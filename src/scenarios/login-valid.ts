import path from 'node:path';
import { APP_SHELL_CONSOLE_ALLOWLIST, POST_LOGIN_URL } from '../lib/auth-expectations.js';
import { config, requireCredentials } from '../config.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { AuthPage } from '../lib/page-auth.js';
import { recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

export async function testLoginValid(
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

  repro.push('Ensure login form is visible (LLM exploration or deterministic fallback)');
  const loginNav = await auth.ensureLoginForm();
  auth.appendExplorerSteps(repro, loginNav);

  const openStep = await recordVerifiedStep(ctx(), {
    workflow: 'open-login',
    action: 'Navigate to /login and switch to login form',
    expected: 'Login form with Email and Password fields visible',
    expectation: {
      description: 'Login form visible on /login',
      urlIncludes: '/login',
      snapshotIncludes: ['textbox "Email*"', 'textbox "Password*"'],
      uglyErrorPatterns: [
        /Internal Server Error/i,
        /TypeError:/i,
        /SyntaxError:/i,
        /UnhandledPromiseRejection/i,
        /ECONNREFUSED/i,
      ],
    },
  });
  steps.push(openStep);

  repro.push(`Fill email ${config.testEmail} and password (redacted)`);
  const fillNav = await auth.fillLogin(config.testEmail, config.testPassword, true);
  auth.appendExplorerSteps(repro, fillNav);

  browser.clearSignals();
  repro.push('Click submit to log in');
  const submitNav = await auth.submitLogin();
  auth.appendExplorerSteps(repro, submitNav);

  const loginStep = await recordVerifiedStep(ctx(), {
    workflow: 'submit-valid-login',
    action: 'Submit valid credentials',
    expected: 'Redirect to /dashboard with authenticated app shell',
    expectation: {
      description: 'Successful login lands in authenticated app shell',
      urlIncludes: POST_LOGIN_URL,
      snapshotIncludes: ['link "Projects"', 'Good afternoon'],
      networkFilter: 'auth',
      requireNetworkActivity: false,
      allowedConsoleErrorPatterns: APP_SHELL_CONSOLE_ALLOWLIST,
    },
  });
  steps.push(loginStep);

  repro.push('Save authenticated session state for later scenarios');
  const statePath = path.join(config.stateDir, `${config.sessionAuth}.json`);
  browser.stateSave(statePath);

  return {
    id: 'login-valid',
    name: 'Login — valid credentials',
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
