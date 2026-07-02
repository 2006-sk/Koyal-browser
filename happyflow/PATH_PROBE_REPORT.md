# Happy Flow Path Probe Report
## Date: 2026-06-29 | Session: `happyflow` (single browser)

> **Note on earlier bad automation:** A previous script opened many sessions and filled the **Sign Up** form without clicking **Log In** first — so email/password went into **FULL NAME** / wrong fields. That was wrong. This report uses one session, snapshot-first navigation.

---

## Summary table

| Path | Works? | Farthest reached | Blocker |
|------|--------|------------------|---------|
| Login | ✅ | `/projects` | Must toggle **Log In** before filling (default is Sign Up) |
| Projects → Create card | ✅ | `/upload` fork | — |
| Dashboard → New project | ✅ | `/upload` fork | — |
| Script 5s → Standard → upload | ✅ | Plan modal → Story Type | — |
| Script 5s → Concept → Next | ⚠️ | `/scriptEdit` or `/dashboard` | Inconsistent routing; script processing fails |
| Script 5s → RESUME from project page | ⚠️ | `/selectStoryType` → `/scriptEdit` | **Something went wrong** at Edit Script |
| Script heist → Concept | ❌ | `/scriptEdit` | Voice/dialogue error (earlier runs) |
| Open project from Dashboard | ✅ | `/project/{id}` | Shows Overview + tabs + **RESUME** |
| Open project from Projects grid click | ❌ | Stays on `/projects` | Card click doesn’t open editor |
| Audio → Start with Audio | ⚠️ | Partial | Often resumes stuck script wizard instead of fresh audio UI |
| Audio → upload 5s WAV | ❌ | No file input | No `input[type=file]` on current wizard step |
| Audio → Select Sample | ❌ | No visible change | Sample picker not observed |
| Character Driven + no character | ❌ | Story Type | **Minimum 1 character required** (Next disabled) |
| Sidebar Locations | ❌ | Wizard error | `projectId is not allowed to be empty` |
| Direct `/theme` `/style` | ❌ | 404 | Only valid inside wizard SPA |
| Characters → NEW → AI Avatar | ✅ | Form opens | Create disabled until description filled |
| Theme / Style / Storyboard / Final Cut tabs | ⚠️ | RESUME sends to Story Type | Project tabs don’t navigate when wizard incomplete |

**Nobody reached:** completed video, generation screen, or Final Cut with content.

---

## What WORKS (do this manually)

### 1. Login
1. Go to `/login`
2. Click **Log In** (bottom toggle — page defaults to **Sign Up**)
3. Fill **EMAIL** and **PASSWORD** only
4. **Start Creating** → lands on `/projects`

### 2. Start a new project
- **Projects** → click **Create Your Next Video** card → `/upload`
- OR **Dashboard** → **New project** → same fork

### 3. Script path (gets you most of the way)
1. **Start with Script**
2. Upload `.txt` or `.pdf`
3. **Select Your Plan** → pick **Standard** or **Pro** → **Continue**
4. **Next** on upload step
5. **Concept Driven** → **Next**

### 4. Resume an in-progress project (best way to continue)
1. **Dashboard** → click project card (shows `InProgress · 0:00`)
2. Opens `/project/{id}` with:
   - **RESUME**
   - Tabs: Overview, Audio & Script, Theme Design, Outfits & Style, Locations, Storyboard, Final Cut
3. Click **RESUME** → returns to wizard at `/selectStoryType`

### 5. App shell / sidebar
- **Dashboard, Projects, Characters, Assets, Outfits, Collaborated Projects** — all load
- **Characters → NEW CHARACTER** — modal with Use Your Likeness / Create AI Avatar

---

## What does NOT work (blockers)

### A. Edit Script / transcript (main blocker)
At `/scriptEdit` after Concept Driven:
- **“Something went wrong”**
- **Next** disabled
- Earlier: *“Character voices data is not generated or is empty”*
- With 5s script later: *“No dialogue found”*

→ **Cannot reach Theme → Style → Storyboard → Final video** with tested scripts.

### B. Projects grid click
Clicking project card on `/projects` does **not** open the project.  
**Dashboard** project cards **do** work.

### C. Character-driven without characters
- **Minimum 1 character required** — Next stays disabled until you add/use a character.

### D. Story Type Next sometimes kicks to Dashboard
After Concept + Next, sometimes redirected to `/dashboard` instead of `/scriptEdit` (inconsistent).

### E. Audio path
- Hard to get clean **Start with Audio** UI if a script project is mid-wizard
- **Select Sample** did nothing visible
- No file input when wizard stuck on script upload step

### F. Global Locations route
`/locations` from sidebar → `projectId is not allowed to be empty`

### G. API noise
- `POST /v1/api/user/savecache` → **400** in several flows
- Console: `Failed to save project cache`

---

## Paths tried (one session)

1. Login → Projects → Create card → Script 5s → Standard → Concept → Next  
2. Same session → Dashboard → open `test-script-5-second.txt` → `/project/...`  
3. RESUME → Story Type (with character UI) → Concept → Next → `/scriptEdit` **FAIL**  
4. Wizard sidebar clicks (Theme, Style, etc.) while blocked  
5. `/upload` again for audio — landed in stuck script wizard  

---

## Recommended manual test for YOU (5s video)

1. Login (toggle **Log In** first!)
2. Dashboard → open **InProgress** project OR create fresh via Create card
3. **RESUME** → **Concept Driven** → **Next**
4. If Edit Script works, keep clicking **Next** through wizard
5. If it fails — that’s the product bug to report; try **real PDF with dialogue** or **audio upload** instead of TXT

**Files to use:**
- `happyflow/test-script-5-second.txt` (small)
- `happyflow/test-audio-5sec.wav` (5 second tone for audio test)

---

## Automation lesson learned

| Bad | Good |
|-----|------|
| 13 sessions `path1`, `path2`… | One session `happyflow` |
| Blind `@e2` fill on signup page | Read snapshot → toggle Log In → fill EMAIL/PASSWORD |
| `click_js` without reading page | Snapshot → find ref by label → click |
| Assuming Create Project = `@e7` | Read snapshot → **Create Your Next Video** = `@e12` |
