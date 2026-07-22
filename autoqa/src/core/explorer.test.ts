import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { AgentBrowser } from './agent-browser.js';
import type { LlmClient, LlmCompletionOptions } from './llm/client.js';
import {
  Explorer,
  explicitGoalValue,
  hasBlockingValidationState,
  hasInlineProcessing,
  isSensitiveFieldLabel,
  PROCESSING_VISION_POLL_THRESHOLD,
} from './explorer.js';

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

test('vision affirmation is scheduled early in a prolonged processing wait', () => {
  assert.equal(PROCESSING_VISION_POLL_THRESHOLD, 3);
});

test('disabled completion plus visible validation triggers narrow vision', () => {
  assert.equal(
    hasBlockingValidationState(
      '- textbox "Character name"\n- text "This name is already used"\n- button "Finalize character" [disabled]',
    ),
    true,
  );
  assert.equal(hasBlockingValidationState('- button "Finalize character" [disabled]'), false);
  assert.equal(hasBlockingValidationState('- text "This name is already used"\n- button "Cancel"'), false);
});

test('prolonged text-only processing is released by visual completion after three polls', async () => {
  let waits = 0;
  let llmCalls = 0;
  const processingSnapshot = '- text "Generating location..."\n- button "Regenerate"';
  const browser = {
    getUrl: () => 'https://example.test/locations',
    snapshotInteractive: () => processingSnapshot,
    snapshotFull: () => processingSnapshot,
    dialogStatus: () => undefined,
    wait: () => {
      waits++;
    },
    screenshotAnnotated: (filePath: string) => fs.writeFileSync(filePath, Buffer.from('completed-location')),
    errorsJson: () => ({ data: { errors: [] } }),
    consoleJson: () => ({ data: { messages: [] } }),
    networkRequestsJson: () => ({ data: { requests: [] } }),
    clearSignals: () => undefined,
  } as unknown as AgentBrowser;
  const llm = {
    async complete(options: LlmCompletionOptions) {
      llmCalls++;
      if (options.image) {
        return '{"status":"complete","summary":"The generated location and post-generation controls are visible."}';
      }
      return '{"action":"done","reason":"The location generation has finished."}';
    },
  } as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Generate a location image', { maxSteps: 2 });
  assert.equal(result.success, true);
  assert.equal(waits, PROCESSING_VISION_POLL_THRESHOLD);
  assert.equal(llmCalls, 2);
  assert.match(result.stepsTaken.join('\n'), /vision processing affirmation: complete/i);
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
