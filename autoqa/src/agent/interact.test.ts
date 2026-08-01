import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LlmClient } from '../core/llm/client.js';
import { Interact, resolveHumanOrSupervisor } from './interact.js';
import { ProductionPromptSupervisor } from './prompt-supervisor.js';

function supervisor(answer: string): ProductionPromptSupervisor {
  return new ProductionPromptSupervisor({
    complete: async () => `{"answer":"${answer}","reason":"test decision"}`,
  } as unknown as LlmClient);
}

test('TTY resolution uses a human answer received inside the override window', async () => {
  let cancelled = false;
  const resolved = await resolveHumanOrSupervisor(
    Promise.resolve('human value'),
    'Value needed for field "Description"',
    supervisor('supervisor value'),
    20,
    () => {
      cancelled = true;
    },
  );
  assert.deepEqual(resolved, { answer: 'human value', source: 'human' });
  assert.equal(cancelled, false);
});

test('TTY resolution uses and records a safe supervisor answer after the override window', async () => {
  let cancelled = false;
  const neverHuman = new Promise<string>(() => undefined);
  const resolved = await resolveHumanOrSupervisor(
    neverHuman,
    'Value needed for field "Description"',
    supervisor('A thoughtful architect with a calm expression.'),
    0,
    () => {
      cancelled = true;
    },
  );
  assert.equal(resolved.answer, 'A thoughtful architect with a calm expression.');
  assert.equal(resolved.source, 'supervisor');
  assert.equal(cancelled, true);
});

test('an unsafe or undefined supervisor answer leaves the human prompt active', async () => {
  let cancelled = false;
  const undecided = new ProductionPromptSupervisor({
    complete: async () => '{}',
  } as unknown as LlmClient);
  const human = new Promise<string>((resolve) => setTimeout(() => resolve('human fallback'), 10));
  const resolved = await resolveHumanOrSupervisor(
    human,
    'Value needed for field "Description"',
    undecided,
    0,
    () => {
      cancelled = true;
    },
  );
  assert.deepEqual(resolved, { answer: 'human fallback', source: 'human' });
  assert.equal(cancelled, false);
});

test('detached prompt records the supervisor as the decision source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-interact-supervisor-'));
  const interact = new Interact(dir, 1, 100, supervisor('A calm professional architect.'), 0);
  interact.setDecisionLog(dir);
  try {
    const answer = await interact.ask('Value needed for field "Description"');
    assert.equal(answer, 'A calm professional architect.');
    assert.equal(interact.decisions.at(-1)?.source, 'supervisor');
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8'),
    ) as Array<{ source?: string; answer: string }>;
    assert.equal(saved.at(-1)?.source, 'supervisor');
    assert.equal(saved.at(-1)?.answer, 'A calm professional architect.');
  } finally {
    interact.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
