import fs from 'node:fs';
import path from 'node:path';
import { config, requireBaseUrl, requireLlm } from '../config.js';
import { AgentBrowser } from '../core/agent-browser.js';
import { Explorer } from '../core/explorer.js';
import { LlmClient } from '../core/llm/client.js';
import type { AuthContext } from '../agent/auth.js';
import { Guard } from '../agent/guard.js';
import { Interact } from '../agent/interact.js';
import { RecipePlayer } from '../agent/recipes.js';
import { SiteState } from '../agent/site-state.js';
import { Statements } from '../agent/statements.js';
import { matchPage } from '../agent/sitemap.js';

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
  const player = new RecipePlayer(browser, state, guard);
  const statements = new Statements(state, interact, llm);

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
