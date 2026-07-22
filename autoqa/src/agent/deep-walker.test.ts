import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentBrowser } from '../core/agent-browser.js';
import { actionableSteps, recoverAwayFromBlockedState } from './deep-walker.js';
import type { PageNode, WalkTrail } from './sitemap.js';

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
