import path from 'node:path';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import { randomEditMarker } from '../core/edits.js';
import {
  explorerStateSignature,
  hasInlineProcessing,
  hasPostMutationProcessing,
  isLikelyMutationLabel,
  type Explorer,
  type ExplorerResult,
} from '../core/explorer.js';
import { LlmBudgetExceededError, type LlmClient } from '../core/llm/client.js';
import type { Nav } from '../core/nav.js';
import {
  assessArtifactPersistenceScreenshot,
  assessProcessingScreenshot,
  type ArtifactPersistenceVisualAssessment,
} from '../core/visual-verification.js';
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

export function runtimeSignalSignature(failure: { kind: string; detail: string }): string {
  return `${failure.kind}:${failure.detail
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()}`;
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
      `If a file is already visibly attached, do not upload another file or switch file types; use the enabled Next/Continue control.\n` +
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
    `If a file is already visibly attached, do not upload another file or switch file types; use the enabled Next/Continue control. ` +
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

/** A successful driver click is not proof that a creation entry was entered.
 * Stateful apps can resume a later draft while stale sidebar text still lets a
 * click command report success. Require a visible state transition before the
 * walk may be compiled into a replayable flow. */
export function entryStateAdvanced(
  beforeUrl: string,
  beforeSnapshot: string,
  afterUrl: string,
  afterSnapshot: string,
): boolean {
  return (
    beforeUrl !== afterUrl ||
    explorerStateSignature(beforeUrl, beforeSnapshot) !==
      explorerStateSignature(afterUrl, afterSnapshot) ||
    hasInlineProcessing(afterSnapshot) ||
    hasPostMutationProcessing(afterSnapshot)
  );
}

export interface BlockedStateRecovery {
  direction: 'back' | 'forward' | 'none';
  changed: boolean;
  url: string;
}

/**
 * Leave a state that has exhausted its bounded recovery. Back is safest for a
 * wizard; Forward is attempted only when Back did not change the document.
 * The caller always ends the current walk afterwards, so this can never turn a
 * timeout into a false continuation/success.
 */
export function recoverAwayFromBlockedState(
  browser: AgentBrowser,
  page: PageNode,
  snapshot: string,
): BlockedStateRecovery {
  const beforeUrl = browser.getUrl();
  const beforeSignature = stableStateSignature(page, snapshot);
  const attempts: Array<{ direction: 'back' | 'forward'; run: () => void }> = [
    { direction: 'back', run: () => browser.back() },
    { direction: 'forward', run: () => browser.forward() },
  ];
  for (const attempt of attempts) {
    try {
      attempt.run();
      browser.wait(1500);
      const url = browser.getUrl();
      const afterSnapshot = browser.snapshotInteractive();
      const changed =
        Boolean(url && !url.startsWith('about:')) &&
        (url !== beforeUrl || stableStateSignature(page, afterSnapshot) !== beforeSignature);
      if (changed) return { direction: attempt.direction, changed: true, url };
    } catch {
      // Try the other bounded direction; the caller records/ends the walk.
    }
  }
  return { direction: 'none', changed: false, url: browser.getUrl() };
}

function hasPossibleCompletionAction(result: ExplorerResult): boolean {
  return result.actions.some(
    (action) =>
      action.action === 'click' &&
      !action.executionFailed &&
      /\b(create(?: video| character| asset| outfit)?|generate|regenerate|finalize|save|submit|finish|complete|download|place order|reserve|book)\b/i.test(
        action.resolvedLabel ?? '',
      ),
  );
}

export function isExplorerStateCycleFailure(result: ExplorerResult): boolean {
  return !result.success && /\bExplorer state-cycle detected\b/i.test(result.error ?? '');
}

export function isMutatingControlLabel(label: string): boolean {
  return isLikelyMutationLabel(label);
}

/** Labels that must not be replayed after a submitted artifact is awaiting proof. */
export function mutatingControlLabels(result: ExplorerResult, entryLabel?: string): string[] {
  const labels = result.actions
    .filter((action) => action.action === 'click' && !action.executionFailed && action.resolvedLabel)
    .map((action) => action.resolvedLabel!)
    .filter(isMutatingControlLabel);
  if (entryLabel && isMutatingControlLabel(entryLabel)) labels.push(entryLabel);
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
}

export function successfulMutatingEntrySubmitted(
  result: ExplorerResult,
  entryLabel: string,
): boolean {
  const target = entryLabel.trim().toLowerCase();
  // Crawler inventory decorates repeated card controls with their owning
  // artifact (e.g. "REGENERATE (Emerald Lantern)"), while accessibility
  // correctly records the clicked button itself as just "REGENERATE".
  const synthesizedCardBase = target.match(/^(.+?)\s+\([^()]+\)$/)?.[1]?.trim();
  return (
    isMutatingControlLabel(entryLabel) &&
    result.actions.some(
      (action) => {
        const observed = action.resolvedLabel?.trim().toLowerCase();
        return (
          action.action === 'click' &&
          !action.executionFailed &&
          Boolean(observed) &&
          (observed === target || observed === synthesizedCardBase)
        );
      },
    )
  );
}

export type TerminalVisualAssessment = ArtifactPersistenceVisualAssessment & {
  screenshot?: string;
};

export type PostMutationPollResult = TerminalVisualAssessment & {
  waitedMs: number;
  timedOut: boolean;
};

/**
 * A bare Processing/Pending badge is intentionally too broad for the generic
 * page-wide processing detector, but is strong evidence here because vision
 * has already affirmed that a just-submitted artifact is processing.
 */
export function postMutationAppearsPending(snapshot: string): boolean {
  return hasPostMutationProcessing(snapshot);
}

export function uncertainArtifactAssessmentAppearsPending(
  assessment: Pick<TerminalVisualAssessment, 'status' | 'summary'>,
  snapshot: string,
): boolean {
  if (assessment.status !== 'uncertain') return false;
  return (
    postMutationAppearsPending(snapshot) ||
    /\b(?:loading|spinner|pending|processing|generating|rendering|finalizing|validating)\b/i.test(
      assessment.summary,
    )
  );
}

/**
 * Vision can correctly see a persisted intermediate artifact (rendered scenes,
 * a saved theme, a finalized character) yet incorrectly call the whole wizard
 * terminal. An enabled forward CTA is deterministic proof that the creation
 * flow has another required stage. Download/export controls are deliberately
 * absent: they are terminal artifact operations, not forward wizard progress.
 */
export function enabledForwardProgressControl(snapshot: string): string | undefined {
  const forward =
    /^(?:next|continue|save and continue|proceed|create video|generate video|render video|finalize|finalize character|review and finalize|apply changes)$/i;
  for (const line of snapshot.split('\n')) {
    const match = line.match(
      /(?:button|link)\s+"([^"]+)"[^\n]*\[ref=e\d+\]/i,
    );
    if (!match || !forward.test(match[1].trim())) continue;
    if (/\bdisabled\b/i.test(line)) continue;
    return match[1].trim();
  }
  return undefined;
}

/**
 * Upload pages commonly have two distinct continuations: a plan modal's
 * Continue and, after it closes, the wizard's Next. The Explorer can complete
 * the upload + modal, see the attached file and enabled Next, yet incorrectly
 * ask for another file (even a different media type) on its next attempt.
 *
 * Once the immediately preceding attempt successfully uploaded on this same
 * mapped state, an enabled ordinary forward control is deterministic and safer
 * than re-consulting the LLM. Keep this narrow: never infer final render/create
 * actions here, and never carry upload history across a different page.
 */
export function forwardControlAfterRecentUpload(
  previous: WalkStep | undefined,
  currentPageId: string,
  snapshot: string,
): string | undefined {
  if (!previous || previous.pageId !== currentPageId) return undefined;
  const actions = previous.actions?.length
    ? previous.actions
    : previous.action
      ? [previous.action]
      : [];
  if (!actions.some((action) => action.type === 'upload')) return undefined;
  const forward = enabledForwardProgressControl(snapshot);
  if (!forward || !/^(?:next|continue|save and continue|proceed)$/i.test(forward)) {
    return undefined;
  }
  return forward;
}

export function pageKindCanBeVisualTerminal(kind: PageNode['kind'] | undefined): boolean {
  const resolved = kind ?? 'page';
  return resolved !== 'wizard-step' && resolved !== 'modal';
}

function shouldPollSubmittedArtifact(
  browser: AgentBrowser,
  assessment: TerminalVisualAssessment,
  fallbackSnapshot: string,
): boolean {
  if (assessment.status === 'processing') return true;
  let snapshot = fallbackSnapshot;
  try {
    snapshot = browser.snapshotFull();
  } catch {
    // Fall back to the already captured state.
  }
  return uncertainArtifactAssessmentAppearsPending(assessment, snapshot);
}

/**
 * A mapped `kind:terminal` is preferred, but vision can prove a persistent
 * artifact when an SPA's sidebar landmarks make deterministic classification
 * ambiguous. The visual reviewer is deliberately asked to reject previews,
 * open forms, spinners, and still-visible finalize controls.
 */
async function visuallyAssessTerminal(
  deps: DeepWalkerDeps,
  trail: WalkTrail,
  page: PageNode,
  opts: { evidenceDir: string },
  observations: string,
): Promise<TerminalVisualAssessment> {
  const screenshot = path.join(opts.evidenceDir, `${slug(trail.id)}-terminal-candidate-${Date.now()}.png`);
  try {
    deps.browser.screenshotAnnotated(screenshot);
    const assessment = await assessArtifactPersistenceScreenshot(deps.llm, screenshot, {
      action: `Complete the creation flow entered through "${trail.entry.actionLabel}"`,
      url: deps.browser.getUrl(),
      observations,
    });
    if (assessment.status !== 'persisted') {
      console.log(`[walk] vision artifact status: ${assessment.status} — ${assessment.summary}`);
      return { ...assessment, screenshot };
    }
    const pageKind = page.kind ?? 'page';
    if (!pageKindCanBeVisualTerminal(pageKind)) {
      const summary =
        `Vision found a persisted intermediate artifact on a mapped ${pageKind}, but that state is still inside the creation flow. ` +
        `Continuing until a terminal page or completed asynchronous artifact is reached.`;
      console.log(`[walk] vision terminal veto: ${summary}`);
      return { status: 'incomplete', summary, screenshot };
    }
    let terminalSnapshot = deps.browser.snapshotInteractive();
    try {
      terminalSnapshot = deps.browser.snapshotFull();
    } catch {
      // Interactive controls are sufficient for the deterministic veto.
    }
    const forwardControl = enabledForwardProgressControl(terminalSnapshot);
    if (forwardControl) {
      const summary =
        `Vision found a persisted intermediate artifact, but enabled "${forwardControl}" proves the flow has another stage. ` +
        `Continuing toward the actual terminal artifact.`;
      console.log(`[walk] vision terminal veto: ${summary}`);
      return { status: 'incomplete', summary, screenshot };
    }
    trail.terminalEvidence = {
      source: 'vision',
      pageId: page.id,
      screenshot,
      summary: assessment.summary,
    };
    console.log(`[walk] ✓ vision verified terminal/persistent artifact: ${assessment.summary}`);
    return { ...assessment, screenshot };
  } catch (error) {
    console.warn(`[walk] terminal vision check unavailable: ${error instanceof Error ? error.message : error}`);
    return { status: 'uncertain', summary: 'Terminal vision check was unavailable' };
  }
}

/**
 * Poll an artifact that vision has already classified as processing. No click,
 * fill, upload, or navigation is permitted in this function. Vision is
 * re-consulted on a bounded backoff schedule and immediately when the visible
 * pending signal disappears.
 */
export async function pollSubmittedArtifact(
  deps: DeepWalkerDeps,
  trail: WalkTrail,
  page: PageNode,
  opts: { evidenceDir: string },
  observations: string,
): Promise<PostMutationPollResult> {
  const started = Date.now();
  let polls = 0;
  let nextVisionPoll = 3;
  let last: TerminalVisualAssessment = {
    status: 'processing',
    summary: 'Vision confirmed that the submitted artifact is still processing.',
  };

  while (Date.now() - started < config.deep.processingWaitMs) {
    deps.browser.wait(5000);
    polls++;
    let snapshot = deps.browser.snapshotInteractive();
    try {
      snapshot = deps.browser.snapshotFull();
    } catch {
      // The interactive snapshot is enough to decide whether to re-check vision.
    }
    const pending = postMutationAppearsPending(snapshot);
    if (!pending || polls >= nextVisionPoll) {
      last = await visuallyAssessTerminal(
        deps,
        trail,
        page,
        opts,
        `${observations}\nPost-mutation poll ${polls}: ${snapshot.slice(0, 5000)}`,
      );
      if (
        last.status === 'uncertain' &&
        (pending || uncertainArtifactAssessmentAppearsPending(last, snapshot))
      ) {
        // Vision can conservatively say "uncertain" while explicitly seeing a
        // loading spinner (live Koyal Assets immediately after Finalize). That
        // is still pending evidence after a known submitted mutation; remain in
        // this click-free poll instead of handing control back to a new
        // Add/Create/Generate attempt.
        last = {
          ...last,
          status: 'processing',
          summary: `The submitted artifact remains pending: ${last.summary}`,
        };
      } else if (last.status !== 'processing') {
        return { ...last, waitedMs: Date.now() - started, timedOut: false };
      }
      // 15s, 30s, 60s, 120s...: responsive without spending one vision call
      // every five seconds during a long video render.
      nextVisionPoll = Math.max(polls + 3, polls * 2);
    }
  }

  return {
    ...last,
    status: 'processing',
    summary: `The submitted artifact remained visibly processing for ${Math.round((Date.now() - started) / 1000)}s.`,
    waitedMs: Date.now() - started,
    timedOut: true,
  };
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
    if (a.executionFailed) continue;
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
    } else if (a.action === 'wait' && a.waitForProcessing) {
      out.push({ type: 'wait-processing', processingMs: a.waitedMs });
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
  const { browser, state, llm, explorer, nav } = deps;
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
  const seenRuntimeSignals = new Set<string>();

  const noteRuntimeSignal = (
    failure: NonNullable<ReturnType<typeof captureRuntimeFailure>>,
    context: string,
    screenshot?: string,
  ): void => {
    // SPAs can rethrow the same exception on every render/poll. One concrete
    // sample is enough evidence; persisting hundreds of identical copies makes
    // trails/reports enormous without adding information.
    const signature = runtimeSignalSignature(failure);
    if (seenRuntimeSignals.has(signature)) {
      browser.clearSignals();
      return;
    }
    seenRuntimeSignals.add(signature);
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

  const noteProcessingTimeout = (
    page: PageNode,
    waitedMs: number,
    context: string,
    screenshot?: string,
  ): void => {
    const detail =
      `Processing on "${page.title}" exceeded the configured wait ceiling ` +
      `(${Math.round(waitedMs / 1000)}s) and remained visibly active.`;
    (trail.runtimeSignals ??= []).push({
      at: new Date().toISOString(),
      context,
      kind: 'processing-timeout',
      detail,
      screenshot,
    });
    console.warn(`[walk] ! processing-timeout ${context}: ${detail}`);
  };

  const recoverAndEndBlockedWalk = (
    page: PageNode,
    snapshot: string,
    reason: string,
  ): void => {
    const recovery = recoverAwayFromBlockedState(browser, page, snapshot);
    console.warn(
      recovery.changed
        ? `[walk] ${reason} — moved ${recovery.direction} to ${recovery.url}; ending this walk and continuing the queue`
        : `[walk] ${reason} — Back/Forward did not leave the state; ending this walk and continuing the queue`,
    );
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

  const persistIncompleteTrail = (): void => {
    state.sitemap.walks = state.sitemap.walks ?? {};
    state.sitemap.walks[trailId] = trail;
    state.saveSitemap();
  };

  /**
   * Prefer the verified button-click entry chain, but verify its result before
   * looking for a branch control. Stateful apps may resume the previous draft
   * instead of showing the expected fork. A direct wizard URL is appropriate
   * only here, as bounded recovery from that failed verified entry path.
   */
  const recoverExpectedEntryPage = (): boolean => {
    const current = (): string =>
      matchPage(
        state.sitemap,
        browser.getUrl(),
        browser.snapshotInteractive(),
      )?.id ?? 'unknown';
    if (current() === entry.pageId) return true;
    if (!entry.via) return false;
    console.warn(
      `[walk] verified entry path "${entry.via.actionLabel}" resumed "${current()}" instead of "${entry.pageId}" — trying direct URL as intentional recovery`,
    );
    browser.open(entry.entryUrl);
    browser.wait(2000);
    return current() === entry.pageId;
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
        persistIncompleteTrail();
        return { trail, newPageIds, flow: null, recipeIds: [] };
      }
    }

    if (!recoverExpectedEntryPage()) {
      console.warn(
        `[walk] ${trailId}: neither the verified entry path nor direct recovery reached "${entry.pageId}" — aborting (will retry next explore)`,
      );
      trail.outcome = 'aborted';
      trail.finishedAt = new Date().toISOString();
      persistIncompleteTrail();
      return { trail, newPageIds, flow: null, recipeIds: [] };
    }

    const role =
      entry.interactive.role === 'button' || entry.interactive.role === 'link' || entry.interactive.role === 'tab'
        ? entry.interactive.role
        : undefined;
    const entryBeforeUrl = browser.getUrl();
    let entryBeforeSnapshot = browser.snapshotInteractive();
    try {
      entryBeforeSnapshot = browser.snapshotFull();
    } catch {
      // Interactive state is enough for a conservative transition check.
    }
    const waitForEntryAdvance = (): boolean => {
      const deadline = Date.now() + 6000;
      do {
        const afterUrl = browser.getUrl();
        let afterSnapshot = browser.snapshotInteractive();
        try {
          afterSnapshot = browser.snapshotFull();
        } catch {
          // Retain interactive state.
        }
        if (entryStateAdvanced(entryBeforeUrl, entryBeforeSnapshot, afterUrl, afterSnapshot)) {
          return true;
        }
        if (Date.now() >= deadline) return false;
        browser.wait(1000);
      } while (true);
    };
    let enteredExploration: ExplorerResult | undefined;
    let enteredDeterministically = nav.click({ label: entry.interactive.label, role, optional: true });
    if (enteredDeterministically) {
      browser.wait(1500);
      if (!waitForEntryAdvance()) {
        console.warn(
          `[walk] deterministic entry click "${entry.interactive.label}" reported success but produced no observable state change — trying bounded Explorer recovery`,
        );
        enteredDeterministically = false;
      }
    }
    if (!enteredDeterministically) {
      const entered = await explorer.achieveGoal(
        `Click the element labeled exactly "${entry.interactive.label}" to start that flow — not a similarly-named sidebar item. Use "done" once the screen changes.`,
        { maxSteps: 3 },
      );
      enteredExploration = entered;
      explorations.push(entered);
      browser.wait(1500);
      const entryAdvanced = waitForEntryAdvance();
      if (
        !entryAdvanced ||
        (!entered.success && !successfulMutatingEntrySubmitted(entered, entry.interactive.label))
      ) {
        // walking whatever page we happen to be on produces junk trails and flows
        console.warn(
          `[walk] ${trailId}: entry element "${entry.interactive.label}" did not produce a verified state transition — aborting without generating a flow`,
        );
        trail.outcome = 'aborted';
        trail.finishedAt = new Date().toISOString();
        persistIncompleteTrail();
        return { trail, newPageIds, flow: null, recipeIds: [] };
      }
      if (!entered.success) {
        console.log(
          `[walk] entry Explorer reported failure after successfully submitting "${entry.interactive.label}" — preserving the real mutation and assessing its resulting state`,
        );
      }
    }

    let prev = await identify();
    let noProgress = 0;
    let lastSignature = '';
    const inlineWaited = new Set<string>();
    const visionReleasedProcessing = new Set<string>();
    const blockedMutationsByPage = new Map<string, Set<string>>();
    const blockedMutationsFor = (pageId: string): string[] => [
      ...(blockedMutationsByPage.get(pageId) ?? new Set<string>()),
    ];
    const rememberSubmittedMutations = (pageId: string, explored: ExplorerResult): void => {
      const set = blockedMutationsByPage.get(pageId) ?? new Set<string>();
      for (const label of mutatingControlLabels(explored, entry.interactive.label)) set.add(label);
      blockedMutationsByPage.set(pageId, set);
    };
    const recordVisualBlocker = (page: PageNode, assessment: TerminalVisualAssessment): void => {
      (trail.runtimeSignals ??= []).push({
        at: new Date().toISOString(),
        context: `after submitting a creation mutation on "${page.id}"`,
        kind: 'visual-blocker',
        detail: assessment.summary,
        screenshot: assessment.screenshot,
      });
      console.warn(`[walk] ! vision found a concrete post-mutation blocker on "${page.id}": ${assessment.summary}`);
    };

    steps.push({
      index: 0,
      pageId: prev.page.id,
      kind: prev.page.kind ?? 'page',
      landmark: verifiedLandmark(prev.page, prev.snapshot),
      action: { type: 'click', label: entry.interactive.label, role: entry.interactive.role },
    });

    // The entry itself may be the mutation under test (Regenerate, Generate,
    // Add, New, Create). Previously only mutations performed inside the main
    // loop entered visual polling, so a successful Regenerate entry showing a
    // Processing badge immediately fell through to the generic page goal and
    // started unrelated creation actions. Treat the entry as the first
    // submitted mutation and apply the identical typed vision policy.
    if (isMutatingControlLabel(entry.interactive.label)) {
      const entryMutation: ExplorerResult = enteredExploration ?? {
        goal: `Enter via ${entry.interactive.label}`,
        success: true,
        actions: [
          {
            action: 'click',
            resolvedLabel: entry.interactive.label,
            resolvedRole: entry.interactive.role,
          },
        ],
        stepsTaken: [`click (${entry.interactive.role} "${entry.interactive.label}") — deterministic walk entry`],
        finalUrl: browser.getUrl(),
        finalSnapshot: prev.snapshot,
      };
      rememberSubmittedMutations(prev.page.id, entryMutation);
      let entryAssessment = await visuallyAssessTerminal(
        deps,
        trail,
        prev.page,
        opts,
        `The walk entry mutation "${entry.interactive.label}" executed successfully. Determine whether it opened an ordinary incomplete form, is actively processing, is blocked, or already produced a persisted artifact.`,
      );
      let entryPoll: PostMutationPollResult | undefined;
      if (shouldPollSubmittedArtifact(browser, entryAssessment, prev.snapshot)) {
        entryPoll = await pollSubmittedArtifact(
          deps,
          trail,
          prev.page,
          opts,
          `The walk entry mutation "${entry.interactive.label}" was submitted once and vision affirmed active processing.`,
        );
        entryAssessment = entryPoll;
        steps.push({
          index: 1,
          pageId: prev.page.id,
          kind: prev.page.kind ?? 'page',
          landmark: verifiedLandmark(prev.page, prev.snapshot),
          processingMs: entryPoll.waitedMs,
          action: { type: 'wait-processing' },
          screenshot: entryPoll.screenshot,
        });
      }
      if (entryAssessment.status === 'persisted') {
        if (!entryPoll) {
          steps.push({
            index: 1,
            pageId: prev.page.id,
            kind: prev.page.kind ?? 'page',
            landmark: verifiedLandmark(prev.page, prev.snapshot),
            screenshot: entryAssessment.screenshot,
          });
        }
        trail.outcome = 'terminal';
        console.log(`[walk] ✓ entry mutation "${entry.interactive.label}" reached a persisted artifact`);
      } else if (entryAssessment.status === 'processing' && entryPoll?.timedOut) {
        noteProcessingTimeout(
          prev.page,
          entryPoll.waitedMs,
          `while polling walk entry mutation "${entry.interactive.label}"`,
          entryAssessment.screenshot,
        );
        recoverAndEndBlockedWalk(prev.page, prev.snapshot, 'walk entry mutation processing wait ceiling exceeded');
        trail.outcome = 'error';
      } else if (entryAssessment.status === 'blocked') {
        recordVisualBlocker(prev.page, entryAssessment);
        recoverAndEndBlockedWalk(prev.page, prev.snapshot, 'vision found a blocker after the walk entry mutation');
        trail.outcome = 'error';
      }
    }

    for (let i = 1; i <= maxSteps && trail.outcome === 'aborted'; i++) {
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
        let assessment = await visuallyAssessTerminal(
          deps,
          trail,
          page,
          opts,
          'The deterministic sitemap classified this page as terminal; visually affirm the current rendered artifact rather than trusting the saved classification alone.',
        );
        let terminalPoll: PostMutationPollResult | undefined;
        if (shouldPollSubmittedArtifact(browser, assessment, snapshot)) {
          terminalPoll = await pollSubmittedArtifact(
            deps,
            trail,
            page,
            opts,
            'A saved terminal-page classification is present, but vision affirmed that the current artifact is still processing.',
          );
          assessment = terminalPoll;
        }
        steps.push({
          index: i,
          pageId: page.id,
          kind,
          landmark,
          screenshot: assessment.screenshot,
          processingMs: terminalPoll?.waitedMs,
          action: terminalPoll ? { type: 'wait-processing' } : undefined,
        });
        if (assessment.status === 'persisted') {
          trail.outcome = 'terminal';
          console.log(`[walk] ✓ reached vision-affirmed terminal state "${page.id}"`);
          break;
        }
        if (assessment.status === 'processing' && terminalPoll?.timedOut) {
          noteProcessingTimeout(page, terminalPoll.waitedMs, `while affirming terminal page "${page.id}"`, assessment.screenshot);
          recoverAndEndBlockedWalk(page, snapshot, 'terminal artifact processing wait ceiling exceeded');
          trail.outcome = 'error';
          break;
        }
        if (assessment.status === 'blocked') {
          recordVisualBlocker(page, assessment);
          recoverAndEndBlockedWalk(page, snapshot, 'vision found a blocker on the mapped terminal page');
          trail.outcome = 'error';
          break;
        }
        console.warn(
          `[walk] mapped terminal page "${page.id}" is visually ${assessment.status}; refusing terminal success and continuing bounded recovery`,
        );
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
        let nextVisionPoll = 3;
        let resolved = false;
        for (;;) {
          if (Date.now() - t0 > waitBudget) {
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
          if (polls === nextVisionPoll) {
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
            // Re-affirm once per minute while a long-running text classifier
            // remains unchanged. Async work can finish well after the initial
            // 15-second check, especially when the route itself is stable.
            nextVisionPoll += 12;
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
          let screenshot: string | undefined;
          try {
            screenshot = path.join(opts.evidenceDir, `${slug(trailId)}-processing-timeout-${i}.png`);
            browser.screenshotAnnotated(screenshot);
          } catch {
            screenshot = undefined;
          }
          noteProcessingTimeout(page, Date.now() - t0, `while waiting on state "${page.id}"`, screenshot);
          recoverAndEndBlockedWalk(page, snapshot, 'processing wait ceiling exceeded');
          trail.outcome = 'error';
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
        let resolved = false;
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
          if (!hasInlineProcessing(currentSnapshot)) {
            resolved = true;
            break;
          }
          if (polls === 3) {
            const visualStatus = await visuallyAffirmWalkProcessing(
              deps,
              path.join(opts.evidenceDir, `${slug(trailId)}-inline-affirm-${i}.png`),
              `Wait for inline processing on "${page.title}" to finish`,
              'The text detector still reports inline processing after three polls.',
            );
            if (visualStatus === 'complete' || visualStatus === 'blocked') {
              resolved = true;
              break;
            }
          }
        }
        const waited = Date.now() - t0;
        console.log(`[walk] inline processing ${resolved ? 'cleared/released' : 'timed out'} after ${Math.round(waited / 1000)}s`);
        steps.push({
          index: i,
          pageId: page.id,
          kind,
          landmark,
          processingMs: waited,
          action: { type: 'wait-processing' },
        });
        if (!resolved) {
          let screenshot: string | undefined;
          try {
            screenshot = path.join(opts.evidenceDir, `${slug(trailId)}-inline-processing-timeout-${i}.png`);
            browser.screenshotAnnotated(screenshot);
          } catch {
            screenshot = undefined;
          }
          noteProcessingTimeout(page, waited, `during inline processing on "${page.id}"`, screenshot);
          recoverAndEndBlockedWalk(page, snapshot, 'inline processing wait ceiling exceeded');
          trail.outcome = 'error';
          break;
        }
        prev = { page, snapshot };
        continue;
      }

      // wizard-step / modal / page: try to advance one screen
      const deterministicUploadForward = forwardControlAfterRecentUpload(
        steps.at(-1),
        page.id,
        snapshot,
      );
      if (deterministicUploadForward) {
        console.log(
          `[walk] uploaded file is attached and "${deterministicUploadForward}" is enabled — advancing without requesting another upload`,
        );
        try {
          deps.nav.click({
            label: deterministicUploadForward,
            exact: true,
            role: 'button',
          });
          steps.push({
            index: i,
            pageId: page.id,
            kind,
            landmark,
            action: {
              type: 'click',
              label: deterministicUploadForward,
              role: 'button',
            },
          });
          browser.wait(1500);
          prev = await identify(snapshot);
          continue;
        } catch (error) {
          console.warn(
            `[walk] deterministic post-upload advance could not click "${deterministicUploadForward}": ${error instanceof Error ? error.message : error}`,
          );
          // Fall through to normal LLM exploration; the prior upload remains
          // visible in its context and the prompt explicitly forbids replacing it.
        }
      }

      const signature = stableStateSignature(page, snapshot);
      if (signature === lastSignature) {
        noProgress++;
        const noProgressLimit = config.probes.exhaustive ? 6 : 3;
        if (noProgress >= noProgressLimit) {
          let terminal = await visuallyAssessTerminal(
            deps,
            trail,
            page,
            opts,
            `The browser state remained unchanged after ${noProgressLimit} attempts. Determine whether that is because the artifact is already completely created and persisted, or because automation is stuck on an intermediate control.`,
          );
          let terminalPoll: PostMutationPollResult | undefined;
          if (shouldPollSubmittedArtifact(browser, terminal, snapshot)) {
            terminalPoll = await pollSubmittedArtifact(
              deps,
              trail,
              page,
              opts,
              `The state was unchanged after ${noProgressLimit} attempts and vision affirmed active artifact processing.`,
            );
            steps.push({
              index: i,
              pageId: page.id,
              kind,
              landmark,
              processingMs: terminalPoll.waitedMs,
              action: { type: 'wait-processing' },
              screenshot: terminalPoll.screenshot,
            });
            terminal = terminalPoll;
          }
          if (terminal.status === 'persisted') {
            trail.outcome = 'terminal';
            console.log(`[walk] unchanged state was a vision-verified terminal artifact on "${page.id}"`);
            break;
          }
          if (terminal.status === 'processing' && terminalPoll?.timedOut) {
            noteProcessingTimeout(page, terminalPoll.waitedMs, `while polling a submitted artifact on "${page.id}"`, terminal.screenshot);
            recoverAndEndBlockedWalk(page, snapshot, 'submitted artifact processing wait ceiling exceeded');
            trail.outcome = 'error';
            break;
          }
          if (terminal.status === 'blocked') {
            recordVisualBlocker(page, terminal);
            recoverAndEndBlockedWalk(page, snapshot, 'vision found a concrete post-mutation blocker');
            trail.outcome = 'error';
            break;
          }

          console.log(`[walk] no progress on "${page.id}" — invoking screenshot-first control recovery`);
          const recoveryFromUrl = browser.getUrl();
          const recovery = await explorer.achieveGoal(
            `The automation is stuck while completing the creation flow started by "${entry.interactive.label}". ` +
              `Use the screenshot and full page state to locate the actual enabled control, modal, validation message, or required field that advances toward a saved terminal artifact. ` +
              `Do not declare a product failure merely because an element is hard to locate. If processing is visible, wait. ` +
              `If a real error is visible, use fail and quote it. Otherwise perform the corrective action and use done only after the state advances.`,
            {
              maxSteps: Math.max(12, config.llm.maxStepsPerGoal),
              visionFirst: true,
              blockedClickLabels: blockedMutationsFor(page.id),
              returnOnUrlChange: true,
            },
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
          if (!recovery.success) {
            const currentUrl = browser.getUrl();
            const currentSnapshot = browser.snapshotInteractive();
            const sameState =
              currentUrl === recoveryFromUrl &&
              stableStateSignature(page, currentSnapshot) === stableStateSignature(page, snapshot);
            if (sameState) {
              if (recovery.processingTimedOut) {
                noteProcessingTimeout(
                  page,
                  config.deep.processingWaitMs,
                  `during screenshot recovery on "${page.id}"`,
                );
              }
              recoverAndEndBlockedWalk(
                page,
                snapshot,
                `Screenshot recovery exhausted the unchanged state: ${recovery.error ?? 'unknown failure'}`,
              );
              trail.outcome = recovery.processingTimedOut || /error|server|processing|timeout|failed/i.test(recovery.error ?? '')
                ? 'error'
                : 'no-progress';
              break;
            }
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
      const exploredFromUrl = browser.getUrl();
      const explored = await explorer.achieveGoal(advanceGoal(page, marker, triedChoices), {
        maxSteps: config.probes.exhaustive ? Math.max(12, config.llm.maxStepsPerGoal) : 6,
        blockedClickLabels: blockedMutationsFor(page.id),
        returnOnUrlChange: true,
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
      if (explored.processingTimedOut) {
        const blockedState = await identify(snapshot);
        let screenshot: string | undefined;
        try {
          screenshot = path.join(opts.evidenceDir, `${slug(trailId)}-explorer-processing-timeout-${i}.png`);
          browser.screenshotAnnotated(screenshot);
        } catch {
          screenshot = undefined;
        }
        noteProcessingTimeout(
          blockedState.page,
          config.deep.processingWaitMs,
          `inside Explorer on live state "${blockedState.page.id}"`,
          screenshot,
        );
        recoverAndEndBlockedWalk(
          blockedState.page,
          blockedState.snapshot,
          'Explorer processing wait ceiling exceeded',
        );
        trail.outcome = 'error';
        break;
      }
      // A completion mutation may have landed even when the Explorer later
      // exhausted its own goal budget. Assess/poll that submitted artifact
      // before treating the overall Explorer result as a normal failure;
      // otherwise the next outer iteration can submit it again.
      if (!explored.success && !hasPossibleCompletionAction(explored)) {
        const currentUrl = browser.getUrl();
        const currentSnapshot = browser.snapshotInteractive();
        const sameState =
          currentUrl === exploredFromUrl &&
          stableStateSignature(page, currentSnapshot) === stableStateSignature(page, snapshot);
        if (sameState) {
          recoverAndEndBlockedWalk(page, snapshot, `Explorer exhausted the unchanged state: ${explored.error ?? 'unknown failure'}`);
          trail.outcome = /error|server|processing|timeout|failed/i.test(explored.error ?? '') ? 'error' : 'no-progress';
          break;
        }
        prev = await identify(snapshot);
        continue;
      }
      if (hasPossibleCompletionAction(explored)) {
        const stateCycleFailure = isExplorerStateCycleFailure(explored);
        const after = await identify(snapshot);
        rememberSubmittedMutations(after.page.id, explored);
        let terminal = await visuallyAssessTerminal(
          deps,
          trail,
          after.page,
          opts,
          explored.stepsTaken.join('\n'),
        );
        let terminalPoll: PostMutationPollResult | undefined;
        if (shouldPollSubmittedArtifact(browser, terminal, after.snapshot)) {
          terminalPoll = await pollSubmittedArtifact(
            deps,
            trail,
            after.page,
            opts,
            explored.stepsTaken.join('\n'),
          );
          steps.push({
            index: i + 1,
            pageId: after.page.id,
            kind: after.page.kind ?? 'page',
            landmark: verifiedLandmark(after.page, after.snapshot),
            processingMs: terminalPoll.waitedMs,
            action: { type: 'wait-processing' },
            screenshot: terminalPoll.screenshot,
          });
          terminal = terminalPoll;
        }
        if (terminal.status === 'persisted') {
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
        if (terminal.status === 'processing' && terminalPoll?.timedOut) {
          noteProcessingTimeout(
            after.page,
            terminalPoll.waitedMs,
            `while polling the submitted artifact on "${after.page.id}"`,
            terminal.screenshot,
          );
          recoverAndEndBlockedWalk(after.page, after.snapshot, 'submitted artifact processing wait ceiling exceeded');
          trail.outcome = 'error';
          break;
        }
        if (terminal.status === 'blocked') {
          if (await explorer.recoverRejectedFillFromVision(explored, terminal.summary)) {
            const lastStep = steps.at(-1);
            if (lastStep?.pageId === page.id) {
              lastStep.action = summarizeActions(explored);
              lastStep.actions = collectActions(explored);
            }
            console.log(
              `[walk] vision-confirmed field rejection was replaced through the human value channel; resuming "${after.page.id}"`,
            );
            prev = await identify(after.snapshot);
            continue;
          }
          recordVisualBlocker(after.page, terminal);
          recoverAndEndBlockedWalk(after.page, after.snapshot, 'vision found a concrete post-mutation blocker');
          trail.outcome = 'error';
          break;
        }
        // A previous completion mutation explains why we visually assess the
        // result before stopping, but it must not erase a contained state-cycle
        // failure. If vision found neither persistence, active processing nor a
        // concrete blocker, restarting another Explorer on this same
        // incomplete/uncertain state only recreates the cycle and burns another
        // full goal budget.
        if (stateCycleFailure) {
          recoverAndEndBlockedWalk(
            after.page,
            after.snapshot,
            `Explorer state-cycle remained incomplete after visual arbitration: ${explored.error ?? 'unknown cycle'}`,
          );
          trail.outcome = 'no-progress';
          break;
        }
        // The mutation was submitted but the rendered result is merely
        // incomplete/uncertain. Continue from the CURRENT state while the
        // execution-level denylist prevents Create/Generate/Finalize from being
        // replayed. A different next-stage control (e.g. Finalize after Create)
        // remains allowed if it was not already executed.
        prev = after;
        continue;
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
    (s) =>
      s.kind === 'wizard-step' ||
      s.kind === 'modal' ||
      s.kind === 'page' ||
      // A page can be classified as processing while the same Explorer goal
      // performs meaningful work before/after the wait. Live Koyal evidence:
      // Edit Scenes was `kind:processing`, but its action sequence edited a
      // scene and clicked Create Video. Dropping the whole step compiled a
      // "terminal" walked flow that ended at Locations even though the walk
      // itself reached a rendered video.
      Boolean(
        (s.action && s.action.type !== 'wait-processing') ||
          s.actions?.some((action) => action.type !== 'wait-processing'),
      ),
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
    const samePageTerminalMutation =
      actionable.length === 1 &&
      i === 0 &&
      step.action?.type === 'click' &&
      Boolean(step.action.label && isMutatingControlLabel(step.action.label));

    milestones.push({
      id: `m${i + 1}`,
      goal:
        (samePageTerminalMutation
          ? `On "${page?.title ?? step.pageId}": ${actionDesc} once, then wait until the named item is visibly finished and usable. Remaining on the same page is valid; do not submit the action again after processing completes.`
          : `On "${page?.title ?? step.pageId}": ${actionDesc}, then advance one screen` +
            (target?.landmark ? ` until "${target.landmark}" is visible.` : '.')) +
        ' If this action appears already done (the control now shows Remove/Undo/Added or is missing), skip it and just advance.' +
        (step.action?.type === 'click' && !samePageTerminalMutation
          ? ' Stop as soon as that click reveals the next distinct dialog, form, wizard step, or page; do not fill or submit the newly revealed state.'
          : ''),
      kind,
      successHint: target?.landmark,
      guardPhases: [step.pageId],
      maxWaitMs: processing?.processingMs ? Math.round(processing.processingMs * 1.5) : undefined,
    });
  }

  // A terminal walk must compile the terminal proof itself, not merely the
  // last mutation that started rendering/generation. This zero-action verify
  // milestone is replayable: prior recipes rebuild the terminal page, then the
  // flow runner's dedicated artifact-persistence oracle must visually confirm
  // the completed artifact before deterministic promotion.
  if (trail.outcome === 'terminal' && trail.terminalEvidence?.pageId) {
    const terminalPageId = trail.terminalEvidence.pageId;
    const terminalPage = state.sitemap.pages[terminalPageId];
    milestones.push({
      id: `m${milestones.length + 1}`,
      goal:
        `Verify the completed terminal artifact on "${terminalPage?.title ?? terminalPageId}" is visibly persisted and usable. ` +
        'Do not start, regenerate, edit, or submit anything; this milestone is verification only.',
      kind: 'verify',
      guardPhases: [terminalPageId],
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

    const recipeSteps: RecipeStep[] = [];
    const recordedActions = step?.actions?.length ? step.actions : step?.action ? [step.action] : [];
    for (const action of recordedActions) {
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
      } else if (action.type === 'wait-processing') {
        recipeSteps.push({
          kind: 'waitForProcessing',
          maxMs: Math.max(
            config.deep.processingWaitMs,
            Math.round((action.processingMs ?? 10000) * 1.5),
          ),
        });
      }
    }
    // A processing observation is often recorded as its own trail state after
    // the action that triggered it (same-page regeneration is the common
    // example), rather than inside that action's `actions` sequence. It still
    // belongs to this milestone. Dropping it produces a replay recipe that
    // merely clicks Generate/Regenerate and immediately verifies the page,
    // even though the successful walk proved that completion required polling.
    //
    // Preserve every standalone processing barrier up to the next actionable
    // milestone. Avoid duplicating barriers already embedded in `actions`.
    const stepIdx = step ? trail.steps.indexOf(step) : -1;
    const nextStep = actionable[i + 1];
    const nextStepIdx = nextStep ? trail.steps.indexOf(nextStep) : trail.steps.length;
    const embeddedProcessingDurations = recordedActions
      .filter((action) => action.type === 'wait-processing')
      .map((action) => action.processingMs ?? 10000);
    if (stepIdx >= 0) {
      for (let j = stepIdx + 1; j < nextStepIdx; j++) {
        const action = trail.steps[j]?.action;
        if (action?.type !== 'wait-processing') continue;
        const duration = action.processingMs ?? trail.steps[j]?.processingMs ?? 10000;
        const duplicateIdx = embeddedProcessingDurations.findIndex(
          (embedded) => embedded === duration,
        );
        if (duplicateIdx >= 0) {
          embeddedProcessingDurations.splice(duplicateIdx, 1);
          continue;
        }
        recipeSteps.push({
          kind: 'waitForProcessing',
          maxMs: Math.max(config.deep.processingWaitMs, Math.round(duration * 1.5)),
        });
      }
    }
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
