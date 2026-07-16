import path from 'node:path';
import { config } from '../config.js';
import { runFlows } from '../agent/flow-runner.js';
import { ensureDir, writeArtifactsIndex } from '../core/evidence.js';
import { LlmClient } from '../core/llm/client.js';
import {
  appendReportNotes,
  createRunReport,
  finalizeRunReport,
  writeRunReport,
} from '../core/report.js';
import { bootstrap, teardown, type Session } from './shared.js';

export async function testCommand(
  opts: { session?: Session; keepOpen?: boolean; only?: string[] } = {},
): Promise<{ session: Session; failed: number }> {
  const session = opts.session ?? bootstrap();
  const { browser, state, interact, explorer, player, statements, authCtx } = session;

  const reportsRoot = path.join(config.reportsDir, state.hostname);
  const report = createRunReport(state.sitemap.origin);
  const runDir = path.join(reportsRoot, report.runId);
  ensureDir(runDir);
  interact.setDecisionLog(runDir);

  let failed = 0;
  try {
    await runFlows(
      { browser, state, interact, explorer, player, statements },
      authCtx,
      report,
      runDir,
      { only: opts.only, quick: !config.probes.thorough },
    );
  } finally {
    const finalized = finalizeRunReport(report);
    writeRunReport(finalized, reportsRoot);
    writeArtifactsIndex(runDir, finalized.scenarios);
    appendReportNotes(runDir);

    const steps = finalized.scenarios.flatMap((s) => s.steps);
    const pass = steps.filter((s) => s.result.verdict === 'pass').length;
    failed = steps.filter((s) => s.result.verdict === 'fail').length;
    const review = steps.filter((s) => s.result.verdict === 'needs-review').length;
    console.log(`\n[autoqa] ${pass} PASS / ${failed} FAIL / ${review} NEEDS REVIEW`);
    console.log(`[autoqa] report → ${path.join(runDir, 'report.md')}`);
    console.log(`[autoqa] LLM calls this run: ${LlmClient.callCount}`);

    if (!opts.keepOpen) teardown(session);
  }

  return { session, failed };
}
