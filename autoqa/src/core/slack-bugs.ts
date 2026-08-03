import type { NetworkRequest, RunReport, TestStep } from './types.js';

/**
 * Post ONLY genuine product bugs found in a run to the Slack bugs channel via an
 * incoming webhook (SLACK_BUGS_WEBHOOK_URL, loaded from login/.env — never hardcoded).
 *
 * Deliberately minimal per the reporting spec: platform, exact page/location,
 * front-end error log, matching backend log, then a three-line explanation.
 * No reproduction dump, passing/needs-review noise, or "harness OK" fluff.
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
const MAX_BACKEND_LOG_CHARS = 2_000;

export interface ProductBugGroup {
  step: TestStep;
  scenarioName: string;
  occurrences: number;
  flows: Set<string>;
}

interface BackendLogMatch {
  text: string;
  href?: string;
}

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
export function productErrorLines(step: TestStep): string[] {
  const sig = step.result.signals;
  if (!sig) return [];
  const lines: string[] = [];
  const visible = `${sig.snapshot.raw}\n${sig.snapshot.interactive}`;
  const visibleError = visible.match(
    /\b(?:video is not edited[^.\n!]*(?:!+)?|something went wrong[^.\n]*(?:\.)?|internal server error[^.\n]*(?:\.)?|(?:failed|unable) to (?:generate|save|create|upload|render|edit|load|close|continue)[^.\n]*(?:\.)?|(?:prompts? data|image|video|scene|asset|character|location|file) (?:is|was) not (?:generated|saved|created|uploaded|rendered|edited|loaded)[^.\n]*(?:\.)?|unexpected error[^.\n]*(?:\.)?|try again later[^.\n]*(?:\.)?|(?:request|operation|generation|processing) (?:was )?(?:aborted|timed out|failed)[^.\n]*(?:\.)?|requested device not found[^.\n]*(?:\.)?)\b/i,
  )?.[0];
  for (const c of sig.consoleErrors ?? []) {
    if (c.text?.trim()) lines.push(`console: ${c.text.trim()}`);
  }
  for (const e of sig.pageErrors ?? []) {
    if (e.message?.trim()) lines.push(`exception: ${e.message.trim()}`);
  }
  for (const n of failedNetworkLines(sig.networkRequests)) lines.push(`network: ${n}`);
  if (visibleError) lines.push(`visible: ${visibleError.trim()}`);
  if (lines.length === 0 && step.result.verdict !== 'pass') {
    const primaryReason = step.result.reasons?.find((reason) => reason.trim());
    if (primaryReason) lines.push(`issue: ${primaryReason.trim()}`);
  }
  // de-dup while preserving order, then cap
  const seen = new Set<string>();
  const deduped = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  return deduped.slice(0, MAX_ERROR_LINES);
}

function isSyntheticDownstreamSkip(step: TestStep): boolean {
  const text = [step.action, step.result.actual, ...step.result.reasons].join('\n');
  return /(?:remaining \d+ milestones? (?:as )?skipped|skipped\s*[—-]\s*not tested because upstream|not tested because (?:an )?upstream|upstream (?:milestone|checkpoint|task).*(?:failed|blocked)|recording remaining \d+ milestone)/i.test(text);
}

/**
 * Reporting is intentionally broader than run failure. A primary unresolved
 * checkpoint is useful production evidence even without a clean console line;
 * a PASS with concrete runtime/network evidence is also worth reporting. The
 * strict `isProductBug` predicate below remains the run-blocker policy.
 */
export function isReportableIssue(step: TestStep): boolean {
  if (isSyntheticDownstreamSkip(step)) return false;
  const lines = productErrorLines(step);
  if (step.result.verdict !== 'pass') return lines.length > 0;
  return lines.some((line) =>
    /^(?:console|exception|network|visible):/i.test(line),
  );
}

export function isProductBug(step: TestStep): boolean {
  if (step.result.verdict === 'pass') return false;
  const lines = productErrorLines(step);
  // Manual task-graph audits deliberately soften a concrete product FAIL to
  // NEEDS REVIEW so independent later checks still run. Reporting happens
  // after the run and must not lose that real visible/backend failure merely
  // because execution continued.
  if (lines.some((line) => line.startsWith('visible:') || line.startsWith('network:'))) return true;
  if (step.result.verdict !== 'fail') return false;
  // Console/page errors can be historical ambient noise in long SPA sessions.
  // Require the verifier to have tied them to this failed checkpoint.
  return (
    lines.length > 0 &&
    step.result.reasons.some((reason) =>
      /\b(?:page error|console error|application failure|product error|uncaught|exception)\b/i.test(reason),
    )
  );
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
  return productErrorLines(step).map(normalizeErrorSignature).sort().join('\n');
}

function shortTitle(step: TestStep): string {
  // Prefer the first real site error as the "what's broken" summary; fall back to
  // the deterministic reason, then the workflow id alone.
  const firstError = productErrorLines(step)[0]?.replace(/^(console|exception|network):\s*/, '');
  const reason = step.result.reasons?.find((r) => r.trim());
  const summary = (firstError ?? reason ?? step.action ?? '').trim();
  const clipped = summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
  return clipped ? `${step.workflow} — ${clipped}` : step.workflow;
}

function formatBug(
  step: TestStep,
  platform: string,
  backendLog?: BackendLogMatch,
  occurrences = 1,
  flowCount = 1,
): string {
  const url = step.result.signals?.url || '—';
  const errors = productErrorLines(step).join('\n');
  const firstError =
    productErrorLines(step)[0]?.replace(/^(console|exception|network):\s*/, '') ??
    'The site emitted an error.';
  const what = shortTitle(step).replace(`${step.workflow} — `, '');
  const backendText = backendLog
    ? `${backendLog.href ? `<${backendLog.href}|Open backend error logs>\n` : ''}\`\`\`${backendLog.text}\`\`\``
    : 'No matching backend record was available.';

  return [
    `*Platform:* ${platform}${occurrences > 1 ? ` · ${occurrences} occurrences across ${flowCount} flow${flowCount === 1 ? '' : 's'}` : ''}`,
    '',
    `*Where bug was found:* ${url.startsWith('http') ? `<${url}|${new URL(url).pathname || '/'}>` : url}`,
    `*Error log:*\n\`\`\`${errors}\`\`\``,
    `*Backend log:*\n${backendText}`,
    '',
    `*What:* ${what}`,
    `*Why:* ${firstError}`,
    `*Impact:* The requested QA action could not complete reliably on this page.`,
  ].join('\n');
}

export function groupedProductBugs(report: RunReport): ProductBugGroup[] {
  const grouped = new Map<string, ProductBugGroup>();
  for (const scenario of report.scenarios) {
    for (const step of scenario.steps) {
      if (!isReportableIssue(step)) continue;
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
  return [...grouped.values()];
}

/**
 * The genuine product bugs in a run — failed milestones carrying real
 * site-emitted error evidence — each formatted with platform, page, front-end
 * error, backend match, and a three-line explanation. Shared so Slack and the
 * per-site summary never disagree about what counts as a product bug.
 */
export function collectProductBugs(report: RunReport, credentialsType: string): string[] {
  void credentialsType;
  let platform = report.baseUrl;
  try {
    platform = new URL(report.baseUrl).hostname;
  } catch {
    // Keep the report's literal platform when it is not a URL.
  }
  return groupedProductBugs(report).map((bug) => formatBug(
    bug.step,
    platform,
    undefined,
    bug.occurrences,
    bug.flows.size,
  ));
}

function backendLogEndpoint(hostname: string): string | undefined {
  const configured = process.env.KOYAL_ADMIN_ERROR_LOGS_URL?.trim();
  if (configured) return configured;
  return /\.koyal\.ai$/i.test(hostname)
    ? `https://${hostname}/v1/api/admin/error-logs?limit=300`
    : undefined;
}

function logCandidates(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => logCandidates(item, depth + 1));
  }
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).join(' ');
  const self = /\b(error|message|stack|status|url|path|project|timestamp|created)\b/i.test(keys)
    ? [record]
    : [];
  return [
    ...self,
    ...Object.values(record).flatMap((item) => logCandidates(item, depth + 1)),
  ];
}

function redactBackendLog(value: string): string {
  return value
    .replace(
      /("(?:password|token|authorization|cookie|secret)"\s*:\s*)"[^"]*"/gi,
      '$1"<redacted>"',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>')
    .slice(0, MAX_BACKEND_LOG_CHARS);
}

function matchingBackendLog(
  payload: unknown,
  step: TestStep,
  endpoint: string,
): BackendLogMatch | undefined {
  const errorText = productErrorLines(step).join(' ').toLowerCase();
  const tokens = [...new Set(
    errorText
      .split(/[^a-z0-9]+/)
      .filter(
        (token) =>
          token.length >= 5 &&
          !['console', 'exception', 'network', 'https', 'error', 'failed'].includes(token),
      ),
  )].slice(0, 30);
  let pagePath = '';
  try {
    pagePath = new URL(step.result.signals.url).pathname.toLowerCase();
  } catch {
    // URL matching is an optional signal.
  }
  const ranked = logCandidates(payload)
    .map((candidate) => {
      const serialized = JSON.stringify(candidate);
      const hay = serialized.toLowerCase();
      const tokenScore = tokens.reduce(
        (score, token) => score + (hay.includes(token) ? 2 : 0),
        0,
      );
      const pathScore = pagePath && hay.includes(pagePath) ? 5 : 0;
      const href = Object.entries(candidate).find(
        ([key, value]) =>
          typeof value === 'string' &&
          /^https?:\/\//i.test(value) &&
          /\b(url|link|href)\b/i.test(key),
      )?.[1] as string | undefined;
      return { serialized, href, score: tokenScore + pathScore };
    })
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best || best.score <= 0) return undefined;
  return {
    text: redactBackendLog(best.serialized),
    href: best.href ?? endpoint,
  };
}

async function fetchBackendLogsForBugs(
  hostname: string,
  bugs: ProductBugGroup[],
): Promise<Array<BackendLogMatch | undefined>> {
  const endpoint = backendLogEndpoint(hostname);
  const token = process.env.KOYAL_ADMIN_TOKEN?.trim();
  if (!endpoint || !token || bugs.length === 0) {
    return bugs.map(() => undefined);
  }
  try {
    const response = await fetch(endpoint, {
      headers: { 'x-admin-token': token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.warn(`[slack] backend-log lookup failed: ${response.status}`);
      return bugs.map(() => undefined);
    }
    const payload: unknown = await response.json();
    return bugs.map((bug) => matchingBackendLog(payload, bug.step, endpoint));
  } catch (error) {
    console.warn(
      `[slack] backend-log lookup unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return bugs.map(() => undefined);
  }
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
  void opts.credentialsType;
  const grouped = groupedProductBugs(opts.report);
  const backendLogs = await fetchBackendLogsForBugs(opts.hostname, grouped);
  const bugs = grouped.map((bug, index) =>
    formatBug(
      bug.step,
      opts.hostname,
      backendLogs[index],
      bug.occurrences,
      bug.flows.size,
    ),
  );

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

  const header = `*AutoQA product bugs* · run \`${opts.report.runId}\` · ${bugs.length} bug${bugs.length === 1 ? '' : 's'}`;
  const body = bugs.join('\n\n────────\n\n');
  const clipped = body.length > 38_000 ? `${body.slice(0, 38_000)}\n… (truncated)` : body;
  const text = `${header}\n\n${clipped}`;

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
