import { config } from '../config.js';
import type { Interact } from './interact.js';
import type { SiteState } from './site-state.js';

export const LOGOUT_RE = /log ?out|sign ?out/i;

/**
 * Destructive-action gate — the single choke point invoked before every click,
 * from both the Explorer and the RecipePlayer.
 *
 * 1. Keyword hard floor (config.destructiveKeywords) — always destructive,
 *    the LLM cannot override it.
 * 2. Union with sitemap interactives the classifier tagged 'destructive',
 *    and 'submit' clicks on pages tagged sensitive.
 * 3. Destructive → ask yes/no/always/never; always/never persist to the
 *    allowlist so each question is asked at most once.
 * 4. Logout is special-cased: auto-denied (it destroys the session mid-run).
 */
export class Guard {
  constructor(
    private readonly state: SiteState,
    private readonly interact: Interact,
  ) {}

  private allowlistKey(label: string, pageId: string): string {
    return `${label.toLowerCase().trim()}::${pageId}`;
  }

  private isDestructive(label: string, pageId: string): boolean {
    if (config.destructiveKeywords.test(label)) return true;
    const page = this.state.sitemap.pages[pageId];
    if (!page) return false;
    const el = page.interactives.find((i) => i.label.toLowerCase() === label.toLowerCase());
    if (el?.category === 'destructive') return true;
    if (page.sensitive && el?.category === 'submit') return true;
    return false;
  }

  async confirmClick(label: string, pageId: string): Promise<boolean> {
    if (LOGOUT_RE.test(label)) {
      console.log(`[guard] auto-denied "${label}" (logout destroys the session)`);
      return false;
    }

    if (!this.isDestructive(label, pageId)) return true;

    const key = this.allowlistKey(label, pageId);
    const remembered = this.state.allowlist[key];
    if (remembered === 'always') return true;
    if (remembered === 'never') {
      console.log(`[guard] "${label}" on ${pageId} denied by saved answer`);
      return false;
    }

    const answer = await this.interact.askConfirmAction(
      `About to click "${label}" on page "${pageId}" — this looks destructive/irreversible. Allow?`,
    );
    if (answer === 'always' || answer === 'never') {
      this.state.allowlist[key] = answer;
      this.state.saveAllowlist();
    }
    return answer === 'yes' || answer === 'always';
  }
}
