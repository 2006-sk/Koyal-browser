import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { parseJsonArrayFromEvalStdout, resolveBlockingDialog, type AgentBrowser } from './agent-browser.js';
import { LlmBudgetExceededError, LlmClient, parseJsonFromLlm, type LlmMessage } from './llm/client.js';
import { captureRuntimeFailure } from './runtime-failure.js';
import { normalizeNetworkRequests } from './verification.js';
import { classifyAuthStatus, describeAuthFailure, pickAuthResponse } from './auth-response.js';
import type { NetworkRequest } from './types.js';
import { assessProcessingScreenshot, type ProcessingVisualAssessment } from './visual-verification.js';

export type ExplorerActionType = 'click' | 'fill' | 'select' | 'press' | 'wait' | 'upload' | 'done' | 'fail';

export interface ExplorerAction {
  action: ExplorerActionType;
  ref?: string;
  value?: string;
  /** CSS selector hint for upload actions (e.g. "#file-input") */
  selector?: string;
  reason?: string;
  /** Resolved from the snapshot line the ref pointed at — makes recipes replayable */
  resolvedLabel?: string;
  resolvedRole?: string;
  /** Set after a successful upload — the local file that was attached */
  uploadedPath?: string;
  /** Original LLM suggestion before the human-value resolver replaced it. */
  proposedValue?: string;
  /** The action was attempted but the browser rejected it; never compile it into a recipe. */
  executionFailed?: boolean;
  /** The human/destructive-action guard denied this click. */
  deniedByUser?: boolean;
  /** Synthetic deterministic barrier learned after a submitted async mutation. */
  waitForProcessing?: boolean;
  waitedMs?: number;
}

export interface ExplorerResult {
  goal: string;
  success: boolean;
  actions: ExplorerAction[];
  stepsTaken: string[];
  finalUrl: string;
  finalSnapshot: string;
  error?: string;
  /** Set when authWatch is enabled and an auth-endpoint response was observed. */
  authStatus?: number;
  /** Deterministic processing exceeded its configured ceiling while still visibly active. */
  processingTimedOut?: boolean;
}

export interface ExplorerHooks {
  /** Called before every click; return false to deny (destructive-action guard) */
  beforeClick?: (label: string, ref: string) => Promise<boolean>;
  /** Called when the LLM signals a file upload is needed; return a local path or null to decline */
  onUploadRequested?: (selectorHint: string | undefined, reason: string | undefined) => Promise<string | null>;
  /** Ask-once resolver for every non-secret free-text fill. */
  onFillRequested?: (
    label: string,
    proposedValue: string,
    context?: { sensitive: boolean; requiresFreshValue: boolean },
  ) => Promise<string>;
  /** Replace a non-secret value that the rendered page explicitly rejected. */
  onRejectedFill?: (
    label: string,
    rejectedValue: string,
    proposedValue?: string,
  ) => Promise<string>;
}

const SENSITIVE_FIELD_RE = /\b(password|passcode|pin|secret|token|api\s*key|email|e-mail|user\s*name|username)\b/i;

export function isSensitiveFieldLabel(label: string): boolean {
  return SENSITIVE_FIELD_RE.test(label);
}

/**
 * In-page async work (spinners on the same URL/state) — must be waited out, not
 * stepped through. Anchored to progress-INDICATOR phrasing, not bare verbs:
 * "generating"/"processing"/"validating" as gerunds followed by ellipsis or an
 * ETA/percentage, or an explicit "please wait" / remaining-time estimate. This
 * deliberately avoids matching static UI copy ("Image Processing", "95% cotton",
 * "Delivery est. 5 days") that would otherwise trigger a multi-minute dead wait.
 */
const IN_PROGRESS_RE =
  /(analy[sz]ing|generating|rendering|exporting|transcribing|uploading|processing|validating|initializing|loading)(\s+[\w\s]{0,40})?(\.{2,3}|…)|(?:button|link)\s+"(?:analy[sz]ing|generating|rendering|exporting|transcribing|uploading|processing|validating|initializing|loading)"[^\n]*(?:disabled|busy)|\b(?:your|the)\s+(?:film|video|asset|image|audio|project)\s+is\s+(?:rendering|generating|processing|exporting)\b|\bnow in production\b|\bplease wait\b|\btaking longer than expected\b|\bserver may be busy\b|\b(est|eta)\.?\s*[:\s]?\s*\d|\bremaining\b|\b\d{1,3}\s?%\s*(complete|done|remaining|uploaded|processed|rendered)/i;
const IN_PROGRESS_DONE_RE = /(?:processing|rendering|export) complete|100\s?%|\bdone\b\s*[!.]/i;
export const PROCESSING_VISION_POLL_THRESHOLD = 3;
/** Maximum observations of one normalized page state within a single goal. */
export const EXPLORER_STATE_VISIT_LIMIT = 4;

export function hasInlineProcessing(snapshot: string): boolean {
  return IN_PROGRESS_RE.test(snapshot) && !IN_PROGRESS_DONE_RE.test(snapshot);
}

const MUTATION_CONTROL_RE =
  /\b(new|add|create|generate|regenerate|finalize|save|submit|finish|complete|download|place order|reserve|book|upload|render|export)\b/i;

function mutationControlKey(label: string): string | undefined {
  return label
    .toLowerCase()
    .match(/\b(regenerate|generate|finalize|create|save|submit|finish|complete|render|export|upload|add|new)\b/)?.[1];
}

export function isLikelyMutationLabel(label: string): boolean {
  return MUTATION_CONTROL_RE.test(label);
}

/** Exact walk-entry target embedded by deep-walker when deterministic navigation needs LLM fallback. */
export function exactEntryTargetLabel(goal: string): string | undefined {
  return goal.match(/Click the element labeled exactly "([^"]+)" to start that flow/i)?.[1]?.trim();
}

/**
 * A walked list-card mutation is also a one-shot entry even when its generated
 * milestone uses the normal `click "ACTION (owner)"` wording rather than the
 * deep-walker's fallback-only "labeled exactly" sentence.
 */
export function contextualMutationTargetLabel(goal: string): string | undefined {
  for (const match of goal.matchAll(/\bclick\s+"([^"]+)"/gi)) {
    const label = match[1]?.trim();
    if (
      label &&
      /^.{1,80}\s+\([^()\n]{1,160}\)$/.test(label) &&
      isLikelyMutationLabel(label)
    ) {
      return label;
    }
  }
  return undefined;
}

/**
 * After async generation, many apps expose one explicit continuation such as
 * "Review and finalize" or "Finalize Asset". Returning control to the LLM
 * before honoring that control lets it misread a still-disabled outer Next as
 * failed generation and start a second item instead. Only return a candidate
 * when exactly one enabled, explicitly finalizing button is visible.
 */
export function uniquePostProcessingCompletionControl(
  snapshot: string,
): { ref: string; label: string } | null {
  const matches: Array<{ ref: string; label: string }> = [];
  for (const line of snapshot.split('\n')) {
    if (!/\bbutton\s+"/i.test(line) || /\[disabled\b/i.test(line)) continue;
    const match = line.match(/\bbutton\s+"([^"]+)"[^\n]*\[ref=(e\d+)\]/i);
    if (!match) continue;
    const label = match[1].replace(/\s+/g, ' ').trim();
    if (
      !/^(?:review\s+(?:and|&)\s+finalize|finalize(?:\s+[\w -]+)?|finish|complete|save(?:\s+(?:changes?|item|character|asset|outfit|project))?)$/i.test(
        label,
      )
    ) {
      continue;
    }
    matches.push({ ref: `@${match[2]}`, label });
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Narrow post-mutation detector; bare badges are safe only after a real mutation. */
export function hasPostMutationProcessing(snapshot: string): boolean {
  return (
    hasInlineProcessing(snapshot) ||
    /(?:text|status|badge)\s+"(?:processing|pending|finalizing|generating|rendering|uploading)"|\b(?:processing|pending|finalizing|generating|rendering|uploading)\s+(?:badge|status)\b/i.test(snapshot)
  );
}

/** Persistent-library proof that the artifact itself is still pending. */
export function hasPendingArtifactBadge(snapshot: string): boolean {
  return (
    /(?:statictext|text|status|badge)\s+"(?:processing|pending|finalizing|generating|rendering|uploading)"/i.test(snapshot) ||
    /button\s+"[^"]*\bregenerate\b[^"]*"[^\n]*disabled/i.test(snapshot)
  );
}

const COMPLETION_CONTROL_RE =
  /(?:button|link)\s+"[^"]*\b(?:create|generate|regenerate|finalize|save|next|continue|submit|finish|complete)\b[^"]*"[^\n]*(?:disabled|busy)/i;
const VISIBLE_VALIDATION_RE =
  /\b(?:not allowed|already (?:exists|used|taken|in use)|only [^.\n]{0,80} allowed|required|invalid|must (?:be|contain|have)|cannot|can't|validation error|failed)\b/i;
const RECOVERABLE_FIELD_VALIDATION_RE =
  /\b(?:not allowed|already (?:exists|used|taken|in use)|(?:name|value|entry)\s+is\s+taken|invalid (?:name|value|entry)|only [^.\n]{0,80} allowed|must (?:be|contain|have))\b/i;

/** Narrow vision trigger: a completion control is disabled and a concrete validation reason is visible. */
export function hasBlockingValidationState(snapshot: string): boolean {
  return COMPLETION_CONTROL_RE.test(snapshot) && VISIBLE_VALIDATION_RE.test(snapshot);
}

export function hasRecoverableFieldValidation(snapshot: string): boolean {
  return COMPLETION_CONTROL_RE.test(snapshot) && RECOVERABLE_FIELD_VALIDATION_RE.test(snapshot);
}

function refForFieldLabel(snapshot: string, label: string): string | undefined {
  const target = label.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const line of snapshot.split('\n')) {
    const match = line.match(
      /(?:textbox|searchbox|combobox|spinbutton)\s+"([^"]*)"[^\n]*\[ref=(e\d+)\]/i,
    );
    if (!match) continue;
    const visible = match[1].toLowerCase().replace(/\s+/g, ' ').trim();
    if (visible === target || visible.includes(target) || target.includes(visible)) {
      return `@${match[2]}`;
    }
  }
  return undefined;
}

/**
 * Some forms leave the previous textarea visible when a new required field
 * appears. If that new field's own accessible name contains the validation
 * constraint, the rejection belongs to it—not to the most recent old fill.
 */
export function validationTargetsDifferentField(snapshot: string, recentLabel: string): boolean {
  const recentRef = refForFieldLabel(snapshot, recentLabel);
  if (!recentRef) return false;
  for (const line of snapshot.split('\n')) {
    const match = line.match(
      /(?:textbox|searchbox|combobox|spinbutton)\s+"([^"]*)"[^\n]*\[ref=(e\d+)\]/i,
    );
    if (!match || !RECOVERABLE_FIELD_VALIDATION_RE.test(match[1])) continue;
    if (`@${match[2]}` !== recentRef) return true;
  }
  return false;
}

/**
 * State-level loop identity for Explorer. Refs and timing/count noise are not
 * semantic progress; checked/disabled/value/error text and the URL remain.
 * This catches short cycles whose individual actions differ (A → B → modal →
 * close → A), which the exact action-signature guard cannot see.
 */
export function explorerStateSignature(url: string, snapshot: string): string {
  const stableSnapshot = snapshot
    .toLowerCase()
    .replace(/\[ref=e\d+\]/g, '')
    // Generated media/cache URLs and opaque task ids change after every retry
    // while the actionable UI can remain exactly the same. They are evidence,
    // not state identity.
    .replace(/https?:\/\/[^\s"']+/g, '<url>')
    .replace(/\b[a-f0-9]{12,}\b/gi, '<id>')
    .replace(/\b[a-z0-9_-]{24,}\b/gi, '<token>')
    .replace(/\b\d+(?:\.\d+)?(?:%|s|sec|seconds?|min|minutes?)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 5000);
  return `${url}|${stableSnapshot}`;
}

export function isSafeStateCycleRecoveryLabel(label: string): boolean {
  return /^(?:next|continue|save and continue|proceed|advance|go forward)$/i.test(
    label.trim(),
  );
}

/**
 * A recurring state may still have one obvious, non-mutating way forward.
 * Resolve it deterministically so loop arbitration cannot miss a visible Next
 * merely because the LLM returned `done`/`fail`. Ambiguous or disabled
 * candidates are deliberately rejected.
 */
export function uniqueSafeStateCycleRecoveryControl(
  snapshot: string,
): { ref: string; label: string; role: string } | null {
  const matches = new Map<string, { ref: string; label: string; role: string }>();
  for (const line of snapshot.split('\n')) {
    if (/\bdisabled\b|aria-disabled\s*=\s*true/i.test(line)) continue;
    const match = line.match(
      /^\s*-\s*(button|link)\s+"([^"]+)"[^\n]*\[ref=(e\d+)\]/i,
    );
    if (!match) continue;
    const label = match[2].replace(/\s+/g, ' ').trim();
    if (!isSafeStateCycleRecoveryLabel(label)) continue;
    const ref = `@${match[3]}`;
    matches.set(ref, { ref, label, role: match[1].toLowerCase() });
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

export function explicitGoalValue(goal: string): string | undefined {
  return goal.match(/When entering test text, use exactly:\s*"([^"]+)"/i)?.[1];
}

/** A create/generate goal consumes name-like identities; saved names must not be reused. */
export function requiresFreshArtifactIdentity(
  goal: string,
  label: string,
  priorActions: ExplorerAction[],
): boolean {
  if (
    !/\b(name|title|slug|identifier)\b/i.test(label) ||
    /\b(email|user\s*name|username|login|search|description|prompt)\b/i.test(label)
  ) {
    return false;
  }
  return (
    /\b(create|generate|regenerate|add\s+(?:a\s+)?new|new\s+(?:character|asset|outfit|location|project|item|artifact))\b/i.test(goal) ||
    priorActions.some(
      (action) =>
        action.action === 'click' &&
        !action.executionFailed &&
        /\b(create|generate|add new|new character|new asset|new outfit|new location)\b/i.test(
          action.resolvedLabel ?? '',
        ),
    )
  );
}

/**
 * Some async generators remount their review form after media generation. The
 * DOM shows the old name, but the new form's internal state never received an
 * input event, so its enabled-looking Finalize button becomes a no-op. Refill
 * only prior non-secret identity fields that are visibly present; descriptions
 * and prompts are deliberately excluded because re-entering them can trigger a
 * second generation.
 */
export function identityReassertionsForReview(
  goal: string,
  priorActions: ExplorerAction[],
  reviewSnapshot: string,
): Array<{ ref: string; label: string; value: string }> {
  const seen = new Set<string>();
  const out: Array<{ ref: string; label: string; value: string }> = [];
  for (const action of [...priorActions].reverse()) {
    if (
      action.action !== 'fill' ||
      action.executionFailed ||
      !action.value ||
      !action.resolvedLabel ||
      isSensitiveFieldLabel(action.resolvedLabel) ||
      !requiresFreshArtifactIdentity(goal, action.resolvedLabel, priorActions)
    ) {
      continue;
    }
    const key = action.resolvedLabel.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = refForFieldLabel(reviewSnapshot, action.resolvedLabel);
    if (ref) out.push({ ref, label: action.resolvedLabel, value: action.value });
  }
  return out;
}

export function shouldDeferUnlabelledProgressClick(
  returnOnUrlChange: boolean | undefined,
  resolvedLabel: string | undefined,
  hasVisualEvidence: boolean,
): boolean {
  return Boolean(returnOnUrlChange && !resolvedLabel?.trim() && !hasVisualEvidence);
}

export function snapshotRefIsDisabled(snapshot: string, ref: string): boolean {
  const bareRef = ref.replace(/^@/, '');
  return snapshot
    .split('\n')
    .some(
      (line) =>
        new RegExp(`\\bref=${bareRef}\\b`).test(line) &&
        (/\bdisabled\b/i.test(line) || /\baria-disabled=(?:"?true"?)/i.test(line)),
    );
}

function isForwardBoundaryLabel(label: string | undefined): boolean {
  return /^(?:next|proceed|finish|complete step|go forward)(?:\s*[›»→>])?$/i.test(
    label?.trim() ?? '',
  );
}

export function goalRequiresObservableProgress(goal: string): boolean {
  return /\b(click|open|update|edit|save|advance|navigate|select|choose|fill|enter|upload|create|generate|regenerate|render|submit|remove|add|change|apply|finalize)\b/i.test(
    goal,
  );
}

function reasonClaimsIdempotentCompletion(reason: string | undefined): boolean {
  return /already (done|exists|added|filled|there|complete|completed|open|opened|selected|saved)|no need to|not needed|nothing (left|more) to do|skip(ping)? (it|this)|appears already done/i.test(
    reason ?? '',
  );
}

/**
 * A goal that asks for a mutation/navigation cannot become successful merely
 * because the LLM says "done" after several clicks that left the exact same
 * page rendered. Require a URL or semantic full-page state transition. Pure
 * verify/wait goals remain valid on an unchanged page, and explicit idempotent
 * completion remains valid for goals that intentionally support resume.
 */
export function doneHasObservableProgress(
  goal: string,
  startUrl: string,
  startStateSignature: string | undefined,
  currentUrl: string,
  currentSnapshot: string,
  reason?: string,
): boolean {
  if (!goalRequiresObservableProgress(goal)) return true;
  if (reasonClaimsIdempotentCompletion(reason)) return true;
  if (!startStateSignature) return true;
  if (currentUrl && startUrl && currentUrl !== startUrl) return true;
  return explorerStateSignature(currentUrl, currentSnapshot) !== startStateSignature;
}

function buildSystemPrompt(siteDescription: string, siteHints: string[]): string {
  const hints = siteHints.length
    ? `\nSite-specific hints learned from previous runs:\n${siteHints.map((h) => `- ${h}`).join('\n')}\n`
    : '';
  return `You are the exploration layer for an automated QA agent testing ${siteDescription}.

You receive an accessibility snapshot with @ref element IDs (e.g. @e4). Your job is to choose the NEXT single browser action to progress toward the stated goal.

Rules:
- Only use refs that appear in the current snapshot.
- Prefer semantic matches (button names, field labels) over guessing.
- For fill actions, use the exact value provided in the goal when filling credentials. EXCEPTION: if the goal specifies an exact literal value for a NAME-like field (not credentials), and the current snapshot shows a visible format constraint near that field (e.g. "letters only", "no numbers", "no spaces or special characters") that the literal value would violate, adapt the value to satisfy the constraint (e.g. strip digits/hyphens/spaces) instead of typing it verbatim and letting the site reject it — the goal's intent is a plausible test value, not that exact string.
- Keep user-provided seed values unless a visible validation rule requires a minimal correction. Never replace one with an unrelated fictional, celebrity, themed, joke, or QA-looking value.
- For a person/character name when no value is supplied, use a normal human name such as "Jason" (and obey visible letters/spacing rules). Never invent handles such as CommanderZephyr123.
- For a character description when no value is supplied, use a natural description such as "A friendly young pilot with short brown hair, a navy flight jacket, and a calm, confident expression." Never enter random tokens, test markers, or nonsense prose.
- When the goal is to CREATE or GENERATE an artifact and a duplicate/existing-item dialog offers both "use existing" and "replace/create new", choose the safe replace/create-new path. Reusing an existing item does not prove that generation works. Only use an existing artifact when the goal explicitly asks to reuse/select one, or when replacement is visibly destructive beyond this test artifact.
- For a native <select> dropdown (snapshot shows "combobox" with nested "option" lines, NOT a custom-styled widget), use action "select" with the ref of the combobox itself and "value" set to the exact visible text of the target option — do NOT use "click" on the option, clicking native select options is unreliable.
- If a field must be submitted with a keyboard key (e.g. a search/todo/tag input with NO visible submit button, only responds to pressing Enter), first "fill" the field with the text, THEN issue a SEPARATE action "press" with "value" set to the key name (e.g. "Enter") as the very next step — do NOT put a key name into a "fill" value, "fill" only ever sets the field's text content, it can never submit anything.
- If the goal requires attaching a local file, respond with action "upload" (you cannot attach files yourself; the harness will do it mechanically). Include a "selector" if a file input's CSS id/selector is apparent.
- If your step history already shows an "upload" action, and the snapshot still shows that same filename attached (e.g. next to a remove/"×" control) with an advance control (Next/Continue/Submit) now enabled, the file IS attached — do not "upload" again. A tiny or "0.00 MB"/"0 KB"-looking size next to the filename does not mean the upload failed (some real test files are only a few KB, and their true size will never look bigger no matter how many times you retry) — trust the filename + enabled advance control over an ambiguous size readout, and click the advance control (or use "done") instead of repeating the same upload.
- Never click a control marked disabled. A disabled Next/Continue means the current screen is still processing or has an unmet requirement. Wait or satisfy that requirement. Never bypass it by clicking a wizard sidebar, breadcrumb, progress-step label, or direct route; if the current step cannot advance after reasonable waiting and no corrective field/choice exists, use "fail" and describe the visible blocker.
- Use action "done" when the goal is clearly achieved in the current snapshot/URL.
- Use action "fail" only if the goal is impossible (e.g. element missing after reasonable attempt).
- If a prior step says an action was denied by the user, do not retry it — choose another path.
- Respond with JSON only, no markdown.
${hints}
JSON schema:
{
  "action": "click" | "fill" | "select" | "press" | "wait" | "upload" | "done" | "fail",
  "ref": "@eN",
  "value": "string for fill/select/press (press: key name e.g. Enter, Tab, Escape)",
  "selector": "CSS selector for upload only (optional)",
  "reason": "brief explanation"
}`;
}

/** Resolve the role + accessible name of a snapshot line containing [ref=eN]. */
export function resolveRefLabel(
  snapshot: string,
  ref: string,
): { role?: string; label?: string } {
  const refId = ref.replace(/^@/, '');
  const line = snapshot.split('\n').find((l) => l.includes(`[ref=${refId}]`));
  if (!line) return {};
  const match = line.match(/-?\s*([a-zA-Z]+)\s+"([^"]+)"/);
  if (!match) return {};
  return { role: match[1].toLowerCase(), label: match[2] };
}

function truncateSnapshot(snapshot: string, maxChars: number): string {
  if (snapshot.length <= maxChars) return snapshot;
  // keep head AND tail — primary buttons (Next/Continue) usually sit at the
  // end of the accessibility tree, after long content lists
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${snapshot.slice(0, head)}\n… [${snapshot.length - maxChars} chars omitted] …\n${snapshot.slice(-tail)}`;
}

export class Explorer {
  private readonly llm: LlmClient;
  private readonly hooks: ExplorerHooks;
  private siteDescription: string;
  private siteHints: string[];
  /** Secret strings (passwords, etc.) to mask from logs + persisted step history. */
  private redactions: string[] = [];

  /** Register secret values to scrub from console output and recorded steps (NOT from the LLM prompt, which needs them to type). */
  setRedactions(values: Array<string | undefined>): void {
    this.redactions = values.filter((v): v is string => Boolean(v) && v!.length >= 3);
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of this.redactions) out = out.split(secret).join('«redacted»');
    return out;
  }

  /** Capture a short-lived screenshot for a bounded stuck-path vision recheck. */
  private captureVisionImage(): { data: string; mediaType: 'image/png' } | undefined {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-vision-'));
    const filePath = path.join(dir, 'page.png');
    try {
      this.browser.screenshotAnnotated(filePath);
      return { data: fs.readFileSync(filePath).toString('base64'), mediaType: 'image/png' };
    } catch {
      return undefined;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Ask vision to arbitrate only after text-based processing has stayed unchanged for several polls. */
  private async affirmProcessingState(
    goal: string,
    url: string,
    observations: string,
  ): Promise<ProcessingVisualAssessment | undefined> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-processing-vision-'));
    const filePath = path.join(dir, 'page.png');
    try {
      this.browser.screenshotAnnotated(filePath);
      return await assessProcessingScreenshot(this.llm, filePath, {
        action: goal,
        url,
        observations,
      });
    } catch (error) {
      console.warn(
        `  [vision] processing affirmation unavailable: ${error instanceof Error ? error.message : error}`,
      );
      return undefined;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  constructor(
    private readonly browser: AgentBrowser,
    options?: {
      llm?: LlmClient;
      hooks?: ExplorerHooks;
      siteDescription?: string;
      siteHints?: string[];
    },
  ) {
    this.llm = options?.llm ?? new LlmClient();
    this.hooks = options?.hooks ?? {};
    this.siteDescription = options?.siteDescription ?? config.baseUrl;
    this.siteHints = options?.siteHints ?? [];
  }

  setSiteContext(description: string, hints: string[]): void {
    this.siteDescription = description;
    this.siteHints = hints;
  }

  /**
   * Feed a concrete screenshot-only validation diagnosis back into the normal
   * human field-value channel. Some canvases/modals expose the rejection only
   * visually, so the in-loop accessibility trigger cannot see it.
   */
  async recoverRejectedFillFromVision(
    result: ExplorerResult,
    visualSummary: string,
  ): Promise<boolean> {
    if (!this.hooks.onRejectedFill || !RECOVERABLE_FIELD_VALIDATION_RE.test(visualSummary)) {
      return false;
    }
    const rejectedFill = [...result.actions]
      .reverse()
      .find(
        (action) =>
          action.action === 'fill' &&
          !action.executionFailed &&
          action.value &&
          action.resolvedLabel &&
          !isSensitiveFieldLabel(action.resolvedLabel),
    );
    if (!rejectedFill?.value || !rejectedFill.resolvedLabel) return false;

    let fullSnapshot = result.finalSnapshot;
    try {
      fullSnapshot = this.browser.snapshotFull();
    } catch {
      return false;
    }
    const currentRef = refForFieldLabel(fullSnapshot, rejectedFill.resolvedLabel);
    // A later field's validation must never invalidate an earlier field that
    // has already disappeared (live Koyal asset description → asset-name step).
    if (!currentRef) return false;
    if (validationTargetsDifferentField(fullSnapshot, rejectedFill.resolvedLabel)) return false;

    const replacement = await this.hooks.onRejectedFill(
      rejectedFill.resolvedLabel,
      rejectedFill.value,
      rejectedFill.proposedValue,
    );
    if (!replacement || replacement === rejectedFill.value) return false;

    const recoveryFill: ExplorerAction = {
      action: 'fill',
      ref: currentRef,
      value: replacement,
      proposedValue: rejectedFill.proposedValue,
      resolvedLabel: rejectedFill.resolvedLabel,
      resolvedRole: rejectedFill.resolvedRole,
      reason: `replace value rejected by visual validation: ${visualSummary}`,
    };
    await this.executeAction(recoveryFill, result.stepsTaken);
    result.actions.push(recoveryFill);
    this.browser.wait(config.actionDelayMs);
    result.finalSnapshot = this.browser.snapshotFull();
    result.stepsTaken.push(
      `vision rejected "${rejectedFill.value}" for "${rejectedFill.resolvedLabel}"; ` +
        `the human supplied a different authoritative value "${replacement}"`,
    );
    return true;
  }

  async achieveGoal(
    goal: string,
    options?: {
      maxSteps?: number;
      visionFirst?: boolean;
      authWatch?: RegExp;
      /** Controls already fired in this goal chain; never execute them again. */
      blockedClickLabels?: string[];
      /** Deep-walk one-screen goals return as soon as navigation proves advancement. */
      returnOnUrlChange?: boolean;
    },
  ): Promise<ExplorerResult> {
    const maxSteps = options?.maxSteps ?? config.llm.maxStepsPerGoal;
    const actions: ExplorerAction[] = [];
    const stepsTaken: string[] = [];
    let repeatCount = 0;
    let lastSignature = '';
    let processingWaitedMs = 0;
    let suppressProcessingUntilAction = false;
    let processingVisuallyComplete = false;
    let lastRealUrl = this.browser.getUrl();
    const goalStartUrl = lastRealUrl;
    let blankRecoveryAttempts = 0;
    const validationVisionStates = new Set<string>();
    let rejectedFillRecoveryUsed = false;
    let stateCycleRecoveryUsed = false;
    let goalStartStateSignature: string | undefined;
    const deniedClickLabels = new Set<string>();
    const stateVisitCounts = new Map<string, number>();
    const submittedMutation = (): boolean =>
      actions.some(
        (action) =>
          action.action === 'click' &&
          !action.executionFailed &&
          isLikelyMutationLabel(action.resolvedLabel ?? ''),
      );
    const processingVisible = (value: string): boolean =>
      hasInlineProcessing(value) || (submittedMutation() && hasPostMutationProcessing(value));

    const goalForLog = this.redact(goal);
    console.log(`\n[explorer] Goal: ${goalForLog.slice(0, 120)}${goalForLog.length > 120 ? '…' : ''}`);

    for (let step = 0; step < maxSteps; step++) {
      // A native alert/confirm/prompt dialog freezes the page target — snapshot
      // and getUrl below both silently come back empty in that state (confirmed
      // live: `agent-browser snapshot` exits non-zero with "A JavaScript
      // confirm dialog is blocking the page"). Resolve it FIRST — otherwise the
      // isBlank check just below misreads an active dialog as a transient blank
      // page, burns the whole blank-recovery budget re-opening a URL that can
      // never actually clear a pending dialog, and the LLM never even learns a
      // dialog existed. `resolveBlockingDialog` itself works even while a
      // dialog is open (it queries the daemon's own listener state, not the
      // frozen page).
      if (resolveBlockingDialog(this.browser)) {
        stepsTaken.push('resolved a native browser dialog blocking the page (no step consumed)');
      }

      let snapshot = this.browser.snapshotInteractive();
      let url = this.browser.getUrl();

      // agent-browser's page target can detach mid-transition, reading as
      // about:blank / an empty snapshot for a beat (confirmed live, reproduced
      // 3x across separate runs: a "click a nav link" action lands here right
      // after the click, then the LLM only has "wait" available and burns the
      // WHOLE step budget on it since it never actively recovers — false-failing
      // a milestone whose click actually worked fine). deep-walker.ts already
      // has this exact recovery (reopen the last known real URL) for its own
      // loop; the generic Explorer never did. Bounded to 2 attempts so a
      // genuinely, persistently blank page still falls through to the normal
      // LLM-driven "wait"/"fail" path rather than looping forever.
      const isBlank = url.startsWith('about:') || !snapshot.trim();
      if (isBlank && blankRecoveryAttempts < 2 && lastRealUrl && !lastRealUrl.startsWith('about:')) {
        blankRecoveryAttempts++;
        console.log(
          `  [explorer] page went blank (${url || 'about:blank'}) — re-opening ${lastRealUrl} (recovery ${blankRecoveryAttempts}/2, no step consumed)`,
        );
        try {
          this.browser.open(lastRealUrl);
          this.browser.wait(2500);
        } catch (error) {
          stepsTaken.push(`blank-page recovery failed: ${error instanceof Error ? error.message : error}`);
        }
        snapshot = this.browser.snapshotInteractive();
        url = this.browser.getUrl();
      }
      if (!isBlank || (url && !url.startsWith('about:'))) lastRealUrl = url || lastRealUrl;
      if (!goalStartStateSignature && snapshot.trim() && !url.startsWith('about:')) {
        let initialSnapshot = snapshot;
        try {
          initialSnapshot = this.browser.snapshotFull();
        } catch {
          // Interactive state is still a valid conservative baseline.
        }
        goalStartStateSignature = explorerStateSignature(url, initialSnapshot);
      }

      // SPA navigation can commit just after the post-action boundary check.
      // Re-check at the START of every loop before asking the LLM anything:
      // otherwise a one-screen milestone can act once inside the next wizard
      // state (live Koyal upload: Next reached /selectStoryType a beat late,
      // then the explorer clicked the Story Type sidebar item and escaped to
      // /dashboard before noticing that the original goal had succeeded).
      if (
        options?.returnOnUrlChange &&
        url &&
        !url.startsWith('about:') &&
        goalStartUrl &&
        !goalStartUrl.startsWith('about:') &&
        url !== goalStartUrl
      ) {
        stepsTaken.push(
          `one-screen goal observed a delayed URL transition at loop start: ${goalStartUrl} → ${url}; returning before acting in the next state`,
        );
        return { goal, success: true, actions, stepsTaken, finalUrl: url, finalSnapshot: snapshot };
      }

      // A normal edit with an explicit human value is complete once Save was
      // clicked and that exact value is visible in the resulting full page.
      // Do not reopen a different row and refill forever. Creation milestones
      // carry their own explicit persistence clause and must continue onward.
      const explicitValue = explicitGoalValue(goal);
      if (
        explicitValue &&
        !goal.includes('This is a real content-creation step') &&
        stepsTaken.some((s) => /click .*\bSave\b/i.test(s))
      ) {
        const full = this.browser.snapshotFull();
        if (full.toLowerCase().includes(explicitValue.toLowerCase())) {
          stepsTaken.push('deterministic edit check: explicit human value remains visible after Save');
          return { goal, success: true, actions, stepsTaken, finalUrl: url, finalSnapshot: full };
        }
      }

      // Multi-minute server-side work (script engines, scene generation) renders as
      // spinner text on the same URL. Burning LLM steps on 1.5s "wait" actions
      // starves it and fails the goal — wait it out deterministically instead,
      // without consuming steps, bounded by one processing budget per goal.
      // Accessibility's interactive-only tree may omit the spinner/status text
      // entirely (Koyal avatar generation showed disabled Create/Finalize here,
      // while "Generating avatar... Est. 0:01 remaining" existed only in the
      // full tree). Consult the full snapshot before asking the LLM to poke a
      // disabled form during genuine server-side work.
      let processingSnapshot = snapshot;
      if (!processingVisible(processingSnapshot)) {
        try {
          processingSnapshot = this.browser.snapshotFull();
        } catch {
          // keep the interactive snapshot
        }
      }
      if (
        processingVisible(processingSnapshot) &&
        processingWaitedMs < config.deep.processingWaitMs &&
        !suppressProcessingUntilAction
      ) {
        const existingFailure = captureRuntimeFailure(this.browser);
        if (existingFailure) {
          stepsTaken.push(
            `Recorded product ${existingFailure.kind} during processing: ${existingFailure.detail}; continuing while the UI remains usable`,
          );
          this.browser.clearSignals();
        }
        console.log(
          `  [explorer] in-page processing detected — waiting it out deterministically (max ${Math.round((config.deep.processingWaitMs - processingWaitedMs) / 1000)}s)`,
        );
        const t0 = Date.now();
        const remainingWaitBudget = config.deep.processingWaitMs - processingWaitedMs;
        let polls = 0;
        let visualRelease: ProcessingVisualAssessment | undefined;
        try {
          while (Date.now() - t0 < remainingWaitBudget) {
            this.browser.wait(5000);
            polls++;
            const processingFailure = captureRuntimeFailure(this.browser);
            if (processingFailure) {
              stepsTaken.push(
                `Recorded product ${processingFailure.kind} during processing: ${processingFailure.detail}; continuing while the UI remains usable`,
              );
              this.browser.clearSignals();
            }
            let now = this.browser.snapshotInteractive();
            if (!processingVisible(now)) {
              try {
                now = this.browser.snapshotFull();
              } catch {
                // keep interactive snapshot
              }
            }
            // empty snapshot = capture/daemon error, NOT "processing finished" —
            // stop waiting and let the normal loop re-snapshot and decide
            if (!now.trim() || !processingVisible(now)) break;
            if (polls === PROCESSING_VISION_POLL_THRESHOLD) {
              const assessment = await this.affirmProcessingState(goal, url, truncateSnapshot(now, 5000));
              if (assessment) {
                stepsTaken.push(`vision processing affirmation: ${assessment.status} — ${assessment.summary}`);
                if (assessment.status === 'complete' && hasPendingArtifactBadge(now)) {
                  stepsTaken.push(
                    'vision completion withheld: the persisted artifact still has a pending/processing badge or disabled regenerate control',
                  );
                } else if (assessment.status === 'complete' || assessment.status === 'blocked') {
                  visualRelease = assessment;
                  suppressProcessingUntilAction = true;
                  processingVisuallyComplete = assessment.status === 'complete';
                  break;
                }
              }
            }
          }
        } catch (error) {
          stepsTaken.push(`processing-wait interrupted: ${error instanceof Error ? error.message : error}`);
        }
        processingWaitedMs += Date.now() - t0;
        snapshot = this.browser.snapshotInteractive();
        url = this.browser.getUrl();
        const waitedS = Math.round((Date.now() - t0) / 1000);
        const waitBudgetExhausted = Date.now() - t0 >= remainingWaitBudget;
        let stillProcessingSnapshot = snapshot;
        if (!processingVisible(stillProcessingSnapshot)) {
          try {
            stillProcessingSnapshot = this.browser.snapshotFull();
          } catch {
            // keep interactive snapshot
          }
        }
        const deterministicWaitMs = Date.now() - t0;
        if (
          (visualRelease?.status === 'complete' || !processingVisible(stillProcessingSnapshot))
        ) {
          // A spinner can disappear one render before the completed controls
          // mount (live Koyal: avatar spinner cleared, then Review/Finalize
          // appeared after the agent had already clicked Add Character).
          // Hold one short render turn before giving mutation control back to
          // the LLM, then use the settled state for the next decision.
          this.browser.wait(Math.max(config.actionDelayMs, 2000));
          snapshot = this.browser.snapshotInteractive();
          url = this.browser.getUrl();
          stillProcessingSnapshot = snapshot;
          if (!processingVisible(stillProcessingSnapshot)) {
            try {
              stillProcessingSnapshot = this.browser.snapshotFull();
            } catch {
              // keep the settled interactive snapshot
            }
          }
          stepsTaken.push('post-processing render stabilization completed before the next action');
        }
        if (!waitBudgetExhausted || visualRelease) {
          actions.push({
            action: 'wait',
            waitForProcessing: true,
            waitedMs: deterministicWaitMs,
            reason: 'deterministic processing barrier learned for replay',
          });
        }
        if (visualRelease) {
          stepsTaken.push(
            visualRelease.status === 'complete'
              ? 'vision confirmed the asynchronous operation finished; returning control to the normal goal loop'
              : 'vision found a visible blocker; returning control to the normal goal loop for recovery',
          );
        } else if (processingVisible(stillProcessingSnapshot) && waitBudgetExhausted) {
          const error =
            `Processing exceeded the configured wait ceiling (${waitedS}s) and is still visibly active. ` +
            'Classify this as a processing-timeout bug; do not click unrelated controls or restart the same state.';
          stepsTaken.push(error);
          return {
            goal,
            success: false,
            actions,
            stepsTaken,
            finalUrl: url,
            finalSnapshot: stillProcessingSnapshot,
            error,
            processingTimedOut: true,
          };
        } else if (processingVisible(stillProcessingSnapshot)) {
          stepsTaken.push(
            `processing wait ended early after ${waitedS}s while the busy state remained visible; return control for a fresh deterministic assessment`,
          );
        } else {
          stepsTaken.push(
            `waited ${waitedS}s for in-page processing to finish (deterministic, no steps consumed)`,
          );
        }

        // The action that triggered processing may also have navigated. The
        // ordinary one-screen boundary check runs immediately after actions,
        // but processing is handled at the next loop iteration before another
        // decision. Re-check the boundary here or the LLM can act once inside
        // the next wizard step (live Koyal upload: it selected Character Driven
        // before returning, then the next milestone selected Concept Driven).
        if (options?.returnOnUrlChange) {
          const afterProcessingUrl = this.browser.getUrl();
          if (
            afterProcessingUrl &&
            !afterProcessingUrl.startsWith('about:') &&
            goalStartUrl &&
            !goalStartUrl.startsWith('about:') &&
            afterProcessingUrl !== goalStartUrl
          ) {
            let finalSnapshot = stillProcessingSnapshot;
            try {
              finalSnapshot = this.browser.snapshotInteractive();
            } catch {
              // Retain the settled snapshot captured by the processing barrier.
            }
            stepsTaken.push(
              `one-screen goal advanced after processing: ${goalStartUrl} → ${afterProcessingUrl}; returning control before acting in the next state`,
            );
            return {
              goal,
              success: true,
              actions,
              stepsTaken,
              finalUrl: afterProcessingUrl,
              finalSnapshot,
            };
          }
        }

        const priorSubmittedMutation = [...actions]
          .reverse()
          .find(
            (action) =>
              action.action === 'click' &&
              !action.executionFailed &&
              isLikelyMutationLabel(action.resolvedLabel ?? ''),
          );
        const completion = priorSubmittedMutation
          ? uniquePostProcessingCompletionControl(stillProcessingSnapshot)
          : null;
        const completionBlocked = completion
          ? options?.blockedClickLabels?.some(
              (label) => label.trim().toLowerCase() === completion.label.toLowerCase(),
            )
          : false;
        if (
          completion &&
          !completionBlocked &&
          mutationControlKey(completion.label) !==
            mutationControlKey(priorSubmittedMutation?.resolvedLabel ?? '')
        ) {
          const completionAction: ExplorerAction = {
            action: 'click',
            ref: completion.ref,
            resolvedLabel: completion.label,
            resolvedRole: 'button',
            reason:
              'unique enabled finalization control appeared after processing; complete the submitted artifact before starting another item',
          };
          try {
            await this.executeAction(completionAction, stepsTaken);
            actions.push(completionAction);
            stepsTaken.push(
              `post-processing continuation: clicked the unique enabled completion control (button "${completion.label}") before permitting Add/New/Create recovery`,
            );
            suppressProcessingUntilAction = false;
            processingVisuallyComplete = false;
            resolveBlockingDialog(this.browser);
            this.browser.wait(config.actionDelayMs);
            snapshot = this.browser.snapshotInteractive();
            url = this.browser.getUrl();
            const reviewFinalizer = uniquePostProcessingCompletionControl(snapshot);
            if (
              /\breview(?:\s+and)?\s+finalize\b/i.test(completion.label) ||
              (reviewFinalizer && /\bfinalize\b/i.test(reviewFinalizer.label))
            ) {
              for (const refill of identityReassertionsForReview(goal, actions, snapshot)) {
                try {
                  this.browser.fillVisible(refill.ref, refill.value);
                  actions.push({
                    action: 'fill',
                    ref: refill.ref,
                    value: refill.value,
                    resolvedLabel: refill.label,
                    reason:
                      're-assert identity after the generated review form remounted so the enabled finalizer receives current form state',
                  });
                  stepsTaken.push(
                    `post-processing review remounted; re-asserted identity field "${refill.label}" before finalization`,
                  );
                } catch (error) {
                  stepsTaken.push(
                    `review-form identity re-assertion unavailable for "${refill.label}": ${error instanceof Error ? error.message : error}`,
                  );
                }
              }
              if (reviewFinalizer) {
                this.browser.wait(config.actionDelayMs);
                snapshot = this.browser.snapshotInteractive();
              }
            }
            if (processingVisible(snapshot)) {
              // This deterministic continuation is not an LLM decision and
              // must not consume one of the goal's step slots. Re-enter the
              // processing loop on the same logical step.
              step--;
              continue;
            }
          } catch (error) {
            completionAction.executionFailed = true;
            actions.push(completionAction);
            stepsTaken.push(
              `post-processing completion control "${completion.label}" could not be activated: ${error instanceof Error ? error.message : error}`,
            );
          }
        }
      }

      // Exact-action repetition is not enough: an explorer can alternate
      // several controls while cycling through the same two or three rendered
      // states (live Koyal case: scene A → scene B → Report Bug modal → close,
      // for 40 steps, followed by another 40-step Explorer). Count normalized
      // full-page state visits across ALL actions. On the fourth recurrence,
      // allow one screenshot/full-page arbitration for a hidden success or
      // concrete blocker, but never execute yet another speculative action.
      let cycleSnapshot = snapshot;
      try {
        cycleSnapshot = this.browser.snapshotFull();
      } catch {
        // Interactive state is still sufficient for a conservative fallback.
      }
      if (!processingVisible(cycleSnapshot)) {
        const stateSignature = explorerStateSignature(url, cycleSnapshot);
        const visits = (stateVisitCounts.get(stateSignature) ?? 0) + 1;
        stateVisitCounts.set(stateSignature, visits);
        if (visits >= EXPLORER_STATE_VISIT_LIMIT) {
          console.warn(
            `  [explorer] recurring page state observed ${visits} times — running one visual/full-page arbitration before aborting`,
          );
          let recheckReason = '';
          const deterministicForward =
            uniqueSafeStateCycleRecoveryControl(cycleSnapshot);
          try {
            const recheck = await this.decideNextAction(
              goal,
              url,
              cycleSnapshot,
              [
                ...stepsTaken,
                `The same normalized page state has recurred ${visits} times after varied actions. ` +
                  'Do not repeat any prior action and do not choose fills, uploads, mutations, modal experiments, wizard sidebars, breadcrumbs, or arbitrary controls. ' +
                  (deterministicForward
                    ? `The goal is not yet complete and exactly one enabled safe forward control exists: ${deterministicForward.role} "${deterministicForward.label}" (${deterministicForward.ref}). Choose that click now. `
                    : 'No unique enabled safe Next/Continue/Proceed control was found. ') +
                  'Use done only if the goal is visibly complete. Use wait only for a visibly active asynchronous operation; otherwise use fail and quote the visible blocker or no-progress condition.',
              ],
              this.captureVisionImage(),
            );
            recheckReason = recheck.reason ?? '';
            if (recheck.action === 'done') {
              if (
                doneHasObservableProgress(
                  goal,
                  goalStartUrl,
                  goalStartStateSignature,
                  url,
                  cycleSnapshot,
                  recheck.reason,
                )
              ) {
                stepsTaken.push(
                  `state-cycle full-page recheck confirmed the goal was already satisfied — ${recheckReason}`.trim(),
                );
                return {
                  goal,
                  success: true,
                  actions,
                  stepsTaken,
                  finalUrl: url,
                  finalSnapshot: cycleSnapshot,
                };
              }
              recheckReason =
                `done rejected: the goal requires a visible transition, but the URL and semantic page state never changed` +
                (recheck.reason ? ` — ${recheck.reason}` : '');
            }
            if (
              !stateCycleRecoveryUsed &&
              recheck.action === 'click' &&
              recheck.ref
            ) {
              const resolved = resolveRefLabel(cycleSnapshot, recheck.ref);
              if (resolved.label && isSafeStateCycleRecoveryLabel(resolved.label)) {
                recheck.resolvedLabel = resolved.label;
                recheck.resolvedRole = resolved.role;
                await this.executeAction(recheck, stepsTaken);
                actions.push(recheck);
                stepsTaken.push(
                  `state-cycle visual recovery executed one bounded safe advance click (${resolved.role ?? ''} "${resolved.label}")`,
                );
                stateCycleRecoveryUsed = true;
                stateVisitCounts.clear();
                this.browser.wait(config.actionDelayMs);
                const recoveredUrl = this.browser.getUrl();
                if (
                  options?.returnOnUrlChange &&
                  recoveredUrl &&
                  !recoveredUrl.startsWith('about:') &&
                  goalStartUrl &&
                  !goalStartUrl.startsWith('about:') &&
                  recoveredUrl !== goalStartUrl
                ) {
                  const finalSnapshot = this.browser.snapshotInteractive();
                  stepsTaken.push(
                    `one-screen goal advanced by bounded state-cycle recovery: ${goalStartUrl} → ${recoveredUrl}`,
                  );
                  return {
                    goal,
                    success: true,
                    actions,
                    stepsTaken,
                    finalUrl: recoveredUrl,
                    finalSnapshot,
                  };
                }
                continue;
              }
            }
          } catch (error) {
            recheckReason = `diagnostic unavailable: ${error instanceof Error ? error.message : error}`;
          }
          const error =
            `Explorer state-cycle detected: the same page state recurred ${visits} times without progress` +
            (recheckReason ? ` — ${recheckReason}` : '');
          stepsTaken.push(error);
          return {
            goal,
            success: false,
            actions,
            stepsTaken,
            finalUrl: url,
            finalSnapshot: cycleSnapshot,
            error,
          };
        }
      }

      console.log(`  [explorer] step ${step + 1}/${maxSteps} — asking LLM (url: ${url})...`);
      const llmStart = Date.now();
      let decisionSnapshot = snapshot;
      let decisionImage = options?.visionFirst && step === 0 ? this.captureVisionImage() : undefined;
      {
        try {
          const fullSnapshot = this.browser.snapshotFull();
          const validationState = explorerStateSignature(url, fullSnapshot);
          const recoverableFieldValidation = hasRecoverableFieldValidation(fullSnapshot);

          // Do not couple rejected-value recovery to the small vision budget.
          // Long nested forms can legitimately show several ordinary "required"
          // states before a generated preview reveals the actionable error
          // ("name already in use", invalid value, etc.). The former used to
          // consume all three slots, making the latter invisible forever.
          if (
            !rejectedFillRecoveryUsed &&
            recoverableFieldValidation
          ) {
            const rejectedFill = [...actions]
              .reverse()
              .find(
                (action) =>
                  action.action === 'fill' &&
                  !action.executionFailed &&
                  action.value &&
                  action.resolvedLabel &&
                  !isSensitiveFieldLabel(action.resolvedLabel),
              );
            if (rejectedFill?.value && rejectedFill.resolvedLabel && this.hooks.onRejectedFill) {
              const currentRef = refForFieldLabel(fullSnapshot, rejectedFill.resolvedLabel);
              if (!currentRef) {
                stepsTaken.push(
                  `visible validation belongs to the current form, but the most recent filled field "${rejectedFill.resolvedLabel}" is no longer present; refusing to misattribute the rejection`,
                );
              } else if (validationTargetsDifferentField(fullSnapshot, rejectedFill.resolvedLabel)) {
                stepsTaken.push(
                  `visible validation is attached to a different unfilled field, not the recent "${rejectedFill.resolvedLabel}" field; refusing to overwrite the accepted value`,
                );
              } else {
                rejectedFillRecoveryUsed = true;
                try {
                  const replacement = await this.hooks.onRejectedFill(
                    rejectedFill.resolvedLabel,
                    rejectedFill.value,
                    rejectedFill.proposedValue,
                  );
                  if (replacement && replacement !== rejectedFill.value) {
                    const recoveryFill: ExplorerAction = {
                      action: 'fill',
                      ref: currentRef,
                      value: replacement,
                      proposedValue: rejectedFill.proposedValue,
                      resolvedLabel: rejectedFill.resolvedLabel,
                      resolvedRole: rejectedFill.resolvedRole,
                      reason: 'replace a value explicitly rejected by visible validation',
                    };
                    await this.executeAction(recoveryFill, stepsTaken);
                    actions.push(recoveryFill);
                    stepsTaken.push(
                      `visible validation rejected "${rejectedFill.value}" for "${rejectedFill.resolvedLabel}"; ` +
                        `the human supplied a different value and the live field was refilled once`,
                    );
                    this.browser.wait(config.actionDelayMs);
                    continue;
                  }
                } catch (error) {
                  stepsTaken.push(
                    `rejected field-value recovery unavailable: ${error instanceof Error ? error.message : error}`,
                  );
                }
              }
            }
          }

          if (
            validationVisionStates.size < 3 &&
            hasBlockingValidationState(fullSnapshot) &&
            !validationVisionStates.has(validationState)
          ) {
            validationVisionStates.add(validationState);
            decisionSnapshot = fullSnapshot;
            decisionImage = this.captureVisionImage();
            stepsTaken.push(
              'narrow vision trigger: a required completion control is disabled beside visible validation text; diagnose the blocker before retrying',
            );

            // A saved human value can become invalid as site data changes
            // (duplicate name is the common case). If the rendered page
            // explicitly rejects a value, do not keep replaying it forever.
            // Replace at most once per goal, only for a recent non-secret fill,
            // and only through the normal human-value channel.
            const rejectedFill = [...actions]
              .reverse()
              .find(
                (action) =>
                  action.action === 'fill' &&
                  !action.executionFailed &&
                  action.value &&
                  action.resolvedLabel &&
                  !isSensitiveFieldLabel(action.resolvedLabel),
              );
            if (
              !rejectedFillRecoveryUsed &&
              recoverableFieldValidation &&
              rejectedFill?.value &&
              rejectedFill.resolvedLabel &&
              this.hooks.onRejectedFill
            ) {
              const currentRef = refForFieldLabel(fullSnapshot, rejectedFill.resolvedLabel);
              if (!currentRef) {
                stepsTaken.push(
                  `visible validation belongs to the current form, but the most recent filled field "${rejectedFill.resolvedLabel}" is no longer present; refusing to misattribute the rejection`,
                );
              } else if (validationTargetsDifferentField(fullSnapshot, rejectedFill.resolvedLabel)) {
                stepsTaken.push(
                  `visible validation is attached to a different unfilled field, not the recent "${rejectedFill.resolvedLabel}" field; refusing to overwrite the accepted value`,
                );
              } else {
              rejectedFillRecoveryUsed = true;
              try {
                const replacement = await this.hooks.onRejectedFill(
                  rejectedFill.resolvedLabel,
                  rejectedFill.value,
                  rejectedFill.proposedValue,
                );
                if (replacement && replacement !== rejectedFill.value && currentRef) {
                  const recoveryFill: ExplorerAction = {
                    action: 'fill',
                    ref: currentRef,
                    value: replacement,
                    proposedValue: rejectedFill.proposedValue,
                    resolvedLabel: rejectedFill.resolvedLabel,
                    resolvedRole: rejectedFill.resolvedRole,
                    reason: 'replace a value explicitly rejected by visible validation',
                  };
                  await this.executeAction(recoveryFill, stepsTaken);
                  actions.push(recoveryFill);
                  stepsTaken.push(
                    `visible validation rejected "${rejectedFill.value}" for "${rejectedFill.resolvedLabel}"; ` +
                      `the human supplied a different value and the live field was refilled once`,
                  );
                  this.browser.wait(config.actionDelayMs);
                  continue;
                }
                if (replacement && replacement !== rejectedFill.value) {
                  stepsTaken.push(
                    `visible validation rejected "${rejectedFill.value}" for "${rejectedFill.resolvedLabel}"; ` +
                      `a different human value "${replacement}" is now authoritative—refill that field before retrying`,
                  );
                }
              } catch (error) {
                stepsTaken.push(
                  `rejected field-value recovery unavailable: ${error instanceof Error ? error.message : error}`,
                );
              }
              }
            }
          }
        } catch {
          // best-effort diagnostic; retain the normal interactive decision path
        }
      }
      let decision = await this.decideNextAction(
        goal,
        url,
        decisionSnapshot,
        stepsTaken,
        decisionImage,
      );
      console.log(
        `  [explorer] LLM responded in ${Date.now() - llmStart}ms → ${decision.action}${decision.ref ? ` ${decision.ref}` : ''}${decision.reason ? ` (${decision.reason})` : ''}`,
      );

      if (decision.ref) {
        const resolved = resolveRefLabel(decisionSnapshot, decision.ref);
        decision.resolvedLabel = resolved.label;
        decision.resolvedRole = resolved.role;
        if (
          !decision.resolvedLabel &&
          (decision.action === 'click' || decision.action === 'fill' || decision.action === 'select')
        ) {
          // Nested controls can have a perfectly good DOM-accessible name even
          // when the snapshot line itself is unnamed. A common shape is a radio
          // nested inside a labelled plan/option card:
          //
          //   LabelText "Standard 536 seconds available" [ref=e18]
          //     - radio [ref=e22]
          //
          // Treating e22 as an unlabelled icon defers the click forever during a
          // one-screen walk. fieldLabelAtRef resolves aria/label/placeholder and
          // remains empty for genuinely unlabelled icon buttons, so the existing
          // screenshot-first safety rule still protects those.
          decision.resolvedLabel = this.browser.fieldLabelAtRef(decision.ref) || undefined;
        }
      }

      if (
        decision.action === 'click' &&
        decision.ref &&
        snapshotRefIsDisabled(decisionSnapshot, decision.ref)
      ) {
        decision.executionFailed = true;
        actions.push(decision);
        stepsTaken.push(
          `deferred disabled control ${decision.ref}${
            decision.resolvedLabel ? ` (${decision.resolvedRole ?? ''} "${decision.resolvedLabel}")` : ''
          }: wait for processing or satisfy the current screen; do not bypass it through wizard navigation`,
        );
        this.browser.wait(2000);
        continue;
      }

      // An unlabeled icon can be Edit, Report a Bug, Delete, or navigation; its
      // ref alone carries no semantics. During a one-screen deep walk, defer it
      // until a screenshot-assisted decision has grounded its purpose.
      if (
        decision.action === 'click' &&
        decision.ref &&
        shouldDeferUnlabelledProgressClick(
          options?.returnOnUrlChange,
          decision.resolvedLabel,
          Boolean(decisionImage),
        )
      ) {
        decision.executionFailed = true;
        actions.push(decision);
        stepsTaken.push(
          `deferred unlabeled progress click ${decision.ref}: use screenshot-assisted recovery to identify the icon before activating it`,
        );
        continue;
      }

      const normalizedDecisionLabel = decision.resolvedLabel?.trim().toLowerCase();
      if (
        decision.action === 'click' &&
        normalizedDecisionLabel &&
        deniedClickLabels.has(normalizedDecisionLabel)
      ) {
        decision.executionFailed = true;
        decision.deniedByUser = true;
        actions.push(decision);
        stepsTaken.push(
          `suppressed retry of user-denied click (${decision.resolvedRole ?? ''} "${decision.resolvedLabel}")`,
        );
        continue;
      }

      const exactEntryTarget =
        exactEntryTargetLabel(goal) ?? contextualMutationTargetLabel(goal);
      const currentMutationKey =
        decision.action === 'click' && decision.resolvedLabel
          ? mutationControlKey(decision.resolvedLabel)
          : undefined;
      const reversedPriorSameClickIndex =
        decision.action === 'click' && decision.resolvedLabel
          ? [...actions].reverse().findIndex(
              (action) =>
                action.action === 'click' &&
                !action.executionFailed &&
                (
                  action.resolvedLabel?.trim().toLowerCase() === decision.resolvedLabel!.trim().toLowerCase() ||
                  (
                    currentMutationKey &&
                    mutationControlKey(action.resolvedLabel ?? '') === currentMutationKey
                  )
                ),
            )
          : -1;
      const priorSameClickIndex =
        reversedPriorSameClickIndex < 0
          ? -1
          : actions.length - 1 - reversedPriorSameClickIndex;
      const meaningfulActionSincePriorMutation =
        priorSameClickIndex >= 0 &&
        actions
          .slice(priorSameClickIndex + 1)
          .some(
            (action) =>
              !action.executionFailed &&
              !['wait', 'done', 'fail'].includes(action.action),
          );
      const priorClickCausedProcessing =
        priorSameClickIndex >= 0 &&
        actions
          .slice(priorSameClickIndex + 1)
          .some((action) => action.action === 'wait' && action.waitForProcessing);
      const repeatedOwnMutation =
        decision.action === 'click' &&
        !!decision.resolvedLabel &&
        priorSameClickIndex >= 0 &&
        (
          priorClickCausedProcessing ||
          (isLikelyMutationLabel(decision.resolvedLabel) && !meaningfulActionSincePriorMutation)
        );
      if (repeatedOwnMutation) {
        decision.executionFailed = true;
        actions.push(decision);
        stepsTaken.push(
          `suppressed duplicate mutation click (${decision.resolvedRole ?? ''} "${decision.resolvedLabel}") — this control already executed successfully in the current goal`,
        );
        if (
          exactEntryTarget &&
          (
            exactEntryTarget.toLowerCase() === decision.resolvedLabel!.trim().toLowerCase() ||
            (
              mutationControlKey(exactEntryTarget) &&
              mutationControlKey(exactEntryTarget) === mutationControlKey(decision.resolvedLabel!)
            )
          )
        ) {
          const finalSnapshot = this.browser.snapshotFull();
          stepsTaken.push(
            `exact walk-entry mutation "${decision.resolvedLabel}" already fired once; treating the entry goal as complete instead of submitting it again`,
          );
          return {
            goal,
            success: true,
            actions,
            stepsTaken,
            finalUrl: this.browser.getUrl(),
            finalSnapshot,
          };
        }
        continue;
      }

      if (
        decision.action === 'click' &&
        decision.resolvedLabel &&
        options?.blockedClickLabels?.some(
          (label) => label.trim().toLowerCase() === decision.resolvedLabel!.trim().toLowerCase(),
        )
      ) {
        decision.executionFailed = true;
        actions.push(decision);
        stepsTaken.push(
          `suppressed duplicate mutation click (${decision.resolvedRole ?? ''} "${decision.resolvedLabel}") — this control already executed successfully in the current creation chain; poll or use a non-mutating next/recovery control instead`,
        );
        continue;
      }

      if (decision.action === 'fill' && decision.value !== undefined && this.hooks.onFillRequested) {
        const proposedValue = decision.value;
        decision.proposedValue = proposedValue;
        const label = decision.resolvedLabel ?? decision.ref ?? 'unlabelled field';
        const sensitive =
          isSensitiveFieldLabel(label) ||
          this.redactions.some((secret) => secret === proposedValue);
        try {
          decision.value = await this.hooks.onFillRequested(label, decision.value, {
            sensitive,
            requiresFreshValue: requiresFreshArtifactIdentity(goal, label, actions),
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          stepsTaken.push(`required human field input was unavailable: ${detail}`);
          return {
            goal,
            success: false,
            actions,
            stepsTaken,
            finalUrl: url,
            finalSnapshot: snapshot,
            error: `Human input unavailable for required field "${label}"`,
          };
        }
        if (sensitive) {
          stepsTaken.push('credential field resolved through the protected secret channel');
        } else if (decision.value !== proposedValue) {
          stepsTaken.push(
            `human field-value resolver replaced the proposed text with "${decision.value}"; this explicit human value is authoritative and satisfies the goal's requested test text—do not replace or "correct" it back to an old marker`,
          );
        }
      }

      const signature = `${decision.action}|${decision.ref ?? ''}|${decision.value ?? ''}`;
      if (signature === lastSignature) {
        repeatCount++;
      } else {
        repeatCount = 0;
        lastSignature = signature;
      }
      if (repeatCount >= 2) {
        // Before honestly giving up, check once whether the goal was actually
        // already achieved — live-reproduced on testpages.eviltester.com's
        // Triangle app: the goal was "verify an equilateral result is shown",
        // the app correctly computed and displayed "Equilateral" in a plain
        // <p> after the FIRST click, yet the explorer kept re-clicking
        // "Identify Triangle Type" and aborted as stuck. Root cause: this
        // decision loop's `snapshot` is ALWAYS snapshotInteractive() — by
        // design, for prompt-size/cost, since ref-addressable click/fill
        // targets only need interactive elements — but that means any
        // non-interactive confirmation/result/validation text (extremely
        // common: computed values, success banners, inline validation
        // messages) is structurally INVISIBLE to every decision this loop
        // makes, including "am I done?". A goal whose success criterion is
        // exactly that kind of static text can never be recognized, no matter
        // how many times the action is retried. Rather than widening every
        // step's snapshot (real prompt-size/cost tradeoff across every site,
        // out of scope to re-validate broadly here), give the loop ONE bounded
        // extra look at the full snapshot only in this narrow "about to abort
        // as stuck" case, reusing the same decision machinery — if it now says
        // "done", the goal really was already satisfied; anything else falls
        // through to the original honest abort unchanged.
        try {
          const fullSnapshot = this.browser.snapshotFull();
          const recheck = await this.decideNextAction(goal, url, fullSnapshot, [
            ...stepsTaken,
            'note: the interactive view showed no change after repeating this action. Use the screenshot plus FULL page content to check for a non-interactive result, visible validation rule, modal, disabled GENERATING control, or other progress state before giving up.',
          ], this.captureVisionImage());
          if (recheck.action === 'done') {
            if (
              doneHasObservableProgress(
                goal,
                goalStartUrl,
                goalStartStateSignature,
                url,
                fullSnapshot,
                recheck.reason,
              )
            ) {
              stepsTaken.push(
                `note: full-snapshot recheck confirmed the goal was already satisfied (a non-interactive result was present) — ${recheck.reason ?? ''}`.trim(),
              );
              return { goal, success: true, actions, stepsTaken, finalUrl: url, finalSnapshot: fullSnapshot };
            }
            stepsTaken.push(
              'full-snapshot done rejected: the goal requires a visible transition, but the URL and semantic page state never changed',
            );
          }
          if (decision.action === 'wait' && recheck.action === 'wait') {
            decision = recheck;
            repeatCount = 0;
            lastSignature = '';
            stepsTaken.push('vision/full-page recheck confirmed that waiting is still appropriate; repeat-loop abort suppressed');
          } else {
            return {
              goal,
              success: false,
              actions,
              stepsTaken,
              finalUrl: url,
              finalSnapshot: snapshot,
              error: `Explorer stuck repeating "${signature}" — aborting`,
            };
          }
        } catch {
          // recheck itself failed (e.g. LLM/browser hiccup) — fall through to the
          // original abort rather than letting a diagnostic-only step crash the run
        }
        if (repeatCount >= 2) {
          return {
            goal,
            success: false,
            actions,
            stepsTaken,
            finalUrl: url,
            finalSnapshot: snapshot,
            error: `Explorer stuck repeating "${signature}" — aborting`,
          };
        }
      }

      actions.push(decision);
      stepsTaken.push(
        this.redact(
          `${decision.action}${decision.ref ? ` ${decision.ref}` : ''}${decision.resolvedLabel ? ` (${decision.resolvedRole ?? ''} "${decision.resolvedLabel}")` : ''}${decision.value ? ` "${decision.value}"` : ''} — ${decision.reason ?? ''}`.trim(),
        ),
      );
      if (repeatCount === 1) {
        stepsTaken.push('note: you repeated the same action — it is not working, try a different element or approach');
      }

      if (decision.action === 'done') {
        // The interactive snapshot can omit a non-interactive spinner/overlay.
        // Never accept the LLM's "done" while the FULL page still visibly says
        // generation/processing is active (live beta.koyal.ai avatar case).
        const fullSnapshot = this.browser.snapshotFull();
        if (
          processingVisible(fullSnapshot) &&
          processingWaitedMs < config.deep.processingWaitMs &&
          !processingVisuallyComplete
        ) {
          const t0 = Date.now();
          let polls = 0;
          let visualRelease: ProcessingVisualAssessment | undefined;
          stepsTaken.push('done suppressed: full page still shows active generation/processing');
          while (Date.now() - t0 < config.deep.processingWaitMs - processingWaitedMs) {
            this.browser.wait(5000);
            polls++;
            const failure = captureRuntimeFailure(this.browser);
            if (failure) {
              stepsTaken.push(
                `Recorded product ${failure.kind} during processing: ${failure.detail}; continuing while the UI remains usable`,
              );
              this.browser.clearSignals();
            }
            const now = this.browser.snapshotFull();
            if (!now.trim() || !processingVisible(now)) break;
            if (polls === PROCESSING_VISION_POLL_THRESHOLD) {
              const assessment = await this.affirmProcessingState(goal, url, truncateSnapshot(now, 5000));
              if (assessment) {
                stepsTaken.push(`vision processing affirmation: ${assessment.status} — ${assessment.summary}`);
                if (assessment.status === 'complete' && hasPendingArtifactBadge(now)) {
                  stepsTaken.push(
                    'vision completion withheld: the persisted artifact still has a pending/processing badge or disabled regenerate control',
                  );
                } else if (assessment.status === 'complete' || assessment.status === 'blocked') {
                  visualRelease = assessment;
                  break;
                }
              }
            }
          }
          processingWaitedMs += Date.now() - t0;
          actions.push({
            action: 'wait',
            waitForProcessing: true,
            waitedMs: Date.now() - t0,
            reason: 'deterministic processing barrier learned after done was suppressed',
          });
          if (visualRelease?.status === 'complete') {
            const finalSnapshot = this.browser.snapshotFull();
            stepsTaken.push('vision confirmed processing finished after the LLM had already satisfied the goal');
            return { goal, success: true, actions, stepsTaken, finalUrl: url, finalSnapshot };
          }
          if (visualRelease?.status === 'blocked') {
            stepsTaken.push('vision found a visible blocker after done; resuming exploration instead of passing');
          }
          continue;
        }
        const doneSnapshot = fullSnapshot;
        if (
          !processingVisuallyComplete &&
          !doneHasObservableProgress(
            goal,
            goalStartUrl,
            goalStartStateSignature,
            url,
            doneSnapshot,
            decision.reason,
          )
        ) {
          stepsTaken.push(
            'done rejected: the goal requires a visible transition, but the URL and semantic page state never changed',
          );
          continue;
        }
        return { goal, success: true, actions, stepsTaken, finalUrl: url, finalSnapshot: doneSnapshot };
      }

      if (decision.action === 'fail') {
        return {
          goal,
          success: false,
          actions,
          stepsTaken,
          finalUrl: url,
          finalSnapshot: snapshot,
          error: decision.reason ?? 'Explorer reported goal impossible',
        };
      }

      try {
        await this.executeAction(decision, stepsTaken);
        if (decision.deniedByUser && decision.resolvedLabel) {
          deniedClickLabels.add(decision.resolvedLabel.trim().toLowerCase());
        }
        if (decision.action !== 'wait') {
          suppressProcessingUntilAction = false;
          processingVisuallyComplete = false;
        }
      } catch (error) {
        decision.executionFailed = true;
        const msg = error instanceof Error ? error.message : String(error);
        stepsTaken.push(`action failed: ${msg}`);
        console.warn(`  [explorer] action failed (will re-snapshot): ${msg}`);
      }
      // A click can open a native dialog synchronously — confirmed live: the
      // click command itself succeeds, but this VERY NEXT wait() call then
      // throws ("A JavaScript confirm dialog is blocking the page"), which is
      // uncaught here and would abort achieveGoal entirely before the loop-top
      // dialog check ever runs. Resolve it right away, before waiting.
      resolveBlockingDialog(this.browser);
      try {
        this.browser.wait(config.actionDelayMs);
      } catch {
        // a dialog may have appeared between the check above and this wait
        // (rare timing edge) — resolve once more and move on regardless.
        resolveBlockingDialog(this.browser);
      }

      // A wait can be the final action on a screen: the preceding Save/Continue
      // may complete asynchronously and navigate while we are polling. Treat
      // that transition exactly like click-driven navigation or this one-screen
      // goal will leak an edit/click into the next wizard milestone.
      if (options?.returnOnUrlChange) {
        let navigatedUrl = this.browser.getUrl();
        if (
          navigatedUrl === goalStartUrl &&
          decision.action === 'click' &&
          !decision.executionFailed &&
          isForwardBoundaryLabel(decision.resolvedLabel)
        ) {
          // A framework may accept the click, disable Next, save remotely, and
          // only commit the route several seconds later. Do not hand that
          // transient state back to the LLM, which may otherwise "solve" it by
          // clicking a wizard breadcrumb and leaving the workflow.
          const settleStartedAt = Date.now();
          while (Date.now() - settleStartedAt < 15_000) {
            this.browser.wait(2000);
            navigatedUrl = this.browser.getUrl();
            if (
              navigatedUrl &&
              !navigatedUrl.startsWith('about:') &&
              navigatedUrl !== goalStartUrl
            ) {
              break;
            }
          }
          if (navigatedUrl === goalStartUrl) {
            stepsTaken.push(
              `forward control "${decision.resolvedLabel}" landed but produced no URL transition during a 15s settle window; re-check the current screen without using wizard navigation`,
            );
          }
        }
        if (
          navigatedUrl &&
          !navigatedUrl.startsWith('about:') &&
          goalStartUrl &&
          !goalStartUrl.startsWith('about:') &&
          navigatedUrl !== goalStartUrl
        ) {
          const finalSnapshot = this.browser.snapshotInteractive();
          stepsTaken.push(
            `one-screen goal advanced by URL transition: ${goalStartUrl} → ${navigatedUrl}; returning control to the deep walker for state classification`,
          );
          return { goal, success: true, actions, stepsTaken, finalUrl: navigatedUrl, finalSnapshot };
        }
      }

      // authWatch (login goals only): after a submit-shaped action, WAIT for the
      // async auth response rather than letting the LLM re-click a form that
      // hasn't answered yet. This is the fix for the filmarena login spam →
      // self-induced 429: the explorer fired ~7 submit clicks because it never
      // saw the response. A 4xx/5xx ends the attempt immediately with the real
      // status (no more clicks, and auth.ts won't retry-deepen a rate limit);
      // a 2xx just tells the LLM the submit landed so it stops re-submitting.
      if (options?.authWatch && (decision.action === 'click' || decision.action === 'press')) {
        const authResp = this.awaitAuthResponse(options.authWatch);
        if (authResp && typeof authResp.status === 'number') {
          if (classifyAuthStatus(authResp.status) !== 'ok') {
            const detail = describeAuthFailure(authResp.status);
            stepsTaken.push(`${detail} — the login submit was refused; stopping (retrying would only re-submit)`);
            return {
              goal,
              success: false,
              actions,
              stepsTaken,
              finalUrl: this.browser.getUrl(),
              finalSnapshot: this.browser.snapshotInteractive(),
              error: detail,
              authStatus: authResp.status,
            };
          }
          stepsTaken.push(
            `auth request accepted (HTTP ${authResp.status}); wait for the app shell/redirect then use done — do not re-submit`,
          );
        }
      }
    }

    return {
      goal,
      success: false,
      actions,
      stepsTaken,
      finalUrl: this.browser.getUrl(),
      finalSnapshot: this.browser.snapshotInteractive(),
      error: `Exceeded max exploration steps (${maxSteps})`,
    };
  }

  /**
   * Poll briefly for the auth endpoint's response after a login submit. The POST
   * is usually still pending immediately after the click, so give it a bounded
   * window rather than reading an absent/stale status. Returns the latest matching
   * COMPLETED request, or undefined if none answered in time.
   */
  private awaitAuthResponse(pattern: RegExp, timeoutMs = 8000): NetworkRequest | undefined {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let resp: NetworkRequest | undefined;
      try {
        resp = pickAuthResponse(
          normalizeNetworkRequests(this.browser.networkRequestsJson().data?.requests),
          pattern,
        );
      } catch {
        resp = undefined;
      }
      if (resp) return resp;
      if (Date.now() >= deadline) return undefined;
      try {
        this.browser.wait(1500);
      } catch {
        return undefined;
      }
    }
  }

  private async decideNextAction(
    goal: string,
    url: string,
    snapshot: string,
    priorSteps: string[],
    image?: { data: string; mediaType: 'image/png' },
  ): Promise<ExplorerAction> {
    const userPrompt = [
      `Goal: ${goal}`,
      `Current URL: ${url}`,
      priorSteps.length ? `Prior steps:\n${priorSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : 'Prior steps: none',
      'Interactive snapshot:',
      truncateSnapshot(snapshot, config.llm.snapshotMaxChars),
    ].join('\n\n');

    const messages: LlmMessage[] = [
      { role: 'system', content: buildSystemPrompt(this.siteDescription, this.siteHints) },
      { role: 'user', content: userPrompt },
    ];

    // A malformed reply (two JSON objects back-to-back, JSON + trailing prose)
    // usually parses cleanly on a second attempt — retry once before giving up.
    // Containing the failure to a single 'fail' step (instead of letting the
    // error propagate) means one bad LLM reply degrades to one contained step
    // failure, not an uncaught exception that kills the whole flow (2026-07-17:
    // this exact gap crashed 4 of 10 koyal flows in one run). The whole attempt
    // — the LLM call AND the parse — is inside the try: an LLM-call-level
    // failure on the retry (network, budget) needs the same containment as a
    // parse failure, or this loop just doubles the pre-existing single-call
    // exposure to that same class of crash. LlmBudgetExceededError is the one
    // exception that must still propagate — it's a deliberate hard stop for
    // the whole run, not a per-step condition to retry past.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.llm.complete({
          messages:
            attempt === 0
              ? messages
              : [
                  ...messages,
                  {
                    role: 'user',
                    content:
                      'Your previous reply could not be parsed as JSON. Respond with ONLY a single JSON object matching the schema above — no second object, no explanation, no markdown.',
                  },
                ],
          image,
        });
        const parsed = parseJsonFromLlm<ExplorerAction>(raw);
        if (!parsed.action) throw new Error(`Invalid explorer response: ${raw}`);
        return parsed;
      } catch (error) {
        if (error instanceof LlmBudgetExceededError) throw error;
        // Redacted for the same reason stepsTaken.push(this.redact(...)) below
        // redacts: a malformed reply can echo prose from the prompt, which for
        // a login goal embeds the real credentials (auth.ts's setRedactions).
        const message = this.redact(error instanceof Error ? error.message : String(error));
        if (attempt === 0) {
          console.log(
            `  [explorer] LLM call/parse failed — retrying once, consuming an extra LLM-call budget unit (${message})`,
          );
          continue;
        }
        console.log(`  [explorer] LLM call/parse failed again after retry — failing this step (${message})`);
        // Deliberately generic, NOT echoing the raw reply: agent/flow-runner.ts's
        // looksLikeIdempotentSkipReason() regex-scans this exact field for
        // phrases like "already done"/"no need to", and a malformed reply can
        // easily contain that kind of self-referential text by coincidence,
        // misreading a parse crash as a legitimate idempotent skip.
        return {
          action: 'fail',
          reason: 'LLM reply could not be parsed as a valid action after one retry (see logs for detail).',
        };
      }
    }
    // unreachable — the loop above always returns or throws by its second iteration
    throw new Error('decideNextAction: exhausted retries');
  }

  private async executeAction(decision: ExplorerAction, stepsTaken: string[]): Promise<void> {
    switch (decision.action) {
      case 'click': {
        if (!decision.ref) throw new Error('Explorer click missing ref');
        if (this.hooks.beforeClick) {
          const allowed = await this.hooks.beforeClick(
            decision.resolvedLabel ?? decision.ref,
            decision.ref,
          );
          if (!allowed) {
            decision.executionFailed = true;
            decision.deniedByUser = true;
            stepsTaken.push(
              `action denied by user: click "${decision.resolvedLabel ?? decision.ref}" — choose another path`,
            );
            return;
          }
        }
        this.browser.clickVisible(decision.ref);
        break;
      }
      case 'fill':
        if (!decision.ref || decision.value === undefined) {
          throw new Error('Explorer fill missing ref or value');
        }
        this.browser.fillVisible(decision.ref, decision.value);
        break;
      case 'select':
        if (!decision.ref || decision.value === undefined) {
          throw new Error('Explorer select missing ref or value');
        }
        this.browser.select(decision.ref, decision.value);
        break;
      case 'press':
        if (!decision.value) throw new Error('Explorer press missing value (key name)');
        this.browser.press(decision.value);
        break;
      case 'upload': {
        if (!this.hooks.onUploadRequested) {
          throw new Error('Upload requested but no upload handler configured');
        }
        const filePath = await this.hooks.onUploadRequested(decision.selector, decision.reason);
        if (!filePath) {
          stepsTaken.push('upload declined by user — choose another path');
          return;
        }
        const used = this.tryUpload(filePath, decision.selector);
        if (!used) throw new Error('Upload failed: no working file input found');
        decision.uploadedPath = filePath;
        decision.selector = used;
        stepsTaken.push(`uploaded ${filePath} via ${used}`);
        this.browser.wait(3000);
        break;
      }
      case 'wait':
        this.browser.wait(1500);
        break;
      default:
        break;
    }
  }

  /** Scan the live DOM for file inputs — ids and accept-attribute selectors. */
  private scanFileInputSelectors(): string[] {
    try {
      const stdout = this.browser.evalScript(`
        (function() {
          const out = [];
          for (const el of document.querySelectorAll('input[type=file]')) {
            if (el.id) out.push('#' + el.id);
            const accept = el.getAttribute('accept');
            if (accept) out.push('input[accept="' + accept + '"]');
          }
          return JSON.stringify(out);
        })();
      `);
      return parseJsonArrayFromEvalStdout(stdout);
    } catch {
      return [];
    }
  }

  /**
   * Ordered-selector upload with bounded retries: hinted selector → generic file
   * input → DOM-scanned ids/accepts; if nothing is found, one attempt to "arm" a
   * dropzone (upload/browse buttons often mount the input lazily), then rescan.
   */
  private tryUpload(filePath: string, selectorHint?: string): string | null {
    for (let attempt = 0; attempt < 3; attempt++) {
      // React-mounted file inputs (react-dropzone etc.) can lag a beat behind
      // the state transition that reveals them — give the DOM a moment before
      // scanning, especially past the first attempt.
      if (attempt > 0) this.browser.wait(800);
      const selectors = [
        ...(selectorHint ? [selectorHint] : []),
        'input[type=file]',
        ...this.scanFileInputSelectors(),
      ];
      for (const selector of [...new Set(selectors)]) {
        try {
          this.browser.upload(selector, filePath);
          return selector;
        } catch {
          // try next selector
        }
      }
      // arm the dropzone and retry — dropzones are often divs, so try a
      // snapshot-ref click before the button-text fallback
      try {
        const snap = this.browser.snapshotInteractive();
        const ref = resolveDropzoneRef(snap);
        if (ref) {
          this.browser.clickVisible(ref);
        } else {
          this.browser.clickButtonByText('Upload', false) ||
            this.browser.clickButtonByText('Browse', false) ||
            this.browser.clickButtonByText('Choose', false);
        }
        this.browser.wait(1500);
      } catch {
        // nothing to arm
      }
    }
    return null;
  }
}

/**
 * Dropzone text ("Drop your audio or video file here") is often a nested
 * heading/paragraph INSIDE the actual clickable wrapper, not clickable itself —
 * clicking the text's own ref may be a no-op. Walk up by indentation to the
 * nearest clickable ancestor line; DOM clicks bubble, so the direct ref still
 * works as a last resort.
 */
function resolveDropzoneRef(snapshot: string): string | null {
  const lines = snapshot.split('\n');
  const idx = lines.findIndex((l) => /drop your|drag (and|&) drop|choose file|browse file/i.test(l));
  if (idx === -1) return null;

  const selfRef = lines[idx].match(/\[ref=(e\d+)\]/)?.[1];
  if (selfRef && /clickable|onclick/i.test(lines[idx])) return `@${selfRef}`;

  const indentOf = (l: string) => l.match(/^(\s*)/)?.[1].length ?? 0;
  const targetIndent = indentOf(lines[idx]);
  for (let i = idx - 1; i >= 0 && i >= idx - 15; i--) {
    const indent = indentOf(lines[i]);
    if (indent >= targetIndent) continue; // not an ancestor
    const ref = lines[i].match(/\[ref=(e\d+)\]/)?.[1];
    if (ref && /clickable|onclick/i.test(lines[i])) return `@${ref}`;
    if (indent === 0) break;
  }

  return selfRef ? `@${selfRef}` : null;
}
