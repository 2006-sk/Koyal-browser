# autoqa in production — architecture decision

Goal: run selected flows against Koyal properties continuously (day and night), post real
product bugs to Slack, unattended.

Everything below is grounded in this repo, not generic cloud advice. Measurements were taken
on 2026-07-29 from `reports/` and `.autoqa-state/`.

---

## 1. What autoqa actually needs (the constraints that decide the answer)

| Requirement | Evidence |
|---|---|
| **Runs a real Chromium browser** | `agent-browser` drives Chrome-for-Testing; needs ~1–2 GB RAM and system libs |
| **Runs for a long time** | 157 measured runs on the 3 real product sites: **median 6.7 min, mean 16.6 min, max 133 min. 51 of 157 (33%) exceeded 15 minutes.** Full deep runs are 33–60 min (filmarena ~48 min, xp.koyal.ai ~33 min, one killed at ~59 min) |
| **Needs zero GPU** | The LLM is a remote Anthropic API call. No local model, no CUDA, nothing to accelerate |
| **Has real learned state** | `.autoqa-state/` is **128 MB** of human-taught success/failure statements, recipes, sitemaps, auth. This is not a cache — losing it means re-teaching the agent |
| **Produces heavy artifacts** | `reports/` is **4.1 GB** after ~3 weeks of *intermittent local* runs. Median 3.7 MB/run, max 166 MB |
| **Needs secrets injected** | `SLACK_BUGS_WEBHOOK_URL`, `ANTHROPIC_API_KEY`, `KOYAL_ADMIN_TOKEN`, site credentials |
| **Occasionally wedges and self-heals** | `AgentBrowser.recycle()` force-kills the daemon; needs a process supervisor, not a one-shot invocation |
| **Is interactive by design** | `agent/interact.ts` asks humans to classify messages, approve flows, resolve guards, supply file paths, and break verdict ties. Unattended operation is a policy decision, not a default — see §6 |

**The single fact that decides the compute choice: one third of your runs exceed 15 minutes,
and full deep runs take 33–60 minutes.** AWS Lambda's hard ceiling is 15 minutes. That is not
a tuning knob — it is the maximum, and it eliminates Lambda as the runner outright.

---

## 2. Cost — and the cadence that decides it

Your own site-summary feature already prices runs. Measured:

- **filmarena.ai:** `$3.20` this run / `~$1.39` estimated future run (234 LLM calls)
- **beta.koyal.ai:** 277 LLM calls, now priced at `claude-sonnet-5` rates ($3 / $15 per MTok)

A "selected flows" loop is the **test phase** — exploration is skipped and recipes replay at 0
LLM calls — so per-cycle cost sits near the ~$1.4–2 replay figure, not the $3.20 cold start.

**Cadence is the whole variable.** At the intended **~2 runs/day**:

| Line item | Monthly |
|---|---|
| Anthropic API (the LLM) | **~$120** |
| Compute — scheduled container, ~60 h used | **$6 – 9** |
| Compute — always-on box, ~730 h paid | $30 – 90 |
| S3 artifacts + 30-day retention | $1 – 2 |

Two things follow, and they drive §4:

1. **Compute is not negligible here** — against ~$120/mo of API spend, an always-on box adds
   25–75%, while a scheduled container adds ~6%. Worth choosing deliberately.
2. **The box would be idle ~95% of the time.** 2 runs × 30–60 min is ~1–2 h of work per day
   against 22–23 h idle. Paying for 730 hours to use 60 is the wrong shape — which is why a
   **scheduled container job ranks above an always-on instance** below.

Cost levers by leverage: **cadence** (dominant — every doubling doubles the bill),
**`AUTOQA_LLM_BUDGET`** (currently `0`, unlimited — set a per-run ceiling), **model choice**
(Sonnet 5 $3/$15; `config.ts:83` defaults to `claude-sonnet-5`), and
**recipe hit rate** (a replayed recipe costs 0 LLM calls — you only pay for flows that fall back
to exploration).

---

## 3. The six options you named, in plain language

### AWS Lambda
**What it is:** you upload a function; Amazon runs it only when triggered and bills per
millisecond. No server to manage. Scales to zero — you pay nothing when idle.

**Why it's wrong here:** the **15-minute hard maximum**. A third of your runs and *all* of your
deep runs exceed it, and they'd be killed mid-flow with no verdict. Secondary problems: no
persistent disk (`.autoqa-state` would need EFS bolted on), a 10 GB `/tmp` ceiling for
screenshots, and packaging Chromium into a Lambda layer is fiddly. **Verdict: disqualified as
the runner.** Still useful as a *trigger* — an EventBridge schedule firing a tiny Lambda that
starts the real job.

### EC2
**What it is:** a rented Linux virtual machine that stays on. You install what you want, run
what you want, for as long as you want. You own patching and monitoring.

**Why it fits:** no time limit at all, so a 133-minute run is fine. Persistent disk comes free
with the instance, so the 128 MB of learned state just lives there. Chromium and its system
libs install normally. A `systemd` service supervises the loop and restarts it if it dies —
which matters because your own logs show wedges that need `recycle()` and restarts. And being
inside AWS keeps you next to Koyal's own S3/backend if you ever need in-VPC access for
`KOYAL_ADMIN_TOKEN` calls. A `t3.medium` (2 vCPU / 4 GB) is ~$30/mo; `m5.large` ~$70–90/mo.
**Verdict: correct and simple — but you pay for 730 hours to use ~60. The honest runner-up to a
scheduled container job (§4).**

### Replicas (tryreplicas.com)
**What it is:** a YC-backed **cloud coding-agent platform**. You assign a task from GitHub,
Slack, Linear, or a dashboard; it spawns **Claude Code, Codex, Cursor, or Opencode** inside an
isolated VM that has your repo and a real dev environment (Docker, npm, databases), the agent
verifies its own work locally, and it opens a PR. It reads CI failures and code review comments
and iterates. Billing is usage-based, in **minutes of workspace runtime**.

**Why it's wrong as a host — despite being the closest of the four non-compute options:** it is
genuinely a real VM with Docker, so autoqa *could* technically execute there. But the model is
**task-in → PR-out**, not cron-in → report-out. Specifically:

- **No scheduler.** Nothing fires a task every N hours; work is triggered by a ticket or message.
- **Workspaces sleep when idle and auto-delete after 7 days of inactivity** — the wrong
  durability guarantee for 128 MB of learned state you must never lose.
- **Billing is per workspace-runtime minute.** Running 24/7 means paying continuously, almost
  certainly above a ~$70/mo dedicated VM.
- **No browser-automation or QA product surface** is described.

**Verdict: wrong tool for hosting — but the right tool for the other half of the loop.** See §8.

### VeilStream
**What it is:** (verified by search, not recall) a lightweight **proxy in front of a PostgreSQL
database** that obfuscates or hides sensitive fields per-user, so teams can develop and debug
against production-*like* data without touching real PII. It also offers cloud-hosted ephemeral
review environments spun up from a `docker-compose.yml` on each commit or PR.

**Why it's wrong as a host:** it isn't a compute platform for long-running scheduled jobs. It's
a data-privacy proxy and a PR-preview service. **Verdict: cannot host autoqa.** But it is
genuinely adjacent to a real problem you have — see §7.

### Cognition
**What it is:** the company behind **Devin**, an AI software engineer. You give Devin a ticket
and it writes code in its own cloud dev sandbox, opens PRs, etc. Billed in ACU-style compute
units.

**Why it's wrong here:** Cognition doesn't sell raw scheduled compute. Devin is a *coder*, not a
job runner. You already have an autonomous agent — autoqa — and you need somewhere to *host*
it. Paying agent-grade pricing to babysit a `npm run qa` loop would be both expensive and
architecturally backwards. **Verdict: wrong category.** (Devin could plausibly help *fix* the
bugs autoqa finds — that's a different project.)

### RunPod
**What it is:** a GPU cloud. You rent an A100/H100/4090 by the second or hour for training and
inference. It also offers CPU-only pods.

**Why it's wrong here:** you need no GPU whatsoever — the intelligence is a remote API call. On
the CPU-pod side it's a bare container host with no real cron, secrets management, IAM, or
monitoring story. **Verdict: paying for hardware you will not use.**

---

## 4. Ranked comparison

Ranked for *this* workload. The last four rows are options you didn't name but that actually
win the comparison, so the recommendation has somewhere to land.

| # | Option | Max run length | Runs real Chromium? | Persistent state | GPU needed? | Cost / mo | Ops effort | Verdict |
|---|---|---|---|---|---|---|---|---|
| **1** | **Scheduled container job** — ECS Fargate / Azure Container Apps Jobs | **Unlimited** | ✅ container | ⚠️ EFS / Azure Files mount | ❌ none | **$6–9** (pay ~60 h, not 730) | Low–medium (IaC, nothing to patch) | ✅ **Recommended** |
| 2 | EC2 + Docker + systemd | Unlimited | ✅ native | ✅ EBS, included | ❌ none | $30–90 | Low (you patch the box) | ✅ Honest runner-up — simplest state, SSH debugging |
| 3 | Fly.io Machine (auto-stop when idle) | Unlimited | ✅ container | ✅ volumes | ❌ none | ~$5–15 | Low | ✅ Same per-use shape, simplest deploy |
| 4 | Hetzner / DigitalOcean VPS | Unlimited | ✅ native | ✅ included | ❌ none | $15–25 | Low | ✅ Cheapest flat rate; loses AWS-VPC adjacency |
| 5 | GitHub Actions scheduled workflow | 6 h/job | ✅ | ❌ cache — best-effort | ❌ none | ~2.7k min/mo | Very low | ⚠️ Viable at this cadence, but 128 MB of state in a best-effort cache is the blocker |
| 6 | **AWS Lambda** | ❌ **15 min hard cap** | ⚠️ painful layer | ❌ (EFS bolt-on) | ❌ none | Cheap but irrelevant | Medium | ❌ **Disqualified — 33% of runs exceed the cap** |
| 7 | RunPod | Unlimited | ✅ container | ⚠️ volumes | ❌ **none needed** | GPU rates for zero GPU use | Medium, thin ops tooling | ❌ Wrong hardware |
| 8 | **Replicas** | Unlimited in-session | ✅ real VM + Docker | ❌ **deleted after 7 days idle** | ❌ none | Per runtime-minute | Low | ❌ No scheduler; task-in→PR-out. **Best fit for fixing the bugs** (§8) |
| 9 | Cognition (Devin) | N/A | N/A | N/A | N/A | Agent-tier pricing | N/A | ❌ Wrong category — an AI coder, not a scheduler |
| 10 | VeilStream | N/A | ❌ | N/A | ❌ | N/A | N/A | ❌ A Postgres PII-masking proxy — cannot host jobs |

---

## 5. Recommended architecture

```
EventBridge Scheduler  ──fires ~2×/day──▶  ECS Fargate task (or Azure Container Apps Job)
                                                      │
        ┌─────────────────────────────────────────────▼──────────────────────┐
        │ Task: autoqa:latest   2 vCPU / 8 GB   no time limit                │
        │                                                                    │
        │   npm run qa -- test --url <site> --flow <id> --flow <id> \        │
        │      --headless                                                    │
        │   AUTOQA_SESSION=autoqa-<site>                                     │
        │   AUTOQA_PROMPT_TIMEOUT_MS=<see §6>                                │
        │   secrets <- SSM / Secrets Manager (never ../login/.env)            │
        │                                                                    │
        │   /mnt/state/.autoqa-state   <-- EFS mount, survives every task     │
        │   /tmp/reports               --- dies with the container            │
        └──────────┬──────────────────────────────┬──────────────────────────┘
                   │                              │
                   ▼                              ▼
        S3 (artifacts, 30-day lifecycle)    Slack + Jira
                                            (deduped bugs)

  task exits => container, Chromium tree and every orphaned daemon go with it
```

**Why each piece:**

- **A scheduled container, not an always-on box** — the decisive argument is *not* cost, it is
  that **a fresh container per run structurally deletes a failure class this project keeps
  hitting.** CLAUDE.md records orphaned daemons accumulating on a long-lived machine (13 at
  `PPID=1` after one run; 19 agent-browser + 15 Chrome piled up overnight; 8.4 M swapouts
  degrading CDP responsiveness generally). None of that can accrue across runs when the task
  exits. It also makes `recycle()`'s broad-kill collateral damage — which has fired for real
  4+ times, killing other sessions' browsers — **impossible by construction**, since there is
  only ever one session per container.
- **`test --flow <id>`, never `run`** — the requirement is *certain selected flows*, and `test`
  with an explicit allowlist is the only command that expresses it. `run` tests *every* approved
  flow, and CLAUDE.md warns it **skips exploration only if the sitemap has pages AND approved
  flows** — so on a task whose EFS mount failed, `run` silently kicks off a **full exploration**:
  the $3.20 cold-start path, re-proposing flows nobody approved. **`explore` must be a
  deliberate, human-gated operation the schedule can never trigger.**
- **EFS for state, ephemeral disk for artifacts** — `.autoqa-state` is small, hot, and must
  outlive the task; `reports/` is large and cold. Offload to S3 *before* the task exits.
- **One task per target site, serialized** — Koyal drafts are account-scoped. If you later need
  parallelism, give each site its own `AUTOQA_SESSION` (`README.md:427`) *and* its own Koyal
  account.
- **Docker image, not `npm install` on a bare host** — Chromium's system dependencies make the
  image the only reproducible option. Note `agent-browser` and `tsx` currently sit in
  `devDependencies` (blocker #1).
- **Cadence is the cost dial** — ~2 runs/day is ~$120/mo of API spend. Every doubling doubles it.

**If you'd rather own a box:** EC2 `t3.medium` + `systemd` (§4 row 2). Burstable is fine at this
cadence — with 22 idle hours a day, T3 credits replenish faster than a 30–60 minute run drains
them. The earlier warning against T3 applies only to back-to-back cycling.

**If cost is the priority:** a Hetzner CPX31 (4 vCPU / 8 GB) at ~€14/mo does this fine. You give
up in-VPC access to Koyal's backend.

---

## 6. Blockers to close before launch

### 0. HARD BLOCKER — unattended prompt defaults will suppress your own bug reports

This is the one to fix first. autoqa asks humans questions; when nobody answers, each prompt
stalls for `AUTOQA_PROMPT_TIMEOUT_MS` (**default 300 s**, `commands/shared.ts:90`) and then
takes a hard-coded default. Those defaults were chosen for a human who stepped away for a
minute — not for a permanently unattended loop. Traced through the code:

| Prompt | Default when unanswered | Consequence at 24/7 |
|---|---|---|
| **Classify a console error** (`statements.ts:210`) | **`noise`** | 🔴 **Silently suppresses the error site-wide, forever** |
| Classify a snapshot message (`statements.ts:210`) | none → left unclassified | 🟡 Safe (re-asked next run) but burns 300 s **every cycle, forever** |
| Approve flows (`crawler.ts:853`) | **`all`** | 🔴 Auto-approves every LLM-proposed flow with zero review |
| Ambiguous verdict (`flow-runner.ts:2099`) | `skip` | 🟢 Safe — stays `needs-review` |
| Logout control (`flow-runner.ts:347`) | `none` | 🟡 Degrades: session-leak flows fail |
| Fresh-start control (`flow-runner.ts:484`) | `none` | 🟡 Degrades: draft contention returns |

**Why the console-error default is severe.** A `noise` classification is scoped **`global`**, not
page-scoped (`statements.ts:238`), and global `noise` + `console` entries are appended to
`allowedConsoleErrorPatterns` (`statements.ts:320-329`) — which tells verification to ignore
that console error on every page, on every future run.

The codebase already knows this is dangerous. The 2026-07-20 LLM auto-noise feature
**deliberately excludes console errors** for exactly this reason, in its own comment
(`statements.ts:185-186`):

> *a `'noise'`+console entry feeds `allowedConsoleErrorPatterns` and would SUPPRESS that console
> error from ever [being reported]*

**The timeout default bypasses that safety property at the human layer.** So on the first
unattended cycle where a new console error appears and nobody answers within 5 minutes, it is
permanently allowlisted. `Failed to fetch JSON from S3` — your Critical known bug, and the entire
reason the Slack reporter exists — is exactly a console error. **The loop would teach itself to
stop reporting the bug it was built to report.**

Required before launch:

- **Change the unanswered-console-error default from `noise` to "leave unclassified"** (match the
  snapshot behaviour), or gate console classification on `AUTOQA_UNATTENDED=true` and never
  auto-noise. This is a small change in `statements.ts` and it is not optional.
- **Never let the loop reach the approve-flows prompt.** Covered by running `test --flow` and
  gating `explore` behind a human (§5). Left as-is, a `run` that triggers exploration
  auto-approves every proposed flow — and this project's own history includes an auto-proposed
  flow that drove a real browser to a live third-party Teachable checkout with an order ID.
- **Cut the timeout for unattended runs** (e.g. `AUTOQA_PROMPT_TIMEOUT_MS=20000`). At 300 s,
  a handful of unanswerable prompts adds 25+ minutes of dead wall-clock to every cycle, which
  quietly moves the runs/day figure the whole cost model in §2 is built on.
- **Then measure the residual prompt count** on one unattended `test --flow` cycle against a
  mature statement KB and a trained guard allowlist. If it's near zero, unattended is ready.
  If it isn't, the remaining prompt types need explicit policies before this ships.

### Other blockers

These are in the code today and will bite on a 24/7 loop.

1. **`agent-browser` and `tsx` are in `devDependencies`** (`package.json`). A standard
   `npm ci --omit=dev` production install breaks the runner. Move them to `dependencies` or
   install dev deps in the image.
2. **Secrets load from `../login/.env`** (per `.env.example` and the `slack-bugs.ts` header).
   That sibling path won't exist in a container. Inject via SSM Parameter Store / Secrets
   Manager instead.
3. **Artifacts still need offloading — but a container defuses the worst of it.** `reports/`
   hit 4.1 GB on *intermittent* local runs. At ~2 runs/day × 3.7 MB median (166 MB worst case)
   that is only ~7–330 MB/day, and on an ephemeral task it is discarded with the container
   anyway. **Offload to S3 before the task exits or the evidence is gone** — that inverts the
   blocker: on a box the risk is filling the disk, in a container the risk is losing the
   artifacts. Add an S3 lifecycle rule for retention.
4. **Screenshots may contain product data.** `scripts/scrub-site-secrets.mjs` exists — wire it
   into the offload path, and keep the S3 bucket private with encryption at rest.
5. **Slack has within-run dedupe but no cross-run dedupe.** The 2026-07-21 fix groups the same
   error signature *inside one run* (verified in `slack-bugs.ts`). There is no fingerprint store
   that remembers what was already posted in *previous* runs. On a 24/7 loop, every known
   standing bug — and `KNOWN_KOYAL_BUGS.md` says there are standing bugs, including the S3
   scene-generation one — re-posts every single cycle. **That's how the channel gets muted by
   day two.** Add a `bug-fingerprint → last-posted-at` record in `.autoqa-state` and suppress
   re-posts within a cooldown window (e.g. 24 h), or post a thread reply instead of a new
   message. Treat this as part of launch, not a nice-to-have.
6. **Datacenter IP / bot protection.** Runs currently originate from a residential IP. A
   datacenter IP may trip protections that never fired locally. Verify against `xp`/`beta`
   before trusting the first unattended results.
7. **Poisoned state must not be replayed forever.** CLAUDE.md documents a poisoned flow written
   into `sitemap.json` (Sign-Up / Verify-OTP milestones that aren't real product steps). A 24/7
   loop will replay bad state indefinitely. Add a periodic sanity check, or a scheduled
   `reset --sitemap` cadence.

---

## 7. The one place VeilStream is genuinely relevant

Not as a host — but you're running an autonomous agent that fills forms, uploads files, and
screenshots pages on Koyal environments. Those 4 GB of screenshots and network logs can capture
real user data, and CLAUDE.md already records live JWTs found in captured network JSON. If
`xp`/`beta` are ever seeded from production-like data, a PII-masking proxy in front of the test
database is the right category of tool for that problem. Separate decision from where the runner
lives.

---

## 8. The two-stage system: find → fix

The target architecture is two stacked, independently-deployed stages:

```
STAGE 1 — FIND (always-on)                  STAGE 2 — FIX (per-ticket, ephemeral)
┌────────────────────────────┐              ┌──────────────────────────────────┐
│ autoqa on one small box    │              │ Claude agent, one sandbox per    │
│ every 2–4 h, selected      │  ──Jira──▶   │ ticket: clone repo, reproduce,   │
│ flows, headless Chromium   │   ticket     │ fix, run tests, open PR          │
│                            │              └──────────────┬───────────────────┘
│ .autoqa-state = memory     │                             │
└────────────┬───────────────┘                             ▼
             │                                    Human reviews + merges
             │                                             │
             └──────── next cycle re-tests the flow ◀───────┘
```

Stage 1 is §5 of this document. Stage 2 is below.

### Two corrections to the obvious version of stage 2

**1. Don't spin a VM per ticket — use a container job.** A fresh VM costs 1–3 minutes of boot
before any work starts, and you pay for the whole VM lifetime. A container that starts in seconds
on a managed job runner gives the same isolation for less. The right primitives:

| If you're on | Use |
|---|---|
| Azure | **Azure Container Apps Jobs** (event-driven + cron triggers) or Container Instances |
| AWS | ECS/Fargate task, or AWS Batch |
| Anthropic-hosted | Managed Agents — no container to run at all (see below) |

**2. Isolation is still worth having** — one sandbox per ticket means two fixes can run in
parallel without fighting over git state, and a failed fix leaves nothing behind. Keep that
property; just get it from a container rather than a VM.

### The constraint that decides the design: Azure cannot host a Managed Agent

There are two real ways to build stage 2, and **your cloud choice picks for you**:

**Option A — Anthropic Managed Agents (least code).** Anthropic runs the agent loop *and* hosts a
per-session container. It already has every piece this stage needs: **scheduled deployments**
(cron-triggered sessions), **GitHub repository resources** (the repo is cloned into the sandbox
and git push is routed through an Anthropic-side proxy, so the token never enters the container),
**MCP servers** for third-party tools like Jira, and **vaults** for credentials. You write an
agent config and a small client; there is no container to build or run.

**But Managed Agents is available on the Claude API and Claude Platform on AWS only — it is not
available on Microsoft Foundry (Azure), Amazon Bedrock, or Google Vertex AI.** If Claude must be
consumed through Azure, Option A is off the table.

**Option B — Claude Agent SDK in a container you host (works on Azure).** The Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk` / `claude-agent-sdk`) is Claude Code packaged as a library:
built-in file read/write/edit, bash, grep, and web tools, plus the full agent loop. You run it in
your own container on Azure Container Apps Jobs, triggered by a Jira webhook. You own the
deployment; the harness is provided. Access Claude via the `AnthropicFoundry` client if billing
must go through Azure, or the standard client if not.

Note the SDK is a *different package* from the API's tool runner — don't substitute one for the
other. Default the model to `claude-sonnet-5`.

### Wiring Jira in

Jira is the one integration neither Replicas nor Managed Agents gives you for free (Replicas does
GitHub/Slack/Linear; Managed Agents needs an MCP server). Two directions to wire:

- **Out (autoqa → Jira):** autoqa must **file a structured issue, not just a Slack message.**
  This is a small addition next to `core/slack-bugs.ts`, which already assembles exactly the
  fields an issue needs — platform, page/location, front-end error, matching backend log,
  reproduction steps. Post to the Jira REST API, keep the Slack post as the notification.
- **In (Jira → fix agent):** a Jira webhook on "issue created with label `autoqa`" triggers the
  container job (or a Managed Agents deployment run).

### Four things that will bite, and the guardrails

1. **Duplicate tickets.** This is the cross-run dedupe gap in blocker #5 above, and it gets worse
   here: without a fingerprint store, a 24/7 loop files a *new Jira ticket every cycle* for the
   same standing bug — and each one spawns a fix agent that burns tokens re-fixing what's already
   in an open PR. **Fix cross-run dedupe before wiring Jira**, not after.
2. **The agent must not be able to silence the test.** Given a failing check, an agent can satisfy
   it either by fixing the product or by weakening the assertion. Scope stage 2's repo access to
   the **product** repo only — never to autoqa's `.autoqa-state`, statements KB, or verification
   code. A bug that vanishes because the oracle was edited is worse than the bug.
3. **Never auto-merge.** The PR is the deliverable; a human merges. autoqa's next cycle is the
   independent verification, and it only means something if the change was reviewed first.
4. **Backend bugs need the backend repo.** The S3 scene-generation failure returns HTML where JSON
   is expected — a server-side fault. An agent can only fix it with access to the service that
   serves that endpoint. **Front-end and harness-side findings are the realistic first target**;
   scope the pilot there.

### Ranking the same options for stage 2 — the order inverts

The §4 table ranks for hosting autoqa: an always-on, stateful, hours-long browser process. Stage 2
is the opposite workload — **short, stateless, ephemeral, task-triggered, one repo checkout**. So
the ranking flips.

| # | Option | Fit for the fix agent | Why |
|---|---|---|---|
| **1** | **Replicas** | ✅ **Best — it is literally this product** | Spawns **Claude Code** in an isolated VM with your repo + dev env, verifies its own work, opens a PR, reads CI failures and review comments to iterate. Task-triggered, per-runtime-minute billing, idle-sleep, 7-day cleanup — every trait that disqualified it as a host is correct here |
| 2 | Cognition (Devin) | ✅ Same category, less flexible | Purpose-built cloud coding agent. But one proprietary agent vs Replicas' choice of Claude Code / Codex / Cursor / Opencode, and agent-tier pricing |
| 3 | GitHub Actions | ✅ Strong if the product repo is on GitHub | Already attached to the repo with secrets and native PR creation; 6 h cap is ample for a fix. Near-zero new infrastructure |
| 4 | Azure Container Apps Jobs / ECS Fargate | ✅ Best DIY | Purpose-built for per-task ephemeral containers, cron *and* event triggers. **The answer if Azure is mandatory** |
| 5 | Fly.io Machines | ✅ Good DIY | Machines are designed to be created and destroyed per job, and start fast |
| 6 | EC2 / VPS | ⚠️ Works, wrong shape | You'd hand-build the queue, isolation, and cleanup that options 1–5 give you |
| 7 | AWS Lambda | ⚠️ Much better here than for stage 1, still poor | A fix run can plausibly exceed the 15 min cap, and running the product's test suite inside Lambda is awkward |
| 8 | RunPod | ❌ | Still zero GPU needed |
| 9 | VeilStream | ❌ | Still not compute |

**Two caveats on Replicas before committing:**

- **Jira is not a listed integration.** Its documented triggers are GitHub, Slack, Linear, and a
  dashboard. If Jira is fixed for you, either bridge Jira → GitHub issue, drive it via its API, or
  drop to option 4 and build stage 2 yourself.
- **It runs on its own cloud, not Azure.** If Claude and its compute must both sit inside Azure for
  policy reasons, Replicas is out and option 4 (Container Apps Jobs + Claude Agent SDK) is the pick.

### Suggested sequencing

Stage 1 and stage 2 are independently useful — don't build them at once.

1. Ship stage 1 (§5) with blocker #0 fixed. Get trustworthy unattended findings first.
2. Add cross-run dedupe, then structured Jira issue creation.
3. Only then add stage 2, scoped to one narrow front-end bug class, PRs human-reviewed.

A fix agent fed by an untrustworthy finder just automates the production of bad PRs.

---

## Sources

- [VeilStream](https://www.veilstream.com/) · [Safe Seed Data](https://www.veilstream.com/safe-seed-data) · [VeilStream for GDPR](https://www.veilstream.com/resources/veilstream-for-gdpr)
- [Replicas](https://tryreplicas.com/) · [Replicas docs](https://docs.tryreplicas.com/) · [Replicas on Y Combinator](https://www.ycombinator.com/companies/replicas)
- Anthropic model pricing: Sonnet 5 $3/$15 ($2/$10 intro through 2026-08-31) per MTok
- Run durations, artifact sizes, and state sizes measured from this repo on 2026-07-29
