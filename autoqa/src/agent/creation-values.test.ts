import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultCreationValue, fillFieldHintFromGoal } from './flow-runner.js';
import { isProvenTrailOutcomeForFlow } from './deep-walker.js';

test('character names default to a normal human name', () => {
  assert.equal(defaultCreationValue('Enter a character name and continue'), 'Jason');
});

test('character descriptions default to natural prose', () => {
  const value = defaultCreationValue('Write the character description');
  assert.match(value, /friendly young pilot/i);
  assert.doesNotMatch(value, /QA-|Zephyr|\d/);
});

test('extracts the actual quoted field label before building the LLM goal', () => {
  assert.equal(
    fillFieldHintFromGoal('On "Outfits": fill "Describe the outfit" with the run marker'),
    'Describe the outfit',
  );
});

test('only terminal deep walks may generate replayable flows', () => {
  assert.equal(isProvenTrailOutcomeForFlow('terminal'), true);
  assert.equal(isProvenTrailOutcomeForFlow('no-progress'), false);
  assert.equal(isProvenTrailOutcomeForFlow('step-cap'), false);
  assert.equal(isProvenTrailOutcomeForFlow('aborted'), false);
});
