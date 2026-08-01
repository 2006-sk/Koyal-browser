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

test('exactly 80% passing milestones with terminal proof enters replay validation', () => {
  const candidate = flow();
  candidate.milestones = Array.from({ length: 10 }, (_, index) => ({
    id: `m${index + 1}`,
    goal: index === 9 ? 'Verify the final video is playable and downloadable' : `Complete step ${index + 1}`,
    kind: index === 9 ? 'verify' : 'edit',
  }));
  const message = qualifyFlowAfterRun(candidate, {
    mode: 'learning',
    executions: candidate.milestones.map((milestone, index) => ({
      milestoneId: milestone.id,
      verdict: index === 1 ? 'fail' : index === 2 ? 'needs-review' : 'pass',
      execution: 'explore',
    })),
    terminalArtifactVerified: true,
    // Replay validation may fill a missing recipe. Deterministic promotion
    // still requires every recipe and every milestone to replay below.
    allRecipesPresent: false,
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(candidate.status, 'exploratory');
  assert.equal(candidate.qualification?.phase, 'replay-validation');
  assert.match(message, /80% of milestones passed/);
});

test('below 80% pass coverage does not enter replay validation', () => {
  const candidate = flow();
  candidate.milestones = Array.from({ length: 10 }, (_, index) => ({
    id: `m${index + 1}`,
    goal: `Complete step ${index + 1}`,
    kind: 'edit',
  }));
  qualifyFlowAfterRun(candidate, {
    mode: 'learning',
    executions: candidate.milestones.slice(0, 7).map((milestone) => ({
      milestoneId: milestone.id,
      verdict: 'pass',
      execution: 'explore',
    })),
    terminalArtifactVerified: true,
    allRecipesPresent: true,
  });
  assert.equal(candidate.qualification?.phase, 'learning');
});

test('above-threshold coverage still requires verified terminal evidence', () => {
  const candidate = flow();
  qualifyFlowAfterRun(candidate, {
    mode: 'learning',
    executions: [
      { milestoneId: 'm1', verdict: 'pass', execution: 'explore' },
      { milestoneId: 'm2', verdict: 'needs-review', execution: 'explore' },
    ],
    terminalArtifactVerified: false,
    allRecipesPresent: true,
  });
  assert.equal(candidate.qualification?.phase, 'learning');
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

test('vision-only terminal uncertainty keeps successful recipes in replay validation', () => {
  const candidate = flow();
  candidate.qualification = { phase: 'replay-validation', learnedAt: 'earlier' };
  const message = qualifyFlowAfterRun(candidate, {
    mode: 'replay-validation',
    executions: [
      { milestoneId: 'm1', verdict: 'pass', execution: 'replay' },
      { milestoneId: 'm2', verdict: 'pass', execution: 'replay' },
    ],
    terminalArtifactVerified: false,
    allRecipesPresent: true,
  });
  assert.equal(candidate.status, 'exploratory');
  assert.equal(candidate.qualification?.phase, 'replay-validation');
  assert.match(message, /terminal artifact evidence was not verified/);
});

test('needs-review terminal evidence does not erase mechanically successful replay state', () => {
  const candidate = flow();
  candidate.qualification = { phase: 'replay-validation', learnedAt: 'earlier' };
  qualifyFlowAfterRun(candidate, {
    mode: 'replay-validation',
    executions: [
      { milestoneId: 'm1', verdict: 'pass', execution: 'replay' },
      { milestoneId: 'm2', verdict: 'needs-review', execution: 'replay' },
    ],
    terminalArtifactVerified: false,
    allRecipesPresent: true,
  });
  assert.equal(candidate.status, 'exploratory');
  assert.equal(candidate.qualification?.phase, 'replay-validation');
});

test('verified product failure does not demote an otherwise healthy replay validation', () => {
  const candidate = flow();
  candidate.milestones = [
    { id: 'render', goal: 'Verify final video is playable and downloadable', kind: 'verify' },
    { id: 'edit', goal: 'Submit Edit Video and verify the result', kind: 'edit' },
    { id: 'retake', goal: 'Verify Retake after the edit', kind: 'verify' },
    { id: 'proof', goal: 'Read-only final task graph proof', kind: 'verify' },
  ];
  candidate.qualification = { phase: 'replay-validation', learnedAt: 'earlier' };
  const message = qualifyFlowAfterRun(candidate, {
    mode: 'replay-validation',
    executions: [
      { milestoneId: 'render', verdict: 'pass', execution: 'replay' },
      {
        milestoneId: 'edit',
        verdict: 'fail',
        execution: 'replay',
        productBlocked: true,
      },
      {
        milestoneId: 'retake',
        verdict: 'needs-review',
        execution: 'none',
        qualificationExcluded: true,
      },
      {
        milestoneId: 'proof',
        verdict: 'fail',
        execution: 'none',
        qualificationExcluded: true,
      },
    ],
    terminalArtifactVerified: true,
    allRecipesPresent: false,
  });
  assert.equal(candidate.status, 'exploratory');
  assert.equal(candidate.qualification?.phase, 'replay-validation');
  assert.match(message, /product failure reported/);
});

test('verified product failure preserves an already deterministic recipe', () => {
  const candidate = flow();
  candidate.status = 'deterministic';
  candidate.qualification = {
    phase: 'replay-validation',
    learnedAt: 'earlier',
    replayValidatedAt: 'validated-earlier',
  };
  const message = qualifyFlowAfterRun(candidate, {
    mode: 'deterministic',
    executions: [
      { milestoneId: 'm1', verdict: 'pass', execution: 'replay' },
      {
        milestoneId: 'm2',
        verdict: 'fail',
        execution: 'replay',
        productBlocked: true,
      },
    ],
    terminalArtifactVerified: true,
    allRecipesPresent: true,
  });
  assert.equal(candidate.status, 'deterministic');
  assert.equal(candidate.qualification?.replayValidatedAt, 'validated-earlier');
  assert.match(message, /deterministic qualification preserved/);
});

test('automation-side replay failure still demotes the flow', () => {
  const candidate = flow();
  candidate.qualification = { phase: 'replay-validation', learnedAt: 'earlier' };
  qualifyFlowAfterRun(candidate, {
    mode: 'replay-validation',
    executions: [
      { milestoneId: 'm1', verdict: 'pass', execution: 'replay' },
      { milestoneId: 'm2', verdict: 'fail', execution: 'replay' },
    ],
    terminalArtifactVerified: true,
    allRecipesPresent: true,
  });
  assert.equal(candidate.qualification?.phase, 'learning');
});

test('video terminal proof accepts visible playable/downloadable artifact controls', () => {
  const candidate = flow();
  assert.equal(
    hasVerifiedTerminalArtifact(candidate, [step('m1'), step('m2', 'Final Video\nPlay\nDownload Video')]),
    true,
  );
  assert.equal(hasVerifiedTerminalArtifact(candidate, [step('m1'), step('m2', 'Edit scenes\nCreate Video')]), false);
});

test('dedicated artifact-persistence vision qualifies a creation flow without magic DOM words', () => {
  const candidate = flow();
  // Live TestStep ids are flow-qualified, unlike the compact ids used by the
  // older unit fixtures.
  const final = step('create-video:m2', 'Celestial Telescope\n3m ago\nREGENERATE');
  final.result.artifactPersistenceVerified = true;
  final.result.visualAssessment = {
    status: 'clear',
    summary: 'The created telescope is visibly saved in the library.',
    concerns: [],
  };
  assert.equal(hasVerifiedTerminalArtifact(candidate, [step('create-video:m1'), final]), true);
});

test('manual flow accepts an earlier passed terminal proof when its final aggregate audit fails', () => {
  const candidate = flow();
  candidate.manualContract = {
    request: 'Create and verify a final video, then audit every requested check',
    checklist: ['Create a final video'],
  };
  candidate.milestones = [
    { id: 'create', goal: 'Click Create Video and wait for the final video to render', kind: 'create' },
    { id: 'terminal', goal: 'Verify the final video is playable and downloadable', kind: 'verify' },
    { id: 'audit', goal: 'Read-only final task graph proof', kind: 'verify' },
  ];
  const terminal = step('create-video:terminal', 'Final Video\nPlay\nDownload Video');
  const audit = step('create-video:audit', 'Final Video\nPlay\nDownload Video');
  audit.result.verdict = 'fail';
  assert.equal(hasVerifiedTerminalArtifact(candidate, [terminal, audit]), true);
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
