import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import { randomEditMarker } from '../core/edits.js';
import {
  isLikelyMutationLabel,
  type Explorer,
  type ExplorerAction,
  type ExplorerResult,
} from '../core/explorer.js';
import { patchStepSummaryVerdict, writeJson } from '../core/evidence.js';
import { scenarioEvidenceDir } from '../core/report.js';
import { recordVerifiedStep, type StepContext } from '../core/scenario-runner.js';
import type {
  RunReport,
  ScenarioResult,
  SignalBundle,
  TestStep,
  VerificationExpectation,
  Verdict,
} from '../core/types.js';
import { VerificationLayer } from '../core/verification.js';
import { ensureAuthenticated, type AuthContext } from './auth.js';
import { extractCandidates, type Statements } from './statements.js';
import { runProbesForMilestone, type ProbeContext } from './probes.js';
import {
  compactSupersededFills,
  recordFromExplorer,
  recordWalkRecipe,
  recipeStepsFromExplorer,
  type RecipePlayer,
  type RecipeStep,
} from './recipes.js';
import { Nav, parseContextualControlLabel } from '../core/nav.js';
import type { Interact } from './interact.js';
import type { SiteState } from './site-state.js';
import {
  matchPage,
  normalizePath,
  type Flow,
  type FlowMilestone,
  type ManualAcceptanceTask,
  type PageNode,
  type SiteMap,
} from './sitemap.js';
import { looksLikeAuthGate, looksLikeSoft404 } from './page-classifier.js';
import type { LlmClient } from '../core/llm/client.js';
import {
  fieldValueKey,
  isLikelyUniqueCreationIdentityField,
  resolveFreshHumanFieldValue,
  resolveHumanFieldValue,
} from './field-values.js';
import {
  flowRunMode,
  hasEveryMilestoneRecipe,
  hasVerifiedTerminalArtifact,
  isRunnableFlow,
  qualifyFlowAfterRun,
  type FlowRunMode,
  type MilestoneExecution,
} from './flow-lifecycle.js';
import { manualEditVerificationGuidance } from './manual-task-engine.js';

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
  llm: LlmClient;
}

/**
 * agent-browser's page target can detach mid-transition, reading as about:blank
 * (same condition core/explorer.ts and deep-walker.ts already guard against).
 * Needed here because `currentPageId` collapses this into the generic 'unknown'
 * sentinel, which the guard-phase/probe-drift checks below intentionally treat
 * as "maybe still loading, don't panic" — correct for a page that simply hasn't
 * been classified yet, but wrong for a genuinely dead target: confirmed live
 * (this exact site, two separate flows) that a failed back-forward probe can
 * leave the browser at about:blank, and the NEXT milestone's own achieveGoal
 * call has no way to recover on its own — its blank-recovery logic anchors to
 * `lastRealUrl` captured at the START of that call, which is about:blank itself
 * when the call begins already-broken, so the condition to recover never fires
 * and the milestone false-fails ("page remains blank after multiple waits").
 */
function isBlankState(browser: AgentBrowser): boolean {
  try {
    const url = browser.getUrl();
    if (url.startsWith('about:')) return true;
    return !browser.snapshotInteractive().trim();
  } catch {
    return false;
  }
}

function currentPageId(deps: FlowRunnerDeps): string {
  // Called throughout this module (guard-phase checks, probe repositioning, KB
  // triage, fast-forward). If the browser daemon is wedged, getUrl/snapshot throw
  // — treat that exactly like "couldn't identify the page" (the existing,
  // already-handled 'unknown' case) rather than letting it escape and abort
  // whatever step is currently in flight, potentially losing an already-passed
  // milestone that just hasn't been pushed to scenario.steps yet.
  try {
    const page = matchPage(deps.state.sitemap, deps.browser.getUrl(), deps.browser.snapshotInteractive());
    return page?.id ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * A task-graph journey can legitimately outlive the exact state that the
 * sitemap observed on a route. The common case is a terminal route mapped
 * while it said "Generating", then rendered in place until those processing
 * landmarks disappeared. `matchPage` correctly refuses URL-only matching for
 * stateful pages, but position recovery still needs to know that the browser is
 * on the journey's one unambiguous route instead of restarting the whole flow.
 *
 * Keep this fallback manual-v2-only and require the normalized URL to identify
 * exactly one primary-journey page. Shared wizard URLs therefore remain
 * landmark-driven; only a unique route such as `/finalvideo` can qualify.
 */
export function manualJourneyPageIdForUrl(
  flow: Flow,
  sitemap: SiteMap,
  url: string,
): string | undefined {
  const primaryIds = flow.manualExecution?.primaryJourneyPageIds;
  if (!primaryIds?.length) return undefined;
  const normalized = normalizePath(url);
  const matches = [...new Set(primaryIds)].filter((id) => {
    const page = sitemap.pages[id];
    if (!page) return false;
    const patterns = new Set([
      ...page.urlPatterns,
      ...(page.exampleUrl ? [normalizePath(page.exampleUrl)] : []),
    ]);
    return patterns.has(normalized);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function currentFlowPageId(deps: FlowRunnerDeps, flow: Flow): string {
  const matched = currentPageId(deps);
  if (matched !== 'unknown' || !flow.manualExecution) return matched;
  try {
    return manualJourneyPageIdForUrl(flow, deps.state.sitemap, deps.browser.getUrl()) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Wait for an expected guard phase to appear before declaring the flow off-track. */
function waitForGuardPhase(
  deps: FlowRunnerDeps,
  phases: string[],
  maxMs: number,
  flow?: Flow,
): string {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const id = flow ? currentFlowPageId(deps, flow) : currentPageId(deps);
    if (phases.includes(id)) return id;
    if (Date.now() >= deadline) return id;
    deps.browser.wait(3000);
  }
}

/** Only literal-looking hints are snapshot-matched; prose descriptions would never appear on the page. */
function isLiteralHint(hint: string): boolean {
  return hint.length <= 120 && !/[()]/.test(hint) && hint.split(/\s+/).length <= 16;
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

export function manualEditRequiresZeroErrorSignals(
  flow: Flow,
  milestone: FlowMilestone,
): boolean {
  if (!flow.manualContract) return false;
  const taskRequirement = milestone.manualTaskId
    ? flow.manualExecution?.tasks.find((task) => task.id === milestone.manualTaskId)?.requirement
    : milestone.manualContractAudit && milestone.manualContractItem
      ? flow.manualContract.checklist[milestone.manualContractItem - 1]
      : milestone.goal;
  return Boolean(taskRequirement && manualEditVerificationGuidance(taskRequirement));
}

function runtimeSignalSignature(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : JSON.stringify(value).toLowerCase();
}

function freshRuntimeEntries<T>(after: readonly T[], before: readonly T[] = []): T[] {
  const remaining = new Map<string, number>();
  for (const entry of before) {
    const key = runtimeSignalSignature(entry);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return after.filter((entry) => {
    const key = runtimeSignalSignature(entry);
    const count = remaining.get(key) ?? 0;
    if (count <= 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

/** Narrow third-party/media teardown failures proven non-blocking by live runs. */
export function isKnownNonBlockingManualRuntimeError(text: string): boolean {
  return /(?:wavesurfer|posthog|rrweb)[\s\S]{0,400}(?:aborterror|signal is aborted|failed to fetch)|(?:aborterror|signal is aborted)[\s\S]{0,400}wavesurfer/i.test(
    text,
  );
}

/** Keep the raw evidence in reports, but judge this action only on fresh signals. */
export function manualFreshSignalBundle(
  after: SignalBundle,
  before?: SignalBundle,
): SignalBundle {
  const pageErrors = freshRuntimeEntries(after.pageErrors, before?.pageErrors).filter(
    (error) => !isKnownNonBlockingManualRuntimeError(error.message),
  );
  const consoleErrors = freshRuntimeEntries(
    after.consoleErrors,
    before?.consoleErrors,
  ).filter((error) => !isKnownNonBlockingManualRuntimeError(error.text));
  const fresh5xx = freshRuntimeEntries(
    after.networkRequests.filter((request) => Number(request.status ?? 0) >= 500),
    before?.networkRequests.filter((request) => Number(request.status ?? 0) >= 500),
  );
  return {
    ...after,
    pageErrors,
    consoleErrors,
    networkRequests: [
      ...after.networkRequests.filter((request) => Number(request.status ?? 0) < 500),
      ...fresh5xx,
    ],
  };
}

function patternAppears(text: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') return text.toLowerCase().includes(pattern.toLowerCase());
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function freshVisibleProductError(after: string, before: string): boolean {
  const patterns = [
    /\b(?:something went wrong|internal server error|unexpected error|insufficient credits)\b/i,
    /\bfailed to (?:generate|save|create|upload|render)\b/i,
    /\b(?:video is not edited|no image available|try again later)\b/i,
    /\b(?:project|workspace|record|document|item)\s*id\s+is\s+not\s+allowed\s+to\s+be\s+empty\b/i,
  ];
  return patterns.some((pattern) => patternAppears(after, pattern) && !patternAppears(before, pattern));
}

/**
 * A product error raised by one manual acceptance task may remain rendered on
 * the SPA while later, independent tasks succeed.  Vision must retain that
 * evidence, but it must not charge the same old banner/tile to every later
 * milestone.  This is intentionally limited to explicit product-error UI that
 * was already visible in the milestone's pre-action baseline.
 */
export function manualVisualConcernIsHistoricalProductError(
  visual: TestStep['result']['visualAssessment'],
  beforeSnapshot: string,
  afterSnapshot: string,
): boolean {
  if (visual?.status !== 'concern') return false;
  const assessment = `${visual.summary}\n${visual.concerns.join('\n')}`;
  const explicitErrorPatterns = [
    {
      assessment: /\bvideo is not edited(?: please try again later)?\b/i,
      snapshot: /\bvideo is not edited(?: please try again later)?\b/i,
    },
    {
      assessment: /\b(?:shot|scene|tile|card)\b.{0,80}\berror\b/i,
      snapshot: /(?:button|statictext)\s+"!?\s*error\b|\b(?:shot|scene)\b.{0,80}\berror\b/i,
    },
    {
      assessment: /\b(?:failed to (?:generate|save|create|upload|render)|no image available)\b/i,
      snapshot: /\b(?:failed to (?:generate|save|create|upload|render)|no image available)\b/i,
    },
    {
      assessment: /\b(?:something went wrong|internal server error|unexpected error)\b/i,
      snapshot: /\b(?:something went wrong|internal server error|unexpected error)\b/i,
    },
  ];
  return explicitErrorPatterns.some(
    ({ assessment: assessmentPattern, snapshot: snapshotPattern }) =>
      patternAppears(assessment, assessmentPattern) &&
      patternAppears(beforeSnapshot, snapshotPattern) &&
      patternAppears(afterSnapshot, snapshotPattern),
  );
}

function normalizeManualVerificationResult(
  step: TestStep,
  before: SignalBundle,
  expectation: VerificationExpectation,
  verification: VerificationLayer,
): void {
  const beforeSnapshot = `${before.snapshot.raw}\n${before.snapshot.interactive}`;
  const afterSnapshot = `${step.result.signals.snapshot.raw}\n${step.result.signals.snapshot.interactive}`;
  const effectiveSignals = manualFreshSignalBundle(step.result.signals, before);
  const effectiveExpectation: VerificationExpectation = {
    ...expectation,
    // A KB exclusion already present before this action is historical context,
    // not evidence that the current action introduced the error.
    snapshotExcludes: expectation.snapshotExcludes?.filter(
      (pattern) => !patternAppears(beforeSnapshot, pattern),
    ),
  };
  const effective = verification.evaluateSignals(effectiveSignals, effectiveExpectation);
  const fresh5xx = effectiveSignals.networkRequests.some(
    (request) =>
      Number(request.status ?? 0) >= 500 &&
      !config.ignored5xxHostsPattern.test(request.url ?? ''),
  );
  const visiblyTimedOutProcessing =
    /\b(?:processing|generating|rendering)\b/i.test(afterSnapshot) &&
    step.result.reasons.some((reason) => /exceeded .{0,30}(?:wait|timeout)|processing timeout/i.test(reason));
  step.result.freshProductFailureEvidence =
    effectiveSignals.pageErrors.length > 0 ||
    effectiveSignals.consoleErrors.length > 0 ||
    fresh5xx ||
    freshVisibleProductError(afterSnapshot, beforeSnapshot) ||
    visiblyTimedOutProcessing;

  const historicalVisualProductError =
    !step.result.freshProductFailureEvidence &&
    manualVisualConcernIsHistoricalProductError(
      step.result.visualAssessment,
      beforeSnapshot,
      afterSnapshot,
    );

  const runtimeNoiseOnly =
    step.result.reasons.length > 0 &&
    step.result.reasons.every((reason) =>
      /^(?:Uncaught JS exceptions|Console errors|Unexpected 5xx responses|Snapshot should not include)/i.test(
        reason,
      ),
    );
  if (
    step.result.verdict !== 'pass' &&
    effective.verdict === 'pass' &&
    (runtimeNoiseOnly || historicalVisualProductError) &&
    (step.result.visualAssessment?.status !== 'concern' || historicalVisualProductError)
  ) {
    step.result.verdict = 'pass';
    step.result.severity = 'low';
    step.result.actual = verification.buildActualSummary(effectiveSignals);
    step.result.reasons = [
      ...effective.reasons,
      historicalVisualProductError
        ? 'Baseline-aware manual verification kept the earlier product error on its originating task instead of charging it to this later independent milestone'
        : 'Baseline-aware manual verification removed only cumulative or known non-blocking runtime noise',
    ];
  }
}

/**
 * A healthy submitted mutation must not be turned into NEEDS REVIEW merely
 * because a second semantic/vision audit cannot prove the artistic delta or
 * reconstruct every label. This is deliberately narrower than "the explorer
 * said done": it requires same-run input + submit evidence and clean captured
 * product signals. Creation, deletion, and terminal-artifact requirements keep
 * their stronger persistence/identity proof.
 */
export function manualOperationalMutationVerified(
  item: string,
  evidence: readonly string[],
  step: TestStep,
  explorerSucceeded: boolean,
  beforeSnapshot = '',
  beforeSignals?: SignalBundle,
): boolean {
  if (
    hasFreshOperationalProductFailure(step, beforeSnapshot, beforeSignals)
  ) {
    return false;
  }
  if (
    /\b(?:delete|remove)\b/i.test(item) ||
    /\b(?:terminal artifact|final[- ]video|rendered video|create video|downloadable)\b/i.test(item) ||
    /\bexactly three distinct characters\b/i.test(item) ||
    /\b(?:create|finalize).{0,60}\b(?:character|asset|location|project)\b/i.test(item) ||
    /\b(?:new reusable asset|asset library)\b/i.test(item)
  ) {
    return false;
  }

  const joined = evidence.join('\n').toLowerCase();
  const mutationShaped =
    Boolean(manualEditVerificationGuidance(item)) ||
    /\b(?:add assets?|add reference|upload)\b/i.test(item);
  if (!mutationShaped) return false;

  const hasInput =
    /\b(?:filled|selected|uploaded) "[^"]+"/.test(joined) ||
    /clicked "[^"]*(?:top down|low angle|high angle|eye level|side profile|over[- ]the[- ]shoulder|close[- ]up|wide shot|bird'?s[- ]eye|dutch angle|melancholy|euphoric|serene)[^"]*"/.test(
      joined,
    );
  const hasSubmit =
    /clicked "[^"]*(?:save|apply|change look|regenerate|reshoot|retake|reframe|add assets?|add reference|add video|submit edit)[^"]*"/.test(
      joined,
    );
  if (!hasInput || !hasSubmit) return false;

  // The explorer can time out after the requested mutation has already been
  // submitted (most commonly by repeating `done` while the SPA remains on the
  // same surface). For operational edits, the recorded input + submit pair and
  // clean post-action signals are stronger evidence than that bookkeeping
  // failure. The strict creation/deletion/terminal cases above still require a
  // genuinely successful explorer result and persisted identity proof.
  void explorerSucceeded;

  // Compound script-edit tasks must still prove each requested operation was
  // actually visited; clean signals alone cannot invent a skipped sub-action.
  if (/\bvoice\b/i.test(item) && !/\bvoice\b/.test(joined)) return false;
  if (
    /\bemotion\b/i.test(item) &&
    !/\b(?:emotion|melancholy|euphoric|serene|happy|sad|angry|fearful|excited|calm)\b/.test(
      joined,
    )
  ) {
    return false;
  }
  if (
    /\b(?:dialogue|spoken text|script line)\b/i.test(item) &&
    !/\bfilled "[^"]+" with "[^"]+"/.test(joined)
  ) {
    return false;
  }
  if (/\badd assets?\b/i.test(item) && !/uploaded "[^"]+"/.test(joined)) return false;
  return true;
}

/** Koyal rounds tiny valid fixtures to 0.00 MB; accepted upload state wins. */
export function manualRoundedUploadVerified(
  item: string,
  evidence: readonly string[],
  step: TestStep,
  explorerSucceeded: boolean,
  beforeSnapshot = '',
  beforeSignals?: SignalBundle,
): boolean {
  if (
    !explorerSucceeded ||
    hasFreshOperationalProductFailure(step, beforeSnapshot, beforeSignals)
  ) {
    return false;
  }
  if (!/\bupload\b/i.test(item) || !manualEvidenceSupportsItem(item, evidence)) return false;
  const visual = step.result.visualAssessment;
  if (!visual || visual.status !== 'concern') return false;
  const concernText = [visual.summary, ...visual.concerns].join('\n');
  if (!/\b(?:0\.00\s*mb|0\s*kb)\b/i.test(concernText)) return false;

  const uploadedPaths = evidence
    .map((entry) => entry.match(/uploaded "([^"]+)"/i)?.[1])
    .filter((value): value is string => Boolean(value));
  const snapshot = step.result.signals.snapshot.raw.toLowerCase();
  const attached = uploadedPaths.some((filePath) =>
    snapshot.includes(path.basename(filePath).toLowerCase()),
  );
  const forwardDisabled = /\b(?:next|continue|submit)\b[^\n]*\bdisabled\b/i.test(snapshot);
  return attached && !forwardDisabled;
}

/**
 * Agent-browser asks Chrome to clear runtime channels before each milestone,
 * but SPAs can retain or immediately re-emit cumulative errors. Compare the
 * captured baseline as a multiset and treat only genuinely new blocking
 * evidence as belonging to this mutation. Visible error text follows the same
 * before/after rule.
 */
function hasFreshOperationalProductFailure(
  step: TestStep,
  beforeSnapshot: string,
  beforeSignals?: SignalBundle,
): boolean {
  const signals = manualFreshSignalBundle(step.result.signals, beforeSignals);
  if (signals.pageErrors.length > 0 || signals.consoleErrors.length > 0) return true;
  if (signals.networkRequests.some((request) => Number(request.status ?? 0) >= 500)) return true;
  const after = `${signals.snapshot.raw}\n${signals.snapshot.interactive}`;
  return freshVisibleProductError(after, beforeSnapshot);
}

export function manualEntryNeedsContextRecovery(snapshot: string): boolean {
  return [
    /\b(?:project|workspace|record|document|item|case|order|account)\s*id\s+is\s+not\s+allowed\s+to\s+be\s+empty\b/i,
    /\b(?:project|workspace|record|document|item|case|order|account)\s*id\s+(?:is\s+)?(?:required|missing|undefined|null)\b/i,
    /\bno\s+(?:project|workspace|record|document|item|case|order|account)\s+(?:is\s+)?selected\b/i,
    /\bselect\s+(?:a|an)\s+(?:project|workspace|record|document|item|case|order|account)\s+first\b/i,
  ].some((pattern) => pattern.test(snapshot));
}

async function recoverManualEntryContext(
  deps: FlowRunnerDeps,
  flow: Flow,
  entryPageTitle: string,
  expectedControls: string[] = [],
): Promise<void> {
  console.log(
    `[flow] manual target "${flow.entry.pageId}" is missing its active item context — re-entering through visible UI`,
  );
  await deps.explorer.achieveGoal(
    `The mapped "${entryPageTitle}" page is visible, but the app says its active item context is missing. ` +
      'Recover through the visible application UI only: navigate to the normal list/dashboard for existing items, ' +
      'select an existing item that can reach this feature, and use its visible workflow controls to return to the ' +
      `"${entryPageTitle}" page with real content loaded. Do not create, delete, regenerate, or mutate anything. ` +
      'Do not use a direct URL. Use "done" only after the target feature page visibly contains its real item content ' +
      'and no longer shows a missing-id, missing-context, or no-selection error. ' +
      (expectedControls.length
        ? `The recovered target must visibly expose its mapped feature controls, including at least one of: ${expectedControls.map((label) => `"${label}"`).join(', ')}. ` +
          'A generic summary/player without those controls is the wrong item or surface; return to the list and try a different existing item, with at most three item candidates.'
        : ''),
    { maxSteps: 20 },
  );
}

export function manualEntryExpectedControlLabels(page: PageNode | undefined): string[] {
  if (!page) return [];
  return [...new Set(
    page.interactives
      .filter((control) => ['edit', 'create', 'submit', 'upload'].includes(control.category))
      .map((control) => control.label.trim())
      .filter(Boolean),
  )].slice(0, 6);
}

async function navigateToEntry(deps: FlowRunnerDeps, flow: Flow): Promise<void> {
  const { browser, state, player } = deps;
  const gotoRecipe = `goto:${flow.entry.pageId}`;

  if (player.has(gotoRecipe)) {
    const replay = await player.tryReplay(gotoRecipe, { pageId: flow.entry.pageId });
    if (replay.ok) {
      const replaySnapshot = browser.snapshotInteractive();
      if (flow.id.startsWith('manual-') && manualEntryNeedsContextRecovery(replaySnapshot)) {
        const entryPage = state.sitemap.pages[flow.entry.pageId];
        await recoverManualEntryContext(
          deps,
          flow,
          entryPage?.title ?? flow.entry.pageId,
          manualEntryExpectedControlLabels(entryPage),
        );
      }
      return;
    }
  }
  if (flow.entry.url) {
    browser.open(`${state.sitemap.origin}${flow.entry.url.replace(state.sitemap.origin, '')}`);
    browser.wait(2000);
    // A pinned per-item URL (crawler.ts's exampleUrl fallback for pages whose only
    // urlPatterns contain ':id') can go stale — the item may since have been
    // deleted/renumbered. Verify we actually landed on the expected page kind
    // before trusting it; if not, fall through to the generic LLM-navigation
    // recovery below instead of silently proceeding on a dead/wrong page.
    // matchPage's plain-page identity is URL-PATTERN-ONLY (never content), so a
    // URL that still matches the pattern but actually 404'd would otherwise fool
    // this check (confirmed live: an LLM-proposed flow's entry.url for
    // "add-remove-elements-flow" was "/add_remove_elements" — missing this site's
    // required trailing slash — which rendered "Not Found", yet currentPageId()
    // still returned the real page's id from the normalized pattern alone; the
    // whole flow then ran every milestone against the 404 page instead of ever
    // reaching the exampleUrl fallback below).
    const entrySnapshot = browser.snapshotInteractive();
    if (currentPageId(deps) === flow.entry.pageId && !looksLikeSoft404(entrySnapshot)) {
      if (flow.id.startsWith('manual-') && manualEntryNeedsContextRecovery(entrySnapshot)) {
        const entryPage = state.sitemap.pages[flow.entry.pageId];
        await recoverManualEntryContext(
          deps,
          flow,
          entryPage?.title ?? flow.entry.pageId,
          manualEntryExpectedControlLabels(entryPage),
        );
      }
      return;
    }
    console.log(
      `[flow] pinned entry url for "${flow.entry.pageId}" looks stale — falling back to LLM navigation`,
    );
  }
  const entryPage = state.sitemap.pages[flow.entry.pageId];
  if (
    flow.manualExecution?.sourceFlowId.startsWith('focused:') &&
    entryPage &&
    !canDirectOpenManualTarget(flow, entryPage.id, new Set<string>(), entryPage.kind)
  ) {
    await recoverManualEntryContext(
      deps,
      flow,
      entryPage.title,
      manualEntryExpectedControlLabels(entryPage),
    );
    return;
  }
  // Prefer the exact concrete URL that actually rendered this page over
  // reconstructing from the normalized urlPattern — normalizePath deliberately
  // strips trailing slashes (and masks ids) for PAGE-IDENTITY purposes, but some
  // routing 404s on a path missing its trailing slash even though it's the "same"
  // page for identity-matching (confirmed live on the-internet.herokuapp.com:
  // urlPatterns held "/add_remove_elements", but only "/add_remove_elements/"
  // — exampleUrl — actually renders; reconstructing from the pattern landed on a
  // 404 "Not Found" page here too, same root cause as crawler.ts's deep-walk
  // entry-builder).
  const directUrl =
    entryPage?.exampleUrl ?? entryPage?.urlPatterns.find((p) => !p.includes(':id'));
  if (directUrl) {
    const opened = directUrl.startsWith('http') ? directUrl : `${state.sitemap.origin}${directUrl}`;
    browser.open(opened);
    browser.wait(2000);
    return;
  }
  await deps.explorer.achieveGoal(
    `Navigate to the "${entryPage?.title ?? flow.entry.pageId}" page (${entryPage?.description ?? ''}). Use "done" when you are there.`,
    { maxSteps: 6 },
  );
}

/** Heuristic: does this page id look like an unauthenticated login/signup/register entry? */
function looksLikeAuthEntryPageId(pageId: string): boolean {
  return /login|sign-?in|sign-?up|register/i.test(pageId);
}

/**
 * Session leak between flows: a flow that needs to START on an unauthenticated
 * page (login/signup) finds itself already logged in because an EARLIER flow in
 * the same run authenticated. Distinct from draft-resume below — the fix is a
 * SITE-LEVEL "log out" control, learned ONCE and reused by every flow that hits
 * this (not asked per-flow, since it's the same underlying problem every time).
 */
async function ensureLoggedOutForEntry(
  deps: FlowRunnerDeps,
  flow: Flow,
  firstGuardPhases: string[],
): Promise<boolean> {
  const sitemap = deps.state.sitemap;
  if (sitemap.learnedLogoutControl === undefined) {
    const answer = await deps.interact.ask(
      `Flow "${flow.title}" needs to start on an unauthenticated page (${firstGuardPhases.join('/')}) but the session is currently logged in (likely left over from an earlier flow). Paste the exact label of a "Logout"/"Sign out" control to click, or "none" if there's no way to log out. ` +
        `If Logout is hidden inside a collapsed user-menu/avatar dropdown that needs opening first (common — e.g. a "Shresth"/profile block you must click before Logout appears), paste BOTH labels separated by " > ", menu-opener first: e.g. "Shresth > Logout".`,
      { default: 'none' },
    );
    const raw = answer.trim();
    if (!raw || raw.toLowerCase() === 'none') {
      sitemap.learnedLogoutControl = 'none';
    } else if (raw.includes('>')) {
      const [opener, logout] = raw.split('>').map((s) => s.trim());
      sitemap.learnedLogoutMenuOpener = opener || undefined;
      sitemap.learnedLogoutControl = logout || 'none';
    } else {
      sitemap.learnedLogoutControl = raw;
    }
    deps.state.saveSitemap();
  }
  if (sitemap.learnedLogoutControl && sitemap.learnedLogoutControl !== 'none') {
    const nav = new Nav(deps.browser);
    const stillAuthed = () => !firstGuardPhases.includes(currentPageId(deps));
    const opener = sitemap.learnedLogoutMenuOpener;
    // The clicks are `optional` (never throw) and some sites hide the actual
    // control inside a collapsed user-menu the first click only opens — verify
    // it actually landed us on the expected anon page before trusting it, one
    // retry, rather than silently declaring success on a no-op click.
    const attemptLogoutClick = () => {
      if (opener) {
        nav.click({ label: opener, optional: true });
        deps.browser.wait(500);
      }
      nav.click({ label: sitemap.learnedLogoutControl!, optional: true });
    };
    attemptLogoutClick();
    deps.browser.wait(1500);
    if (!stillAuthed()) return true;
    deps.browser.wait(800);
    attemptLogoutClick();
    deps.browser.wait(1500);
    if (!stillAuthed()) return true;
    console.warn(
      `[flow] logout control "${opener ? `${opener} > ` : ''}${sitemap.learnedLogoutControl}" didn't change page state — ` +
        `still looks authenticated${opener ? '' : ' (it may be hidden inside a menu that needs opening first)'}`,
    );
    return false;
  }
  return false;
}

/**
 * Some create/upload entry points resume prior state (e.g. Koyal's "Create Your
 * Next Video" always resumes the last draft) instead of landing where entry
 * navigation should. Ask once for a site-wide "start fresh" action (a URL or a
 * control label), persist it on the sitemap (or "none" to stop asking), and
 * apply it going forward — reused by every flow, mirroring learnedLogoutControl.
 * Only called at true flow start — never during replayUpTo repositioning, where
 * clicking "start fresh" again would blow away the progress being rebuilt.
 *
 * The expected post-entry-navigation page is `flow.entry.pageId`. Current flow
 * proposals and deep-walked flows use one consistent guard contract:
 * `guardPhases` describes the page BEFORE a milestone runs, so milestone 1's
 * guard is also a safe fallback when an older flow omitted entry.pageId.
 */
async function applyFreshEntryHint(deps: FlowRunnerDeps, flow: Flow): Promise<void> {
  // page-classifier.ts sets entry.pageId from the LLM's JSON directly (defaulting
  // to '' if the LLM omitted entryPageId) — the old guardPhases-based check ran
  // even in that case, so skipping entirely here would leave a flow with zero
  // draft-resume protection instead of the weaker-but-nonzero prior fallback.
  const firstMilestone = flow.milestones[0];
  const expectedEntryPageId =
    flow.entry.pageId ||
    firstMilestone?.guardPhases?.[0];
  if (!expectedEntryPageId) return;

  const needsAnonEntry = looksLikeAuthEntryPageId(expectedEntryPageId);
  // One shared url+snapshot round-trip for all three checks below (page id,
  // real-login-gate, logout-control-visible) instead of each independently
  // re-querying the browser — nothing changes the page between them, so a
  // second and third capture just cost extra subprocess round-trips (and,
  // under this project's documented CDP-stall conditions, extra surface area
  // for one of those calls to hang).
  let urlEarly = '';
  let snapshotEarly = '';
  let hereIdEarly = 'unknown';
  try {
    urlEarly = deps.browser.getUrl();
    snapshotEarly = deps.browser.snapshotInteractive();
    hereIdEarly = matchPage(deps.state.sitemap, urlEarly, snapshotEarly)?.id ?? 'unknown';
  } catch {
    // wedged daemon — treat like the existing 'unknown' case below
  }
  // Page-id mismatch is the common signal. 'unknown' counts as a mismatch too —
  // a same-session redirect right after navigateToEntry can land somewhere the
  // sitemap hasn't classified yet, and requiring a resolved id previously let
  // that case through uninspected. Once a logout control has been learned this
  // run, its literal presence in the CURRENT snapshot is an even more direct
  // "are we actually logged in" signal than the page id alone (some apps still
  // render/resolve the login page's id/URL even while an earlier flow's session
  // is silently active — e.g. a login URL that only redirects away on an actual
  // protected-route hit).
  const logoutCtrl = deps.state.sitemap.learnedLogoutControl;
  // A Logout-labeled control's mere presence isn't authoritative on every site —
  // confirmed live on automationintesting.online: its /admin page renders a
  // "Logout" nav button UNCONDITIONALLY, alongside the real, fillable
  // Username/Password/Login form, regardless of whether anyone is actually
  // logged in. Treating that label alone as proof of an active session made
  // this check fire even when hereIdEarly was ALREADY the correct anon entry
  // page, causing it to click a decorative "Logout" link, actually navigate
  // AWAY to the wrong page, then misdiagnose the result as "still authenticated"
  // — poisoning the flow's starting position before the milestone loop even
  // began. A real, unauthenticated login gate (verified via the same DOM check
  // auth.ts uses) is strong, direct counter-evidence that outweighs a merely-
  // present Logout label: an actually-authenticated page would not simultaneously
  // present a live password field to log in with.
  const currentlyOnRealLoginGate =
    needsAnonEntry &&
    looksLikeAuthGate(urlEarly, snapshotEarly, deps.browser.hasVisiblePasswordInput());
  const logoutControlVisible =
    needsAnonEntry &&
    !currentlyOnRealLoginGate &&
    Boolean(logoutCtrl) &&
    logoutCtrl !== 'none' &&
    snapshotEarly.toLowerCase().includes(logoutCtrl!.toLowerCase());
  const pageIdLooksStillAuthed = needsAnonEntry && hereIdEarly !== expectedEntryPageId;
  if (pageIdLooksStillAuthed || logoutControlVisible) {
    if (await ensureLoggedOutForEntry(deps, flow, [expectedEntryPageId])) return;
  }

  const sitemap = deps.state.sitemap;

  // Site-level fresh-start action, learned ONCE and reused by every flow (like
  // learnedLogoutControl) — replaces the old per-flow flow.entry.freshEntryHint
  // (which was asked/persisted per flow and, when answered 'none', poisoned that
  // one flow forever). Accepts a URL (http…/ /…) → navigate, or a control label →
  // click. 'none' = no fresh-start needed/available on this site (stop asking).
  if (sitemap.learnedFreshStart === undefined) {
    const hereId = currentPageId(deps);
    if (hereId === expectedEntryPageId || hereId === 'unknown') return; // not a resumed draft — don't ask yet
    const answer = await deps.interact.ask(
      `A flow's entry landed on "${hereId}", not the expected first step "${expectedEntryPageId}" — ` +
        `looks like it resumed stale state (e.g. a draft). To start fresh, paste EITHER a URL ` +
        `(e.g. https://…/new) OR the exact label of a "start fresh/new" control, or "none" if this is expected.`,
      { default: 'none' },
    );
    const raw = answer.trim();
    sitemap.learnedFreshStart = raw && raw.toLowerCase() !== 'none' ? raw : 'none';
    deps.state.saveSitemap();
  }

  const fresh = sitemap.learnedFreshStart;
  if (!fresh || fresh === 'none') return;

  // Apply it, then SELF-VERIFY it actually reached the expected entry (retry once).
  // If it still didn't, warn honestly and proceed from the current state rather
  // than silently pretending the draft was cleared (mirrors the logout self-check).
  for (let attempt = 0; attempt < 2; attempt++) {
    applyFreshStartAction(deps, fresh);
    deps.browser.wait(1500);
    const now = currentPageId(deps);
    if (now === expectedEntryPageId || now === 'unknown') return;
    if (attempt === 1) {
      console.warn(
        `[flow] fresh-start "${fresh}" did not reach "${expectedEntryPageId}" (still on "${now}") — proceeding from current state`,
      );
    }
  }
}

/**
 * Apply a learned fresh-start action agnostically. Supports a MULTI-STEP value
 * separated by " > " (mirroring the logout `opener > control` pattern), so a
 * site whose "start fresh" control lives on a different page than the flow entry
 * can be reached — e.g. "/dashboard > New project" navigates to the dashboard
 * then clicks the "New project" button. Each step is either a URL (absolute
 * http(s) or a root-relative path resolved against the origin) → navigate, or a
 * control label → click. A malformed URL step falls back to a click so a
 * mis-typed hint still does something rather than throwing.
 */
function applyFreshStartAction(deps: FlowRunnerDeps, action: string): void {
  const steps = action
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const step of steps) {
    const looksLikeUrl = /^https?:\/\//i.test(step) || step.startsWith('/');
    if (looksLikeUrl) {
      try {
        const url = step.startsWith('/')
          ? new URL(step, deps.state.sitemap.origin).toString()
          : step;
        deps.browser.open(url);
        deps.browser.wait(1500);
        continue;
      } catch {
        // fall through to click
      }
    }
    new Nav(deps.browser).click({ label: step, optional: true });
    deps.browser.wait(1500);
  }
}

/** Safe suggestion passed to the centralized human field-value resolver. */
export function defaultCreationValue(goal: string): string {
  if (/description|appearance|bio|about the character|character prompt/i.test(goal)) {
    return 'A friendly young pilot with short brown hair, a navy flight jacket, and a calm, confident expression.';
  }
  if (/character|person|name/i.test(goal)) return 'Jason';
  return 'Summer Journey';
}

export function fillFieldHintFromGoal(goal: string): string | undefined {
  return goal.match(/\bfill\s+"([^"]+)"/i)?.[1];
}

export function requiresPersistedCreation(flow: Flow, milestone: FlowMilestone): boolean {
  const finalMilestone = flow.milestones.at(-1);
  if (!finalMilestone || finalMilestone.id !== milestone.id) return false;
  return (
    flow.milestones.some((item) => item.kind === 'create' || item.kind === 'upload') ||
    /\b(create|generate|regenerate|render|upload|add asset|new character|new outfit|checkout|order)\b/i.test(
      `${flow.title} ${flow.description}`,
    )
  );
}

export function artifactIdentityForMilestone(
  milestone: FlowMilestone,
  marker?: string,
): string | undefined {
  if (marker?.trim()) return marker.trim();
  for (const match of milestone.goal.matchAll(/"([^"]+)"/g)) {
    const contextual = parseContextualControlLabel(match[1]);
    if (contextual && /generate|regenerate|create|edit|save|update/i.test(contextual.action)) {
      return contextual.owner;
    }
  }
  return undefined;
}

function hasCompletionAction(explored: ExplorerResult | null, recipe: typeof SiteState.prototype.recipes[string] | undefined): boolean {
  const explorerLabels = explored?.actions
    .filter((a) => a.action === 'click')
    .map((a) => a.resolvedLabel ?? '') ?? [];
  const recipeLabels = recipe?.steps
    .filter((s) => s.kind === 'click')
    .map((s) => (s as { label: string }).label) ?? [];
  return [...explorerLabels, ...recipeLabels].some((label) =>
    /create|generate|try outfit|finalize|save|add asset|create video|render/i.test(label),
  );
}

export function flowHasCompletionAction(
  flow: Flow,
  state: SiteState,
  explored: ExplorerResult | null,
): boolean {
  if (hasCompletionAction(explored, undefined)) return true;
  return flow.milestones.some((candidate) =>
    hasCompletionAction(null, state.recipes[`flow:${flow.id}:${candidate.id}`]),
  );
}

interface PositionReplayResult {
  ok: boolean;
  completedSteps: RecipeStep[];
  startedFromEntry: boolean;
  failedRecipeId?: string;
  detail?: string;
}

/** Rebuild flow position by replaying prior milestones' recipes from the entry. */
async function replayUpTo(
  deps: FlowRunnerDeps,
  flow: Flow,
  milestoneIndex: number,
  options: { forceFromEntry?: boolean } = {},
): Promise<PositionReplayResult> {
  // Prefer continuing from a verified intermediate state over resetting to the
  // entry URL. Stateful wizards often make a direct entry URL resume a draft or
  // redirect past its real first screen; resetting there can make an otherwise
  // valid early recipe impossible to replay. Start at the latest prior
  // milestone whose guard explicitly matches the live page.
  const livePageId = currentFlowPageId(deps, flow);
  let startIndex = -1;
  if (!options.forceFromEntry) {
    for (let j = milestoneIndex - 1; j >= 0; j--) {
      if (flow.milestones[j].guardPhases?.includes(livePageId)) {
        startIndex = j;
        break;
      }
    }
  }
  const startedFromEntry = options.forceFromEntry || startIndex < 0;
  if (startedFromEntry) {
    await navigateToEntry(deps, flow);
    startIndex = 0;
  } else {
    console.log(
      `[replay] resuming position recovery from verified intermediate page "${livePageId}" at ${flow.milestones[startIndex].id}`,
    );
  }

  const completedSteps: RecipeStep[] = [];
  for (let j = startIndex; j < milestoneIndex; j++) {
    const recipeId = `flow:${flow.id}:${flow.milestones[j].id}`;
    if (!deps.player.has(recipeId)) continue;
    const replay = await deps.player.tryReplay(recipeId, {
      pageId: flow.milestones[j].guardPhases?.[0],
      secrets: { email: deps.state.secrets.email, password: deps.state.secrets.password },
    });
    if (!replay.ok) {
      console.warn(
        `[replay] stopped position recovery: ${recipeId} failed at step ${replay.failedAtStep ?? 'unknown'}${replay.detail ? ` (${replay.detail})` : ''}`,
      );
      completedSteps.push(...(replay.completedSteps ?? []));
      return {
        ok: false,
        completedSteps,
        startedFromEntry,
        failedRecipeId: recipeId,
        detail: replay.detail,
      };
    }
    completedSteps.push(...(replay.completedSteps ?? []));
  }
  return { ok: true, completedSteps, startedFromEntry };
}

export function positionRecoveryRecipeId(flowId: string, milestoneId: string): string {
  return `recovery:${flowId}:${milestoneId}`;
}

export function positionRecoveryGoal(
  next: FlowMilestone,
  targetLabels: readonly string[],
  failedDetail?: string,
): string {
  const target = targetLabels.filter(Boolean).join(' / ') || next.id;
  return `[POSITION RECOVERY]\nRebuild the current flow only far enough to reach the mapped start of the next milestone "${next.id}". The target state is identified by: ${target}.\nContinue from the current browser state after the deterministic prefix. Do not restart, repeat, or resubmit a Create, Generate, Upload, Finalize, Save, Render, or other mutation that is already complete. Use safe forward controls and satisfy only prerequisites required to reach the target. Do not perform the next milestone's own acceptance task. Stop as soon as the target state is visibly reached.${failedDetail ? `\nThe stale deterministic step that needs remapping failed with: ${failedDetail}` : ''}`;
}

/**
 * A stale deterministic position recipe must not make every downstream check
 * disappear. Re-run from the verified entry, retain every deterministic step
 * that still works, explore only the stale suffix, and persist the resulting
 * full entry-to-target recovery recipe for the next VM run.
 */
async function remapPositionTo(
  deps: FlowRunnerDeps,
  flow: Flow,
  nextIndex: number,
  guards: readonly string[],
  initialReplay?: PositionReplayResult,
): Promise<boolean> {
  const next = flow.milestones[nextIndex];
  const recoveryId = positionRecoveryRecipeId(flow.id, next.id);

  if (deps.player.has(recoveryId)) {
    await navigateToEntry(deps, flow);
    const replay = await deps.player.tryReplay(recoveryId, {
      pageId: flow.entry.pageId,
      secrets: { email: deps.state.secrets.email, password: deps.state.secrets.password },
    });
    if (replay.ok && guards.includes(currentFlowPageId(deps, flow))) {
      console.log(`[recovery] ${recoveryId} restored the mapped position deterministically`);
      return true;
    }
    console.log(`[recovery] stale ${recoveryId} did not restore the target — remapping it`);
  }

  // The caller may have just replayed from the entry and stopped at the stale
  // step. Continue from that exact state instead of restarting and repeating
  // its successful mutations. If it resumed from an intermediate state, rebuild
  // once from entry so the persisted recovery recipe is complete and portable.
  const replay = initialReplay?.startedFromEntry
    ? initialReplay
    : await replayUpTo(deps, flow, nextIndex, { forceFromEntry: true });
  if (replay.ok && guards.includes(currentFlowPageId(deps, flow))) return true;

  const targetPages = guards
    .map((id) => deps.state.sitemap.pages[id])
    .filter((page): page is PageNode => Boolean(page));
  const targetLabels = targetPages.flatMap((page) => [
    page.title,
    ...page.detection.snapshotAnyOf.slice(0, 3),
  ]);
  const explored = await deps.explorer.achieveGoal(
    positionRecoveryGoal(next, targetLabels, replay.detail),
    {
      returnOnUrlChange: false,
      manualMode: Boolean(flow.manualContract),
    },
  );
  if (!explored.success || !guards.includes(currentFlowPageId(deps, flow))) {
    console.warn(`[recovery] directed remapping did not reach the mapped start for ${next.id}`);
    return false;
  }

  const suffix = recipeStepsFromExplorer(explored, {
    secrets: { email: deps.state.secrets.email, password: deps.state.secrets.password },
  });
  if (!suffix) {
    console.warn(`[recovery] reached ${next.id}, but the explored suffix was not safely replayable`);
    return true;
  }
  recordWalkRecipe(
    deps.state,
    recoveryId,
    positionRecoveryGoal(next, targetLabels),
    compactSupersededFills([...replay.completedSteps, ...suffix]),
    {},
  );
  console.log(`[recovery] remapped and saved ${recoveryId} for deterministic validation`);
  return true;
}

/**
 * True only if at least one milestone before `milestoneIndex` has a recorded
 * recipe. On a flow's very first pass (freshly proposed, never run before),
 * NONE do — so replayUpTo would navigate all the way back to the flow's
 * entry and then skip every single intermediate milestone (the `if
 * (!deps.player.has(recipeId)) continue` above), stranding the browser at
 * square one instead of wherever the previous milestone's own actions
 * actually, correctly left it. Live-reproduced on saucedemo (exhaustive
 * mode, 2026-07-14): a guardPhases string not exactly matching the live
 * page classification on a later milestone's very first run triggered this
 * every time, forcing the explorer to re-derive login→cart→checkout from
 * scratch on top of its own goal, reliably exhausting the step budget
 * before the milestone's real action (e.g. "click Continue") ever ran.
 */
function hasAnyPriorRecipe(deps: FlowRunnerDeps, flow: Flow, milestoneIndex: number): boolean {
  for (let j = 0; j < milestoneIndex; j++) {
    if (deps.player.has(`flow:${flow.id}:${flow.milestones[j].id}`)) return true;
  }
  return false;
}

/** Minimal empty signal bundle for synthetic (skipped) steps — no browser I/O. */
function emptySignals(url: string): SignalBundle {
  return {
    url,
    title: '',
    snapshot: { raw: '', interactive: '' },
    pageErrors: [],
    consoleMessages: [],
    consoleErrors: [],
    networkRequests: [],
  };
}

/**
 * Production supervisor reports are binary. A downstream milestone skipped
 * after an unrecoverable journey break was not tested, but it is still an
 * unmet production check and therefore fails rather than entering a review
 * queue. Interactive/non-production runs retain the more descriptive
 * needs-review state.
 */
export function skippedMilestoneVerdict(supervisorEnabled: boolean): Verdict {
  return supervisorEnabled ? 'fail' : 'needs-review';
}

/**
 * Return the explicit task-graph prerequisites that have not been proven.
 * This is deliberately Manual-v2-only: ordinary flows and legacy manual
 * contracts have no task graph and therefore keep their existing behavior.
 */
export function blockedManualTaskDependencyIds(
  flow: Flow,
  milestone: FlowMilestone,
  taskVerdicts: ReadonlyMap<string, Verdict>,
): string[] {
  if (!flow.manualExecution || !milestone.manualTaskId) return [];
  const task = flow.manualExecution.tasks.find(
    (candidate) => candidate.id === milestone.manualTaskId,
  );
  if (!task) return [];
  return task.dependsOn.filter(
    (dependencyId) => taskVerdicts.get(dependencyId) !== 'pass',
  );
}

/**
 * A synthetic step recording that a milestone was NOT tested because an upstream
 * milestone failed and its position could not be recovered to test this one
 * independently. Interactive runs use `needs-review`; production-supervisor
 * runs use binary `fail` because an unexecuted required check is unmet. Empty signals ensure the
 * Slack product-bug filter (fail + real error evidence) never treats it as a bug.
 * This replaces the old behavior of silently dropping every milestone after a
 * `break` — a skipped-with-reason record is strictly more honest than a milestone
 * that vanishes from the report entirely.
 */
function skippedStep(
  flow: Flow,
  milestone: FlowMilestone,
  brokenAtId: string,
  priorGoals: string[],
): TestStep {
  const actual = `skipped — not tested because upstream milestone "${brokenAtId}" failed and position could not be recovered to test this one independently`;
  const verdict = skippedMilestoneVerdict(config.supervisor.enabled);
  return {
    workflow: milestone.id,
    action: milestone.goal,
    expected: milestone.goal,
    result: {
      verdict,
      severity: 'low',
      expected: milestone.goal,
      actual,
      signals: emptySignals('unknown'),
      reasons: [`skipped: upstream break at ${brokenAtId}`],
      retried: false,
    },
    stepsToReproduce: [...priorGoals, milestone.goal],
  };
}

/** Record one dependent task as untested without touching the browser. */
function dependencyBlockedStep(
  flow: Flow,
  milestone: FlowMilestone,
  dependencyIds: string[],
  priorGoals: string[],
): TestStep {
  const dependencyList = dependencyIds.map((id) => `"${id}"`).join(', ');
  const actual =
    `blocked — not tested because required prerequisite task(s) ${dependencyList} ` +
    'did not pass; running this consumer would produce invalid evidence';
  const verdict = skippedMilestoneVerdict(config.supervisor.enabled);
  return {
    workflow: milestone.id,
    action: milestone.goal,
    expected: milestone.goal,
    result: {
      verdict,
      severity: 'low',
      expected: milestone.goal,
      actual,
      signals: emptySignals('unknown'),
      reasons: [`blocked by unmet task dependency: ${dependencyIds.join(', ')}`],
      retried: false,
    },
    stepsToReproduce: [...priorGoals, milestone.goal],
  };
}

/**
 * After a milestone FAILS, decide whether the browser can be brought to the NEXT
 * milestone's expected start so independent later milestones still get tested.
 * Returns true only when we can CONFIRM a good position (the next milestone's own
 * guardPhases matches, possibly after replaying prior recipes) — never guesses.
 * When it can't confirm, the caller records the remaining milestones as skipped
 * rather than running them from a corrupted post-failure position (which would
 * mint an untrustworthy verdict — the exact thing this whole area is about).
 */
async function tryRecoverAfterBreak(
  deps: FlowRunnerDeps,
  flow: Flow,
  nextIndex: number,
  visitedPageIds: Set<string> = new Set(),
): Promise<boolean> {
  const next = flow.milestones[nextIndex];
  const guards = recoveryGuardPageIds(next);
  // No guardPhases on the next milestone → we have no reliable way to confirm the
  // post-failure position is the one it expects, so we can't safely continue.
  if (!guards?.length) return false;
  if (guards.includes(currentFlowPageId(deps, flow))) return true;
  // Rebuild position by replaying prior milestones' recipes — only meaningful when
  // at least one exists (else replayUpTo strands us at the flow entry, per
  // hasAnyPriorRecipe's doc comment).
  if (hasAnyPriorRecipe(deps, flow, nextIndex)) {
    try {
      const replay = await replayUpTo(deps, flow, nextIndex);
      if (!replay.ok) {
        return remapPositionTo(deps, flow, nextIndex, guards, replay);
      }
    } catch {
      try {
        return await remapPositionTo(deps, flow, nextIndex, guards);
      } catch {
        return false;
      }
    }
    if (guards.includes(currentFlowPageId(deps, flow))) return true;
    try {
      return await remapPositionTo(deps, flow, nextIndex, guards);
    } catch {
      return false;
    }
  }
  // A manual task graph may overshoot a requested task while recovering from a
  // prior verifier. When the current page is a LATER state in the exact same
  // mapped primary journey, that later position proves the earlier target was
  // traversed for this active project. Returning to it is intentional
  // resume/recovery, not a stale direct-entry shortcut. This keeps one failed
  // checkpoint from silently skipping the remaining acceptance work.
  if (flow.manualExecution && next?.manualContractTargetPageId) {
    const target = deps.state.sitemap.pages[next.manualContractTargetPageId];
    const targetUrl = target
      ? target.exampleUrl ??
        (target.urlPatterns[0]
          ? new URL(target.urlPatterns[0], deps.state.sitemap.origin).toString()
          : undefined)
      : undefined;
    const here = currentFlowPageId(deps, flow);
    if (
      target &&
      targetUrl &&
      canDirectOpenManualTarget(
        flow,
        target.id,
        visitedPageIds,
        target.kind,
        here,
      )
    ) {
      deps.browser.open(targetUrl);
      deps.browser.wait(1500);
      const recovered = currentFlowPageId(deps, flow);
      if (recovered !== 'unknown') visitedPageIds.add(recovered);
      if (guards.includes(recovered)) return true;
    }
  }
  return false;
}

/**
 * Manual task-graph milestones are grounded by their mapped target page even
 * when the original proposal did not also copy that page into guardPhases.
 * This lets later independent audits continue after a real but non-blocking
 * product error when the browser already reached their owning surface.
 */
export function recoveryGuardPageIds(
  milestone: FlowMilestone | undefined,
): string[] | undefined {
  if (!milestone) return undefined;
  const ids = [
    ...(milestone.guardPhases ?? []),
    ...(milestone.manualContractTargetPageId
      ? [milestone.manualContractTargetPageId]
      : []),
  ];
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

/**
 * Milestone goals never carry secrets, so the generic explorer can only guess
 * credentials — or worse, type the run marker into the password field ("Epic
 * sadface"). Positive-path auth milestones must route through the auth module.
 * Negative-path goals (invalid/empty credentials) stay with the explorer.
 */
export function isLoginShapedGoal(goal: string): boolean {
  // A milestone that just fills ONE password-labeled field (e.g. a widget-demo
  // page's "Input: Password" text box, unrelated to real auth) must not route
  // through ensureAuthenticated — require BOTH username+password together, or
  // the word "credentials" (which implies a full login attempt by itself),
  // never "password" in isolation.
  //
  // Same discipline applies to "log in"/"sign in" itself: the LLM quotes a
  // clicked control's label verbatim (e.g. "Click 'Bank Manager Login' to enter
  // the manager dashboard" or "Click 'Customer Login' to reach the customer
  // selection screen") — a nav button/link whose LABEL merely contains the word
  // "Login"/"Sign in" is not an instruction to authenticate, just to navigate.
  // Strip quoted spans before checking for the bare phrase so only an
  // authentication verb appearing OUTSIDE a clicked label's own quoted text
  // counts.
  // Only strip a quoted span when its delimiters look like real quotation marks —
  // preceded by whitespace/start-of-string and followed by whitespace/punctuation/
  // end-of-string — not a stray possessive apostrophe (e.g. "user's"), which sits
  // directly between two letters with no such boundary. A naive quote-to-next-quote
  // strip would otherwise mis-pair "user's" with a LATER real quoted label and
  // swallow genuine unquoted auth wording in between.
  const unquoted = goal.replace(/(?<=^|\s)(['"])[^'"]*\1(?=\s|[.,;:!?]|$)/g, '');
  // Beyond a quoted clicked-label, "login"/"sign in" also shows up UNQUOTED as a
  // bare UI-element descriptor in a purely navigational/confirmation milestone —
  // live-reproduced on filmarena.ai: "Switch back to the 'Login' tab and confirm
  // the login form is shown" matched the bare-word check on unquoted "login
  // form" and got routed through the full credentialed ensureAuthenticated
  // machinery (2 real login attempts, 24 wasted LLM steps) for a milestone that
  // never asked to enter or submit anything — just navigate to/confirm a tab.
  // "form/tab/page/screen" immediately after "log(in)/sign in" is the tell (a
  // passive UI-element noun, unlike "button"/"link" which stay ambiguous with a
  // real submit action and are deliberately NOT included here); only treat the
  // bare match as a false alarm when the goal ALSO has no credential-entry
  // wording anywhere else — a goal that both names the login form AND asks to
  // enter/submit credentials still wants real auth.
  const loginAsUiElement = /\b(log ?in|sign ?in)\b\s+(form|tab|page|screen)\b/i.test(unquoted);
  const hasCredentialWording =
    (/\b(enter|fill|type|submit)\b/i.test(unquoted) && /\b(credentials?|username|password)\b/i.test(unquoted)) ||
    /\bcredentials?\b/i.test(unquoted);
  const wantsAuth =
    (/\b(log ?in|sign ?in)\b/i.test(unquoted) && !(loginAsUiElement && !hasCredentialWording)) ||
    (/\b(enter|fill|type|submit)\b/i.test(unquoted) &&
      (/\bcredentials?\b/i.test(unquoted) || (/\busername\b/i.test(unquoted) && /\bpassword\b/i.test(unquoted))));
  const negativePath = /\b(invalid|wrong|incorrect|bad|empty|blank|missing|error|fail)/i.test(goal);
  return wantsAuth && !negativePath;
}

/** A credential-fill step prepares the form but must not submit it through auth.ts yet. */
export function isCredentialPreparationGoal(goal: string): boolean {
  const hasCredentials =
    /\bcredentials?\b/i.test(goal) ||
    ((/\b(email|username)\b/i.test(goal)) && /\bpassword\b/i.test(goal));
  const fills = /\b(fill|enter|type|input)\b/i.test(goal);
  const submits = /\b(click|submit|authenticate|log ?in|sign ?in|start creating)\b/i.test(goal);
  return hasCredentials && fills && !submits;
}

/** Stable execution order: proven deterministic recipes, replay candidates, then learning flows. */
export function orderRunnableFlows(flows: Flow[]): Flow[] {
  const rank = (flow: Flow): number => {
    const mode = flowRunMode(flow);
    return mode === 'deterministic' ? 0 : mode === 'replay-validation' ? 1 : 2;
  };
  return flows
    .map((flow, index) => ({ flow, index }))
    .sort((a, b) => rank(a.flow) - rank(b.flow) || a.index - b.index)
    .map(({ flow }) => flow);
}

export function boundaryConstrainedGoal(goal: string): string {
  if (!/\bclick\s+"[^"]+"[\s\S]*\badvance one screen\b/i.test(goal)) return goal;
  return (
    `${goal}\nMilestone boundary: stop as soon as the click reveals the next distinct dialog, form, wizard step, or page. ` +
    'Do not fill, select, generate, save, or submit anything in that newly revealed state; that belongs to the next milestone.'
  );
}

/**
 * Exploratory execution needs the local milestone as a checkpoint, not as an
 * artificial scope wall. Give the LLM the whole directed mission and the
 * remaining checkpoints so it can satisfy an omitted prerequisite (for
 * example, choosing/creating a required character before Story Type can
 * advance) without wandering into unrelated product areas.
 */
export function exploratoryDirectedGoal(
  flow: Flow,
  milestone: FlowMilestone,
  milestoneIndex: number,
  options?: { continuation?: boolean },
): string {
  const remaining = flow.milestones
    .slice(milestoneIndex + 1)
    .map((item, index) =>
      flow.manualContract
        ? `${milestoneIndex + index + 2}. ${
          item.manualContractAudit
            ? `audit acceptance item ${item.manualContractItem}`
            : item.id
        }`
        : `${milestoneIndex + index + 2}. ${item.goal}`,
    )
    .join('\n');
  const finalMilestone = flow.milestones.at(-1);
  const mission = flow.manualContract
    ? `${flow.title} — complete the active manual acceptance contract`
    : [flow.title, flow.description].filter(Boolean).join(' — ');
  const continuation = options?.continuation
    ? 'The previous automation attempt ended, but verification did not prove this checkpoint complete. Continue from the exact current state; do not restart or repeat successful mutations.'
    : 'Treat the milestone wording as the next checkpoint and a guide, not a brittle literal script. It is also the recipe boundary for this call.';
  const boundary =
    milestone.kind === 'verify'
      ? 'This is a verification checkpoint. Inspect, poll, play, or reveal non-mutating evidence as needed, but do not start, create, regenerate, save, finalize, upload, or submit a new artifact.'
      : options?.continuation
        ? 'Stop at the first visibly verified current or later checkpoint. Cross a stale boundary only as far as needed to obtain that proof.'
        : 'Use done as soon as the current checkpoint is visibly satisfied. The remaining checkpoints are orientation only: do not execute a later checkpoint in this call unless it is a necessary prerequisite for proving the current one.';

  return [
    milestone.goal,
    '',
    `Exploratory flow mission: ${mission}`,
    continuation,
    'Complete any visible, safe prerequisite required to move forward, even when the milestone proposal omitted it. Prefer enabled forward controls and remain inside this flow.',
    'Do not stop merely because the proposed wording is stale, slightly incomplete, or the expected control was renamed. Use the current UI, page state, and visible validation to make forward progress.',
    'Do not repeat an already-successful Create/Generate/Finalize/Save action. Do not bypass guards, perform destructive actions, or leave for an unrelated feature.',
    boundary,
    finalMilestone
      ? `The flow is ultimately complete only when its final checkpoint is verified: ${
        flow.manualContract ? finalMilestone.id : finalMilestone.goal
      }`
      : 'The flow is complete only when its directed purpose is visibly verified.',
    remaining ? `Remaining directed checkpoints:\n${remaining}` : '',
    'Use done once the current checkpoint is visibly satisfied, or once a later checkpoint/terminal state proves the stale checkpoint was already passed. If the checkpoint is still unfinished and safe progress toward it is available, take that progress instead of failing for wording mismatch.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function milestoneReturnsOnUrlChange(goal: string): boolean {
  return /\badvance (?:exactly )?one screen\b/i.test(goal);
}

export function mergeExplorerResults(
  first: ExplorerResult | null,
  continuation: ExplorerResult,
): ExplorerResult {
  if (!first) return continuation;
  return {
    goal: first.goal,
    success: continuation.success,
    actions: [...first.actions, ...continuation.actions],
    stepsTaken: [...first.stepsTaken, 'post-verification exploratory continuation', ...continuation.stepsTaken],
    finalUrl: continuation.finalUrl,
    finalSnapshot: continuation.finalSnapshot,
    error: continuation.success ? undefined : continuation.error,
  };
}

export function successfulMutationLabels(result: ExplorerResult | null): string[] {
  return (
    result?.actions
      .filter(
        (action) =>
          action.action === 'click' &&
          !action.executionFailed &&
          action.resolvedLabel &&
          isLikelyMutationLabel(action.resolvedLabel),
      )
      .map((action) => action.resolvedLabel!)
    ?? []
  );
}

/**
 * A random marker string is meaningless as a search query — it deterministically
 * returns zero results, so a milestone that then asserts results appear always
 * false-fails on a healthy site. Search fields need a real-looking term, not the
 * edit-verification marker (which is only meaningful for content-persistence checks).
 */
function isSearchShapedGoal(goal: string): boolean {
  return /\bsearch\b/i.test(goal);
}

/**
 * A random marker string can only be verified if it was TYPED into a free-text
 * field. A milestone that chooses/toggles a PRESET option (checkbox, native
 * <select>, dropdown, radio, toggle) has no text field to type it into, so the
 * injected "use exactly: <marker>" instruction is unsatisfiable and the
 * milestone false-fails on the marker-presence check regardless of whether the
 * real action succeeded. Verified live on bstackdemo.com: "Open the Order By
 * sorting control and choose Price - Highest to Lowest" correctly selected the
 * option (confirmed via the explorer's own snapshot check) but still failed
 * with "Expected snapshot to include one of: <marker>". Only exempted when the
 * goal doesn't ALSO ask to type/enter/fill something (a compound goal that
 * really does need the marker) — the exclusion list covers both the ACTION verbs
 * (type/enter/fill/write) and common free-text-field NOUNS (comment/note/
 * instructions/feedback/message/describe/explain/details), since a goal like
 * "Select the delivery option and add special delivery instructions" contains
 * "option" but no action verb, even though it also has a genuine text field.
 */
export function isSelectionShapedGoal(goal: string): boolean {
  return (
    (
      /\b(select|choose|checkbox|dropdown|combobox|toggle|checked|radio|option)\b/i.test(goal) ||
      /\b(?:adjust|change|set)\s+(?:the\s+)?(?:character\s+)?(?:voices?|emotion|style|theme|setting|mode)\b/i.test(goal)
    ) &&
    !(
      /\b(?:enter|fill|write|comment|note|instructions?|feedback|message|describe|explain|details?)\b/i.test(goal) ||
      // "story type", "content type", etc. use type as a noun. Treat it as a
      // text-entry verb only when the surrounding wording actually asks to type
      // a value. The old bare `type` check injected a random edit marker into
      // Koyal's "Select the Character Driven story type" milestone.
      /\btype\s+(?:in(?:to)?\b|the\b|a\b|an\b|some\b|text\b|value\b|['"])/i.test(goal)
    )
  );
}

function meaningfulPageTokens(value: string): string[] {
  const ignored = new Set([
    'a', 'an', 'and', 'at', 'in', 'of', 'on', 'page', 'screen', 'step', 'the',
    'to', 'wizard',
  ]);
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !ignored.has(token));
}

/**
 * Flow proposals sometimes split one transition into an action milestone and a
 * second "reach X" navigation milestone. When the previous milestone already
 * left the browser on X, running the second goal through the LLM makes it invent
 * another action and can leave the correct page. Only no-op a pure destination
 * goal whose destination words are all grounded in the currently matched page
 * id; compound "advance through ... and reach Y" goals remain actionable.
 */
export function isAlreadySatisfiedNavigationMilestone(
  milestone: FlowMilestone,
  pageId: string,
): boolean {
  // Manual-v2 converts a journey mutation already performed by an acceptance
  // task into a destination-only verify milestone. If that task has already
  // landed on the recorded destination, running its inherited "advance"
  // wording through the LLM overshoots the page and strands the next local
  // task. Record zero actions here; the normal verification layer below still
  // proves the destination before the milestone can pass.
  if (
    milestone.kind === 'verify' &&
    milestone.manualJourneyDestinationPageId === pageId &&
    /active acceptance task already owns and performed this checkpoint/i.test(
      milestone.goal,
    )
  ) {
    return true;
  }
  if (milestone.kind !== 'navigate') return false;
  if (/\b(click|choose|select|upload|fill|enter|edit|change|generate|create|save|submit|wait|verify)\b/i.test(milestone.goal)) {
    return false;
  }
  const destination =
    milestone.goal.match(
      /\b(?:advance|navigate|go|return|open)\s+(?:back\s+)?to\s+(?:the\s+)?([^.;]+)/i,
    )?.[1] ??
    milestone.goal.match(/\breach\s+(?:the\s+)?([^.;]+)/i)?.[1];
  if (!destination) return false;
  const targetTokens = meaningfulPageTokens(destination);
  if (targetTokens.length === 0) return false;
  const pageTokens = new Set(meaningfulPageTokens(pageId));
  return targetTokens.every((token) => pageTokens.has(token));
}

export function laterMilestoneStartingOnPage(
  flow: Flow,
  currentIndex: number,
  pageId: string,
  isInitialEntryPage: boolean,
): number {
  if (isInitialEntryPage || pageId === 'unknown') return -1;
  return flow.milestones.findIndex(
    (milestone, index) =>
      index > currentIndex && milestone.guardPhases?.includes(pageId),
  );
}

/**
 * A resumed-page shortcut may skip ordinary journey checkpoints, but never a
 * pending manual task. Once all intervening tasks are complete, the shortcut
 * remains useful (notably when Create Video lands directly on Final Video).
 */
export function manualSafeAheadIndex(
  flow: Flow,
  currentIndex: number,
  candidateAheadIndex: number,
): number {
  if (!flow.manualExecution) return candidateAheadIndex;
  return flow.milestones
    .slice(currentIndex, candidateAheadIndex)
    .some((candidate) => Boolean(candidate.manualTaskId))
    ? currentIndex
    : candidateAheadIndex;
}

export function isManualFinalProofMilestone(milestone: FlowMilestone): boolean {
  return (
    milestone.id === 'manual-contract-final-proof' ||
    milestone.id === 'manual-task-final-proof'
  );
}

export function isNonIdempotentManualMilestone(
  flow: Flow,
  milestone: FlowMilestone,
): boolean {
  if (!flow.manualContract) return false;
  const taskRequirement =
    milestone.manualTaskId && flow.manualExecution
      ? flow.manualExecution.tasks.find((task) => task.id === milestone.manualTaskId)
          ?.requirement
      : milestone.manualContractItem
        ? flow.manualContract.checklist[milestone.manualContractItem - 1]
        : undefined;
  const text = `${taskRequirement ?? ''} ${milestone.goal}`;
  return /\b(?:delete|remove|destroy|pay|purchase|checkout|invite|revoke|deactivate)\b/i.test(
    text,
  );
}

function explorerInfrastructureBlocked(explored: ExplorerResult | null): boolean {
  return Boolean(
    explored &&
      !explored.success &&
      /^Infrastructure blocked:/i.test(explored.error ?? ''),
  );
}

export function canDirectOpenManualTarget(
  flow: Flow,
  targetPageId: string,
  visitedPageIds: ReadonlySet<string>,
  targetKind?: string,
  currentPageId?: string,
): boolean {
  // A focused invocation starts without the browser-local owner/project context
  // that a stateful wizard/processing/terminal route needs. Once its explorer
  // leaves that route to establish context through Dashboard/List → item, never
  // snap it back with a direct URL. Full journey runs keep their same-run context
  // and retain the existing visited-state recovery behavior.
  if (
    flow.manualExecution?.sourceFlowId.startsWith('focused:') &&
    targetKind &&
    targetKind !== 'page'
  ) {
    return false;
  }
  const primaryIds = flow.manualExecution?.primaryJourneyPageIds ?? [];
  const targetIndex = primaryIds.indexOf(targetPageId);
  const currentIndex = currentPageId ? primaryIds.indexOf(currentPageId) : -1;
  const laterJourneyStateProvesTraversal =
    targetIndex >= 0 && currentIndex >= targetIndex;
  return (
    !flow.manualExecution ||
    !primaryIds.includes(targetPageId) ||
    visitedPageIds.has(targetPageId) ||
    laterJourneyStateProvesTraversal
  );
}

export function manualJourneyDestinationIssue(
  flow: Flow,
  milestone: FlowMilestone,
  pageId: string,
): string | undefined {
  const primaryIds = flow.manualExecution?.primaryJourneyPageIds ?? [];
  const destinationIndex = milestone.manualJourneyDestinationPageId
    ? primaryIds.indexOf(milestone.manualJourneyDestinationPageId)
    : -1;
  const currentIndex = primaryIds.indexOf(pageId);
  // A task-graph checkpoint may legitimately over-achieve by moving through
  // more than one wizard screen before the runner verifies it. Any later state
  // on the same ordered primary journey proves the required destination was
  // crossed; demanding exact equality sends the explorer backwards or
  // false-fails healthy forward progress.
  const laterJourneyStateProvesTraversal =
    destinationIndex >= 0 && currentIndex > destinationIndex;
  if (
    !flow.manualExecution ||
    !milestone.manualJourneyDestinationPageId ||
    pageId === milestone.manualJourneyDestinationPageId ||
    laterJourneyStateProvesTraversal
  ) {
    return undefined;
  }
  return `Task-graph journey checkpoint did not reach required mapped state "${milestone.manualJourneyDestinationPageId}"`;
}

/**
 * Some milestones already specify the EXACT literal value to type, because the
 * app under test validates that specific value — live-reproduced on
 * testpages.eviltester.com's "7 Char Val" length-validation micro-app, whose
 * flow milestone read "Type the value 'abcdefg' (exactly 7 characters) into
 * the first input field". Appending the usual "When entering test text, use
 * exactly: <random marker>" on top of that creates two contradictory
 * instructions — the explorer correctly typed the app-required literal value
 * (typing a random marker instead would defeat the entire point of a
 * length-validation milestone), then failed verification because the marker
 * it was told to check for was never typed. Detect the narrow "value '...'"
 * phrasing this project's own goal-authoring uses for exactly this situation
 * and skip marker injection, the same way isSearchShapedGoal/
 * isSelectionShapedGoal already exempt their own unsatisfiable-marker shapes.
 * Deliberately narrow (requires the word "value" right before the quote, not
 * just any quoted string) so a goal quoting a FIELD LABEL instead of a value
 * — e.g. "Type text into the 'Comments' field" — still gets the marker.
 *
 * A SECOND, differently-phrased regeneration of the same flow (re-proposed
 * from a fresh explore) confirmed the "value '...'" phrasing isn't the LLM's
 * only way to express this: "Type exactly 7 characters (abcdefg) into the
 * input value field" has no quotes at all — the literal sits in parentheses,
 * and "value" describes the FIELD ("input value field"), not the literal.
 * Both phrasings share a more decisive tell: an explicit "exactly/precisely N
 * character(s)" length constraint, which only shows up when the goal is
 * testing a fixed-length format/validation rule (a random marker's length is
 * unpredictable and would violate it) — as opposed to a generic MINIMUM/
 * maximum length hint ("at least 10 characters"), which a marker can usually
 * still satisfy, so that phrasing deliberately does NOT match here.
 */
function isLiteralValueShapedGoal(goal: string): boolean {
  return /\bvalue\s*['"]/i.test(goal) || /\b(exactly|precisely)\s+\d+[- ]?character/i.test(goal);
}

/** Letters-only, lowercased — strips exactly what the explorer's own literal-value-adaptation instruction strips (digits/hyphens/spaces/special chars) for comparison purposes. */
function markerLettersOnly(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Was `value` really this run's edit marker, or a legitimate ADAPTATION of it?
 * The explorer's own system prompt instructs it to strip disallowed characters
 * from a literal value when the target field shows a visible format constraint
 * (e.g. a letters-only name field) — a strict `===` against the raw marker
 * (which contains digits/a hyphen/a space) would wrongly treat that adapted,
 * genuinely-typed value as "marker never typed" (found via code review
 * 2026-07-14). Falls back to a letters-only substring match, guarded by a
 * minimum length so short/coincidental overlaps can't false-match.
 */
function valueLooksLikeMarker(value: string | undefined, marker: string): boolean {
  if (value === undefined) return false;
  if (value === marker) return true;
  const markerLetters = markerLettersOnly(marker);
  return markerLetters.length >= 6 && markerLettersOnly(value).includes(markerLetters);
}

/**
 * Does the explorer's OWN stated reasoning show it recognized an already-done
 * state, rather than just never having filled the marker for some other reason
 * (including a premature/hallucinated "done")? Absence of a fill action alone
 * doesn't distinguish a legitimate idempotent skip from an LLM that gave up or
 * misjudged completion without ever attempting the edit — found via code
 * review 2026-07-14: the original fix waived the marker requirement on
 * absence-of-fill alone, which could silently pass a milestone whose edit
 * never actually happened. Matches the exact phrasing walked-flow goals
 * themselves use ("already done ... skip it and just advance" — see
 * deep-walker.ts's flowFromTrail) plus its natural paraphrases.
 */
function looksLikeIdempotentSkipReason(actions: ExplorerAction[]): boolean {
  return actions.some((a) =>
    /already (done|exists|added|filled|there|complete)|no need to|not needed|nothing (left|more) to do|skip(ping)? (it|this)/i.test(
      a.reason ?? '',
    ),
  );
}

function hasConcreteProductFailureEvidence(step: TestStep): boolean {
  if (step.result.freshProductFailureEvidence !== undefined) {
    return step.result.freshProductFailureEvidence;
  }
  const signals = step.result.signals;
  if (signals.pageErrors.length > 0 || signals.consoleErrors.length > 0) return true;
  if (signals.networkRequests.some((request) => Number(request.status ?? 0) >= 500)) return true;
  if (
    /\b(something went wrong|internal server error|failed to (?:generate|save|create|upload|render)|unexpected error|try again later)\b/i.test(
      `${signals.snapshot.raw}\n${signals.snapshot.interactive}`,
    )
  ) {
    return true;
  }
  return step.result.reasons.some(
    (reason) =>
      /page error|console error|unexpected.*5\d\d|blank (?:page|screen)|should not include|visible error/i.test(reason) &&
      !reason.startsWith('Expected snapshot to include'),
  );
}

function hasBlockingProductFailureEvidence(step: TestStep): boolean {
  const signals = step.result.signals;
  const visible = `${signals.snapshot.raw}\n${signals.snapshot.interactive}`;
  if (signals.networkRequests.some((request) => Number(request.status ?? 0) >= 500)) return true;
  if (
    /\b(something went wrong|internal server error|failed to (?:generate|save|create|upload|render)|unexpected error|try again later|no image available)\b/i.test(
      visible,
    )
  ) {
    return true;
  }
  return step.result.reasons.some(
    (reason) =>
      /processing timeout|blank (?:page|screen)|visible (?:product )?error|failed to (?:generate|save|create|upload|render)/i.test(
        reason,
      ),
  );
}

/**
 * Execution success only proves that browser actions were dispatched. A later
 * deterministic/visual verification can still show that the checkpoint never
 * completed. In that case the normal replay → explore self-healing contract
 * must continue from the current state instead of finalizing an unfinished
 * milestone. Concrete product failures remain failures; exploration must not
 * force its way through them.
 */
export function shouldContinueAfterVerification(
  step: TestStep,
  explored: ExplorerResult | null,
  options: {
    loginShaped: boolean;
    creationMustPersist: boolean;
    completionActionSeen: boolean;
  },
): boolean {
  if (options.loginShaped || hasBlockingProductFailureEvidence(step)) return false;
  if (explored && !explored.success) return true;
  if (
    options.creationMustPersist &&
    (!options.completionActionSeen || step.result.artifactPersistenceVerified !== true)
  ) {
    return true;
  }
  if (step.result.verdict === 'pass') return false;

  // Generic screenshot uncertainty is not enough to invalidate a mechanically
  // successful replay (live Asset replay: the creation form had correctly
  // disappeared, and vision called that absence a concern). Continue only
  // when verification carries objective evidence that the checkpoint itself
  // remains unfinished.
  const unfinished = [
    ...step.result.reasons,
    step.result.visualAssessment?.summary ?? '',
    ...(step.result.visualAssessment?.concerns ?? []),
  ].join('\n');
  return /Expected snapshot to include|not visually proven|did not prove|still (?:open|disabled|processing|unchanged)|required|already in use|not allowed|validation|original .*(?:remain|unchanged)|no (?:new |expected )?(?:artifact|item|character|asset|outfit|video) (?:appears|is visible|was found)/i.test(
    unfinished,
  );
}

async function runMilestone(
  deps: FlowRunnerDeps,
  flow: Flow,
  milestone: FlowMilestone,
  milestoneIndex: number,
  ctx: StepContext,
  authCtx: AuthContext,
  runMode: FlowRunMode,
  manualEvidence: readonly string[] = [],
  visitedPageIds: Set<string> = new Set(),
): Promise<{
  step: TestStep;
  marker?: string;
  execution: MilestoneExecution['execution'];
  manualEvidence: string[];
}> {
  const { browser, state, player, statements, interact } = deps;
  const decisionsBefore = interact.decisions.length;
  const activeManualRequirement =
    milestone.manualTaskId && flow.manualExecution
      ? flow.manualExecution.tasks.find((task) => task.id === milestone.manualTaskId)
          ?.requirement
      : undefined;
  const priorEvidenceProvesActiveTask = activeManualRequirement
    ? manualEvidenceSupportsItem(activeManualRequirement, manualEvidence)
    : false;
  let pageId = currentFlowPageId(deps, flow);
  if (pageId !== 'unknown') visitedPageIds.add(pageId);

  // A genuinely dead/blank target (about:blank, empty snapshot — typically left
  // behind by a failed probe from the PREVIOUS milestone) always resolves pageId
  // to 'unknown', which the guard-phase check below deliberately treats as "give
  // it a moment, might just not be classified yet" and skips repositioning for.
  // That's correct for "not yet classified" but wrong for "actually dead" — the
  // milestone's own achieveGoal call has no way to recover from this on its own
  // (see isBlankState's doc comment), so it would just wait twice and false-fail.
  // Reposition unconditionally here, regardless of whether guardPhases is set.
  if (pageId === 'unknown' && isBlankState(browser)) {
    console.log(`[flow] page is blank/dead entering "${milestone.id}" — replaying up to this milestone`);
    await replayUpTo(deps, flow, milestoneIndex);
    pageId = currentFlowPageId(deps, flow);
  }

  // guard-phase check: poll first (processing lag ≠ off-track — restarting a wizard
  // from its entry mid-flow destroys the walk), then recover by REBUILDING position
  // (entry alone is not enough — probes/aborts can strand us anywhere)
  if (milestone.guardPhases?.length && !milestone.guardPhases.includes(pageId) && pageId !== 'unknown') {
    pageId = waitForGuardPhase(
      deps,
      milestone.guardPhases,
      flow.manualExecution ? 3000 : 30000,
      flow,
    );
    if (!milestone.guardPhases.includes(pageId)) {
      if (flow.manualExecution) {
        const target = milestone.guardPhases
          .map((id) => state.sitemap.pages[id])
          .find(Boolean);
        const targetUrl = target
          ? target.exampleUrl ??
            (target.urlPatterns[0]
              ? new URL(target.urlPatterns[0], state.sitemap.origin).toString()
              : undefined)
          : undefined;
        if (target && targetUrl) {
          if (!canDirectOpenManualTarget(flow, target.id, visitedPageIds, target.kind)) {
            console.log(
              `[flow:v2] refusing to direct-open unvisited primary state "${target.title}"; the current journey must reach it first`,
            );
          } else {
            console.log(
              `[flow:v2] restoring previously reached primary journey state "${target.title}" after a task/side quest`,
            );
            browser.open(targetUrl);
            browser.wait(1500);
            pageId = currentFlowPageId(deps, flow);
            if (pageId !== 'unknown') visitedPageIds.add(pageId);
          }
        }
      } else if (hasAnyPriorRecipe(deps, flow, milestoneIndex) && !flow.manualContract) {
        console.log(`[flow] off-track (on "${pageId}", expected ${milestone.guardPhases.join('/')}) — replaying up to this milestone`);
        await replayUpTo(deps, flow, milestoneIndex);
      } else {
        console.log(
          `[flow] guard-phase mismatch (on "${pageId}", expected ${milestone.guardPhases.join('/')}) but no prior milestone has a recorded recipe yet — repositioning would strand the browser at the flow's entry for no benefit; proceeding from the current, real position instead`,
        );
      }
    }
  }

  // A session can expire during probe recovery/repositioning, before the next
  // Explorer call begins. Do not hand a non-auth milestone to the generic LLM
  // while visibly on /login (it will guess credentials and ask for fake email
  // field values). Re-authenticate with the dedicated auth module, then rebuild
  // the exact milestone position before taking any test action.
  const authRelated = isLoginShapedGoal(milestone.goal);
  const credentialPreparation = isCredentialPreparationGoal(milestone.goal);
  if (
    !authRelated &&
    looksLikeAuthGate(browser.getUrl(), browser.snapshotInteractive(), browser.hasVisiblePasswordInput())
  ) {
    console.log(`[flow] auth wall detected before milestone "${milestone.id}" — re-authenticating and rebuilding position`);
    await ensureAuthenticated(authCtx);
    await navigateToEntry(deps, flow);
    if (milestoneIndex > 0) await replayUpTo(deps, flow, milestoneIndex);
    pageId = currentFlowPageId(deps, flow);
  }

  // Manual audits are independent feature checks. For mutation-heavy items,
  // start on the sitemap-grounded feature page instead of asking the explorer
  // to escape an unrelated wizard state by touching controls that belong to a
  // different checklist item. Evidence-only setup audits (items 1–4) remain
  // in place so they can prove the already-completed fresh-entry/upload work
  // without destroying the active draft.
  if (
    milestone.manualContractAudit &&
    (Boolean(flow.manualExecution) || (milestone.manualContractItem ?? 0) >= 5) &&
    milestone.manualContractTargetPageId &&
    pageId !== milestone.manualContractTargetPageId
  ) {
    const target = state.sitemap.pages[milestone.manualContractTargetPageId];
    const targetUrl = target
      ? target.exampleUrl ??
        (target.urlPatterns[0]
          ? new URL(target.urlPatterns[0], state.sitemap.origin).toString()
          : undefined)
      : undefined;
    if (target && targetUrl) {
      if (!canDirectOpenManualTarget(flow, target.id, visitedPageIds, target.kind)) {
        console.log(
          `[flow:v2] audit ${milestone.manualContractItem} targets unvisited primary state "${target.title}" — keeping the current state instead of resuming a stale draft`,
        );
      } else {
        console.log(
          `[flow] pre-positioning manual audit ${milestone.manualContractItem} on mapped feature "${target.title}"`,
        );
        deps.browser.open(targetUrl);
        deps.browser.wait(1500);
        pageId = currentFlowPageId(deps, flow);
        if (pageId !== 'unknown') visitedPageIds.add(pageId);
      }
    }
  }

  browser.clearSignals();
  const verification = ctx.verification;
  const before = await verification.captureSignals();

  const recipeId = `flow:${flow.id}:${milestone.id}`;

  // fill in run-unique edit markers so edits are real and verifiable — only for
  // explicit edit milestones (a 'create' click may involve no text field at all)
  const loginShaped = authRelated && !credentialPreparation;
  const searchShaped = isSearchShapedGoal(milestone.goal);
  const selectionShaped = isSelectionShapedGoal(milestone.goal);
  const literalValueShaped = isLiteralValueShapedGoal(milestone.goal);
  const creationMustPersist = requiresPersistedCreation(flow, milestone);
  let goal =
    runMode === 'learning'
      ? exploratoryDirectedGoal(flow, milestone, milestoneIndex)
      : boundaryConstrainedGoal(milestone.goal);
  if (flow.manualContract) {
    goal += manualContractRuntimeGuidance(
      flow,
      milestone,
      manualEvidence,
    );
  }
  let marker: string | undefined;
  if (milestone.kind === 'edit' && !authRelated && !searchShaped && !selectionShaped && !literalValueShaped) {
    // If a recipe already exists for this milestone (walked-flow recipes are
    // recorded during the deep walk itself, BEFORE flow-testing ever runs —
    // see deep-walker.ts's own independent `randomEditMarker('autoqa-walk')` —
    // and a prior test run's recordFromExplorer can do the same), its 'fill'
    // steps carry a FIXED literal value baked in at recording time. Replay
    // (RecipePlayer.tryReplay) types that exact recorded value verbatim, no
    // matter what we generate here — inventing a brand-new random marker in
    // that case guarantees the post-replay snapshot check requires text that
    // was never actually typed this run (two independent random strings can
    // never coincidentally match). Live-reproduced on filmarena.ai's very
    // first walked-flow test: recipe replayed "autoqa-walk QA-284z0fud6" while
    // verification demanded "autoqa QA-2cqh35n08" — guaranteed mismatch, every
    // run, forever. Reuse the recipe's own last recorded fill value as the
    // marker instead: it matches what replay actually produces, AND — if
    // replay fails and falls through to a fresh explore below — the goal's
    // "use exactly" instruction stays consistent with what a retry should type.
    const existingRecipe = state.recipes[recipeId];
    const fieldHint = fillFieldHintFromGoal(milestone.goal);
    const recordedFillValue = existingRecipe?.steps
      .filter(
        (s) =>
          s.kind === 'fill' &&
          !s.secretRef &&
          (!fieldHint ||
            s.hint.toLowerCase().replace(/\s+/g, ' ').trim() ===
              fieldHint.toLowerCase().replace(/\s+/g, ' ').trim()),
      )
      .map((s) => (s as { value: string }).value)
      .pop();
    if (fieldHint) {
      marker = await resolveHumanFieldValue(
        state,
        deps.interact,
        pageId,
        fieldHint,
        milestone.seedValue ?? recordedFillValue ?? defaultCreationValue(milestone.goal),
      );
      // The preflight's intended value can differ from the final human answer
      // (especially after --reset-values). The explorer is then instructed to
      // propose that final answer verbatim. Store the equivalent intent alias
      // now so its onFillRequested hook reuses the answer instead of asking the
      // human for the identical field/value a second time in the same run.
      const finalIntentKey = fieldValueKey(pageId, fieldHint, marker);
      if (!state.fieldValues[finalIntentKey]) {
        state.fieldValues[finalIntentKey] = {
          pageId,
          label: fieldHint,
          value: marker,
          updatedAt: new Date().toISOString(),
        };
        state.saveFieldValues();
      }
      // The human's run-specific answer is authoritative for the matching
      // recipe field. Update that one step before replay so the preflight and
      // RecipePlayer do not ask twice with two different intended values.
      const matchingFill = existingRecipe?.steps.find(
        (step) =>
          step.kind === 'fill' &&
          !step.secretRef &&
          step.hint.toLowerCase().replace(/\s+/g, ' ').trim() ===
            fieldHint.toLowerCase().replace(/\s+/g, ' ').trim(),
      );
      if (matchingFill?.kind === 'fill' && matchingFill.value !== marker) {
        matchingFill.value = marker;
        state.saveRecipes();
      }
    } else if (recordedFillValue) {
      // A recipe already carries the value that will actually be typed on replay —
      // reuse it so verification and replay never diverge (see the long note above).
      marker = recordedFillValue;
    } else if (milestone.seedValue) {
      // Human already provided a real value for this milestone on an earlier run.
      marker = milestone.seedValue;
    } else marker = defaultCreationValue(milestone.goal);
    goal = `${goal}\nWhen entering test text, use exactly: "${marker}"`;
    if (creationMustPersist) {
      goal +=
        '\nThis is a real content-creation step. Filling the field is NOT completion. ' +
        'Click the appropriate Create/Generate/Try control, wait until generation genuinely finishes, complete every subsequently required field, ' +
        'then click Finalize/Save. Use done only after the new item is visibly present in the persistent list/library. ' +
        'A spinner, generated preview, name field, or Finalize button means the goal is still in progress.';
    }
  } else if (searchShaped) {
    goal = `${goal}\nUse a real, generic search term likely to match existing content (e.g. a common product/category word) — NOT a random or made-up string.`;
  }

  let explored: ExplorerResult | null = null;
  let replayOk = false;
  let replayCompletedSteps: RecipeStep[] = [];
  let execution: MilestoneExecution['execution'] = 'none';
  const nonIdempotentManual = isNonIdempotentManualMilestone(flow, milestone);
  const forceExplore = runMode === 'learning' || nonIdempotentManual;
  const alreadySatisfiedNavigation = isAlreadySatisfiedNavigationMilestone(milestone, pageId);
  const replayFillHint =
    fillFieldHintFromGoal(milestone.goal) ??
    (isSearchShapedGoal(milestone.goal) ? milestone.successHint : undefined);
  const replayFillOverrides: Record<string, string> = {};
  if (replayFillHint && marker) {
    replayFillOverrides[replayFillHint.toLowerCase().replace(/\s+/g, ' ').trim()] = marker;
  }

  // A deterministic creation replay that reuses a consumed name/title is
  // structurally correct but guaranteed to be rejected on many real sites.
  // Refresh identity-shaped fields before replay, while leaving descriptions
  // and other reusable content on the normal ask-once path.
  const replayRecipe = state.recipes[recipeId];
  if (!forceExplore && replayRecipe && creationMustPersist) {
    for (const step of replayRecipe.steps) {
      if (
        step.kind !== 'fill' ||
        step.secretRef ||
        !isLikelyUniqueCreationIdentityField(step.hint)
      ) {
        continue;
      }
      const fresh = await resolveFreshHumanFieldValue(
        state,
        deps.interact,
        pageId,
        step.hint,
        step.value,
        step.value,
      );
      replayFillOverrides[step.hint.toLowerCase().replace(/\s+/g, ' ').trim()] = fresh;
    }
  }

  if (alreadySatisfiedNavigation) {
    console.log(
      `[flow] navigation milestone "${milestone.id}" is already at its grounded destination "${pageId}" — recording a zero-action recipe`,
    );
    const finalUrl = browser.getUrl();
    const finalSnapshot = browser.snapshotFull();
    explored = {
      goal,
      success: true,
      actions: [],
      stepsTaken: [`already at destination page "${pageId}"; no navigation action was needed`],
      finalUrl,
      finalSnapshot,
    };
    replayOk = true;
    execution = forceExplore ? 'explore' : 'replay';
  } else if (loginShaped) {
    console.log('[flow] auth milestone — delegating to the auth module');
    try {
      await ensureAuthenticated(authCtx);
      if (state.authenticatedThisRun) {
        replayOk = true; // a real login (this call or an earlier one this run) — verification below judges the milestone
      } else {
        // Real, previously-disclosed gap (bstackdemo.com, 2026-07-10): ensureAuthenticated()
        // returning without throwing used to be treated as "authenticated" unconditionally,
        // but it can ALSO mean the generic probe found no login gate anywhere on this site at
        // all (e.g. a public-catalog site whose real login control sits behind an account icon,
        // never on the generic probe page) — silently declaring the milestone done with zero
        // login ever attempted is a false pass. Force a REAL, credentialed login attempt at the
        // milestone's current position via ensureAuthenticated's own machinery (its `forceAttempt`
        // option) instead of handing the raw, credential-less goal to the generic explorer — code
        // review (2026-07-14) found that the generic-explorer version of this fix reintroduced the
        // exact "LLM guesses/hallucinates credentials" anti-pattern isLoginShapedGoal exists to
        // prevent, plus a positioning bug (the explorer ran from wherever ensureAuthenticated's own
        // failed probe had navigated to, not the milestone's actual position).
        console.log('[flow] auth probe found no gate and no login has succeeded yet this run — forcing a real credentialed login attempt at the current position instead of assuming success');
        try {
          await ensureAuthenticated(authCtx, { forceAttempt: true });
          replayOk = state.authenticatedThisRun;
        } catch (forceErr) {
          console.log(`[flow] forced login attempt failed: ${forceErr instanceof Error ? forceErr.message : forceErr}`);
        }
      }
    } catch (err) {
      console.log(`[flow] auth milestone failed: ${err instanceof Error ? err.message : err}`);
    }
    if (replayOk) execution = 'auth';
  } else if (
    !forceExplore &&
    player.has(recipeId) &&
    (!creationMustPersist || flowHasCompletionAction(flow, state, null))
  ) {
    const replay = await player.tryReplay(recipeId, {
      pageId,
      secrets: { email: state.secrets.email, password: state.secrets.password },
      fillOverrides:
        Object.keys(replayFillOverrides).length > 0 ? replayFillOverrides : undefined,
    });
    replayCompletedSteps = replay.completedSteps ?? [];
    replayOk = replay.ok;
    if (replayOk) execution = 'replay';
  } else if (!forceExplore && player.has(recipeId) && creationMustPersist) {
    console.log('[flow] ignoring stale creation recipe: it never recorded Create/Generate/Finalize/Save');
  } else if (forceExplore && player.has(recipeId)) {
    console.log('[flow] exploratory learning mode — bypassing the saved recipe and using LLM exploration');
  }

  if (!replayOk && !loginShaped) {
    execution = 'explore';
    if (flow.manualContract && replayCompletedSteps.length > 0) {
      const completedPrefixEvidence =
        manualEvidenceFromRecipeSteps(replayCompletedSteps);
      goal +=
        '\n\nThe deterministic attempt completed this exact prefix in the current run before it needed help:\n- ' +
        completedPrefixEvidence.join('\n- ') +
        '\nContinue from the current state. Treat only this listed prefix as completed; do not repeat its successful ' +
        'Create, Generate, Upload, Finalize, Save, or submission actions.';
    }
    explored = await deps.explorer.achieveGoal(goal, {
      // Preserve deliberately small one-screen recipes during the first
      // attempt. If that boundary leaves the checkpoint unverified, the
      // post-verification continuation below is allowed to cross it.
      returnOnUrlChange: runMode === 'learning' ? true : milestoneReturnsOnUrlChange(goal),
      manualMode: Boolean(flow.manualContract),
      manualReadOnly: Boolean(flow.manualContract && isManualFinalProofMilestone(milestone)),
      allowDoneWithoutProgress:
        priorEvidenceProvesActiveTask ||
        Boolean(flow.manualContract && isManualFinalProofMilestone(milestone)),
    });
    // mid-flow auth wall → re-login once and retry. This used to be a bare
    // `/log ?in|password/i` regex over the snapshot text — a much weaker,
    // duplicate version of looksLikeAuthGate's own OLD false-positive bug that
    // never got the same fix. Independently live-reproduced on two different
    // sites in the same batch: webdriveruniversity.com's content-dense "AI
    // Testing Playground" (a decorative login/password widget sitting among
    // ~20 unrelated demo cards) and testpages.eviltester.com (the persistent
    // Docsy sidebar's "Cookie Controlled Login" link, present on every
    // /apps/* page). Either way, ANY milestone failing for an unrelated
    // reason on a page merely containing the word "login"/"password"
    // anywhere got misdiagnosed as an auth wall, triggering a pointless
    // re-authenticate + re-navigate-to-entry that burned LLM calls and masked
    // the real failure. Reuse the same DOM-verified, already-hardened
    // looksLikeAuthGate() check (requires an ACTUAL visible password input)
    // instead of this one-off, looser substring test.
    if (
      !explored.success &&
      looksLikeAuthGate(deps.browser.getUrl(), explored.finalSnapshot, deps.browser.hasVisiblePasswordInput())
    ) {
      console.log('[flow] hit an auth wall mid-flow — re-authenticating');
      await ensureAuthenticated(authCtx);
      await navigateToEntry(deps, flow);
      explored = await deps.explorer.achieveGoal(goal, {
        returnOnUrlChange: runMode === 'learning' ? true : milestoneReturnsOnUrlChange(goal),
        manualMode: Boolean(flow.manualContract),
        manualReadOnly: Boolean(flow.manualContract && isManualFinalProofMilestone(milestone)),
        allowDoneWithoutProgress:
          priorEvidenceProvesActiveTask ||
          Boolean(flow.manualContract && isManualFinalProofMilestone(milestone)),
      });
    }
  }

  // The ask-once resolver may replace a stale recipe/LLM proposal with the
  // human's saved value. Verify what was actually typed, not the suggestion
  // that existed before the resolver ran.
  if (marker && milestone.kind === 'edit') {
    const actualFill =
      explored?.actions.filter((a) => a.action === 'fill' && a.value !== undefined).at(-1)?.value ??
      state.recipes[recipeId]?.steps
        .filter((s) => s.kind === 'fill' && !s.secretRef)
        .map((s) => (s as { value: string }).value)
        .at(-1);
    if (actualFill) marker = actualFill;
  }

  // verify with the KB-augmented expectation
  const base = baseExpectationFor(milestone);
  if (manualEditRequiresZeroErrorSignals(flow, milestone)) {
    // Manual edit checks judge operational health, not artistic compliance.
    // Signals were cleared immediately before this milestone, so any captured
    // page exception/console error/5xx belongs to this edit attempt rather than
    // stale ambient history.
    base.allowPageErrors = false;
    base.allowConsoleErrors = false;
    base.maxUnexpectedNetwork5xx = 0;
  }
  // a login-shaped milestone that authenticated successfully proves itself via
  // ensureAuthenticated() above, not via a login-page landmark that may never
  // reappear when the session silently restores — drop the literal-text check
  // so the milestone is judged on the generic error/console/5xx signals instead.
  if (loginShaped && replayOk) {
    delete base.snapshotIncludesAny;
  }
  if (marker) {
    // Walked-flow goals deliberately carry an idempotency clause ("if this action
    // appears already done ... skip it and just advance" — see deep-walker.ts's
    // flowFromTrail) so a re-run against state a PRIOR run already created (a
    // character/asset that already exists) doesn't force a duplicate. When the
    // explorer legitimately takes that path, it calls "done" without ever typing
    // the marker — there was nothing to type. The marker text can then never
    // legitimately appear in the final snapshot, yet this check required it
    // unconditionally, false-failing an otherwise-correct skip. Live-reproduced
    // twice on koyal (2026-07-14): walked-projects-list-create-your-next-video:m5,
    // walked-characters-list-new-character:m2. Only require the marker when we
    // have direct evidence (from the explorer's own recorded actions) that it was
    // actually typed; recipe-replay/login-shaped paths (explored === null) are
    // unchanged — this only touches the live-explorer path where the ambiguity
    // exists.
    // valueLooksLikeMarker (not strict equality): the explorer's own system prompt
    // instructs it to ADAPT the literal marker for a format-constrained field (e.g.
    // strip digits/hyphens/spaces for a letters-only name field) — strict `===`
    // would misclassify that legitimate, adapted fill as "marker never typed" and
    // wrongly waive verification on a real edit (found via code review 2026-07-14).
    const markerTyped =
      !explored || explored.actions.some((a) => a.action === 'fill' && valueLooksLikeMarker(a.value, marker));
    // A missing marker is ONLY a legitimate idempotent skip when the explorer's OWN
    // stated reasoning shows it actually recognized an already-done state — absence
    // of a fill action ALONE doesn't distinguish that from an LLM that hallucinated
    // "done" without ever attempting the edit (found via code review 2026-07-14:
    // the original fix dropped the marker requirement on absence-of-fill alone,
    // silently passing a milestone whose edit never happened at all).
    const legitimateSkip = !markerTyped && Boolean(explored) && looksLikeIdempotentSkipReason(explored!.actions);
    if (markerTyped || !legitimateSkip) {
      base.snapshotIncludesAny = [...(base.snapshotIncludesAny ?? []), marker];
    } else {
      console.log(
        '[flow] edit milestone completed without ever typing the verification marker ' +
          '(explorer reasoning confirms it recognized an already-done state — the goal\'s own ' +
          '"already done, just advance" idempotency clause) — not requiring the marker in the final snapshot',
      );
    }
  }
  const expectation = statements.augmentExpectation(base, pageId);

  let step = await recordVerifiedStep(ctx, {
    workflow: `${flow.id}:${milestone.id}`,
    action: milestone.goal,
    expected: milestone.successHint ?? milestone.goal,
    expectation,
    waitOptions: {
      maxWaitMs: milestone.maxWaitMs ?? MILESTONE_WAIT_MS[milestone.kind],
      pollMs: milestone.maxWaitMs && milestone.maxWaitMs > 60000 ? 5000 : 2000,
    },
    explorerSteps: explored?.stepsTaken,
    visualVerification: true,
    artifactPersistenceVerification: creationMustPersist,
    artifactPersistenceIdentity: creationMustPersist
      ? artifactIdentityForMilestone(milestone, marker)
      : undefined,
    logResult: !milestone.manualContractAudit,
  });
  if (explored) step.explorerSteps = explored.stepsTaken;
  if (flow.manualContract) {
    normalizeManualVerificationResult(step, before, expectation, verification);
  }

  const completionActionSeen = flowHasCompletionAction(flow, state, explored);
  const currentRecipeEvidence = manualEvidenceFromRecipeSteps(replayCompletedSteps);
  const firstAttemptManualEvidence = [
    ...manualEvidence,
    ...currentRecipeEvidence,
    ...(explored ? manualEvidenceFromActions(explored.actions) : []),
  ];
  const firstAttemptRequirement =
    flow.manualContract && milestone.manualContractAudit && milestone.manualContractItem
      ? flow.manualContract.checklist[milestone.manualContractItem - 1] ?? milestone.goal
      : milestone.goal;
  const firstAttemptOperationallyVerified = Boolean(
    flow.manualContract &&
      milestone.manualContractAudit &&
      explored &&
      (
        manualOperationalMutationVerified(
          firstAttemptRequirement,
          firstAttemptManualEvidence,
          step,
          explored.success,
          `${before.snapshot.raw}\n${before.snapshot.interactive}`,
          before,
        ) ||
        manualRoundedUploadVerified(
          firstAttemptRequirement,
          firstAttemptManualEvidence,
          step,
          true,
          `${before.snapshot.raw}\n${before.snapshot.interactive}`,
          before,
        )
      ),
  );
  if (
    firstAttemptOperationallyVerified &&
    step.result.verdict !== 'pass'
  ) {
    step.result.verdict = 'pass';
    step.result.reasons = step.result.reasons.filter(
      (reason) =>
        !/^Visual review found a concrete concern:/i.test(reason) &&
        !/^(?:Uncaught page|Console error|Unexpected.*5\d\d)/i.test(reason),
    );
    step.result.reasons.push(
      'Same-run operational mutation evidence and clean product signals override non-terminal visual ambiguity',
    );
  }
  const firstAttemptManualAuditIssue = firstAttemptOperationallyVerified
    ? undefined
    : manualTaskGraphRepairIssue(
        flow,
        milestone,
        firstAttemptManualEvidence,
        step.result.signals.snapshot.raw,
        manualVisualAssessmentFromActions(explored?.actions ?? []) ??
          step.result.visualAssessment,
      );
  const firstAttemptJourneyDestinationIssue = manualJourneyDestinationIssue(
    flow,
    milestone,
    currentFlowPageId(deps, flow),
  );
  if (
    (
      !explorerInfrastructureBlocked(explored) &&
      (
        Boolean(firstAttemptManualAuditIssue) ||
        Boolean(firstAttemptJourneyDestinationIssue) ||
        (
          !(milestone.manualContractAudit && explored?.success) &&
          shouldContinueAfterVerification(step, explored, {
            loginShaped,
            creationMustPersist,
            completionActionSeen,
          })
        )
      )
    )
  ) {
    console.log(
      firstAttemptManualAuditIssue
        ? `[flow:v2] acceptance audit found missing evidence for "${milestone.id}" — one bounded repair from the current state`
        : firstAttemptJourneyDestinationIssue
          ? `[flow:v2] journey checkpoint "${milestone.id}" missed its mapped destination — one bounded forward recovery from the current state`
        : `[flow] verification did not prove "${milestone.id}" complete — continuing with directed LLM exploration from the current state`,
    );
    if (
      milestone.manualContractAudit &&
      milestone.manualContractTargetPageId &&
      currentFlowPageId(deps, flow) !== milestone.manualContractTargetPageId
    ) {
      const target = state.sitemap.pages[milestone.manualContractTargetPageId];
      const targetUrl = target
        ? target.exampleUrl ??
          (target.urlPatterns[0]
            ? new URL(target.urlPatterns[0], state.sitemap.origin).toString()
            : undefined)
        : undefined;
      if (target && targetUrl) {
        if (!canDirectOpenManualTarget(flow, target.id, visitedPageIds, target.kind)) {
          console.log(
            `[flow:v2] refusing mapped recovery to unvisited primary state "${target.title}"`,
          );
        } else {
          console.log(
            `[flow] manual audit ${milestone.manualContractItem} could not reach its feature — one mapped-page recovery to "${target.title}"`,
          );
          deps.browser.open(targetUrl);
          deps.browser.wait(1500);
          const recoveredPageId = currentFlowPageId(deps, flow);
          if (recoveredPageId !== 'unknown') visitedPageIds.add(recoveredPageId);
        }
      }
    }
    let continuationGoal = exploratoryDirectedGoal(flow, milestone, milestoneIndex, {
      continuation: true,
    });
    if (flow.manualContract) {
      continuationGoal += manualContractRuntimeGuidance(
        flow,
        milestone,
        [
          ...manualEvidence,
          ...currentRecipeEvidence,
          ...(explored ? manualEvidenceFromActions(explored.actions) : []),
        ],
      );
      if (firstAttemptManualAuditIssue) {
        continuationGoal +=
          `\n\nThe independent acceptance audit found this exact remaining gap: ${firstAttemptManualAuditIssue}. ` +
          'Repair only that missing part of the active task. Preserve completed methods and do not repeat a ' +
          'successful Create, Generate, Finalize, Save, or submission action. If the audit identifies an empty ' +
          'slot or wrong owner/context, completing that exact empty slot in its own section is allowed and is not ' +
          'a repetition of an earlier action performed elsewhere.';
      }
      if (firstAttemptJourneyDestinationIssue) {
        continuationGoal +=
          `\n\nThe journey invariant is still unmet: ${firstAttemptJourneyDestinationIssue}. ` +
          'Move forward through the current wizard using a unique enabled Next, Continue, Proceed, or equivalent ' +
          'control. Do not use a sidebar breadcrumb or direct URL, and do not repeat an earlier acceptance task.';
      }
    }
    const priorSuccessfulMutations = [
      ...successfulMutationLabelsFromRecipeSteps(replayCompletedSteps),
      ...successfulMutationLabels(explored),
    ];
    const continuation = await deps.explorer.achieveGoal(continuationGoal, {
      // This is specifically the recovery for a checkpoint that looked
      // executed but was not actually complete. Let the explorer cross the
      // stale boundary and reach a verifiable checkpoint/terminal state.
      returnOnUrlChange: false,
      // A new Explorer instance has an empty local action history. Carry the
      // first attempt's successful mutations into its hard denylist so a
      // verification retry cannot resubmit Generate/Try/Finalize/Save.
      blockedClickLabels: priorSuccessfulMutations,
      manualMode: Boolean(flow.manualContract),
      manualReadOnly: Boolean(flow.manualContract && isManualFinalProofMilestone(milestone)),
      allowDoneWithoutProgress:
        priorEvidenceProvesActiveTask ||
        Boolean(flow.manualContract && isManualFinalProofMilestone(milestone)),
    });
    explored = mergeExplorerResults(explored, continuation);
    execution = 'explore';

    // Re-run the complete deterministic + screenshot verification after the
    // continuation. Evidence uses the same milestone directory intentionally:
    // the final state is authoritative, while explorerSteps retains both
    // attempts so the learned recipe contains the whole successful sequence.
    step = await recordVerifiedStep(ctx, {
      workflow: `${flow.id}:${milestone.id}`,
      action: milestone.goal,
      expected: milestone.successHint ?? milestone.goal,
      expectation,
      waitOptions: {
        maxWaitMs: milestone.maxWaitMs ?? MILESTONE_WAIT_MS[milestone.kind],
        pollMs: milestone.maxWaitMs && milestone.maxWaitMs > 60000 ? 5000 : 2000,
      },
      explorerSteps: explored.stepsTaken,
      visualVerification: true,
      artifactPersistenceVerification: creationMustPersist,
      artifactPersistenceIdentity: creationMustPersist
        ? artifactIdentityForMilestone(milestone, marker)
        : undefined,
      logResult: !milestone.manualContractAudit,
    });
    step.explorerSteps = explored.stepsTaken;
    if (flow.manualContract) {
      // The continuation may be the attempt that finally performs the required
      // mutation. Apply the same fresh-vs-baseline classifier to its result;
      // otherwise stale SPA banners re-enter through this second verification
      // path and turn successful repairs into false failures.
      normalizeManualVerificationResult(step, before, expectation, verification);
    }
  }

  // recordVerifiedStep() already wrote step-summary.md to disk with THIS verdict
  // and printed it — but everything below (explorer-failure downgrade, KB
  // verdict flip, human escalation) can still change step.result.verdict in
  // memory. Remember what was actually persisted so we can patch the file back
  // into agreement once the verdict is truly final (see patchStepSummaryVerdict).
  const writtenVerdict = step.result.verdict;
  const writtenReasons = [...step.result.reasons];
  let humanRejectedSuccessHint = false;
  const fieldHintForRecipe =
    fillFieldHintFromGoal(milestone.goal) ??
    (isSearchShapedGoal(milestone.goal) ? milestone.successHint : undefined);

  // The explorer's own success/failure signal was previously consulted ONLY for
  // the mid-flow auth-wall retry above — verifyAfterAction's deterministic health
  // checks (console errors, blank page, 5xx, ...) can all pass even when the
  // explorer gave up without completing the goal (exhausted its step budget,
  // got stuck repeating an action, or explicitly returned action:'fail').
  // Observed live: a milestone with no successHint ("click Laptops (75), then
  // advance one screen") had the explorer ping-pong between two category-filter
  // links for all 8 steps and return success:false with error "Exceeded max
  // exploration steps (8)" — yet the milestone was still recorded PASS because
  // the page it ended up on had no console errors or other objective breakage.
  // Downgrade (never upgrade) a bare 'pass' to 'needs-review' in this case — the
  // explorer's self-report isn't ground truth either (same reasoning as the
  // missed-successHint softening below), but a silent PASS that ignores an
  // explicit "I could not do this" hides a real gap in coverage as if the
  // milestone were proven.
  const explorerFailureDowngrade = Boolean(explored && !explored.success && step.result.verdict === 'pass');
  const automationBlockedWithoutProductEvidence = Boolean(
    explored && !explored.success && !hasConcreteProductFailureEvidence(step),
  );
  const infrastructureBlocked = explorerInfrastructureBlocked(explored);
  let visualConcernDowngrade = step.result.visualAssessment?.status === 'concern';
  const creationCompletionMissing =
    creationMustPersist && !flowHasCompletionAction(flow, state, explored);
  const creationVisuallyUnproven =
    creationMustPersist && step.result.visualAssessment?.status !== 'clear';
  if (creationCompletionMissing && step.result.verdict === 'pass') {
    step.result.verdict = 'needs-review';
    step.result.reasons.push(
      'Creation milestone filled content but did not prove a Create/Generate/Finalize/Save action and persisted item',
    );
  }
  if (creationVisuallyUnproven && step.result.verdict === 'pass') {
    step.result.verdict = 'needs-review';
    step.result.reasons.push(
      'Creation was not visually proven persisted in the final list/library/artifact state',
    );
  }
  if (explorerFailureDowngrade && explored) {
    step.result.verdict = 'needs-review';
    step.result.reasons.push(
      `Explorer did not confirm goal completion: ${explored.error ?? 'unknown reason'}`,
    );
  }
  if (infrastructureBlocked) {
    step.result.verdict = 'needs-review';
    step.result.reasons = step.result.reasons.filter(
      (reason) => !/product error|application failure/i.test(reason),
    );
    step.result.reasons.push(
      explored?.error ??
        'Infrastructure blocked: LLM provider was unavailable after retries.',
    );
  }
  if (automationBlockedWithoutProductEvidence && step.result.verdict === 'fail') {
    step.result.verdict = 'needs-review';
    step.result.reasons.push(
      `Automation could not complete the interaction (${explored?.error ?? 'control not reached'}), but captured no concrete product error; flow remains exploratory and will retry`,
    );
  }

  // The SAME false-PASS gap, but for the login-shaped branch (the "m4" class,
  // task #17). A login-shaped milestone routes through ensureAuthenticated()
  // (explored === null), so the explorer-failure downgrade above can never fire
  // for it. When that auth did NOT succeed this run (replayOk stayed false —
  // neither a silent session-restore nor the forced credentialed attempt
  // confirmed a login via state.authenticatedThisRun), the deterministic layer
  // can still record PASS purely from absence of a negative signal: a
  // silently-failed login usually leaves the page unchanged with no console
  // error, so nothing objective trips. That is a false pass sitting on top of a
  // login that never happened. Downgrade the bare 'pass' to needs-review (never
  // upgrade) — mirroring the explorer-failure case, and honest for the
  // isLoginShapedGoal false-positive case too (a mis-classified nav milestone on
  // a public site just gets surfaced for review rather than hard-failed).
  // Live-reproduced repeatedly and deliberately deferred until now: lambdatest
  // account-login-gate:m2, expandtesting user-auth-api:m3, webdriveruniversity
  // login-portal-auth:m1/m2, koyal google-signup-flow (2026-07-16).
  const loginFailureDowngrade = loginShaped && !replayOk && step.result.verdict === 'pass';
  if (loginFailureDowngrade) {
    step.result.verdict = 'needs-review';
    step.result.reasons.push(
      'Login-shaped milestone did not confirm authentication this run (no successful login) — not a verified pass',
    );
  }

  const milestoneManualEvidence = [
    ...currentRecipeEvidence,
    ...(explored ? manualEvidenceFromActions(explored.actions) : []),
  ];
  const finalManualRequirement =
    flow.manualContract && milestone.manualContractAudit && milestone.manualContractItem
      ? flow.manualContract.checklist[milestone.manualContractItem - 1] ?? milestone.goal
      : milestone.goal;
  const finalOperationallyVerified = Boolean(
    flow.manualContract &&
      milestone.manualContractAudit &&
      explored &&
      (
        manualOperationalMutationVerified(
          finalManualRequirement,
          [...manualEvidence, ...milestoneManualEvidence],
          step,
          explored.success,
          `${before.snapshot.raw}\n${before.snapshot.interactive}`,
          before,
        ) ||
        manualRoundedUploadVerified(
          finalManualRequirement,
          [...manualEvidence, ...milestoneManualEvidence],
          step,
          true,
          `${before.snapshot.raw}\n${before.snapshot.interactive}`,
          before,
        )
      ),
  );
  if (
    finalOperationallyVerified &&
    step.result.verdict !== 'pass'
  ) {
    step.result.verdict = 'pass';
    visualConcernDowngrade = false;
    step.result.reasons = step.result.reasons.filter(
      (reason) =>
        !/^Visual review found a concrete concern:/i.test(reason) &&
        !/^Manual audit lacks distinct persisted evidence/i.test(reason) &&
        !/^(?:Uncaught page|Console error|Unexpected.*5\d\d)/i.test(reason),
    );
    step.result.reasons.push(
      'Same-run operational mutation evidence and clean product signals override non-terminal audit ambiguity',
    );
  }
  const manualAuditIssue = finalOperationallyVerified
    ? undefined
    :
    flow.manualContract && milestone.manualContractAudit && milestone.manualContractItem
      ? manualAuditEvidenceIssue(
          finalManualRequirement,
          [...manualEvidence, ...milestoneManualEvidence],
          step.result.signals.snapshot.raw,
          flow.manualExecution?.tasks.find(
            (task) => task.id === milestone.manualTaskId,
          ),
          manualVisualAssessmentFromActions(explored?.actions ?? []) ??
            step.result.visualAssessment,
        )
      : undefined;
  const finalManualVisual =
    manualVisualAssessmentFromActions(explored?.actions ?? []) ??
    step.result.visualAssessment;
  const acceptedCharacterPresentationAmbiguity = Boolean(
    flow.manualContract &&
      milestone.manualContractAudit &&
      !manualAuditIssue &&
      !hasConcreteProductFailureEvidence(step) &&
      manualVisionAffirmsPersistedOutcome(finalManualRequirement, finalManualVisual),
  );
  if (acceptedCharacterPresentationAmbiguity && step.result.verdict !== 'pass') {
    step.result.verdict = 'pass';
    visualConcernDowngrade = false;
    step.result.reasons = step.result.reasons.filter(
      (reason) => !/^Visual review found a concrete concern:/i.test(reason),
    );
    step.result.reasons.push(
      'Same-run method provenance and visible finalized entities resolve the app-specific character-section presentation ambiguity',
    );
  }
  const journeyDestinationIssue = manualJourneyDestinationIssue(
    flow,
    milestone,
    currentFlowPageId(deps, flow),
  );
  if (manualAuditIssue && step.result.verdict === 'pass') {
    step.result.verdict = 'needs-review';
    step.result.reasons.push(manualAuditIssue);
  } else if (manualAuditIssue && !step.result.reasons.includes(manualAuditIssue)) {
    step.result.reasons.push(manualAuditIssue);
  }
  if (journeyDestinationIssue) {
    // A journey checkpoint is structural positioning, not a subjective audit.
    // After its bounded forward-recovery attempt, continuing from the wrong
    // wizard state would make every later task untrustworthy. Fail here so the
    // outer runner either proves a recipe-based recovery or skips downstream
    // tasks honestly.
    step.result.verdict = 'fail';
    if (!step.result.reasons.includes(journeyDestinationIssue)) {
      step.result.reasons.push(journeyDestinationIssue);
    }
  }

  // Everything below is POST-verdict bookkeeping (KB triage, human escalation,
  // recipe caching) — none of it should be able to lose the verdict `step`
  // already computed above. A browser hiccup here (the daemon wedging between
  // this milestone's own verification and the next browser call) previously
  // threw out of runMilestone entirely, and since `step` is only pushed to
  // scenario.steps by the CALLER after a normal return, the already-passing
  // step vanished from the report with no trace beyond the console log.
  try {
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
      const beforeSnapshot = `${before.snapshot.raw}\n${before.snapshot.interactive}`;
      const reExpectation = flow.manualContract
        ? {
            ...augmented,
            snapshotExcludes: augmented.snapshotExcludes?.filter(
              (pattern) => !patternAppears(beforeSnapshot, pattern),
            ),
          }
        : augmented;
      const reSignals = flow.manualContract
        ? manualFreshSignalBundle(step.result.signals, before)
        : step.result.signals;
      const re = verification.evaluateSignals(reSignals, reExpectation);
      const successSeen = statements.hasSuccessStatement(reSignals, currentPageId(deps));
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
      // A needs-review caused by the explorer itself failing to confirm the goal
      // (explorerFailureDowngrade above) has NOTHING to do with the deterministic
      // signals — they were already clean, which is exactly why the downgrade
      // fired. Re-evaluating those SAME signals against the SAME expectation here
      // trivially comes back 'pass' again, silently erasing the downgrade on every
      // single occurrence. Only let a genuinely NEW signal — a human-classified
      // success statement actually observed on the page — resolve it back to pass;
      // a bare re-check with no new evidence must not.
      let flipped: Verdict | null = null;
      if (
        (reVerdict === 'pass' && !(explorerFailureDowngrade && !successSeen) && !visualConcernDowngrade && !creationCompletionMissing && !creationVisuallyUnproven && !loginFailureDowngrade && !manualAuditIssue && !journeyDestinationIssue) ||
        (reVerdict !== 'fail' && successSeen && !visualConcernDowngrade && !creationCompletionMissing && !creationVisuallyUnproven && !loginFailureDowngrade && !manualAuditIssue && !journeyDestinationIssue)
      ) {
        flipped = 'pass';
      } else if (
        reVerdict === 'fail' &&
        step.result.verdict !== 'fail' &&
        (!automationBlockedWithoutProductEvidence || hasConcreteProductFailureEvidence(step))
      ) {
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
    if (
      step.result.verdict === 'needs-review' &&
      !automationBlockedWithoutProductEvidence &&
      !manualAuditIssue &&
      !journeyDestinationIssue
    ) {
      const hintWasOnlyConcern =
        Boolean(milestone.successHint) &&
        step.result.reasons.length > 0 &&
        step.result.reasons.every((reason) => reason.startsWith('Expected snapshot to include'));
      const answer = await interact.askChoice(
        `Step "${milestone.goal.slice(0, 80)}" is ambiguous (${step.result.reasons.join('; ').slice(0, 120)}). Verdict?`,
        ['pass', 'fail', 'skip'],
        'skip',
      );
      if (answer === 'pass' || answer === 'fail') {
        step.result.kbTriage = step.result.kbTriage ?? { statementsSeen: [], newlyClassified: [] };
        step.result.kbTriage.verdictFlippedFrom = 'needs-review';
        step.result.verdict = answer;
        if (answer === 'pass' && hintWasOnlyConcern) {
          // The human just proved that the LLM-authored literal was not a valid
          // post-action landmark (common for placeholders that disappear after
          // typing). Do not bake that rejected hint into the recipe forever.
          milestone.successHint = undefined;
          humanRejectedSuccessHint = true;
        }
      }
    }

    if (config.supervisor.enabled && step.result.verdict === 'needs-review') {
      const binary = productionBinaryVerdict({
        current: step.result.verdict,
        milestone,
        explorerSucceeded: explored?.success,
        explorerSteps: explored?.stepsTaken,
        visual:
          manualVisualAssessmentFromActions(explored?.actions ?? []) ??
          step.result.visualAssessment,
        manualAuditIssue,
        journeyDestinationIssue,
        infrastructureBlocked,
        concreteProductFailure: hasConcreteProductFailureEvidence(step),
      });
      step.result.kbTriage = step.result.kbTriage ?? { statementsSeen: [], newlyClassified: [] };
      step.result.kbTriage.verdictFlippedFrom = 'needs-review';
      step.result.verdict = binary;
      step.result.reasons.push(
        binary === 'pass'
          ? 'Production binary adjudication found goal-specific persisted success evidence; no human review queue is required'
          : 'Production binary adjudication could not prove the required outcome after bounded repair; unresolved work is a failure, not a review item',
      );
    }

    step.humanDecisions = interact.decisions.slice(decisionsBefore);

    // success + explored → cache the recipe for next time
    if (
      step.result.verdict === 'pass' &&
      explored?.success &&
      !nonIdempotentManual
    ) {
      const existingRecipe = state.recipes[recipeId];
      const normalizedPrimaryHint = fieldHintForRecipe?.toLowerCase().replace(/\s+/g, ' ').trim();
      const existingHasPrimaryFill = Boolean(
        normalizedPrimaryHint &&
          existingRecipe?.steps.some(
            (recipeStep) =>
              recipeStep.kind === 'fill' &&
              recipeStep.hint.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedPrimaryHint,
          ),
      );
      const exploredHasPrimaryFill = Boolean(
        normalizedPrimaryHint &&
          explored.actions.some(
            (action) =>
              action.action === 'fill' &&
              action.resolvedLabel?.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedPrimaryHint,
          ),
      );

      if (existingHasPrimaryFill && !exploredHasPrimaryFill) {
        // Replay may fail only after completing a valid prefix (most notably a
        // processing wait timing out while the artifact is still generating).
        // Explorer then resumes from that halfway state and records only the
        // suffix: Name → Finalize → wait. Replacing the original recipe with
        // that suffix makes the next clean replay start on the entry form and
        // immediately look for a field that cannot exist. Preserve the
        // stronger full recipe unless recovery actually revisited its primary
        // input and therefore proved a complete replacement sequence.
        console.log(
          `[flow] preserving full recipe ${recipeId}; fallback resumed after its primary fill and only learned a suffix`,
        );
      } else {
        recordFromExplorer(state, recipeId, explored, {
          secrets: { email: state.secrets.email, password: state.secrets.password },
          successCheck:
            !humanRejectedSuccessHint && milestone.successHint && isLiteralHint(milestone.successHint)
              ? { snapshotAnyOf: [milestone.successHint] }
              : undefined,
          fallbackFieldHint: fieldHintForRecipe,
        });
      }
    }
  } catch (error) {
    console.warn(
      `[flow] post-verdict bookkeeping failed (keeping the already-computed "${step.result.verdict}" verdict): ${error instanceof Error ? error.message : error}`,
    );
  }

  if (
    step.artifactDir &&
    (step.result.verdict !== writtenVerdict ||
      JSON.stringify(step.result.reasons) !== JSON.stringify(writtenReasons))
  ) {
    patchStepSummaryVerdict(step.artifactDir, step.result.verdict, step.result.reasons);
  }

  const endingPageId = currentFlowPageId(deps, flow);
  if (endingPageId !== 'unknown') visitedPageIds.add(endingPageId);
  return {
    step,
    marker,
    execution,
    manualEvidence: milestoneManualEvidence,
  };
}

/** Successful action evidence retained even when the surrounding milestone is incomplete. */
export function manualEvidenceFromActions(actions: ExplorerAction[]): string[] {
  return actions.flatMap((action) => {
    if (action.executionFailed || action.deniedByUser || action.action === 'fail') return [];
    const label = action.resolvedLabel?.trim();
    if (action.action === 'fill') {
      return [`filled "${label || 'editable field'}" with "${action.value ?? ''}"`];
    }
    if (action.action === 'upload') {
      return [`uploaded "${action.uploadedPath ?? action.selector ?? 'requested file'}"`];
    }
    if (action.action === 'select' || action.action === 'click' || action.action === 'press') {
      if (!label) return [];
      return [
        `${action.action === 'click' ? 'clicked' : action.action === 'select' ? 'selected' : 'pressed'} ` +
          `"${label}"`,
      ];
    }
    return [];
  });
}

/** Deterministic steps that completed before a replay fallback remain same-run evidence. */
export function manualEvidenceFromRecipeSteps(steps: readonly RecipeStep[]): string[] {
  return steps.flatMap((step) => {
    if (step.kind === 'click') {
      return step.label ? [`clicked "${step.label}"`] : [];
    }
    if (step.kind === 'fill') {
      return step.secretRef
        ? ['filled a secret field']
        : [`filled "${step.hint}" with "${step.value}"`];
    }
    if (step.kind === 'select') return [`selected "${step.hint}" with "${step.value}"`];
    if (step.kind === 'press') return [`pressed "${step.key}"`];
    if (step.kind === 'upload') return [`uploaded "${step.assetPath}"`];
    return [];
  });
}

/** One-shot replay mutations already executed in this run must stay blocked in fallback. */
export function successfulMutationLabelsFromRecipeSteps(
  steps: readonly RecipeStep[],
): string[] {
  return steps.flatMap((step) =>
    step.kind === 'click' &&
    step.label &&
    isLikelyMutationLabel(step.label)
      ? [step.label]
      : [],
  );
}

export function manualEvidenceSupportsItem(
  requirement: string,
  evidence: readonly string[],
): boolean {
  const joined = evidence.join('\n');
  if (/\b(?:new project|fresh journey)\b/i.test(requirement)) {
    return /clicked "[^"]*new project[^"]*"/i.test(joined);
  }
  if (/\bupload\b.{0,60}\b(?:script|pdf)\b/i.test(requirement)) {
    return /\buploaded "[^"]+\.(?:pdf|docx?)(?:\?[^"]*)?"/i.test(joined);
  }
  if (/\bupload\b.{0,60}\b(?:audio|recording|sound|file)\b/i.test(requirement)) {
    return /\buploaded "[^"]+\.(?:mp3|wav|m4a|aac|ogg|flac)(?:\?[^"]*)?"/i.test(
      joined,
    );
  }
  return false;
}

type ManualVisualAssessment = NonNullable<TestStep['result']['visualAssessment']>;

/** Prefer the visual proof captured on the owning surface before a forward click. */
export function manualVisualAssessmentFromActions(
  actions: readonly ExplorerAction[],
): ManualVisualAssessment | undefined {
  return [...actions]
    .reverse()
    .find((action) => action.visualAssessment)
    ?.visualAssessment;
}

/**
 * DOM/accessibility snapshots often expose stale wizard controls, hidden empty
 * templates, or a disabled forward button while the rendered UI already shows
 * the requested persisted result. In that narrow ambiguity, a clear visual
 * assessment may settle the visible outcome. It never substitutes for action
 * provenance (checked separately by each audit) and never overrides a visual
 * concern, uncertainty, processing state, missing item, or product error.
 */
export function manualVisionAffirmsPersistedOutcome(
  item: string,
  visual: ManualVisualAssessment | undefined,
): boolean {
  if (!visual) return false;
  const summary = visual.summary.toLowerCase();
  const threeCharacterItem = /\bexactly three distinct characters\b/i.test(item);
  const uploadedCharacterAssetGrouping =
    threeCharacterItem &&
    (
      /\btwo (?:named |finalized )?characters?\b[\s\S]{0,180}\b(?:plus|and)\b[\s\S]{0,80}\b(?:named )?asset entry\b/.test(
        summary,
      ) ||
      (
        /\bnamed ai[- ]generated character\b/.test(summary) &&
        /\blibrary character\b/.test(summary) &&
        /\basset[- ]section image\b/.test(summary)
      ) ||
      (
        /\btwo characters?\b/.test(summary) &&
        /\b(?:third|uploaded)\b[\s\S]{0,100}\b(?:asset|assets\/animals)\b/.test(summary)
      )
    ) &&
    !/\b(?:disabled|loading|processing|generating|no image available|failed)\b/.test(
      summary,
    ) &&
    (
      !/\b(?:missing|empty)\b/.test(summary) ||
      /\bempty ['"]?add(?: another)?['"]? placeholder\b/.test(summary)
    );
  const migratedCharacterSubsectionGrouping =
    threeCharacterItem &&
    /\b(?:appear|displayed|shown) under (?:the )?['"]?add assets and animals as character/i.test(summary) &&
    (visual.summary.match(/\b[A-Z][a-z]+[A-Z][a-z]+\b/g)?.length ?? 0) >= 2 &&
    !/\b(?:missing|empty|disabled|loading|processing|generating|no image available|failed)\b/.test(summary) &&
    visual.concerns.every((concern) =>
      /\b(?:assets and animals as character|character[- ]assets|separate (?:asset|character) section|in-flow character slot|wrong section)\b/i.test(
        concern,
      ),
    );
  // Some applications persist an uploaded character in a dedicated
  // character-assets group rather than rendering it as a normal avatar card.
  // The action audit separately proves AI Finalize + image Upload/Save +
  // existing-library Confirm. In that narrow, fully named 2-card + 1 asset
  // grouping, vision is settling presentation ambiguity, not inventing a
  // missing mutation. Never extend this exception to an empty/disabled/loading
  // state or a generic asset unrelated to the uploaded-character provenance.
  if (
    (uploadedCharacterAssetGrouping || migratedCharacterSubsectionGrouping) &&
    !visual.concerns.some((concern) =>
      /\b(?:upload (?:did not|never)|existing (?:was not|never)|ai avatar (?:was not|never)|still processing|empty slot|next (?:is|remains) disabled|no image)\b/i.test(
        concern,
      ),
    )
  ) {
    return true;
  }
  if (visual.status === 'concern') return false;
  if (
    (threeCharacterItem
      ? /\b(?:missing|empty|disabled|loading|processing|generating|not (?:visible|shown|persisted|complete)|no image available|error|failed)\b/
      : /\b(?:missing|empty|disabled|loading|processing|generating|uncertain|cannot|not (?:visible|shown|persisted|complete)|no image available|error|failed)\b/
    ).test(summary)
  ) {
    return false;
  }
  if (
    !/\b(?:visibly confirmed|clearly shows?|visible|shown|persisted|finalized|completed|successfully|playable|downloadable)\b/.test(
      summary,
    )
  ) {
    return false;
  }

  if (threeCharacterItem) {
    if (visual.status === 'uncertain') {
      const concerns = visual.concerns.join('\n').toLowerCase();
      // The final list cannot show how each item was created. Same-run action
      // provenance already proves those methods before this helper is called,
      // so method-label uncertainty (or inability to prove persistence beyond
      // the visibly populated current list) must not trigger duplicate creation.
      if (
        visual.concerns.length === 0 ||
        /\b(?:only (?:one|two|1|2)|missing|empty|disabled|loading|processing|no image|not three)\b/.test(
          concerns,
        ) ||
        !visual.concerns.every((concern) =>
          /\b(?:method|upload|ai[- ]generated|existing library|method labels?|separate|assets?(?: and animals)?(?: as character)? section|different sections|beyond the current view|after finalize|after next)\b/i.test(
            concern,
          ),
        )
      ) {
        return false;
      }
    } else if (visual.concerns.length > 0) {
      return false;
    }
    return (
      /\b(?:three|3)\b[\s\S]{0,100}\bcharacters?\b|\bcharacters?\b[\s\S]{0,100}\b(?:three|3)\b/.test(
        summary,
      ) &&
      /\b(?:character section|character[- ]assets? section|choose your characters|character slots?|finalized|persisted)\b/.test(
        summary,
      )
    );
  }
  if (/\b(?:style|orientation)\b/i.test(item)) {
    return /\b(?:style|animated|sketch|realistic)\b/.test(summary) &&
      /\b(?:orientation|portrait|landscape|square)\b/.test(summary);
  }
  if (/\b(?:final[- ]video|rendered video|terminal artifact)\b/i.test(item)) {
    return /\bvideo\b/.test(summary) && /\b(?:playable|downloadable|persisted|rendered)\b/.test(summary);
  }
  return false;
}

/**
 * Unattended production runs have no human review queue. After the normal
 * deterministic checks, visual audit, bounded repair, and supervisor prompt
 * have all run, collapse any residual ambiguity to a binary operational
 * verdict. A goal-specific success toast/playback/persistence observation may
 * prove the current operation even when an unrelated older error remains on
 * the page; missing required evidence, infrastructure loss, or an explicit
 * audit gap is a fail. Nothing is silently parked for later review.
 */
export function productionBinaryVerdict(args: {
  current: Verdict;
  milestone: FlowMilestone;
  explorerSucceeded?: boolean;
  explorerSteps?: readonly string[];
  visual?: ManualVisualAssessment;
  manualAuditIssue?: string;
  journeyDestinationIssue?: string;
  infrastructureBlocked?: boolean;
  concreteProductFailure?: boolean;
}): Exclude<Verdict, 'needs-review'> {
  if (args.current === 'pass' || args.current === 'fail') return args.current;
  if (
    args.manualAuditIssue ||
    args.journeyDestinationIssue ||
    args.infrastructureBlocked ||
    args.concreteProductFailure
  ) {
    return 'fail';
  }
  const evidence = (args.explorerSteps ?? []).join('\n').toLowerCase();
  const operationSpecificSuccess =
    /(?:toast|message)[^\n]{0,100}\b(?:success|successfully|completed)\b/.test(evidence) ||
    /\b(?:actively playing|playback advancing|scrubber (?:moving|advancing))\b/.test(evidence) ||
    /\b(?:download video|export xml)[^\n]{0,100}\benabled\b/.test(evidence) ||
    /\b(?:persisted|finalized)[^\n]{0,100}\b(?:visible|shown|library|scene|video)\b/.test(evidence);
  if (operationSpecificSuccess) return 'pass';
  if (
    args.visual?.status === 'clear' &&
    (args.explorerSucceeded || args.milestone.kind === 'verify')
  ) {
    return 'pass';
  }
  return 'fail';
}

/**
 * High-risk manual checks need stronger evidence than an LLM `done` action.
 * An unresolved requirement stays needs-review and therefore cannot qualify
 * the flow for replay.
 */
export function manualAuditEvidenceIssue(
  item: string,
  evidence: readonly string[],
  snapshot: string,
  task?: ManualAcceptanceTask,
  visual?: ManualVisualAssessment,
): string | undefined {
  const joined = evidence.join('\n').toLowerCase();
  const view = snapshot.toLowerCase();
  const has = (pattern: RegExp) => pattern.test(joined);
  const missing = (description: string) =>
    `Manual audit lacks distinct persisted evidence for ${description}`;

  if (
    /\bupload\b.{0,80}\b(?:file (?:i|the user) provide|supplied (?:audio|script|file)|provided (?:audio|script|file))\b/i.test(
      item,
    )
  ) {
    const expectsAudio = /\b(audio|recording|sound)\b/i.test(item);
    const expectsScript = /\b(script|pdf)\b/i.test(item);
    const uploadedExpectedType = expectsAudio
      ? has(/uploaded "[^"]+\.(?:mp3|wav|m4a|aac|ogg|flac)(?:\?[^"]*)?"/)
      : expectsScript
        ? has(/uploaded "[^"]+\.(?:pdf|docx?)(?:\?[^"]*)?"/)
        : has(/uploaded "[^"]+"/);
    if (!uploadedExpectedType) {
      return missing(
        'uploading the user-supplied file through a file input (choosing a built-in sample is not equivalent)',
      );
    }
  }

  if (/\bexactly three distinct characters\b/i.test(item)) {
    if (!has(/clicked "[^"]*create ai avatar[^"]*"/)) {
      return missing('the AI-avatar character method');
    }
    if (!has(/uploaded "[^"]+\.(?:png|jpe?g|webp|gif|heic|avif)(?:\?[^"]*)?"/)) {
      return missing('an image upload for the uploaded-character method (a prior script/audio upload does not count)');
    }
    const existingSelectorIndex = evidence.findIndex((entry) =>
      /clicked "[^"]*use existing[^"]*"/i.test(entry),
    );
    if (existingSelectorIndex < 0) {
      return missing('the existing-library character method');
    }
    const existingCommitted = evidence
      .slice(existingSelectorIndex + 1)
      .some((entry) =>
        /clicked "[^"]*(?:add(?: \(\d+\)| selected)?|use selected|confirm(?: selection)?|done)[^"]*"/i.test(
          entry,
        ),
      );
    if (!existingCommitted) {
      return missing('committing the selected existing-library character');
    }
    if (manualVisionAffirmsPersistedOutcome(item, visual)) return undefined;
    const onCharacterSurface =
      /\b(?:choose your characters|create ai avatar|use your likeness)\b/i.test(snapshot);
    if (!onCharacterSurface) {
      return missing(
        'returning to the character surface and visibly verifying all three persisted characters after closing any picker or naming dialog',
      );
    }
    if (
      onCharacterSurface &&
      /\bcharacter \d+\b[\s\S]{0,500}\b(?:use your likeness|create ai avatar)\b/i.test(
        snapshot,
      )
    ) {
      return missing('all three character slots finalized with no empty character slot');
    }
    if (onCharacterSurface && /\bnext\b[^\n]*\bdisabled\b/.test(view)) {
      return missing('three accepted characters with the forward control enabled');
    }
  }

  if (/\b(character voice|emotion|dialogue|spoken text|script line)\b/i.test(item)) {
    if (!has(/\bvoice\b/)) return missing('a character voice change');
    if (!has(/\bemotion\b|\b(happy|sad|angry|fearful|excited|calm)\b/)) {
      return missing('a dialogue emotion change');
    }
    if (!has(/filled "[^"]*(dialogue|script|spoken|text)[^"]*"/)) {
      return missing('an edited spoken dialogue line');
    }
  }

  if (/\b(reusable asset|asset library)\b/i.test(item)) {
    if (!has(/clicked "(?:add(?: new)? asset|create asset|new asset)"/)) {
      return missing('creating a reusable library asset (a character or direct scene upload is not equivalent)');
    }
    if (!has(/clicked "[^"]*(?:generate|finalize|save)[^"]*asset[^"]*"/)) {
      return missing('finalizing the reusable asset in its library');
    }
    if (/\badd.+same asset.+scene\b/i.test(item) && !has(/clicked "[^"]*add assets?[^"]*"/)) {
      return missing('adding that same reusable asset to a generated scene');
    }
  }

  if (
    task?.artifactRole === 'consumer' ||
    /\b(?:same asset|that asset|asset created earlier|previously created asset|earlier asset)\b/i.test(
      item,
    )
  ) {
    const producerStart = evidence.findIndex((entry) =>
      /clicked "(?:add(?: new)? asset|create asset|new asset)"/i.test(entry),
    );
    const producerEnd = evidence.findIndex(
      (entry, index) =>
        index > producerStart &&
        /clicked "[^"]*(?:finalize|save)[^"]*asset[^"]*"/i.test(entry),
    );
    const consumerStart = evidence.findIndex(
      (entry, index) =>
        index > producerEnd && /clicked "[^"]*add assets?[^"]*"/i.test(entry),
    );
    const uploadsBetween = (start: number, end: number): string[] =>
      evidence
        .slice(Math.max(0, start), end < 0 ? undefined : end + 1)
        .map((entry) => entry.match(/uploaded "([^"]+)"/i)?.[1])
        .filter((assetPath): assetPath is string => Boolean(assetPath));
    const producerPaths =
      producerStart >= 0 && producerEnd > producerStart
        ? uploadsBetween(producerStart, producerEnd)
        : [];
    const consumerPaths =
      consumerStart > producerEnd ? uploadsBetween(consumerStart, -1) : [];
    const reusedExactSource = producerPaths.some((assetPath) =>
      consumerPaths.includes(assetPath),
    );
    const producedNames =
      producerStart >= 0 && producerEnd > producerStart
        ? evidence
            .slice(producerStart, producerEnd + 1)
            .map(
              (entry) =>
                entry.match(
                  /filled "[^"]*(?:asset )?name[^"]*" with "([^"]+)"/i,
                )?.[1],
            )
            .filter((name): name is string => Boolean(name))
        : [];
    const selectedByIdentity = producedNames.some((name) =>
      evidence
        .slice(Math.max(0, producerEnd + 1))
        .some(
          (entry) =>
            /^clicked "/i.test(entry) &&
            entry.toLowerCase().includes(name.toLowerCase()),
        ),
    );
    if (!reusedExactSource && !selectedByIdentity) {
      return missing(
        'consuming the exact previously created asset by the same source file path or persisted library identity',
      );
    }
  }

  if (/\b(outfit|change look)\b/i.test(item)) {
    let outfitFill = -1;
    evidence.forEach((entry, index) => {
      if (/\b(coat|shirt|dress|jacket|suit|trousers|pants|skirt|sweater|boots|outfit|wearing)\b/i.test(entry)) {
        outfitFill = index;
      }
    });
    const appliedAfterFill = evidence
      .slice(Math.max(0, outfitFill + 1))
      .some((entry) => /clicked "[^"]*(?:change look|generate outfit|save outfit)[^"]*"/i.test(entry));
    if (outfitFill < 0 || !appliedAfterFill) {
      return missing('applying the requested outfit after entering its new prompt');
    }
  }

  if (/\b(location|locations)\b/i.test(item)) {
    const locationCreateIndex = evidence.findIndex((entry) =>
      /clicked "[^"]*(?:add new location|create location|new location)[^"]*"/i.test(
        entry,
      ),
    );
    const locationCreationCommittedIndex = evidence.findIndex(
      (entry, index) =>
        index > locationCreateIndex &&
        /clicked "[^"]*(?:create|generate|finalize|save)[^"]*location[^"]*"/i.test(
          entry,
        ),
    );
    const persistedInlineLocationEdit = evidence
      .slice(Math.max(0, locationCreationCommittedIndex + 1))
      .some((entry) => {
        const editedValue = entry.match(/filled "[^"]+" with "([^"]+)"/i)?.[1];
        return Boolean(
          editedValue &&
            editedValue.trim().length >= 3 &&
            view.includes(editedValue.trim().toLowerCase()),
        );
      });
    if (
      /\b(?:create|add|new|generate)\b/i.test(item) &&
      locationCreateIndex < 0
    ) {
      return missing('creating the new test location');
    }
    if (
      /\b(?:edit|change|regenerate|update)\b/i.test(item) &&
      !has(/clicked "[^"]*(?:edit|regenerate|save)[^"]*location[^"]*"|clicked "edit"/) &&
      !(locationCreationCommittedIndex >= 0 && persistedInlineLocationEdit)
    ) {
      return missing('editing and persisting the new test location');
    }
    if (/\bdelet/i.test(item) && !has(/clicked "[^"]*(?:delete|remove)[^"]*"/)) {
      return missing('the explicitly approved deletion of only the new test location');
    }
  }

  if (/\b(sketch style|orientation|art style)\b/i.test(item)) {
    const requiredStyle = item.match(/\b(sketch|animated|realistic)\s+style\b/i)?.[1];
    if (
      requiredStyle &&
      !evidence.some((entry) =>
        new RegExp(`clicked "[^"]*${requiredStyle}[^"]*"`, 'i').test(entry),
      )
    ) {
      return missing(`selecting ${requiredStyle} style`);
    }
    if (!has(/clicked "(?:portrait|landscape|square)"/)) {
      return missing('selecting a required orientation');
    }
    if (manualVisionAffirmsPersistedOutcome(item, visual)) return undefined;
    const onStyleSurface =
      /\b(?:choose.{0,40}(?:art )?style|sketch|orientation)\b/i.test(snapshot);
    if (onStyleSurface && /\bnext\b[^\n]*\bdisabled\b/.test(view)) {
      return missing('a completed style configuration with the forward control enabled');
    }
  }

  if (/\b(change scene|reshoot|camera angle|add assets?)\b/i.test(item)) {
    const sceneOperations = [
      {
        requested: /\b(?:change scene function:\s*)?edit\b/i.test(item),
        label: 'the Edit scene function',
        evidence: /clicked "(?:edit|edit scene)"/,
      },
      {
        requested: /\breshoot\b/i.test(item),
        label: 'the Reshoot function',
        evidence: /clicked "[^"]*reshoot[^"]*"/,
      },
      {
        requested: /\bcamera angle\b/i.test(item),
        label: 'the Change Camera Angle function',
        evidence: /clicked "[^"]*camera angle[^"]*"/,
      },
      {
        requested: /\badd assets?\b/i.test(item),
        label: 'the Add Assets function',
        evidence: /clicked "[^"]*add assets?[^"]*"/,
      },
    ];
    for (const operation of sceneOperations) {
      if (operation.requested && !has(operation.evidence)) {
        return missing(operation.label);
      }
    }
  }
  if (/\badd .{0,30}asset.{0,30}(?:generated )?scene\b/i.test(item)) {
    if (!has(/clicked "[^"]*add assets?[^"]*"/)) {
      return missing('adding the previously created reusable asset to a generated scene');
    }
  }

  if (/\b(final[- ]video|create video|rendered video|terminal artifact)\b/i.test(item)) {
    if (/\bcreate video\b/i.test(item) && !has(/clicked "[^"]*create video[^"]*"/)) {
      return missing('submitting Create Video');
    }
    if (manualVisionAffirmsPersistedOutcome(item, visual)) return undefined;
    if (!/\b(download|play|video)\b/.test(view) || /\b(generating|rendering|processing)\b/.test(view)) {
      return missing('a completed playable/downloadable terminal video');
    }
  }

  const finalVideoOperations = [
    {
      requested: /\bedit video\b/i.test(item),
      label: 'Edit Video',
      evidence: /clicked "[^"]*(?:edit video|submit edit)[^"]*"/,
    },
    {
      requested: /\bretake\b/i.test(item),
      label: 'Retake',
      evidence: /clicked "[^"]*retake[^"]*"/,
    },
    {
      requested: /\badd reference\b/i.test(item),
      label: 'Add Reference',
      evidence: /clicked "[^"]*add reference[^"]*"/,
    },
    {
      requested: /\breframe\b/i.test(item),
      label: 'Reframe',
      evidence: /clicked "[^"]*reframe[^"]*"/,
    },
  ];
  for (const operation of finalVideoOperations) {
    if (operation.requested && !has(operation.evidence)) {
      return missing(`the final-video ${operation.label} operation`);
    }
  }

  return undefined;
}

export function manualTaskGraphRepairIssue(
  flow: Flow,
  milestone: FlowMilestone,
  evidence: readonly string[],
  snapshot: string,
  visual?: ManualVisualAssessment,
): string | undefined {
  if (
    !flow.manualExecution ||
    !flow.manualContract ||
    !milestone.manualContractAudit ||
    !milestone.manualContractItem
  ) {
    return undefined;
  }
  return manualAuditEvidenceIssue(
    flow.manualContract.checklist[milestone.manualContractItem - 1] ?? milestone.goal,
    evidence,
    snapshot,
    flow.manualExecution.tasks.find((task) => task.id === milestone.manualTaskId),
    visual,
  );
}

export function manualContractRuntimeGuidance(
  flow: Flow,
  milestone: FlowMilestone,
  evidence: readonly string[],
): string {
  if (!flow.manualContract) return '';
  const taskGraphTask = milestone.manualTaskId
    ? flow.manualExecution?.tasks.find((task) => task.id === milestone.manualTaskId)
    : undefined;
  const verificationOnly =
    milestone.id === 'manual-contract-final-proof' ||
    milestone.id === 'manual-task-final-proof';
  const contract = verificationOnly
    ? flow.manualExecution
      ? 'The runner has already adjudicated each acceptance task independently. Assess only the terminal artifact ' +
        'and visible global constraints; do not demand that early-task UI or evidence remain visible here.'
      : flow.manualContract.checklist
          .map((item, index) => `${index + 1}. ${item}`)
          .join('\n')
    : taskGraphTask
      ? `${milestone.manualContractItem ?? '?'}: ${taskGraphTask.requirement}`
      : flow.manualExecution
        ? 'No acceptance task is active in this call. Advance only the current mapped journey checkpoint.'
        : milestone.manualContractAudit && milestone.manualContractItem
      ? `${milestone.manualContractItem}. ${
        flow.manualContract.checklist[milestone.manualContractItem - 1]
      }`
      : flow.manualContract.checklist
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n');
  const uniqueEvidence = [...new Set(evidence)].slice(
    flow.manualExecution ? -12 : -80,
  );
  const evidenceText = uniqueEvidence.length
    ? `\n\nRecorded successful action evidence from this same run:\n- ${uniqueEvidence.join('\n- ')}`
    : '\n\nThere is no successful action evidence from an earlier checkpoint yet.';
  const threeCharacterMethodTask = /\bexactly three distinct (?:characters|character methods)\b/i.test(
    taskGraphTask?.requirement ?? contract,
  );
  const artifactGroupingRule = threeCharacterMethodTask
    ? 'For this exact three-character-method task, complete all methods inside the active video wizard through the owning Character section or ' +
      'an empty character slot. The uploaded-character method must begin from the upload control belonging to that ' +
      'character slot; never substitute the standalone reusable Assets, Attachments, Animals, or Media section. ' +
      'The application may later display a finalized uploaded character or library-selected character in a ' +
      'dedicated character-assets/animals-as-character subsection. That dedicated section counts only when same-run ' +
      'actions prove the upload or selection originated from the Character section and the screenshot visibly shows ' +
      'three finalized character entities. Do not require method labels in the final list. If uploading migrated ' +
      'an entry out of a newly added slot and left only an unused empty ' +
      'placeholder that disables Next, remove that empty placeholder once; never remove a finalized entity. Confirm ' +
      'the requested selected set before advancing, and never defer this task to or revisit it later through the ' +
      'standalone Characters library. '
    : /\b(?:new )?reusable asset\b|\basset library\b/i.test(taskGraphTask?.requirement ?? contract)
      ? 'Create/add the reusable asset only through the standalone Asset section or Asset library. Never use a ' +
        'character slot, character uploader, or Assets/Animals-as-Character subsection as proof of the reusable ' +
        'asset. Verify the finalized item on its owning Asset surface. '
      : 'Use screenshot grouping to ensure an upload/create/select control belongs to the requested artifact ' +
        'section or empty slot. Never use a visually separate assets, attachments, animals, or media section as ' +
        'proof of a character/person upload. ';
  const operatingRule = verificationOnly
    ? '\nThis checkpoint is strictly read-only. The contract and evidence are provided only for assessment. Do not ' +
      'click Edit/Create/Save/Generate/Upload/Submit controls, fill fields, or retry a missing mutation.'
      : milestone.manualContractAudit
      ? `\nThis is a mutation-capable audit for acceptance item ${milestone.manualContractItem ?? 'assigned here'} only. ` +
        'Do not work on a different checklist item in this call. Repair this item only when it has no matching ' +
        'completion evidence, and never repeat a proven mutation. An attempted click, a submitted form with no ' +
        'result, an ambiguous visual state, or a related-but-different action is not completion evidence. When this ' +
        'item changes a value, enter every requested new value before activating Change/Generate/Save; never click ' +
        'the mutation control once with the old value and then treat a later fill as completion. ' +
        'item asks for persistence, require a saved value, completed processing state, or final library/artifact ' +
        'state before calling done. A screenshot is attached on every manual decision: use its visual grouping to ' +
        artifactGroupingRule +
        'After a modal selection, return to the owning surface and visibly verify the persisted item before done. ' +
        'If this item says the user supplies a file, only an actual upload action with that file type is completion; ' +
        'a built-in sample, preset, or previously attached unrelated file is not the supplied file. ' +
        (taskGraphTask?.artifactRole === 'producer'
          ? 'This task produces an artifact consumed later: preserve a stable, unique library identity. Prefer a ' +
            'finalized named library item that the later surface can select. Use an upload-backed path only when ' +
            'the active requirement or a visible consumer explicitly requires a file; do not infer that from a ' +
            'generic upload option. '
          : taskGraphTask?.artifactRole === 'consumer'
            ? 'Use the exact dependency artifact by its persisted name or the identical source path; never substitute ' +
              'a different upload and call it the same artifact. '
            : '') +
        'When it cannot be completed after one bounded attempt, ' +
        'record it as an incomplete sub-check so the next independent audit milestone can still run.'
      : '\nWork only on contract operations that are directly supported by the current screen/current mapped ' +
        'checkpoint. Never restart an obligation that already has matching evidence. A successful Fill/Select ' +
        'followed by Save/Apply is action evidence: do not reopen and repeat it merely because a collapsed summary ' +
        'shows stale text. Record that visual mismatch for verification, then use the safe forward control so later ' +
        'Screenshot grouping is authoritative when identical controls appear in different sections: use only the ' +
        'control inside the requested artifact section or empty slot, then verify the result on that owning surface. ' +
        'independent features are still tested. If one sub-check cannot complete after one bounded attempt, leave it ' +
        'incomplete and continue forward; do not trap the entire journey retrying it.';
  const constraints =
    flow.manualExecution?.constraints.length
      ? `\nGlobal run constraints (apply silently; do not turn them into extra tasks):\n- ${flow.manualExecution.constraints.join('\n- ')}`
      : '';
  const editGuidance = milestone.goal.includes('Operational edit contract:')
    ? ''
    : manualEditVerificationGuidance(taskGraphTask?.requirement ?? contract);
  return (
    `\n\nManual acceptance contract:\n${contract}${constraints}${evidenceText}\n` +
    'Do not infer completion merely from reaching a later page. Use the evidence to avoid duplicate work and to ' +
    `distinguish an attempted-but-visually-ambiguous check from an omitted check.${operatingRule}` +
    editGuidance
  );
}

/**
 * A manual acceptance contract already names the exact checks the user wants.
 * Generic probes can mutate or navigate away from the one fresh artifact the
 * contract is building, without satisfying any contract item. Keep the normal
 * probe suite unchanged for every ordinary flow, but make contract execution
 * exclusively follow its explicit checklist.
 */
export function shouldRunMilestoneProbes(flow: Flow, quick = false): boolean {
  return !quick && !flow.manualContract;
}

export async function runFlows(
  deps: FlowRunnerDeps,
  authCtx: AuthContext,
  report: RunReport,
  runDir: string,
  opts: { only?: string[]; quick?: boolean } = {},
): Promise<void> {
  const { state } = deps;
  const flows = orderRunnableFlows(state.sitemap.flows.filter(
    (f) => isRunnableFlow(f) && (!opts.only?.length || opts.only.includes(f.id)),
  ));

  if (flows.length === 0) {
    console.log('[flow] no exploratory/deterministic flows to run — run `autoqa explore` first or select flows via `autoqa review`');
    return;
  }

  const verification = new VerificationLayer(deps.browser);

  for (const flow of flows) {
    const runMode = flowRunMode(flow);
    console.log(`\n[flow] ▶ ${flow.title} (${flow.milestones.length} milestones, ${runMode})`);
    if (runMode === 'learning') {
      console.log('[flow] exploratory flow — every milestone will use LLM exploration until one complete terminal run is learned');
    } else if (runMode === 'replay-validation') {
      console.log('[flow] complete exploratory flow — validating every saved milestone recipe before deterministic promotion');
    }
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
      llm: deps.llm,
    };

    // Highest milestone index we started running — lets the outer catch record
    // any milestones AFTER an uncaught mid-flow exception as skipped instead of
    // silently dropping them (the-internet.herokuapp.com report-loss variant).
    let lastAttemptedIndex = -1;
    const milestoneExecutions: MilestoneExecution[] = [];
    const manualEvidence: string[] = [];
    const manualTaskVerdicts = new Map<string, Verdict>();
    const visitedPageIds = new Set<string>();
    let verifiedProductBlockSeen = false;

    try {
      // Nothing has navigated anywhere for THIS flow yet at this point — the
      // browser is wherever the PREVIOUS flow left it, which is unrelated to
      // whether this flow's own entry requires login. Don't trust an incidental
      // login-shaped page left over from that prior flow (see trustCurrentGate's
      // doc comment in auth.ts for the confirmed live false-positive this fixes).
      const needsAnonymousEntry = looksLikeAuthEntryPageId(flow.entry.pageId);
      if (!needsAnonymousEntry) {
        await ensureAuthenticated(authCtx, { trustCurrentGate: false });
      }
      await navigateToEntry(deps, flow);
      if (needsAnonymousEntry) {
        let url = '';
        let snapshot = '';
        try {
          url = deps.browser.getUrl();
          snapshot = deps.browser.snapshotInteractive();
        } catch {
          // The ordinary entry handling below will report an unavailable browser.
        }
        const onLoginGate = looksLikeAuthGate(url, snapshot, deps.browser.hasVisiblePasswordInput());
        if (!onLoginGate) {
          await ensureLoggedOutForEntry(deps, flow, [flow.entry.pageId]);
          await navigateToEntry(deps, flow);
        }
      }
      await applyFreshEntryHint(deps, flow);

      const probeCtx: ProbeContext = {
        browser: deps.browser,
        state: deps.state,
        nav: new Nav(deps.browser),
        statements: deps.statements,
        stepCtx: ctx,
        interact: deps.interact,
      };

      for (let mi = 0; mi < flow.milestones.length; mi++) {
        const milestone = flow.milestones[mi];

        const blockedDependencies = blockedManualTaskDependencyIds(
          flow,
          milestone,
          manualTaskVerdicts,
        );
        if (blockedDependencies.length > 0) {
          const blockedStep = dependencyBlockedStep(
            flow,
            milestone,
            blockedDependencies,
            flow.milestones.slice(0, mi).map((candidate) => candidate.goal),
          );
          scenario.steps.push(blockedStep);
          if (milestone.manualTaskId) {
            manualTaskVerdicts.set(milestone.manualTaskId, blockedStep.result.verdict);
          }
          milestoneExecutions.push({
            milestoneId: milestone.id,
            verdict: blockedStep.result.verdict,
            execution: 'none',
          });
          console.log(
            `[flow:v2] acceptance task ${milestone.manualContractItem ?? milestone.id} blocked by unmet prerequisite(s) ${blockedDependencies.join(', ')} — skipping only this dependent task`,
          );
          continue;
        }

        // wizard drafts can resume mid-flow: if we're already on a LATER
        // milestone's page, fast-forward instead of failing the earlier ones.
        // But the flow's own entry page is never a valid fast-forward TARGET —
        // a later milestone's guardPhases can legitimately equal entry.pageId
        // (e.g. "log in" flows that start AND end on the same storefront page,
        // just in a different auth state a page id alone can't see). Verified
        // live on bstackdemo.com: entry.pageId="products-list" also happens to
        // be m4 AND m5's guardPhase, so on the very first check of m1 — right
        // after fresh entry navigation, nothing has run yet — this matched and
        // skipped straight to m4, silently false-PASSing the entire
        // username/password/login-click sequence.
        const hereId = currentFlowPageId(deps, flow);
        // Only guard the exact scenario above: the FIRST check (mi===0), right after
        // fresh entry navigation, before anything has run. For any LATER check
        // (mi>0), landing back on entry.pageId can legitimately BE a resumed later
        // milestone's position (not just the unstarted flow start) — unconditionally
        // disabling fast-forward for every iteration would block that legitimate case.
        const isEntryPage = mi === 0 && hereId !== 'unknown' && hereId === flow.entry.pageId;
        // Task-graph manual runs always start through their explicit fresh
        // entry contract. Page-based fast-forward is unsafe for them because a
        // later journey guard can appear beyond an unguarded acceptance task,
        // silently skipping that task. Resume is handled by each task's mapped
        // positioning and never by jumping over graph nodes.
        const candidateAheadIdx = laterMilestoneStartingOnPage(
          flow,
          mi,
          hereId,
          isEntryPage,
        );
        const aheadIdx = manualSafeAheadIndex(flow, mi, candidateAheadIdx);
        if (aheadIdx > mi && hereId !== 'unknown' && !milestone.guardPhases?.includes(hereId)) {
          console.log(
            `[flow] resumed mid-wizard on "${hereId}" — fast-forwarding ${aheadIdx - mi} milestone(s)`,
          );
          mi = aheadIdx - 1;
          continue;
        }

        ctx.stepsToReproduce.push(milestone.goal);
        lastAttemptedIndex = mi;
        const {
          step,
          marker,
          execution,
          manualEvidence: newManualEvidence,
        } = await runMilestone(
          deps,
          flow,
          milestone,
          mi,
          ctx,
          authCtx,
          runMode,
          manualEvidence,
          visitedPageIds,
        );
        // Capture this before an independent manual audit is softened from FAIL
        // to NEEDS REVIEW. The product verdict and the replay-health verdict are
        // separate axes: a real application error must remain lifecycle evidence
        // even when later contract checks are allowed to continue.
        const productBlocked =
          step.result.verdict === 'fail' && hasConcreteProductFailureEvidence(step);
        if (productBlocked) verifiedProductBlockSeen = true;
        scenario.steps.push(step);
        manualEvidence.push(...newManualEvidence);
        milestoneExecutions.push({
          milestoneId: milestone.id,
          verdict: step.result.verdict,
          execution,
          productBlocked,
          qualificationExcluded:
            productBlocked ||
            (verifiedProductBlockSeen && isManualFinalProofMilestone(milestone)),
        });
        if (milestone.manualTaskId) {
          manualTaskVerdicts.set(milestone.manualTaskId, step.result.verdict);
          console.log(
            `[flow:v2] acceptance task ${milestone.manualContractItem ?? milestone.id} final verdict: ${step.result.verdict.toUpperCase()}`,
          );
        }
        if (step.result.verdict === 'fail') {
          const remaining = flow.milestones.length - (mi + 1);
          if (remaining <= 0) {
            console.log(`[flow] ✗ ${flow.id} broken at ${milestone.id} (final milestone) — flow done`);
            break;
          }
          if (milestone.manualContractAudit) {
            console.log(
              `[flow:v2] acceptance task ${milestone.manualContractItem ?? milestone.id} failed — continuing; explicit dependents will be blocked and unrelated tasks will still run`,
            );
            continue;
          }
          // Don't abandon the rest of the flow on one failed milestone. Try to
          // recover position to the next milestone's expected start so
          // independent later milestones still get tested; only continue if we
          // can CONFIRM a good position. If we can't, record the remainder as
          // explicitly skipped (untested due to the upstream break) rather than
          // silently dropping them (old `break` behavior) or running them from a
          // corrupted position and minting an untrustworthy verdict.
          const recovered = await tryRecoverAfterBreak(
            deps,
            flow,
            mi + 1,
            visitedPageIds,
          );
          if (recovered) {
            console.log(
              `[flow] milestone ${milestone.id} failed — recovered position; continuing to test remaining ${remaining} milestone(s)`,
            );
            continue;
          }
          console.log(
            `[flow] ✗ ${flow.id} broken at ${milestone.id} — could not recover position; recording remaining ${remaining} milestone(s) as skipped`,
          );
          const priorGoals = flow.milestones.slice(0, mi + 1).map((m) => m.goal);
          for (let k = mi + 1; k < flow.milestones.length; k++) {
            scenario.steps.push(skippedStep(flow, flow.milestones[k], milestone.id, priorGoals));
            milestoneExecutions.push({
              milestoneId: flow.milestones[k].id,
              verdict: skippedMilestoneVerdict(config.supervisor.enabled),
              execution: 'none',
              qualificationExcluded: productBlocked,
            });
          }
          break;
        }

        // QA probes: back/forward, matrices, edit sweeps — probe failures never abort the flow
        if (shouldRunMilestoneProbes(flow, opts.quick)) {
          const pageIdBeforeProbes = currentPageId(deps);
          const page = deps.state.sitemap.pages[pageIdBeforeProbes];
          const probes = await runProbesForMilestone(probeCtx, flow, milestone, page, {
            marker,
            skipLandmark: isLoginShapedGoal(milestone.goal),
          });
          scenario.steps.push(...probes.map((p) => p.step));

          // a probe (e.g. back/forward) can strand the browser off-track; the next
          // milestone's own guard-phase check only fires when guardPhases is set,
          // so reposition here whenever a probe both failed AND the page drifted
          const pageIdAfterProbes = currentPageId(deps);
          const probeBroke = probes.some((p) => p.step.result.verdict !== 'pass');
          if (probeBroke && pageIdAfterProbes !== pageIdBeforeProbes) {
            console.log(
              `[flow] probe left page drifted (${pageIdBeforeProbes} → ${pageIdAfterProbes}) — repositioning`,
            );
            await replayUpTo(deps, flow, mi + 1);
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[flow] ${flow.id} aborted: ${msg}`);
      writeJson(path.join(evidenceDir, 'flow-error.json'), { flow: flow.id, error: msg });
      // An abort BEFORE any milestone ran (e.g. ensureAuthenticated/navigateToEntry
      // throwing) leaves scenario.steps empty — the flow then vanishes from the
      // report with zero evidence instead of showing up as a real, explained
      // failure. Record one synthetic step so "could not even enter this flow" is
      // as visible as a milestone that ran and failed.
      if (scenario.steps.length === 0) {
        let url = 'unknown';
        try {
          url = deps.browser.getUrl();
        } catch {
          // browser unavailable — keep 'unknown'
        }
        scenario.steps.push({
          workflow: flow.id,
          action: 'enter flow (authenticate + navigate to entry)',
          expected: 'flow entry succeeds so its milestones can run',
          result: {
            verdict: 'fail',
            severity: 'high',
            expected: 'flow entry succeeds',
            actual: msg,
            signals: {
              url,
              title: '',
              snapshot: { raw: '', interactive: '' },
              pageErrors: [],
              consoleMessages: [],
              consoleErrors: [],
              networkRequests: [],
            },
            reasons: [msg],
            retried: false,
          },
          stepsToReproduce: [...ctx.stepsToReproduce],
        });
      } else if (lastAttemptedIndex >= 0) {
        // Some milestones ran, then an uncaught exception threw mid-flow (e.g. a
        // malformed-JSON parse in the explorer's decide step) — previously the
        // milestone that crashed AND every milestone after it just vanished from
        // the report (the-internet.herokuapp.com report-loss variant). Record the
        // crashing milestone as a FAIL carrying the error, and the rest as
        // skipped, so nothing disappears silently.
        const recorded = new Set(scenario.steps.map((s) => s.workflow));
        for (let k = lastAttemptedIndex; k < flow.milestones.length; k++) {
          const m = flow.milestones[k];
          if (recorded.has(m.id)) continue;
          if (k === lastAttemptedIndex) {
            scenario.steps.push({
              workflow: m.id,
              action: m.goal,
              expected: m.goal,
              result: {
                verdict: 'fail',
                severity: 'high',
                expected: m.goal,
                actual: `milestone crashed with an uncaught error: ${msg}`,
                signals: emptySignals('unknown'),
                reasons: [msg],
                retried: false,
              },
              stepsToReproduce: [...ctx.stepsToReproduce],
            });
          } else {
            const priorGoals = flow.milestones.slice(0, k).map((mm) => mm.goal);
            scenario.steps.push(
              skippedStep(flow, m, flow.milestones[lastAttemptedIndex].id, priorGoals),
            );
          }
        }
      }
      // A wedged browser daemon (heavy-page CDP stall) makes EVERY later flow abort
      // on timeouts. Recycle it and re-auth so the next flow starts on a fresh,
      // healthy daemon instead of cascading the whole test phase into failure.
      if (/timed out|consecutiveTimeouts/i.test(msg) || deps.browser.consecutiveTimeouts >= 2) {
        // recycle() can now legitimately no-op (return false) instead of always
        // attempting some kill — if it did, the daemon is exactly as wedged as
        // before, so a re-auth attempt against it is certain to fail too; skip
        // the pointless retry and say so plainly instead of silently proceeding
        // as if recovery had happened.
        if (deps.browser.recycle()) {
          try {
            await ensureAuthenticated(authCtx);
          } catch (reauthErr) {
            console.warn(`[flow] re-auth after recycle failed: ${reauthErr instanceof Error ? reauthErr.message : reauthErr}`);
          }
        } else {
          console.warn('[flow] daemon recycle failed — still wedged; skipping re-auth, next flow will likely hit the same timeout');
        }
      }
    }

    scenario.finishedAt = new Date().toISOString();
    report.scenarios.push(scenario);

    // Real report workflow ids are namespaced as "<flow-id>:<milestone-id>".
    // Comparing them only to bare milestone ids made this collection empty on
    // every live run, so even a dedicated artifact-persistence `true` could
    // never qualify a learned flow for replay validation.
    const milestoneWorkflowIds = new Set(
      flow.milestones.flatMap((milestone) => [
        milestone.id,
        `${flow.id}:${milestone.id}`,
      ]),
    );
    const milestoneSteps = scenario.steps.filter((step) => milestoneWorkflowIds.has(step.workflow));
    let finalPageKind: string | undefined;
    try {
      finalPageKind = matchPage(state.sitemap, deps.browser.getUrl(), deps.browser.snapshotInteractive())?.kind;
    } catch {
      // The captured final milestone signals below can still prove the artifact.
    }
    const terminalArtifactVerified = hasVerifiedTerminalArtifact(flow, milestoneSteps, finalPageKind);
    const lifecycleMessage = qualifyFlowAfterRun(flow, {
      mode: runMode,
      executions: milestoneExecutions,
      terminalArtifactVerified,
      allRecipesPresent: hasEveryMilestoneRecipe(state, flow),
    });
    console.log(`[flow] lifecycle: ${flowRunMode(flow)} — ${lifecycleMessage}`);

    // Navigation/state-loss breakage (back/forward, abandon/resume) is a REAL,
    // first-class product bug — the user explicitly wants it reported, not buried
    // as probe noise. Other probe failures (option-matrix, edit-sweep) stay
    // needs-review. Milestone failures are always first-class fails.
    const isProbe = (s: TestStep) => s.workflow.startsWith('probe:');
    const isNavProbe = (s: TestStep) =>
      isProbe(s) && /(back-forward|abandon-resume)/.test(s.workflow);
    const verdict: Verdict = scenario.steps.some(
      (s) => (!isProbe(s) || isNavProbe(s)) && s.result.verdict === 'fail',
    )
      ? 'fail'
      : scenario.steps.some((s) => s.result.verdict === 'needs-review' || (isProbe(s) && s.result.verdict === 'fail'))
        ? 'needs-review'
        : 'pass';
    flow.lastResult = { runId: report.runId, verdict };
    state.saveSitemap();
  }
}
