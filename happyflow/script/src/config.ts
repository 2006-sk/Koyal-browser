import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const loginRoot = path.resolve(projectRoot, '../../login');

dotenv.config({ path: path.join(loginRoot, '.env') });
dotenv.config({ path: path.join(projectRoot, '.env') });

function resolveAsset(rel: string): string {
  const p = path.isAbsolute(rel) ? rel : path.resolve(projectRoot, rel);
  if (!fs.existsSync(p)) {
    const fallback = path.resolve(projectRoot, '..', rel);
    if (fs.existsSync(fallback)) return fallback;
    throw new Error(`Script asset not found: ${p}`);
  }
  return p;
}

export const config = {
  baseUrl: process.env.KOYAL_BASE_URL ?? 'https://beta.koyal.ai',
  testEmail: process.env.KOYAL_TEST_EMAIL ?? '',
  testPassword: process.env.KOYAL_TEST_PASSWORD ?? '',
  sessionScript: process.env.KOYAL_SESSION_SCRIPT ?? 'qa-script-e2e',
  headed: process.env.AGENT_BROWSER_HEADED !== 'false',
  showCursor: process.env.AGENT_SHOW_CURSOR !== 'false',
  actionDelayMs: Number(process.env.AGENT_ACTION_DELAY_MS ?? '350'),
  verificationMaxWaitMs: Number(process.env.VERIFICATION_MAX_WAIT_MS ?? '15000'),
  verificationPollMs: Number(process.env.VERIFICATION_POLL_MS ?? '1000'),
  scriptProcessingWaitMs: Number(process.env.SCRIPT_PROCESSING_WAIT_MS ?? '300000'),
  sceneWaitMs: Number(process.env.SCRIPT_SCENE_WAIT_MS ?? '240000'),
  finalWaitMs: Number(process.env.SCRIPT_FINAL_WAIT_MS ?? '600000'),
  llm: (() => {
    type LlmProvider = 'openai' | 'anthropic' | 'openrouter' | 'custom';
    const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider;
    const apiKey =
      provider === 'anthropic'
        ? (process.env.ANTHROPIC_API_KEY ?? process.env.LLM_API_KEY ?? '')
        : provider === 'openai'
          ? (process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY ?? '')
          : (process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '');
    const defaultModel = provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini';
    return {
      enabled: process.env.LLM_ENABLED !== 'false' && Boolean(apiKey),
      provider,
      apiKey,
      baseUrl: process.env.LLM_BASE_URL ?? '',
      model: process.env.LLM_MODEL ?? defaultModel,
      maxStepsPerGoal: Number(process.env.LLM_MAX_STEPS_PER_GOAL ?? '12'),
    };
  })(),
  projectRoot,
  loginRoot,
  reportsDir: path.join(projectRoot, 'reports'),
  stateDir: path.join(projectRoot, '.state'),
  cursorScriptPath: path.join(projectRoot, 'assets', 'agent-cursor.js'),
  loginStatePath: path.resolve(
    projectRoot,
    process.env.KOYAL_LOGIN_STATE_PATH ?? '../../login/.state/qa-auth.json',
  ),
  script: {
    shortPdf: resolveAsset(
      process.env.SCRIPT_FILE ?? '../test-script-5-second.pdf',
    ),
  },
  paths: {
    upload: '/upload',
    scriptEdit: '/scriptEdit',
    selectStoryType: '/selectStoryType',
    selectTheme: '/selectTheme',
    selectStyle: '/selectStyle',
    editscene: '/editscene',
    finalvideo: '/finalvideo',
    login: '/login',
    projects: '/projects',
  },
} as const;

export function requireCredentials(): void {
  if (!config.testEmail || !config.testPassword) {
    throw new Error(
      'Missing KOYAL_TEST_EMAIL or KOYAL_TEST_PASSWORD — set in login/.env',
    );
  }
}

export function requireLlm(): void {
  if (!config.llm.apiKey) {
    throw new Error(
      'Missing ANTHROPIC_API_KEY (or LLM_API_KEY) in login/.env — script E2E requires LLM for adaptive navigation.',
    );
  }
}

export function readCursorScript(): string {
  return fs.readFileSync(config.cursorScriptPath, 'utf8');
}

export function defaultLlmBaseUrl(provider: typeof config.llm.provider): string {
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
