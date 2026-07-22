import type { NetworkRequest } from './types.js';

/**
 * URLs that look like an authentication / login *submit*. Deliberately broad
 * across the products this project tests (Koyal's `.../user/userLogin`, generic
 * `/login`, `/signin`, `/auth`, `/session`, `/authenticate`).
 */
export const AUTH_URL_RE = /(userlogin|\/login\b|sign[-_]?in|\/auth\b|authenticate|\/session\b)/i;

/**
 * The most recent COMPLETED authentication request (one that actually has a
 * numeric response status). Two traps this guards against, both seen live on
 * filmarena.ai's `/auth`:
 *  - A GET document load of the `/auth` PAGE returns 200 and matches the URL
 *    pattern too; mistaking it for a successful login submit would false-pass a
 *    failed login. So only POST/PUT or fetch/xhr requests count as a submit.
 *  - Right after the submit click the POST is still PENDING (no status yet);
 *    those are skipped so the caller keeps waiting instead of reading a stale one.
 * Last match wins → the most recent attempt's outcome.
 */
export function pickAuthResponse(
  requests: NetworkRequest[],
  pattern: RegExp = AUTH_URL_RE,
): NetworkRequest | undefined {
  let match: NetworkRequest | undefined;
  for (const r of requests) {
    const url = typeof r.url === 'string' ? r.url : '';
    if (!url || !pattern.test(url)) continue;
    if (typeof r.status !== 'number') continue; // still pending / no response captured
    const method = (r.method ?? '').toUpperCase();
    const rtype = String(r.resourceType ?? '').toLowerCase();
    const isSubmit = method === 'POST' || method === 'PUT' || rtype === 'fetch' || rtype === 'xhr';
    if (!isSubmit) continue; // skip the GET document/page-load of the auth URL
    match = r;
  }
  return match;
}

export type AuthOutcome = 'ok' | 'rate-limited' | 'rejected' | 'server-error';

export function classifyAuthStatus(status: number): AuthOutcome {
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'rejected';
  if (status >= 500) return 'server-error';
  if (status >= 200 && status < 300) return 'ok';
  return 'rejected'; // any other 4xx: the submit reached the backend and was refused
}

export function describeAuthFailure(status: number): string {
  const label = {
    'rate-limited': 'rate limited',
    rejected: 'credentials rejected or request refused',
    'server-error': 'server error',
    ok: 'accepted',
  }[classifyAuthStatus(status)];
  return `auth endpoint returned HTTP ${status} (${label})`;
}

/**
 * What the auth module should do after a login attempt that did NOT visibly
 * reach the app shell, given the observed auth-endpoint status:
 *  - undefined  → no auth request ever fired ⇒ the submit likely never
 *                 dispatched (a click-loss); one fresh retry is worthwhile.
 *  - >= 400     → the backend refused it (429 rate-limit, 401/403 rejected,
 *                 5xx error). Retrying re-submits — it can only DEEPEN a 429 and
 *                 fails identically on wrong creds. Do NOT retry; report it.
 *  - 2xx        → the login POST was accepted; the explorer just didn't observe
 *                 the app shell. Don't re-submit — verify the session directly.
 */
export function loginRetryDecision(status: number | undefined): 'retry' | 'blocked' | 'verify' {
  if (status === undefined) return 'retry';
  if (status >= 400) return 'blocked';
  return 'verify';
}
