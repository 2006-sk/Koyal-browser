import fs from 'node:fs';
import path from 'node:path';
import { config, requireBaseUrl, requireLlm } from '../config.js';
import { AgentBrowser } from '../core/agent-browser.js';
import { Explorer, isSensitiveFieldLabel } from '../core/explorer.js';
import { LlmClient } from '../core/llm/client.js';
import type { AuthContext } from '../agent/auth.js';
import { Guard } from '../agent/guard.js';
import { Interact } from '../agent/interact.js';
import { RecipePlayer } from '../agent/recipes.js';
import { SiteState } from '../agent/site-state.js';
import { Statements } from '../agent/statements.js';
import { matchPage } from '../agent/sitemap.js';
import { resolveHumanFieldValue } from '../agent/field-values.js';

export interface Session {
  browser: AgentBrowser;
  state: SiteState;
  interact: Interact;
  llm: LlmClient;
  guard: Guard;
  player: RecipePlayer;
  statements: Statements;
  explorer: Explorer;
  authCtx: AuthContext;
}

export type UploadKind = 'pdf' | 'audio' | 'any';

/** Infer what kind of file an upload wants from the LLM's reason / selector hint. */
export function inferUploadKind(selectorHint?: string, reason?: string): UploadKind {
  const context = `${selectorHint ?? ''} ${reason ?? ''}`.toLowerCase();
  if (/pdf|script|document/.test(context)) return 'pdf';
  if (/audio|wav|mp3|m4a|narration|music|song|voice/.test(context)) return 'audio';
  return 'any';
}

const KIND_EXT: Record<UploadKind, RegExp> = {
  pdf: /\.pdf$/i,
  audio: /\.(wav|mp3|m4a|mp4)$/i,
  any: /\.(pdf|txt|wav|mp3|png|jpg|csv|mp4|m4a)$/i,
};

/** Known local test assets offered as suggestions when the agent needs a file. */
export function uploadSuggestions(kind: UploadKind = 'any'): string[] {
  const suggestions: string[] = [];
  if (config.uploadFileOverride) suggestions.push(config.uploadFileOverride);
  const envList = process.env.AUTOQA_UPLOAD_SUGGESTIONS;
  if (envList) {
    suggestions.push(...envList.split(',').map((s) => s.trim()).filter(Boolean));
  }
  const scanDirs = [
    path.join(config.projectRoot, 'assets'),
    path.resolve(config.projectRoot, '../happyflow'),
  ];
  const pattern = KIND_EXT[kind];
  for (const dir of scanDirs) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (pattern.test(file)) suggestions.push(path.join(dir, file));
      }
    } catch {
      // dir absent
    }
  }
  return [...new Set(suggestions)].slice(0, 8);
}

export function bootstrap(): Session {
  const baseUrl = requireBaseUrl();
  requireLlm();
  LlmClient.budget = config.llm.callBudget;

  const state = new SiteState(baseUrl);
  const interact = new Interact(
    state.inboxDir,
    2000,
    Number(process.env.AUTOQA_PROMPT_TIMEOUT_MS ?? '300000'),
  );
  const browser = new AgentBrowser({ session: `${config.session}-${state.hostname}` });
  const llm = new LlmClient();
  const guard = new Guard(state, interact);
  const pageIdNow = (): string => {
    try {
      const url = browser.getUrl();
      // cheap URL-only match first; wizard states need the snapshot to disambiguate
      const byUrl = matchPage(state.sitemap, url, '');
      if (byUrl) return byUrl.id;
      return matchPage(state.sitemap, url, browser.snapshotInteractive())?.id ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const resolveFillValue = async (
    label: string,
    proposedValue: string,
    context?: { sensitive: boolean },
  ): Promise<string> => {
    const sensitive = context?.sensitive || isSensitiveFieldLabel(label);
    if (!sensitive) return resolveHumanFieldValue(state, interact, pageIdNow(), label, proposedValue);

    const passwordLike = /\b(password|passcode|pin)\b/i.test(label);
    const identityLike = /\b(email|e-mail|user\s*name|username)\b/i.test(label);
    if (passwordLike && state.secrets.password) return state.secrets.password;
    if (identityLike && state.secrets.email) return state.secrets.email;
    // applyCliOverrides scopes these environment values to Koyal before bootstrap.
    // Use them directly through the protected channel after --wipeout instead of
    // asking again or copying them into field-values/decisions/recipes.
    if (passwordLike && process.env.AUTOQA_PASSWORD) return process.env.AUTOQA_PASSWORD;
    if (identityLike && process.env.AUTOQA_EMAIL) return process.env.AUTOQA_EMAIL;

    const answer = await interact.ask(`Enter ${label}`, { secret: true });
    if (!answer.trim()) throw new Error(`No protected value provided for "${label}"`);
    if (passwordLike) state.secrets.password = answer;
    else if (identityLike) state.secrets.email = answer;
    state.saveSecrets();
    return answer;
  };
  const player = new RecipePlayer(
    browser,
    state,
    guard,
    resolveFillValue,
    (suggestedPath) => interact.askPath('A saved recipe is ready to upload a file. Local path?', [suggestedPath]),
  );
  const statements = new Statements(state, interact, llm);

  const explorer = new Explorer(browser, {
    llm,
    siteDescription: baseUrl,
    siteHints: state.sitemap.siteHints,
    hooks: {
      beforeClick: (label) => guard.confirmClick(label, pageIdNow()),
      onUploadRequested: async (selector, reason) => {
        try {
          const kind = inferUploadKind(selector, reason);
          return await interact.askPath(
            `The agent needs a ${kind === 'any' ? '' : `${kind} `}file to upload${reason ? ` (${reason})` : ''}. Local path?`,
            uploadSuggestions(kind),
          );
        } catch {
          return null;
        }
      },
      onFillRequested: resolveFillValue,
    },
  });

  const authCtx: AuthContext = { browser, state, interact, explorer, player };

  return { browser, state, interact, llm, guard, player, statements, explorer, authCtx };
}

export function teardown(session: Session): void {
  try {
    session.browser.close();
  } catch {
    // browser may already be closed
  }
  session.interact.close();
}
