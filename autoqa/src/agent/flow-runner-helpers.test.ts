import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artifactIdentityForMilestone,
  boundaryConstrainedGoal,
  exploratoryDirectedGoal,
  flowHasCompletionAction,
  isAlreadySatisfiedNavigationMilestone,
  isCredentialPreparationGoal,
  isSelectionShapedGoal,
  laterMilestoneStartingOnPage,
  mergeExplorerResults,
  milestoneReturnsOnUrlChange,
  orderRunnableFlows,
  requiresPersistedCreation,
  shouldContinueAfterVerification,
  successfulMutationLabels,
} from './flow-runner.js';
import type { Flow } from './sitemap.js';
import type { SiteState } from './site-state.js';
import type { ExplorerResult } from '../core/explorer.js';
import type { TestStep } from '../core/types.js';

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

test('later wizard states fast-forward exploratory and replay flows without mistaking initial entry', () => {
  const candidate: Flow = {
    id: 'video',
    title: 'Video',
    description: '',
    status: 'exploratory',
    entry: { pageId: 'upload' },
    milestones: [
      { id: 'm1', goal: 'Upload', kind: 'upload', guardPhases: ['upload'] },
      { id: 'm2', goal: 'Choose type', kind: 'edit', guardPhases: ['story-type'] },
      { id: 'm3', goal: 'Edit scenes', kind: 'edit', guardPhases: ['edit-scenes'] },
      { id: 'm4', goal: 'Verify video', kind: 'verify', guardPhases: ['final-video'] },
    ],
  };
  assert.equal(
    laterMilestoneStartingOnPage(candidate, 0, 'edit-scenes', false),
    2,
  );
  assert.equal(
    laterMilestoneStartingOnPage(candidate, 0, 'upload', true),
    -1,
  );
});

test('single-screen click milestones cannot consume the next form', () => {
  const constrained = boundaryConstrainedGoal(
    'On "Outfits": click "CREATE OUTFIT", then advance one screen.',
  );
  assert.match(constrained, /stop as soon as the click reveals/i);
  assert.match(constrained, /Do not fill, select, generate, save, or submit/i);
  assert.equal(
    boundaryConstrainedGoal('Fill the outfit description, then advance one screen.'),
    'Fill the outfit description, then advance one screen.',
  );
});

test('exploratory milestone receives the whole directed flow mission and remaining checkpoints', () => {
  const candidate: Flow = {
    id: 'audio-video',
    title: 'Audio upload to final video',
    description: 'Create a playable rendered video from an uploaded audio file.',
    status: 'exploratory',
    entry: { pageId: 'upload' },
    milestones: [
      { id: 'm1', goal: 'Upload an audio file', kind: 'upload' },
      { id: 'm2', goal: 'Select Character Driven and click Next', kind: 'create' },
      { id: 'm3', goal: 'Verify the playable final video', kind: 'verify' },
    ],
  };
  const directed = exploratoryDirectedGoal(candidate, candidate.milestones[1], 1);
  assert.match(directed, /milestone wording as the next checkpoint and a guide, not a brittle literal script/i);
  assert.match(directed, /Complete any visible, safe prerequisite required to move forward/i);
  assert.match(directed, /Verify the playable final video/i);
  assert.match(directed, /Remaining directed checkpoints:\n3\. Verify the playable final video/i);
  assert.match(directed, /remaining checkpoints are orientation only/i);
  assert.match(directed, /do not execute a later checkpoint in this call/i);

  const verifyDirected = exploratoryDirectedGoal(candidate, candidate.milestones[2], 2);
  assert.match(verifyDirected, /This is a verification checkpoint/i);
  assert.match(verifyDirected, /do not start, create, regenerate, save, finalize, upload, or submit/i);
});

test('post-verification recovery is requested for unfinished automation but not concrete product errors', () => {
  const makeStep = (
    verdict: TestStep['result']['verdict'],
    snapshot = '',
    consoleErrors: Array<{ text: string; type: string }> = [],
  ): TestStep => ({
    workflow: 'flow:m1',
    action: 'advance',
    expected: 'next state',
    result: {
      verdict,
      severity: 'medium',
      expected: 'next state',
      actual: snapshot,
      signals: {
        url: 'https://example.test/wizard',
        title: 'Wizard',
        snapshot: { raw: snapshot, interactive: snapshot },
        pageErrors: [],
        consoleMessages: [],
        consoleErrors,
        networkRequests: [],
      },
      reasons: verdict === 'pass' ? [] : ['Expected snapshot to include one of: Next state'],
      retried: false,
    },
    stepsToReproduce: [],
  });
  const unfinishedExplorer: ExplorerResult = {
    goal: 'advance',
    success: false,
    actions: [],
    stepsTaken: ['state cycle'],
    finalUrl: 'https://example.test/wizard',
    finalSnapshot: 'Next',
    error: 'state cycle',
  };

  assert.equal(
    shouldContinueAfterVerification(makeStep('needs-review'), unfinishedExplorer, {
      loginShaped: false,
      creationMustPersist: false,
      completionActionSeen: false,
    }),
    true,
  );
  assert.equal(
    shouldContinueAfterVerification(
      makeStep('fail', 'Failed to generate image', [
        { text: 'Error: generation request failed', type: 'error' },
      ]),
      unfinishedExplorer,
      {
        loginShaped: false,
        creationMustPersist: true,
        completionActionSeen: true,
      },
    ),
    false,
  );

  const disappearedForm = makeStep('needs-review');
  disappearedForm.result.reasons = [
    'Visual review found a concrete concern: the creation input is no longer visible on the healthy gallery page',
  ];
  disappearedForm.result.visualAssessment = {
    status: 'concern',
    summary: 'The creation textarea is absent after the successful transition to the gallery.',
    concerns: ['No textarea is visible.'],
  };
  assert.equal(
    shouldContinueAfterVerification(disappearedForm, null, {
      loginShaped: false,
      creationMustPersist: false,
      completionActionSeen: true,
    }),
    false,
  );
});

test('explorer continuation preserves successful actions and final result for recipe learning', () => {
  const first: ExplorerResult = {
    goal: 'create video',
    success: false,
    actions: [{ action: 'click', ref: 'e1', resolvedLabel: 'Next' }],
    stepsTaken: ['clicked Next'],
    finalUrl: 'https://example.test/theme',
    finalSnapshot: 'Theme',
    error: 'checkpoint not verified',
  };
  const second: ExplorerResult = {
    goal: 'continue',
    success: true,
    actions: [{ action: 'click', ref: 'e2', resolvedLabel: 'Create Video' }],
    stepsTaken: ['clicked Create Video', 'final artifact visible'],
    finalUrl: 'https://example.test/final',
    finalSnapshot: 'Download video',
  };
  const merged = mergeExplorerResults(first, second);
  assert.equal(merged.success, true);
  assert.deepEqual(merged.actions.map((action) => action.resolvedLabel), ['Next', 'Create Video']);
  assert.equal(merged.finalUrl, second.finalUrl);
  assert.equal(merged.error, undefined);
  assert.match(merged.stepsTaken.join('\n'), /post-verification exploratory continuation/);
});

test('post-verification continuation inherits only successful mutation labels', () => {
  const result: ExplorerResult = {
    goal: 'create outfit',
    success: false,
    actions: [
      { action: 'click', ref: 'e1', resolvedLabel: 'TRY OUTFIT' },
      { action: 'click', ref: 'e2', resolvedLabel: 'Next' },
      { action: 'click', ref: 'e3', resolvedLabel: 'Finalize Asset', executionFailed: true },
      { action: 'fill', ref: 'e4', value: 'A navy suit' },
    ],
    stepsTaken: [],
    finalUrl: 'https://example.test/outfits',
    finalSnapshot: 'Processing',
  };
  assert.deepEqual(successfulMutationLabels(result), ['TRY OUTFIT']);
});

test('flow-runner self-healing uses the same URL boundary for click and fill milestones', () => {
  assert.equal(
    milestoneReturnsOnUrlChange('Click Next, then advance one screen.'),
    true,
  );
  assert.equal(
    milestoneReturnsOnUrlChange('Fill the transcript, then advance one screen.'),
    true,
  );
  assert.equal(
    milestoneReturnsOnUrlChange('Create a complete video through final rendering.'),
    false,
  );
});

test('story type is a selection noun, not a request to type marker text', () => {
  assert.equal(
    isSelectionShapedGoal("Select the 'Character Driven' story type and click Next."),
    true,
  );
  assert.equal(
    isSelectionShapedGoal("Select a category and type text into the Notes field."),
    false,
  );
  assert.equal(
    isSelectionShapedGoal('Adjust Character Voices and verify the selection persists.'),
    true,
  );
});

test('pure navigation already at its grounded destination becomes a no-op', () => {
  assert.equal(
    isAlreadySatisfiedNavigationMilestone(
      {
        id: 'm2',
        goal: 'Advance to the story type wizard step.',
        kind: 'navigate',
        guardPhases: ['wizard-story-type'],
      },
      'wizard-story-type',
    ),
    true,
  );
  assert.equal(
    isAlreadySatisfiedNavigationMilestone(
      {
        id: 'm5',
        goal: 'Advance through theme, style, locations and reach Edit scenes; wait for scenes.',
        kind: 'navigate',
        guardPhases: ['wizard-story-theme'],
      },
      'wizard-story-theme',
    ),
    false,
  );
});

test('only the final milestone of a creation flow carries artifact-persistence proof', () => {
  const candidate: Flow = {
    id: 'create-character',
    title: 'Create a character',
    description: 'Generate and save a character',
    status: 'exploratory',
    entry: { pageId: 'characters' },
    milestones: [
      { id: 'm1', goal: 'Click NEW CHARACTER', kind: 'create' },
      { id: 'm2', goal: 'Fill details and generate', kind: 'edit' },
      { id: 'm3', goal: 'Verify the character appears in the gallery', kind: 'verify' },
    ],
  };
  assert.equal(requiresPersistedCreation(candidate, candidate.milestones[0]), false);
  assert.equal(requiresPersistedCreation(candidate, candidate.milestones[1]), false);
  assert.equal(requiresPersistedCreation(candidate, candidate.milestones[2]), true);
});

test('contextual repeated-card mutation supplies the artifact identity to vision', () => {
  assert.equal(
    artifactIdentityForMilestone({
      id: 'm1',
      goal:
        'On "Your Assets": click "REGENERATE (Wayfinder Compass)" once, then wait until the named item is visibly finished and usable.',
      kind: 'verify',
    }),
    'Wayfinder Compass',
  );
  assert.equal(
    artifactIdentityForMilestone(
      {
        id: 'm2',
        goal: 'Finalize the new character',
        kind: 'verify',
      },
      'Leona',
    ),
    'Leona',
  );
});

test('a final verification milestone may rely on a prior creation recipe for completion proof', () => {
  const candidate: Flow = {
    id: 'create-character',
    title: 'Create a character',
    description: 'Generate and save a character',
    status: 'exploratory',
    entry: { pageId: 'characters' },
    milestones: [
      { id: 'm1', goal: 'Open the form', kind: 'create' },
      { id: 'm2', goal: 'Generate and finalize', kind: 'edit' },
      { id: 'm3', goal: 'Verify the character appears', kind: 'verify' },
    ],
  };
  const state = {
    recipes: {
      'flow:create-character:m2': {
        id: 'flow:create-character:m2',
        goal: 'Generate and finalize',
        steps: [{ kind: 'click', label: 'Finalize character' }],
        successCheck: {},
        stats: { successes: 0, failures: 0 },
      },
      'flow:create-character:m3': {
        id: 'flow:create-character:m3',
        goal: 'Verify',
        steps: [],
        successCheck: {},
        stats: { successes: 0, failures: 0 },
      },
    },
  } as unknown as SiteState;
  assert.equal(flowHasCompletionAction(candidate, state, null), true);
});
