import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentBrowser } from './agent-browser.js';
import { captureRuntimeFailure } from './runtime-failure.js';

function browserWith(input: {
  errors?: unknown[];
  messages?: Array<{ text: string; type: string }>;
  requests?: unknown[];
}): AgentBrowser {
  return {
    errorsJson: () => ({ success: true, data: { errors: input.errors ?? [] } }),
    consoleJson: () => ({ success: true, data: { messages: input.messages ?? [] } }),
    networkRequestsJson: () => ({ success: true, data: { requests: input.requests ?? [] } }),
  } as unknown as AgentBrowser;
}

test('runtime processing failure prioritizes page exceptions', () => {
  const failure = captureRuntimeFailure(browserWith({ errors: [{ text: 'render exploded', line: 12 }] }));
  assert.equal(failure?.kind, 'page-error');
  assert.match(failure?.detail ?? '', /render exploded/);
});

test('runtime processing failure detects console errors but not warnings', () => {
  assert.equal(
    captureRuntimeFailure(browserWith({ messages: [{ text: 'slow response', type: 'warning' }] })),
    null,
  );
  assert.deepEqual(
    captureRuntimeFailure(browserWith({ messages: [{ text: 'generation failed', type: 'error' }] })),
    { kind: 'console-error', detail: 'generation failed' },
  );
});

test('runtime processing failure detects unexpected 5xx', () => {
  assert.deepEqual(
    captureRuntimeFailure(
      browserWith({ requests: [{ method: 'POST', url: 'https://app.example.test/api/render', status: 503 }] }),
    ),
    { kind: 'network-5xx', detail: 'POST https://app.example.test/api/render → 503' },
  );
});
