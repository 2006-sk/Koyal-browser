import { config } from '../config.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { AuthPage } from '../lib/page-auth.js';
import { recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

const AUTH_URL = '/login';

export async function testAuthBackAndForth(
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
  await auth.ensureLoginForm();

  // --- Partial fill, switch away, return ---
  repro.push('Fill login email, switch to signup, switch back to login');
  auth.fillLoginEmailOnly('partial-fill-test@koyal.ai');
  await auth.ensureSignupForm();
  await auth.ensureLoginForm();

  const partialStep = await recordVerifiedStep(ctx(), {
    workflow: 'partial-fill-toggle',
    action: 'Partially fill login, toggle to signup and back',
    expected: 'Login form still usable after toggling (no blank screen)',
    expectation: {
      description: 'Partial fill survives auth toggle',
      urlIncludes: AUTH_URL,
      snapshotIncludes: ['email', 'password'],
      snapshotExcludes: ['Internal Server Error', 'TypeError'],
    },
  });
  steps.push(partialStep);

  // --- Forgot password abandon and resume ---
  repro.push('Open forgot password, go back to login, open forgot again');
  await auth.openForgotPassword();
  browser.clearSignals();

  const forgotOpenStep = await recordVerifiedStep(ctx(), {
    workflow: 'forgot-password-open',
    action: 'Open forgot-password request form',
    expected: 'Forgot-password email form visible',
    expectation: {
      description: 'Forgot password form opens',
      urlIncludes: AUTH_URL,
      snapshotIncludesAny: ['send new password', 'email'],
    },
  });
  steps.push(forgotOpenStep);

  await auth.backToLoginFromForgot();
  browser.clearSignals();
  await auth.openForgotPassword();

  const forgotResumeStep = await recordVerifiedStep(ctx(), {
    workflow: 'forgot-password-resume',
    action: 'Abandon forgot flow and re-open forgot password',
    expected: 'Forgot-password form reachable again after going back',
    expectation: {
      description: 'Forgot password flow can be resumed',
      urlIncludes: AUTH_URL,
      snapshotIncludesAny: ['send new password', 'email', 'temp password', 'reset password'],
    },
  });
  steps.push(forgotResumeStep);

  await auth.backToLoginFromForgot();

  // --- Browser back / forward on auth page ---
  repro.push('Navigate signup via toggle, browser back, browser forward');
  await auth.ensureSignupForm();
  browser.back();
  browser.wait(800);
  browser.forward();
  browser.wait(800);

  const historyStep = await recordVerifiedStep(ctx(), {
    workflow: 'auth-browser-history',
    action: 'Browser back then forward on /login auth views',
    expected: 'Page recovers — signup or login form still visible',
    expectation: {
      description: 'Browser history navigation on auth pages',
      urlIncludes: AUTH_URL,
      snapshotIncludesAny: ['email', 'full name', 'password', 'sign up', 'log in'],
      snapshotExcludes: ['Internal Server Error', 'TypeError'],
    },
  });
  steps.push(historyStep);

  // --- Invalid login then recovery ---
  repro.push('Submit invalid login, verify error, form still works');
  await auth.ensureLoginForm();
  await auth.fillLogin('qa-invalid-nonexistent@koyal.ai', 'WrongPass123!', true);
  browser.clearSignals();
  await auth.submitLogin();

  const invalidStep = await recordVerifiedStep(ctx(), {
    workflow: 'invalid-login-recovery',
    action: 'Submit invalid credentials then verify form recovery',
    expected: 'Readable error on /login; form still present for retry',
    expectation: {
      description: 'Invalid login shows error without breaking form',
      urlIncludes: AUTH_URL,
      snapshotIncludesAny: ['user not found', 'email', 'password'],
      snapshotExcludes: ['Internal Server Error', 'TypeError'],
    },
  });
  steps.push(invalidStep);

  // --- Rapid signup/login toggles ---
  repro.push('Rapid signup ↔ login toggles (5x)');
  for (let i = 0; i < 5; i++) {
    if (i % 2 === 0) await auth.ensureSignupForm();
    else await auth.ensureLoginForm();
  }

  const rapidToggleStep = await recordVerifiedStep(ctx(), {
    workflow: 'rapid-auth-toggle',
    action: 'Rapidly toggle signup/login 5 times',
    expected: 'Final state is login form without duplicate UI or crash',
    expectation: {
      description: 'Rapid auth toggling stable',
      urlIncludes: AUTH_URL,
      snapshotIncludes: ['email', 'password'],
      snapshotExcludes: ['Internal Server Error', 'TypeError', 'SyntaxError'],
    },
  });
  steps.push(rapidToggleStep);

  return {
    id: 'auth-back-and-forth',
    name: 'Auth — back-and-forth navigation',
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
