# Known Koyal product bugs (found by autoqa)

**Koyal-owned** defects on [beta.koyal.ai](https://beta.koyal.ai). autoqa detects these, records a **FAIL** with the site's own error lines as evidence, and (when `SLACK_BUGS_WEBHOOK_URL` is set) posts them to the Slack bugs channel at end of run. A detected product bug is a *successful* QA result, not a harness failure.

Distinguishing signal: a milestone that FAILED **and** carries real site-emitted error evidence (browser console error, uncaught JS exception, 5xx, or 4xx on an `/api/` call). That filter is what separates a genuine backend bug from nav-state-loss probes and marker-verification gaps (which have no error lines).

---

## `koyal-s3-scene-generation-fetch`

| | |
| --- | --- |
| **Owner** | Koyal |
| **Severity** | Critical (blocks a video from finishing on BOTH the script and audio paths) |
| **Where** | Video-creation wizard, scene-generation / final-video stage (`/editscene`, `/finalvideo`) |
| **Symptom** | Scene generation fails; the wizard cannot produce the finished video |
| **Console** | `Failed to fetch JSON from S3: SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`; `Failed to fetch data` (same error) |
| **Root cause (likely)** | A request that should return JSON from S3 is instead returning an HTML page (`<!DOCTYPE …>`) — e.g. a 4xx/redirect/error page served where a JSON asset was expected. The client then blows up parsing HTML as JSON. |
| **Reproduced** | 2026-07-09, 2026-07-13/14, and again 2026-07-16 (script m6 + audio m3, run `2026-07-16T18-31-11-702Z`, 54 PASS / 14 FAIL / 6 NEEDS-REVIEW) |
| **Not** | An autoqa / agent-browser / credentials issue — the site's own console throws it |

### Repro

1. Log in to beta.koyal.ai (email/password test account)
2. Start a new project → **Start with Script** (PDF) or **Start with Audio** (WAV)
3. Upload the source file and advance through the wizard toward scene generation
4. Observe: at the scene-generation / final-video step, the browser console shows `Failed to fetch JSON from S3` / `Failed to fetch data`, and the video does not complete

### Fix (Koyal)

Ensure the scene-generation asset endpoint returns valid JSON (correct S3 object / signed URL / content-type) rather than an HTML error page. Check what the failing request actually receives (`<!DOCTYPE …>` implies an HTML error/redirect page where JSON was expected).

### How autoqa reports it

- Verdict **FAIL** on the scene-gen milestone, with the two console errors captured in `console.json` / `signals.json`
- Posted to Slack (if `SLACK_BUGS_WEBHOOK_URL` set) as: `Bug` = milestone + error summary, `Inputs` = file/plan/credentials-type/url, `Reproduction` = milestone steps, `Error log` = the console lines above
