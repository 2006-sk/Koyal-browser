import assert from 'node:assert/strict';
import test from 'node:test';
import { actionableSteps } from './deep-walker.js';
import type { WalkTrail } from './sitemap.js';

test('walk compilation collapses repeated attempts on one unchanged page', () => {
  const trail: WalkTrail = {
    id: 'walk:test',
    entry: { pageId: 'splash', actionLabel: 'Create' },
    startedAt: '',
    finishedAt: '',
    outcome: 'terminal',
    steps: [
      { index: 0, pageId: 'characters', kind: 'wizard-step', action: { type: 'click', label: 'Create' } },
      { index: 1, pageId: 'characters', kind: 'wizard-step', action: { type: 'click', label: 'Finalize' } },
      { index: 2, pageId: 'story', kind: 'wizard-step', action: { type: 'fill', label: 'Scene', value: 'A real scene' } },
      { index: 3, pageId: 'premiere', kind: 'wizard-step', action: { type: 'click', label: 'Tone navy' } },
      { index: 4, pageId: 'premiere', kind: 'wizard-step', action: { type: 'click', label: 'EXPORT' } },
      { index: 5, pageId: 'export', kind: 'terminal' },
    ],
  };

  assert.deepEqual(
    actionableSteps(trail).map((step) => [step.pageId, step.action?.label]),
    [
      ['characters', 'Create'],
      ['characters', 'Finalize'],
      ['story', 'Scene'],
      ['premiere', 'EXPORT'],
    ],
  );
});
