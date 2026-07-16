import fs from 'node:fs';
import path from 'node:path';
import type { RunReport, ScenarioResult, TestStep, Verdict } from './types.js';
import { ensureDir } from './evidence.js';

function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return 'FAIL';
    case 'needs-review':
      return 'NEEDS REVIEW';
  }
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

function truncate(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n… _(truncated)_`;
}

function snapshotExcerpt(step: TestStep, maxLines = 40): string {
  const snap = step.result.signals.snapshot.interactive || step.result.signals.snapshot.raw || '';
  const lines = snap.split('\n').filter(Boolean);
  if (lines.length <= maxLines) return lines.join('\n');
  const head = Math.ceil(maxLines * 0.6);
  const tail = maxLines - head;
  return [...lines.slice(0, head), '…', ...lines.slice(-tail)].join('\n');
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

/** Wipe previous report folders/files so only the new REPORT.md remains. */
export function clearPreviousReports(reportsRoot: string): void {
  ensureDir(reportsRoot);
  for (const name of fs.readdirSync(reportsRoot)) {
    const full = path.join(reportsRoot, name);
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export function renderPresentationReport(report: RunReport, title: string): string {
  const counts = summarizeCounts(report.scenarios);
  const allSteps = report.scenarios.flatMap((s) =>
    s.steps.map((step) => ({ scenario: s, step })),
  );
  const fails = allSteps.filter((x) => x.step.result.verdict === 'fail');
  const reviews = allSteps.filter((x) => x.step.result.verdict === 'needs-review');
  const overall =
    counts.fail > 0 ? 'FAIL' : counts['needs-review'] > 0 ? 'NEEDS REVIEW' : 'PASS';

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`| --- | --- |`);
  lines.push(`| **Result** | **${overall}** |`);
  lines.push(`| Run ID | \`${report.runId}\` |`);
  lines.push(`| Started | ${report.startedAt} |`);
  lines.push(`| Finished | ${report.finishedAt || '—'} |`);
  lines.push(`| Base URL | ${report.baseUrl} |`);
  lines.push(
    `| Steps | ${counts.pass} PASS · ${counts.fail} FAIL · ${counts['needs-review']} NEEDS REVIEW |`,
  );
  lines.push('');

  const productBugs = allSteps.filter((x) =>
    x.step.result.reasons.some((r) => /KOYAL PRODUCT BUG/i.test(r)),
  );
  if (productBugs.length) {
    lines.push('## Koyal product bugs found');
    lines.push('');
    lines.push(
      '_The QA harness completed successfully. These failures are **Koyal product/infra bugs**, not harness defects. The flow is rejected until Koyal fixes them._',
    );
    lines.push('');
    for (const { scenario, step } of productBugs) {
      lines.push(`### ${scenario.id} · ${step.workflow}`);
      lines.push('');
      lines.push(`- **Owner:** Koyal`);
      lines.push(`- **Action:** ${step.action}`);
      lines.push(`- **Expected:** ${step.expected}`);
      lines.push(`- **URL:** ${step.result.signals.url}`);
      for (const r of step.result.reasons) {
        lines.push(`- ${r}`);
      }
      lines.push('');
    }
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| # | Scenario | Step | Verdict | Severity | URL |');
  lines.push('| ---: | --- | --- | --- | --- | --- |');
  let n = 0;
  for (const { scenario, step } of allSteps) {
    n += 1;
    lines.push(
      `| ${n} | ${scenario.id} | ${step.workflow} | ${verdictLabel(step.result.verdict)} | ${step.result.severity} | ${step.result.signals.url} |`,
    );
  }
  lines.push('');

  if (fails.length) {
    lines.push('## Failures (detail)');
    lines.push('');
    for (const { scenario, step } of fails) {
      lines.push(...renderStepDetail(scenario.id, step, true));
    }
  }

  if (reviews.length) {
    lines.push('## Needs review (detail)');
    lines.push('');
    for (const { scenario, step } of reviews) {
      lines.push(...renderStepDetail(scenario.id, step, true));
    }
  }

  lines.push('## All steps');
  lines.push('');
  for (const { scenario, step } of allSteps) {
    const expand = step.result.verdict !== 'pass';
    lines.push(...renderStepDetail(scenario.id, step, expand));
  }

  lines.push('---');
  lines.push('');
  lines.push('_Single-file presentation report. Per-step artifact folders are not kept._');
  lines.push('');

  return lines.join('\n');
}

function renderStepDetail(scenarioId: string, step: TestStep, expand: boolean): string[] {
  const lines: string[] = [];
  const v = verdictLabel(step.result.verdict);
  lines.push(`### ${scenarioId} · ${step.workflow} — ${v}`);
  lines.push('');
  lines.push(`- **Action:** ${step.action}`);
  lines.push(`- **Expected:** ${step.expected}`);
  lines.push(`- **Actual:** ${step.result.actual}`);
  lines.push(`- **Severity:** ${step.result.severity}`);
  lines.push(`- **URL:** ${step.result.signals.url}`);
  if (step.result.reasons.length) {
    lines.push(`- **Reasons:**`);
    for (const r of step.result.reasons) lines.push(`  - ${r}`);
  }
  lines.push('');

  if (!expand) {
    return lines;
  }

  if (step.stepsToReproduce.length) {
    lines.push('**Reproduction**');
    lines.push('');
    for (const [i, s] of step.stepsToReproduce.entries()) {
      lines.push(`${i + 1}. ${s}`);
    }
    lines.push('');
  }

  if (step.explorerSteps?.length) {
    lines.push('**Explorer / LLM actions**');
    lines.push('');
    for (const [i, s] of step.explorerSteps.entries()) {
      lines.push(`${i + 1}. ${s}`);
    }
    lines.push('');
  }

  const pageErrors = step.result.signals.pageErrors ?? [];
  const consoleErrors = step.result.signals.consoleErrors ?? [];
  if (pageErrors.length) {
    lines.push('**Page errors**');
    lines.push('');
    lines.push('```');
    lines.push(truncate(pageErrors.map((e) => e.message).join('\n'), 2000));
    lines.push('```');
    lines.push('');
  }
  if (consoleErrors.length) {
    lines.push('**Console errors**');
    lines.push('');
    lines.push('```');
    lines.push(
      truncate(
        consoleErrors.map((e) => e.text).join('\n'),
        2000,
      ),
    );
    lines.push('```');
    lines.push('');
  }

  const net = step.result.signals.networkRequests ?? [];
  if (net.length) {
    lines.push('**Network (sample)**');
    lines.push('');
    lines.push('```');
    lines.push(
      truncate(
        net
          .slice(0, 25)
          .map((r) => `${r.method ?? 'GET'} ${r.status ?? '?'} ${r.url ?? ''}`)
          .join('\n'),
        2500,
      ),
    );
    lines.push('```');
    lines.push('');
  }

  lines.push('**Snapshot (interactive excerpt)**');
  lines.push('');
  lines.push('```');
  lines.push(snapshotExcerpt(step, step.result.verdict === 'fail' ? 60 : 30));
  lines.push('```');
  lines.push('');

  return lines;
}

/**
 * Write one presentation REPORT.md (and KOYAL_BUGS.md when product bugs were found).
 * Deletes previous report folders/files under reports/.
 * Returns REPORT.md path and optional KOYAL_BUGS.md path.
 */
export function writeRunReport(
  report: RunReport,
  reportsRoot: string,
): { reportPath: string; bugsPath: string | null } {
  clearPreviousReports(reportsRoot);
  ensureDir(reportsRoot);

  const mdPath = path.join(reportsRoot, 'REPORT.md');
  const body = renderPresentationReport(report, 'Koyal Beta QA — Audio Happy Flow');
  fs.writeFileSync(mdPath, body, 'utf8');

  const productBugs = report.scenarios.flatMap((s) =>
    s.steps
      .filter((step) => step.result.reasons.some((r) => /KOYAL PRODUCT BUG/i.test(r)))
      .map((step) => ({ scenario: s, step })),
  );
  let bugsPath: string | null = null;
  if (productBugs.length) {
    const bugLines: string[] = [
      '# Koyal product bugs (from audio QA)',
      '',
      `_Run \`${report.runId}\` · ${report.finishedAt || report.startedAt}_`,
      '',
      'The QA harness ran successfully and **rejected** the happy-path flow because of the following **Koyal-owned** defects.',
      '',
    ];
    for (const { scenario, step } of productBugs) {
      bugLines.push(`## ${scenario.id} — ${step.workflow}`);
      bugLines.push('');
      bugLines.push(`- **Owner:** Koyal (not the QA harness)`);
      bugLines.push(`- **Severity:** ${step.result.severity}`);
      bugLines.push(`- **Action:** ${step.action}`);
      bugLines.push(`- **Expected:** ${step.expected}`);
      bugLines.push(`- **URL:** ${step.result.signals.url}`);
      bugLines.push(`- **Actual:** ${step.result.actual}`);
      bugLines.push('');
      bugLines.push('### Reasons');
      bugLines.push('');
      for (const r of step.result.reasons) bugLines.push(`- ${r}`);
      bugLines.push('');
      if (step.stepsToReproduce.length) {
        bugLines.push('### Reproduction');
        bugLines.push('');
        step.stepsToReproduce.forEach((s, i) => bugLines.push(`${i + 1}. ${s}`));
        bugLines.push('');
      }
    }
    bugsPath = path.join(reportsRoot, 'KOYAL_BUGS.md');
    fs.writeFileSync(bugsPath, `${bugLines.join('\n')}\n`, 'utf8');
  }

  return { reportPath: mdPath, bugsPath };
}

/** @deprecated no-op kept for call sites */
export function appendReportNotes(_runDir: string): void {}

export function scenarioEvidenceDir(runDir: string, scenarioId: string): string {
  const dir = path.join(runDir, scenarioId);
  ensureDir(dir);
  return dir;
}
