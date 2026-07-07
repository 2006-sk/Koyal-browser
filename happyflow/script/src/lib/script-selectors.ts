/** Snapshot predicates for script wizard — mirrors audio-selectors patterns. */

export function isCreateVideoReady(s: string): boolean {
  return /button "Create Video"/.test(s) && !/button "Create Video" \[disabled/.test(s);
}

export function isDownloadReady(s: string): boolean {
  return /button "Download Video"/.test(s) && !/button "Download Video" \[disabled/.test(s);
}

export function isFinalVideoVisible(s: string, url: string): boolean {
  return (
    /finalvideo/i.test(url) ||
    isDownloadReady(s) ||
    /Generating Video|Downloading|Preview/i.test(s)
  );
}

export function isThemeStep(s: string, url: string): boolean {
  return /selecttheme/i.test(url) || /story theme/i.test(s);
}

export function isStyleStep(s: string, url: string): boolean {
  return /selectstyle/i.test(url) || /choose art style/i.test(s);
}

export function isScriptUploadScreen(s: string): boolean {
  return /upload your script|choose pdf/i.test(s);
}

export function isUploadFork(s: string): boolean {
  return /how would you like to start|start with script|start with audio/i.test(s);
}

export function isScriptEditIdle(s: string, url: string): boolean {
  return (
    (/scriptedit/i.test(url) || /edit script/i.test(s)) &&
    !/processing script|analyzing|please wait/i.test(s) &&
    !/button "Next" \[disabled/.test(s)
  );
}
