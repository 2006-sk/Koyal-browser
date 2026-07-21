import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const loginRoot = path.resolve(projectRoot, '../login');

dotenv.config({ path: path.join(projectRoot, '.env') });
// Fallback: reuse credentials/API keys from the sibling login project
dotenv.config({ path: path.join(loginRoot, '.env') });

export type LlmProvider = 'openai' | 'anthropic' | 'openrouter' | 'custom';

function resolveLlmApiKey(provider: LlmProvider): string {
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY ?? process.env.LLM_API_KEY ?? '';
  }
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY ?? '';
  }
  return process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
}

const llmProvider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider;
const llmApiKey = resolveLlmApiKey(llmProvider);

export const config = {
  /** Target site; set via --url flag or AUTOQA_URL env */
  baseUrl: process.env.AUTOQA_URL ?? '',
  session: process.env.AUTOQA_SESSION ?? 'autoqa',
  headed: process.env.AGENT_BROWSER_HEADED !== 'false',
  showCursor: process.env.AGENT_SHOW_CURSOR !== 'false',
  actionDelayMs: Number(process.env.AGENT_ACTION_DELAY_MS ?? '350'),
  verificationMaxWaitMs: Number(process.env.VERIFICATION_MAX_WAIT_MS ?? '15000'),
  verificationPollMs: Number(process.env.VERIFICATION_POLL_MS ?? '1000'),

  /** Crawl caps */
  maxPages: Number(process.env.AUTOQA_MAX_PAGES ?? '25'),
  crawlDepth: Number(process.env.AUTOQA_CRAWL_DEPTH ?? '4'),
  probesPerPage: Number(process.env.AUTOQA_PROBES_PER_PAGE ?? '6'),

  /** Deep exploration: actually enter create/upload flows during explore */
  deep: {
    enabled: process.env.AUTOQA_DEEP !== 'false',
    walksPerExplore: Number(process.env.AUTOQA_DEEP_FLOWS ?? '3'),
    walkMaxSteps: Number(process.env.AUTOQA_DEEP_WALK_MAX_STEPS ?? '60'),
    processingWaitMs: Number(process.env.AUTOQA_PROCESSING_WAIT_MS ?? '1200000'),
    terminalWaitMs: Number(process.env.AUTOQA_TERMINAL_WAIT_MS ?? '1200000'),
  },

  /** QA probes during flow testing (back/forward, matrices, edit sweeps, …) */
  probes: {
    thorough: process.env.AUTOQA_QUICK !== 'true',
    perMilestoneCap: Number(process.env.AUTOQA_PROBES_PER_MILESTONE ?? '3'),
    /** Exhaustive mode: exercise EVERY option/edit (no per-milestone cap, no 6-member slice) and treat nav/state-loss as first-class bugs. */
    exhaustive: process.env.AUTOQA_EXHAUSTIVE === 'true',
  },

  /** Force this file for every upload this run (recipe replays + prompt default) */
  uploadFileOverride: process.env.AUTOQA_UPLOAD_FILE ?? '',

  /** 5xx responses from these hosts never count against maxUnexpectedNetwork5xx */
  ignored5xxHostsPattern: new RegExp(
    process.env.AUTOQA_IGNORED_5XX_HOSTS ?? 'google-analytics|googletagmanager|mux\\.com|posthog|sentry|segment\\.io',
    'i',
  ),

  /** Keyword hard floor for the destructive-action guard (LLM cannot override) */
  destructiveKeywords: new RegExp(
    process.env.AUTOQA_DESTRUCTIVE_KEYWORDS ??
      'delete|remove|destroy|clear all|pay|purchase|buy|checkout|subscribe|invite|revoke|deactivate|cancel (account|subscription)|log ?out|sign ?out',
    'i',
  ),

  llm: {
    enabled: process.env.LLM_ENABLED !== 'false' && Boolean(llmApiKey),
    provider: llmProvider,
    apiKey: llmApiKey,
    baseUrl: process.env.LLM_BASE_URL ?? '',
    model: process.env.LLM_MODEL ?? (llmProvider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini'),
    maxStepsPerGoal: Number(process.env.LLM_MAX_STEPS_PER_GOAL ?? '12'),
    snapshotMaxChars: Number(process.env.AUTOQA_SNAPSHOT_MAX_CHARS ?? '8000'),
    /** Hard cap on LLM calls per run; 0 = unlimited */
    callBudget: Number(process.env.AUTOQA_LLM_BUDGET ?? '0'),
    /** Per-attempt network timeout for LLM HTTP calls; a stalled connection must
     *  fail fast and let the existing 3x retry/backoff (and callers' try/catch,
     *  e.g. proposeFlows "must never kill the run") actually run, instead of the
     *  whole explore/test process hanging forever on an un-timed-out fetch().
     *  `||` (not `??`) so a blank env value (e.g. `AUTOQA_LLM_TIMEOUT_MS=` left
     *  over from an .env template) falls back to the default instead of coercing
     *  to Number('')===0, which would abort every LLM call immediately. */
    requestTimeoutMs: Number(process.env.AUTOQA_LLM_TIMEOUT_MS || '60000'),
  },

  projectRoot,
  loginRoot,
  reportsDir: path.join(projectRoot, 'reports'),
  stateRoot: path.join(projectRoot, '.autoqa-state'),
  cursorScriptPath: path.join(projectRoot, 'assets', 'agent-cursor.js'),
};

export interface CliOverrides {
  url?: string;
  maxPages?: number;
  maxSteps?: number;
  headless?: boolean;
  budget?: number;
  deepFlows?: number;
  noDeep?: boolean;
  quick?: boolean;
  uploadFile?: string;
}

/** Apply --flag overrides on top of env-derived config (call once from cli.ts). */
export function applyCliOverrides(overrides: CliOverrides): void {
  if (overrides.url) config.baseUrl = overrides.url;
  if (overrides.maxPages) config.maxPages = overrides.maxPages;
  if (overrides.maxSteps) config.llm.maxStepsPerGoal = overrides.maxSteps;
  if (overrides.headless) config.headed = false;
  if (overrides.budget !== undefined) config.llm.callBudget = overrides.budget;
  if (overrides.deepFlows !== undefined) config.deep.walksPerExplore = overrides.deepFlows;
  if (overrides.noDeep) config.deep.enabled = false;
  if (overrides.quick) config.probes.thorough = false;
  if (overrides.uploadFile) config.uploadFileOverride = overrides.uploadFile;

  // login/.env's KOYAL_TEST_EMAIL/PASSWORD are a convenience for testing Koyal
  // specifically — they must NOT leak into AUTOQA_EMAIL/PASSWORD (checked by the
  // generic, site-agnostic auth module) for every other target site. Scope the
  // shim to when the resolved target actually is Koyal.
  try {
    const isKoyal = config.baseUrl && new URL(config.baseUrl).hostname.includes('koyal');
    if (isKoyal) {
      if (!process.env.AUTOQA_EMAIL && process.env.KOYAL_TEST_EMAIL) {
        process.env.AUTOQA_EMAIL = process.env.KOYAL_TEST_EMAIL;
      }
      if (!process.env.AUTOQA_PASSWORD && process.env.KOYAL_TEST_PASSWORD) {
        process.env.AUTOQA_PASSWORD = process.env.KOYAL_TEST_PASSWORD;
      }
    }
  } catch {
    // malformed baseUrl — requireBaseUrl() will surface this later
  }
}

export function requireBaseUrl(): string {
  if (!config.baseUrl) {
    throw new Error('No target URL. Pass --url https://example.com or set AUTOQA_URL in .env');
  }
  return config.baseUrl;
}

export function requireLlm(): void {
  if (!config.llm.apiKey) {
    throw new Error(
      'LLM key required: set ANTHROPIC_API_KEY (or LLM_PROVIDER + LLM_API_KEY) in autoqa/.env or login/.env',
    );
  }
}

export function readCursorScript(): string {
  return fs.readFileSync(config.cursorScriptPath, 'utf8');
}

export function defaultLlmBaseUrl(provider: LlmProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'openai':
      return 'https://api.openai.com/v1';
    default:
      return config.llm.baseUrl;
  }
}
