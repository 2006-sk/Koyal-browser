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
  const finalStep = [...milestoneSteps].reverse().find((step) => step.workflow === finalMilestone.id);
  if (!finalStep || finalStep.result.verdict !== 'pass') return false;
  if (finalPageKind === 'terminal') return true;

  const signalText = [
    finalStep.result.signals.url,
    finalStep.result.signals.title,
    finalStep.result.signals.snapshot.raw,
    finalStep.result.signals.snapshot.interactive,
  ]
    .join('\n')
    .toLowerCase();
  const artifactVisible =
    /\b(download(?: video)?|export xml|final video|completed|order complete|thank you|play(?: video)?|persistent (?:list|library)|created successfully)\b/i.test(
      signalText,
    );
  if (artifactVisible) return true;

  const goalPromisesPersistence =
    /\b(verify|confirm)\b/i.test(finalMilestone.goal) &&
    /\b(persist|appears?|visible|list|library|artifact|playable|downloadable|completed)\b/i.test(finalMilestone.goal);
  return goalPromisesPersistence && finalStep.result.visualAssessment?.status === 'clear';
}

export interface QualificationInput {
  mode: FlowRunMode;
  executions: MilestoneExecution[];
  terminalArtifactVerified: boolean;
  allRecipesPresent: boolean;
  now?: string;
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
  const fullyLearned = everyMilestonePassed && input.allRecipesPresent && input.terminalArtifactVerified;

  if (input.mode === 'learning') {
    flow.status = 'exploratory';
    flow.qualification = fullyLearned
      ? {
          phase: 'replay-validation',
          learnedAt: now,
          terminalArtifactVerifiedAt: now,
        }
      : { phase: 'learning' };
    return fullyLearned
      ? 'all milestones learned with terminal evidence; replay validation is required before promotion'
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

  flow.status = 'exploratory';
  flow.qualification = fullyLearned
    ? {
        phase: 'replay-validation',
        learnedAt: flow.qualification?.learnedAt ?? now,
        terminalArtifactVerifiedAt: now,
      }
    : { phase: 'learning' };
  return fullyLearned
    ? 'recipe fallback occurred; refreshed recipes must pass a complete replay-validation run'
    : 'deterministic proof was lost; flow demoted to exploratory learning';
}
