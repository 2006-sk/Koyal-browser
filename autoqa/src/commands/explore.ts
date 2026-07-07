import { ensureAuthenticated } from '../agent/auth.js';
import { explore } from '../agent/crawler.js';
import { LlmClient } from '../core/llm/client.js';
import { bootstrap, teardown, type Session } from './shared.js';

export async function exploreCommand(opts: { session?: Session; keepOpen?: boolean } = {}): Promise<Session> {
  const session = opts.session ?? bootstrap();
  const { browser, state, llm, interact, explorer } = session;

  try {
    console.log(`[autoqa] exploring ${state.sitemap.origin} (state: ${state.dir})`);
    await ensureAuthenticated(session.authCtx);
    await explore(browser, state, llm, interact, explorer);
    console.log(`[autoqa] sitemap saved → ${state.sitemapPath}`);
    console.log(`[autoqa] LLM calls so far: ${LlmClient.callCount}`);
  } finally {
    if (!opts.keepOpen) teardown(session);
  }
  return session;
}
