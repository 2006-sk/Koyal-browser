import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config.js';
import type { ExplorerResult } from '../core/explorer.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import {
  nextRecipeStepAppearsReady,
  refForDynamicEditableParagraph,
  compactSupersededFills,
  recordFromExplorer,
  recordWalkRecipe,
  waitForProcessingBarrier,
} from './recipes.js';
import type { SiteState } from './site-state.js';

function state(): SiteState {
  return {
    recipes: {},
    saveRecipes() {},
  } as unknown as SiteState;
}

test('missing prior click is skippable only when the next recipe step is already actionable', () => {
  assert.equal(
    nextRecipeStepAppearsReady(
      { kind: 'fill', hint: 'Enter the name', value: 'Kaelan' },
      '- textbox "Enter the name" [ref=e12]\n- button "Finalize character" [ref=e13]',
      'https://example.test/review',
    ),
    true,
  );
  assert.equal(
    nextRecipeStepAppearsReady(
      { kind: 'click', label: 'Continue' },
      '- button "Continue" [ref=e13] [disabled]',
      'https://example.test/plan',
    ),
    false,
  );
  assert.equal(
    nextRecipeStepAppearsReady(
      { kind: 'waitFor', textIncludes: 'Story Type', maxMs: 1000 },
      '- heading "Story Type"',
      'https://example.test/story-type',
    ),
    true,
  );
});

test('dynamic transcript replay selects substantive content instead of instructional copy', () => {
  assert.equal(
    refForDynamicEditableParagraph(
      [
        '- paragraph "Click any portion to edit dialogue or emotion" [ref=e24]',
        '- paragraph "Your coffee is ready. Take a moment and enjoy it while it is fresh." [ref=e30]',
        '- paragraph "Final video" [ref=e31]',
      ].join('\n'),
    ),
    '@e30',
  );
});

test('consecutive recovery fills collapse to the final accepted value', () => {
  assert.deepEqual(
    compactSupersededFills([
      { kind: 'fill', hint: 'Enter the name', value: 'Elena' },
      { kind: 'fill', hint: 'Enter the name', value: 'Sabrina' },
      { kind: 'click', label: 'Finalize character' },
    ]),
    [
      { kind: 'fill', hint: 'Enter the name', value: 'Sabrina' },
      { kind: 'click', label: 'Finalize character' },
    ],
  );
});

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

test('successfully relearning a recipe clears failures from the stale sequence', () => {
  const site = {
    recipes: {
      'flow:test:repair': {
        id: 'flow:test:repair',
        goal: 'old',
        steps: [{ kind: 'click', label: 'Old control' }],
        successCheck: {},
        stats: { successes: 0, failures: 3 },
      },
    },
    saveRecipes() {},
  } as unknown as SiteState;
  const result = {
    goal: 'Use the repaired control',
    success: true,
    actions: [
      {
        action: 'click',
        resolvedLabel: 'New control',
        resolvedRole: 'button',
      },
    ],
    stepsTaken: [],
    finalUrl: 'https://example.test/done',
    finalSnapshot: 'Done',
  } as ExplorerResult;

  const recipe = recordFromExplorer(site, 'flow:test:repair', result);
  assert.equal(recipe?.stats.failures, 0);
  assert.deepEqual(recipe?.steps, [{ kind: 'click', label: 'New control', role: 'button' }]);
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

test('explorer processing barriers are preserved in deterministic recipes', () => {
  const site = state();
  const result: ExplorerResult = {
    goal: 'Create a character',
    success: true,
    actions: [
      { action: 'click', resolvedLabel: 'Create' },
      { action: 'wait', waitForProcessing: true, waitedMs: 60000 },
      { action: 'fill', resolvedLabel: 'Name', value: 'Chen' },
      { action: 'click', resolvedLabel: 'Finalize character' },
      { action: 'wait', waitForProcessing: true, waitedMs: 120000 },
      { action: 'done' },
    ],
    stepsTaken: [],
    finalUrl: 'https://example.test/characters',
    finalSnapshot: 'Chen',
  };
  const recipe = recordFromExplorer(site, 'flow:test:create', result);
  assert.ok(recipe);
  assert.deepEqual(recipe.steps, [
    { kind: 'click', label: 'Create', role: undefined },
    { kind: 'waitForProcessing', maxMs: config.deep.processingWaitMs },
    { kind: 'fill', hint: 'Name', value: 'Chen' },
    { kind: 'click', label: 'Finalize character', role: undefined },
    { kind: 'waitForProcessing', maxMs: config.deep.processingWaitMs },
  ]);
});

test('a learned repeated-card mutation keeps the owner identity in its recipe', () => {
  const site = state();
  const result: ExplorerResult = {
    goal:
      'On "Your Assets": click "REGENERATE (Wayfinder Compass)" once, then wait until the named item is visibly finished and usable.',
    success: true,
    actions: [
      { action: 'click', resolvedLabel: 'REGENERATE', resolvedRole: 'button' },
      { action: 'wait', waitForProcessing: true, waitedMs: 45000 },
      { action: 'click', resolvedLabel: 'REGENERATE', resolvedRole: 'button', executionFailed: true },
    ],
    stepsTaken: [],
    finalUrl: 'https://example.test/assets',
    finalSnapshot: 'Wayfinder Compass REGENERATE',
  };

  const recipe = recordFromExplorer(site, 'flow:test:regenerate', result);
  assert.ok(recipe);
  assert.deepEqual(recipe.steps[0], {
    kind: 'click',
    label: 'REGENERATE (Wayfinder Compass)',
    role: 'button',
  });
});

test('recipe processing wait survives a late mount and a transient clear frame', () => {
  const states = [
    'ordinary form',
    'ordinary form',
    'Generating asset...',
    'Generating asset...',
    'preview frame without spinner',
    '- text "Processing"',
    'saved artifact',
    'saved artifact',
  ];
  let index = 0;
  let clock = 0;
  const browser = {
    snapshotFull: () => states[Math.min(index, states.length - 1)],
    wait: (ms: number) => {
      clock += ms;
      index++;
    },
  } as unknown as AgentBrowser;

  waitForProcessingBarrier(browser, 20000, {
    now: () => clock,
    pollMs: 1000,
    mountGraceMs: 5000,
    stableClearPolls: 2,
  });

  assert.equal(index, 7);
});

test('recipe processing wait allows a production-latency mount by default', () => {
  let clock = 0;
  const browser = {
    snapshotFull: () =>
      clock < 18000
        ? 'Create Asset'
        : clock < 22000
          ? 'Generating asset...'
          : 'Saved artifact',
    wait: (ms: number) => {
      clock += ms;
    },
  } as unknown as AgentBrowser;

  waitForProcessingBarrier(browser, 60000, {
    now: () => clock,
    pollMs: 1000,
    stableClearPolls: 2,
  });

  assert.equal(clock, 23000);
});
