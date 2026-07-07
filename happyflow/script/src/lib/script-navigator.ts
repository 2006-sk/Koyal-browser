import { config } from '../config.js';
import type { ExplorerResult } from './explorer.js';
import { Explorer } from './explorer.js';
import type { AgentBrowser } from './agent-browser.js';
import { refForEnabledButton, refForInteractiveSnapshot } from './agent-browser.js';
import { ScriptWizardPage } from './page-script.js';
import { describeScriptPhase, snapHas, type ScriptPhase } from './script-phase.js';

export interface ExploreRecord {
  goal: string;
  result: ExplorerResult;
  ok: boolean;
}

export class ScriptNavigator {
  readonly explorer: Explorer;
  readonly explorerLog: string[] = [];
  readonly wizard: ScriptWizardPage;

  constructor(private readonly browser: AgentBrowser) {
    this.explorer = new Explorer(browser);
    this.wizard = new ScriptWizardPage(browser);
  }

  async explore(goal: string, maxSteps?: number): Promise<ExploreRecord> {
    this.browser.clearSignals();
    const result = await this.explorer.achieveGoal(goal, {
      maxSteps: maxSteps ?? config.llm.maxStepsPerGoal,
    });
    for (const step of result.stepsTaken) {
      this.explorerLog.push(`[LLM] ${step}`);
    }
    return { goal, result, ok: result.success };
  }

  phase(): ScriptPhase {
    return describeScriptPhase(this.browser.getUrl(), this.browser.snapshotInteractive());
  }

  async waitForPhase(phases: ScriptPhase[], maxMs: number, pollMs = 3000): Promise<ScriptPhase> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const phase = this.phase();
      if (phases.includes(phase)) return phase;
      this.browser.wait(pollMs);
    }
    return this.phase();
  }

  openUploadFork(): void {
    const base = config.baseUrl.replace(/\/$/, '');
    this.browser.open(`${base}${config.paths.upload}`);
    this.browser.wait(2500);
  }

  uploadScriptFile(filePath: string): void {
    this.browser.clearSignals();
    try {
      this.browser.upload('#script-file-input', filePath);
    } catch {
      this.browser.upload('input[type=file]', filePath);
    }
    this.browser.wait(5000);
  }

  clickNextIfEnabled(): boolean {
    return this.wizard.clickNext();
  }

  async waitUntilNextEnabled(maxMs = 120_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const snap = this.browser.snapshotInteractive();
      if (refForEnabledButton(snap, 'Next')) return;
      this.browser.wait(3000);
    }
  }

  async waitUntilCreateVideoEnabled(maxMs = config.sceneWaitMs): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const snap = this.browser.snapshotInteractive();
      if (refForEnabledButton(snap, 'Create Video')) return;
      this.browser.wait(5000);
    }
  }

  async recoverWizardIfLost(): Promise<ExploreRecord | null> {
    const url = this.browser.getUrl();
    const phase = this.phase();
    if (phase !== 'app-shell' && this.wizard.isOnWizard()) return null;
    if (!/\/(dashboard|projects|project\/)/i.test(url) && phase !== 'app-shell') return null;

    return this.explore(
      `You left the script video wizard. From dashboard or projects, open the in-progress script project ` +
        `(Continue, Resume, or the latest project card). Do NOT click Dashboard in the wizard sidebar. ` +
        `Mark done when on Story Type, Edit Script, or upload wizard with Story Type in sidebar.`,
      12,
    );
  }

  /** After plan: click Next on upload until Story Type appears. */
  async advanceUploadToStoryType(): Promise<boolean> {
    for (let i = 0; i < 6; i++) {
      const phase = this.phase();
      if (phase === 'story-type' || this.snapIncludes('concept driven or character driven')) {
        return true;
      }
      // Lost wizard — reopen script path
      if (phase === 'upload-fork') {
        await this.startWithScript();
        this.browser.wait(2000);
        continue;
      }

      const snap = this.browser.snapshotInteractive();
      if (refForEnabledButton(snap, 'Next') && this.wizard.clickNext()) {
        this.browser.wait(3000);
        if (this.phase() === 'story-type' || this.snapIncludes('Concept Driven', 'Character Driven')) {
          return true;
        }
        continue;
      }

      if (this.wizard.clickSidebarStep('Story Type')) {
        if (this.snapIncludes('Concept Driven', 'Character Driven')) return true;
      }

      this.browser.wait(1500);
    }
    return this.phase() === 'story-type' || this.snapIncludes('Concept Driven', 'Character Driven');
  }

  /** Navigate to Story Type — must complete upload step first (sets projectId). */
  async goToStoryType(): Promise<boolean> {
    if (this.phase() === 'story-type' || this.snapIncludes('concept driven or character driven')) {
      return true;
    }
    return this.advanceUploadToStoryType();
  }

  async recoverFromWrongTranscriptStep(): Promise<boolean> {
    const url = this.browser.getUrl();
    if (!url.includes('lyricedit') && !this.snapIncludes('No dialogue found', 'Audio transcript')) {
      return true;
    }
    this.wizard.dismissOverlays();
    const snap = this.browser.snapshotInteractive();
    const back = refForInteractiveSnapshot(snap, /Go back to Story Type/i);
    if (back) {
      this.wizard.safeClick(back);
      this.browser.wait(2500);
    }
    return this.resetToConceptDriven();
  }

  /** @deprecated Use goToStoryType + completeStoryTypeConcept instead */
  async ensureWizardProgress(): Promise<void> {
    await this.goToStoryType();
  }

  async resetToConceptDriven(): Promise<boolean> {
    await this.recoverFromWrongTranscriptStep();
    if (!(await this.goToStoryType())) {
      const explore = await this.explore(
        `On upload wizard: click Next to reach Story Type. Never use Dashboard. ` +
          `Mark done on Concept Driven / Character Driven screen.`,
        8,
      );
      if (!explore.ok) return false;
    }
    this.wizard.dismissOverlays();

    for (let i = 0; i < 6; i++) {
      const snap = this.browser.snapshotInteractive();
      const remove = refForInteractiveSnapshot(snap, /Remove character/i);
      if (!remove) break;
      this.wizard.safeClick(remove);
      this.browser.wait(400);
    }

    this.wizard.dismissOverlays();
    if (!this.wizard.selectConceptDriven()) {
      const explore = await this.selectConceptDriven();
      if (!explore.ok) return false;
    }
    this.wizard.dismissOverlays();
    if (!this.wizard.clickNext()) {
      const explore = await this.explore(
        `Select Concept Driven. Click Next when enabled. Mark done on /scriptEdit or Processing Script.`,
        8,
      );
      return explore.ok;
    }
    return true;
  }

  async completeStoryTypeConcept(): Promise<boolean> {
    if (!(await this.goToStoryType())) return false;

    this.wizard.dismissOverlays();
    if (!this.wizard.selectConceptDriven()) {
      const explore = await this.selectConceptDriven();
      if (!explore.ok) return false;
    }

    this.wizard.dismissOverlays();
    if (!this.wizard.clickNext()) {
      const explore = await this.explore(
        `On Story Type with Concept Driven selected: click Next when enabled. ` +
          `Mark done when script processing or Edit Script appears.`,
        6,
      );
      if (!explore.ok) return false;
    }
    return true;
  }

  /** Optional probe — run after script edit is confirmed working. */
  async probeRandomCharacter(name: string, description: string): Promise<boolean> {
    if (!(await this.goToStoryType())) return false;
    return (await this.tryCreateRandomCharacter(name, description)).ok;
  }

  async tryCreateRandomCharacter(name: string, description: string): Promise<ExploreRecord> {
    if (!(await this.goToStoryType())) {
      return {
        goal: 'go to story type',
        result: { goal: '', success: false, actions: [], stepsTaken: [], finalUrl: '', finalSnapshot: '' },
        ok: false,
      };
    }

    this.wizard.dismissOverlays();
    if (!this.wizard.selectCharacterDriven()) {
      return this.createNewCharacter(name, description);
    }

    return this.explore(
      `Character Driven is selected. Click Add Character or Create AI Avatar. ` +
        `Fill name: "${name}". Fill description: "${description}". Save. Click Next when enabled. ` +
        `Mark done when past story type.`,
      12,
    );
  }

  async selectStandardPlanDeterministic(): Promise<boolean> {
    return this.wizard.selectPlanStandard();
  }

  dismissCreditModal(): void {
    const snap = this.browser.snapshotInteractive();
    const close = refForInteractiveSnapshot(snap, /button.*[×✕]/i)
      || refForInteractiveSnapshot(snap, /close/i);
    if (close) {
      this.browser.clickVisible(close);
      this.browser.wait(500);
    }
  }

  clickWizardSidebar(label: string): boolean {
    const snap = this.browser.snapshotInteractive();
    const ref = refForInteractiveSnapshot(snap, new RegExp(`"${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i'));
    if (!ref) return false;
    this.browser.clickVisible(ref);
    this.browser.wait(1200);
    return true;
  }

  async startWithScript(): Promise<ExploreRecord> {
    return this.explore(
      `On the upload start page ("How would you like to start?"), click Start with Script (not audio). ` +
        `Mark done when script upload UI is visible (Upload Your Script, PDF picker, or file input).`,
    );
  }

  async selectStandardPlan(): Promise<ExploreRecord> {
    return this.explore(
      `A plan selection modal may be open. Choose Standard plan (not Pro), click Continue when enabled. ` +
        `Do NOT click Dashboard or Cancel. Mark done when modal is gone and wizard continues.`,
      10,
    );
  }

  async advancePastUpload(): Promise<ExploreRecord> {
    return this.explore(
      `On script upload step: if Next is enabled, click it. Complete any remaining upload steps. ` +
        `Mark done when on Story Type OR script is processing.`,
      10,
    );
  }

  async selectConceptDriven(): Promise<ExploreRecord> {
    return this.explore(
      `On Story Type: select Concept Driven (not Character Driven). Click Next when enabled. ` +
        `Mark done when past story type (script edit processing or Edit Script visible).`,
    );
  }

  async createNewCharacter(name: string, description: string): Promise<ExploreRecord> {
    return this.explore(
      `On Story Type: select Character Driven. Choose Create New Character or Add New Character. ` +
        `Fill character name with exactly: "${name}". Fill description/bio with: "${description}". ` +
        `Save or confirm the character. Click Next when enabled. ` +
        `Mark done when past story type (script edit or processing).`,
      15,
    );
  }

  async waitForScriptEditReady(maxMs = config.scriptProcessingWaitMs): Promise<ScriptPhase> {
    console.log(`\n⏳ Waiting for script edit (up to ${maxMs / 1000}s)…`);
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const phase = this.phase();
      if (['script-edit', 'theme', 'error'].includes(phase)) return phase;
      if (phase === 'processing') {
        this.browser.wait(5000);
        continue;
      }
      // Stuck on upload/story-type — don't burn full timeout silently
      if (['upload-fork', 'script-upload', 'unknown'].includes(phase)) {
        const snap = this.browser.snapshotInteractive();
        if (snapHas(snap, 'Upload Your Script', 'Choose PDF') && !snapHas(snap, 'Edit Script')) {
          console.warn('  [wait] still on upload — aborting early');
          return phase;
        }
      }
      this.browser.wait(5000);
    }
    return this.phase();
  }

  async advanceFromScriptEdit(): Promise<ExploreRecord> {
    return this.explore(
      `On Edit Script / script review: optionally click Play audio. Click Next when enabled to proceed to Theme. ` +
        `Do not get stuck on emotion tags. Mark done on Theme step (Story Theme visible).`,
    );
  }

  async editFieldViaLlm(fieldLabel: string, value: string): Promise<ExploreRecord> {
    return this.explore(
      `Edit the "${fieldLabel}" field to contain this exact text: "${value}". ` +
        `Click the field or Edit Text if needed, type or paste the value, confirm/save if required. ` +
        `Mark done when the text appears in the page.`,
      10,
    );
  }

  async advanceFromTheme(): Promise<ExploreRecord> {
    return this.explore(
      `On Story Theme: click Edit Text or Describe New Theme if you need to edit fields. ` +
        `Click Next when enabled. Mark done on Style step (Choose art style).`,
    );
  }

  async completeStyleStep(): Promise<ExploreRecord> {
    return this.explore(
      `On Style: select Realistic art style and Landscape aspect ratio. ` +
        `Dismiss any credit package modal (click × or close). Click Next when enabled. ` +
        `Mark done on Locations or Edit scenes.`,
      12,
    );
  }

  async advanceFromLocations(): Promise<ExploreRecord> {
    return this.explore(
      `On Locations step (if shown): optionally click Add New Location, then click Next when enabled. ` +
        `Mark done on Edit scenes (Create Video or scene grid visible).`,
      8,
    );
  }

  async editSceneAndCreateVideo(sceneEditHint: string): Promise<ExploreRecord> {
    this.wizard.dismissOverlays();
    return this.explore(
      `Dismiss any blocking modal first (credit package ×, "Taking longer" — click × or Escape). ` +
        `On Edit scenes: click a scene card. Edit description to include: "${sceneEditHint}". ` +
        `Try Retake or Reframe if visible. When Create Video is enabled, click it. Mark done on Final video.`,
      15,
    );
  }

  async completeFinalVideo(): Promise<ExploreRecord> {
    return this.explore(
      `On Final video: try Edit Video, Export XML, captions toggle if visible. ` +
        `Add an edit note if Edit field is available. Wait for Download Video to become enabled if rendering. ` +
        `Mark done when Download Video is clickable or preview shots are visible.`,
      12,
    );
  }

  async sidebarRoundTrip(): Promise<ExploreRecord> {
    return this.explore(
      `Use wizard sidebar to visit each step: Upload file, Story Type, Review transcript, Theme, Style, Edit scenes, Final video. ` +
        `Click each sidebar label if reachable. Verify no crash. Mark done after visiting Final video.`,
      18,
    );
  }

  async goBackToStoryTypeAndReturn(): Promise<ExploreRecord> {
    const phase = this.phase();
    if (phase === 'script-edit') {
      return this.explore(
        `Click "Go back to Story Type Selection" if visible. On Story Type, select Concept Driven, click Next. ` +
          `Mark done when Edit Script is visible again.`,
        12,
      );
    }
    this.wizard.dismissOverlays();
    return this.explore(
      `Use wizard sidebar: click "Story Type" (NOT Dashboard). Dismiss overlays first (×, Escape). ` +
        `On Story Type select Concept Driven and click Next. Mark done when Edit Script or Review transcript is visible.`,
      12,
    );
  }

  async navigateSidebar(stepLabel: string): Promise<ExploreRecord> {
    this.wizard.dismissOverlays();
    return this.explore(
      `Dismiss any modal overlay first (×, Cancel, Escape). Then click wizard sidebar "${stepLabel}". ` +
        `Never click Dashboard. Mark done when that step is active.`,
      8,
    );
  }

  async browserHistoryProbe(): Promise<void> {
    this.browser.back();
    this.browser.wait(1500);
    this.browser.forward();
    this.browser.wait(1500);
  }

  isErrorState(): boolean {
    return this.phase() === 'error';
  }

  snapIncludes(...needles: string[]): boolean {
    return snapHas(this.browser.snapshotInteractive(), ...needles);
  }
}
