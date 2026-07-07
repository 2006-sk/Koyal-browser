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
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        this.browser.clearSignals();
        const result = await this.explorer.achieveGoal(goal, {
          maxSteps: maxSteps ?? config.llm.maxStepsPerGoal,
        });
        for (const step of result.stepsTaken) {
          this.explorerLog.push(`[LLM] ${step}`);
        }
        return { goal, result, ok: result.success };
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        if (attempt < 2 && /fetch failed|EPIPE|ECONNRESET|timed out/i.test(msg)) {
          console.warn(`[explorer] LLM error, retrying: ${msg}`);
          this.browser.wait(3000);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  phase(): ScriptPhase {
    return describeScriptPhase(this.browser.getUrl(), this.browser.snapshotInteractive());
  }

  async waitForPhase(phases: ScriptPhase[], maxMs: number, pollMs = 3000): Promise<ScriptPhase> {
    const deadline = Date.now() + maxMs;
    let lastRecovery = 0;
    while (Date.now() < deadline) {
      const url = this.browser.getUrl();
      const lost =
        /about:blank/i.test(url) ||
        (this.phase() === 'unknown' && !this.wizard.isOnWizard() && Date.now() - lastRecovery > 20_000);
      if (lost && Date.now() - lastRecovery > 10_000) {
        await this.recoverFromBlankOrLost();
        lastRecovery = Date.now();
      }
      const phase = this.phase();
      if (phases.includes(phase)) return phase;
      this.browser.wait(pollMs);
    }
    return this.phase();
  }

  /** Re-open in-progress project when browser tab is blank or wizard was lost. */
  async recoverFromBlankOrLost(): Promise<boolean> {
    const url = this.browser.getUrl();
    if (!/about:blank/i.test(url) && this.wizard.isOnWizard()) return true;

    const base = config.baseUrl.replace(/\/$/, '');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.browser.open(`${base}${config.paths.projects}`);
        this.browser.wait(3000);
      } catch {
        this.browser.wait(2000);
        continue;
      }
      if (/about:blank/i.test(this.browser.getUrl())) continue;

      const snap = this.browser.snapshotInteractive();
      const resume =
        refForInteractiveSnapshot(snap, /Continue|Resume|In Progress/i) ??
        refForInteractiveSnapshot(snap, /button "Open"/i);
      if (resume) {
        this.wizard.safeClick(resume);
        this.browser.wait(4000);
        if (this.wizard.isOnWizard()) return true;
      }

      const card = refForInteractiveSnapshot(snap, /project card|Create Your Next Video/i);
      if (card && !/create your next video/i.test(snap)) {
        this.wizard.safeClick(card);
        this.browser.wait(4000);
        if (this.wizard.isOnWizard()) return true;
      }

      const explore = await this.recoverWizardIfLost();
      if (explore?.ok || this.wizard.isOnWizard()) return true;
    }
    return this.wizard.isOnWizard();
  }

  openUploadFork(): void {
    const base = config.baseUrl.replace(/\/$/, '');
    const uploadUrl = `${base}${config.paths.upload}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.browser.open(uploadUrl);
        this.browser.wait(3000);
        const url = this.browser.getUrl();
        if (!/about:blank/i.test(url)) return;
      } catch {
        // retry
      }
      this.browser.wait(2000 * attempt);
    }
    throw new Error(`Could not open upload fork (url=${this.browser.getUrl()})`);
  }

  uploadScriptFile(filePath: string): void {
    this.wizard.uploadScriptFile(filePath);
  }

  clickNextIfEnabled(): boolean {
    return this.wizard.clickNext();
  }

  async waitUntilNextEnabled(maxMs = config.scriptProcessingWaitMs): Promise<void> {
    this.wizard.waitForNextEnabled(maxMs);
  }

  async waitForScriptEditIdle(maxMs = config.scriptProcessingWaitMs): Promise<void> {
    try {
      this.wizard.waitForScriptEditIdle(maxMs);
    } catch {
      // May already be past script edit
    }
  }

  /** Return to script edit from any wizard step (e.g. after character probe). */
  async ensureOnScriptEdit(): Promise<boolean> {
    if (this.phase() === 'script-edit') {
      try {
        await this.waitForScriptEditIdle(60_000);
      } catch {
        // already idle enough
      }
      return true;
    }
    if (!(await this.resetToConceptDriven())) return false;
    await this.waitForScriptEditReady(config.scriptProcessingWaitMs);
    await this.waitForScriptEditIdle(config.scriptProcessingWaitMs);
    return this.phase() === 'script-edit';
  }

  /** Mechanical advance script edit → theme; LLM only if needed. */
  async advanceFromScriptEdit(): Promise<ExploreRecord | null> {
    if (!(await this.ensureOnScriptEdit())) {
      return this.explore(
        `Get to Edit Script with Next enabled, then click Next to reach Theme. Mark done on Theme step.`,
        8,
      );
    }
    this.wizard.dismissOverlays();
    if (this.wizard.advanceToTheme()) {
      return null;
    }
    return this.explore(
      `On Edit Script: click Next when enabled to reach Theme (Story Theme). ` +
        `If Next is disabled, wait. Use sidebar Theme if needed. Mark done on Theme step.`,
      8,
    );
  }

  /** Mechanical theme → style; LLM fallback. */
  async advanceFromTheme(): Promise<ExploreRecord | null> {
    this.wizard.dismissOverlays();
    this.wizard.dismissEditPanels();
    await this.waitUntilNextEnabled(config.scriptProcessingWaitMs);
    this.wizard.dismissOverlays();
    if (this.wizard.advanceToStyle()) {
      return null;
    }
    return this.explore(
      `On Story Theme: dismiss any Create New Theme dialog (×). Click Next when enabled. Mark done on Style (Choose art style).`,
      6,
    );
  }

  /** Mechanical style step; LLM fallback. */
  async completeStyleStep(): Promise<ExploreRecord | null> {
    this.wizard.dismissCreditModal();
    if (this.wizard.completeStyleAndAdvance()) {
      return null;
    }
    return this.explore(
      `On Style: select Realistic and Landscape. Dismiss credit modal (×). ` +
        `Click Next when enabled. Mark done on Edit scenes or Locations.`,
      10,
    );
  }

  /** Mechanical scene edit + create video; LLM fallback. */
  async editSceneAndCreateVideo(sceneEditHint: string): Promise<ExploreRecord | null> {
    this.wizard.dismissOverlays();
    this.wizard.dismissEditPanels();
    try {
      this.wizard.waitForCreateVideoReady();
      this.wizard.clickCreateVideo();
      await this.waitForPhase(['final-video'], config.sceneWaitMs, 5000);
      if (this.phase() === 'final-video') return null;
    } catch {
      // fall through to LLM
    }
    return this.explore(
      `Dismiss blocking panels (Close, Cancel, credit ×). On Edit scenes: edit description to include "${sceneEditHint}". ` +
        `When Create Video is enabled, click it. Mark done on Final video.`,
      12,
    );
  }

  /** Wait for final video UI; LLM for optional controls. */
  async completeFinalVideo(): Promise<ExploreRecord | null> {
    try {
      this.wizard.waitForDownloadReady();
      return null;
    } catch {
      return this.explore(
        `On Final video: wait for Download Video or Generating Video. ` +
          `Try Edit Video / Export XML if visible. Mark done when download or preview is shown.`,
        10,
      );
    }
  }

  /** Mechanical story-type round trip without full re-process when possible. */
  async goBackToStoryTypeAndReturn(): Promise<ExploreRecord | null> {
    const phase = this.phase();
    if (phase === 'script-edit') {
      const snap = this.browser.snapshotInteractive();
      const back = refForInteractiveSnapshot(snap, /Go back to Story Type/i);
      if (back) {
        this.wizard.safeClick(back);
        this.browser.wait(2500);
        if (await this.completeStoryTypeConcept()) {
          await this.waitForScriptEditReady();
          await this.waitForScriptEditIdle();
          if (this.phase() === 'script-edit') return null;
        }
      }
    }
    return this.explore(
      `From script edit: click "Go back to Story Type Selection" OR sidebar Story Type (not Dashboard). ` +
        `Select Concept Driven, click Next. Mark done when Edit Script is visible with Next enabled.`,
      12,
    );
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
    if (/about:blank/i.test(url)) {
      const ok = await this.recoverFromBlankOrLost();
      return ok ? null : this.explore(
        `Browser tab is blank. Open projects, resume the in-progress script video wizard. ` +
          `Mark done on Edit scenes, Style, or script wizard with sidebar visible.`,
        10,
      );
    }
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
    for (let i = 0; i < 8; i++) {
      this.wizard.dismissOverlays();
      const phase = this.phase();
      if (phase === 'story-type' || this.snapIncludes('Concept Driven', 'Character Driven')) {
        return true;
      }

      if (phase === 'upload-fork') {
        if (!this.wizard.startWithScript()) {
          await this.startWithScript();
        }
        this.browser.wait(2000);
        continue;
      }

      // Sidebar Story Type works once file is uploaded (more reliable than Next through modals)
      if (
        this.snapIncludes('Upload Your Script', 'Upload file', 'Choose PDF') &&
        this.snapIncludes('Story Type')
      ) {
        if (this.wizard.clickSidebarStep('Story Type')) {
          this.browser.wait(3000);
          if (this.phase() === 'story-type' || this.snapIncludes('Concept Driven', 'Character Driven')) {
            return true;
          }
        }
      }

      if (this.wizard.clickNextRobust()) {
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

  async startWithScript(): Promise<ExploreRecord | null> {
    if (this.wizard.startWithScript()) return null;
    return this.explore(
      `On the upload start page ("How would you like to start?"), click Start with Script (not audio). ` +
        `Mark done when script upload UI is visible (Upload Your Script, PDF picker, or file input).`,
      6,
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


  async advanceFromScriptEditLlm(): Promise<ExploreRecord> {
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

  async advanceFromLocations(): Promise<ExploreRecord> {
    return this.explore(
      `On Locations step (if shown): optionally click Add New Location, then click Next when enabled. ` +
        `Mark done on Edit scenes (Create Video or scene grid visible).`,
      8,
    );
  }

  async sidebarRoundTrip(): Promise<ExploreRecord> {
    return this.explore(
      `Use wizard sidebar to visit each step: Upload file, Story Type, Review transcript, Theme, Style, Edit scenes, Final video. ` +
        `Click each sidebar label if reachable. Verify no crash. Mark done after visiting Final video.`,
      18,
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
