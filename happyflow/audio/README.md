# Koyal Audio Happy Flow QA

Agentic E2E automation for the **audio upload** path on [beta.koyal.ai](https://beta.koyal.ai).

## Test suite (2 tests — not 5)

| # | Scenario | Command | Duration | What it covers |
|---|----------|---------|----------|----------------|
| **1** | `audio-complete-wav` | `npm run qa:wav` | ~6–8 min | **Everything** — one session, short WAV |
| **2** | `audio-complete-mp3` | `npm run qa:mp3` | ~6 min | MP3 format parity + real edits |
| **Both** | WAV + MP3 | `npm run qa` | ~12–14 min | Full suite |

Legacy scripts (`qa:e2e`, `qa:back-forth`, `qa:wizard-nav`, `qa:full`) now map to the consolidated tests.

```bash
cd happyflow/audio
npm install

# Full suite (2 tests)
npm run qa

# Watch with red QA cursor
AGENT_BROWSER_HEADED=true AGENT_SHOW_CURSOR=true npm run qa
```

---

## Full flow — Test 1: `audio-complete-wav`

Single browser session. Asset: `assets/test-narration-short.wav` (~5s).

```
LOGIN (reuse login/.state/qa-auth.json)
│
├─ UPLOAD FORK          /upload → Start with Audio
├─ UPLOAD SCREEN        probe Select Sample, Record Audio, restore Upload File tab
├─ FILE UPLOAD          WAV → plan modal
├─ PLAN                 Standard → Continue
├─ AUDIO TYPE           Music → Podcast → Narration → Multilingual No → Next
├─ STORY TYPE           Character Driven probe → Use Existing modal → Concept Driven → Next
│
├─ TRANSCRIPT           /lyricedit — wait Analyzing → Processing complete
│   ├─ ✏ EDIT           transcript dialogue line (verified in snapshot)
│   ├─ emotions         Excited / Calm / Dramatic / Somber
│   ├─ NAV              story-type go-back round-trip (if enabled)
│   ├─ NAV              sidebar Theme → Review transcript
│   └─ NAV              browser back / forward
│
├─ STORY THEME          /selectTheme
│   └─ ✏ EDIT           Visual Style + Visual Narrative (both fields, verified)
│
├─ STYLE                Realistic / Animated / Sketch + Portrait/Landscape/Square probes
│   └─ final pick       Realistic + Landscape → Next
│
├─ LOCATIONS            Add New Location probe (if shown) → Next
│
├─ EDIT SCENES          /editscene — wait Create Video
│   └─ ✏ EDIT           scene description + Submit Edit / Retake / Reframe
│
├─ FINAL VIDEO          /finalvideo — Create Video → render
│   ├─ captions, Export XML, Edit Video
│   └─ ✏ EDIT           final video tweak note (verified)
│
├─ DOWNLOAD             Download Video enabled + click
│
└─ SIDEBAR ROUND-TRIP   Upload → Story → Review → Theme → Style → Scenes → Final
```

Every step saves **screenshot, snapshot, console.json, network.json** under `reports/<runId>/`.

---

## Full flow — Test 2: `audio-complete-mp3`

Same happy path with `assets/test-narration-short.mp3`. Skips redundant probes (sample/record tabs, style matrix, sidebar round-trip, back-forth) but **still performs all real edits**:

- Transcript dialogue edit
- Theme Visual Style + Narrative
- Scene description edit
- Final video edit note
- Download Video

---

## Real edits (what changed)

Previously `fillFirstEditable()` always hit the **first** field — theme narrative overwrote visual style.

Now `src/lib/audio-edits.ts` targets fields by:

| Stage | Method | Verification |
|-------|--------|--------------|
| Transcript | `editTranscriptLine()` — click segment, then fill | snapshot includes edit text |
| Story Theme | `editThemeFields()` — label **Visual Style** + **Visual Narrative** | both strings in snapshot |
| Edit Scenes | `editSceneDescription()` — Description field | snapshot includes edit text |
| Final Video | `editFinalVideoNote()` — after Edit Video | snapshot includes edit text |

Tests **fail** if edit text does not appear in the snapshot.

---

## What was merged (old → new)

| Old scenario (5 sessions) | Now in |
|---------------------------|--------|
| `audio-full-coverage` | Test 1 |
| `audio-e2e-wav` | Test 1 (superset) |
| `audio-back-and-forth` | Test 1 (transcript nav block) |
| `audio-wizard-navigation` | Test 1 (sidebar round-trip) |
| `audio-e2e-mp3` | Test 2 |

---

## Setup

Credentials from `login/.env`. Auth state from `login/.state/qa-auth.json`.

```bash
cp .env.example .env   # optional overrides
```

## Timeouts

- `AUDIO_TRANSCRIPT_WAIT_MS=180000`
- `AUDIO_SCENE_WAIT_MS=180000`
- `AUDIO_FINAL_WAIT_MS=180000`

## Reports

```
reports/<runId>/
├── report.md
├── audio-complete-wav/
│   ├── 14-transcript-edit/
│   ├── 17-theme-edit/
│   ├── 22-scene-edit/
│   └── ...
└── audio-complete-mp3/
```

## Architecture

- `scenarios/audio-complete.ts` — shared flow engine + Test 1
- `scenarios/audio-mp3.ts` — Test 2 wrapper
- `lib/audio-edits.ts` — targeted field editing
- `lib/audio-nav.ts` — resilient clicks
- `lib/page-audio.ts` — wizard waits, upload tab restore
