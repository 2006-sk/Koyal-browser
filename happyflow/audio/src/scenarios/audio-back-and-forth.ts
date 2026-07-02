import { config } from '../config.js';
import { AUDIO_EXPECTATION_BASE } from '../lib/audio-expectations.js';
import { audioSelectors } from '../lib/audio-selectors.js';
import { AgentBrowser, isButtonDisabled } from '../lib/agent-browser.js';
import { AudioWizardPage } from '../lib/page-audio.js';
import { SessionPage } from '../lib/page-session.js';
import { assertStepPassed, recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

export async function testAudioBackAndForth(
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

  repro.push('Start audio flow with short WAV');
  browser.clearSignals();
  audio.runAudioUploadPreflight(config.audio.shortWav);
  audio.runThroughAudioTypeAndStory();

  repro.push('Wait for transcript');
  audio.waitForTranscriptReady();
  browser.clearSignals();

  const atTranscript = await recordVerifiedStep(ctx(), {
    workflow: 'at-transcript',
    action: 'Reach lyricedit with transcript',
    expected: 'Audio transcript with Play audio',
    expectation: {
      description: 'On transcript step',
      urlIncludes: '/lyricedit',
      snapshotIncludesAny: ['Audio transcript', 'Play audio'],
      ...AUDIO_EXPECTATION_BASE,
    },
    waitOptions: { maxWaitMs: config.transcriptWaitMs, pollMs: 5000 },
  });
  steps.push(atTranscript);
  assertStepPassed(atTranscript);

  repro.push('Wizard: Go back to Story Type if enabled → Concept Driven → transcript');
  browser.clearSignals();
  if (!audio.isOnTranscriptStep()) {
    audio.waitForTranscriptReady();
  }

  const snapBeforeBack = browser.snapshotInteractive();
  const canGoBack = !isButtonDisabled(snapBeforeBack, 'Go back to Story Type Selection');

  if (canGoBack) {
    audio.goBackToStoryType();
    audio.selectConceptDriven();
    audio.clickNext();
    audio.waitForTranscriptReady();

    const storyRoundTrip = await recordVerifiedStep(ctx(), {
      workflow: 'story-type-round-trip',
      action: 'Story Type go-back round-trip to transcript',
      expected: 'Transcript preserved after Concept Driven re-selection',
      expectation: {
        description: 'Story type round-trip succeeds',
        urlIncludes: '/lyricedit',
        snapshotIncludesAny: ['Audio transcript', 'Play audio'],
        ...AUDIO_EXPECTATION_BASE,
      },
      waitOptions: { maxWaitMs: config.transcriptWaitMs, pollMs: 5000 },
    });
    steps.push(storyRoundTrip);
    assertStepPassed(storyRoundTrip);
  } else {
    const skipped = await recordVerifiedStep(ctx(), {
      workflow: 'story-type-round-trip-skipped',
      action: 'Skip story round-trip — Go back disabled while processing',
      expected: 'Transcript still visible (processing in background)',
      expectation: {
        description: 'Transcript step stable while go-back disabled',
        snapshotIncludesAny: ['Audio transcript', 'Understanding emotions', 'Play audio'],
        ...AUDIO_EXPECTATION_BASE,
      },
    });
    steps.push(skipped);
  }

  repro.push('Wizard sidebar: try Theme step (may stay on transcript if processing)');
  browser.clearSignals();
  try {
    audio.clickWizardStep(audioSelectors.wizard.themeStep);
  } catch {
    // non-fatal — document in verification
  }

  const themeNav = await recordVerifiedStep(ctx(), {
    workflow: 'wizard-theme-attempt',
    action: 'Click Theme in wizard sidebar from transcript',
    expected: 'Story Theme OR still on transcript without error',
    expectation: {
      description: 'Theme navigation does not crash wizard',
      snapshotIncludesAny: ['Story Theme', 'Audio transcript', 'Visual Style'],
      snapshotExcludes: ['Something went wrong'],
      ...AUDIO_EXPECTATION_BASE,
    },
    waitOptions: { maxWaitMs: 30000, pollMs: 2000 },
  });
  steps.push(themeNav);

  repro.push('Return to Review transcript via sidebar');
  browser.clearSignals();
  audio.clickWizardStep(audioSelectors.wizard.reviewStep);
  browser.wait(2000);
  if (!audio.isOnTranscriptStep()) {
    try {
      browser.back();
      browser.wait(1500);
    } catch {
      audio.clickWizardStep(audioSelectors.wizard.reviewStep);
    }
  }

  const backToTranscript = await recordVerifiedStep(ctx(), {
    workflow: 'wizard-back-to-transcript',
    action: 'Navigate back to Review transcript step',
    expected: 'Transcript step visible again',
    expectation: {
      description: 'Back to transcript after sidebar hops',
      snapshotIncludesAny: ['Audio transcript', 'Play audio'],
      ...AUDIO_EXPECTATION_BASE,
    },
    waitOptions: { maxWaitMs: 30000, pollMs: 2000 },
  });
  steps.push(backToTranscript);
  assertStepPassed(backToTranscript);

  repro.push('Advance toward theme and test browser back/forward');
  browser.clearSignals();
  if (!audio.isNextDisabled()) {
    audio.clickNext();
    browser.wait(2000);
  }
  browser.back();
  browser.wait(1500);
  browser.forward();
  browser.wait(1500);

  const browserNav = await recordVerifiedStep(ctx(), {
    workflow: 'browser-back-forward',
    action: 'Browser back then forward in wizard',
    expected: 'Still in wizard without blocking error',
    expectation: {
      description: 'Browser history navigation safe',
      snapshotExcludes: ['Something went wrong'],
      snapshotIncludesAny: ['Story Theme', 'Audio transcript', 'Theme', 'Review transcript'],
      ...AUDIO_EXPECTATION_BASE,
    },
    waitOptions: { maxWaitMs: 20000, pollMs: 2000 },
  });
  steps.push(browserNav);
  assertStepPassed(browserNav);

  return {
    id: 'audio-back-and-forth',
    name: 'Audio flow — wizard & browser back/forth',
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
