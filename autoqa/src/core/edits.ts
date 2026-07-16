import { AgentBrowser, snapshotIncludes } from './agent-browser.js';

export interface FillResult {
  ok: boolean;
  detail: string;
}

/** Fill textarea / contenteditable matched by label text, placeholder, or aria-label. */
export function fillFieldByHint(browser: AgentBrowser, hint: string, text: string): FillResult {
  const hintJson = JSON.stringify(hint);
  const textJson = JSON.stringify(text);
  browser.evalScript(`
    (function() {
      const hint = ${hintJson}.toLowerCase();
      const value = ${textJson};
      const isMatch = (s) => s && String(s).toLowerCase().includes(hint);

      function setValue(el) {
        if (!el) return false;
        el.focus();
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          el.value = value;
        } else {
          el.textContent = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      for (const label of document.querySelectorAll('label')) {
        if (!isMatch(label.textContent)) continue;
        const id = label.getAttribute('for');
        if (id) {
          const linked = document.getElementById(id);
          if (setValue(linked)) return true;
        }
        const nested = label.querySelector('textarea,input,[contenteditable="true"],[contenteditable=true]');
        if (setValue(nested)) return true;
      }

      for (const el of document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=true]')) {
        const ph = el.getAttribute('placeholder') || '';
        const aria = el.getAttribute('aria-label') || '';
        if (isMatch(ph) || isMatch(aria)) return setValue(el);
      }

      return false;
    })();
  `);
  browser.wait(600);
  const snap = browser.snapshotInteractive();
  if (snapshotIncludes(snap, text.slice(0, Math.min(24, text.length)))) {
    return { ok: true, detail: `filled by hint "${hint}"` };
  }
  return { ok: false, detail: `hint "${hint}" — text not visible in snapshot` };
}

/** Fill the Nth editable field (0-based) among visible textareas/contenteditables. */
export function fillEditableByIndex(browser: AgentBrowser, index: number, text: string): FillResult {
  const textJson = JSON.stringify(text);
  browser.evalScript(`
    (function() {
      const els = [...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=true]')]
        .filter(el => el.offsetParent !== null || el.getClientRects().length);
      const el = els[${index}];
      if (!el) return false;
      el.focus();
      const value = ${textJson};
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.value = value;
      else el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })();
  `);
  browser.wait(600);
  const snap = browser.snapshotInteractive();
  const snippet = text.slice(0, Math.min(20, text.length));
  if (snapshotIncludes(snap, snippet)) {
    return { ok: true, detail: `filled editable index ${index}` };
  }
  return { ok: false, detail: `editable index ${index} — text not visible` };
}

/**
 * Unique self-identifying marker text for real edits — each run writes text it
 * can later assert is visible in the snapshot.
 */
export function randomEditMarker(prefix: string): string {
  const stamp = Date.now().toString(36).slice(-5);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix} QA-${stamp}${rand}`;
}

export function snapshotHasText(browser: AgentBrowser, text: string): boolean {
  const snap = `${browser.snapshotInteractive()}\n${browser.snapshotFull()}`;
  return snapshotIncludes(snap, text.slice(0, Math.min(30, text.length)));
}
