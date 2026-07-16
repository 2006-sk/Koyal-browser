import { config } from '../config.js';
import { audioSelectors, isAudioUploadScreen, isCreateVideoReady, isDownloadReady, isPlanModalOpen, isTranscriptReady, isUploadFileTabReady, isUploadForkSnapshot } from './audio-selectors.js';
import {
  AgentBrowser,
  isButtonDisabled,
  refForEnabledButton,
  refForInteractiveSnapshot,
  snapshotIncludes,
  snapshotIncludesAny,
} from './agent-browser.js';

export type AudioType = 'Podcast' | 'Narration' | 'Music';
export type PlanType = 'Standard' | 'Pro';

/** Stable id for the tus trim-upload regression on beta (Next after audio type). */
export const KOYAL_BUG_TUS_TRIM_UPLOAD = 'koyal-tus-trim-upload-405';

/**
 * Thrown when the harness correctly drove the UI but Koyal's own Next handler
 * failed (product/infra bug). Callers should record a FAIL step and end the
 * scenario — do not treat this as a harness crash.
 */
export class KoyalProductBugError extends Error {
  readonly bugId: string;
  readonly owner = 'koyal' as const;

  constructor(message: string, bugId: string = KOYAL_BUG_TUS_TRIM_UPLOAD) {
    super(message);
    this.name = 'KoyalProductBugError';
    this.bugId = bugId;
  }
}

export function isKoyalProductBug(error: unknown): error is KoyalProductBugError {
  return error instanceof KoyalProductBugError;
}

/** Detect tus / performTrimAndUpload / handleNext console failures after Next. */
export function readTusTrimUploadBug(browser: AgentBrowser): string | null {
  try {
    const messages = browser.consoleJson()?.data?.messages ?? [];
    const hit = messages.find((m) =>
      /tus upload failed|performTrimAndUpload|Error in handleNext|uploads\/tus|unexpected response while uploading chunk/i.test(
        m.text,
      ),
    );
    if (!hit) return null;
    return (
      `[Koyal product bug · ${KOYAL_BUG_TUS_TRIM_UPLOAD}] ` +
      `Clicking Next on Choose Audio Type calls performTrimAndUpload; tus PATCH ` +
      `/api/user/uploads/tus/* returns nginx HTTP 405 Not Allowed on beta.koyal.ai. ` +
      `UI steps through audio type succeeded; the app cannot advance to Story Type. ` +
      `Console: ${hit.text.slice(0, 220)}. ` +
      `Owner: Koyal (not the QA harness). Last known good full WAV run: 2026-07-11.`
    );
  } catch {
    return null;
  }
}

export class AudioWizardPage {
  constructor(private readonly browser: AgentBrowser) {}

  uploadUrl(): string {
    return `${config.baseUrl.replace(/\/$/, '')}${config.paths.upload}`;
  }

  openFreshUploadFork(): void {
    const projectsUrl = `${config.baseUrl.replace(/\/$/, '')}${config.paths.projects}`;
    this.browser.open(projectsUrl);
    this.browser.wait(2000);

    const snap0 = this.browser.snapshotInteractive();
    const createCard = refForInteractiveSnapshot(snap0, /Create Your Next Video|Create Project|New project/i);
    if (createCard) {
      this.browser.clickVisible(createCard);
      this.browser.wait(2500);
    } else {
      this.browser.open(this.uploadUrl());
      this.browser.wait(2000);
    }

    this.dismissWizardIfOpen();
    const snap = this.browser.snapshotInteractive();
    if (
      audioSelectors.uploadFork.startWithAudio.test(snap) ||
      audioSelectors.uploadFork.heading.test(snap)
    ) {
      return;
    }

    this.browser.open(this.uploadUrl());
    this.browser.wait(2000);
    this.dismissWizardIfOpen();
  }

  dismissWizardIfOpen(): void {
    for (let i = 0; i < 3; i++) {
      const snap = this.browser.snapshotInteractive();
      if (audioSelectors.uploadFork.heading.test(snap)) return;
      if (isAudioUploadScreen(snap)) return;

      const close = refForInteractiveSnapshot(snap, audioSelectors.wizard.closeWizard);
      if (close) {
        this.browser.clickVisible(close);
        this.browser.wait(1000);
        continue;
      }
      break;
    }
  }

  dismissCreditModal(): void {
    const snap = this.browser.snapshotInteractive();
    if (!audioSelectors.style.creditModal.test(snap)) return;
    const close =
      refForInteractiveSnapshot(snap, /button "✕"/i) ??
      refForInteractiveSnapshot(snap, /button "×"/i) ??
      refForInteractiveSnapshot(snap, /button "X"/i);
    if (close) {
      this.browser.clickVisible(close);
      this.browser.wait(800);
    }
  }

  startWithAudio(): void {
    let snap = this.browser.snapshotInteractive();
    if (isAudioUploadScreen(snap)) return;

    const deadline = Date.now() + config.verificationMaxWaitMs;
    while (Date.now() < deadline) {
      snap = this.browser.snapshotInteractive();
      if (isAudioUploadScreen(snap)) return;

      let btn = refForInteractiveSnapshot(snap, audioSelectors.uploadFork.startWithAudio);
      if (!btn) {
        snap = this.browser.snapshotFull();
        btn = refForInteractiveSnapshot(snap, audioSelectors.uploadFork.startWithAudio);
      }

      if (btn) {
        this.browser.clickVisible(btn);
      } else if (snapshotIncludes(snap, 'Start with Audio')) {
        if (!this.browser.clickButtonByText('Start with Audio')) {
          throw new Error(`Start with Audio button not found. URL=${this.browser.getUrl()}`);
        }
      } else {
        throw new Error(`Start with Audio button not found. URL=${this.browser.getUrl()}`);
      }

      const settleDeadline = Date.now() + 8000;
      while (Date.now() < settleDeadline) {
        this.browser.wait(500);
        snap = this.browser.snapshotInteractive();
        if (isAudioUploadScreen(snap)) return;
      }
    }

    throw new Error(
      `Start with Audio did not reach audio upload screen. URL=${this.browser.getUrl()}`,
    );
  }

  ensureAudioUploadScreen(): void {
    let snap = this.browser.snapshotInteractive();
    if (isUploadFileTabReady(snap)) return;
    this.dismissWizardIfOpen();
    snap = this.browser.snapshotInteractive();
    if (isUploadFileTabReady(snap)) return;
    if (audioSelectors.uploadFork.startWithAudio.test(snap) || audioSelectors.uploadFork.heading.test(snap)) {
      this.startWithAudio();
      this.ensureUploadFileTab();
      return;
    }
    if (isAudioUploadScreen(snap)) {
      this.ensureUploadFileTab();
      return;
    }
    this.openFreshUploadFork();
    this.startWithAudio();
    this.ensureUploadFileTab();
  }

  /** After probing Record Audio / Select Sample, restore the file-upload drop zone */
  ensureUploadFileTab(): void {
    for (let i = 0; i < 6; i++) {
      const snap = this.browser.snapshotInteractive();
      if (isUploadFileTabReady(snap)) return;
      if (/\/login/i.test(this.browser.getUrl())) return;

      if (snapshotIncludes(snap, 'Upload File')) {
        this.browser.clickButtonByText('Upload File', true);
        this.browser.wait(1000);
        continue;
      }

      const uploadBtn = refForInteractiveSnapshot(snap, audioSelectors.audioUpload.uploadFile);
      if (uploadBtn) {
        try {
          this.browser.clickVisible(uploadBtn);
          this.browser.wait(1000);
        } catch {
          // continue
        }
      }
    }
  }

  uploadAudioFile(filePath: string): void {
    this.ensureAudioUploadScreen();
    if (/\/login/i.test(this.browser.getUrl())) {
      throw new Error('Session expired before audio upload — re-run after auth restore');
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const url = this.browser.getUrl();
      if (url === 'about:blank' || !/koyal\.ai/i.test(url)) {
        this.browser.open(this.uploadUrl());
        this.browser.wait(2000);
        if (/\/login/i.test(this.browser.getUrl())) {
          throw new Error('REAUTH_REQUIRED');
        }
        if (!isAudioUploadScreen(this.browser.snapshotInteractive())) {
          this.startWithAudio();
        }
      }

      this.ensureUploadFileTab();
      const snap = this.browser.snapshotInteractive();
      if (!audioSelectors.audioUpload.dropZone.test(snap)) {
        this.browser.clickButtonByText('Upload File', true);
        this.browser.wait(1200);
      }

      const dropRef = refForInteractiveSnapshot(
        this.browser.snapshotInteractive(),
        audioSelectors.audioUpload.dropZone,
      );
      if (dropRef) {
        try {
          this.browser.clickVisible(dropRef);
          this.browser.wait(400);
        } catch {
          // best-effort
        }
      }

      const selectors = [
        'input[type=file]',
        '#audio-file-input',
        'input[type="file"]',
        'input[accept*="audio"]',
      ];
      let lastError: Error | undefined;
      for (const sel of selectors) {
        try {
          this.browser.upload(sel, filePath);
          this.browser.wait(3000);
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }

      this.browser.wait(1000);
    }
    throw new Error(`No file input found for audio upload at ${this.browser.getUrl()}`);
  }

  selectPlan(plan: PlanType = 'Standard'): void {
    const deadline = Date.now() + config.verificationMaxWaitMs;
    while (Date.now() < deadline) {
      const snap = this.browser.snapshotInteractive();
      if (!isPlanModalOpen(snap)) {
        if (isUploadForkSnapshot(snap)) {
          throw new Error(`Plan modal missing — still on upload fork at ${this.browser.getUrl()}`);
        }
        return;
      }

      const label =
        plan === 'Standard'
          ? refForInteractiveSnapshot(snap, audioSelectors.planModal.standardLabel)
          : refForInteractiveSnapshot(snap, audioSelectors.planModal.proLabel);
      if (label) this.browser.clickVisible(label);

      this.browser.wait(500);
      const continueRef = refForEnabledButton(this.browser.snapshotInteractive(), 'Continue');
      if (continueRef) {
        this.browser.clickVisible(continueRef);
        this.browser.wait(2000);
        return;
      }
      this.browser.wait(500);
    }
    throw new Error(`Plan modal still open after selecting ${plan}`);
  }

  clickNext(): void {
    this.dismissCreditModal();
    this.waitForNextEnabled(config.verificationMaxWaitMs);
    let snap = this.browser.snapshotInteractive();
    let next = refForEnabledButton(snap, 'Next');
    if (!next) {
      snap = this.browser.snapshotFull();
      next = refForEnabledButton(snap, 'Next');
    }
    if (next) {
      try {
        this.browser.clickVisible(next);
      } catch {
        if (!this.browser.clickButtonByText('Next', true)) {
          throw new Error(`Next click failed (enabled ref ${next}) at ${this.browser.getUrl()}`);
        }
      }
    } else if (!this.browser.clickButtonByText('Next', true)) {
      throw new Error(`Next is not clickable at ${this.browser.getUrl()}`);
    }
    this.browser.wait(config.actionDelayMs);
  }

  selectAudioType(type: AudioType, multilingual: boolean): void {
    this.browser.clickButtonByText(type, true);
    this.browser.wait(800);
    this.answerMultilingual(multilingual);
  }

  /**
   * Multilingual Yes/No is required before Next enables on the audio-type screen.
   * Snapshot after type select shows Next [disabled] until one of these is chosen.
   */
  answerMultilingual(multilingual: boolean): void {
    const label = multilingual ? 'Yes' : 'No';
    const snap = this.browser.snapshotInteractive();
    if (!/is the content multilingual/i.test(snap) && !new RegExp(`button "${label}"`, 'i').test(snap)) {
      // Already past this gate (or UI variant without the question).
      return;
    }
    // Prefer exact button-"No"/"Yes" lines — loose text click can hit unrelated controls.
    const ref = refForInteractiveSnapshot(snap, new RegExp(`button "${label}"`, 'i'));
    if (ref) {
      this.browser.clickVisible(ref);
    } else if (!this.browser.clickButtonByText(label, true)) {
      throw new Error(`Could not click multilingual "${label}" at ${this.browser.getUrl()}`);
    }
    this.browser.wait(800);
    this.waitForNextEnabled(config.verificationMaxWaitMs);
  }

  /**
   * Leave Choose Audio Type → Story Type. Retries multilingual+Next if the SPA
   * swallows the first click, and waits through Analyzing/Uploading.
   *
   * On Next, Koyal runs `performTrimAndUpload` (tus). If that API is broken,
   * throws {@link KoyalProductBugError} so the scenario can record a FAIL
   * (product bug found — not a harness crash).
   */
  advanceToStoryType(preferredType: AudioType = 'Narration'): void {
    const maxMs = Math.max(config.verificationMaxWaitMs, config.transcriptWaitMs);
    const deadline = Date.now() + maxMs;
    let attempts = 0;

    const onStoryType = (url: string, snap: string): boolean =>
      audioSelectors.storyType.heading.test(snap) ||
      /selectStoryType/i.test(url) ||
      (audioSelectors.storyType.conceptDriven.test(snap) &&
        audioSelectors.storyType.characterDriven.test(snap) &&
        !audioSelectors.audioUpload.chooseAudioType.test(snap));

    while (Date.now() < deadline) {
      const url = this.browser.getUrl();
      const snap = this.browser.snapshotInteractive();

      if (onStoryType(url, snap)) return;

      const tusErr = readTusTrimUploadBug(this.browser);
      if (tusErr) throw new KoyalProductBugError(tusErr);

      if (audioSelectors.audioUpload.chooseAudioType.test(snap)) {
        attempts++;
        if (attempts > 4) {
          const tusLate = readTusTrimUploadBug(this.browser);
          if (tusLate) throw new KoyalProductBugError(tusLate);
          throw new Error(
            `Still on Choose Audio Type after ${attempts} advance attempts at ${url}`,
          );
        }
        this.browser.clearSignals();
        this.selectAudioType(preferredType, false);
        this.clickNext();
        this.browser.wait(2500);
        continue;
      }

      this.browser.wait(config.verificationPollMs);
    }

    const tusLate = readTusTrimUploadBug(this.browser);
    if (tusLate) throw new KoyalProductBugError(tusLate);
    throw new Error(
      `Timed out waiting for story type (${maxMs}ms) url=${this.browser.getUrl()} snap=${this.browser.snapshotInteractive().slice(0, 400)}`,
    );
  }

  selectConceptDriven(): void {
    let snap = this.browser.snapshotInteractive();
    let btn = refForInteractiveSnapshot(snap, audioSelectors.storyType.conceptDriven);
    if (!btn) {
      snap = this.browser.snapshotFull();
      btn = refForInteractiveSnapshot(snap, /Concept Driven/i);
    }
    if (btn) {
      this.browser.clickVisible(btn);
      this.browser.wait(1000);
      return;
    }
    if (snapshotIncludes(snap, 'Concept Driven')) {
      this.browser.clickButtonByText('Concept Driven');
      this.browser.wait(1000);
      return;
    }
    throw new Error(`Concept Driven option not found at ${this.browser.getUrl()}`);
  }

  runThroughAudioTypeAndStory(): void {
    this.waitForSnapshotCondition(
      (snap, url) =>
        audioSelectors.audioUpload.chooseAudioType.test(snap) ||
        audioSelectors.storyType.heading.test(snap) ||
        /selectStoryType/.test(url),
      config.verificationMaxWaitMs,
      'audio type or story type screen',
    );

    const snap = this.browser.snapshotInteractive();
    if (audioSelectors.audioUpload.chooseAudioType.test(snap)) {
      this.advanceToStoryType('Podcast');
    } else {
      this.waitForSnapshotCondition(
        (s, url) => audioSelectors.storyType.heading.test(s) || /selectStoryType/.test(url),
        config.verificationMaxWaitMs,
        'story type selection',
      );
    }
    this.selectConceptDriven();
    this.clickNext();
  }

  selectStyleOptions(): void {
    const snap = this.browser.snapshotInteractive();
    const realistic = refForInteractiveSnapshot(snap, audioSelectors.style.realistic);
    const landscape = refForInteractiveSnapshot(snap, audioSelectors.style.landscape);
    const noRadio = refForInteractiveSnapshot(snap, /radio "No"/i);
    if (realistic) this.browser.clickVisible(realistic);
    if (landscape) this.browser.clickVisible(landscape);
    if (noRadio) this.browser.clickVisible(noRadio);
    this.browser.wait(800);
    this.dismissCreditModal();
  }

  clickWizardStep(pattern: RegExp): void {
    let snap = this.browser.snapshotInteractive();
    let ref = refForInteractiveSnapshot(snap, pattern);
    if (!ref) {
      snap = this.browser.snapshotFull();
      ref = refForInteractiveSnapshot(snap, pattern);
    }
    if (!ref) {
      const label = pattern.source.replace(/\\"/g, '"').match(/"([^"]+)"/)?.[1];
      if (label) {
        this.browser.clickButtonByText(label);
        this.browser.wait(500);
        this.browser.dialogAccept();
        this.browser.wait(1500);
        return;
      }
      throw new Error(`Wizard step not found: ${pattern}`);
    }
    this.browser.clickVisible(ref);
    this.browser.wait(500);
    this.browser.dialogAccept();
    this.browser.wait(1500);
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
      `Timed out waiting for: ${label} (${maxMs}ms) url=${this.browser.getUrl()} snap=${this.browser.snapshotInteractive().slice(0, 300)}`,
    );
  }

  waitForTranscriptReady(): void {
    this.waitForSnapshotCondition(
      (snap) => isTranscriptReady(snap),
      config.transcriptWaitMs,
      'audio transcript processing complete',
    );
  }

  waitForTranscriptIdle(): void {
    this.waitForSnapshotCondition(
      (snap) =>
        audioSelectors.transcript.playAudio.test(snap) ||
        audioSelectors.transcript.processingComplete.test(snap) ||
        (audioSelectors.transcript.heading.test(snap) &&
          !isButtonDisabled(snap, 'Next') &&
          !snapshotIncludesAny(snap, ['Understanding emotions', 'Analyzing Audio', 'Uploading audio'])),
      config.transcriptWaitMs,
      'transcript idle with controls or Next enabled',
    );
  }

  waitForCreateVideoReady(): void {
    this.waitForSnapshotCondition(
      (snap) => isCreateVideoReady(snap),
      config.sceneWaitMs,
      'scene generation + Create Video enabled',
    );
  }

  waitForDownloadReady(): void {
    const snap = this.browser.snapshotInteractive();
    if (isDownloadReady(snap)) return;
    this.waitForSnapshotCondition(
      (s) => isDownloadReady(s),
      config.finalWaitMs,
      'final video Download enabled',
    );
  }

  clickCreateVideo(): void {
    this.dismissCreditModal();
    const snap = this.browser.snapshotInteractive();
    const btn = refForEnabledButton(snap, 'Create Video');
    if (!btn) throw new Error('Create Video not enabled');
    this.browser.clickVisible(btn);
    this.browser.wait(3000);
  }

  runAudioUploadPreflight(filePath: string): void {
    this.openFreshUploadFork();
    this.startWithAudio();
    this.uploadAudioFile(filePath);
    this.selectPlan('Standard');

    this.waitForSnapshotCondition(
      (snap) =>
        audioSelectors.audioUpload.chooseAudioType.test(snap) ||
        refForEnabledButton(snap, 'Next') !== null ||
        audioSelectors.audioUpload.analyzing.test(snap),
      config.verificationMaxWaitMs,
      'post-upload plan screen',
    );

    const snap = this.browser.snapshotInteractive();
    if (
      !audioSelectors.audioUpload.chooseAudioType.test(snap) &&
      refForEnabledButton(snap, 'Next')
    ) {
      this.clickNext();
    }
  }


  waitForNextEnabled(maxMs = config.transcriptWaitMs): void {
    this.waitForSnapshotCondition(
      (snap) => !isButtonDisabled(snap, 'Next'),
      maxMs,
      'Next button enabled',
    );
  }

  selectThemeOptions(): void {
    const snap = this.browser.snapshotInteractive();
    const emotion = refForInteractiveSnapshot(snap, /Excited|Calm|Dramatic|Somber/i);
    if (emotion) {
      this.browser.clickVisible(emotion);
      this.browser.wait(800);
      return;
    }
    this.browser.evalScript(`
      const pick = [...document.querySelectorAll('button,div,label')].find(el => {
        const t = (el.textContent||'').trim();
        return t.length > 3 && t.length < 40 && !/Next|Previous|Dashboard|Upload|Theme|Style/i.test(t);
      });
      if (pick) pick.click();
    `);
    this.browser.wait(800);
  }

  runThroughTranscriptThemeStyle(): void {
    this.waitForTranscriptReady();
    this.waitForTranscriptIdle();
    this.waitForNextEnabled();
    this.clickNext();
    this.browser.wait(3000);

    this.waitForSnapshotCondition(
      (snap, url) => /selectTheme/.test(url) || audioSelectors.theme.heading.test(snap),
      config.transcriptWaitMs,
      'theme step',
    );
    this.selectThemeOptions();
    this.waitForNextEnabled(config.transcriptWaitMs);
    this.clickNext();
    this.browser.wait(3000);

    this.waitForSnapshotCondition(
      (snap, url) => /selectStyle/.test(url) || audioSelectors.style.heading.test(snap),
      config.transcriptWaitMs,
      'style step',
    );
    this.selectStyleOptions();
    this.dismissCreditModal();
    this.waitForNextEnabled(config.sceneWaitMs);
    this.clickNext();
    this.browser.wait(3000);
  }

  runThroughScenesAndFinal(): void {
    this.waitForSnapshotCondition(
      (snap, url) => /editscene/.test(url) || isCreateVideoReady(snap),
      config.sceneWaitMs,
      'edit scenes step',
    );

    if (!/editscene/.test(this.browser.getUrl())) {
      this.clickNext();
      this.browser.wait(3000);
    }

    this.waitForCreateVideoReady();
    this.clickCreateVideo();
    this.waitForSnapshotCondition(
      (snap, url) =>
        /finalvideo/.test(url) || isDownloadReady(snap) || audioSelectors.final.generatingVideo.test(snap),
      config.sceneWaitMs,
      'final video page or generating',
    );
    this.waitForDownloadReady();
  }

  isOnTranscriptStep(): boolean {
    const snap = this.browser.snapshotInteractive();
    return audioSelectors.transcript.heading.test(snap) || /lyricedit/.test(this.browser.getUrl());
  }

  goBackToStoryType(): void {
    const snap = this.browser.snapshotInteractive();
    const backBtn = refForEnabledButton(snap, 'Go back to Story Type Selection');
    if (backBtn) {
      this.browser.clickVisible(backBtn);
    } else {
      this.clickWizardStep(audioSelectors.wizard.storyTypeStep);
    }
    this.waitForSnapshotCondition(
      (s, url) => /selectStoryType/.test(url) || audioSelectors.storyType.heading.test(s),
      config.transcriptWaitMs,
      'story type after go back',
    );
  }

  snapshotHasProcessing(): boolean {
    const snap = this.browser.snapshotInteractive();
    return snapshotIncludesAny(snap, [
      'Analyzing Audio',
      'Uploading audio',
      'Generating Scenes',
      'Generating Video',
      'Processing your request',
    ]);
  }

  assertNoBlockingErrors(): void {
    const snap = this.browser.snapshotInteractive();
    if (audioSelectors.errors.somethingWrong.test(snap)) {
      throw new Error('Something went wrong visible on page');
    }
  }

  isNextDisabled(): boolean {
    return isButtonDisabled(this.browser.snapshotInteractive(), 'Next');
  }
}
