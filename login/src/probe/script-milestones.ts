import path from 'node:path';
import fs from 'node:fs';
import { config, requireCredentials } from '../config.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { Explorer } from '../lib/explorer.js';
import { captureProbeStep } from './script-evidence.js';
import { describeScriptPhase, snapHas, type ScriptPhase } from './script-phase.js';

export interface MilestoneResult {
  id: string;
  label: string;
  reached: boolean;
  phase: ScriptPhase;
  explorerSteps?: string[];
  error?: string;
}

export interface ScriptProbeOptions {
  scriptPath: string;
  outDir: string;
  maxProcessingMs?: number;
}

function isAuthenticated(browser: AgentBrowser): boolean {
  const url = browser.getUrl();
  const snap = browser.snapshotInteractive();
  if (/textbox "EMAIL"/i.test(snap) || /textbox "PASSWORD"/i.test(snap)) return false;
  return /\/(projects|dashboard|upload|scriptedit|selecttheme|selectstyle|editscene|finalvideo|selectstorytype)/i.test(
    url,
  );
}

async function explore(
  explorer: Explorer,
  browser: AgentBrowser,
  outDir: string,
  id: string,
  label: string,
  goal: string,
  maxSteps?: number,
): Promise<{ ok: boolean; result: Awaited<ReturnType<Explorer['achieveGoal']>> }> {
  browser.clearSignals();
  const result = await explorer.achieveGoal(goal, { maxSteps });
  captureProbeStep(browser, outDir, id, label, result);
  return { ok: result.success, result };
}

async function waitForPhase(
  browser: AgentBrowser,
  phases: ScriptPhase[],
  maxMs: number,
  pollMs = 3000,
): Promise<ScriptPhase> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const phase = describeScriptPhase(browser.getUrl(), browser.snapshotInteractive());
    if (phases.includes(phase)) return phase;
    browser.wait(pollMs);
  }
  return describeScriptPhase(browser.getUrl(), browser.snapshotInteractive());
}

export async function runScriptPathProbe(
  browser: AgentBrowser,
  options: ScriptProbeOptions,
): Promise<MilestoneResult[]> {
  const explorer = new Explorer(browser);
  const results: MilestoneResult[] = [];
  const processingMs = options.maxProcessingMs ?? 300_000;
  const base = config.baseUrl.replace(/\/$/, '');
  const authState = path.join(config.stateDir, 'qa-auth.json');

  const record = (r: MilestoneResult) => {
    results.push(r);
    console.log(`${r.reached ? '✅' : '⚠️'} ${r.id}: ${r.label} (phase=${r.phase})`);
  };

  // ── 0. Session ────────────────────────────────────────────────
  try {
    if (fs.existsSync(authState)) {
      browser.stateLoad(authState);
      browser.wait(500);
    }
  } catch {
    /* fresh login via explorer */
  }

  browser.open(`${base}/projects`);
  browser.wait(2000);

  if (!isAuthenticated(browser)) {
    requireCredentials();
    const login = await explore(
      explorer,
      browser,
      options.outDir,
      '00-login',
      'Authenticate via login form',
      `You are on the Koyal login page. Log in with email "${config.testEmail}" and password "${config.testPassword}". ` +
        `Toggle to the Log In form if Sign Up is showing. Click Start Creating when done. ` +
        `Mark done when you reach projects or dashboard (not the login form).`,
      12,
    );
    record({
      id: '00-login',
      label: 'Login',
      reached: login.ok && isAuthenticated(browser),
      phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
      explorerSteps: login.result.stepsTaken,
      error: login.ok ? undefined : login.result.error,
    });
    if (isAuthenticated(browser)) {
      browser.stateSave(authState);
    }
  } else {
    captureProbeStep(browser, options.outDir, '00-session', 'Restored authenticated session');
    record({
      id: '00-session',
      label: 'Session restore',
      reached: true,
      phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
    });
  }

  // ── 1. Upload fork ────────────────────────────────────────────
  browser.open(`${base}/upload`);
  browser.wait(2500);

  if (!snapHas(browser.snapshotInteractive(), 'How would you like to start')) {
    const dismiss = await explore(
      explorer,
      browser,
      options.outDir,
      '01-reach-upload',
      'Reach upload onboarding',
      `Get to the "How would you like to start?" onboarding page where the user can choose Script or Audio. ` +
        `If stuck in another wizard, use Dashboard or close (×) then navigate to upload. Mark done when that heading is visible.`,
      10,
    );
    record({
      id: '01-reach-upload',
      label: 'Reach upload fork',
      reached: dismiss.ok,
      phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
      explorerSteps: dismiss.result.stepsTaken,
    });
  } else {
    captureProbeStep(browser, options.outDir, '01-upload-fork', 'Upload fork visible');
    record({ id: '01-upload-fork', label: 'Upload fork', reached: true, phase: 'upload-fork' });
  }

  // ── 2. Script upload screen (LLM discovers path) ──────────────
  const scriptScreen = await explore(
    explorer,
    browser,
    options.outDir,
    '02-script-upload-screen',
    'Open script upload UI',
    `From the upload start page, choose the SCRIPT path (not audio). ` +
      `Success: you see script file upload UI — heading like "Upload Your Script" or a PDF/TXT file picker label. ` +
      `Do not select a plan yet. Mark done when script upload UI is visible.`,
    12,
  );
  record({
    id: '02-script-upload-screen',
    label: 'Script upload screen',
    reached: scriptScreen.ok || describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()) === 'script-upload',
    phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
    explorerSteps: scriptScreen.result.stepsTaken,
  });

  // ── 3. File upload (mechanical — LLM cannot attach local files) ─
  browser.clearSignals();
  console.log(`\n📎 Uploading script file: ${path.basename(options.scriptPath)}`);
  try {
    browser.upload('#script-file-input', options.scriptPath);
  } catch {
    browser.upload('input[type=file]', options.scriptPath);
  }
  browser.wait(5000);
  await waitForPhase(browser, ['plan-modal', 'processing', 'story-type', 'script-upload'], 90_000);
  captureProbeStep(browser, options.outDir, '03-script-file-uploaded', `Uploaded ${path.basename(options.scriptPath)}`);
  record({
    id: '03-script-file-uploaded',
    label: 'Script file uploaded',
    reached: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()) !== 'script-upload' ||
      snapHas(browser.snapshotInteractive(), 'Select Your Plan'),
    phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
  });

  // ── 4. Plan selection (LLM) ─────────────────────────────────────
  if (describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()) === 'plan-modal' ||
      snapHas(browser.snapshotInteractive(), 'Select Your Plan')) {
    const plan = await explore(
      explorer,
      browser,
      options.outDir,
      '04-plan-standard',
      'Select Standard plan',
      `A plan selection modal is open. Choose the Standard plan (not Pro), then click Continue. ` +
        `Continue must be enabled before clicking. Do NOT click Dashboard, ×, or Cancel. ` +
        `If Continue was already clicked and modal is gone, mark done immediately.`,
      8,
    ).catch((err) => ({
      ok: false,
      result: {
        goal: 'plan',
        success: false,
        actions: [],
        stepsTaken: [],
        finalUrl: browser.getUrl(),
        finalSnapshot: browser.snapshotInteractive(),
        error: err instanceof Error ? err.message : String(err),
      },
    }));
    record({
      id: '04-plan-standard',
      label: 'Standard plan',
      reached: plan.ok,
      phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
      explorerSteps: plan.result.stepsTaken,
    });
  }

  // ── 5. Past upload step → story type (LLM + wait) ─────────────
  const phaseBeforeStory = describeScriptPhase(browser.getUrl(), browser.snapshotInteractive());
  if (phaseBeforeStory === 'script-upload' || phaseBeforeStory === 'upload-fork' || phaseBeforeStory === 'plan-modal') {
    await explore(
      explorer,
      browser,
      options.outDir,
      '05-advance-past-upload',
      'Advance past script upload',
      `If a Next button is enabled on the current wizard step, click it to proceed. ` +
        `If still on upload/plan, complete any remaining upload steps. ` +
        `Mark done when you reach Story Type (concept vs character) OR script is processing.`,
      8,
    );
  }

  console.log(`\n⏳ Waiting for story type or script edit (up to ${processingMs / 1000}s)…`);
  browser.clearSignals();
  const processingStart = Date.now();
  let poll = 0;
  while (Date.now() - processingStart < processingMs) {
    const phase = describeScriptPhase(browser.getUrl(), browser.snapshotInteractive());
    poll++;
    if (poll % 4 === 1) {
      captureProbeStep(
        browser,
        options.outDir,
        `06-processing-poll-${String(Math.ceil(poll / 4)).padStart(2, '0')}`,
        `Processing poll ${poll}`,
      );
    }
    if (['story-type', 'script-edit', 'theme', 'error'].includes(phase)) break;
    browser.wait(5000);
  }

  const phaseAfterWait = describeScriptPhase(browser.getUrl(), browser.snapshotInteractive());
  record({
    id: '06-processing',
    label: 'Script processing',
    reached: phaseAfterWait !== 'processing' && phaseAfterWait !== 'unknown',
    phase: phaseAfterWait,
  });

  // ── 6. Story type (LLM) ───────────────────────────────────────
  if (phaseAfterWait === 'story-type') {
    const story = await explore(
      explorer,
      browser,
      options.outDir,
      '07-story-type-concept',
      'Concept Driven story type',
      `On Story Type selection: choose Concept Driven (not Character Driven). ` +
        `If character picker appears, switch back to Concept Driven. ` +
        `Click Next when enabled. Mark done when past story type (script edit, theme, or processing).`,
      12,
    );
    record({
      id: '07-story-type-concept',
      label: 'Concept Driven + Next',
      reached: story.ok,
      phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
      explorerSteps: story.result.stepsTaken,
    });

    await waitForPhase(browser, ['script-edit', 'theme', 'error', 'processing'], 180_000);
    captureProbeStep(browser, options.outDir, '08-after-story-type', 'After story type');
  }

  // ── 7. Script edit / error (observe + LLM if stuck) ───────────
  let phase = describeScriptPhase(browser.getUrl(), browser.snapshotInteractive());
  if (phase === 'processing') {
    await waitForPhase(browser, ['script-edit', 'theme', 'error'], 180_000);
    phase = describeScriptPhase(browser.getUrl(), browser.snapshotInteractive());
  }

  captureProbeStep(browser, options.outDir, '09-script-edit-state', 'Script edit / transcript state');

  if (phase === 'error') {
    const retry = await explore(
      explorer,
      browser,
      options.outDir,
      '09-error-retry',
      'Retry after script error',
      `The page shows an error (Something went wrong, no dialogue, or character voices). ` +
        `Click Retry if available. Otherwise go back to story type and try again. ` +
        `Mark done if error clears and script/transcript editor appears, or fail if blocked.`,
      8,
    );
    record({
      id: '09-script-edit',
      label: 'Script edit (error state)',
      reached: false,
      phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
      explorerSteps: retry.result.stepsTaken,
      error: retry.result.error ?? 'Script path error UI',
    });
  } else if (phase === 'script-edit' || snapHas(browser.snapshotInteractive(), 'Edit Script', 'Audio transcript')) {
    record({
      id: '09-script-edit',
      label: 'Script edit reached',
      reached: true,
      phase,
    });

    const advance = await explore(
      explorer,
      browser,
      options.outDir,
      '10-advance-from-transcript',
      'Advance from transcript',
      `On the script/transcript review step: if Next is enabled, click it to proceed to Theme. ` +
        `Optionally click Play audio if visible. Do not get stuck on emotions. Mark done on Theme or Style step.`,
      10,
    );
    record({
      id: '10-advance-transcript',
      label: 'Advance past transcript',
      reached: advance.ok,
      phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
      explorerSteps: advance.result.stepsTaken,
    });
  } else {
    record({
      id: '09-script-edit',
      label: 'Script edit',
      reached: false,
      phase,
      error: `Stopped at ${phase} before script edit`,
    });
  }

  // ── 8. Push wizard forward (LLM discovers each step) ──────────
  const wizardGoals: Array<{ id: string; label: string; goal: string; donePhases: ScriptPhase[] }> = [
    {
      id: '11-theme',
      label: 'Theme step',
      goal: `On Story Theme: interact if needed (Edit Text / Describe New Theme), then click Next when enabled. Mark done on Style step.`,
      donePhases: ['style', 'locations', 'edit-scenes', 'final-video'],
    },
    {
      id: '12-style',
      label: 'Style step',
      goal: `On Style: pick any art style and aspect ratio, dismiss credit modals if any, click Next when enabled. Mark done on Locations or Edit scenes.`,
      donePhases: ['locations', 'edit-scenes', 'final-video'],
    },
    {
      id: '13-locations',
      label: 'Locations step',
      goal: `On Locations (if shown): click Next or skip Add New Location. Mark done on Edit scenes.`,
      donePhases: ['edit-scenes', 'final-video'],
    },
    {
      id: '14-scenes',
      label: 'Edit scenes',
      goal: `On Edit scenes: wait if Create Video is disabled (generation in progress). When enabled, click Create Video. Mark done on Final video.`,
      donePhases: ['final-video'],
    },
    {
      id: '15-final',
      label: 'Final video',
      goal: `On Final video: wait for Download Video to become enabled if rendering. Mark done when download/preview UI is ready.`,
      donePhases: ['final-video'],
    },
  ];

  for (const step of wizardGoals) {
    phase = describeScriptPhase(browser.getUrl(), browser.snapshotInteractive());
    if (phase === 'error') break;
    if (step.donePhases.includes(phase) && step.id !== '15-final') continue;

    const result = await explore(
      explorer,
      browser,
      options.outDir,
      step.id,
      step.label,
      step.goal,
      12,
    );
    record({
      id: step.id,
      label: step.label,
      reached: result.ok,
      phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
      explorerSteps: result.result.stepsTaken,
      error: result.ok ? undefined : result.result.error,
    });

    if (step.id === '14-scenes') {
      await waitForPhase(browser, ['final-video', 'error'], 180_000);
    }
  }

  // ── 9. Sidebar discovery (LLM per step) ───────────────────────
  const sidebar = await explore(
    explorer,
    browser,
    options.outDir,
    '16-sidebar-discovery',
    'Wizard sidebar round-trip',
    `Use the wizard sidebar to visit: Upload file, Story Type, Review transcript, Theme, Style, Edit scenes, Final video. ` +
      `Click each sidebar label once if reachable. Mark done after visiting Final video sidebar.`,
    15,
  );
  record({
    id: '16-sidebar',
    label: 'Sidebar round-trip',
    reached: sidebar.ok,
    phase: describeScriptPhase(browser.getUrl(), browser.snapshotInteractive()),
    explorerSteps: sidebar.result.stepsTaken,
  });

  captureProbeStep(browser, options.outDir, '99-final', 'Final probe state');
  return results;
}
