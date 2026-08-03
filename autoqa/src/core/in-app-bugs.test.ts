import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentBrowser } from './agent-browser.js';
import type { Explorer } from './explorer.js';
import {
  openKoyalBugReportForm,
  reportKoyalBugsInApp,
  type InAppBugReportResult,
} from './in-app-bugs.js';
import { isProductBug, isReportableIssue } from './slack-bugs.js';
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
    assert.match(filledText, /AutoQA issue report/);
    assert.match(filledText, /video is not edited please try again later/);
    assert.match(filledText, /Impact: Submit Edit Video/);
    assert.match(filledText, /Console \/ exceptions:/);
    assert.match(filledText, /Network:/);
    assert.match(filledText, /Where: https:\/\/beta\.koyal\.ai\/finalvideo — audio:edit-video\s*$/);
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

test('ambient page errors remain non-blocking but are broadly reportable', () => {
  const step = failedStep();
  step.result.signals.snapshot = { raw: 'Character Driven\nNext disabled', interactive: '' };
  step.result.signals.consoleErrors = [];
  step.result.signals.pageErrors = [{ message: 'AbortError: audio element was destroyed' }];
  step.result.reasons = ['Expected snapshot to include "Audio transcript"'];
  assert.equal(isProductBug(step), false);
  assert.equal(isReportableIssue(step), true);
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

test('in-app description includes captured runtime evidence and keeps location last', async () => {
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
  assert.match(description, /AbortError: stale audio element was destroyed/);
  assert.match(description, /Where: https:\/\/beta\.koyal\.ai\/finalvideo — audio:edit-video\s*$/);
});

test('primary unresolved checkpoint without runtime logs is reportable, downstream synthetic skip is not', () => {
  const primary = failedStep();
  primary.result.signals.snapshot = { raw: 'Scene details modal remains open', interactive: '' };
  primary.result.signals.consoleErrors = [];
  primary.result.reasons = ['Scene modal blocked Create Video after Close had no effect'];
  assert.equal(isProductBug(primary), false);
  assert.equal(isReportableIssue(primary), true);

  const downstream = failedStep();
  downstream.result.signals.snapshot = { raw: '', interactive: '' };
  downstream.result.signals.consoleErrors = [];
  downstream.result.reasons = ['Skipped — not tested because upstream milestone failed'];
  assert.equal(isReportableIssue(downstream), false);
});

test('visible generated-data failure keeps the affected subject in the report', async () => {
  const step = failedStep();
  step.result.signals.snapshot = {
    raw: 'Error in Image 50: prompts data is not generated please try again later',
    interactive: '',
  };
  step.result.signals.consoleErrors = [];
  step.result.reasons = ['Visible product error blocked scene generation'];
  const { inAppBugDescription } = await import('./in-app-bugs.js');
  const description = inAppBugDescription({
    step,
    scenarioName: 'Scene generation',
    occurrences: 1,
    flows: new Set(['scene']),
  }, 'run-scene-error');
  assert.match(description, /Issue: prompts data is not generated please try again later/i);
});

test('zero-issue run still writes in-app reporting evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-in-app-empty-'));
  const passing = failedStep();
  passing.result.verdict = 'pass';
  passing.result.signals.consoleErrors = [];
  passing.result.signals.pageErrors = [];
  passing.result.signals.snapshot = { raw: 'All good', interactive: '' };
  passing.result.reasons = [];
  try {
    const result = await reportKoyalBugsInApp({
      report: report(passing),
      hostname: 'beta.koyal.ai',
      runDir: dir,
      browser: {} as AgentBrowser,
      explorer: {} as Explorer,
    });
    assert.equal(result.found, 0);
    const evidence = JSON.parse(
      fs.readFileSync(path.join(dir, 'in-app-bug-reporting.json'), 'utf8'),
    ) as InAppBugReportResult;
    assert.equal(evidence.found, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
