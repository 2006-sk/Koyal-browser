import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import { randomEditMarker } from '../core/edits.js';
import type { Explorer, ExplorerAction, ExplorerResult } from '../core/explorer.js';
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
import { recordFromExplorer, type RecipePlayer } from './recipes.js';
import { Nav } from '../core/nav.js';
import type { Interact } from './interact.js';
import type { SiteState } from './site-state.js';
import { matchPage, type Flow, type FlowMilestone } from './sitemap.js';
import { looksLikeAuthGate, looksLikeSoft404 } from './page-classifier.js';
import type { LlmClient } from '../core/llm/client.js';
import { resolveHumanFieldValue } from './field-values.js';
import {
  flowRunMode,
  hasEveryMilestoneRecipe,
  hasVerifiedTerminalArtifact,
  isRunnableFlow,
  qualifyFlowAfterRun,
  type FlowRunMode,
  type MilestoneExecution,
} from './flow-lifecycle.js';

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
    if (currentPageId(deps) === flow.entry.pageId && !looksLikeSoft404(browser.snapshotInteractive())) return;
    console.log(
      `[flow] pinned entry url for "${flow.entry.pageId}" looks stale — falling back to LLM navigation`,
    );
  }
  const entryPage = state.sitemap.pages[flow.entry.pageId];
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
 * NOTE: the expected post-entry-navigation page is `flow.entry.pageId` — "the page
 * id where the flow starts" (see page-classifier.ts's entryPageId prompt field) —
 * NOT `flow.milestones[0].guardPhases`. Those two coincide only for deep-walked
 * flows, where milestone 1 acts ON the already-reached entry page. For the far
 * more common case of an LLM-proposed flow whose milestone 1 is itself a
 * *navigation* step (goal: "click X to reach Y"), guardPhases holds Y — the
 * DESTINATION milestone 1 is about to create, not the page entry navigation
 * alone should have already produced. Comparing against guardPhases there
 * always mismatches (since nothing has navigated to Y yet), asking a bogus
 * "did this resume stale state?" question on the very first run of virtually
 * every non-deep-walked flow on any site.
 */
async function applyFreshEntryHint(deps: FlowRunnerDeps, flow: Flow): Promise<void> {
  // page-classifier.ts sets entry.pageId from the LLM's JSON directly (defaulting
  // to '' if the LLM omitted entryPageId) — the old guardPhases-based check ran
  // even in that case, so skipping entirely here would leave a flow with zero
  // draft-resume protection instead of the weaker-but-nonzero prior fallback.
  // Only fall back to milestones[0].guardPhases when milestone 1 is NOT a
  // navigate-type step — that's the exact condition under which guardPhases[0]
  // legitimately describes the entry page itself rather than a destination
  // milestone 1 hasn't reached yet (the original bug this function fixes).
  const firstMilestone = flow.milestones[0];
  const expectedEntryPageId =
    flow.entry.pageId ||
    (firstMilestone?.kind !== 'navigate' ? firstMilestone?.guardPhases?.[0] : undefined);
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

function requiresPersistedCreation(flow: Flow, milestone: FlowMilestone): boolean {
  const context = `${flow.id} ${flow.title} ${flow.description} ${milestone.goal}`;
  if (milestone.kind === 'edit') {
    // Do not inherit broad words from the FLOW title (e.g. every transcript
    // edit lives inside "Create video"). Only this milestone's own wording can
    // make an edit responsible for persisted creation.
    return /character|asset|outfit|avatar|generate|regenerate|finalize/i.test(milestone.goal);
  }
  return (
    milestone.kind === 'create' &&
    /complete (?:adding|creation)|submit|generate|regenerate|try outfit|finalize|save|create video|render/i.test(milestone.goal)
  );
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

/** Rebuild flow position by replaying prior milestones' recipes from the entry. */
async function replayUpTo(deps: FlowRunnerDeps, flow: Flow, milestoneIndex: number): Promise<void> {
  await navigateToEntry(deps, flow);
  for (let j = 0; j < milestoneIndex; j++) {
    const recipeId = `flow:${flow.id}:${flow.milestones[j].id}`;
    if (!deps.player.has(recipeId)) continue;
    await deps.player.tryReplay(recipeId, {
      pageId: flow.milestones[j].guardPhases?.[0],
      secrets: { email: deps.state.secrets.email, password: deps.state.secrets.password },
    });
  }
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
 * A synthetic step recording that a milestone was NOT tested because an upstream
 * milestone failed and its position could not be recovered to test this one
 * independently. Verdict is `needs-review` (honest: neither a pass nor a real
 * failure of THIS milestone — it simply never ran), with empty signals so the
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
  return {
    workflow: milestone.id,
    action: milestone.goal,
    expected: milestone.goal,
    result: {
      verdict: 'needs-review',
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
): Promise<boolean> {
  const next = flow.milestones[nextIndex];
  const guards = next?.guardPhases;
  // No guardPhases on the next milestone → we have no reliable way to confirm the
  // post-failure position is the one it expects, so we can't safely continue.
  if (!guards?.length) return false;
  if (guards.includes(currentPageId(deps))) return true;
  // Rebuild position by replaying prior milestones' recipes — only meaningful when
  // at least one exists (else replayUpTo strands us at the flow entry, per
  // hasAnyPriorRecipe's doc comment).
  if (hasAnyPriorRecipe(deps, flow, nextIndex)) {
    try {
      await replayUpTo(deps, flow, nextIndex);
    } catch {
      return false;
    }
    if (guards.includes(currentPageId(deps))) return true;
  }
  return false;
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
function isSelectionShapedGoal(goal: string): boolean {
  return (
    /\b(select|choose|checkbox|dropdown|combobox|toggle|checked|radio|option)\b/i.test(goal) &&
    !/\b(type|enter|fill|write|comment|note|instructions?|feedback|message|describe|explain|details?)\b/i.test(goal)
  );
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
      /page error|console error|unexpected.*5\d\d|blank (?:page|screen)|should not include|persist|visible error/i.test(reason) &&
      !reason.startsWith('Expected snapshot to include'),
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
): Promise<{ step: TestStep; marker?: string; execution: MilestoneExecution['execution'] }> {
  const { browser, state, player, statements, interact } = deps;
  const decisionsBefore = interact.decisions.length;
  let pageId = currentPageId(deps);

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
    pageId = currentPageId(deps);
  }

  // guard-phase check: poll first (processing lag ≠ off-track — restarting a wizard
  // from its entry mid-flow destroys the walk), then recover by REBUILDING position
  // (entry alone is not enough — probes/aborts can strand us anywhere)
  if (milestone.guardPhases?.length && !milestone.guardPhases.includes(pageId) && pageId !== 'unknown') {
    pageId = waitForGuardPhase(deps, milestone.guardPhases, 30000);
    if (!milestone.guardPhases.includes(pageId)) {
      if (hasAnyPriorRecipe(deps, flow, milestoneIndex)) {
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
    pageId = currentPageId(deps);
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
  let goal = milestone.goal;
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
    const recordedFillValue = existingRecipe?.steps
      .filter((s) => s.kind === 'fill' && !s.secretRef)
      .map((s) => (s as { value: string }).value)
      .pop();
    const fieldHint = fillFieldHintFromGoal(milestone.goal);
    if (fieldHint) {
      marker = await resolveHumanFieldValue(
        state,
        deps.interact,
        pageId,
        fieldHint,
        milestone.seedValue ?? recordedFillValue ?? defaultCreationValue(milestone.goal),
      );
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
  let execution: MilestoneExecution['execution'] = 'none';
  const forceExplore = runMode === 'learning';

  if (loginShaped) {
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
  } else if (!forceExplore && player.has(recipeId) && (!creationMustPersist || hasCompletionAction(null, state.recipes[recipeId]))) {
    const replay = await player.tryReplay(recipeId, {
      pageId,
      secrets: { email: state.secrets.email, password: state.secrets.password },
    });
    replayOk = replay.ok;
    if (replayOk) execution = 'replay';
  } else if (!forceExplore && player.has(recipeId) && creationMustPersist) {
    console.log('[flow] ignoring stale creation recipe: it never recorded Create/Generate/Finalize/Save');
  } else if (forceExplore && player.has(recipeId)) {
    console.log('[flow] exploratory learning mode — bypassing the saved recipe and using LLM exploration');
  }

  if (!replayOk && !loginShaped) {
    execution = 'explore';
    explored = await deps.explorer.achieveGoal(goal);
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
      explored = await deps.explorer.achieveGoal(goal);
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

  const step = await recordVerifiedStep(ctx, {
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
  });
  if (explored) step.explorerSteps = explored.stepsTaken;

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
  const visualConcernDowngrade = step.result.visualAssessment?.status === 'concern';
  const creationCompletionMissing = creationMustPersist && !hasCompletionAction(explored, state.recipes[recipeId]);
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
        (reVerdict === 'pass' && !(explorerFailureDowngrade && !successSeen) && !visualConcernDowngrade && !creationCompletionMissing && !creationVisuallyUnproven && !loginFailureDowngrade) ||
        (reVerdict !== 'fail' && successSeen && !visualConcernDowngrade && !creationCompletionMissing && !creationVisuallyUnproven && !loginFailureDowngrade)
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
    if (step.result.verdict === 'needs-review' && !automationBlockedWithoutProductEvidence) {
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

    step.humanDecisions = interact.decisions.slice(decisionsBefore);

    // success + explored → cache the recipe for next time
    if (step.result.verdict === 'pass' && explored?.success) {
      recordFromExplorer(state, recipeId, explored, {
        secrets: { email: state.secrets.email, password: state.secrets.password },
        successCheck:
          !humanRejectedSuccessHint && milestone.successHint && isLiteralHint(milestone.successHint)
            ? { snapshotAnyOf: [milestone.successHint] }
            : undefined,
        fallbackFieldHint: fieldHintForRecipe,
      });
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

  return { step, marker, execution };
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
        const hereId = currentPageId(deps);
        // Only guard the exact scenario above: the FIRST check (mi===0), right after
        // fresh entry navigation, before anything has run. For any LATER check
        // (mi>0), landing back on entry.pageId can legitimately BE a resumed later
        // milestone's position (not just the unstarted flow start) — unconditionally
        // disabling fast-forward for every iteration would block that legitimate case.
        const isEntryPage = mi === 0 && hereId !== 'unknown' && hereId === flow.entry.pageId;
        const aheadIdx = runMode !== 'deterministic' || isEntryPage
          ? -1
          : flow.milestones.findIndex((m, j) => j > mi && m.guardPhases?.includes(hereId));
        if (aheadIdx > mi && hereId !== 'unknown' && !milestone.guardPhases?.includes(hereId)) {
          console.log(
            `[flow] resumed mid-wizard on "${hereId}" — fast-forwarding ${aheadIdx - mi} milestone(s)`,
          );
          mi = aheadIdx - 1;
          continue;
        }

        ctx.stepsToReproduce.push(milestone.goal);
        lastAttemptedIndex = mi;
        const { step, marker, execution } = await runMilestone(deps, flow, milestone, mi, ctx, authCtx, runMode);
        scenario.steps.push(step);
        milestoneExecutions.push({ milestoneId: milestone.id, verdict: step.result.verdict, execution });
        if (step.result.verdict === 'fail') {
          const remaining = flow.milestones.length - (mi + 1);
          if (remaining <= 0) {
            console.log(`[flow] ✗ ${flow.id} broken at ${milestone.id} (final milestone) — flow done`);
            break;
          }
          // Don't abandon the rest of the flow on one failed milestone. Try to
          // recover position to the next milestone's expected start so
          // independent later milestones still get tested; only continue if we
          // can CONFIRM a good position. If we can't, record the remainder as
          // explicitly skipped (untested due to the upstream break) rather than
          // silently dropping them (old `break` behavior) or running them from a
          // corrupted position and minting an untrustworthy verdict.
          const recovered = await tryRecoverAfterBreak(deps, flow, mi + 1);
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
          }
          break;
        }

        // QA probes: back/forward, matrices, edit sweeps — probe failures never abort the flow
        if (!opts.quick) {
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

    const milestoneSteps = scenario.steps.filter((step) => flow.milestones.some((m) => m.id === step.workflow));
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
    console.log(`[flow] lifecycle: ${flow.status} — ${lifecycleMessage}`);

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
