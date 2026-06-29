import { config, requireSignupCredentials } from '../config.js';
import { APP_SHELL_CONSOLE_ALLOWLIST, POST_LOGIN_URL } from '../lib/auth-expectations.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { AuthPage } from '../lib/page-auth.js';
import { promptSignupOtp } from '../lib/prompt.js';
import { isSignupOtpSnapshot } from '../lib/auth-selectors.js';
import { recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

export async function testSignupCreateAccount(
  browser: AgentBrowser,
  evidenceDir: string,
): Promise<ScenarioResult> {
  requireSignupCredentials();

  const startedAt = new Date().toISOString();
  const steps: TestStep[] = [];
  const auth = new AuthPage(browser);
  const verification = new VerificationLayer(browser);
  const repro: string[] = [];

  const ctx = (): StepContext => ({
    browser,
    verification,
    evidenceDir,
    stepsToReproduce: repro,
  });

  browser.clearSignals();
  repro.push(`Open ${auth.loginUrl(config.baseUrl)}`);
  auth.openLogin(config.baseUrl);

  repro.push('Ensure signup form is visible');
  const signupNav = await auth.ensureSignupForm();
  auth.appendExplorerSteps(repro, signupNav);

  const openStep = await recordVerifiedStep(ctx(), {
    workflow: 'open-signup',
    action: 'Navigate to /login and show signup form',
    expected: 'Signup form with name, email, password, confirm password, and Continue button',
    expectation: {
      description: 'Signup form visible on /login',
      urlIncludes: '/login',
      snapshotIncludes: ['full name', 'confirm password', 'continue'],
    },
  });
  steps.push(openStep);

  repro.push(`Fill signup form for ${config.signupEmail} (name: ${config.signupName})`);
  const fillNav = await auth.fillSignup(
    config.signupName,
    config.signupEmail,
    config.signupPassword,
    true,
  );
  auth.appendExplorerSteps(repro, fillNav);

  browser.clearSignals();
  repro.push('Click Continue to create account');
  const submitNav = await auth.submitSignup();
  auth.appendExplorerSteps(repro, submitNav);

  const snapAfterSubmit = browser.snapshotInteractive();
  const onOtpScreen = isSignupOtpSnapshot(snapAfterSubmit);

  const createStep = await recordVerifiedStep(ctx(), {
    workflow: onOtpScreen ? 'submit-signup-otp-sent' : 'submit-signup',
    action: onOtpScreen
      ? 'Submit signup — OTP verification screen shown'
      : 'Submit signup form with valid credentials',
    expected: onOtpScreen
      ? 'OTP sent — Verify OTP screen with 6 digit fields'
      : 'Account created — lands in authenticated app shell (projects, dashboard, or /upload onboarding)',
    expectation: onOtpScreen
      ? {
          description: 'Signup OTP verification screen',
          urlIncludes: '/login',
          snapshotIncludes: ['verify otp', 'digit 1'],
          snapshotExcludes: ['Internal Server Error', 'TypeError', 'SyntaxError'],
          requireNetworkActivity: false,
        }
      : {
          description: 'Successful signup enters app',
          urlIncludes: POST_LOGIN_URL,
          snapshotExcludes: ['Internal Server Error', 'TypeError', 'SyntaxError'],
          requireNetworkActivity: false,
          allowedConsoleErrorPatterns: APP_SHELL_CONSOLE_ALLOWLIST,
          uglyErrorPatterns: [
            /Internal Server Error/i,
            /TypeError:/i,
            /SyntaxError:/i,
            /already (exists|registered)/i,
          ],
        },
  });
  steps.push(createStep);

  const err = auth.visibleUserFacingErrorText(createStep.result.signals.snapshot.raw);
  if (err?.toLowerCase().includes('already') && createStep.result.verdict === 'fail') {
    createStep.result.verdict = 'needs-review';
    createStep.result.reasons.push(
      'Email may already be registered — use a fresh KOYAL_SIGNUP_EMAIL',
    );
    createStep.result.severity = 'medium';
  }

  if (onOtpScreen && createStep.result.verdict !== 'fail') {
    repro.push('Wait for user to paste signup OTP from email');
    const otp = await promptSignupOtp();
    repro.push(`Enter signup OTP (${otp.length} chars) and verify`);

    browser.clearSignals();
    const verifyNav = await auth.verifySignupOtp(otp);
    auth.appendExplorerSteps(repro, verifyNav);

    const verifyStep = await recordVerifiedStep(ctx(), {
      workflow: 'verify-signup-otp',
      action: 'Enter signup OTP and complete account creation',
      expected: 'OTP accepted — lands in app (/projects or /upload onboarding)',
      expectation: {
        description: 'Signup OTP verified and account active',
        urlIncludes: POST_LOGIN_URL,
        snapshotExcludes: ['Internal Server Error', 'TypeError', 'SyntaxError'],
        requireNetworkActivity: false,
        allowedConsoleErrorPatterns: APP_SHELL_CONSOLE_ALLOWLIST,
      },
    });
    steps.push(verifyStep);
  }

  return {
    id: 'signup-create',
    name: 'Signup — create account',
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
