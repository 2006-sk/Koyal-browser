import { fillEditableByIndex } from './edits.js';
import { config } from '../config.js';
import {
  AgentBrowser,
  isButtonDisabled,
  refForEnabledButton,
  refForInteractiveSnapshot,
  resolveBlockingDialog,
  snapshotIncludes,
} from './agent-browser.js';

export interface ClickIntent {
  /** Button/link label — string or regex matched against snapshot lines */
  label: string | RegExp;
  exact?: boolean;
  /** If true, return false instead of throwing */
  optional?: boolean;
  /** Also try agent-browser find role click */
  role?: 'button' | 'link' | 'tab';
}

/**
 * The crawler may synthesize "ACTION (owning item)" when a list contains many
 * identically named controls. Keep that useful context separate from the
 * control's real accessible name for deterministic replay.
 */
export function parseContextualControlLabel(
  label: string,
): { action: string; owner: string } | null {
  const match = label.trim().match(/^(.{1,80}?)\s+\(([^()\n]{1,160})\)$/);
  if (!match) return null;
  const action = match[1].trim();
  const owner = match[2].trim();
  if (!action || !owner) return null;
  return { action, owner };
}

/**
 * Accessible names often include volatile counters, balances, timestamps, or
 * availability values. Recipes should survive those numbers changing while
 * retaining every stable word (for example, "Standard553 seconds available"
 * must still match "Standard536 seconds available"). The placeholder is kept
 * rather than deleting numbers so labels with and without a numeric component
 * cannot accidentally collapse together.
 */
export function normalizeVolatileAccessibleName(label: string): string {
  return label
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)*/g, '<n>')
    // Accessibility names assembled from nested nodes are inconsistent about
    // whether a boundary before a number contains whitespace
    // ("Standard553" vs "Standard 536"). Numeric replacement already keeps a
    // structural placeholder, so whitespace can safely be ignored here.
    .replace(/\s+/g, '')
    .trim();
}

export function refForUniqueVolatileLabel(
  snapshot: string,
  label: string,
  role?: ClickIntent['role'],
): string | undefined {
  const target = normalizeVolatileAccessibleName(label);
  if (!target.includes('<n>')) return undefined;
  const matches: Array<{ ref: string; role: string }> = [];
  for (const line of snapshot.split('\n')) {
    const match = line.match(
      /^\s*-\s*([a-zA-Z]+)\s+"([^"]+)"[^\n]*\bref=(e\d+)\b/,
    );
    if (!match || /\bdisabled\b/i.test(line)) continue;
    const candidateRole = match[1].toLowerCase();
    if (role && candidateRole !== role) continue;
    if (normalizeVolatileAccessibleName(match[2]) === target) {
      matches.push({ ref: `@${match[3]}`, role: candidateRole });
    }
  }
  // Nav.snapshot() deliberately concatenates interactive + full trees, so the
  // same DOM ref can appear twice. That is one candidate, not ambiguity.
  const uniqueMatches = [
    ...new Map(matches.map((match) => [match.ref, match])).values(),
  ];
  if (uniqueMatches.length === 1) return uniqueMatches[0].ref;
  // A labelled wrapper and its nested radio may expose the same accessible
  // name. Prefer one unique clickable label wrapper; multiple same-role
  // candidates remain ambiguous and are never guessed.
  const labelledWrappers = uniqueMatches.filter((match) => match.role === 'labeltext');
  return labelledWrappers.length === 1 ? labelledWrappers[0].ref : undefined;
}

/**
 * Resilient UI interaction — tries snapshot ref (interactive + full),
 * find role click, then DOM text click. Survives minor UI reflows.
 */
export class Nav {
  constructor(private readonly browser: AgentBrowser) {}

  snapshot(): string {
    return `${this.browser.snapshotInteractive()}\n${this.browser.snapshotFull()}`;
  }

  click(intent: ClickIntent): boolean {
    // An exact-quoted-name match is tried FIRST — a broader parent wrapper whose
    // accessible name concatenates ALL its children's text (e.g. a card-grid div
    // absorbing "ElementsFormsWidgets...") also contains any single child's label
    // as a substring, so a loose substring pattern alone can silently resolve to
    // the wrong (wrapper) element every time. When `exact` is requested, the loose
    // pattern is dropped entirely rather than kept as a fallback — snapshot LINES
    // include ref/attribute noise (e.g. "[expanded=false, ref=e18]"), so a short,
    // symbolic label like "X" (a close-icon glyph) can loosely match the letter
    // "x" inside unrelated metadata on a completely different element (observed:
    // a dismiss-overlay "X" click matching a "Demos" dropdown button's own
    // `expanded=false` attribute text and opening/triggering unrelated navigation).
    const patterns =
      typeof intent.label === 'string'
        ? (() => {
            const escaped = intent.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const exactPattern = new RegExp(`"${escaped}"`, 'i');
            return intent.exact ? [exactPattern] : [exactPattern, new RegExp(escaped, 'i')];
          })()
        : [intent.label];

    for (const pattern of patterns) {
      for (const snapFn of [
        () => this.browser.snapshotInteractive(),
        () => this.browser.snapshotFull(),
      ]) {
        const snap = snapFn();
        const ref = refForInteractiveSnapshot(snap, pattern);
        if (ref) {
          try {
            this.browser.clickVisible(ref);
            this.afterClick();
            return true;
          } catch {
            // fall through
          }
        }
      }

      if (intent.role && typeof intent.label === 'string') {
        try {
          this.browser.findAndClick(intent.role, intent.label, intent.exact ?? false);
          this.afterClick();
          return true;
        } catch {
          // fall through
        }
      }

      if (typeof intent.label === 'string') {
        try {
          if (this.browser.clickButtonByText(intent.label, intent.exact ?? false)) {
            this.afterClick();
            return true;
          }
        } catch {
          // fall through
        }
      }
    }

    // Exact accessible names can legitimately change only in their numeric
    // portions between learning and replay (credits, seconds available, item
    // counts, timestamps). Use this strictly-equal normalized fallback only
    // when it resolves to ONE enabled control; ambiguity is safer than guessing.
    if (typeof intent.label === 'string') {
      const snapshot = this.snapshot();
      const volatileRef = refForUniqueVolatileLabel(snapshot, intent.label, intent.role);
      if (volatileRef) {
        try {
          this.browser.clickVisible(volatileRef);
          this.afterClick();
          return true;
        } catch {
          // fall through to contextual matching / optional result
        }
      }
    }

    // Repeated per-item controls have a generic accessible label even when the
    // crawler stored a contextual synthetic label. Only use this after every
    // ordinary exact/role/text route failed, and require a shared card/row
    // ancestor containing the owner text; never degrade to "first button".
    if (typeof intent.label === 'string') {
      const contextual = parseContextualControlLabel(intent.label);
      if (contextual) {
        try {
          if (this.browser.clickButtonWithinText(contextual.action, contextual.owner)) {
            this.afterClick();
            return true;
          }
        } catch {
          // fall through to the normal optional/throw result
        }
      }
    }

    if (intent.optional) return false;
    throw new Error(
      `Nav: could not click "${String(intent.label)}" at ${this.browser.getUrl()}`,
    );
  }

  clickNext(): void {
    this.dismissOverlays();
    const snap = this.browser.snapshotInteractive();
    const next = refForEnabledButton(snap, 'Next');
    if (next) {
      try {
        this.browser.clickVisible(next);
      } catch {
        this.click({ label: 'Next', exact: true });
      }
    } else {
      this.click({ label: 'Next', exact: true });
    }
    this.browser.wait(config.actionDelayMs);
  }

  clickIfEnabled(label: string): boolean {
    if (isButtonDisabled(this.browser.snapshotInteractive(), label)) return false;
    return this.click({ label, exact: true, optional: true });
  }

  fillFirstEditable(text: string): boolean {
    return fillEditableByIndex(this.browser, 0, text).ok;
  }

  toggleCheckbox(labelPattern: RegExp): boolean {
    const snap = this.snapshot();
    const ref = refForInteractiveSnapshot(snap, labelPattern);
    if (ref) {
      this.browser.clickVisible(ref);
      this.browser.wait(400);
      return true;
    }
    return false;
  }

  dismissOverlays(): void {
    for (const label of ['✕', '×', 'X', 'Cancel']) {
      if (this.click({ label, exact: true, optional: true })) {
        this.browser.wait(400);
      }
    }
    resolveBlockingDialog(this.browser);
  }

  private afterClick(): void {
    // The wait() BEFORE resolveBlockingDialog used to be unconditional — if the
    // click just opened a native dialog, this wait() call itself throws ("A
    // JavaScript dialog is blocking the page"), which propagates straight out
    // of afterClick() UNCAUGHT (this method has no try/catch of its own) —
    // Nav.click()'s outer try/catch swallows it as a generic "fall through to
    // the next fallback method," but the dialog is NEVER resolved, so every
    // subsequent fallback attempt (findAndClick, clickButtonByText, ...) fails
    // for the exact same reason, and the caller (e.g. a recipe replay) moves on
    // with the dialog left open — confirmed live: this exact gap left a
    // prompt() dialog open long enough to wedge the daemon and trigger
    // recycle()'s broad-kill fallback (real, observed collateral risk to any
    // OTHER concurrently-running session, not just a theoretical one). Resolve
    // first, THEN wait — and don't let a wait() failure escape either.
    resolveBlockingDialog(this.browser);
    try {
      this.browser.wait(config.actionDelayMs);
    } catch {
      resolveBlockingDialog(this.browser);
    }
    // Was an unconditional dialogAccept() — a real confirm()/prompt() dialog's
    // message was never inspected, silently bypassing the destructive-action
    // guard entirely (a confirm() reading "permanently delete X" would be
    // blindly OK'd like any benign one). resolveBlockingDialog checks the
    // dialog's actual message against the same destructive-keyword floor the
    // click guard uses and dismisses (never accepts) anything that matches.
    resolveBlockingDialog(this.browser);
  }
}

/** Wait until predicate or timeout */
export function waitUntil(
  browser: AgentBrowser,
  predicate: (url: string, snap: string) => boolean,
  maxMs: number,
  label: string,
): void {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const url = browser.getUrl();
    const snap = browser.snapshotInteractive();
    if (predicate(url, snap)) return;
    browser.wait(config.verificationPollMs);
  }
  throw new Error(
    `waitUntil timeout: ${label} (${maxMs}ms) url=${browser.getUrl()}`,
  );
}

export function waitUntilNextEnabled(browser: AgentBrowser, maxMs: number): void {
  waitUntil(
    browser,
    (_u, snap) => !isButtonDisabled(snap, 'Next'),
    maxMs,
    'Next enabled',
  );
}
