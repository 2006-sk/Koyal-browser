# autoqa task tracker

Persistent, cross-session task list for the autoqa project. **Read this first, before CLAUDE.md's prose**, at the start of any session — Claude Code's built-in TaskCreate/TaskList tool is scoped to one session and invisible across jobs, so anything tracked only there is lost the moment that session ends or crashes. This file is the single source of truth for open work; update it directly (check items off, add new ones, don't let CLAUDE.md's prose accumulate more ad-hoc "task #N" mentions — link back here instead).

IDs here are unique by construction. CLAUDE.md's own historical numbering is **not** reliable — #14 and #16 were each independently reused for two unrelated things by different sessions before this file existed. Where a task below descends from one of those prose mentions, the old number is noted for continuity, but the ID in this file is canonical.

Full narrative/evidence for anything here lives in CLAUDE.md (search by date or task ID) — this file is deliberately terse; don't duplicate the write-up, just enough to act on and a pointer.

---

## Open — priority order

### #16-live — validate task #17 on a real login-gated site
`loginFailureDowngrade` (task #17, shipped 2026-07-16, commit `c13c7e4`) is only validated by code-review + saucedemo no-regression — a clean-auth koyal run never proposes a login-shaped milestone, so the actual downgrade-on-silent-failure branch has never fired live. Run against lambdatest / expandtesting / webdriveruniversity (all have real login-gated flows in history) and confirm a genuinely-failed login gets `needs-review`, not a false `pass`.
*(Old prose called this "task #16" on 2026-07-17 — collides with the already-shipped Slack-integration #16 from 2026-07-16. Disambiguated here as #16-live.)*

### #14-vision — investigate whether vision closes the koyal upload-recognition slowness
The explorer sometimes loops ~5 retries before recognizing an upload already succeeded (self-resolves on the last budget step, not a hard failure, but wastes budget). Suspected fix: feed a screenshot into the stuck-retry path so the model can see the uploaded-filename/enabled-Next-button state directly instead of parsing an ambiguous "0.00 MB" size string from the accessibility tree. Tie into #6/#12 below rather than a one-off patch.
*(Old prose called this "task #14" on 2026-07-17 — collides with the earlier #14 "blank-page recovery doesn't verify authenticated landing" from 2026-07-15/16, which is tracked separately below as #14-blankpage.)*

### #6 / #12 — architecture: feed screenshots into verification as a second signal
Discussed at length 2026-07-15; not yet designed in code. The a11y-tree/DOM/console/network-only oracle is structurally blind to visual-only bugs (invisible text, layout breakage, mis-styled controls) and to click-occlusion (ad iframes, cookie banners covering the real target). Design: (a) occlusion/action-grounding during exploration can stay selective (only when stuck/retrying); (b) the bug-detection/verification-oracle use must be systematic (every milestone) or it won't catch what the a11y tree structurally can't see. **Hard guardrail: vision must never autonomously flip a deterministic pass↔fail — only feed the existing needs-review/human-escalation path** (motivated directly by a verdict-flip false-PASS bug found the same session). autoqa already screenshots every step, so this is wiring, not new capture infra.

### #14-blankpage — blank-page recovery doesn't verify it landed on the *authenticated* page
Found 2026-07-15 on koyal. Both the deep-walker's and `core/explorer.ts`'s `about:blank` recovery paths just reopen a URL and move on without checking it's the *expected authenticated* page — twice in one run this landed on `/login` mid-walk instead, driving the explorer into an unwinnable fake-signup + unguessable-OTP loop before the walk-level "no progress after 3 attempts" bound caught it. The existing auth-wall check only fires at flow **entry**, not mid-walk. Fix: make the recovery verify landing state, not just that *a* page loaded.

### #auth-gate-convergence — auth-gate detection is still not converged (standing watch-item, not a discrete fix)
Second-highest-value recurring bug source in this project's history (`normalizePath`/`matchPage` is #1). Patched in nearly every batch since ParaBank (missing accessible-name password field → expandtesting demo-page-name false-positive → automationintesting unconditional-Logout-label trust → lambdatest cross-flow contamination → webdriveruniversity heading-count false-positive + a duplicate bypass → automationintesting's bare-"login"-in-a-verify-goal misroute) with a new failure mode nearly every time. If a future site's flow keeps re-authenticating unnecessarily or silently skips a real login milestone, suspect `looksLikeAuthGate`/`hasVisiblePasswordInput`/`isLoginShapedGoal` first. Consider a structural rework rather than another one-off patch next time it recurs.

### #off-origin-replay-guard — `Explorer.achieveGoal()` has no off-origin guard during milestone execution or flow replay
Real safety gap, found 2026-07-15 on globalsqa (ad interstitial led a click off-site twice, caught only reactively) and GreenKart (a "JOIN NOW" button drove a real 3-hop redirect all the way to a live Teachable checkout page with a real order ID and **zero guard prompt raised** — `guard.ts`'s destructive-keyword floor doesn't cover join/enroll/subscribe, AND the off-origin guard that exists only lives in `crawler.ts`/`deep-walker.ts`'s exploration-time edge mapping, never in the replay/test path). Fix: port the same `isOffOrigin` guard `deep-walker.ts` already has into `Explorer.achieveGoal()`'s milestone/replay path. Until fixed, treat any payment/subscription-adjacent flow on a new site with suspicion — de-approve if in doubt (already done for GreenKart's `subscription-plan-selection`).

### #logout-guard-override — `guard.ts`'s `LOGOUT_RE` has no override path at all
Found 2026-07-15. Every other destructive-action keyword can be allowlisted `always`/`never`; a Logout click is auto-denied unconditionally. Makes any flow whose explicit milestone goal is "click Logout" structurally unpassable, permanently, on any site. Distinct from the already-fixed (2026-07-16) "logout hidden in a dropdown" discovery problem.

### #koyal-fresh-project — Koyal draft-per-account contention needs a fresh-project-per-run entry strategy
Long-standing, most recently cost 20+ minutes on 2026-07-15 (a resumed draft caused 5 repeated doomed-upload CLI prompts) and blocked clean Audio-path coverage again on 2026-07-17. Drafts are account-scoped, not session-scoped, so manual investigation and automated runs against the same account collide too. Needs an explicit "start a genuinely fresh project" entry path, not just the reactive `applyFreshEntryHint` ask-once prompt (which only fires once you're already stuck on a resumed draft).

### #initial-login-retry — initial login has no retry-once on a transient failure
Found 2026-07-16. `commands/explore.ts` wraps the pre-crawl `ensureAuthenticated()` in a try/catch that logs a warning and continues UNAUTHENTICATED on ANY failure, including a transient one (observed: an Anthropic 529). Starves the whole crawl/flow-proposal off a near-empty map. Fix: retry the initial `ensureAuthenticated()` once (or with backoff) before giving up.

### #statement-kb-batching — statement-KB flags every item on a listing page as its own classify question
Confirmed inefficient (not incorrect) on 3+ sites (GreenKart's ~25-item catalog, lambdatest's product listings, webdriveruniversity's ~30-widget page). Always correctly classified noise so far, but a real human-in-the-loop efficiency problem. Worth batching same-shaped repeated candidates into one round-trip instead of one per item.

### #flow-runner-anomaly-tags — structured per-milestone anomaly tagging
Design discussed 2026-07-15, not built. Add a tag (`overachievement`/`session-leak`/`off-site`/`upstream-break`/`repositioned`/`crash-recovered`) separate from the pass/fail/needs-review/skipped verdict, so a report shows *why* a milestone is unusual instead of requiring someone to read six step-summaries by hand. Also needs an "is this milestone's goal already satisfied by current state" pre-check for the LLM-overachievement case (distinct from the existing fast-forward-to-a-later-page mechanism, which doesn't apply when overachievement lands *past* the last milestone).

### #koyal-wizard-landmark — Koyal's own wizard sidebar over-matches as a page landmark
Live-reproduced 2026-07-15: the `wizard-upload-file` classifier landmark (`snapshotAnyOf: ['Upload file', 'Story Type', 'Review transcript', 'Edit scenes']`) matches the wizard's persistent sidebar, visible on every step — can't distinguish "on the upload step" from "anywhere in the wizard." Drove ~12 doomed upload attempts in one run. Same "chrome landmarks must never identify a state" disease as `normalizePath`'s collisions; needs a Koyal-specific landmark fix (probably: require a step-specific element, not just a sidebar item, in the detection signature).

### #prompt-dialog-value — native `prompt()` dialogs with a required specific typed value are only partially supported
Found 2026-07-13 on webdriveruniversity. `resolveBlockingDialog` resolves the block correctly but always accepts with an empty value, so a milestone whose verification depends on the exact typed text appearing would false-fail. Needs the pending dialog's message surfaced to the LLM's own decision loop — bigger than a one-off patch.

---

## Recently completed / shipped (context, not action items)

- **#15 — `parseJsonFromLlm` crash-the-whole-flow bug.** Fixed 2026-07-17 in worktree branch `worktree-fix-json-parse-crash`, commit `07d33f0`, draft PR [#2](https://github.com/2006-sk/Koyal-browser/pull/2) (not yet merged to `autoqa`). `client.ts`: extracts every brace-balanced candidate, prefers the LAST one that parses (recovers self-correction replies, skips a stray earlier brace). `explorer.ts`: `decideNextAction` retries once on parse/call failure, degrades to one contained `fail` step instead of an uncaught throw; `LlmBudgetExceededError` still propagates. xhigh code review (`wf_48ed55b0-0d5`) found 6 real defects in the first version (credential-redaction bypass, the retry's own unguarded 2nd LLM call, stale-object extraction, wrong-brace anchoring, an idempotent-skip regex collision, silent budget double-consumption) — all fixed in the same commit. 2 lower-severity findings (unify with `proposeFlows`' own retry pattern; retry-stacking with the LLM client's internal retries) left as follow-ups, not fixed. Validated: unit tests for every extraction scenario + mocked-LLM redaction/budget tests, plus a live saucedemo run where a genuine transient "fetch failed" hit both the attempt and the retry and degraded cleanly to one contained FAIL instead of crashing the flow.
- **#11 — flow-runner no longer silently drops milestones after a mid-flow FAIL.** Shipped + live-validated both branches 2026-07-16/17. Commit `c13c7e4`.
- **#17 — login-shaped-milestone false-PASS downgrade.** Shipped 2026-07-16, commit `c13c7e4`. Code-reviewed + no-regression only — see #16-live above for the still-needed live trigger.
- **Two-step logout (opener > logout) + auto-discovery.** Shipped 2026-07-16, commit `8d99b06`. Not yet re-confirmed on OrangeHRM's collapsed-dropdown case specifically.
- **Slack product-bug reporter.** Shipped 2026-07-16, commit `8d99b06`. Live-validated (posted only the 2 real S3 bugs from a 14-fail run, correctly excluded the rest).
- **Walk choice-memory + flow-proposal mode enumeration** (the "only tests the default mode" fix). Shipped 2026-07-16, validated live on filmarena.ai and (mode-coverage generalization) on koyal's 2026-07-17 run (a distinct Audio flow got proposed for the first time).
- **Duplicate-successHint dedup / soft-404 filtering / probe-breaks-position repositioning / Koyal draft "fresh entry" prompt** (5-file diff: `crawler.ts`, `flow-runner.ts`, `page-classifier.ts`, `probes.ts`, `sitemap.ts`). Validated 2026-07-17 on fresh-wipe saucedemo (47/3/1) + koyal (28/13/6) runs — no regressions, repositioning confirmed (no probe failure cascaded).

## Known, live, external — not autoqa bugs (context only)

- **koyal-s3-scene-generation-fetch** (Critical) — Koyal backend returns an HTML error page where JSON was expected during scene generation ("Failed to fetch JSON from S3: SyntaxError"). Documented in `autoqa/KNOWN_KOYAL_BUGS.md`. Reproduced 2026-07-09, 07-13, 07-16. **Not sighted on 2026-07-17's run — exploration never reached that step (bug-widget trap + budget), NOT evidence it's fixed.**
- **webdriveruniversity's Login Portal** genuinely cannot succeed — jQuery loaded over `http://` on an HTTPS page is blocked as mixed content, so the page's own `preventDefault` script never attaches and a native form submit always wins, reloading with an empty query string. Real site bug, not autoqa's.
- ParaBank backend has genuine intermittent concurrency/flakiness on login (same credentials succeed most of the time, fail occasionally even in single-session isolation) — not fixable client-side.
- practice.expandtesting.com's Register button is genuinely, repeatedly obstructed by a shifting ad iframe — real site accessibility issue.
