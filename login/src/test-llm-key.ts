#!/usr/bin/env node
import { config, defaultLlmBaseUrl } from './config.js';
import { LlmClient, parseJsonFromLlm } from './lib/llm/client.js';

async function main(): Promise<void> {
  const provider = config.llm.provider;
  const baseUrl = config.llm.baseUrl || defaultLlmBaseUrl(provider);
  const model = config.llm.model;

  console.log('Provider:', provider);
  console.log('Base URL:', baseUrl);
  console.log('Model:', model);
  console.log('API key set:', Boolean(config.llm.apiKey));
  console.log('Enabled:', config.llm.enabled);
  console.log('');

  if (!config.llm.apiKey) {
    console.error('FAIL: ANTHROPIC_API_KEY (or LLM_API_KEY) is empty');
    process.exit(1);
  }

  const client = new LlmClient();
  const start = Date.now();

  const raw = await client.complete({
    messages: [
      { role: 'system', content: 'Reply with JSON only.' },
      { role: 'user', content: 'Return {"status":"ok","message":"LLM API key works"}' },
    ],
    maxTokens: 100,
  });

  const parsed = parseJsonFromLlm<{ status: string; message: string }>(raw);
  const ms = Date.now() - start;

  console.log('Response time:', `${ms}ms`);
  console.log('Raw:', raw.slice(0, 200));
  console.log('Parsed:', JSON.stringify(parsed));

  if (parsed.status === 'ok') {
    console.log('\n✅ LLM API key test PASSED');
    process.exit(0);
  }

  console.error('\n❌ Unexpected response');
  process.exit(1);
}

main().catch((err) => {
  console.error('\n❌ LLM API key test FAILED');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
