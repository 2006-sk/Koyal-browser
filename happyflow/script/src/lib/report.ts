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

function isProductBug(step: TestStep): boolean {
  const reasons = step.result.reasons.join(' ').toLowerCase();
  if (reasons.includes('product_bug')) return true;
  if (step.result.verdict !== 'fail') return false;
  if (reasons.includes('exceeded') && reasons.includes('wait')) return true;
  if (reasons.includes('uncaught') || reasons.includes('white screen')) return true;
  if (/\b5\d\d\b/.test(reasons) || reasons.includes('something went wrong')) return true;
  if (step.result.severity === 'critical' || step.result.severity === 'high') {
    if (!reasons.includes('harness') && !reasons.includes('agent-browser timed out')) return true;
  }
  return false;
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

function renderStepDetail(scenarioId: string, step: TestStep, expand: boolean): string[] {
  const lines: string[] = [];
  const v = verdictLabel(step.result.verdict);
  const bugTag = step.result.verdict === 'fail' && isProductBug(step) ? ' · PRODUCT BUG' : '';
  lines.push(`### ${scenarioId} · ${step.workflow} — ${v}${bugTag}`);
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

  if (!expand) return lines;

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
    lines.push(truncate(consoleErrors.map((e) => e.text).join('\n'), 2000));
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

export function renderPresentationReport(report: RunReport, title: string): string {
  const counts = summarizeCounts(report.scenarios);
  const allSteps = report.scenarios.flatMap((s) =>
    s.steps.map((step) => ({ scenario: s, step })),
  );
  const fails = allSteps.filter((x) => x.step.result.verdict === 'fail');
  const reviews = allSteps.filter((x) => x.step.result.verdict === 'needs-review');
  const productBugs = fails.filter((x) => isProductBug(x.step));
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

  if (productBugs.length) {
    lines.push('## Product bugs (Koyal)');
    lines.push('');
    for (const { step } of productBugs) {
      const headline =
        step.result.reasons.find((r) => /PRODUCT_BUG/i.test(r)) ??
        step.result.reasons[0] ??
        step.expected;
      lines.push(`- **${step.workflow}** (${step.result.severity}): ${headline}`);
    }
    lines.push('');
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
    lines.push(...renderStepDetail(scenario.id, step, step.result.verdict !== 'pass'));
  }

  lines.push('---');
  lines.push('');
  lines.push('_Single-file presentation report. Per-step artifact folders are not kept._');
  lines.push('');

  return lines.join('\n');
}

/** Write one REPORT.md (+ KOYAL_BUGS.md for product bugs). Returns paths. */
export function writeRunReport(
  report: RunReport,
  reportsRoot: string,
): { reportPath: string; bugsPath: string | null } {
  clearPreviousReports(reportsRoot);
  ensureDir(reportsRoot);
  const mdPath = path.join(reportsRoot, 'REPORT.md');
  fs.writeFileSync(
    mdPath,
    renderPresentationReport(report, 'Koyal Beta QA — Script Happy Flow'),
    'utf8',
  );

  const productBugs = report.scenarios.flatMap((s) =>
    s.steps
      .filter(
        (step) =>
          step.result.verdict === 'fail' &&
          (isProductBug(step) ||
            step.result.reasons.some((r) => /PRODUCT_BUG|KOYAL PRODUCT BUG/i.test(r))),
      )
      .map((step) => ({ scenario: s, step })),
  );

  let bugsPath: string | null = null;
  if (productBugs.length) {
    const bugLines: string[] = [
      '# Koyal product bugs (from script QA)',
      '',
      `_Run \`${report.runId}\` · ${report.finishedAt || report.startedAt}_`,
      '',
    ];
    for (const { scenario, step } of productBugs) {
      bugLines.push(`## ${scenario.id} — ${step.workflow}`);
      bugLines.push('');
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

/** @deprecated */
export function appendReportNotes(_runDir: string): void {}

export function scenarioEvidenceDir(runDir: string, scenarioId: string): string {
  const dir = path.join(runDir, scenarioId);
  ensureDir(dir);
  return dir;
}
