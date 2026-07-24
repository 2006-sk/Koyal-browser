import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Interact } from './interact.js';
import { SiteState } from './site-state.js';
import {
  fieldValueKey,
  isLikelyUniqueCreationIdentityField,
  replaceRejectedHumanFieldValue,
  resolveFreshHumanFieldValue,
  resolveHumanFieldValue,
  suggestionForField,
} from './field-values.js';

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

test('creation replay asks for a fresh identity instead of reusing the consumed name', async () => {
  const questions: string[] = [];
  const answers = ['Maya', 'Priya'];
  const state = {
    fieldValues: {},
    saveFieldValues() {},
  } as unknown as SiteState;
  const interact = {
    async ask(question: string) {
      questions.push(question);
      return answers.shift() ?? '';
    },
  } as unknown as Interact;

  const value = await resolveFreshHumanFieldValue(
    state,
    interact,
    'characters-list',
    'Enter the name',
    'Maya',
    'Maya',
  );
  assert.equal(value, 'Priya');
  assert.equal(questions.length, 2);
  assert.match(questions[0], /Previous value \(do not reuse\): Maya/);
});

test('unique creation identity detection excludes descriptions but includes constrained name fields', () => {
  assert.equal(isLikelyUniqueCreationIdentityField('Enter the name'), true);
  assert.equal(
    isLikelyUniqueCreationIdentityField(
      'Only letters and spaces between words are allowed (a-z, A-Z). Spaces are not allowed at the start or end.',
    ),
    true,
  );
  assert.equal(isLikelyUniqueCreationIdentityField('Character description'), false);
  assert.equal(isLikelyUniqueCreationIdentityField('Describe a shot…'), false);
});

test('visibly rejected saved answer is replaced with a different human value', async () => {
  let saves = 0;
  const state = {
    fieldValues: {
      [fieldValueKey('character-form', 'Enter the name', 'Jason')]: {
        pageId: 'character-form',
        label: 'Enter the name',
        value: 'Jason',
        updatedAt: new Date().toISOString(),
      },
    },
    saveFieldValues() { saves++; },
  } as unknown as SiteState;
  const answers = ['Jason', 'Maya'];
  const interact = {
    async ask() { return answers.shift() ?? ''; },
  } as unknown as Interact;

  const replacement = await replaceRejectedHumanFieldValue(
    state,
    interact,
    'character-form',
    'Enter the name',
    'Jason',
    'Jason',
  );
  assert.equal(replacement, 'Maya');
  assert.equal(
    state.fieldValues[fieldValueKey('character-form', 'Enter the name', 'Jason')]?.value,
    'Maya',
  );
  assert.ok(saves >= 2);
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

test('asset-shaped fields receive an object description, not a character bio', () => {
  assert.match(
    suggestionForField('e.g., A red vintage car, elegant and classic...', 'A friendly young pilot'),
    /roadster|car/i,
  );
  assert.doesNotMatch(
    suggestionForField('e.g., A red vintage car, elegant and classic...', 'A friendly young pilot'),
    /pilot/i,
  );
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
