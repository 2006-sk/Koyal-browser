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
    context?: { sensitive: boolean },
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
  /(analy[sz]ing|generating|rendering|exporting|transcribing|uploading|processing|validating|initializing|loading)(\s+[\w\s]{0,40})?(\.{2,3}|…)|(?:button|link)\s+"(?:analy[sz]ing|generating|rendering|exporting|transcribing|uploading|processing|validating|initializing|loading)"[^\n]*(?:disabled|busy)|\b(?:your|the)\s+(?:film|video|asset|image|audio|project)\s+is\s+(?:rendering|generating|processing|exporting)\b|\bnow in production\b|\bplease wait\b|\b(est|eta)\.?\s*[:\s]?\s*\d|\bremaining\b|\b\d{1,3}\s?%\s*(complete|done|remaining|uploaded|processed|rendered)/i;
const IN_PROGRESS_DONE_RE = /(?:processing|rendering|export) complete|100\s?%|\bdone\b\s*[!.]/i;

export function hasInlineProcessing(snapshot: string): boolean {
  return IN_PROGRESS_RE.test(snapshot) && !IN_PROGRESS_DONE_RE.test(snapshot);
}

export function explicitGoalValue(goal: string): string | undefined {
  return goal.match(/When entering test text, use exactly:\s*"([^"]+)"/i)?.[1];
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

  async achieveGoal(
    goal: string,
    options?: { maxSteps?: number; visionFirst?: boolean; authWatch?: RegExp },
  ): Promise<ExplorerResult> {
    const maxSteps = options?.maxSteps ?? config.llm.maxStepsPerGoal;
    const actions: ExplorerAction[] = [];
    const stepsTaken: string[] = [];
    let repeatCount = 0;
    let lastSignature = '';
    let processingWaitedMs = 0;
    let lastRealUrl = this.browser.getUrl();
    let blankRecoveryAttempts = 0;

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
      if (!hasInlineProcessing(processingSnapshot)) {
        try {
          processingSnapshot = this.browser.snapshotFull();
        } catch {
          // keep the interactive snapshot
        }
      }
      if (hasInlineProcessing(processingSnapshot) && processingWaitedMs < config.deep.processingWaitMs) {
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
        try {
          while (Date.now() - t0 < config.deep.processingWaitMs - processingWaitedMs) {
            this.browser.wait(5000);
            const processingFailure = captureRuntimeFailure(this.browser);
            if (processingFailure) {
              stepsTaken.push(
                `Recorded product ${processingFailure.kind} during processing: ${processingFailure.detail}; continuing while the UI remains usable`,
              );
              this.browser.clearSignals();
            }
            let now = this.browser.snapshotInteractive();
            if (!hasInlineProcessing(now)) {
              try {
                now = this.browser.snapshotFull();
              } catch {
                // keep interactive snapshot
              }
            }
            // empty snapshot = capture/daemon error, NOT "processing finished" —
            // stop waiting and let the normal loop re-snapshot and decide
            if (!now.trim() || !hasInlineProcessing(now)) break;
          }
        } catch (error) {
          stepsTaken.push(`processing-wait interrupted: ${error instanceof Error ? error.message : error}`);
        }
        processingWaitedMs += Date.now() - t0;
        snapshot = this.browser.snapshotInteractive();
        url = this.browser.getUrl();
        const waitedS = Math.round((Date.now() - t0) / 1000);
        let stillProcessingSnapshot = snapshot;
        if (!hasInlineProcessing(stillProcessingSnapshot)) {
          try {
            stillProcessingSnapshot = this.browser.snapshotFull();
          } catch {
            // keep interactive snapshot
          }
        }
        if (hasInlineProcessing(stillProcessingSnapshot)) {
          // Loop exited on the budget, NOT because processing cleared — server-side
          // work (script/scene generation, final render) can take several minutes,
          // longer than one wait budget. Tell the LLM plainly it just needs MORE
          // time and must NOT navigate away: the observed failure mode was the
          // explorer giving up here and clicking a sidebar/step link, which
          // abandoned the in-progress wizard entirely (koyal script-gen, 2026-07-20).
          // Raise AUTOQA_PROCESSING_WAIT_MS so the whole generation fits in-budget.
          stepsTaken.push(
            `waited ${waitedS}s but in-page processing is STILL ongoing — this server-side work just needs MORE time. Respond with another "wait"; do NOT click other controls, sidebar/step links, or navigate away, or you will abandon the in-progress work.`,
          );
        } else {
          stepsTaken.push(
            `waited ${waitedS}s for in-page processing to finish (deterministic, no steps consumed)`,
          );
        }
      }

      console.log(`  [explorer] step ${step + 1}/${maxSteps} — asking LLM (url: ${url})...`);
      const llmStart = Date.now();
      let decision = await this.decideNextAction(
        goal,
        url,
        snapshot,
        stepsTaken,
        options?.visionFirst && step === 0 ? this.captureVisionImage() : undefined,
      );
      console.log(
        `  [explorer] LLM responded in ${Date.now() - llmStart}ms → ${decision.action}${decision.ref ? ` ${decision.ref}` : ''}${decision.reason ? ` (${decision.reason})` : ''}`,
      );

      if (decision.ref) {
        const resolved = resolveRefLabel(snapshot, decision.ref);
        decision.resolvedLabel = resolved.label;
        decision.resolvedRole = resolved.role;
      }

      if (decision.action === 'fill' && decision.value !== undefined && this.hooks.onFillRequested) {
        const proposedValue = decision.value;
        const label = decision.resolvedLabel ?? decision.ref ?? 'unlabelled field';
        const sensitive =
          isSensitiveFieldLabel(label) ||
          this.redactions.some((secret) => secret === proposedValue);
        try {
          decision.value = await this.hooks.onFillRequested(label, decision.value, { sensitive });
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
            stepsTaken.push(
              `note: full-snapshot recheck confirmed the goal was already satisfied (a non-interactive result was present) — ${recheck.reason ?? ''}`.trim(),
            );
            return { goal, success: true, actions, stepsTaken, finalUrl: url, finalSnapshot: fullSnapshot };
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
        if (hasInlineProcessing(fullSnapshot) && processingWaitedMs < config.deep.processingWaitMs) {
          const t0 = Date.now();
          stepsTaken.push('done suppressed: full page still shows active generation/processing');
          while (Date.now() - t0 < config.deep.processingWaitMs - processingWaitedMs) {
            this.browser.wait(5000);
            const failure = captureRuntimeFailure(this.browser);
            if (failure) {
              stepsTaken.push(
                `Recorded product ${failure.kind} during processing: ${failure.detail}; continuing while the UI remains usable`,
              );
              this.browser.clearSignals();
            }
            const now = this.browser.snapshotFull();
            if (!now.trim() || !hasInlineProcessing(now)) break;
          }
          processingWaitedMs += Date.now() - t0;
          continue;
        }
        return { goal, success: true, actions, stepsTaken, finalUrl: url, finalSnapshot: snapshot };
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
      } catch (error) {
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
