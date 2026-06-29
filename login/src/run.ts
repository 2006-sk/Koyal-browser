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
import { testAppShellNavigation } from './scenarios/app-shell-navigation.js';
import { testAuthBackAndForth } from './scenarios/auth-back-and-forth.js';
import { testForgotPasswordFullFlow } from './scenarios/forgot-password.js';
import { testLoginInvalid } from './scenarios/login-invalid.js';
import { testLoginValid } from './scenarios/login-valid.js';
import { testSignupCreateAccount } from './scenarios/signup-create.js';
import { testSignupValidation } from './scenarios/signup-validation.js';

function hasOnlyFlag(prefix: string): boolean {
  return process.argv.some((a) => a === `${prefix}-only`);
}

async function main(): Promise<void> {
  const onlySignup = hasOnlyFlag('--signup');
  const onlyForgot = hasOnlyFlag('--forgot');
  const onlyValidation = hasOnlyFlag('--validation');
  const onlyBackForth = hasOnlyFlag('--back-forth');
  const onlyAppShell = hasOnlyFlag('--app-shell');
  const anyOnly = onlySignup || onlyForgot || onlyValidation || onlyBackForth || onlyAppShell;

  const skipValid =
    process.argv.includes('--invalid-only') || anyOnly || process.argv.includes('--skip-valid');
  const skipInvalid =
    process.argv.includes('--skip-invalid') || anyOnly || onlySignup || onlyForgot;
  const skipSignupCreate =
    (process.argv.includes('--skip-signup') && !onlySignup) || anyOnly && !onlySignup;
  const skipSignupValidation =
    (process.argv.includes('--skip-validation') && !onlyValidation) ||
    (anyOnly && !onlyValidation);
  const skipBackForth =
    (process.argv.includes('--skip-back-forth') && !onlyBackForth) || (anyOnly && !onlyBackForth);
  const skipAppShell =
    (process.argv.includes('--skip-app-shell') && !onlyAppShell) || (anyOnly && !onlyAppShell);
  const skipForgot =
    (process.argv.includes('--skip-forgot') && !onlyForgot) || (anyOnly && !onlyForgot);

  if (config.llm.enabled && process.argv.includes('--require-llm')) {
    requireLlm();
  }

  if (!skipValid && !onlyForgot && !onlyValidation && !onlyBackForth && !onlyAppShell) {
    requireCredentials();
  }

  const report = createRunReport(config.baseUrl);
  const runDir = `${config.reportsDir}/${report.runId}`;

  console.log(`\nRun ID: ${report.runId}`);
  console.log(`Artifacts will be saved to: ${runDir}/`);
  console.log(`Verification max wait: ${config.verificationMaxWaitMs}ms\n`);

  if (!skipValid) {
    console.log('\n▶ Scenario: login-valid');
    const browser = new AgentBrowser({ session: config.sessionAuth, headed: config.headed });
    try {
      const evidence = scenarioEvidenceDir(runDir, 'login-valid');
      report.scenarios.push(await testLoginValid(browser, evidence));
    } finally {
      browser.close();
    }
  }

  if (!skipInvalid) {
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

  if (!skipSignupValidation) {
    console.log('\n▶ Scenario: signup-validation');
    const browser = new AgentBrowser({
      session: `${config.sessionAuth}-signup-val`,
      headed: config.headed,
    });
    try {
      const evidence = scenarioEvidenceDir(runDir, 'signup-validation');
      report.scenarios.push(await testSignupValidation(browser, evidence));
    } finally {
      browser.close();
    }
  }

  if (!skipBackForth) {
    console.log('\n▶ Scenario: auth-back-and-forth');
    const browser = new AgentBrowser({
      session: `${config.sessionAuth}-backforth`,
      headed: config.headed,
    });
    try {
      const evidence = scenarioEvidenceDir(runDir, 'auth-back-and-forth');
      report.scenarios.push(await testAuthBackAndForth(browser, evidence));
    } finally {
      browser.close();
    }
  }

  if (!skipAppShell) {
    console.log('\n▶ Scenario: app-shell-navigation');
    const browser = new AgentBrowser({
      session: config.sessionAuth,
      headed: config.headed,
    });
    try {
      const evidence = scenarioEvidenceDir(runDir, 'app-shell-navigation');
      report.scenarios.push(await testAppShellNavigation(browser, evidence));
    } finally {
      browser.close();
    }
  }

  if (!skipSignupCreate || onlySignup) {
    console.log('\n▶ Scenario: signup-create (will prompt for signup OTP if required)');
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
