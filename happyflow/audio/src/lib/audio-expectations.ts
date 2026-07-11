import type { VerificationExpectation } from './types.js';

export const AUDIO_CONSOLE_ALLOWLIST: RegExp[] = [
  /favicon/i,
  /posthog/i,
  /google-analytics/i,
  /mux\.com/i,
  /socket\.io/i,
  /ResizeObserver/i,
  /Unable to play media/i,
  /Failed to fetch JSON from S3/i,
  /Failed to fetch data/i,
  /Unexpected token '<'/i,
  /is not valid JSON/i,
];

export const AUDIO_EXPECTATION_BASE: Partial<VerificationExpectation> = {
  allowPageErrors: true,
  allowConsoleErrors: false,
  allowedConsoleErrorPatterns: AUDIO_CONSOLE_ALLOWLIST,
  maxUnexpectedNetwork5xx: 1,
  uglyErrorPatterns: [
    /Internal Server Error/i,
    /TypeError:/i,
    /SyntaxError:/i,
    /Something went wrong/i,
    /Character voices data is not generated/i,
    /projectId.*empty/i,
  ],
  snapshotExcludes: ['Something went wrong', 'No dialogue found'],
};

export const POST_AUTH_URL = /\/(dashboard|projects|upload|lyricedit|selectTheme|selectStyle|editscene|finalvideo|selectStoryType)/;
