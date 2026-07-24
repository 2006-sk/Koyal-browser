import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDeepWalkCap } from './crawler.js';

test('resolveDeepWalkCap: an explicit CLI cap wins in exhaustive mode', () => {
  assert.equal(resolveDeepWalkCap(2, 3, false, true), 2);
});

test('resolveDeepWalkCap: an explicit environment cap wins in exhaustive mode', () => {
  assert.equal(resolveDeepWalkCap(undefined, 7, true, true), 7);
});

test('resolveDeepWalkCap: exhaustive mode is unlimited only without an explicit cap', () => {
  assert.equal(resolveDeepWalkCap(undefined, 3, false, true), Number.POSITIVE_INFINITY);
});

test('resolveDeepWalkCap: normal mode uses the configured default', () => {
  assert.equal(resolveDeepWalkCap(undefined, 3, false, false), 3);
});
