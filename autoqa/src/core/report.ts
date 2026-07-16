import fs from 'node:fs';
import path from 'node:path';
import type { RunReport, ScenarioResult, TestStep, Verdict } from './types.js';
import { ensureDir, relativeEvidencePath } from './evidence.js';

function verdictEmoji(verdict: Verdict): string {
  switch (verdict) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return 'FAIL';
    case 'needs-review':
      return 'NEEDS REVIEW';
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function formatEvidenceLinks(step: TestStep, runDir: string): string {
  if (!step.evidenceFiles?.length) return '—';
  return step.evidenceFiles
    .map((file) => {
      const rel = relativeEvidencePath(runDir, file);
      const name = path.basename(file);
      return `[${name}](${rel})`;
    })
    .join('<br>');
}

function summarizeCounts(scenarios: ScenarioResult[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { pass: 0, fail: 0, 'needs-review': 0 };
  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      counts[step.result.verdict]++;
    }
  }
  return counts;
}

export function createRunReport(baseUrl: string): RunReport {
  const now = new Date();
  const runId = now.toISOString().replace(/[:.]/g, '-');
  return {
    runId,
    startedAt: now.toISOString(),
    finishedAt: '',
    baseUrl,
    scenarios: [],
  };
}

export function finalizeRunReport(report: RunReport): RunReport {
  return {
    ...report,
    finishedAt: new Date().toISOString(),
  };
}

export function writeRunReport(report: RunReport, reportsRoot: string): string {
  const runDir = path.join(reportsRoot, report.runId);
  ensureDir(runDir);

  const mdPath = path.join(runDir, 'report.md');
  const jsonPath = path.join(runDir, 'report.json');

  fs.writeFileSync(mdPath, renderMarkdownReport(report, runDir), 'utf8');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return runDir;
}

export function appendReportNotes(runDir: string): void {
  const mdPath = path.join(runDir, 'report.md');
  if (!fs.existsSync(mdPath)) return;
  const extra = [
    '',
    '## Where to find agent actions & responses',
    '',
    'After every verification step, open the linked evidence folder. Each contains:',
    '',
    '- `step-summary.md` — action, verdict, explorer/LLM steps, repro steps',
    '- `snapshot-interactive.txt` — what the agent saw (`agent-browser snapshot -i`)',
    '- `snapshot-full.txt` — full accessibility tree',
    '- `console.json` — all console output + error-level lines',
    '- `network.json` / `network-all.json` — captured network requests',
    '- `page-errors.json` — uncaught JS exceptions',
    '- `screenshot.png` — annotated screenshot',
    '',
    'See also [`ARTIFACTS.md`](ARTIFACTS.md) for a per-step index.',
    '',
  ].join('\n');
  fs.appendFileSync(mdPath, extra, 'utf8');
}

export function renderMarkdownReport(report: RunReport, runDir: string): string {
  const counts = summarizeCounts(report.scenarios);
  const lines: string[] = [];

  lines.push(`# AutoQA Report — ${report.baseUrl}`);
  lines.push('');
  lines.push(`**Run ID:** \`${report.runId}\``);
  lines.push(`**Started:** ${report.startedAt}`);
  lines.push(`**Finished:** ${report.finishedAt || 'in progress'}`);
  lines.push(`**Base URL:** ${report.baseUrl}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Verdict | Count |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| PASS | ${counts.pass} |`);
  lines.push(`| FAIL | ${counts.fail} |`);
  lines.push(`| NEEDS REVIEW | ${counts['needs-review']} |`);
  lines.push('');
  lines.push('## Test Results');
  lines.push('');
  lines.push(
    '| Workflow | Action | Expected | Actual | Verdict | Severity | Evidence | Reproduction |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const scenario of report.scenarios) {
    for (const step of scenario.steps) {
      const repro = step.stepsToReproduce.map((s) => escapeCell(s)).join('<br>');
      lines.push(
        `| ${escapeCell(`${scenario.name}: ${step.workflow}`)} | ${escapeCell(step.action)} | ${escapeCell(step.expected)} | ${escapeCell(step.result.actual)} | ${verdictEmoji(step.result.verdict)} | ${step.result.severity} | ${formatEvidenceLinks(step, runDir)} | ${repro} |`,
      );
    }
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push(
    '- Verdicts are determined by the deterministic verification layer (console, network, DOM snapshot), not LLM impression alone.',
  );
  lines.push(
    '- Network request capture depends on agent-browser logging; when empty, DOM + console signals are used with possible NEEDS REVIEW.',
  );
  lines.push('');

  return lines.join('\n');
}

export function scenarioEvidenceDir(runDir: string, scenarioId: string): string {
  const dir = path.join(runDir, scenarioId);
  ensureDir(dir);
  return dir;
}
