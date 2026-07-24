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
LLM_MODEL=claude-sonnet-4-6
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
| `AUTOQA_LLM_BUDGET` | `0` | LLM-call cap; `0` means unlimited. |
| `AUTOQA_LLM_TIMEOUT_MS` | `60000` | Timeout for one LLM request attempt. |
| `AUTOQA_UPLOAD_SUGGESTIONS` | none | Comma-separated upload paths shown as suggestions. |
| `AGENT_BROWSER_HEADED` | `true` | Set `false` to hide Chrome. |
| `AGENT_SHOW_CURSOR` | `true` | Set `false` to hide the cursor overlay. |
| `SLACK_BUGS_WEBHOOK_URL` | none | Post verified product bugs to Slack. Leave unset to disable posting. |

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
```

Each report includes human-readable and JSON summaries, per-step screenshots,
DOM snapshots, console/network evidence, and reproduction steps.

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

### Disable Slack bug notifications

Leave `SLACK_BUGS_WEBHOOK_URL` unset for that process.
