import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import { randomEditMarker } from '../core/edits.js';
import type { Explorer, ExplorerResult } from '../core/explorer.js';
import { patchStepSummaryVerdict, writeJson } from '../core/evidence.js';
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
import { looksLikeAuthGate, looksLikeSoft404 } from './page-classifier.js';

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
      `Flow "${flow.title}" needs to start on an unauthenticated page (${firstGuardPhases.join('/')}) but the session is currently logged in (likely left over from an earlier flow). Paste the exact label of a "Logout"/"Sign out" control to click, or "none" if there's no way to log out.`,
      { default: 'none' },
    );
    const label = answer.trim();
    sitemap.learnedLogoutControl = label && label.toLowerCase() !== 'none' ? label : 'none';
    deps.state.saveSitemap();
  }
  if (sitemap.learnedLogoutControl && sitemap.learnedLogoutControl !== 'none') {
    const nav = new Nav(deps.browser);
    const stillAuthed = () => !firstGuardPhases.includes(currentPageId(deps));
    // The click is `optional` (never throws) and some sites hide the actual
    // control inside a collapsed user-menu the first click only opens — verify
    // it actually landed us on the expected anon page before trusting it, one
    // retry, rather than silently declaring success on a no-op click.
    nav.click({ label: sitemap.learnedLogoutControl, optional: true });
    deps.browser.wait(1500);
    if (!stillAuthed()) return true;
    deps.browser.wait(800);
    nav.click({ label: sitemap.learnedLogoutControl, optional: true });
    deps.browser.wait(1500);
    if (!stillAuthed()) return true;
    console.warn(
      `[flow] logout control "${sitemap.learnedLogoutControl}" didn't change page state — ` +
        `still looks authenticated (it may be hidden inside a menu that needs opening first)`,
    );
    return false;
  }
  return false;
}

/**
 * Some create/upload entry points resume prior state (e.g. Koyal's "Create Your
 * Next Video" always resumes the last draft) instead of landing where entry
 * navigation should. Ask once for the label of a "start fresh" control, persist
 * it on the flow (or persist "none" to stop asking), and apply it going forward.
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

  if (flow.entry.freshEntryHint) {
    if (flow.entry.freshEntryHint !== 'none') {
      new Nav(deps.browser).click({ label: flow.entry.freshEntryHint, optional: true });
      deps.browser.wait(1500);
    }
    return;
  }

  const hereId = currentPageId(deps);
  if (hereId === expectedEntryPageId || hereId === 'unknown') return;

  const answer = await deps.interact.ask(
    `Flow "${flow.title}" entry landed on "${hereId}", not the expected first step "${expectedEntryPageId}" — ` +
      `looks like it resumed stale state (e.g. a draft). Paste the exact label of a "start fresh/new" control to click here, or "none" if this is expected.`,
    { default: 'none' },
  );
  const label = answer.trim();
  flow.entry.freshEntryHint = label && label.toLowerCase() !== 'none' ? label : 'none';
  deps.state.saveSitemap();
  if (flow.entry.freshEntryHint !== 'none') {
    new Nav(deps.browser).click({ label: flow.entry.freshEntryHint, optional: true });
    deps.browser.wait(1500);
  }
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
 * Milestone goals never carry secrets, so the generic explorer can only guess
 * credentials — or worse, type the run marker into the password field ("Epic
 * sadface"). Positive-path auth milestones must route through the auth module.
 * Negative-path goals (invalid/empty credentials) stay with the explorer.
 */
function isLoginShapedGoal(goal: string): boolean {
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
  const wantsAuth =
    /\b(log ?in|sign ?in)\b/i.test(unquoted) ||
    (/\b(enter|fill|type|submit)\b/i.test(unquoted) &&
      (/\bcredentials?\b/i.test(unquoted) || (/\busername\b/i.test(unquoted) && /\bpassword\b/i.test(unquoted))));
  const negativePath = /\b(invalid|wrong|incorrect|bad|empty|blank|missing|error|fail)/i.test(goal);
  return wantsAuth && !negativePath;
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

async function runMilestone(
  deps: FlowRunnerDeps,
  flow: Flow,
  milestone: FlowMilestone,
  milestoneIndex: number,
  ctx: StepContext,
  authCtx: AuthContext,
): Promise<{ step: TestStep; marker?: string }> {
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
      console.log(`[flow] off-track (on "${pageId}", expected ${milestone.guardPhases.join('/')}) — replaying up to this milestone`);
      await replayUpTo(deps, flow, milestoneIndex);
    }
  }

  browser.clearSignals();
  const verification = ctx.verification;
  const before = await verification.captureSignals();

  // fill in run-unique edit markers so edits are real and verifiable — only for
  // explicit edit milestones (a 'create' click may involve no text field at all)
  const loginShaped = isLoginShapedGoal(milestone.goal);
  const searchShaped = isSearchShapedGoal(milestone.goal);
  const selectionShaped = isSelectionShapedGoal(milestone.goal);
  let goal = milestone.goal;
  let marker: string | undefined;
  if (milestone.kind === 'edit' && !loginShaped && !searchShaped && !selectionShaped) {
    marker = randomEditMarker('autoqa');
    goal = `${goal}\nWhen entering test text, use exactly: "${marker}"`;
  } else if (searchShaped) {
    goal = `${goal}\nUse a real, generic search term likely to match existing content (e.g. a common product/category word) — NOT a random or made-up string.`;
  }

  const recipeId = `flow:${flow.id}:${milestone.id}`;
  let explored: ExplorerResult | null = null;
  let replayOk = false;

  if (loginShaped) {
    console.log('[flow] auth milestone — delegating to the auth module');
    try {
      await ensureAuthenticated(authCtx);
      replayOk = true; // authenticated; verification below judges the milestone
    } catch (err) {
      console.log(`[flow] auth milestone failed: ${err instanceof Error ? err.message : err}`);
    }
  } else if (player.has(recipeId)) {
    const replay = await player.tryReplay(recipeId, {
      pageId,
      secrets: { email: state.secrets.email, password: state.secrets.password },
    });
    replayOk = replay.ok;
  }

  if (!replayOk && !loginShaped) {
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
  // a login-shaped milestone that authenticated successfully proves itself via
  // ensureAuthenticated() above, not via a login-page landmark that may never
  // reappear when the session silently restores — drop the literal-text check
  // so the milestone is judged on the generic error/console/5xx signals instead.
  if (loginShaped && replayOk) {
    delete base.snapshotIncludesAny;
  }
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
    explorerSteps: explored?.stepsTaken,
  });
  if (explored) step.explorerSteps = explored.stepsTaken;

  // recordVerifiedStep() already wrote step-summary.md to disk with THIS verdict
  // and printed it — but everything below (explorer-failure downgrade, KB
  // verdict flip, human escalation) can still change step.result.verdict in
  // memory. Remember what was actually persisted so we can patch the file back
  // into agreement once the verdict is truly final (see patchStepSummaryVerdict).
  const writtenVerdict = step.result.verdict;
  const writtenReasons = [...step.result.reasons];

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
  if (explorerFailureDowngrade && explored) {
    step.result.verdict = 'needs-review';
    step.result.reasons.push(
      `Explorer did not confirm goal completion: ${explored.error ?? 'unknown reason'}`,
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
      if ((reVerdict === 'pass' && !(explorerFailureDowngrade && !successSeen)) || (reVerdict !== 'fail' && successSeen)) {
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
      // Nothing has navigated anywhere for THIS flow yet at this point — the
      // browser is wherever the PREVIOUS flow left it, which is unrelated to
      // whether this flow's own entry requires login. Don't trust an incidental
      // login-shaped page left over from that prior flow (see trustCurrentGate's
      // doc comment in auth.ts for the confirmed live false-positive this fixes).
      await ensureAuthenticated(authCtx, { trustCurrentGate: false });
      await navigateToEntry(deps, flow);
      await applyFreshEntryHint(deps, flow);

      const probeCtx: ProbeContext = {
        browser: deps.browser,
        state: deps.state,
        nav: new Nav(deps.browser),
        statements: deps.statements,
        stepCtx: ctx,
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
        const aheadIdx = isEntryPage
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
        const { step, marker } = await runMilestone(deps, flow, milestone, mi, ctx, authCtx);
        scenario.steps.push(step);
        if (step.result.verdict === 'fail') {
          console.log(`[flow] ✗ ${flow.id} broken at ${milestone.id} — moving to next flow`);
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
      }
      // A wedged browser daemon (heavy-page CDP stall) makes EVERY later flow abort
      // on timeouts. Recycle it and re-auth so the next flow starts on a fresh,
      // healthy daemon instead of cascading the whole test phase into failure.
      if (/timed out|consecutiveTimeouts/i.test(msg) || deps.browser.consecutiveTimeouts >= 2) {
        deps.browser.recycle();
        try {
          await ensureAuthenticated(authCtx);
        } catch (reauthErr) {
          console.warn(`[flow] re-auth after recycle failed: ${reauthErr instanceof Error ? reauthErr.message : reauthErr}`);
        }
      }
    }

    scenario.finishedAt = new Date().toISOString();
    report.scenarios.push(scenario);

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
