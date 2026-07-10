import { config } from '../config.js';
import type { AgentBrowser } from './agent-browser.js';
import type {
  ConsoleMessage,
  NetworkRequest,
  PageError,
  Severity,
  SignalBundle,
  VerificationExpectation,
  VerificationResult,
  Verdict,
} from './types.js';

const RAW_ERROR_PATTERNS: RegExp[] = [
  /\bstack trace\b/i,
  /\bat\s+\S+\s+\(/i,
  /SyntaxError:/i,
  /TypeError:/i,
  /UnhandledPromiseRejection/i,
  /Internal Server Error/i,
  // NOT `/\b500\b.*error/i` — too loose: matches any page that merely
  // *documents* a possible 500 response (REST API docs, Swagger UI, a
  // status-codes practice page) as if it were an actual crash dump. A real
  // server error already trips `Internal Server Error` or the stack-trace
  // patterns above; this standalone pairing added false positives, not
  // meaningfully more true positives.
  /ECONNREFUSED/i,
  /NetworkError/i,
  /Unexpected token/i,
  /Cannot read propert/i,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNetworkRequests(raw: unknown): NetworkRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === 'object' && item !== null) return item as NetworkRequest;
    return { url: String(item) };
  });
}

function extractConsoleErrors(messages: ConsoleMessage[]): ConsoleMessage[] {
  return messages.filter((m) => m.type.toLowerCase() === 'error');
}

function snapshotText(bundle: SignalBundle): string {
  return `${bundle.snapshot.raw}\n${bundle.snapshot.interactive}`;
}

function includesPattern(text: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) return pattern.test(text);
  return text.toLowerCase().includes(pattern.toLowerCase());
}

function findUglyErrors(snapshot: string, patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const pattern of patterns) {
    if (pattern.test(snapshot)) {
      hits.push(pattern.source);
    }
  }
  return hits;
}

function isBlankScreen(snapshot: string): boolean {
  const trimmed = snapshot.trim();
  if (!trimmed) return true;
  const hasChildNodes = /\n\s+-\s/.test(trimmed) || /\[ref=e\d+\]/.test(trimmed);
  return !hasChildNodes;
}

function networkStatusSummary(requests: NetworkRequest[]): string {
  if (requests.length === 0) return 'no captured requests';
  return requests
    .map((r) => {
      const status = r.status ?? '?';
      const method = r.method ?? 'GET';
      const url = r.url ?? JSON.stringify(r);
      return `${method} ${url} → ${status}`;
    })
    .join('; ');
}

function inferSeverity(reasons: string[], verdict: Verdict): Severity {
  if (verdict === 'needs-review') return 'medium';
  const joined = reasons.join(' ').toLowerCase();
  if (joined.includes('exceeded') && joined.includes('wait')) return 'high';
  if (joined.includes('uncaught') || joined.includes('white screen') || joined.includes('500')) {
    return 'critical';
  }
  if (joined.includes('login') || joined.includes('auth') || joined.includes('dashboard')) {
    return 'high';
  }
  if (joined.includes('console error') || joined.includes('network')) {
    return 'medium';
  }
  return 'low';
}

export class VerificationLayer {
  constructor(private readonly browser: AgentBrowser) {}

  async captureSignals(networkFilter?: string): Promise<SignalBundle> {
    const errorsResp = this.browser.errorsJson();
    const consoleResp = this.browser.consoleJson();
    const networkResp = this.browser.networkRequestsJson(networkFilter);

    const pageErrors: PageError[] = (errorsResp.data?.errors ?? []).map((e) => ({
      message: e.message ?? String(e),
      stack: e.stack,
    }));

    const consoleMessages: ConsoleMessage[] = consoleResp.data?.messages ?? [];
    const consoleErrors = extractConsoleErrors(consoleMessages);
    const networkRequests = normalizeNetworkRequests(networkResp.data?.requests);

    return {
      url: this.browser.getUrl(),
      title: this.browser.getTitle(),
      snapshot: {
        raw: this.browser.snapshotFull(),
        interactive: this.browser.snapshotInteractive(),
      },
      pageErrors,
      consoleMessages,
      consoleErrors,
      networkRequests,
      errorsCaptureOk: errorsResp.success !== false,
      consoleCaptureOk: consoleResp.success !== false,
    };
  }

  evaluateSignals(
    signals: SignalBundle,
    expectation: VerificationExpectation,
  ): { verdict: Verdict; reasons: string[]; ambiguous: boolean } {
    const reasons: string[] = [];
    let passSignals = 0;
    let failSignals = 0;
    let ambiguous = false;
    const snap = snapshotText(signals);

    if (!expectation.allowPageErrors && signals.pageErrors.length > 0) {
      failSignals++;
      reasons.push(
        `Uncaught JS exceptions: ${signals.pageErrors.map((e) => e.message).join(' | ')}`,
      );
    } else if (signals.pageErrors.length === 0 && signals.errorsCaptureOk !== false) {
      passSignals++;
    } else if (signals.errorsCaptureOk === false) {
      // capture subprocess failed — "no errors" is unobservable, not a pass
      ambiguous = true;
      reasons.push('Could not capture page errors (agent-browser errors command failed)');
    }

    const disallowedConsoleErrors = signals.consoleErrors.filter((msg) => {
      if (expectation.allowedConsoleErrorPatterns?.some((p) => p.test(msg.text))) return false;
      return true;
    });

    if (!expectation.allowConsoleErrors && disallowedConsoleErrors.length > 0) {
      failSignals++;
      reasons.push(
        `Console errors: ${disallowedConsoleErrors.map((m) => m.text).join(' | ')}`,
      );
    } else if (disallowedConsoleErrors.length === 0 && signals.consoleCaptureOk !== false) {
      passSignals++;
    } else if (signals.consoleCaptureOk === false) {
      ambiguous = true;
      reasons.push('Could not capture console (agent-browser console command failed)');
    }

    if (isBlankScreen(snap)) {
      failSignals++;
      reasons.push('Blank or empty page snapshot (possible white screen)');
    } else {
      passSignals++;
    }

    const uglyPatterns = expectation.uglyErrorPatterns ?? RAW_ERROR_PATTERNS;
    const uglyHits = findUglyErrors(snap, uglyPatterns);
    if (uglyHits.length > 0) {
      failSignals++;
      reasons.push(`Raw/ugly error text visible: ${uglyHits.join(', ')}`);
    }

    if (expectation.urlIncludes) {
      if (includesPattern(signals.url, expectation.urlIncludes)) {
        passSignals++;
      } else {
        failSignals++;
        reasons.push(
          `URL mismatch: expected "${String(expectation.urlIncludes)}", got "${signals.url}"`,
        );
      }
    }

    if (expectation.urlExcludes) {
      if (!includesPattern(signals.url, expectation.urlExcludes)) {
        passSignals++;
      } else {
        failSignals++;
        reasons.push(`URL should not match "${String(expectation.urlExcludes)}", got "${signals.url}"`);
      }
    }

    for (const text of expectation.snapshotIncludes ?? []) {
      if (includesPattern(snap, text)) {
        passSignals++;
      } else {
        failSignals++;
        reasons.push(`Expected snapshot to include "${String(text)}"`);
      }
    }

    if (expectation.snapshotIncludesAny?.length) {
      const anyHit = expectation.snapshotIncludesAny.some((text) => includesPattern(snap, text));
      if (anyHit) {
        passSignals++;
      } else {
        failSignals++;
        reasons.push(
          `Expected snapshot to include one of: ${expectation.snapshotIncludesAny.map((t) => `"${String(t)}"`).join(', ')}`,
        );
      }
    }

    for (const text of expectation.snapshotExcludes ?? []) {
      if (!includesPattern(snap, text)) {
        passSignals++;
      } else {
        failSignals++;
        reasons.push(`Snapshot should not include "${String(text)}"`);
      }
    }

    if (expectation.requireNetworkActivity || expectation.expectedNetworkStatuses) {
      if (signals.networkRequests.length === 0) {
        if (expectation.requireNetworkActivity) {
          ambiguous = true;
          reasons.push(
            'No network requests captured (agent-browser may not be logging requests in this build — falling back to DOM/console signals)',
          );
        }
      } else if (expectation.expectedNetworkStatuses) {
        const statuses = signals.networkRequests.map((r) => r.status).filter(Boolean) as number[];
        const expected = expectation.expectedNetworkStatuses;
        const anyMatch = statuses.some((s) => expected.includes(s));
        if (anyMatch) {
          passSignals++;
        } else {
          failSignals++;
          reasons.push(
            `Network status mismatch: expected one of [${expected.join(', ')}], got [${statuses.join(', ')}] (${networkStatusSummary(signals.networkRequests)})`,
          );
        }
      }
    }

    if (expectation.maxUnexpectedNetwork5xx !== undefined) {
      const bad = signals.networkRequests.filter((r) => {
        const status = r.status ?? 0;
        const url = r.url ?? '';
        if (status < 500) return false;
        if (config.ignored5xxHostsPattern.test(url)) return false;
        return true;
      });
      if (bad.length > expectation.maxUnexpectedNetwork5xx) {
        failSignals++;
        reasons.push(
          `Unexpected 5xx responses: ${bad.map((r) => `${r.url} → ${r.status}`).join('; ')}`,
        );
      } else {
        passSignals++;
      }
    }

    let verdict: Verdict;
    if (failSignals > 0) {
      verdict = 'fail';
    } else if (ambiguous && passSignals === 0) {
      verdict = 'needs-review';
    } else if (ambiguous) {
      verdict = 'needs-review';
    } else if (passSignals > 0) {
      verdict = 'pass';
    } else {
      verdict = 'needs-review';
      reasons.push('No clear pass/fail signals within wait window');
    }

    return { verdict, reasons, ambiguous };
  }

  buildActualSummary(signals: SignalBundle): string {
    const parts = [
      `URL: ${signals.url}`,
      `Title: ${signals.title}`,
      `Page errors: ${signals.pageErrors.length}`,
      `Console errors: ${signals.consoleErrors.length}`,
      `Network: ${networkStatusSummary(signals.networkRequests)}`,
    ];

    const visibleErrors = signals.snapshot.raw.match(
      /invalid|incorrect|error|failed|required|not found|denied|success|saved|created|deleted|updated/i,
    );
    if (visibleErrors) {
      parts.push(`Visible messages: ${visibleErrors.join(', ')}`);
    }

    return parts.join(' | ');
  }

  async verifyAfterAction(
    expectation: VerificationExpectation,
    options: { maxWaitMs?: number; pollMs?: number } = {},
  ): Promise<VerificationResult> {
    const maxWaitMs = options.maxWaitMs ?? config.verificationMaxWaitMs;
    const pollMs = options.pollMs ?? config.verificationPollMs;
    const deadline = Date.now() + maxWaitMs;

    let lastSignals = await this.captureSignals(expectation.networkFilter);
    let lastEvaluation = this.evaluateSignals(lastSignals, expectation);
    let retried = false;

    while (Date.now() < deadline) {
      if (lastEvaluation.verdict === 'fail') {
        return {
          verdict: 'fail',
          severity: inferSeverity(lastEvaluation.reasons, 'fail'),
          expected: expectation.description,
          actual: this.buildActualSummary(lastSignals),
          signals: lastSignals,
          reasons: lastEvaluation.reasons,
          retried,
        };
      }
      if (lastEvaluation.verdict === 'pass') {
        // Confirmation hold: async failures (e.g. an S3 fetch that returns HTML
        // and throws a console error a beat after render) can surface right after
        // an initial pass. Re-check once after a short settle before trusting it —
        // bounded so we don't wait the full window on every passing step.
        const holdMs = Math.min(pollMs, 2500);
        if (Date.now() + holdMs <= deadline) {
          await sleep(holdMs);
          retried = true;
          const confirm = await this.captureSignals(expectation.networkFilter);
          const confirmEval = this.evaluateSignals(confirm, expectation);
          if (confirmEval.verdict === 'fail') {
            return {
              verdict: 'fail',
              severity: inferSeverity(confirmEval.reasons, 'fail'),
              expected: expectation.description,
              actual: this.buildActualSummary(confirm),
              signals: confirm,
              reasons: confirmEval.reasons,
              retried,
            };
          }
        }
        return {
          verdict: 'pass',
          severity: inferSeverity(lastEvaluation.reasons, 'pass'),
          expected: expectation.description,
          actual: this.buildActualSummary(lastSignals),
          signals: lastSignals,
          reasons: lastEvaluation.reasons,
          retried,
        };
      }

      await sleep(pollMs);
      retried = true;
      lastSignals = await this.captureSignals(expectation.networkFilter);
      lastEvaluation = this.evaluateSignals(lastSignals, expectation);
    }

    const timeoutReasons = [
      `Exceeded ${maxWaitMs / 1000}s wait without a clear pass signal`,
      ...lastEvaluation.reasons,
    ];

    return {
      verdict: 'fail',
      severity: inferSeverity(timeoutReasons, 'fail'),
      expected: expectation.description,
      actual: this.buildActualSummary(lastSignals),
      signals: lastSignals,
      reasons: timeoutReasons,
      retried,
    };
  }
}
