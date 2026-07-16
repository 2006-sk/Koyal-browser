# Known Koyal product bugs (audio happy path)

These are **Koyal-owned** defects on [beta.koyal.ai](https://beta.koyal.ai). The QA harness detects them, records a **FAIL**, and rejects the flow. That is a successful QA result (bug found), not a harness crash.

When a run hits one of these, see also `reports/KOYAL_BUGS.md` (written for that run).

---

## `koyal-tus-trim-upload-405`

| | |
| --- | --- |
| **Owner** | Koyal |
| **Severity** | Critical (blocks audio happy path) |
| **Where** | Choose Audio Type → **Next** |
| **Symptom** | Next stays on `/upload`; never reaches Story Type / `/selectStoryType` |
| **App code path** | `handleNext` → `performTrimAndUpload` (tus) |
| **API** | `PATCH https://beta.koyal.ai/api/user/uploads/tus/<id>` |
| **Server** | nginx `405 Not Allowed` |
| **Console** | `tus upload failed`, `Error in performTrimAndUpload`, `Error in handleNext` |
| **Last known good** | Full WAV audio QA run `2026-07-11T00-28-00-090Z` (23 PASS) |
| **Not** | A happyflow / agent-browser / credentials issue |

### Repro

1. Log in to beta.koyal.ai  
2. Create / upload fork → **Start with Audio**  
3. Upload a short WAV/MP3 → select **Standard** plan  
4. Choose audio type + multilingual **No** → **Next**  
5. Observe: page does not advance; browser console shows tus 405  

### Fix (Koyal)

Allow tus `PATCH` (and related methods) on `/api/user/uploads/tus/*` in nginx / the upload service, or restore whatever upload path Next used when the 2026-07-11 run passed.

### How QA reports it

- Step workflow: `koyal-bug-koyal-tus-trim-upload-405`  
- Reasons include `KOYAL PRODUCT BUG (not a harness failure)`  
- Process exit code is non-zero (flow **rejected**) while prior steps may still be PASS  
