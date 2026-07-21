import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LlmClient, LlmCompletionOptions } from './llm/client.js';
import { assessScreenshot } from './visual-verification.js';

test('visual assessment sends the screenshot and parses a conservative concern', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-visual-test-'));
  const screenshot = path.join(dir, 'shot.png');
  fs.writeFileSync(screenshot, Buffer.from('fake-png'));
  let captured: LlmCompletionOptions | undefined;
  const fakeLlm = {
    async complete(options: LlmCompletionOptions) {
      captured = options;
      return '{"status":"concern","summary":"Generation is visibly stuck","concerns":["Disabled GENERATING button"]}';
    },
  } as LlmClient;
  try {
    const result = await assessScreenshot(fakeLlm, screenshot, {
      action: 'Create character',
      expected: 'Generated character appears',
      url: 'https://example.test/characters',
    });
    assert.equal(result.status, 'concern');
    assert.equal(captured?.image?.mediaType, 'image/png');
    assert.equal(captured?.image?.data, Buffer.from('fake-png').toString('base64'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
