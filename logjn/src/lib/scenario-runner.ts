import path from 'node:path';
import { AgentBrowser } from './agent-browser.js';
import {
  attachEvidenceToStep,
  captureNetworkAll,
  capturePageErrors,
  captureStepArtifacts,
} from './evidence.js';
import type { TestStep, VerificationExpectation, VerificationResult } from './types.js';
import { VerificationLayer } from './verification.js';

export interface StepContext {
  browser: AgentBrowser;
  verification: VerificationLayer;
  evidenceDir: string;
  stepsToReproduce: string[];
  explorerSteps?: string[];
}

function slugify(workflow: string): string {
  return workflow.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

export async function recordVerifiedStep(
  ctx: StepContext,
  meta: {
    workflow: string;
    action: string;
    expected: string;
    expectation: VerificationExpectation;
  },
): Promise<TestStep> {
  const result = await ctx.verification.verifyAfterAction(meta.expectation);

  // Also capture unfiltered network for artifact completeness
  const networkAllResp = ctx.browser.networkRequestsJson();
  const networkAll = networkAllResp.data?.requests ?? [];

  const slug = `${String(ctx.stepsToReproduce.length).padStart(2, '0')}-${slugify(meta.workflow)}`;
  const stepDir = path.join(ctx.evidenceDir, slug);

  const files = await captureStepArtifacts(
    ctx.evidenceDir,
    slug,
    result.signals,
    ctx.stepsToReproduce,
    {
      workflow: meta.workflow,
      action: meta.action,
      verdict: result.verdict,
      reasons: result.reasons,
      explorerSteps: ctx.explorerSteps,
    },
    (filePath) => ctx.browser.screenshotAnnotated(path.resolve(filePath)),
  );

  captureNetworkAll(stepDir, networkAll);
  files.push(path.join(stepDir, 'network-all.json'));

  capturePageErrors(stepDir, result.signals.pageErrors);
  files.push(path.join(stepDir, 'page-errors.json'));

  const step: TestStep = {
    workflow: meta.workflow,
    action: meta.action,
    expected: meta.expected,
    result,
    stepsToReproduce: [...ctx.stepsToReproduce],
    explorerSteps: ctx.explorerSteps ? [...ctx.explorerSteps] : undefined,
  };

  const withEvidence = attachEvidenceToStep(step, ctx.evidenceDir, files);

  const summaryPath = path.join(stepDir, 'step-summary.md');
  console.log(
    `[${result.verdict.toUpperCase()}] ${meta.workflow} → artifacts: ${summaryPath}`,
  );

  return withEvidence;
}

export function assertStepPassed(step: TestStep): void {
  if (step.result.verdict === 'fail') {
    const reasons = step.result.reasons.join('; ');
    throw new Error(`Step failed: ${step.workflow} — ${reasons}`);
  }
}

export function formatResultLine(step: TestStep): string {
  return `[${step.result.verdict.toUpperCase()}] ${step.workflow}: ${step.action}`;
}

export function summarizeSteps(steps: TestStep[]): VerificationResult['verdict'] {
  if (steps.some((s) => s.result.verdict === 'fail')) return 'fail';
  if (steps.some((s) => s.result.verdict === 'needs-review')) return 'needs-review';
  return 'pass';
}
