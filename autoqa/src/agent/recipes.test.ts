import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExplorerResult } from '../core/explorer.js';
import { recordFromExplorer, recordWalkRecipe } from './recipes.js';
import type { SiteState } from './site-state.js';

function state(): SiteState {
  return {
    recipes: {},
    saveRecipes() {},
  } as unknown as SiteState;
}

test('an already-satisfied successful milestone records a zero-action recipe', () => {
  const site = state();
  const result: ExplorerResult = {
    goal: 'Open the already-visible page',
    success: true,
    actions: [{ action: 'done', reason: 'already open' }],
    stepsTaken: [],
    finalUrl: 'https://example.test/projects',
    finalSnapshot: 'Projects',
  };
  const recipe = recordFromExplorer(site, 'flow:test:m1', result);
  assert.ok(recipe);
  assert.deepEqual(recipe.steps, []);
  assert.equal(recipe.successCheck.urlIncludes, '/projects');
});

test('failed actions are excluded and an unresolved successful fill uses the stable milestone hint', () => {
  const site = state();
  const result: ExplorerResult = {
    goal: 'Search characters',
    success: true,
    actions: [
      { action: 'fill', ref: '@e22', value: 'pilot', executionFailed: true },
      { action: 'fill', ref: '@e13', value: 'Jason' },
      { action: 'done' },
    ],
    stepsTaken: [],
    finalUrl: 'https://example.test/characters',
    finalSnapshot: 'Jason',
  };
  const recipe = recordFromExplorer(site, 'flow:test:m2', result, {
    fallbackFieldHint: 'Search characters',
  });
  assert.ok(recipe);
  assert.deepEqual(recipe.steps, [{ kind: 'fill', hint: 'Search characters', value: 'Jason' }]);
});

test('walk recorder permits an explicit no-op recipe so every terminal milestone is replayable', () => {
  const site = state();
  const recipe = recordWalkRecipe(site, 'flow:walk:m1', 'Already complete', [], {
    snapshotAnyOf: ['Completed'],
  });
  assert.ok(recipe);
  assert.deepEqual(recipe.steps, []);
});
