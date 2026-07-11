#!/usr/bin/env node
/**
 * Script path QA — LLM-powered E2E with short PDF.
 *   npm run qa       — full script-complete-pdf scenario
 *   npm run qa:pdf   — same (explicit)
 */
import { config, requireCredentials, requireLlm } from './config.js';
import { AgentBrowser } from './lib/agent-browser.js';
import { writeArtifactsIndex } from './lib/evidence.js';
import {
  appendReportNotes,
  createRunReport,
  finalizeRunReport,
  scenarioEvidenceDir,
  writeRunReport,
} from './lib/report.js';
import { testScriptCompletePdf } from './scenarios/script-complete-pdf.js';

async function runScenario(
  report: { scenarios: unknown[] },
  runDir: string,
  id: string,
  session: string,
  fn: (browser: AgentBrowser, evidence: string) => Promise<unknown>,
): Promise<void> {
  console.log(`\n▶ Scenario: ${id}`);
  const browser = new AgentBrowser({ session, headed: config.headed });
  try {
    const evidence = scenarioEvidenceDir(runDir, id);
    report.scenarios.push(await fn(browser, evidence));
  } finally {
    browser.close();
    browser.recycle();
  }
}

async function main(): Promise<void> {
  requireCredentials();
  requireLlm();

  const report = createRunReport(config.baseUrl);
  const runDir = `${config.reportsDir}/${report.runId}`;

  console.log(`\nRun ID: ${report.runId}`);
  console.log(`Artifacts: ${runDir}/`);
  console.log(`Script: ${config.script.shortPdf}`);
  console.log(`Headed: ${config.headed} | Cursor: ${config.showCursor}`);
  console.log(`LLM: enabled (max ${config.llm.maxStepsPerGoal} steps/goal)\n`);

  await runScenario(report, runDir, 'script-complete-pdf', config.sessionScript, testScriptCompletePdf);

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
