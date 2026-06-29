import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Explorer, ExplorerResult } from './explorer.js';

export type NavigationMode = 'deterministic' | 'explored';

export interface NavigationResult {
  mode: NavigationMode;
  action: string;
  explorer?: ExplorerResult;
  deterministicFailedReason?: string;
}

export interface NavigationTask {
  /** Short id for logs, e.g. ensure-login-form */
  action: string;
  /** Run known selectors / patterns first */
  deterministic: () => void | Promise<void>;
  /** Return true when the page is in the desired state */
  verify: () => boolean;
  /** LLM goal — only used when deterministic fails verification */
  exploreGoal: string;
  /** When true, run deterministic even if verify() already passes (e.g. filling a form) */
  mustRunAction?: boolean;
}

const LEARNED_SELECTORS_PATH = path.join(config.stateDir, 'auth-selectors-learned.json');

export class NavigationHarness {
  constructor(
    private readonly explorer: Explorer | null,
    private readonly logPrefix = '[nav]',
  ) {}

  async run(task: NavigationTask): Promise<NavigationResult> {
    if (!task.mustRunAction && task.verify()) {
      console.log(`${this.logPrefix} ${task.action} — already in target state (deterministic)`);
      return { mode: 'deterministic', action: task.action };
    }

    console.log(`${this.logPrefix} ${task.action} — trying deterministic selectors…`);

    let deterministicFailedReason: string | undefined;

    try {
      await task.deterministic();
      await sleep(400);

      if (task.verify()) {
        console.log(`${this.logPrefix} ${task.action} — deterministic succeeded`);
        return { mode: 'deterministic', action: task.action };
      }

      deterministicFailedReason = 'Deterministic actions ran but target state not reached';
      console.log(`${this.logPrefix} ${task.action} — ${deterministicFailedReason}`);
    } catch (error) {
      deterministicFailedReason = error instanceof Error ? error.message : String(error);
      console.log(`${this.logPrefix} ${task.action} — deterministic failed: ${deterministicFailedReason}`);
    }

    if (!this.explorer) {
      throw new Error(
        `${task.action}: deterministic navigation failed (${deterministicFailedReason}) and LLM exploration is disabled — set LLM_API_KEY or update auth-selectors.ts`,
      );
    }

    console.log(`${this.logPrefix} ${task.action} — falling back to LLM exploration…`);

    const explorerResult = await this.explorer.achieveGoal(task.exploreGoal);

    if (!explorerResult.success) {
      throw new Error(
        `${task.action}: deterministic and exploration both failed — ${explorerResult.error ?? 'unknown'}`,
      );
    }

    if (!task.verify()) {
      console.warn(
        `${this.logPrefix} ${task.action} — exploration finished but verify() still false; continuing with caution`,
      );
    } else {
      this.recordLearnedSuccess(task.action, explorerResult);
    }

    return {
      mode: 'explored',
      action: task.action,
      explorer: explorerResult,
      deterministicFailedReason,
    };
  }

  private recordLearnedSuccess(action: string, result: ExplorerResult): void {
    recordLearnedPatterns(action, result);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordLearnedPatterns(action: string, result: ExplorerResult): void {
  try {
    const existing = fs.existsSync(LEARNED_SELECTORS_PATH)
      ? (JSON.parse(fs.readFileSync(LEARNED_SELECTORS_PATH, 'utf8')) as Record<string, unknown>)
      : {};

    const entry = {
      lastSuccessAt: new Date().toISOString(),
      stepsTaken: result.stepsTaken,
      snapshotSnippet: result.finalSnapshot.split('\n').slice(0, 20),
    };

    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(
      LEARNED_SELECTORS_PATH,
      `${JSON.stringify({ ...existing, [action]: entry }, null, 2)}\n`,
      'utf8',
    );
    console.log(`${'[nav]'} Recorded learned patterns for "${action}" → ${LEARNED_SELECTORS_PATH}`);
  } catch {
    // non-fatal
  }
}
