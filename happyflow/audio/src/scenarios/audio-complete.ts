/**
 * Test 1 of 2 — complete audio path (short WAV): every control, real edits, nav, download.
 */
import { config } from '../config.js';
import { audioSelectors, isDownloadReady } from '../lib/audio-selectors.js';
import {
  editFinalVideoNote,
  editSceneDescription,
  editThemeFields,
  editTranscriptLine,
  snapshotHasText,
} from '../lib/audio-edits.js';
import { AudioNav, waitUntil, waitUntilNextEnabled } from '../lib/audio-nav.js';
import { assertNoStepFailures, probeStep, STEP_BASE } from '../lib/audio-scenario-helpers.js';
import { AgentBrowser, isButtonDisabled, refForEnabledButton } from '../lib/agent-browser.js';
import { AudioWizardPage } from '../lib/page-audio.js';
import { SessionPage } from '../lib/page-session.js';
import type { StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep, VerificationExpectation } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';
import { detectWizardPhase, snapHas } from '../lib/wizard-phase.js';

export interface AudioCompleteFlowOptions {
  audioPath: string;
  formatLabel: string;
  scenarioId: string;
  scenarioName: string;
  /** Probe Select Sample / Record Audio tabs before upload */
  probeUploadAlternates?: boolean;
  /** Click Music/Podcast/Narration matrix */
  probeAudioTypeMatrix?: boolean;
  /** Individual style + aspect probe steps */
  probeStyleMatrix?: boolean;
  /** Wizard sidebar round-trip after download */
  probeSidebarRoundTrip?: boolean;
  /** Story-type go-back + sidebar + browser history on transcript */
  includeBackForth?: boolean;
}

const TRANSCRIPT_EDIT = 'QA transcript: edited dialogue line for automation.';
const THEME_VISUAL = 'QA visual style: warm coffee shop, soft morning light.';
const THEME_NARRATIVE = 'QA narrative: two friends share a quiet moment over coffee.';
const SCENE_EDIT = 'QA scene: warmer background with soft morning light.';
const FINAL_EDIT = 'QA final: slightly brighter exposure on faces.';

export async function runAudioCompleteFlow(
  browser: AgentBrowser,
  evidenceDir: string,
  options: AudioCompleteFlowOptions,
): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const steps: TestStep[] = [];
  const session = new SessionPage(browser);
  const wizard = new AudioWizardPage(browser);
  const nav = new AudioNav(browser);
  const verification = new VerificationLayer(browser);
  const repro: string[] = [];
  const ctx = (): StepContext => ({ browser, verification, evidenceDir, stepsToReproduce: repro });

  await session.loginOrRestoreSession();

  // agent-browser `record start` navigates authenticated pages to /login — re-auth after recording begins.
  browser.startRecordingIfQueued();
  let snapAfterRecord = browser.snapshotInteractive();
  if (/\/login/i.test(browser.getUrl()) || /sign up|full name\*/i.test(snapAfterRecord)) {
    session.loginFresh();
  }

  // ── UPLOAD ────────────────────────────────────────────────────
  wizard.openFreshUploadFork();
  let uploadSnap = browser.snapshotInteractive();
  if (/\/login/i.test(browser.getUrl()) || /sign up|full name\*/i.test(uploadSnap)) {
    session.loginFresh();
    wizard.openFreshUploadFork();
    uploadSnap = browser.snapshotInteractive();
    if (/\/login/i.test(browser.getUrl()) || /sign up|full name\*/i.test(uploadSnap)) {
      throw new Error(`Not authenticated after login retry (url=${browser.getUrl()})`);
    }
  }
  steps.push(
    await probeStep(ctx(), repro, 'upload-fork', 'Open upload fork', 'Start with Audio visible', {
      description: 'Upload fork',
      urlIncludes: '/upload',
      snapshotIncludesAny: ['Start with Audio', 'How would you like to start'],
      ...STEP_BASE,
    }),
  );

  wizard.startWithAudio();
  steps.push(
    await probeStep(ctx(), repro, 'audio-screen', 'Start with Audio', 'Upload options visible', {
      description: 'Audio upload screen',
      snapshotIncludesAny: ['Drop your audio', 'button "Upload File"'],
      snapshotExcludes: ['How would you like to start?'],
      ...STEP_BASE,
    }),
  );

  if (options.probeUploadAlternates !== false) {
    nav.click({ label: 'Select Sample', optional: true });
    steps.push(
      await probeStep(ctx(), repro, 'probe-select-sample', 'Click Select Sample', 'Sample UI no crash', {
        description: 'Select Sample probe',
        snapshotExcludes: ['Something went wrong'],
        ...STEP_BASE,
      }),
    );
    nav.dismissOverlays();
    nav.click({ label: 'Record Audio', optional: true });
    steps.push(
      await probeStep(ctx(), repro, 'probe-record-audio', 'Click Record Audio', 'Recorder UI no crash', {
        description: 'Record Audio probe',
        snapshotExcludes: ['Something went wrong'],
        ...STEP_BASE,
      }),
    );
    nav.dismissOverlays();
    wizard.ensureAudioUploadScreen();
    wizard.ensureUploadFileTab();
    nav.click({ label: 'Upload File', exact: true, optional: true });
    browser.wait(800);
  }

  const uploadAudio = (): void => {
    wizard.uploadAudioFile(options.audioPath);
  };

  try {
    uploadAudio();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('REAUTH_REQUIRED') && !message.includes('about:blank')) throw error;
    session.loginFresh();
    wizard.openFreshUploadFork();
    wizard.startWithAudio();
    wizard.ensureUploadFileTab();
    uploadAudio();
  }

  steps.push(
    await probeStep(ctx(), repro, 'file-uploaded', `Upload ${options.formatLabel}`, 'Plan or processing', {
      description: 'File uploaded',
      snapshotIncludesAny: ['Select Your Plan', 'Choose Audio Type', 'Uploading audio'],
      networkFilter: 'audio',
      requireNetworkActivity: false,
      ...STEP_BASE,
    }, undefined, 30000),
  );

  wizard.selectPlan('Standard');
  steps.push(
    await probeStep(ctx(), repro, 'plan-standard', 'Select Standard plan', 'Plan modal closed', {
      description: 'Standard plan',
      snapshotExcludes: ['Select Your Plan', 'How would you like to start?'],
      snapshotIncludesAny: ['Choose Audio Type', 'Uploading audio', 'Analyzing Audio'],
      ...STEP_BASE,
    }),
  );

  const snapPostPlan = browser.snapshotInteractive();
  if (snapHas(snapPostPlan, 'Choose Audio Type') || refForEnabledButton(snapPostPlan, 'Next')) {
    if (!snapHas(snapPostPlan, 'Choose Audio Type')) wizard.clickNext();
  }

  // ── AUDIO TYPE ────────────────────────────────────────────────
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'audio-type' || detectWizardPhase(u, s) === 'story-type',
    config.verificationMaxWaitMs,
    'audio type or story',
  );

  if (
    options.probeAudioTypeMatrix !== false &&
    detectWizardPhase(browser.getUrl(), browser.snapshotInteractive()) === 'audio-type'
  ) {
    for (const type of ['Music', 'Podcast', 'Narration'] as const) {
      nav.click({ label: type, exact: true });
      steps.push(
        await probeStep(ctx(), repro, `audio-type-${type.toLowerCase()}`, `Select ${type}`, `${type} selectable`, {
          description: `Audio type ${type}`,
          snapshotIncludes: [type],
          ...STEP_BASE,
        }),
      );
    }
    nav.click({ label: 'No', exact: true, optional: true });
    wizard.clickNext();
  } else if (detectWizardPhase(browser.getUrl(), browser.snapshotInteractive()) === 'audio-type') {
    nav.click({ label: 'Podcast', exact: true });
    nav.click({ label: 'No', exact: true, optional: true });
    wizard.clickNext();
  }

  // ── STORY TYPE ────────────────────────────────────────────────
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'story-type',
    config.verificationMaxWaitMs,
    'story type',
  );

  nav.click({ label: 'Character Driven', optional: true });
  nav.click({ label: 'Use Existing', optional: true });
  if (snapHas(browser.snapshotInteractive(), 'Choose Existing Character')) {
    nav.dismissOverlays();
  }
  wizard.selectConceptDriven();
  wizard.clickNext();

  // ── TRANSCRIPT (with processing signal capture) ───────────────
  browser.clearSignals();
  wizard.waitForTranscriptReady();
  wizard.waitForTranscriptIdle();

  steps.push(
    await probeStep(
      ctx(),
      repro,
      'transcript-ready',
      'Wait for transcript on lyricedit',
      'Processing complete / Play audio',
      {
        description: 'Transcript ready (signals from processing window)',
        urlIncludes: '/lyricedit',
        snapshotIncludesAny: ['Audio transcript', 'Play audio', 'Processing complete'],
        ...STEP_BASE,
      },
      undefined,
      config.transcriptWaitMs,
    ),
  );

  nav.click({ label: 'Play audio', optional: true });
  const transcriptEdit = editTranscriptLine(browser, TRANSCRIPT_EDIT);
  steps.push(
    await probeStep(ctx(), repro, 'transcript-edit', 'Edit transcript dialogue', 'Edited text in snapshot', {
      description: 'Transcript edit',
      snapshotIncludesAny: [TRANSCRIPT_EDIT.slice(0, 20), 'QA transcript'],
      snapshotExcludes: ['Something went wrong'],
      ...STEP_BASE,
    }),
  );
  if (!transcriptEdit.ok) {
    throw new Error(`Transcript edit failed: ${transcriptEdit.detail}`);
  }

  for (const emotion of ['Excited', 'Calm', 'Dramatic', 'Somber']) {
    nav.click({ label: emotion, optional: true });
  }

  // ── BACK & FORTH (same session) ───────────────────────────────
  if (options.includeBackForth !== false) {
    const snapBeforeBack = browser.snapshotInteractive();
    if (!isButtonDisabled(snapBeforeBack, 'Go back to Story Type Selection')) {
      wizard.goBackToStoryType();
      wizard.selectConceptDriven();
      wizard.clickNext();
      wizard.waitForTranscriptReady();
      steps.push(
        await probeStep(ctx(), repro, 'nav-story-round-trip', 'Story type go-back round trip', 'Back on transcript', {
          description: 'Story type round-trip',
          urlIncludes: '/lyricedit',
          snapshotIncludesAny: ['Audio transcript', 'Play audio', TRANSCRIPT_EDIT.slice(0, 15)],
          ...STEP_BASE,
        }, undefined, config.transcriptWaitMs),
      );
    }

    try {
      wizard.clickWizardStep(audioSelectors.wizard.themeStep);
      wizard.clickWizardStep(audioSelectors.wizard.reviewStep);
    } catch {
      // non-fatal
    }
    browser.back();
    browser.wait(1200);
    browser.forward();
    browser.wait(1200);
    steps.push(
      await probeStep(ctx(), repro, 'nav-browser-history', 'Browser back/forward', 'Wizard stable', {
        description: 'Browser history on wizard',
        snapshotExcludes: ['Something went wrong'],
        snapshotIncludesAny: ['Audio transcript', 'Story Theme', 'Review transcript'],
        ...STEP_BASE,
      }),
    );
  }

  waitUntilNextEnabled(browser, config.transcriptWaitMs);
  wizard.clickNext();

  // ── STORY THEME (real dual-field edit) ────────────────────────
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'theme',
    config.transcriptWaitMs,
    'theme step',
  );

  nav.click({ label: 'Edit Text', optional: true });
  nav.click({ label: 'Describe New Theme', optional: true });
  const themeEdits = editThemeFields(browser, THEME_VISUAL, THEME_NARRATIVE);
  steps.push(
    await probeStep(ctx(), repro, 'theme-edit', 'Edit Visual Style + Narrative', 'Both fields in snapshot', {
      description: 'Theme dual-field edit',
      snapshotIncludesAny: [THEME_VISUAL.slice(0, 18), THEME_NARRATIVE.slice(0, 18)],
      snapshotExcludes: ['Something went wrong'],
      ...STEP_BASE,
    }),
  );
  if (!themeEdits.visual.ok || !themeEdits.narrative.ok) {
    throw new Error(
      `Theme edit failed: visual=${themeEdits.visual.detail}; narrative=${themeEdits.narrative.detail}`,
    );
  }

  waitUntilNextEnabled(browser, config.transcriptWaitMs);
  wizard.clickNext();

  // ── STYLE ─────────────────────────────────────────────────────
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'style',
    config.transcriptWaitMs,
    'style step',
  );

  if (options.probeStyleMatrix !== false) {
    for (const style of ['Realistic', 'Animated', 'Sketch']) {
      nav.click({ label: style, exact: true });
    }
    for (const aspect of ['Portrait', 'Landscape', 'Square']) {
      nav.click({ label: aspect, exact: true, optional: true });
    }
  }
  nav.click({ label: 'Realistic', exact: true });
  nav.click({ label: 'Landscape', exact: true, optional: true });
  nav.click({ label: 'No', exact: true, optional: true });
  wizard.dismissCreditModal();

  steps.push(
    await probeStep(ctx(), repro, 'style-selected', 'Realistic + Landscape', 'Style step ready', {
      description: 'Final style selection',
      snapshotIncludesAny: ['Realistic', 'Choose art style'],
      ...STEP_BASE,
    }),
  );

  waitUntilNextEnabled(browser, config.sceneWaitMs);
  wizard.clickNext();

  // ── LOCATIONS ─────────────────────────────────────────────────
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'locations' || detectWizardPhase(u, s) === 'edit-scenes',
    config.sceneWaitMs,
    'locations or scenes',
  );
  if (detectWizardPhase(browser.getUrl(), browser.snapshotInteractive()) === 'locations') {
    nav.click({ label: 'Add New Location', optional: true });
    wizard.clickNext();
  }

  // ── EDIT SCENES ───────────────────────────────────────────────
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'edit-scenes',
    config.sceneWaitMs,
    'edit scenes',
  );
  wizard.waitForCreateVideoReady();

  nav.click({ label: 'Select Scenes', optional: true });
  const sceneEdit = editSceneDescription(browser, SCENE_EDIT);
  nav.click({ label: 'Submit Edit', optional: true });
  nav.click({ label: 'Retake', optional: true });
  nav.click({ label: 'Reframe', optional: true });
  steps.push(
    await probeStep(ctx(), repro, 'scene-edit', 'Edit scene description + controls', 'Edit text visible', {
      description: 'Scene description edit',
      snapshotIncludesAny: [SCENE_EDIT.slice(0, 18), 'Create Video'],
      snapshotExcludes: ['Something went wrong'],
      ...STEP_BASE,
    }),
  );
  wizard.clickCreateVideo();

  // ── FINAL VIDEO ───────────────────────────────────────────────
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'final-video',
    config.finalWaitMs,
    'final video',
  );

  nav.toggleCheckbox(/captions/i);
  nav.click({ label: 'Export XML', optional: true });
  nav.click({ label: 'Edit Video', optional: true });
  const finalEdit = editFinalVideoNote(browser, FINAL_EDIT);
  steps.push(
    await probeStep(
      ctx(),
      repro,
      'final-video-edit',
      'Final video edit + controls',
      'Edit note or download UI',
      {
        description: 'Final video edit',
        urlIncludes: '/finalvideo',
        snapshotIncludesAny: ['Download Video', 'Preview', FINAL_EDIT.slice(0, 15)],
        ...STEP_BASE,
      },
      undefined,
      config.finalWaitMs,
    ),
  );
  if (!isDownloadReady(browser.snapshotInteractive())) {
    wizard.waitForDownloadReady();
  }
  nav.click({ label: 'Close', optional: true });
  nav.click({ label: 'Cancel', optional: true });
  nav.dismissOverlays();
  nav.clickIfEnabled('Download Video');
  steps.push(
    await probeStep(ctx(), repro, 'download-ready', 'Download Video enabled', 'Download clickable', {
      description: 'Download ready',
      urlIncludes: '/finalvideo',
      snapshotIncludesAny: ['Download Video', 'Downloading', 'Generating Video', 'Preview'],
      ...STEP_BASE,
    }, undefined, config.finalWaitMs),
  );

  // ── SIDEBAR ROUND-TRIP ────────────────────────────────────────
  if (options.probeSidebarRoundTrip !== false) {
    for (const step of [
      { id: 'upload', pattern: audioSelectors.wizard.uploadStep, hint: 'Upload file' },
      { id: 'story', pattern: audioSelectors.wizard.storyTypeStep, hint: 'Story Type' },
      { id: 'review', pattern: audioSelectors.wizard.reviewStep, hint: 'Review transcript' },
      { id: 'theme', pattern: audioSelectors.wizard.themeStep, hint: 'Theme' },
      { id: 'style', pattern: audioSelectors.wizard.styleStep, hint: 'Style' },
      { id: 'scenes', pattern: audioSelectors.wizard.editScenesStep, hint: 'Edit scenes' },
      { id: 'final', pattern: audioSelectors.wizard.finalVideoStep, hint: 'Final video' },
    ]) {
      try {
        wizard.clickWizardStep(step.pattern);
        steps.push(
          await probeStep(ctx(), repro, `sidebar-${step.id}`, `Sidebar: ${step.hint}`, 'Step reachable', {
            description: `Sidebar ${step.hint}`,
            snapshotIncludesAny: [step.hint, 'Download Video', 'Audio transcript', 'Story Theme'],
            snapshotExcludes: ['Something went wrong'],
            ...STEP_BASE,
          }),
        );
      } catch {
        steps.push(
          await probeStep(ctx(), repro, `sidebar-${step.id}-skip`, `Sidebar skip ${step.hint}`, 'Non-fatal', {
            description: `Sidebar skip ${step.hint}`,
            ...STEP_BASE,
          }),
        );
      }
    }
  }

  assertNoStepFailures(steps, options.scenarioId);

  return {
    id: options.scenarioId,
    name: options.scenarioName,
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export async function testAudioComplete(
  browser: AgentBrowser,
  evidenceDir: string,
  runOptions: { record?: boolean } = {},
): Promise<ScenarioResult> {
  return runAudioCompleteFlow(browser, evidenceDir, {
    audioPath: config.audio.shortWav,
    formatLabel: 'WAV (short)',
    scenarioId: 'audio-complete-wav',
    scenarioName: 'Audio complete — WAV short clip, full path + real edits',
    probeUploadAlternates: !runOptions.record,
    probeAudioTypeMatrix: true,
    probeStyleMatrix: true,
    probeSidebarRoundTrip: true,
    includeBackForth: true,
  });
}

/** @deprecated Use testAudioComplete */
export const testAudioFullCoverage = testAudioComplete;
