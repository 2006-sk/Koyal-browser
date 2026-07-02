import { config } from '../config.js';
import { AUDIO_EXPECTATION_BASE } from '../lib/audio-expectations.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { AudioWizardPage } from '../lib/page-audio.js';
import { SessionPage } from '../lib/page-session.js';
import { assertStepPassed, recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

export interface AudioE2EOptions {
  audioPath: string;
  formatLabel: string;
}

export async function testAudioE2E(
  browser: AgentBrowser,
  evidenceDir: string,
  options: AudioE2EOptions,
): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const steps: TestStep[] = [];
  const session = new SessionPage(browser);
  const audio = new AudioWizardPage(browser);
  const verification = new VerificationLayer(browser);
  const repro: string[] = [];

  const ctx = (): StepContext => ({ browser, verification, evidenceDir, stepsToReproduce: repro });

  repro.push('Restore or perform login');
  await session.loginOrRestoreSession();

  browser.clearSignals();
  repro.push(`Open upload fork at ${audio.uploadUrl()}`);
  audio.openFreshUploadFork();

  const forkStep = await recordVerifiedStep(ctx(), {
    workflow: 'upload-fork',
    action: 'Open /upload and show Start with Audio fork',
    expected: 'Upload choice screen with Start with Audio',
    expectation: {
      description: 'Audio upload fork visible',
      urlIncludes: '/upload',
      snapshotIncludesAny: ['Start with Audio', 'How would you like to start'],
      ...AUDIO_EXPECTATION_BASE,
    },
  });
  steps.push(forkStep);
  assertStepPassed(forkStep);

  browser.clearSignals();
  repro.push('Click Start with Audio');
  audio.startWithAudio();

  const audioScreenStep = await recordVerifiedStep(ctx(), {
    workflow: 'audio-upload-screen',
    action: 'Enter audio upload screen',
    expected: 'Upload File / Record / Select Sample options',
    expectation: {
      description: 'Audio upload UI visible',
      snapshotIncludesAny: ['Upload File', 'Drop your audio', 'Record Audio'],
      ...AUDIO_EXPECTATION_BASE,
    },
  });
  steps.push(audioScreenStep);
  assertStepPassed(audioScreenStep);

  browser.clearSignals();
  repro.push(`Upload ${options.formatLabel}: ${options.audioPath}`);
  audio.uploadAudioFile(options.audioPath);

  const uploadStep = await recordVerifiedStep(ctx(), {
    workflow: 'audio-file-uploaded',
    action: `Upload ${options.formatLabel} file`,
    expected: 'Plan modal or upload progress after file selected',
    expectation: {
      description: 'Audio file accepted',
      snapshotIncludesAny: ['Select Your Plan', 'Choose Audio Type', 'Uploading audio'],
      networkFilter: 'audio',
      requireNetworkActivity: false,
      ...AUDIO_EXPECTATION_BASE,
    },
    waitOptions: { maxWaitMs: 30000, pollMs: 2000 },
  });
  steps.push(uploadStep);
  assertStepPassed(uploadStep);

  repro.push('Select Standard plan and Continue');
  audio.selectPlan('Standard');
  browser.clearSignals();
  audio.clickNext();

  repro.push('Select Podcast + No multilingual');
  audio.runThroughAudioTypeAndStory();

  browser.clearSignals();
  const storyStep = await recordVerifiedStep(ctx(), {
    workflow: 'story-type-concept',
    action: 'Choose Podcast audio type and Concept Driven story',
    expected: 'On lyricedit or analyzing transcript',
    expectation: {
      description: 'Past story type toward transcript',
      snapshotIncludesAny: ['Audio transcript', 'Analyzing Audio', 'Upload file'],
      ...AUDIO_EXPECTATION_BASE,
    },
    waitOptions: { maxWaitMs: 60000, pollMs: 3000 },
  });
  steps.push(storyStep);
  assertStepPassed(storyStep);

  browser.clearSignals();
  repro.push('Wait for transcript processing');
  audio.waitForTranscriptReady();
  browser.clearSignals();

  const transcriptStep = await recordVerifiedStep(ctx(), {
    workflow: 'transcript-ready',
    action: 'Wait for audio transcript segments',
    expected: 'Transcript lines with Play audio controls',
    expectation: {
      description: 'Transcript processed',
      urlIncludes: '/lyricedit',
      snapshotIncludesAny: ['Play audio', 'Processing complete', 'Audio transcript'],
      ...AUDIO_EXPECTATION_BASE,
    },
    waitOptions: { maxWaitMs: config.transcriptWaitMs, pollMs: 5000 },
  });
  steps.push(transcriptStep);
  assertStepPassed(transcriptStep);

  browser.clearSignals();
  repro.push('Advance through Theme and Style');
  audio.runThroughTranscriptThemeStyle();
  browser.clearSignals();
  browser.clearSignals();

  const styleStep = await recordVerifiedStep(ctx(), {
    workflow: 'style-selected',
    action: 'Select Realistic + Landscape style and advance',
    expected: 'Past style step toward scenes',
    expectation: {
      description: 'Style step completed',
      snapshotExcludes: ['Something went wrong'],
      snapshotIncludesAny: ['Edit scenes', 'Locations', 'Generating Scenes', 'Create Video', 'selectStyle', 'editscene'],
      urlExcludes: '/lyricedit',
      ...AUDIO_EXPECTATION_BASE,
    },
    waitOptions: { maxWaitMs: config.sceneWaitMs, pollMs: 5000 },
  });
  steps.push(styleStep);
  assertStepPassed(styleStep);

  browser.clearSignals();
  repro.push('Wait for scene generation and Create Video');
  audio.runThroughScenesAndFinal();

  const finalStep = await recordVerifiedStep(ctx(), {
    workflow: 'final-video-download',
    action: 'Complete final video render',
    expected: 'Download Video button enabled on /finalvideo',
    expectation: {
      description: 'Final video ready for download',
      urlIncludes: '/finalvideo',
      snapshotIncludes: ['Download Video'],
      networkFilter: 'video',
      requireNetworkActivity: false,
      ...AUDIO_EXPECTATION_BASE,
    },
    waitOptions: { maxWaitMs: config.finalWaitMs, pollMs: 10000 },
  });
  steps.push(finalStep);
  assertStepPassed(finalStep);

  return {
    id: `audio-e2e-${options.formatLabel.toLowerCase()}`,
    name: `Audio E2E — ${options.formatLabel} upload to final video`,
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
