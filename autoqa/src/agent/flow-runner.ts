import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import { randomEditMarker } from '../core/edits.js';
import type { Explorer, ExplorerResult } from '../core/explorer.js';
import { writeJson } from '../core/evidence.js';
import { scenarioEvidenceDir } from '../core/report.js';
import { recordVerifiedStep, type StepContext } from '../core/scenario-runner.js';
import type {
  RunReport,
  ScenarioResult,
  TestStep,
  VerificationExpectation,
  Verdict,
} from '../core/types.js';
import { VerificationLayer } from '../core/verification.js';
import { ensureAuthenticated, type AuthContext } from './auth.js';
import { extractCandidates, type Statements } from './statements.js';
import { runProbesForMilestone, type ProbeContext } from './probes.js';
import { recordFromExplorer, type RecipePlayer } from './recipes.js';
import { Nav } from '../core/nav.js';
import type { Interact } from './interact.js';
import type { SiteState } from './site-state.js';
import { matchPage, type Flow, type FlowMilestone } from './sitemap.js';

const STEP_BASE: Partial<VerificationExpectation> = {
  allowPageErrors: true,
  allowConsoleErrors: false,
  maxUnexpectedNetwork5xx: 2,
};

const MILESTONE_WAIT_MS: Record<FlowMilestone['kind'], number> = {
  navigate: 15000,
  edit: 20000,
  create: 30000,
  upload: 60000,
  verify: 15000,
};

export interface FlowRunnerDeps {
  browser: AgentBrowser;
  state: SiteState;
  interact: Interact;
  explorer: Explorer;
  player: RecipePlayer;
  statements: Statements;
}

function currentPageId(deps: FlowRunnerDeps): string {
  const page = matchPage(
    deps.state.sitemap,
    deps.browser.getUrl(),
    deps.browser.snapshotInteractive(),
  );
  return page?.id ?? 'unknown';
}

/** Wait for an expected guard phase to appear before declaring the flow off-track. */
function waitForGuardPhase(deps: FlowRunnerDeps, phases: string[], maxMs: number): string {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const id = currentPageId(deps);
    if (phases.includes(id)) return id;
    if (Date.now() >= deadline) return id;
    deps.browser.wait(3000);
  }
}

/** Only literal-looking hints are snapshot-matched; prose descriptions would never appear on the page. */
function isLiteralHint(hint: string): boolean {
  return hint.length <= 60 && !/[()]/.test(hint) && hint.split(/\s+/).length <= 8;
}

function baseExpectationFor(milestone: FlowMilestone): VerificationExpectation {
  const expectation: VerificationExpectation = {
    ...STEP_BASE,
    description: milestone.successHint ?? milestone.goal,
  };
  if (milestone.successHint && isLiteralHint(milestone.successHint)) {
    expectation.snapshotIncludesAny = [milestone.successHint];
  }
  return expectation;
}

async function navigateToEntry(deps: FlowRunnerDeps, flow: Flow): Promise<void> {
  const { browser, state, player } = deps;
  const gotoRecipe = `goto:${flow.entry.pageId}`;

  if (player.has(gotoRecipe)) {
    const replay = await player.tryReplay(gotoRecipe, { pageId: flow.entry.pageId });
    if (replay.ok) return;
  }
  if (flow.entry.url) {
    browser.open(`${state.sitemap.origin}${flow.entry.url.replace(state.sitemap.origin, '')}`);
    browser.wait(2000);
    return;
  }
  const entryPage = state.sitemap.pages[flow.entry.pageId];
  const directPattern = entryPage?.urlPatterns.find((p) => !p.includes(':id'));
  if (directPattern) {
    browser.open(`${state.sitemap.origin}${directPattern}`);
    browser.wait(2000);
    return;
  }
  await deps.explorer.achieveGoal(
    `Navigate to the "${entryPage?.title ?? flow.entry.pageId}" page (${entryPage?.description ?? ''}). Use "done" when you are there.`,
    { maxSteps: 6 },
  );
}

async function runMilestone(
  deps: FlowRunnerDeps,
  flow: Flow,
  milestone: FlowMilestone,
  ctx: StepContext,
  authCtx: AuthContext,
): Promise<{ step: TestStep; marker?: string }> {
  const { browser, state, player, statements, interact } = deps;
  const decisionsBefore = interact.decisions.length;
  let pageId = currentPageId(deps);

  // guard-phase check: poll first (processing lag ≠ off-track — restarting a wizard
  // from its entry mid-flow destroys the walk), then recover
  if (milestone.guardPhases?.length && !milestone.guardPhases.includes(pageId) && pageId !== 'unknown') {
    pageId = waitForGuardPhase(deps, milestone.guardPhases, 30000);
    if (!milestone.guardPhases.includes(pageId)) {
      console.log(`[flow] off-track (on "${pageId}", expected ${milestone.guardPhases.join('/')}) — recovering`);
      await navigateToEntry(deps, flow);
    }
  }

  browser.clearSignals();
  const verification = ctx.verification;
  const before = await verification.captureSignals();

  // fill in run-unique edit markers so edits are real and verifiable
  let goal = milestone.goal;
  let marker: string | undefined;
  if (milestone.kind === 'edit' || milestone.kind === 'create') {
    marker = randomEditMarker('autoqa');
    goal = `${goal}\nWhen entering test text, use exactly: "${marker}"`;
  }

  const recipeId = `flow:${flow.id}:${milestone.id}`;
  let explored: ExplorerResult | null = null;
  let replayOk = false;

  if (player.has(recipeId)) {
    const replay = await player.tryReplay(recipeId, {
      pageId,
      secrets: { email: state.secrets.email, password: state.secrets.password },
    });
    replayOk = replay.ok;
  }

  if (!replayOk) {
    explored = await deps.explorer.achieveGoal(goal);
    // mid-flow auth wall → re-login once and retry
    if (!explored.success && /log ?in|password/i.test(explored.finalSnapshot.slice(0, 2000))) {
      console.log('[flow] hit an auth wall mid-flow — re-authenticating');
      await ensureAuthenticated(authCtx);
      await navigateToEntry(deps, flow);
      explored = await deps.explorer.achieveGoal(goal);
    }
  }

  // verify with the KB-augmented expectation
  const base = baseExpectationFor(milestone);
  if (marker) {
    base.snapshotIncludesAny = [...(base.snapshotIncludesAny ?? []), marker];
  }
  const expectation = statements.augmentExpectation(base, pageId);

  const step = await recordVerifiedStep(ctx, {
    workflow: `${flow.id}:${milestone.id}`,
    action: milestone.goal,
    expected: milestone.successHint ?? milestone.goal,
    expectation,
    waitOptions: {
      maxWaitMs: milestone.maxWaitMs ?? MILESTONE_WAIT_MS[milestone.kind],
      pollMs: milestone.maxWaitMs && milestone.maxWaitMs > 60000 ? 5000 : 2000,
    },
  });
  if (explored) step.explorerSteps = explored.stepsTaken;

  // A missed successHint is an LLM guess, not ground truth: when it is the ONLY
  // failure signal (page otherwise healthy, no edit marker at stake), escalate
  // to the human instead of hard-failing.
  if (
    step.result.verdict === 'fail' &&
    !marker &&
    step.result.reasons.length > 0 &&
    step.result.reasons.every((r) => r.startsWith('Expected snapshot to include'))
  ) {
    step.result.verdict = 'needs-review';
  }

  // ask-once statement triage on the new outcome state
  const triage = await statements.triage(
    extractCandidates(before, step.result.signals),
    currentPageId(deps),
  );
  step.result.kbTriage = {
    statementsSeen: triage.seen,
    newlyClassified: triage.newlyClassified,
  };

  // the KB (including anything just classified) may resolve a non-pass verdict
  if (step.result.verdict !== 'pass') {
    const augmented = statements.augmentExpectation(base, currentPageId(deps));
    const re = verification.evaluateSignals(step.result.signals, augmented);
    const successSeen = statements.hasSuccessStatement(step.result.signals, currentPageId(deps));
    // soften hint-only failures here too (same rule as above)
    let reVerdict = re.verdict;
    if (
      reVerdict === 'fail' &&
      !marker &&
      re.reasons.length > 0 &&
      re.reasons.every((r) => r.startsWith('Expected snapshot to include'))
    ) {
      reVerdict = 'needs-review';
    }
    let flipped: Verdict | null = null;
    if (reVerdict === 'pass' || (reVerdict !== 'fail' && successSeen)) {
      flipped = 'pass';
    } else if (reVerdict === 'fail' && step.result.verdict !== 'fail') {
      flipped = 'fail';
    }
    if (flipped && flipped !== step.result.verdict) {
      console.log(`[flow] verdict flipped ${step.result.verdict} → ${flipped} after human classification`);
      step.result.kbTriage.verdictFlippedFrom = step.result.verdict;
      step.result.verdict = flipped;
      step.result.reasons = flipped === 'pass' ? re.reasons.filter((r) => !r.startsWith('Expected')) : re.reasons;
    }
  }

  // still ambiguous → the human is the escalation path
  if (step.result.verdict === 'needs-review') {
    const answer = await interact.askChoice(
      `Step "${milestone.goal.slice(0, 80)}" is ambiguous (${step.result.reasons.join('; ').slice(0, 120)}). Verdict?`,
      ['pass', 'fail', 'skip'],
      'skip',
    );
    if (answer === 'pass' || answer === 'fail') {
      step.result.kbTriage = step.result.kbTriage ?? { statementsSeen: [], newlyClassified: [] };
      step.result.kbTriage.verdictFlippedFrom = 'needs-review';
      step.result.verdict = answer;
    }
  }

  step.humanDecisions = interact.decisions.slice(decisionsBefore);

  // success + explored → cache the recipe for next time
  if (step.result.verdict === 'pass' && explored?.success) {
    recordFromExplorer(state, recipeId, explored, {
      secrets: { email: state.secrets.email, password: state.secrets.password },
      successCheck:
        milestone.successHint && isLiteralHint(milestone.successHint)
          ? { snapshotAnyOf: [milestone.successHint] }
          : undefined,
    });
  }

  return { step, marker };
}

export async function runFlows(
  deps: FlowRunnerDeps,
  authCtx: AuthContext,
  report: RunReport,
  runDir: string,
  opts: { only?: string[]; quick?: boolean } = {},
): Promise<void> {
  const { state } = deps;
  const flows = state.sitemap.flows.filter(
    (f) => f.status === 'approved' && (!opts.only?.length || opts.only.includes(f.id)),
  );

  if (flows.length === 0) {
    console.log('[flow] no approved flows to run — run `autoqa explore` first or approve flows via `autoqa review`');
    return;
  }

  const verification = new VerificationLayer(deps.browser);

  for (const flow of flows) {
    console.log(`\n[flow] ▶ ${flow.title} (${flow.milestones.length} milestones)`);
    const scenario: ScenarioResult = {
      id: flow.id,
      name: flow.title,
      steps: [],
      startedAt: new Date().toISOString(),
      finishedAt: '',
    };

    const evidenceDir = scenarioEvidenceDir(runDir, flow.id);
    const ctx: StepContext = {
      browser: deps.browser,
      verification,
      evidenceDir,
      stepsToReproduce: [],
    };

    try {
      await ensureAuthenticated(authCtx);
      await navigateToEntry(deps, flow);

      const probeCtx: ProbeContext = {
        browser: deps.browser,
        state: deps.state,
        nav: new Nav(deps.browser),
        statements: deps.statements,
        stepCtx: ctx,
      };

      for (const milestone of flow.milestones) {
        ctx.stepsToReproduce.push(milestone.goal);
        const { step, marker } = await runMilestone(deps, flow, milestone, ctx, authCtx);
        scenario.steps.push(step);
        if (step.result.verdict === 'fail') {
          console.log(`[flow] ✗ ${flow.id} broken at ${milestone.id} — moving to next flow`);
          break;
        }

        // QA probes: back/forward, matrices, edit sweeps — probe failures never abort the flow
        if (!opts.quick) {
          const page = deps.state.sitemap.pages[currentPageId(deps)];
          const probes = await runProbesForMilestone(probeCtx, flow, milestone, page, { marker });
          scenario.steps.push(...probes.map((p) => p.step));
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[flow] ${flow.id} aborted: ${msg}`);
      writeJson(path.join(evidenceDir, 'flow-error.json'), { flow: flow.id, error: msg });
    }

    scenario.finishedAt = new Date().toISOString();
    report.scenarios.push(scenario);

    // probe-step failures downgrade the flow to needs-review, never to fail
    const isProbe = (s: TestStep) => s.workflow.startsWith('probe:');
    const verdict: Verdict = scenario.steps.some((s) => !isProbe(s) && s.result.verdict === 'fail')
      ? 'fail'
      : scenario.steps.some((s) => s.result.verdict === 'needs-review' || (isProbe(s) && s.result.verdict === 'fail'))
        ? 'needs-review'
        : 'pass';
    flow.lastResult = { runId: report.runId, verdict };
    state.saveSitemap();
  }
}
