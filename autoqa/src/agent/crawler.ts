import path from 'node:path';
import { config } from '../config.js';
import { parseJsonArrayFromEvalStdout, type AgentBrowser } from '../core/agent-browser.js';
import type { Explorer } from '../core/explorer.js';
import type { LlmClient } from '../core/llm/client.js';
import { Nav } from '../core/nav.js';
import { deepWalk, type DeepWalkEntry } from './deep-walker.js';
import { classifyPage, looksLikeSoft404, proposeFlows } from './page-classifier.js';
import { LOGOUT_RE } from './guard.js';
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

/** Guard for the anchor-less click-probe fallback: never auto-click destructive-looking text during discovery. */
const DESTRUCTIVE_TEXT_RE = /\b(delete|remove|destroy|clear all|pay|checkout|buy|purchase|place order|logout|log out|sign out|deactivate|cancel (account|subscription|plan|membership)|revoke|invite|withdraw|transfer)\b/i;

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
    for (const raw of parseJsonArrayFromEvalStdout(stdout)) {
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

/** A page classified as a soft-404/catch-all is never merged into the sitemap. */
function transientErrorPage(url: string): PageNode {
  const now = new Date().toISOString();
  return {
    id: `soft-404:${normalizePath(url)}`,
    title: 'Soft 404 (not persisted)',
    description: '',
    kind: 'error',
    urlPatterns: [normalizePath(url)],
    detection: { snapshotAnyOf: [] },
    requiresAuth: false,
    sensitive: false,
    interactives: [],
    optionGroups: [],
    firstSeenAt: now,
    lastSeenAt: now,
  };
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
  opts: {
    maxPages?: number;
    depth?: number;
    probesPerPage?: number;
    deepFlows?: number;
    /** Re-login hook passed to deep walks (sessions can expire mid-explore) */
    ensureAuth?: () => Promise<void>;
  } = {},
): Promise<void> {
  const maxPages = opts.maxPages ?? config.maxPages;
  const maxDepth = opts.depth ?? config.crawlDepth;
  const probesPerPage = opts.probesPerPage ?? config.probesPerPage;
  const nav = new Nav(browser);
  const origin = state.sitemap.origin;
  const inventoryBefore = takeInventory(state.sitemap);
  // Footer/nav links to a related marketing site (e.g. an app's own vendor
  // homepage) are common and must never be mapped/tested as part of the target
  // app — a flow that wandered off-site was observed proposing a "trial signup"
  // against a completely different domain.
  const isOffOrigin = (url: string): boolean => {
    try {
      return new URL(url).origin !== origin;
    } catch {
      return false;
    }
  };

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
      if (pattern.includes(':id')) continue;
      // Prefer the exact concrete URL that last actually rendered this page over
      // reconstructing from the identity-masked pattern — normalizePath strips
      // trailing slashes for PAGE-IDENTITY purposes, but some routing 404s on a
      // path missing its trailing slash even though it's the "same" page for
      // matching (confirmed live: re-queuing "/add_remove_elements" without its
      // slash on the-internet.herokuapp.com re-visited a 404 every re-explore).
      const seedUrl =
        page.exampleUrl && normalizePath(page.exampleUrl) === pattern ? page.exampleUrl : `${origin}${pattern}`;
      queue.push({ url: seedUrl, depth: 1 });
    }
  }

  const visitedThisRun = new Set<string>();
  const seenPageIds = new Set<string>(); // sitemap pages re-confirmed live this run (for removed-feature detection)
  let pagesVisited = 0;
  let soft404Skipped = 0;
  // maps exact snapshot content -> the first URL that produced it, so an SPA
  // catch-all/fallback served under many distinct paths is caught even when it
  // doesn't literally say "404" (e.g. saucedemo's phantom /company/sauce-labs page)
  const contentSignatures = new Map<string, string>();

  const identifyCurrentPage = async (): Promise<PageNode> => {
    const url = browser.getUrl();
    const snapshot = browser.snapshotInteractive();
    // detached/blank target — never classify emptiness into the sitemap
    if (url.startsWith('about:') || !snapshot.trim()) {
      console.log(`[crawl] page read as blank (${url}) — skipping classification`);
      return transientErrorPage(url || 'about:blank');
    }
    const known = matchPage(state.sitemap, url, snapshot);
    if (known) {
      known.lastSeenAt = new Date().toISOString();
      // matchPage identifies plain pages by URL PATTERN only, never content (by
      // design — one shared chrome landmark must not decide identity). That means
      // a URL that still matches the pattern can nonetheless have rendered an
      // error page (confirmed live: a reconstructed entry URL missing its
      // required trailing slash matched this page's normalized pattern but
      // actually rendered "Not Found"). Blindly trusting `url` here overwrote
      // exampleUrl — the one field every entry-URL fallback in this codebase
      // relies on — with a URL that 404s. Only refresh it when the page doesn't
      // look like an error/soft-404.
      if (!looksLikeSoft404(snapshot)) {
        known.exampleUrl = url;
      }
      seenPageIds.add(known.id);
      const norm = normalizePath(url);
      if (!known.urlPatterns.includes(norm)) known.urlPatterns.push(norm);
      return known;
    }

    if (looksLikeSoft404(snapshot)) {
      soft404Skipped++;
      console.log(`[crawl] ${url} looks like a soft-404 — not adding to sitemap`);
      return transientErrorPage(url);
    }
    const signature = snapshot.trim();
    const priorUrl = signature ? contentSignatures.get(signature) : undefined;
    if (priorUrl && normalizePath(priorUrl) !== normalizePath(url)) {
      soft404Skipped++;
      console.log(
        `[crawl] ${url} renders content identical to ${priorUrl} — likely an SPA catch-all, not adding to sitemap`,
      );
      return transientErrorPage(url);
    }
    if (signature) contentSignatures.set(signature, url);

    console.log(`[crawl] classifying new page at ${url}`);
    const classified = await classifyPage(llm, url, snapshot);
    // Per-item detail pages (a specific room/product — urlPattern like
    // "/reservation/:id") have no stable direct URL; remember the exact concrete
    // URL that actually rendered this page so callers needing one (the deep-walk
    // entry-finder) have a fallback.
    classified.exampleUrl = url;
    const merged = mergePage(state.sitemap, classified);
    seenPageIds.add(merged.id);
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

    // A single problematic page during a probe (confirmed live: a click-probe
    // that lands on a button wired to a native window.alert()/confirm()/prompt()
    // wedges the agent-browser daemon — `get url` and even `dialog accept` hang
    // indefinitely against it) must not be allowed to crash the WHOLE crawl.
    // Before this try/catch, an uncaught timeout here propagated all the way to
    // the CLI's top-level "fatal:" handler and killed the process, discarding
    // every page still queued (and the deep-walk/flow-proposal phases that
    // follow the crawl) — the single least-resilient spot in the whole explore
    // pipeline, since browser.open() at the top of this loop already has its own
    // catch. Recycle the daemon on a timeout-shaped error and move on to the
    // next queue item instead.
    try {
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
          if (isOffOrigin(afterUrl)) {
            console.log(`[crawl] "${el.label}" led off-site (${afterUrl}) — not mapping, returning`);
            try {
              browser.open(item.url);
              browser.wait(1500);
              nav.dismissOverlays();
            } catch {
              break;
            }
            continue;
          }
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
          // Same URL — may have opened a modal/dropdown. Before dismissing it,
          // check whether this click just revealed a Logout/Sign out control
          // that wasn't visible before (a collapsed user-menu/avatar toggle is
          // exactly this shape — confirmed live on beta.koyal.ai: clicking the
          // profile block reveals Profile/Pricing/Transactions/Billing/Logout).
          // Auto-learning this here, as a side effect of exploration this crawl
          // was already doing anyway, means the ask-once question in
          // flow-runner.ts often never needs to fire at all — no dedicated
          // "hunt for logout" task, no extra risk of clicking something
          // unrelated in that same menu (this only ever fires on a click the
          // crawler was already going to make regardless).
          if (state.sitemap.learnedLogoutControl === undefined) {
            const afterClickSnapshot = browser.snapshotInteractive();
            const knownBefore = new Set(page.interactives.map((i) => i.label.toLowerCase()));
            const revealedLogoutLine = afterClickSnapshot
              .split('\n')
              .find((line) => LOGOUT_RE.test(line) && !knownBefore.has(line.trim().toLowerCase()));
            if (revealedLogoutLine) {
              const labelMatch = revealedLogoutLine.match(/"([^"]+)"/);
              const discoveredLabel = labelMatch?.[1] ?? revealedLogoutLine.trim();
              state.sitemap.learnedLogoutControl = discoveredLabel;
              state.sitemap.learnedLogoutMenuOpener = el.label;
              state.saveSitemap();
              console.log(
                `[crawl] auto-discovered logout control while exploring: "${el.label}" > "${discoveredLabel}"`,
              );
            }
          }
          nav.dismissOverlays();
        }
      }

      // SPA fallback: JS-routed clickables the LLM did NOT surface as interactives
      // (e.g. demoqa's <div> cards with no href). Probe by visible text; skip
      // anything destructive-looking. Fixes sites whose whole nav is anchor-less.
      if (pagesVisited < maxPages) {
        const knownLabels = new Set(page.interactives.map((e) => e.label.toLowerCase()));
        const candidates = browser
          .findClickableCandidates()
          .filter((t) => !knownLabels.has(t.toLowerCase()))
          .filter((t) => !DESTRUCTIVE_TEXT_RE.test(t))
          .slice(0, probesPerPage);
        for (const label of candidates) {
          const beforeUrl = browser.getUrl();
          if (!browser.clickByText(label)) continue;
          let afterUrl = browser.getUrl();
          const navDeadline = Date.now() + 5000;
          while (normalizePath(afterUrl) === normalizePath(beforeUrl) && Date.now() < navDeadline) {
            browser.wait(1000);
            afterUrl = browser.getUrl();
          }
          if (normalizePath(afterUrl) !== normalizePath(beforeUrl)) {
            if (isOffOrigin(afterUrl)) {
              console.log(`[crawl] "${label}" led off-site (${afterUrl}) — not mapping, returning`);
              try {
                browser.open(item.url);
                browser.wait(1500);
                nav.dismissOverlays();
              } catch {
                break;
              }
              continue;
            }
            const landed = await identifyCurrentPage();
            pagesVisited++;
            if (!state.sitemap.edges.some((e) => e.from === page.id && e.actionLabel === label)) {
              state.sitemap.edges.push({ from: page.id, actionLabel: label, to: landed.id });
            }
            try {
              browser.open(item.url);
              browser.wait(1500);
              nav.dismissOverlays();
            } catch {
              break;
            }
            if (pagesVisited >= maxPages) break;
          } else {
            // Same auto-discovery as the main click-probe loop above — this
            // fallback is exactly the path that catches a profile/avatar block
            // rendered as a plain anchor-less <div> (confirmed live on
            // beta.koyal.ai: "Shresth" has no accessible button/link role, so
            // it never appears in page.interactives and only this JS-routed
            // fallback ever clicks it).
            if (state.sitemap.learnedLogoutControl === undefined) {
              const afterClickSnapshot = browser.snapshotInteractive();
              const knownBefore = new Set(page.interactives.map((i) => i.label.toLowerCase()));
              const revealedLogoutLine = afterClickSnapshot
                .split('\n')
                .find((line) => LOGOUT_RE.test(line) && !knownBefore.has(line.trim().toLowerCase()));
              if (revealedLogoutLine) {
                const labelMatch = revealedLogoutLine.match(/"([^"]+)"/);
                const discoveredLabel = labelMatch?.[1] ?? revealedLogoutLine.trim();
                state.sitemap.learnedLogoutControl = discoveredLabel;
                state.sitemap.learnedLogoutMenuOpener = label;
                state.saveSitemap();
                console.log(
                  `[crawl] auto-discovered logout control while exploring: "${label}" > "${discoveredLabel}"`,
                );
              }
            }
            nav.dismissOverlays();
          }
        }
      }

      state.saveSitemap();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[crawl] error while processing ${item.url}: ${msg} — skipping to next page`);
      if (/timed out|consecutiveTimeouts/i.test(msg) || browser.consecutiveTimeouts >= 2) {
        // recycle() can now legitimately no-op (return false) rather than always
        // attempting some kill — a wedged daemon it couldn't recover is still
        // wedged, so every remaining queued page would otherwise silently time
        // out one by one with no signal beyond individually-logged skips.
        // Abort the crawl outright instead of burning through the whole queue.
        if (!browser.recycle()) {
          console.warn('[crawl] daemon recycle failed — aborting crawl early rather than timing out on every remaining page');
          break;
        }
      }
    }
  }

  console.log(
    `[crawl] done: ${Object.keys(state.sitemap.pages).length} pages, ${state.sitemap.edges.length} edges`,
  );
  if (soft404Skipped > 0) {
    console.log(`[crawl] skipped ${soft404Skipped} suspected soft-404/catch-all page(s) (not added to sitemap)`);
  }

  // ---- Refactor change-detection: known pages we RE-VISITED (their direct URL was
  // queued) but could no longer match are likely removed/changed by a redesign.
  // Only judge pages that were in the sitemap before this run AND had a direct URL
  // (so we actually re-opened them) — never new-this-run pages.
  const removedOrChanged: string[] = [];
  for (const page of Object.values(state.sitemap.pages)) {
    if (!inventoryBefore.pageIds.has(page.id)) continue; // new this run
    if (seenPageIds.has(page.id)) continue; // re-confirmed live
    const directPattern = page.urlPatterns.find((u) => !u.includes(':id'));
    if (!directPattern) continue; // couldn't have re-visited it deterministically
    if (visitedThisRun.has(normalizePath(`${origin}${directPattern}`))) {
      removedOrChanged.push(`${page.id} (${directPattern})`);
    }
  }
  if (removedOrChanged.length > 0) {
    console.log('\n[crawl] ⚠ POSSIBLY REMOVED/CHANGED since last explore (re-visited but no longer matched):');
    for (const p of removedOrChanged) console.log(`  - ${p}`);
    const staleFlows = state.sitemap.flows.filter(
      (f) =>
        (f.status === 'exploratory' || f.status === 'deterministic' || f.status === 'approved') &&
        (removedOrChanged.some((r) => r.startsWith(`${f.entry.pageId} `)) ||
          f.milestones.some((m) => m.guardPhases?.some((g) => removedOrChanged.some((r) => r.startsWith(`${g} `))))),
    );
    for (const f of staleFlows) {
      console.log(`  ↳ flow "${f.id}" references a removed/changed page — needs re-verification`);
    }
  }

  // ---- Deep-walk phase: actually enter create/upload flows ----
  const walkFlowIds: string[] = [];
  // Exhaustive means every discovered creation entry, unless the caller gave an
  // explicit --deep-flows budget. The old default cap of 3 silently left Koyal's
  // character/assets/outfit/audio entries untouched while claiming the crawl
  // was complete.
  const deepCap =
    opts.deepFlows !== undefined
      ? opts.deepFlows
      : config.probes.exhaustive
        ? Number.POSITIVE_INFINITY
        : config.deep.walksPerExplore;
  if (config.deep.enabled && deepCap > 0) {
    const entries: DeepWalkEntry[] = [];
    for (const page of Object.values(state.sitemap.pages)) {
      // flows start from plain pages, or from directly-openable wizard steps
      // (a fork like /upload hosts the branch choices — each branch is its own walk)
      const kind = page.kind ?? 'page';
      if (kind !== 'page' && kind !== 'wizard-step') continue;
      const pattern = page.urlPatterns.find((u) => !u.includes(':id'));
      // Per-item detail pages (a specific room/product — every urlPattern has
      // ":id") have no stable pattern to build a direct URL from — fall back to
      // the exact concrete URL the crawler actually visited (`exampleUrl`).
      // Without this, any create/checkout-ish action living one hop off a listing
      // page (room/product/listing detail — a very common site shape) could never
      // become a deep-walk entry, regardless of category/keyword matching (confirmed
      // live: automationintesting.online's room-reservation page, urlPattern
      // "/reservation/:id", was silently skipped here even after broadening the
      // checkout-ish keywords below).
      // `pattern` comes from normalizePath, which deliberately masks ids AND strips
      // trailing slashes for PAGE-IDENTITY purposes — but some routing (e.g. this
      // Sinatra/Heroku app) 404s on a path missing its trailing slash even though
      // it's the "same" page for identity-matching (confirmed live: /add_remove_elements
      // without the slash returns "Not Found", /add_remove_elements/ returns 200;
      // urlPatterns stored "/add_remove_elements", exampleUrl correctly kept the
      // real "/add_remove_elements/" — reconstructing from `pattern` here silently
      // 404'd the whole deep-walk entry). Prefer the exact URL that actually
      // rendered the page; only reconstruct from the masked pattern when no
      // concrete URL was ever recorded.
      const entryUrl = page.exampleUrl ?? (pattern ? `${origin}${pattern}` : undefined);
      if (!entryUrl) continue;
      for (const el of page.interactives) {
        // The LLM classifies a form-submitting CTA as category 'submit' even when it
        // clearly CREATES something (e.g. "Reserve Now" on a hotel-booking site — a
        // real reservation, not just a form post) — 'create' vs 'submit' is a judgment
        // call the classifier makes inconsistently. This keyword fallback was written
        // checkout-only-tuned (only "checkout|place order|start|begin"), so an entire
        // app archetype — reservations/bookings/appointments/scheduling, not just
        // e-commerce — never produced a single deep-walk entry regardless of how deep
        // its real creation flow goes. Broadened to the equally-common creation verbs
        // for that archetype (confirmed live: automationintesting.online's
        // "Reserve Now" is category:'submit' and was the ONLY candidate on the whole
        // site, so `walks` stayed permanently empty until this matched it).
        const checkoutish =
          el.category === 'submit' &&
          // Wrap the whole alternation in one \b...\b pair — a per-alternative \b
          // (as 'book(ing)?' alone had) doesn't extend to its siblings, so bare
          // words like "reserve"/"schedule"/"enroll" matched as substrings inside
          // unrelated words (e.g. "Preserve My Settings" contains "reserve").
          /\b(check ?out|place order|start|begin|reserve|book(ing)?|schedule|enroll)\b/i.test(el.label);
        // Classification is advisory; a mislabeled but explicit creation CTA
        // must not disappear from deep coverage. This catches concrete surfaces
        // such as NEW CHARACTER, ADD ASSET, CREATE OUTFIT, Start with Audio,
        // Generate/Regenerate and Create Video even if the page classifier called
        // them navigation/unknown.
        const explicitCreationLabel =
          /\b(new (?:project|character|asset|outfit|item)|create(?: video| character| asset| outfit| project)?|add (?:asset|character|outfit|item)|start with (?:script|audio)|generate|regenerate|render|upload)\b/i.test(
            el.label,
          ) && !/\bdelete|remove|cancel\b/i.test(el.label);
        if (el.category !== 'create' && el.category !== 'upload' && !checkoutish && !explicitCreationLabel) continue;
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
        entries.push({ pageId: page.id, interactive: el, entryUrl, via });
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

    // Only terminal walks are complete. no-progress/step-cap/error/budget walks
    // stay queued and are retried on every explore; previously only `aborted`
    // retried, so one weak button-discovery attempt permanently suppressed that
    // creation surface from all future crawls.
    const toWalk = entries
      .filter((e) => !walks[trailIdFor(e)] || walks[trailIdFor(e)].outcome !== 'terminal')
      .slice(0, deepCap);
    if (toWalk.length === 0) {
      console.log('[crawl] deep: all known entry points already walked (delete a walk via `review` to re-walk)');
    }
    const walkEvidenceDir = path.join(state.dir, 'walks');
    // Shared across every entry walked this crawl — lets a later walk (or a later
    // retry within one walk) know which mode/tab options an earlier one already
    // selected on a given page, instead of each walk starting with zero memory and
    // converging on the same 1-2 options every time. See deep-walker.ts's
    // DeepWalkerDeps.triedChoicesByPage doc comment for the live repro this fixes.
    const triedChoicesByPage = new Map<string, Set<string>>();
    for (const entry of toWalk) {
      try {
        const result = await deepWalk(
          { browser, state, llm, explorer, interact, nav, ensureAuth: opts.ensureAuth, triedChoicesByPage },
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
  // proposeFlows only sees a flattened TEXT summary of the sitemap, not the real
  // page objects, so its `entryPageId` is a free-text guess with no guarantee it
  // actually matches the page that `entryUrl` resolves to. Live-reproduced on
  // testpages.eviltester.com: "7 character validation check" got entryUrl
  // "/apps/7-char-val" (correct, specific) but entryPageId "apps-index" (the
  // parent index, not the actual "7-char-val" page) — navigateToEntry's
  // stale-pinned-URL check (`currentPageId(deps) === flow.entry.pageId`) then
  // legitimately found a mismatch after opening the correct URL, treated it as
  // stale, and fell back to navigating to whatever "apps-index" resolves to —
  // silently steering milestone 1 away from the real target page entirely (the
  // explorer ended up on a wrong, generically-similar page and never found the
  // real "Check Input" button downstream). Correct entryPageId deterministically
  // against the URL it's paired with, using the same exact urlPattern lookup
  // matchPage's PASS 1 uses for plain pages, whenever they disagree.
  for (const flow of proposed) {
    if (!flow.entry.url) continue;
    const normalized = normalizePath(
      flow.entry.url.startsWith('http') ? flow.entry.url : `${state.sitemap.origin}${flow.entry.url}`,
    );
    const owner = Object.values(state.sitemap.pages).find((p) => p.urlPatterns.includes(normalized));
    if (owner && owner.id !== flow.entry.pageId) {
      console.warn(
        `[flow] "${flow.id}" entryPageId "${flow.entry.pageId}" doesn't match entryUrl "${flow.entry.url}" — correcting to "${owner.id}"`,
      );
      flow.entry.pageId = owner.id;
    }
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
    if (keep.has(i)) {
      const allRecipes =
        f.flow.milestones.length > 0 &&
        f.flow.milestones.every((milestone) => Boolean(state.recipes[`flow:${f.flow.id}:${milestone.id}`]));
      f.flow.status = 'exploratory';
      f.flow.qualification = {
        // A terminal deep walk has already learned the entire action trail, but
        // its recipes still need one real replay-validation run. LLM-proposed or
        // incomplete flows start in learning and deliberately bypass recipes.
        phase: f.walked && allRecipes ? 'replay-validation' : 'learning',
      };
    } else {
      f.flow.status = 'skipped';
      f.flow.qualification = undefined;
    }
    if (!f.inSitemap) state.sitemap.flows.push(f.flow);
  });
  state.saveSitemap();
  console.log(`[crawl] ${keep.size}/${fresh.length} flows selected as exploratory (promotion requires complete replay proof)`);
}
