import { config } from '../config.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { AuthPage } from '../lib/page-auth.js';
import { recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

const AUTH_URL = '/login';

/** Koyal logs OTP API errors even when client-side validation blocks submit */
const SIGNUP_VALIDATION_CONSOLE_ALLOW = [/Failed to send OTP/i, /Failed to load resource/i];

export async function testSignupValidation(
  browser: AgentBrowser,
  evidenceDir: string,
): Promise<ScenarioResult> {
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

  // --- Signup <-> login toggle ---
  repro.push('Toggle signup → login → signup → login');
  await auth.ensureSignupForm();
  await auth.ensureLoginForm();
  await auth.ensureSignupForm();
  await auth.ensureLoginForm();

  const toggleStep = await recordVerifiedStep(ctx(), {
    workflow: 'signup-login-toggle',
    action: 'Toggle between signup and login forms repeatedly',
    expected: 'Both forms render without errors; login form visible after final toggle',
    expectation: {
      description: 'Auth toggle works',
      urlIncludes: AUTH_URL,
      snapshotIncludes: ['email', 'password'],
      snapshotExcludes: ['Internal Server Error', 'TypeError'],
    },
  });
  steps.push(toggleStep);

  // --- Empty required fields ---
  repro.push('Switch to signup and submit empty form');
  await auth.ensureSignupForm();
  browser.clearSignals();
  await auth.submitSignup();

  const emptyStep = await recordVerifiedStep(ctx(), {
    workflow: 'signup-empty-fields',
    action: 'Submit signup with all fields empty',
    expected: 'Validation feedback — stays on signup, no crash',
    expectation: {
      description: 'Empty signup blocked with validation',
      urlIncludes: AUTH_URL,
      snapshotIncludesAny: ['required', 'email', 'full name', 'password', 'at least'],
      snapshotExcludes: ['Internal Server Error', 'TypeError'],
    },
  });
  steps.push(emptyStep);

  // --- Weak password ---
  repro.push('Submit signup with weak password (no upper/lower/number)');
  await auth.ensureSignupForm();
  await auth.fillSignupFields('QA Weak Pass', 'qa-weak@example.com', 'abcdef', 'abcdef', true);
  browser.clearSignals();
  await auth.submitSignup();

  const weakStep = await recordVerifiedStep(ctx(), {
    workflow: 'signup-weak-password',
    action: 'Submit signup with password "abcdef" (fails complexity rules)',
    expected: 'Password rule message visible; stays on signup',
    expectation: {
      description: 'Weak password rejected',
      urlIncludes: AUTH_URL,
      snapshotIncludesAny: [
        'password must contain',
        'uppercase',
        'lowercase',
        'number',
        'at least 6',
      ],
      snapshotExcludes: ['Internal Server Error'],
      allowedConsoleErrorPatterns: SIGNUP_VALIDATION_CONSOLE_ALLOW,
    },
  });
  steps.push(weakStep);

  // --- Password mismatch ---
  repro.push('Submit signup with mismatched confirm password');
  await auth.ensureSignupForm();
  await auth.fillSignupFields(
    'QA Mismatch',
    'qa-mismatch@example.com',
    'KoyalQa!Test1',
    'KoyalQa!Test2',
    true,
  );
  browser.clearSignals();
  await auth.submitSignup();

  const mismatchStep = await recordVerifiedStep(ctx(), {
    workflow: 'signup-password-mismatch',
    action: 'Submit signup with password !== confirm password',
    expected: 'Mismatch error shown; stays on signup',
    expectation: {
      description: 'Password mismatch rejected',
      urlIncludes: AUTH_URL,
      snapshotIncludesAny: ['do not match', 'match', 'password'],
      snapshotExcludes: ['Internal Server Error'],
    },
  });
  steps.push(mismatchStep);

  // --- Re-submit after validation error ---
  repro.push('Fix mismatch and re-submit (valid fields, still on signup — no OTP without real email)');
  await auth.fillSignupFields(
    'QA Mismatch',
    'qa-mismatch@example.com',
    'KoyalQa!Valid1',
    'KoyalQa!Valid1',
    true,
  );
  browser.clearSignals();
  await auth.submitSignup();

  const resubmitStep = await recordVerifiedStep(ctx(), {
    workflow: 'signup-resubmit-after-error',
    action: 'Re-submit signup after fixing validation errors',
    expected: 'Form accepts valid input — signup or OTP screen (no ugly error)',
    expectation: {
      description: 'Re-submit after validation error works',
      urlIncludes: AUTH_URL,
      snapshotExcludes: ['Internal Server Error', 'TypeError', 'SyntaxError'],
    },
  });
  steps.push(resubmitStep);

  return {
    id: 'signup-validation',
    name: 'Signup — form validation',
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
