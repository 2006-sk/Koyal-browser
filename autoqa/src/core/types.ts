export type Verdict = 'pass' | 'fail' | 'needs-review';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface ConsoleMessage {
  text: string;
  type: string;
  timestamp?: number;
}

export interface PageError {
  message: string;
  stack?: string;
}

export interface NetworkRequest {
  url?: string;
  method?: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface SnapshotResult {
  raw: string;
  interactive: string;
}

export interface SignalBundle {
  url: string;
  title: string;
  snapshot: SnapshotResult;
  pageErrors: PageError[];
  consoleMessages: ConsoleMessage[];
  consoleErrors: ConsoleMessage[];
  networkRequests: NetworkRequest[];
}

export interface VerificationExpectation {
  /** Human-readable description of what should happen */
  description: string;
  /** Expected URL substring or regex string */
  urlIncludes?: string | RegExp;
  /** Text that must appear in snapshot (case-insensitive; RegExp tested as-is) */
  snapshotIncludes?: Array<string | RegExp>;
  /** At least one of these must appear in snapshot */
  snapshotIncludesAny?: Array<string | RegExp>;
  /** URL must NOT match */
  urlExcludes?: string | RegExp;
  /** Text that must NOT appear in snapshot */
  snapshotExcludes?: Array<string | RegExp>;
  /** Fail if more than N unexpected 5xx API responses (excludes analytics/CDN) */
  maxUnexpectedNetwork5xx?: number;
  /** Network filter passed to agent-browser network requests */
  networkFilter?: string;
  /** Expected HTTP status codes for filtered requests (e.g. [200], [401,404]) */
  expectedNetworkStatuses?: number[];
  /** Whether any network call matching filter is required */
  requireNetworkActivity?: boolean;
  /** Uncaught JS exceptions must be empty */
  allowPageErrors?: boolean;
  /** Console error-level messages allowed (default: none) */
  allowConsoleErrors?: boolean;
  /** Patterns in console errors that are acceptable (e.g. expected 404 on bad login) */
  allowedConsoleErrorPatterns?: RegExp[];
  /** Patterns that indicate raw/ugly backend errors shown to user */
  uglyErrorPatterns?: RegExp[];
}

export interface VerificationResult {
  verdict: Verdict;
  severity: Severity;
  expected: string;
  actual: string;
  signals: SignalBundle;
  reasons: string[];
  retried: boolean;
  /** Set when knowledge-base triage touched this verdict */
  kbTriage?: {
    statementsSeen: string[];
    newlyClassified: string[];
    verdictFlippedFrom?: Verdict;
  };
}

/** A recorded answer the human gave during a run */
export interface HumanDecision {
  question: string;
  answer: string;
  at: string;
}

export interface TestStep {
  workflow: string;
  action: string;
  expected: string;
  result: VerificationResult;
  stepsToReproduce: string[];
  evidenceDir?: string;
  evidenceFiles?: string[];
  artifactDir?: string;
  explorerSteps?: string[];
  humanDecisions?: HumanDecision[];
}

export interface ScenarioResult {
  id: string;
  name: string;
  steps: TestStep[];
  startedAt: string;
  finishedAt: string;
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  scenarios: ScenarioResult[];
}
