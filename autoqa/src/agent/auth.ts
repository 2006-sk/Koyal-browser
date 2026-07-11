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
  return looksLikeAuthGate(browser.getUrl(), browser.snapshotInteractive(), browser.hasVisiblePasswordInput());
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

/**
 * A protected route is a better auth probe than the origin (which may always show
 * login). Before any page has been learned (a totally fresh explore), fall back to
 * the exact URL the user asked for (state.startUrl) rather than the bare origin —
 * a deep-linked target (e.g. a hash-routed SPA's "#/login") has its path/hash
 * silently discarded by `sitemap.origin` alone, stranding the very first
 * navigation of the run on the site root instead of the requested entry point.
 */
function authProbeUrl(state: SiteState): string {
  const authedPage = Object.values(state.sitemap.pages).find(
    (p) => p.requiresAuth && p.urlPatterns.some((u) => !u.includes(':id')),
  );
  const pattern = authedPage?.urlPatterns.find((u) => !u.includes(':id'));
  if (pattern) return `${state.sitemap.origin}${pattern}`;
  return state.startUrl || state.sitemap.origin;
}

async function resolveCredentials(ctx: AuthContext): Promise<{ email: string; password: string }> {
  // site-specific saved secrets are a deliberate, per-host choice and must win over
  // any blanket env var — a generic AUTOQA_EMAIL/PASSWORD set for one site (e.g.
  // while also testing Koyal) must never get submitted to an unrelated site's login.
  const emailRes = await ctx.interact.askSecret(
    `login email for ${ctx.state.hostname}`,
    ['AUTOQA_EMAIL'],
    ctx.state.secrets.email,
  );
  const passwordRes = await ctx.interact.askSecret(
    `login password for ${ctx.state.hostname}`,
    ['AUTOQA_PASSWORD'],
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
 *
 * `trustCurrentGate` (default true) governs whether "the browser already looks
 * like it's on a real login gate right now" is trusted as-is, or whether that
 * signal is ignored in favor of navigating to a known probe URL first. Callers
 * that deliberately positioned the browser before calling this (a login-shaped
 * MILESTONE after navigateToEntry/replayUpTo ran for THAT milestone) should
 * leave it true. The generic per-flow-start call is different: at that point
 * nothing has navigated anywhere for the flow about to run yet, so "the current
 * page" is just whatever an unrelated PREVIOUS flow happened to leave on
 * screen — confirmed live on ecommerce-playground.lambdatest.io, where a
 * completed checkout flow left the browser on OpenCart's checkout "Account"
 * step (which legitimately renders an optional returning-customer login form,
 * i.e. a real password input, as ONE choice alongside guest checkout) and the
 * NEXT flow ("Build a product comparison", entry = the unauthenticated home
 * page, no login involved at all) misread that leftover form as "this site
 * requires login," prompting for credentials no flow on this site needed.
 */
export async function ensureAuthenticated(
  ctx: AuthContext,
  opts: { trustCurrentGate?: boolean } = {},
): Promise<void> {
  const { browser, state } = ctx;
  const trustCurrentGate = opts.trustCurrentGate ?? true;

  // A login-shaped MILESTONE calls this while already sitting on the real login
  // page (navigateToEntry took it straight there — e.g. a site whose whole auth
  // gate is a separate /admin area, never linked from any page tagged
  // requiresAuth). The generic probe below unconditionally NAVIGATES AWAY from
  // wherever the browser currently is to authProbeUrl() (the bare origin, when
  // no page is yet known to require auth) — on a public+admin split site that
  // origin is never gated, so the probe concludes "not gated" THERE and returns,
  // having never touched the real, unauthenticated login form it was already on.
  // Confirmed live: automationintesting.online's admin-login milestone was
  // silently skipped this way every run — credentials never entered, the
  // milestone never recorded PASS/FAIL, and the flow still reported an overall
  // "pass" despite authentication never being attempted. Trust the CURRENT page
  // when it already looks like a genuine login gate, instead of bouncing away —
  // UNLESS the caller has explicitly said not to (see `trustCurrentGate` above).
  const alreadyOnRealLoginGate = trustCurrentGate && isGated(browser);

  // 1. Silent path: restore saved storage state
  const probeUrl = authProbeUrl(state);
  if (fs.existsSync(state.authStatePath)) {
    try {
      browser.stateLoad(state.authStatePath);
      browser.wait(500);
    } catch {
      // corrupted state — fall through to fresh login
    }
    // stateLoad() only applies cookies via CDP — it never reloads/re-renders the
    // current page, so the visible DOM stays whatever it was BEFORE the cookies
    // landed. Skipping navigation entirely here (as the earlier version did) left
    // waitForAuthenticated polling a static, stale, pre-restore document that could
    // never change, guaranteeing "expired — logging in fresh" every time even with a
    // perfectly valid session. Reload the CURRENT url (not probeUrl) when already on
    // a real login gate, so the cookies take visible effect without bouncing away to
    // an ungated probe page.
    browser.open(alreadyOnRealLoginGate ? browser.getUrl() : probeUrl);
    if (waitForAuthenticated(browser, alreadyOnRealLoginGate ? 5000 : 15000)) {
      console.log('[auth] session restored silently');
      return;
    }
    console.log('[auth] saved session expired — logging in fresh');
  } else if (alreadyOnRealLoginGate) {
    console.log('[auth] already on a real login gate — skipping the generic probe, logging in directly');
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

  // 3. LLM-explore the login form (mask creds from logs/step history, not the prompt)
  ctx.explorer.setRedactions([creds.password, creds.email]);
  const loginGoal =
    `Log in to this site with email "${creds.email}" and password "${creds.password}". ` +
    `The login form may be behind a toggle or "Log In" tab if the page defaults to sign-up. ` +
    `Use action "done" once you are past the auth gate (URL changes away from login, or the app shell appears).`;
  let result = await ctx.explorer.achieveGoal(loginGoal, { maxSteps: 12 });

  // one full fresh retry — guards against a transient first-attempt hiccup
  // (slow backend, one-off form-submit flake) without weakening detection of
  // genuinely-wrong credentials, which will fail identically on the retry too.
  if (!result.success) {
    console.log(`[auth] first login attempt failed (${result.error ?? 'unknown'}) — retrying once fresh`);
    browser.open(probeUrl);
    browser.wait(1000);
    result = await ctx.explorer.achieveGoal(loginGoal, { maxSteps: 12 });
  }

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
