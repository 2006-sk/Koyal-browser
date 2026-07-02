# Koyal Audio Happy Flow QA

Agentic E2E automation for the **audio upload** path on [beta.koyal.ai](https://beta.koyal.ai), modeled after `login/` Phase 1 QA.

## Quick start

```bash
cd happyflow/audio
npm install
# Credentials from login/.env (KOYAL_TEST_EMAIL, KOYAL_TEST_PASSWORD)

npm run qa:full      # 100% audio path coverage — primary command (~6 min)
npm run qa:all       # full + WAV/MP3 E2E + back-forth + wizard nav (~20 min)
```

**Headed mode with persistent red QA cursor** (watch the agent work — cursor survives SPA navigation):

```bash
AGENT_BROWSER_HEADED=true AGENT_SHOW_CURSOR=true npm run qa:all
```

## What it tests


| Scenario          | Command                 | Steps | Description                                                   |
| ----------------- | ----------------------- | ----- | ------------------------------------------------------------- |
| **100% coverage** | `npm run qa:full`       | 35    | One session — every control probed, ends at Download Video    |
| **WAV E2E**       | `npm run qa:e2e`        | 7     | Upload alt WAV → transcript → theme/style → scenes → Download |
| **MP3 E2E**       | `npm run qa:mp3`        | 7     | Same flow with MP3                                            |
| **Back & forth**  | `npm run qa:back-forth` | 5     | Wizard sidebar + browser history on transcript/theme          |
| **Wizard nav**    | `npm run qa:wizard-nav` | 7     | Click every wizard sidebar step                               |
| **Full suite**    | `npm run qa:all`        | 61    | All scenarios above                                           |


Every verification step saves **screenshot, snapshot, console.json, network.json** under `reports/<runId>/`.

## 100% coverage matrix (`audio-full-coverage`)

Single session with `test-narration-short.wav` (~5s). Probes every major control; verifies no crash / no blocking errors / console+network per step. Does **not** assert visual correctness of AI output.


| Wizard stage | Controls probed                                                                |
| ------------ | ------------------------------------------------------------------------------ |
| Upload fork  | Start with Audio                                                               |
| Audio screen | Select Sample, Record Audio, Upload File (tab restore)                         |
| Plan         | Standard                                                                       |
| Audio type   | Music, Podcast, Narration + Multilingual No                                    |
| Story type   | Character Driven, Use Existing modal, Concept Driven                           |
| Transcript   | Play audio, line edit, emotion tags (Excited/Calm/Dramatic/Somber)             |
| Story Theme  | Edit Text, Visual Style + Narrative fields                                     |
| Style        | Realistic / Animated / Sketch + Portrait / Landscape / Square, camera settings |
| Locations    | Add New Location (if shown)                                                    |
| Edit scenes  | Select Scenes, Submit Edit, Retake, Reframe, Add Reference                     |
| Final video  | Preview shots, captions, Export XML, Edit Video, Download Video                |
| Sidebar      | Round-trip: Upload → Story → Review → Theme → Style → Scenes → Final           |


## Robustness

- `**AudioNav`** — multi-fallback clicks: snapshot ref → full snapshot → `find role` → text click
- `**ensureUploadFileTab()**` — restores drop zone after Record Audio / Select Sample probes
- `**wizard-phase.ts**` — phase detection from URL + snapshot
- **Character probe** — opens modal only; does not confirm selection (avoids breaking Concept Driven flow)
- **Transcript idle** — positive signals (Play audio / Next enabled) instead of fragile string absence

## Setup

```bash
cd happyflow/audio
npm install
cp .env.example .env   # optional — inherits login/.env by default
```

Credentials come from `login/.env`. Auth state is reused from `login/.state/qa-auth.json` when present.

## Test audio assets


| File                                       | Description                                      |
| ------------------------------------------ | ------------------------------------------------ |
| `assets/test-narration-short.wav` / `.mp3` | ~5s clip — full coverage, back-forth, wizard nav |
| `assets/test-narration-alt.wav` / `.mp3`   | ~12s dialogue — WAV/MP3 E2E smoke                |


Override with `KOYAL_AUDIO_SHORT_WAV`, `KOYAL_AUDIO_WAV`, etc. in `.env`.

## Timeouts

Audio processing is slow. Defaults:

- `AUDIO_TRANSCRIPT_WAIT_MS=180000` (3 min)
- `AUDIO_SCENE_WAIT_MS=180000` (3 min)
- `AUDIO_FINAL_WAIT_MS=180000` (3 min)

Full coverage ~6 min; `qa:all` ~20 min.

## Reports

```
reports/<runId>/
├── report.md
├── ARTIFACTS.md
├── audio-full-coverage/
│   ├── 01-upload-fork/
│   │   ├── screenshot.png
│   │   ├── console.json
│   │   ├── network.json
│   │   └── step-summary.md
│   └── ... (35 steps)
└── audio-e2e-wav/ ...
```

Latest passing run: `reports/2026-07-02T05-05-36-690Z/` — **61 PASS | 0 FAIL**.

## Architecture

Same patterns as `login/`:

- `page-session.ts` — login / restore auth (toggles **Log In** on signup form)
- `page-audio.ts` — wizard navigation, upload tab restore, waits, modal dismiss
- `audio-nav.ts` — resilient multi-fallback UI interactions
- `audio-selectors.ts` — regex on `snapshot -i` (not stale `@eN` refs)
- `recordVerifiedStep()` — console + network + DOM verification per step

