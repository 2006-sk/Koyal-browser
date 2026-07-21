import assert from 'node:assert/strict';
import test from 'node:test';
import { explicitGoalValue, hasInlineProcessing, isSensitiveFieldLabel } from './explorer.js';

test('disabled GENERATING button is treated as active processing', () => {
  assert.equal(hasInlineProcessing('- button "GENERATING" [disabled]'), true);
});

test('static generation copy is not treated as active processing', () => {
  assert.equal(hasInlineProcessing('- heading "AI Image Generation"'), false);
});

test('avatar generation overlay is treated as active processing', () => {
  assert.equal(hasInlineProcessing('- status "Generating avatar..."'), true);
});

test('rendering status prose is treated as active processing', () => {
  assert.equal(
    hasInlineProcessing('YOUR FILM IS RENDERING. CUSTOMIZE YOUR TITLE CARD AND EXPLORE FUN FACTS WHILE YOU WAIT.'),
    true,
  );
  assert.equal(hasInlineProcessing('NOW IN PRODUCTION 00:10'), true);
});

test('static rendering settings copy is not treated as active processing', () => {
  assert.equal(hasInlineProcessing('- heading "Video Rendering Settings"'), false);
});

test('extracts the authoritative explicit edit value from a goal', () => {
  assert.equal(
    explicitGoalValue('Edit transcript\nWhen entering test text, use exactly: "The quiet dawn"'),
    'The quiet dawn',
  );
});

test('credential labels use the protected fill channel', () => {
  assert.equal(isSensitiveFieldLabel('PASSWORD'), true);
  assert.equal(isSensitiveFieldLabel('Email address'), true);
  assert.equal(isSensitiveFieldLabel('Character name'), false);
});
