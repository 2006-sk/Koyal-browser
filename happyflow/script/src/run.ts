#!/usr/bin/env node
/**
 * Script path QA — LLM-powered E2E with short PDF.
 * Output: a single clean reports/REPORT.md (previous reports deleted).
 */
import { config, requireCredentials, requireLlm } from './config.js';
import path from 'node:path';
import fs from 'node:fs';
import { AgentBrowser } from './lib/agent-browser.js';
import {
  createRunReport,
  finalizeRunReport,
  writeRunReport,
} from './lib/report.js';
import { testScriptCompletePdf } from './scenarios/script-complete-pdf.js';

async function runScenario(
  report: { scenarios: unknown[] },
  scratchDir: string,
  id: string,
  session: string,
  fn: (browser: AgentBrowser, evidence: string) => Promise<unknown>,
): Promise<void> {
  console.log(`\n▶ Scenario: ${id}`);
  const browser = new AgentBrowser({ session, headed: config.headed });
  const evidence = path.join(scratchDir, id);
  fs.mkdirSync(evidence, { recursive: true });
  try {
    report.scenarios.push(await fn(browser, evidence));
  } finally {
    browser.close();
    browser.recycle('teardown');
  }
}

async function main(): Promise<void> {
  requireCredentials();
  requireLlm();

  const report = createRunReport(config.baseUrl);
  const scratchDir = path.join(config.reportsDir, `.scratch-${report.runId}`);
  fs.mkdirSync(scratchDir, { recursive: true });

  console.log(`\nRun ID: ${report.runId}`);
  console.log(`Report:  ${path.join(config.reportsDir, 'REPORT.md')} (single file)`);
  console.log(`Script: ${config.script.shortPdf}`);
  console.log(`Headed: ${config.headed} | Cursor: ${config.showCursor}`);
  console.log(`LLM: enabled (max ${config.llm.maxStepsPerGoal} steps/goal)\n`);

  let exitCode = 0;
  try {
    await runScenario(
      report,
      scratchDir,
      'script-complete-pdf',
      config.sessionScript,
      testScriptCompletePdf,
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }

  const finalReport = finalizeRunReport(report as never);
  const { reportPath, bugsPath } = writeRunReport(finalReport, config.reportsDir);

  if (bugsPath) {
    const { notifySlackBugs } = await import('./lib/slack-bugs.js');
    await notifySlackBugs({
      suite: 'script',
      runId: finalReport.runId,
      markdown: fs.readFileSync(bugsPath, 'utf8'),
    });
  }

  const allSteps = finalReport.scenarios.flatMap((s) => s.steps);
  const pass = allSteps.filter((st) => st.result.verdict === 'pass').length;
  const fail = allSteps.filter((st) => st.result.verdict === 'fail').length;
  const review = allSteps.filter((st) => st.result.verdict === 'needs-review').length;
  if (fail > 0) exitCode = 1;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Steps: ${pass} PASS | ${fail} FAIL | ${review} NEEDS REVIEW`);
  console.log(`Report: ${reportPath}`);
  if (bugsPath) console.log(`Bugs:   ${bugsPath}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
