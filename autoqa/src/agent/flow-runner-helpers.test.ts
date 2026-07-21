import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCredentialPreparationGoal, orderRunnableFlows } from './flow-runner.js';
import type { Flow } from './sitemap.js';

function flow(id: string, status: Flow['status'], phase?: 'learning' | 'replay-validation'): Flow {
  return {
    id,
    title: id,
    description: id,
    status,
    entry: { pageId: 'entry' },
    milestones: [],
    qualification: phase ? { phase } : undefined,
  };
}

test('credential preparation is distinct from submitting a login', () => {
  assert.equal(isCredentialPreparationGoal('Fill EMAIL and PASSWORD with valid credentials'), true);
  assert.equal(isCredentialPreparationGoal('Fill EMAIL and PASSWORD, then click SIGN IN'), false);
  assert.equal(isCredentialPreparationGoal('Click SIGN IN to authenticate'), false);
});

test('flows run deterministic first, replay-validation second, learning last', () => {
  const ordered = orderRunnableFlows([
    flow('learning-a', 'exploratory', 'learning'),
    flow('deterministic', 'deterministic'),
    flow('replay', 'exploratory', 'replay-validation'),
    flow('learning-b', 'exploratory', 'learning'),
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ['deterministic', 'replay', 'learning-a', 'learning-b']);
});
