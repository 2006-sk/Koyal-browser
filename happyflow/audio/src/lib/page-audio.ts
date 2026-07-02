import { config } from '../config.js';
import { audioSelectors, isAudioUploadScreen, isCreateVideoReady, isDownloadReady, isPlanModalOpen, isTranscriptReady, isUploadFileTabReady } from './audio-selectors.js';
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

    let btn = refForInteractiveSnapshot(snap, audioSelectors.uploadFork.startWithAudio);
    if (!btn) {
      snap = this.browser.snapshotFull();
      btn = refForInteractiveSnapshot(snap, audioSelectors.uploadFork.startWithAudio);
    }
    if (btn) {
      this.browser.clickVisible(btn);
      this.browser.wait(1500);
      return;
    }

    if (snapshotIncludes(snap, 'Start with Audio')) {
      this.browser.clickButtonByText('Start with Audio');
      this.browser.wait(1500);
      return;
    }

    throw new Error(
      `Start with Audio button not found. URL=${this.browser.getUrl()}`,
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
    const deadline = Date.now() + config.verificationMaxWaitMs;
    while (Date.now() < deadline) {
      const snap = this.browser.snapshotInteractive();
      if (isUploadFileTabReady(snap)) return;

      const uploadBtn = refForInteractiveSnapshot(snap, audioSelectors.audioUpload.uploadFile);
      if (uploadBtn) {
        this.browser.clickVisible(uploadBtn);
      } else if (snapshotIncludes(snap, 'Upload File')) {
        this.browser.clickButtonByText('Upload File');
      } else {
        break;
      }
      this.browser.wait(800);
    }

    let snap = this.browser.snapshotInteractive();
    if (isUploadFileTabReady(snap)) return;

    this.browser.evalScript(`
      const btn = [...document.querySelectorAll('button')].find(
        (el) => (el.textContent || '').trim() === 'Upload File',
      );
      if (btn) btn.click();
    `);
    this.browser.wait(1000);
    snap = this.browser.snapshotInteractive();
    if (isUploadFileTabReady(snap)) return;

    this.openFreshUploadFork();
    this.startWithAudio();
    snap = this.browser.snapshotInteractive();
    if (!isUploadFileTabReady(snap)) {
      const uploadBtn = refForInteractiveSnapshot(snap, audioSelectors.audioUpload.uploadFile);
      if (uploadBtn) this.browser.clickVisible(uploadBtn);
      this.browser.wait(1000);
    }
  }

  uploadAudioFile(filePath: string): void {
    this.ensureAudioUploadScreen();
    this.ensureUploadFileTab();

    const snap = this.browser.snapshotInteractive();
    const dropRef = refForInteractiveSnapshot(snap, audioSelectors.audioUpload.dropZone);
    if (dropRef) {
      try {
        this.browser.clickVisible(dropRef);
        this.browser.wait(400);
      } catch {
        // drop zone click is best-effort; upload may still work
      }
    }

    const selectors = ['input[type=file]', '#audio-file-input', 'input[type="file"]'];
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
    throw lastError ?? new Error('No file input found for audio upload');
  }

  selectPlan(plan: PlanType = 'Standard'): void {
    const deadline = Date.now() + config.verificationMaxWaitMs;
    while (Date.now() < deadline) {
      const snap = this.browser.snapshotInteractive();
      if (!isPlanModalOpen(snap)) return;

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
    let snap = this.browser.snapshotInteractive();
    let next = refForEnabledButton(snap, 'Next');
    if (!next) {
      snap = this.browser.snapshotFull();
      next = refForEnabledButton(snap, 'Next');
    }
    if (!next) {
      this.browser.clickButtonByText('Next', true);
      this.browser.wait(config.actionDelayMs);
      return;
    }
    try {
      this.browser.clickVisible(next);
    } catch {
      this.browser.clickButtonByText('Next', true);
    }
    this.browser.wait(config.actionDelayMs);
  }

  selectAudioType(type: AudioType, multilingual: boolean): void {
    this.browser.clickButtonByText(type, true);
    this.browser.wait(800);
    this.browser.clickButtonByText(multilingual ? 'Yes' : 'No', true);
    this.browser.wait(800);
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
      this.selectAudioType('Podcast', false);
      this.clickNext();
    }

    this.waitForSnapshotCondition(
      (snap, url) => audioSelectors.storyType.heading.test(snap) || /selectStoryType/.test(url),
      config.verificationMaxWaitMs,
      'story type selection',
    );
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
    this.waitForSnapshotCondition(
      (snap) => isDownloadReady(snap),
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
