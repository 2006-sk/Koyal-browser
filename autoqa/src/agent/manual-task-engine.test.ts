import assert from 'node:assert/strict';
import test from 'node:test';
import type { Flow } from './sitemap.js';
import {
  compileManualTaskGraph,
  lowerManualTaskGraph,
  manualEditVerificationGuidance,
  splitCrossPageAcceptanceItems,
  splitIndependentFunctionItems,
} from './manual-task-engine.js';

test('generic edits compile to concrete inputs with operational error-based verification', () => {
  const guidance = manualEditVerificationGuidance(
    'Edit one generated scene and change its camera angle',
  );
  assert.match(guidance, /choose one simple concrete/i);
  assert.match(guidance, /Never use unverifiable wording/i);
  assert.match(guidance, /processing finishes/i);
  assert.match(guidance, /no page exception/i);
  assert.match(guidance, /console error/i);
  assert.match(guidance, /network\/backend response/i);
  assert.match(guidance, /Do not require the requested visual\/text delta to remain visible/i);
  assert.match(guidance, /result looks unchanged/i);
  assert.equal(manualEditVerificationGuidance('Upload one audio file'), '');
});

function sourceFlow(): Flow {
  return {
    id: 'script-video',
    title: 'Script to video',
    description: 'Create a video from a script',
    status: 'deterministic',
    entry: { pageId: 'upload' },
    milestones: [
      {
        id: 'choose-script',
        goal: 'Choose the script upload path',
        kind: 'navigate',
        guardPhases: ['upload'],
      },
      {
        id: 'upload',
        goal: 'Upload the script and advance',
        kind: 'upload',
        guardPhases: ['upload'],
      },
      {
        id: 'script',
        goal: 'Review the transcript and advance',
        kind: 'edit',
        guardPhases: ['script-edit'],
      },
      {
        id: 'scenes',
        goal: 'Edit scenes and create video',
        kind: 'edit',
        guardPhases: ['edit-scenes'],
      },
      {
        id: 'final',
        goal: 'Verify final rendered video is playable',
        kind: 'verify',
        guardPhases: ['final-video'],
      },
    ],
  };
}

test('manual task graph makes ordering and terminal dependencies explicit', () => {
  const checklist = [
    'Upload the supplied script',
    'Create one reusable asset',
    'Add that asset to a generated scene',
    'After rendering test Reframe',
  ];
  const targets: Record<string, string> = {
    [checklist[0]]: 'upload',
    [checklist[1]]: 'assets-list',
    [checklist[2]]: 'edit-scenes',
    [checklist[3]]: 'final-video',
  };
  const graph = compileManualTaskGraph({
    sourceFlow: sourceFlow(),
    checklist,
    resolveTargetPageId: (item) => targets[item],
    isPostTerminal: (item) => /after rendering/i.test(item),
  });

  assert.deepEqual(
    graph.tasks.map((task) => ({
      id: task.id,
      phase: task.phase,
      dependsOn: task.dependsOn,
    })),
    [
      { id: 'acceptance-1', phase: 'pre-terminal', dependsOn: [] },
      {
        id: 'acceptance-2',
        phase: 'pre-terminal',
        dependsOn: [],
      },
      {
        id: 'acceptance-3',
        phase: 'pre-terminal',
        dependsOn: ['acceptance-2'],
      },
      {
        id: 'acceptance-4',
        phase: 'post-terminal',
        dependsOn: [],
      },
    ],
  );
});

test('task compiler separates cross-page clauses and keeps global rules out of action queue', () => {
  const themeAndOutfit =
    'Change one story element on Story Theme and change one character outfit';
  const atomic = splitCrossPageAcceptanceItems(
    [themeAndOutfit, 'Do not claim success from a spinner'],
    (item) =>
      /story/i.test(item) && !/outfit/i.test(item)
        ? 'theme'
        : /outfit/i.test(item)
          ? 'style'
          : undefined,
  );
  assert.deepEqual(atomic, [
    'Change one story element on Story Theme',
    'change one character outfit',
    'Do not claim success from a spinner',
  ]);
  const graph = compileManualTaskGraph({
    sourceFlow: sourceFlow(),
    checklist: atomic,
    resolveTargetPageId: (item) =>
      /story/i.test(item) ? 'theme' : /outfit/i.test(item) ? 'style' : undefined,
    isPostTerminal: () => false,
  });
  assert.deepEqual(
    graph.tasks.map((task) => task.requirement),
    [
      'Change one story element on Story Theme',
      'change one character outfit',
    ],
  );
  assert.deepEqual(graph.constraints, ['Do not claim success from a spinner']);
});

test('task compiler splits an explicit create-then-delete lifecycle across mapped states', () => {
  const checklist = splitCrossPageAcceptanceItems(
    [
      'Go to Locations, create exactly one disposable location, edit its description, then delete it and verify it is gone',
    ],
    (requirement) => {
      if (/\bdelete|remove\b/i.test(requirement)) return 'locations-list';
      if (/\bcreate\b/i.test(requirement)) return 'wizard-locations';
      return undefined;
    },
  );

  assert.deepEqual(checklist, [
    'Go to Locations, create exactly one disposable location, edit its description',
    'On the same Location feature, delete it and verify it is gone',
  ]);

  const graph = compileManualTaskGraph({
    sourceFlow: sourceFlow(),
    checklist,
    resolveTargetPageId: (requirement) =>
      /\bdelete|remove\b/i.test(requirement) ? 'locations-list' : 'wizard-locations',
    isPostTerminal: () => false,
  });
  assert.equal(graph.constraints.length, 0);
  assert.equal(graph.tasks.length, 2);
  assert.equal(graph.tasks[1].targetPageId, 'locations-list');
  assert.deepEqual(graph.tasks[1].dependsOn, ['acceptance-1']);
  assert.equal(graph.tasks[0].artifactRole, 'producer');
  assert.equal(graph.tasks[1].artifactRole, 'consumer');
});

test('task compiler separates a reusable asset from its later scene use and treats execution policy as a constraint', () => {
  const assetRequirement =
    'Create one reusable asset in the asset library and later add that same asset to a generated scene';
  const policy =
    'Use different scenes when possible, submit each generation action only once, wait until it finishes, and verify the result before continuing';
  const atomic = splitCrossPageAcceptanceItems(
    [assetRequirement, policy],
    (item) =>
      /asset library/i.test(item)
        ? 'assets-list'
        : /generated scene/i.test(item)
          ? 'edit-scenes'
          : undefined,
  );
  assert.deepEqual(atomic, [
    'Create one reusable asset in the asset library',
    'add that same asset to a generated scene',
    policy,
  ]);
  const graph = compileManualTaskGraph({
    sourceFlow: sourceFlow(),
    checklist: atomic,
    resolveTargetPageId: (item) =>
      /asset library/i.test(item)
        ? 'assets-list'
        : /generated scene/i.test(item)
          ? 'edit-scenes'
          : undefined,
    isPostTerminal: () => false,
  });
  assert.deepEqual(
    graph.tasks.map((task) => task.requirement),
    [
      'Create one reusable asset in the asset library',
      'add that same asset to a generated scene',
    ],
  );
  assert.deepEqual(graph.tasks[1].dependsOn, ['acceptance-1']);
  assert.deepEqual(
    graph.tasks.map((task) => ({
      artifactKey: task.artifactKey,
      artifactRole: task.artifactRole,
    })),
    [
      { artifactKey: 'artifact:acceptance-1', artifactRole: 'producer' },
      { artifactKey: 'artifact:acceptance-1', artifactRole: 'consumer' },
    ],
  );
  assert.deepEqual(graph.constraints, [policy]);
});

test('task compiler splits enumerated same-surface functions into independently auditable tasks', () => {
  assert.deepEqual(
    splitIndependentFunctionItems(
      'After scenes generate, test all four visible Change Scene functions: Edit for one minor change, Reshoot for a new version, Change Camera Angle for a different perspective, and Add Assets using the earlier asset',
    ),
    [
      'After scenes generate, test visible Change Scene function: Edit for one minor change',
      'After scenes generate, test visible Change Scene function: Reshoot for a new version',
      'After scenes generate, test visible Change Scene function: Change Camera Angle for a different perspective',
      'After scenes generate, test visible Change Scene function: Add Assets using the earlier asset',
    ],
  );
  assert.deepEqual(
    splitIndependentFunctionItems(
      'Then test the visible final-video functions Edit Video, Retake, Add Reference using a file, and Reframe; after each operation verify the updated video is playable',
    ),
    [
      'Then test the visible final-video function: Edit Video; after each operation verify the updated video is playable',
      'Then test the visible final-video function: Retake; after each operation verify the updated video is playable',
      'Then test the visible final-video function: Add Reference using a file; after each operation verify the updated video is playable',
      'Then test the visible final-video function: Reframe; after each operation verify the updated video is playable',
    ],
  );
  assert.deepEqual(
    splitIndependentFunctionItems('Change one character voice and edit one dialogue'),
    ['Change one character voice and edit one dialogue'],
  );
});

test('task graph lowering schedules local work by page and side quests before terminal', () => {
  const flow = sourceFlow();
  const checklist = [
    'Upload the supplied script',
    'Create one reusable asset',
    'Add that asset to a generated scene',
    'After rendering test Reframe',
  ];
  const targets = ['upload', 'assets-list', 'edit-scenes', 'final-video'];
  const graph = compileManualTaskGraph({
    sourceFlow: flow,
    checklist,
    resolveTargetPageId: () => undefined,
    isPostTerminal: (item) => /after rendering/i.test(item),
  });
  // The resolver callback is intentionally index-free in production. Assign
  // explicit targets here so this test focuses only on scheduler ordering.
  graph.tasks.forEach((task, index) => {
    task.targetPageId = targets[index];
  });

  const lowered = lowerManualTaskGraph(flow, graph);
  assert.deepEqual(
    lowered.map((milestone) => milestone.id),
    [
      'choose-script',
      'manual-task-1',
      'upload',
      'script',
      'manual-task-2',
      'manual-task-3',
      'scenes',
      'final',
      'manual-task-4',
      'manual-task-final-proof',
    ],
  );
  assert.match(lowered[0].goal, /JOURNEY CHECKPOINT/);
  assert.doesNotMatch(lowered[0].goal, /Create one reusable asset/);
  assert.match(
    lowered.find((item) => item.id === 'manual-task-2')?.goal ?? '',
    /Create one reusable asset/,
  );
  assert.equal(flow.milestones[2].kind, 'edit');
  assert.equal(flow.milestones[2].goal, 'Review the transcript and advance');
  const scriptJourney = lowered.find((milestone) => milestone.id === 'script');
  assert.doesNotMatch(scriptJourney?.goal ?? '', /run marker/i);
  assert.match(scriptJourney?.goal ?? '', /Do not fill, edit, regenerate, or overwrite/i);
  assert.match(scriptJourney?.goal ?? '', /branch semantics/i);
  assert.match(scriptJourney?.goal ?? '', /scenes → final/);
  assert.match(
    scriptJourney?.goal ?? '',
    /Do not choose a branch that skips those states/,
  );
});

test('fresh-entry evidence is verified immediately after entry without another mutation', () => {
  const flow = sourceFlow();
  const graph = {
    sourceFlowId: flow.id,
    constraints: [],
    tasks: [
      {
        id: 'acceptance-1',
        requirement: 'Start a fresh project through New Project',
        phase: 'pre-terminal' as const,
        dependsOn: [],
        position: 'after-entry' as const,
      },
    ],
  };
  const lowered = lowerManualTaskGraph(flow, graph);
  assert.deepEqual(lowered.slice(0, 3).map((milestone) => milestone.id), [
    'choose-script',
    'manual-task-1',
    'upload',
  ]);
  assert.equal(lowered[1].kind, 'verify');
});

test('task-owned one-shot journey mutation becomes destination-only verification', () => {
  const flow = sourceFlow();
  const requirement =
    'Click Create Video only once and wait until the final video is rendered';
  const graph = compileManualTaskGraph({
    sourceFlow: flow,
    checklist: [requirement],
    resolveTargetPageId: () => 'edit-scenes',
    isPostTerminal: () => false,
  });
  const lowered = lowerManualTaskGraph(flow, graph);
  const createTaskIndex = lowered.findIndex(
    (milestone) => milestone.id === 'manual-task-1',
  );
  const journey = lowered[createTaskIndex + 1];
  assert.equal(journey.id, 'scenes');
  assert.equal(journey.kind, 'verify');
  assert.deepEqual(journey.guardPhases, ['final-video']);
  assert.match(journey.goal, /Do not click, submit, generate, create, save, or retry/i);
});
