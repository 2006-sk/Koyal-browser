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
      ctx(), repro, 'upload-fork', 'Start with Script (LLM)', 'Script upload UI',
      {
        description: 'Script upload fork',
        urlIncludes: '/upload',
        snapshotIncludesAny: ['Upload Your Script', 'Upload file', 'script', 'PDF'],
        ...STEP_BASE,
      },
      undefined,
      undefined,
      forkExplore,
    ),
  );

  // ── FILE UPLOAD (mechanical) ──────────────────────────────────
  nav.uploadScriptFile(options.scriptPath);
  await nav.waitForPhase(['plan-modal', 'processing', 'story-type', 'script-upload'], 90_000);
  steps.push(
    await probeStep(
      ctx(), repro, 'file-uploaded', `Upload ${options.formatLabel}`, 'Plan or processing',
      {
        description: 'PDF uploaded',
        snapshotIncludesAny: ['Select Your Plan', 'Standard', 'Processing', 'Story Type'],
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
          snapshotExcludes: ['Select Your Plan'],
          ...STEP_BASE,
        },
        undefined,
        undefined,
        planOk ? undefined : planExplore,
      ),
    );
  }

  // Click Next once right after plan — no overlay dismiss (Escape/× closes wizard)
  nav.wizard.clickNext();
  browser.wait(3000);

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

  // Optional: probe random character via sidebar (non-blocking)
  if (options.tryRandomCharacter !== false) {
    const charOk = await nav.probeRandomCharacter(character.name, character.description);
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
    if (!charOk) {
      await nav.resetToConceptDriven();
      await nav.waitForScriptEditReady(120_000);
    }
  }

  // Mechanical edit, LLM fallback — only when on script edit
  let dialogueResult = editScriptDialogue(browser, transcriptEdit);
  if (!dialogueResult.ok) {
    const llmEdit = await nav.editFieldViaLlm('dialogue line', transcriptEdit);
    dialogueResult = {
      ok: llmEdit.ok || snapshotHasText(browser, transcriptEdit.slice(0, 15)),
      detail: llmEdit.ok ? 'LLM dialogue edit' : llmEdit.result.error ?? 'dialogue edit failed',
    };
  }

  await nav.explore('Click Play audio on any dialogue line if visible. Mark done when clicked or not available.', 4);

  steps.push(
    await probeStep(
      ctx(), repro, 'script-dialogue-edit', 'Edit script dialogue', 'Edited text visible',
      {
        description: 'Script dialogue edit',
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
        backExplore,
      ),
    );

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

  await nav.waitUntilNextEnabled(config.scriptProcessingWaitMs);
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
      advanceEdit,
    ),
  );

  // ── THEME EDITS ───────────────────────────────────────────────
  await nav.waitForPhase(['theme', 'style'], 60_000);
  await nav.explore('Click Edit Text or Describe New Theme if those buttons are visible.', 4);

  let themeEdits = editThemeFields(browser, themeVisual, themeNarrative);
  if (!themeEdits.visual.ok) {
    await nav.editFieldViaLlm('Visual Style', themeVisual);
  }
  if (!themeEdits.narrative.ok) {
    await nav.editFieldViaLlm('Visual Narrative', themeNarrative);
  }
  themeEdits = editThemeFields(browser, themeVisual, themeNarrative);

  steps.push(
    await probeStep(
      ctx(), repro, 'theme-edit', 'Edit theme fields', 'QA markers in snapshot',
      {
        description: 'Theme dual-field edit',
        snapshotIncludesAny: [themeVisual.slice(0, 16), themeNarrative.slice(0, 16), 'QA visual', 'QA narrative'],
        ...STEP_BASE,
      },
    ),
  );

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
      themeAdvance,
    ),
  );

  // ── STYLE ─────────────────────────────────────────────────────
  const styleExplore = await nav.completeStyleStep();
  steps.push(
    await probeStep(
      ctx(), repro, 'style-complete', 'Style + dismiss credits (LLM)', 'Past style',
      {
        description: 'Style step',
        snapshotIncludesAny: ['Edit scenes', 'Create Video', 'Location', 'editscene'],
        ...STEP_BASE,
      },
      undefined,
      config.sceneWaitMs,
      styleExplore,
    ),
  );

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
  await nav.waitForPhase(['edit-scenes', 'final-video'], config.sceneWaitMs, 5000);
  nav.wizard.dismissOverlays();

  let sceneResult = editSceneDescription(browser, sceneEdit);
  if (!sceneResult.ok) {
    await nav.editFieldViaLlm('scene description', sceneEdit);
  }

  await nav.waitUntilCreateVideoEnabled();
  nav.wizard.clickNext(); // dismiss any open edit panel
  browser.evalScript(`document.body.click()`);
  browser.wait(500);

  const sceneExplore = await nav.editSceneAndCreateVideo(sceneEdit.slice(0, 30));
  steps.push(
    await probeStep(
      ctx(), repro, 'scene-edit-create', 'Scene edit + Create Video (LLM)', 'Final video',
      {
        description: 'Scene edit and create video',
        snapshotIncludesAny: [sceneEdit.slice(0, 14), 'finalvideo', 'Download Video', 'Generating Video', 'Preview'],
        ...STEP_BASE,
      },
      undefined,
      config.sceneWaitMs,
      sceneExplore,
    ),
  );

  // ── FINAL VIDEO ───────────────────────────────────────────────
  await nav.waitForPhase(['final-video'], config.finalWaitMs, 5000);

  let finalResult = editFinalVideoNote(browser, finalEdit);
  if (!finalResult.ok) {
    await nav.explore(
      `On Final video: click Edit Video if visible. Enter edit note: "${finalEdit}". ` +
        `Try Export XML and captions toggle. Mark done when edit is saved or preview visible.`,
      10,
    );
  }

  const finalExplore = await nav.completeFinalVideo();
  steps.push(
    await probeStep(
      ctx(), repro, 'final-video', 'Final video + download wait (LLM)', 'Download or generating',
      {
        description: 'Final video',
        urlIncludes: '/finalvideo',
        snapshotIncludesAny: ['Download Video', 'Generating Video', 'Preview', finalEdit.slice(0, 12)],
        ...STEP_BASE,
      },
      undefined,
      config.finalWaitMs,
      finalExplore,
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

  assertNoStepFailures(steps, options.scenarioId);
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
