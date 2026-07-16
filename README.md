# Happyflow — Koyal QA

Automated browser QA for [beta.koyal.ai](https://beta.koyal.ai), organized by product flow.

## Flows

| Folder | Scope |
|--------|--------|
| [`login/`](login/) | Login, signup, forgot-password (Phase 1) |

Each flow is a self-contained Node project with its own `package.json`, `src/`, and `reports/`.

## Quick start (login flow)

```bash
cd login
npm install
npx agent-browser install
cp .env.example .env   # add credentials
npm run qa
```
