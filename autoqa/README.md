# autoqa — autonomous site-agnostic QA agent

Point it at any URL. It explores the app, builds a site map, proposes end-to-end
test flows, then walks them in a real browser — clicking, editing, uploading —
while a deterministic verification layer watches console, network, and DOM.
When it sees a page message it doesn't understand, it asks you **once**
("success / failure / noise?") and remembers the answer forever.

The LLM is the primary navigator; everything it learns (site map, outcome
statements, replayable action recipes) is cached per-site in label-based form —
never brittle element refs — so repeat runs are fast, cheap, and quiet, and the
agent self-heals when the site is refactored.

## Quick start

```bash
cd autoqa
npm install
npx agent-browser install   # once, if Playwright browsers are missing
cp .env.example .env        # set AUTOQA_URL + ANTHROPIC_API_KEY (login/.env is picked up automatically)

npm run qa -- run --url https://beta.koyal.ai
```

First run: it prompts for credentials (or finds them in env), explores, asks you
to approve proposed flows, and asks you to classify new page messages inline.
Second run: near-silent — session restored, statements known, recipes replayed
with almost no LLM calls.

## Commands

| Command | What it does |
|---|---|
| `run` (default) | explore if the sitemap is missing/stale, then test approved flows |
| `explore` | crawl + classify pages, build the sitemap, propose flows |
| `test` | run approved flows (`--flow id,id` to filter) |
| `review` | browse/reclassify statements, approve/skip flows, prune recipes & allowlist |
| `reset` | clear saved state (`--sitemap --statements --recipes --auth` or `--all`) |

Flags: `--url <URL>` `--fresh` `--flow id[,id]` `--max-pages N` `--max-steps N`
`--budget N` (hard LLM-call cap) `--headless`

## How a milestone executes

```
replay cached recipe (0 LLM calls)
  └─ failed? → LLM explorer takes over with the same goal (self-heals the recipe)
       └─ every click passes the destructive-action guard (delete/pay/invite → ask once)
verify deterministically (console errors, network 5xx, blank screen, expected text)
  └─ new outcome message? → ask you once, save to statements.json
  └─ still ambiguous? → ask you for the verdict (pass/fail/skip)
evidence per step: screenshot, snapshots, console, network, repro steps
```

## Per-site state (`.autoqa-state/<hostname>/`)

- `sitemap.json` — pages, detection recipes, nav edges, flows
- `statements.json` — human-classified success/failure/noise messages
- `recipes.json` — replayable label-based action sequences (+ success/failure stats)
- `allowlist.json` — remembered always/never answers for destructive actions
- `auth-state.json` — saved browser session; `secrets.json` — saved credentials (0600)
- `inbox/` — file-based Q&A channel for detached runs: when no TTY is attached,
  questions land in `inbox/QUESTION.txt`; write your answer to `inbox/answer.txt`

Reports land in `reports/<hostname>/<runId>/` — same evidence-rich format as the
sibling `login/` and `audio/` harnesses (report.md, report.json, ARTIFACTS.md,
per-step folders).

## Safety model

- **Free:** navigation, form fills, content edits (with unique verifiable markers), uploads.
- **Ask first (once):** anything matching the destructive keyword floor
  (delete/remove/pay/checkout/invite/revoke/…) or tagged destructive by the
  page classifier. `always`/`never` answers persist.
- **Never:** logout is auto-denied mid-run (it would destroy the session);
  exploration never submits forms — discovery only.
