import assert from 'node:assert/strict';
import test from 'node:test';
import type { SiteMap } from '../agent/sitemap.js';
import {
  bestManualFlow,
  bestManualPage,
  manualAcceptanceChecklist,
  planManualRequest,
  upsertManualFlow,
  validateManualPlan,
  type ManualPlan,
} from './manual.js';

function sitemap(): SiteMap {
  const now = new Date().toISOString();
  return {
    origin: 'https://example.test',
    updatedAt: now,
    pages: {
      dashboard: {
        id: 'dashboard',
        title: 'Dashboard',
        description: 'Project home',
        urlPatterns: ['/dashboard'],
        detection: { snapshotAnyOf: ['Projects'] },
        requiresAuth: true,
        interactives: [{ label: 'Create', role: 'button', category: 'create' }],
        firstSeenAt: now,
        lastSeenAt: now,
      },
      locations: {
        id: 'locations',
        title: 'Locations Library',
        description: 'Create and edit filming locations',
        urlPatterns: ['/locations'],
        detection: { snapshotAnyOf: ['Add New Location'] },
        requiresAuth: true,
        interactives: [
          { label: 'Add New Location', role: 'button', category: 'create' },
          { label: 'Regenerate', role: 'button', category: 'edit' },
          { label: 'Expand sidebar', role: 'button', category: 'nav' },
        ],
        firstSeenAt: now,
        lastSeenAt: now,
      },
    },
    edges: [],
    flows: [],
    walks: {},
    siteHints: [],
  };
}

test('bestManualPage grounds a feature request in matching sitemap content', () => {
  assert.equal(bestManualPage(sitemap(), 'go test the locations part')?.id, 'locations');
});

test('upsertManualFlow creates a stable focused flow and does not duplicate it', () => {
  const map = sitemap();
  let saves = 0;
  const state = { sitemap: map, saveSitemap: () => saves++ };
  const plan: ManualPlan = {
    mode: 'focused-page',
    targetPageId: 'locations',
    title: 'Test locations',
    goal: 'Create or edit one location and verify it persists.',
    kind: 'edit',
  };
  const first = upsertManualFlow(state, 'test the locations part', plan);
  const second = upsertManualFlow(state, 'test the locations part', plan);

  assert.equal(first, second);
  assert.equal(map.flows.length, 1);
  assert.equal(first.entry.url, 'https://example.test/locations');
  assert.deepEqual(first.milestones[0].guardPhases, ['locations']);
  assert.equal(first.milestones[0].goal, plan.goal);
  assert.equal(saves, 1);
});

test('focused task-graph flow runs enumerated functions as separate milestones', () => {
  const map = sitemap();
  const request =
    'Test the visible final-video functions Retake, Add Reference using a file, and Reframe; verify the video after each operation';
  const flow = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    request,
    {
      mode: 'focused-page',
      targetPageId: 'locations',
      title: 'Focused functions',
      goal: request,
      kind: 'edit',
    },
    { engine: 'task-graph' },
  );

  assert.deepEqual(
    flow.manualExecution?.tasks.map((task) => task.requirement),
    [
      'Test the visible final-video function: Retake; verify the video after each operation',
      'Test the visible final-video function: Add Reference using a file; verify the video after each operation',
      'Test the visible final-video function: Reframe; verify the video after each operation',
    ],
  );
  assert.deepEqual(
    flow.milestones.map((milestone) => milestone.id),
    ['manual-task-1', 'manual-task-2', 'manual-task-3', 'manual-task-final-proof'],
  );
  assert.equal(flow.milestones[1].kind, 'upload');
});

test('upsertManualFlow creates a request-specific copy of a matching platform flow', () => {
  const map = sitemap();
  const original = {
    id: 'location-e2e',
    title: 'Location end to end',
    description: 'Create and persist a location',
    status: 'proposed',
    entry: { pageId: 'locations', url: '/locations' },
    milestones: [{ id: 'm1', goal: 'Create a location', kind: 'create' }],
  } satisfies SiteMap['flows'][number];
  map.flows.push(original);
  let saves = 0;
  const selected = upsertManualFlow(
    { sitemap: map, saveSitemap: () => saves++ },
    'Click Add New Location, name it Harbor Point, and save it',
    {
      mode: 'existing-flow',
      existingFlowId: 'location-e2e',
      title: 'ignored',
      goal: 'ignored',
      kind: 'create',
    },
  );
  assert.notEqual(selected, original);
  assert.match(selected.id, /^manual-/);
  assert.equal(selected.status, 'exploratory');
  assert.equal(selected.qualification?.phase, 'learning');
  assert.equal(
    selected.manualContract?.request,
    'Click Add New Location, name it Harbor Point, and save it',
  );
  assert.match(selected.milestones[0].goal, /Create a location/);
  assert.equal(selected.milestones.at(-2)?.manualContractAudit, true);
  assert.match(selected.milestones.at(-1)?.goal ?? '', /FINAL MANUAL CONTRACT PROOF/);
  assert.equal(original.status, 'proposed');
  assert.equal(original.milestones[0].goal, 'Create a location');
  assert.equal(map.flows.length, 2);
  assert.equal(saves, 1);
});

test('task-graph manual engine stores compact active tasks without mutating the source flow', () => {
  const map = sitemap();
  const original = {
    id: 'location-e2e',
    title: 'Location end to end',
    description: 'Create and persist a location',
    status: 'deterministic',
    entry: { pageId: 'locations', url: '/locations' },
    milestones: [
      {
        id: 'open',
        goal: 'Open locations',
        kind: 'navigate',
        guardPhases: ['locations'],
      },
      {
        id: 'final',
        goal: 'Verify the final persisted location',
        kind: 'verify',
        guardPhases: ['locations'],
      },
    ],
  } satisfies SiteMap['flows'][number];
  map.flows.push(original);
  const request =
    'Create one new location and verify it persists. After rendering verify the final artifact.';
  const flow = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    request,
    {
      mode: 'existing-flow',
      existingFlowId: original.id,
      title: original.title,
      goal: request,
      kind: 'create',
    },
    { engine: 'task-graph' },
  );

  assert.equal(flow.manualExecution?.version, 1);
  assert.equal(flow.manualExecution?.policy.context, 'active-task');
  assert.deepEqual(
    flow.manualExecution?.tasks.map((task) => task.requirement),
    [
      'Create one new location and verify it persists',
      'After rendering verify the final artifact',
    ],
  );
  assert.ok(flow.milestones.some((milestone) => milestone.manualTaskId === 'acceptance-1'));
  assert.ok(flow.milestones.some((milestone) => milestone.id === 'manual-task-final-proof'));
  assert.doesNotMatch(flow.milestones[0].goal, /After rendering verify/);
  assert.equal(original.milestones[0].goal, 'Open locations');
});

test('task-graph end-to-end creation starts through a dedicated fresh-entry checkpoint', () => {
  const map = sitemap();
  map.pages.dashboard.interactives.push({
    label: 'New Project',
    role: 'button',
    category: 'create',
  });
  const original = {
    id: 'script-video',
    title: 'Script to final video',
    description: 'Upload a script and render a video',
    status: 'deterministic',
    entry: { pageId: 'locations', url: '/upload' },
    milestones: [
      {
        id: 'upload',
        goal: 'Upload script',
        kind: 'upload',
        guardPhases: ['locations'],
      },
      {
        id: 'final',
        goal: 'Verify final video',
        kind: 'verify',
        guardPhases: ['locations'],
      },
    ],
  } satisfies SiteMap['flows'][number];
  map.flows.push(original);
  const flow = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    'Upload a script and create a final rendered video.',
    {
      mode: 'existing-flow',
      existingFlowId: original.id,
      title: original.title,
      goal: 'Upload a script and create a final rendered video.',
      kind: 'create',
    },
    { engine: 'task-graph' },
  );
  assert.equal(flow.entry.pageId, 'dashboard');
  assert.equal(flow.milestones[0].id, 'manual-fresh-entry');
  assert.deepEqual(flow.milestones[0].guardPhases, ['dashboard']);
  assert.equal(flow.milestones[0].manualJourneyDestinationPageId, 'locations');
  assert.match(flow.milestones[0].goal, /New Project/);
  assert.equal(flow.milestones[1].id, 'upload');
  assert.ok(flow.manualExecution?.primaryJourneyPageIds.includes('dashboard'));
});

test('task-graph location creation targets the mapped wizard instead of the read-only library', () => {
  const map = sitemap();
  const now = new Date().toISOString();
  map.pages['wizard-locations'] = {
    id: 'wizard-locations',
    title: 'Locations',
    description: 'Wizard step for creating and editing story locations',
    urlPatterns: ['/wizard/locations'],
    detection: { snapshotAnyOf: ['Location Description', 'Add New Location'] },
    requiresAuth: true,
    kind: 'wizard-step',
    interactives: [
      { label: 'Add New Location', role: 'button', category: 'create' },
      { label: 'Edit', role: 'button', category: 'edit' },
    ],
    firstSeenAt: now,
    lastSeenAt: now,
  };
  const original = {
    id: 'script-video',
    title: 'Script video workflow',
    description: 'Render a video',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [
      {
        id: 'locations-step',
        goal: 'Advance through locations',
        kind: 'navigate',
        guardPhases: ['wizard-locations'],
      },
    ],
  } satisfies SiteMap['flows'][number];
  map.flows.push(original);
  const state = { sitemap: map, saveSitemap: () => {} };
  const createFlow = upsertManualFlow(
    state,
    'Create one new test location and edit it.',
    {
      mode: 'existing-flow',
      existingFlowId: original.id,
      title: original.title,
      goal: 'Create one new test location and edit it.',
      kind: 'create',
    },
    { engine: 'task-graph' },
  );
  assert.equal(createFlow.manualExecution?.tasks[0].targetPageId, 'wizard-locations');
});

test('both manual planners route location creation to the mapped builder capability', () => {
  const map = sitemap();
  const now = new Date().toISOString();
  map.pages['locations-list'] = {
    id: 'locations-list',
    title: 'Your Locations',
    description: 'Search and manage saved locations',
    urlPatterns: ['/locations-list'],
    detection: { snapshotAnyOf: ['Your Locations'] },
    requiresAuth: true,
    interactives: [
      { label: 'Search locations', role: 'textbox', category: 'edit' },
      { label: 'Edit Harbor', role: 'button', category: 'edit' },
    ],
    firstSeenAt: now,
    lastSeenAt: now,
  };
  map.pages['wizard-locations'] = {
    id: 'wizard-locations',
    title: 'Locations',
    description: 'Wizard location builder',
    urlPatterns: ['/wizard/locations'],
    detection: { snapshotAnyOf: ['Add New Location'] },
    requiresAuth: true,
    kind: 'wizard-step',
    interactives: [
      { label: 'Add New Location', role: 'button', category: 'create' },
      { label: 'Regenerate', role: 'button', category: 'edit' },
    ],
    firstSeenAt: now,
    lastSeenAt: now,
  };

  const plan = validateManualPlan(
    map,
    'Go to Locations, create one new location and edit its description',
    {
      mode: 'focused-page',
      targetPageId: 'locations-list',
      title: 'Location lifecycle',
      kind: 'create',
    },
  );

  assert.equal(plan.mode, 'focused-page');
  assert.equal(plan.targetPageId, 'wizard-locations');
});

test('stateful manual capability inherits the mapped journey prefix instead of direct-opening its URL', () => {
  const map = sitemap();
  const now = new Date().toISOString();
  map.pages['wizard-locations'] = {
    id: 'wizard-locations',
    title: 'Locations',
    description: 'Wizard location builder',
    urlPatterns: ['/wizard/locations'],
    detection: { snapshotAnyOf: ['Add New Location'] },
    requiresAuth: true,
    kind: 'wizard-step',
    interactives: [
      { label: 'Add New Location', role: 'button', category: 'create' },
    ],
    firstSeenAt: now,
    lastSeenAt: now,
  };
  map.flows.push({
    id: 'script-journey',
    title: 'Script journey',
    description: 'Mapped script journey',
    status: 'exploratory',
    entry: { pageId: 'dashboard' },
    milestones: [
      { id: 'upload', goal: 'Upload script', kind: 'upload', guardPhases: ['dashboard'] },
      { id: 'theme', goal: 'Choose theme', kind: 'navigate', guardPhases: ['locations'] },
      {
        id: 'locations-step',
        goal: 'Configure locations',
        kind: 'navigate',
        guardPhases: ['wizard-locations'],
      },
      { id: 'final', goal: 'Render final video', kind: 'verify' },
    ],
  });

  const plan = validateManualPlan(map, 'Create one new location', {
    mode: 'focused-page',
    targetPageId: 'wizard-locations',
  });
  assert.equal(plan.mode, 'existing-flow');
  assert.equal(plan.existingFlowId, 'script-journey');

  const flow = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    'Create one new location',
    plan,
  );
  assert.deepEqual(
    flow.milestones
      .filter((milestone) => !milestone.manualContractAudit)
      .map((milestone) => milestone.id),
    ['upload', 'theme', 'locations-step', 'manual-contract-final-proof'],
  );
  assert.ok(!flow.milestones.some((milestone) => milestone.id === 'final'));
});

test('focused legacy manual flows carry the contract and disable generic replay probes', () => {
  const map = sitemap();
  const request = 'Create one location and verify it persists';
  const flow = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    request,
    {
      mode: 'focused-page',
      targetPageId: 'locations',
      title: 'Create location',
      goal: request,
      kind: 'create',
    },
  );

  assert.deepEqual(flow.manualContract?.checklist, [request]);
  assert.equal(flow.milestones[0].manualContractAudit, true);
  assert.equal(flow.milestones.at(-1)?.id, 'manual-contract-final-proof');
  assert.match(flow.milestones.at(-1)?.goal ?? '', /Do not perform another mutation/);
});

test('detailed manual flow preserves atomic acceptance clauses and audits beyond mapped terminal state', () => {
  const map = sitemap();
  map.pages.dashboard.interactives.push({
    label: 'New Project',
    role: 'button',
    category: 'create',
  });
  map.flows.push({
    id: 'script-video',
    title: 'Script to final video',
    description: 'Upload a script and render a final video',
    status: 'deterministic',
    entry: { pageId: 'locations', url: '/upload' },
    milestones: [
      { id: 'script', goal: 'Edit Script and advance', kind: 'edit' },
      { id: 'scenes', goal: 'Edit scenes', kind: 'edit' },
      { id: 'final', goal: 'Verify final rendered video', kind: 'verify' },
    ],
  });
  const request =
    'Start one genuinely new project through the verified Dashboard to New Project button path. ' +
    'Change one character voice, change one emotion, and edit one dialogue line. ' +
    'After rendering, test Edit Video, Retake, Add Reference, and Reframe.';
  assert.deepEqual(manualAcceptanceChecklist(request), [
    'Start one genuinely new project through the verified Dashboard to New Project button path',
    'Change one character voice, change one emotion, and edit one dialogue line',
    'After rendering, test Edit Video, Retake, Add Reference, and Reframe',
  ]);
  const flow = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    request,
    {
      mode: 'existing-flow',
      existingFlowId: 'script-video',
      title: 'Script',
      goal: request,
      kind: 'create',
    },
  );
  assert.equal(flow.entry.pageId, 'dashboard');
  assert.equal(flow.entry.url, 'https://example.test/dashboard');
  assert.deepEqual(flow.milestones[0].guardPhases, ['dashboard']);
  assert.match(flow.milestones[0].goal, /activate the mapped "New Project" control/);
  assert.match(flow.milestones[0].goal, /do not use a resumed draft/i);
  assert.ok(
    flow.milestones
      .filter((milestone) => !milestone.manualContractAudit)
      .slice(0, 2)
      .every((milestone) => /Manual acceptance contract is active/.test(milestone.goal)),
  );
  assert.ok(
    flow.milestones
      .filter((milestone) => !milestone.manualContractAudit)
      .slice(0, 2)
      .every((milestone) => !/Non-optional acceptance checklist/.test(milestone.goal)),
  );
  assert.match(flow.milestones[0].goal, /Before using a forward\/Next control/);
  assert.equal(flow.manualContract?.checklist.length, 3);
  const audits = flow.milestones.filter((milestone) => milestone.manualContractAudit);
  assert.equal(audits.length, 3);
  assert.deepEqual(audits.map((milestone) => milestone.manualContractItem), [1, 2, 3]);
  assert.ok(audits.every((milestone) => milestone.kind === 'navigate'));
  assert.match(audits[1]?.goal ?? '', /Audit only acceptance item 2/);
  assert.match(audits[1]?.goal ?? '', /one mapped-page recovery/);
  assert.deepEqual(
    flow.milestones.map((milestone) => milestone.id),
    [
      'script',
      'scenes',
      'manual-contract-audit-1',
      'manual-contract-audit-2',
      'final',
      'manual-contract-audit-3',
      'manual-contract-final-proof',
    ],
  );
  assert.equal(flow.milestones.at(-1)?.kind, 'verify');
  assert.match(flow.milestones.at(-1)?.goal ?? '', /every numbered obligation/);
});

test('a stricter follow-up request never reuses a stale generated manual flow', () => {
  const map = sitemap();
  map.flows.push({
    id: 'manual-create-outfit-old',
    title: 'Create outfit',
    description: 'Sitemap-directed manual request: create an outfit',
    status: 'exploratory',
    entry: { pageId: 'locations', url: '/locations' },
    milestones: [{ id: 'm1', goal: 'Create something', kind: 'create' }],
  });

  const plan = validateManualPlan(map, 'first click Expand sidebar, then select Aditi', {
    mode: 'existing-flow',
    existingFlowId: 'manual-create-outfit-old',
    title: 'ignored stale title',
    goal: 'ignored stale goal',
    kind: 'edit',
  });

  assert.equal(plan.mode, 'focused-page');
  assert.equal(plan.targetPageId, 'locations');
  assert.match(plan.goal, /first click Expand sidebar, then select Aditi/);
  assert.doesNotMatch(plan.goal, /Create something/);
});

test('planner inventory excludes generated manual flows', async () => {
  const map = sitemap();
  map.flows.push(
    {
      id: 'platform-location-flow',
      title: 'Platform locations',
      description: 'Create a location',
      status: 'deterministic',
      entry: { pageId: 'locations' },
      milestones: [{ id: 'm1', goal: 'Create a mapped location', kind: 'create' }],
    },
    {
      id: 'manual-stale-request',
      title: 'Old manual request',
      description: 'Sitemap-directed manual request: old values',
      status: 'exploratory',
      entry: { pageId: 'locations' },
      milestones: [{ id: 'm1', goal: 'Use the wrong old values', kind: 'edit' }],
    },
  );
  let prompt = '';
  const llm = {
    complete: async (input: { messages: Array<{ content: string }> }) => {
      prompt = input.messages[0].content;
      return JSON.stringify({
        mode: 'focused-page',
        targetPageId: 'locations',
        title: 'Fresh request',
        goal: 'Use current values',
        kind: 'edit',
      });
    },
  };

  await planManualRequest(llm as never, map, 'edit locations using the current values');
  assert.match(prompt, /platform-location-flow/);
  assert.doesNotMatch(prompt, /manual-stale-request/);
  assert.doesNotMatch(prompt, /wrong old values/);
});

test('equivalent whitespace and casing reuse the same request-specific flow', () => {
  const map = sitemap();
  const state = { sitemap: map, saveSitemap: () => {} };
  const plan: ManualPlan = {
    mode: 'focused-page',
    targetPageId: 'locations',
    title: 'Test exact control',
    goal: 'Click Expand sidebar before creating anything.',
    kind: 'edit',
  };
  const first = upsertManualFlow(state, 'Click  Expand sidebar FIRST', plan);
  const second = upsertManualFlow(state, '  click expand SIDEBAR first  ', plan);
  assert.equal(first, second);
  assert.equal(map.flows.length, 1);
});

test('different constraints on the same page create isolated flows and recipes ids', () => {
  const map = sitemap();
  const state = { sitemap: map, saveSitemap: () => {} };
  const plan: ManualPlan = {
    mode: 'focused-page',
    targetPageId: 'locations',
    title: 'Test locations',
    goal: 'Exercise the requested control.',
    kind: 'edit',
  };
  const first = upsertManualFlow(state, 'make the location black', plan);
  const second = upsertManualFlow(state, 'make the location pink', plan);
  assert.notEqual(first.id, second.id);
  assert.equal(map.flows.length, 2);
});

test('focused goal preserves an exact named control and required order', () => {
  const map = sitemap();
  const request = 'First click Expand sidebar, then search Aditi, and only then click CREATE OUTFIT';
  const plan = validateManualPlan(map, request, {
    mode: 'focused-page',
    targetPageId: 'locations',
    title: 'Ordered task',
    goal: 'Create an outfit.',
    kind: 'create',
  });
  assert.match(plan.goal, new RegExp(request));
  assert.ok(plan.goal.indexOf('Expand sidebar') < plan.goal.indexOf('CREATE OUTFIT'));
});

test('invalid planner ids stay sitemap-grounded and skipped flows cannot be selected', () => {
  const map = sitemap();
  map.flows.push({
    id: 'skipped-flow',
    title: 'Unavailable',
    description: 'Unavailable flow',
    status: 'skipped',
    entry: { pageId: 'dashboard' },
    milestones: [{ id: 'm1', goal: 'Do unavailable thing', kind: 'verify' }],
  });
  const plan = validateManualPlan(map, 'test Add New Location', {
    mode: 'existing-flow',
    existingFlowId: 'skipped-flow',
    targetPageId: 'invented-page',
  });
  assert.equal(plan.mode, 'focused-page');
  assert.equal(plan.targetPageId, 'locations');
});

test('vague outfit request remains intact as an actionable focused-page mission', () => {
  const map = sitemap();
  const request = 'go to locations search Airport and create a location';
  const plan = validateManualPlan(map, request, {
    mode: 'focused-page',
    targetPageId: 'locations',
    title: 'Location task',
    goal: 'Complete the requested task.',
    kind: 'create',
  });
  const flow = upsertManualFlow({ sitemap: map, saveSitemap: () => {} }, request, plan);
  assert.equal(flow.entry.pageId, 'locations');
  assert.match(flow.milestones[0].goal, /go to locations search Airport and create a location/);
  assert.match(flow.milestones[1].goal, /Only finish when the requested behavior has been proved/);
});

test('audio rendered-video request selects and copies every milestone of the full mapped flow', () => {
  const map = sitemap();
  map.flows.push({
    id: 'video-wizard-from-audio',
    title: 'Create final rendered video from audio',
    description: 'Upload audio and complete the video wizard end to end',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [
      { id: 'upload', goal: 'Upload an audio narration', kind: 'upload' },
      { id: 'theme', goal: 'Choose the video theme', kind: 'edit' },
      {
        id: 'render',
        goal: 'Create video and verify the final rendered video',
        kind: 'create',
        successHint: 'Final video',
      },
    ],
  });
  const request = 'go make a rendered video for audio path';
  const matched = bestManualFlow(map, request);
  assert.equal(matched?.id, 'video-wizard-from-audio');

  const plan = validateManualPlan(map, request, {});
  assert.equal(plan.mode, 'existing-flow');
  const manual = upsertManualFlow({ sitemap: map, saveSitemap: () => {} }, request, plan);
  assert.equal(manual.milestones.length, 5);
  assert.deepEqual(manual.milestones.slice(0, 3).map((milestone) => milestone.id), [
    'upload',
    'theme',
    'render',
  ]);
  assert.equal(manual.manualContract?.request, request);
  assert.equal(manual.milestones[2]?.successHint, 'Final video');
  assert.equal(manual.milestones.at(-2)?.manualContractAudit, true);
  assert.match(manual.milestones.at(-1)?.goal ?? '', /FINAL MANUAL CONTRACT PROOF/);
});

test('malformed planning output falls back to the matching complete flow', async () => {
  const map = sitemap();
  map.flows.push({
    id: 'audio-video',
    title: 'Audio to rendered video',
    description: 'Audio path from upload to final video',
    status: 'exploratory',
    entry: { pageId: 'dashboard' },
    milestones: [
      { id: 'upload', goal: 'Upload audio', kind: 'upload' },
      { id: 'final', goal: 'Verify rendered video', kind: 'verify' },
    ],
  });
  const llm = { complete: async () => 'not json' };
  const plan = await planManualRequest(
    llm as never,
    map,
    'make a rendered video through the audio path',
  );
  assert.equal(plan.mode, 'existing-flow');
  assert.equal(plan.existingFlowId, 'audio-video');
});

test('a feature appearing only inside an unrelated long flow does not hijack a focused request', () => {
  const map = sitemap();
  map.flows.push({
    id: 'audio-video',
    title: 'Audio to video',
    description: 'Complete the audio wizard',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [
      { id: 'upload', goal: 'Upload audio', kind: 'upload' },
      { id: 'location', goal: 'Choose a location', kind: 'edit' },
      { id: 'final', goal: 'Verify final video', kind: 'verify' },
    ],
  });
  assert.equal(bestManualFlow(map, 'test locations'), undefined);
  const plan = validateManualPlan(map, 'test locations', {});
  assert.equal(plan.mode, 'focused-page');
  assert.equal(plan.targetPageId, 'locations');
});

test('a focused character upload trims a required wizard path after its character checkpoint', () => {
  const map = sitemap();
  map.pages.characters = {
    id: 'characters',
    title: 'Characters',
    description: 'Create, upload, and manage reusable characters',
    urlPatterns: ['/characters'],
    detection: { snapshotAnyOf: ['Your Characters'] },
    requiresAuth: true,
    interactives: [
      { label: 'Add New Character', role: 'button', category: 'create' },
      { label: 'Upload image', role: 'button', category: 'upload' },
    ],
    firstSeenAt: map.updatedAt,
    lastSeenAt: map.updatedAt,
  };
  map.pages.storyType = {
    id: 'wizard-story-type',
    title: 'Select Story Type',
    description: 'Choose Character Driven and add characters to the project',
    urlPatterns: ['/selectStoryType'],
    detection: { snapshotAnyOf: ['Character Driven'] },
    requiresAuth: true,
    interactives: [
      { label: 'Character Driven', role: 'button', category: 'edit' },
      { label: 'Upload image', role: 'button', category: 'upload' },
    ],
    firstSeenAt: map.updatedAt,
    lastSeenAt: map.updatedAt,
  };
  map.flows.push({
    id: 'audio-wizard',
    title: 'Start with Audio Upload',
    description: 'Upload audio and complete the full video wizard',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [
      { id: 'upload', goal: 'Upload an audio file', kind: 'upload' },
      { id: 'character', goal: 'Create or upload a character image', kind: 'create' },
      { id: 'theme', goal: 'Choose a story theme', kind: 'edit' },
      { id: 'style', goal: 'Choose a video style', kind: 'edit' },
      { id: 'render', goal: 'Render the final video', kind: 'create' },
    ],
  });
  const request =
    'Go to Characters and create exactly one new character using a character image file I provide. Use a realistic human name, finalize it, and verify it persists in the character library.';

  assert.equal(bestManualFlow(map, request)?.id, 'audio-wizard');
  const plan = validateManualPlan(map, request, {
    mode: 'existing-flow',
    existingFlowId: 'audio-wizard',
    title: 'Character upload',
    goal: request,
    kind: 'upload',
  });
  assert.equal(plan.mode, 'existing-flow');
  const legacy = upsertManualFlow({ sitemap: map, saveSitemap: () => {} }, request, plan);
  assert.match(legacy.milestones.map((milestone) => milestone.goal).join('\n'), /Upload an audio file/);
  assert.match(legacy.milestones.map((milestone) => milestone.goal).join('\n'), /Create or upload a character image/);
  assert.doesNotMatch(legacy.milestones.map((milestone) => milestone.goal).join('\n'), /Choose a story theme|Render the final video/);
  assert.match(legacy.milestones.at(-1)?.goal ?? '', /focused result remains visibly completed/);

  const taskGraph = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    request,
    plan,
    { engine: 'task-graph' },
  );
  assert.doesNotMatch(
    taskGraph.milestones.map((milestone) => milestone.goal).join('\n'),
    /Choose a story theme|Render the final video/,
  );
  assert.equal(taskGraph.manualExecution?.tasks.length, 1);
  assert.equal(taskGraph.manualExecution?.tasks[0]?.targetPageId, 'wizard-story-type');
  assert.match(
    taskGraph.manualExecution?.tasks[0]?.requirement ?? '',
    /Go to Characters and create exactly one new character/,
  );
  assert.match(taskGraph.milestones.at(-1)?.goal ?? '', /focused result remains visibly completed/);
});

test('a destructive character request never reuses a character-creation flow', () => {
  const map = sitemap();
  map.pages.characters = {
    id: 'characters',
    title: 'Characters',
    description: 'Create and delete saved characters',
    urlPatterns: ['/characters'],
    detection: { snapshotAnyOf: ['Your Characters'] },
    requiresAuth: true,
    interactives: [
      { label: 'New Character', role: 'button', category: 'create' },
      { label: 'Delete (Mina)', role: 'button', category: 'edit' },
    ],
    firstSeenAt: map.updatedAt,
    lastSeenAt: map.updatedAt,
  };
  map.flows.push({
    id: 'create-character',
    title: 'Create character',
    description: 'Create and finalize a character',
    status: 'deterministic',
    entry: { pageId: 'characters' },
    milestones: [
      { id: 'create', goal: 'Create one character', kind: 'create' },
      { id: 'verify', goal: 'Verify the character persists', kind: 'verify' },
    ],
  });
  const request = 'Go to Characters and delete exactly 10 existing characters.';
  assert.equal(bestManualFlow(map, request), undefined);
  const plan = validateManualPlan(map, request, {
    mode: 'existing-flow',
    existingFlowId: 'create-character',
    title: 'Wrong mutation',
    goal: request,
    kind: 'edit',
  });
  assert.equal(plan.mode, 'focused-page');
  assert.equal(plan.targetPageId, 'characters');
});

test('a generic projects request prefers the primary projects page over a qualified collaborated-projects page', () => {
  const map = sitemap();
  map.pages.projects = {
    id: 'projects-list',
    title: 'Your Projects',
    description: 'Lists video projects with status tabs and pagination',
    urlPatterns: ['/projects'],
    detection: { snapshotAnyOf: ['Your Projects'] },
    requiresAuth: true,
    interactives: [{ label: 'Search projects', role: 'textbox', category: 'unknown' }],
    firstSeenAt: map.updatedAt,
    lastSeenAt: map.updatedAt,
  };
  map.pages.collaborated = {
    id: 'collaborated-projects-list',
    title: 'Collaborated Projects',
    description: 'Lists projects shared by other users',
    urlPatterns: ['/collaborated-projects'],
    detection: { snapshotAnyOf: ['Collaborated Projects'] },
    requiresAuth: true,
    interactives: [],
    firstSeenAt: map.updatedAt,
    lastSeenAt: map.updatedAt,
  };
  assert.equal(
    bestManualPage(map, 'Go to Projects and delete exactly 10 existing projects')?.id,
    'projects-list',
  );
});

test('a single distinctive feature name can still select its purpose-built flow', () => {
  const map = sitemap();
  map.flows.push({
    id: 'create-character',
    title: 'Character creation',
    description: 'Create and finalize a character',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [{ id: 'create', goal: 'Create character', kind: 'create' }],
  });
  assert.equal(bestManualFlow(map, 'create a new character')?.id, 'create-character');
});

test('manual flow goals forbid repeating a reversible choice-modal-close cycle', () => {
  const map = sitemap();
  map.flows.push({
    id: 'audio-video',
    title: 'Audio to video',
    description: 'Complete the audio wizard',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [{ id: 'style', goal: 'Choose style and advance', kind: 'edit' }],
  });
  const request = 'make a final video through audio';
  const flow = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    request,
    {
      mode: 'existing-flow',
      existingFlowId: 'audio-video',
      title: 'Audio',
      goal: request,
      kind: 'create',
    },
  );
  assert.match(flow.milestones[0].goal, /try the other safe visible choice once/);
  assert.match(flow.milestones[0].goal, /do not repeat the same choice-modal-close cycle/);
});

test('manual goals prioritize newly discovered required groups over retried choices', () => {
  const map = sitemap();
  const request = 'edit locations and keep moving forward';
  const plan = validateManualPlan(map, request, {
    mode: 'focused-page',
    targetPageId: 'locations',
    title: 'Complete wizard',
    goal: 'Advance through the wizard.',
    kind: 'edit',
  });
  const flow = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    request,
    plan,
  );
  assert.match(flow.milestones[0].goal, /inspect every visible required option group/);
  assert.match(flow.milestones[0].goal, /If loop analysis identifies a different unmet group/);
});

test('manual copies do not require a synthetic edit marker after navigating onward', () => {
  const map = sitemap();
  map.flows.push({
    id: 'edit-then-final',
    title: 'Edit then render',
    description: 'Edit a scene and continue to final video',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [
      { id: 'edit', goal: 'Edit the scene and continue', kind: 'edit' },
      { id: 'final', goal: 'Verify final video', kind: 'verify' },
    ],
  });
  const flow = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    'edit the scene and make a final video',
    {
      mode: 'existing-flow',
      existingFlowId: 'edit-then-final',
      title: 'Edit then render',
      goal: 'edit the scene and make a final video',
      kind: 'edit',
    },
  );
  assert.equal(flow.milestones[0].kind, 'navigate');
  assert.match(flow.milestones[0].goal, /Edit the scene and continue/);
  assert.equal(flow.milestones[1].kind, 'verify');
});

test('focused creation requires owner selection before mutation and verifies owner separately', () => {
  const map = sitemap();
  const request = 'go to locations, search Aditi, and create a black outfit for Aditi';
  const plan = validateManualPlan(map, request, {
    mode: 'focused-page',
    targetPageId: 'locations',
    title: 'Aditi outfit',
    goal: 'Create the requested result.',
    kind: 'create',
  });
  const flow = upsertManualFlow({ sitemap: map, saveSitemap: () => {} }, request, plan);
  assert.equal(flow.milestones.length, 3);
  assert.equal(flow.milestones[0].kind, 'navigate');
  assert.match(flow.milestones[0].goal, /click the mapped button labeled exactly "Expand sidebar"/);
  assert.match(flow.milestones[0].goal, /Search for "Aditi"/);
  assert.match(flow.milestones[0].goal, /Do not click any Create, Add, Try, Generate, Save, or Apply/);
  assert.equal(flow.milestones[0].successHint, 'Aditi');
  assert.match(flow.milestones[1].goal, /Before any create or edit action/);
  assert.match(flow.milestones[1].goal, /visibly confirm that the active entity matches/);
  assert.match(flow.milestones[1].goal, /first expose the mapped selector\/search UI/);
  assert.match(flow.milestones[1].goal, /search for and select "Aditi"/);
  assert.match(flow.milestones[1].goal, /"Expand sidebar" \(button\)/);
  assert.match(flow.milestones[1].goal, /only then perform the requested creation or edit/);
  assert.equal(flow.milestones[2].kind, 'verify');
  assert.match(flow.milestones[2].goal, /Do not pass from a generic success toast/);
  assert.match(flow.milestones[2].goal, /visible active owner/);
});

test('typo-tolerant page matching finds the intended mapped feature', () => {
  const map = sitemap();
  assert.equal(bestManualPage(map, 'test locatons')?.id, 'locations');
});

test('typo-tolerant flow matching selects a full audio-to-video journey', () => {
  const map = sitemap();
  map.flows.push({
    id: 'audio-to-final-video',
    title: 'Audio to rendered video',
    description: 'Upload audio and complete the path',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [
      { id: 'upload', goal: 'Upload audio', kind: 'upload' },
      { id: 'final', goal: 'Verify rendered final video', kind: 'verify' },
    ],
  });
  assert.equal(
    bestManualFlow(map, 'make a rendred vido through the audoi path')?.id,
    'audio-to-final-video',
  );
});

test('detailed value constraints do not dilute a clear end-to-end audio flow match', () => {
  const map = sitemap();
  map.flows.push({
    id: 'audio-to-final-video',
    title: 'Audio path',
    description: 'Upload or select audio and complete the full journey',
    status: 'exploratory',
    entry: { pageId: 'dashboard' },
    milestones: [
      { id: 'upload', goal: 'Select audio and trim its duration', kind: 'upload' },
      { id: 'final', goal: 'Verify the final rendered video is playable', kind: 'verify' },
    ],
  });
  const request =
    "Create a final rendered video through the audio path. Select 'The Fate of Ophelia | Taylor Swift'. " +
    'Trim from 15 seconds to 25 seconds so the duration is exactly 10 seconds.';
  assert.equal(bestManualFlow(map, request)?.id, 'audio-to-final-video');
});

test('generic text cannot match a substring hidden inside an unrelated flow', () => {
  const map = sitemap();
  map.flows.push({
    id: 'something-audio',
    title: 'Create something with audio',
    description: 'Audio creation flow',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [{ id: 'm1', goal: 'Create something', kind: 'create' }],
  });
  assert.equal(bestManualFlow(map, 'do the thing'), undefined);
  assert.equal(bestManualPage(map, 'do the thing'), undefined);
});

test('an unmapped feature errors instead of silently choosing an unrelated page', () => {
  const map = sitemap();
  map.pages['wizard-edit-script'] = {
    ...structuredClone(map.pages.locations),
    id: 'wizard-edit-script',
    title: 'Edit Script',
    description: 'Review the generated script.',
    urlPatterns: ['/scriptEdit'],
    interactives: [
      { label: 'At least five seconds of pure joy, I promise.', role: 'button', category: 'edit' },
    ],
  };
  assert.throws(
    () => validateManualPlan(map, 'check profile', {}),
    /sitemap has no page matching/i,
  );
  assert.throws(
    () =>
      validateManualPlan(map, 'check profile without making changes', {
        mode: 'focused-page',
        targetPageId: 'dashboard',
        title: 'View profile read-only',
        goal: 'Treat the dashboard as a profile.',
        kind: 'verify',
      }),
    /sitemap has no page matching/i,
  );
});

test('explicit read-only wording rejects a mutating flow and overrides a mutating planner kind', () => {
  const map = sitemap();
  map.pages.characters = {
    ...structuredClone(map.pages.locations),
    id: 'characters',
    title: 'Characters',
    description: 'View and create characters',
    urlPatterns: ['/characters'],
  };
  map.flows.push({
    id: 'create-character',
    title: 'Create character',
    description: 'Create and save a character',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [{ id: 'create', goal: 'Create character', kind: 'create' }],
  });
  const plan = validateManualPlan(
    map,
    'do not create anything, only verify characters are visible',
    {
      mode: 'existing-flow',
      existingFlowId: 'create-character',
      targetPageId: 'dashboard',
      kind: 'create',
    },
  );
  assert.equal(plan.mode, 'focused-page');
  assert.equal(plan.targetPageId, 'characters');
  assert.equal(plan.kind, 'verify');
});

test('read-only final-video request never selects a create-video flow', () => {
  const map = sitemap();
  map.flows.push({
    id: 'create-final-video',
    title: 'Create final video',
    description: 'Generate and render a final video',
    status: 'deterministic',
    entry: { pageId: 'dashboard' },
    milestones: [
      { id: 'create', goal: 'Create video', kind: 'create' },
      { id: 'final', goal: 'Verify final video', kind: 'verify' },
    ],
  });
  assert.equal(
    bestManualFlow(map, 'verify the final video, do not regenerate it'),
    undefined,
  );
});

test('multiword and categorized search phrases preserve the actual entity', () => {
  const map = sitemap();
  const state = { sitemap: map, saveSitemap: () => {} };
  const maryRequest = 'search for Mary Jane and create a location';
  const maryPlan = validateManualPlan(map, maryRequest, {
    mode: 'focused-page',
    targetPageId: 'locations',
    kind: 'create',
  });
  const mary = upsertManualFlow(state, maryRequest, maryPlan);
  assert.match(mary.milestones[0].goal, /Search for "Mary Jane"/);

  const aditiRequest = 'search characters for Aditi and create a location';
  const aditiPlan = validateManualPlan(map, aditiRequest, {
    mode: 'focused-page',
    targetPageId: 'locations',
    kind: 'create',
  });
  const aditi = upsertManualFlow(state, aditiRequest, aditiPlan);
  assert.match(aditi.milestones[0].goal, /Search for "Aditi"/);
  assert.doesNotMatch(aditi.milestones[0].goal, /Search for "characters"/i);
});

test('selector preparation prefers a mapped Expand control over generic Toggle controls', () => {
  const map = sitemap();
  map.pages.locations.interactives.unshift({
    label: 'Toggle sidebar',
    role: 'button',
    category: 'nav',
  });
  const request = 'search Aditi and create a location';
  const plan = validateManualPlan(map, request, {
    mode: 'focused-page',
    targetPageId: 'locations',
    kind: 'create',
  });
  const flow = upsertManualFlow({ sitemap: map, saveSitemap: () => {} }, request, plan);
  assert.match(flow.milestones[0].goal, /labeled exactly "Expand sidebar"/);
  assert.doesNotMatch(flow.milestones[0].goal, /labeled exactly "Toggle sidebar"/);
});

test('read-only grammar variants cannot be promoted into mutations', () => {
  const map = sitemap();
  for (const request of [
    'inspect locations without creating anything',
    'check locations without making changes',
    'just look at locations',
  ]) {
    const plan = validateManualPlan(map, request, {
      mode: 'focused-page',
      targetPageId: 'locations',
      kind: 'create',
    });
    assert.equal(plan.kind, 'verify', request);
    assert.match(plan.goal, /without creating, editing, uploading, submitting, or saving anything/i);
    assert.doesNotMatch(plan.goal, /make one meaningful change or creation/i);
  }
});

test('quoted multiword search entities remain intact in selector and verification checkpoints', () => {
  const map = sitemap();
  const request = 'search for "Mary Jane Watson" and create a location';
  const plan = validateManualPlan(map, request, {
    mode: 'focused-page',
    targetPageId: 'locations',
    kind: 'create',
  });
  const flow = upsertManualFlow({ sitemap: map, saveSitemap: () => {} }, request, plan);
  assert.match(flow.milestones[0].goal, /Search for "Mary Jane Watson"/);
  assert.equal(flow.milestones[0].successHint, 'Mary Jane Watson');
  assert.match(flow.milestones.at(-1)!.goal, /visible active owner/);
});

test('the same wording aimed at two mapped targets cannot share learned recipes', () => {
  const map = sitemap();
  const request = 'verify the mapped feature';
  const first = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    request,
    {
      mode: 'focused-page',
      targetPageId: 'dashboard',
      title: 'Dashboard verification',
      goal: request,
      kind: 'verify',
    },
  );
  const second = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    request,
    {
      mode: 'focused-page',
      targetPageId: 'locations',
      title: 'Locations verification',
      goal: request,
      kind: 'verify',
    },
  );
  assert.notEqual(first.id, second.id);
});

test('request-specific copies never mutate the original mapped flow contract', () => {
  const map = sitemap();
  const original = {
    id: 'location-create',
    title: 'Create location',
    description: 'Create and save a location',
    status: 'deterministic' as const,
    qualification: { phase: 'replay-validation' as const },
    entry: { pageId: 'locations' },
    milestones: [{ id: 'm1', goal: 'Create location', kind: 'edit' as const }],
  };
  map.flows.push(original);
  const before = structuredClone(original);
  const copy = upsertManualFlow(
    { sitemap: map, saveSitemap: () => {} },
    'create a black location',
    {
      mode: 'existing-flow',
      existingFlowId: original.id,
      title: original.title,
      goal: 'create a black location',
      kind: 'create',
    },
  );
  assert.deepEqual(original, before);
  assert.notEqual(copy, original);
  assert.equal(copy.status, 'exploratory');
  assert.equal(copy.milestones[0].kind, 'navigate');
});
