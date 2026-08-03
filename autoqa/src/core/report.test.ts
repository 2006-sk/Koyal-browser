import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeArtifactsIndex } from './evidence.js';
import {
  appendReportNotes,
  scenarioEvidenceDir,
  writeRunReport,
} from './report.js';
import type { RunReport, TestStep } from './types.js';

function passingStep(evidenceFile: string): TestStep {
  return {
    workflow: 'create-character',
    action: 'Create a character',
    expected: 'Character is saved',
    result: {
      verdict: 'pass',
      severity: 'low',
      expected: 'Character is saved',
      actual: 'Character saved',
      reasons: [],
      retried: false,
      signals: {
        url: 'https://beta.koyal.ai/characters',
        title: 'Characters',
        snapshot: { raw: 'Character saved', interactive: '' },
        pageErrors: [],
        consoleMessages: [],
        consoleErrors: [],
        networkRequests: [],
      },
    },
    stepsToReproduce: ['Open Characters', 'Create a character'],
    evidenceFiles: [evidenceFile],
    evidenceDir: path.dirname(evidenceFile),
    artifactDir: path.dirname(evidenceFile),
  };
}

test('run reports keep only readable summaries at root and place detailed evidence in artifacts', () => {
  const reportsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-report-layout-'));
  const runId = 'run-layout';
  const runDir = path.join(reportsRoot, runId);
  const stepDir = scenarioEvidenceDir(runDir, 'characters');
  const summary = path.join(stepDir, 'step-summary.md');
  fs.writeFileSync(summary, '# step', 'utf8');
  const step = passingStep(summary);
  const report: RunReport = {
    runId,
    baseUrl: 'https://beta.koyal.ai',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    scenarios: [{
      id: 'characters',
      name: 'Characters',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      steps: [step],
    }],
  };

  try {
    writeRunReport(report, reportsRoot);
    writeArtifactsIndex(runDir, report.scenarios);
    appendReportNotes(runDir);

    assert.equal(fs.existsSync(path.join(runDir, 'report.md')), true);
    assert.equal(fs.existsSync(path.join(runDir, 'report.json')), false);
    assert.equal(fs.existsSync(path.join(runDir, 'ARTIFACTS.md')), false);
    assert.equal(fs.existsSync(path.join(runDir, 'artifacts', 'report.json')), true);
    assert.equal(fs.existsSync(path.join(runDir, 'artifacts', 'ARTIFACTS.md')), true);
    assert.equal(fs.existsSync(summary), true);

    const markdown = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
    assert.match(markdown, /artifacts\/characters\/step-summary\.md/);
    assert.match(markdown, /\[`bugs-reported\.md`\]\(bugs-reported\.md\)/);
    assert.match(markdown, /artifacts\/ARTIFACTS\.md/);

    const index = fs.readFileSync(path.join(runDir, 'artifacts', 'ARTIFACTS.md'), 'utf8');
    assert.match(index, /characters\/step-summary\.md/);
    assert.doesNotMatch(index, /artifacts\/characters\/step-summary\.md/);
  } finally {
    fs.rmSync(reportsRoot, { recursive: true, force: true });
  }
});
