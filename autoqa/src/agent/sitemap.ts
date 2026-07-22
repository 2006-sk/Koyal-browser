import type { Verdict } from '../core/types.js';

/**
 * page = normal URL-addressable screen; wizard-step = one screen of a multi-step
 * creation flow (often shares its URL with siblings — detection leans on snapshot
 * landmarks); modal = dialog overlaying a page; processing = async server work in
 * progress; terminal = final artifact/download state; error = error state.
 */
export type PageKind = 'page' | 'wizard-step' | 'modal' | 'processing' | 'terminal' | 'error';

/** A mutually-exclusive choice group on a page (discovered once, probed deterministically) */
export interface OptionGroup {
  id: string;
  memberLabels: string[];
  /** member to settle on after probing (default: first) */
  canonical: string;
  /** primary groups gate advancing — probe failure is a fail; secondary → needs-review */
  primary: boolean;
  discoveredAt: string;
}

export type InteractiveCategory =
  | 'nav'
  | 'create'
  | 'edit'
  | 'submit'
  | 'upload'
  | 'destructive'
  | 'unknown';

export interface PageInteractive {
  label: string;
  role: string;
  category: InteractiveCategory;
  targetPageId?: string;
  probed?: boolean;
}

export interface PageNode {
  /** LLM-chosen slug, e.g. "login", "projects-list" */
  id: string;
  title: string;
  description: string;
  /** Normalized paths with ids masked, e.g. "/project/:id" */
  urlPatterns: string[];
  /** Learned detection recipe — how to recognize this page later without an LLM */
  detection: { urlIncludes?: string; snapshotAnyOf: string[] };
  requiresAuth: boolean;
  /** True for pages where any submit should be guard-confirmed (payment, account settings) */
  sensitive?: boolean;
  /** absent = 'page' (backward compatible with v1 sitemaps) */
  kind?: PageKind;
  optionGroups?: OptionGroup[];
  interactives: PageInteractive[];
  screenshot?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * A concrete, directly-openable URL that actually rendered this page (the exact
   * URL the crawler visited when it was classified). Per-item detail pages (a
   * specific room/product/listing — e.g. "/reservation/:id") have NO stable,
   * parameter-free urlPattern, so callers that need one direct URL to open this
   * page (the deep-walker's entry-finder) fall back to this when every
   * urlPattern includes ":id". Refreshed on every re-visit so it doesn't go stale.
   */
  exampleUrl?: string;
}

export interface WalkAction {
  type: 'click' | 'fill' | 'select' | 'press' | 'upload' | 'wait-processing';
  label?: string;
  role?: string;
  selector?: string;
  assetPath?: string;
  value?: string;
}

export interface WalkStep {
  index: number;
  pageId: string;
  kind: PageKind;
  /** primary action (display) — `actions` holds the full ordered sequence */
  action?: WalkAction;
  actions?: WalkAction[];
  /** literal on-page text, verified against a live snapshot before storing */
  landmark?: string;
  processingMs?: number;
  screenshot?: string;
}

export interface WalkTrail {
  id: string;
  entry: { pageId: string; actionLabel: string; entryUrl?: string };
  startedAt: string;
  finishedAt: string;
  outcome: 'terminal' | 'error' | 'no-progress' | 'step-cap' | 'budget' | 'aborted';
  steps: WalkStep[];
  generatedFlowId?: string;
  terminalEvidence?: {
    source: 'page-kind' | 'vision';
    pageId: string;
    screenshot?: string;
    summary?: string;
  };
  /**
   * Runtime problems observed while walking that did not themselves prevent
   * progress. They remain reportable evidence; the walk only becomes `error`
   * when the UI is actually blocked, visibly enters an error state, or cannot
   * complete after bounded recovery/waiting.
   */
  runtimeSignals?: Array<{
    at: string;
    context: string;
    kind: 'page-error' | 'console-error' | 'network-5xx' | 'processing-timeout';
    detail: string;
    screenshot?: string;
  }>;
}

export interface Edge {
  from: string;
  actionLabel: string;
  to: string;
}

export interface FlowMilestone {
  id: string;
  /** Natural-language goal handed to the Explorer */
  goal: string;
  /** Page ids that should be current for/after this milestone */
  guardPhases?: string[];
  kind: 'navigate' | 'edit' | 'create' | 'upload' | 'verify';
  successHint?: string;
  /** Verification wait override (e.g. observed processing time × 1.5) */
  maxWaitMs?: number;
  /**
   * Human-provided value to type on this edit milestone (a real name/title/
   * description for content being created), asked ONCE the first time the
   * milestone runs and reused forever — replaces the auto-generated random
   * marker so created items get meaningful, valid names instead of invented
   * junk that the site may reject. Empty/absent = fall back to the auto marker.
   */
  seedValue?: string;
}

export interface Flow {
  id: string;
  title: string;
  description: string;
  /**
   * proposed: waiting for human selection
   * exploratory: selected, but not yet proven replayable end-to-end
   * deterministic: every milestone recipe replayed successfully and any
   *   creation flow reached a verified terminal/persistent artifact
   * skipped: intentionally disabled
   * approved: legacy on-disk value, migrated to exploratory by SiteState
   */
  status: 'proposed' | 'exploratory' | 'deterministic' | 'skipped' | 'approved';
  qualification?: {
    /** learning uses the LLM for every milestone; replay-validation tests the compiled recipes. */
    phase: 'learning' | 'replay-validation';
    learnedAt?: string;
    terminalArtifactVerifiedAt?: string;
    replayValidatedAt?: string;
  };
  entry: {
    pageId: string;
    url?: string;
    /** Learned once: label of a "start fresh" control to click when entry resumes stale state (e.g. a draft) instead of landing on milestone 1's guard phase. */
    freshEntryHint?: string;
  };
  milestones: FlowMilestone[];
  lastResult?: { runId: string; verdict: Verdict };
}

export interface SiteMap {
  origin: string;
  updatedAt: string;
  pages: Record<string, PageNode>;
  edges: Edge[];
  flows: Flow[];
  /** Deep-walk trails, keyed by trail id */
  walks?: Record<string, WalkTrail>;
  /** Free-text hints appended to the Explorer system prompt */
  siteHints: string[];
  /** Learned once: label of a site-wide "Logout"/"Sign out" control, or 'none' if there isn't one — reused by every flow that needs to start from an unauthenticated page. */
  learnedLogoutControl?: string;
  /**
   * Some sites (confirmed live on beta.koyal.ai and previously on OrangeHRM)
   * hide the real Logout control inside a collapsed user-menu/avatar dropdown —
   * a single click on the Logout label itself does nothing until that menu has
   * been opened first. When set, click this control BEFORE learnedLogoutControl.
   * Left unset for sites where Logout is directly clickable with no menu.
   */
  learnedLogoutMenuOpener?: string;
  /**
   * Learned once, site-wide: how to START A FRESH creation (bypassing a
   * resumed/stale draft that some create-entry points reopen — e.g. Koyal's
   * "Create Your Next Video" reopens the last draft). Either a URL (starts with
   * http:// or /) → navigate there, or the exact label of a "start fresh/new"
   * control → click it. 'none' = no fresh-start action needed/available on this
   * site (stop asking). Agnostic — the site-specific value is runtime data,
   * learned via the human once and reused by every flow (mirrors
   * learnedLogoutControl). Replaces the old per-flow Flow.entry.freshEntryHint.
   */
  learnedFreshStart?: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_ID_RE = /\b[0-9a-f]{16,}\b/gi;
const NUM_ID_RE = /\/\d+(?=\/|$)/g;

/** Mask an id-looking query VALUE the same way path segments are masked. */
function maskQueryValue(value: string): string {
  const masked = value.replace(UUID_RE, ':id').replace(HEX_ID_RE, ':id');
  return /^\d+$/.test(masked) ? ':id' : masked;
}

/** Mask volatile id segments so /project/123 and /project/456 are the same page. */
export function normalizePath(url: string): string {
  let pathname: string;
  let hash = '';
  let search = '';
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname;
    hash = parsed.hash;
    search = parsed.search;
  } catch {
    pathname = url;
  }
  const base =
    pathname
      .replace(UUID_RE, ':id')
      .replace(HEX_ID_RE, ':id')
      .replace(NUM_ID_RE, '/:id')
      .replace(/\/+$/, '') || '/';
  // Hash-ROUTED SPAs (AngularJS ngRoute, hash-mode Vue/React routers, ...) encode
  // the actual client-side route in the fragment, conventionally "#/some/path" —
  // dropping it collapsed every distinct app state onto one identity (every route
  // in an app like an AngularJS ngRoute banking demo shares one bare pathname).
  // Plain in-page anchors ("#section2") don't follow the "#/" convention, so they
  // stay excluded — folding them in would spuriously multiply otherwise-identical
  // pages on ordinary anchor-link sites.
  if (/^#\//.test(hash)) {
    // Apply the SAME id-masking regexes used for `base` — a hash route like
    // "#/account/1013529310" needs "/account/:id" just as much as a pathname
    // does, or every distinct account/item id spawns its own page identity,
    // defeating this function's own contract for the exact SPA archetype
    // (id-in-hash routing) this branch exists to support.
    const maskedRoute = hash
      .replace(UUID_RE, ':id')
      .replace(HEX_ID_RE, ':id')
      .replace(NUM_ID_RE, '/:id')
      .replace(/\/+$/, '');
    // Trimming trailing slashes off the bare root hash "#/" leaves "#" (the
    // leading '#' isn't itself a slash), so the naive `|| '#/'` fallback below
    // was unreachable dead code — canonicalize the root explicitly instead.
    const route = maskedRoute === '#' ? '#/' : maskedRoute;
    return `${base}${route}`;
  }
  // Legacy front-controller MPAs (OpenCart, phpBB, MediaWiki, ...) route through a
  // single bare pathname (e.g. "/index.php") and encode the ACTUAL page identity in
  // the query string ("?route=product/category&path=25"). Dropping the query
  // entirely collapsed every distinct route on such a site onto one pathname —
  // observed live: home ("?route=common/home"), a category listing
  // ("?route=product/category&path=25"), and checkout ("?route=checkout/cart") all
  // normalized to "/index.php" and merged into a single sitemap page. Fold the query
  // string into the identity, masking id-looking VALUES the same way path segments
  // already are (so "path=25" vs "path=57" still collapse like /project/123 vs
  // /project/456 do) and sorting keys for determinism.
  if (search) {
    const params = new URLSearchParams(search);
    const maskedEntries = [...params.entries()].map(([k, v]) => `${k}=${maskQueryValue(v)}`).sort();
    if (maskedEntries.length) return `${base}?${maskedEntries.join('&')}`;
  }
  return base;
}

function isPlainPage(page: PageNode): boolean {
  return !page.kind || page.kind === 'page';
}

/**
 * Recognize a known page from URL + snapshot using learned detection recipes (no LLM).
 * Wizard states often share a URL with their siblings, so non-'page' kinds are matched
 * FIRST, by snapshot landmarks, before any URL-pattern matching.
 */
export function matchPage(sitemap: SiteMap, url: string, snapshot: string): PageNode | null {
  const normalized = normalizePath(url);
  const lowerUrl = url.toLowerCase();
  const lowerSnap = snapshot.toLowerCase();
  const routeAgrees = (page: PageNode): boolean =>
    page.urlPatterns.length > 0
      ? page.urlPatterns.includes(normalized)
      : Boolean(
          page.detection.urlIncludes &&
          lowerUrl.includes(page.detection.urlIncludes.toLowerCase()),
        );

  // PASS 0: landmark-first match for wizard/modal/processing/terminal/error states
  if (lowerSnap) {
    let best: PageNode | null = null;
    let bestScore = 0;
    for (const page of Object.values(sitemap.pages)) {
      if (isPlainPage(page)) continue;
      const hits = page.detection.snapshotAnyOf.filter((t) => lowerSnap.includes(t.toLowerCase())).length;
      if (hits === 0) continue;
      const urlAgrees = routeAgrees(page);
      // Stateful landmarks are often persistent wizard sidebars ("Upload",
      // "Theme", "Final video") visible on every step. Never let those labels
      // identify the state on a completely different URL: this was collapsing
      // Koyal's /scriptEdit, /selectTheme, /editscene and /finalvideo back into
      // the old /upload node, so the deep crawler literally could not map the
      // rendering/download states even after reaching them.
      if (!urlAgrees) continue;
      const urlBonus = 0.5;
      const score = hits + urlBonus;
      if (score > bestScore) {
        best = page;
        bestScore = score;
      }
    }
    if (best) return best;
  }

  // PASS 1: exact normalized-path match — plain pages only (wizard states share URLs)
  for (const page of Object.values(sitemap.pages)) {
    if (isPlainPage(page) && page.urlPatterns.includes(normalized)) return page;
  }

  // A stateful route with exactly one learned owner is unambiguous even when
  // its distinctive action disappeared after completion (e.g. CREATE COMMANDER
  // is gone once the character exists). Without this, a broad LLM fragment such
  // as `/characters` on another theme can steal `/space/characters` at runtime.
  const exactStateful = Object.values(sitemap.pages).filter(
    (page) => !isPlainPage(page) && page.urlPatterns.includes(normalized),
  );
  if (exactStateful.length === 1) return exactStateful[0];

  // PASS 2: detection recipes (URL fragment and/or snapshot landmarks).
  // Plain pages are URL-addressable by definition — they may only match when the
  // URL agrees. Snapshot-only matching is reserved for stateful kinds; otherwise
  // one shared chrome landmark (site header) absorbs every page on the site.
  for (const page of Object.values(sitemap.pages)) {
    const det = page.detection;
    const urlOk = routeAgrees(page);
    const snapOk = det.snapshotAnyOf.some((text) => lowerSnap.includes(text.toLowerCase()));
    if (det.urlIncludes && urlOk && (det.snapshotAnyOf.length === 0 || snapOk)) return page;
    if (
      !isPlainPage(page) &&
      !det.urlIncludes &&
      det.snapshotAnyOf.length > 0 &&
      snapOk &&
      (page.urlPatterns.length === 0 || page.urlPatterns.includes(normalized))
    ) {
      return page;
    }
  }

  return null;
}

/**
 * Merge a newly classified page into the sitemap. Dedupe by id, by landmark overlap
 * (same kind), or — for plain pages only — by shared normalized path. Distinct wizard
 * states sharing a URL must never merge into each other.
 */
export function mergePage(sitemap: SiteMap, incoming: PageNode): PageNode {
  const landmarksLower = incoming.detection.snapshotAnyOf.map((t) => t.toLowerCase());
  const sameRoute = (page: PageNode): boolean =>
    page.urlPatterns.length === 0 ||
    incoming.urlPatterns.length === 0 ||
    page.urlPatterns.some((u) => incoming.urlPatterns.includes(u));
  const idMatch = sitemap.pages[incoming.id];
  // Plain pages are identified by URL only: a single shared chrome landmark (a
  // header/nav item) must NOT collapse two distinct plain pages into one. Landmark-
  // overlap merging is reserved for stateful kinds (wizard/modal/…) that legitimately
  // share a URL across sibling states.
  const existing =
    (idMatch && sameRoute(idMatch) ? idMatch : undefined) ??
    (isPlainPage(incoming)
      ? Object.values(sitemap.pages).find(
          (p) => isPlainPage(p) && p.urlPatterns.some((u) => incoming.urlPatterns.includes(u)),
        )
      : Object.values(sitemap.pages).find(
          (p) =>
            (p.kind ?? 'page') === (incoming.kind ?? 'page') &&
            !isPlainPage(p) &&
            // Landmark overlap only means "same state" when the route also
            // agrees. Separate themed wizards commonly share generic chrome
            // (Characters, Continue, Next character); merging /space/characters
            // with /titanic/characters pooled their theme-specific controls and
            // caused impossible cross-theme flows to be proposed.
            p.urlPatterns.some((u) => incoming.urlPatterns.includes(u)) &&
            p.detection.snapshotAnyOf.some((t) => landmarksLower.includes(t.toLowerCase())),
        ));

  if (!existing) {
    // LLM page ids are descriptive guesses, not identities. Different routes
    // frequently receive the same generic id ("wizard-characters",
    // "checkout", "details"). Never overwrite/merge solely because that text
    // key collided; derive a stable route-qualified key for the later page.
    if (sitemap.pages[incoming.id]) {
      const routeSlug = (incoming.urlPatterns[0] ?? 'state')
        .replace(/:id/g, 'item')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
      const base = `${incoming.id}-${routeSlug || 'state'}`;
      let candidate = base;
      let suffix = 2;
      while (sitemap.pages[candidate]) candidate = `${base}-${suffix++}`;
      console.warn(
        `[sitemap] page id "${incoming.id}" was reused for a different route; storing it as "${candidate}"`,
      );
      incoming.id = candidate;
    }
    sitemap.pages[incoming.id] = incoming;
    return incoming;
  }

  existing.lastSeenAt = incoming.lastSeenAt;
  if (incoming.kind && !existing.kind) existing.kind = incoming.kind;
  if (incoming.exampleUrl) existing.exampleUrl = incoming.exampleUrl;
  for (const pattern of incoming.urlPatterns) {
    if (!existing.urlPatterns.includes(pattern)) existing.urlPatterns.push(pattern);
  }
  for (const landmark of incoming.detection.snapshotAnyOf) {
    if (!existing.detection.snapshotAnyOf.some((t) => t.toLowerCase() === landmark.toLowerCase())) {
      existing.detection.snapshotAnyOf.push(landmark);
    }
  }
  for (const el of incoming.interactives) {
    if (!existing.interactives.some((e) => e.label === el.label && e.role === el.role)) {
      existing.interactives.push(el);
    }
  }
  for (const group of incoming.optionGroups ?? []) {
    existing.optionGroups = existing.optionGroups ?? [];
    if (!existing.optionGroups.some((g) => g.id === group.id)) {
      existing.optionGroups.push(group);
    }
  }
  if (incoming.screenshot) existing.screenshot = incoming.screenshot;
  return existing;
}

/** Compact text summary of the sitemap for the flow-proposal prompt. */
export function summarizeSitemap(sitemap: SiteMap): string {
  const lines: string[] = [`Origin: ${sitemap.origin}`, '', 'Pages:'];
  for (const page of Object.values(sitemap.pages)) {
    const actions = page.interactives
      .slice(0, 12)
      .map((i) => `${i.label}(${i.category})`)
      .join(', ');
    lines.push(`- ${page.id} [${page.urlPatterns.join(', ')}] — ${page.description}. Interactives: ${actions}`);
  }
  lines.push('', 'Navigation edges:');
  for (const edge of sitemap.edges.slice(0, 60)) {
    lines.push(`- ${edge.from} --"${edge.actionLabel}"--> ${edge.to}`);
  }
  return lines.join('\n');
}
