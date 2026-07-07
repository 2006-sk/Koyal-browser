import fs from 'node:fs';
import type { AgentBrowser } from '../core/agent-browser.js';
import type { Explorer } from '../core/explorer.js';
import { looksLikeAuthGate, looksLikeOtpGate } from './page-classifier.js';
import { recordFromExplorer, RecipePlayer } from './recipes.js';
import type { Interact } from './interact.js';
import type { SiteState } from './site-state.js';

export interface AuthContext {
  browser: AgentBrowser;
  state: SiteState;
  interact: Interact;
  explorer: Explorer;
  player: RecipePlayer;
}

function isGated(browser: AgentBrowser): boolean {
  return looksLikeAuthGate(browser.getUrl(), browser.snapshotInteractive());
}

/** SPA hydration + auth redirects lag page load — poll instead of sampling once. */
function waitForAuthenticated(browser: AgentBrowser, maxMs: number): boolean {
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (!isGated(browser)) return true;
    if (Date.now() >= deadline) return false;
    browser.wait(2000);
  }
}

/** A protected route is a better auth probe than the origin (which may always show login). */
function authProbeUrl(state: SiteState): string {
  const authedPage = Object.values(state.sitemap.pages).find(
    (p) => p.requiresAuth && p.urlPatterns.some((u) => !u.includes(':id')),
  );
  const pattern = authedPage?.urlPatterns.find((u) => !u.includes(':id'));
  return pattern ? `${state.sitemap.origin}${pattern}` : state.sitemap.origin;
}

async function resolveCredentials(ctx: AuthContext): Promise<{ email: string; password: string }> {
  const emailRes = await ctx.interact.askSecret(
    `login email for ${ctx.state.hostname}`,
    ['AUTOQA_EMAIL', 'KOYAL_TEST_EMAIL'],
    ctx.state.secrets.email,
  );
  const passwordRes = await ctx.interact.askSecret(
    `login password for ${ctx.state.hostname}`,
    ['AUTOQA_PASSWORD', 'KOYAL_TEST_PASSWORD'],
    ctx.state.secrets.password,
  );

  if (emailRes.fromPrompt || passwordRes.fromPrompt) {
    const save = await ctx.interact.askYesNo(
      `Save these credentials to ${ctx.state.secretsPath} for future runs?`,
      true,
    );
    if (save) {
      ctx.state.secrets.email = emailRes.value;
      ctx.state.secrets.password = passwordRes.value;
      ctx.state.saveSecrets();
    }
  }

  return { email: emailRes.value, password: passwordRes.value };
}

/**
 * Generic login: restore saved session → replay learned login recipe →
 * LLM-explore the login form. OTP challenges route through the human channel.
 */
export async function ensureAuthenticated(ctx: AuthContext): Promise<void> {
  const { browser, state } = ctx;

  // 1. Silent path: restore saved storage state
  const probeUrl = authProbeUrl(state);
  if (fs.existsSync(state.authStatePath)) {
    try {
      browser.stateLoad(state.authStatePath);
      browser.wait(500);
    } catch {
      // corrupted state — fall through to fresh login
    }
    browser.open(probeUrl);
    if (waitForAuthenticated(browser, 15000)) {
      console.log('[auth] session restored silently');
      return;
    }
    console.log('[auth] saved session expired — logging in fresh');
  } else {
    browser.open(probeUrl);
    if (waitForAuthenticated(browser, 8000)) {
      console.log('[auth] site is not auth-gated (or already authenticated)');
      return;
    }
  }

  const creds = await resolveCredentials(ctx);

  // 2. Replay learned login recipe (zero LLM calls)
  if (ctx.player.has('auth:login')) {
    const replay = await ctx.player.tryReplay('auth:login', {
      pageId: 'login',
      secrets: creds,
    });
    if (replay.ok && waitForAuthenticated(browser, 10000)) {
      browser.stateSave(state.authStatePath);
      console.log('[auth] logged in via recipe replay');
      return;
    }
  }

  // 3. LLM-explore the login form
  const result = await ctx.explorer.achieveGoal(
    `Log in to this site with email "${creds.email}" and password "${creds.password}". ` +
      `The login form may be behind a toggle or "Log In" tab if the page defaults to sign-up. ` +
      `Use action "done" once you are past the auth gate (URL changes away from login, or the app shell appears).`,
    { maxSteps: 12 },
  );

  if (!result.success) {
    throw new Error(`Login failed: ${result.error ?? 'explorer could not complete login'}`);
  }

  browser.wait(2000);

  // 4. OTP / verification code challenge
  if (looksLikeOtpGate(browser.snapshotInteractive())) {
    const code = await ctx.interact.ask(
      `The site is asking for a verification code (check ${creds.email})`,
    );
    await ctx.explorer.achieveGoal(
      `Enter the verification code "${code}" into the code field and submit. Use "done" once accepted.`,
      { maxSteps: 6 },
    );
    browser.wait(2000);
  }

  if (!waitForAuthenticated(browser, 15000)) {
    throw new Error('Still on the auth gate after login attempt — credentials may be wrong');
  }

  browser.stateSave(state.authStatePath);
  recordFromExplorer(state, 'auth:login', result, { secrets: creds });
  console.log('[auth] logged in via explorer; session + recipe saved');
}
