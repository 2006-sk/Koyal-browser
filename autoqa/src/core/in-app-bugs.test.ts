import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentBrowser } from './agent-browser.js';
import type { Explorer } from './explorer.js';
import { openKoyalBugReportForm, reportKoyalBugsInApp } from './in-app-bugs.js';
import { isProductBug } from './slack-bugs.js';
import type { RunReport, TestStep } from './types.js';

function failedStep(): TestStep {
  return {
    workflow: 'audio:edit-video',
    action: 'Submit Edit Video and wait for the edited result',
    expected: 'edited video completes',
    result: {
      verdict: 'fail',
      severity: 'high',
      expected: 'edited video completes',
      actual: 'video is not edited please try again later!!',
      reasons: ['visible product error'],
      retried: false,
      signals: {
        url: 'https://beta.koyal.ai/finalvideo',
        title: 'Final Video',
        snapshot: { raw: 'video is not edited please try again later!!', interactive: '' },
        pageErrors: [],
        consoleMessages: [],
        consoleErrors: [{ type: 'error', text: 'video is not edited please try again later!!' }],
        networkRequests: [],
      },
    },
    stepsToReproduce: [],
  };
}

function report(step = failedStep()): RunReport {
  return {
    runId: 'run-in-app-report',
    baseUrl: 'https://beta.koyal.ai',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    scenarios: [
      {
        id: 'audio',
        name: 'Audio replay',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        steps: [step],
      },
    ],
  };
}

test('in-app reporter submits one concise AutoQA report without repeating the action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-in-app-bug-'));
  const goals: string[] = [];
  const opened: string[] = [];
  let filledText = '';
  let submitted = false;
  let confirmationPolls = 0;
  try {
    const result = await reportKoyalBugsInApp({
      report: report(),
      hostname: 'beta.koyal.ai',
      runDir: dir,
      browser: {
        open: (url: string) => opened.push(url),
        wait: () => undefined,
        snapshotInteractive: () =>
          submitted && ++confirmationPolls >= 3
            ? 'text "Bug report submitted successfully! Thank you for your feedback."'
            : filledText
              ? `heading "Report a Bug"\ntextbox "Please describe the bug you encountered" [ref=e1]\ntext "${filledText.slice(0, 40)}"\nbutton "Submit Report"`
              : 'heading "Report a Bug"\ntextbox "Please describe the bug you encountered" [ref=e1]\nbutton "Submit Report"',
        snapshotFull: () => '',
        fillVisible: (_ref: string, value: string) => {
          filledText = value;
        },
        clickButtonByText: (label: string) => {
          if (label === 'Report a Bug') return false;
          submitted = label === 'Submit Report';
          return submitted;
        },
        clickByText: () => false,
        evalScript: () => 'NO_UNIQUE_REPORT_CONTROL',
      } as unknown as AgentBrowser,
      explorer: {
        achieveGoal: async (goal: string) => {
          goals.push(goal);
          return {
            goal,
            success: true,
            actions: [],
            stepsTaken: [],
            finalUrl: 'https://beta.koyal.ai/finalvideo',
            finalSnapshot: 'Thank you',
          };
        },
      } as unknown as Explorer,
    });
    assert.equal(result.submitted, 1);
    assert.deepEqual(opened, ['https://beta.koyal.ai/finalvideo']);
    assert.equal(goals.length, 0);
    assert.match(filledText, /Reported automatically by AutoQA/);
    assert.match(filledText, /video is not edited please try again later/);
    assert.match(filledText, /Blocked capability: Submit Edit Video/);
    assert.equal(result.submittedReports[0]?.description, filledText);
    assert.ok(confirmationPolls >= 3);
    assert.equal(fs.existsSync(path.join(dir, 'in-app-bug-reporting.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('icon-only fixed Koyal bug launcher is activated deterministically and form visibility is proved', () => {
  let modalOpen = false;
  let evalCalls = 0;
  const opened = openKoyalBugReportForm({
    snapshotInteractive: () => modalOpen
      ? 'heading "Report a Bug"\ntextbox "Please describe the bug"\nbutton "Submit Report"'
      : 'button [ref=e13]',
    snapshotFull: () => '',
    wait: () => undefined,
    clickButtonByText: () => false,
    clickByText: () => false,
    evalScript: () => {
      evalCalls++;
      modalOpen = true;
      return 'CLICKED_REPORT_CONTROL';
    },
  } as unknown as AgentBrowser);
  assert.equal(opened, true);
  assert.equal(evalCalls, 1);
});

test('in-app reporting failure is contained and does not alter the product verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-in-app-bug-'));
  const source = failedStep();
  try {
    const result = await reportKoyalBugsInApp({
      report: report(source),
      hostname: 'beta.koyal.ai',
      runDir: dir,
      browser: {
        open: () => {
          throw new Error('browser unavailable');
        },
        wait: () => undefined,
      } as unknown as AgentBrowser,
      explorer: {} as Explorer,
    });
    assert.equal(result.submitted, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(source.result.verdict, 'fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ambient page errors do not turn an automation failure into a product bug', () => {
  const step = failedStep();
  step.result.signals.snapshot = { raw: 'Character Driven\nNext disabled', interactive: '' };
  step.result.signals.consoleErrors = [];
  step.result.signals.pageErrors = [{ message: 'AbortError: audio element was destroyed' }];
  step.result.reasons = ['Expected snapshot to include "Audio transcript"'];
  assert.equal(isProductBug(step), false);
});

test('a visible application error is reportable even without a console error', () => {
  const step = failedStep();
  step.result.signals.consoleErrors = [];
  assert.equal(isProductBug(step), true);
});

test('a softened manual needs-review still reports a concrete visible product error', () => {
  const step = failedStep();
  step.result.verdict = 'needs-review';
  step.result.reasons = ['This manual audit is independent; keeping it unresolved'];
  assert.equal(isProductBug(step), true);
});

test('in-app description omits an ambient runtime error when a different visible product error is authoritative', async () => {
  const step = failedStep();
  step.result.verdict = 'needs-review';
  step.result.signals.pageErrors = [{ message: 'AbortError: stale audio element was destroyed' }];
  step.result.signals.consoleErrors = [];
  step.result.reasons = ['This manual audit is independent; keeping it unresolved'];
  const { inAppBugDescription } = await import('./in-app-bugs.js');
  const bug = {
    step,
    scenarioName: 'Audio',
    occurrences: 1,
    flows: new Set(['audio']),
  };
  const description = inAppBugDescription(bug, 'run-ambient-filter');
  assert.match(description, /video is not edited please try again later/i);
  assert.doesNotMatch(description, /AbortError|stale audio element/);
});
