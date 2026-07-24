import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artifactIdentityForMilestone,
  boundaryConstrainedGoal,
  flowHasCompletionAction,
  isAlreadySatisfiedNavigationMilestone,
  isCredentialPreparationGoal,
  isSelectionShapedGoal,
  laterMilestoneStartingOnPage,
  milestoneReturnsOnUrlChange,
  orderRunnableFlows,
  requiresPersistedCreation,
} from './flow-runner.js';
import type { Flow } from './sitemap.js';
import type { SiteState } from './site-state.js';

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
