import assert from 'node:assert/strict';
import test from 'node:test';
import type { Interact } from './interact.js';
import type { SiteState } from './site-state.js';
import { fieldValueKey, resolveHumanFieldValue, suggestionForField } from './field-values.js';

test('field suggestions are shown but never silently selected', async () => {
  const questions: string[] = [];
  let saves = 0;
  const state = {
    fieldValues: {},
    saveFieldValues() { saves++; },
  } as unknown as SiteState;
  const interact = {
    async ask(question: string) {
      questions.push(question);
      return 'Maya';
    },
  } as Interact;

  const value = await resolveHumanFieldValue(state, interact, 'character-form', 'Enter the name', 'Jason');
  assert.equal(value, 'Maya');
  assert.match(questions[0], /Suggestion.*Jason/);
  assert.equal(saves, 1);
});

test('saved explicit field answer is reused without asking again', async () => {
  const key = fieldValueKey('character-form', 'Enter the name');
  const state = {
    fieldValues: { [key]: { pageId: 'character-form', label: 'Enter the name', value: 'Maya', updatedAt: '' } },
    saveFieldValues() { throw new Error('should not save again'); },
  } as unknown as SiteState;
  const interact = { async ask() { throw new Error('should not ask again'); } } as unknown as Interact;
  assert.equal(await resolveHumanFieldValue(state, interact, 'character-form', 'Enter the name'), 'Maya');
});

test('description suggestion is realistic prose', () => {
  assert.match(suggestionForField('Character description', 'autoqa-walk QA-123'), /friendly young pilot/i);
});
