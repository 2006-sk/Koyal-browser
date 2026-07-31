import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectProductBugs, notifyKoyalBugsToSlack } from './slack-bugs.js';
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

test('Slack bug report uses platform/location/logs and a three-line explanation', async () => {
  const report: RunReport = {
    runId: 'run-slack-format',
    startedAt: '',
    finishedAt: '',
    baseUrl: 'https://beta.koyal.ai',
    scenarios: [{
      id: 'audio-flow',
      name: 'Audio flow',
      startedAt: '',
      finishedAt: '',
      steps: [
        failedStep(
          'audio-flow:style',
          'AbortError: wardrobe generation aborted',
          'https://beta.koyal.ai/selectStyle?projectId=project-42',
        ),
      ],
    }],
  };
  const previousWebhook = process.env.SLACK_BUGS_WEBHOOK_URL;
  const previousToken = process.env.KOYAL_ADMIN_TOKEN;
  const previousEndpoint = process.env.KOYAL_ADMIN_ERROR_LOGS_URL;
  const previousFetch = globalThis.fetch;
  let postedText = '';
  process.env.SLACK_BUGS_WEBHOOK_URL = 'https://hooks.slack.test/bugs';
  process.env.KOYAL_ADMIN_TOKEN = 'test-admin-token';
  process.env.KOYAL_ADMIN_ERROR_LOGS_URL =
    'https://beta.koyal.ai/v1/api/admin/error-logs?limit=300';
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('/error-logs')) {
      assert.equal(
        (init?.headers as Record<string, string>)['x-admin-token'],
        'test-admin-token',
      );
      return new Response(
        JSON.stringify({
          data: [{
            projectId: 'project-42',
            message: 'wardrobe generation aborted',
            status: 500,
          }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    postedText = JSON.parse(String(init?.body)).text;
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await notifyKoyalBugsToSlack({
      report,
      hostname: 'beta.koyal.ai',
      credentialsType: 'saved test credentials',
    });
    assert.equal(result.posted, true);
    assert.match(postedText, /\*Platform:\* beta\.koyal\.ai/);
    assert.match(postedText, /\*Where bug was found:\*/);
    assert.match(postedText, /\*Error log:\*/);
    assert.match(postedText, /\*Backend log:\*/);
    assert.match(postedText, /project-42/);
    assert.match(postedText, /\*What:\*.+\n\*Why:\*.+\n\*Impact:\*/s);
    assert.doesNotMatch(postedText, /Reproduction|Inputs|test-admin-token/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWebhook === undefined) delete process.env.SLACK_BUGS_WEBHOOK_URL;
    else process.env.SLACK_BUGS_WEBHOOK_URL = previousWebhook;
    if (previousToken === undefined) delete process.env.KOYAL_ADMIN_TOKEN;
    else process.env.KOYAL_ADMIN_TOKEN = previousToken;
    if (previousEndpoint === undefined) {
      delete process.env.KOYAL_ADMIN_ERROR_LOGS_URL;
    } else {
      process.env.KOYAL_ADMIN_ERROR_LOGS_URL = previousEndpoint;
    }
  }
});
