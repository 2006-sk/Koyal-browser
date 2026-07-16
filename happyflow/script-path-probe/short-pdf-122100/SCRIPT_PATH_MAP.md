# Script Path Map — `test-script-5-second.pdf`
**Asset:** `happyflow/test-script-5-second.pdf` (~5–8s coffee shop spot)  
**Probed:** 2026-07-06 via agent-browser (`agent-short-pdf`)  
**Result:** ✅ **Full path to Final Video** (render in progress)

---

## Path (all steps reached)

```
/upload          → Start with Script
/upload          → Upload PDF → Standard → Continue → Next
/selectStoryType → Concept Driven → Next
/scriptEdit      → Engine (~90s) → Edit Script ✅
/selectTheme     → Story Theme (auto-generated) → Next
/selectStyle     → Realistic + Landscape + No → dismiss credit modal → Next
/editscene       → 4 scenes generated → Create Video ✅
/finalvideo      → Generating Video (~9:45 est) ✅
```

---

## Timing

| Phase | Duration |
|-------|----------|
| Script engine | ~90s (init → parsing → characters → tones → voices → dialogues) |
| Theme | ~instant (auto-filled) |
| Scene descriptions | ~2 min |
| Scene images (4 scenes) | ~3 min |
| Final video render | ~9:45 estimated (in progress at capture) |

---

## Transcript extracted

**Barista:** "There you go… [excited] your coffee. Five whole seconds of joy, right there."  
**Customer:** "[exhales] Mmmm… perfect."

Character Voices panel available. Play audio per line.

---

## Scenes

**4 scenes** (vs 234 on full PDF) — all got descriptions + images:
1. Hands pushing coffee cup
2. Barista (early 30s, wire-rimmed glasses, mustard cardigan)
3. Coffee shop corner window stillness
4. (4th scene in grid)

**Create Video** enabled after scene gen → clicked successfully.

---

## Final video (`/finalvideo`)

- Preview shots: Shot 1 (0:00), Shot 2 (0:01)…
- "Generating Video… Est. 9:45 remaining"
- Download Video disabled (still rendering)
- Export XML, Edit scene controls present

---

## Console / network

| Signal | Result |
|--------|--------|
| API 4xx/5xx | **None** |
| `pdf-upload` | 200 |
| `savecache` | 200 |
| Console S3 JSON errors | 6× (same `<!DOCTYPE` parse issue as large PDF) — **did not block** this run |

---

## vs other assets

| Asset | Script edit | Scenes | Final video |
|-------|-------------|--------|-------------|
| `test-script-5-second.txt` | ❌ Something went wrong | — | — |
| `2911.21nscriptn.pdf` (full) | ✅ | ❌ 234 scenes, S3 stall | — |
| **`test-script-5-second.pdf`** | ✅ | ✅ 4 scenes | ✅ Rendering |

**Recommendation:** Use short PDF (5–10s dialogue) for script-path E2E QA.
