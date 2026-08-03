# Bugs Reported — beta.koyal.ai

**Source:** GitHub Actions run `30844077054`
**Run attempts:** `2026-08-03T19-04-33-547Z`, `2026-08-03T19-17-36-803Z`
**Reports submitted:** 6
**Distinct issue signatures:** 5
**Assessment:** 1 confirmed product bug, 1 probable product bug, 1 environment limitation reported twice, and 2 AutoQA execution/verification gaps.

> A submitted report is evidence that AutoQA observed and filed an issue. It is not, by itself, proof that the application caused the issue.

## 1. Webcam unavailable during character-method testing

**Reporting status:** SUBMITTED
**Evidence assessment:** ENVIRONMENT-SPECIFIC — not a confirmed Koyal product bug
**Where:** https://beta.koyal.ai/selectStoryType
**Workflow:** Script flow — in-flow character creation
**Checkpoint:** Exercise AI-generated, image-upload, and existing-character methods
**Issue:** Koyal attempted to access a webcam on a GitHub runner that has no camera device.

### Console errors and page exceptions

```text
Error accessing webcam: {code: 8, name: "NotFoundError", message: "Requested device not found"}
```

### Network errors

_None captured for this checkpoint._

### Assessment

This is relevant only if the tested path should work without a webcam. The missing device is expected in GitHub Actions, and the requested test did not require camera capture, so this should normally be classified as environment noise unless it blocks the other character methods.

## 2. Empty character placeholder blocked Next and could not be removed

**Reporting status:** SUBMITTED
**Evidence assessment:** PROBABLE PRODUCT BUG — needs one focused human/browser reproduction
**Where:** https://beta.koyal.ai/selectStoryType
**Workflow:** Script flow — advance from Character Driven selection
**Checkpoint:** Reach the Edit Script wizard state
**Issue:** An empty `Character 1` slot kept Next disabled. Activating Remove character produced no visible change, while two completed characters remained selected.

### Console errors and page exceptions

_None captured for this checkpoint._

### Network errors

_None captured for this checkpoint._

### Assessment

This looks like a genuine wizard-state blocker because the UI visibly remained unusable after the cleanup action. It is not fully confirmed because no console/network failure accompanied it and the hosted browser required its lost-click fallback.

## 3. Webcam unavailable during the retry attempt

**Reporting status:** SUBMITTED
**Evidence assessment:** DUPLICATE of bug 1 — environment-specific
**Where:** https://beta.koyal.ai/selectStoryType
**Workflow:** Script retry — in-flow character creation
**Checkpoint:** Exercise AI-generated, image-upload, and existing-character methods
**Issue:** The retry emitted the same missing-webcam error as the first attempt.

### Console errors and page exceptions

```text
Error accessing webcam: {code: 8, name: "NotFoundError", message: "Requested device not found"}
```

### Network errors

_None captured for this checkpoint._

### Assessment

This should have been grouped with bug 1. It is a second occurrence, not a distinct defect.

## 4. Reusable asset was not finalized before the agent left the creation flow

**Reporting status:** SUBMITTED
**Evidence assessment:** AUTOQA GAP — not established as a Koyal product bug
**Where:** https://beta.koyal.ai/assets
**Workflow:** Script retry — create one reusable asset
**Checkpoint:** Upload, name, save, and verify a reusable asset
**Issue:** AutoQA returned to the Assets list without distinct proof that the upload-backed asset had been finalized, then entered a repeated-state loop while trying to reopen the creation flow.

### Console errors and page exceptions

_None captured for this checkpoint._

### Network errors

_None captured for this checkpoint._

### Assessment

The evidence describes AutoQA failing to complete or verify its own action. There is no application error, failed request, or visible Koyal error. This should remain an automation gap unless a focused replay proves that Koyal discarded a correctly submitted asset.

## 5. Scene asset verification lost the owning project context

**Reporting status:** SUBMITTED
**Evidence assessment:** AUTOQA GAP — not established as a Koyal product bug
**Where:** https://beta.koyal.ai/assets
**Workflow:** Script retry — add the created asset to a generated scene
**Checkpoint:** Verify the exact reusable asset inside the scene's Add Assets control
**Issue:** After uploading the asset into the scene slot, AutoQA landed on the standalone Assets library and could no longer prove that the scene retained the exact asset.

### Console errors and page exceptions

_None captured for this checkpoint._

### Network errors

_None captured for this checkpoint._

### Assessment

This is a positioning and verification failure in AutoQA. The evidence does not show that Koyal rejected or lost the asset; it shows that the agent left the owning scene before completing verification.

## 6. Final-video edit operation was rejected

**Reporting status:** SUBMITTED
**Evidence assessment:** CONFIRMED PRODUCT BUG
**Where:** https://beta.koyal.ai/finalvideo
**Workflow:** Script retry — final-video edit
**Checkpoint:** Submit one concrete final-video edit and wait for processing
**Issue:** The application visibly rejected the edit after submission.

### Console errors and page exceptions

_None captured for this checkpoint._

### Network errors

_None captured for this checkpoint._

### Visible application error

```text
video is not edited please try again later
```

### Assessment

This is genuine and relevant. AutoQA reached the correct final-video function, submitted the operation, and Koyal displayed an explicit failure message. The same symptom has also appeared in earlier Script and Audio runs.

## Triage summary

| Report | Classification | Genuine Koyal bug? | Recommended handling |
| --- | --- | --- | --- |
| Webcam unavailable, attempt 1 | Environment limitation | No, unless it blocks non-camera paths | Suppress or group as hosted-environment noise |
| Empty character slot blocks Next | Probable product issue | Probably | Reproduce once in a focused browser test |
| Webcam unavailable, retry | Duplicate environment limitation | No | Merge with the first occurrence |
| Reusable asset not finalized | AutoQA gap | No evidence yet | Fix/verify AutoQA completion and persistence logic |
| Scene asset context lost | AutoQA gap | No evidence yet | Fix/verify AutoQA positioning and same-asset proof |
| Final-video edit rejected | Product failure | Yes | File/keep as a Koyal bug |
