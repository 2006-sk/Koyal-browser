import path from 'node:path';
import { config } from '../config.js';
import type { AgentBrowser } from '../core/agent-browser.js';
import type { Explorer } from '../core/explorer.js';
import type { LlmClient } from '../core/llm/client.js';
import { Nav } from '../core/nav.js';
import { deepWalk, type DeepWalkEntry } from './deep-walker.js';
import { classifyPage, proposeFlows } from './page-classifier.js';
import type { Interact } from './interact.js';
import type { SiteState } from './site-state.js';
import {
  matchPage,
  mergePage,
  normalizePath,
  summarizeSitemap,
  type Flow,
  type PageNode,
  type SiteMap,
} from './sitemap.js';

interface QueueItem {
  url: string;
  depth: number;
}

interface Inventory {
  pageIds: Set<string>;
  interactiveKeys: Set<string>;
  walkIds: Set<string>;
}

function takeInventory(sitemap: SiteMap): Inventory {
  const pageIds = new Set(Object.keys(sitemap.pages));
  const interactiveKeys = new Set<string>();
  for (const page of Object.values(sitemap.pages)) {
    for (const el of page.interactives) interactiveKeys.add(`${page.id}::${el.label}`);
  }
  return { pageIds, interactiveKeys, walkIds: new Set(Object.keys(sitemap.walks ?? {})) };
}

function diffInventory(before: Inventory, sitemap: SiteMap): { added: string[]; removedHint: string[] } {
  const added: string[] = [];
  for (const [id, page] of Object.entries(sitemap.pages)) {
    if (!before.pageIds.has(id)) added.push(`page "${id}" (${page.kind ?? 'page'}) — ${page.title}`);
  }
  for (const page of Object.values(sitemap.pages)) {
    for (const el of page.interactives) {
      const key = `${page.id}::${el.label}`;
      if (!before.interactiveKeys.has(key) && before.pageIds.has(page.id)) {
        added.push(`interactive "${el.label}" [${el.category}] on ${page.id}`);
      }
    }
  }
  // pages that stopped matching this run are only detectable heuristically; report stale walks
  const removedHint: string[] = [];
  return { added, removedHint };
}

/** Same-origin hrefs pulled from the live DOM — accessibility snapshots omit hrefs. */
function extractSameOriginLinks(browser: AgentBrowser, origin: string): string[] {
  const urls = new Set<string>();
  try {
    const stdout = browser.evalScript(`
      (function() {
        const out = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href');
          if (href && !href.startsWith('#') && !href.startsWith('javascript:')) out.add(a.href);
        }
        return JSON.stringify([...out].slice(0, 100));
      })();
    `);
    const match = stdout.match(/\[[\s\S]*\]/);
    for (const raw of match ? (JSON.parse(match[0]) as string[]) : []) {
      try {
        const url = new URL(raw, origin);
        if (url.origin === origin) urls.add(url.href.split('#')[0]);
      } catch {
        // not a URL
      }
    }
  } catch {
    // eval unavailable — no free edges this page
  }
  return [...urls];
}

/**
 * The EXPLORE engine: BFS crawl from the origin, LLM-classifying each new page,
 * click-probing nav elements to discover SPA transitions, then proposing flows.
 * Discovery only — no form submits, uploads, or edits happen here.
 */
export async function explore(
  browser: AgentBrowser,
  state: SiteState,
  llm: LlmClient,
  interact: Interact,
  explorer: Explorer,
  opts: { maxPages?: number; depth?: number; probesPerPage?: number; deepFlows?: number } = {},
): Promise<void> {
  const maxPages = opts.maxPages ?? config.maxPages;
  const maxDepth = opts.depth ?? config.crawlDepth;
  const probesPerPage = opts.probesPerPage ?? config.probesPerPage;
  const nav = new Nav(browser);
  const origin = state.sitemap.origin;
  const inventoryBefore = takeInventory(state.sitemap);

  // re-probe interactives whose earlier probe led nowhere (clicks can fail transiently)
  for (const page of Object.values(state.sitemap.pages)) {
    for (const el of page.interactives) {
      if (el.probed && !el.targetPageId) el.probed = false;
    }
  }

  // Seed with the CURRENT (post-auth) page first: many apps show the login form
  // at the origin even with a valid session (no auth redirect), so re-opening the
  // origin would discard the only authenticated doorway into the app.
  const queue: QueueItem[] = [];
  try {
    const landing = browser.getUrl();
    if (landing && new URL(landing).origin === origin && normalizePath(landing) !== '/') {
      queue.push({ url: landing, depth: 0 });
    }
  } catch {
    // no current page
  }
  queue.push({ url: origin, depth: 0 });
  for (const page of Object.values(state.sitemap.pages)) {
    for (const pattern of page.urlPatterns) {
      if (!pattern.includes(':id')) queue.push({ url: `${origin}${pattern}`, depth: 1 });
    }
  }

  const visitedThisRun = new Set<string>();
  let pagesVisited = 0;

  const identifyCurrentPage = async (): Promise<PageNode> => {
    const url = browser.getUrl();
    const snapshot = browser.snapshotInteractive();
    const known = matchPage(state.sitemap, url, snapshot);
    if (known) {
      known.lastSeenAt = new Date().toISOString();
      const norm = normalizePath(url);
      if (!known.urlPatterns.includes(norm)) known.urlPatterns.push(norm);
      return known;
    }
    console.log(`[crawl] classifying new page at ${url}`);
    const classified = await classifyPage(llm, url, snapshot);
    const merged = mergePage(state.sitemap, classified);
    try {
      const shot = path.join(state.screensDir, `${merged.id}.png`);
      browser.screenshotAnnotated(shot);
      merged.screenshot = shot;
    } catch {
      // best-effort screenshot
    }
    state.saveSitemap();
    return merged;
  };

  while (queue.length > 0 && pagesVisited < maxPages) {
    const item = queue.shift()!;
    const norm = normalizePath(item.url);
    if (visitedThisRun.has(norm) || item.depth > maxDepth) continue;
    visitedThisRun.add(norm);

    console.log(`[crawl] (${pagesVisited + 1}/${maxPages}) visiting ${item.url}`);
    try {
      browser.open(item.url);
      browser.wait(2500);
      nav.dismissOverlays();
    } catch (error) {
      console.warn(`[crawl] failed to open ${item.url}: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    const page = await identifyCurrentPage();
    pagesVisited++;

    // free edges from live-DOM hrefs
    for (const href of extractSameOriginLinks(browser, origin)) {
      const hrefNorm = normalizePath(href);
      if (!visitedThisRun.has(hrefNorm)) queue.push({ url: href, depth: item.depth + 1 });
    }

    // click probes for SPA nav (buttons/links without hrefs): nav-tagged first,
    // then unknown-tagged as fallback — never destructive/submit/upload
    const navTargets = page.interactives.filter((el) => el.category === 'nav' && !el.probed);
    const unknownTargets = page.interactives.filter((el) => el.category === 'unknown' && !el.probed);
    const probeTargets = [...navTargets, ...unknownTargets].slice(0, probesPerPage);

    for (const el of probeTargets) {
      el.probed = true;
      const beforeUrl = browser.getUrl();
      const role = el.role === 'button' || el.role === 'link' || el.role === 'tab' ? el.role : undefined;
      const clicked = nav.click({ label: el.label, role, optional: true });
      if (!clicked) continue;

      // SPA route changes can lag the click — poll up to 5s
      let afterUrl = browser.getUrl();
      const navDeadline = Date.now() + 5000;
      while (normalizePath(afterUrl) === normalizePath(beforeUrl) && Date.now() < navDeadline) {
        browser.wait(1000);
        afterUrl = browser.getUrl();
      }
      if (normalizePath(afterUrl) !== normalizePath(beforeUrl)) {
        const landed = await identifyCurrentPage();
        pagesVisited++;
        el.targetPageId = landed.id;
        if (!state.sitemap.edges.some((e) => e.from === page.id && e.actionLabel === el.label)) {
          state.sitemap.edges.push({ from: page.id, actionLabel: el.label, to: landed.id });
        }
        // return to the page we were probing
        try {
          browser.open(item.url);
          browser.wait(1500);
          nav.dismissOverlays();
        } catch {
          break;
        }
        if (pagesVisited >= maxPages) break;
      } else {
        // same URL — may have opened a modal; note it and dismiss
        nav.dismissOverlays();
      }
    }

    state.saveSitemap();
  }

  console.log(
    `[crawl] done: ${Object.keys(state.sitemap.pages).length} pages, ${state.sitemap.edges.length} edges`,
  );

  // ---- Deep-walk phase: actually enter create/upload flows ----
  const walkFlowIds: string[] = [];
  const deepCap = opts.deepFlows ?? config.deep.walksPerExplore;
  if (config.deep.enabled && deepCap > 0) {
    const entries: DeepWalkEntry[] = [];
    for (const page of Object.values(state.sitemap.pages)) {
      // flows start from plain pages, or from directly-openable wizard steps
      // (a fork like /upload hosts the branch choices — each branch is its own walk)
      const kind = page.kind ?? 'page';
      if (kind !== 'page' && kind !== 'wizard-step') continue;
      const pattern = page.urlPatterns.find((u) => !u.includes(':id'));
      if (!pattern) continue;
      for (const el of page.interactives) {
        const checkoutish = el.category === 'submit' && /check ?out|place order|start|begin/i.test(el.label);
        if (el.category !== 'create' && el.category !== 'upload' && !checkoutish) continue;
        // wizard states resumed by direct URL need the fresh entry chain that
        // originally discovered them (e.g. projects → "Create …" → fork)
        let via: DeepWalkEntry['via'];
        if (kind === 'wizard-step') {
          const discoveringTrail = Object.values(state.sitemap.walks ?? {}).find(
            (t) => t.steps[0]?.pageId === page.id && t.entry.entryUrl,
          );
          if (discoveringTrail) {
            via = {
              entryUrl: discoveringTrail.entry.entryUrl!,
              actionLabel: discoveringTrail.entry.actionLabel,
            };
          }
        }
        entries.push({ pageId: page.id, interactive: el, entryUrl: `${origin}${pattern}`, via });
      }
    }

    // priority: never-walked entries first, then stale trails; new-this-run beats old
    const walks = state.sitemap.walks ?? {};
    const trailIdFor = (e: DeepWalkEntry) =>
      `walk:${e.pageId}:${e.interactive.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40)}`;
    const isNew = (e: DeepWalkEntry) => !inventoryBefore.interactiveKeys.has(`${e.pageId}::${e.interactive.label}`);
    entries.sort((a, b) => {
      const aScore = (walks[trailIdFor(a)] ? 2 : 0) - (isNew(a) ? 1 : 0);
      const bScore = (walks[trailIdFor(b)] ? 2 : 0) - (isNew(b) ? 1 : 0);
      return aScore - bScore;
    });

    const toWalk = entries.filter((e) => !walks[trailIdFor(e)]).slice(0, deepCap);
    if (toWalk.length === 0) {
      console.log('[crawl] deep: all known entry points already walked (delete a walk via `review` to re-walk)');
    }
    const walkEvidenceDir = path.join(state.dir, 'walks');
    for (const entry of toWalk) {
      try {
        const result = await deepWalk(
          { browser, state, llm, explorer, interact, nav },
          entry,
          { evidenceDir: walkEvidenceDir },
        );
        if (result.flow) walkFlowIds.push(result.flow.id);
      } catch (error) {
        console.warn(`[crawl] deep walk failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // ---- New-path detection ----
  const diff = diffInventory(inventoryBefore, state.sitemap);
  if (diff.added.length > 0) {
    console.log('\n[crawl] NEW since last explore:');
    for (const item of diff.added) console.log(`  + ${item}`);
  }

  // ---- Flow proposal — one LLM call over the summarized map ----
  // A proposal failure must NEVER kill the run: walk-generated flows already exist.
  console.log('[crawl] proposing test flows...');
  const summary =
    summarizeSitemap(state.sitemap) +
    (diff.added.length
      ? `\n\nNEW since the previous exploration (prioritize flows covering these):\n${diff.added.map((a) => `- ${a}`).join('\n')}`
      : '');
  let proposed: Flow[] = [];
  try {
    proposed = await proposeFlows(llm, summary);
  } catch (error) {
    console.warn(
      `[crawl] flow proposal failed (${error instanceof Error ? error.message : error}) — continuing with walk-generated flows only`,
    );
  }
  const existingIds = new Set(state.sitemap.flows.map((f) => f.id));
  const llmFresh = proposed.filter((f) => !existingIds.has(f.id));

  // walk-generated flows still pending approval join the same list, first
  const walkFresh = state.sitemap.flows.filter((f) => walkFlowIds.includes(f.id) && f.status === 'proposed');
  const fresh: Array<{ flow: Flow; walked: boolean; inSitemap: boolean }> = [
    ...walkFresh.map((flow) => ({ flow, walked: true, inSitemap: true })),
    ...llmFresh.map((flow) => ({ flow, walked: false, inSitemap: false })),
  ];

  if (fresh.length === 0) {
    console.log('[crawl] no new flows proposed (existing flows kept)');
    state.saveSitemap();
    return;
  }

  console.log('\nProposed flows:');
  fresh.forEach((f, i) => {
    const tag = f.walked ? ' [deep-walked]' : '';
    console.log(`  ${i + 1}.${tag} ${f.flow.title} — ${f.flow.description} (${f.flow.milestones.length} milestones)`);
  });

  const answer = await interact.ask(
    'Approve flows: "all", comma-separated numbers (e.g. 1,3), or "none"',
    { default: 'all' },
  );

  const keep = new Set<number>();
  if (answer.trim().toLowerCase() === 'all') {
    fresh.forEach((_, i) => keep.add(i));
  } else if (answer.trim().toLowerCase() !== 'none') {
    for (const token of answer.split(',')) {
      const n = Number(token.trim());
      if (n >= 1 && n <= fresh.length) keep.add(n - 1);
    }
  }

  fresh.forEach((f, i) => {
    f.flow.status = keep.has(i) ? 'approved' : 'skipped';
    if (!f.inSitemap) state.sitemap.flows.push(f.flow);
  });
  state.saveSitemap();
  console.log(`[crawl] ${keep.size}/${fresh.length} flows approved`);
}
