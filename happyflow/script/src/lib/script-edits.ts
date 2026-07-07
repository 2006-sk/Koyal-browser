import { AgentBrowser, snapshotIncludes } from './agent-browser.js';

export interface FillResult {
  ok: boolean;
  detail: string;
}

const ADJECTIVES = ['bold', 'mysterious', 'quirky', 'wise', 'cheerful', 'stoic', 'playful'];
const ROLES = ['Barista', 'Detective', 'Traveler', 'Inventor', 'Chef', 'Pilot', 'Poet'];
const TRAITS = ['warm smile', 'sharp wit', 'quiet intensity', 'restless energy', 'gentle patience'];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export interface RandomCharacter {
  name: string;
  description: string;
  tag: string;
}

/** Unique per-run character for Create New Character flows. */
export function randomCharacter(): RandomCharacter {
  const tag = `QA${rand(100, 999)}`;
  const name = `${pick(ADJECTIVES)} ${pick(ROLES)} ${tag}`;
  const description =
    `QA auto character ${tag}: ${pick(TRAITS)}, age ${rand(22, 58)}, ` +
    `wearing casual attire, expressive eyes.`;
  return { name, description, tag };
}

export function randomEditMarker(prefix: string): string {
  return `${prefix} ${tag()} ${rand(1000, 9999)}`;
}

function tag(): string {
  return pick(['alpha', 'beta', 'gamma', 'delta', 'omega']);
}

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
  const snippet = text.slice(0, Math.min(24, text.length));
  if (snapshotIncludes(snap, snippet)) {
    return { ok: true, detail: `filled by hint "${hint}"` };
  }
  return { ok: false, detail: `hint "${hint}" — text not visible` };
}

export function fillEditableByIndex(browser: AgentBrowser, index: number, text: string): FillResult {
  const textJson = JSON.stringify(text);
  browser.evalScript(`
    (function() {
      const els = [...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=true],input[type=text]')]
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

export function editScriptDialogue(browser: AgentBrowser, text: string): FillResult {
  const textJson = JSON.stringify(text);
  browser.evalScript(`
    (function() {
      const segment = [...document.querySelectorAll('paragraph,generic,div,p,[class*="dialogue"],[class*="segment"]')]
        .find(el => {
          const t = (el.textContent || '').trim();
          return t.length > 8 && t.length < 300 && !/Edit Script|Play audio|Next|Dashboard|Character Voices/i.test(t);
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
    return { ok: true, detail: 'script dialogue edited' };
  }
  return fillEditableByIndex(browser, 0, text);
}

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
