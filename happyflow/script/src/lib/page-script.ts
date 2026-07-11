import { config } from '../config.js';
import {
  AgentBrowser,
  isButtonDisabled,
  refForEnabledButton,
  refForInteractiveSnapshot,
  snapshotIncludes,
} from './agent-browser.js';
import { snapHas } from './script-phase.js';
import {
  isCreateVideoReady,
  isDownloadReady,
  isFinalVideoVisible,
  isScriptEditIdle,
  isScriptUploadScreen,
  isStyleStep,
  isThemeStep,
  isUploadFork,
} from './script-selectors.js';

export class ScriptWizardPage {
  constructor(private readonly browser: AgentBrowser) {}

  safeClick(ref: string | null): boolean {
    if (!ref) return false;
    try {
      this.browser.clickVisible(ref);
      return true;
    } catch {
      return false;
    }
  }

  uploadUrl(): string {
    return `${config.baseUrl.replace(/\/$/, '')}${config.paths.upload}`;
  }

  /** Dismiss bug-report or credit modals only — never Escape (closes wizard). */
  dismissOverlays(): void {
    for (let round = 0; round < 5; round++) {
      const snap = this.browser.snapshotInteractive();
      let dismissed = false;

      if (snapHas(snap, 'Report a Bug')) {
        for (const pat of [/button "Cancel"/i, /button "×"/i, /button "✕"/i]) {
          const btn = refForInteractiveSnapshot(snap, pat);
          if (this.safeClick(btn)) {
            this.browser.wait(500);
            dismissed = true;
            break;
          }
        }
      }

      if (
        snapHas(snap, 'Select Your Plan', 'Taking longer', 'Pro Package') ||
        (/credit/i.test(snap) && snapHas(snap, 'Select Your Plan', 'Continue', 'Pro Package'))
      ) {
        const close =
          refForInteractiveSnapshot(snap, /button "×"/i) ??
          refForInteractiveSnapshot(snap, /button "✕"/i);
        if (this.safeClick(close)) {
          this.browser.wait(500);
          dismissed = true;
        }
      }

      if (!dismissed) break;
    }
  }

  clickNextRobust(attempts = 4): boolean {
    for (let i = 0; i < attempts; i++) {
      this.dismissOverlays();
      if (this.clickNext()) return true;
      if (this.clickUploadForward()) return true;
      try {
        this.browser.clickButtonByText('Next');
        this.browser.wait(config.actionDelayMs);
        return true;
      } catch {
        // try again after dismiss
      }
      this.browser.wait(800);
    }
    return false;
  }

  /** Click labeled Next or icon FAB on upload step (e2). */
  clickUploadForward(): boolean {
    const snap = this.browser.snapshotInteractive();
    if (!this.isScriptUploadScreen(snap) && !snapHas(snap, 'Upload file')) return false;

    try {
      this.browser.evalScript(`
        (function() {
          for (const root of document.querySelectorAll('div.fixed.inset-0, [role="dialog"]')) {
            if (!/report a bug/i.test(root.textContent || '')) continue;
            for (const btn of root.querySelectorAll('button')) {
              const t = (btn.textContent || '').trim();
              if (/^(×|✕|x|cancel|close)$/i.test(t)) { btn.click(); return; }
            }
          }
          const nextBtn = [...document.querySelectorAll('button')].find(
            (b) => /^next$/i.test((b.textContent || '').trim()) && !b.disabled,
          );
          if (nextBtn) { nextBtn.click(); return true; }
          const fab = [...document.querySelectorAll('button')].find(
            (b) => b.offsetParent && !b.disabled && !(b.textContent || '').trim() && b.querySelector('img,svg'),
          );
          if (fab) { fab.click(); return true; }
          return false;
        })();
      `);
      this.browser.wait(config.actionDelayMs);
      return true;
    } catch {
      return false;
    }
  }

  clickSidebarStep(label: string): boolean {
    const snap = this.browser.snapshotInteractive();
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ref =
      refForInteractiveSnapshot(snap, new RegExp(`generic "${escaped}"`, 'i')) ??
      refForInteractiveSnapshot(snap, new RegExp(`"${escaped}"`, 'i'));
    if (!ref) return false;
    const ok = this.safeClick(ref);
    if (ok) this.browser.wait(2000);
    return ok;
  }

  selectConceptDriven(): boolean {
    let snap = this.browser.snapshotInteractive();
    let btn = refForInteractiveSnapshot(snap, /Concept Driven/i);
    if (!btn) {
      snap = this.browser.snapshotFull();
      btn = refForInteractiveSnapshot(snap, /Concept Driven/i);
    }
    if (btn) {
      this.safeClick(btn);
      this.browser.wait(1000);
      return true;
    }
    if (snapshotIncludes(snap, 'Concept Driven')) {
      return this.browser.clickButtonByText('Concept Driven');
    }
    return false;
  }

  selectCharacterDriven(): boolean {
    const snap = this.browser.snapshotInteractive();
    const btn = refForInteractiveSnapshot(snap, /Character Driven/i);
    if (btn) {
      this.safeClick(btn);
      this.browser.wait(1000);
      return true;
    }
    return this.browser.clickButtonByText('Character Driven');
  }

  selectPlanStandard(): boolean {
    const snap = this.browser.snapshotInteractive();
    if (isUploadFork(snap)) return false;
    if (!snapHas(snap, 'Select Your Plan', 'Standard')) return false;
    const standard = refForInteractiveSnapshot(snap, /Standard/i);
    if (standard) {
      this.safeClick(standard);
      this.browser.wait(500);
    }
    const snap2 = this.browser.snapshotInteractive();
    const cont = refForEnabledButton(snap2, 'Continue');
    if (cont) {
      this.safeClick(cont);
      this.browser.wait(1500);
      return true;
    }
    return false;
  }

  isScriptUploadScreen(snap: string): boolean {
    return isScriptUploadScreen(snap);
  }

  startWithScript(): boolean {
    let snap = this.browser.snapshotInteractive();
    if (isScriptUploadScreen(snap)) return true;

    let btn = refForInteractiveSnapshot(snap, /Start with Script/i);
    if (!btn) {
      snap = this.browser.snapshotFull();
      btn = refForInteractiveSnapshot(snap, /Start with Script/i);
    }
    if (btn) {
      this.safeClick(btn);
      this.browser.wait(2000);
    } else if (snapshotIncludes(snap, 'Start with Script')) {
      this.browser.clickButtonByText('Start with Script');
      this.browser.wait(2000);
    } else {
      return false;
    }

    try {
      this.waitForSnapshotCondition(
        (s) => isScriptUploadScreen(s),
        config.verificationMaxWaitMs,
        'script upload panel after Start with Script',
      );
      return true;
    } catch {
      return isScriptUploadScreen(this.browser.snapshotInteractive());
    }
  }

  ensureScriptUploadReady(): void {
    if (!this.startWithScript()) {
      throw new Error('Could not open script upload screen (Start with Script)');
    }
  }

  uploadScriptFile(filePath: string): void {
    this.ensureScriptUploadReady();
    const selectors = ['#script-file-input', 'input[type=file]', 'input[accept*=".pdf"]', 'input[accept*="pdf"]'];
    for (const selector of selectors) {
      try {
        this.browser.upload(selector, filePath);
        this.browser.wait(3000);
        return;
      } catch {
        // try next selector
      }
    }
    throw new Error(`Script file input not found for upload at ${this.browser.getUrl()}`);
  }

  clickNext(): boolean {
    this.dismissOverlays();
    const snap = this.browser.snapshotInteractive();
    const next = refForEnabledButton(snap, 'Next');
    if (!next) return false;
    const ok = this.safeClick(next);
    if (ok) this.browser.wait(config.actionDelayMs);
    return ok;
  }

  waitForSnapshotCondition(
    predicate: (snap: string, url: string) => boolean,
    maxMs: number,
    label: string,
  ): void {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const snap = this.browser.snapshotInteractive();
      const url = this.browser.getUrl();
      if (predicate(snap, url)) return;
      this.browser.wait(config.verificationPollMs);
    }
    throw new Error(
      `Timed out waiting for: ${label} (${maxMs}ms) url=${this.browser.getUrl()}`,
    );
  }

  waitForScriptEditIdle(maxMs = config.scriptProcessingWaitMs): void {
    this.waitForSnapshotCondition(
      (snap, url) => isScriptEditIdle(snap, url),
      maxMs,
      'script edit idle with Next enabled',
    );
  }

  waitForNextEnabled(maxMs = config.scriptProcessingWaitMs): void {
    this.waitForSnapshotCondition(
      (snap) => !isButtonDisabled(snap, 'Next'),
      maxMs,
      'Next button enabled',
    );
  }

  waitForCreateVideoReady(): void {
    this.waitForSnapshotCondition(
      (snap) => isCreateVideoReady(snap),
      config.sceneWaitMs,
      'Create Video enabled',
    );
  }

  waitForDownloadReady(): void {
    const snap = this.browser.snapshotInteractive();
    const url = this.browser.getUrl();
    if (isDownloadReady(snap) || isFinalVideoVisible(snap, url)) return;
    this.waitForSnapshotCondition(
      (s, u) => isDownloadReady(s) || isFinalVideoVisible(s, u),
      config.finalWaitMs,
      'final video download or preview',
    );
  }

  dismissCreditModal(): void {
    const snap = this.browser.snapshotInteractive();
    if (
      !snapHas(snap, 'Select Your Plan', 'Taking longer', 'Pro Package') &&
      !(/credit package/i.test(snap))
    ) {
      return;
    }
    const close =
      refForInteractiveSnapshot(snap, /button "×"/i) ??
      refForInteractiveSnapshot(snap, /button "✕"/i);
    if (this.safeClick(close)) this.browser.wait(800);
  }

  /** Close scene/final edit panels that block Create Video or Download. */
  dismissEditPanels(): void {
    this.dismissCreditModal();
    for (const label of ['Close', 'Cancel', 'Done', 'Save']) {
      const snap = this.browser.snapshotInteractive();
      if (!snapHas(snap, 'Edit the scene', 'Edit scene', 'Edit Video', 'Description')) break;
      const ref = refForEnabledButton(snap, label) ?? refForInteractiveSnapshot(snap, new RegExp(`button "${label}"`, 'i'));
      if (ref) {
        this.safeClick(ref);
        this.browser.wait(500);
      }
    }
    this.browser.evalScript(`
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
      document.body.click();
    `);
    this.browser.wait(400);
  }

  selectStyleOptions(): void {
    const snap = this.browser.snapshotInteractive();
    const realistic = refForInteractiveSnapshot(snap, /Realistic/i);
    const landscape = refForInteractiveSnapshot(snap, /Landscape/i);
    if (realistic) {
      this.safeClick(realistic);
      this.browser.wait(500);
    }
    if (landscape) {
      this.safeClick(landscape);
      this.browser.wait(500);
    }
  }

  clickCreateVideo(): void {
    this.dismissEditPanels();
    const snap = this.browser.snapshotInteractive();
    const btn = refForEnabledButton(snap, 'Create Video');
    if (!btn) throw new Error('Create Video not enabled');
    this.safeClick(btn);
    this.browser.wait(3000);
  }

  advanceToTheme(): boolean {
    this.dismissOverlays();
    if (this.clickNext()) {
      this.browser.wait(2500);
      const snap = this.browser.snapshotInteractive();
      const url = this.browser.getUrl();
      if (isThemeStep(snap, url)) return true;
    }
    if (this.clickSidebarStep('Theme') || this.clickSidebarStep('Story Theme')) {
      this.browser.wait(2000);
      const snap = this.browser.snapshotInteractive();
      if (isThemeStep(snap, this.browser.getUrl())) return true;
    }
    return isThemeStep(this.browser.snapshotInteractive(), this.browser.getUrl());
  }

  advanceToStyle(): boolean {
    this.dismissOverlays();
    if (this.clickNext()) {
      this.browser.wait(2500);
      const snap = this.browser.snapshotInteractive();
      if (isStyleStep(snap, this.browser.getUrl())) return true;
    }
    if (this.clickSidebarStep('Style')) {
      this.browser.wait(2000);
      return isStyleStep(this.browser.snapshotInteractive(), this.browser.getUrl());
    }
    return isStyleStep(this.browser.snapshotInteractive(), this.browser.getUrl());
  }

  completeStyleAndAdvance(): boolean {
    this.selectStyleOptions();
    this.dismissCreditModal();
    this.waitForNextEnabled(config.sceneWaitMs);
    if (!this.clickNext()) return false;
    this.browser.wait(3000);
    const url = this.browser.getUrl();
    const snap = this.browser.snapshotInteractive();
    return /editscene/i.test(url) || snapHas(snap, 'Edit scenes', 'Create Video', 'Location');
  }

  isOnWizard(): boolean {
    const snap = this.browser.snapshotInteractive();
    return (
      snapHas(snap, 'Upload file', 'Story Type') ||
      snapHas(snap, 'Review transcript', 'Theme') ||
      /\/(upload|selectStoryType|scriptEdit|selectTheme|selectStyle|editscene|finalvideo)/i.test(
        this.browser.getUrl(),
      )
    );
  }
}

export function isPlanModalOpen(snap: string): boolean {
  return snapshotIncludes(snap, 'Select Your Plan');
}

export function isScriptEditReady(snap: string): boolean {
  return snapHas(snap, 'Edit Script', 'Play audio') && !snapHas(snap, 'Processing Script');
}
