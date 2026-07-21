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
import { notifyKoyalBugsToSlack } from '../core/slack-bugs.js';
import { writeSiteSummary } from '../core/site-summary.js';
import { bootstrap, teardown, type Session } from './shared.js';

export async function testCommand(
  opts: { session?: Session; keepOpen?: boolean; only?: string[] } = {},
): Promise<{ session: Session; failed: number }> {
  const session = opts.session ?? bootstrap();
  const { browser, state, interact, llm, explorer, player, statements, authCtx } = session;

  const reportsRoot = path.join(config.reportsDir, state.hostname);
  // Snapshot LLM counters at test-phase entry. For the combined `run` command,
  // exploration has already run in this same process, so this snapshot = the
  // exploration cost; the delta at the end = the test-phase cost, which is the
  // basis for the "future runs" estimate (future runs skip exploration).
  const llmAtTestStart = {
    calls: LlmClient.callCount,
    input: LlmClient.inputTokens,
    output: LlmClient.outputTokens,
  };
  const report = createRunReport(state.sitemap.origin);
  const runDir = path.join(reportsRoot, report.runId);
  ensureDir(runDir);
  interact.setDecisionLog(runDir);

  let failed = 0;
  try {
    await runFlows(
      { browser, state, interact, llm, explorer, player, statements },
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

    const credentialsType = state.authenticatedThisRun
      ? 'email/password test account (secrets omitted)'
      : 'none (unauthenticated)';

    // Post genuine product bugs (failed milestones with real site-emitted error
    // evidence) to the Slack bugs channel — Bug/Inputs/Reproduction/Error-log
    // only, nothing else, and nothing at all when there are zero product bugs.
    // Never lets a notify failure affect teardown/exit.
    try {
      await notifyKoyalBugsToSlack({
        report: finalized,
        hostname: state.hostname,
        credentialsType,
      });
    } catch (err) {
      console.warn(`[autoqa] slack bug notify skipped: ${err instanceof Error ? err.message : err}`);
    }

    // (Re)write the per-site summary: flows designed, the product bugs sent to
    // Slack, this run's cost, and the estimated future-run cost. Rewritten every
    // run; never lets a write failure affect teardown/exit.
    try {
      const summaryPath = writeSiteSummary({
        reportsDir: config.reportsDir,
        hostname: state.hostname,
        report: finalized,
        model: config.llm.model,
        credentialsType,
        flowsTotal: state.sitemap.flows.length,
        flowsApproved: state.sitemap.flows.filter(
          (f) => f.status === 'exploratory' || f.status === 'deterministic' || f.status === 'approved',
        ).length,
        verdicts: { pass, fail: failed, review },
        total: {
          calls: LlmClient.callCount,
          inputTokens: LlmClient.inputTokens,
          outputTokens: LlmClient.outputTokens,
        },
        testPhase: {
          calls: LlmClient.callCount - llmAtTestStart.calls,
          inputTokens: LlmClient.inputTokens - llmAtTestStart.input,
          outputTokens: LlmClient.outputTokens - llmAtTestStart.output,
        },
      });
      console.log(`[autoqa] site summary → ${summaryPath}`);
    } catch (err) {
      console.warn(`[autoqa] site summary skipped: ${err instanceof Error ? err.message : err}`);
    }

    if (!opts.keepOpen) teardown(session);
  }

  return { session, failed };
}
