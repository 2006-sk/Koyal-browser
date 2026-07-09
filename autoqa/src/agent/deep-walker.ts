import path from 'node:path';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import { randomEditMarker } from '../core/edits.js';
import { hasInlineProcessing, type Explorer, type ExplorerResult } from '../core/explorer.js';
import { LlmBudgetExceededError, type LlmClient } from '../core/llm/client.js';
import type { Nav } from '../core/nav.js';
import { classifyPage, looksLikeAuthGate } from './page-classifier.js';
import { recordWalkRecipe, type RecipeStep } from './recipes.js';
import type { Interact } from './interact.js';
import type { SiteState } from './site-state.js';
import {
  matchPage,
  mergePage,
  type Flow,
  type FlowMilestone,
  type PageInteractive,
  type PageNode,
  type WalkAction,
  type WalkStep,
  type WalkTrail,
} from './sitemap.js';

export interface DeepWalkerDeps {
  browser: AgentBrowser;
  state: SiteState;
  llm: LlmClient;
  explorer: Explorer;
  interact: Interact;
  nav: Nav;
  /** Re-login hook: sessions can expire mid-explore, stranding a walk on the login wall */
  ensureAuth?: () => Promise<void>;
}

export interface DeepWalkEntry {
  pageId: string;
  interactive: PageInteractive;
  entryUrl: string;
  /**
   * How to reach the entry page when it is a wizard state that a direct URL
   * would not freshly produce (e.g. /upload resumes the last project draft):
   * open via.entryUrl, click via.actionLabel, THEN click the entry interactive.
   */
  via?: { entryUrl: string; actionLabel: string };
}

export interface DeepWalkResult {
  trail: WalkTrail;
  newPageIds: string[];
  flow: Flow | null;
  recipeIds: string[];
}

function slug(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);
}

/** agent-browser's page target can detach mid-transition, reading as about:blank */
function isBlankState(url: string, snapshot: string): boolean {
  return url.startsWith('about:') || snapshot.trim() === '';
}

function advanceGoal(page: PageNode, marker: string): string {
  return (
    `You are one step inside a creation flow. Current step: "${page.title}" (${page.description}). ` +
    `Complete ONLY this step and advance exactly one screen: make the minimal required choice ` +
    `(prefer the first/standard/default option), fill any required text field with exactly "${marker}", ` +
    `use action "upload" if a file picker is required, then click the enabled Next/Continue/primary button. ` +
    `If a REQUIRED modal blocks you (plan selection, confirmation), complete it — never close it with ✕ or Cancel. ` +
    `Use "done" the moment the screen visibly changes to the next step.`
  );
}

/** First detection landmark actually present in the live snapshot (verified-literal). */
function verifiedLandmark(page: PageNode, snapshot: string): string | undefined {
  const lower = snapshot.toLowerCase();
  return page.detection.snapshotAnyOf.find((t) => lower.includes(t.toLowerCase()));
}

/** Full ordered sequence of meaningful actions from one explorer goal. */
function collectActions(explored: ExplorerResult): WalkAction[] {
  const out: WalkAction[] = [];
  for (const a of explored.actions) {
    if (a.action === 'upload' && a.uploadedPath) {
      out.push({ type: 'upload', assetPath: a.uploadedPath, selector: a.selector });
    } else if (a.action === 'fill' && a.resolvedLabel && a.value !== undefined) {
      out.push({ type: 'fill', label: a.resolvedLabel, value: a.value });
    } else if (a.action === 'click' && a.resolvedLabel) {
      out.push({ type: 'click', label: a.resolvedLabel, role: a.resolvedRole });
    }
  }
  return out;
}

function summarizeActions(explored: ExplorerResult): WalkAction | undefined {
  const all = collectActions(explored);
  // most meaningful action wins for the display summary: upload > fill > last click
  return all.find((a) => a.type === 'upload') ?? all.find((a) => a.type === 'fill') ?? all[all.length - 1];
}

/**
 * The deep-exploration engine: enter a creation/upload flow from its entry
 * interactive and walk it state by state — classifying each new wizard state
 * into the sitemap, mechanically uploading CLI-provided files, waiting out
 * multi-minute server processing — until a terminal/error state or a cap.
 */
export async function deepWalk(
  deps: DeepWalkerDeps,
  entry: DeepWalkEntry,
  opts: { evidenceDir: string; maxSteps?: number },
): Promise<DeepWalkResult> {
  const { browser, state, llm, explorer, interact, nav } = deps;
  const maxSteps = opts.maxSteps ?? config.deep.walkMaxSteps;
  const trailId = `walk:${entry.pageId}:${slug(entry.interactive.label)}`;
  const marker = randomEditMarker('autoqa-walk');
  const newPageIds: string[] = [];
  const steps: WalkStep[] = [];
  const explorations: ExplorerResult[] = [];

  const trail: WalkTrail = {
    id: trailId,
    entry: { pageId: entry.pageId, actionLabel: entry.interactive.label, entryUrl: entry.entryUrl },
    startedAt: new Date().toISOString(),
    finishedAt: '',
    outcome: 'aborted',
    steps,
  };

  console.log(`\n[walk] ▶ ${trailId} — entering via "${entry.interactive.label}"`);

  let lastRealUrl = entry.entryUrl;

  const identify = async (prevSnapshot = ''): Promise<{ page: PageNode; snapshot: string }> => {
    let url = browser.getUrl();
    let snapshot = browser.snapshotInteractive();
    // blank/detached target: recover by re-opening the last real URL — classifying
    // about:blank pollutes the sitemap and burns the no-progress budget
    for (let attempt = 0; isBlankState(url, snapshot) && attempt < 2; attempt++) {
      console.log(`[walk] page went blank (${url}) — re-opening ${lastRealUrl}`);
      browser.open(lastRealUrl);
      browser.wait(3000);
      url = browser.getUrl();
      snapshot = browser.snapshotInteractive();
    }
    if (isBlankState(url, snapshot)) {
      throw new Error(`page stuck at ${url} after blank-state recovery attempts`);
    }
    lastRealUrl = url;
    let page = matchPage(state.sitemap, url, snapshot);
    // A plain page matched by URL whose landmarks are all gone is likely a wizard
    // sub-state sharing that URL (fork → upload UI → modal) — classify it fresh.
    if (
      page &&
      (page.kind ?? 'page') === 'page' &&
      page.detection.snapshotAnyOf.length > 0 &&
      !verifiedLandmark(page, snapshot)
    ) {
      page = null;
    }
    if (!page) {
      console.log(`[walk] classifying new state at ${url}`);
      const classified = await classifyPage(llm, url, snapshot);
      // Landmarks also visible in the PREVIOUS state are shared chrome (wizard
      // sidebars list every step name on every screen) — not distinctive.
      if (prevSnapshot) {
        const prevLower = prevSnapshot.toLowerCase();
        const distinct = classified.detection.snapshotAnyOf.filter(
          (t) => !prevLower.includes(t.toLowerCase()),
        );
        if (distinct.length > 0) classified.detection.snapshotAnyOf = distinct;
      }
      page = mergePage(state.sitemap, classified);
      if (!newPageIds.includes(page.id)) newPageIds.push(page.id);
      try {
        const shot = path.join(state.screensDir, `${page.id}.png`);
        browser.screenshotAnnotated(shot);
        page.screenshot = shot;
      } catch {
        // best-effort
      }
      state.saveSitemap();
    }
    return { page, snapshot };
  };

  const openEntry = (): void => {
    if (entry.via) {
      browser.open(entry.via.entryUrl);
      browser.wait(2000);
      nav.click({ label: entry.via.actionLabel, optional: true });
      browser.wait(2000);
    } else {
      browser.open(entry.entryUrl);
      browser.wait(2000);
    }
  };

  try {
    // enter the flow — deterministic first (we know the exact label), LLM only as fallback
    openEntry();

    // sessions expire mid-explore: a login wall here means we'd deep-walk the auth
    // pages instead of the target flow (observed: an "audio upload" walk that
    // faithfully explored Sign Up + OTP). Re-authenticate and re-enter.
    if (looksLikeAuthGate(browser.getUrl(), browser.snapshotInteractive())) {
      if (deps.ensureAuth) {
        console.log('[walk] entry landed on a login wall — re-authenticating');
        await deps.ensureAuth();
        openEntry();
      }
      if (looksLikeAuthGate(browser.getUrl(), browser.snapshotInteractive())) {
        console.warn(`[walk] ${trailId}: entry is stuck behind a login wall — aborting (will retry next explore)`);
        trail.outcome = 'aborted';
        trail.finishedAt = new Date().toISOString();
        return { trail, newPageIds, flow: null, recipeIds: [] };
      }
    }

    const role =
      entry.interactive.role === 'button' || entry.interactive.role === 'link' || entry.interactive.role === 'tab'
        ? entry.interactive.role
        : undefined;
    const enteredDeterministically = nav.click({ label: entry.interactive.label, role, optional: true });
    if (enteredDeterministically) {
      browser.wait(1500);
    } else {
      const entered = await explorer.achieveGoal(
        `Click the element labeled exactly "${entry.interactive.label}" to start that flow — not a similarly-named sidebar item. Use "done" once the screen changes.`,
        { maxSteps: 3 },
      );
      explorations.push(entered);
      browser.wait(1500);
      if (!entered.success) {
        // walking whatever page we happen to be on produces junk trails and flows
        console.warn(
          `[walk] ${trailId}: entry element "${entry.interactive.label}" not reachable — aborting (will retry next explore)`,
        );
        trail.outcome = 'aborted';
        trail.finishedAt = new Date().toISOString();
        return { trail, newPageIds, flow: null, recipeIds: [] };
      }
    }

    let prev = await identify();
    let noProgress = 0;
    let lastSignature = '';
    const inlineWaited = new Set<string>();

    steps.push({
      index: 0,
      pageId: prev.page.id,
      kind: prev.page.kind ?? 'page',
      landmark: verifiedLandmark(prev.page, prev.snapshot),
      action: { type: 'click', label: entry.interactive.label, role: entry.interactive.role },
    });

    for (let i = 1; i <= maxSteps; i++) {
      const { page, snapshot } = await identify(prev.snapshot);
      const kind = page.kind ?? 'page';
      const landmark = verifiedLandmark(page, snapshot);

      // record edge
      if (page.id !== prev.page.id) {
        const lastAction = steps[steps.length - 1]?.action?.label ?? 'advance';
        if (!state.sitemap.edges.some((e) => e.from === prev.page.id && e.to === page.id)) {
          state.sitemap.edges.push({ from: prev.page.id, actionLabel: lastAction, to: page.id });
        }
      }

      if (kind === 'terminal') {
        steps.push({ index: i, pageId: page.id, kind, landmark });
        trail.outcome = 'terminal';
        console.log(`[walk] ✓ reached terminal state "${page.id}"`);
        break;
      }

      if (kind === 'error') {
        console.log(`[walk] error state "${page.id}" — attempting bounded recovery`);
        const recovery = await explorer.achieveGoal(
          'An error state is shown. Click Retry if present; otherwise go back one step and try a different option. Use "done" if the error clears.',
          { maxSteps: 4 },
        );
        explorations.push(recovery);
        browser.wait(2000);
        const after = await identify(snapshot);
        if ((after.page.kind ?? 'page') === 'error') {
          steps.push({ index: i, pageId: page.id, kind, landmark });
          trail.outcome = 'error';
          break;
        }
        prev = after;
        continue;
      }

      if (kind === 'processing') {
        // 5s poll cadence, screenshot every 4th poll — never one long wait
        console.log(`[walk] processing state "${page.id}" — waiting (max ${config.deep.processingWaitMs / 1000}s)`);
        const t0 = Date.now();
        let waitBudget = config.deep.processingWaitMs;
        let polls = 0;
        let resolved = false;
        let extended = false;
        for (;;) {
          if (Date.now() - t0 > waitBudget) {
            if (!extended) {
              const ans = await interact.askChoice(
                `"${page.title}" still processing after ${Math.round(waitBudget / 60000)} min — keep waiting?`,
                ['wait', 'skip'],
                'skip',
              );
              if (ans === 'wait') {
                extended = true;
                waitBudget += config.deep.terminalWaitMs;
                continue;
              }
            }
            break;
          }
          browser.wait(5000);
          polls++;
          if (polls % 4 === 1) {
            try {
              browser.screenshotAnnotated(path.join(opts.evidenceDir, `${slug(trailId)}-poll-${polls}.png`));
            } catch {
              // best-effort
            }
          }
          const now = matchPage(state.sitemap, browser.getUrl(), browser.snapshotInteractive());
          if (!now || (now.kind ?? 'page') !== 'processing') {
            resolved = true;
            break;
          }
        }
        steps.push({
          index: i,
          pageId: page.id,
          kind,
          landmark,
          processingMs: Date.now() - t0,
          action: { type: 'wait-processing' },
        });
        if (!resolved) {
          trail.outcome = 'no-progress';
          console.log('[walk] processing never resolved — stopping walk');
          break;
        }
        prev = { page, snapshot };
        continue;
      }

      // inline processing on a wizard step (same URL, spinner text) — wait it out first
      // (once per state: a capped wait that never cleared must not loop forever)
      if (hasInlineProcessing(snapshot) && !inlineWaited.has(page.id)) {
        inlineWaited.add(page.id);
        console.log(`[walk] inline processing on "${page.id}" — waiting for it to clear`);
        const t0 = Date.now();
        let polls = 0;
        while (Date.now() - t0 < config.deep.processingWaitMs) {
          browser.wait(5000);
          polls++;
          if (polls % 4 === 1) {
            try {
              browser.screenshotAnnotated(path.join(opts.evidenceDir, `${slug(trailId)}-inline-${i}-${polls}.png`));
            } catch {
              // best-effort
            }
          }
          if (!hasInlineProcessing(browser.snapshotInteractive())) break;
        }
        const waited = Date.now() - t0;
        console.log(`[walk] inline processing cleared/capped after ${Math.round(waited / 1000)}s`);
        steps.push({
          index: i,
          pageId: page.id,
          kind,
          landmark,
          processingMs: waited,
          action: { type: 'wait-processing' },
        });
        prev = { page, snapshot };
        continue;
      }

      // wizard-step / modal / page: try to advance one screen
      const signature = `${page.id}|${landmark ?? ''}`;
      if (signature === lastSignature) {
        noProgress++;
        if (noProgress >= 3) {
          trail.outcome = 'no-progress';
          console.log(`[walk] no progress after 3 attempts on "${page.id}" — stopping`);
          break;
        }
      } else {
        noProgress = 0;
        lastSignature = signature;
      }

      const explored = await explorer.achieveGoal(advanceGoal(page, marker), { maxSteps: 6 });
      explorations.push(explored);
      browser.wait(1500);

      steps.push({
        index: i,
        pageId: page.id,
        kind,
        landmark,
        action: summarizeActions(explored),
        actions: collectActions(explored),
      });
      prev = { page, snapshot };
    }

    if (trail.outcome === 'aborted') trail.outcome = 'step-cap';
  } catch (error) {
    if (error instanceof LlmBudgetExceededError) {
      trail.outcome = 'budget';
      console.log('[walk] LLM budget exhausted — keeping partial trail');
    } else {
      trail.outcome = 'aborted';
      console.warn(`[walk] aborted: ${error instanceof Error ? error.message : error}`);
    }
  }

  trail.finishedAt = new Date().toISOString();
  state.sitemap.walks = state.sitemap.walks ?? {};
  state.sitemap.walks[trailId] = trail;

  // derive a testable flow + replayable recipes from the observed trail
  let flow: Flow | null = null;
  let recipeIds: string[] = [];
  if (trail.steps.length >= 2 && (trail.outcome === 'terminal' || trail.outcome === 'step-cap' || trail.outcome === 'no-progress')) {
    flow = flowFromTrail(trail, state);
    if (flow) {
      trail.generatedFlowId = flow.id;
      recipeIds = recordWalkRecipes(state, flow, trail);
    }
  }
  state.saveSitemap();

  console.log(
    `[walk] ${trailId} finished: ${trail.outcome}, ${trail.steps.length} steps, ${newPageIds.length} new pages${flow ? `, flow "${flow.id}" generated` : ''}`,
  );
  return { trail, newPageIds, flow, recipeIds };
}

/**
 * The single source of truth for which trail steps become milestones. BOTH
 * flowFromTrail and recordWalkRecipes must use this exact list — if they derive
 * it independently they drift (e.g. a collapsed wait-processing step) and recipes
 * bind to the wrong milestone.
 */
function actionableSteps(trail: WalkTrail): WalkStep[] {
  const candidates = trail.steps.filter(
    (s) => s.kind === 'wizard-step' || s.kind === 'modal' || s.kind === 'page',
  );
  // collapse repeats: keep a step only if it did something, or it landed on a new state
  const actionable: WalkStep[] = [];
  for (const step of candidates) {
    const last = actionable[actionable.length - 1];
    const meaningful = Boolean(step.action && step.action.type !== 'wait-processing');
    if (meaningful || !last || last.pageId !== step.pageId) actionable.push(step);
  }
  return actionable;
}

/** Deterministically turn an observed walk into a testable Flow (zero LLM). */
export function flowFromTrail(trail: WalkTrail, state: SiteState): Flow | null {
  const actionable = actionableSteps(trail);
  if (actionable.length === 0) return null;

  const flowId = `walked-${trail.entry.pageId}-${slug(trail.entry.actionLabel)}`;
  const milestones: FlowMilestone[] = [];

  for (let i = 0; i < actionable.length; i++) {
    const step = actionable[i];
    const page = state.sitemap.pages[step.pageId];
    const stepIdx = trail.steps.indexOf(step);
    // fold processing waits after this step into its budget, and aim the success
    // hint at the NEXT DIFFERENT state's landmark (same-page hints are vacuous)
    let processing: WalkStep | undefined;
    let target: WalkStep | undefined;
    for (let j = stepIdx + 1; j < trail.steps.length; j++) {
      const candidate = trail.steps[j];
      if (candidate.kind === 'processing' || candidate.action?.type === 'wait-processing') {
        processing = processing ?? candidate;
        continue;
      }
      if (candidate.pageId !== step.pageId && candidate.landmark) {
        target = candidate;
        break;
      }
    }

    const kind: FlowMilestone['kind'] =
      step.action?.type === 'upload'
        ? 'upload'
        : step.action?.type === 'fill'
          ? 'edit'
          : i === actionable.length - 1
            ? 'verify'
            : 'create';

    const actionDesc =
      step.action?.type === 'upload'
        ? `upload a file (previously: ${path.basename(step.action.assetPath ?? 'test file')})`
        : step.action?.type === 'fill'
          ? `fill "${step.action.label ?? 'the field'}" with the run marker`
          : step.action?.label
            ? `click "${step.action.label}"`
            : 'complete this step';

    milestones.push({
      id: `m${i + 1}`,
      goal:
        `On "${page?.title ?? step.pageId}": ${actionDesc}, then advance one screen` +
        (target?.landmark ? ` until "${target.landmark}" is visible.` : '.') +
        ' If this action appears already done (the control now shows Remove/Undo/Added or is missing), skip it and just advance.',
      kind,
      successHint: target?.landmark,
      guardPhases: [step.pageId],
      maxWaitMs: processing?.processingMs ? Math.round(processing.processingMs * 1.5) : undefined,
    });
  }

  const flow: Flow = {
    id: flowId,
    title: `Walked: ${trail.entry.actionLabel} (${trail.entry.pageId})`,
    description: `Auto-generated from deep walk ${trail.id} (outcome: ${trail.outcome}, ${trail.steps.length} states)`,
    status: 'proposed',
    entry: { pageId: trail.entry.pageId, url: trail.entry.entryUrl?.replace(state.sitemap.origin, '') },
    milestones,
  };

  const existingIdx = state.sitemap.flows.findIndex((f) => f.id === flowId);
  if (existingIdx >= 0) {
    // keep approval status across re-walks
    flow.status = state.sitemap.flows[existingIdx].status;
    flow.lastResult = state.sitemap.flows[existingIdx].lastResult;
    state.sitemap.flows[existingIdx] = flow;
  } else {
    state.sitemap.flows.push(flow);
  }
  return flow;
}

/** Store per-milestone recipes from the trail so the FIRST test run already replays. */
export function recordWalkRecipes(state: SiteState, flow: Flow, trail: WalkTrail): string[] {
  // MUST be the same collapsed list flowFromTrail used, or recipes bind to the
  // wrong milestone (milestone[i] ↔ actionable[i] is positional)
  const actionable = actionableSteps(trail);
  const ids: string[] = [];

  for (let i = 0; i < flow.milestones.length; i++) {
    const milestone = flow.milestones[i];
    const step = actionable[i];
    if (!step?.action) continue;

    const recipeSteps: RecipeStep[] = [];
    for (const action of step.actions?.length ? step.actions : [step.action]) {
      if (action.type === 'click' && action.label) {
        recipeSteps.push({ kind: 'click', label: action.label, role: action.role });
      } else if (action.type === 'fill' && action.label && action.value) {
        recipeSteps.push({ kind: 'fill', hint: action.label, value: action.value });
      } else if (action.type === 'upload' && action.assetPath) {
        recipeSteps.push({ kind: 'upload', assetPath: action.assetPath, selector: action.selector });
      }
    }
    if (recipeSteps.length === 0) continue;

    if (milestone.successHint) {
      recipeSteps.push({
        kind: 'waitFor',
        textIncludes: milestone.successHint,
        maxMs: milestone.maxWaitMs ?? 20000,
      });
    }

    const id = `flow:${flow.id}:${milestone.id}`;
    const recorded = recordWalkRecipe(state, id, milestone.goal, recipeSteps, {
      snapshotAnyOf: milestone.successHint ? [milestone.successHint] : undefined,
    });
    if (recorded) ids.push(id);
  }
  return ids;
}
