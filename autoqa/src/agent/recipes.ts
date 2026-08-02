import fs from 'node:fs';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import { snapshotIncludesAny } from '../core/agent-browser.js';
import { fillEditableByIndex, fillFieldByHint } from '../core/edits.js';
import type { ExplorerResult } from '../core/explorer.js';
import {
  contextualMutationTargetLabel,
  hasPostMutationProcessing,
} from '../core/explorer.js';
import { Nav, parseContextualControlLabel } from '../core/nav.js';
import type { SiteState } from './site-state.js';
import type { Guard } from './guard.js';

export type RecipeStep =
  | { kind: 'open'; path: string }
  | { kind: 'click'; label: string; role?: string }
  | { kind: 'fill'; hint: string; value: string; secretRef?: 'email' | 'password' }
  | { kind: 'select'; hint: string; value: string }
  | { kind: 'press'; key: string }
  | { kind: 'upload'; assetPath: string; selector?: string }
  | { kind: 'waitForProcessing'; maxMs: number }
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
 * Validation recovery may refill the same field immediately with a replacement.
 * Keep only the final consecutive fill so replay asks once and never types a
 * value that the learning run already proved invalid.
 */
export function compactSupersededFills(steps: RecipeStep[]): RecipeStep[] {
  const compacted: RecipeStep[] = [];
  for (const step of steps) {
    const previous = compacted.at(-1);
    if (
      step.kind === 'fill' &&
      previous?.kind === 'fill' &&
      normalizedHint(previous.hint) === normalizedHint(step.hint)
    ) {
      compacted[compacted.length - 1] = step;
    } else {
      compacted.push(step);
    }
  }
  return compacted;
}

function secretRefForLabel(label: string): 'email' | 'password' | undefined {
  if (/\b(password|passcode|pin)\b/i.test(label)) return 'password';
  if (/\b(email|e-mail|user\s*name|username)\b/i.test(label)) return 'email';
  return undefined;
}

function redactRecipeGoal(
  goal: string,
  secrets?: { email?: string; password?: string },
): string {
  let safe = goal;
  if (secrets?.email) safe = safe.split(secrets.email).join('«email»');
  if (secrets?.password) safe = safe.split(secrets.password).join('«password»');
  return safe;
}

/**
 * Convert a successful LLM exploration into a label-based recipe that replays
 * without any LLM calls. Refs (@eN) are never stored — labels survive refactors.
 */
export interface RecipeFromExplorerOptions {
  secrets?: { email?: string; password?: string };
  successCheck?: Recipe['successCheck'];
  fallbackFieldHint?: string;
}

/**
 * Convert explorer actions into portable label-based recipe steps without
 * writing them. Position recovery uses this to append a newly explored suffix
 * to the deterministic prefix that already succeeded in the same run.
 */
export function recipeStepsFromExplorer(
  result: ExplorerResult,
  options?: RecipeFromExplorerOptions,
): RecipeStep[] | null {
  const steps: RecipeStep[] = [];
  const contextualTarget = contextualMutationTargetLabel(result.goal);
  const contextualParts = contextualTarget
    ? parseContextualControlLabel(contextualTarget)
    : null;

  for (const action of result.actions) {
    if (action.executionFailed) continue;
    if (action.action === 'click' && action.resolvedLabel) {
      // Accessibility exposes repeated card buttons by their generic name,
      // while the milestone goal retains the owning item. Preserve that owner
      // in the deterministic recipe or replay would click the first matching
      // control in the grid.
      const label =
        contextualParts &&
        normalizedHint(contextualParts.action) === normalizedHint(action.resolvedLabel)
          ? contextualTarget!
          : action.resolvedLabel;
      steps.push({ kind: 'click', label, role: action.resolvedRole });
    } else if (action.action === 'fill' && (action.resolvedLabel || options?.fallbackFieldHint) && action.value !== undefined) {
      const label = action.resolvedLabel ?? options!.fallbackFieldHint!;
      const step: RecipeStep = { kind: 'fill', hint: label, value: action.value };
      const labelSecretRef = secretRefForLabel(label);
      if (labelSecretRef) {
        step.value = '';
        step.secretRef = labelSecretRef;
      } else if (options?.secrets?.email && action.value === options.secrets.email) {
        step.value = '';
        step.secretRef = 'email';
      } else if (options?.secrets?.password && action.value === options.secrets.password) {
        step.value = '';
        step.secretRef = 'password';
      }
      steps.push(step);
    } else if (action.action === 'select' && (action.resolvedLabel || options?.fallbackFieldHint) && action.value !== undefined) {
      steps.push({ kind: 'select', hint: action.resolvedLabel ?? options!.fallbackFieldHint!, value: action.value });
    } else if (action.action === 'press' && action.value !== undefined) {
      steps.push({ kind: 'press', key: action.value });
    } else if (action.action === 'upload' && action.uploadedPath) {
      steps.push({ kind: 'upload', assetPath: action.uploadedPath, selector: action.selector });
    } else if (action.action === 'wait' && action.waitForProcessing) {
      steps.push({
        kind: 'waitForProcessing',
        // A single successful sample is not an upper bound. Async generation
        // routinely varies by several minutes under load; replay should keep
        // polling while the UI still proves work is active, up to the same
        // generous site-agnostic ceiling used by exploration.
        maxMs: Math.max(
          config.deep.processingWaitMs,
          Math.round((action.waitedMs ?? 10000) * 1.5),
        ),
      });
    } else if (action.action === 'click' || action.action === 'fill' || action.action === 'select') {
      // Un-resolvable ref (no label) — recipe would be brittle; skip recording entirely
      return null;
    }
    // Ordinary LLM "wait" decisions are dropped. Deterministic processing
    // barriers are preserved explicitly so replay cannot race async work.
  }

  return compactSupersededFills(steps);
}

export function recordFromExplorer(
  state: SiteState,
  id: string,
  result: ExplorerResult,
  options?: RecipeFromExplorerOptions,
): Recipe | null {
  const steps = recipeStepsFromExplorer(result, options);
  if (!steps) return null;

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
    goal: redactRecipeGoal(result.goal, options?.secrets),
    steps,
    successCheck,
    stats: {
      successes: existing?.stats.successes ?? 0,
      // A successful exploration just replaced/repaired this recipe. Failures
      // belonged to the old step sequence and must not immediately evict the
      // newly learned one on its first recovery replay.
      failures: 0,
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
  const existing = state.recipes[id];
  const recipe: Recipe = {
    id,
    goal,
    steps,
    successCheck,
    stats: {
      successes: existing?.stats.successes ?? 0,
      failures: 0,
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
  /** Steps that actually completed before replay returned or fell back. */
  completedSteps?: RecipeStep[];
}

function normalizedHint(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A prior choice/navigation click may be absent because the app resumed one
 * screen later. A missing click is safely idempotent only when the immediately
 * following recipe step is already visibly actionable. */
export function nextRecipeStepAppearsReady(
  step: RecipeStep | undefined,
  snapshot: string,
  url: string,
): boolean {
  if (!step) return false;
  const lower = snapshot.toLowerCase();
  if (step.kind === 'fill' || step.kind === 'select') {
    const hint = normalizedHint(step.hint).replace(/^"+|"+$/g, '');
    return hint.length >= 3 && lower.includes(hint);
  }
  if (step.kind === 'click') {
    const target = normalizedHint(step.label);
    return snapshot.split('\n').some((line) => {
      const match = line.match(/(?:button|link|tab|radio|checkbox|generic|labeltext)\s+"([^"]+)"[^\n]*\[ref=e\d+\]/i);
      return (
        Boolean(match) &&
        !/\bdisabled\b/i.test(line) &&
        normalizedHint(match![1]).includes(target)
      );
    });
  }
  if (step.kind === 'waitFor') {
    const urlReady = step.urlIncludes
      ? url.toLowerCase().includes(step.urlIncludes.toLowerCase())
      : true;
    const textReady = step.textIncludes
      ? lower.includes(step.textIncludes.toLowerCase())
      : true;
    return urlReady && textReady;
  }
  return false;
}

/** Dynamic dialogue/copy changes after every edit, so its old text is not a
 * stable replay selector. Choose a substantive content paragraph while
 * excluding instructional/wizard chrome; the immediately following fill step
 * then targets the editor opened by this structural click. */
export function refForDynamicEditableParagraph(snapshot: string): string | undefined {
  for (const line of snapshot.split('\n')) {
    const match = line.match(/paragraph\s+"([^"]+)"[^\n]*\[ref=(e\d+)\]/i);
    if (!match || match[1].trim().length < 12) continue;
    if (
      /\b(click|edit|instruction|upload|story type|review transcript|theme|style|locations?|final video|step)\b/i.test(
        match[1],
      )
    ) {
      continue;
    }
    return `@${match[2]}`;
  }
  return undefined;
}

/**
 * Wait through the async mount race and require a stable clear state after
 * processing was observed. One early spinner-free render is not completion.
 */
export function waitForProcessingBarrier(
  browser: AgentBrowser,
  maxMs: number,
  options: {
    now?: () => number;
    pollMs?: number;
    mountGraceMs?: number;
    stableClearPolls?: number;
  } = {},
): void {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 1000;
  const started = now();
  const deadline = started + maxMs;
  // A recorded waitForProcessing step exists because exploration really saw an
  // asynchronous transition here. Production SPAs can take well over five
  // seconds after a successful click before their spinner/progress UI mounts
  // (live Koyal Asset replay: the 5s grace released into a still-unmounted name
  // form and guaranteed the next fill would fail). Give the async UI a
  // realistic mount window. We deliberately do NOT retry the preceding
  // mutation: absence of a spinner can be latency, and resubmission can create
  // duplicate artifacts.
  const mountDeadline = started + Math.min(options.mountGraceMs ?? 30000, maxMs);
  const requiredClear = options.stableClearPolls ?? 2;
  let sawProcessing = false;
  let clearPolls = 0;

  while (now() < deadline) {
    const active = hasPostMutationProcessing(browser.snapshotFull());
    if (active) {
      sawProcessing = true;
      clearPolls = 0;
    } else if (sawProcessing) {
      clearPolls++;
      if (clearPolls >= requiredClear) return;
    } else if (now() >= mountDeadline) {
      // Some synchronous actions legitimately never show processing.
      return;
    }
    browser.wait(pollMs);
  }

  if (hasPostMutationProcessing(browser.snapshotFull())) {
    throw new Error(`waitForProcessing timeout (${maxMs}ms)`);
  }
}

export class RecipePlayer {
  private readonly nav: Nav;

  constructor(
    private readonly browser: AgentBrowser,
    private readonly state: SiteState,
    private readonly guard: Guard | null,
    private readonly resolveFillValue?: (label: string, proposedValue: string) => Promise<string>,
    private readonly resolveUploadPath?: (suggestedPath: string) => Promise<string>,
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
    context: {
      pageId?: string;
      secrets?: { email?: string; password?: string };
      /** Explicit values already approved during this milestone's preflight. */
      fillOverrides?: Record<string, string>;
    } = {},
  ): Promise<ReplayResult> {
    const recipe = this.state.recipes[id];
    if (!recipe) return { ok: false, detail: 'no recipe' };
    const compactedSteps = compactSupersededFills(recipe.steps);
    if (compactedSteps.length !== recipe.steps.length) {
      recipe.steps = compactedSteps;
      this.state.saveRecipes();
    }

    console.log(`[replay] ${id} (${recipe.steps.length} steps, ${recipe.stats.successes} prior successes)`);

    let dynamicEditableOpened = false;
    const completedSteps: RecipeStep[] = [];
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
          let clicked = this.nav.click({ label: step.label, role, optional: true });
          if (
            !clicked &&
            step.role === 'paragraph' &&
            recipe.steps[i + 1]?.kind === 'fill'
          ) {
            const ref = refForDynamicEditableParagraph(this.browser.snapshotFull());
            if (ref) {
              this.browser.clickVisible(ref);
              this.browser.wait(config.actionDelayMs);
              dynamicEditableOpened = true;
              clicked = true;
              console.log(
                `[replay] old paragraph text changed; opened the current editable content structurally via ${ref}`,
              );
            }
          }
          if (!clicked) {
            const next = recipe.steps[i + 1];
            let nextReady = nextRecipeStepAppearsReady(
              next,
              this.browser.snapshotFull(),
              this.browser.getUrl(),
            );
            if (next?.kind === 'upload') {
              try {
                const selector = next.selector ?? 'input[type=file]';
                nextReady =
                  this.browser.evalScript(
                    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
                  ).trim() === 'true';
              } catch {
                nextReady = false;
              }
            }
            if (nextReady) {
              console.log(
                `[replay] skipping absent click "${step.label}" because the next ${next?.kind} step is already actionable`,
              );
              continue;
            }
            throw new Error(`could not click "${step.label}"`);
          }
        } else if (step.kind === 'fill') {
          const authoritative = context.fillOverrides?.[normalizedHint(step.hint)];
          const value = step.secretRef
            ? (context.secrets?.[step.secretRef] ?? '')
            : authoritative
              ? authoritative
            : this.resolveFillValue
              ? await this.resolveFillValue(step.hint, step.value)
              : step.value;
          if (!value) throw new Error(`no value for fill "${step.hint}"`);
          if (!step.secretRef && value !== step.value) {
            step.value = value;
            this.state.saveRecipes();
          }
          const filled = fillFieldByHint(this.browser, step.hint, value);
          if (!filled.ok) {
            if (dynamicEditableOpened) {
              const structuralFill = fillEditableByIndex(this.browser, 0, value);
              if (!structuralFill.ok) {
                throw new Error(
                  `could not fill structurally opened editor: ${structuralFill.detail}`,
                );
              }
              dynamicEditableOpened = false;
              completedSteps.push(step);
              continue;
            }
            // fall back to ref-based fill via snapshot label match
            const snap = this.browser.snapshotInteractive();
            const line = snap
              .split('\n')
              .find((l) => l.toLowerCase().includes(step.hint.toLowerCase()) && /\[ref=e\d+\]/.test(l));
            const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
            if (!ref) throw new Error(`could not fill "${step.hint}": ${filled.detail}`);
            this.browser.fillVisible(`@${ref}`, value);
          }
          dynamicEditableOpened = false;
        } else if (step.kind === 'select') {
          const snap = this.browser.snapshotInteractive();
          const line = snap
            .split('\n')
            .find((l) => l.toLowerCase().includes(step.hint.toLowerCase()) && /\[ref=e\d+\]/.test(l));
          const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
          if (!ref) throw new Error(`could not find select "${step.hint}"`);
          this.browser.select(`@${ref}`, step.value);
        } else if (step.kind === 'press') {
          this.browser.press(step.key);
        } else if (step.kind === 'upload') {
          const suggestedPath = config.uploadFileOverride || step.assetPath;
          const assetPath = this.resolveUploadPath
            ? await this.resolveUploadPath(suggestedPath)
            : suggestedPath;
          if (!fs.existsSync(assetPath)) {
            throw new Error(`upload asset missing: ${assetPath}`);
          }
          this.browser.upload(step.selector ?? 'input[type=file]', assetPath);
          this.browser.wait(3000);
        } else if (step.kind === 'waitForProcessing') {
          // Honor the current generous processing policy even for recipes
          // persisted by older builds with narrowly sampled ceilings.
          waitForProcessingBarrier(
            this.browser,
            Math.max(step.maxMs, config.deep.processingWaitMs),
          );
        } else if (step.kind === 'waitFor') {
          const deadline = Date.now() + step.maxMs;
          let satisfied = false;
          while (Date.now() < deadline) {
            const url = this.browser.getUrl();
            const snap = this.browser.snapshotFull();
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
        completedSteps.push(step);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.log(`[replay] ${id} failed at step ${i + 1}: ${detail}`);
        this.recordFailure(recipe);
        return { ok: false, failedAtStep: i, detail, completedSteps };
      }
    }

    // final success check
    const url = this.browser.getUrl();
    const snap = this.browser.snapshotFull();
    const urlOk = recipe.successCheck.urlIncludes
      ? url.toLowerCase().includes(recipe.successCheck.urlIncludes.toLowerCase())
      : true;
    const snapOk = recipe.successCheck.snapshotAnyOf?.length
      ? snapshotIncludesAny(snap, recipe.successCheck.snapshotAnyOf)
      : true;

    if (!urlOk || !snapOk) {
      this.recordFailure(recipe);
      return { ok: false, detail: 'success check failed after replay', completedSteps };
    }

    recipe.stats.successes++;
    recipe.stats.lastSuccessAt = new Date().toISOString();
    this.state.saveRecipes();
    console.log(`[replay] ${id} OK (no LLM calls)`);
    return { ok: true, completedSteps };
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
