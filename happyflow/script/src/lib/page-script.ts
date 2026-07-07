import { config } from '../config.js';
import {
  AgentBrowser,
  refForEnabledButton,
  refForInteractiveSnapshot,
  snapshotIncludes,
} from './agent-browser.js';
import { snapHas } from './script-phase.js';

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
    const snap = this.browser.snapshotInteractive();

    if (snapHas(snap, 'Report a Bug')) {
      for (const pat of [/button "Cancel"/i, /button "×"/i, /button "✕"/i, /button "X"/i]) {
        const btn = refForInteractiveSnapshot(snap, pat);
        if (this.safeClick(btn)) {
          this.browser.wait(700);
          return;
        }
      }
    }

    if (snapHas(snap, 'Select Your Plan', 'credit', 'Taking longer', 'Pro Package')) {
      const close =
        refForInteractiveSnapshot(snap, /button "×"/i) ??
        refForInteractiveSnapshot(snap, /button "✕"/i);
      if (this.safeClick(close)) this.browser.wait(700);
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

  clickNext(): boolean {
    const snap = this.browser.snapshotInteractive();
    const next = refForEnabledButton(snap, 'Next');
    if (!next) return false;
    return this.safeClick(next);
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
