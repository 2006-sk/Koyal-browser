import fs from 'node:fs';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import { snapshotIncludesAny } from '../core/agent-browser.js';
import { fillFieldByHint } from '../core/edits.js';
import type { ExplorerResult } from '../core/explorer.js';
import { Nav } from '../core/nav.js';
import type { SiteState } from './site-state.js';
import type { Guard } from './guard.js';

export type RecipeStep =
  | { kind: 'open'; path: string }
  | { kind: 'click'; label: string; role?: string }
  | { kind: 'fill'; hint: string; value: string; secretRef?: 'email' | 'password' }
  | { kind: 'select'; hint: string; value: string }
  | { kind: 'upload'; assetPath: string; selector?: string }
  | { kind: 'waitFor'; urlIncludes?: string; textIncludes?: string; maxMs: number };

export interface Recipe {
  /** e.g. "auth:login", "flow:create-project:m2", "goto:projects-list" */
  id: string;
  goal: string;
  steps: RecipeStep[];
  successCheck: { urlIncludes?: string; snapshotAnyOf?: string[] };
  stats: { successes: number; failures: number; lastSuccessAt?: string };
}

/**
 * Convert a successful LLM exploration into a label-based recipe that replays
 * without any LLM calls. Refs (@eN) are never stored — labels survive refactors.
 */
export function recordFromExplorer(
  state: SiteState,
  id: string,
  result: ExplorerResult,
  options?: { secrets?: { email?: string; password?: string }; successCheck?: Recipe['successCheck'] },
): Recipe | null {
  const steps: RecipeStep[] = [];

  for (const action of result.actions) {
    if (action.action === 'click' && action.resolvedLabel) {
      steps.push({ kind: 'click', label: action.resolvedLabel, role: action.resolvedRole });
    } else if (action.action === 'fill' && action.resolvedLabel && action.value !== undefined) {
      const step: RecipeStep = { kind: 'fill', hint: action.resolvedLabel, value: action.value };
      if (options?.secrets?.email && action.value === options.secrets.email) {
        step.value = '';
        step.secretRef = 'email';
      } else if (options?.secrets?.password && action.value === options.secrets.password) {
        step.value = '';
        step.secretRef = 'password';
      }
      steps.push(step);
    } else if (action.action === 'select' && action.resolvedLabel && action.value !== undefined) {
      steps.push({ kind: 'select', hint: action.resolvedLabel, value: action.value });
    } else if (action.action === 'upload' && action.uploadedPath) {
      steps.push({ kind: 'upload', assetPath: action.uploadedPath, selector: action.selector });
    } else if (action.action === 'click' || action.action === 'fill' || action.action === 'select') {
      // Un-resolvable ref (no label) — recipe would be brittle; skip recording entirely
      return null;
    }
    // 'wait' steps are dropped; replay relies on Nav delays + successCheck
  }

  if (steps.length === 0) return null;

  const successCheck: Recipe['successCheck'] = options?.successCheck ?? {};
  if (!successCheck.urlIncludes && result.finalUrl) {
    try {
      successCheck.urlIncludes = new URL(result.finalUrl).pathname;
    } catch {
      // keep empty
    }
  }

  const existing = state.recipes[id];
  const recipe: Recipe = {
    id,
    goal: result.goal,
    steps,
    successCheck,
    stats: {
      successes: existing?.stats.successes ?? 0,
      failures: existing?.stats.failures ?? 0,
      lastSuccessAt: new Date().toISOString(),
    },
  };
  state.recipes[id] = recipe;
  state.saveRecipes();
  return recipe;
}

/** Store a recipe composed directly by the caller (e.g. from a deep-walk trail). */
export function recordWalkRecipe(
  state: SiteState,
  id: string,
  goal: string,
  steps: RecipeStep[],
  successCheck: Recipe['successCheck'],
): Recipe | null {
  if (steps.length === 0) return null;
  const existing = state.recipes[id];
  const recipe: Recipe = {
    id,
    goal,
    steps,
    successCheck,
    stats: {
      successes: existing?.stats.successes ?? 0,
      failures: existing?.stats.failures ?? 0,
      lastSuccessAt: new Date().toISOString(),
    },
  };
  state.recipes[id] = recipe;
  state.saveRecipes();
  return recipe;
}

export interface ReplayResult {
  ok: boolean;
  failedAtStep?: number;
  detail?: string;
}

export class RecipePlayer {
  private readonly nav: Nav;

  constructor(
    private readonly browser: AgentBrowser,
    private readonly state: SiteState,
    private readonly guard: Guard | null,
  ) {
    this.nav = new Nav(browser);
  }

  has(id: string): boolean {
    return Boolean(this.state.recipes[id]);
  }

  /**
   * Replay a recipe deterministically (zero LLM calls). Aborts on the first
   * failing step — the caller falls back to the Explorer with the same goal.
   */
  async tryReplay(
    id: string,
    context: { pageId?: string; secrets?: { email?: string; password?: string } } = {},
  ): Promise<ReplayResult> {
    const recipe = this.state.recipes[id];
    if (!recipe) return { ok: false, detail: 'no recipe' };

    console.log(`[replay] ${id} (${recipe.steps.length} steps, ${recipe.stats.successes} prior successes)`);

    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i];
      try {
        if (step.kind === 'open') {
          this.browser.open(`${this.state.sitemap.origin}${step.path}`);
        } else if (step.kind === 'click') {
          if (this.guard) {
            const allowed = await this.guard.confirmClick(step.label, context.pageId ?? 'unknown');
            if (!allowed) {
              this.recordFailure(recipe);
              return { ok: false, failedAtStep: i, detail: `click "${step.label}" denied by guard` };
            }
          }
          const role = step.role === 'button' || step.role === 'link' || step.role === 'tab' ? step.role : undefined;
          const clicked = this.nav.click({ label: step.label, role, optional: true });
          if (!clicked) throw new Error(`could not click "${step.label}"`);
        } else if (step.kind === 'fill') {
          const value = step.secretRef ? (context.secrets?.[step.secretRef] ?? '') : step.value;
          if (!value) throw new Error(`no value for fill "${step.hint}"`);
          const filled = fillFieldByHint(this.browser, step.hint, value);
          if (!filled.ok) {
            // fall back to ref-based fill via snapshot label match
            const snap = this.browser.snapshotInteractive();
            const line = snap
              .split('\n')
              .find((l) => l.toLowerCase().includes(step.hint.toLowerCase()) && /\[ref=e\d+\]/.test(l));
            const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
            if (!ref) throw new Error(`could not fill "${step.hint}": ${filled.detail}`);
            this.browser.fillVisible(`@${ref}`, value);
          }
        } else if (step.kind === 'select') {
          const snap = this.browser.snapshotInteractive();
          const line = snap
            .split('\n')
            .find((l) => l.toLowerCase().includes(step.hint.toLowerCase()) && /\[ref=e\d+\]/.test(l));
          const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
          if (!ref) throw new Error(`could not find select "${step.hint}"`);
          this.browser.select(`@${ref}`, step.value);
        } else if (step.kind === 'upload') {
          const assetPath = config.uploadFileOverride || step.assetPath;
          if (!fs.existsSync(assetPath)) {
            throw new Error(`upload asset missing: ${assetPath}`);
          }
          this.browser.upload(step.selector ?? 'input[type=file]', assetPath);
          this.browser.wait(3000);
        } else if (step.kind === 'waitFor') {
          const deadline = Date.now() + step.maxMs;
          let satisfied = false;
          while (Date.now() < deadline) {
            const url = this.browser.getUrl();
            const snap = this.browser.snapshotInteractive();
            const urlOk = step.urlIncludes ? url.toLowerCase().includes(step.urlIncludes.toLowerCase()) : true;
            const textOk = step.textIncludes ? snap.toLowerCase().includes(step.textIncludes.toLowerCase()) : true;
            if (urlOk && textOk) {
              satisfied = true;
              break;
            }
            this.browser.wait(1000);
          }
          if (!satisfied) throw new Error(`waitFor timeout (${step.maxMs}ms)`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.log(`[replay] ${id} failed at step ${i + 1}: ${detail}`);
        this.recordFailure(recipe);
        return { ok: false, failedAtStep: i, detail };
      }
    }

    // final success check
    const url = this.browser.getUrl();
    const snap = this.browser.snapshotInteractive();
    const urlOk = recipe.successCheck.urlIncludes
      ? url.toLowerCase().includes(recipe.successCheck.urlIncludes.toLowerCase())
      : true;
    const snapOk = recipe.successCheck.snapshotAnyOf?.length
      ? snapshotIncludesAny(snap, recipe.successCheck.snapshotAnyOf)
      : true;

    if (!urlOk || !snapOk) {
      this.recordFailure(recipe);
      return { ok: false, detail: 'success check failed after replay' };
    }

    recipe.stats.successes++;
    recipe.stats.lastSuccessAt = new Date().toISOString();
    this.state.saveRecipes();
    console.log(`[replay] ${id} OK (no LLM calls)`);
    return { ok: true };
  }

  private recordFailure(recipe: Recipe): void {
    recipe.stats.failures++;
    if (recipe.stats.failures > 3 && recipe.stats.successes === 0) {
      delete this.state.recipes[recipe.id];
      console.log(`[replay] dropping recipe ${recipe.id} (never succeeded)`);
    }
    this.state.saveRecipes();
  }
}
