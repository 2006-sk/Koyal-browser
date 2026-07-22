import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Interact } from './interact.js';
import { SiteState } from './site-state.js';
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

test('a different intended value for the same field asks again instead of restoring the first answer', async () => {
  const answers = ['5', '3'];
  let asks = 0;
  const state = {
    fieldValues: {},
    saveFieldValues() {},
  } as unknown as SiteState;
  const interact = {
    async ask() {
      return answers[asks++];
    },
  } as unknown as Interact;

  assert.equal(await resolveHumanFieldValue(state, interact, 'triangle', 'Side 3', '5'), '5');
  assert.equal(await resolveHumanFieldValue(state, interact, 'triangle', 'Side 3', '3'), '3');
  assert.equal(await resolveHumanFieldValue(state, interact, 'triangle', 'Side 3', '3'), '3');
  assert.equal(asks, 2);
});

test('description suggestion is realistic prose', () => {
  assert.match(suggestionForField('Character description', 'autoqa-walk QA-123'), /friendly young pilot/i);
});

test('values-only reset preserves sitemap and recipes while forgetting human field answers', () => {
  const state = new SiteState(`https://reset-values-${randomUUID()}.invalid`);
  try {
    state.sitemap.updatedAt = 'test';
    state.saveSitemap();
    state.recipes.example = {
      id: 'example',
      goal: 'Fill a name',
      steps: [{ kind: 'fill', hint: 'Name', value: 'Jason' }],
      successCheck: {},
      stats: { successes: 0, failures: 0 },
    };
    state.saveRecipes();
    state.fieldValues[fieldValueKey('character-form', 'Name')] = {
      pageId: 'character-form',
      label: 'Name',
      value: 'Jason',
      updatedAt: 'test',
    };
    state.saveFieldValues();

    const removed = state.reset({ values: true });

    assert.deepEqual(removed, [state.fieldValuesPath]);
    assert.deepEqual(state.fieldValues, {});
    assert.equal(fs.existsSync(state.fieldValuesPath), false);
    assert.equal(fs.existsSync(state.sitemapPath), true);
    assert.equal(fs.existsSync(state.recipesPath), true);
  } finally {
    state.reset({ all: true });
  }
});
