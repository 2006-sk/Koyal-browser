import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunReport, TestStep } from './types.js';
import { functionalRunOutcome } from './run-outcome.js';

function step(verdict: TestStep['result']['verdict'], actual: string, opts: {
  url?: string;
  snapshot?: string;
  artifact?: boolean;
  reasons?: string[];
} = {}): TestStep {
  return {
    workflow: 'flow:m1',
    action: 'exercise requested control',
    expected: 'control works',
    result: {
      verdict,
      severity: 'high',
      expected: 'control works',
      actual,
      reasons: opts.reasons ?? [],
      retried: false,
      artifactPersistenceVerified: opts.artifact,
      signals: {
        url: opts.url ?? 'https://example.test/page',
        title: '',
        snapshot: { raw: opts.snapshot ?? '', interactive: '' },
        pageErrors: [],
        consoleMessages: [],
        consoleErrors: [],
        networkRequests: [],
      },
    },
    stepsToReproduce: [],
  };
}

function report(steps: TestStep[]): RunReport {
  return {
    runId: 'outcome-test',
    baseUrl: 'https://example.test',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    scenarios: [{ id: 'flow', name: 'Flow', startedAt: '', finishedAt: '', steps }],
  };
}

test('verified terminal artifact makes the run successful despite raw audit failures', () => {
  const result = functionalRunOutcome(report([
    step('fail', 'The requested optional control was not visible'),
    step('pass', 'Final video is playable and downloadable', {
      url: 'https://example.test/finalvideo',
      snapshot: 'Final Video Download Video Export XML',
      artifact: true,
    }),
  ]));
  assert.equal(result.success, true);
  assert.equal(result.rawFailures, 1);
  assert.equal(result.terminalArtifactVerified, true);
});

test('a harmless assertion mismatch does not fail a completed responsive run', () => {
  const result = functionalRunOutcome(report([
    step('fail', 'Expected heading was renamed; page remained usable'),
  ]));
  assert.equal(result.success, true);
  assert.equal(result.genuineBlockers.length, 0);
});

test('an unrecovered forward-progress failure remains a real run failure', () => {
  const result = functionalRunOutcome(report([
    step('fail', 'could not recover position; recording remaining 25 milestones as skipped'),
  ]));
  assert.equal(result.success, false);
  assert.equal(result.genuineBlockers.length, 1);
});

test('a persisted intermediate object is not mistaken for a terminal artifact', () => {
  const result = functionalRunOutcome(report([
    step('pass', 'Character persisted in the library', { artifact: true }),
    step('fail', 'skipped — not tested because upstream milestone m3 failed and position could not be recovered'),
  ]));
  assert.equal(result.terminalArtifactVerified, false);
  assert.equal(result.success, false);
});

test('a concrete visible product error remains a real run failure without terminal proof', () => {
  const broken = step('fail', 'Something went wrong. Please try again later.', {
    snapshot: 'Something went wrong. Please try again later.',
    reasons: ['visible product error'],
  });
  const result = functionalRunOutcome(report([broken]));
  assert.equal(result.success, false);
  assert.equal(result.genuineBlockers.length, 1);
});
