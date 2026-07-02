#!/usr/bin/env node
import { config, requireCredentials } from './config.js';
import { AgentBrowser } from './lib/agent-browser.js';
import { writeArtifactsIndex } from './lib/evidence.js';
import {
  appendReportNotes,
  createRunReport,
  finalizeRunReport,
  scenarioEvidenceDir,
  writeRunReport,
} from './lib/report.js';
import { testAudioBackAndForth } from './scenarios/audio-back-and-forth.js';
import { testAudioE2E } from './scenarios/audio-e2e.js';
import { testAudioFullCoverage } from './scenarios/audio-full-coverage.js';
import { testAudioWizardNavigation } from './scenarios/audio-wizard-navigation.js';

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function hasOnlyFlag(prefix: string): boolean {
  return process.argv.includes(`${prefix}-only`);
}

async function runScenario(
  report: { scenarios: Awaited<ReturnType<typeof testAudioE2E>>[] },
  runDir: string,
  id: string,
  session: string,
  fn: (browser: AgentBrowser, evidence: string) => Promise<unknown>,
): Promise<void> {
  console.log(`\n▶ Scenario: ${id}`);
  const browser = new AgentBrowser({ session, headed: config.headed });
  try {
    const evidence = scenarioEvidenceDir(runDir, id);
    report.scenarios.push((await fn(browser, evidence)) as never);
  } finally {
    browser.close();
  }
}

async function main(): Promise<void> {
  const onlyFull = hasOnlyFlag('--full');
  const onlyE2e = hasOnlyFlag('--e2e');
  const onlyMp3 = hasOnlyFlag('--mp3');
  const onlyBackForth = hasOnlyFlag('--back-forth');
  const onlyWizardNav = hasOnlyFlag('--wizard-nav');
  const anyOnly = onlyFull || onlyE2e || onlyMp3 || onlyBackForth || onlyWizardNav;

  const runFull = onlyFull || (!anyOnly && !hasFlag('--skip-full'));
  const runE2eWav = onlyE2e || (!anyOnly && !hasFlag('--skip-e2e') && !onlyFull);
  const runMp3 = onlyMp3 || (!anyOnly && !hasFlag('--skip-mp3') && !onlyFull);
  const runBackForth =
    onlyBackForth || (!anyOnly && !hasFlag('--skip-back-forth') && !onlyFull);
  const runWizardNav =
    onlyWizardNav || (!anyOnly && !hasFlag('--skip-wizard-nav') && !onlyFull);

  requireCredentials();

  const report = createRunReport(config.baseUrl);
  const runDir = `${config.reportsDir}/${report.runId}`;

  console.log(`\nRun ID: ${report.runId}`);
  console.log(`Artifacts: ${runDir}/`);
  console.log(`Headed: ${config.headed} | Cursor: ${config.showCursor}`);
  console.log(`Audio: ${config.audio.shortWav} (short) | ${config.audio.wav} (e2e)\n`);

  if (runFull) {
    await runScenario(report, runDir, 'audio-full-coverage', config.sessionAudio, testAudioFullCoverage);
  }

  if (runE2eWav) {
    await runScenario(report, runDir, 'audio-e2e-wav', `${config.sessionAudio}-e2e-wav`, (b, e) =>
      testAudioE2E(b, e, { audioPath: config.audio.wav, formatLabel: 'WAV' }),
    );
  }

  if (runMp3) {
    await runScenario(report, runDir, 'audio-e2e-mp3', `${config.sessionAudio}-mp3`, (b, e) =>
      testAudioE2E(b, e, { audioPath: config.audio.mp3, formatLabel: 'MP3' }),
    );
  }

  if (runBackForth) {
    await runScenario(report, runDir, 'audio-back-and-forth', `${config.sessionAudio}-backforth`, testAudioBackAndForth);
  }

  if (runWizardNav) {
    await runScenario(report, runDir, 'audio-wizard-navigation', `${config.sessionAudio}-wizard`, testAudioWizardNavigation);
  }

  const finalReport = finalizeRunReport(report);
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
