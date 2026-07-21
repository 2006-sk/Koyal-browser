import { config } from '../config.js';
import type { AgentBrowser } from './agent-browser.js';

export interface RuntimeFailure {
  kind: 'page-error' | 'console-error' | 'network-5xx';
  detail: string;
}

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json && json !== '{}' ? json : String(value);
  } catch {
    return String(value);
  }
}

function isIgnored5xx(raw: Record<string, unknown>): boolean {
  const url = typeof raw.url === 'string' ? raw.url : '';
  try {
    return config.ignored5xxHostsPattern.test(new URL(url).hostname);
  } catch {
    return config.ignored5xxHostsPattern.test(url);
  }
}

/** Capture the first concrete product/runtime error currently buffered. */
export function captureRuntimeFailure(browser: AgentBrowser): RuntimeFailure | null {
  const pageErrors = browser.errorsJson().data?.errors ?? [];
  if (pageErrors.length > 0) {
    return { kind: 'page-error', detail: stringifyUnknown(pageErrors[0]) };
  }

  const messages = browser.consoleJson().data?.messages ?? [];
  const consoleError = messages.find((message) => /^(error|assert)$/i.test(message.type));
  if (consoleError) {
    return { kind: 'console-error', detail: consoleError.text || stringifyUnknown(consoleError) };
  }

  const requests = browser.networkRequestsJson().data?.requests ?? [];
  for (const value of requests) {
    if (!value || typeof value !== 'object') continue;
    const request = value as Record<string, unknown>;
    const status = Number(request.status ?? 0);
    if (status >= 500 && !isIgnored5xx(request)) {
      return {
        kind: 'network-5xx',
        detail: `${String(request.method ?? 'GET')} ${String(request.url ?? 'unknown URL')} → ${status}`,
      };
    }
  }
  return null;
}
