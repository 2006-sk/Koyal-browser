#!/usr/bin/env node
import { config, requireCredentials, requireLlm } from './config.js';
import { AgentBrowser } from './lib/agent-browser.js';
import {
  createRunReport,
  finalizeRunReport,
  scenarioEvidenceDir,
  writeRunReport,
} from './lib/report.js';
import { testLoginInvalid } from './scenarios/login-invalid.js';
import { testLoginValid } from './scenarios/login-valid.js';

async function main(): Promise<void> {
  const skipValid = process.argv.includes('--invalid-only');

  if (config.llm.enabled && process.argv.includes('--require-llm')) {
    requireLlm();
  }

  if (!skipValid) {
    requireCredentials();
  }

  const report = createRunReport(config.baseUrl);
  const runDir = `${config.reportsDir}/${report.runId}`;
  const browser = new AgentBrowser({ session: config.sessionAuth, headed: config.headed });

  try {
    if (!skipValid) {
      const validEvidence = scenarioEvidenceDir(runDir, 'login-valid');
      const validScenario = await testLoginValid(browser, validEvidence);
      report.scenarios.push(validScenario);

      browser.close();
    }

    const invalidBrowser = new AgentBrowser({
      session: `${config.sessionAuth}-invalid`,
      headed: config.headed,
    });

    try {
      const invalidEvidence = scenarioEvidenceDir(runDir, 'login-invalid');
      const invalidScenario = await testLoginInvalid(invalidBrowser, invalidEvidence);
      report.scenarios.push(invalidScenario);
    } finally {
      invalidBrowser.close();
    }
  } finally {
    browser.close();
  }

  const finalReport = finalizeRunReport(report);
  const { runDir: outputDir, bugsPath } = writeRunReport(finalReport, config.reportsDir);

  if (bugsPath) {
    const { notifySlackBugs } = await import('./lib/slack-bugs.js');
    const fs = await import('node:fs');
    await notifySlackBugs({
      suite: 'login',
      runId: finalReport.runId,
      markdown: fs.readFileSync(bugsPath, 'utf8'),
    });
  }

  console.log(`\nReport written to: ${outputDir}/report.md`);
  console.log(`Evidence folder: ${outputDir}/`);

  const hasFail = finalReport.scenarios.some((s) =>
    s.steps.some((step) => step.result.verdict === 'fail'),
  );
  process.exit(hasFail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
