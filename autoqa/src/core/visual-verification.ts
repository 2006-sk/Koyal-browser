import fs from 'node:fs';
import { LlmClient, parseJsonFromLlm } from './llm/client.js';

export interface VisualAssessment {
  status: 'clear' | 'concern' | 'uncertain';
  summary: string;
  concerns: string[];
}

export interface ProcessingVisualAssessment {
  status: 'active' | 'complete' | 'blocked' | 'uncertain';
  summary: string;
}

/**
 * Corroborating visual oracle. It may surface a concern for review, but callers
 * must never use it to turn a deterministic failure into a pass.
 */
export async function assessScreenshot(
  llm: LlmClient,
  screenshotPath: string,
  context: { action: string; expected: string; url: string; observations?: string },
): Promise<VisualAssessment> {
  const data = fs.readFileSync(screenshotPath).toString('base64');
  const raw = await llm.complete({
    messages: [
      {
        role: 'system',
        content:
          'You are a conservative visual QA reviewer. Inspect only visible evidence. ' +
          'Look for validation errors, disabled/stuck progress states, overlays, visibly wrong values, missing expected outcomes, or broken layout. ' +
          'Do not judge artistic quality and do not claim success when the screenshot cannot prove it. Return JSON only.',
      },
      {
        role: 'user',
        content:
          `Action: ${context.action}\nExpected: ${context.expected}\nURL: ${context.url}\n` +
          `${'observations' in context && context.observations ? `Explorer actions:\n${String(context.observations)}\n` : ''}` +
          'Return {"status":"clear|concern|uncertain","summary":"one sentence","concerns":["..."]}. ' +
          'Use concern only for a concrete visible problem; use uncertain when the screenshot simply cannot prove the outcome.',
      },
    ],
    image: { data, mediaType: 'image/png' },
    maxTokens: 500,
  });
  const parsed = parseJsonFromLlm<Partial<VisualAssessment>>(raw);
  const status = parsed.status;
  if (status !== 'clear' && status !== 'concern' && status !== 'uncertain') {
    throw new Error(`Invalid visual assessment status: ${String(status)}`);
  }
  return {
    status,
    summary: String(parsed.summary ?? 'No visual summary supplied'),
    concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
  };
}

/**
 * Resolve a contradiction between the text detector and the rendered page.
 * "complete" only means the asynchronous operation has finished; it does not
 * assert that the caller's entire creation flow or milestone is complete.
 */
export async function assessProcessingScreenshot(
  llm: LlmClient,
  screenshotPath: string,
  context: { action: string; url: string; observations?: string },
): Promise<ProcessingVisualAssessment> {
  const data = fs.readFileSync(screenshotPath).toString('base64');
  const raw = await llm.complete({
    messages: [
      {
        role: 'system',
        content:
          'You are a conservative visual state verifier for browser automation. Inspect only visible evidence. ' +
          'Classify whether an asynchronous operation is actively running, visibly finished, visibly blocked, or cannot be determined. ' +
          'A finished generated preview with usable Edit/Revert/Regenerate/Save/Next controls is complete even when static copy mentions generating. ' +
          'A spinner, changing progress/ETA, disabled Generating/Rendering control, or explicit wait message is active. ' +
          'A validation error, failed generation, disabled completion control with a visible reason, or required-field error is blocked. ' +
          'Do not judge artistic quality. Return JSON only.',
      },
      {
        role: 'user',
        content:
          `Operation: ${context.action}\nURL: ${context.url}\n` +
          `${context.observations ? `Text observations:\n${context.observations}\n` : ''}` +
          'Return {"status":"active|complete|blocked|uncertain","summary":"one sentence grounded in visible evidence"}. ' +
          'Use complete only for the async operation, not for the overall workflow.',
      },
    ],
    image: { data, mediaType: 'image/png' },
    maxTokens: 350,
  });
  const parsed = parseJsonFromLlm<Partial<ProcessingVisualAssessment>>(raw);
  const status = parsed.status;
  if (status !== 'active' && status !== 'complete' && status !== 'blocked' && status !== 'uncertain') {
    throw new Error(`Invalid processing visual status: ${String(status)}`);
  }
  return {
    status,
    summary: String(parsed.summary ?? 'No processing-state summary supplied'),
  };
}
