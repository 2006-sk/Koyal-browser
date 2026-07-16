import { fillEditableByIndex } from './audio-edits.js';
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
export class AudioNav {
  constructor(private readonly browser: AgentBrowser) {}

  snapshot(): string {
    return `${this.browser.snapshotInteractive()}\n${this.browser.snapshotFull()}`;
  }

  click(intent: ClickIntent): boolean {
    const patterns =
      typeof intent.label === 'string'
        ? intent.exact
          ? [
              // Prefer exact accessible-name button/link lines when exact=true
              // (avoids "Music" matching "Music Icon", "No" matching unrelated text).
              new RegExp(
                `(?:button|link|tab)\\s+"${intent.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
                'i',
              ),
              new RegExp(`"${intent.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i'),
            ]
          : [new RegExp(intent.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]
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
          this.browser.clickButtonByText(intent.label, intent.exact ?? false);
          this.afterClick();
          return true;
        } catch {
          // fall through
        }
      }
    }

    if (intent.optional) return false;
    throw new Error(
      `AudioNav: could not click "${String(intent.label)}" at ${this.browser.getUrl()}`,
    );
  }

  clickNext(): void {
    // Do not click × here — that closes the wizard chrome. Credit modals use dismissCreditModal on PageAudio.
    this.browser.dialogAccept();
    waitUntilNextEnabled(this.browser, config.verificationMaxWaitMs);
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
    for (const label of ['✕', '×', 'Cancel']) {
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

/** Wait until predicate or timeout. Logs every 10s so long waits aren't silent. */
export function waitUntil(
  browser: AgentBrowser,
  predicate: (url: string, snap: string) => boolean,
  maxMs: number,
  label: string,
): void {
  const deadline = Date.now() + maxMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const url = browser.getUrl();
    const snap = browser.snapshotInteractive();
    if (predicate(url, snap)) return;
    const now = Date.now();
    if (now - lastLog >= 10_000) {
      const left = Math.max(0, Math.round((deadline - now) / 1000));
      console.log(`[wait] ${label} — still waiting (${left}s left) url=${url}`);
      lastLog = now;
    }
    browser.wait(config.verificationPollMs);
  }
  throw new Error(
    `waitUntil timeout: ${label} (${maxMs}ms) url=${browser.getUrl()}`,
  );
}

/**
 * Wait for Next to enable. Use short maxMs for UI gates (theme/style).
 * Do NOT pass transcript/scene processing budgets here — that looks like a hang.
 */
export function waitUntilNextEnabled(browser: AgentBrowser, maxMs: number): void {
  waitUntil(
    browser,
    (_u, snap) => !isButtonDisabled(snap, 'Next'),
    maxMs,
    'Next enabled',
  );
}

/** On Theme: Next stays disabled until fields are Saved. Retry Save; fail fast. */
export function advanceFromThemePage(
  browser: AgentBrowser,
  clickNext: () => void,
  dismiss: () => void,
  maxMs = 30_000,
): void {
  const deadline = Date.now() + maxMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    dismiss();
    const snap = browser.snapshotInteractive();
    if (!isButtonDisabled(snap, 'Next') && refForEnabledButton(snap, 'Next')) {
      clickNext();
      return;
    }
    // Click Save buttons if present (theme fields require Save before Next enables)
    const saves = snap.split('\n').filter((l) => /button "Save"/i.test(l) && !/\[disabled/.test(l));
    for (const line of saves) {
      const ref = line.match(/\[ref=(e\d+)\]/)?.[1];
      if (ref) {
        try {
          browser.clickVisible(`@${ref}`);
          browser.wait(600);
        } catch {
          // try next
        }
      }
    }
    browser.evalScript(`
      (function(){
        for (const b of document.querySelectorAll('button')) {
          if (/^\\s*Save\\s*$/i.test(b.textContent||'') && !b.disabled) b.click();
        }
      })();
    `);
    browser.wait(800);
    const now = Date.now();
    if (now - lastLog >= 8_000) {
      console.log(
        `[theme] Next still disabled — retrying Save (${Math.round((deadline - now) / 1000)}s left)`,
      );
      lastLog = now;
    }
  }
  throw new Error(
    `Theme: Next stayed disabled for ${maxMs}ms at ${browser.getUrl()} — Save may have failed or theme fields empty`,
  );
}
