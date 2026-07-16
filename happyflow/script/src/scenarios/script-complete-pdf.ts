/**
 * Script path E2E — short PDF, LLM navigation, real edits, back-forth, random character.
 */
import { config } from '../config.js';
import {
  editFinalVideoNote,
  editSceneDescription,
  editScriptDialogue,
  editThemeFields,
  randomCharacter,
  randomEditMarker,
  snapshotHasText,
} from '../lib/script-edits.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { SessionPage } from '../lib/page-session.js';
import { ScriptNavigator } from '../lib/script-navigator.js';
import { ScriptNav } from '../lib/script-nav.js';
import { isDownloadReady, isFinalVideoVisible } from '../lib/script-selectors.js';
import { assertNoStepFailures, probeStep, STEP_BASE } from '../lib/script-scenario-helpers.js';
import type { StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

export interface ScriptCompleteFlowOptions {
  scriptPath: string;
  formatLabel: string;
  scenarioId: string;
  scenarioName: string;
  tryRandomCharacter?: boolean;
  includeBackForth?: boolean;
  probeSidebarRoundTrip?: boolean;
}

export async function runScriptCompleteFlow(
  browser: AgentBrowser,
  evidenceDir: string,
  options: ScriptCompleteFlowOptions,
): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const steps: TestStep[] = [];
  const session = new SessionPage(browser);
  const nav = new ScriptNavigator(browser);
  const uiNav = new ScriptNav(browser);
  const verification = new VerificationLayer(browser);
  const repro: string[] = [];
  const ctx = (): StepContext => ({ browser, verification, evidenceDir, stepsToReproduce: repro });

  const character = randomCharacter();
  const transcriptEdit = randomEditMarker('QA script line');
  const themeVisual = randomEditMarker('QA visual style warm coffee shop');
  const themeNarrative = randomEditMarker('QA narrative quiet morning moment');
  const sceneEdit = randomEditMarker('QA scene warmer light');
  const finalEdit = randomEditMarker('QA final brighter faces');

  await session.loginOrRestoreSession();

  // ── UPLOAD FORK ─────────────────────────────────────────────
  nav.openUploadFork();
  const forkExplore = await nav.startWithScript();
  steps.push(
    await probeStep(
      ctx(), repro, 'upload-fork', 'Start with Script', 'Script upload UI',
      {
        description: 'Script upload fork',
        urlIncludes: '/upload',
        snapshotIncludesAny: ['Upload Your Script', 'Choose PDF'],
        snapshotExcludes: ['How would you like to start?'],
        ...STEP_BASE,
      },
      undefined,
      30_000,
      forkExplore ?? undefined,
    ),
  );
  assertNoStepFailures(steps, options.scenarioId);

  // ── FILE UPLOAD (mechanical) ──────────────────────────────────
  nav.uploadScriptFile(options.scriptPath);
  await nav.waitForPhase(['plan-modal', 'processing', 'story-type', 'script-upload'], 90_000);
  steps.push(
    await probeStep(
      ctx(), repro, 'file-uploaded', `Upload ${options.formatLabel}`, 'Plan or processing',
      {
        description: 'PDF uploaded',
        snapshotIncludesAny: ['Select Your Plan', 'Processing', 'Story Type', 'Edit Script'],
        snapshotExcludes: ['How would you like to start?'],
        ...STEP_BASE,
      },
      undefined,
      30_000,
    ),
  );

  // ── PLAN ──────────────────────────────────────────────────────
  if (nav.phase() === 'plan-modal' || nav.snapIncludes('Select Your Plan')) {
    const planOk = await nav.selectStandardPlanDeterministic();
    const planExplore = planOk ? undefined : await nav.selectStandardPlan();
    steps.push(
      await probeStep(
        ctx(), repro, 'plan-standard', 'Standard plan', 'Past plan modal',
        {
          description: 'Standard plan',
          snapshotExcludes: ['Select Your Plan', 'How would you like to start?'],
          snapshotIncludesAny: ['Story Type', 'Concept Driven', 'Character Driven', 'Edit Script', 'Processing'],
          ...STEP_BASE,
        },
        undefined,
        undefined,
        planOk ? undefined : planExplore,
      ),
    );
  }

  // Advance past upload — dismiss bug modal, sidebar Story Type, then Next
  for (let i = 0; i < 6; i++) {
    nav.wizard.dismissOverlays();
    if (nav.phase() === 'story-type' || nav.snapIncludes('Concept Driven', 'Character Driven')) break;
    if (nav.wizard.clickSidebarStep('Story Type')) {
      browser.wait(3000);
      if (nav.phase() === 'story-type' || nav.snapIncludes('Concept Driven', 'Character Driven')) break;
    }
    nav.wizard.clickNextRobust();
    browser.wait(3000);
  }

  await nav.recoverWizardIfLost();

  const uploadAdvanced = await nav.advanceUploadToStoryType();
  steps.push(
    await probeStep(
      ctx(), repro, 'advance-to-story-type', 'Next from upload → Story Type', 'Concept/Character screen',
      {
        description: 'Advance to story type',
        snapshotIncludesAny: ['Concept Driven', 'Character Driven', 'concept driven or character driven'],
        snapshotExcludes: ['No dialogue found'],
        ...STEP_BASE,
      },
      undefined,
      30_000,
    ),
  );

  // ── STORY TYPE: Concept Driven first (reliable for short PDF) ─
  let storyTypeDone = uploadAdvanced && (await nav.completeStoryTypeConcept());
  if (!storyTypeDone || browser.getUrl().includes('lyricedit')) {
    storyTypeDone = await nav.resetToConceptDriven();
  }
  if (browser.getUrl().includes('lyricedit') || nav.snapIncludes('No dialogue found', 'Audio transcript')) {
    storyTypeDone = await nav.recoverFromWrongTranscriptStep();
  }
  steps.push(
    await probeStep(
      ctx(), repro, 'story-type-concept', 'Concept Driven + Next', 'Processing or script edit',
      {
        description: 'Concept Driven story type',
        snapshotIncludesAny: [
          'Edit Script',
          'Processing',
          'Processing Script',
          'Concept Driven',
          'scriptEdit',
        ],
        snapshotExcludes: ['No dialogue found', 'Audio transcript'],
        ...STEP_BASE,
      },
      undefined,
      30_000,
    ),
  );

  if (!storyTypeDone) {
    assertNoStepFailures(steps, options.scenarioId);
    return finish(options, steps, startedAt);
  }

  // ── SCRIPT EDIT ───────────────────────────────────────────────
  await nav.recoverWizardIfLost();
  if (browser.getUrl().includes('lyricedit')) {
    await nav.recoverFromWrongTranscriptStep();
  }
  const editPhase = await nav.waitForScriptEditReady();
  if (editPhase === 'error' || nav.phase() !== 'script-edit') {
    steps.push(
      await probeStep(ctx(), repro, 'script-edit-ready', 'Script edit ready', 'Edit Script + dialogue', {
        description: 'Script edit failed or wrong page',
        urlIncludes: '/scriptEdit',
        snapshotIncludesAny: ['Edit Script', 'Play audio', 'Barista', 'Customer'],
        ...STEP_BASE,
      }, undefined, config.scriptProcessingWaitMs),
    );
    assertNoStepFailures(steps, options.scenarioId);
    return finish(options, steps, startedAt);
  }

  steps.push(
    await probeStep(
      ctx(), repro, 'script-edit-ready', 'Script edit ready', 'Edit Script + dialogue',
      {
        description: 'Script edit reached',
        urlIncludes: '/scriptEdit',
        snapshotIncludesAny: ['Edit Script', 'Play audio', 'Barista', 'Customer'],
        ...STEP_BASE,
      },
      undefined,
      config.scriptProcessingWaitMs,
    ),
  );

  // Optional: probe random character — always restore script edit afterward
  if (options.tryRandomCharacter !== false) {
    await nav.probeRandomCharacter(character.name, character.description);
    steps.push(
      await probeStep(
        ctx(), repro, 'random-character-probe', `Probe character ${character.tag}`, 'Character UI explored',
        {
          description: 'Random character probe (optional)',
          snapshotIncludesAny: [character.tag, 'Character Driven', 'Add Character', 'Edit Script'],
          ...STEP_BASE,
        },
        undefined,
        60_000,
      ),
    );
    await nav.ensureOnScriptEdit();
  }

  // Mechanical edit on script edit — LLM fallback
  await nav.ensureOnScriptEdit();
  let dialogueResult = editScriptDialogue(browser, transcriptEdit);
  if (!dialogueResult.ok) {
    const llmEdit = await nav.editFieldViaLlm('dialogue line', transcriptEdit);
    dialogueResult = {
      ok: llmEdit.ok || snapshotHasText(browser, transcriptEdit.slice(0, 15)),
      detail: llmEdit.ok ? 'LLM dialogue edit' : llmEdit.result.error ?? 'dialogue edit failed',
    };
  }

  uiNav.click({ label: 'Play audio', optional: true });

  steps.push(
    await probeStep(
      ctx(), repro, 'script-dialogue-edit', 'Edit script dialogue', 'Edited text visible',
      {
        description: 'Script dialogue edit',
        urlIncludes: '/scriptEdit',
        snapshotIncludesAny: [transcriptEdit.slice(0, 18), 'QA script line'],
        ...STEP_BASE,
      },
    ),
  );

  // ── BACK & FORTH (only when still on script edit) ─────────────
  if (options.includeBackForth !== false && nav.phase() === 'script-edit') {
    const backExplore = await nav.goBackToStoryTypeAndReturn();
    steps.push(
      await probeStep(
        ctx(), repro, 'nav-story-round-trip', 'Go back to Story Type + return', 'Edit Script again',
        {
          description: 'Story type round-trip',
          urlIncludes: '/scriptEdit',
          snapshotIncludesAny: ['Edit Script', transcriptEdit.slice(0, 12), 'Play audio'],
          ...STEP_BASE,
        },
        undefined,
        config.scriptProcessingWaitMs,
        backExplore ?? undefined,
      ),
    );

    await nav.waitForScriptEditIdle(config.scriptProcessingWaitMs);

    nav.browserHistoryProbe();
    steps.push(
      await probeStep(
        ctx(), repro, 'nav-browser-history', 'Browser back/forward', 'Wizard stable',
        {
          description: 'Browser history',
          snapshotExcludes: ['Something went wrong'],
          snapshotIncludesAny: ['Edit Script', 'Story Theme', 'Theme'],
          ...STEP_BASE,
        },
      ),
    );
  }

  await nav.waitForScriptEditIdle(config.scriptProcessingWaitMs);
  const advanceEdit = await nav.advanceFromScriptEdit();
  steps.push(
    await probeStep(
      ctx(), repro, 'advance-theme', 'Next from script edit', 'Theme step',
      {
        description: 'Advance to theme',
        snapshotIncludesAny: ['Story Theme', 'Visual Style', 'selectTheme'],
        ...STEP_BASE,
      },
      undefined,
      60_000,
      advanceEdit ?? undefined,
    ),
  );

  // ── THEME EDITS ───────────────────────────────────────────────
  // Theme textboxes are React-controlled + require Save. Old path set el.value
  // without Save, then re-ran mechanical fill after LLM and wiped success.
  await nav.waitForPhase(['theme', 'style'], 60_000);
  uiNav.click({ label: 'Describe new theme', optional: true });
  uiNav.click({ label: 'Edit Text', optional: true });

  let themeEdits = editThemeFields(browser, themeVisual, themeNarrative);
  let themeExplore: Awaited<ReturnType<typeof nav.editFieldViaLlm>> | undefined;
  if (!themeEdits.visual.ok || !themeEdits.narrative.ok) {
    themeExplore = await nav.editFieldViaLlm(
      'Visual Style and Visual Narrative',
      `${themeVisual}|||${themeNarrative}`,
    );
    // Re-apply once with Save after LLM (do not loop mechanical fills that skip Save).
    themeEdits = editThemeFields(browser, themeVisual, themeNarrative);
  }
  uiNav.dismissOverlays();
  nav.wizard.dismissOverlays();

  const themeOk =
    snapshotHasText(browser, themeVisual) || snapshotHasText(browser, themeNarrative);
  steps.push(
    await probeStep(
      ctx(), repro, 'theme-edit', 'Edit theme fields + Save', 'QA markers in snapshot after Save',
      {
        description: themeOk
          ? 'Theme dual-field edit'
          : 'Theme dual-field edit (product: edits must persist after Save)',
        snapshotIncludesAny: [themeVisual.slice(0, 16), themeNarrative.slice(0, 16), 'QA visual', 'QA narrative'],
        ...STEP_BASE,
      },
      undefined,
      undefined,
      themeExplore,
    ),
  );
  // If theme text still missing after fill+Save+LLM, annotate as product bug signal
  if (!themeOk) {
    const last = steps[steps.length - 1]!;
    last.result.reasons = [
      ...last.result.reasons,
      'PRODUCT_BUG: Theme Visual Style/Narrative did not retain QA edit after Save — Koyal theme fields rejected or reverted the edit',
      `visual=${themeEdits.visual.detail}; narrative=${themeEdits.narrative.detail}`,
    ];
    last.result.severity = 'high';
    last.result.verdict = 'fail';
  }

  const themeAdvance = await nav.advanceFromTheme();
  steps.push(
    await probeStep(
      ctx(), repro, 'advance-style', 'Next from theme', 'Style step',
      {
        description: 'Advance to style',
        snapshotIncludesAny: ['Choose art style', 'Realistic', 'selectStyle'],
        ...STEP_BASE,
      },
      undefined,
      60_000,
      themeAdvance ?? undefined,
    ),
  );

  // ── STYLE ─────────────────────────────────────────────────────
  const styleExplore = await nav.completeStyleStep();
  steps.push(
    await probeStep(
      ctx(), repro, 'style-complete', 'Style + dismiss credits', 'Past style',
      {
        description: 'Style step',
        snapshotIncludesAny: ['Edit scenes', 'Create Video', 'Location', 'editscene'],
        ...STEP_BASE,
      },
      undefined,
      config.sceneWaitMs,
      styleExplore ?? undefined,
    ),
  );

  if (!['edit-scenes', 'final-video', 'locations'].includes(nav.phase())) {
    nav.wizard.clickSidebarStep('Edit scenes');
    nav.wizard.clickNextRobust();
  }

  // ── LOCATIONS (optional) ──────────────────────────────────────
  if (nav.phase() === 'locations') {
    const locExplore = await nav.advanceFromLocations();
    steps.push(
      await probeStep(
        ctx(), repro, 'locations', 'Locations step', 'Edit scenes',
        {
          description: 'Locations',
          snapshotIncludesAny: ['Edit scenes', 'Create Video', 'editscene'],
          ...STEP_BASE,
        },
        undefined,
        config.sceneWaitMs,
        locExplore,
      ),
    );
  }

  // ── EDIT SCENES ───────────────────────────────────────────────
  await nav.recoverFromBlankOrLost();
  await nav.waitForPhase(['edit-scenes', 'final-video', 'locations'], config.sceneWaitMs, 5000);
  nav.wizard.dismissOverlays();

  if (nav.phase() === 'locations') {
    uiNav.click({ label: 'Add New Location', optional: true });
    nav.wizard.clickNext();
    await nav.waitForPhase(['edit-scenes', 'final-video'], config.sceneWaitMs, 5000);
  }

  nav.wizard.dismissEditPanels();

  let sceneResult = editSceneDescription(browser, sceneEdit);
  if (!sceneResult.ok) {
    await nav.editFieldViaLlm('scene description', sceneEdit);
  }
  uiNav.click({ label: 'Submit Edit', optional: true });
  uiNav.click({ label: 'Retake', optional: true });
  uiNav.click({ label: 'Reframe', optional: true });

  steps.push(
    await probeStep(
      ctx(), repro, 'scene-edit', 'Edit scene description', 'QA marker visible',
      {
        description: 'Scene description edit',
        snapshotIncludesAny: [sceneEdit.slice(0, 16), 'Create Video', 'Edit scenes'],
        ...STEP_BASE,
      },
    ),
  );

  nav.wizard.dismissEditPanels();
  let sceneExplore = null;
  let createVideoBlankBug = false;
  try {
    nav.wizard.waitForCreateVideoReady();
    nav.wizard.clickCreateVideo();
    browser.wait(2500);
    // Create Video on Koyal sometimes nukes the tab to about:blank — recover immediately
    // (do NOT burn sceneWaitMs waiting; recovery must run before any waitUntil).
    if (/about:blank/i.test(browser.getUrl())) {
      createVideoBlankBug = true;
      console.warn(
        '[script] PRODUCT_BUG: Create Video navigated to about:blank — recovering wizard',
      );
      await nav.recoverFromBlankOrLost();
      if (!nav.wizard.clickSidebarStep('Final video')) {
        const base = config.baseUrl.replace(/\/$/, '');
        browser.open(`${base}${config.paths.finalvideo}`);
        browser.wait(3000);
      }
      await nav.recoverFromBlankOrLost();
    }
  } catch {
    sceneExplore = await nav.editSceneAndCreateVideo(sceneEdit.slice(0, 30));
  }

  // waitForPhase recovers about:blank mid-poll; bare waitUntil used to throw after 240s first.
  let afterCreate = await nav.waitForPhase(
    ['final-video', 'edit-scenes'],
    config.sceneWaitMs,
    5000,
  );
  if (afterCreate !== 'final-video') {
    if (/about:blank/i.test(browser.getUrl())) {
      createVideoBlankBug = true;
      await nav.recoverFromBlankOrLost();
    }
    nav.wizard.clickSidebarStep('Final video');
    afterCreate = await nav.waitForPhase(['final-video'], 120_000, 5000);
  }

  steps.push(
    await probeStep(
      ctx(), repro, 'scene-edit-create', 'Create Video', 'Final video step',
      {
        description: createVideoBlankBug
          ? 'Create Video (product: navigated to about:blank)'
          : 'Scene edit and create video',
        snapshotIncludesAny: [
          sceneEdit.slice(0, 14),
          'finalvideo',
          'Download Video',
          'Generating Video',
          'Preview',
          'Edit scenes',
          'Create Video',
        ],
        ...STEP_BASE,
      },
      undefined,
      config.sceneWaitMs,
      sceneExplore ?? undefined,
    ),
  );
  if (createVideoBlankBug) {
    const last = steps[steps.length - 1]!;
    last.result.reasons = [
      ...last.result.reasons,
      'PRODUCT_BUG: Clicking Create Video navigated the browser to about:blank instead of /finalvideo',
    ];
    last.result.severity = 'critical';
    if (afterCreate !== 'final-video') {
      last.result.verdict = 'fail';
    }
  }

  // ── FINAL VIDEO ───────────────────────────────────────────────
  await nav.recoverFromBlankOrLost();
  await nav.waitForPhase(['final-video'], config.finalWaitMs, 5000);
  if (nav.phase() !== 'final-video') {
    await nav.waitForPhase(['final-video'], config.finalWaitMs, 5000);
  }

  uiNav.toggleCheckbox(/captions/i);
  uiNav.click({ label: 'Export XML', optional: true });
  uiNav.click({ label: 'Edit Video', optional: true });
  let finalResult = editFinalVideoNote(browser, finalEdit);
  if (!finalResult.ok) {
    await nav.editFieldViaLlm('final video edit', finalEdit);
  }

  steps.push(
    await probeStep(
      ctx(), repro, 'final-video-edit', 'Final video edit + controls', 'Edit note or preview',
      {
        description: 'Final video edit',
        urlIncludes: '/finalvideo',
        snapshotIncludesAny: ['Download Video', 'Preview', 'Generating Video', finalEdit.slice(0, 12)],
        ...STEP_BASE,
      },
      undefined,
      config.finalWaitMs,
    ),
  );

  let finalExplore = null;
  const finalSnap = browser.snapshotInteractive();
  if (!isDownloadReady(finalSnap) && !isFinalVideoVisible(finalSnap, browser.getUrl())) {
    try {
      nav.wizard.waitForDownloadReady();
    } catch {
      finalExplore = await nav.completeFinalVideo();
    }
  }
  uiNav.dismissOverlays();
  uiNav.clickIfEnabled('Download Video');

  steps.push(
    await probeStep(
      ctx(), repro, 'download-ready', 'Download Video ready', 'Download or generating',
      {
        description: 'Download ready',
        urlIncludes: '/finalvideo',
        snapshotIncludesAny: ['Download Video', 'Downloading', 'Generating Video', 'Preview'],
        ...STEP_BASE,
      },
      undefined,
      config.finalWaitMs,
      finalExplore ?? undefined,
    ),
  );

  // ── SIDEBAR ROUND-TRIP ────────────────────────────────────────
  if (options.probeSidebarRoundTrip !== false) {
    const sidebarExplore = await nav.sidebarRoundTrip();
    steps.push(
      await probeStep(
        ctx(), repro, 'sidebar-round-trip', 'Wizard sidebar round-trip (LLM)', 'All steps reachable',
        {
          description: 'Sidebar navigation',
          snapshotIncludesAny: ['Final video', 'Download Video', 'Edit Script', 'Story Theme'],
          snapshotExcludes: ['Something went wrong'],
          ...STEP_BASE,
        },
        undefined,
        60_000,
        sidebarExplore,
      ),
    );
  }

  // Do not throw here — return the scenario so report.md + BUGS.md are always written.
  const failures = steps.filter((s) => s.result.verdict === 'fail');
  if (failures.length) {
    console.error(
      `\n⚠ ${options.scenarioId}: ${failures.length} failure(s): ${failures.map((f) => f.workflow).join(', ')}`,
    );
    for (const f of failures) {
      const product = f.result.reasons.some((r) => /PRODUCT_BUG/i.test(r));
      console.error(
        `  - ${f.workflow}: ${product ? 'PRODUCT BUG' : 'FAIL'} — ${f.result.reasons.slice(0, 2).join('; ')}`,
      );
    }
  }
  return finish(options, steps, startedAt);
}

function finish(
  options: ScriptCompleteFlowOptions,
  steps: TestStep[],
  startedAt: string,
): ScenarioResult {
  return {
    id: options.scenarioId,
    name: options.scenarioName,
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export async function testScriptCompletePdf(
  browser: AgentBrowser,
  evidenceDir: string,
): Promise<ScenarioResult> {
  return runScriptCompleteFlow(browser, evidenceDir, {
    scriptPath: config.script.shortPdf,
    formatLabel: 'PDF (5-second)',
    scenarioId: 'script-complete-pdf',
    scenarioName: 'Script complete — short PDF, LLM nav, edits, character, back-forth',
    tryRandomCharacter: true,
    includeBackForth: true,
    probeSidebarRoundTrip: true,
  });
}
