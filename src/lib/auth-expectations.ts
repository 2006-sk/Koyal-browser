/** Shared console noise patterns for post-login app shell (not app bugs). */
export const APP_SHELL_CONSOLE_ALLOWLIST: RegExp[] = [
  /Failed to load resource/i,
  /Route .* not found in preload map/i,
  /WebSocket connection.*failed/i,
  /socket\.io/i,
];

/** Post-auth URL patterns — login → /projects; new signup after OTP → /upload (onboarding). */
export const POST_LOGIN_URL = /\/(dashboard|projects|collaborated-projects|upload)/;

export function isPostAuthUrl(url: string): boolean {
  return POST_LOGIN_URL.test(url);
}
