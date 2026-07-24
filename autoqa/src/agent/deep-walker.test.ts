import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import type { LlmClient } from '../core/llm/client.js';
import {
  entryStateAdvanced,
  enabledForwardProgressControl,
  flowFromTrail,
  forwardControlAfterRecentUpload,
  actionableSteps,
  isMutatingControlLabel,
  isExplorerStateCycleFailure,
  mutatingControlLabels,
  pageKindCanBeVisualTerminal,
  pollSubmittedArtifact,
  postMutationAppearsPending,
  recordWalkRecipes,
  recoverAwayFromBlockedState,
  runtimeSignalSignature,
  successfulMutatingEntrySubmitted,
  uncertainArtifactAssessmentAppearsPending,
} from './deep-walker.js';
import type { ExplorerResult } from '../core/explorer.js';
import type { Flow, PageNode, WalkTrail } from './sitemap.js';
import type { SiteState } from './site-state.js';

test('walk entry requires a semantic transition, not merely a successful click command', () => {
  const before = '- button "Upload file" [ref=e12]\n- button "Next" [ref=e13]';
  const refOnlyChange = '- button "Upload file" [ref=e28]\n- button "Next" [ref=e29]';
  assert.equal(
    entryStateAdvanced(
      'https://example.test/story-type',
      before,
      'https://example.test/story-type',
      refOnlyChange,
    ),
    false,
  );
});

test('walk entry accepts URL, modal, and processing transitions', () => {
  const before = '- button "Create" [ref=e1]';
  assert.equal(
    entryStateAdvanced(
      'https://example.test/list',
      before,
      'https://example.test/create',
      before,
    ),
    true,
  );
  assert.equal(
    entryStateAdvanced(
      'https://example.test/list',
      before,
      'https://example.test/list',
      `${before}\n- dialog "Create New Character"\n- textbox "Name" [ref=e2]`,
    ),
    true,
  );
  assert.equal(
    entryStateAdvanced(
      'https://example.test/list',
      before,
      'https://example.test/list',
      '- status "Generating avatar... Est. 0:20 remaining"',
    ),
    true,
  );
});

test('enabled forward wizard controls veto premature visual terminal success', () => {
  assert.equal(
    enabledForwardProgressControl(
      '- button "Edit" [ref=e12]\n- button "Create Video" [ref=e13]\n- button "Go back" [ref=e14]',
    ),
    'Create Video',
  );
  assert.equal(
    enabledForwardProgressControl(
      '- button "Next" [ref=e1] [disabled]\n- button "Download Video" [ref=e2]\n- button "Export XML" [ref=e3]',
    ),
    undefined,
  );
});

test('a completed upload advances through an enabled Next without requesting another file', () => {
  const previous: WalkTrail['steps'][number] = {
    index: 1,
    pageId: 'wizard-upload',
    kind: 'wizard-step',
    actions: [
      { type: 'click', label: 'Start with Script' },
      { type: 'upload', assetPath: '/tmp/script.pdf' },
      { type: 'click', label: 'Continue' },
    ],
  };
  assert.equal(
    forwardControlAfterRecentUpload(
      previous,
      'wizard-upload',
      '- text "script.pdf"\n- button "Next" [ref=e14]',
    ),
    'Next',
  );
  assert.equal(
    forwardControlAfterRecentUpload(
      previous,
      'different-page',
      '- text "script.pdf"\n- button "Next" [ref=e14]',
    ),
    undefined,
  );
  assert.equal(
    forwardControlAfterRecentUpload(
      previous,
      'wizard-upload',
      '- text "script.pdf"\n- button "Next" [disabled, ref=e14]',
    ),
    undefined,
  );
});

test('post-upload auto-advance never infers a render mutation', () => {
  const previous: WalkTrail['steps'][number] = {
    index: 1,
    pageId: 'wizard-scenes',
    kind: 'wizard-step',
    action: { type: 'upload', assetPath: '/tmp/reference.png' },
  };
  assert.equal(
    forwardControlAfterRecentUpload(
      previous,
      'wizard-scenes',
      '- button "Create Video" [ref=e20]',
    ),
    undefined,
  );
});

test('mapped wizard and modal states are never terminal merely because an intermediate edit persisted', () => {
  assert.equal(pageKindCanBeVisualTerminal('wizard-step'), false);
  assert.equal(pageKindCanBeVisualTerminal('modal'), false);
  assert.equal(pageKindCanBeVisualTerminal('processing'), true);
  assert.equal(pageKindCanBeVisualTerminal('terminal'), true);
  assert.equal(pageKindCanBeVisualTerminal('page'), true);
});

test('repeated runtime exceptions normalize to one trail evidence signature', () => {
  assert.equal(
    runtimeSignalSignature({
      kind: 'page-error',
      detail: 'Failure in task 1784830012345   at line 719',
    }),
    runtimeSignalSignature({
      kind: 'page-error',
      detail: 'Failure in task 1784830099999 at line 719',
    }),
  );
  assert.notEqual(
    runtimeSignalSignature({ kind: 'console-error', detail: 'Failure in task 1784830012345' }),
    runtimeSignalSignature({ kind: 'page-error', detail: 'Failure in task 1784830012345' }),
  );
});

test('state-cycle failure remains terminal to the walk even after an earlier mutation', () => {
  const result = {
    goal: 'Create a character',
    success: false,
    actions: [
      { action: 'click', resolvedLabel: 'Create', resolvedRole: 'button' },
      { action: 'click', resolvedLabel: 'Remove character', resolvedRole: 'button' },
    ],
    stepsTaken: [],
    finalUrl: 'https://example.test/characters',
    finalSnapshot: '- button "Finalize" [disabled]',
    error: 'Explorer state-cycle detected: the same page state recurred 4 times without progress',
  } satisfies ExplorerResult;
  assert.equal(isExplorerStateCycleFailure(result), true);
  assert.equal(
    isExplorerStateCycleFailure({ ...result, success: true, error: undefined }),
    false,
  );
});

test('a pessimistic entry result still credits the exact successful mutation click', () => {
  const result: ExplorerResult = {
    goal: 'Regenerate funny',
    success: false,
    actions: [
      { action: 'click', resolvedLabel: 'REGENERATE (funny)', resolvedRole: 'button' },
      { action: 'wait', waitForProcessing: true, waitedMs: 25000 },
      { action: 'fail', reason: 'button is now disabled while processing' },
    ],
    stepsTaken: [],
    finalUrl: 'https://example.test/assets',
    finalSnapshot: '- text "Processing"',
    error: 'button is disabled',
  };
  assert.equal(successfulMutatingEntrySubmitted(result, 'REGENERATE (funny)'), true);
  assert.equal(successfulMutatingEntrySubmitted(result, 'REGENERATE (Joee)'), false);
  assert.equal(
    successfulMutatingEntrySubmitted(
      {
        ...result,
        actions: [{ action: 'click', resolvedLabel: 'REGENERATE', resolvedRole: 'button' }],
      },
      'REGENERATE (Emerald Lantern)',
    ),
    true,
  );
});

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

test('walk compilation preserves meaningful actions on processing pages and appends terminal proof', () => {
  const trail: WalkTrail = {
    id: 'walk:projects:create-video',
    entry: { pageId: 'projects', actionLabel: 'Create Video' },
    startedAt: '',
    finishedAt: '',
    outcome: 'terminal',
    steps: [
      {
        index: 0,
        pageId: 'upload',
        kind: 'wizard-step',
        action: { type: 'click', label: 'Create Video' },
      },
      {
        index: 1,
        pageId: 'edit-scenes',
        kind: 'processing',
        action: { type: 'fill', label: 'Scene edit', value: 'Warm sunset light' },
        actions: [
          { type: 'fill', label: 'Scene edit', value: 'Warm sunset light' },
          { type: 'click', label: 'Apply Changes' },
          { type: 'wait-processing', processingMs: 45000 },
          { type: 'click', label: 'Create Video' },
        ],
      },
      {
        index: 2,
        pageId: 'final-video',
        kind: 'processing',
        action: { type: 'wait-processing', processingMs: 120000 },
      },
    ],
    terminalEvidence: {
      source: 'vision',
      pageId: 'final-video',
      screenshot: '/tmp/final.png',
      summary: 'The completed video is playable and downloadable.',
    },
  };
  const state = {
    sitemap: {
      origin: 'https://example.test',
      pages: {
        upload: { id: 'upload', title: 'Upload', kind: 'wizard-step' },
        'edit-scenes': { id: 'edit-scenes', title: 'Edit Scenes', kind: 'processing' },
        'final-video': { id: 'final-video', title: 'Final Video', kind: 'processing' },
      },
      flows: [],
    },
  } as unknown as SiteState;

  assert.deepEqual(
    actionableSteps(trail).map((step) => step.pageId),
    ['upload', 'edit-scenes'],
  );
  const flow = flowFromTrail(trail, state);
  assert.ok(flow);
  assert.equal(flow.milestones.length, 3);
  assert.equal(flow.milestones[1].guardPhases?.[0], 'edit-scenes');
  assert.equal(flow.milestones[2].kind, 'verify');
  assert.equal(flow.milestones[2].guardPhases?.[0], 'final-video');

  const recipes: Record<string, unknown> = {};
  Object.assign(state, {
    recipes,
    saveRecipes: () => undefined,
  });
  recordWalkRecipes(state, flow, trail);
  const editRecipe = recipes[`flow:${flow.id}:m2`] as {
    steps: Array<{ kind: string; label?: string }>;
  };
  assert.ok(editRecipe.steps.some((step) => step.kind === 'click' && step.label === 'Create Video'));
  assert.ok(editRecipe.steps.some((step) => step.kind === 'waitForProcessing'));
  const terminalRecipe = recipes[`flow:${flow.id}:m3`] as { steps: unknown[] };
  assert.deepEqual(terminalRecipe.steps, []);
});

test('deep-walk recipes preserve processing barriers between dependent actions', () => {
  const trail: WalkTrail = {
    id: 'walk:asset',
    entry: { pageId: 'assets', actionLabel: 'ADD ASSET' },
    startedAt: '',
    finishedAt: '',
    outcome: 'terminal',
    steps: [
      {
        index: 0,
        pageId: 'assets',
        kind: 'page',
        action: { type: 'click', label: 'ADD ASSET' },
      },
      {
        index: 1,
        pageId: 'assets',
        kind: 'modal',
        action: { type: 'fill', label: 'Description', value: 'A brass lamp' },
        actions: [
          { type: 'fill', label: 'Description', value: 'A brass lamp' },
          { type: 'click', label: 'Generate Asset' },
          { type: 'wait-processing', processingMs: 60000 },
          { type: 'fill', label: 'Name', value: 'Emerald Lantern' },
          { type: 'click', label: 'Finalize Asset' },
          { type: 'wait-processing', processingMs: 120000 },
        ],
      },
      { index: 2, pageId: 'assets', kind: 'terminal' },
    ],
  };
  const flow: Flow = {
    id: 'walked-assets-add-asset',
    title: 'Add asset',
    description: '',
    status: 'exploratory',
    entry: { pageId: 'assets' },
    milestones: [
      { id: 'm1', goal: 'Open add asset', kind: 'create' },
      { id: 'm2', goal: 'Create it', kind: 'edit' },
    ],
  };
  const site = {
    recipes: {},
    saveRecipes() {},
  } as unknown as SiteState;

  recordWalkRecipes(site, flow, trail);
  assert.deepEqual(site.recipes['flow:walked-assets-add-asset:m2'].steps, [
    { kind: 'fill', hint: 'Description', value: 'A brass lamp' },
    { kind: 'click', label: 'Generate Asset', role: undefined },
    { kind: 'waitForProcessing', maxMs: config.deep.processingWaitMs },
    { kind: 'fill', hint: 'Name', value: 'Emerald Lantern' },
    { kind: 'click', label: 'Finalize Asset', role: undefined },
    { kind: 'waitForProcessing', maxMs: config.deep.processingWaitMs },
  ]);
});

test('deep-walk recipes preserve a standalone same-page processing barrier after regeneration', () => {
  const trail: WalkTrail = {
    id: 'walk:asset-regenerate',
    entry: { pageId: 'assets', actionLabel: 'REGENERATE (Emerald Lantern)' },
    startedAt: '',
    finishedAt: '',
    outcome: 'terminal',
    steps: [
      {
        index: 0,
        pageId: 'assets',
        kind: 'page',
        action: { type: 'click', label: 'REGENERATE (Emerald Lantern)' },
      },
      {
        index: 1,
        pageId: 'assets',
        kind: 'page',
        processingMs: 40000,
        action: { type: 'wait-processing' },
      },
    ],
  };
  const flow: Flow = {
    id: 'walked-assets-regenerate',
    title: 'Regenerate asset',
    description: '',
    status: 'exploratory',
    entry: { pageId: 'assets' },
    milestones: [
      {
        id: 'm1',
        goal: 'Regenerate once and wait until the asset is visibly finished',
        kind: 'verify',
      },
    ],
  };
  const site = {
    recipes: {},
    saveRecipes() {},
  } as unknown as SiteState;

  recordWalkRecipes(site, flow, trail);
  assert.deepEqual(site.recipes['flow:walked-assets-regenerate:m1'].steps, [
    { kind: 'click', label: 'REGENERATE (Emerald Lantern)', role: undefined },
    { kind: 'waitForProcessing', maxMs: config.deep.processingWaitMs },
  ]);
});

test('blocked-state recovery moves back and does not restart the same state', () => {
  let url = 'https://example.test/scriptEdit';
  let forwardCalls = 0;
  const browser = {
    getUrl: () => url,
    snapshotInteractive: () => (url.endsWith('/upload') ? '- heading "Upload"' : '- text "Server may be busy"'),
    back: () => {
      url = 'https://example.test/upload';
    },
    forward: () => {
      forwardCalls++;
      url = 'https://example.test/scriptEdit';
    },
    wait: () => undefined,
  } as unknown as AgentBrowser;
  const page: PageNode = {
    id: 'wizard-edit-script',
    title: 'Edit Script',
    description: '',
    kind: 'wizard-step',
    urlPatterns: ['/scriptEdit'],
    detection: { snapshotAnyOf: ['Edit Script'] },
    requiresAuth: true,
    interactives: [],
    firstSeenAt: '',
    lastSeenAt: '',
  };

  const result = recoverAwayFromBlockedState(browser, page, '- text "Server may be busy"');
  assert.deepEqual(result, {
    direction: 'back',
    changed: true,
    url: 'https://example.test/upload',
  });
  assert.equal(forwardCalls, 0);
});

test('blocked-state recovery tries forward once when back is ineffective', () => {
  let url = 'https://example.test/scriptEdit';
  let backCalls = 0;
  const browser = {
    getUrl: () => url,
    snapshotInteractive: () => (url.endsWith('/theme') ? '- heading "Theme"' : '- text "Server may be busy"'),
    back: () => {
      backCalls++;
    },
    forward: () => {
      url = 'https://example.test/theme';
    },
    wait: () => undefined,
  } as unknown as AgentBrowser;
  const page: PageNode = {
    id: 'wizard-edit-script',
    title: 'Edit Script',
    description: '',
    kind: 'wizard-step',
    urlPatterns: ['/scriptEdit'],
    detection: { snapshotAnyOf: ['Edit Script'] },
    requiresAuth: true,
    interactives: [],
    firstSeenAt: '',
    lastSeenAt: '',
  };

  const result = recoverAwayFromBlockedState(browser, page, '- text "Server may be busy"');
  assert.equal(backCalls, 1);
  assert.deepEqual(result, {
    direction: 'forward',
    changed: true,
    url: 'https://example.test/theme',
  });
});

test('post-mutation pending detector accepts a bare Processing badge only in this narrow context', () => {
  assert.equal(postMutationAppearsPending('- article "Sofia"\n- text "Processing"'), true);
  assert.equal(postMutationAppearsPending('- article "Sofia"\n- button "Edit"'), false);
});

test('uncertain terminal vision with explicit loading evidence remains a pending artifact', () => {
  assert.equal(
    uncertainArtifactAssessmentAppearsPending(
      {
        status: 'uncertain',
        summary: 'The library list is displaying a loading spinner, so persistence cannot yet be confirmed.',
      },
      '- heading "Your Assets"',
    ),
    true,
  );
  assert.equal(
    uncertainArtifactAssessmentAppearsPending(
      {
        status: 'uncertain',
        summary: 'The screenshot does not show the expected item.',
      },
      '- heading "Your Assets"',
    ),
    false,
  );
});

test('mutating walk entries include regeneration and creation but exclude ordinary navigation', () => {
  assert.equal(isMutatingControlLabel('REGENERATE (Joee)'), true);
  assert.equal(isMutatingControlLabel('ADD ASSET'), true);
  assert.equal(isMutatingControlLabel('NEW CHARACTER'), true);
  assert.equal(isMutatingControlLabel('RESUME'), false);
  assert.equal(isMutatingControlLabel('Next'), false);
});

test('mutation replay suppression remembers creation controls but not navigation', () => {
  const result = {
    actions: [
      { action: 'click', resolvedLabel: 'Create AI Avatar' },
      { action: 'click', resolvedLabel: 'Create' },
      { action: 'click', resolvedLabel: 'Finalize character' },
      { action: 'click', resolvedLabel: 'Next' },
      { action: 'click', resolvedLabel: 'Generate', executionFailed: true },
    ],
  } as ExplorerResult;
  assert.deepEqual(mutatingControlLabels(result, 'NEW CHARACTER'), [
    'Create AI Avatar',
    'Create',
    'Finalize character',
    'NEW CHARACTER',
  ]);
});

test('failed browser actions are never mistaken for submitted completion mutations', () => {
  const result = {
    actions: [
      { action: 'click', resolvedLabel: 'Create', executionFailed: true },
      { action: 'click', resolvedLabel: 'Finalize character' },
    ],
  } as ExplorerResult;
  assert.deepEqual(mutatingControlLabels(result), ['Finalize character']);
});

test('vision-affirmed processing is polled without replaying creation and exits when persisted', async () => {
  const originalWait = config.deep.processingWaitMs;
  config.deep.processingWaitMs = 100;
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-post-mutation-poll-'));
  let waits = 0;
  let clicks = 0;
  const browser = {
    getUrl: () => 'https://example.test/characters',
    wait: () => {
      waits++;
      const until = Date.now() + 4;
      while (Date.now() < until) {
        // Advance real time without sleeping for the production five seconds.
      }
    },
    snapshotInteractive: () => '- article "Sofia"\n- text "Processing"',
    snapshotFull: () => '- article "Sofia"\n- text "Processing"',
    screenshotAnnotated: (filePath: string) => fs.writeFileSync(filePath, Buffer.from('saved-sofia')),
    click: () => {
      clicks++;
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      return '{"status":"persisted","summary":"Sofia is saved in the library with no pending badge."}';
    },
  } as unknown as LlmClient;
  const trail: WalkTrail = {
    id: 'walk:characters:new',
    entry: { pageId: 'characters', actionLabel: 'NEW CHARACTER' },
    startedAt: '',
    finishedAt: '',
    outcome: 'aborted',
    steps: [],
  };
  const page: PageNode = {
    id: 'characters',
    title: 'Characters',
    description: '',
    kind: 'page',
    urlPatterns: ['/characters'],
    detection: { snapshotAnyOf: ['Characters'] },
    requiresAuth: true,
    interactives: [],
    firstSeenAt: '',
    lastSeenAt: '',
  };
  try {
    const result = await pollSubmittedArtifact(
      { browser, llm } as never,
      trail,
      page,
      { evidenceDir },
      'Finalize character was clicked once.',
    );
    assert.equal(result.status, 'persisted');
    assert.equal(result.timedOut, false);
    assert.equal(waits, 3);
    assert.equal(clicks, 0);
    assert.equal(trail.terminalEvidence?.source, 'vision');
  } finally {
    config.deep.processingWaitMs = originalWait;
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('uncertain loading after a submitted mutation stays in click-free polling', async () => {
  const originalWait = config.deep.processingWaitMs;
  config.deep.processingWaitMs = 100;
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-uncertain-loading-poll-'));
  let waits = 0;
  let llmCalls = 0;
  const browser = {
    getUrl: () => 'https://example.test/assets',
    wait: () => {
      waits++;
      const until = Date.now() + 4;
      while (Date.now() < until) {
        // Advance real time without a production sleep.
      }
    },
    snapshotInteractive: () => '- heading "Your Assets"',
    snapshotFull: () => '- heading "Your Assets"',
    screenshotAnnotated: (filePath: string) => fs.writeFileSync(filePath, Buffer.from('asset-list')),
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      return llmCalls === 1
        ? '{"status":"uncertain","summary":"The asset list is displaying a loading spinner."}'
        : '{"status":"persisted","summary":"Wayfinder Compass is saved with an enabled Regenerate control."}';
    },
  } as unknown as LlmClient;
  const trail: WalkTrail = {
    id: 'walk:assets:add',
    entry: { pageId: 'assets', actionLabel: 'ADD ASSET' },
    startedAt: '',
    finishedAt: '',
    outcome: 'aborted',
    steps: [],
  };
  const page: PageNode = {
    id: 'assets',
    title: 'Assets',
    description: '',
    kind: 'page',
    urlPatterns: ['/assets'],
    detection: { snapshotAnyOf: ['Your Assets'] },
    requiresAuth: true,
    interactives: [],
    firstSeenAt: '',
    lastSeenAt: '',
  };
  try {
    const result = await pollSubmittedArtifact(
      { browser, llm } as never,
      trail,
      page,
      { evidenceDir },
      'Finalize Asset was clicked once.',
    );
    assert.equal(result.status, 'persisted');
    assert.equal(result.timedOut, false);
    assert.equal(llmCalls, 2);
    assert.equal(waits, 2);
  } finally {
    config.deep.processingWaitMs = originalWait;
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  }
});
