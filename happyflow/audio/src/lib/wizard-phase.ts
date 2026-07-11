/** Detect wizard phase from URL + snapshot — avoids brittle single-button assumptions. */

export type WizardPhase =
  | 'upload-fork'
  | 'audio-upload'
  | 'plan-modal'
  | 'audio-type'
  | 'story-type'
  | 'transcript'
  | 'theme'
  | 'style'
  | 'locations'
  | 'edit-scenes'
  | 'final-video'
  | 'unknown';

export function detectWizardPhase(url: string, snap: string): WizardPhase {
  const u = url.toLowerCase();
  const s = snap.toLowerCase();

  if (/how would you like to start|start with audio/i.test(snap)) return 'upload-fork';
  if (/select your plan/i.test(s)) return 'plan-modal';
  if (/choose audio type/i.test(s)) return 'audio-type';
  if (u.includes('selectstorytype') || /concept driven or character driven/i.test(s)) return 'story-type';
  if (u.includes('lyricedit') || /audio transcript/i.test(s)) return 'transcript';
  if (u.includes('selecttheme') || /story theme/i.test(s)) return 'theme';
  if (u.includes('selectstyle') || /choose art style/i.test(s)) return 'style';
  if (/add new location/i.test(s) || u.includes('location')) return 'locations';
  if (u.includes('editscene') || /reshoot generated scenes/i.test(s)) return 'edit-scenes';
  if (u.includes('finalvideo') || /download video/i.test(s)) return 'final-video';
  if (/upload file|drop your audio|record audio|select sample/i.test(s)) return 'audio-upload';
  return 'unknown';
}

export function snapHas(snap: string, ...needles: string[]): boolean {
  const lower = snap.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}
