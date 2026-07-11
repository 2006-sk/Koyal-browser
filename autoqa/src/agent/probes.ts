import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import { snapshotIncludes } from '../core/agent-browser.js';
import { fillEditableByIndex, randomEditMarker } from '../core/edits.js';
import type { Nav } from '../core/nav.js';
import { recordVerifiedStep, type StepContext } from '../core/scenario-runner.js';
import type { TestStep, VerificationExpectation } from '../core/types.js';
import type { Statements } from './statements.js';
import type { SiteState } from './site-state.js';
import { matchPage, type Flow, type FlowMilestone, type OptionGroup, type PageNode } from './sitemap.js';

export interface ProbeContext {
  browser: AgentBrowser;
  state: SiteState;
  nav: Nav;
  statements: Statements;
  stepCtx: StepContext;
}

export interface ProbeOutcome {
  probe: string;
  step: TestStep;
}

const PROBE_BASE: Partial<VerificationExpectation> = {
  allowPageErrors: true,
  allowConsoleErrors: false,
  maxUnexpectedNetwork5xx: 2,
};

function pageIdNow(ctx: ProbeContext): string {
  try {
    const url = ctx.browser.getUrl();
    return (
      matchPage(ctx.state.sitemap, url, '')?.id ??
      matchPage(ctx.state.sitemap, url, ctx.browser.snapshotInteractive())?.id ??
      'unknown'
    );
  } catch {
    return 'unknown';
  }
}

async function recordProbe(
  ctx: ProbeContext,
  workflow: string,
  action: string,
  expected: string,
  expectation: VerificationExpectation,
  waitMs = 12000,
): Promise<TestStep> {
  ctx.stepCtx.stepsToReproduce.push(`[probe] ${action}`);
  const augmented = ctx.statements.augmentExpectation(expectation, pageIdNow(ctx));
  return recordVerifiedStep(ctx.stepCtx, {
    workflow,
    action,
    expected,
    expectation: augmented,
    waitOptions: { maxWaitMs: waitMs, pollMs: 2000 },
  });
}

/**
 * Browser back → forward mid-flow; the app must recover to the current step
 * with prior edits (marker) intact. In-app "Back"-style buttons are exercised
 * too when one is enabled and a previous landmark is known.
 */
export async function backForwardProbe(
  ctx: ProbeContext,
  workflowPrefix: string,
  opts: { landmark?: string; marker?: string; prevLandmark?: string },
): Promise<ProbeOutcome | null> {
  const { browser } = ctx;
  const anchors = [opts.landmark, opts.marker].filter(Boolean) as string[];
  if (anchors.length === 0) return null;

  try {
    browser.back();
    browser.wait(1200);
    browser.forward();
    browser.wait(1200);

    const step = await recordProbe(
      ctx,
      `${workflowPrefix}:back-forward`,
      'browser back then forward mid-flow',
      `app recovers to the same step; prior state (${anchors.map((a) => `"${a.slice(0, 24)}"`).join(', ')}) intact`,
      { ...PROBE_BASE, description: 'optional: browser history round trip', snapshotIncludesAny: anchors },
    );
    return { probe: 'back-forward', step };
  } catch {
    return null;
  }
}

/**
 * Leave the flow via a plain page, then return to the recorded URL — state
 * (landmark/marker) should survive the abandon+resume.
 */
export async function abandonResumeProbe(
  ctx: ProbeContext,
  workflowPrefix: string,
  opts: { landmark?: string; marker?: string },
): Promise<ProbeOutcome | null> {
  const { browser, state } = ctx;
  const anchors = [opts.landmark, opts.marker].filter(Boolean) as string[];
  if (anchors.length === 0) return null;

  const escapePage = Object.values(state.sitemap.pages).find(
    (p) => (p.kind ?? 'page') === 'page' && p.urlPatterns.some((u) => !u.includes(':id')),
  );
  const escapePattern = escapePage?.urlPatterns.find((u) => !u.includes(':id'));
  if (!escapePattern) return null;

  try {
    const resumeUrl = browser.getUrl();
    browser.open(`${state.sitemap.origin}${escapePattern}`);
    browser.wait(1500);
    browser.open(resumeUrl);
    browser.wait(2500);

    const step = await recordProbe(
      ctx,
      `${workflowPrefix}:abandon-resume`,
      `leave to ${escapePage!.id}, then re-open the flow URL`,
      `flow state resumes (${anchors.map((a) => `"${a.slice(0, 24)}"`).join(', ')})`,
      { ...PROBE_BASE, description: 'optional: abandon and resume', snapshotIncludesAny: anchors },
      20000,
    );
    return { probe: 'abandon-resume', step };
  } catch {
    return null;
  }
}

/**
 * Click every member of a discovered option group (each must stay selectable,
 * no crash), then settle back on the canonical member. If a click navigates
 * away, back out and flag it.
 */
export async function optionMatrixProbe(
  ctx: ProbeContext,
  workflowPrefix: string,
  page: PageNode,
): Promise<ProbeOutcome[]> {
  const outcomes: ProbeOutcome[] = [];
  // exhaustive mode exercises EVERY option group and EVERY member; default caps to 2 groups / 6 members
  const groups = config.probes.exhaustive ? (page.optionGroups ?? []) : (page.optionGroups ?? []).slice(0, 2);

  for (const group of groups) {
    const missing: string[] = [];
    let navigatedAway = false;

    const members = config.probes.exhaustive ? group.memberLabels : group.memberLabels.slice(0, 6);
    for (const label of members) {
      const clicked = ctx.nav.click({ label, exact: true, optional: true });
      if (!clicked) {
        missing.push(label);
        continue;
      }
      ctx.browser.wait(600);
      const current = pageIdNow(ctx);
      if (current !== 'unknown' && current !== page.id) {
        navigatedAway = true;
        try {
          ctx.browser.back();
          ctx.browser.wait(1500);
        } catch {
          // keep going; the recorded step will surface the state
        }
        break;
      }
    }

    // settle on the canonical member
    ctx.nav.click({ label: group.canonical, exact: true, optional: true });
    ctx.browser.wait(600);

    const problems = [
      ...missing.map((m) => `"${m}" not clickable`),
      ...(navigatedAway ? ['an option click navigated away from the step'] : []),
    ];
    const expectation: VerificationExpectation = {
      ...PROBE_BASE,
      description: `${group.primary ? '' : 'optional: '}option group "${group.id}" members all selectable`,
      snapshotIncludesAny: [group.canonical],
      // absent members force a visible failure for primary groups
      ...(group.primary && missing.length > 0 ? { snapshotIncludes: missing } : {}),
    };

    const step = await recordProbe(
      ctx,
      `${workflowPrefix}:matrix-${group.id}`,
      `try each option in "${group.id}" (${group.memberLabels.join(', ')}), settle on "${group.canonical}"`,
      problems.length ? `all options selectable — issues: ${problems.join('; ')}` : 'all options selectable, canonical restored',
      expectation,
    );
    outcomes.push({ probe: `matrix-${group.id}`, step });
  }

  return outcomes;
}

/**
 * Edit visible editable fields with run-unique markers and verify each edit
 * echoes back in the snapshot. The milestone's own target field is hard-verified.
 */
export async function editSweepProbe(
  ctx: ProbeContext,
  workflowPrefix: string,
  opts: { cap?: number },
): Promise<ProbeOutcome | null> {
  const { browser } = ctx;
  const cap = opts.cap ?? 3;

  let count = 0;
  try {
    const stdout = browser.evalScript(`
      (function() {
        const els = [...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=true]')]
          .filter(el => el.offsetParent !== null || el.getClientRects().length);
        return String(els.length);
      })();
    `);
    count = Math.min(Number(stdout.match(/\d+/)?.[0] ?? '0'), cap);
  } catch {
    return null;
  }
  if (count === 0) return null;

  const results: string[] = [];
  const markers: string[] = [];
  for (let i = 0; i < count; i++) {
    const marker = randomEditMarker(`sweep${i}`);
    const filled = fillEditableByIndex(browser, i, marker);
    results.push(`field ${i}: ${filled.ok ? 'edit stuck' : `NOT verified (${filled.detail})`}`);
    if (filled.ok) markers.push(marker.slice(0, 20));
  }

  const step = await recordProbe(
    ctx,
    `${workflowPrefix}:edit-sweep`,
    `edit ${count} visible field(s) with unique markers`,
    results.join('; '),
    {
      ...PROBE_BASE,
      description: 'optional: edits echo back in the page',
      snapshotIncludesAny: markers.length ? markers : undefined,
      // no marker stuck anywhere → force a visible failure signal
      ...(markers.length === 0 ? { snapshotIncludes: ['__autoqa_edit_never_stuck__'] } : {}),
    },
  );
  return { probe: 'edit-sweep', step };
}

/** Alternate a 2-member option group 5× — the UI must end stable on the last pick. */
export async function rapidToggleProbe(
  ctx: ProbeContext,
  workflowPrefix: string,
  page: PageNode,
): Promise<ProbeOutcome | null> {
  const pair = (page.optionGroups ?? []).find((g) => g.memberLabels.length === 2);
  if (!pair) return null;

  try {
    for (let i = 0; i < 5; i++) {
      const label = pair.memberLabels[i % 2];
      ctx.nav.click({ label, exact: true, optional: true });
      ctx.browser.wait(250);
    }
    ctx.nav.click({ label: pair.canonical, exact: true, optional: true });
    ctx.browser.wait(600);

    // Some 2-member "toggles" are actually two nav links that transition to a
    // DIFFERENT page/state (e.g. a role selector like "Customer Login" /
    // "Bank Manager Login" that navigates to a customer- or manager-only
    // screen) rather than switching an in-place UI control on the same page.
    // Requiring the clicked label's own text to still be visible after a real
    // navigation always false-fails — that label was left behind on the page
    // that's no longer displayed, even though the click correctly navigated.
    // Only require the label-visible check for a TRUE in-place toggle (same
    // page before/after); otherwise just assert the page didn't end up broken
    // (PROBE_BASE's page-error/console-error checks still apply either way).
    // 'unknown' means matchPage couldn't classify wherever we ended up — which is
    // exactly what happens when settling navigates to a genuinely new, not-yet-
    // crawled page (e.g. a role-selector toggle whose members are real nav links,
    // not an in-place control). Treating 'unknown' as "stayed" reproduces the same
    // false-fail this check exists to avoid: requiring the OLD label's text on a
    // page it was never on. Only a POSITIVE match to the same page id counts as
    // having stayed; anything else falls back to the safer base checks.
    const current = pageIdNow(ctx);
    const stayedOnPage = current === page.id;
    const expectation: VerificationExpectation = stayedOnPage
      ? { ...PROBE_BASE, description: 'optional: rapid toggle stability', snapshotIncludesAny: [pair.canonical] }
      : { ...PROBE_BASE, description: 'optional: rapid toggle stability (settled via navigation, not an in-place toggle)' };

    const step = await recordProbe(
      ctx,
      `${workflowPrefix}:rapid-toggle`,
      `rapidly alternate "${pair.memberLabels.join('" / "')}" 5x, settle on "${pair.canonical}"`,
      'UI stays stable, no crash',
      expectation,
    );
    return { probe: 'rapid-toggle', step };
  } catch {
    return null;
  }
}

/** Pick applicable probes for a milestone, bounded by the per-milestone cap. */
export async function runProbesForMilestone(
  ctx: ProbeContext,
  flow: Flow,
  milestone: FlowMilestone,
  page: PageNode | undefined,
  opts: { marker?: string; skipLandmark?: boolean },
): Promise<ProbeOutcome[]> {
  if (!config.probes.thorough) return [];
  const kind = page?.kind ?? 'page';
  if (kind === 'processing' || kind === 'terminal' || kind === 'error') return [];

  const cap = config.probes.exhaustive ? 99 : config.probes.perMilestoneCap;
  const prefix = `probe:${flow.id}:${milestone.id}`;
  // a login-shaped milestone's successHint is often literal login-page text (e.g.
  // "Login") that legitimately never reappears once authenticated — the same
  // reason runMilestone() drops it (see isLoginShapedGoal), so probes must too.
  const landmark = opts.skipLandmark ? undefined : milestone.successHint;
  const outcomes: ProbeOutcome[] = [];

  const runners: Array<() => Promise<ProbeOutcome[] | ProbeOutcome | null>> = [];

  if (page && kind === 'wizard-step' && page.optionGroups?.length) {
    runners.push(() => optionMatrixProbe(ctx, prefix, page));
  }
  if (milestone.kind === 'edit' || kind === 'wizard-step') {
    runners.push(() => editSweepProbe(ctx, prefix, { cap: 3 }));
  }
  runners.push(() => backForwardProbe(ctx, prefix, { landmark, marker: opts.marker }));
  if (milestone.kind === 'create' || milestone.kind === 'upload') {
    runners.push(() => abandonResumeProbe(ctx, prefix, { landmark, marker: opts.marker }));
  }
  if (page && page.optionGroups?.some((g: OptionGroup) => g.memberLabels.length === 2)) {
    runners.push(() => rapidToggleProbe(ctx, prefix, page));
  }

  for (const run of runners) {
    if (outcomes.length >= cap) break;
    try {
      const result = await run();
      if (Array.isArray(result)) outcomes.push(...result);
      else if (result) outcomes.push(result);
    } catch (error) {
      console.warn(`[probe] skipped after error: ${error instanceof Error ? error.message : error}`);
    }
  }

  for (const outcome of outcomes) {
    console.log(`  [probe] ${outcome.probe}: ${outcome.step.result.verdict}`);
  }
  return outcomes.slice(0, cap + 2); // matrices may emit 2 steps; keep them all but bounded
}

/** Is any text still visible? Convenience for probe callers. */
export function stillVisible(browser: AgentBrowser, text: string): boolean {
  return snapshotIncludes(browser.snapshotInteractive(), text.slice(0, 30));
}
