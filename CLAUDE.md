# happyflow — Koyal QA workspace + autoqa (autonomous site-agnostic QA agent)

This file is the session brain-dump: everything a fresh session needs to be as effective as the one that built this. Last updated 2026-07-07 (night — fresh-wipe validation runs of both sites + two autoqa fixes).

## What this repo is

Browser-QA workspace for **beta.koyal.ai** (AI filmmaking app: turns uploaded scripts/audio into videos). Layout quirk: the git root is `happyflow/`, with `login/` at top level and a NESTED `happyflow/` subdir holding `audio/`, `script/`, exploration reports, and test media.

| Path | What | Status |
|---|---|---|
| `autoqa/` | **The main project**: generic autonomous QA agent CLI | Active; branch `autoqa` (commits 8b6ca3c → a5cc999 pushed to github.com/2006-sk/Koyal-browser) |
| `login/` | Legacy hand-built auth QA harness (Phase 1) | Passing, superseded by autoqa |
| `happyflow/audio/` | Legacy audio-wizard harness | Passing; scenario consolidation uncommitted |
| `happyflow/script/` | Legacy script-wizard harness | Never fully passed; superseded |
| `happyflow/*.md` | HAPPY_FLOW_MAP / FULL_EXPLORATION_REPORT / PATH_PROBE_REPORT | Manual exploration ground truth |
| `happyflow/test-*` | Test media: `test-script-5-second.pdf` (known-good script), `test-narration-short.wav/.mp3` (audio), heist TXT (known-BROKEN on Koyal) | fixtures |

**Git state:** work happens on branch `autoqa` (created from `cursor/rename-logjn-to-login`). Do NOT switch back to `cursor/rename-logjn-to-login` casually — `autoqa/` files are tracked on `autoqa` but absent there, so checkout deletes them from disk. Credentials/API keys live in `login/.env` (KOYAL_TEST_EMAIL/PASSWORD, ANTHROPIC_API_KEY) — autoqa's config auto-falls-back to it.

## autoqa — what it is

Give it a URL; it logs in (asking the human in the CLI only when needed), **deep-explores** (crawls + actually enters creation flows: uploads CLI-asked files, completes required modals, waits out multi-minute processing), maps every state, auto-generates testable flows with replayable recipes, then **tests** them with QA probes. Learns page outcome statements from the human ONCE (success/failure/noise), forever. agent-browser CLI is the ONLY thing touching the browser; the LLM (Anthropic, `claude-sonnet-4-6` default) only picks which ref to click.

Core loop everywhere: **replay recipe (0 LLM) → if broken, LLM-explore (self-heals recipe) → verify deterministically (console/network/DOM) → triage unknown statements with human → persist**.

### Run it
```bash
cd autoqa
npm run qa -- run --url https://beta.koyal.ai            # explore-if-needed → test (thorough probes default)
npx tsx src/cli.ts explore --url ... --deep-flows 2 --budget 150
npx tsx src/cli.ts test --url ... --flow <id> --quick
npx tsx src/cli.ts review --url ...                       # browse/fix statements, flows, walks, recipes, allowlist
npx tsx src/cli.ts reset --url ... --all                  # wipe a site's memory
```
Flags: `--deep-flows N` `--no-deep` `--quick` `--budget N` (hard LLM-call cap) `--upload-file <p>` (force one file for all uploads) `--fresh` `--headless` `--max-pages/steps`.
NOTE: `run` skips exploration if the sitemap has pages AND approved flows — use explicit `explore` to force re-exploration (don't rely on `run` after partial state exists).

### Module map (src/)
- `config.ts` — env (AUTOQA_*), falls back to `../login/.env`; `applyCliOverrides`; deep/probes/uploadFileOverride blocks.
- `core/agent-browser.ts` — sync spawnSync wrapper per action; sessions named `autoqa-<hostname>`. FACTS: 30s default subprocess timeout (never issue one long wait — loop 5s waits); `evalScript` RETURNS stdout (eval prints the JS return value); accessibility snapshots DO NOT contain hrefs; `clickButtonByText` returns honest boolean via eval stdout.
- `core/explorer.ts` — LLM loop, one JSON action/step (click/fill/wait/upload/done/fail); label capture (`resolvedLabel/Role` from `[ref=eN]` lines) makes recipes replayable; guard hook before clicks; upload hook asks CLI for a path; loop detection; snapshot truncation is HEAD+TAIL (60/40 — Next buttons live at the end); upload selector chain incl. DOM-scanned inputs + dropzone-ref arming.
- `core/verification.ts` — deterministic verdicts (pass/fail/needs-review) from page errors, console (allowlist), blank screen, ugly-error regexes, url/snapshot includes/excludes (RegExp-capable), 5xx counts. `core/llm/client.ts` — Anthropic + OpenAI paths BOTH retry 3× w/ backoff; static callCount + budget (throws LlmBudgetExceededError).
- `core/nav.ts` — resilient click ladder (interactive-snapshot ref → full → role find → DOM text); `core/edits.ts` — fillFieldByHint ladder + snapshot echo verify, randomEditMarker.
- `agent/sitemap.ts` — **identity rules (hard-won)**: plain pages are URL-identified ONLY (PASS 2 snapshot-only matching reserved for wizard/modal/processing/terminal/error kinds — else one chrome landmark like a site header absorbs every page); PASS 0 = landmark-first for stateful kinds (same-URL wizard states); mergePage dedupes by landmark overlap same-kind. WalkTrail/WalkStep carry full `actions` sequences + verified landmarks + processingMs.
- `agent/deep-walker.ts` — the flow walker: deterministic entry click (label known) → per state: matchPage else classifyPage (landmarks filtered against PREV snapshot — wizard sidebars list every step name on every screen); kind-based handling (processing = 5s polls + screenshots + one human-approved extension; inline processing detected by spinner regex, waited once per state; error → bounded recovery; terminal → done); `via` chain re-entry for fork branches (direct URLs resume drafts); `flowFromTrail` (hints = NEXT DIFFERENT state's verified landmark; processing folds into maxWaitMs×1.5; goals include idempotency clause "if already done, just advance"); `recordWalkRecipes` (full action sequences).
- `agent/crawler.ts` — BFS **seeded with the post-auth landing page** (sites without auth redirects hide the app behind the login URL); links from live DOM eval (not snapshot); click-probes nav then unknown categories; walk entries = create/upload interactives + checkout-ish submits, wizard-step pages allowed as entry sources (with via); inventory diff → "NEW since last explore"; flows approval via CLI.
- `agent/flow-runner.ts` — per milestone: guardPhase check (poll 30s, then **replayUpTo** = rebuild position by replaying prior milestone recipes — entry alone strands you); fast-forward when a draft resumes at a LATER milestone's page; recipe replay → explorer fallback; markers only on `edit` milestones; missed successHint alone (no marker) downgrades fail→needs-review→human; KB statements auto-resolve verdicts (flip logic); probes after each passing milestone (`probe:*` steps never abort; count as needs-review in flow verdict).
- `agent/probes.ts` — optionMatrix (cached groups, settle canonical, back out if navigation), backForward (marker/landmark survives), abandonResume (leave + re-open URL), editSweep (markers echo), rapidToggle. Deterministic; capped 3/milestone.
- `agent/statements.ts` — ask-once KB: deterministic candidate extraction (new outcome-looking lines + console errors), normalize/mask → regex pattern, human classifies s/f/n, feeds expectations (failures→snapshotExcludes etc.).
- `agent/guard.ts` — destructive keyword floor (delete|pay|checkout|invite|revoke|logout...) + classifier tags; yes/no/always/never → allowlist; logout auto-denied.
- `agent/auth.ts` — stateLoad → **poll** waitForAuthenticated (SPAs hydrate slowly; probe a requiresAuth page, not the origin) → recipe replay → LLM login → OTP via CLI channel.
- `agent/interact.ts` — CLI questions: TTY readline OR **inbox file channel** (`.autoqa-state/<host>/inbox/QUESTION.txt` → write `answer.txt`); `AUTOQA_PROMPT_TIMEOUT_MS` controls wait; unanswered classify questions defer (re-ask next run).

### Per-site state (`autoqa/.autoqa-state/<hostname>/`) — gitignored
`sitemap.json` (pages/kinds/landmarks/optionGroups/edges/flows/walks), `statements.json`, `recipes.json`, `allowlist.json`, `auth-state.json`, `secrets.json` (0600), `screens/`, `walks/` (poll screenshots), `inbox/`. Reports: `autoqa/reports/<hostname>/<runId>/` — same evidence format as legacy harnesses.

### Driving it detached (how this session operated)
Launch runs with `nohup ... &` + a watcher script answering the inbox (see `/Users/apple/.claude/jobs/*/tmp/watcher2.sh` pattern): parse the QUOTED message out of classify questions (naive globbing matches the word "success" in the answer menu — that bug once stored "Epic sadface: Username is required" as success); answer files contextually (pdf question → test-script-5-second.pdf, audio → test-narration-short.wav); "still processing" → wait; approve flows → all; guard → case-by-case (`always` for saucedemo Checkout, `no` for Koyal destructive). Kill wedged browser daemons with `pkill -f agent-browser` if `open` times out.

## Hard-won lessons (the recurring villain: URLs ≠ app state)
1. **BFS maps addresses; apps are state machines.** Everything action-gated needs the deep walker; the walker is FED by the crawl, so a starved crawl starves everything.
2. **Chrome landmarks** (site headers, wizard sidebar step names) must never identify a state — filter classified landmarks against the previous snapshot; plain pages match by URL only.
3. **Drafts/state leak between runs**: Koyal's "Create Your Next Video" resumes the last draft; saucedemo keeps cart items. Cures: fast-forward to later milestones, idempotent goals, via-chain fresh entry. Remaining idea: fresh-project-per-run entry strategy.
4. **Inline processing** (spinner on the same URL) ≠ processing page — detect via text regex, wait once per state.
5. One walker "step" may span several screens (LLM overachieves) — record FULL action sequences for recipes.

## Koyal product knowledge (verified by runs)
Login page defaults to Sign Up — click "Log In" toggle, submit is "Start Creating"; auth = cookies, sessions expire fast. Script path is **PDF-only** (TXT broken: "No dialogue found"); script-edit does ~50-110s inline character/voice generation; scenes ~70-125s; final render ~10min (landmark "Generating Video...Est."); credit-upsell modal appears at style step (dismiss ✕); upload fork at `/upload` is NOT resumable (probes proved it) and resumes drafts instead of showing the fork; wizard sidebar lists all step names on every screen. Audio path: fork → plan Continue → story type → /lyricedit transcript → theme → style.

## Validation results
- **2026-07-07 night, both sites wiped (`reset --all`) and re-run from zero with two new fixes (below):**
  - **saucedemo.com**: full cycle (login learned → crawl → 2 walks to "Thank you for your order!" → 7 flows tested): **43 PASS / 12 FAIL / 9 NEEDS-REVIEW, 0 aborts, 128 LLM calls**. Walked flows 100% green incl. probes. Legit site finding (re-confirmed): browser back→forward at checkout-overview strands you on checkout-step-one with progress lost; most remaining FAILs are collateral of that probe (runner doesn't re-position after a probe breaks state — known improvement). login-authentication:m1 FAIL is cosmetic (auth module silently restores session; milestone successHint expects to *see* the login form).
  - **beta.koyal.ai**: full cycle from zero (login learned incl. Sign-Up→Log In toggle, crawl 2 pages/7 edges, 2 walks incl. script wizard with PDF upload + "Initializing script engine" inline-processing waits, 7/7 flows approved+tested): **47 PASS / 7 FAIL / 3 NEEDS-REVIEW, 129 LLM calls**. wizard-step-navigation + audio flows fully green with edit-sweep probes. FAILs: sidebar-nav-flow m2–m4 are FALSE positives — the flow proposer copied the same successHint ("Upload Content") onto every sidebar destination (pages actually loaded: /assets, /locations-list); plus back/forward probe quirks at script-wizard m2/m4 (same SPA-history class as yesterday). Final ~10-min render NOT exercised this run; MP3 parity still untested.
- Earlier same-day benchmark (pre-wipe): saucedemo 7 PASS / 0 FAIL / 9 LLM calls — that run tested only ONE walked flow on warm recipes.

## 2026-07-08 stress + detection benchmarks
- **uitestingplayground.com (click ladder + wait logic).** BLOCKER: the agent-browser–bundled **Chrome for Testing 150.0.7871.24 refuses ALL plain-http nav** with `net::ERR_BLOCKED_BY_CLIENT` (repro'd on neverssl.com/httpforever.com too; https fine). Fix: run against http sites with `AGENT_BROWSER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` (system Chrome loads http; the wrapper passes env through). LIMITATION found: `run`'s crawl COLLAPSED the ~40-page challenge hub into 3 nodes (challenge pages share header/nav landmarks → same-kind landmark-overlap dedup merged them), so auto-flows were shallow nav only (24/1/1). Drove the widgets directly via the `AgentBrowser` class instead: **7/7 challenge behaviors correct** — click registers, dynamic-id (ref not id), load-delay/ajax-15s/client-delay-15s waits, hidden-layers 2nd click honestly REJECTED ("covered by #blueButton" — no false pass), overlapped fill lands. NOTE: the lost-click *fallback* only fires on CfT (which can't load http), so uitp exercised the ladder/waits, not the zombie-target fallback — that path is covered by the saucedemo runs on CfT.
- **saucedemo detection benchmark (differential vs standard_user's 43/12/9 baseline, same map/flows, `reset --auth` between users).** Method: keep standard_user's approved map+recipes, clear session, `test` as the broken user. MUST `pkill -f agent-browser` before switching users — agent-browser reuses the live session daemon and its cookies, so `reset --auth` (disk only) isn't enough; a contaminated perf_glitch run showed "session restored silently" as the prior user until the daemon was killed.
  - **problem_user: 33 PASS / 12 FAIL / 7 NEEDS-REVIEW — detection WORKS.** 3 milestones green for standard_user flipped to FAIL, all at checkout "Your Information"→Continue; "Error: First Name is required" surfaced ×20 and got KB-flagged (bike-light m3 reason literally `Snapshot should not include "error: first name is required"`). Real product bug caught: problem_user can't complete checkout.
  - **performance_glitch_user: 43 PASS / 10 FAIL / 7 NEEDS-REVIEW — wait logic ROBUST, no timing false-fails.** PASS count = standard_user baseline; "Thank you for your order" captured 4× (slow checkout DID complete). All FAILs are the user-independent back/forward SPA collateral, not slowness.

## 2026-07-07 night fixes (uncommitted on `autoqa`)
1. **`core/agent-browser.ts` — verified clicks.** agent-browser 0.31.1 (reinstalled 10:23 that day) + its Chromium 150.0.7871.24 silently LOSES trusted clicks on some pages: CLI reports success but the browser routes input to a stale/zombie page target (`/json` shows a page target frozen at the pre-navigation URL); eval/snapshot always reach the live page; hover + keyboard + JS clicks still work. `click()` now arms a one-shot in-page probe → CLI click → if probe reads 0 on the same un-navigated document, activates the element via `elementFromPoint(...).click()` (focus+activeElement fallback). Log line: `[browser] trusted click on @eN never reached the page`. Costs ~2 extra subprocess calls per click. If clicks ever look dead again: this is the first suspect — diagnose with an in-page capture listener, NOT by trusting CLI exit codes.
2. **`agent/flow-runner.ts` — login milestones route to the auth module.** LLM-proposed flows carry credential-less goals ("Log in with valid credentials") tagged kind:'edit', so the explorer typed the run MARKER into the password field ("Epic sadface: Username and password do not match any user"). `isLoginShapedGoal()` detects positive-path auth milestones → `ensureAuthenticated()` (env/secrets creds, saved session, learned recipe); negative-path goals (invalid/empty creds) still explore. Saucedemo login needs `AUTOQA_EMAIL=standard_user AUTOQA_PASSWORD=secret_sauce` env at launch or askSecret leaks KOYAL_TEST_* into it (env is checked FIRST).

## Known rough edges / next steps
- flow-runner should RE-POSITION after a probe breaks page state (back-forward probe failures currently cascade into m4/m5 collateral FAILs).
- Flow proposer sometimes copies one successHint across all milestones (koyal sidebar-nav-flow) → false FAILs; hints need per-milestone grounding.
- Login-shaped milestones verified against pre-login successHints read as FAIL when the session silently restores (cosmetic; consider treating "authenticated" as pass).
- Draft contention on Koyal still causes recovery churn on repeated runs (fresh-project-per-run strategy is the fix).
- Junk URL pollution: SPAs serve content for any path (a `/company/sauce-labs` footer link became a phantom page) — consider soft-404 detection.
- Audio walk trail on Koyal is noisier than script (one polluted node was hand-patched); re-walk self-heals.
- MP3 parity on Koyal not yet cleanly exercised (`--upload-file` exists for it).
- Statement KBs are young — user should `review` and classify with real judgment (watcher heuristics are stand-ins).
