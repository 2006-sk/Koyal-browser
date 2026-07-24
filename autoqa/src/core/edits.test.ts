import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentBrowser } from './agent-browser.js';
import { fillFieldByHint } from './edits.js';

test('hint-based deterministic fill prefers a real browser fill for controlled inputs', () => {
  const value = 'A mahogany gramophone with a brass horn';
  let filledRef = '';
  let filledValue = '';
  let evalCalls = 0;
  let snapshot = '- textbox "Describe asset" [ref=e24]';
  const browser = {
    snapshotInteractive: () => snapshot,
    fillVisible: (ref: string, text: string) => {
      filledRef = ref;
      filledValue = text;
      snapshot = `- textbox "Describe asset" [ref=e24]: ${text}`;
    },
    wait() {},
    evalScript() {
      evalCalls++;
      return '';
    },
  } as unknown as AgentBrowser;

  const result = fillFieldByHint(browser, 'Describe asset', value);

  assert.equal(result.ok, true);
  assert.equal(filledRef, '@e24');
  assert.equal(filledValue, value);
  assert.equal(evalCalls, 0);
});
