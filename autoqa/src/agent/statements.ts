import crypto from 'node:crypto';
import { parseJsonFromLlm, type LlmClient } from '../core/llm/client.js';
import type { SignalBundle, VerificationExpectation } from '../core/types.js';
import type { Interact } from './interact.js';
import type { SiteState } from './site-state.js';

export type StatementClass = 'success' | 'failure' | 'noise';

export interface StatementEntry {
  /** sha1 of normalized text */
  key: string;
  /** lowercased, ids/numbers/emails/quoted-names masked */
  normalized: string;
  /** regex source with masks widened to .*? — used for matching + expectations */
  pattern: string;
  /** first raw sighting, for display */
  raw: string;
  classification: StatementClass;
  /** 'global' or a pageId */
  scope: string;
  /** 'snapshot' for visible page text, 'console' for console errors */
  kind: 'snapshot' | 'console';
  decidedBy: 'human' | 'llm';
  decidedAt: string;
  seenCount: number;
}

const MASK = '«x»';

export function normalizeStatement(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, MASK) // emails
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, MASK) // uuids
    .replace(/"[^"]{1,60}"|'[^']{1,60}'|«[^»]{1,60}»/g, MASK) // quoted names
    .replace(/\b\d[\d,.]*\b/g, MASK) // numbers
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function statementPattern(normalized: string): string {
  return escapeRegex(normalized).split(escapeRegex(MASK)).join('.{0,60}?');
}

export function statementKey(normalized: string): string {
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

const OUTCOME_KEYWORDS =
  /success|fail|error|invalid|incorrect|wrong|denied|required|created|saved|deleted|updated|removed|added|uploaded|complete|sent|not found|missing|expired|unauthorized|forbidden|try again|went wrong|welcome|thank/i;

const ROLE_HINT = /^\s*-?\s*(alert|status|dialog|heading|banner|toast|alertdialog)\b/i;

/**
 * A CONTROL's own label (what you'd click/type into) can never itself be an
 * outcome statement, no matter what words it contains — confirmed live on
 * webdriveruniversity.com's "AI Testing Playground": an unrelated demo widget
 * ("18. Network States") has three buttons literally labelled "Success",
 * "Error", "Timeout" for SIMULATING network responses. `button "Error"` isn't
 * a status/alert/heading role, so ROLE_HINT correctly didn't match it — but
 * OUTCOME_KEYWORDS matched the bare word "Error" regardless, so the
 * role-based check below was bypassed entirely and it got asked about as if
 * it were an observed outcome message, with the question text itself giving
 * a human reviewer zero indication it was actually a clickable button's own
 * label, not a report of anything happening. Excluded outright, unconditional
 * on OUTCOME_KEYWORDS, since a control's label is structurally never a
 * "message" — it's a THING TO ACT ON, not a result to observe.
 */
const INTERACTIVE_CONTROL_HINT =
  /^\s*-?\s*(button|link|tab|menuitem|checkbox|radio|textbox|combobox|switch|slider)\b/i;

/** Pull quoted accessible names out of a snapshot line. */
function quotedTexts(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]{4,140})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1]);
  return out;
}

export interface StatementCandidate {
  text: string;
  kind: 'snapshot' | 'console';
}

/**
 * Deterministic candidate extraction — no LLM. New lines in the after-snapshot
 * (vs before) that look like outcome messages, plus console errors.
 */
export function extractCandidates(
  before: SignalBundle | null,
  after: SignalBundle,
): StatementCandidate[] {
  const beforeText = before ? `${before.snapshot.raw}\n${before.snapshot.interactive}` : '';
  const afterLines = `${after.snapshot.raw}\n${after.snapshot.interactive}`.split('\n');

  const seen = new Set<string>();
  const candidates: StatementCandidate[] = [];

  for (const line of afterLines) {
    const isNew = !beforeText.includes(line.trim());
    if (!isNew && before) continue;

    const roleHit = ROLE_HINT.test(line);
    const isInteractiveControl = INTERACTIVE_CONTROL_HINT.test(line);
    for (const text of quotedTexts(line)) {
      if (text.length < 4 || text.length > 140) continue;
      if (!/[a-z]/i.test(text)) continue;
      if (isInteractiveControl) continue;
      if (!roleHit && !OUTCOME_KEYWORDS.test(text)) continue;
      const norm = normalizeStatement(text);
      if (norm.length < 4 || seen.has(norm)) continue;
      seen.add(norm);
      candidates.push({ text, kind: 'snapshot' });
    }
  }

  for (const err of after.consoleErrors) {
    const text = err.text.slice(0, 140);
    const norm = normalizeStatement(text);
    if (norm.length < 4 || seen.has(norm)) continue;
    seen.add(norm);
    candidates.push({ text, kind: 'console' });
  }

  return candidates;
}

export class Statements {
  constructor(
    private readonly state: SiteState,
    private readonly interact: Interact,
    private readonly llm?: LlmClient,
  ) {}

  find(normalized: string): StatementEntry | undefined {
    const key = statementKey(normalized);
    return this.state.statements.find((s) => s.key === key);
  }

  /** Match a raw text against known statements (pattern-based, mask-tolerant). */
  match(raw: string): StatementEntry | undefined {
    const norm = normalizeStatement(raw);
    const exact = this.find(norm);
    if (exact) return exact;
    return this.state.statements.find((s) => new RegExp(s.pattern, 'i').test(norm));
  }

  /**
   * Triage unknown candidates. Known ones just bump seenCount. Unknown SNAPSHOT
   * candidates first go through one batched LLM pass that auto-classifies obvious
   * NOISE (UI chrome, headings, nav, data/list items) so the human is never asked
   * about them; everything the model calls an OUTCOME (or is unsure about, or that
   * the LLM can't decide) falls through to the human, as do ALL console errors.
   * Success/failure are only ever assigned by the human — the model can only
   * downgrade snapshot text to noise.
   */
  async triage(
    candidates: StatementCandidate[],
    pageId: string,
  ): Promise<{ seen: string[]; newlyClassified: string[] }> {
    const seen: string[] = [];
    const newlyClassified: string[] = [];

    const unknown: StatementCandidate[] = [];
    for (const candidate of candidates) {
      const known = this.match(candidate.text);
      if (known) {
        known.seenCount++;
        seen.push(known.normalized);
        continue;
      }
      unknown.push(candidate);
    }

    // LLM auto-noise pass — SNAPSHOT candidates ONLY. A snapshot 'noise' entry is
    // verdict-harmless: it feeds NEITHER augmentExpectation NOR hasSuccessStatement,
    // it only stops us re-asking — so auto-suppressing it is safe even when the
    // model is wrong, and snapshot labels are the entire human-prompt flood ("Your
    // Projects", "Create Asset", character/asset names, …). CONSOLE errors are
    // deliberately EXCLUDED here: a 'noise'+console entry feeds
    // allowedConsoleErrorPatterns and would SUPPRESS that console error from ever
    // failing verification — exactly how the marquee product bug surfaces (Koyal's
    // S3 scene-gen "Failed to fetch JSON from S3"), so one mislabel there would hide
    // the very class of bug this tool exists to catch. Console errors always go to
    // the human below.
    const snapshotUnknown = unknown.filter((c) => c.kind === 'snapshot');
    const autoNoise = await this.classifyNoiseWithLlm(snapshotUnknown.map((c) => c.text));

    const needsHuman: StatementCandidate[] = [];
    snapshotUnknown.forEach((candidate, i) => {
      if (autoNoise[i]) this.persist(candidate, 'noise', pageId, 'llm', newlyClassified);
      else needsHuman.push(candidate);
    });
    for (const candidate of unknown) {
      if (candidate.kind === 'console') needsHuman.push(candidate);
    }

    for (const candidate of needsHuman) {
      const kindLabel = candidate.kind === 'console' ? 'console error' : 'message';
      let answer: StatementClass;
      try {
        answer = await this.interact.askChoice(
          `New ${kindLabel} on page "${pageId}": "${candidate.text}" — classify`,
          ['success', 'failure', 'noise'],
          candidate.kind === 'console' ? 'noise' : undefined,
        );
      } catch {
        // no answer (detached run) — leave unclassified so it is asked again next run
        console.log(`[statements] unanswered, will re-ask next run: "${candidate.text}"`);
        continue;
      }
      this.persist(candidate, answer, pageId, 'human', newlyClassified);
    }

    if (newlyClassified.length) this.state.saveStatements();
    return { seen, newlyClassified };
  }

  /** Persist one classified candidate (idempotent on its normalized key). */
  private persist(
    candidate: StatementCandidate,
    answer: StatementClass,
    pageId: string,
    decidedBy: 'human' | 'llm',
    newlyClassified: string[],
  ): void {
    const normalized = normalizeStatement(candidate.text);
    if (this.find(normalized)) return; // already added (e.g. earlier in this batch)
    // success/failure classifications FLIP verdicts, so scope them to the page
    // they were seen on — a global "success" phrase would wrongly pass every
    // page containing it. 'noise' only SUPPRESSES a benign message, so keeping
    // it global is low-risk and avoids re-asking about framework warnings.
    const scope = answer === 'noise' ? 'global' : pageId || 'global';
    this.state.statements.push({
      key: statementKey(normalized),
      normalized,
      pattern: statementPattern(normalized),
      raw: candidate.text,
      classification: answer,
      scope,
      kind: candidate.kind,
      decidedBy,
      decidedAt: new Date().toISOString(),
      seenCount: 1,
    });
    newlyClassified.push(`${normalized} → ${answer}${decidedBy === 'llm' ? ' (llm)' : ''}`);
  }

  /**
   * One batched LLM call labelling each snapshot snippet 'noise' (UI chrome,
   * labels, headings, nav, data/list items) or 'outcome' (reports an action's
   * result). Returns per-input `true` ONLY where the model is confident it is
   * noise; anything marked 'outcome', omitted, or unparseable defaults to `false`
   * (escalate to the human). Any failure — no client, parse error, or over
   * budget — yields all-`false`, i.e. degrades to today's ask-the-human behavior.
   * Never called for console candidates (see triage).
   */
  private async classifyNoiseWithLlm(texts: string[]): Promise<boolean[]> {
    const result: boolean[] = new Array(texts.length).fill(false);
    if (!this.llm || texts.length === 0) return result;

    const numbered = texts.map((t, i) => `${i + 1}. ${JSON.stringify(t)}`).join('\n');
    const prompt =
      `You are triaging short text snippets captured from a web page during automated QA.\n` +
      `For EACH snippet choose exactly one label:\n` +
      `- "noise": NOT a report of an action's result — UI labels, headings/section titles, ` +
      `navigation items, button/link/tab text, field labels, placeholder or empty-state text ` +
      `("No X yet"), and data/list items (names, filenames, IDs, counts, prices).\n` +
      `- "outcome": DOES report the result of an action — a success confirmation ("Saved", ` +
      `"X created", "started successfully") or an error/validation/failure message ` +
      `("required", "invalid", "not found", "failed", "went wrong", "unauthorized").\n` +
      `When unsure, choose "outcome" — it is safer to escalate than to suppress a real result.\n\n` +
      `Snippets:\n${numbered}\n\n` +
      `Return ONLY JSON: {"labels":[{"i":<1-based index>,"label":"noise"|"outcome"}, ...]} ` +
      `with exactly one entry per snippet.`;

    try {
      // NB: no `temperature` — some models (e.g. claude-opus-4-8) reject the param
      // with a 400, which would throw and silently degrade every candidate to the
      // human. Mirror the explorer's call, which omits it.
      const raw = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
      });
      const parsed = parseJsonFromLlm<{ labels?: { i?: number; label?: string }[] }>(raw);
      for (const item of parsed.labels ?? []) {
        if (
          typeof item.i === 'number' &&
          item.i >= 1 &&
          item.i <= texts.length &&
          item.label === 'noise'
        ) {
          result[item.i - 1] = true;
        }
      }
    } catch {
      // no client / parse failure / over budget → degrade to all-human
      return new Array(texts.length).fill(false);
    }
    return result;
  }

  /** Merge the KB into a deterministic expectation. */
  augmentExpectation(
    base: VerificationExpectation,
    pageId: string,
  ): VerificationExpectation {
    const relevant = this.state.statements.filter(
      (s) => s.scope === 'global' || s.scope === pageId,
    );

    const failureSnapshot = relevant
      .filter((s) => s.classification === 'failure' && s.kind === 'snapshot')
      .map((s) => new RegExp(s.pattern, 'i'));

    const noiseConsole = relevant
      .filter((s) => s.classification === 'noise' && s.kind === 'console')
      .map((s) => new RegExp(s.pattern, 'i'));

    return {
      ...base,
      snapshotExcludes: [...(base.snapshotExcludes ?? []), ...failureSnapshot],
      allowedConsoleErrorPatterns: [
        ...(base.allowedConsoleErrorPatterns ?? []),
        ...noiseConsole,
      ],
    };
  }

  /** Does the after-state contain a KB-classified success statement? */
  hasSuccessStatement(signals: SignalBundle, pageId: string): boolean {
    const text = `${signals.snapshot.raw}\n${signals.snapshot.interactive}`;
    const norm = normalizeStatement(text);
    return this.state.statements.some(
      (s) =>
        s.classification === 'success' &&
        s.kind === 'snapshot' &&
        (s.scope === 'global' || s.scope === pageId) &&
        new RegExp(s.pattern, 'i').test(norm),
    );
  }
}
