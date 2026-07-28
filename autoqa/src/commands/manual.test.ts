import assert from 'node:assert/strict';
import test from 'node:test';
import type { SiteMap } from '../agent/sitemap.js';
import {
  bestManualFlow,
  bestManualPage,
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
  assert.match(selected.milestones[0].goal, /Click Add New Location, name it Harbor Point, and save it/);
  assert.match(selected.milestones[0].goal, /Create a location/);
  assert.equal(original.status, 'proposed');
  assert.equal(original.milestones[0].goal, 'Create a location');
  assert.equal(map.flows.length, 2);
  assert.equal(saves, 1);
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
  assert.equal(manual.milestones.length, 3);
  assert.deepEqual(manual.milestones.map((milestone) => milestone.id), [
    'upload',
    'theme',
    'render',
  ]);
  assert.ok(manual.milestones.every((milestone) => milestone.goal.includes(request)));
  assert.equal(manual.milestones.at(-1)?.successHint, 'Final video');
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
