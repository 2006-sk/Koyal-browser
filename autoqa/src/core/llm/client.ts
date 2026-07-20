import { config, defaultLlmBaseUrl } from '../../config.js';

export type LlmProvider = 'openai' | 'anthropic' | 'openrouter' | 'custom';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionOptions {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
}

export class LlmBudgetExceededError extends Error {
  constructor(budget: number) {
    super(`LLM call budget exhausted (${budget} calls). Re-run with a higher --budget or rely on cached recipes.`);
    this.name = 'LlmBudgetExceededError';
  }
}

export class LlmClient {
  private readonly provider: LlmProvider;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  /** Cumulative calls across all clients this process */
  static callCount = 0;
  /** Hard cap; 0 = unlimited */
  static budget = 0;

  constructor(options?: {
    provider?: LlmProvider;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }) {
    this.provider = options?.provider ?? config.llm.provider;
    this.apiKey = options?.apiKey ?? config.llm.apiKey;
    this.baseUrl = (options?.baseUrl ?? config.llm.baseUrl) || defaultLlmBaseUrl(this.provider);
    this.model = options?.model ?? config.llm.model;
    this.timeoutMs = config.llm.requestTimeoutMs;
  }

  async complete(options: LlmCompletionOptions): Promise<string> {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY (or LLM_API_KEY) is not configured');
    }
    if (LlmClient.budget > 0 && LlmClient.callCount >= LlmClient.budget) {
      throw new LlmBudgetExceededError(LlmClient.budget);
    }
    LlmClient.callCount++;

    if (this.provider === 'anthropic') {
      return this.completeAnthropic(options);
    }

    return this.completeOpenAiCompatible(options);
  }

  private async completeOpenAiCompatible(options: LlmCompletionOptions): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 800,
      messages: options.messages,
      response_format: { type: 'json_object' },
    });

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...(this.provider === 'openrouter' ? { 'X-Title': 'autoqa' } : {}),
          },
          body,
          // Scale the timeout per attempt — a legitimately slow (not stalled) call
          // that needs longer than the base timeout would otherwise abort identically
          // on all 3 attempts for the same underlying reason (genuine latency), turning
          // a call that used to succeed (pre-timeout) into a deterministic failure.
          signal: AbortSignal.timeout(this.timeoutMs * attempt),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`LLM request failed (${response.status}): ${text}`);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('LLM returned empty response');
        return content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastError ?? new Error('LLM request failed');
  }

  private async completeAnthropic(options: LlmCompletionOptions): Promise<string> {
    const system = options.messages.find((m) => m.role === 'system')?.content ?? '';
    const messages = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens ?? 800,
      system,
      messages,
    };
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          // Scale the timeout per attempt — a legitimately slow (not stalled) call
          // that needs longer than the base timeout would otherwise abort identically
          // on all 3 attempts for the same underlying reason (genuine latency), turning
          // a call that used to succeed (pre-timeout) into a deterministic failure.
          signal: AbortSignal.timeout(this.timeoutMs * attempt),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Anthropic request failed (${response.status}): ${text}`);
        }

        const data = (await response.json()) as {
          content?: Array<{ type: string; text?: string }>;
        };
        const text = data.content?.find((c) => c.type === 'text')?.text;
        if (!text) {
          throw new Error('Anthropic returned empty response');
        }
        return text;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastError ?? new Error('Anthropic request failed');
  }
}

/**
 * Extract every complete, brace-balanced `{...}` substring in `text`, in
 * order, tracking quoted-string state so braces inside string values (e.g.
 * `"reason": "the {selector} syntax"`) don't miscount and so a stray `{`
 * appearing in prose before the real object doesn't get anchored on alone —
 * scanning continues past it to any later balanced object too. A span that
 * never returns to depth 0 (truncated/incomplete JSON) ends the scan.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf('{', searchFrom);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (inString) {
        if (ch === '\\') escapeNext = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break; // unbalanced from here to the end — nothing more to find
    objects.push(text.slice(start, end + 1));
    searchFrom = end + 1;
  }
  return objects;
}

/**
 * The LLM is expected to reply with exactly one small JSON object, but
 * occasionally returns two objects back-to-back, an abandoned self-correction
 * followed by the real answer, or JSON plus prose containing a stray `{`. The
 * old fallback (greedy first-`{`-to-last-`}`) glued any of these into invalid
 * JSON and threw uncaught, which killed the entire calling flow rather than
 * just this one step (2026-07-17, 4 of 10 koyal flows crashed this way).
 * Extracting every balanced candidate and preferring the LAST one that
 * actually parses — rather than blindly the first — recovers the model's
 * final/corrected answer in a self-correction reply, and skips past an
 * earlier stray `{` (e.g. in "ref {e12} looks right. {\"action\":...}") that
 * would otherwise be mistaken for the whole object. A still-bad parse is
 * always wrapped in a typed error so a caller can catch and contain it
 * instead of an uncaught JSON.parse throw.
 */
export function parseJsonFromLlm<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const candidates = extractJsonObjects(trimmed);
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(candidates[i]) as T;
      } catch {
        // try the next-earliest candidate
      }
    }
    throw new Error(`LLM did not return parseable JSON: ${raw}`);
  }
}
