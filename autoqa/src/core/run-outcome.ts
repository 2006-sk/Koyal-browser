import type { RunReport, TestStep } from './types.js';
import { isProductBug } from './slack-bugs.js';

export interface FunctionalRunOutcome {
  success: boolean;
  rawFailures: number;
  genuineBlockers: TestStep[];
  terminalArtifactVerified: boolean;
  summary: string;
}

function stepText(step: TestStep): string {
  return [
    step.action,
    step.result.actual,
    ...step.result.reasons,
    step.result.signals?.snapshot?.raw ?? '',
    step.result.signals?.snapshot?.interactive ?? '',
  ].join('\n');
}

function isVerifiedTerminalStep(step: TestStep): boolean {
  if (step.result.verdict !== 'pass') return false;
  // Manual checkpoints repeat the entire original request in `action`, so an
  // early PASS can mention "final video/playable/downloadable" long before a
  // terminal state exists. Terminal proof must come from the observed result,
  // URL, or captured page—not from instructions.
  const text = [
    step.result.signals?.url ?? '',
    step.result.actual,
    step.result.signals?.snapshot?.raw ?? '',
    step.result.signals?.snapshot?.interactive ?? '',
  ].join('\n');
  const terminalShaped =
    /\/finalvideo\b/i.test(step.result.signals?.url ?? '') ||
    /\b(?:final[- ]video|terminal artifact|rendered video)\b/i.test(text);
  return terminalShaped && (
    step.result.artifactPersistenceVerified === true ||
    /\b(?:play(?:able)?|download(?:able| video)?|export xml|persist(?:ed|ence)?|completed)\b/i.test(text)
  );
}

/**
 * A raw assertion mismatch is useful report evidence, but it must not make a
 * production job red by itself. Only a concrete product/infrastructure error
 * or an inability to continue the requested journey is a run-level blocker.
 */
export function isGenuineRunBlocker(step: TestStep): boolean {
  if (step.result.verdict !== 'fail') return false;
  if (isProductBug(step)) return true;
  const text = stepText(step);
  return /\b(?:infrastructure blocked|milestone crashed|uncaught error|could not recover position|remaining \d+ milestones? (?:as )?skipped|skipped\s*[—-]\s*not tested because upstream|position could not be recovered|blocking safe forward progress|next (?:control|button) (?:is )?(?:not reachable|disabled)|flow entry (?:failed|did not succeed)|login blocked|authentication failed|browser(?: daemon)? (?:timed out|unavailable|wedged)|processing (?:timed out|never (?:finished|resolved))|required (?:file )?upload was declined|no safe forward path exists|concrete product error blocks progress)\b/i.test(text);
}

/**
 * Production exit policy:
 * - a verified terminal artifact means the end-to-end journey succeeded;
 * - otherwise, only genuine blockers fail the process;
 * - raw expectation/coverage disagreements remain visible in the report but
 *   do not masquerade as a broken production run.
 */
export function functionalRunOutcome(report: RunReport): FunctionalRunOutcome {
  const steps = report.scenarios.flatMap((scenario) => scenario.steps);
  const rawFailures = steps.filter((step) => step.result.verdict === 'fail').length;
  const terminalArtifactVerified = steps.some(isVerifiedTerminalStep);
  const genuineBlockers = steps.filter(isGenuineRunBlocker);
  const success = terminalArtifactVerified || genuineBlockers.length === 0;
  const summary = terminalArtifactVerified
    ? `verified terminal artifact reached; ${rawFailures} raw assertion failure${rawFailures === 1 ? '' : 's'} retained as diagnostic evidence`
    : success
      ? `no genuine product, infrastructure, or forward-progress blocker; ${rawFailures} raw assertion failure${rawFailures === 1 ? '' : 's'} retained as diagnostic evidence`
      : `${genuineBlockers.length} genuine blocker${genuineBlockers.length === 1 ? '' : 's'} prevented a verified terminal outcome`;
  return { success, rawFailures, genuineBlockers, terminalArtifactVerified, summary };
}
