import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { HumanDecision } from '../core/types.js';
import type { ProductionPromptSupervisor } from './prompt-supervisor.js';

export interface PromptResolution {
  answer: string;
  source: HumanDecision['source'];
  reason?: string;
}

/**
 * Give a terminal user a bounded opportunity to answer, then let the
 * production supervisor resolve the same question. An undefined supervisor
 * decision deliberately stays pending so the human prompt remains active.
 */
export async function resolveHumanOrSupervisor(
  humanAnswer: Promise<string>,
  question: string,
  supervisor: ProductionPromptSupervisor,
  humanOverrideMs: number,
  cancelHuman: () => void,
): Promise<PromptResolution> {
  const human = humanAnswer.then((answer) => ({
    answer,
    source: 'human' as const,
  }));
  const supervised = (async (): Promise<PromptResolution> => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, humanOverrideMs)));
    const decision = await supervisor.answer(question);
    if (!decision?.answer) return new Promise<never>(() => undefined);
    return {
      answer: decision.answer,
      source: 'supervisor',
      reason: decision.reason,
    };
  })();
  const resolved = await Promise.race([human, supervised]);
  if (resolved.source === 'supervisor') cancelHuman();
  return resolved;
}

/**
 * Human-in-the-loop channel. Three ways an answer can arrive, in priority order:
 * 1. Interactive TTY prompt (normal case — user is at the terminal)
 * 2. Polled answer file in the site's inbox/ dir (for detached/background runs:
 *    the question is written to <inbox>/QUESTION.txt, the answer is read from
 *    <inbox>/answer.txt, which is deleted after reading)
 * 3. Default value on timeout, when one is provided
 */
export class Interact {
  private rl: readline.Interface | null = null;
  private decisionLogPath: string | null = null;
  readonly decisions: HumanDecision[] = [];

  constructor(
    private readonly inboxDir: string,
    private readonly filePollMs = 2000,
    private readonly fileTimeoutMs = 300000,
    private readonly supervisor?: ProductionPromptSupervisor,
    private readonly supervisorHumanOverrideMs = 3000,
  ) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  setDecisionLog(runDir: string): void {
    this.decisionLogPath = path.join(runDir, 'decisions.json');
  }

  private record(
    question: string,
    answer: string,
    source: HumanDecision['source'] = 'human',
  ): void {
    const decision: HumanDecision = { question, answer, at: new Date().toISOString(), source };
    this.decisions.push(decision);
    if (this.decisionLogPath) {
      try {
        fs.writeFileSync(this.decisionLogPath, `${JSON.stringify(this.decisions, null, 2)}\n`, 'utf8');
      } catch {
        // best-effort
      }
    }
  }

  private getReadline(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    return this.rl;
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }

  private get isTty(): boolean {
    return Boolean(process.stdin.isTTY);
  }

  private async askViaTty(
    question: string,
    defaultValue?: string,
    secret = false,
  ): Promise<PromptResolution> {
    const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : '';
    const prompt = `\n${question}${suffix}: `;
    if (!this.supervisor || secret) {
      return {
        answer: await this.getReadline().question(prompt),
        source: 'human',
      };
    }

    const controller = new AbortController();
    const humanAnswer = this.getReadline().question(prompt, { signal: controller.signal });
    const resolved = await resolveHumanOrSupervisor(
      humanAnswer,
      question,
      this.supervisor,
      this.supervisorHumanOverrideMs,
      () => controller.abort(),
    );
    if (resolved.source === 'supervisor') {
      process.stdout.write('\n');
      console.log(`[supervisor] ${resolved.reason ?? 'answered the structured production prompt'}`);
    }
    return resolved;
  }

  private async askViaFile(
    question: string,
    defaultValue?: string,
  ): Promise<{ answer: string; source: HumanDecision['source'] }> {
    const questionFile = path.join(this.inboxDir, 'QUESTION.txt');
    const answerFile = path.join(this.inboxDir, 'answer.txt');
    // Clear any stale answer left over from a previous question BEFORE writing the new
    // question file. Without this, a late/duplicate write to answer.txt for a PRIOR
    // question can be consumed as the answer to THIS question (a real race observed live:
    // a stale "success" answer leaked into a credential prompt, corrupting secrets.json).
    fs.rmSync(answerFile, { force: true });
    fs.writeFileSync(
      questionFile,
      `${question}\n\nWrite your answer into: ${answerFile}\n`,
      'utf8',
    );
    console.log(`\n[autoqa] QUESTION (no TTY): ${question}`);
    console.log(`[autoqa] → answer by writing to ${answerFile}`);

    const deadline = Date.now() + this.fileTimeoutMs;
    const supervisorAt = this.supervisor
      ? Math.min(deadline, Date.now() + this.supervisorHumanOverrideMs)
      : Number.POSITIVE_INFINITY;
    let supervisorAttempted = false;
    while (Date.now() < deadline) {
      if (fs.existsSync(answerFile)) {
        const raw = fs.readFileSync(answerFile, 'utf8').trim();
        if (raw) {
          fs.unlinkSync(answerFile);
          fs.rmSync(questionFile, { force: true });
          return { answer: raw, source: 'human' };
        }
      }
      if (this.supervisor && !supervisorAttempted && Date.now() >= supervisorAt) {
        supervisorAttempted = true;
        try {
          const decision = await this.supervisor.answer(question);
          if (decision?.answer) {
            fs.rmSync(questionFile, { force: true });
            console.log(`[supervisor] ${decision.reason}`);
            return { answer: decision.answer, source: 'supervisor' };
          }
        } catch (error) {
          console.warn(
            `[supervisor] could not answer safely: ${error instanceof Error ? error.message : error}`,
          );
        }
        // The supervisor gets one bounded attempt. Preserve the human inbox
        // fallback for the remainder of the configured prompt timeout.
      }
      await new Promise((r) => setTimeout(r, this.filePollMs));
    }
    fs.rmSync(questionFile, { force: true });
    if (defaultValue !== undefined) {
      console.log(`[autoqa] no answer within ${this.fileTimeoutMs / 1000}s — using default "${defaultValue}"`);
      return { answer: defaultValue, source: 'default' };
    }
    throw new Error(`No answer received for: ${question}`);
  }

  async ask(question: string, opts?: { default?: string; secret?: boolean }): Promise<string> {
    let answer: string;
    let source: HumanDecision['source'] = 'human';
    if (this.isTty) {
      let resolved = await this.askViaTty(question, opts?.default, opts?.secret);
      answer = resolved.answer.trim() || opts?.default || '';
      source = resolved.source;
      if (!answer && opts?.default === undefined) {
        // re-ask once for genuinely required input
        resolved = await this.askViaTty(`(required) ${question}`, undefined, opts?.secret);
        answer = resolved.answer.trim();
        source = resolved.source;
      }
    } else {
      const resolved = await this.askViaFile(question, opts?.default);
      answer = resolved.answer;
      source = resolved.source;
    }
    this.record(question, opts?.secret ? '«secret»' : answer, source);
    return answer;
  }

  async askChoice<T extends string>(question: string, choices: T[], defaultChoice?: T): Promise<T> {
    const menu = choices.map((c) => `[${c[0]}]${c.slice(1)}`).join(' / ');
    // bounded retries: an interactive user can mistype a few times, but a detached
    // run whose answer file keeps arriving invalid must NOT recurse forever
    // (that re-writes QUESTION.txt each round and hangs the run indefinitely).
    const maxAttempts = this.isTty ? 5 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const raw = await this.ask(`${question} ${menu}`, { default: defaultChoice });
      const lower = raw.trim().toLowerCase();
      const match =
        choices.find((c) => c.toLowerCase() === lower) ??
        choices.find((c) => c[0].toLowerCase() === lower[0]);
      if (match) return match;
      if (defaultChoice) return defaultChoice;
    }
    // no valid answer after bounded attempts and no default: fall back to the
    // first choice rather than looping forever
    return defaultChoice ?? choices[0];
  }

  async askYesNo(question: string, defaultAnswer: boolean): Promise<boolean> {
    const answer = await this.askChoice(question, ['yes', 'no'], defaultAnswer ? 'yes' : 'no');
    return answer === 'yes';
  }

  /** Guard answers — 'always'/'never' persist to the allowlist */
  async askConfirmAction(question: string): Promise<'yes' | 'no' | 'always' | 'never'> {
    return this.askChoice(question, ['yes', 'no', 'always', 'never'], 'no');
  }

  async askPath(question: string, suggestions: string[]): Promise<string> {
    const hint = suggestions.length ? `\n  suggestions:\n${suggestions.map((s) => `    ${s}`).join('\n')}` : '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await this.ask(`${question}${hint}`, { default: suggestions[0] });
      const resolved = path.resolve(answer.replace(/^~\//, `${process.env.HOME}/`));
      if (fs.existsSync(resolved)) return resolved;
      console.log(`[autoqa] file not found: ${resolved}`);
    }
    throw new Error(`No valid file path provided for: ${question}`);
  }

  /**
   * Resolution chain: saved (site-specific) secret → env vars → human prompt.
   * Saved secrets win over env vars deliberately — a generic env var (e.g.
   * AUTOQA_EMAIL set while testing one site) must never silently override a
   * DIFFERENT site's own previously-learned, per-host credentials.
   */
  async askSecret(
    label: string,
    envVars: string[],
    saved: string | undefined,
  ): Promise<{ value: string; fromPrompt: boolean }> {
    if (saved) return { value: saved, fromPrompt: false };
    for (const envVar of envVars) {
      const value = process.env[envVar];
      if (value) return { value, fromPrompt: false };
    }
    const value = await this.ask(`Enter ${label}`, { secret: true });
    return { value, fromPrompt: true };
  }
}
