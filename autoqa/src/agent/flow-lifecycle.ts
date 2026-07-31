import type { TestStep } from '../core/types.js';
import type { SiteState } from './site-state.js';
import type { Flow } from './sitemap.js';

export type FlowRunMode = 'learning' | 'replay-validation' | 'deterministic';

export interface MilestoneExecution {
  milestoneId: string;
  verdict: TestStep['result']['verdict'];
  execution: 'explore' | 'replay' | 'auth' | 'none';
}

export function flowRecipeId(flow: Flow, milestoneId: string): string {
  return `flow:${flow.id}:${milestoneId}`;
}

export function isRunnableFlow(flow: Flow): boolean {
  return flow.status === 'exploratory' || flow.status === 'deterministic' || flow.status === 'approved';
}

export function flowRunMode(flow: Flow): FlowRunMode {
  if (flow.status === 'deterministic') return 'deterministic';
  if (flow.qualification?.phase === 'replay-validation') return 'replay-validation';
  return 'learning';
}

export function hasEveryMilestoneRecipe(state: SiteState, flow: Flow): boolean {
  return (
    flow.milestones.length > 0 &&
    flow.milestones.every((milestone) => Boolean(state.recipes[flowRecipeId(flow, milestone.id)]))
  );
}

function flowCreatesContent(flow: Flow): boolean {
  if (flow.milestones.some((milestone) => milestone.kind === 'create' || milestone.kind === 'upload')) return true;
  return /\b(create|generate|render|upload|add asset|new character|new outfit|checkout|order)\b/i.test(
    `${flow.title} ${flow.description}`,
  );
}

/**
 * Creation flows need stronger proof than a passing intermediate page check.
 * Prefer a mapped terminal page, but also accept the final milestone's own
 * verified artifact controls/list persistence because many SPAs (including
 * Koyal) have historically collapsed terminal wizard states in the sitemap.
 */
export function hasVerifiedTerminalArtifact(
  flow: Flow,
  milestoneSteps: TestStep[],
  finalPageKind?: string,
): boolean {
  if (!flowCreatesContent(flow)) return true;
  const finalMilestone = flow.milestones.at(-1);
  if (!finalMilestone) return false;
  const finalWorkflowId = `${flow.id}:${finalMilestone.id}`;
  const finalStep = [...milestoneSteps]
    .reverse()
    .find((step) => step.workflow === finalMilestone.id || step.workflow === finalWorkflowId);
  const terminalProofSteps =
    flow.manualContract
      ? flow.milestones.flatMap((milestone) => {
          if (!/\b(final video|terminal artifact|create video)\b/i.test(milestone.goal)) return [];
          const workflowId = `${flow.id}:${milestone.id}`;
          const proof = [...milestoneSteps]
            .reverse()
            .find((step) => step.workflow === milestone.id || step.workflow === workflowId);
          return proof ? [proof] : [];
        })
      : finalStep
        ? [finalStep]
        : [];
  const passingTerminalProofs = terminalProofSteps.filter((step) => step.result.verdict === 'pass');
  if (passingTerminalProofs.length === 0) return false;
  if (finalPageKind === 'terminal') return true;
  const terminalProof = passingTerminalProofs.at(-1)!;
  // recordVerifiedStep sets this only after the dedicated artifact-persistence
  // vision prompt confirms that the new item is visibly saved in its
  // list/library or that the terminal artifact is usable. Do not throw that
  // structured proof away and try to infer it again from incidental DOM words:
  // Koyal's completed Asset/Outfit pages use ordinary card UI and may contain
  // none of the generic "completed/download" vocabulary below.
  if (terminalProof.result.artifactPersistenceVerified) return true;

  const signalText = [
    terminalProof.result.signals.url,
    terminalProof.result.signals.title,
    terminalProof.result.signals.snapshot.raw,
    terminalProof.result.signals.snapshot.interactive,
  ]
    .join('\n')
    .toLowerCase();
  const artifactVisible =
    /\b(download(?: video)?|export xml|final video|completed|order complete|thank you|play(?: video)?|persistent (?:list|library)|created successfully)\b/i.test(
      signalText,
    );
  if (artifactVisible) return true;

  const goalPromisesPersistence =
    flow.milestones.some(
      (milestone) =>
        /\b(final video|terminal artifact|create video)\b/i.test(milestone.goal) &&
        /\b(verify|confirm|wait)\b/i.test(milestone.goal) &&
        /\b(persist|appears?|visible|list|library|artifact|playable|downloadable|completed|rendered)\b/i.test(
          milestone.goal,
        ),
    );
  return goalPromisesPersistence && terminalProof.result.visualAssessment?.status === 'clear';
}

export interface QualificationInput {
  mode: FlowRunMode;
  executions: MilestoneExecution[];
  terminalArtifactVerified: boolean;
  allRecipesPresent: boolean;
  now?: string;
}

/**
 * A learning run that proves a terminal artifact and passes at least 80% of
 * its milestones has learned enough to enter replay validation. Uncertain or
 * failed milestones stay visible and are retried there; they are never counted
 * as passes. Hard deterministic promotion remains intentionally stricter.
 */
export const REPLAY_VALIDATION_MIN_PASS_RATE = 0.8;

function passRate(flow: Flow, byId: Map<string, MilestoneExecution>): number {
  if (flow.milestones.length === 0) return 0;
  const passes = flow.milestones.filter(
    (milestone) => byId.get(milestone.id)?.verdict === 'pass',
  ).length;
  return passes / flow.milestones.length;
}

/** Update the flow's lifecycle after one full attempted run. */
export function qualifyFlowAfterRun(flow: Flow, input: QualificationInput): string {
  const now = input.now ?? new Date().toISOString();
  const byId = new Map(input.executions.map((execution) => [execution.milestoneId, execution]));
  const everyMilestonePassed = flow.milestones.every(
    (milestone) => byId.get(milestone.id)?.verdict === 'pass',
  );
  const everyMilestoneReplayed = flow.milestones.every(
    (milestone) => byId.get(milestone.id)?.execution === 'replay',
  );
  const replayCoverage = passRate(flow, byId);
  const replayEligible =
    replayCoverage >= REPLAY_VALIDATION_MIN_PASS_RATE && input.terminalArtifactVerified;
  const fullyLearned = everyMilestonePassed && input.allRecipesPresent && input.terminalArtifactVerified;

  if (input.mode === 'learning') {
    flow.status = 'exploratory';
    flow.qualification = replayEligible
      ? {
          phase: 'replay-validation',
          learnedAt: now,
          terminalArtifactVerifiedAt: now,
        }
      : { phase: 'learning' };
    return replayEligible
      ? `${Math.round(replayCoverage * 1000) / 10}% of milestones passed with terminal evidence; entered replay validation`
      : 'flow remains exploratory because one or more milestones/recipes/terminal checks are incomplete';
  }

  if (fullyLearned && everyMilestoneReplayed) {
    flow.status = 'deterministic';
    flow.qualification = {
      phase: 'replay-validation',
      learnedAt: flow.qualification?.learnedAt ?? now,
      terminalArtifactVerifiedAt: now,
      replayValidatedAt: now,
    };
    return 'every milestone recipe replayed successfully and terminal evidence was verified; promoted to deterministic';
  }

  const noMilestoneHardFailed = flow.milestones.every(
    (milestone) => byId.get(milestone.id)?.verdict !== 'fail',
  );
  if (
    noMilestoneHardFailed &&
    everyMilestoneReplayed &&
    input.allRecipesPresent &&
    !input.terminalArtifactVerified
  ) {
    // The deterministic recipe itself just replayed cleanly; only the
    // corroborating terminal oracle was uncertain. Re-running every milestone
    // through LLM learning cannot improve that oracle and risks replacing good
    // recipes with a different exploratory path. Keep the flow queued for
    // replay validation instead.
    flow.status = 'exploratory';
    flow.qualification = {
      phase: 'replay-validation',
      learnedAt: flow.qualification?.learnedAt ?? now,
    };
    return 'all recipes replayed without a hard failure, but terminal artifact evidence was not verified; replay validation remains required';
  }

  flow.status = 'exploratory';
  flow.qualification = replayEligible
    ? {
        phase: 'replay-validation',
        learnedAt: flow.qualification?.learnedAt ?? now,
        terminalArtifactVerifiedAt: now,
      }
    : { phase: 'learning' };
  return replayEligible
    ? 'at least 80% of milestones passed with terminal evidence; replay validation remains active while missing or refreshed recipes are retried'
    : 'deterministic proof was lost; flow demoted to exploratory learning';
}
