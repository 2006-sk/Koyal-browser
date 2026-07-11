import { config } from '../config.js';
import { APP_SHELL_NAV_ITEMS } from '../lib/app-shell-selectors.js';
import { AgentBrowser } from '../lib/agent-browser.js';
import { APP_SHELL_EXPECTATION_BASE, AppShellPage } from '../lib/page-app.js';
import { recordVerifiedStep, type StepContext } from '../lib/scenario-runner.js';
import type { ScenarioResult, TestStep } from '../lib/types.js';
import { VerificationLayer } from '../lib/verification.js';

export async function testAppShellNavigation(
  browser: AgentBrowser,
  evidenceDir: string,
): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const steps: TestStep[] = [];
  const app = new AppShellPage(browser);
  const verification = new VerificationLayer(browser);
  const repro: string[] = [];

  const ctx = (): StepContext => ({
    browser,
    verification,
    evidenceDir,
    stepsToReproduce: repro,
  });

  repro.push('Login or restore authenticated session');
  await app.loginOrRestoreSession();

  const shellStep = await recordVerifiedStep(ctx(), {
    workflow: 'app-shell-loaded',
    action: 'Land in authenticated app shell after login',
    expected: 'Sidebar with Projects/Dashboard visible',
    expectation: {
      description: 'App shell loads after auth',
      ...APP_SHELL_EXPECTATION_BASE,
      snapshotIncludesAny: ['projects', 'dashboard', 'good afternoon'],
    },
  });
  steps.push(shellStep);

  // Visit each sidebar destination
  for (const item of APP_SHELL_NAV_ITEMS) {
    repro.push(`Navigate sidebar → ${item.id}`);
    browser.clearSignals();
    await app.navigateSidebarAndSettle(item);

    const navStep = await recordVerifiedStep(ctx(), {
      workflow: `nav-${item.id}`,
      action: `Click sidebar "${item.id}" and verify page loads`,
      expected: `URL or content matches ${item.id}; no 5xx or blank screen`,
      expectation: {
        description: `${item.id} page loads`,
        ...APP_SHELL_EXPECTATION_BASE,
        snapshotIncludesAny: item.snapshotHints,
        maxUnexpectedNetwork5xx: 0,
      },
    });
    steps.push(navStep);
  }

  // Back-and-forth: Projects → Characters → back → forward → Dashboard
  repro.push('Back-and-forth: Projects → Characters → browser back → forward → Dashboard');
  const projects = APP_SHELL_NAV_ITEMS.find((i) => i.id === 'projects')!;
  const characters = APP_SHELL_NAV_ITEMS.find((i) => i.id === 'characters')!;
  const dashboard = APP_SHELL_NAV_ITEMS.find((i) => i.id === 'dashboard')!;

  browser.clearSignals();
  await app.navigateSidebarAndSettle(projects);
  await app.navigateSidebarAndSettle(characters);
  browser.back();
  browser.wait(1000);
  browser.forward();
  browser.wait(1000);
  await app.navigateSidebarAndSettle(dashboard);

  const backForthStep = await recordVerifiedStep(ctx(), {
    workflow: 'app-shell-back-forward',
    action: 'Sidebar navigation with browser back/forward between pages',
    expected: 'Dashboard loads after back/forward chain; no broken state',
    expectation: {
      description: 'App shell survives browser history navigation',
      ...APP_SHELL_EXPECTATION_BASE,
      snapshotIncludesAny: ['dashboard', 'good afternoon', 'projects'],
    },
  });
  steps.push(backForthStep);

  // Round-trip: Dashboard → Outfits → Projects
  repro.push('Round-trip: Dashboard → Outfits → Projects');
  const outfits = APP_SHELL_NAV_ITEMS.find((i) => i.id === 'outfits')!;
  browser.clearSignals();
  await app.navigateSidebarAndSettle(dashboard);
  await app.navigateSidebarAndSettle(outfits);
  await app.navigateSidebarAndSettle(projects);

  const roundTripStep = await recordVerifiedStep(ctx(), {
    workflow: 'app-shell-round-trip',
    action: 'Navigate Dashboard → Outfits → Projects',
    expected: 'Projects page loads after multi-hop navigation',
    expectation: {
      description: 'Multi-hop sidebar navigation works',
      ...APP_SHELL_EXPECTATION_BASE,
      snapshotIncludesAny: ['project', 'create project', 'your projects'],
    },
  });
  steps.push(roundTripStep);

  // Account menu (if present)
  repro.push('Open account menu button if visible');
  browser.clearSignals();
  const opened = app.clickAccountMenuIfPresent();

  const accountStep = await recordVerifiedStep(ctx(), {
    workflow: 'account-menu',
    action: 'Click account/profile menu control in sidebar',
    expected: opened
      ? 'Account menu opens or toggles without error'
      : 'Account control not in a11y tree — needs manual check',
    expectation: {
      description: 'Account menu interaction',
      ...APP_SHELL_EXPECTATION_BASE,
      snapshotExcludes: ['Internal Server Error', 'TypeError'],
    },
  });
  if (!opened) {
    accountStep.result.verdict = 'needs-review';
    accountStep.result.reasons.push('Account menu button not identified in accessibility snapshot');
    accountStep.result.severity = 'low';
  }
  steps.push(accountStep);

  return {
    id: 'app-shell-navigation',
    name: 'Post-login app shell navigation',
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
