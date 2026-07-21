import fs from 'node:fs';
import path from 'node:path';
import { AgentBrowser } from './agent-browser.js';
import {
  attachEvidenceToStep,
  captureNetworkAll,
  capturePageErrors,
  captureStepArtifacts,
  patchStepSummaryVerdict,
  writeJson,
} from './evidence.js';
import type { TestStep, VerificationExpectation, VerificationResult } from './types.js';
import { VerificationLayer } from './verification.js';
import type { LlmClient } from './llm/client.js';
import { assessScreenshot } from './visual-verification.js';

export interface StepContext {
  browser: AgentBrowser;
  verification: VerificationLayer;
  evidenceDir: string;
  stepsToReproduce: string[];
  llm?: LlmClient;
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
    waitOptions?: { maxWaitMs?: number; pollMs?: number };
    /** LLM/explorer step log for this milestone, if the explorer ran (not a recipe replay/probe). */
    explorerSteps?: string[];
    /** Run screenshot review for real milestones (not every probe). */
    visualVerification?: boolean;
  },
): Promise<TestStep> {
  const result = await ctx.verification.verifyAfterAction(meta.expectation, meta.waitOptions);

  const networkAllResp = ctx.browser.networkRequestsJson();
  const networkAll = networkAllResp.data?.requests ?? [];

  const slug = `${String(ctx.stepsToReproduce.length).padStart(2, '0')}-${slugify(meta.workflow)}`;
  const stepDir = path.join(ctx.evidenceDir, slug);

  // meta.explorerSteps used to be silently dropped here — captureStepArtifacts
  // DOES accept it (StepArtifactMeta.explorerSteps), but no caller ever passed
  // it, so step-summary.md's "Explorer / agent actions" section always
  // rendered "_No LLM explorer steps recorded_" even when the explorer had
  // just run a real multi-step sequence (fills, clicks, the new "press"
  // action, ...). The caller (flow-runner.ts) only set it on the RETURNED
  // TestStep object, AFTER this function had already written the file.
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
      explorerSteps: meta.explorerSteps,
    },
    (filePath) => ctx.browser.screenshotAnnotated(path.resolve(filePath)),
  );

  captureNetworkAll(stepDir, networkAll);
  files.push(path.join(stepDir, 'network-all.json'));

  capturePageErrors(stepDir, result.signals.pageErrors);
  files.push(path.join(stepDir, 'page-errors.json'));

  const screenshotPath = path.join(stepDir, 'screenshot.png');
  if (meta.visualVerification && ctx.llm && fs.existsSync(screenshotPath)) {
    try {
      const visual = await assessScreenshot(ctx.llm, screenshotPath, {
        action: meta.action,
        expected: meta.expected,
        url: result.signals.url,
        observations: meta.explorerSteps?.join('\n'),
      });
      result.visualAssessment = visual;
      const visualPath = path.join(stepDir, 'visual-assessment.json');
      writeJson(visualPath, visual);
      files.push(visualPath);
      // Vision is corroborating only: it may request review, never create a
      // hard failure and never erase a deterministic failure.
      if (visual.status === 'concern' && result.verdict === 'pass') {
        result.verdict = 'needs-review';
        result.reasons.push(`Visual review found a concrete concern: ${visual.summary}`);
        patchStepSummaryVerdict(stepDir, result.verdict, result.reasons);
      }
    } catch (error) {
      console.warn(`[vision] screenshot review unavailable: ${error instanceof Error ? error.message : error}`);
    }
  }

  const step: TestStep = {
    workflow: meta.workflow,
    action: meta.action,
    expected: meta.expected,
    result,
    stepsToReproduce: [...ctx.stepsToReproduce],
    explorerSteps: meta.explorerSteps,
  };

  const withEvidence = attachEvidenceToStep(step, ctx.evidenceDir, files);

  console.log(
    `[${result.verdict.toUpperCase()}] ${meta.workflow} → ${path.join(stepDir, 'step-summary.md')}`,
  );

  return withEvidence;
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
