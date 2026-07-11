import type { AgentBrowser } from './agent-browser.js';
import type { StepContext } from './scenario-runner.js';
import type { TestStep, VerificationExpectation } from './types.js';
import { recordVerifiedStep } from './scenario-runner.js';
import { AUDIO_EXPECTATION_BASE } from './audio-expectations.js';

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
