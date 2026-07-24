import assert from 'node:assert/strict';
import test from 'node:test';
import type { Recipe } from './recipes.js';
import { normalizeSamePageContextualMutationGoal } from './site-state.js';

const recipe: Recipe = {
  id: 'flow:regenerate:m1',
  goal: 'old',
  steps: [
    {
      kind: 'click',
      label: 'REGENERATE (Wayfinder Compass)',
      role: 'button',
    },
    { kind: 'waitForProcessing', maxMs: 1200000 },
  ],
  successCheck: { urlIncludes: '/assets' },
  stats: { successes: 0, failures: 0 },
};

test('migrates a learned same-page card mutation away from stale next-screen wording', () => {
  const migrated = normalizeSamePageContextualMutationGoal(
    'On "Your Assets": click "REGENERATE (Wayfinder Compass)", then advance one screen. Stop as soon as a new page appears.',
    recipe,
  );
  assert.match(migrated, /click "REGENERATE \(Wayfinder Compass\)" exactly once/i);
  assert.match(migrated, /Remaining on the same page is valid/i);
  assert.doesNotMatch(migrated, /advance one screen/i);
});

test('does not rewrite a contextual click whose recipe proves real navigation', () => {
  const navigating: Recipe = {
    ...recipe,
    steps: [
      ...recipe.steps,
      { kind: 'waitFor', urlIncludes: '/editor', maxMs: 20000 },
    ],
  };
  const goal =
    'Click "EDIT (Wayfinder Compass)", then advance one screen.';
  assert.equal(normalizeSamePageContextualMutationGoal(goal, navigating), goal);
});
