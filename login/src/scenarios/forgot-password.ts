import { config } from '../config.js';
import { APP_SHELL_CONSOLE_ALLOWLIST, isPostAuthUrl, POST_LOGIN_URL } from '../lib/auth-expectations.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { AuthPage } from '../lib/page-auth.js';
import { promptVerificationCode, resetNewPassword } from '../lib/prompt.js';
import { recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

export async function testForgotPasswordFullFlow(
  browser: AgentBrowser,
  evidenceDir: string,
): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const steps: TestStep[] = [];
  const auth = new AuthPage(browser);
  const verification = new VerificationLayer(browser);
  const repro: string[] = [];
  const explorerLog: string[] = [];
  const resetEmail = config.resetEmail;
  const newPassword = resetNewPassword();

  const ctx = (): StepContext => ({
    browser,
    verification,
    evidenceDir,
    stepsToReproduce: repro,
    explorerSteps: explorerLog.length ? [...explorerLog] : undefined,
  });

  browser.clearSignals();
  repro.push(`Open ${auth.loginUrl(config.baseUrl)}`);
  auth.openLogin(config.baseUrl);

  repro.push(`Request password reset for ${resetEmail}`);
  const requestNav = await auth.requestPasswordReset(resetEmail);
  auth.appendExplorerSteps(repro, requestNav);
  explorerLog.push(...auth.collectExplorerSteps(requestNav));

  const requestStep = await recordVerifiedStep(ctx(), {
    workflow: 'request-reset',
    action: `Request reset email for ${resetEmail}`,
    expected: 'Reset email sent — verification/code entry UI appears or success message shown',
    expectation: {
      description: 'Password reset request accepted',
      urlIncludes: '/login',
      snapshotIncludes: ['Email'],
      requireNetworkActivity: false,
      allowedConsoleErrorPatterns: [/Failed to load resource/i],
    },
  });
  steps.push(requestStep);

  repro.push('Wait for user to paste verification code from email');
  const code = await promptVerificationCode();
  repro.push(`Enter verification code (length ${code.length}) and new password`);

  browser.clearSignals();
  const completeNav = await auth.completePasswordReset(code, newPassword);
  auth.appendExplorerSteps(repro, completeNav);
  explorerLog.push(...auth.collectExplorerSteps(completeNav));

  const resetStep = await recordVerifiedStep(ctx(), {
    workflow: 'complete-reset',
    action: 'Enter verification code and set new password',
    expected: 'Password reset succeeds with readable confirmation (not raw error)',
    expectation: {
      description: 'Password reset completes successfully',
      snapshotExcludes: ['Internal Server Error', 'TypeError', 'SyntaxError', 'stack trace'],
      requireNetworkActivity: false,
      allowedConsoleErrorPatterns: [/Failed to load resource/i],
    },
  });
  steps.push(resetStep);

  repro.push(`Log in with reset account ${resetEmail} and new password`);
  browser.clearSignals();

  const alreadyLoggedIn = isPostAuthUrl(browser.getUrl());
  if (!alreadyLoggedIn) {
    await auth.ensureLoginForm();
    const fillNav = await auth.fillLogin(resetEmail, newPassword);
    auth.appendExplorerSteps(repro, fillNav);
    explorerLog.push(...auth.collectExplorerSteps(fillNav));

    const submitNav = await auth.submitLogin();
    auth.appendExplorerSteps(repro, submitNav);
    explorerLog.push(...auth.collectExplorerSteps(submitNav));
  } else {
    repro.push('Already authenticated after reset — skip redundant login');
  }

  const loginStep = await recordVerifiedStep(ctx(), {
    workflow: 'login-after-reset',
    action: alreadyLoggedIn
      ? 'Verify authenticated app shell after password reset'
      : 'Login with new password after reset',
    expected: 'Successful login lands on /dashboard or /projects',
    expectation: {
      description: 'New password works for login',
      urlIncludes: POST_LOGIN_URL,
      snapshotIncludes: ['link "Projects"'],
      requireNetworkActivity: false,
      allowedConsoleErrorPatterns: APP_SHELL_CONSOLE_ALLOWLIST,
    },
  });
  steps.push(loginStep);

  repro.push(`New password set by runner: ${newPassword.slice(0, 8)}*** (full value in .env as KOYAL_RESET_NEW_PASSWORD)`);

  return {
    id: 'forgot-password',
    name: 'Forgot password — full flow',
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
