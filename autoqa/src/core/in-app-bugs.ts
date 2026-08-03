import fs from 'node:fs';
import path from 'node:path';
import type { Explorer } from './explorer.js';
import type { AgentBrowser } from './agent-browser.js';
import type { RunReport } from './types.js';
import { fillFieldByHint } from './edits.js';
import {
  groupedProductBugs,
  productErrorLines,
  type ProductBugGroup,
} from './slack-bugs.js';
import { runArtifactsDir } from './evidence.js';

export interface DetectedBugReport {
  workflow: string;
  where: string;
  checkpoint: string;
  issue: string;
  consoleErrors: string[];
  networkErrors: string[];
  status: 'submitted' | 'not-submitted';
  reportingError?: string;
}

export interface InAppBugReportResult {
  found: number;
  submitted: number;
  failures: string[];
  submittedReports: Array<{ workflow: string; description: string }>;
  bugs: DetectedBugReport[];
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>')
    .replace(
      /\b(password|token|authorization|cookie|secret|api[ -]?key)\b\s*[:=]\s*\S+/gi,
      '$1: <redacted>',
    )
    .slice(0, 6000);
}

function likelyCause(bug: ProductBugGroup): string {
  const text = productErrorLines(bug.step).join(' ');
  if (/s3|json|unexpected token|doctype/i.test(text)) {
    return 'The application received an invalid or unavailable generated-media response and could not parse or load it.';
  }
  if (/5\d\d|internal server/i.test(text)) {
    return 'The application backend returned a server error after the requested action was submitted.';
  }
  if (/try again later|not edited|failed to/i.test(text)) {
    return 'The application rejected the submitted operation after AutoQA reached the correct feature state.';
  }
  return 'The application emitted concrete runtime error evidence after the requested action.';
}

export function inAppBugDescription(bug: ProductBugGroup, runId: string): string {
  const evidence = bugReportEvidence(bug);
  return redact(
    [
      'AutoQA issue report',
      `Issue: ${evidence.issue}`,
      '',
      'Console / exceptions:',
      ...(evidence.consoleErrors.length ? evidence.consoleErrors : ['None captured for this checkpoint.']),
      '',
      'Network:',
      ...(evidence.networkErrors.length ? evidence.networkErrors : ['None captured for this checkpoint.']),
      '',
      `Likely cause: ${likelyCause(bug)}`,
      `Impact: ${bug.step.action}`,
      `Occurrences in this run: ${bug.occurrences}`,
      `Run: ${runId}`,
      '',
      `Where: ${evidence.where} — ${evidence.workflow}`,
    ].join('\n'),
  );
}

function bugReportEvidence(bug: ProductBugGroup): Omit<DetectedBugReport, 'status'> {
  const lines = productErrorLines(bug.step);
  const consoleLines = lines
    .filter((line) => /^(?:console|exception):/i.test(line))
    .map((line) => line.replace(/^(?:console|exception):\s*/i, ''));
  const networkLines = lines
    .filter((line) => /^network:/i.test(line))
    .map((line) => line.replace(/^network:\s*/i, ''));
  const issueLines = lines
    .filter((line) => /^(?:visible|issue):/i.test(line))
    .map((line) => line.replace(/^(?:visible|issue):\s*/i, ''));
  const issue = issueLines[0] ?? consoleLines[0] ?? networkLines[0] ?? bug.step.result.actual;
  return {
    workflow: bug.step.workflow,
    where: bug.step.result.signals.url,
    checkpoint: bug.step.action,
    issue: redact(issue),
    consoleErrors: consoleLines.map(redact),
    networkErrors: networkLines.map(redact),
  };
}

function fenced(lines: string[]): string {
  return lines.length ? `\`\`\`text\n${lines.join('\n')}\n\`\`\`` : '_None captured for this checkpoint._';
}

export function renderBugsReportedMarkdown(report: RunReport, result: InAppBugReportResult): string {
  const lines = [
    `# Bugs Reported — ${report.baseUrl}`,
    '',
    `**Run ID:** \`${report.runId}\``,
    `**Detected:** ${result.found}`,
    `**Submitted through Report a Bug:** ${result.submitted}`,
    '',
  ];
  if (result.bugs.length === 0) {
    lines.push('No reportable product bugs were detected in this run.', '');
  }
  result.bugs.forEach((bug, index) => {
    lines.push(
      `## ${index + 1}. ${bug.workflow}`,
      '',
      `**Reporting status:** ${bug.status === 'submitted' ? 'SUBMITTED' : 'NOT SUBMITTED'}`,
      `**Where:** ${bug.where}`,
      `**Checkpoint:** ${bug.checkpoint}`,
      `**Issue:** ${bug.issue}`,
      '',
      '### Console errors and page exceptions',
      '',
      fenced(bug.consoleErrors),
      '',
      '### Network errors',
      '',
      fenced(bug.networkErrors),
      '',
    );
    if (bug.reportingError) lines.push(`**Reporting error:** ${bug.reportingError}`, '');
  });
  return `${lines.join('\n')}\n`;
}

function writeReportingEvidence(runDir: string, report: RunReport, result: InAppBugReportResult): void {
  try {
    const artifactsDir = runArtifactsDir(runDir);
    fs.writeFileSync(
      path.join(artifactsDir, 'in-app-bug-reporting.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(runDir, 'bugs-reported.md'),
      renderBugsReportedMarkdown(report, result),
      'utf8',
    );
  } catch {
    // Evidence logging is best-effort and cannot alter the QA result.
  }
}

function reportGoal(): string {
  return [
    'Open the visible in-app "Report a Bug" control and stop as soon as its report form/modal is visible.',
    'Do not fill or submit the form, do not repeat the failed product action, and do not use any unrelated control.',
    'If the control is unavailable, fail safely.',
  ].join('\n');
}

function reportFormVisible(browser: AgentBrowser): boolean {
  const snapshot = `${browser.snapshotInteractive()}\n${browser.snapshotFull()}`;
  return (
    /\bReport a Bug\b/i.test(snapshot) &&
    /\b(?:Please describe the bug|Bug Description)\b/i.test(snapshot) &&
    /\bSubmit Report\b/i.test(snapshot)
  );
}

/**
 * The Koyal launcher is often an icon-only fixed button. A hosted Chromium
 * trusted click can report success without reaching the live document, while
 * Explorer then blacklists the only correct control. Prefer explicit labels,
 * then activate one uniquely identifiable fixed bug-icon launcher in-page and
 * prove the form appeared after every attempt.
 */
export function openKoyalBugReportForm(browser: AgentBrowser): boolean {
  if (reportFormVisible(browser)) return true;
  const verify = (): boolean => {
    browser.wait(500);
    return reportFormVisible(browser);
  };

  if (browser.clickButtonByText('Report a Bug', true) && verify()) return true;
  if (browser.clickByText('Report a Bug') && verify()) return true;

  const result = browser.evalScript(`
    (function() {
      const visible = (el) =>
        (el.offsetParent !== null || el.getClientRects().length) &&
        !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      const controls = [...document.querySelectorAll('button,[role=button],[onclick]')]
        .filter(visible);
      const labeled = controls.find((el) => {
        const label = [
          el.textContent,
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('data-testid'),
          el.getAttribute('class'),
          el.querySelector('svg')?.getAttribute('data-lucide'),
          el.querySelector('svg')?.getAttribute('aria-label'),
        ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').toLowerCase();
        return /(?:report.{0,12}bug|bug.{0,12}report|bug-icon|bugbutton)/.test(label);
      });
      const fixedIconButtons = controls.filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const nearBottomRight =
          rect.right >= innerWidth - 180 && rect.bottom >= innerHeight - 180;
        return style.position === 'fixed' && nearBottomRight &&
          rect.width >= 32 && rect.width <= 120 && rect.height >= 32 && rect.height <= 120 &&
          Boolean(el.querySelector('svg,img'));
      });
      const target = labeled || (fixedIconButtons.length === 1 ? fixedIconButtons[0] : null);
      if (!target) return 'NO_UNIQUE_REPORT_CONTROL';
      target.scrollIntoView({block: 'center'});
      target.click();
      return 'CLICKED_REPORT_CONTROL';
    })();
  `);
  return result.includes('CLICKED_REPORT_CONTROL') && verify();
}

/**
 * File verified Koyal product errors through its own Report-a-Bug UI. This runs
 * after report finalization, so navigation/reporting failures cannot alter QA
 * verdicts or cause the product action to be repeated.
 */
export async function reportKoyalBugsInApp(opts: {
  report: RunReport;
  hostname: string;
  runDir: string;
  browser: AgentBrowser;
  explorer: Explorer;
}): Promise<InAppBugReportResult> {
  const bugs = groupedProductBugs(opts.report);
  const result: InAppBugReportResult = {
    found: bugs.length,
    submitted: 0,
    failures: [],
    submittedReports: [],
    bugs: bugs.map((bug) => ({ ...bugReportEvidence(bug), status: 'not-submitted' })),
  };
  if (bugs.length === 0) {
    writeReportingEvidence(opts.runDir, opts.report, result);
    return result;
  }
  if (!/\.?koyal\.ai$/i.test(opts.hostname)) {
    result.failures.push('in-app product reporting is currently available only on Koyal properties');
    writeReportingEvidence(opts.runDir, opts.report, result);
    return result;
  }

  for (const [bugIndex, bug] of bugs.entries()) {
    try {
      const url = bug.step.result.signals.url;
      if (url.startsWith('http')) {
        opts.browser.open(url);
        opts.browser.wait(1200);
      }
      let formOpen = openKoyalBugReportForm(opts.browser);
      if (!formOpen) {
        const attempt = await opts.explorer.achieveGoal(reportGoal(), {
          maxSteps: 2,
          visionFirst: true,
          manualMode: true,
        });
        formOpen = attempt.success && reportFormVisible(opts.browser);
        if (!formOpen) {
          const failure = `${bug.step.workflow}: ${attempt.error ?? 'report form was not visibly opened'}`;
          result.failures.push(failure);
          result.bugs[bugIndex].reportingError = failure;
          continue;
        }
      }
      const description = inAppBugDescription(bug, opts.report.runId);
      const filled =
        fillFieldByHint(opts.browser, 'Please describe the bug', description).ok ||
        fillFieldByHint(opts.browser, 'Bug Description', description).ok ||
        fillFieldByHint(opts.browser, 'Description', description).ok;
      if (!filled) {
        const failure = `${bug.step.workflow}: report description field was not fillable`;
        result.failures.push(failure);
        result.bugs[bugIndex].reportingError = failure;
        continue;
      }
      if (!opts.browser.clickButtonByText('Submit Report', true)) {
        const failure = `${bug.step.workflow}: Submit Report was not available`;
        result.failures.push(failure);
        result.bugs[bugIndex].reportingError = failure;
        continue;
      }
      let confirmed = false;
      for (let poll = 0; poll < 12; poll++) {
        opts.browser.wait(poll === 0 ? 1000 : 750);
        const confirmation = `${opts.browser.snapshotInteractive()}\n${opts.browser.snapshotFull()}`;
        if (/\b(?:submitted successfully|report submitted|thank you for your feedback)\b/i.test(confirmation)) {
          confirmed = true;
          break;
        }
      }
      if (!confirmed) {
        const failure = `${bug.step.workflow}: submission confirmation was not visible`;
        result.failures.push(failure);
        result.bugs[bugIndex].reportingError = failure;
        continue;
      }
      result.submitted++;
      result.bugs[bugIndex].status = 'submitted';
      result.submittedReports.push({
        workflow: bug.step.workflow,
        description,
      });
    } catch (error) {
      const failure = `${bug.step.workflow}: ${error instanceof Error ? error.message : String(error)}`;
      result.failures.push(failure);
      result.bugs[bugIndex].reportingError = failure;
    }
  }

  writeReportingEvidence(opts.runDir, opts.report, result);
  console.log(
    `[bugs] in-app reporting: ${result.submitted}/${result.found} submitted` +
      (result.failures.length ? ` (${result.failures.length} safely skipped/failed)` : ''),
  );
  return result;
}
