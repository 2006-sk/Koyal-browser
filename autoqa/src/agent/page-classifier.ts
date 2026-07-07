import { LlmClient, parseJsonFromLlm } from '../core/llm/client.js';
import { config } from '../config.js';
import type { Flow, PageNode, SiteMap } from './sitemap.js';
import { normalizePath } from './sitemap.js';

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[truncated]`;
}

/** One LLM call per NEW page: classify it and tag its interactive elements. */
export async function classifyPage(
  llm: LlmClient,
  url: string,
  interactiveSnapshot: string,
): Promise<PageNode> {
  const prompt = `You are mapping a web app for automated QA. Classify this page.

URL: ${url}

Interactive accessibility snapshot:
${truncate(interactiveSnapshot, config.llm.snapshotMaxChars)}

Respond with JSON only:
{
  "id": "short-kebab-slug describing the page (e.g. login, projects-list, wizard-story-type)",
  "title": "short human title",
  "description": "1-2 sentences: what this page is for",
  "kind": "page|wizard-step|modal|processing|terminal|error",
  "detection": {
    "urlIncludes": "distinctive URL path fragment, or null if the URL is not distinctive",
    "snapshotAnyOf": ["2-4 distinctive text landmarks visible on this page"]
  },
  "requiresAuth": true/false,
  "sensitive": true/false (true only for payment/billing/account-settings pages),
  "interactives": [
    { "label": "accessible name", "role": "button|link|tab|textbox|...", "category": "nav|create|edit|submit|upload|destructive|unknown" }
  ],
  "optionGroups": [
    { "id": "slug", "memberLabels": ["exact accessible names of mutually-exclusive choices"], "primary": true/false }
  ]
}
Kind guidance: "wizard-step" = one screen of a multi-step creation flow (progress steps/dots, Next/Continue buttons, step labels); "modal" = a dialog overlaying a page (plan selection, confirmation); "processing" = dominated by loading/progress text (analyzing, generating, uploading, percent complete); "terminal" = a final artifact/completed state (download ready, success screen); "error" = an error state (something went wrong, retry); otherwise "page".
IMPORTANT for wizard-step/modal/processing/terminal/error: these often share a URL with sibling states, so snapshotAnyOf landmarks MUST be text distinctive to THIS state versus its siblings (step headings, unique button labels) — never generic app chrome.
optionGroups = groups of mutually-exclusive choice cards/tabs/radios on this screen (e.g. story types, art styles); "primary": true when picking one gates advancing. Omit or [] when none.
Category guidance: "nav" = pure navigation; "create" = creates content; "edit" = modifies content; "submit" = submits a form; "upload" = file upload trigger; "destructive" = deletes/pays/revokes/invites or anything irreversible. Include at most 20 interactives, prioritizing meaningful ones.`;

  const raw = await llm.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1500,
  });

  const parsed = parseJsonFromLlm<{
    id: string;
    title: string;
    description: string;
    kind?: string;
    detection: { urlIncludes?: string | null; snapshotAnyOf?: string[] };
    requiresAuth?: boolean;
    sensitive?: boolean;
    interactives?: Array<{ label: string; role: string; category: string }>;
    optionGroups?: Array<{ id?: string; memberLabels?: string[]; primary?: boolean }>;
  }>(raw);

  const now = new Date().toISOString();
  const kind = (
    ['page', 'wizard-step', 'modal', 'processing', 'terminal', 'error'].includes(parsed.kind ?? '')
      ? parsed.kind
      : 'page'
  ) as PageNode['kind'];

  return {
    id: (parsed.id || 'page').replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
    title: parsed.title ?? parsed.id ?? 'Untitled',
    description: parsed.description ?? '',
    kind,
    urlPatterns: [normalizePath(url)],
    detection: {
      urlIncludes: parsed.detection?.urlIncludes || undefined,
      snapshotAnyOf: parsed.detection?.snapshotAnyOf ?? [],
    },
    requiresAuth: parsed.requiresAuth ?? false,
    sensitive: parsed.sensitive ?? false,
    interactives: (parsed.interactives ?? []).slice(0, 20).map((i) => ({
      label: i.label,
      role: i.role,
      category: ([
        'nav',
        'create',
        'edit',
        'submit',
        'upload',
        'destructive',
      ].includes(i.category)
        ? i.category
        : 'unknown') as PageNode['interactives'][number]['category'],
    })),
    optionGroups: (parsed.optionGroups ?? [])
      .filter((g) => (g.memberLabels?.length ?? 0) >= 2)
      .slice(0, 5)
      .map((g, i) => ({
        id: (g.id || `group-${i + 1}`).replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
        memberLabels: g.memberLabels!.slice(0, 8),
        canonical: g.memberLabels![0],
        primary: g.primary ?? false,
        discoveredAt: now,
      })),
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

/** One LLM call at the end of exploration: propose end-to-end testable flows. */
export async function proposeFlows(llm: LlmClient, sitemapSummary: string): Promise<Flow[]> {
  const prompt = `You are designing end-to-end QA test flows for a web app that was just mapped.

Site map:
${sitemapSummary}

Propose 3-8 end-to-end flows a QA tester should walk, ordered by importance. Each flow is a sequence of milestones; each milestone is a natural-language goal a browser agent can execute (click/fill/upload — it will ask a human for file paths and credentials when needed). Include real content edits where the app supports them (the agent inserts unique marker text and verifies it appears). Prefer flows that end in a verifiable outcome.

Respond with JSON only:
{
  "flows": [
    {
      "id": "kebab-slug",
      "title": "short title",
      "description": "what this flow proves",
      "entryPageId": "page id where the flow starts",
      "entryUrl": "/path to open, if direct navigation works, else null",
      "milestones": [
        { "id": "m1", "goal": "natural-language instruction", "kind": "navigate|edit|create|upload|verify", "successHint": "SHORT LITERAL text fragment (2-6 words) expected to be VISIBLE ON THE PAGE after this milestone — it is substring-matched against the page snapshot, so it must be exact on-page wording (e.g. a heading or button label from the site map), NEVER a description of the outcome", "guardPhases": ["pageId that should be current after this milestone"] }
      ]
    }
  ]
}`;

  const raw = await llm.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 3000,
  });

  const parsed = parseJsonFromLlm<{
    flows?: Array<{
      id: string;
      title: string;
      description: string;
      entryPageId?: string;
      entryUrl?: string | null;
      milestones?: Array<{
        id: string;
        goal: string;
        kind?: string;
        successHint?: string;
        guardPhases?: string[];
      }>;
    }>;
  }>(raw);

  return (parsed.flows ?? []).map((f) => ({
    id: (f.id || 'flow').replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
    title: f.title ?? f.id,
    description: f.description ?? '',
    status: 'proposed' as const,
    entry: { pageId: f.entryPageId ?? '', url: f.entryUrl ?? undefined },
    milestones: (f.milestones ?? []).map((m, i) => ({
      id: m.id || `m${i + 1}`,
      goal: m.goal,
      kind: ([
        'navigate',
        'edit',
        'create',
        'upload',
        'verify',
      ].includes(m.kind ?? '')
        ? m.kind
        : 'navigate') as Flow['milestones'][number]['kind'],
      successHint: m.successHint,
      guardPhases: m.guardPhases,
    })),
  }));
}

/** Deterministic auth-gate heuristic; call the LLM only if genuinely ambiguous. */
export function looksLikeAuthGate(url: string, interactiveSnapshot: string): boolean {
  const snap = interactiveSnapshot.toLowerCase();
  const hasPassword = /textbox\s+"[^"]*password/i.test(interactiveSnapshot) || snap.includes('password');
  const hasLoginWords = /log ?in|sign ?in|sign ?up/.test(snap) || /login|signin|auth/.test(url.toLowerCase());
  return hasPassword && hasLoginWords;
}

/** Is the site currently asking for an emailed code / OTP? */
export function looksLikeOtpGate(interactiveSnapshot: string): boolean {
  return /verification code|one[- ]time|otp|code sent|enter the code|6[- ]digit/i.test(interactiveSnapshot);
}

export function makeSitemapHintList(sitemap: SiteMap): string[] {
  return sitemap.siteHints.slice(0, 10);
}
