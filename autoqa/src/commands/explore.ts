import { ensureAuthenticated } from '../agent/auth.js';
import { explore } from '../agent/crawler.js';
import { LlmClient } from '../core/llm/client.js';
import { bootstrap, teardown, type Session } from './shared.js';

export async function exploreCommand(opts: { session?: Session; keepOpen?: boolean } = {}): Promise<Session> {
  const session = opts.session ?? bootstrap();
  const { browser, state, llm, interact, explorer } = session;

  try {
    console.log(`[autoqa] exploring ${state.sitemap.origin} (state: ${state.dir})`);
    try {
      await ensureAuthenticated(session.authCtx);
    } catch (err) {
      // login is one gate, not the whole product — a failed/unavailable login
      // must not stop the crawler from mapping the site's public surface.
      // Auth-gated flows will simply abort individually (deep-walker's own
      // login-wall handling) rather than the whole explore run dying here.
      console.warn(
        `[autoqa] initial login failed — continuing unauthenticated for this explore (auth-gated flows will be skipped): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
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
