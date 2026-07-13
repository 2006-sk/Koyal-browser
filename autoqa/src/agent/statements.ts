import crypto from 'node:crypto';
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
  decidedBy: 'human';
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
   * Ask-once triage: every unknown candidate gets one inline human classification,
   * persisted forever. Known candidates just bump seenCount.
   */
  async triage(
    candidates: StatementCandidate[],
    pageId: string,
  ): Promise<{ seen: string[]; newlyClassified: string[] }> {
    const seen: string[] = [];
    const newlyClassified: string[] = [];

    for (const candidate of candidates) {
      const known = this.match(candidate.text);
      if (known) {
        known.seenCount++;
        seen.push(known.normalized);
        continue;
      }

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

      const normalized = normalizeStatement(candidate.text);
      // success/failure classifications FLIP verdicts, so scope them to the page
      // they were seen on — a global "success" phrase would wrongly pass every
      // page containing it. 'noise' only SUPPRESSES a benign message, so keeping
      // it global is low-risk and avoids re-asking about framework warnings.
      const scope = answer === 'noise' ? 'global' : pageId || 'global';
      const entry: StatementEntry = {
        key: statementKey(normalized),
        normalized,
        pattern: statementPattern(normalized),
        raw: candidate.text,
        classification: answer,
        scope,
        kind: candidate.kind,
        decidedBy: 'human',
        decidedAt: new Date().toISOString(),
        seenCount: 1,
      };
      this.state.statements.push(entry);
      newlyClassified.push(`${normalized} → ${answer}`);
    }

    if (newlyClassified.length) this.state.saveStatements();
    return { seen, newlyClassified };
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
