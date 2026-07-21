import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectProductBugs } from './slack-bugs.js';
import type { RunReport, TestStep } from './types.js';

function failedStep(workflow: string, message: string, url: string): TestStep {
  return {
    workflow,
    action: 'Load the page',
    expected: 'The page loads',
    stepsToReproduce: ['Open the page'],
    result: {
      verdict: 'fail',
      severity: 'critical',
      expected: 'The page loads',
      actual: 'An exception occurred',
      reasons: ['Uncaught JS exception'],
      retried: false,
      signals: {
        url,
        title: 'Koyal',
        snapshot: { raw: 'heading "Koyal"', interactive: '' },
        pageErrors: [{ message }],
        consoleMessages: [],
        consoleErrors: [],
        networkRequests: [],
      },
    },
  };
}

test('collectProductBugs collapses a repeated exception across milestones and flows', () => {
  const message = '{"text":"TypeError: Cannot read properties of undefined","url":"https://xp.koyal.ai/app.js"}';
  const report: RunReport = {
    runId: 'run-1',
    startedAt: '2026-07-21T00:00:00Z',
    finishedAt: '2026-07-21T00:01:00Z',
    baseUrl: 'https://xp.koyal.ai',
    scenarios: [
      { id: 'flow-a', name: 'Flow A', startedAt: '', finishedAt: '', steps: [
        failedStep('flow-a:m1', message, 'https://xp.koyal.ai/space'),
        failedStep('flow-a:m2', message, 'https://xp.koyal.ai/space'),
      ] },
      { id: 'flow-b', name: 'Flow B', startedAt: '', finishedAt: '', steps: [
        failedStep('flow-b:m1', message, 'https://xp.koyal.ai/titanic'),
      ] },
    ],
  };

  const bugs = collectProductBugs(report, 'saved test credentials');
  assert.equal(bugs.length, 1);
  assert.match(bugs[0], /3 occurrences across 2 flows/);
  assert.match(bugs[0], /TypeError: Cannot read properties of undefined/);
});

test('collectProductBugs keeps distinct exceptions separate', () => {
  const report: RunReport = {
    runId: 'run-2',
    startedAt: '',
    finishedAt: '',
    baseUrl: 'https://xp.koyal.ai',
    scenarios: [{
      id: 'flow-a', name: 'Flow A', startedAt: '', finishedAt: '', steps: [
        failedStep('flow-a:m1', 'TypeError: first', 'https://xp.koyal.ai/a'),
        failedStep('flow-a:m2', 'ReferenceError: second', 'https://xp.koyal.ai/b'),
      ],
    }],
  };

  assert.equal(collectProductBugs(report, 'saved test credentials').length, 2);
});
