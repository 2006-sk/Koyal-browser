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

/** Click first transcript dialogue segment, then edit its text. */
export function editTranscriptLine(browser: AgentBrowser, text: string): FillResult {
  const textJson = JSON.stringify(text);
  browser.evalScript(`
    (function() {
      const segment = [...document.querySelectorAll('[class*="transcript"],[class*="segment"],[class*="dialogue"],generic,div,p')]
        .find(el => {
          const t = (el.textContent || '').trim();
          return t.length > 8 && t.length < 200 && !/Audio transcript|Play audio|Next|Dashboard/i.test(t);
        });
      if (segment) segment.click();
      const editable = document.querySelector('[contenteditable="true"],[contenteditable=true],textarea')
        || segment;
      if (!editable) return false;
      editable.focus();
      const value = ${textJson};
      if (editable.tagName === 'TEXTAREA' || editable.tagName === 'INPUT') editable.value = value;
      else editable.textContent = value;
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })();
  `);
  browser.wait(800);
  const snap = browser.snapshotInteractive();
  const snippet = text.slice(0, Math.min(20, text.length));
  if (snapshotIncludes(snap, snippet)) {
    return { ok: true, detail: 'transcript line edited' };
  }
  return fillEditableByIndex(browser, 0, text);
}

/** Story Theme — Visual Style + Visual Narrative (label-first, then index fallback). */
export function editThemeFields(
  browser: AgentBrowser,
  visualStyle: string,
  narrative: string,
): { visual: FillResult; narrative: FillResult } {
  let visual = fillFieldByHint(browser, 'Visual Style', visualStyle);
  if (!visual.ok) visual = fillFieldByHint(browser, 'visual', visualStyle);
  if (!visual.ok) visual = fillEditableByIndex(browser, 0, visualStyle);

  let narr = fillFieldByHint(browser, 'Visual Narrative', narrative);
  if (!narr.ok) narr = fillFieldByHint(browser, 'Narrative', narrative);
  if (!narr.ok) narr = fillEditableByIndex(browser, 1, narrative);

  return { visual, narrative: narr };
}

export function editSceneDescription(browser: AgentBrowser, text: string): FillResult {
  let result = fillFieldByHint(browser, 'Description', text);
  if (!result.ok) result = fillFieldByHint(browser, 'scene', text);
  if (!result.ok) result = fillEditableByIndex(browser, 0, text);
  return result;
}

export function editFinalVideoNote(browser: AgentBrowser, text: string): FillResult {
  let result = fillFieldByHint(browser, 'Edit', text);
  if (!result.ok) result = fillEditableByIndex(browser, 0, text);
  return result;
}

export function snapshotHasText(browser: AgentBrowser, text: string): boolean {
  const snap = `${browser.snapshotInteractive()}\n${browser.snapshotFull()}`;
  return snapshotIncludes(snap, text.slice(0, Math.min(30, text.length)));
}
