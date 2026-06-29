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

const DEFAULT_WAIT_MS = 2000;
const RETRY_WAIT_MS = 3000;

const RAW_ERROR_PATTERNS: RegExp[] = [
  /\bstack trace\b/i,
  /\bat\s+\S+\s+\(/i,
  /SyntaxError:/i,
  /TypeError:/i,
  /UnhandledPromiseRejection/i,
  /Internal Server Error/i,
  /\b500\b.*error/i,
  /ECONNREFUSED/i,
  /NetworkError/i,
  /Unexpected token/i,
  /Cannot read propert/i,
];

const BLANK_SCREEN_PATTERNS: RegExp[] = [
  /^- document:\s*$/m,
  /^- document:\s*\n\s*$/m,
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
  // Snapshots always start with "- document:" — only blank if there are no child nodes
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
    } else if (signals.pageErrors.length === 0) {
      passSignals++;
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
    } else if (disallowedConsoleErrors.length === 0) {
      passSignals++;
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

    for (const text of expectation.snapshotIncludes ?? []) {
      if (snap.toLowerCase().includes(text.toLowerCase())) {
        passSignals++;
      } else {
        failSignals++;
        reasons.push(`Expected snapshot to include "${text}"`);
      }
    }

    for (const text of expectation.snapshotExcludes ?? []) {
      if (!snap.toLowerCase().includes(text.toLowerCase())) {
        passSignals++;
      } else {
        failSignals++;
        reasons.push(`Snapshot should not include "${text}"`);
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

    const visibleErrors = signals.snapshot.raw.match(/User not found\.|Invalid|incorrect|error/gi);
    if (visibleErrors) {
      parts.push(`Visible messages: ${visibleErrors.join(', ')}`);
    }

    return parts.join(' | ');
  }

  async verifyAfterAction(
    expectation: VerificationExpectation,
    options: { waitMs?: number; retryWaitMs?: number } = {},
  ): Promise<VerificationResult> {
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const retryWaitMs = options.retryWaitMs ?? RETRY_WAIT_MS;

    await sleep(waitMs);
    let signals = await this.captureSignals(expectation.networkFilter);
    let evaluation = this.evaluateSignals(signals, expectation);

    if (evaluation.verdict === 'needs-review') {
      await sleep(retryWaitMs);
      signals = await this.captureSignals(expectation.networkFilter);
      evaluation = this.evaluateSignals(signals, expectation);
      if (evaluation.verdict === 'needs-review') {
        return {
          verdict: 'needs-review',
          severity: inferSeverity(evaluation.reasons, 'needs-review'),
          expected: expectation.description,
          actual: this.buildActualSummary(signals),
          signals,
          reasons: evaluation.reasons,
          retried: true,
        };
      }
    }

    return {
      verdict: evaluation.verdict,
      severity: inferSeverity(evaluation.reasons, evaluation.verdict),
      expected: expectation.description,
      actual: this.buildActualSummary(signals),
      signals,
      reasons: evaluation.reasons,
      retried: false,
    };
  }
}
