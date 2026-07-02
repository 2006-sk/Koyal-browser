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
  const p = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
  if (!fs.existsSync(p)) {
    throw new Error(`Audio asset not found: ${p}`);
  }
  return p;
}

export const config = {
  baseUrl: process.env.KOYAL_BASE_URL ?? 'https://beta.koyal.ai',
  testEmail: process.env.KOYAL_TEST_EMAIL ?? '',
  testPassword: process.env.KOYAL_TEST_PASSWORD ?? '',
  sessionAudio: process.env.KOYAL_SESSION_AUDIO ?? 'qa-audio',
  headed: process.env.AGENT_BROWSER_HEADED !== 'false',
  showCursor: process.env.AGENT_SHOW_CURSOR !== 'false',
  actionDelayMs: Number(process.env.AGENT_ACTION_DELAY_MS ?? '350'),
  verificationMaxWaitMs: Number(process.env.VERIFICATION_MAX_WAIT_MS ?? '15000'),
  verificationPollMs: Number(process.env.VERIFICATION_POLL_MS ?? '1000'),
  transcriptWaitMs: Number(process.env.AUDIO_TRANSCRIPT_WAIT_MS ?? '180000'),
  sceneWaitMs: Number(process.env.AUDIO_SCENE_WAIT_MS ?? '180000'),
  finalWaitMs: Number(process.env.AUDIO_FINAL_WAIT_MS ?? '180000'),
  projectRoot,
  loginRoot,
  reportsDir: path.join(projectRoot, 'reports'),
  stateDir: path.join(projectRoot, '.state'),
  cursorScriptPath: path.join(projectRoot, 'assets', 'agent-cursor.js'),
  loginStatePath: path.resolve(
    projectRoot,
    process.env.KOYAL_LOGIN_STATE_PATH ?? '../../login/.state/qa-auth.json',
  ),
  audio: {
    wav: resolveAsset(process.env.KOYAL_AUDIO_WAV ?? 'assets/test-narration-alt.wav'),
    mp3: resolveAsset(process.env.KOYAL_AUDIO_MP3 ?? 'assets/test-narration-alt.mp3'),
    shortWav: resolveAsset(process.env.KOYAL_AUDIO_SHORT_WAV ?? 'assets/test-narration-short.wav'),
    shortMp3: resolveAsset(process.env.KOYAL_AUDIO_SHORT_MP3 ?? 'assets/test-narration-short.mp3'),
  },
  paths: {
    upload: '/upload',
    lyricedit: '/lyricedit',
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
      'Missing KOYAL_TEST_EMAIL or KOYAL_TEST_PASSWORD — set in login/.env or happyflow/audio/.env',
    );
  }
}

export function readCursorScript(): string {
  return fs.readFileSync(config.cursorScriptPath, 'utf8');
}
