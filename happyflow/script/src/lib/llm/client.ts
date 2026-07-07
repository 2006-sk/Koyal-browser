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

export class LlmClient {
  private readonly provider: LlmProvider;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

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
  }

  async complete(options: LlmCompletionOptions): Promise<string> {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY (or LLM_API_KEY) is not configured');
    }

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
            ...(this.provider === 'openrouter'
              ? { 'HTTP-Referer': 'https://beta.koyal.ai', 'X-Title': 'koyal-qa-agent' }
              : {}),
          },
          body,
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

    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic request failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (!text) {
      throw new Error('Anthropic returned empty response');
    }
    return text;
  }
}

export function parseJsonFromLlm<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`LLM did not return JSON: ${raw}`);
    }
    return JSON.parse(match[0]) as T;
  }
}
