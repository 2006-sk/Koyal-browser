# happyflow — Koyal QA workspace + autoqa (autonomous site-agnostic QA agent)

This file is the session brain-dump: everything a fresh session needs to be as effective as the one that built this. Last updated 2026-07-07 (late evening).

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
- **saucedemo.com**: full autonomy proven — login learned, store mapped (after crawl fixes), checkout deep-walked to terminal "Thank you for your order!" twice, final test **7 PASS / 0 FAIL / 0 NEEDS-REVIEW, 9 LLM calls** (recipes did the work). Legit findings: checkout state lost on abandon; back/forward quirks at the fork.
- **beta.koyal.ai**: script wizard mapped end-to-end from zero (9 states, kinds+landmarks+option groups), flows auto-generated + tested with probes (story-type matrix, marker persistence). Audio branch traversed. The final autonomous run was SHUT DOWN by the user mid-flight (after commit ddf957f fixed the proposal-truncation fatal): state has 9 pages + 2 walks + 0 approved flows. TO RESUME: `npx tsx src/cli.ts run --url https://beta.koyal.ai --deep-flows 2 --budget 250` (it will re-explore because no flows are approved, walk the remaining fork branches incl. audio, propose+approve, then test) with a watcher on `.autoqa-state/beta.koyal.ai/inbox/`.

## Known rough edges / next steps
- Draft contention on Koyal still causes recovery churn on repeated runs (fresh-project-per-run strategy is the fix).
- Junk URL pollution: SPAs serve content for any path (a `/company/sauce-labs` footer link became a phantom page) — consider soft-404 detection.
- Audio walk trail on Koyal is noisier than script (one polluted node was hand-patched); re-walk self-heals.
- MP3 parity on Koyal not yet cleanly exercised (`--upload-file` exists for it).
- Statement KBs are young — user should `review` and classify with real judgment (watcher heuristics are stand-ins).
