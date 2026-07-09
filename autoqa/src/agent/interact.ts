import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { HumanDecision } from '../core/types.js';

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
  ) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  setDecisionLog(runDir: string): void {
    this.decisionLogPath = path.join(runDir, 'decisions.json');
  }

  private record(question: string, answer: string): void {
    const decision: HumanDecision = { question, answer, at: new Date().toISOString() };
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

  private async askViaFile(question: string, defaultValue?: string): Promise<string> {
    const questionFile = path.join(this.inboxDir, 'QUESTION.txt');
    const answerFile = path.join(this.inboxDir, 'answer.txt');
    fs.writeFileSync(
      questionFile,
      `${question}\n\nWrite your answer into: ${answerFile}\n`,
      'utf8',
    );
    console.log(`\n[autoqa] QUESTION (no TTY): ${question}`);
    console.log(`[autoqa] → answer by writing to ${answerFile}`);

    const deadline = Date.now() + this.fileTimeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(answerFile)) {
        const raw = fs.readFileSync(answerFile, 'utf8').trim();
        if (raw) {
          fs.unlinkSync(answerFile);
          fs.rmSync(questionFile, { force: true });
          return raw;
        }
      }
      await new Promise((r) => setTimeout(r, this.filePollMs));
    }
    fs.rmSync(questionFile, { force: true });
    if (defaultValue !== undefined) {
      console.log(`[autoqa] no answer within ${this.fileTimeoutMs / 1000}s — using default "${defaultValue}"`);
      return defaultValue;
    }
    throw new Error(`No answer received for: ${question}`);
  }

  async ask(question: string, opts?: { default?: string; secret?: boolean }): Promise<string> {
    let answer: string;
    if (this.isTty) {
      const suffix = opts?.default !== undefined ? ` [${opts.default}]` : '';
      const raw = await this.getReadline().question(`\n${question}${suffix}: `);
      answer = raw.trim() || opts?.default || '';
      if (!answer && opts?.default === undefined) {
        // re-ask once for genuinely required input
        answer = (await this.getReadline().question(`(required) ${question}: `)).trim();
      }
    } else {
      answer = await this.askViaFile(question, opts?.default);
    }
    this.record(question, opts?.secret ? '«secret»' : answer);
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

  /** Resolution chain: env vars → saved secrets → human prompt */
  async askSecret(
    label: string,
    envVars: string[],
    saved: string | undefined,
  ): Promise<{ value: string; fromPrompt: boolean }> {
    for (const envVar of envVars) {
      const value = process.env[envVar];
      if (value) return { value, fromPrompt: false };
    }
    if (saved) return { value: saved, fromPrompt: false };
    const value = await this.ask(`Enter ${label}`, { secret: true });
    return { value, fromPrompt: true };
  }
}
