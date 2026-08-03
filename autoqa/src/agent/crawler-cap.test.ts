import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDeepWalkCap } from './crawler.js';

test('resolveDeepWalkCap: an explicit CLI cap wins', () => {
  assert.equal(resolveDeepWalkCap(2, 10), 2);
});

test('resolveDeepWalkCap: the configured default remains a finite cap', () => {
  assert.equal(resolveDeepWalkCap(undefined, 10), 10);
});
