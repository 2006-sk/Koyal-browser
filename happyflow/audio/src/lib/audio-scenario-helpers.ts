import type { StepContext } from './scenario-runner.js';
import type { SignalBundle, TestStep, VerificationExpectation } from './types.js';
import { recordVerifiedStep } from './scenario-runner.js';
import { AUDIO_EXPECTATION_BASE } from './audio-expectations.js';
import {
  isKoyalProductBug,
  KOYAL_BUG_TUS_TRIM_UPLOAD,
  type KoyalProductBugError,
} from './page-audio.js';

export const STEP_BASE: Partial<VerificationExpectation> = {
  ...AUDIO_EXPECTATION_BASE,
  maxUnexpectedNetwork5xx: 2,
};

export async function probeStep(
  ctx: StepContext,
  repro: string[],
  workflow: string,
  action: string,
  expected: string,
  expectation: VerificationExpectation,
  fn?: () => void,
  waitMs?: number,
): Promise<TestStep> {
  repro.push(action);
  ctx.browser.clearSignals();
  if (fn) {
    try {
      fn();
    } catch (error) {
      if (!expectation.description.includes('optional')) throw error;
    }
  }
  return recordVerifiedStep(ctx, {
    workflow,
    action,
    expected,
    expectation,
    waitOptions: waitMs ? { maxWaitMs: waitMs, pollMs: 3000 } : undefined,
  });
}

export function assertNoStepFailures(steps: TestStep[], scenarioId: string): void {
  const failures = steps.filter((s) => s.result.verdict === 'fail');
  if (failures.length > 0) {
    throw new Error(
      `${scenarioId} had ${failures.length} failures: ${failures.map((f) => f.workflow).join(', ')}`,
    );
  }
}

/**
 * Record a FAIL step for a confirmed Koyal product bug and stop the scenario.
 * The harness did its job; the flow is rejected because of Koyal, not us.
 */
export async function recordKoyalProductBugStep(
  ctx: StepContext,
  repro: string[],
  error: KoyalProductBugError,
): Promise<TestStep> {
  repro.push(`Advance past audio type → Story Type (blocked: ${error.bugId})`);
  const verification = ctx.verification;
  let signals: SignalBundle;
  try {
    signals = await verification.captureSignals();
  } catch {
    signals = {
      url: (() => {
        try {
          return ctx.browser.getUrl();
        } catch {
          return 'unknown';
        }
      })(),
      title: '',
      snapshot: { raw: '', interactive: '' },
      pageErrors: [],
      consoleMessages: [],
      consoleErrors: [],
      networkRequests: [],
    };
  }

  const step: TestStep = {
    workflow: `koyal-bug-${error.bugId}`,
    action: 'Next after Choose Audio Type (performTrimAndUpload)',
    expected: 'Navigate to Story Type (/selectStoryType)',
    result: {
      verdict: 'fail',
      severity: 'critical',
      expected: 'Story Type after Next',
      actual: error.message,
      signals,
      reasons: [
        'KOYAL PRODUCT BUG (not a harness failure)',
        error.message,
        `Bug id: ${error.bugId}`,
        'Owner: Koyal — fix tus PATCH on /api/user/uploads/tus/* (nginx 405 Not Allowed)',
      ],
      retried: false,
    },
    stepsToReproduce: [...repro],
  };

  console.log(`[FAIL] ${step.workflow} — Koyal product bug (harness OK)`);
  console.log(`       ${error.message.slice(0, 180)}…`);
  return step;
}

export { isKoyalProductBug, KOYAL_BUG_TUS_TRIM_UPLOAD };
