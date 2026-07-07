/** Describe where we are from URL + snapshot — observation only, not navigation. */

export type ScriptPhase =
  | 'login'
  | 'upload-fork'
  | 'script-upload'
  | 'plan-modal'
  | 'processing'
  | 'story-type'
  | 'script-edit'
  | 'theme'
  | 'style'
  | 'locations'
  | 'edit-scenes'
  | 'final-video'
  | 'error'
  | 'app-shell'
  | 'unknown';

export function describeScriptPhase(url: string, snap: string): ScriptPhase {
  const u = url.toLowerCase();
  const s = snap.toLowerCase();

  if (/textbox "email"|textbox "password"|start creating/i.test(s) && /login/i.test(u)) return 'login';
  if (/something went wrong|no dialogue found|character voices data is not/i.test(s)) return 'error';
  if (/how would you like to start|start with script|start with audio/i.test(s)) return 'upload-fork';
  if (/upload your script|choose pdf|script-file/i.test(s)) return 'script-upload';
  if (/select your plan/i.test(s)) return 'plan-modal';
  if (/processing|analyzing|uploading|generating|please wait/i.test(s)) return 'processing';
  if (/concept driven or character driven|character driven|concept driven/i.test(s)) return 'story-type';
  if (u.includes('selectstorytype')) return 'story-type';
  if (u.includes('scriptedit') || /edit script/i.test(s)) return 'script-edit';
  if (u.includes('selecttheme') || /story theme/i.test(s)) return 'theme';
  if (u.includes('selectstyle') || /choose art style/i.test(s)) return 'style';
  if (/add new location/i.test(s)) return 'locations';
  if (u.includes('editscene') || /reshoot generated scenes|create video/i.test(s)) return 'edit-scenes';
  if (u.includes('finalvideo') || /download video/i.test(s)) return 'final-video';
  if (/\/(projects|dashboard|characters|assets)/i.test(u)) return 'app-shell';
  return 'unknown';
}

export function snapHas(snap: string, ...needles: string[]): boolean {
  const lower = snap.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}
