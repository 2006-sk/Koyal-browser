import { bootstrap, teardown } from './shared.js';
import { exploreCommand } from './explore.js';
import { testCommand } from './test.js';

/** Default command: explore when the sitemap is missing/stale, then test. */
export async function runCommand(opts: { fresh?: boolean; only?: string[] } = {}): Promise<number> {
  const session = bootstrap();
  let failed = 0;

  try {
    const pageCount = Object.keys(session.state.sitemap.pages).length;
    const runnableFlows = session.state.sitemap.flows.filter(
      (f) => f.status === 'exploratory' || f.status === 'deterministic' || f.status === 'approved',
    ).length;

    if (opts.fresh || pageCount === 0 || runnableFlows === 0) {
      console.log(
        opts.fresh
          ? '[autoqa] --fresh: re-exploring'
          : `[autoqa] sitemap has ${pageCount} pages / ${runnableFlows} runnable flows — exploring first`,
      );
      await exploreCommand({ session, keepOpen: true });
    } else {
      console.log(`[autoqa] using cached sitemap (${pageCount} pages, ${runnableFlows} runnable flows)`);
    }

    const result = await testCommand({ session, keepOpen: true, only: opts.only });
    failed = result.failed;
  } finally {
    teardown(session);
  }

  return failed > 0 ? 1 : 0;
}
