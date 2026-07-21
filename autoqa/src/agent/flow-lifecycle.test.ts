import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestStep } from '../core/types.js';
import {
  flowRunMode,
  hasEveryMilestoneRecipe,
  hasVerifiedTerminalArtifact,
  qualifyFlowAfterRun,
} from './flow-lifecycle.js';
import type { SiteState } from './site-state.js';
import type { Flow } from './sitemap.js';

function flow(): Flow {
  return {
    id: 'create-video',
    title: 'Create video',
    description: 'Render a video end to end',
    status: 'exploratory',
    qualification: { phase: 'learning' },
    entry: { pageId: 'dashboard' },
    milestones: [
      { id: 'm1', goal: 'Upload a script', kind: 'upload' },
      { id: 'm2', goal: 'Verify the final video is playable or downloadable', kind: 'verify' },
    ],
  };
}

function step(workflow: string, snapshot = ''): TestStep {
  return {
    workflow,
    action: workflow,
    expected: workflow,
    result: {
      verdict: 'pass',
      severity: 'low',
      expected: workflow,
      actual: workflow,
      signals: {
        url: workflow === 'm2' ? 'https://example.test/finalvideo' : 'https://example.test/upload',
        title: '',
        snapshot: { raw: snapshot, interactive: snapshot },
        pageErrors: [],
        consoleMessages: [],
        consoleErrors: [],
        networkRequests: [],
      },
      reasons: [],
      retried: false,
    },
    stepsToReproduce: [],
  };
}

test('partial selected flow stays exploratory learning and never becomes replay', () => {
  const candidate = flow();
  const message = qualifyFlowAfterRun(candidate, {
    mode: 'learning',
    executions: [{ milestoneId: 'm1', verdict: 'pass', execution: 'explore' }],
    terminalArtifactVerified: false,
    allRecipesPresent: false,
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(candidate.status, 'exploratory');
  assert.equal(candidate.qualification?.phase, 'learning');
  assert.match(message, /remains exploratory/);
  assert.equal(flowRunMode(candidate), 'learning');
});

test('complete LLM-learned flow waits for a separate replay-validation run', () => {
  const candidate = flow();
  qualifyFlowAfterRun(candidate, {
    mode: 'learning',
    executions: [
      { milestoneId: 'm1', verdict: 'pass', execution: 'explore' },
      { milestoneId: 'm2', verdict: 'pass', execution: 'explore' },
    ],
    terminalArtifactVerified: true,
    allRecipesPresent: true,
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(candidate.status, 'exploratory');
  assert.equal(candidate.qualification?.phase, 'replay-validation');
  assert.equal(flowRunMode(candidate), 'replay-validation');
});

test('only a complete successful replay with terminal evidence promotes deterministic', () => {
  const candidate = flow();
  candidate.qualification = { phase: 'replay-validation', learnedAt: 'earlier' };
  const message = qualifyFlowAfterRun(candidate, {
    mode: 'replay-validation',
    executions: [
      { milestoneId: 'm1', verdict: 'pass', execution: 'replay' },
      { milestoneId: 'm2', verdict: 'pass', execution: 'replay' },
    ],
    terminalArtifactVerified: true,
    allRecipesPresent: true,
    now: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(candidate.status, 'deterministic');
  assert.equal(candidate.qualification?.replayValidatedAt, '2026-01-02T00:00:00.000Z');
  assert.match(message, /promoted to deterministic/);
});

test('an LLM fallback during replay validation refreshes but does not promote', () => {
  const candidate = flow();
  candidate.qualification = { phase: 'replay-validation' };
  qualifyFlowAfterRun(candidate, {
    mode: 'replay-validation',
    executions: [
      { milestoneId: 'm1', verdict: 'pass', execution: 'replay' },
      { milestoneId: 'm2', verdict: 'pass', execution: 'explore' },
    ],
    terminalArtifactVerified: true,
    allRecipesPresent: true,
  });
  assert.equal(candidate.status, 'exploratory');
  assert.equal(candidate.qualification?.phase, 'replay-validation');
});

test('video terminal proof accepts visible playable/downloadable artifact controls', () => {
  const candidate = flow();
  assert.equal(
    hasVerifiedTerminalArtifact(candidate, [step('m1'), step('m2', 'Final Video\nPlay\nDownload Video')]),
    true,
  );
  assert.equal(hasVerifiedTerminalArtifact(candidate, [step('m1'), step('m2', 'Edit scenes\nCreate Video')]), false);
});

test('every milestone must have a recipe', () => {
  const candidate = flow();
  const state = {
    recipes: {
      'flow:create-video:m1': { id: 'flow:create-video:m1' },
    },
  } as unknown as SiteState;
  assert.equal(hasEveryMilestoneRecipe(state, candidate), false);
  state.recipes['flow:create-video:m2'] = { id: 'flow:create-video:m2' } as never;
  assert.equal(hasEveryMilestoneRecipe(state, candidate), true);
});
