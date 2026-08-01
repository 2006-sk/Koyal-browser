import fs from 'node:fs';
import { parseJsonFromLlm, type LlmClient } from '../core/llm/client.js';

export interface SupervisorDecision {
  answer: string;
  reason: string;
}

function choicesFromQuestion(question: string): string[] {
  return [...question.matchAll(/\[([a-z0-9_-])\]([a-z0-9_-]*)/gi)].map(
    (match) => `${match[1]}${match[2]}`,
  );
}

function requestedPathPattern(question: string): RegExp | undefined {
  // Infer the requested type only from the prompt, never from suggestion
  // filenames. Production questions can offer all fixture types together.
  const requestText = question.split(/\n\s*suggestions\s*:/i, 1)[0] ?? question;
  return (
    /\b(?:reference video|video file|upload video|motion capture|reference motion)\b/i.test(requestText)
      ? /\.(?:mp4|mov|webm|m4v)$/i
      : /\b(?:character image|avatar image|image file|asset image|asset file|image[- ]upload|upload(?:ing)? (?:a |the )?(?:character |avatar |asset )?image|photo|logo|png|jpe?g|webp)\b/i.test(requestText)
        ? /\.(?:png|jpe?g|webp)$/i
        : /\b(?:pdf file|script file|upload(?:ing)? (?:a )?(?:pdf|script)|script|document|pdf)\b/i.test(requestText)
          ? /\.pdf$/i
          : /\b(?:audio|narration|music|song|wav|mp3|m4a)\b/i.test(requestText)
            ? /\.(?:wav|mp3|m4a|aac)$/i
            : undefined
  );
}

function existingSuggestedPaths(question: string): string[] {
  const paths = question
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/') && fs.existsSync(line));
  const requestedPattern = requestedPathPattern(question);
  return requestedPattern ? paths.filter((candidate) => requestedPattern.test(candidate)) : paths;
}

function suggestedValue(question: string): string | undefined {
  return question.match(/Suggestion[^:]*:\s*([^\n]+)/i)?.[1]?.trim();
}

function contextualBlankLabelSuggestion(question: string): string | undefined {
  if (!/field\s+"{2,}|field\s+""/i.test(question)) return undefined;
  const suggestion = suggestedValue(question);
  if (!suggestion) return undefined;
  if (
    /"wizard-edit-script"/i.test(question) &&
    (/^\[[^\]]+\]/.test(suggestion) || /[.!?…]/.test(suggestion))
  ) {
    return suggestion;
  }
  if (
    /"wizard-theme"/i.test(question) &&
    suggestion.split(/\s+/).length >= 10
  ) {
    return suggestion;
  }
  return undefined;
}

function replacementArtifactName(
  question: string,
  usedNames: Set<string>,
): string | undefined {
  if (!/\bsite rejected\b/i.test(question)) return undefined;
  if (!/\b(?:name|letters and spaces|a-z,?\s*A-Z)\b/i.test(question)) return undefined;
  const rejected = [...question.matchAll(/site rejected\s+"([^"]+)"/gi)]
    .map((match) => match[1].trim().toLowerCase());
  for (const value of rejected) usedNames.add(value);
  const candidates = [
    'Crimson Roadster',
    'Harbor Lantern',
    'Cedar Compass',
    'Silver Telescope',
    'Meadow Bicycle',
    'Copper Camera',
  ];
  const selected = candidates.find((candidate) => !usedNames.has(candidate.toLowerCase()));
  if (selected) usedNames.add(selected.toLowerCase());
  return selected;
}

function constrainedSingleName(
  question: string,
  usedNames: Set<string>,
): string | undefined {
  const artifactNameField =
    /field\s+"+[^"\n]*\b(?:enter the name|name(?: for)?)[^"\n]*"+/i.test(question);
  if (
    !artifactNameField ||
    !/(?:\bnew artifact is being created\b|\bsite rejected\b)/i.test(question)
  ) {
    return undefined;
  }
  const forbidden = new Set(
    [...question.matchAll(/(?:previous value \(do not reuse\)|rejected)\s*[:"]+\s*"?([^"\n]+)/gi)]
      .map((match) => match[1].trim().toLowerCase()),
  );
  for (const value of forbidden) usedNames.add(value);
  const suggestion = question.match(/Suggestion[^:]*:\s*([A-Za-z]+)/i)?.[1];
  const candidates = [
    suggestion,
    'NolanMercer',
    'PriyaKapoor',
    'ClaraBennett',
    'TheoSullivan',
    'MayaFernandez',
    'AdrianCole',
    'ElenaMarin',
    'FelixTurner',
    'LeahMorgan',
    'OwenParker',
  ].filter((value): value is string => Boolean(value));
  const selected = candidates.find((value) => {
    const normalized = value.toLowerCase();
    return /^[A-Za-z]+$/.test(value) && !forbidden.has(normalized) && !usedNames.has(normalized);
  });
  if (selected) usedNames.add(selected.toLowerCase());
  return selected;
}

/**
 * Production-only human companion. It answers the same structured questions a
 * person sees; it never drives the browser or bypasses the normal guard.
 */
export class ProductionPromptSupervisor {
  private readonly usedArtifactNames = new Set<string>();
  /**
   * A site confirmation often shortens a grounded control such as
   * "Remove character" to the context-free label "Remove". Remember only the
   * immediately pending character/asset cleanup so that the confirmation does
   * not fall back through the generic destructive-action denial.
   */
  private pendingHindranceCleanup = false;

  constructor(
    private readonly llm: LlmClient,
    private readonly captureVisualContext?: () => {
      screenshotPath: string;
      snapshot: string;
      url: string;
    },
  ) {}

  async answer(question: string): Promise<SupervisorDecision | undefined> {
    // Secrets are intentionally outside the supervisor channel. They must come
    // from site-scoped saved secrets or environment variables.
    if (/\b(?:enter|provide).{0,30}(?:password|passcode|token|secret|api key|credentials?)\b/i.test(question)) {
      return undefined;
    }

    // A scheduled agent has no authority to expand destructive scope. Explicit
    // standing approvals are consumed by Guard before a question reaches here.
    const destructiveQuestion =
      /looks destructive\/irreversible|about to click .{0,100}\b(?:delete|remove|destroy|pay|purchase|revoke)\b/i.test(
        question,
      );
    if (destructiveQuestion) {
      const label = question.match(/about to click "([^"]+)"/i)?.[1]?.trim() ?? '';
      const evidence = question.match(/current browser-agent evidence:\s*([\s\S]*?)(?:\[[yn]|$)/i)?.[1] ?? '';
      const cleanupEntity =
        /\b(?:character|avatar|asset|image|animal|media|slot|placeholder)\b/i.test(`${label} ${evidence}`);
      const isHindrance =
        /\b(?:empty|unused|unfinalized|incomplete|placeholder|extra|duplicate|stale|corrupt(?:ed)?|wrong|invalid|blocking|blocks|disabled|disables|prevent(?:s|ing)?|hindrance|required to (?:continue|advance)|cannot (?:continue|advance))\b/i.test(
          evidence,
        );
      const cleanupAction = /\b(?:remove|delete)\b/i.test(label);
      const genericConfirmation = /^(?:remove|delete|confirm|yes)$/i.test(label);
      const groundedHindranceCleanup =
        Boolean(evidence) && cleanupAction && cleanupEntity && isHindrance;
      const confirmsPendingCleanup =
        this.pendingHindranceCleanup && genericConfirmation && cleanupEntity && isHindrance;

      if (groundedHindranceCleanup || confirmsPendingCleanup) {
        // A specific trigger may be followed immediately by a generic site
        // confirmation. A generic confirmation consumes the authorization.
        this.pendingHindranceCleanup = !genericConfirmation;
        return {
          answer: 'yes',
          reason:
            'approved a browser-grounded character/asset cleanup that removes a concrete workflow hindrance',
        };
      }
      this.pendingHindranceCleanup = false;
      return { answer: 'no', reason: 'unattended safety floor denied an unallowlisted destructive action' };
    }
    // Confirmation authority is deliberately one-question wide. If the site
    // did not ask for a confirmation immediately, do not retain it.
    this.pendingHindranceCleanup = false;

    const paths = existingSuggestedPaths(question);
    if (/\blocal path\b/i.test(question)) {
      if (paths.length === 0) return undefined;
      const inferredType = requestedPathPattern(question);
      const distinctExtensions = new Set(paths.map((candidate) => candidate.match(/\.[^.]+$/)?.[0]?.toLowerCase()));
      if (inferredType || distinctExtensions.size === 1) {
        return { answer: paths[0], reason: 'selected an existing compatible suggested file' };
      }
      // Multiple offered file types and no reliable textual type: continue to
      // the vision fallback below. Its answer is still constrained to `paths`.
    }

    const singleName = constrainedSingleName(question, this.usedArtifactNames);
    if (singleName) {
      return {
        answer: singleName,
        reason: 'used a fresh realistic letters-only single name for the constrained artifact field',
      };
    }

    const replacementName = replacementArtifactName(question, this.usedArtifactNames);
    if (replacementName) {
      return {
        answer: replacementName,
        reason: 'rotated immediately to a different realistic constraint-safe artifact name after rejection',
      };
    }


    const contextualSuggestion = contextualBlankLabelSuggestion(question);
    if (contextualSuggestion) {
      return {
        answer: contextualSuggestion,
        reason: 'preserved the semantically grounded dialogue/theme value using the owning page context despite an empty accessibility label',
      };
    }

    const choices = choicesFromQuestion(question);
    if (/approve.{0,40}flows?/i.test(question) && choices.includes('all')) {
      return { answer: 'all', reason: 'approved the proposed non-destructive QA flow set' };
    }

    // A final audit explicitly saying that no creation/finalization/persistence
    // action was proven must not be softened into pass merely because an old
    // library item is visible. This is the exact production question a human
    // previously had to answer after an incomplete character run.
    if (
      /\bverdict\?/i.test(question) &&
      choices.includes('fail') &&
      /(?:did not prove|no (?:same-run |matching )?(?:creation|finali[sz]ation|persistence|terminal artifact) proof|without (?:a )?(?:created|saved|finalized|persisted) item)/i.test(question)
    ) {
      return {
        answer: 'fail',
        reason: 'audit evidence explicitly says the required same-run mutation or persistence was not proven',
      };
    }

    let visual:
      | { screenshotPath: string; snapshot: string; url: string }
      | undefined;
    if (this.captureVisualContext) {
      try {
        visual = this.captureVisualContext();
      } catch {
        // A screenshot failure must not disable the existing text supervisor.
      }
    }
    const image = visual && fs.existsSync(visual.screenshotPath)
      ? {
          data: fs.readFileSync(visual.screenshotPath).toString('base64'),
          mediaType: 'image/png' as const,
        }
      : undefined;
    const raw = await this.llm.complete({
      maxTokens: 250,
      image,
      messages: [
        {
          role: 'system',
          content:
            'You are AutoQA’s production prompt supervisor. Return one JSON object: ' +
            '{"answer":"...","reason":"..."}. Answer exactly the operational question. ' +
            'Use realistic, ordinary human names and semantically correct descriptions. ' +
            'Reject mismatched suggestions and choose a value that fits the named field. ' +
            'For uniqueness-constrained names, use a realistic name with a short natural suffix. ' +
            'For classifications, visible application errors and failed operations are failure; ' +
            'ordinary labels/help copy are noise; clear completion is success. Select only one ' +
            'offered choice when choices exist. Never invent credentials, secrets, file paths, ' +
            'or permissions. Never approve destructive/irreversible actions unless the question ' +
            'itself states they were explicitly pre-authorized.',
        },
        {
          role: 'user',
          content: [
            `Question:\n${question}`,
            choices.length ? `Allowed choices: ${choices.join(', ')}` : 'Free-text answer required.',
            paths.length ? `Allowed existing upload paths (choose exactly one, never invent another):\n${paths.join('\n')}` : '',
            visual ? `Current URL: ${visual.url}\nVisible accessibility state:\n${visual.snapshot.slice(0, 6000)}` : '',
          ].join('\n\n'),
        },
      ],
    });
    const decision = parseJsonFromLlm<Partial<SupervisorDecision>>(raw);
    const answer = decision.answer?.trim();
    if (!answer) return undefined;
    if (/\blocal path\b/i.test(question)) {
      if (!paths.includes(answer)) return undefined;
      return {
        answer,
        reason: decision.reason?.trim() ||
          (visual ? 'used current-page vision to select one allowed compatible upload' : 'selected one allowed upload'),
      };
    }
    if (choices.length > 0) {
      const chosen = choices.find((choice) => choice.toLowerCase() === answer.toLowerCase());
      if (!chosen) return undefined;
      return { answer: chosen, reason: decision.reason?.trim() || 'selected an offered choice' };
    }
    return { answer, reason: decision.reason?.trim() || 'answered the structured production prompt' };
  }
}
