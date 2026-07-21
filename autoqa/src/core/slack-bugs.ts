import type { NetworkRequest, RunReport, TestStep } from './types.js';

/**
 * Post ONLY genuine product bugs found in a run to the Slack bugs channel via an
 * incoming webhook (SLACK_BUGS_WEBHOOK_URL, loaded from login/.env — never hardcoded).
 *
 * Deliberately minimal per the reporting spec: for each product bug, exactly four
 * fields — Bug / Inputs / Reproduction / Error log — and NOTHING else. No
 * "harness OK" fluff, no full-report dump, no passing/needs-review noise. If a
 * run finds zero product bugs, this posts nothing at all (silence, not an
 * all-clear message).
 *
 * What counts as a "product bug" (vs. a test-harness/probe artifact): a milestone
 * that FAILED *and* carries real site-emitted error evidence — a browser console
 * error, an uncaught JS exception, a 5xx response, or a 4xx on an /api/ call. That
 * filter is exactly what separates "the site itself threw an error" (e.g. Koyal's
 * S3 scene-generation `Failed to fetch JSON from S3`) from nav-state-loss probes,
 * marker-verification gaps, and other verdict disagreements that have no
 * site-error lines to show. It also means the "Error log" field is never empty.
 */

const MAX_ERROR_LINES = 12;
const MAX_REPRO_STEPS = 12;

function failedNetworkLines(requests: NetworkRequest[] | undefined): string[] {
  if (!requests) return [];
  const out: string[] = [];
  for (const r of requests) {
    const status = typeof r.status === 'number' ? r.status : undefined;
    if (status === undefined) continue;
    const isServerError = status >= 500 && status < 600;
    const isApiClientError = status >= 400 && status < 500 && /\/api\//i.test(r.url ?? '');
    if (isServerError || isApiClientError) {
      out.push(`${r.method ?? 'GET'} ${r.url ?? '(unknown url)'} → ${status}${r.statusText ? ` ${r.statusText}` : ''}`);
    }
  }
  return out;
}

/** The concrete console/exception/network error lines the SITE emitted for this step. */
function errorLines(step: TestStep): string[] {
  const sig = step.result.signals;
  if (!sig) return [];
  const lines: string[] = [];
  for (const c of sig.consoleErrors ?? []) if (c.text?.trim()) lines.push(`console: ${c.text.trim()}`);
  for (const e of sig.pageErrors ?? []) if (e.message?.trim()) lines.push(`exception: ${e.message.trim()}`);
  for (const n of failedNetworkLines(sig.networkRequests)) lines.push(`network: ${n}`);
  // de-dup while preserving order, then cap
  const seen = new Set<string>();
  const deduped = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  return deduped.slice(0, MAX_ERROR_LINES);
}

function isProductBug(step: TestStep): boolean {
  return step.result.verdict === 'fail' && errorLines(step).length > 0;
}

function normalizeErrorSignature(line: string): string {
  return line
    .toLowerCase()
    .replace(/https?:\/\/[^\s)]+/g, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return url;
      }
    })
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<id>')
    .replace(/:\d+:\d+\b/g, ':<line>:<column>')
    .replace(/\s+/g, ' ')
    .trim();
}

function bugSignature(step: TestStep): string {
  return errorLines(step).map(normalizeErrorSignature).sort().join('\n');
}

function shortTitle(step: TestStep): string {
  // Prefer the first real site error as the "what's broken" summary; fall back to
  // the deterministic reason, then the workflow id alone.
  const firstError = errorLines(step)[0]?.replace(/^(console|exception|network):\s*/, '');
  const reason = step.result.reasons?.find((r) => r.trim());
  const summary = (firstError ?? reason ?? step.action ?? '').trim();
  const clipped = summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
  return clipped ? `${step.workflow} — ${clipped}` : step.workflow;
}

function detectFileType(step: TestStep): string {
  const hay = [step.action, ...(step.stepsToReproduce ?? [])].join(' ');
  const m = hay.match(/\.(pdf|wav|mp3|png|jpe?g|txt|mp4|mov|csv|json)\b/i);
  return m ? m[1].toLowerCase() : '—';
}

function detectPlan(step: TestStep): string {
  const hay = [step.action, ...(step.stepsToReproduce ?? [])].join(' ');
  const m = hay.match(/\b(standard|pro|free|premium|enterprise|basic)\b\s*(plan)?/i);
  return m ? m[1].replace(/^\w/, (c) => c.toUpperCase()) : '—';
}

function formatBug(
  step: TestStep,
  scenarioName: string,
  credentialsType: string,
  occurrences = 1,
  flowCount = 1,
): string {
  const url = step.result.signals?.url || '—';
  const repro = (step.stepsToReproduce ?? [])
    .slice(0, MAX_REPRO_STEPS)
    .map((s, i) => `  ${i + 1}. ${s.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  const errors = errorLines(step)
    .map((l) => `  ${l}`)
    .join('\n');

  return [
    `Bug — ${shortTitle(step)}${occurrences > 1 ? ` (${occurrences} occurrences across ${flowCount} flow${flowCount === 1 ? '' : 's'})` : ''}`,
    `Inputs — file: ${detectFileType(step)} · plan: ${detectPlan(step)} · credentials: ${credentialsType} · url: ${url}`,
    `Reproduction —\n${repro || '  (no steps recorded)'}`,
    `Error log —\n${errors}`,
  ].join('\n');
}

/**
 * The genuine product bugs in a run — failed milestones carrying real
 * site-emitted error evidence — each formatted as the Bug/Inputs/Reproduction/
 * Error-log block used for both Slack and the per-site summary. Shared so the two
 * surfaces never disagree about what counts as a product bug.
 */
export function collectProductBugs(report: RunReport, credentialsType: string): string[] {
  const grouped = new Map<string, {
    step: TestStep;
    scenarioName: string;
    occurrences: number;
    flows: Set<string>;
  }>();
  for (const scenario of report.scenarios) {
    for (const step of scenario.steps) {
      if (!isProductBug(step)) continue;
      const signature = bugSignature(step);
      const existing = grouped.get(signature);
      if (existing) {
        existing.occurrences++;
        existing.flows.add(scenario.id);
      } else {
        grouped.set(signature, {
          step,
          scenarioName: scenario.name,
          occurrences: 1,
          flows: new Set([scenario.id]),
        });
      }
    }
  }
  return [...grouped.values()].map((bug) => formatBug(
    bug.step,
    bug.scenarioName,
    credentialsType,
    bug.occurrences,
    bug.flows.size,
  ));
}

export interface SlackBugReport {
  posted: boolean;
  bugCount: number;
}

/**
 * Filter a finished run's report to genuine product bugs and post them to Slack.
 * Never throws — a notify failure must not affect the run's exit path.
 */
export async function notifyKoyalBugsToSlack(opts: {
  report: RunReport;
  hostname: string;
  credentialsType: string;
}): Promise<SlackBugReport> {
  const url = process.env.SLACK_BUGS_WEBHOOK_URL?.trim();

  const bugs = collectProductBugs(opts.report, opts.credentialsType);

  if (bugs.length === 0) {
    // No product bugs → post nothing (no all-clear/fluff, per spec).
    return { posted: false, bugCount: 0 };
  }

  if (!url) {
    console.log(
      `[slack] ${bugs.length} product bug(s) found but SLACK_BUGS_WEBHOOK_URL not set — not posting`,
    );
    return { posted: false, bugCount: bugs.length };
  }

  const header = `*autoqa* · ${opts.hostname} · run \`${opts.report.runId}\` · ${bugs.length} product bug(s)`;
  const body = bugs.join('\n\n────────\n\n');
  const clipped = body.length > 38_000 ? `${body.slice(0, 38_000)}\n… (truncated)` : body;
  const text = `${header}\n\`\`\`\n${clipped}\n\`\`\``;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const t = await res.text();
    if (!res.ok || t !== 'ok') {
      console.warn(`[slack] notify failed: ${res.status} ${t}`);
      return { posted: false, bugCount: bugs.length };
    }
    console.log(`[slack] posted ${bugs.length} product bug(s) to bugs channel`);
    return { posted: true, bugCount: bugs.length };
  } catch (err) {
    console.warn(`[slack] notify error: ${err instanceof Error ? err.message : String(err)}`);
    return { posted: false, bugCount: bugs.length };
  }
}
