#!/usr/bin/env node
/**
 * Audio QA — 2 tests by default:
 *   1. audio-complete-wav  — full path, all probes, real edits, nav, download (~6–8 min)
 *   2. audio-complete-mp3  — MP3 format parity with edits (~6 min)
 */
import { config, requireCredentials } from './config.js';
import path from 'node:path';
import { AgentBrowser } from './lib/agent-browser.js';
import { writeArtifactsIndex } from './lib/evidence.js';
import {
  appendReportNotes,
  createRunReport,
  finalizeRunReport,
  scenarioEvidenceDir,
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
  runDir: string,
  id: string,
  session: string,
  fn: (browser: AgentBrowser, evidence: string, options?: { record?: boolean }) => Promise<unknown>,
  options: { record?: boolean } = {},
): Promise<void> {
  console.log(`\n▶ Scenario: ${id}`);
  const browser = new AgentBrowser({ session, headed: config.headed });
  browser.recycle();
  const evidence = scenarioEvidenceDir(runDir, id);
  if (options.record) {
    browser.queueRecording(path.join(evidence, 'run-recording.webm'));
  }
  try {
    report.scenarios.push(await fn(browser, evidence, { record: options.record }));
  } finally {
    browser.recordStop();
    browser.close();
    browser.recycle();
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
  const runDir = `${config.reportsDir}/${report.runId}`;

  const record = hasFlag('--record') || process.env.AGENT_RECORD === 'true';

  console.log(`\nRun ID: ${report.runId}`);
  console.log(`Artifacts: ${runDir}/`);
  console.log(`Headed: ${config.headed} | Cursor: ${config.showCursor} | Record: ${record}`);
  console.log(`Tests: ${runWav ? 'WAV complete' : ''}${runWav && runMp3 ? ' + ' : ''}${runMp3 ? 'MP3 complete' : ''}\n`);

  if (runWav) {
    await runScenario(report, runDir, 'audio-complete-wav', config.sessionAudio, testAudioComplete, { record });
  }

  if (runMp3) {
    await runScenario(report, runDir, 'audio-complete-mp3', `${config.sessionAudio}-mp3`, testAudioMp3, { record });
  }

  const finalReport = finalizeRunReport(report as never);
  const outputDir = writeRunReport(finalReport, config.reportsDir);
  writeArtifactsIndex(outputDir, finalReport.scenarios);
  appendReportNotes(outputDir);

  const allSteps = finalReport.scenarios.flatMap((s) => s.steps);
  const pass = allSteps.filter((st) => st.result.verdict === 'pass').length;
  const fail = allSteps.filter((st) => st.result.verdict === 'fail').length;
  const review = allSteps.filter((st) => st.result.verdict === 'needs-review').length;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Steps: ${pass} PASS | ${fail} FAIL | ${review} NEEDS REVIEW`);
  console.log(`Report:     ${outputDir}/report.md`);
  console.log(`Artifacts:  ${outputDir}/ARTIFACTS.md`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
