import { config } from '../config.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { AuthPage } from '../lib/page-auth.js';
import { recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

const INVALID_EMAIL = 'qa-invalid-nonexistent@koyal.ai';
const INVALID_PASSWORD = 'WrongPass1';

export async function testLoginInvalid(
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

  const loginNav = await auth.ensureLoginForm();
  auth.appendExplorerSteps(repro, loginNav);

  repro.push(`Fill invalid email ${INVALID_EMAIL} and password`);
  const fillNav = await auth.fillLogin(INVALID_EMAIL, INVALID_PASSWORD, true);
  auth.appendExplorerSteps(repro, fillNav);

  browser.clearSignals();
  repro.push('Click submit with invalid credentials');
  const submitNav = await auth.submitLogin();
  auth.appendExplorerSteps(repro, submitNav);

  const loginStep = await recordVerifiedStep(ctx(), {
    workflow: 'submit-invalid-login',
    action: 'Submit invalid credentials',
    expected: 'Stay on login page with readable error (not raw backend error or silent failure)',
    expectation: {
      description: 'Invalid login shows user-friendly error on /login',
      urlIncludes: '/login',
      snapshotIncludes: ['User not found'],
      networkFilter: 'auth',
      expectedNetworkStatuses: [404, 401, 400],
      requireNetworkActivity: false,
      allowedConsoleErrorPatterns: [
        /Failed to load resource: the server responded with a status of 404/i,
        /Failed to load resource: the server responded with a status of 400/i,
        /Failed to load resource/i,
      ],
      uglyErrorPatterns: [
        /Internal Server Error/i,
        /TypeError:/i,
        /SyntaxError:/i,
        /UnhandledPromiseRejection/i,
        /ECONNREFUSED/i,
      ],
    },
  });
  steps.push(loginStep);

  const errorText = auth.visibleUserFacingErrorText(loginStep.result.signals.snapshot.raw);
  if (!errorText && loginStep.result.verdict === 'pass') {
    loginStep.result.verdict = 'needs-review';
    loginStep.result.reasons.push('Readable error text not detected by helper patterns');
    loginStep.result.severity = 'medium';
  }

  return {
    id: 'login-invalid',
    name: 'Login — invalid credentials',
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
