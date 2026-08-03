# AutoQA

AutoQA is a site-agnostic browser QA agent. Give it a web application URL and
it can:

1. authenticate through the real UI;
2. crawl pages and discover application states;
3. deep-walk creation and upload workflows;
4. propose end-to-end test flows for human approval;
5. replay learned recipes without an LLM when possible;
6. fall back to LLM exploration when a recipe no longer works;
7. verify outcomes using the DOM, console, network traffic, and screenshots; and
8. save evidence-rich reports and reusable per-site knowledge.

AutoQA drives a real Chrome session through `agent-browser`. It does not require
site-specific selectors or test scripts. Human answers, flow definitions,
semantic action recipes, and outcome classifications are stored separately for
each hostname.

## Requirements

- Node.js 20 or newer
- npm
- Chrome or the Chrome for Testing browser installed by `agent-browser`
- An API key for one supported LLM provider
- Test credentials and safe test data for authenticated applications

## Install on a new machine

```bash
git clone https://github.com/2006-sk/Koyal-browser.git
cd Koyal-browser/autoqa
npm install
npx agent-browser install
cp .env.example .env
```

Edit `autoqa/.env` and provide at least a target URL and an LLM key:

```dotenv
AUTOQA_URL=https://your-app.example
ANTHROPIC_API_KEY=your-key
```

Credentials are optional. If they are not supplied, AutoQA asks for them when
it encounters a login gate and stores them in the hostname-specific state
directory with restricted file permissions.

### LLM providers

Anthropic is the default:

```dotenv
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-key
LLM_MODEL=claude-sonnet-5
```

OpenAI:

```dotenv
LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
LLM_MODEL=your-model
```

OpenRouter or another OpenAI-compatible endpoint:

```dotenv
LLM_PROVIDER=openrouter
LLM_API_KEY=your-key
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=your-model
```

For a custom compatible endpoint, use `LLM_PROVIDER=custom` together with
`LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`.

## Default command

Run this from the `autoqa` directory:

```bash
npm run qa -- run --url https://your-app.example
```

`run` is the normal command. It:

- restores the saved browser session when possible;
- explores when there is no usable sitemap or no approved flow;
- otherwise reuses the existing sitemap without deep-crawling again;
- runs all approved exploratory and deterministic flows;
- tries a saved recipe first;
- falls back to LLM exploration when a recipe breaks;
- verifies every milestone; and
- writes a report.

On a first run, expect questions for login credentials, upload files, realistic
field values, unfamiliar success/error messages, destructive actions, and flow
approval. Later runs reuse saved answers and recipes.

## Command reference

| Command | Purpose |
|---|---|
| `run` | Default workflow: explore only when needed, then test runnable flows. |
| `explore` | Crawl, classify, deep-walk, update the sitemap, and propose flows. Does not test flows afterward. |
| `test` | Test existing approved flows without crawling first. |
| `review` | Review statements, flow approvals, walks, recipes, and the destructive-action allowlist. |
| `reset` | Remove selected pieces of saved state for one hostname. |
| `help` | Print CLI help. `--help` and `-h` work too. |

All commands accept the target through `--url` or `AUTOQA_URL`.

### Normal cached run

```bash
npm run qa -- run --url https://your-app.example
```

Use this after an initial mapping. If the sitemap already has runnable flows,
AutoQA skips exploration and starts testing.

### Explore only

```bash
npm run qa -- explore --url https://your-app.example
```

Use this to extend or refresh the map without immediately running every flow.

### Test all approved flows without crawling

```bash
npm run qa -- test --url https://your-app.example
```

### Test one flow by ID

```bash
npm run qa -- test \
  --url https://your-app.example \
  --flow audio-to-final-video
```

### Test several flows by ID

```bash
npm run qa -- test \
  --url https://your-app.example \
  --flow audio-to-final-video,create-character,create-outfit
```

Do not put spaces inside the comma-separated flow list.

The flow keeps its saved lifecycle state:

- `deterministic`: replay the complete validated recipe;
- `replay-validation`: replay a newly learned recipe before promotion;
- `exploratory`: use any available recipe, then let the LLM recover and learn
  when necessary.

### Run a focused Manual v2 test from a natural-language request

```bash
npm run qa -- run \
  --url https://your-app.example \
  --manual-v2 \
  --manual "Test the Locations area: create or edit one location and verify it persists"
```

Manual v2 requires an existing sitemap. `--manual-v2` selects the current
dependency-aware task-graph engine; `--manual` supplies its natural-language
request. AutoQA selects the narrowest mapped page or exactly matching flow,
rejects invented page/flow IDs, and runs only the requested scope. It prefers
verified UI entry paths and uses a mapped direct URL only for intentional
resume or recovery.

Manual v2 preserves named entities, exact controls, ordering constraints,
field values, expected outcomes, and producer-to-consumer artifact identity.
Detailed values do not dilute a clear end-to-end flow match. For example, a
request can select a mapped Audio-to-video journey while also specifying a
sample name and exact trim timestamps:

```bash
npm run qa -- run \
  --url https://your-app.example \
  --manual-v2 \
  --manual "Create a final video through Audio, select Sample A, trim 15s to 25s, and verify the playable 10-second result"
```

Read-only wording such as `only verify` or `without making changes` prevents
create/edit/upload/save actions. Typo-tolerant matching handles small spelling
mistakes, but AutoQA refuses vague or unmapped targets instead of silently
testing an unrelated page. Requests that name an owner or searchable entity
must select and visibly confirm that entity before a mutation, then verify the
result persisted under the same active context.

Manual v2 compiles the request once into small dependency-aware tasks.
Focused requests may use the necessary prefix of a mapped multi-page journey
(for example reaching an upload-only character step), but stop after that
feature is completed and persisted. Only requests that explicitly ask for an
end-to-end journey or final rendered artifact inherit the full mapped flow.
Flow matching also respects the requested operation: an upload request
needs an upload-capable path, a deletion request cannot reuse a creation recipe,
and a render request needs a terminal render path.

Mapped journey checkpoints determine page order; explicit dependencies carry
artifacts between tasks; policy sentences become constraints instead of extra
browser actions. Only the active task is sent to the LLM, completed mutations
are not repeated by later journey steps, and unresolved tasks remain visible
instead of being hidden by reaching a terminal page.

The first successful Manual v2 run records semantic recipes. The next identical
request replays them for validation; a complete successful replay can become
deterministic like any other flow. A terminal artifact plus at least 80% passing
milestones can enter replay validation, while deterministic promotion still
requires every milestone and recipe to pass. Normal login, upload, realistic
field-value, guard, processing-wait, screenshot, vision, recovery, and outcome
verification behavior still applies. Manual v2 cannot be combined with
`--wipeout`; map the site first.

For unattended scheduled runs, enable the production prompt supervisor:

```bash
AUTOQA_PRODUCTION_SUPERVISOR=true \
AUTOQA_SUPERVISOR_HUMAN_OVERRIDE_MS=3000 \
npm run qa -- test --url https://your-app.example
```

The supervisor answers non-secret field, file, classification, guard, and flow
approval questions with auditable realistic values. A human inbox answer wins
during the short override window. Credentials remain in the protected secret
channel; nonexistent files and unrelated destructive actions are refused.
Upload selection is constrained by the requested media type, and unique
artifact names rotate after a visible duplicate-name rejection.

Manual v2 is opt-in and does not change ordinary crawling, exhaustive mapping,
approved-flow replay, or deterministic execution.

## How sitemap coverage stays current

AutoQA treats authentication as a change in the visible application surface,
not merely a login prerequisite. When a run changes from anonymous to
authenticated, it revisits the landing page and persistent navigation pages
once, merges newly visible links and controls into the existing sitemap, and
records whether controls were observed while anonymous, authenticated, or
both. Each authentication state is refreshed at most once per exploration, so
this expands coverage without creating an endless recrawl.

Deep walking enters creation and upload workflows after navigation crawling.
Persistent wizard controls remain available as sitemap controls and edges, but
the same progress-bar or sidebar control repeated across several wizard states
does not launch a separate expensive walk from every page. Equivalent terminal
walk proposals are consolidated while the underlying pages, edges, choices,
and walk evidence remain preserved.

For broad Koyal-family exhaustive runs, use an explicit cap of ten deep walks:

```bash
AUTOQA_EXHAUSTIVE=true npm run qa -- run \
  --url https://your-app.example \
  --wipeout \
  --deep-flows 10 \
  --budget 800 \
  --max-pages 50 \
  --max-steps 40
```

### Force a fresh exploration while keeping saved knowledge

```bash
npm run qa -- run \
  --url https://your-app.example \
  --fresh
```

`--fresh` re-crawls and deep-walks, but does not erase the existing sitemap,
recipes, authentication, statements, or saved field values.

### Full first-run/exhaustive mapping

```bash
AUTOQA_EXHAUSTIVE=true npm run qa -- run \
  --url https://your-app.example \
  --wipeout \
  --deep-flows 10 \
  --budget 800 \
  --max-pages 50 \
  --max-steps 40
```

This is intentionally expensive. It erases AutoQA's local knowledge for that
hostname, maps from zero, performs up to ten deep walks, proposes flows, and
tests the approved set with exhaustive probes.

`AUTOQA_EXHAUSTIVE=true` removes the ordinary per-milestone probe cap. An
explicit `--deep-flows` value is still respected.

### Full reset without immediately running

```bash
npm run qa -- reset \
  --url https://your-app.example \
  --all
```

This is equivalent to clearing all AutoQA state for that hostname. It does not
delete projects, accounts, or other data inside the target application.

### Ask for new names and values while keeping the map and recipes

```bash
npm run qa -- run \
  --url https://your-app.example \
  --reset-values
```

Use `--reset-values` when deterministic recipes are valid but should ask for
fresh names, descriptions, or other user-controlled field values.

### Fast smoke test

```bash
npm run qa -- run \
  --url https://your-app.example \
  --quick
```

`--quick` skips extra QA probes such as back/forward, option matrices, edit
sweeps, and abandon/resume checks. Milestone execution and verification still
run.

### Headless CI/server run

```bash
npm run qa -- run \
  --url https://your-app.example \
  --headless
```

For non-interactive runs, AutoQA writes questions to:

```text
.autoqa-state/<hostname>/inbox/QUESTION.txt
```

Write the answer to:

```text
.autoqa-state/<hostname>/inbox/answer.txt
```

The default prompt timeout is five minutes. Override it with
`AUTOQA_PROMPT_TIMEOUT_MS`.

### Force one upload fixture

```bash
npm run qa -- test \
  --url https://your-app.example \
  --flow audio-to-final-video \
  --upload-file /absolute/path/to/test-audio.wav
```

`--upload-file` forces the same file for every upload encountered during that
process. This is useful for format-parity tests. For different file types in one
run, omit it and answer each upload prompt separately.

### Shallow crawl without entering creation workflows

```bash
npm run qa -- explore \
  --url https://your-app.example \
  --no-deep
```

This maps navigation but deliberately does not exercise create/upload flows.

### Interactive review

```bash
npm run qa -- review --url https://your-app.example
```

Use `review` to approve or skip flows, fix learned statement classifications,
inspect or delete stale walk/recipe data, and manage remembered guard choices.

## Flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--url <URL>` | all | Target application. Overrides `AUTOQA_URL`. |
| `--flow <id[,id]>` | `run`, `test` | Run only the listed flow IDs. |
| `--manual-v2` | `run --manual` | Use the current dependency-aware Manual v2 task-graph engine. |
| `--manual "<request>"` | `run --manual-v2` | Supply the focused Manual v2 request; requires an existing sitemap. |
| `--fresh` | `run` | Force exploration while preserving saved state. |
| `--wipeout` | `run` | Delete all saved AutoQA state for the hostname, then explore and test from zero. |
| `--reset-values` | `run`, `explore`, `test` | Forget saved non-secret field answers but keep sitemap, recipes, and authentication. |
| `--max-pages <N>` | browser commands | Maximum crawl pages. Default: 25. |
| `--max-steps <N>` | browser commands | Maximum LLM decisions for one goal, not the whole run. Default: 12. |
| `--budget <N>` | browser commands | Hard cap on total LLM calls for the process. Default: unlimited. |
| `--deep-flows <N>` | exploration | Maximum deep walks in this exploration. Default: 3. |
| `--no-deep` | exploration | Disable deep walking. |
| `--quick` | testing | Skip additional QA probes. |
| `--headless` | browser commands | Hide the browser window. |
| `--upload-file <path>` | browser commands | Force one local file for all uploads. |

Reset supports these selectors:

```bash
npm run qa -- reset --url https://your-app.example --sitemap
npm run qa -- reset --url https://your-app.example --statements
npm run qa -- reset --url https://your-app.example --recipes
npm run qa -- reset --url https://your-app.example --auth
npm run qa -- reset --url https://your-app.example --values
npm run qa -- reset --url https://your-app.example --all
```

Selectors can be combined.

## Useful environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `AUTOQA_URL` | none | Default target URL. |
| `AUTOQA_EMAIL`, `AUTOQA_PASSWORD` | none | Optional generic test credentials. |
| `AUTOQA_SESSION` | `autoqa` | Browser-session name prefix. Use distinct values for concurrent runs. |
| `AUTOQA_EXHAUSTIVE` | `false` | Exercise all option/edit probes instead of the normal cap. |
| `AUTOQA_MAX_PAGES` | `25` | Crawl page cap. |
| `AUTOQA_CRAWL_DEPTH` | `4` | Crawl depth cap. |
| `AUTOQA_PROBES_PER_PAGE` | `6` | Click-probe cap per crawled page. |
| `AUTOQA_DEEP` | `true` | Enable deep walking. |
| `AUTOQA_DEEP_FLOWS` | `3` | Deep-walk cap when no CLI value is supplied. |
| `AUTOQA_DEEP_WALK_MAX_STEPS` | `60` | State cap for one deep walk. |
| `AUTOQA_PROCESSING_WAIT_MS` | `1200000` | Maximum deterministic processing wait. |
| `AUTOQA_TERMINAL_WAIT_MS` | `1200000` | Maximum final-artifact wait. |
| `AUTOQA_PROMPT_TIMEOUT_MS` | `300000` | Detached question timeout. |
| `AUTOQA_PRODUCTION_SUPERVISOR` | `false` | Answer safe non-secret run prompts autonomously for unattended production QA. |
| `AUTOQA_SUPERVISOR_HUMAN_OVERRIDE_MS` | `3000` | Short window in which an inbox/human answer overrides the production supervisor. |
| `AUTOQA_LLM_BUDGET` | `0` | LLM-call cap; `0` means unlimited. |
| `AUTOQA_LLM_TIMEOUT_MS` | `60000` | Timeout for one LLM request attempt. |
| `AUTOQA_UPLOAD_SUGGESTIONS` | none | Comma-separated upload paths shown as suggestions. |
| `AGENT_BROWSER_HEADED` | `true` | Set `false` to hide Chrome. |
| `AGENT_SHOW_CURSOR` | `true` | Set `false` to hide the cursor overlay. |

CLI flags override the corresponding environment values for that process.

## What is saved

State is isolated by hostname:

```text
autoqa/.autoqa-state/<hostname>/
├── sitemap.json       # pages, state detection, edges, walks, and flows
├── recipes.json       # semantic replay steps and replay history
├── statements.json    # learned success/failure/noise classifications
├── allowlist.json     # remembered destructive-action decisions
├── auth-state.json    # browser authentication state
├── secrets.json       # saved credentials; mode 0600
├── screens/           # mapping screenshots
├── walks/             # deep-walk evidence
└── inbox/             # detached human-question channel
```

Reports are written to:

```text
autoqa/reports/<hostname>/<run-id>/
├── report.md             # run summary and verdicts
├── bugs-reported.md      # detected bugs, locations, console and network errors
└── artifacts/            # JSON, screenshots, snapshots, logs, and step evidence
```

The two Markdown files at the run root are the human-readable output. All
machine-readable data and detailed evidence live under `artifacts/`.

## How replay and self-healing work

For every milestone:

```text
saved semantic recipe
  ├─ succeeds → verify and record evidence
  └─ breaks   → LLM explores the same bounded goal
                   ├─ succeeds → save the repaired recipe
                   └─ fails    → preserve evidence and report the failure
```

A newly learned complete flow remains exploratory until a later complete replay
proves every milestone and the final artifact. Only then can it be promoted to
deterministic. Partial or failed exploratory attempts are not promoted.

Recipes use accessible labels and roles instead of temporary browser refs such
as `e17`, so they can survive normal DOM reordering. When an exact recipe no
longer works, the LLM fallback is the self-healing layer.

## Safety

- Navigation, ordinary form filling, test-content editing, and uploads are
  allowed.
- Potentially destructive actions—delete, remove, pay, checkout, invite,
  revoke, and similar controls—require confirmation.
- `always` and `never` answers are stored per hostname.
- Logout is denied during a run because it would destroy the test session.
- AutoQA's `--wipeout` and `reset` commands only delete local AutoQA knowledge.
  They do not clear application data on the target website.
- Use dedicated test accounts. Do not point creation/edit flows at production
  customer data.

## Development

Run the complete unit suite and TypeScript compiler:

```bash
cd autoqa
npm run test:unit
npm run build
```

Print the authoritative CLI help:

```bash
npm run qa -- --help
```

Run a focused test file:

```bash
node --test --import tsx src/core/explorer.test.ts
```

## Troubleshooting

### A normal run unexpectedly explores again

`run` explores when there are zero mapped pages or zero runnable flows. Check
flow approval/status with `review`. To guarantee no crawl, use `test`.

### A previous crawl already mapped the site

Use the normal `run` command or `test`. Do not add `--fresh` or `--wipeout`.

### A recipe fails after the product changes

Run the affected flow normally. AutoQA tries the recipe first and then falls
back to exploratory recovery. A repaired flow must pass a later replay before
deterministic promotion.

### Chrome or the browser daemon is unavailable

```bash
npx agent-browser install
```

Then rerun the command. AutoQA gives each hostname/session its own browser state
and attempts scoped recovery if that session becomes unresponsive.

### The command is waiting but no terminal question is visible

For a detached run, inspect:

```text
.autoqa-state/<hostname>/inbox/QUESTION.txt
```

Place the answer in `answer.txt` in the same directory.

### Product bug reporting

On Koyal properties, reportable primary issues are filed after verdict
finalization through the site’s own **Report a Bug** modal. This includes fresh
console/page/network/visible application errors and unresolved primary
checkpoints; synthetic downstream skips are excluded. The report states that
AutoQA filed it, includes the concrete evidence and blocked capability, and
records whether submission succeeded. A submitted diagnostic is evidence of an
observed issue, not automatic proof that Koyal caused it. Reporting failure
never changes the QA verdict or repeats the tested action. Submission evidence
is saved as `artifacts/in-app-bug-reporting.json`; the readable bug ledger is
`bugs-reported.md` at the run root.

Product-side failures and recipe health are separate: a verified application
error can block a milestone without demoting an otherwise healthy
replay-validation or deterministic recipe. Automation failures still demote.

## Scheduled production runs on GitHub Actions

The repository includes `.github/workflows/autoqa-beta-scheduled.yml`. It runs
one approved comprehensive Script flow followed by one approved comprehensive
Audio flow every day at 6:00 AM Pacific (`America/Los_Angeles`, including
daylight-saving changes). The workflow can also be
started manually from the **Actions → AutoQA Beta Koyal → Run workflow**
screen, for both flows or either flow individually.

Required repository Actions secrets:

- `ANTHROPIC_API_KEY`
- `AUTOQA_EMAIL`
- `AUTOQA_PASSWORD`
- `AUTOQA_STATE_KEY`

Learned sitemap/recipe data is stored only as an AES-256 encrypted seed and
encrypted Actions cache. Authentication state, cookies, remembered field
values, and application secrets are never cached or committed. Each run uploads
its detailed reports as a 30-day artifact and writes the Script/Audio outcomes
to the GitHub run summary. A failed flow makes the workflow fail after the other
selected flow and report upload have finished.

For browser parity with the validated local environment, the hosted job pins
agent-browser 0.31.1 and Chrome for Testing 150.0.7871.24. Chrome runs headed
inside Xvfb with a fixed 1440×1000 viewport; the virtual display is not remotely
visible, but it preserves headed rendering and input behavior on the Linux
runner.
