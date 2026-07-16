# Full Happy Flow Exploration Report
**Date:** 2026-06-29 | **Session:** `happyflow` (single browser, no multi-session spam)

---

## TL;DR

| Path | Result | Farthest step |
|------|--------|---------------|
| **Audio upload (dialogue WAV)** | ✅ **SUCCESS** | `/finalvideo` — **Download Video enabled**, 4 shots (~10s) |
| Script — coffee shop heist (422 lines) | ❌ BLOCKED | `/scriptEdit` — "Character voices data is not generated or is empty" |
| Script — 5s spot | ❌ BLOCKED | `/scriptEdit` — "No dialogue found" |
| Character Driven + Surya avatar | ❌ BLOCKED | `/scriptEdit` — same voice error |
| Audio Select Sample | ⚠️ Not fully tested | Button visible, no sample picker observed |
| Audio Record Audio | ⚠️ Not tested | Visible on upload screen |
| Projects grid click | ❌ | Stays on `/projects` |
| Dashboard project click | ✅ | Opens `/project/{id}` + RESUME |
| Sidebar routes | ✅ | Dashboard, Projects, Characters, Assets, Outfits, Collaborated |
| Sidebar `/locations` (global) | ❌ | `projectId is not allowed to be empty` |

---

## 🎉 Audio path — END TO END (WORKS)

This is the path that actually completes a video.

### Assets used
- `test-audio-dialogue.wav` — macOS `say` generated speech (~10s):
  > "Maya walked into the coffee shop. Leo looked up and smiled. Large black coffee please, she said. Coming right up, Leo replied. The rain kept falling outside."
- Also available: `test-audio-dialogue.mp3`, `test-audio-5sec.wav`

### Steps that worked
1. Login → toggle **Log In** first
2. `/upload` → **Start with Audio**
3. Upload WAV → **Select Your Plan** → click **Standard** label → **Continue**
4. **Next** → **Choose Audio Type** → pick type (Podcast) + **No** multilingual
5. **Next** → Story Type → **Concept Driven** → **Next**
6. `/lyricedit` — wait ~1–2 min for "Analyzing Audio..." → transcript appears with line-by-line segments
7. **Next** → `/selectTheme` (Story Theme) → **Next**
8. `/selectStyle` — Realistic + Landscape + No camera change → dismiss credit upsell modal (✕) → **Next**
9. Locations step → **Next** (auto)
10. `/editscene` — 4 scenes generated (~2 min) → **Create Video**
11. `/finalvideo` — final render (~1–2 min) → **Download Video** enabled

### Final video details
- **URL:** `https://beta.koyal.ai/finalvideo`
- **4 shots:** 0:00, 0:03, 0:07, 0:09 (~10 seconds total)
- **Download Video:** enabled
- **Export XML for Premiere Pro:** enabled
- Screenshot: `screenshots/COMPLETED-VIDEO.png`

### Gotchas on audio path
- Must pick **audio type** (Music/Podcast/Narration) AND **multilingual Yes/No** before Next enables
- Wait for "Analyzing Audio..." / "Processing complete!" on lyricedit — Next stays disabled until done
- Credit package upsell modal blocks clicks — close with **✕** before Next on style page
- "Upgrade" button on style page can open same modal

---

## ❌ Script path — BLOCKED (all variants)

### Heist script (`test-script-coffee-shop-heist.txt` — 422 lines, full screenplay)
- Upload ✅ → Plan ✅ → Concept Driven ✅
- `/scriptEdit` → **"Something went wrong"**
- Error after Retry: **"Character voices data is not generated or is empty"**
- Next disabled, cannot proceed to Theme/Style/Final

### 5-second script (`test-script-5-second.txt`)
- Same flow, same block at `/scriptEdit`
- Also seen: **"No dialogue found"**

### Character Driven + existing character (Avatar Surya)
- Character selection works: Use Existing → pick Surya → Confirm ✅
- Still fails at `/scriptEdit` with same voice generation error

**Conclusion:** Script-based creation is broken at the voice/dialogue processing step. Audio-based creation bypasses this entirely.

---

## Navigation reference

### Login (correct order)
```
/login → click "Log In" toggle → fill EMAIL + PASSWORD → "Start Creating"
```
Never fill on Sign Up form (FULL NAME field = wrong).

### Wizard steps (both paths)
```
Upload file → Story Type → Review transcript → Theme → Style → Locations → Edit scenes → Final video
```

### Project page (`/project/{id}`)
- Open via **Dashboard** card click (not Projects grid)
- Tabs: Overview, Audio & Script, Theme Design, Outfits & Style, Locations, Storyboard, Final Cut
- **RESUME** returns to wizard (but script path still hits scriptEdit error)

### Characters
- `/characters` → NEW CHARACTER → Create AI Avatar
- Existing: **AvatarSurya** available via Use Existing

---

## Files created this session

| File | Purpose |
|------|---------|
| `test-audio-dialogue.wav` | Speech audio for upload path |
| `test-audio-dialogue.mp3` | MP3 variant |
| `test-audio-5sec.wav` | 5s tone (backup) |
| `explore-full-push.sh` | Automated probe (plan modal refs need LabelText clicks) |
| `FULL_EXPLORATION_REPORT.md` | This report |
| `screenshots/COMPLETED-VIDEO.png` | Final video screen with Download enabled |

---

## Recommended QA flow going forward

**For happy-path E2E automation, use the audio path:**
1. Generate speech WAV with `say` or download short narration
2. Upload → Standard plan → Podcast/Narration → No multilingual
3. Concept Driven → wait for transcript → push through wizard
4. Assert `/finalvideo` + Download Video enabled

**For script path regression:** File as known bug — `/scriptEdit` voice generation fails for TXT uploads.

---

## Automation lessons (single session)

| Do | Don't |
|----|-------|
| One `happyflow` session | Spawn path1/path2/... sessions |
| Snapshot → read labels → click refs | Blind `@e2` fill |
| Click **Log In** before credentials | Fill Sign Up FULL NAME field |
| Click **LabelText "Standard"** for plan | Click text "Standard" via eval |
| Wait for async processing (lyricedit, editscene, finalvideo) | Click Next immediately |
| Close credit upsell modal (✕) | Click Next through overlay |
