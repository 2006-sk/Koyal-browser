/** Regex patterns on agent-browser snapshot -i lines */

export const audioSelectors = {
  uploadFork: {
    startWithAudio: /Start with Audio/i,
    startWithScript: /button "Start with Script"/i,
    heading: /How would you like to start/i,
  },
  audioUpload: {
    uploadFile: /button "Upload File"/i,
    recordAudio: /button "Record Audio"/i,
    selectSample: /button "Select Sample"/i,
    dropZone: /Drop your audio or video file here/i,
    chooseAudioType: /Choose Audio Type/i,
    analyzing: /Analyzing Audio/i,
    uploading: /Uploading audio/i,
  },
  planModal: {
    heading: /Select Your Plan/i,
    standardLabel: /LabelText "Standard/i,
    proLabel: /LabelText "Pro/i,
    continue: /button "Continue"/i,
    close: /button "×"|button "✕"|button "X"/i,
  },
  storyType: {
    heading: /concept driven or character driven/i,
    conceptDriven: /button "Concept Driven"/i,
    characterDriven: /button "Character Driven"/i,
    goBackAudio: /Go back to upload audio/i,
  },
  transcript: {
    heading: /Audio transcript/i,
    processingComplete: /Processing complete/i,
    playAudio: /Play audio/i,
    saveDraft: /button "Save as Draft"/i,
  },
  theme: {
    heading: /Story Theme/i,
  },
  style: {
    heading: /Choose art style/i,
    realistic: /generic "Realistic"/i,
    landscape: /LabelText "Landscape"/i,
    creditModal: /Choose Your Credit Package/i,
  },
  scenes: {
    heading: /edit or completely reshoot generated scenes/i,
    createVideo: /button "Create Video"/i,
    generating: /Generating Scenes/i,
  },
  final: {
    downloadVideo: /button "Download Video"/i,
    generatingVideo: /Generating Video/i,
    previewShot: /Preview \d Shot/i,
    exportXml: /Export XML/i,
  },
  wizard: {
    uploadStep: /generic "Upload file"/i,
    storyTypeStep: /generic "Story Type"/i,
    reviewStep: /generic "Review transcript"/i,
    themeStep: /generic "Theme"/i,
    styleStep: /generic "Style"/i,
    locationsStep: /generic "Locations"/i,
    editScenesStep: /generic "Edit scenes"/i,
    finalVideoStep: /generic "Final video"/i,
    closeWizard: /button "×"/i,
  },
  errors: {
    somethingWrong: /Something went wrong/i,
    noDialogue: /No dialogue found/i,
  },
} as const;

export function isUploadForkSnapshot(s: string): boolean {
  return audioSelectors.uploadFork.heading.test(s);
}

export function isAudioUploadScreen(s: string): boolean {
  return (
    audioSelectors.audioUpload.dropZone.test(s) ||
    audioSelectors.audioUpload.uploadFile.test(s)
  );
}

/** Upload File tab active — drop zone or file input available (not Record/Sample panel) */
export function isUploadFileTabReady(s: string): boolean {
  if (audioSelectors.audioUpload.dropZone.test(s)) return true;
  if (/Select Plan to Record|Start Recording|sample audio/i.test(s)) return false;
  return audioSelectors.audioUpload.uploadFile.test(s);
}

export function isPlanModalOpen(s: string): boolean {
  return audioSelectors.planModal.heading.test(s);
}

export function isTranscriptReady(s: string): boolean {
  if (audioSelectors.transcript.processingComplete.test(s)) return true;
  if (audioSelectors.transcript.playAudio.test(s)) return true;
  if (audioSelectors.transcript.heading.test(s) && !audioSelectors.audioUpload.analyzing.test(s)) {
    return true;
  }
  return false;
}

export function isCreateVideoReady(s: string): boolean {
  return /button "Create Video"/.test(s) && !/button "Create Video" \[disabled/.test(s);
}

export function isDownloadReady(s: string): boolean {
  return /button "Download Video"/.test(s) && !/button "Download Video" \[disabled/.test(s);
}
