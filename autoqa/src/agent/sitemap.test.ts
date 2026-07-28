import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalTerminalWalkFingerprint,
  dedupeEquivalentWalkFlows,
  matchPage,
  mergePage,
  summarizeSitemap,
  type Flow,
  type PageNode,
  type SiteMap,
  type WalkTrail,
} from './sitemap.js';

test('stateful wizard sidebar landmarks cannot absorb a different URL state', () => {
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: {
      upload: {
        id: 'upload',
        title: 'Upload',
        kind: 'wizard-step',
        description: '',
        urlPatterns: ['/upload'],
        detection: { snapshotAnyOf: ['Upload file', 'Final video'] },
        requiresAuth: true,
        interactives: [],
        optionGroups: [],
        firstSeenAt: '',
        lastSeenAt: '',
      },
    },
    edges: [],
    flows: [],
    siteHints: [],
  };

  assert.equal(matchPage(sitemap, 'https://example.test/finalvideo', 'Upload file\nFinal video\nDownload Video'), null);
  assert.equal(matchPage(sitemap, 'https://example.test/upload', 'Upload file\nFinal video')?.id, 'upload');
});

test('stateful pages with shared chrome remain separate across different URLs', () => {
  const space: PageNode = {
    id: 'space-characters',
    title: 'Space Characters',
    kind: 'wizard-step',
    description: '',
    urlPatterns: ['/space/characters'],
    detection: { snapshotAnyOf: ['Characters', 'CREATE COMMANDER'] },
    requiresAuth: true,
    interactives: [{ label: 'CREATE COMMANDER', role: 'button', category: 'create' }],
    firstSeenAt: '',
    lastSeenAt: '',
  };
  const titanic: PageNode = {
    id: 'titanic-characters',
    title: 'Titanic Characters',
    kind: 'wizard-step',
    description: '',
    urlPatterns: ['/titanic/characters'],
    detection: { snapshotAnyOf: ['Characters', 'CREATE ROSE'] },
    requiresAuth: true,
    interactives: [{ label: 'CREATE ROSE', role: 'button', category: 'create' }],
    firstSeenAt: '',
    lastSeenAt: '',
  };
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: { [space.id]: space },
    edges: [],
    flows: [],
    siteHints: [],
  };

  const merged = mergePage(sitemap, titanic);

  assert.equal(merged.id, 'titanic-characters');
  assert.deepEqual(Object.keys(sitemap.pages).sort(), ['space-characters', 'titanic-characters']);
  assert.deepEqual(sitemap.pages['space-characters'].urlPatterns, ['/space/characters']);
  assert.deepEqual(sitemap.pages['space-characters'].interactives.map((item) => item.label), ['CREATE COMMANDER']);
});

test('a reused LLM page id cannot merge different routes', () => {
  const first: PageNode = {
    id: 'wizard-characters',
    title: 'Space Characters',
    kind: 'wizard-step',
    description: '',
    urlPatterns: ['/space/characters'],
    detection: { snapshotAnyOf: ['Characters', 'CREATE COMMANDER'] },
    requiresAuth: true,
    interactives: [{ label: 'CREATE COMMANDER', role: 'button', category: 'create' }],
    firstSeenAt: '',
    lastSeenAt: '',
  };
  const second: PageNode = {
    ...first,
    title: 'Titanic Characters',
    urlPatterns: ['/titanic/characters'],
    detection: { snapshotAnyOf: ['Characters', 'CREATE ROSE'] },
    interactives: [{ label: 'CREATE ROSE', role: 'button', category: 'create' }],
  };
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: { [first.id]: first },
    edges: [],
    flows: [],
    siteHints: [],
  };

  const added = mergePage(sitemap, second);

  assert.equal(added.id, 'wizard-characters-titanic-characters');
  assert.deepEqual(Object.keys(sitemap.pages).sort(), [
    'wizard-characters',
    'wizard-characters-titanic-characters',
  ]);
  assert.deepEqual(sitemap.pages['wizard-characters'].interactives.map((item) => item.label), ['CREATE COMMANDER']);
  assert.deepEqual(added.interactives.map((item) => item.label), ['CREATE ROSE']);
});

test('mergePage records controls seen anonymously, authenticated, or in both contexts', () => {
  const anonymous: PageNode = {
    id: 'landing',
    title: 'Landing',
    description: '',
    urlPatterns: ['/'],
    detection: { snapshotAnyOf: ['Choose an experience'] },
    requiresAuth: false,
    observedAuthStates: ['anonymous'],
    interactives: [
      { label: 'Log in', role: 'link', category: 'nav', authVisibility: 'anonymous' },
      { label: 'Space', role: 'button', category: 'nav', authVisibility: 'anonymous' },
    ],
    firstSeenAt: '',
    lastSeenAt: '',
  };
  const authenticated: PageNode = {
    ...anonymous,
    observedAuthStates: ['authenticated'],
    interactives: [
      { label: 'Your profile', role: 'link', category: 'nav', authVisibility: 'authenticated' },
      { label: 'Space', role: 'button', category: 'nav', authVisibility: 'authenticated' },
    ],
  };
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: { landing: anonymous },
    edges: [],
    flows: [],
    siteHints: [],
  };

  const merged = mergePage(sitemap, authenticated);

  assert.deepEqual(merged.observedAuthStates, ['anonymous', 'authenticated']);
  assert.equal(
    merged.interactives.find((item) => item.label === 'Log in')?.authVisibility,
    'anonymous',
  );
  assert.equal(
    merged.interactives.find((item) => item.label === 'Your profile')?.authVisibility,
    'authenticated',
  );
  assert.equal(merged.interactives.find((item) => item.label === 'Space')?.authVisibility, 'both');
});

function walkedFlow(id: string): Flow {
  return {
    id,
    title: id,
    description: `Auto-generated from deep walk ${id} (outcome: terminal, 3 states)`,
    status: 'proposed',
    entry: { pageId: 'upload' },
    milestones: [{ id: 'm1', goal: 'verify output', kind: 'verify' }],
  };
}

function audioTrail(id: string, pageId: string, actionLabel: string, generatedFlowId: string): WalkTrail {
  return {
    id,
    entry: { pageId, actionLabel, entryUrl: `https://example.test/${pageId}` },
    startedAt: '',
    finishedAt: '',
    outcome: 'terminal',
    generatedFlowId,
    steps: [
      { index: 0, pageId: 'upload', kind: 'wizard-step', actions: [] },
      {
        index: 1,
        pageId: 'story-type',
        kind: 'wizard-step',
        actions: [{ type: 'click', label: 'Character Driven' }],
      },
      { index: 2, pageId: 'audio-transcript', kind: 'wizard-step', actions: [] },
      { index: 3, pageId: 'final-video', kind: 'terminal', actions: [] },
    ],
  };
}

test('equivalent terminal walks consolidate navigation aliases but preserve walks and edges', () => {
  const canonical = audioTrail(
    'walk:upload:start-with-audio',
    'upload',
    'Start with Audio',
    'walked-upload-start-with-audio',
  );
  const backAlias = audioTrail(
    'walk:story-type:go-back-to-upload-audio',
    'story-type',
    'Go back to upload audio',
    'walked-story-type-go-back-to-upload-audio',
  );
  const uploadAlias = audioTrail(
    'walk:theme:upload-file',
    'theme',
    'Upload file',
    'walked-theme-upload-file',
  );
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: {
      upload: {
        id: 'upload',
        title: 'Upload',
        kind: 'wizard-step',
        description: '',
        urlPatterns: ['/upload'],
        detection: { snapshotAnyOf: ['Upload'] },
        requiresAuth: true,
        interactives: [],
        optionGroups: [],
        firstSeenAt: '',
        lastSeenAt: '',
      },
      'story-type': {
        id: 'story-type',
        title: 'Story Type',
        kind: 'wizard-step',
        description: '',
        urlPatterns: ['/story-type'],
        detection: { snapshotAnyOf: ['Story Type'] },
        requiresAuth: true,
        interactives: [],
        optionGroups: [
          {
            id: 'story-mode',
            memberLabels: ['Concept Driven', 'Character Driven'],
            canonical: 'Concept Driven',
            primary: true,
            discoveredAt: '',
          },
        ],
        firstSeenAt: '',
        lastSeenAt: '',
      },
      'audio-transcript': {
        id: 'audio-transcript',
        title: 'Transcript',
        kind: 'wizard-step',
        description: '',
        urlPatterns: ['/transcript'],
        detection: { snapshotAnyOf: ['Transcript'] },
        requiresAuth: true,
        interactives: [],
        firstSeenAt: '',
        lastSeenAt: '',
      },
      'final-video': {
        id: 'final-video',
        title: 'Final Video',
        kind: 'terminal',
        description: '',
        urlPatterns: ['/final'],
        detection: { snapshotAnyOf: ['Download'] },
        requiresAuth: true,
        interactives: [],
        firstSeenAt: '',
        lastSeenAt: '',
      },
    },
    edges: [
      { from: 'story-type', actionLabel: 'Upload file', to: 'upload' },
      { from: 'theme', actionLabel: 'Upload file', to: 'upload' },
    ],
    flows: [
      walkedFlow(canonical.generatedFlowId!),
      walkedFlow(backAlias.generatedFlowId!),
      walkedFlow(uploadAlias.generatedFlowId!),
    ],
    walks: {
      [canonical.id]: canonical,
      [backAlias.id]: backAlias,
      [uploadAlias.id]: uploadAlias,
    },
    siteHints: [],
  };
  const originalEdges = structuredClone(sitemap.edges);

  const result = dedupeEquivalentWalkFlows(sitemap);

  assert.deepEqual(
    result.removedFlowIds.sort(),
    ['walked-story-type-go-back-to-upload-audio', 'walked-theme-upload-file'].sort(),
  );
  assert.deepEqual(sitemap.flows.map((flow) => flow.id), ['walked-upload-start-with-audio']);
  assert.equal(Object.keys(sitemap.walks!).length, 3);
  assert.deepEqual(sitemap.edges, originalEdges);
  assert.equal(backAlias.generatedFlowId, 'walked-upload-start-with-audio');
  assert.equal(uploadAlias.generatedFlowId, 'walked-upload-start-with-audio');
});

test('walk fingerprints keep different primary workflow modes and same-page mutations separate', () => {
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: {
      mode: {
        id: 'mode',
        title: 'Mode',
        kind: 'wizard-step',
        description: '',
        urlPatterns: ['/mode'],
        detection: { snapshotAnyOf: ['Mode'] },
        requiresAuth: false,
        interactives: [],
        optionGroups: [
          {
            id: 'mode',
            memberLabels: ['Video', 'Image'],
            canonical: 'Video',
            primary: true,
            discoveredAt: '',
          },
        ],
        firstSeenAt: '',
        lastSeenAt: '',
      },
      done: {
        id: 'done',
        title: 'Done',
        kind: 'terminal',
        description: '',
        urlPatterns: ['/done'],
        detection: { snapshotAnyOf: ['Done'] },
        requiresAuth: false,
        interactives: [],
        firstSeenAt: '',
        lastSeenAt: '',
      },
    },
    edges: [],
    flows: [],
    walks: {},
    siteHints: [],
  };
  const trail = (choice: string, entry = 'Generate'): WalkTrail => ({
    id: `walk:${choice}:${entry}`,
    entry: { pageId: 'mode', actionLabel: entry },
    startedAt: '',
    finishedAt: '',
    outcome: 'terminal',
    steps: [
      {
        index: 0,
        pageId: 'mode',
        kind: 'wizard-step',
        actions: [{ type: 'click', label: choice }],
      },
      { index: 1, pageId: 'done', kind: 'terminal', actions: [] },
    ],
  });

  assert.notEqual(
    canonicalTerminalWalkFingerprint(trail('Video'), sitemap),
    canonicalTerminalWalkFingerprint(trail('Image'), sitemap),
  );

  const samePageA = trail('Video', 'Add Asset');
  samePageA.steps = [{ index: 0, pageId: 'mode', kind: 'page', actions: [] }];
  const samePageB = trail('Video', 'Regenerate');
  samePageB.steps = [{ index: 0, pageId: 'mode', kind: 'page', actions: [] }];
  assert.notEqual(
    canonicalTerminalWalkFingerprint(samePageA, sitemap),
    canonicalTerminalWalkFingerprint(samePageB, sitemap),
  );
});

test('broad stateful urlIncludes cannot steal another theme exact route', () => {
  const space: PageNode = {
    id: 'wizard-characters',
    title: 'Space Characters',
    kind: 'wizard-step',
    description: '',
    urlPatterns: ['/space/characters'],
    detection: { snapshotAnyOf: ['CREATE COMMANDER'] },
    requiresAuth: true,
    interactives: [],
    firstSeenAt: '',
    lastSeenAt: '',
  };
  const titanic: PageNode = {
    ...space,
    id: 'wizard-characters-titanic',
    title: 'Titanic Characters',
    urlPatterns: ['/titanic/characters'],
    detection: { urlIncludes: '/characters', snapshotAnyOf: ['Characters'] },
  };
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: { [space.id]: space, [titanic.id]: titanic },
    edges: [],
    flows: [],
    siteHints: [],
  };

  assert.equal(
    matchPage(sitemap, 'https://example.test/space/characters', 'Jason already exists')?.id,
    'wizard-characters',
  );
});

test('broad terminal urlIncludes cannot label an unseen theme export as Titanic', () => {
  const titanicExport: PageNode = {
    id: 'wizard-export-titanic',
    title: 'Titanic Export',
    kind: 'terminal',
    description: '',
    urlPatterns: ['/titanic/export'],
    detection: { urlIncludes: '/export', snapshotAnyOf: ['Download your film'] },
    requiresAuth: true,
    interactives: [],
    firstSeenAt: '',
    lastSeenAt: '',
  };
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: { [titanicExport.id]: titanicExport },
    edges: [],
    flows: [],
    siteHints: [],
  };

  assert.equal(
    matchPage(sitemap, 'https://example.test/bollywood/export', 'Download your film'),
    null,
  );
});

test('a transient processing state is not kept solely because it owns the route', () => {
  const processing: PageNode = {
    id: 'transcript-processing',
    title: 'Processing transcript',
    kind: 'processing',
    description: '',
    urlPatterns: ['/transcript'],
    detection: { snapshotAnyOf: ['Transcribing audio...'] },
    requiresAuth: true,
    interactives: [],
    firstSeenAt: '',
    lastSeenAt: '',
  };
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: { [processing.id]: processing },
    edges: [],
    flows: [],
    siteHints: [],
  };

  assert.equal(
    matchPage(sitemap, 'https://example.test/transcript', 'Transcribing audio...')?.id,
    processing.id,
  );
  assert.equal(
    matchPage(sitemap, 'https://example.test/transcript', 'Review transcript\nNext'),
    null,
  );
});

test('flow proposal summary preserves observed branch provenance', () => {
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: {},
    edges: [],
    flows: [],
    siteHints: [],
    walks: {
      'walk:upload:start-audio': {
        id: 'walk:upload:start-audio',
        entry: { pageId: 'upload', actionLabel: 'Start with Audio' },
        startedAt: '',
        finishedAt: '',
        outcome: 'no-progress',
        steps: [
          {
            index: 0,
            pageId: 'upload',
            kind: 'wizard-step',
            action: { type: 'click', label: 'Start with Audio' },
          },
          {
            index: 1,
            pageId: 'audio-transcript',
            kind: 'wizard-step',
            action: { type: 'click', label: 'Next' },
          },
        ],
      },
    },
  };

  const summary = summarizeSitemap(sitemap);
  assert.match(summary, /authoritative path provenance/i);
  assert.match(summary, /upload --"Start with Audio".*audio-transcript --"Next"/);
});
