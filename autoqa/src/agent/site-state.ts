import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { SiteMap } from './sitemap.js';
import type { StatementEntry } from './statements.js';
import type { Recipe } from './recipes.js';
import type { SavedFieldValue } from './field-values.js';

export interface Secrets {
  email?: string;
  password?: string;
  [key: string]: string | undefined;
}

/** 'always'/'never' guard answers, keyed by `${normalizedLabel}::${pageId}` */
export type Allowlist = Record<string, 'always' | 'never'>;

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * All persistent per-site knowledge lives here:
 * .autoqa-state/<hostname>/{sitemap,statements,recipes,allowlist,secrets}.json
 * plus auth-state.json (Playwright storage state), screens/, inbox/.
 */
export class SiteState {
  readonly hostname: string;
  readonly dir: string;
  /**
   * The exact URL passed via --url/AUTOQA_URL, including path/query/hash —
   * distinct from `sitemap.origin` (protocol+host only). Deep-linked targets
   * (e.g. a hash-routed SPA's "#/login") need this to seed the very first
   * navigation; `sitemap.origin` alone would silently discard the path/hash
   * and land the agent on the bare site root instead of the requested screen.
   */
  readonly startUrl: string;

  sitemap: SiteMap;
  statements: StatementEntry[];
  recipes: Record<string, Recipe>;
  allowlist: Allowlist;
  secrets: Secrets;
  /** Explicit human-provided non-secret field values, reused across runs. */
  fieldValues: Record<string, SavedFieldValue>;
  /**
   * In-memory only (never persisted) — has a REAL login (silent session
   * restore, recipe replay, or a full explorer-driven login) actually
   * succeeded at least once during this process's run? Distinct from
   * "ensureAuthenticated() returned without throwing," which can also mean
   * "the generic auth probe found no login gate at all" — a real, disclosed
   * gap (bstackdemo.com) where those two were conflated. Set by auth.ts.
   */
  authenticatedThisRun = false;

  constructor(baseUrl: string) {
    this.hostname = new URL(baseUrl).hostname;
    this.startUrl = baseUrl;
    this.dir = path.join(config.stateRoot, this.hostname);
    fs.mkdirSync(this.screensDir, { recursive: true });
    fs.mkdirSync(this.inboxDir, { recursive: true });
    fs.mkdirSync(this.walksDir, { recursive: true });

    this.sitemap = readJson<SiteMap>(this.sitemapPath, {
      origin: new URL(baseUrl).origin,
      updatedAt: '',
      pages: {},
      edges: [],
      flows: [],
      walks: {},
      siteHints: [],
    });
    this.sitemap.walks = this.sitemap.walks ?? {};
    // A bounded walk that explicitly ended in no-progress/step-cap is useful
    // diagnostic evidence, but it never proved an end-to-end flow. Older
    // versions generated and users approved these anyway, producing fill-only
    // recipes that could never create/finalize content. Quarantine them while
    // preserving both the map and the walk evidence.
    let quarantined = false;
    for (const flow of this.sitemap.flows) {
      if (/Auto-generated from deep walk .*\(outcome: (?:no-progress|step-cap),/i.test(flow.description)) {
        if (flow.status !== 'skipped') {
          flow.status = 'skipped';
          quarantined = true;
        }
      }
    }
    if (quarantined) this.saveSitemap();
    this.statements = readJson<StatementEntry[]>(this.statementsPath, []);
    this.recipes = readJson<Record<string, Recipe>>(this.recipesPath, {});
    // `approved` used to mean only "the human selected this proposal", even if
    // most milestones had never run and had no recipe. That made partial LLM
    // plans look deterministic. Migrate every legacy selected flow into the
    // explicit lifecycle. Only a terminal deep walk with a recipe for every
    // milestone is ready to TRY replay validation; everything else must learn
    // each milestone through LLM exploration first.
    let lifecycleMigrated = false;
    for (const flow of this.sitemap.flows) {
      const allRecipes =
        flow.milestones.length > 0 &&
        flow.milestones.every((milestone) => Boolean(this.recipes[`flow:${flow.id}:${milestone.id}`]));
      if (flow.status === 'approved') {
        const terminalWalk = /Auto-generated from deep walk .*\(outcome: terminal,/i.test(flow.description);
        flow.status = 'exploratory';
        flow.qualification = { phase: terminalWalk && allRecipes ? 'replay-validation' : 'learning' };
        lifecycleMigrated = true;
      } else if (flow.status === 'deterministic' && !allRecipes) {
        flow.status = 'exploratory';
        flow.qualification = { phase: 'learning' };
        lifecycleMigrated = true;
      } else if (flow.status === 'exploratory' && flow.qualification?.phase === 'replay-validation' && !allRecipes) {
        flow.qualification = { phase: 'learning' };
        lifecycleMigrated = true;
      }
    }
    if (lifecycleMigrated) this.saveSitemap();
    this.allowlist = readJson<Allowlist>(this.allowlistPath, {});
    this.secrets = readJson<Secrets>(this.secretsPath, {});
    this.fieldValues = readJson<Record<string, SavedFieldValue>>(this.fieldValuesPath, {});
  }

  get sitemapPath(): string {
    return path.join(this.dir, 'sitemap.json');
  }
  get statementsPath(): string {
    return path.join(this.dir, 'statements.json');
  }
  get recipesPath(): string {
    return path.join(this.dir, 'recipes.json');
  }
  get allowlistPath(): string {
    return path.join(this.dir, 'allowlist.json');
  }
  get secretsPath(): string {
    return path.join(this.dir, 'secrets.json');
  }
  get fieldValuesPath(): string {
    return path.join(this.dir, 'field-values.json');
  }
  get authStatePath(): string {
    return path.join(this.dir, 'auth-state.json');
  }
  get screensDir(): string {
    return path.join(this.dir, 'screens');
  }
  get inboxDir(): string {
    return path.join(this.dir, 'inbox');
  }
  get walksDir(): string {
    return path.join(this.dir, 'walks');
  }

  saveSitemap(): void {
    this.sitemap.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.sitemapPath, this.sitemap);
  }
  saveStatements(): void {
    writeJsonAtomic(this.statementsPath, this.statements);
  }
  saveRecipes(): void {
    writeJsonAtomic(this.recipesPath, this.recipes);
  }
  saveAllowlist(): void {
    writeJsonAtomic(this.allowlistPath, this.allowlist);
  }
  saveSecrets(): void {
    writeJsonAtomic(this.secretsPath, this.secrets);
    try {
      fs.chmodSync(this.secretsPath, 0o600);
    } catch {
      // best-effort
    }
  }
  saveFieldValues(): void {
    writeJsonAtomic(this.fieldValuesPath, this.fieldValues);
  }

  reset(parts: { sitemap?: boolean; statements?: boolean; recipes?: boolean; auth?: boolean; all?: boolean }): string[] {
    const removed: string[] = [];
    const rm = (p: string) => {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(p);
      }
    };
    if (parts.all) {
      rm(this.dir);
      return removed;
    }
    if (parts.sitemap) rm(this.sitemapPath);
    if (parts.statements) rm(this.statementsPath);
    if (parts.recipes) rm(this.recipesPath);
    if (parts.auth) rm(this.authStatePath);
    return removed;
  }
}
