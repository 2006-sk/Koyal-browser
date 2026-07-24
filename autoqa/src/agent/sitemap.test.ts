import assert from 'node:assert/strict';
import test from 'node:test';
import { matchPage, mergePage, summarizeSitemap, type PageNode, type SiteMap } from './sitemap.js';

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
