import { createHash } from 'node:crypto';
import { parseJsonFromLlm, type LlmClient } from '../core/llm/client.js';
import {
  summarizeSitemap,
  type Flow,
  type FlowMilestone,
  type PageNode,
  type SiteMap,
} from '../agent/sitemap.js';
import {
  compileManualTaskGraph,
  lowerManualTaskGraph,
  manualEditVerificationGuidance,
  splitCrossPageAcceptanceItems,
} from '../agent/manual-task-engine.js';
import type { SiteState } from '../agent/site-state.js';
import { testCommand } from './test.js';
import { bootstrap, teardown, type Session } from './shared.js';

export interface ManualPlan {
  mode: 'existing-flow' | 'focused-page';
  existingFlowId?: string;
  targetPageId?: string;
  title: string;
  goal: string;
  kind: FlowMilestone['kind'];
  successHint?: string;
}

// Bump only when the execution contract changes in a way that makes previously
// learned manual recipes unsafe to reuse.
const MANUAL_FLOW_CONTRACT_VERSION = '28';
export type ManualEngine = 'legacy' | 'task-graph';

function normalizedWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

const MANUAL_MATCH_STOP_WORDS = new Set([
  'add',
  'and',
  'change',
  'changes',
  'check',
  'click',
  'create',
  'edit',
  'first',
  'inspect',
  'for',
  'from',
  'have',
  'here',
  'into',
  'look',
  'make',
  'making',
  'new',
  'only',
  'open',
  'part',
  'please',
  'search',
  'select',
  'test',
  'then',
  'them',
  'the',
  'that',
  'this',
  'thing',
  'things',
  'through',
  'try',
  'update',
  'use',
  'verify',
  'view',
  'visible',
  'with',
  'without',
  'your',
]);

function manualKeywords(request: string): string[] {
  return normalizedWords(request).filter((word) => !MANUAL_MATCH_STOP_WORDS.has(word));
}

function requestForTargetMatching(request: string): string {
  return request.replace(
    /\bsearch(?:\s+(?:characters?|people|items?|assets?|locations?|outfits?))?(?:\s+for)?\s+(?:"[^"]+"|'[^']+'|[a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,3}?)(?=\s+(?:and|then|before|after|create|add|edit|change|make|generate|verify)\b|[,;.]|$)/gi,
    ' ',
  );
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[right.length];
}

function tokenMatchStrength(needle: string, haystackTokens: Set<string>): number {
  if (haystackTokens.has(needle)) return 1;
  if (needle.length < 4) return 0;
  const isAdjacentTransposition = (token: string): boolean => {
    if (token.length !== needle.length) return false;
    const mismatches = [...needle].flatMap((char, index) =>
      char === token[index] ? [] : [index],
    );
    return (
      mismatches.length === 2 &&
      mismatches[1] === mismatches[0] + 1 &&
      needle[mismatches[0]] === token[mismatches[1]] &&
      needle[mismatches[1]] === token[mismatches[0]]
    );
  };
  if ([...haystackTokens].some(isAdjacentTransposition)) return 0.8;
  // One ordinary insertion/deletion/substitution catches common prompt typos
  // without turning unrelated long words into matches (for example "profile"
  // and "promise"). Adjacent transpositions are handled separately above.
  const allowance = 1;
  return [...haystackTokens].some(
    (token) =>
      Math.abs(token.length - needle.length) <= allowance &&
      editDistance(needle, token) <= allowance,
  )
    ? 0.7
    : 0;
}

function isReadOnlyManualRequest(request: string): boolean {
  const readIntent = /\b(verify|check|inspect|view|confirm|review|look|show)\b/i.test(request);
  const onlyRead = /\b(only|just)\s+(verify|check|inspect|view|confirm|review|look|show)\b/i.test(
    request,
  );
  const deniesMutation =
    /\b(?:do\s+not|don't|never|without)\s+(?:\w+\s+){0,2}(?:creat(?:e|ing)|add(?:ing)?|edit(?:ing)?|chang(?:e|ing)|updat(?:e|ing)|regenerat(?:e|ing)|generat(?:e|ing)|sav(?:e|ing)|submit(?:ting)?|upload(?:ing)?|mak(?:e|ing))\b/i.test(
      request,
    );
  return readIntent && (onlyRead || deniesMutation);
}

function requestsEndToEndJourney(request: string): boolean {
  return /\b(?:end[\s-]*to[\s-]*end|all\s+the\s+way|final\s+(?:artifact|movie|video)|render(?:ed|ing)?\s+(?:movie|video)|complete\s+(?:the\s+)?(?:flow|journey|path|wizard))\b/i.test(
    request,
  );
}

function flowHasRequestedCapabilities(flow: Flow, request: string): boolean {
  const haystack = flowSearchText(flow);
  const required: RegExp[] = [];
  if (/\b(?:upload|file\s+I\s+provide|provided\s+(?:image|file))\b/i.test(request)) {
    required.push(/\bupload\b/i);
  }
  if (/\b(?:delete|deletions?|remove)\b/i.test(request)) {
    const identity = `${flow.id} ${flow.title} ${flow.description}`;
    const hasRealDeleteStep =
      /\b(?:delete|remov(?:e|al))\b/i.test(identity) ||
      flow.milestones.some((milestone) =>
        /\b(?:click|choose|select|press)\s+(?:"[^"]*(?:delete|remove)|(?:delete|remove)\b)|\b(?:delete|remove)\s+(?:an?|the|exactly|\d)/i.test(
          milestone.goal,
        ),
      );
    if (!hasRealDeleteStep) return false;
  }
  if (/\b(?:render(?:ed|ing)?|final\s+(?:movie|video))\b/i.test(request)) {
    required.push(/\b(?:render(?:ed|ing)?|final\s+(?:movie|video))\b/i);
  }
  return required.every((pattern) => pattern.test(haystack));
}

function pageSearchText(page: PageNode): string {
  return [
    page.id,
    page.title,
    page.description,
    ...page.urlPatterns,
    ...page.interactives.flatMap((item) => [item.label, item.category]),
  ]
    .join(' ')
    .toLowerCase();
}

function flowSearchText(flow: Flow): string {
  return [
    flow.id,
    flow.title,
    flow.description,
    ...flow.milestones.flatMap((milestone) => [
      milestone.goal,
      milestone.successHint ?? '',
      milestone.kind,
    ]),
  ]
    .join(' ')
    .toLowerCase();
}

type RequestedMediaSource = 'script' | 'audio';

function requestedMediaSource(request: string): RequestedMediaSource | undefined {
  const script = /\b(?:script(?:-to-|\s+to\s+|[- ]based\b|\s+(?:path|flow|file|upload))|upload\s+(?:the\s+)?script)\b/i.test(
    request,
  );
  const audio = /\b(?:audio(?:-to-|\s+to\s+|[- ]based\b|\s+(?:path|flow|file|upload))|upload\s+(?:the\s+)?audio)\b/i.test(
    request,
  );
  return script === audio ? undefined : script ? 'script' : 'audio';
}

function flowMatchesRequestedMediaSource(flow: Flow, source: RequestedMediaSource): boolean {
  // Source identity belongs to the flow title/id/description and its opening
  // upload checkpoints. Do not search the whole journey: an Audio flow may
  // legitimately contain a later "edit script line" acceptance task, which
  // must never make it eligible for an explicit Script-to-video request.
  const sourceIdentity = [
    flow.id,
    flow.title,
    flow.description,
    ...flow.milestones.slice(0, 2).map((milestone) => milestone.goal),
  ].join(' ');
  return source === 'script'
    ? /\bscript\b/i.test(sourceIdentity)
    : /\baudio\b/i.test(sourceIdentity);
}

export function authoritativeManualSourceFlow(
  sitemap: SiteMap,
  request: string,
): Flow | undefined {
  const mediaSource = requestedMediaSource(request);
  if (!mediaSource || !requestsEndToEndJourney(request)) return undefined;
  return sitemap.flows
    .filter(
      (flow) =>
        flow.status !== 'skipped' &&
        !isManualFlow(flow) &&
        flowMatchesRequestedMediaSource(flow, mediaSource) &&
        flowHasRequestedCapabilities(flow, request),
    )
    .sort(
      (left, right) =>
        right.milestones.length - left.milestones.length ||
        left.id.localeCompare(right.id),
    )[0];
}

/** Deterministic fallback for clear requests that match a complete mapped flow. */
export function bestManualFlow(sitemap: SiteMap, request: string): Flow | undefined {
  if (isReadOnlyManualRequest(request)) return undefined;
  const words = manualKeywords(requestForTargetMatching(request));
  if (words.length === 0) return undefined;
  const explicitlyScopedSurface = requestsEndToEndJourney(request)
    ? undefined
    : request.match(
      /\b(?:go\s+to|return\s+to|open|visit|in|on|from)\s+(?:the\s+)?(projects?|characters?|locations?|assets?|outfits?)\s*(?:area|page|library)?\b/i,
    )?.[1]?.toLowerCase().replace(/s$/, '');
  const mediaSource = requestedMediaSource(request);
  if (mediaSource && !explicitlyScopedSurface) {
    const authoritativeSource = authoritativeManualSourceFlow(sitemap, request);
    if (authoritativeSource) return authoritativeSource;
  }
  const ranked = sitemap.flows
    .filter(
      (flow) =>
        flow.status !== 'skipped' &&
        !isManualFlow(flow) &&
        flowHasRequestedCapabilities(flow, request) &&
        (!mediaSource || flowMatchesRequestedMediaSource(flow, mediaSource)) &&
        (
          !explicitlyScopedSurface ||
          normalizedWords(`${flow.entry.pageId} ${flow.id} ${flow.title}`).some(
            (token) => token.replace(/s$/, '') === explicitlyScopedSurface,
          )
        ),
    )
    .map((flow) => {
      const haystack = flowSearchText(flow);
      const identity = `${flow.id} ${flow.title}`.toLowerCase();
      const haystackTokens = new Set(normalizedWords(haystack));
      const identityTokens = new Set(normalizedWords(identity));
      const descriptionTokens = new Set(normalizedWords(flow.description));
      const strengths = words.map((word) => tokenMatchStrength(word, haystackTokens));
      const matches = strengths.filter((strength) => strength > 0).length;
      const identityMatches = words.filter(
        (word) => tokenMatchStrength(word, identityTokens) > 0,
      ).length;
      const coverage = strengths.reduce((total, strength) => total + strength, 0) / words.length;
      const score = words.reduce((total, word) => {
        const identityStrength = tokenMatchStrength(word, identityTokens);
        if (identityStrength) return total + 6 * identityStrength;
        const descriptionStrength = tokenMatchStrength(word, descriptionTokens);
        if (descriptionStrength) return total + 3 * descriptionStrength;
        return total + tokenMatchStrength(word, haystackTokens);
      }, 0);
      return { flow, score, coverage, matches, identityMatches };
    })
    .sort(
      (a, b) =>
        b.coverage - a.coverage ||
        b.identityMatches - a.identityMatches ||
        b.score - a.score ||
        b.flow.milestones.length - a.flow.milestones.length ||
        a.flow.id.localeCompare(b.flow.id),
    );
  const best = ranked[0];
  // Two matching meaningful terms are enough for concise requests such as
  // "audio video". A single distinctive feature term (for example "character")
  // may select a flow only when it occurs in the flow's own id/title, not merely
  // in one incidental milestone of a larger flow.
  const strongMultiTermMatch =
    best &&
    best.matches >= 2 &&
    (best.coverage >= 0.35 ||
      // Detailed manual requests often contain many value constraints (names,
      // timestamps, colors) that should not dilute clear flow anchors. Require
      // at least one identity match plus three matches across the full journey.
      (best.identityMatches >= 1 && best.matches >= 3));
  const distinctiveIdentityMatch =
    best && words.length === 1 && best.identityMatches === 1 && best.coverage === 1;
  return strongMultiTermMatch || distinctiveIdentityMatch ? best.flow : undefined;
}

/** Deterministic fallback when the planning LLM returns an invalid/nonexistent id. */
export function bestManualPage(sitemap: SiteMap, request: string): PageNode | undefined {
  const words = manualKeywords(requestForTargetMatching(request));
  if (words.length === 0) return undefined;
  const destructiveSurface = /\b(?:delete|remove)\b/i.test(request)
    ? request.match(
        /\b(?:go\s+to|open|visit)\s+(?:the\s+)?(projects?|characters?|locations?|assets?|outfits?)\b/i,
      )?.[1]?.toLowerCase()
    : undefined;
  return Object.values(sitemap.pages)
    .map((page) => {
      const haystack = pageSearchText(page);
      const haystackTokens = new Set(normalizedWords(haystack));
      const idTokens = new Set(normalizedWords(page.id));
      const titleTokens = new Set(normalizedWords(page.title));
      const interactiveTokens = new Set(
        normalizedWords(page.interactives.map((item) => item.label).join(' ')),
      );
      const strengths = words.map((word) => tokenMatchStrength(word, haystackTokens));
      const identityMatches = words.filter(
        (word) =>
          tokenMatchStrength(word, idTokens) > 0 ||
          tokenMatchStrength(word, titleTokens) > 0 ||
          tokenMatchStrength(word, interactiveTokens) > 0,
      ).length;
      const score = words.reduce((total, word) => {
        const idStrength = tokenMatchStrength(word, idTokens);
        if (idStrength) return total + 6 * idStrength;
        const titleStrength = tokenMatchStrength(word, titleTokens);
        if (titleStrength) return total + 5 * titleStrength;
        const interactiveStrength = tokenMatchStrength(word, interactiveTokens);
        if (interactiveStrength) return total + 3 * interactiveStrength;
        return total + tokenMatchStrength(word, haystackTokens);
      }, 0);
      const matches = strengths.filter((strength) => strength > 0).length;
      const coverage = strengths.reduce((total, strength) => total + strength, 0) / words.length;
      const identityBreadth = new Set([...idTokens, ...titleTokens]).size;
      const primaryDestructiveSurfaceBonus =
        destructiveSurface &&
        (page.id.toLowerCase() === destructiveSurface ||
          page.id.toLowerCase().startsWith(`${destructiveSurface}-`))
          ? 24
          : 0;
      return {
        page,
        score: score + primaryDestructiveSurfaceBonus,
        matches,
        coverage,
        identityMatches,
        identityBreadth,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.identityMatches - a.identityMatches ||
        a.identityBreadth - b.identityBreadth ||
        a.page.id.localeCompare(b.page.id),
    )
    .find(
      (candidate) =>
        candidate.score > 0 &&
        (candidate.identityMatches > 0 ||
          (candidate.matches >= 2 && candidate.coverage >= 0.5)),
    )?.page;
}

function inferManualKind(request: string): FlowMilestone['kind'] {
  if (isReadOnlyManualRequest(request)) return 'verify';
  if (/\b(upload|file|audio|script|pdf)\b/i.test(request)) return 'upload';
  if (/\b(create|add|generate|new|make)\b/i.test(request)) return 'create';
  if (/\b(edit|change|update|regenerate|modify|retake|reframe|reference|location|asset|character|outfit|style)\b/i.test(request)) {
    return 'edit';
  }
  return 'verify';
}

function directPageUrl(sitemap: SiteMap, page: PageNode): string | undefined {
  if (page.exampleUrl) return page.exampleUrl;
  const pattern = page.urlPatterns.find((candidate) => !candidate.includes(':id'));
  if (!pattern) return undefined;
  try {
    return new URL(pattern, sitemap.origin).toString();
  } catch {
    return undefined;
  }
}

function searchedEntity(request: string): string | undefined {
  const quoted = request.match(
    /\bsearch(?:\s+\w+)?(?:\s+for)?\s+["']([^"']{1,80})["']/i,
  )?.[1];
  if (quoted) return quoted.trim();
  return request
    .match(
      /\bsearch(?:\s+(?:characters?|people|items?|assets?|locations?|outfits?))?(?:\s+for)?\s+([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,3}?)(?=\s+(?:and|then|before|after|create|add|edit|change|make|generate|verify)\b|[,;.]|$)/i,
    )?.[1]
    ?.trim();
}

function focusedPageGuidance(page: PageNode, request: string): string {
  const controls = [
    ...new Set(
      page.interactives
        .filter((item) => item.label.trim())
        .map((item) => `"${item.label.trim()}" (${item.role})`),
    ),
  ].slice(0, 16);
  const searchEntity = searchedEntity(request);
  const sequence = searchEntity
    ? `Required sequence: first expose the mapped selector/search UI, search for and select "${searchEntity}", ` +
      `and visibly confirm "${searchEntity}" is the active context; only then perform the requested creation or edit. `
    : '';
  return (
    sequence +
    (controls.length
      ? `Mapped interactive controls on this area include: ${controls.join(', ')}. Prefer these exact interactive ` +
        'controls over clicking static headings or descriptive text. '
      : '')
  );
}

function compactManualInventory(sitemap: SiteMap): string {
  // Generated manual flows are request-specific execution artifacts, not
  // reusable descriptions of product behavior. Feeding them back to the
  // planner lets a new request select an older, broader manual goal.
  const flows = sitemap.flows.filter((flow) => !isManualFlow(flow)).map(
    (flow) =>
      `- ${flow.id} [${flow.status}]: ${flow.title} — ${flow.description}; milestones: ` +
      flow.milestones.map((milestone) => milestone.goal).join(' | '),
  );
  return `${summarizeSitemap(sitemap)}\n\nExisting flows:\n${flows.join('\n') || '(none)'}`;
}

function isManualFlow(flow: Flow): boolean {
  return flow.id.startsWith('manual-') || flow.description.startsWith('Sitemap-directed manual request:');
}

function mappedRouteToState(
  sitemap: SiteMap,
  page: PageNode | undefined,
): Flow | undefined {
  if (!page || (page.kind ?? 'page') === 'page') return undefined;
  const statusRank: Record<Flow['status'], number> = {
    deterministic: 0,
    exploratory: 1,
    approved: 1,
    proposed: 2,
    skipped: 3,
  };
  return sitemap.flows
    .filter((flow) => !isManualFlow(flow) && flow.status !== 'skipped')
    .map((flow) => {
      const targetIndex = flow.milestones.findIndex(
        (milestone) =>
          milestone.guardPhases?.includes(page.id) ||
          milestone.manualJourneyDestinationPageId === page.id,
      );
      return { flow, targetIndex };
    })
    .filter((candidate) => candidate.targetIndex >= 0)
    .sort(
      (left, right) =>
        statusRank[left.flow.status] - statusRank[right.flow.status] ||
        left.targetIndex - right.targetIndex ||
        left.flow.milestones.length - right.flow.milestones.length ||
        left.flow.id.localeCompare(right.flow.id),
    )[0]?.flow;
}

export function validateManualPlan(
  sitemap: SiteMap,
  request: string,
  candidate: Partial<ManualPlan>,
): ManualPlan {
  // The LLM may choose among mapped targets, but a syntactically valid id is
  // not evidence that the target is related to the request. Ground its choice
  // again with the deterministic matcher so "profile" cannot be silently
  // relabeled as "dashboard" merely because Dashboard is a real page.
  const groundedFlow = bestManualFlow(sitemap, request);
  // Capability semantics outrank title/keyword similarity. A library page can
  // mention "Locations" everywhere while the mapped create control exists only
  // on a wizard state. Both manual engines must therefore start from the state
  // that can perform the requested action, not merely the page with the closest
  // name. Fall back to the broad matcher only when no capability rule applies.
  const groundedPage =
    manualAuditTargetPage(sitemap, request) ?? bestManualPage(sitemap, request);
  const capabilityRoute = mappedRouteToState(sitemap, groundedPage);
  const selectedById = candidate.existingFlowId
    ? sitemap.flows.find((flow) => flow.id === candidate.existingFlowId)
    : undefined;
  const existing = candidate.existingFlowId
    ? selectedById &&
      selectedById.status !== 'skipped' &&
      !isManualFlow(selectedById) &&
      groundedFlow?.id === selectedById.id &&
      (!isReadOnlyManualRequest(request) ||
        selectedById.milestones.every(
          (milestone) => milestone.kind === 'verify' || milestone.kind === 'navigate',
        ))
      ? selectedById
      : undefined
    : undefined;
  if (candidate.mode === 'existing-flow' && existing) {
    return {
      mode: 'existing-flow',
      existingFlowId: existing.id,
      title: existing.title,
      goal: request,
      kind: inferManualKind(request),
    };
  }

  const fallbackFlow =
    candidate.mode === undefined || candidate.mode === 'existing-flow'
      ? groundedFlow
      : undefined;
  if (fallbackFlow) {
    return {
      mode: 'existing-flow',
      existingFlowId: fallbackFlow.id,
      title: fallbackFlow.title,
      goal: request,
      kind: inferManualKind(request),
    };
  }

  // Stateful wizard/modal/processing surfaces require browser-local context.
  // Reuse the shortest mapped journey that actually reached the capability,
  // then cloneManualFlow trims it at that target. Directly opening the example
  // URL can resume a stale draft or land without the owning project.
  if (capabilityRoute) {
    return {
      mode: 'existing-flow',
      existingFlowId: capabilityRoute.id,
      title: capabilityRoute.title,
      goal: request,
      kind: inferManualKind(request),
    };
  }

  const page = groundedPage;
  if (!page) {
    throw new Error(
      `The sitemap has no page matching "${request}". Re-run exploration first so that area is mapped.`,
    );
  }
  const allowedKinds: FlowMilestone['kind'][] = [
    'navigate',
    'edit',
    'create',
    'upload',
    'verify',
  ];
  const kind = allowedKinds.includes(candidate.kind as FlowMilestone['kind'])
    ? (candidate.kind as FlowMilestone['kind'])
    : inferManualKind(request);
  const safeKind = isReadOnlyManualRequest(request) ? 'verify' : kind;
  const title = (candidate.title || `Manual test: ${page.title}`).trim().slice(0, 100);
  const requestedGoal = (candidate.goal || request).trim();
  const groundedTexts = [
    page.title,
    ...page.detection.snapshotAnyOf,
    ...page.interactives.map((item) => item.label),
  ].map((value) => value.toLowerCase());
  const successHint = candidate.successHint?.trim();
  return {
    mode: 'focused-page',
    targetPageId: page.id,
    title,
    kind: safeKind,
    successHint:
      successHint && groundedTexts.some((text) => text.includes(successHint.toLowerCase()))
        ? successHint
        : undefined,
    goal:
      `${manualDirective(request)} ${focusedPageGuidance(page, request)}On the mapped "${page.title}" area, ` +
      `${requestedGoal}. ` +
      (safeKind === 'verify'
        ? 'Inspect and verify the requested visible state without creating, editing, uploading, submitting, or saving anything. '
        : 'Exercise the relevant safe functionality with realistic user-provided values, make one meaningful ' +
          'change or creation when the page supports it, wait for processing, and verify visibly that the outcome ' +
          'completed and persisted. ') +
      'Stay within this requested feature; do not branch into unrelated workflows. ' +
      'Only finish when the requested behavior has been proved or a genuine product error blocks progress.',
  };
}

export async function planManualRequest(
  llm: LlmClient,
  sitemap: SiteMap,
  request: string,
): Promise<ManualPlan> {
  const raw = await llm.complete({
    messages: [
      {
        role: 'user',
        content: `Choose the narrowest sitemap-grounded QA target for this manual request:
"${request}"

${compactManualInventory(sitemap)}

Rules:
- Never invent a page id, flow id, URL, control, or success text.
- Choose "existing-flow" only when an existing flow's full purpose directly matches the request.
- Requests for an end-to-end or final artifact (for example a rendered video through the audio path)
  must use the matching complete existing flow so every mapped milestone runs through terminal verification.
- A request that says only/just verify, or explicitly says not to create/edit/regenerate/upload, is read-only:
  choose a focused page or a read-only flow and never choose a mutating flow.
- Otherwise choose "focused-page" and the single mapped page most relevant to the request.
- The goal must test meaningful functionality and verify its visible/persistent result, not merely open the page.
- Keep the test inside the requested feature.
- successHint is optional and may only be literal visible text copied from the sitemap.

Return JSON only:
{"mode":"existing-flow|focused-page","existingFlowId":"id or omit","targetPageId":"id or omit","title":"short title","goal":"focused test goal","kind":"navigate|edit|create|upload|verify","successHint":"literal text or omit"}`,
      },
    ],
    maxTokens: 900,
  });
  let candidate: Partial<ManualPlan> = {};
  try {
    candidate = parseJsonFromLlm<Partial<ManualPlan>>(raw);
  } catch {
    console.warn('[manual] planner returned invalid JSON — using deterministic sitemap matching');
  }
  return validateManualPlan(sitemap, request, candidate);
}

function canonicalManualRequest(request: string): string {
  return request.trim().replace(/\s+/g, ' ').toLowerCase();
}

function manualFlowId(
  request: string,
  targetId: string,
  engine: ManualEngine = 'legacy',
): string {
  const slug = request
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36) || 'request';
  const digest = createHash('sha256')
    .update(
      `${MANUAL_FLOW_CONTRACT_VERSION}\0${engine}\0${targetId}\0${canonicalManualRequest(request)}`,
    )
    .digest('hex')
    .slice(0, 8);
  return `manual-${slug}-${digest}`;
}

function manualDirective(request: string): string {
  return (
    `Manual QA request (preserve every named control, value, order constraint, and expected outcome exactly): ` +
    `"${request.trim().replace(/\s+/g, ' ')}". ` +
    'Keep moving toward the requested outcome through mapped forward controls. If a reversible choice repeatedly ' +
    'opens the same blocking modal or upsell without advancing, close it and try the other safe visible choice once; ' +
    'do not repeat the same choice-modal-close cycle. When a forward control is disabled, inspect every visible ' +
    'required option group and satisfy one safe option in each still-unanswered group before retrying an option that ' +
    'was already attempted. If loop analysis identifies a different unmet group, act on that group next. Before any ' +
    'create or edit action, satisfy every named search, selection, and owner requirement in the request and visibly ' +
    'confirm that the active entity matches; never assume the currently selected entity is the requested one.' +
    manualEditVerificationGuidance(request)
  );
}

/**
 * Preserve the user's own acceptance statements as discrete obligations. The
 * old contract repeated one large paragraph at every checkpoint, which let the
 * explorer focus on the nearby mapped hint and forget earlier clauses. These
 * strings are intentionally not rephrased: names, counts, ordering, and
 * negative constraints must survive compilation exactly.
 */
export function manualAcceptanceChecklist(request: string): string[] {
  const compact = request.trim().replace(/\s+/g, ' ');
  const sentences = compact
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((item) => item.trim().replace(/[.!?]+$/, ''))
    .filter(Boolean);
  return sentences.length > 1 ? sentences : [compact.replace(/[.!?]+$/, '')];
}

function checklistText(checklist: string[]): string {
  return checklist.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

export function manualAuditTargetPage(sitemap: SiteMap, item: string): PageNode | undefined {
  const semanticTarget = (() => {
    const candidates = Object.values(sitemap.pages);
    const find = (pattern: RegExp) =>
      candidates.find((page) => pattern.test(`${page.id} ${page.title}`)) ??
      candidates.find((page) => pattern.test(page.description));
    if (
      /\b(?:click|submit|create|make|render)\b.{0,30}\b(?:final[- ]?)?video\b/i.test(
        item,
      )
    ) {
      return find(/wizard-edit-scenes|\bedit scenes?\b/i);
    }
    if (/\b(final[- ]video|terminal artifact|create video|render(?:ed|ing)?|playable|downloadable)\b/i.test(item)) {
      return find(/\bfinal[- ]?video\b|wizard-final-video/i);
    }
    if (
      /\b(change scene|reshoot|camera angle|add assets?|add .{0,30}asset.{0,30}scene|different scenes?)\b/i.test(
        item,
      )
    ) {
      return find(/wizard-edit-scenes|\bedit scenes?\b/i);
    }
    if (/\b(location|locations)\b/i.test(item)) {
      if (/\b(create|new|add|generate|regenerate)\b/i.test(item)) {
        return find(/wizard-locations|\blocations?\b.{0,60}\bwizard\b/i);
      }
      return find(/locations-list|\blocations library\b|\byour locations\b/i);
    }
    if (/\b(?:delete|remove)\b.{0,50}\bcharacters?\b|\bcharacters?\b.{0,50}\b(?:delete|remove)\b/i.test(item)) {
      return find(/characters-list|\byour characters\b|\bcharacters library\b/i);
    }
    // Multi-method character creation belongs to the active project's wizard,
    // even when the user naturally says "in the Character section". Resolve
    // this before the explicit standalone-library navigation rule below.
    if (
      /\b(three distinct characters|three distinct character methods)\b/i.test(
        item,
      )
    ) {
      return find(/wizard-story-type|select story type/i);
    }
    if (
      /\b(?:go\s+to|return\s+to|open|visit|in|on|from)\s+(?:the\s+)?characters?\s*(?:area|page|library)?\b/i.test(
        item,
      )
    ) {
      return find(/characters-list|\byour characters\b|^characters?$/i);
    }
    if (/\b(?:delete|remove)\b.{0,50}\bprojects?\b|\bprojects?\b.{0,50}\b(?:delete|remove)\b/i.test(item)) {
      return find(/projects-list|\byour projects\b|\bprojects library\b/i);
    }
    if (/\b(reusable asset|asset library)\b/i.test(item)) {
      return find(/assets-list|\byour assets\b|\bassets library\b/i);
    }
    if (/\b(outfit|sketch style|orientation|art style)\b/i.test(item)) {
      return find(/wizard-style-character-look|character.+look.+art style/i);
    }
    if (/\b(story theme|story element)\b/i.test(item)) {
      return find(/wizard-theme|\bstory theme\b/i);
    }
    if (/\b(character voice|emotion|dialogue|spoken text|script line)\b/i.test(item)) {
      return find(/wizard-edit-script|edit script|review transcript/i);
    }
    if (
      /\b(?:upload.{0,40}character|character.{0,40}(?:image|photo).{0,40}(?:upload|file)|create.{0,40}character.{0,40}(?:image|photo))\b/i.test(
        item,
      )
    ) {
      return find(/wizard-story-type|select story type/i);
    }
    if (/\b(ai avatar|existing character|character library)\b/i.test(item)) {
      return find(/wizard-story-type|select story type/i);
    }
    if (/\b(upload.+script|script file)\b/i.test(item)) {
      return find(/upload-content-start|\bupload content\b/i);
    }
    if (/\b(new project|dashboard)\b/i.test(item)) {
      return find(/projects-list|\bdashboard\b/i);
    }
    return undefined;
  })();
  if (semanticTarget) return semanticTarget;

  const words = normalizedWords(item);
  const ranked = Object.values(sitemap.pages)
    .map((page) => {
      const title = new Set(normalizedWords(page.title));
      const controls = new Set(
        normalizedWords(page.interactives.map((interactive) => interactive.label).join(' ')),
      );
      const description = new Set(normalizedWords(page.description));
      const score = words.reduce(
        (total, word) =>
          total +
          (title.has(word) ? 10 : 0) +
          (controls.has(word) ? 4 : 0) +
          (description.has(word) ? 1 : 0),
        0,
      );
      return { page, score };
    })
    .sort((left, right) => right.score - left.score || left.page.id.localeCompare(right.page.id));
  return ranked[0]?.score > 0 ? ranked[0].page : undefined;
}

function isPostTerminalManualItem(item: string): boolean {
  return /\b(final[- ]video|terminal artifact|create video|after render(?:ing|ed)?|rendered video|rendered.{0,40}(?:playable|downloadable)|spinner|disabled player|finish only)\b/i.test(
    item,
  );
}

function isPostTerminalManualTask(item: string): boolean {
  if (
    /\b(?:click|submit|create|make|render)\b.{0,30}\b(?:final[- ]?)?video\b/i.test(
      item,
    )
  ) {
    return false;
  }
  return /\b(after render(?:ing|ed)?|final[- ]video functions?|updated video|terminal artifact remains)\b/i.test(
    item,
  );
}

function isMappedTerminalMilestone(milestone: Flow['milestones'][number]): boolean {
  return (
    milestone.kind === 'verify' ||
    /\b(final video|final rendered|terminal artifact|create video.{0,60}(?:verify|render)|playable.{0,30}video)\b/i.test(
      `${milestone.goal} ${milestone.successHint ?? ''}`,
    )
  );
}

function requestedEntryOverride(
  sitemap: SiteMap,
  request: string,
): { page: PageNode; control?: string } | undefined {
  const match = request.match(
    /\bthrough\s+(?:the\s+)?(?:verified\s+)?(.+?)\s+to\s+(?:the\s+)?(.+?)\s+(?:button|control)\s+path\b/i,
  );
  if (!match) return undefined;
  const page = bestManualPage(sitemap, match[1]);
  if (!page) return undefined;
  const requestedControl = match[2].trim();
  const mapped = page.interactives.find(
    (item) =>
      item.label.localeCompare(requestedControl, undefined, { sensitivity: 'accent' }) === 0 ||
      item.label.toLowerCase().includes(requestedControl.toLowerCase()) ||
      requestedControl.toLowerCase().includes(item.label.toLowerCase()),
  );
  return { page, control: mapped?.label ?? requestedControl };
}

function defaultFreshCreationEntry(
  sitemap: SiteMap,
  flow: Flow,
): { page: PageNode; control?: string } | undefined {
  const creationFlow =
    flow.milestones.some((milestone) => milestone.kind === 'upload') ||
    /\b(script|audio|video|project|workflow|render|film)\b/i.test(
      `${flow.title} ${flow.description}`,
    );
  if (!creationFlow) return undefined;
  const candidates = Object.values(sitemap.pages)
    .filter((page) => page.requiresAuth && (page.kind ?? 'page') === 'page')
    .map((page) => {
      const text = `${page.id} ${page.title} ${page.description}`;
      const score =
        (/\bdashboard\b/i.test(text) ? 30 : 0) +
        (/\bhome\b/i.test(text) ? 20 : 0) +
        (/\bprojects?\b/i.test(text) ? 10 : 0);
      const control = page.interactives.find(
        (item) =>
          item.category !== 'destructive' &&
          /\b(?:new|create|start)\b.{0,40}\b(?:project|video|experience|workflow)\b/i.test(
            item.label,
          ),
      )?.label;
      return { page, control, score: score + (control ? 50 : 0) };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best ? { page: best.page, control: best.control } : undefined;
}

function manualJourneySource(
  existing: Flow,
  request: string,
  targetPageId?: string,
): Flow {
  if (requestsEndToEndJourney(request) || existing.milestones.length <= 3) {
    return existing;
  }
  const featurePatterns = [
    /\bcharacters?\b/i,
    /\blocations?\b/i,
    /\boutfits?\b/i,
    /\bassets?\b/i,
    /\bprojects?\b/i,
    /\b(?:dialogue|transcript|voice|emotion)\b/i,
    /\bscenes?\b/i,
    /\bstyles?\b/i,
    /\bthemes?\b/i,
    /\baudio\b/i,
    /\bscripts?\b/i,
  ].filter((pattern) => pattern.test(request));
  if (featurePatterns.length === 0) return existing;
  const cutoff = existing.milestones.findIndex(
    (milestone) =>
      (targetPageId && milestone.guardPhases?.includes(targetPageId)) ||
      featurePatterns.some((pattern) => pattern.test(milestone.goal)),
  );
  if (cutoff < 0) return existing;
  return {
    ...existing,
    milestones: existing.milestones.slice(0, cutoff + 1),
  };
}

function cloneExistingFlowForManualRequest(
  sitemap: SiteMap,
  existing: Flow,
  request: string,
  engine: ManualEngine,
): Flow {
  const id = manualFlowId(request, `flow:${existing.id}`, engine);
  const checklist = manualAcceptanceChecklist(request);
  const obligations = checklistText(checklist);
  const sourceFlow = manualJourneySource(
    existing,
    request,
    manualAuditTargetPage(sitemap, request)?.id,
  );
  const requestedOverride = requestedEntryOverride(sitemap, request);
  const entryOverride =
    requestedOverride ??
    (engine === 'task-graph' ? defaultFreshCreationEntry(sitemap, existing) : undefined);
  if (engine === 'task-graph') {
    const atomicChecklist = splitCrossPageAcceptanceItems(
      checklist,
      (item) => manualAuditTargetPage(sitemap, item)?.id,
    );
    const graph = compileManualTaskGraph({
      sourceFlow,
      checklist: atomicChecklist,
      resolveTargetPageId: (item) => manualAuditTargetPage(sitemap, item)?.id,
      isPostTerminal: isPostTerminalManualTask,
    });
    if (entryOverride) {
      const entryTask = graph.tasks.find((task) =>
        /\b(?:new project|dashboard.{0,80}new project)\b/i.test(task.requirement),
      );
      if (entryTask) {
        // The first journey checkpoint owns the verified button-click entry.
        // Keep this task as an evidence audit, but do not navigate back to the
        // dashboard and create a second project after the entry already ran.
        entryTask.targetPageId = undefined;
        entryTask.position = 'after-entry';
      }
    }
    const milestones = lowerManualTaskGraph(sourceFlow, graph, {
      requiresTerminalArtifact: requestsEndToEndJourney(request),
    });
    if (entryOverride && milestones[0]) {
      const controlInstruction = entryOverride.control
        ? `activate the mapped "${entryOverride.control}" control`
        : 'activate the one visible safe New/Create/Start control that begins a genuinely fresh workflow';
      milestones.unshift({
        id: 'manual-fresh-entry',
        kind: 'navigate',
        guardPhases: [entryOverride.page.id],
        manualJourneyDestinationPageId: existing.entry.pageId,
        goal:
          `[FRESH ENTRY]\nOn "${entryOverride.page.title}", ${controlInstruction}. ` +
          `Stop as soon as the mapped workflow entry "${existing.entry.pageId}" is visibly reached. ` +
          'Never resume or direct-open an old artifact.',
      });
    }
    return {
      ...structuredClone(existing),
      id,
      title: `Manual v2: ${existing.title}`.slice(0, 100),
      description: `Task-graph manual request: ${request.trim()} (based on flow ${existing.id})`,
      status: 'exploratory',
      qualification: { phase: 'learning' },
      manualContract: { request: request.trim(), checklist: atomicChecklist },
      manualExecution: {
        version: 1,
        sourceFlowId: existing.id,
        primaryJourneyPageIds: [
          ...new Set([
            ...(entryOverride ? [entryOverride.page.id] : []),
            ...sourceFlow.milestones.flatMap((milestone) => milestone.guardPhases ?? []),
          ]),
        ],
        tasks: graph.tasks,
        constraints: graph.constraints,
        policy: {
          context: 'active-task',
          processing: 'manual-narrative-safe',
          recovery: 'bounded-modal-dismiss',
          probes: 'contract-only',
        },
      },
      entry: entryOverride
        ? {
            pageId: entryOverride.page.id,
            url: directPageUrl(sitemap, entryOverride.page),
            freshEntryHint: existing.entry.freshEntryHint,
          }
        : structuredClone(existing.entry),
      milestones,
    };
  }
  const copiedMilestones = sourceFlow.milestones.map((milestone, index) => ({
    ...structuredClone(milestone),
    // The runner's generic `edit` kind injects a random marker and later
    // requires that marker to remain visible. In an end-to-end manual journey
    // the requested edit may legitimately navigate onward (for example Edit
    // Scenes → Final Video), making that synthetic marker a false failure.
    // The exact edit remains in the goal; `navigate` removes only the marker
    // instrumentation and does not prevent the explorer from performing it.
    kind: milestone.kind === 'edit' ? ('navigate' as const) : milestone.kind,
    guardPhases:
      index === 0 && entryOverride ? [entryOverride.page.id] : milestone.guardPhases,
    goal:
      'Manual acceptance contract is active for this journey. ' +
      (index === 0 && entryOverride
        ? `Required entry path: begin on "${entryOverride.page.title}", activate the mapped ` +
          `"${entryOverride.control}" control, and visibly prove this created a genuinely fresh journey before ` +
          'performing the mapped checkpoint. Do not navigate directly to a later wizard URL and do not use a resumed draft. '
        : '') +
      `Current checkpoint from the mapped flow: ${milestone.goal} ` +
      'Before using a forward/Next control, inspect the current screen for every checklist operation that can be ' +
      'performed here. Perform and verify each such operation now; advancing the mapped checkpoint is not proof ' +
      'that those operations happened. The checkpoint is a navigation guide, but it must not override or omit ' +
      'the manual request. If one reversible choice repeatedly opens the same blocking modal without advancing, ' +
      'close it and try the other safe visible choice once; do not repeat the same choice-modal-close cycle. ' +
      'After one bounded attempt at an unavailable or ineffective checklist operation, dismiss its modal, leave ' +
      'that operation unproven for its later independent audit, and use the safe mapped forward control; do not ' +
      'let an earlier incomplete sub-check trap every later checkpoint.',
  }));
  const auditMilestones = checklist.map((item, index) => ({
    id: `manual-contract-audit-${index + 1}`,
    kind: 'navigate' as const,
    manualContractAudit: true,
    manualContractItem: index + 1,
    manualContractTargetPageId: manualAuditTargetPage(sitemap, item)?.id,
    goal:
      `[MANUAL CONTRACT AUDIT — ITEM ${index + 1}]\n${index + 1}. ${item}\n\n` +
      `Audit only acceptance item ${index + 1}. A click or attempted action is not proof. Call done only when ` +
      'same-run evidence shows the requested state change completed and persisted. If the evidence is missing or ' +
      'ambiguous, use safe visible navigation to reach the feature, perform only this missing operation once, wait ' +
      'for processing, and verify the result. If visible navigation cannot reach the feature, report the item ' +
      'incomplete so the runner can use its one mapped-page recovery. Never treat a direct scene upload as proof of ' +
      'a separately requested reusable library asset, or an attempted editor click as proof that a value persisted.',
  }));
  const preTerminalAudits = auditMilestones.filter(
    (_, index) => !isPostTerminalManualItem(checklist[index]),
  );
  const postTerminalAudits = auditMilestones.filter(
    (_, index) => isPostTerminalManualItem(checklist[index]),
  );
  let terminalIndex = -1;
  copiedMilestones.forEach((milestone, index) => {
    if (isMappedTerminalMilestone(milestone)) terminalIndex = index;
  });
  const journeyBeforeTerminal =
    terminalIndex >= 0 ? copiedMilestones.slice(0, terminalIndex) : copiedMilestones;
  const terminalJourney = terminalIndex >= 0 ? copiedMilestones.slice(terminalIndex) : [];
  const finalProofId = 'manual-contract-final-proof';
  return {
    ...structuredClone(existing),
    id,
    title: `Manual: ${existing.title}`.slice(0, 100),
    description: `Sitemap-directed manual request: ${request.trim()} (based on flow ${existing.id})`,
    status: 'exploratory',
    qualification: { phase: 'learning' },
    manualContract: { request: request.trim(), checklist },
    entry: entryOverride
      ? {
          pageId: entryOverride.page.id,
          url: directPageUrl(sitemap, entryOverride.page),
          freshEntryHint: existing.entry.freshEntryHint,
        }
      : structuredClone(existing.entry),
    milestones: [
      ...journeyBeforeTerminal,
      ...preTerminalAudits,
      ...terminalJourney,
      ...postTerminalAudits,
      {
        id: finalProofId,
        kind: 'verify',
        goal:
          `[FINAL MANUAL CONTRACT PROOF]\n${obligations}\n\n` +
          'Verification only: prove that every numbered obligation has concrete evidence from this run and that ' +
          (requestsEndToEndJourney(request)
            ? 'the requested terminal artifact remains playable, persisted, and downloadable. '
            : 'the requested focused result remains visibly completed and persisted. ') +
          'Do not perform another ' +
          'mutation. If any obligation lacks proof, report the contract incomplete rather than treating the mapped ' +
          'flow terminal state as success.',
      },
    ],
  };
}

export function upsertManualFlow(
  state: Pick<SiteState, 'sitemap' | 'saveSitemap'>,
  request: string,
  plan: ManualPlan,
  options?: { engine?: ManualEngine },
): Flow {
  const engine = options?.engine ?? 'legacy';
  if (plan.mode === 'existing-flow') {
    const existing = state.sitemap.flows.find((flow) => flow.id === plan.existingFlowId);
    if (!existing || existing.status === 'skipped' || isManualFlow(existing)) {
      throw new Error(`Manual planner selected unavailable flow "${plan.existingFlowId}"`);
    }
    const id = manualFlowId(request, `flow:${existing.id}`, engine);
    const saved = state.sitemap.flows.find((flow) => flow.id === id);
    if (saved) return saved;
    const manualCopy = cloneExistingFlowForManualRequest(
      state.sitemap,
      existing,
      request,
      engine,
    );
    state.sitemap.flows.push(manualCopy);
    state.saveSitemap();
    return manualCopy;
  }

  const page = plan.targetPageId ? state.sitemap.pages[plan.targetPageId] : undefined;
  if (!page) throw new Error(`Manual planner selected unknown page "${plan.targetPageId}"`);
  const id = manualFlowId(request, page.id, engine);
  const existing = state.sitemap.flows.find((flow) => flow.id === id);
  if (existing) return existing;
  const entity = searchedEntity(request);
  const sidebarControls = page.interactives.filter((item) =>
    /\b(expand|toggle).{0,20}\b(sidebar|selector|panel)\b/i.test(item.label),
  );
  const expandControl =
    sidebarControls.find((item) => /\bexpand\b/i.test(item.label)) ?? sidebarControls[0];
  const selectorMilestones: FlowMilestone[] = entity
    ? [
        {
          id: 'm1',
          goal:
            `${manualDirective(request)} Before performing any creation or edit, ` +
            (expandControl
              ? `click the mapped ${expandControl.role} labeled exactly "${expandControl.label}" to expose the selector/search UI. `
              : 'expose the mapped selector/search UI using a visible navigation control. ') +
            `Search for "${entity}", select the matching result, and visibly confirm "${entity}" is now the active ` +
            'owner/context. Do not click any Create, Add, Try, Generate, Save, or Apply control in this milestone. ' +
            'Finish this milestone only after the requested entity is visibly active.',
          kind: 'navigate',
          guardPhases: [page.id],
          successHint: entity,
        },
      ]
    : [];
  const actionId = entity ? 'm2' : 'm1';

  const flow: Flow = {
    id,
    title: plan.title,
    description: `Sitemap-directed manual request: ${request}`,
    status: 'exploratory',
    qualification: { phase: 'learning' },
    // Focused legacy flows used to omit this marker. That accidentally enabled
    // generic probes and ordinary replay recovery, so a successful destructive
    // task could be executed again after a back/forward probe. Every --manual
    // flow, regardless of engine, now opts into the same contract-only policy.
    manualContract: {
      request: request.trim(),
      checklist: [request.trim()],
    },
    entry: { pageId: page.id, url: directPageUrl(state.sitemap, page) },
    milestones: [
      ...selectorMilestones,
      {
        id: actionId,
        goal: plan.goal,
        kind: plan.kind,
        guardPhases: [page.id],
        successHint: plan.successHint,
        manualContractAudit: true,
        manualContractItem: 1,
        manualContractTargetPageId: page.id,
      },
      ...(plan.kind === 'create' || plan.kind === 'edit'
        ? [
            {
              id: 'manual-contract-final-proof',
              goal:
                `${manualDirective(request)} Verification only: confirm the final visible state satisfies every ` +
                'explicit named entity, owner, value, ordering constraint, and expected outcome in the request. ' +
                'Do not pass from a generic success toast or matching description alone; the visible active owner ' +
                'or selected context must match any named entity in the request, and the created/edited result must ' +
                'be visibly finalized and persisted. Do not perform another mutation.',
              kind: 'verify' as const,
              guardPhases: [page.id],
            },
          ]
        : []),
    ],
  };
  if (engine === 'task-graph') {
    const atomicChecklist = splitCrossPageAcceptanceItems(
      [request.trim()],
      () => page.id,
    );
    const graph = compileManualTaskGraph({
      sourceFlow: flow,
      checklist: atomicChecklist,
      resolveTargetPageId: () => page.id,
      isPostTerminal: isPostTerminalManualTask,
    });
    flow.manualContract = { request: request.trim(), checklist: atomicChecklist };
    flow.manualExecution = {
      version: 1,
      sourceFlowId: `focused:${page.id}`,
      primaryJourneyPageIds: [page.id],
      tasks: graph.tasks,
      constraints: graph.constraints,
      policy: {
        context: 'active-task',
        processing: 'manual-narrative-safe',
        recovery: 'bounded-modal-dismiss',
        probes: 'contract-only',
      },
    };
    flow.milestones = [
      ...graph.tasks.map((task, index) => ({
        id: `manual-task-${index + 1}`,
        goal:
          `[ACTIVE ACCEPTANCE TASK ${index + 1}]\n${task.requirement}\n\n` +
          `${focusedPageGuidance(page, task.requirement)}Work only on this task. Perform one bounded ` +
          'attempt, wait for genuine processing, and verify the result remains usable before returning control. ' +
          'Do not perform a later task and do not repeat a mutation already proven in same-run evidence.',
        kind: inferManualKind(task.requirement),
        guardPhases: [page.id],
        manualContractAudit: true,
        manualContractItem: index + 1,
        manualContractTargetPageId: page.id,
        manualTaskId: task.id,
      })),
      {
        id: 'manual-task-final-proof',
        goal:
          '[FINAL TASK-GRAPH PROOF]\nRead-only verification. Confirm the current feature remains usable after ' +
          'the independently adjudicated tasks. Do not repeat, create, edit, upload, or submit anything.',
        kind: 'verify',
        guardPhases: [page.id],
      },
    ];
  }
  state.sitemap.flows.push(flow);
  state.saveSitemap();
  return flow;
}

export async function manualCommand(
  request: string,
  opts: { session?: Session; keepOpen?: boolean; engine?: ManualEngine } = {},
): Promise<{ session: Session; failed: number; flow: Flow }> {
  const cleanRequest = request.trim();
  if (!cleanRequest) throw new Error('--manual requires a non-empty request');
  const session = opts.session ?? bootstrap();
  try {
    if (Object.keys(session.state.sitemap.pages).length === 0) {
      throw new Error('--manual needs an existing sitemap. Run an exhaustive exploration first.');
    }
    const plan = await planManualRequest(session.llm, session.state.sitemap, cleanRequest);
    const flow = upsertManualFlow(session.state, cleanRequest, plan, {
      engine: opts.engine,
    });
    console.log(
      `[manual${opts.engine === 'task-graph' ? ':v2' : ''}] ${
        plan.mode === 'existing-flow' ? 'using existing flow' : 'targeted mapped page'
      }: ` +
        `${flow.id} — ${flow.title}`,
    );
    const result = await testCommand({ session, keepOpen: true, only: [flow.id] });
    return { ...result, flow };
  } finally {
    if (!opts.keepOpen) teardown(session);
  }
}
