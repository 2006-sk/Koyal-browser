import { config } from '../config.js';
import { parseJsonArrayFromEvalStdout, type AgentBrowser } from './agent-browser.js';
import { LlmClient, parseJsonFromLlm } from './llm/client.js';

export type ExplorerActionType = 'click' | 'fill' | 'wait' | 'upload' | 'done' | 'fail';

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
}

export interface ExplorerHooks {
  /** Called before every click; return false to deny (destructive-action guard) */
  beforeClick?: (label: string, ref: string) => Promise<boolean>;
  /** Called when the LLM signals a file upload is needed; return a local path or null to decline */
  onUploadRequested?: (selectorHint: string | undefined, reason: string | undefined) => Promise<string | null>;
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
  /(analy[sz]ing|generating|transcribing|uploading|processing|validating|initializing|loading)(\s+[\w\s]{0,40})?(\.{2,3}|…)|\bplease wait\b|\b(est|eta)\.?\s*[:\s]?\s*\d|\bremaining\b|\b\d{1,3}\s?%\s*(complete|done|remaining|uploaded|processed)/i;
const IN_PROGRESS_DONE_RE = /processing complete|100\s?%|\bdone\b\s*[!.]/i;

export function hasInlineProcessing(snapshot: string): boolean {
  return IN_PROGRESS_RE.test(snapshot) && !IN_PROGRESS_DONE_RE.test(snapshot);
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
- For fill actions, use the exact value provided in the goal when filling credentials.
- If the goal requires attaching a local file, respond with action "upload" (you cannot attach files yourself; the harness will do it mechanically). Include a "selector" if a file input's CSS id/selector is apparent.
- Use action "done" when the goal is clearly achieved in the current snapshot/URL.
- Use action "fail" only if the goal is impossible (e.g. element missing after reasonable attempt).
- If a prior step says an action was denied by the user, do not retry it — choose another path.
- Respond with JSON only, no markdown.
${hints}
JSON schema:
{
  "action": "click" | "fill" | "wait" | "upload" | "done" | "fail",
  "ref": "@eN",
  "value": "string for fill only",
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

  async achieveGoal(goal: string, options?: { maxSteps?: number }): Promise<ExplorerResult> {
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

      // Multi-minute server-side work (script engines, scene generation) renders as
      // spinner text on the same URL. Burning LLM steps on 1.5s "wait" actions
      // starves it and fails the goal — wait it out deterministically instead,
      // without consuming steps, bounded by one processing budget per goal.
      if (hasInlineProcessing(snapshot) && processingWaitedMs < config.deep.processingWaitMs) {
        console.log(
          `  [explorer] in-page processing detected — waiting it out deterministically (max ${Math.round((config.deep.processingWaitMs - processingWaitedMs) / 1000)}s)`,
        );
        const t0 = Date.now();
        try {
          while (Date.now() - t0 < config.deep.processingWaitMs - processingWaitedMs) {
            this.browser.wait(5000);
            const now = this.browser.snapshotInteractive();
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
        stepsTaken.push(
          `waited ${Math.round((Date.now() - t0) / 1000)}s for in-page processing to finish (deterministic, no steps consumed)`,
        );
      }

      console.log(`  [explorer] step ${step + 1}/${maxSteps} — asking LLM (url: ${url})...`);
      const llmStart = Date.now();
      const decision = await this.decideNextAction(goal, url, snapshot, stepsTaken);
      console.log(
        `  [explorer] LLM responded in ${Date.now() - llmStart}ms → ${decision.action}${decision.ref ? ` ${decision.ref}` : ''}${decision.reason ? ` (${decision.reason})` : ''}`,
      );

      if (decision.ref) {
        const resolved = resolveRefLabel(snapshot, decision.ref);
        decision.resolvedLabel = resolved.label;
        decision.resolvedRole = resolved.role;
      }

      const signature = `${decision.action}|${decision.ref ?? ''}|${decision.value ?? ''}`;
      if (signature === lastSignature) {
        repeatCount++;
      } else {
        repeatCount = 0;
        lastSignature = signature;
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
      this.browser.wait(config.actionDelayMs);
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

  private async decideNextAction(
    goal: string,
    url: string,
    snapshot: string,
    priorSteps: string[],
  ): Promise<ExplorerAction> {
    const userPrompt = [
      `Goal: ${goal}`,
      `Current URL: ${url}`,
      priorSteps.length ? `Prior steps:\n${priorSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : 'Prior steps: none',
      'Interactive snapshot:',
      truncateSnapshot(snapshot, config.llm.snapshotMaxChars),
    ].join('\n\n');

    const raw = await this.llm.complete({
      messages: [
        { role: 'system', content: buildSystemPrompt(this.siteDescription, this.siteHints) },
        { role: 'user', content: userPrompt },
      ],
    });

    const parsed = parseJsonFromLlm<ExplorerAction>(raw);
    if (!parsed.action) {
      throw new Error(`Invalid explorer response: ${raw}`);
    }
    return parsed;
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
