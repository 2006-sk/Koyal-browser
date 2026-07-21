import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeNetworkRequests, pageErrorFromUnknown } from './verification.js';

test('pageErrorFromUnknown preserves a normal message and stack', () => {
  assert.deepEqual(
    pageErrorFromUnknown({ message: 'boom', stack: 'at app.js:1:2' }),
    { message: 'boom', stack: 'at app.js:1:2' },
  );
});

test('pageErrorFromUnknown serializes message-less agent-browser objects', () => {
  const result = pageErrorFromUnknown({ text: 'TypeError: failed', url: 'https://xp.koyal.ai/app.js', line: 42 });
  assert.equal(result.message, '{"text":"TypeError: failed","url":"https://xp.koyal.ai/app.js","line":42}');
  assert.notEqual(result.message, '[object Object]');
});

test('pageErrorFromUnknown handles circular and empty objects without the placeholder', () => {
  const circular: Record<string, unknown> = { name: 'pageerror' };
  circular.self = circular;
  assert.match(pageErrorFromUnknown(circular).message, /"self":"\[Circular\]"/);
  assert.equal(pageErrorFromUnknown({}).message, 'Unknown page error object (no serializable fields)');
});

test('normalizeNetworkRequests redacts credentials in fields and request bodies', () => {
  const originalPassword = 'never-store-this';
  const originalEmail = 'person@example.com';
  const result = normalizeNetworkRequests([{
    url: 'https://example.test/login',
    headers: { authorization: 'Bearer abc.def', cookie: 'session=secret' },
    postData: `{"email":"${originalEmail}","password":"${originalPassword}"}`,
    username: originalEmail,
  }]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /never-store-this|person@example\.com|abc\.def|session=secret/);
  assert.match(serialized, /redacted/);
});
