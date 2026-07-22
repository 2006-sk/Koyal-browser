import path from 'node:path';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import { randomEditMarker } from '../core/edits.js';
import { hasInlineProcessing, type Explorer, type ExplorerResult } from '../core/explorer.js';
import { LlmBudgetExceededError, type LlmClient } from '../core/llm/client.js';
import type { Nav } from '../core/nav.js';
import { assessProcessingScreenshot, assessScreenshot } from '../core/visual-verification.js';
import { captureRuntimeFailure } from '../core/runtime-failure.js';
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
  /**
   * Shared across every deepWalk() call in one explore session (crawler.ts owns
   * the Map, passes the same instance to each entry it walks). Tracks which
   * radio/tab option labels have already been selected on a given page, so a
   * later attempt — whether a retry within this walk or a separate walk entry
   * that lands on the same page — knows to prefer an untried alternative instead
   * of blindly re-picking (or regressing back to) an option already covered.
   * Confirmed live on filmarena.ai: 3 separate walk entries into the same
   * "Best/Top 3/Custom/Battle" mode selector converged on just 2 of 4 options
   * across 6 total attempts, because each attempt had no idea what a prior one
   * (in this walk or an earlier walk) had already tried.
   */
  triedChoicesByPage?: Map<string, Set<string>>;
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

/**
 * Same-origin guard, mirroring crawler.ts's `isOffOrigin` — a footer/CTA link to
 * a related marketing/checkout site (a different (sub)domain) is common, and the
 * crawler already refuses to map or click-probe such destinations. The deep
 * walker had no equivalent check: confirmed live on GreenKart's parent domain
 * (rahulshettyacademy.com), an "all-access-subscription" walk entry followed a
 * "JOIN NOW" → "ENROLL NOW" chain off-site to a REAL third-party checkout page
 * (sso.teachable.com, behind Cloudflare "verify you are human"), where the walker
 * then spent LLM steps trying to click through the Cloudflare challenge and was
 * about to enter a 300s processing-wait for someone else's real payment flow.
 * Not a hypothetical: this is a genuine safety/scope leak, not just wasted budget.
 */
function isOffOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin !== origin;
  } catch {
    return false;
  }
}

function advanceGoal(page: PageNode, marker: string, triedChoices: string[] = []): string {
  if (config.probes.exhaustive) {
    // DEEP mode: don't just click through — actually USE the step's features so we
    // test that they work (create a character, edit a scene, change settings), then
    // advance. This is what proves the platform functions, not just that it renders.
    const alreadyTried =
      triedChoices.length > 0
        ? ` Already tried on this step (in this walk or an earlier one): ${triedChoices.join(', ')}. ` +
          `If other radio/tab/mode options exist that you haven't tried yet, pick one of those instead — ` +
          `don't repeat or regress back to an option already covered.`
        : '';
    return (
      `You are one step inside a creation flow. Current step: "${page.title}" (${page.description}). ` +
      `Your job is to EXERCISE this step's real functionality, then advance one screen:\n` +
      `1. If this step lets you CREATE or ADD something (a character, a scene, an item), DO it — ` +
      `click the create/add control and confirm the new thing appears. For a person/character name use a normal human name such as "Jason"; ` +
      `for a character description use "A friendly young pilot with short brown hair, a navy flight jacket, and a calm, confident expression."; ` +
      `for other free-text fields use exactly "${marker}". Obey every visible format rule and never use fictional titles, digits in letters-only names, joke names, or random nonsense.\n` +
      `2. If this step has EDITABLE content (script/scene/prompt text), edit it: insert exactly "${marker}" and verify it shows.\n` +
      `If the edit requires Apply/Regenerate/Save, click it, wait for processing, and verify the edited value survives the resulting refresh/state change; merely typing text is never sufficient.\n` +
      `3. If this step offers CHOICES (story type, style, settings), make a real selection (not necessarily the first — pick a meaningful one).${alreadyTried}\n` +
      `4. Complete any REQUIRED modal (plan/confirmation) — never close it with ✕ or Cancel; upload via action "upload" if a file picker is required.\n` +
      `Then click the enabled Next/Continue/primary button. Use "done" the moment the screen visibly changes to the next step. ` +
      `If the step has no creatable/editable/selectable content, just advance.`
    );
  }
  return (
    `You are one step inside a creation flow. Current step: "${page.title}" (${page.description}). ` +
    `Complete ONLY this step and advance exactly one screen: make the minimal required choice ` +
    `(prefer the first/standard/default option). For person/character names use "Jason" and for character descriptions use ` +
    `"A friendly young pilot with short brown hair, a navy flight jacket, and a calm, confident expression."; ` +
    `otherwise fill required text with exactly "${marker}". Obey visible validation rules. ` +
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

function stableStateSignature(page: PageNode, snapshot: string): string {
  const stableSnapshot = snapshot
    .toLowerCase()
    .replace(/\[ref=e\d+\]/g, '')
    .replace(/\b\d+(?:\.\d+)?(?:%|s|sec|seconds?|min|minutes?)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 3500);
  return `${page.id}|${stableSnapshot}`;
}

function hasPossibleCompletionAction(result: ExplorerResult): boolean {
  return result.actions.some(
    (action) =>
      action.action === 'click' &&
      /\b(create(?: video| character| asset| outfit)?|generate|regenerate|finalize|save|submit|finish|complete|download|place order|reserve|book)\b/i.test(
        action.resolvedLabel ?? '',
      ),
  );
}

/**
 * A mapped `kind:terminal` is preferred, but vision can prove a persistent
 * artifact when an SPA's sidebar landmarks make deterministic classification
 * ambiguous. The visual reviewer is deliberately asked to reject previews,
 * open forms, spinners, and still-visible finalize controls.
 */
async function visuallyProveTerminal(
  deps: DeepWalkerDeps,
  trail: WalkTrail,
  page: PageNode,
  opts: { evidenceDir: string },
  observations: string,
): Promise<boolean> {
  const screenshot = path.join(opts.evidenceDir, `${slug(trail.id)}-terminal-candidate-${Date.now()}.png`);
  try {
    deps.browser.screenshotAnnotated(screenshot);
    const assessment = await assessScreenshot(deps.llm, screenshot, {
      action: `Complete the creation flow entered through "${trail.entry.actionLabel}"`,
      expected:
        'A genuinely completed, persistent artifact is visible: for video, a playable/downloadable final video; for character/asset/outfit/item, the newly created item in its saved list/library. A generated preview, open form, spinner, Regenerate/Create/Finalize/Save button, or intermediate wizard step is NOT completion.',
      url: deps.browser.getUrl(),
      observations,
    });
    if (assessment.status !== 'clear') {
      console.log(`[walk] vision did not prove terminal persistence (${assessment.status}: ${assessment.summary})`);
      return false;
    }
    trail.terminalEvidence = {
      source: 'vision',
      pageId: page.id,
      screenshot,
      summary: assessment.summary,
    };
    console.log(`[walk] ✓ vision verified terminal/persistent artifact: ${assessment.summary}`);
    return true;
  } catch (error) {
    console.warn(`[walk] terminal vision check unavailable: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

async function visuallyAffirmWalkProcessing(
  deps: DeepWalkerDeps,
  screenshot: string,
  action: string,
  observations: string,
): Promise<'active' | 'complete' | 'blocked' | 'uncertain' | undefined> {
  try {
    deps.browser.screenshotAnnotated(screenshot);
    const assessment = await assessProcessingScreenshot(deps.llm, screenshot, {
      action,
      url: deps.browser.getUrl(),
      observations,
    });
    console.log(`[walk] vision processing affirmation: ${assessment.status} — ${assessment.summary}`);
    return assessment.status;
  } catch (error) {
    console.warn(`[walk] processing vision check unavailable: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

/** Full ordered sequence of meaningful actions from one explorer goal. */
function collectActions(explored: ExplorerResult): WalkAction[] {
  const out: WalkAction[] = [];
  for (const a of explored.actions) {
    if (a.action === 'upload' && a.uploadedPath) {
      out.push({ type: 'upload', assetPath: a.uploadedPath, selector: a.selector });
    } else if (a.action === 'fill' && a.resolvedLabel && a.value !== undefined) {
      out.push({ type: 'fill', label: a.resolvedLabel, value: a.value });
    } else if (a.action === 'select' && a.resolvedLabel && a.value !== undefined) {
      out.push({ type: 'select', label: a.resolvedLabel, value: a.value });
    } else if (a.action === 'press' && a.value !== undefined) {
      out.push({ type: 'press', value: a.value });
    } else if (a.action === 'click' && a.resolvedLabel) {
      out.push({ type: 'click', label: a.resolvedLabel, role: a.resolvedRole });
    }
  }
  return out;
}

function summarizeActions(explored: ExplorerResult): WalkAction | undefined {
  const all = collectActions(explored);
  // most meaningful action wins for the display summary: upload > fill/select > last click
  return (
    all.find((a) => a.type === 'upload') ??
    all.find((a) => a.type === 'fill' || a.type === 'select') ??
    all[all.length - 1]
  );
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

  const noteRuntimeSignal = (
    failure: NonNullable<ReturnType<typeof captureRuntimeFailure>>,
    context: string,
    screenshot?: string,
  ): void => {
    (trail.runtimeSignals ??= []).push({
      at: new Date().toISOString(),
      context,
      kind: failure.kind,
      detail: failure.detail,
      screenshot,
    });
    console.warn(
      `[walk] ! recorded product ${failure.kind} ${context}: ${failure.detail} — continuing while the UI remains usable`,
    );
    // Prevent one already-recorded exception from being mistaken for a new
    // blocker on every subsequent state/poll.
    browser.clearSignals();
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
    // Never classify/map a third-party domain — abort the walk instead (same
    // policy the crawler already enforces on its own click-probes).
    if (isOffOrigin(url, state.sitemap.origin)) {
      throw new Error(
        `walk navigated off-site to ${url} (expected origin ${state.sitemap.origin}) — aborting, not mapping third-party domains`,
      );
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
    browser.clearSignals();

    // sessions expire mid-explore: a login wall here means we'd deep-walk the auth
    // pages instead of the target flow (observed: an "audio upload" walk that
    // faithfully explored Sign Up + OTP). Re-authenticate and re-enter.
    if (looksLikeAuthGate(browser.getUrl(), browser.snapshotInteractive(), browser.hasVisiblePasswordInput())) {
      if (deps.ensureAuth) {
        console.log('[walk] entry landed on a login wall — re-authenticating');
        await deps.ensureAuth();
        openEntry();
      }
      if (looksLikeAuthGate(browser.getUrl(), browser.snapshotInteractive(), browser.hasVisiblePasswordInput())) {
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
    const visionReleasedProcessing = new Set<string>();

    steps.push({
      index: 0,
      pageId: prev.page.id,
      kind: prev.page.kind ?? 'page',
      landmark: verifiedLandmark(prev.page, prev.snapshot),
      action: { type: 'click', label: entry.interactive.label, role: entry.interactive.role },
    });

    for (let i = 1; i <= maxSteps; i++) {
      // Public landing pages can make the initial auth probe look healthy, while
      // a protected creation action redirects to login later. Re-authenticate at
      // the redirect before identify() maps the login page as a wizard state.
      if (looksLikeAuthGate(browser.getUrl(), browser.snapshotInteractive(), browser.hasVisiblePasswordInput())) {
        if (!deps.ensureAuth) {
          trail.outcome = 'aborted';
          console.warn(`[walk] ${trailId}: hit an authentication wall mid-walk with no auth handler`);
          break;
        }
        console.log('[walk] authentication wall appeared mid-flow — signing in and resuming the redirected state');
        await deps.ensureAuth();
        browser.wait(1500);
        if (looksLikeAuthGate(browser.getUrl(), browser.snapshotInteractive(), browser.hasVisiblePasswordInput())) {
          trail.outcome = 'aborted';
          console.warn(`[walk] ${trailId}: authentication wall remained after login attempt`);
          break;
        }
      }
      const { page, snapshot } = await identify(prev.snapshot);
      const kind = page.kind ?? 'page';
      const landmark = verifiedLandmark(page, snapshot);

      const runtimeFailure = captureRuntimeFailure(browser);
      if (runtimeFailure) {
        let screenshot: string | undefined;
        try {
          screenshot = path.join(opts.evidenceDir, `${slug(trailId)}-product-error-${i}.png`);
          browser.screenshotAnnotated(screenshot);
        } catch {
          screenshot = undefined;
        }
        noteRuntimeSignal(runtimeFailure, `on state "${page.id}"`, screenshot);
      }

      // record edge
      if (page.id !== prev.page.id) {
        const lastAction = steps[steps.length - 1]?.action?.label ?? 'advance';
        if (!state.sitemap.edges.some((e) => e.from === prev.page.id && e.to === page.id)) {
          state.sitemap.edges.push({ from: prev.page.id, actionLabel: lastAction, to: page.id });
        }
      }

      if (kind === 'terminal') {
        let screenshot: string | undefined;
        try {
          screenshot = path.join(opts.evidenceDir, `${slug(trailId)}-terminal.png`);
          browser.screenshotAnnotated(screenshot);
        } catch {
          screenshot = undefined;
        }
        steps.push({ index: i, pageId: page.id, kind, landmark, screenshot });
        trail.outcome = 'terminal';
        trail.terminalEvidence = { source: 'page-kind', pageId: page.id, screenshot };
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

      if (kind === 'processing' && !visionReleasedProcessing.has(page.id)) {
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
          const failure = captureRuntimeFailure(browser);
          if (failure) {
            noteRuntimeSignal(failure, `while processing "${page.id}"`);
          }
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
          if (polls === 3) {
            const visualStatus = await visuallyAffirmWalkProcessing(
              deps,
              path.join(opts.evidenceDir, `${slug(trailId)}-processing-affirm-${i}.png`),
              `Wait for processing state "${page.title}" to finish`,
              'The deterministic page classifier still labels this state as processing after three polls.',
            );
            if (visualStatus === 'complete' || visualStatus === 'blocked') {
              visionReleasedProcessing.add(page.id);
              resolved = true;
              break;
            }
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
          const failure = captureRuntimeFailure(browser);
          if (failure) {
            noteRuntimeSignal(failure, `during inline processing on "${page.id}"`);
          }
          if (polls % 4 === 1) {
            try {
              browser.screenshotAnnotated(path.join(opts.evidenceDir, `${slug(trailId)}-inline-${i}-${polls}.png`));
            } catch {
              // best-effort
            }
          }
          const currentSnapshot = browser.snapshotInteractive();
          if (!hasInlineProcessing(currentSnapshot)) break;
          if (polls === 3) {
            const visualStatus = await visuallyAffirmWalkProcessing(
              deps,
              path.join(opts.evidenceDir, `${slug(trailId)}-inline-affirm-${i}.png`),
              `Wait for inline processing on "${page.title}" to finish`,
              'The text detector still reports inline processing after three polls.',
            );
            if (visualStatus === 'complete' || visualStatus === 'blocked') break;
          }
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
      const signature = stableStateSignature(page, snapshot);
      if (signature === lastSignature) {
        noProgress++;
        const noProgressLimit = config.probes.exhaustive ? 6 : 3;
        if (noProgress >= noProgressLimit) {
          const terminal = await visuallyProveTerminal(
            deps,
            trail,
            page,
            opts,
            `The browser state remained unchanged after ${noProgressLimit} attempts. Determine whether that is because the artifact is already completely created and persisted, or because automation is stuck on an intermediate control.`,
          );
          if (terminal) {
            trail.outcome = 'terminal';
            console.log(`[walk] unchanged state was a vision-verified terminal artifact on "${page.id}"`);
            break;
          }

          console.log(`[walk] no progress on "${page.id}" — invoking screenshot-first control recovery`);
          const recovery = await explorer.achieveGoal(
            `The automation is stuck while completing the creation flow started by "${entry.interactive.label}". ` +
              `Use the screenshot and full page state to locate the actual enabled control, modal, validation message, or required field that advances toward a saved terminal artifact. ` +
              `Do not declare a product failure merely because an element is hard to locate. If processing is visible, wait. ` +
              `If a real error is visible, use fail and quote it. Otherwise perform the corrective action and use done only after the state advances.`,
            { maxSteps: Math.max(12, config.llm.maxStepsPerGoal), visionFirst: true },
          );
          explorations.push(recovery);
          steps.push({
            index: i,
            pageId: page.id,
            kind,
            landmark,
            action: summarizeActions(recovery),
            actions: collectActions(recovery),
          });
          const afterRecoveryFailure = captureRuntimeFailure(browser);
          if (afterRecoveryFailure) {
            noteRuntimeSignal(afterRecoveryFailure, `during screenshot recovery on "${page.id}"`);
          }
          noProgress = 0;
          lastSignature = '';
          prev = await identify(snapshot);
          continue;
        }
      } else {
        noProgress = 0;
        lastSignature = signature;
      }

      const triedChoices = Array.from(deps.triedChoicesByPage?.get(page.id) ?? []);
      const explored = await explorer.achieveGoal(advanceGoal(page, marker, triedChoices), {
        maxSteps: config.probes.exhaustive ? Math.max(12, config.llm.maxStepsPerGoal) : 6,
      });
      explorations.push(explored);
      browser.wait(1500);

      // Remember which mode/tab options this attempt selected, so a retry within
      // this walk — or a later, separate walk entry that lands on the same page —
      // can be told to try something else instead of converging on the same 1-2
      // options (or regressing back to the default) every time.
      if (deps.triedChoicesByPage) {
        const chosen = explored.actions
          .filter((a) => a.action === 'click' && (a.resolvedRole === 'radio' || a.resolvedRole === 'tab') && a.resolvedLabel)
          .map((a) => a.resolvedLabel!);
        if (chosen.length > 0) {
          const set = deps.triedChoicesByPage.get(page.id) ?? new Set<string>();
          chosen.forEach((label) => set.add(label));
          deps.triedChoicesByPage.set(page.id, set);
        }
      }

      steps.push({
        index: i,
        pageId: page.id,
        kind,
        landmark,
        action: summarizeActions(explored),
        actions: collectActions(explored),
      });
      if (!explored.success && /^Human input unavailable for required field/i.test(explored.error ?? '')) {
        trail.outcome = 'aborted';
        console.warn(`[walk] current walk stopped: ${explored.error}`);
        break;
      }
      if (explored.success && hasPossibleCompletionAction(explored)) {
        const after = await identify(snapshot);
        const terminal = await visuallyProveTerminal(
          deps,
          trail,
          after.page,
          opts,
          explored.stepsTaken.join('\n'),
        );
        if (terminal) {
          steps.push({
            index: i + 1,
            pageId: after.page.id,
            kind: after.page.kind ?? 'page',
            landmark: verifiedLandmark(after.page, after.snapshot),
            screenshot: trail.terminalEvidence?.screenshot,
          });
          trail.outcome = 'terminal';
          break;
        }
      }
      prev = { page, snapshot };
    }

    if (trail.outcome === 'aborted' && steps.length >= maxSteps) trail.outcome = 'step-cap';
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
  // Only a terminal trail proves an end-to-end flow. no-progress/step-cap trails
  // are diagnostic evidence, not replayable success recipes; turning them into
  // approved flows created repeated fill-only Koyal tests that never finalized.
  if (trail.steps.length >= 2 && isProvenTrailOutcomeForFlow(trail.outcome)) {
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

export function isProvenTrailOutcomeForFlow(outcome: WalkTrail['outcome']): boolean {
  return outcome === 'terminal';
}

/**
 * The single source of truth for which trail steps become milestones. BOTH
 * flowFromTrail and recordWalkRecipes must use this exact list — if they derive
 * it independently they drift (e.g. a collapsed wait-processing step) and recipes
 * bind to the wrong milestone.
 */
export function actionableSteps(trail: WalkTrail): WalkStep[] {
  const candidates = trail.steps.filter(
    (s) => s.kind === 'wizard-step' || s.kind === 'modal' || s.kind === 'page',
  );
  if (candidates.length === 0) return [];

  // Step zero is the entry action and must remain independently replayable even
  // when clicking it lands on the same page id as the first in-page action.
  // After that, a no-progress walker may make several full Explorer attempts on
  // one unchanged page. Each contains clicks, but turning all of them into
  // milestones produced five identical Premiere→Next-step milestones and huge,
  // broken recipes. Keep only the final meaningful attempt in each consecutive
  // page-state run: that is the attempt closest to (and normally responsible
  // for) the observed transition to the next mapped state.
  const actionable: WalkStep[] = [candidates[0]];
  for (let i = 1; i < candidates.length; ) {
    let end = i;
    while (end + 1 < candidates.length && candidates[end + 1].pageId === candidates[i].pageId) end++;
    const group = candidates.slice(i, end + 1);
    const meaningful = group.filter((step) => step.action && step.action.type !== 'wait-processing');
    const chosen = meaningful[meaningful.length - 1] ?? group[group.length - 1];
    const last = actionable[actionable.length - 1];
    if (meaningful.length > 0 || last.pageId !== chosen.pageId) actionable.push(chosen);
    i = end + 1;
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
    // Bound the lookahead to the NEXT milestone's own boundary — if this step's
    // action didn't immediately navigate (e.g. a same-page toast/modal), searching
    // unbounded can walk PAST the next milestone and steal ITS landmark instead
    // (observed: an "Add to cart" milestone grabbing a later, unrelated Signup
    // page's landmark). The next milestone's own state is still a valid target.
    const nextActionableIdx = i + 1 < actionable.length ? trail.steps.indexOf(actionable[i + 1]) : trail.steps.length;
    // fold processing waits after this step into its budget, and aim the success
    // hint at the NEXT DIFFERENT state's landmark (same-page hints are vacuous)
    let processing: WalkStep | undefined;
    let target: WalkStep | undefined;
    for (let j = stepIdx + 1; j < trail.steps.length && j <= nextActionableIdx; j++) {
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
    // keep lifecycle state across re-walks
    flow.status = state.sitemap.flows[existingIdx].status;
    flow.qualification = state.sitemap.flows[existingIdx].qualification;
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
      } else if (action.type === 'select' && action.label && action.value) {
        recipeSteps.push({ kind: 'select', hint: action.label, value: action.value });
      } else if (action.type === 'press' && action.value) {
        recipeSteps.push({ kind: 'press', key: action.value });
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
