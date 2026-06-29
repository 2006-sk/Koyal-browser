import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const MODEL_ALIASES: Record<string, string> = {
  'sonnet-4.6': 'claude-sonnet-4-6',
  sonnet: 'claude-sonnet-4-6',
};

function normalizeLlmModel(model: string): string {
  return MODEL_ALIASES[model.trim().toLowerCase()] ?? model;
}

export type LlmProvider = 'openai' | 'anthropic' | 'openrouter' | 'custom';

export const config = {
  baseUrl: process.env.KOYAL_BASE_URL ?? 'https://beta.koyal.ai',
  testEmail: process.env.KOYAL_TEST_EMAIL ?? '',
  testPassword: process.env.KOYAL_TEST_PASSWORD ?? '',
  resetEmail: process.env.KOYAL_RESET_EMAIL ?? process.env.KOYAL_TEST_EMAIL ?? '',
  signupEmail: process.env.KOYAL_SIGNUP_EMAIL ?? '',
  signupName: process.env.KOYAL_SIGNUP_NAME ?? 'QA Test User',
  signupPassword: process.env.KOYAL_SIGNUP_PASSWORD ?? 'KoyalQa!Signup2026',
  sessionAuth: process.env.KOYAL_SESSION_AUTH ?? 'qa-auth',
  sessionApp: process.env.KOYAL_SESSION_APP ?? 'qa-app',
  headed: process.env.AGENT_BROWSER_HEADED !== 'false',
  showCursor: process.env.AGENT_SHOW_CURSOR !== 'false',
  actionDelayMs: Number(process.env.AGENT_ACTION_DELAY_MS ?? '350'),
  /** Max wait per verification step — exceed → fail */
  verificationMaxWaitMs: Number(process.env.VERIFICATION_MAX_WAIT_MS ?? '15000'),
  verificationPollMs: Number(process.env.VERIFICATION_POLL_MS ?? '1000'),
  /** How long to wait for OTP/reset code file (signup-otp.txt / reset-code.txt) */
  codeWaitMs: Number(process.env.KOYAL_CODE_WAIT_MS ?? '60000'),
  /** Poll interval while waiting for code file */
  codePollMs: Number(process.env.KOYAL_CODE_POLL_MS ?? '2000'),
  llm: {
    enabled: process.env.LLM_ENABLED !== 'false' && Boolean(process.env.LLM_API_KEY),
    provider: (process.env.LLM_PROVIDER ?? 'openai') as LlmProvider,
    apiKey: process.env.LLM_API_KEY ?? '',
    baseUrl: process.env.LLM_BASE_URL ?? '',
    model: normalizeLlmModel(process.env.LLM_MODEL ?? 'gpt-4o-mini'),
    maxStepsPerGoal: Number(process.env.LLM_MAX_STEPS_PER_GOAL ?? '8'),
  },
  projectRoot,
  reportsDir: path.join(projectRoot, 'reports'),
  stateDir: path.join(projectRoot, '.state'),
  cursorScriptPath: path.join(projectRoot, 'assets', 'agent-cursor.js'),
  paths: {
    login: '/login',
    dashboard: '/dashboard',
    forgotPassword: '/forgot-password',
  },
} as const;

export function requireCredentials(): void {
  if (!config.testEmail || !config.testPassword) {
    throw new Error(
      'Missing KOYAL_TEST_EMAIL or KOYAL_TEST_PASSWORD in .env — copy .env.example and fill in test credentials.',
    );
  }
}

export function requireSignupCredentials(): void {
  if (!config.signupEmail) {
    throw new Error(
      'Missing KOYAL_SIGNUP_EMAIL in .env — set a fresh email address for the create-account test.',
    );
  }
  if (!config.signupPassword || config.signupPassword.length < 6) {
    throw new Error('KOYAL_SIGNUP_PASSWORD must be at least 6 characters.');
  }
}

export function requireLlm(): void {
  if (!config.llm.apiKey) {
    throw new Error(
      'Missing LLM_API_KEY in .env — exploration layer requires an LLM for adaptive navigation.',
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
    case 'custom':
      return config.llm.baseUrl;
    default:
      return 'https://api.openai.com/v1';
  }
}
