# Koyal AI — Happy Flow Map
## Explored: 2026-06-29 (evening UTC)

Exploration method: `agent-browser` (session `happyflow-explore` / `happyflow-audio`), logged in with credentials from `login/.env`. No pass/fail assertions — observation only.

Artifacts: `happyflow/screenshots/`, `happyflow/snapshots/`, `happyflow/network/`, `happyflow/console/`.

---

## Flow overview

| Step | URL | What happens |
| ---: | --- | --- |
| 1 | `/login` | Auth gate (Phase 1). After login, lands on **`/projects`** (not `/dashboard`). |
| 2 | `/dashboard` | Creative dashboard — greeting, “New project”, “CREATE YOUR FIRST PROJECT”, project list preview. |
| 3 | `/projects` | Project library — Recent/Folders tabs, search, filter, grid view, **Create Project** / **Create Your Next Video** cards. |
| 4 | `/upload` | **Onboarding fork:** “How would you like to start?” — **Start with Script** or **Start with Audio**. Shows credit buckets: `1000s (Standard)` / `250s (Pro)`. |
| 5a | `/upload` (script) | **Upload file** step — “Upload Your Script”, PDF/TXT file picker (`#script-file-input`, accepts `.pdf,.txt`). After upload → **Select Your Plan** modal (Standard / Pro) → Continue. |
| 5b | `/upload` (audio) | **Upload file** step — **Upload File**, **Record Audio**, **Select Sample**, drag-drop zone. Formats: MP3, WAV, MP4, M4A. |
| 6 | `/upload` → `/selectStoryType` | **Story Type** — choose **Concept Driven** or **Character Driven**, then Next. Character path adds **Use existing** / **Add** (file upload) / asset picker. |
| 7 | `/scriptEdit` | **Review transcript / Edit Script** — dialogue editor, emotion labels, background score. Sidebar still shows full wizard. |
| 8 | `/scriptEdit` (wizard nav) | **Theme** — per-line emotions visible (Euphoric, Serene, Melancholy, Tense); background score section. |
| 9 | `/scriptEdit` (wizard nav) | **Style** — same shell; content not fully reachable without valid transcript (blocked). |
| 10 | `/scriptEdit` or `/locations` | **Locations** — in-flow step shows **Add New Location**, Previous/Next. Direct `/locations` without project context shows validation error. |
| 11 | wizard nav | **Edit scenes** — not reached with valid media in this session (blocked at script processing). |
| 12 | wizard nav | **Final video** — not reached; expected generation / export screen. |
| 13 | `/projects` | Completed project appears as card (e.g. `sample-script.txt`) with edit-name control. |

**Wizard sidebar labels (consistent across script/audio once in flow):**  
`Upload file` → `Story Type` → `Review transcript` → `Theme` → `Style` → `Locations` → `Edit scenes` → `Final video`

Top bar during wizard: **Dashboard** back link, **Credits** display, close (×) button.

---

## Branches discovered

### A. Entry: how to start (`/upload`)
| Choice | Next screen |
| --- | --- |
| **Start with Script** | Script file upload (PDF/TXT) |
| **Start with Audio** | Audio upload / record / sample picker |

### B. After script upload
| Choice | Effect |
| --- | --- |
| **Standard plan** (1000s) | Continues with Standard credit pool |
| **Pro plan** (250s) | Continues with Pro credit pool |

### C. Story type (`/selectStoryType`)
| Choice | Effect |
| --- | --- |
| **Concept Driven** | Proceeds toward script processing without mandatory character assets |
| **Character Driven** | Reveals **Use existing** (asset library modal), **Add** / **Choose files**, must finalize characters before proceeding |

### D. Character creation (from Characters page or story-type flow)
| Choice | Effect |
| --- | --- |
| **Use Your Likeness** | Face-training / personalization flow (not fully explored) |
| **Create AI Avatar** | Text-described avatar (AVATAR form: description + name + Create → Finalize character) |

### E. Audio upload methods
| Method | UI |
| --- | --- |
| Upload File | File picker / drop zone |
| Record Audio | Recording UI (clicked once; navigated away — not fully captured) |
| Select Sample | Button present; sample list did not open a distinct modal in this session |

### F. Projects list
| Entry | Effect |
| --- | --- |
| **Create Project** / **New project** | Opens `/upload` fork |
| Existing project card | Click did not open editor in this session (may require double-click or different target) |

---

## Input methods

| Method | Details |
| --- | --- |
| **Script file** | PDF or TXT via hidden input `#script-file-input` (label: “Choose PDF File”). Uploaded to S3 via `POST /v1/api/user/uploads/pdf-upload`. |
| **Audio file** | MP3, WAV, MP4, M4A via drop zone or Upload File. |
| **Record audio** | In-app recorder button (not fully exercised). |
| **Sample audio** | “Select Sample” button — samples loaded from `GET /v1/api/audio` (not fully exercised). |
| **Character image/files** | Character-driven path: **Choose files** / **Use existing** from asset library. |
| **AI avatar text** | Free-text character description + name on Create AI Avatar screen. |

There is **no plain-text script editor** on the first upload screen — script path expects a **file upload**, not pasted text.

---

## All selectable options found

### Plan selection (after script upload)
- **Standard** — 1000 seconds available
- **Pro** — 250 seconds available

### Story type
- **Concept Driven** — theme/emotion-led scenes, no fixed character
- **Character Driven** — consistent character across scenes

### Script edit / theme emotions (visible on transcript step)
- **Euphoric**
- **Serene**
- **Melancholy**
- **Tense**

### Characters page filters
- Type: **ALL**, **AI AVATAR**, **HUMAN CHARACTER**
- Gender: **All Genders**, **Male**, **Female**, **Others**

### Projects page
- Tabs: **Recent**, **Folders**
- Views: **Grid view**
- Search: **Search projects**
- **Filter projects**

### Credit / monetization CTAs (persistent)
- **BUY MORE CREDITS** (sidebar)
- **Buy more credits** (projects header)

---

## API endpoints observed

Grouped by exploration screen. Status codes from network captures.

### Auth & session
| Screen | Method | Endpoint | Status |
| --- | --- | --- | --- |
| login | POST | `/v1/api/user/userLogin` | 200 |

### Dashboard / projects
| Screen | Method | Endpoint | Status |
| --- | --- | --- | --- |
| dashboard | GET | `/v1/api/user/getUserDashboard` | 200 |
| projects | GET | `/v1/api/user/projects?page=1&limit=12&search=&scope=owned` | 200 |
| collaborated | GET | `/v1/api/user/projects?...&scope=shared` | 200 |
| various | GET | `/v1/api/user/available-plan` | 200 |

### Upload / script flow
| Screen | Method | Endpoint | Status |
| --- | --- | --- | --- |
| script upload | POST | `/v1/api/user/uploads/pdf-upload` | 200 |
| after upload | GET | `/v1/api/user/audio/getAudioDetails?projectId={id}` | 200 |
| wizard | POST | `/v1/api/user/savecache` | 200 / **400** |
| audio branch | GET | `/v1/api/audio` | 200 |

### Characters / assets
| Screen | Method | Endpoint | Status |
| --- | --- | --- | --- |
| characters | GET | `/v1/api/user/charcha/characters?page=1&pageSize=10` | 200 |
| characters | GET | `/v1/api/user/charcha/characters?page=1&pageSize=1000` | 200 |
| assets | GET | `/v1/api/user/assets?page=1&limit=10` | 200 |

### Realtime
| Screen | Method | Endpoint | Status |
| --- | --- | --- | --- |
| app shell | GET/POST | `/v1/socket.io/?EIO=4&transport=polling...` | 200 |

### Storage (observed after upload)
- `GET s3.ap-south-1.amazonaws.com/koyal-beta-v1/{email}/{projectId}/pdf/{filename}` — 206

---

## Sidebar items

### Dashboard (`/dashboard`)
- Greeting (“Good evening, {name}”)
- **New project** / **CREATE YOUR FIRST PROJECT**
- Embedded **Your Projects** section

### Projects (`/projects`)
- Project grid, create card, search/filter
- Empty state: “No projects yet” + **Create Project**
- After flow: project cards (e.g. `sample-script.txt`)

### Collaborated Projects (`/collaborated-projects`)
- Same layout as Projects but scope=shared
- Empty: “No collaborated projects yet”

### Characters (`/characters`)
- **NEW CHARACTER** → modal: **Use Your Likeness** | **Create AI Avatar**
- AI Avatar: text description, name, **Create**, **Finalize character**
- Filters: ALL / AI AVATAR / HUMAN CHARACTER + gender combobox
- Empty: **CREATE YOUR FIRST CHARACTER**

### Assets (`/assets`)
- **ADD ASSET** / **ADD YOUR FIRST ASSET**
- Search textbox
- Empty asset library on this account

### Locations (`/locations`)
- When opened **without active project**: in-flow wizard renders with error `"projectId" is not allowed to be empty`
- In-flow step: **Add New Location**, **Previous**, **Next**

### Outfits (`/outfits`)
- **Select a Character** — character picker sidebar with **Search characters**
- Requires existing characters (none on this account)

---

## Errors or anomalies noticed

| Issue | Where | Notes |
| --- | --- | --- |
| Login redirect | post-login | Lands on `/projects`, not `/dashboard` (known from Phase 1). |
| Script engine failure | `/scriptEdit` | After Concept Driven + minimal TXT script: **“Character voices data is not generated or is empty”** / **Something went wrong**. Retry did not recover. |
| No dialogue | `/scriptEdit` (later revisit) | **“No dialogue found”** — transcript empty for uploaded TXT; **Next** disabled. |
| savecache 400 | `/locations`, projects | `POST /v1/api/user/savecache` → 400; console: `Failed to save project cache`. |
| projectId validation | `/locations` | UI shows `"projectId" is not allowed to be empty` when navigating outside active project context. |
| Route preload warning | console | `Route /projects not found in preload map` (non-fatal). |
| Theme/Style/Final not standalone | `/theme`, `/style` | Direct URLs return **404 Page not found** — steps only exist inside wizard SPA routes (`/scriptEdit` etc.). |
| Project card click | `/projects` | Clicking `sample-script.txt` card did not navigate to editor in this session. |
| Select Sample | audio upload | Button click did not visibly change UI (samples may need network/media). |
| Record Audio | audio upload | Click appeared to navigate to `/characters` (unexpected — possible mis-click or app redirect). |

---

## Open questions

1. **What script format produces valid dialogue?** Minimal screenplay TXT uploaded successfully but yielded no dialogue / voice generation failed. Need a known-good sample PDF or longer script.

2. **How to reach Theme → Style → Locations → Edit scenes → Final video with Next enabled?** Blocked on transcript/voice processing in this session.

3. **What does the generation / completed video UI look like?** Not reached — requires completing upstream steps with valid audio + transcript.

4. **Select Sample audio** — what samples are returned from `GET /v1/api/audio` and how are they selected in UI?

5. **Record Audio** — full recorder UI and how recording feeds the wizard.

6. **Character Driven path** — exact requirements to pass “finalize all characters” gate (`Please finalize all characters before proceeding` seen in console).

7. **Opening an existing project** — correct interaction to resume wizard (single click vs double click vs menu).

8. **Style options** — visual style presets not observed (step not unlocked).

9. **Edit scenes & Final video** — scene editor layout and export/generation controls not observed.

10. **Credit consumption** — when Standard vs Pro seconds are deducted (upload, generation, or export).

11. **Global Locations library** vs **in-project Locations step** — relationship unclear; sidebar `/locations` showed wizard error.

12. **Use Your Likeness** — training flow steps not explored (likely needs photos/video).

---

## Screenshot index

| File | Screen |
| --- | --- |
| `01_projects_list.png` | Projects after login |
| `03_dashboard.png` | Dashboard |
| `04_upload_start_choice.png` | Script vs Audio fork |
| `05_script_upload_file.png` | Script upload step |
| `06_script_plan_selection.png` | Standard/Pro plan modal |
| `07_story_type.png` | Concept vs Character driven |
| `08_script_edit_error.png` | Script edit failure state |
| `09_story_type_character_driven.png` | Character-driven options |
| `11_audio_upload_choice.png` | Audio upload methods |
| `15_theme_step_blocked.png` | Theme/emotions with no dialogue |
| `16_new_character.png` | New character modal |
| `17_create_ai_avatar.png` | AI avatar creation form |
| `sidebar_*.png` | Each sidebar section |

---

## Helper tooling (not part of product)

- `happyflow/capture.sh` — wraps `agent-browser snapshot`, `screenshot --annotate`, `network requests`, `errors`, `console` into the folder structure above.
- `happyflow/sample-script.txt` — minimal script used for upload probe.
