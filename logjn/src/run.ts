#!/usr/bin/env node
import { config, requireCredentials, requireLlm } from './config.js';
import { AgentBrowser } from './lib/agent-browser.js';
import { writeArtifactsIndex } from './lib/evidence.js';
import {
  createRunReport,
  finalizeRunReport,
  appendReportNotes,
  scenarioEvidenceDir,
  writeRunReport,
} from './lib/report.js';
import { testSignupCreateAccount } from './scenarios/signup-create.js';
import { testForgotPasswordFullFlow } from './scenarios/forgot-password.js';
import { testLoginInvalid } from './scenarios/login-invalid.js';
import { testLoginValid } from './scenarios/login-valid.js';

async function main(): Promise<void> {
  const onlySignup = process.argv.includes('--signup-only');
  const onlyForgot = process.argv.includes('--forgot-only');
  const skipValid = process.argv.includes('--invalid-only') || onlyForgot || onlySignup;
  const skipInvalid = process.argv.includes('--skip-invalid') || onlyForgot || onlySignup;
  const skipSignup = process.argv.includes('--skip-signup') && !onlySignup;
  const skipForgot = process.argv.includes('--skip-forgot') && !onlyForgot;

  if (config.llm.enabled && process.argv.includes('--require-llm')) {
    requireLlm();
  }

  if (!skipValid && !onlyForgot) {
    requireCredentials();
  }

  const report = createRunReport(config.baseUrl);
  const runDir = `${config.reportsDir}/${report.runId}`;

  console.log(`\nRun ID: ${report.runId}`);
  console.log(`Artifacts will be saved to: ${runDir}/\n`);

  if (!skipValid && !onlyForgot) {
    console.log('\n▶ Scenario: login-valid');
    const browser = new AgentBrowser({ session: config.sessionAuth, headed: config.headed });
    try {
      const evidence = scenarioEvidenceDir(runDir, 'login-valid');
      report.scenarios.push(await testLoginValid(browser, evidence));
    } finally {
      browser.close();
    }
  }

  if (!skipInvalid && !onlyForgot && !onlySignup) {
    console.log('\n▶ Scenario: login-invalid');
    const browser = new AgentBrowser({
      session: `${config.sessionAuth}-invalid`,
      headed: config.headed,
    });
    try {
      const evidence = scenarioEvidenceDir(runDir, 'login-invalid');
      report.scenarios.push(await testLoginInvalid(browser, evidence));
    } finally {
      browser.close();
    }
  }

  if (!skipSignup || onlySignup) {
    console.log('\n▶ Scenario: signup-create (will prompt for signup OTP if email verification is required)');
    const browser = new AgentBrowser({
      session: `${config.sessionAuth}-signup`,
      headed: config.headed,
    });
    try {
      const evidence = scenarioEvidenceDir(runDir, 'signup-create');
      report.scenarios.push(await testSignupCreateAccount(browser, evidence));
    } finally {
      browser.close();
    }
  }

  if (!skipForgot || onlyForgot) {
    console.log('\n▶ Scenario: forgot-password (will prompt for verification code)');
    const browser = new AgentBrowser({
      session: `${config.sessionAuth}-reset`,
      headed: config.headed,
    });
    try {
      const evidence = scenarioEvidenceDir(runDir, 'forgot-password');
      report.scenarios.push(await testForgotPasswordFullFlow(browser, evidence));
    } finally {
      browser.close();
    }
  }

  const finalReport = finalizeRunReport(report);
  const outputDir = writeRunReport(finalReport, config.reportsDir);
  writeArtifactsIndex(outputDir, finalReport.scenarios);
  appendReportNotes(outputDir);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Report:     ${outputDir}/report.md`);
  console.log(`Artifacts:  ${outputDir}/ARTIFACTS.md`);
  console.log(`JSON:       ${outputDir}/report.json`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const hasFail = finalReport.scenarios.some((s) =>
    s.steps.some((step) => step.result.verdict === 'fail'),
  );
  process.exit(hasFail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
