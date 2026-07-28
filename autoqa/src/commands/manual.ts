import { createHash } from 'node:crypto';
import { parseJsonFromLlm, type LlmClient } from '../core/llm/client.js';
import {
  summarizeSitemap,
  type Flow,
  type FlowMilestone,
  type PageNode,
  type SiteMap,
} from '../agent/sitemap.js';
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
const MANUAL_FLOW_CONTRACT_VERSION = '10';

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

/** Deterministic fallback for clear requests that match a complete mapped flow. */
export function bestManualFlow(sitemap: SiteMap, request: string): Flow | undefined {
  if (isReadOnlyManualRequest(request)) return undefined;
  const words = manualKeywords(requestForTargetMatching(request));
  if (words.length === 0) return undefined;
  const ranked = sitemap.flows
    .filter((flow) => flow.status !== 'skipped' && !isManualFlow(flow))
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
      return { page, score, matches, coverage, identityMatches };
    })
    .sort((a, b) => b.score - a.score || a.page.id.localeCompare(b.page.id))
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
  if (/\b(edit|change|update|regenerate|modify|location|asset|character|outfit|style)\b/i.test(request)) {
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
  const groundedPage = bestManualPage(sitemap, request);
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

function manualFlowId(request: string, targetId: string): string {
  const slug = request
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36) || 'request';
  const digest = createHash('sha256')
    .update(`${MANUAL_FLOW_CONTRACT_VERSION}\0${targetId}\0${canonicalManualRequest(request)}`)
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
    'confirm that the active entity matches; never assume the currently selected entity is the requested one.'
  );
}

function cloneExistingFlowForManualRequest(existing: Flow, request: string): Flow {
  const id = manualFlowId(request, `flow:${existing.id}`);
  const directive = manualDirective(request);
  return {
    ...structuredClone(existing),
    id,
    title: `Manual: ${existing.title}`.slice(0, 100),
    description: `Sitemap-directed manual request: ${request.trim()} (based on flow ${existing.id})`,
    status: 'exploratory',
    qualification: { phase: 'learning' },
    milestones: existing.milestones.map((milestone) => ({
      ...structuredClone(milestone),
      // The runner's generic `edit` kind injects a random marker and later
      // requires that marker to remain visible. In an end-to-end manual journey
      // the requested edit may legitimately navigate onward (for example Edit
      // Scenes → Final Video), making that synthetic marker a false failure.
      // The exact edit remains in the goal; `navigate` removes only the marker
      // instrumentation and does not prevent the explorer from performing it.
      kind: milestone.kind === 'edit' ? 'navigate' : milestone.kind,
      goal:
        `${directive} Current checkpoint from the mapped flow: ${milestone.goal} ` +
        'The checkpoint is a navigation guide, but it must not override or omit the manual request.',
    })),
  };
}

export function upsertManualFlow(
  state: Pick<SiteState, 'sitemap' | 'saveSitemap'>,
  request: string,
  plan: ManualPlan,
): Flow {
  if (plan.mode === 'existing-flow') {
    const existing = state.sitemap.flows.find((flow) => flow.id === plan.existingFlowId);
    if (!existing || existing.status === 'skipped' || isManualFlow(existing)) {
      throw new Error(`Manual planner selected unavailable flow "${plan.existingFlowId}"`);
    }
    const id = manualFlowId(request, `flow:${existing.id}`);
    const saved = state.sitemap.flows.find((flow) => flow.id === id);
    if (saved) return saved;
    const manualCopy = cloneExistingFlowForManualRequest(existing, request);
    state.sitemap.flows.push(manualCopy);
    state.saveSitemap();
    return manualCopy;
  }

  const page = plan.targetPageId ? state.sitemap.pages[plan.targetPageId] : undefined;
  if (!page) throw new Error(`Manual planner selected unknown page "${plan.targetPageId}"`);
  const id = manualFlowId(request, page.id);
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
  const verificationId = entity ? 'm3' : 'm2';

  const flow: Flow = {
    id,
    title: plan.title,
    description: `Sitemap-directed manual request: ${request}`,
    status: 'exploratory',
    qualification: { phase: 'learning' },
    entry: { pageId: page.id, url: directPageUrl(state.sitemap, page) },
    milestones: [
      ...selectorMilestones,
      {
        id: actionId,
        goal: plan.goal,
        kind: plan.kind,
        guardPhases: [page.id],
        successHint: plan.successHint,
      },
      ...(plan.kind === 'create' || plan.kind === 'edit'
        ? [
            {
              id: verificationId,
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
  state.sitemap.flows.push(flow);
  state.saveSitemap();
  return flow;
}

export async function manualCommand(
  request: string,
  opts: { session?: Session; keepOpen?: boolean } = {},
): Promise<{ session: Session; failed: number; flow: Flow }> {
  const cleanRequest = request.trim();
  if (!cleanRequest) throw new Error('--manual requires a non-empty request');
  const session = opts.session ?? bootstrap();
  try {
    if (Object.keys(session.state.sitemap.pages).length === 0) {
      throw new Error('--manual needs an existing sitemap. Run an exhaustive exploration first.');
    }
    const plan = await planManualRequest(session.llm, session.state.sitemap, cleanRequest);
    const flow = upsertManualFlow(session.state, cleanRequest, plan);
    console.log(
      `[manual] ${plan.mode === 'existing-flow' ? 'using existing flow' : 'targeted mapped page'}: ` +
        `${flow.id} — ${flow.title}`,
    );
    const result = await testCommand({ session, keepOpen: true, only: [flow.id] });
    return { ...result, flow };
  } finally {
    if (!opts.keepOpen) teardown(session);
  }
}
