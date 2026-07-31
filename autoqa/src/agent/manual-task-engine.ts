import type {
  Flow,
  FlowMilestone,
  ManualAcceptanceTask,
} from './sitemap.js';

export interface ManualTaskGraphInput {
  sourceFlow: Flow;
  checklist: string[];
  resolveTargetPageId: (requirement: string) => string | undefined;
  isPostTerminal: (requirement: string) => boolean;
}

export interface ManualTaskGraph {
  sourceFlowId: string;
  tasks: ManualAcceptanceTask[];
  constraints: string[];
}

function isConstraintOnly(requirement: string): boolean {
  const normalized = requirement.trim();
  // A clause such as "On the same Location feature, delete..." is still an
  // executable task even though it begins with context and ends in
  // "verify it". Keep the override deliberately narrow: broader mutation
  // matching would turn execution-policy clauses ("submit each only once")
  // and trailing finalize/verify prose into extra tasks.
  const hasExecutableMutation = /\b(?:delete|remove)\b/i.test(normalized);
  return (
    /^(?:do not|don't|never)\b/i.test(normalized) ||
    /^finish only\b/i.test(normalized) ||
    /^use the complete mapped\b.*\bflow\b/i.test(normalized) ||
    (
      !/^(?:click|submit|create|change|edit|add|upload|select|render|make|delete|remove)\b/i.test(
        normalized,
      ) &&
      /\b(?:only once|wait until|verify (?:it|the result)|when possible)\b/i.test(normalized) &&
      !hasExecutableMutation &&
      !/\b(?:create|change|edit|add|upload|select|click)\s+(?:a|an|one|the|exactly)\b/i.test(
        normalized,
      )
    )
  );
}

/**
 * A single LLM goal containing several independent controls on one screen tends
 * to stop after the first successful mutation. Turn an explicitly enumerated
 * "functions: A, B, C, and D" clause into one task per function so each gets
 * its own attempt, audit, evidence, and verdict. This is syntax-driven rather
 * than site-specific: the labels remain exactly as the user wrote them.
 */
export function splitIndependentFunctionItems(requirement: string): string[] {
  const match = requirement.match(/^(.*?\bfunctions?)\s*:?\s+(.+)$/i);
  if (!match || !match[2].includes(',')) return [requirement];
  const [list, suffix] = match[2].split(/\s*;\s*/, 2);
  const operations = list
    .replace(/,\s+and\s+/i, ', ')
    .split(/\s*,\s*/)
    .map((item) => item.replace(/^and\s+/i, '').trim())
    .filter(Boolean);
  if (operations.length < 3) return [requirement];
  const prefix = match[1]
    .replace(/\ball\s+(?:two|three|four|five|six|\d+)\s+/i, '')
    .replace(/\bfunctions\b/i, 'function');
  return operations.map(
    (operation) =>
      `${prefix}: ${operation}${suffix ? `; ${suffix}` : ''}`,
  );
}

/**
 * Split only clauses that clearly belong to different mapped pages. Lists of
 * related operations on one surface stay together (voice/emotion/dialogue);
 * cross-surface clauses (Story Theme + outfit) become independently schedulable.
 */
export function splitCrossPageAcceptanceItems(
  checklist: string[],
  resolveTargetPageId: (requirement: string) => string | undefined,
): string[] {
  return checklist.flatMap(splitIndependentFunctionItems).flatMap((requirement) => {
    // A lifecycle request can name one entity while requiring work on two
    // different mapped states: creation/editing in a builder and deletion in a
    // library. Keeping it as one task made the planner choose one page and then
    // guess controls that cannot exist there. Split only an explicit
    // "then delete/remove" boundary and carry the user's entity noun forward;
    // values, ordering, and the exact delete clause remain unchanged.
    const lifecycle = requirement.match(
      /^(.*?\b(location|character|asset|outfit|project)s?\b[\s\S]*?\bcreate\b[\s\S]*?)(?:,\s*|\s+)\bthen\s+(delete|remove)\s+([\s\S]+)$/i,
    );
    if (lifecycle) {
      const beforeDelete = lifecycle[1].trim().replace(/[,\s]+$/, '');
      const entity = lifecycle[2];
      const deletion = `On the same ${entity} feature, ${lifecycle[3]} ${lifecycle[4].trim()}`;
      const firstTarget = resolveTargetPageId(beforeDelete);
      const deletionTarget = resolveTargetPageId(deletion);
      if (firstTarget && deletionTarget && firstTarget !== deletionTarget) {
        return [beforeDelete, deletion];
      }
    }

    const parts = requirement
      .split(
        /\s+\band\b\s+(?:(?:later|then)\s+)?(?=(?:change|create|edit|test|add|use|click|verify|upload)\b)/i,
      )
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 2) return [requirement];
    const surfaceTokens = (value: string) =>
      new Set(
        (
          value
            .toLowerCase()
            .match(/\b(?:characters?|locations?|assets?|outfits?|projects?|scenes?|scripts?|audio|video)\b/g) ??
          []
        ).map((surface) => surface.replace(/s$/, '')),
      );
    const firstSurfaces = surfaceTokens(parts[0]);
    const laterSurfaces = new Set(parts.slice(1).flatMap((part) => [...surfaceTokens(part)]));
    if (
      /^(?:go\s+to|open|visit|navigate\s+to)\b/i.test(parts[0]) &&
      [...firstSurfaces].some((surface) => laterSurfaces.has(surface))
    ) {
      // "Go to Characters and create a character" is one atomic feature
      // task, not navigation to the library followed by an unrelated action.
      return [requirement];
    }
    const explicitSurface =
      /\b(story theme|outfits?|locations?|assets?|characters?|dialogue|script|styles?|scenes?|final video|uploads?)\b/i;
    if (parts.some((part) => !explicitSurface.test(part))) return [requirement];
    const targets = parts.map(resolveTargetPageId);
    if (targets.some((target) => !target) || new Set(targets).size < 2) {
      return [requirement];
    }
    return parts;
  });
}

/**
 * Compile the user's acceptance contract once. Dependencies are explicit and
 * intentionally small: pre-terminal work remains ordered, post-terminal work
 * waits for every pre-terminal task, and each post-terminal task is ordered.
 * The runtime therefore never needs the full request to decide what is next.
 */
export function compileManualTaskGraph(input: ManualTaskGraphInput): ManualTaskGraph {
  const tasks: ManualAcceptanceTask[] = [];
  const constraints: string[] = [];
  let previousPostTerminal: string | undefined;

  for (const [index, requirement] of input.checklist.entries()) {
    if (isConstraintOnly(requirement)) {
      constraints.push(requirement);
      continue;
    }
    const phase = input.isPostTerminal(requirement)
      ? 'post-terminal'
      : 'pre-terminal';
    const id = `acceptance-${index + 1}`;
    const referencedEntity = requirement.match(
      /\b(?:same|that|newly created|created earlier|previously created)\s+(?:newly created\s+)?(location|character|asset|outfit|project|scene|video)\b/i,
    )?.[1];
    const referencedPriorArtifact = tasks
      .slice()
      .reverse()
      .find(
        (task) =>
          (referencedEntity
            ? new RegExp(`\\b${referencedEntity}s?\\b`, 'i').test(task.requirement) &&
              /\b(?:create|add|upload|generate|make)\b/i.test(task.requirement)
            : false) ||
          (/\b(?:same asset|that asset|asset created earlier|previously created asset)\b/i.test(
              requirement,
            ) &&
            /\b(?:reusable asset|asset library|create.{0,30}asset)\b/i.test(
              task.requirement,
            )),
      );
    const artifactKey = referencedPriorArtifact
      ? referencedPriorArtifact.artifactKey ?? `artifact:${referencedPriorArtifact.id}`
      : undefined;
    if (referencedPriorArtifact && artifactKey) {
      referencedPriorArtifact.artifactKey = artifactKey;
      referencedPriorArtifact.artifactRole = 'producer';
    }
    const dependsOn = [
      ...(referencedPriorArtifact ? [referencedPriorArtifact.id] : []),
      ...(phase === 'post-terminal' && previousPostTerminal
        ? [previousPostTerminal]
        : []),
    ];
    tasks.push({
      id,
      requirement,
      targetPageId: input.resolveTargetPageId(requirement),
      phase,
      dependsOn: [...new Set(dependsOn)],
      artifactKey,
      artifactRole: referencedPriorArtifact ? 'consumer' : undefined,
    });
    if (phase === 'post-terminal') previousPostTerminal = id;
  }

  return { sourceFlowId: input.sourceFlow.id, tasks, constraints };
}

function journeyMilestone(
  source: FlowMilestone,
  index: number,
  destinationPageId?: string,
  remainingDestinationPageIds: string[] = [],
): FlowMilestone {
  const wasEdit = source.kind === 'edit';
  const destination = source.successHint
    ? ` until "${source.successHint}" is visible`
    : '';
  const branchGuidance =
    remainingDestinationPageIds.length > 0
      ? ` Preserve the mapped route's branch semantics. If this screen offers mutually exclusive paths, choose ` +
        `the path whose visible label or description is consistent with these upcoming mapped states: ` +
        `${remainingDestinationPageIds.join(' → ')}. Do not choose a branch that skips those states.`
      : '';
  return {
    ...structuredClone(source),
    kind: wasEdit ? 'navigate' : source.kind,
    manualJourneyDestinationPageId: destinationPageId,
    goal:
      `[JOURNEY CHECKPOINT ${index + 1}]\n` +
      (wasEdit
        ? `Preserve the acceptance-task changes already completed on this mapped state. Do not fill, edit, ` +
          `regenerate, or overwrite them. Satisfy only still-required non-mutating options, then use the unique ` +
          `safe forward control${destination}.${branchGuidance}`
        : source.goal) +
      '\n\n' +
      'Advance the primary mapped journey through visible safe controls. Complete only prerequisites required ' +
      'for this checkpoint. Do not revisit an earlier acceptance task and do not perform a later acceptance task. ' +
      'Stop as soon as this checkpoint or the next mapped state is visibly reached.',
  };
}

function taskMilestone(task: ManualAcceptanceTask, ordinal: number): FlowMilestone {
  const artifactIdentityGuidance =
    task.artifactRole === 'producer'
      ? '\nThis artifact is consumed by a later acceptance task. Preserve a stable reusable identity and source. ' +
        'Prefer a finalized, uniquely named library artifact that a later picker can select. Use an upload-backed ' +
        'creation only when this requirement or the visible consumer explicitly requires a file, and then retain ' +
        'the exact source path. Do not choose a creation method merely because it mentions uploading.'
      : task.artifactRole === 'consumer'
        ? '\nConsume the exact artifact produced by the dependency task. Match its visible name or reuse the exact ' +
          'same source file path. An unrelated file or merely similar artifact must remain unproven.'
        : '';
  return {
    id: `manual-task-${ordinal}`,
    kind: task.position === 'after-entry' ? 'verify' : 'navigate',
    manualContractAudit: true,
    manualContractItem: ordinal,
    manualContractTargetPageId: task.targetPageId,
    manualTaskId: task.id,
    goal:
      `[ACTIVE ACCEPTANCE TASK ${ordinal}]\n${task.requirement}\n\n` +
      'Work only on this task. Reuse same-run evidence if it already proves completion. Otherwise perform one ' +
      'bounded safe attempt, wait for genuine processing, and verify persistence. If the control is unavailable ' +
      'or the attempt has no effect, leave this task unproven and return control; do not retry it from later tasks. ' +
      'When the requirement names an artifact type and an upload/creation method, use the control inside that ' +
      "artifact's own section or slot; never substitute a separate assets, attachments, or media uploader." +
      artifactIdentityGuidance,
  };
}

function normalizedActionWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (word) =>
          word.length >= 3 &&
          !new Set([
            'the',
            'and',
            'for',
            'with',
            'this',
            'that',
            'then',
            'only',
            'once',
            'after',
            'before',
            'visible',
            'mapped',
            'journey',
            'checkpoint',
            'advance',
            'screen',
            'page',
          ]).has(word),
      ),
  );
}

/**
 * A task can own the same one-shot mutation as the following journey edge
 * (for example acceptance task "Click Create Video only once" and mapped
 * checkpoint "create video"). The journey must then verify the destination,
 * not submit the mutation a second time.
 */
function taskOwnsJourneyMutation(
  milestone: FlowMilestone,
  tasks: ManualAcceptanceTask[],
  sourceMilestone?: FlowMilestone,
): boolean {
  const mutationVerbs =
    /\b(create|generate|render|submit|publish|finalize|upload|save|apply|delete|remove|checkout|pay|send|place)\b/i;
  const sourceGoal = sourceMilestone?.goal ?? milestone.goal;
  if (!mutationVerbs.test(sourceGoal)) return false;
  const milestoneWords = normalizedActionWords(sourceGoal);
  return tasks.some((task) => {
    if (!mutationVerbs.test(task.requirement)) return false;
    const taskWords = normalizedActionWords(task.requirement);
    const shared = [...milestoneWords].filter(
      (word) => taskWords.has(word) && !mutationVerbs.test(word),
    );
    return shared.length > 0;
  });
}

function destinationOnlyJourneyMilestone(
  milestone: FlowMilestone,
): FlowMilestone {
  const destination = milestone.manualJourneyDestinationPageId;
  return {
    ...milestone,
    kind: 'verify',
    guardPhases: destination ? [destination] : milestone.guardPhases,
    goal:
      `${milestone.goal}\n\n` +
      'The active acceptance task already owns and performed this checkpoint’s primary mutation. Do not click, ' +
      'submit, generate, create, save, or retry that mutation again. Verify or wait for its mapped destination and ' +
      'result only. A concrete product error is a terminal blocker for this checkpoint, not permission to resubmit.',
  };
}

function milestoneTargetsPage(milestone: FlowMilestone, pageId: string): boolean {
  const familyTokens = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(
          (token) =>
            token.length >= 4 &&
            ![
              'wizard',
              'list',
              'page',
              'start',
              'content',
              'edit',
              'select',
              'final',
              'video',
              'character',
              'story',
            ].includes(token),
        ),
    );
  const targetFamily = familyTokens(pageId);
  const guardFamily = new Set(
    (milestone.guardPhases ?? []).flatMap((guard) => [...familyTokens(guard)]),
  );
  return (
    milestone.guardPhases?.includes(pageId) === true ||
    [...targetFamily].some((token) => guardFamily.has(token)) ||
    milestone.goal.toLowerCase().includes(pageId.toLowerCase().replace(/[-_]+/g, ' '))
  );
}

function isTerminalMilestone(milestone: FlowMilestone): boolean {
  return (
    milestone.kind === 'verify' ||
    /\b(final video|final rendered|terminal artifact|playable.{0,30}video)\b/i.test(
      `${milestone.goal} ${milestone.successHint ?? ''}`,
    )
  );
}

/**
 * Lower the task graph into today's Flow runner without giving the runner the
 * large original request. Tasks whose target occurs on the primary journey are
 * scheduled immediately after that state; side quests are placed before the
 * terminal boundary. Post-terminal tasks remain after terminal generation.
 */
export function lowerManualTaskGraph(
  sourceFlow: Flow,
  graph: ManualTaskGraph,
  options?: { requiresTerminalArtifact?: boolean },
): FlowMilestone[] {
  const journey = sourceFlow.milestones.map((milestone, index) =>
    journeyMilestone(
      milestone,
      index,
      sourceFlow.milestones[index + 1]?.guardPhases?.[0],
      sourceFlow.milestones
        .slice(index + 1)
        .flatMap((remaining) => remaining.guardPhases ?? [])
        .filter((pageId, destinationIndex, all) => all.indexOf(pageId) === destinationIndex)
        .slice(0, 6),
    ),
  );
  let terminalIndex = -1;
  journey.forEach((milestone, index) => {
    if (isTerminalMilestone(milestone)) terminalIndex = index;
  });
  const split = terminalIndex >= 0 ? terminalIndex : journey.length;
  const beforeTerminal = journey.slice(0, split);
  const terminalAndAfter = journey.slice(split);
  const pending = graph.tasks.filter((task) => task.phase === 'pre-terminal');
  const afterEntryTasks = pending.filter((task) => task.position === 'after-entry');
  const byId = new Map(pending.map((task) => [task.id, task]));
  const scheduled = new Set<string>();
  const lowered: FlowMilestone[] = [];
  const emitTaskWithDependencies = (task: ManualAcceptanceTask): void => {
    if (scheduled.has(task.id)) return;
    for (const dependencyId of task.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency) emitTaskWithDependencies(dependency);
    }
    lowered.push(taskMilestone(task, Number(task.id.split('-').at(-1))));
    scheduled.add(task.id);
  };

  for (const [milestoneIndex, milestone] of beforeTerminal.entries()) {
    const localTasks = pending.filter(
      (task) =>
        task.targetPageId &&
        milestoneTargetsPage(milestone, task.targetPageId),
    );
    const nextMilestone = beforeTerminal[milestoneIndex + 1];
    const nextUsesSameState =
      nextMilestone &&
      localTasks.some(
        (task) =>
          task.targetPageId &&
          milestoneTargetsPage(nextMilestone, task.targetPageId),
      );
    if (nextUsesSameState) {
      lowered.push(milestone);
      if (milestoneIndex === 0) {
        for (const task of afterEntryTasks) emitTaskWithDependencies(task);
      }
      continue;
    }
    // A local task may depend on a side quest that is not part of the primary
    // journey (for example create a reusable asset before Add Assets in scene
    // editing). Complete those dependencies before entering the dependent
    // journey state, then run the local task directly after that state.
    for (const task of localTasks) {
      for (const dependencyId of task.dependsOn) {
        const dependency = byId.get(dependencyId);
        if (dependency && !localTasks.includes(dependency)) {
          emitTaskWithDependencies(dependency);
        }
      }
    }
    for (const task of localTasks) {
      emitTaskWithDependencies(task);
    }
    lowered.push(
      taskOwnsJourneyMutation(
        milestone,
        localTasks,
        sourceFlow.milestones[milestoneIndex],
      )
        ? destinationOnlyJourneyMilestone(milestone)
        : milestone,
    );
    if (milestoneIndex === 0) {
      for (const task of afterEntryTasks) emitTaskWithDependencies(task);
    }
  }

  for (const task of pending) {
    emitTaskWithDependencies(task);
  }
  lowered.push(...terminalAndAfter);
  for (const task of graph.tasks.filter((item) => item.phase === 'post-terminal')) {
    lowered.push(taskMilestone(task, Number(task.id.split('-').at(-1))));
  }
  lowered.push({
    id: 'manual-task-final-proof',
    kind: 'verify',
    goal:
      '[FINAL TASK-GRAPH PROOF]\nRead-only verification. Individual acceptance-task verdicts are ' +
      'accumulated deterministically by the runner and must not be re-proved from this last screen. Verify only ' +
      (options?.requiresTerminalArtifact === false
        ? 'that the requested focused result remains visibly completed and persisted and that no visible global '
        : 'that the requested terminal artifact remains persisted, playable, and usable and that no visible global ') +
      'constraint is violated. Do not mutate or retry.',
  });
  return lowered;
}
