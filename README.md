# Happyflow / AutoQA

This repository contains **AutoQA**, an autonomous, site-agnostic browser QA
agent, plus older Koyal-specific harnesses retained as fixtures and historical
reference.

AutoQA can authenticate, crawl an application, enter real creation/upload
workflows, propose end-to-end flows, replay learned semantic recipes, recover
with an LLM when the UI changes, verify outcomes, and produce evidence-rich
reports.

## Start here

```bash
git clone https://github.com/2006-sk/Koyal-browser.git
cd Koyal-browser/autoqa
npm install
npx agent-browser install
cp .env.example .env
```

Add your LLM key to `autoqa/.env`, then run:

```bash
npm run qa -- run --url https://your-app.example
```

See the complete [AutoQA developer guide](autoqa/README.md) for:

- all commands and flags;
- cached, fresh, wipeout, and exhaustive runs;
- running all flows or selected flow IDs;
- LLM provider and environment configuration;
- headless and detached operation;
- upload fixtures and human prompts;
- saved sitemap/recipe state;
- reports, safety, development, and troubleshooting.

## Repository layout

| Path | Purpose |
|---|---|
| [`autoqa/`](autoqa/) | Main autonomous QA agent |
| [`login/`](login/) | Legacy Koyal authentication harness |
| [`happyflow/audio/`](happyflow/audio/) | Legacy Koyal audio-flow harness |
| [`happyflow/script/`](happyflow/script/) | Legacy Koyal script-flow harness |
| [`happyflow/`](happyflow/) | Test fixtures and historical exploration material |

New development should normally target `autoqa/`.
