import type { Interact } from './interact.js';
import type { SiteState } from './site-state.js';

export interface SavedFieldValue {
  pageId: string;
  label: string;
  value: string;
  updatedAt: string;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 140);
}

const SYNTHETIC_VALUE_RE = /\b(?:qamark(?:[-_][a-z0-9]+)*|autoqa(?:[-_][a-z0-9]+)*|autoqa test item|qa[-_][a-z0-9]+|sweep\d+|zephyr)\b/gi;

function naturalValueForContext(context: string): string {
  if (/character|avatar|person/i.test(context) && /description|appearance|bio|prompt/i.test(context)) {
    return 'A friendly young pilot with short brown hair, a navy flight jacket, and a calm, confident expression.';
  }
  if (/character|avatar|person|name/i.test(context)) return 'Jason';
  if (/asset|object|prop/i.test(context)) return 'Black Ceramic Cup';
  if (/outfit|clothing|wardrobe/i.test(context)) return 'Navy Flight Jacket';
  if (/location|place|room|setting/i.test(context)) return 'Cozy Corner Café';
  return 'Summer Journey';
}

/** Last-resort guard against LLM-authored junk leaking into real customer data. */
export function sanitizeProposedFlowText(text: string): string {
  const withoutQuotedJunk = text.replace(/(['"])([^'"]*(?:qamark|autoqa|qa[-_]|sweep\d|zephyr)[^'"]*)\1/gi, () =>
    `"${naturalValueForContext(text)}"`,
  );
  return withoutQuotedJunk
    .replace(SYNTHETIC_VALUE_RE, () => naturalValueForContext(text))
    .replace(/\bunique\s+(?:test\s+)?marker\s+text\b/gi, 'realistic user-provided text')
    .replace(/\btest marker\b/gi, 'user-provided value');
}

export function fieldValueKey(pageId: string, label: string, proposed?: string): string {
  const base = `${normalize(pageId || 'unknown')}::${normalize(label || 'unlabelled field')}`;
  // The same control can legitimately need different values in different
  // milestones (5→3 in a triangle test, or a Koyal search retry changing
  // "script"→"video"). Remember the human answer for the intended value, not
  // forever for the DOM field itself, or the first answer overrides every later
  // goal and makes a correct flow impossible to learn.
  return proposed ? `${base}::intent:${normalize(proposed)}` : base;
}

/** Suggestion text only. It is never submitted unless the human explicitly enters it. */
export function suggestionForField(label: string, proposed?: string): string {
  if (/\b(?:asset|object|prop|car|vehicle|furniture|product)\b/i.test(label)) {
    return 'A red vintage roadster with chrome trim, cream leather seats, and soft studio lighting.';
  }
  if (/\b(?:outfit|clothing|wardrobe|suit|jacket|dress)\b/i.test(label)) {
    return 'A tailored navy linen suit with a pale blue shirt and polished brown shoes.';
  }
  if (/\b(?:location|place|room|setting|scene)\b/i.test(label)) {
    return 'A quiet coastal café with warm pendant lights, wooden counters, and large sunlit windows.';
  }
  if (/description|appearance|bio|examples?:.*(?:man|woman|face|hair)/i.test(label)) {
    return 'A friendly young pilot with short brown hair, a navy flight jacket, and a calm, confident expression.';
  }
  if (/\b(name|character name|person name)\b/i.test(label)) return 'Jason';
  if (proposed && !/autoqa|qa[- _]|sweep\d|marker|zephyr/i.test(proposed)) return proposed;
  return 'A realistic value appropriate for this field';
}

/**
 * Ask once for every distinct non-secret text field, persist the explicit human
 * answer per site/page/label, and reuse it on future exploration and replay.
 */
export async function resolveHumanFieldValue(
  state: SiteState,
  interact: Interact,
  pageId: string,
  label: string,
  proposed?: string,
): Promise<string> {
  const key = fieldValueKey(pageId, label, proposed);
  const saved = state.fieldValues[key];
  if (saved?.value) return saved.value;

  const suggestion = suggestionForField(label, proposed);
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await interact.ask(
      `Value needed for field "${label}" on "${pageId}".\n` +
        `Suggestion (copy or edit it if you want): ${suggestion}\n` +
        `Enter the value to use. Your explicit answer will be saved and reused on future runs`,
    );
    const value = answer.trim();
    if (!value) continue;
    state.fieldValues[key] = { pageId, label, value, updatedAt: new Date().toISOString() };
    state.saveFieldValues();
    return value;
  }
  throw new Error(`No value provided for required field "${label}"`);
}

/**
 * Creation replays must not blindly reuse an identity that the preceding
 * learning run just consumed. Ask for a fresh value while retaining the old
 * value as a suggestion, and reject an unchanged answer. Descriptions/prompts
 * continue using the normal ask-once path; this is intentionally limited to
 * identity-shaped fields selected by the caller.
 */
export async function resolveFreshHumanFieldValue(
  state: SiteState,
  interact: Interact,
  pageId: string,
  label: string,
  previousValue: string,
  proposed?: string,
): Promise<string> {
  const previous = normalize(previousValue);
  const suggestion = suggestionForField(label, proposed ?? previousValue);
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await interact.ask(
      `A new artifact is being created, so field "${label}" on "${pageId}" needs a fresh value.\n` +
        `Previous value (do not reuse): ${previousValue}\n` +
        `Suggestion (copy or edit it if it is different): ${suggestion}\n` +
        'Enter a different realistic value. Your answer will be used by this deterministic replay',
    );
    const value = answer.trim();
    if (!value || normalize(value) === previous) continue;
    state.fieldValues[fieldValueKey(pageId, label, proposed)] = {
      pageId,
      label,
      value,
      updatedAt: new Date().toISOString(),
    };
    state.saveFieldValues();
    return value;
  }
  throw new Error(`No fresh value provided for creation identity field "${label}"`);
}

/** Conservative identity-field detector used only for creation replay. */
export function isLikelyUniqueCreationIdentityField(label: string): boolean {
  if (/\b(description|appearance|bio|prompt|search|dialogue|transcript|theme|style|url|email)\b/i.test(label)) {
    return false;
  }
  return (
    /\b(name|title|slug|identifier)\b/i.test(label) ||
    /only letters(?: and spaces)?(?: between words)? are allowed/i.test(label)
  );
}

/**
 * Forget one visibly rejected non-secret answer and ask for a genuinely
 * different replacement. The replacement is stored under the original intent
 * key so future exploration and recipe replay converge on the corrected value.
 */
export async function replaceRejectedHumanFieldValue(
  state: SiteState,
  interact: Interact,
  pageId: string,
  label: string,
  rejectedValue: string,
  proposed?: string,
): Promise<string> {
  const rejected = normalize(rejectedValue);
  let removed = false;
  for (const [key, saved] of Object.entries(state.fieldValues)) {
    if (
      normalize(saved.pageId) === normalize(pageId) &&
      normalize(saved.label) === normalize(label) &&
      normalize(saved.value) === rejected
    ) {
      delete state.fieldValues[key];
      removed = true;
    }
  }
  if (removed) state.saveFieldValues();

  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await interact.ask(
      `The site rejected "${rejectedValue}" for field "${label}" on "${pageId}".\n` +
        'Enter a different realistic value. It will replace the rejected saved answer for future runs',
    );
    const value = answer.trim();
    if (!value || normalize(value) === rejected) continue;
    state.fieldValues[fieldValueKey(pageId, label, proposed)] = {
      pageId,
      label,
      value,
      updatedAt: new Date().toISOString(),
    };
    state.saveFieldValues();
    return value;
  }
  throw new Error(`No different replacement provided for rejected field "${label}"`);
}
