import fs from 'node:fs';
import path from 'node:path';
import { collectProductBugs } from './slack-bugs.js';
import type { RunReport } from './types.js';

/**
 * Per-site run summary — rewritten after EVERY run to `reports/<hostname>.md`.
 * Carries the four things asked for: how many flows were designed, the genuine
 * product bugs (the exact ones posted to Slack), the cost of THIS run, and an
 * estimate of FUTURE-run cost. Agnostic — nothing site-specific.
 */

/** USD per 1M tokens by model id (Anthropic list pricing). */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
};
const FALLBACK_PRICE = { input: 5, output: 25 };

function priceFor(model: string): { input: number; output: number } {
  // tolerate suffixes like "[1m]" / dated variants by stripping to the base id
  const base = model.replace(/\[.*$/, '').trim();
  return PRICING[model] ?? PRICING[base] ?? FALLBACK_PRICE;
}

function usd(inputTokens: number, outputTokens: number, model: string): number {
  const p = priceFor(model);
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

function money(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

export interface SiteSummaryInput {
  reportsDir: string;
  hostname: string;
  report: RunReport;
  model: string;
  credentialsType: string;
  flowsTotal: number;
  flowsApproved: number;
  verdicts: { pass: number; fail: number; review: number };
  /** Whole run (exploration + testing). */
  total: { calls: number; inputTokens: number; outputTokens: number };
  /** Test phase only — the basis for the future-run estimate (future runs skip exploration). */
  testPhase: { calls: number; inputTokens: number; outputTokens: number };
}

export function writeSiteSummary(input: SiteSummaryInput): string {
  const { report, model } = input;
  const bugs = collectProductBugs(report, input.credentialsType);
  const thisCost = usd(input.total.inputTokens, input.total.outputTokens, model);
  const futureCost = usd(input.testPhase.inputTokens, input.testPhase.outputTokens, model);
  const priced = PRICING[model.replace(/\[.*$/, '').trim()] ?? PRICING[model];
  const p = priceFor(model);

  const L: string[] = [];
  L.push(`# AutoQA — ${input.hostname}`);
  L.push('');
  L.push(`_Rewritten after every run. Latest run: \`${report.runId}\` (${report.scenarios.length} flows tested)._`);
  L.push('');
  L.push('## Flows');
  L.push('');
  L.push(`- **Designed:** ${input.flowsTotal} (${input.flowsApproved} selected exploratory/deterministic flows tested)`);
  L.push(
    `- **Verdicts:** ${input.verdicts.pass} PASS · ${input.verdicts.fail} FAIL · ${input.verdicts.review} NEEDS-REVIEW`,
  );
  L.push('');
  L.push('## Cost');
  L.push('');
  L.push(
    `Model \`${model}\` at ${money(p.input)}/1M input · ${money(p.output)}/1M output` +
      (priced ? '' : ' _(pricing not in table — using fallback rate)_') +
      '.',
  );
  L.push('');
  L.push('| Run | LLM calls | Input tok | Output tok | Est. cost |');
  L.push('| --- | ---: | ---: | ---: | ---: |');
  L.push(
    `| **This run** (explore + test) | ${input.total.calls} | ${input.total.inputTokens.toLocaleString()} | ${input.total.outputTokens.toLocaleString()} | **${money(thisCost)}** |`,
  );
  L.push(
    `| **Future runs** (skip explore, replay recipes) | ~${input.testPhase.calls} | ~${input.testPhase.inputTokens.toLocaleString()} | ~${input.testPhase.outputTokens.toLocaleString()} | **~${money(futureCost)} or less** |`,
  );
  L.push('');
  L.push(
    `_Future-run estimate = this run's **test-phase** cost. Exploratory flows continue using the LLM until every milestone is learned, a terminal/persistent artifact is verified, and one complete recipe-validation run succeeds. Only then does the flow become deterministic and replay at **0 LLM calls**; a broken recipe demotes it for self-healing._`,
  );
  L.push('');
  L.push('## Product bugs');
  L.push('');
  L.push(
    bugs.length === 0
      ? '_None this run — no failed milestone carried real site-emitted error evidence (console error, JS exception, 5xx, or 4xx on an /api/ call)._'
      : `${bugs.length} genuine product bug(s) — the exact set posted to Slack:`,
  );
  L.push('');
  for (const bug of bugs) {
    L.push('```');
    L.push(bug);
    L.push('```');
    L.push('');
  }

  const outPath = path.join(input.reportsDir, `${input.hostname}.md`);
  fs.mkdirSync(input.reportsDir, { recursive: true });
  fs.writeFileSync(outPath, `${L.join('\n')}\n`, 'utf8');
  return outPath;
}
