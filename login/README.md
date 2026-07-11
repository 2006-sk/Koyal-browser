# Koyal Beta QA — Login flow (`login`)

Automated QA for **beta.koyal.ai** auth flow (login, signup, forgot-password), using [agent-browser](https://github.com/vercel-labs/agent-browser).

Run all commands from this folder (`login/`).

## Setup

```bash
cd login
npm install
npx agent-browser install   # Downloads Chrome (requires network)
cp .env.example .env          # Add test credentials
```

Uses **agent-browser ^0.31.1** (annotated screenshots, improved snapshots). Node 24+ is recommended by upstream; Node 22 works with a warning.

## Run (Phase 1 vertical slice — login only)

```bash
npm run qa:login
```

Headed mode is on by default (`AGENT_BROWSER_HEADED=true`). A visible **red QA Agent cursor** overlay tracks where the agent is pointing (`AGENT_SHOW_CURSOR=true`).

Set `AGENT_BROWSER_HEADED=false` or `AGENT_SHOW_CURSOR=false` to disable.

## LLM exploration layer

When `LLM_API_KEY` is set, navigation uses an LLM to pick `@ref` targets from live snapshots — so UI label/ref changes are handled adaptively. **Pass/fail verdicts remain deterministic** (console, network, DOM signals via `src/lib/verification.ts`).

```env
LLM_ENABLED=true
LLM_PROVIDER=openai        # openai | anthropic | openrouter | custom
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

Without an API key, scenarios fall back to regex-based snapshot matching from discovery.

Invalid-login only (no credentials needed):

```bash
npx tsx src/run-login.ts --invalid-only
```

Discovery pass (no credentials):

```bash
npm run discover
```

## Output

Each run creates `reports/<timestamp>/` when run from this folder:

- `report.md` — markdown table with verdicts and evidence links
- `report.json` — machine-readable results
- `<scenario>/` — screenshots and logs for fail / needs-review cases

## Architecture

- **Deterministic first** — known accessibility labels in `src/lib/auth-selectors.ts` (fast, no LLM)
- **LLM exploration fallback** — only when deterministic actions fail or verification doesn't pass; learned steps logged to `.state/auth-selectors-learned.json`
- **Verification layer** (`src/lib/verification.ts`) — deterministic pass/fail from console, network, DOM snapshot signals

## Credentials required

| Variable | Purpose |
| --- | --- |
| `KOYAL_TEST_EMAIL` | Valid login test |
| `KOYAL_TEST_PASSWORD` | Valid login test |
| `KOYAL_RESET_EMAIL` | Forgot-password flow (Phase 1 step 5) |
| `LLM_API_KEY` | LLM exploration (adaptive navigation) |
| `LLM_PROVIDER` / `LLM_MODEL` | LLM vendor and model |

## Known discovery notes (beta.koyal.ai)

- `/login` defaults to **Sign Up**; toggle via **Log In** button
- Login submit button label: **Start Creating**
- Invalid login shows: **User not found.**
- **Google OAuth button not visible** on signup as of discovery — flag for review
