import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTH_URL_RE,
  classifyAuthStatus,
  describeAuthFailure,
  loginRetryDecision,
  pickAuthResponse,
} from './auth-response.js';
import type { NetworkRequest } from './types.js';

// The exact shape observed live on filmarena.ai's /auth: a GET document load of
// the auth PAGE (200) plus the real POST login submit (429).
const filmarenaLike: NetworkRequest[] = [
  { url: 'https://filmarena.ai/auth', method: 'GET', status: 200, resourceType: 'Document' },
  { url: 'https://beta.koyal.ai/v1/api/user/userLogin', method: 'OPTIONS', status: 200, resourceType: 'Other' },
  { url: 'https://beta.koyal.ai/v1/api/user/userLogin', method: 'POST', status: 429, resourceType: 'Fetch' },
];

test('pickAuthResponse ignores the GET page-load and returns the POST login submit', () => {
  const resp = pickAuthResponse(filmarenaLike);
  assert.equal(resp?.status, 429);
  assert.equal(resp?.method, 'POST');
});

test('pickAuthResponse skips still-pending requests (no numeric status)', () => {
  const pending: NetworkRequest[] = [
    { url: 'https://x/api/userLogin', method: 'POST', resourceType: 'Fetch' }, // pending
  ];
  assert.equal(pickAuthResponse(pending), undefined);
});

test('pickAuthResponse returns undefined when only a GET document load matches', () => {
  const docOnly: NetworkRequest[] = [
    { url: 'https://site/auth', method: 'GET', status: 200, resourceType: 'Document' },
  ];
  assert.equal(pickAuthResponse(docOnly), undefined);
});

test('pickAuthResponse takes the most recent matching submit (last wins)', () => {
  const two: NetworkRequest[] = [
    { url: 'https://x/login', method: 'POST', status: 429, resourceType: 'Fetch' },
    { url: 'https://x/login', method: 'POST', status: 200, resourceType: 'Fetch' },
  ];
  assert.equal(pickAuthResponse(two)?.status, 200);
});

test('AUTH_URL_RE matches the login/auth endpoints but not arbitrary app calls', () => {
  assert.ok(AUTH_URL_RE.test('https://beta.koyal.ai/v1/api/user/userLogin'));
  assert.ok(AUTH_URL_RE.test('https://site/api/signin'));
  assert.ok(AUTH_URL_RE.test('https://site/auth'));
  assert.ok(!AUTH_URL_RE.test('https://site/api/generate/video'));
});

test('classifyAuthStatus maps statuses to outcomes', () => {
  assert.equal(classifyAuthStatus(429), 'rate-limited');
  assert.equal(classifyAuthStatus(401), 'rejected');
  assert.equal(classifyAuthStatus(403), 'rejected');
  assert.equal(classifyAuthStatus(400), 'rejected');
  assert.equal(classifyAuthStatus(200), 'ok');
  assert.equal(classifyAuthStatus(500), 'server-error');
});

test('loginRetryDecision: retry only when no auth request fired; never re-submit a refusal', () => {
  assert.equal(loginRetryDecision(undefined), 'retry'); // submit never dispatched (click-loss)
  assert.equal(loginRetryDecision(429), 'blocked'); // rate-limited — retry would deepen it
  assert.equal(loginRetryDecision(401), 'blocked'); // wrong creds — fails identically
  assert.equal(loginRetryDecision(500), 'blocked');
  assert.equal(loginRetryDecision(200), 'verify'); // accepted — verify session, don't re-submit
});

test('describeAuthFailure is human-readable and carries the status', () => {
  assert.match(describeAuthFailure(429), /429/);
  assert.match(describeAuthFailure(429), /rate limited/);
});
