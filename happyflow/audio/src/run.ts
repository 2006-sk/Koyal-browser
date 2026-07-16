#!/usr/bin/env node
/**
 * Audio QA — 2 tests by default:
 *   1. audio-complete-wav  — full path, all probes, real edits, nav, download (~6–8 min)
 *   2. audio-complete-mp3  — MP3 format parity with edits (~6 min)
 *
 * Output: a single clean reports/REPORT.md (previous reports deleted).
 */
import { config, requireCredentials } from './config.js';
import path from 'node:path';
import fs from 'node:fs';
import { AgentBrowser } from './lib/agent-browser.js';
import {
  createRunReport,
  finalizeRunReport,
  writeRunReport,
} from './lib/report.js';
import { testAudioComplete } from './scenarios/audio-complete.js';
import { testAudioMp3 } from './scenarios/audio-mp3.js';

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function hasOnlyFlag(prefix: string): boolean {
  return process.argv.includes(`${prefix}-only`);
}

async function runScenario(
  report: { scenarios: unknown[] },
  scratchDir: string,
  id: string,
  session: string,
  fn: (browser: AgentBrowser, evidence: string, options?: { record?: boolean }) => Promise<unknown>,
  options: { record?: boolean } = {},
): Promise<void> {
  console.log(`\n▶ Scenario: ${id}`);
  const browser = new AgentBrowser({ session, headed: config.headed });
  browser.recycle('startup');
  const evidence = path.join(scratchDir, id);
  fs.mkdirSync(evidence, { recursive: true });
  if (options.record) {
    browser.queueRecording(path.join(evidence, 'run-recording.webm'));
  }
  try {
    report.scenarios.push(await fn(browser, evidence, { record: options.record }));
  } finally {
    browser.recordStop();
    browser.close();
    browser.recycle('teardown');
  }
}

async function main(): Promise<void> {
  const onlyWav = hasOnlyFlag('--wav') || hasOnlyFlag('--complete') || hasOnlyFlag('--full');
  const onlyMp3 = hasOnlyFlag('--mp3');
  const anyOnly = onlyWav || onlyMp3;

  const runWav = onlyWav || (!anyOnly && !hasFlag('--skip-wav'));
  const runMp3 = onlyMp3 || (!anyOnly && !hasFlag('--skip-mp3'));

  requireCredentials();

  const report = createRunReport(config.baseUrl);
  const scratchDir = path.join(config.reportsDir, `.scratch-${report.runId}`);
  fs.mkdirSync(scratchDir, { recursive: true });

  const record = hasFlag('--record') || process.env.AGENT_RECORD === 'true';

  console.log(`\nRun ID: ${report.runId}`);
  console.log(`Report:  ${path.join(config.reportsDir, 'REPORT.md')} (single file)`);
  console.log(`Headed: ${config.headed} | Cursor: ${config.showCursor} | Record: ${record}`);
  console.log(`Tests: ${runWav ? 'WAV complete' : ''}${runWav && runMp3 ? ' + ' : ''}${runMp3 ? 'MP3 complete' : ''}\n`);

  let exitCode = 0;
  try {
    if (runWav) {
      await runScenario(report, scratchDir, 'audio-complete-wav', config.sessionAudio, testAudioComplete, {
        record,
      });
    }

    if (runMp3) {
      await runScenario(
        report,
        scratchDir,
        'audio-complete-mp3',
        `${config.sessionAudio}-mp3`,
        testAudioMp3,
      );
    }
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }

  const finalReport = finalizeRunReport(report as never);
  const { reportPath, bugsPath } = writeRunReport(finalReport, config.reportsDir);

  if (bugsPath) {
    const { notifySlackBugs } = await import('./lib/slack-bugs.js');
    await notifySlackBugs({
      suite: 'audio',
      runId: finalReport.runId,
      markdown: fs.readFileSync(bugsPath, 'utf8'),
    });
  }

  const allSteps = finalReport.scenarios.flatMap((s) => s.steps);
  const pass = allSteps.filter((st) => st.result.verdict === 'pass').length;
  const fail = allSteps.filter((st) => st.result.verdict === 'fail').length;
  const review = allSteps.filter((st) => st.result.verdict === 'needs-review').length;
  const koyalBugs = allSteps.filter((st) =>
    st.result.reasons.some((r) => /KOYAL PRODUCT BUG/i.test(r)),
  );
  if (fail > 0) exitCode = 1;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Steps: ${pass} PASS | ${fail} FAIL | ${review} NEEDS REVIEW`);
  if (koyalBugs.length) {
    console.log(`Koyal product bugs: ${koyalBugs.length} (harness OK — flow rejected)`);
    for (const bug of koyalBugs) {
      console.log(`  • ${bug.workflow}`);
    }
    console.log(`Also wrote: ${path.join(config.reportsDir, 'KOYAL_BUGS.md')}`);
  }
  console.log(`Report: ${reportPath}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
