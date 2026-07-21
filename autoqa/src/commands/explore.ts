import { ensureAuthenticated } from '../agent/auth.js';
import { explore } from '../agent/crawler.js';
import { LlmClient } from '../core/llm/client.js';
import { bootstrap, teardown, type Session } from './shared.js';

/**
 * Retry the initial login a few times with linear backoff before giving up.
 * `authFn` throws on a real failure and returns cleanly when there's no gate, so
 * a public site succeeds on attempt 1 (no retry) and only a genuine (usually
 * transient) failure is re-attempted. Returns true if authenticated, false if all
 * attempts failed (caller continues unauthenticated). `sleep` is injectable so
 * tests don't wait real seconds. Exported for testing.
 */
export async function attemptInitialAuth(
  authFn: () => Promise<void>,
  attempts = 3,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await authFn();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < attempts) {
        console.warn(
          `[autoqa] initial login attempt ${attempt}/${attempts} failed (${msg}) — retrying in ${attempt * 3}s`,
        );
        await sleep(attempt * 3000);
      } else {
        console.warn(
          `[autoqa] initial login failed after ${attempts} attempts — continuing unauthenticated for this explore (auth-gated flows will be skipped): ${msg}`,
        );
      }
    }
  }
  return false;
}

export async function exploreCommand(opts: { session?: Session; keepOpen?: boolean } = {}): Promise<Session> {
  const session = opts.session ?? bootstrap();
  const { browser, state, llm, interact, explorer } = session;

  try {
    console.log(`[autoqa] exploring ${state.sitemap.origin} (state: ${state.dir})`);
    // Retry the initial login before giving up (see attemptInitialAuth). A
    // genuinely public/un-gated site does NOT throw here, so this only ever
    // re-attempts a real (often transient, e.g. an Anthropic 529) failure that
    // would otherwise strand the whole explore UNAUTHENTICATED — collapsing the
    // crawl to the login page and starving flow-proposal (koyal run #1 was
    // 7/5/2 for exactly this). After the attempts are exhausted we still continue
    // unauthenticated (login is one gate, not the whole product) — deep-walker's
    // own login-wall handling aborts auth-gated flows individually.
    await attemptInitialAuth(() => ensureAuthenticated(session.authCtx));
    await explore(browser, state, llm, interact, explorer, {
      ensureAuth: async () => {
        await ensureAuthenticated(session.authCtx);
      },
    });
    console.log(`[autoqa] sitemap saved → ${state.sitemapPath}`);
    console.log(`[autoqa] LLM calls so far: ${LlmClient.callCount}`);
  } finally {
    if (!opts.keepOpen) teardown(session);
  }
  return session;
}
