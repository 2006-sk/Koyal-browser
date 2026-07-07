import { fillEditableByIndex } from './edits.js';
import { config } from '../config.js';
import {
  AgentBrowser,
  isButtonDisabled,
  refForEnabledButton,
  refForInteractiveSnapshot,
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
 * Resilient UI interaction — tries snapshot ref (interactive + full),
 * find role click, then DOM text click. Survives minor UI reflows.
 */
export class Nav {
  constructor(private readonly browser: AgentBrowser) {}

  snapshot(): string {
    return `${this.browser.snapshotInteractive()}\n${this.browser.snapshotFull()}`;
  }

  click(intent: ClickIntent): boolean {
    const patterns =
      typeof intent.label === 'string'
        ? [new RegExp(intent.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]
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
    this.browser.dialogAccept();
  }

  private afterClick(): void {
    this.browser.wait(config.actionDelayMs);
    this.browser.dialogAccept();
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
