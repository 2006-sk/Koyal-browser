/**
 * Test 2 of 2 — MP3 format parity: same happy path with real edits (lighter probes).
 */
import { config } from '../config.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import type { ScenarioResult } from '../lib/types.js';
import { runAudioCompleteFlow } from './audio-complete.js';

export async function testAudioMp3(
  browser: AgentBrowser,
  evidenceDir: string,
): Promise<ScenarioResult> {
  return runAudioCompleteFlow(browser, evidenceDir, {
    audioPath: config.audio.shortMp3,
    formatLabel: 'MP3 (short)',
    scenarioId: 'audio-complete-mp3',
    scenarioName: 'Audio complete — MP3 short clip, full path + real edits',
    probeUploadAlternates: false,
    probeAudioTypeMatrix: false,
    probeStyleMatrix: false,
    probeSidebarRoundTrip: false,
    includeBackForth: false,
  });
}

/** @deprecated Use testAudioMp3 */
export async function testAudioE2E(
  browser: AgentBrowser,
  evidenceDir: string,
  options: { audioPath: string; formatLabel: string },
): Promise<ScenarioResult> {
  return runAudioCompleteFlow(browser, evidenceDir, {
    audioPath: options.audioPath,
    formatLabel: options.formatLabel,
    scenarioId: `audio-e2e-${options.formatLabel.toLowerCase()}`,
    scenarioName: `Audio E2E — ${options.formatLabel}`,
    probeUploadAlternates: false,
    probeAudioTypeMatrix: false,
    probeStyleMatrix: false,
    probeSidebarRoundTrip: false,
    includeBackForth: false,
  });
}
