import { config } from '../config.js';
import { AUDIO_EXPECTATION_BASE } from '../lib/audio-expectations.js';
import { audioSelectors } from '../lib/audio-selectors.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { AudioWizardPage } from '../lib/page-audio.js';
import { SessionPage } from '../lib/page-session.js';
import { assertStepPassed, recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

const WIZARD_STEPS = [
  { id: 'upload', pattern: audioSelectors.wizard.uploadStep, hint: 'Upload file' },
  { id: 'story-type', pattern: audioSelectors.wizard.storyTypeStep, hint: 'Story Type' },
  { id: 'review', pattern: audioSelectors.wizard.reviewStep, hint: 'Review transcript' },
  { id: 'theme', pattern: audioSelectors.wizard.themeStep, hint: 'Theme' },
  { id: 'style', pattern: audioSelectors.wizard.styleStep, hint: 'Style' },
] as const;

export async function testAudioWizardNavigation(
  browser: AgentBrowser,
  evidenceDir: string,
): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const steps: TestStep[] = [];
  const session = new SessionPage(browser);
  const audio = new AudioWizardPage(browser);
  const verification = new VerificationLayer(browser);
  const repro: string[] = [];
  const ctx = (): StepContext => ({ browser, verification, evidenceDir, stepsToReproduce: repro });

  await session.loginOrRestoreSession();

  repro.push('Reach transcript step via short MP3');
  browser.clearSignals();
  audio.runAudioUploadPreflight(config.audio.shortMp3);
  audio.runThroughAudioTypeAndStory();
  audio.waitForTranscriptReady();

  const baseStep = await recordVerifiedStep(ctx(), {
    workflow: 'wizard-nav-base',
    action: 'Reach transcript for sidebar navigation tests',
    expected: 'Wizard sidebar visible on lyricedit',
    expectation: {
      description: 'Wizard chrome present',
      snapshotIncludesAny: ['Review transcript', 'Theme', 'Upload file'],
      ...AUDIO_EXPECTATION_BASE,
    },
  });
  steps.push(baseStep);
  assertStepPassed(baseStep);

  for (const step of WIZARD_STEPS) {
    repro.push(`Click wizard step: ${step.hint}`);
    browser.clearSignals();
    try {
      audio.clickWizardStep(step.pattern);
    } catch (error) {
      const failStep = await recordVerifiedStep(ctx(), {
        workflow: `wizard-nav-${step.id}`,
        action: `Click wizard sidebar: ${step.hint}`,
        expected: `${step.hint} step reachable`,
        expectation: {
          description: `${step.hint} navigation`,
          snapshotIncludes: [step.hint],
          ...AUDIO_EXPECTATION_BASE,
        },
      });
      steps.push(failStep);
      continue;
    }

    const navStep = await recordVerifiedStep(ctx(), {
      workflow: `wizard-nav-${step.id}`,
      action: `Click wizard sidebar: ${step.hint}`,
      expected: `${step.hint} step content or wizard marker visible`,
      expectation: {
        description: `${step.hint} navigation`,
        snapshotIncludesAny: [step.hint, 'Upload Your Script', 'Story Theme', 'Choose art style', 'Audio transcript'],
        snapshotExcludes: ['Something went wrong'],
        ...AUDIO_EXPECTATION_BASE,
      },
      waitOptions: { maxWaitMs: 20000, pollMs: 2000 },
    });
    steps.push(navStep);
  }

  repro.push('Return to Review transcript and verify Next state');
  browser.clearSignals();
  audio.clickWizardStep(audioSelectors.wizard.reviewStep);

  const nextStep = await recordVerifiedStep(ctx(), {
    workflow: 'wizard-nav-next-state',
    action: 'Return to transcript and check Next button',
    expected: 'Transcript visible; Next not blocked by error',
    expectation: {
      description: 'Next available after wizard navigation',
      snapshotIncludesAny: ['Audio transcript', 'Play audio'],
      snapshotExcludes: ['Something went wrong'],
      ...AUDIO_EXPECTATION_BASE,
    },
  });
  steps.push(nextStep);
  assertStepPassed(nextStep);

  return {
    id: 'audio-wizard-navigation',
    name: 'Audio flow — wizard sidebar navigation',
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
