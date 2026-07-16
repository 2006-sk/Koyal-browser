import {
  AgentBrowser,
  snapshotIncludes,
} from './agent-browser.js';

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

/** React-controlled inputs ignore el.value= — use the native setter. */
const NATIVE_SET_VALUE = `
  function setNativeValue(el, value) {
    if (!el) return false;
    el.focus();
    el.click();
    const proto =
      (el.tagName === 'TEXTAREA' && window.HTMLTextAreaElement.prototype) ||
      (el.tagName === 'INPUT' && window.HTMLInputElement.prototype) ||
      null;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else if (el.isContentEditable) el.textContent = value;
    else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
`;

export function fillFieldByHint(browser: AgentBrowser, hint: string, text: string): FillResult {
  const hintJson = JSON.stringify(hint);
  const textJson = JSON.stringify(text);
  browser.evalScript(`
    (function() {
      ${NATIVE_SET_VALUE}
      const hint = ${hintJson}.toLowerCase();
      const value = ${textJson};
      const isMatch = (s) => s && String(s).toLowerCase().includes(hint);

      for (const label of document.querySelectorAll('label,h1,h2,h3,h4,h5,h6,[class*="label"]')) {
        if (!isMatch(label.textContent)) continue;
        const id = label.getAttribute('for');
        if (id) {
          const linked = document.getElementById(id);
          if (setNativeValue(linked, value)) return 'LABEL_FOR';
        }
        let root = label.parentElement;
        for (let i = 0; i < 4 && root; i++) {
          const nested = root.querySelector('textarea,input:not([type=hidden]),[contenteditable="true"],[contenteditable=true]');
          if (nested && setNativeValue(nested, value)) return 'HEADING_NEAR';
          root = root.parentElement;
        }
        let sib = label.nextElementSibling;
        for (let i = 0; i < 6 && sib; i++) {
          const nested = sib.matches?.('textarea,input,[contenteditable]')
            ? sib
            : sib.querySelector?.('textarea,input:not([type=hidden]),[contenteditable="true"],[contenteditable=true]');
          if (nested && setNativeValue(nested, value)) return 'HEADING_SIB';
          sib = sib.nextElementSibling;
        }
      }

      for (const el of document.querySelectorAll('textarea,input:not([type=hidden]),[contenteditable="true"],[contenteditable=true]')) {
        const ph = el.getAttribute('placeholder') || '';
        const aria = el.getAttribute('aria-label') || '';
        if (isMatch(ph) || isMatch(aria)) {
          if (setNativeValue(el, value)) return 'PLACEHOLDER';
        }
      }
      return 'NO_MATCH';
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
      ${NATIVE_SET_VALUE}
      const els = [...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=true],input[type=text],input:not([type])')]
        .filter(el => el.offsetParent !== null || el.getClientRects().length);
      const el = els[${index}];
      if (!el) return 'NO_EL';
      return setNativeValue(el, ${textJson}) ? 'OK' : 'FAIL';
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
 * Theme page: textboxes sit under h4 "Visual Style" / "Visual Narrative" with a Save button each.
 * agent-browser fill + Save is required — plain DOM value= is ignored by React and unsaved edits revert.
 */
function fillThemeFieldByHeading(
  browser: AgentBrowser,
  heading: 'Visual Style' | 'Visual Narrative',
  text: string,
): FillResult {
  const snap = browser.snapshotInteractive();
  const lines = snap.split('\n');
  const headingIdx = lines.findIndex((l) => new RegExp(`heading "${heading}"`, 'i').test(l));
  if (headingIdx < 0) {
    return { ok: false, detail: `heading "${heading}" not in snapshot` };
  }

  let textboxRef: string | null = null;
  let saveRef: string | null = null;
  for (let i = headingIdx + 1; i < Math.min(headingIdx + 12, lines.length); i++) {
    const line = lines[i]!;
    if (!textboxRef) {
      const m = line.match(/textbox[^[]*\[ref=(e\d+)\]/i);
      if (m) textboxRef = `@${m[1]}`;
    }
    if (textboxRef && !saveRef) {
      const m = line.match(/button "Save"[^[]*\[ref=(e\d+)\]/i);
      if (m) saveRef = `@${m[1]}`;
    }
    if (textboxRef && saveRef) break;
    // Stop if we hit the other theme heading
    if (i > headingIdx + 1 && /heading "Visual /i.test(line) && !line.includes(heading)) break;
  }

  if (textboxRef) {
    try {
      browser.fillVisible(textboxRef, text);
      browser.wait(400);
    } catch {
      // fall through to DOM path
    }
  }

  // Always also apply native setter via heading (covers fill miss / React)
  const hintResult = fillFieldByHint(browser, heading, text);
  if (!hintResult.ok) {
    const idx = heading === 'Visual Style' ? 0 : 1;
    fillEditableByIndex(browser, idx, text);
  }

  if (saveRef) {
    try {
      browser.clickVisible(saveRef);
      browser.wait(800);
    } catch {
      browser.clickButtonByText('Save', true);
      browser.wait(800);
    }
  } else {
    // Click the Save nearest this heading in the DOM
    const headingJson = JSON.stringify(heading);
    browser.evalScript(`
      (function() {
        const h = [...document.querySelectorAll('h1,h2,h3,h4,h5')].find(el =>
          (el.textContent || '').trim() === ${headingJson});
        if (!h) return 'NO_H';
        let root = h.parentElement;
        for (let i = 0; i < 5 && root; i++) {
          const btn = [...root.querySelectorAll('button')].find(b => /^\\s*Save\\s*$/i.test(b.textContent || ''));
          if (btn) { btn.click(); return 'SAVED'; }
          root = root.parentElement;
        }
        return 'NO_SAVE';
      })();
    `);
    browser.wait(800);
  }

  const after = `${browser.snapshotInteractive()}\n${browser.snapshotFull()}`;
  const snippet = text.slice(0, Math.min(24, text.length));
  if (snapshotIncludes(after, snippet)) {
    return { ok: true, detail: `theme "${heading}" filled + saved` };
  }
  return { ok: false, detail: `theme "${heading}" — text not visible after Save` };
}

export function editScriptDialogue(browser: AgentBrowser, text: string): FillResult {
  const textJson = JSON.stringify(text);
  browser.evalScript(`
    (function() {
      ${NATIVE_SET_VALUE}
      const segment = [...document.querySelectorAll('paragraph,generic,div,p,[class*="dialogue"],[class*="segment"]')]
        .find(el => {
          const t = (el.textContent || '').trim();
          return t.length > 8 && t.length < 300 && !/Edit Script|Play audio|Next|Dashboard|Character Voices/i.test(t);
        });
      if (segment) segment.click();
      const editable = document.querySelector('[contenteditable="true"],[contenteditable=true],textarea')
        || segment;
      if (!editable) return 'NO_EL';
      return setNativeValue(editable, ${textJson}) ? 'OK' : 'FAIL';
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
  const visual = fillThemeFieldByHeading(browser, 'Visual Style', visualStyle);
  const narr = fillThemeFieldByHeading(browser, 'Visual Narrative', narrative);
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
