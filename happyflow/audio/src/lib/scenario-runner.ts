import path from 'node:path';
import { AgentBrowser } from './agent-browser.js';
import type { TestStep, VerificationExpectation, VerificationResult } from './types.js';
import { VerificationLayer } from './verification.js';

export interface StepContext {
  browser: AgentBrowser;
  verification: VerificationLayer;
  evidenceDir: string;
  stepsToReproduce: string[];
}

/**
 * Verify a step and keep signals in memory for the single REPORT.md.
 * Does not write per-step artifact folders (screenshots/json/txt).
 */
export async function recordVerifiedStep(
  ctx: StepContext,
  meta: {
    workflow: string;
    action: string;
    expected: string;
    expectation: VerificationExpectation;
    waitOptions?: { maxWaitMs?: number; pollMs?: number };
  },
): Promise<TestStep> {
  const result = await ctx.verification.verifyAfterAction(meta.expectation, meta.waitOptions);

  const step: TestStep = {
    workflow: meta.workflow,
    action: meta.action,
    expected: meta.expected,
    result,
    stepsToReproduce: [...ctx.stepsToReproduce],
  };

  console.log(`[${result.verdict.toUpperCase()}] ${meta.workflow}`);

  return step;
}

export function assertStepPassed(step: TestStep): void {
  if (step.result.verdict === 'fail') {
    throw new Error(`Step failed: ${step.workflow} — ${step.result.reasons.join('; ')}`);
  }
}

export function summarizeSteps(steps: TestStep[]): VerificationResult['verdict'] {
  if (steps.some((s) => s.result.verdict === 'fail')) return 'fail';
  if (steps.some((s) => s.result.verdict === 'needs-review')) return 'needs-review';
  return 'pass';
}

/** No-op: presentation mode does not keep step dirs. */
export function scenarioWorkDir(evidenceDir: string, _slug: string): string {
  return evidenceDir;
}

export function stepSlug(workflow: string, index: number): string {
  const slug = workflow.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `${String(index).padStart(2, '0')}-${slug}`;
}

export { path };
