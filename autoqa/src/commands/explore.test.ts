import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attemptInitialAuth } from './explore.js';

/**
 * #initial-login-retry: the initial login must retry a transient failure before
 * giving up, instead of stranding the whole explore unauthenticated on the first
 * throw (koyal run #1 was 7/5/2 for exactly that — a first-call Anthropic 529).
 * `sleep` is stubbed to a no-op so the test doesn't wait real backoff seconds.
 */
const noSleep = async () => {};

test('attemptInitialAuth: succeeds on the first try without retrying (public/normal site)', async () => {
  let calls = 0;
  const ok = await attemptInitialAuth(async () => { calls++; }, 3, noSleep);
  assert.equal(ok, true);
  assert.equal(calls, 1);
});

test('attemptInitialAuth: retries a transient failure then succeeds', async () => {
  let calls = 0;
  const ok = await attemptInitialAuth(
    async () => {
      calls++;
      if (calls < 3) throw new Error('Anthropic request failed (529): overloaded');
    },
    3,
    noSleep,
  );
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test('attemptInitialAuth: exhausts attempts on a persistent failure and returns false (caller continues unauthenticated)', async () => {
  let calls = 0;
  const ok = await attemptInitialAuth(
    async () => { calls++; throw new Error('still down'); },
    3,
    noSleep,
  );
  assert.equal(ok, false);
  assert.equal(calls, 3);
});
