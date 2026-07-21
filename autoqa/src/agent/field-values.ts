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

export function fieldValueKey(pageId: string, label: string): string {
  return `${normalize(pageId || 'unknown')}::${normalize(label || 'unlabelled field')}`;
}

/** Suggestion text only. It is never submitted unless the human explicitly enters it. */
export function suggestionForField(label: string, proposed?: string): string {
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
  const key = fieldValueKey(pageId, label);
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
