import type { VerificationExpectation } from './types.js';

export const POST_AUTH_URL = /\/(projects|dashboard|upload|scriptedit|selecttheme|selectstyle|editscene|finalvideo|selectstorytype)/i;

export const SCRIPT_EXPECTATION_BASE: Partial<VerificationExpectation> = {
  allowPageErrors: true,
  allowConsoleErrors: true,
  allowedConsoleErrorPatterns: [
    /Failed to fetch JSON from S3/i,
    /Unexpected token/i,
    /favicon/i,
    /analytics/i,
  ],
  snapshotExcludes: ['Something went wrong', 'no dialogue found'],
};
