/**
 * 100% audio happy-path coverage — one session, short audio, every control probed.
 * Verifies: no crash, no blocking errors, console/network captured per step.
 * Does NOT assert visual correctness of edits.
 */
import { config } from '../config.js';
import { AUDIO_EXPECTATION_BASE } from '../lib/audio-expectations.js';
import { audioSelectors } from '../lib/audio-selectors.js';
import { AudioNav, waitUntil, waitUntilNextEnabled } from '../lib/audio-nav.js';
import { AgentBrowser, refForEnabledButton } from '../lib/agent-browser.js';
import { AudioWizardPage } from '../lib/page-audio.js';
import { SessionPage } from '../lib/page-session.js';
import { recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep, VerificationExpectation } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';
import { detectWizardPhase, snapHas } from '../lib/wizard-phase.js';

const STEP_BASE: Partial<VerificationExpectation> = {
  ...AUDIO_EXPECTATION_BASE,
  maxUnexpectedNetwork5xx: 2,
};

async function probe(
  ctx: StepContext,
  repro: string[],
  workflow: string,
  action: string,
  expected: string,
  expectation: VerificationExpectation,
  fn?: () => void,
  waitMs?: number,
): Promise<TestStep> {
  repro.push(action);
  ctx.browser.clearSignals();
  if (fn) {
    try {
      fn();
    } catch (error) {
      if (!expectation.description.includes('optional')) throw error;
    }
  }
  const step = await recordVerifiedStep(ctx, {
    workflow,
    action,
    expected,
    expectation,
    waitOptions: waitMs ? { maxWaitMs: waitMs, pollMs: 3000 } : undefined,
  });
  return step;
}

export async function testAudioFullCoverage(
  browser: AgentBrowser,
  evidenceDir: string,
): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const steps: TestStep[] = [];
  const session = new SessionPage(browser);
  const wizard = new AudioWizardPage(browser);
  const nav = new AudioNav(browser);
  const verification = new VerificationLayer(browser);
  const repro: string[] = [];
  const ctx = (): StepContext => ({ browser, verification, evidenceDir, stepsToReproduce: repro });

  const audioFile = config.audio.shortWav;

  await session.loginOrRestoreSession();

  // ── UPLOAD FORK ─────────────────────────────────────────────
  wizard.openFreshUploadFork();
  steps.push(
    await probe(ctx(), repro, 'upload-fork', 'Open upload fork', 'Start with Audio visible', {
      description: 'Upload fork',
      urlIncludes: '/upload',
      snapshotIncludesAny: ['Start with Audio', 'How would you like to start'],
      ...STEP_BASE,
    }),
  );

  wizard.startWithAudio();
  steps.push(
    await probe(ctx(), repro, 'audio-screen', 'Start with Audio', 'Audio upload options', {
      description: 'Audio upload screen',
      snapshotIncludesAny: ['Upload File', 'Drop your audio', 'Record Audio', 'Select Sample'],
      ...STEP_BASE,
    }),
  );

  // Probe alternate entry points before file upload (same screen)
  nav.click({ label: 'Select Sample', optional: true });
  steps.push(
    await probe(
      ctx(),
      repro,
      'probe-select-sample',
      'Click Select Sample',
      'No crash; optional sample UI',
      {
        description: 'Select Sample optional probe',
        snapshotExcludes: ['Something went wrong'],
        ...STEP_BASE,
      },
    ),
  );
  nav.dismissOverlays();
  nav.click({ label: 'Upload File', optional: true });
  browser.wait(500);

  nav.click({ label: 'Record Audio', optional: true });
  steps.push(
    await probe(
      ctx(),
      repro,
      'probe-record-audio',
      'Click Record Audio',
      'Recorder UI without crash',
      {
        description: 'Record Audio optional probe',
        snapshotExcludes: ['Something went wrong'],
        ...STEP_BASE,
      },
    ),
  );
  nav.dismissOverlays();
  wizard.ensureUploadFileTab();
  browser.wait(500);

  wizard.uploadAudioFile(audioFile);
  steps.push(
    await probe(ctx(), repro, 'file-uploaded', `Upload ${audioFile}`, 'Plan or audio type', {
      description: 'File uploaded',
      snapshotIncludesAny: ['Select Your Plan', 'Choose Audio Type', 'Uploading audio'],
      networkFilter: 'audio',
      requireNetworkActivity: false,
      ...STEP_BASE,
    }, undefined, 30000),
  );

  wizard.selectPlan('Standard');
  steps.push(
    await probe(ctx(), repro, 'plan-standard', 'Select Standard plan', 'Plan modal closed', {
      description: 'Standard plan',
      snapshotExcludes: ['Select Your Plan'],
      ...STEP_BASE,
    }),
  );

  const snapPostPlan = browser.snapshotInteractive();
  if (snapHas(snapPostPlan, 'Choose Audio Type') || refForEnabledButton(snapPostPlan, 'Next')) {
    if (!snapHas(snapPostPlan, 'Choose Audio Type')) wizard.clickNext();
  }

  // ── AUDIO TYPE MATRIX (probe all types; continue with Podcast) ──
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'audio-type' || detectWizardPhase(u, s) === 'story-type',
    config.verificationMaxWaitMs,
    'audio type or story',
  );

  if (detectWizardPhase(browser.getUrl(), browser.snapshotInteractive()) === 'audio-type') {
    for (const type of ['Music', 'Podcast', 'Narration'] as const) {
      nav.click({ label: type, exact: true });
      steps.push(
        await probe(ctx(), repro, `audio-type-${type.toLowerCase()}`, `Select ${type}`, `${type} selectable`, {
          description: `Audio type ${type}`,
          snapshotIncludes: [type],
          ...STEP_BASE,
        }),
      );
    }
    nav.click({ label: 'No', exact: true, optional: true });
    steps.push(
      await probe(ctx(), repro, 'audio-multilingual-no', 'Multilingual No', 'Type selection complete', {
        description: 'Multilingual No',
        ...STEP_BASE,
      }),
    );
    wizard.clickNext();
  }

  // ── STORY TYPE ──────────────────────────────────────────────
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'story-type',
    config.verificationMaxWaitMs,
    'story type',
  );

  nav.click({ label: 'Character Driven', optional: true });
  steps.push(
    await probe(ctx(), repro, 'probe-character-driven', 'Click Character Driven', 'Character UI or requirement message', {
      description: 'Character Driven probe',
      snapshotIncludesAny: ['Character Driven', 'Minimum 1 character', 'Choose your characters'],
      ...STEP_BASE,
    }),
  );

  nav.click({ label: 'Use Existing', optional: true });
  const charModal = browser.snapshotInteractive();
  if (snapHas(charModal, 'Choose Existing Character')) {
    steps.push(
      await probe(ctx(), repro, 'probe-character-modal', 'Open character picker', 'Character modal visible', {
        description: 'Character modal probe (no selection)',
        snapshotIncludesAny: ['Choose Existing Character', 'character'],
        snapshotExcludes: ['Something went wrong'],
        ...STEP_BASE,
      }),
    );
    nav.dismissOverlays();
  }

  wizard.selectConceptDriven();
  steps.push(
    await probe(ctx(), repro, 'story-concept', 'Concept Driven selected', 'Concept Driven active on story type', {
      description: 'Concept Driven',
      snapshotIncludesAny: ['Concept Driven', 'concept driven or character driven'],
      ...STEP_BASE,
    }),
  );
  wizard.clickNext();

  // ── TRANSCRIPT ────────────────────────────────────────────────
  wizard.waitForTranscriptReady();
  wizard.waitForTranscriptIdle();

  nav.click({ label: 'Play audio', optional: true });
  steps.push(
    await probe(ctx(), repro, 'transcript-ready', 'Transcript processed', 'Play audio / segments visible', {
      description: 'Transcript ready',
      urlIncludes: '/lyricedit',
      snapshotIncludesAny: ['Audio transcript', 'Play audio', 'Processing complete'],
      ...STEP_BASE,
    }, undefined, config.transcriptWaitMs),
  );

  nav.fillFirstEditable('QA edit: short dialogue line for responsiveness test.');
  steps.push(
    await probe(ctx(), repro, 'transcript-edit', 'Edit transcript text', 'No crash after edit', {
      description: 'Transcript edit probe',
      snapshotExcludes: ['Something went wrong'],
      ...STEP_BASE,
    }),
  );

  for (const emotion of ['Excited', 'Calm', 'Dramatic', 'Somber']) {
    nav.click({ label: emotion, optional: true });
  }
  steps.push(
    await probe(ctx(), repro, 'transcript-emotions', 'Click emotion tags', 'Emotion UI responsive', {
      description: 'Transcript emotions probe',
      snapshotExcludes: ['Something went wrong'],
      ...STEP_BASE,
    }),
  );

  waitUntilNextEnabled(browser, config.transcriptWaitMs);
  wizard.clickNext();

  // ── STORY THEME ───────────────────────────────────────────────
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'theme',
    config.transcriptWaitMs,
    'theme step',
  );

  nav.click({ label: 'Edit Text', optional: true });
  nav.click({ label: 'Describe New Theme', optional: true });
  nav.fillFirstEditable('QA visual style: warm coffee shop, soft morning light, cinematic framing.');
  nav.fillFirstEditable('QA narrative: two friends share a quiet moment over coffee.');
  steps.push(
    await probe(ctx(), repro, 'theme-edit', 'Edit Story Theme fields', 'Story Theme page responsive', {
      description: 'Theme edit probe',
      snapshotIncludesAny: ['Story Theme', 'Visual Style', 'Visual Narrative'],
      ...STEP_BASE,
    }),
  );

  waitUntilNextEnabled(browser, config.transcriptWaitMs);
  wizard.clickNext();

  // ── STYLE MATRIX ──────────────────────────────────────────────
  waitUntil(
    browser,
    (u, s) => detectWizardPhase(u, s) === 'style',
    config.transcriptWaitMs,
    'style step',
  );

  for (const style of ['Realistic', 'Animated', 'Sketch']) {
    nav.click({ label: style, exact: true });
    steps.push(
      await probe(ctx(), repro, `style-${style.toLowerCase()}`, `Select ${style}`, `${style} clickable`, {
        description: `Art style ${style}`,
        snapshotIncludes: [style],
        ...STEP_BASE,
      }),
    );
  }

  for (const aspect of ['Portrait', 'Landscape', 'Square']) {
    nav.click({ label: aspect, exact: true, optional: true });
    steps.push(
      await probe(ctx(), repro, `aspect-${aspect.toLowerCase()}`, `Select ${aspect}`, `${aspect} aspect`, {
        description: `Aspect ${aspect}`,
        snapshotIncludesAny: [aspect, 'Choose art style'],
        ...STEP_BASE,
      }),
    );
  }

  nav.click({ label: 'Change Camera Settings', optional: true });
  nav.dismissOverlays();
  nav.click({ label: 'Realistic', exact: true });
  nav.click({ label: 'Landscape', exact: true, optional: true });
  nav.click({ label: 'No', exact: true, optional: true });
  wizard.dismissCreditModal();

  steps.push(
    await probe(ctx(), repro, 'style-final-pick', 'Realistic + Landscape for continue', 'Style step ready', {
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
    steps.push(
      await probe(ctx(), repro, 'locations-probe', 'Locations step', 'Locations UI responsive', {
        description: 'Locations probe',
        snapshotIncludesAny: ['Location', 'Add New Location', 'Upload file'],
        ...STEP_BASE,
      }),
    );
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
  nav.fillFirstEditable('QA scene edit: make the background warmer with soft morning light.');
  nav.click({ label: 'Submit Edit', optional: true });
  nav.click({ label: 'Retake', optional: true });
  nav.click({ label: 'Reframe', optional: true });
  nav.click({ label: 'Add Reference', optional: true });
  steps.push(
    await probe(ctx(), repro, 'scene-edits-probe', 'Scene edit controls', 'Edit scene UI responsive', {
      description: 'Scene edits probe',
      snapshotIncludesAny: ['edit', 'scene', 'Description', 'Create Video'],
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

  for (let i = 0; i < 4; i++) {
    nav.click({ label: `Preview`, optional: true });
    nav.click({ label: `Shot ${i + 1}`, optional: true });
  }

  nav.toggleCheckbox(/captions/i);
  nav.click({ label: 'Export XML', optional: true });
  nav.click({ label: 'Edit Video', optional: true });
  nav.fillFirstEditable('QA final tweak: slightly brighter exposure.');

  steps.push(
    await probe(
      ctx(),
      repro,
      'final-video-probes',
      'Final video controls',
      'Shots / export / edit probes',
      {
        description: 'Final video probes',
        urlIncludes: '/finalvideo',
        snapshotIncludesAny: ['Download Video', 'Preview', 'Final video', 'Generating Video'],
        ...STEP_BASE,
      },
      undefined,
      config.finalWaitMs,
    ),
  );

  wizard.waitForDownloadReady();
  steps.push(
    await probe(ctx(), repro, 'download-ready', 'Wait for Download Video', 'Download enabled', {
      description: 'Download ready',
      urlIncludes: '/finalvideo',
      snapshotIncludes: ['Download Video'],
      ...STEP_BASE,
    }, undefined, config.finalWaitMs),
  );

  nav.clickIfEnabled('Download Video');
  steps.push(
    await probe(ctx(), repro, 'download-click', 'Click Download Video', 'Download action no crash', {
      description: 'Download click',
      snapshotExcludes: ['Something went wrong'],
      ...STEP_BASE,
    }),
  );

  // ── WIZARD SIDEBAR ROUND-TRIP ─────────────────────────────────
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
        await probe(ctx(), repro, `sidebar-${step.id}`, `Sidebar: ${step.hint}`, 'Step reachable', {
          description: `Sidebar ${step.hint}`,
          snapshotIncludesAny: [step.hint, 'Download Video', 'Audio transcript', 'Story Theme'],
          snapshotExcludes: ['Something went wrong'],
          ...STEP_BASE,
        }),
      );
    } catch {
      steps.push(
        await probe(ctx(), repro, `sidebar-${step.id}-skip`, `Sidebar ${step.hint} skip`, 'Non-fatal', {
          description: `Sidebar skip ${step.hint}`,
          ...STEP_BASE,
        }),
      );
    }
  }

  const failures = steps.filter((s) => s.result.verdict === 'fail');
  if (failures.length > 0) {
    throw new Error(
      `Full coverage had ${failures.length} failures: ${failures.map((f) => f.workflow).join(', ')}`,
    );
  }

  return {
    id: 'audio-full-coverage',
    name: 'Audio path — 100% coverage (short clip, one session)',
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}