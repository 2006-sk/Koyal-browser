import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artifactIdentityForMilestone,
  boundaryConstrainedGoal,
  canDirectOpenManualTarget,
  exploratoryDirectedGoal,
  flowHasCompletionAction,
  isAlreadySatisfiedNavigationMilestone,
  isCredentialPreparationGoal,
  isSelectionShapedGoal,
  laterMilestoneStartingOnPage,
  manualSafeAheadIndex,
  manualJourneyPageIdForUrl,
  isManualFinalProofMilestone,
  isNonIdempotentManualMilestone,
  manualAuditEvidenceIssue,
  manualEvidenceSupportsItem,
  manualEntryNeedsContextRecovery,
  manualEntryExpectedControlLabels,
  manualJourneyDestinationIssue,
  manualEditRequiresZeroErrorSignals,
  manualFreshSignalBundle,
  manualVisualConcernIsHistoricalProductError,
  manualOperationalMutationVerified,
  manualRoundedUploadVerified,
  manualTaskGraphRepairIssue,
  manualVisualAssessmentFromActions,
  manualVisionAffirmsPersistedOutcome,
  mergeExplorerResults,
  manualContractRuntimeGuidance,
  manualEvidenceFromActions,
  manualEvidenceFromRecipeSteps,
  successfulMutationLabelsFromRecipeSteps,
  milestoneReturnsOnUrlChange,
  orderRunnableFlows,
  productionBinaryVerdict,
  skippedMilestoneVerdict,
  requiresPersistedCreation,
  recoveryGuardPageIds,
  shouldContinueAfterVerification,
  shouldRunMilestoneProbes,
  successfulMutationLabels,
} from './flow-runner.js';
import type { Flow, SiteMap } from './sitemap.js';
import type { SiteState } from './site-state.js';
import type { ExplorerResult } from '../core/explorer.js';
import type { TestStep } from '../core/types.js';

function flow(id: string, status: Flow['status'], phase?: 'learning' | 'replay-validation'): Flow {
  return {
    id,
    title: id,
    description: id,
    status,
    entry: { pageId: 'entry' },
    milestones: [],
    qualification: phase ? { phase } : undefined,
  };
}

test('production supervisor converts structurally skipped milestones to binary fail', () => {
  assert.equal(skippedMilestoneVerdict(true), 'fail');
  assert.equal(skippedMilestoneVerdict(false), 'needs-review');
});

test('a stale product-error tile is charged only to its originating manual task', () => {
  const visual = {
    status: 'concern' as const,
    summary: 'The final video is playable, but Shot 1 tile displays an Error state.',
    concerns: ['Shot 1 tile displays a red Error icon instead of a thumbnail.'],
  };
  const stale = 'video is not edited please try again later!!\nbutton "! Error"\nDownload Video';
  assert.equal(
    manualVisualConcernIsHistoricalProductError(visual, stale, `${stale}\nvideo time 0:05 / 0:10`),
    true,
  );
  assert.equal(
    manualVisualConcernIsHistoricalProductError(visual, 'Download Video', stale),
    false,
  );
});

test('manual edit tasks use zero-tolerance fresh error signals without changing ordinary flows', () => {
  const manual = flow('manual-edit', 'exploratory');
  manual.manualContract = {
    request: 'Edit one scene',
    checklist: ['Edit one scene'],
  };
  manual.manualExecution = {
    version: 1,
    sourceFlowId: 'source',
    primaryJourneyPageIds: ['edit-scenes'],
    tasks: [
      {
        id: 'acceptance-1',
        requirement: 'Edit one scene',
        phase: 'pre-terminal',
        dependsOn: [],
      },
    ],
    constraints: [],
    policy: {
      context: 'active-task',
      processing: 'manual-narrative-safe',
      recovery: 'bounded-modal-dismiss',
      probes: 'contract-only',
    },
  };
  assert.equal(
    manualEditRequiresZeroErrorSignals(manual, {
      id: 'manual-task-1',
      goal: 'Edit scene',
      kind: 'navigate',
      manualTaskId: 'acceptance-1',
    }),
    true,
  );
  assert.equal(
    manualEditRequiresZeroErrorSignals(flow('ordinary', 'exploratory'), {
      id: 'edit',
      goal: 'Edit scene',
      kind: 'edit',
    }),
    false,
  );
});

test('clean submitted manual mutations override semantic persistence ambiguity but never product errors', () => {
  const makeStep = (consoleErrors: Array<{ text: string; type: string }> = []): TestStep => ({
    workflow: 'manual:edit',
    action: 'edit dialogue',
    expected: 'healthy mutation',
    result: {
      verdict: 'needs-review',
      severity: 'medium',
      expected: 'healthy mutation',
      actual: 'Edit Script',
      signals: {
        url: 'https://example.test/script',
        title: 'Edit Script',
        snapshot: { raw: 'Edit Script', interactive: 'Edit Script' },
        pageErrors: [],
        consoleMessages: [],
        consoleErrors,
        networkRequests: [],
      },
      reasons: ['Visual review found a concrete concern: change not visibly persisted'],
      retried: false,
    },
    stepsToReproduce: [],
  });
  const item = 'perform one voice change, one emotion change, and one dialogue-text edit';
  const evidence = [
    'clicked "Character Voices"',
    'filled "description" with "Calm lower voice"',
    'clicked "Save"',
    'clicked "melancholy"',
    'filled "editable field" with "A revised dialogue line"',
    'clicked "Save"',
  ];
  assert.equal(manualOperationalMutationVerified(item, evidence, makeStep(), true), true);
  assert.equal(
    manualOperationalMutationVerified(
      item,
      evidence,
      makeStep([{ text: 'Failed to save dialogue', type: 'error' }]),
      true,
    ),
    false,
  );
  assert.equal(
    manualOperationalMutationVerified('Create and finalize one new asset', evidence, makeStep(), true),
    false,
    'creation outcomes retain strict persisted-artifact proof',
  );

  const staleErrorStep = makeStep();
  staleErrorStep.result.signals.snapshot = {
    raw: 'Final video\nvideo is not edited please try again later!!\nDownload Video',
    interactive: 'button "Download Video"',
  };
  assert.equal(
    manualOperationalMutationVerified(
      'Retake one scene with a concrete motion prompt',
      ['filled "motion prompt" with "slow zoom"', 'clicked "Retake Scene"'],
      staleErrorStep,
      true,
      'video is not edited please try again later!!',
    ),
    true,
    'an unchanged visible error from an earlier task cannot fail a later healthy mutation',
  );
  assert.equal(
    manualOperationalMutationVerified(
      'Retake one scene with a concrete motion prompt',
      ['filled "motion prompt" with "slow zoom"', 'clicked "Retake Scene"'],
      staleErrorStep,
      true,
      'Final video without an error',
    ),
    false,
    'a newly appearing visible error still blocks operational success',
  );

  const recurringNoiseStep = makeStep();
  recurringNoiseStep.result.verdict = 'fail';
  recurringNoiseStep.result.signals.pageErrors = [
    { message: 'WaveSurfer AbortError: signal is aborted without reason' },
    { message: 'PostHog recorder TypeError: Failed to fetch' },
  ];
  recurringNoiseStep.result.reasons = [
    'Uncaught page exceptions: WaveSurfer AbortError',
  ];
  const beforeSignals = {
    ...recurringNoiseStep.result.signals,
    pageErrors: [{ message: 'WaveSurfer AbortError: signal is aborted without reason' }],
  };
  assert.equal(
    manualOperationalMutationVerified(item, evidence, recurringNoiseStep, false, '', beforeSignals),
    true,
    'submitted operational evidence overrides a later explorer bookkeeping failure and recurring media/analytics noise',
  );
  assert.equal(
    manualOperationalMutationVerified(
      'Change Camera Angle to a clearly named perspective',
      ['clicked "Side Profile Camera at 90° to the side"', 'clicked "Apply Camera Angle"'],
      makeStep(),
      false,
    ),
    true,
    'a named camera option plus Apply is sufficient same-run operational evidence',
  );
  assert.equal(
    manualOperationalMutationVerified(
      'Add Reference using the supplied suitable media file',
      [
        'clicked "Add Reference"',
        'uploaded "/tmp/reference-motion.mp4"',
        'clicked "Add Video"',
      ],
      makeStep(),
      false,
    ),
    true,
    'a supplied reference upload plus Add Video is sufficient same-run operational evidence',
  );

  const freshProductErrorStep = makeStep();
  freshProductErrorStep.result.verdict = 'fail';
  freshProductErrorStep.result.signals.pageErrors = [
    { message: 'Failed to save dialogue' },
  ];
  assert.equal(
    manualOperationalMutationVerified(item, evidence, freshProductErrorStep, true, '', {
      ...freshProductErrorStep.result.signals,
      pageErrors: [],
    }),
    false,
    'a genuinely new product exception remains a failure',
  );

  const serverFailureStep = makeStep();
  serverFailureStep.result.verdict = 'fail';
  serverFailureStep.result.signals.networkRequests = [
    { url: 'https://example.test/api/dialogue', status: 500 },
  ];
  assert.equal(
    manualOperationalMutationVerified(item, evidence, serverFailureStep, true, '', {
      ...serverFailureStep.result.signals,
      networkRequests: [],
    }),
    false,
    'a new 5xx remains a failure',
  );
});

test('manual fresh-signal classification removes cumulative teardown noise but preserves new failures', () => {
  const baseline = {
    url: 'https://example.test/theme',
    title: 'Theme',
    snapshot: { raw: 'Theme', interactive: 'button "Next"' },
    pageErrors: [
      { message: 'WaveSurfer AbortError: signal is aborted without reason' },
      { message: 'An older application exception' },
    ],
    consoleMessages: [],
    consoleErrors: [],
    networkRequests: [{ url: 'https://example.test/old', status: 500 }],
  };
  const after = {
    ...baseline,
    pageErrors: [
      ...baseline.pageErrors,
      { message: 'PostHog recorder TypeError: Failed to fetch' },
      { message: 'Failed to save theme' },
    ],
    networkRequests: [
      ...baseline.networkRequests,
      { url: 'https://example.test/healthy', status: 200 },
      { url: 'https://example.test/new', status: 503 },
    ],
  };
  const fresh = manualFreshSignalBundle(after, baseline);
  assert.deepEqual(fresh.pageErrors, [{ message: 'Failed to save theme' }]);
  assert.deepEqual(
    fresh.networkRequests.map((request) => [request.url, request.status]),
    [
      ['https://example.test/healthy', 200],
      ['https://example.test/new', 503],
    ],
  );
});

test('tiny accepted upload wins over a rounded 0.00 MB visual concern', () => {
  const step: TestStep = {
    workflow: 'manual:upload',
    action: 'upload supplied PDF',
    expected: 'attached PDF',
    result: {
      verdict: 'needs-review',
      severity: 'medium',
      expected: 'attached PDF',
      actual: 'test-script-5-second.pdf 0.00 MB Next',
      signals: {
        url: 'https://example.test/upload',
        title: 'Upload',
        snapshot: {
          raw: 'test-script-5-second.pdf 0.00 MB\nbutton "Next"',
          interactive: 'button "Next"',
        },
        pageErrors: [],
        consoleMessages: [],
        consoleErrors: [],
        networkRequests: [],
      },
      reasons: ['Visual review found a concrete concern: size shows 0.00 MB'],
      retried: false,
      visualAssessment: {
        status: 'concern',
        summary: 'The attached PDF size shows 0.00 MB.',
        concerns: ['The file size shows 0.00 MB.'],
      },
    },
    stepsToReproduce: [],
  };
  const item = 'upload the PDF file supplied by the production supervisor';
  const evidence = ['uploaded "/tmp/test-script-5-second.pdf"'];
  assert.equal(manualRoundedUploadVerified(item, evidence, step, true), true);
  step.result.signals.snapshot.raw += '\nbutton "Next" disabled';
  assert.equal(manualRoundedUploadVerified(item, evidence, step, true), false);
});

test('credential preparation is distinct from submitting a login', () => {
  assert.equal(isCredentialPreparationGoal('Fill EMAIL and PASSWORD with valid credentials'), true);
  assert.equal(isCredentialPreparationGoal('Fill EMAIL and PASSWORD, then click SIGN IN'), false);
  assert.equal(isCredentialPreparationGoal('Click SIGN IN to authenticate'), false);
});

test('successful deterministic replay prefix remains manual audit evidence after fallback', () => {
  assert.deepEqual(
    manualEvidenceFromRecipeSteps([
      { kind: 'click', label: 'Upload image', role: 'button' },
      { kind: 'upload', assetPath: '/tmp/avatar.png' },
      { kind: 'fill', hint: 'Character name', value: 'Rosalind' },
    ]),
    [
      'clicked "Upload image"',
      'uploaded "/tmp/avatar.png"',
      'filled "Character name" with "Rosalind"',
    ],
  );
  assert.deepEqual(
    successfulMutationLabelsFromRecipeSteps([
      { kind: 'click', label: 'Upload image', role: 'button' },
      { kind: 'upload', assetPath: '/tmp/avatar.png' },
      { kind: 'click', label: 'Finalize Character', role: 'button' },
      { kind: 'click', label: 'Next', role: 'button' },
    ]),
    ['Upload image', 'Finalize Character'],
  );
});

test('manual recovery accepts the next audit mapped target when guard phases were omitted', () => {
  assert.deepEqual(
    recoveryGuardPageIds({
      id: 'manual-task-8',
      goal: 'Edit the story theme',
      kind: 'edit',
      manualContractTargetPageId: 'wizard-theme',
    }),
    ['wizard-theme'],
  );
  assert.deepEqual(
    recoveryGuardPageIds({
      id: 'm4',
      goal: 'Advance',
      kind: 'navigate',
      guardPhases: ['wizard-edit-script'],
    }),
    ['wizard-edit-script'],
  );
});

test('focused manual entry detects missing active-item context without matching ordinary empty states', () => {
  assert.equal(
    manualEntryNeedsContextRecovery('Error: projectId is not allowed to be empty'),
    true,
  );
  assert.equal(manualEntryNeedsContextRecovery('No project selected'), true);
  assert.equal(manualEntryNeedsContextRecovery('Select a workspace first'), true);
  assert.equal(
    manualEntryNeedsContextRecovery('This project has no scenes yet. Create Video is disabled.'),
    false,
  );
});

test('manual context recovery names mapped feature controls instead of accepting a generic summary', () => {
  assert.deepEqual(
    manualEntryExpectedControlLabels({
      id: 'final-video',
      title: 'Final Video',
      description: '',
      kind: 'processing',
      urlPatterns: ['/finalvideo'],
      detection: { snapshotAnyOf: [] },
      requiresAuth: true,
      sensitive: false,
      interactives: [
        { label: 'Dashboard', role: 'button', category: 'nav' },
        { label: 'Retake', role: 'button', category: 'edit' },
        { label: 'Add Reference', role: 'button', category: 'edit' },
        { label: 'Reframe', role: 'button', category: 'edit' },
        { label: 'Submit Edit', role: 'button', category: 'submit' },
      ],
      optionGroups: [],
      firstSeenAt: '',
      lastSeenAt: '',
    }),
    ['Retake', 'Add Reference', 'Reframe', 'Submit Edit'],
  );
});

test('flows run deterministic first, replay-validation second, learning last', () => {
  const ordered = orderRunnableFlows([
    flow('learning-a', 'exploratory', 'learning'),
    flow('deterministic', 'deterministic'),
    flow('replay', 'exploratory', 'replay-validation'),
    flow('learning-b', 'exploratory', 'learning'),
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ['deterministic', 'replay', 'learning-a', 'learning-b']);
});

test('later wizard states fast-forward exploratory and replay flows without mistaking initial entry', () => {
  const candidate: Flow = {
    id: 'video',
    title: 'Video',
    description: '',
    status: 'exploratory',
    entry: { pageId: 'upload' },
    milestones: [
      { id: 'm1', goal: 'Upload', kind: 'upload', guardPhases: ['upload'] },
      { id: 'm2', goal: 'Choose type', kind: 'edit', guardPhases: ['story-type'] },
      { id: 'm3', goal: 'Edit scenes', kind: 'edit', guardPhases: ['edit-scenes'] },
      { id: 'm4', goal: 'Verify video', kind: 'verify', guardPhases: ['final-video'] },
    ],
  };
  assert.equal(
    laterMilestoneStartingOnPage(candidate, 0, 'edit-scenes', false),
    2,
  );
  assert.equal(
    laterMilestoneStartingOnPage(candidate, 0, 'upload', true),
    -1,
  );
});

test('task-graph fast-forward never skips pending tasks but still accepts a completed render transition', () => {
  const candidate: Flow = {
    id: 'manual-video',
    title: 'Manual video',
    description: '',
    status: 'exploratory',
    entry: { pageId: 'upload' },
    milestones: [
      { id: 'journey-upload', goal: 'Upload', kind: 'upload', guardPhases: ['upload'] },
      {
        id: 'manual-task-1',
        goal: 'Edit scenes',
        kind: 'navigate',
        manualTaskId: 'acceptance-1',
      },
      { id: 'journey-scenes', goal: 'Advance', kind: 'navigate', guardPhases: ['edit-scenes'] },
      { id: 'manual-create-video', goal: 'Create video', kind: 'navigate', manualTaskId: 'acceptance-2' },
      { id: 'journey-render', goal: 'Advance render', kind: 'navigate', guardPhases: ['edit-scenes'] },
      { id: 'terminal', goal: 'Verify', kind: 'verify', guardPhases: ['final-video'] },
    ],
    manualExecution: {
      version: 1,
      sourceFlowId: 'source',
      primaryJourneyPageIds: ['upload', 'edit-scenes', 'final-video'],
      tasks: [],
      constraints: [],
      policy: {
        context: 'active-task',
        processing: 'manual-narrative-safe',
        recovery: 'bounded-modal-dismiss',
        probes: 'contract-only',
      },
    },
  };
  assert.equal(manualSafeAheadIndex(candidate, 0, 2), 0);
  assert.equal(manualSafeAheadIndex(candidate, 4, 5), 5);
  assert.equal(isManualFinalProofMilestone({ id: 'manual-task-final-proof', goal: '', kind: 'verify' }), true);
  assert.equal(isManualFinalProofMilestone({ id: 'manual-contract-final-proof', goal: '', kind: 'verify' }), true);
  assert.equal(
    isManualFinalProofMilestone({
      id: 'manual-task-1',
      goal: 'Create and persist a character, then verify it exists',
      kind: 'verify',
    }),
    false,
  );
  assert.equal(
    canDirectOpenManualTarget(candidate, 'edit-scenes', new Set(['upload'])),
    false,
  );
  assert.equal(
    canDirectOpenManualTarget(
      candidate,
      'edit-scenes',
      new Set(['upload']),
      'wizard',
      'final-video',
    ),
    true,
  );
  assert.equal(
    canDirectOpenManualTarget(
      candidate,
      'edit-scenes',
      new Set(['upload', 'edit-scenes']),
    ),
    true,
  );
  assert.equal(
    canDirectOpenManualTarget(candidate, 'assets-list', new Set(['upload'])),
    true,
  );
  assert.match(
    manualJourneyDestinationIssue(
      candidate,
      {
        id: 'journey-style',
        goal: 'Advance',
        kind: 'navigate',
        manualJourneyDestinationPageId: 'edit-scenes',
      },
      'script-edit',
    ) ?? '',
    /did not reach required mapped state "edit-scenes"/,
  );
  assert.equal(
    manualJourneyDestinationIssue(
      candidate,
      {
        id: 'journey-style',
        goal: 'Advance',
        kind: 'navigate',
        manualJourneyDestinationPageId: 'edit-scenes',
      },
      'edit-scenes',
    ),
    undefined,
  );
  assert.equal(
    manualJourneyDestinationIssue(
      candidate,
      {
        id: 'journey-upload',
        goal: 'Advance',
        kind: 'navigate',
        manualJourneyDestinationPageId: 'upload',
      },
      'final-video',
    ),
    undefined,
    'a later ordered journey state proves the earlier destination was crossed',
  );
  assert.match(
    manualJourneyDestinationIssue(
      candidate,
      {
        id: 'journey-final',
        goal: 'Advance',
        kind: 'navigate',
        manualJourneyDestinationPageId: 'final-video',
      },
      'upload',
    ) ?? '',
    /did not reach required mapped state "final-video"/,
    'an earlier state must not satisfy a later destination',
  );
});

test('focused manual stateful targets recover through visible UI instead of direct URL', () => {
  const focused: Flow = {
    ...flow('manual-focused', 'exploratory', 'learning'),
    manualExecution: {
      version: 1,
      sourceFlowId: 'focused:final-video',
      primaryJourneyPageIds: ['final-video'],
      tasks: [],
      constraints: [],
      policy: {
        context: 'active-task',
        processing: 'manual-narrative-safe',
        recovery: 'bounded-modal-dismiss',
        probes: 'contract-only',
      },
    },
  };
  assert.equal(
    canDirectOpenManualTarget(
      focused,
      'final-video',
      new Set(['final-video']),
      'processing',
    ),
    false,
  );
  assert.equal(
    canDirectOpenManualTarget(
      focused,
      'projects',
      new Set(['projects']),
      'page',
    ),
    true,
  );
});

test('manual no-op completion is enabled only by evidence matching the active task', () => {
  const evidence = [
    'clicked "New Project"',
    'clicked "Start with Script"',
    'uploaded "/tmp/script.pdf"',
  ];
  assert.equal(
    manualEvidenceSupportsItem(
      'Start one genuinely new project through Dashboard to New Project',
      evidence,
    ),
    true,
  );
  assert.equal(
    manualEvidenceSupportsItem('Upload the script file I provide', evidence),
    true,
  );
  assert.equal(
    manualEvidenceSupportsItem('Create three distinct characters', evidence),
    false,
  );
});

test('single-screen click milestones cannot consume the next form', () => {
  const constrained = boundaryConstrainedGoal(
    'On "Outfits": click "CREATE OUTFIT", then advance one screen.',
  );
  assert.match(constrained, /stop as soon as the click reveals/i);
  assert.match(constrained, /Do not fill, select, generate, save, or submit/i);
  assert.equal(
    boundaryConstrainedGoal('Fill the outfit description, then advance one screen.'),
    'Fill the outfit description, then advance one screen.',
  );
});

test('exploratory milestone receives the whole directed flow mission and remaining checkpoints', () => {
  const candidate: Flow = {
    id: 'audio-video',
    title: 'Audio upload to final video',
    description: 'Create a playable rendered video from an uploaded audio file.',
    status: 'exploratory',
    entry: { pageId: 'upload' },
    milestones: [
      { id: 'm1', goal: 'Upload an audio file', kind: 'upload' },
      { id: 'm2', goal: 'Select Character Driven and click Next', kind: 'create' },
      { id: 'm3', goal: 'Verify the playable final video', kind: 'verify' },
    ],
  };
  const directed = exploratoryDirectedGoal(candidate, candidate.milestones[1], 1);
  assert.match(directed, /milestone wording as the next checkpoint and a guide, not a brittle literal script/i);
  assert.match(directed, /Complete any visible, safe prerequisite required to move forward/i);
  assert.match(directed, /Verify the playable final video/i);
  assert.match(directed, /Remaining directed checkpoints:\n3\. Verify the playable final video/i);
  assert.match(directed, /remaining checkpoints are orientation only/i);
  assert.match(directed, /do not execute a later checkpoint in this call/i);

  const verifyDirected = exploratoryDirectedGoal(candidate, candidate.milestones[2], 2);
  assert.match(verifyDirected, /This is a verification checkpoint/i);
  assert.match(verifyDirected, /do not start, create, regenerate, save, finalize, upload, or submit/i);
});

test('post-verification recovery is requested for unfinished automation but not concrete product errors', () => {
  const makeStep = (
    verdict: TestStep['result']['verdict'],
    snapshot = '',
    consoleErrors: Array<{ text: string; type: string }> = [],
  ): TestStep => ({
    workflow: 'flow:m1',
    action: 'advance',
    expected: 'next state',
    result: {
      verdict,
      severity: 'medium',
      expected: 'next state',
      actual: snapshot,
      signals: {
        url: 'https://example.test/wizard',
        title: 'Wizard',
        snapshot: { raw: snapshot, interactive: snapshot },
        pageErrors: [],
        consoleMessages: [],
        consoleErrors,
        networkRequests: [],
      },
      reasons: verdict === 'pass' ? [] : ['Expected snapshot to include one of: Next state'],
      retried: false,
    },
    stepsToReproduce: [],
  });
  const unfinishedExplorer: ExplorerResult = {
    goal: 'advance',
    success: false,
    actions: [],
    stepsTaken: ['state cycle'],
    finalUrl: 'https://example.test/wizard',
    finalSnapshot: 'Next',
    error: 'state cycle',
  };

  assert.equal(
    shouldContinueAfterVerification(makeStep('needs-review'), unfinishedExplorer, {
      loginShaped: false,
      creationMustPersist: false,
      completionActionSeen: false,
    }),
    true,
  );
  assert.equal(
    shouldContinueAfterVerification(
      makeStep('fail', 'Failed to generate image', [
        { text: 'Error: generation request failed', type: 'error' },
      ]),
      unfinishedExplorer,
      {
        loginShaped: false,
        creationMustPersist: true,
        completionActionSeen: true,
      },
    ),
    false,
  );

  const disappearedForm = makeStep('needs-review');
  disappearedForm.result.reasons = [
    'Visual review found a concrete concern: the creation input is no longer visible on the healthy gallery page',
  ];
  disappearedForm.result.visualAssessment = {
    status: 'concern',
    summary: 'The creation textarea is absent after the successful transition to the gallery.',
    concerns: ['No textarea is visible.'],
  };
  assert.equal(
    shouldContinueAfterVerification(disappearedForm, null, {
      loginShaped: false,
      creationMustPersist: false,
      completionActionSeen: true,
    }),
    false,
  );
});

test('production binary verdict passes operation-specific success and fails unresolved audits', () => {
  const milestone: Flow['milestones'][number] = {
    id: 'retake',
    goal: 'Retake one scene and verify the updated video is playable',
    kind: 'edit',
  };
  assert.equal(
    productionBinaryVerdict({
      current: 'needs-review',
      milestone,
      explorerSucceeded: true,
      explorerSteps: ['Retake completed; player is actively playing and scrubber advancing'],
      visual: {
        status: 'concern',
        summary: 'An older unrelated shot still says Error.',
        concerns: ['Old shot error remains visible.'],
      },
    }),
    'pass',
  );
  assert.equal(
    productionBinaryVerdict({
      current: 'needs-review',
      milestone,
      explorerSucceeded: false,
      explorerSteps: ['No Reshoot control produced a state change'],
      manualAuditIssue: 'Manual audit lacks distinct persisted evidence for Reshoot',
    }),
    'fail',
  );
});

test('production binary verdict accepts clear read-only terminal proof', () => {
  assert.equal(
    productionBinaryVerdict({
      current: 'needs-review',
      milestone: { id: 'proof', goal: 'Verify terminal video', kind: 'verify' },
      explorerSucceeded: false,
      visual: {
        status: 'clear',
        summary: 'The final video is playable and Download Video is enabled.',
        concerns: [],
      },
    }),
    'pass',
  );
});

test('explorer continuation preserves successful actions and final result for recipe learning', () => {
  const first: ExplorerResult = {
    goal: 'create video',
    success: false,
    actions: [{ action: 'click', ref: 'e1', resolvedLabel: 'Next' }],
    stepsTaken: ['clicked Next'],
    finalUrl: 'https://example.test/theme',
    finalSnapshot: 'Theme',
    error: 'checkpoint not verified',
  };
  const second: ExplorerResult = {
    goal: 'continue',
    success: true,
    actions: [{ action: 'click', ref: 'e2', resolvedLabel: 'Create Video' }],
    stepsTaken: ['clicked Create Video', 'final artifact visible'],
    finalUrl: 'https://example.test/final',
    finalSnapshot: 'Download video',
  };
  const merged = mergeExplorerResults(first, second);
  assert.equal(merged.success, true);
  assert.deepEqual(merged.actions.map((action) => action.resolvedLabel), ['Next', 'Create Video']);
  assert.equal(merged.finalUrl, second.finalUrl);
  assert.equal(merged.error, undefined);
  assert.match(merged.stepsTaken.join('\n'), /post-verification exploratory continuation/);
});

test('post-verification continuation inherits only successful mutation labels', () => {
  const result: ExplorerResult = {
    goal: 'create outfit',
    success: false,
    actions: [
      { action: 'click', ref: 'e1', resolvedLabel: 'TRY OUTFIT' },
      { action: 'click', ref: 'e2', resolvedLabel: 'Next' },
      { action: 'click', ref: 'e3', resolvedLabel: 'Finalize Asset', executionFailed: true },
      { action: 'fill', ref: 'e4', value: 'A navy suit' },
    ],
    stepsTaken: [],
    finalUrl: 'https://example.test/outfits',
    finalSnapshot: 'Processing',
  };
  assert.deepEqual(successfulMutationLabels(result), ['TRY OUTFIT']);
});

test('flow-runner self-healing uses the same URL boundary for click and fill milestones', () => {
  assert.equal(
    milestoneReturnsOnUrlChange('Click Next, then advance one screen.'),
    true,
  );
  assert.equal(
    milestoneReturnsOnUrlChange('Fill the transcript, then advance one screen.'),
    true,
  );
  assert.equal(
    milestoneReturnsOnUrlChange('Create a complete video through final rendering.'),
    false,
  );
});

test('story type is a selection noun, not a request to type marker text', () => {
  assert.equal(
    isSelectionShapedGoal("Select the 'Character Driven' story type and click Next."),
    true,
  );
  assert.equal(
    isSelectionShapedGoal("Select a category and type text into the Notes field."),
    false,
  );
  assert.equal(
    isSelectionShapedGoal('Adjust Character Voices and verify the selection persists.'),
    true,
  );
});

test('pure navigation already at its grounded destination becomes a no-op', () => {
  assert.equal(
    isAlreadySatisfiedNavigationMilestone(
      {
        id: 'm2',
        goal: 'Advance to the story type wizard step.',
        kind: 'navigate',
        guardPhases: ['wizard-story-type'],
      },
      'wizard-story-type',
    ),
    true,
  );
  assert.equal(
    isAlreadySatisfiedNavigationMilestone(
      {
        id: 'm5',
        goal: 'Advance through theme, style, locations and reach Edit scenes; wait for scenes.',
        kind: 'navigate',
        guardPhases: ['wizard-story-theme'],
      },
      'wizard-story-theme',
    ),
    false,
  );
  assert.equal(
    isAlreadySatisfiedNavigationMilestone(
      {
        id: 'm3',
        goal:
          'The active acceptance task already owns and performed this checkpoint’s primary mutation. ' +
          'Verify or wait for its mapped destination and result only.',
        kind: 'verify',
        guardPhases: ['wizard-edit-script'],
        manualJourneyDestinationPageId: 'wizard-edit-script',
      },
      'wizard-edit-script',
    ),
    true,
  );
});

test('only the final milestone of a creation flow carries artifact-persistence proof', () => {
  const candidate: Flow = {
    id: 'create-character',
    title: 'Create a character',
    description: 'Generate and save a character',
    status: 'exploratory',
    entry: { pageId: 'characters' },
    milestones: [
      { id: 'm1', goal: 'Click NEW CHARACTER', kind: 'create' },
      { id: 'm2', goal: 'Fill details and generate', kind: 'edit' },
      { id: 'm3', goal: 'Verify the character appears in the gallery', kind: 'verify' },
    ],
  };
  assert.equal(requiresPersistedCreation(candidate, candidate.milestones[0]), false);
  assert.equal(requiresPersistedCreation(candidate, candidate.milestones[1]), false);
  assert.equal(requiresPersistedCreation(candidate, candidate.milestones[2]), true);
});

test('contextual repeated-card mutation supplies the artifact identity to vision', () => {
  assert.equal(
    artifactIdentityForMilestone({
      id: 'm1',
      goal:
        'On "Your Assets": click "REGENERATE (Wayfinder Compass)" once, then wait until the named item is visibly finished and usable.',
      kind: 'verify',
    }),
    'Wayfinder Compass',
  );
  assert.equal(
    artifactIdentityForMilestone(
      {
        id: 'm2',
        goal: 'Finalize the new character',
        kind: 'verify',
      },
      'Leona',
    ),
    'Leona',
  );
});

test('a final verification milestone may rely on a prior creation recipe for completion proof', () => {
  const candidate: Flow = {
    id: 'create-character',
    title: 'Create a character',
    description: 'Generate and save a character',
    status: 'exploratory',
    entry: { pageId: 'characters' },
    milestones: [
      { id: 'm1', goal: 'Open the form', kind: 'create' },
      { id: 'm2', goal: 'Generate and finalize', kind: 'edit' },
      { id: 'm3', goal: 'Verify the character appears', kind: 'verify' },
    ],
  };
  const state = {
    recipes: {
      'flow:create-character:m2': {
        id: 'flow:create-character:m2',
        goal: 'Generate and finalize',
        steps: [{ kind: 'click', label: 'Finalize character' }],
        successCheck: {},
        stats: { successes: 0, failures: 0 },
      },
      'flow:create-character:m3': {
        id: 'flow:create-character:m3',
        goal: 'Verify',
        steps: [],
        successCheck: {},
        stats: { successes: 0, failures: 0 },
      },
    },
  } as unknown as SiteState;
  assert.equal(flowHasCompletionAction(candidate, state, null), true);
});

test('manual action evidence survives an incomplete milestone and excludes failed actions', () => {
  assert.deepEqual(
    manualEvidenceFromActions([
      {
        action: 'fill',
        value: 'This tea is wonderful.',
        resolvedLabel: 'Dialogue',
        reason: 'edit spoken text',
      },
      {
        action: 'click',
        resolvedLabel: 'Save',
        reason: 'persist dialogue edit',
      },
      {
        action: 'click',
        resolvedLabel: 'Save',
        executionFailed: true,
      },
      {
        action: 'fail',
        reason: 'collapsed summary looked stale',
      },
    ]),
    [
      'filled "Dialogue" with "This tea is wonderful."',
      'clicked "Save"',
    ],
  );
});

test('manual audits do not confuse characters with reusable assets', () => {
  const item =
    'Create exactly one new reusable asset, verify it is finalized in the asset library, and later add that same asset to a generated scene';
  const characterOnly = [
    'clicked "Create AI Avatar"',
    'clicked "Finalize character"',
    'clicked "Save All"',
  ];
  assert.match(
    manualAuditEvidenceIssue(item, characterOnly, 'Assets Collection') ?? '',
    /reusable library asset/,
  );

  const complete = [
    ...characterOnly,
    'clicked "Add Asset"',
    'uploaded "/tmp/roadster.png"',
    'clicked "Finalize Asset"',
    'clicked "Add Assets"',
    'uploaded "/tmp/roadster.png"',
  ];
  assert.equal(manualAuditEvidenceIssue(item, complete, 'Your Assets'), undefined);
});

test('manual supplied-file audit rejects a built-in sample and requires the expected upload type', () => {
  const item = 'Upload the audio file I provide';
  assert.match(
    manualAuditEvidenceIssue(
      item,
      ['clicked "Select Sample"', 'clicked "APT | Bruno Mars"'],
      'APT | Bruno Mars.mp3',
    ) ?? '',
    /user-supplied file.+built-in sample/i,
  );
  assert.equal(
    manualAuditEvidenceIssue(
      item,
      ['uploaded "/tmp/narration.wav"'],
      'narration.wav',
    ),
    undefined,
  );
  assert.match(
    manualAuditEvidenceIssue(
      item,
      ['uploaded "/tmp/avatar.png"'],
      'avatar.png',
    ) ?? '',
    /user-supplied file/i,
  );
});

test('manual location audit accepts a persisted inline edit after creation', () => {
  const item = 'Create one new test location, edit it, and verify the edit';
  const evidence = [
    'clicked "Add New Location"',
    'filled "Location Name" with "Sunset Rooftop Terrace"',
    'clicked "Create Location"',
    'filled "Enter location name" with "Golden Hour Terrace"',
  ];
  assert.equal(
    manualAuditEvidenceIssue(
      item,
      evidence,
      'LOCATION\ntextbox "Golden Hour Terrace"\nRegenerate',
    ),
    undefined,
  );
  assert.match(
    manualAuditEvidenceIssue(item, evidence, 'textbox "Sunset Rooftop Terrace"') ?? '',
    /editing and persisting/i,
  );
});

test('manual same-artifact audit requires stable identity across producer and consumer', () => {
  const item = 'Add that same asset to a generated scene';
  const task = {
    id: 'acceptance-2',
    requirement: item,
    targetPageId: 'edit-scenes',
    phase: 'pre-terminal' as const,
    dependsOn: ['acceptance-1'],
    artifactKey: 'artifact:acceptance-1',
    artifactRole: 'consumer' as const,
  };
  const prefix = [
    'clicked "Add Asset"',
    'uploaded "/tmp/roadster.png"',
    'filled "Asset Name" with "Crimson Roadster"',
    'clicked "Finalize Asset"',
    'clicked "Add Assets"',
  ];
  assert.match(
    manualAuditEvidenceIssue(
      item,
      [...prefix, 'uploaded "/tmp/avatar.png"'],
      'Edit scenes',
      task,
    ) ?? '',
    /exact previously created asset/i,
  );
  assert.equal(
    manualAuditEvidenceIssue(
      item,
      [...prefix, 'uploaded "/tmp/roadster.png"'],
      'Edit scenes',
      task,
    ),
    undefined,
  );
});

test('three-character audit rejects an empty slot or disabled forward gate', () => {
  const item =
    'Create exactly three distinct characters using AI avatar, uploaded image, and existing library';
  const evidence = [
    'clicked "Create AI Avatar"',
    'clicked "Finalize character"',
    'uploaded "/tmp/avatar.png"',
    'clicked "Use existing"',
    'clicked "Add (1)"',
  ];
  assert.match(
    manualAuditEvidenceIssue(
      item,
      evidence,
      'Character 1\nUse your likeness\nCreate AI Avatar\nNext [disabled]',
    ) ?? '',
    /all three character slots finalized|forward control enabled/i,
  );
  assert.equal(
    manualAuditEvidenceIssue(
      item,
      evidence,
      'Character 1\nUse your likeness\nCreate AI Avatar\nNext [disabled]',
      undefined,
      {
        status: 'clear',
        summary:
          'Visibly confirmed: three finalized characters are persisted in the Choose your characters section.',
        concerns: [],
      },
    ),
    undefined,
  );
  assert.equal(
    manualVisionAffirmsPersistedOutcome(item, {
      status: 'concern',
      summary: 'Three characters are visible, but one empty slot remains.',
      concerns: ['One empty slot remains'],
    }),
    false,
  );
  assert.equal(
    manualAuditEvidenceIssue(
      item,
      evidence,
      'Choose your characters\nMilan\nZayne\nArvind\nNext [disabled]',
      undefined,
      {
        status: 'uncertain',
        summary:
          "Three named characters (Milan, Zayne, Arvind) with thumbnails are visible in the 'Choose your characters' list.",
        concerns: [
          'Cannot visually verify that Milan was uploaded, Zayne was AI-generated, and Arvind came from the existing library; the list only shows names and thumbnails without method labels',
          'No visible confirmation of persistence beyond the current view (e.g., after finalize/next step)',
        ],
      },
    ),
    undefined,
  );
  assert.equal(
    manualAuditEvidenceIssue(
      item,
      evidence,
      'Choose your characters\nEthan Cole\nMaya Stone\nAmara\nNext',
    ),
    undefined,
  );
  assert.equal(
    manualAuditEvidenceIssue(
      item,
      [
        'clicked "Create AI Avatar"',
        'uploaded "/tmp/avatar.png"',
        'clicked "Use existing"',
        'clicked "Confirm"',
      ],
      'Choose your characters\nMarcusLee\nNina Patel\nAdrianCole\nNext',
    ),
    undefined,
  );
  assert.match(
    manualAuditEvidenceIssue(
      item,
      [
        'uploaded "/tmp/story.pdf"',
        'clicked "Create AI Avatar"',
        'clicked "Use existing"',
        'clicked "Add (1)"',
      ],
      'Ethan Cole\nMaya Stone\nAmara\nNext',
    ) ?? '',
    /image upload.+prior script\/audio upload does not count/i,
  );
  assert.match(
    manualAuditEvidenceIssue(
      item,
      [
        'clicked "Create AI Avatar"',
        'uploaded "/tmp/avatar.png"',
        'clicked "Use existing"',
      ],
      'Ethan Cole\nMaya Stone\nAmara\nNext',
    ) ?? '',
    /committing the selected existing-library character/i,
  );
  assert.match(
    manualAuditEvidenceIssue(
      item,
      evidence,
      'dialog "Choose existing characters"\nbutton "Add (1)"',
    ) ?? '',
    /returning to the character surface|visibly verifying all three/i,
  );
});

test('vision affirmation still requires same-run method provenance', () => {
  const item =
    'Create exactly three distinct characters using AI avatar, uploaded image, and existing library';
  assert.match(
    manualAuditEvidenceIssue(
      item,
      ['clicked "Create AI Avatar"'],
      'Choose your characters',
      undefined,
      {
        status: 'clear',
        summary:
          'Visibly confirmed: three finalized characters are persisted in the Choose your characters section.',
        concerns: [],
      },
    ) ?? '',
    /uploaded-character method/i,
  );
});

test('manual audit uses visual proof captured before advancing to the next wizard page', () => {
  const visual = {
    status: 'uncertain' as const,
    summary:
      "Three named characters (Milan, Zayne, Arvind) are visible in the 'Choose your characters' list.",
    concerns: [
      'Cannot visually verify which creation method produced each character because the list has no method labels.',
    ],
  };
  const carried = manualVisualAssessmentFromActions([
    { action: 'click', resolvedLabel: 'Confirm' },
    { action: 'click', resolvedLabel: 'Next', visualAssessment: visual },
  ]);
  assert.deepEqual(carried, visual);
  assert.equal(
    manualAuditEvidenceIssue(
      'Create exactly three distinct characters: one using AI avatar generation, one by uploading a character image, and one selected from the existing character library; finalize and visibly verify all three',
      [
        'clicked "Create AI Avatar"',
        'uploaded "/tmp/avatar.png"',
        'clicked "Use Existing"',
        'clicked "Confirm"',
      ],
      'Review transcript',
      undefined,
      carried,
    ),
    undefined,
  );
});

test('three visible finalized character entities may span Koyal character sections', () => {
  assert.equal(
    manualAuditEvidenceIssue(
      'Create exactly three distinct characters: one using AI avatar generation, one by uploading a character image, and one selected from the existing character library; finalize and visibly verify all three',
      [
        'clicked "Create AI Avatar"',
        'uploaded "/tmp/avatar.png"',
        'clicked "Use Existing"',
        'clicked "Confirm"',
      ],
      'Review transcript',
      undefined,
      {
        status: 'uncertain',
        summary:
          'Three finalized character entities are visible across Choose your characters and the character-assets section.',
        concerns: [
          'The uploaded character is displayed in a separate character-assets section, and the creation method labels are not shown.',
        ],
      },
    ),
    undefined,
  );
});

test('two named character cards plus the named uploaded-character asset may settle the same narrow ambiguity', () => {
  const item =
    'Create exactly three distinct characters: AI avatar, uploaded image, and existing library';
  const visual = {
    status: 'concern' as const,
    summary:
      'The screen shows two named characters (Calder, Caspian) plus a named asset entry (Mira), but they are not clearly finalized as three character entities.',
    concerns: [
      'The uploaded character is shown as an asset entry rather than a normal character entity.',
    ],
  };
  assert.equal(manualVisionAffirmsPersistedOutcome(item, visual), true);
  assert.notEqual(
    manualAuditEvidenceIssue(
      item,
      [
        'clicked "Create AI Avatar"',
        'clicked "Finalize character"',
        'uploaded "/tmp/avatar.png"',
        'clicked "Save All"',
        'clicked "Use Existing"',
        'clicked "AvatarCaspian"',
        'clicked "Confirm"',
      ],
      'Next disabled\nCharacter Calder\nCharacter Caspian\nAsset Mira',
      undefined,
      {
        ...visual,
        summary: `${visual.summary} Next is disabled because an empty slot remains.`,
      },
    ),
    undefined,
  );
});

test('Koyal character-slot results may migrate into its Assets and Animals as Character subsection', () => {
  const item =
    'During the in-flow Character step, exercise exactly three distinct characters using AI generation, image upload, and existing library selection';
  assert.equal(
    manualVisionAffirmsPersistedOutcome(item, {
      status: 'concern',
      summary:
        "ElenaMarin and NolanMercer appear under the 'Add Assets and Animals as Character' section, while AdrianCole is shown as the generated character.",
      concerns: [
        "ElenaMarin and NolanMercer are displayed in the Assets and Animals as Character subsection rather than the in-flow character slot.",
      ],
    }),
    true,
  );
});

test('an optional empty Add-another slot does not invalidate three named finalized sources', () => {
  const item =
    'Create exactly three distinct characters: AI avatar, uploaded image, and existing library';
  const visual = {
    status: 'concern' as const,
    summary:
      "The screenshot shows a named AI-generated character (Eamon), a library character (Calder), and an asset-section image (Maeve), but the asset section still shows an empty 'Add' placeholder and the attributions do not cleanly map to exactly three distinct finalized characters.",
    concerns: [
      'The empty Add placeholder and section attribution make the grouping ambiguous.',
    ],
  };
  assert.equal(manualVisionAffirmsPersistedOutcome(item, visual), true);
  assert.equal(
    manualVisionAffirmsPersistedOutcome(item, {
      ...visual,
      summary: `${visual.summary} Next is disabled.`,
    }),
    false,
  );
});

test('three-character vision may be uncertain only because methods and sections are not labeled', () => {
  assert.equal(
    manualVisionAffirmsPersistedOutcome(
      'Create exactly three distinct characters using three methods',
      {
        status: 'uncertain',
        summary:
          "The screenshot shows one character 'Augustine' and an assets section with Seraphina and Soraya, but it cannot clearly prove three finalized distinct characters covering all three required methods without ambiguity.",
        concerns: [
          'Seraphina and Soraya appear in the separate Assets and Animals as Character section.',
          'The screenshot does not label the AI, upload, and existing-library creation methods.',
        ],
      },
    ),
    true,
  );
});

test('three-character runtime guidance requires character-section creation before accepting its migrated display', () => {
  const threeCharacterFlow = flow('manual-three-characters', 'exploratory');
  threeCharacterFlow.manualContract = {
    request: 'Create exactly three distinct characters.',
    checklist: ['Create exactly three distinct characters.'],
  };
  threeCharacterFlow.manualExecution = {
    version: 1,
    sourceFlowId: 'walked-audio',
    primaryJourneyPageIds: ['wizard-story-type'],
    tasks: [
      {
        id: 'acceptance-1',
        requirement:
          'Create exactly three distinct characters: one using AI avatar generation, one by uploading a character image, and one selected from the existing character library.',
        phase: 'pre-terminal',
        dependsOn: [],
      },
    ],
    constraints: [],
    policy: {
      context: 'active-task',
      processing: 'manual-narrative-safe',
      recovery: 'bounded-modal-dismiss',
      probes: 'contract-only',
    },
  };
  const guidance = manualContractRuntimeGuidance(
    threeCharacterFlow,
    {
      id: 'manual-task-1',
      kind: 'navigate',
      goal: 'Create three characters',
      manualContractAudit: true,
      manualContractItem: 1,
      manualTaskId: 'acceptance-1',
    },
    [],
  );
  assert.match(guidance, /owning Character section or an empty character slot/i);
  assert.match(guidance, /upload.*must begin.*character slot/i);
  assert.match(guidance, /dedicated character-assets\/animals-as-character subsection/i);
  assert.match(guidance, /only when same-run actions prove.*originated from the Character section/i);
  assert.match(guidance, /remove that empty placeholder once/i);
  assert.match(guidance, /never substitute the standalone reusable Assets/i);
});

test('reusable-asset runtime guidance requires the standalone Asset section', () => {
  const assetFlow = flow('manual-reusable-asset', 'exploratory');
  assetFlow.manualContract = {
    request: 'Create one new reusable asset.',
    checklist: ['Create one new reusable asset in the asset library.'],
  };
  assetFlow.manualExecution = {
    version: 1,
    sourceFlowId: 'walked-audio',
    primaryJourneyPageIds: ['assets-list'],
    tasks: [
      {
        id: 'acceptance-1',
        requirement: 'Create one new reusable asset in the asset library.',
        phase: 'pre-terminal',
        dependsOn: [],
      },
    ],
    constraints: [],
    policy: {
      context: 'active-task',
      processing: 'manual-narrative-safe',
      recovery: 'bounded-modal-dismiss',
      probes: 'contract-only',
    },
  };
  const guidance = manualContractRuntimeGuidance(
    assetFlow,
    {
      id: 'manual-task-1',
      kind: 'navigate',
      goal: 'Create reusable asset',
      manualContractAudit: true,
      manualContractItem: 1,
      manualTaskId: 'acceptance-1',
    },
    [],
  );
  assert.match(guidance, /standalone Asset section or Asset library/i);
  assert.match(guidance, /Never use a character slot/i);
});

test('Animated style audit accepts Animated provenance and clear visual persistence', () => {
  const item =
    'Use Animated style for this run and satisfy every required style and orientation option';
  assert.equal(
    manualAuditEvidenceIssue(
      item,
      ['clicked "Animated"', 'clicked "Landscape"'],
      'Animated\nLandscape\nNext [disabled]',
      undefined,
      {
        status: 'clear',
        summary:
          'Visibly confirmed: Animated style and Landscape orientation are selected and persisted.',
        concerns: [],
      },
    ),
    undefined,
  );
});

test('manual outfit audit requires applying the mutation after the new prompt', () => {
  const item = 'Change one selected character outfit with a realistic prompt';
  const wrongOrder = [
    'clicked "Change Look"',
    'filled "Outfit" with "A charcoal wool peacoat and brown leather boots"',
  ];
  assert.match(
    manualAuditEvidenceIssue(item, wrongOrder, 'Realistic image not generated') ?? '',
    /applying the requested outfit/,
  );
  assert.equal(
    manualAuditEvidenceIssue(
      item,
      [...wrongOrder, 'clicked "Change Look"'],
      'Updated outfit image',
    ),
    undefined,
  );
});

test('manual style audit rejects a disabled forward state', () => {
  const item = 'Use Sketch style and satisfy every required orientation option';
  const evidence = ['clicked "Sketch"', 'clicked "Portrait"'];
  assert.match(
    manualAuditEvidenceIssue(
      item,
      evidence,
      'Choose character art style\nSketch\nbutton "Next" disabled',
    ) ?? '',
    /forward control enabled/,
  );
  assert.equal(manualAuditEvidenceIssue(item, evidence, 'button "Next"'), undefined);
  assert.equal(
    manualAuditEvidenceIssue(
      item,
      evidence,
      'Generate filming locations\nbutton "Next" disabled',
    ),
    undefined,
    'a disabled forward control on the next page must not invalidate completed style evidence',
  );
});

test('manual runtime guidance is mutation-capable only for the audit and read-only for proof', () => {
  const candidate: Flow = {
    id: 'manual-video',
    title: 'Manual video',
    description: 'manual',
    status: 'exploratory',
    entry: { pageId: 'dashboard' },
    manualContract: {
      request: 'Edit dialogue and render.',
      checklist: ['Edit dialogue', 'Render final video'],
    },
    milestones: [],
  };
  const ordinary = manualContractRuntimeGuidance(
    candidate,
    { id: 'script', goal: 'Edit Script', kind: 'navigate' },
    ['filled "Dialogue" with "New text"', 'clicked "Save"'],
  );
  assert.match(ordinary, /Never restart an obligation that already has matching evidence/);
  assert.match(ordinary, /do not reopen and repeat it merely because a collapsed summary shows stale text/);
  assert.match(ordinary, /continue forward; do not trap the entire journey retrying it/);
  assert.match(ordinary, /Operational edit contract/);
  assert.match(ordinary, /operational health, not artistic compliance or persistence/i);
  assert.match(ordinary, /no page exception, console error/i);

  const audit = manualContractRuntimeGuidance(
    candidate,
    {
      id: 'audit',
      goal: 'Audit',
      kind: 'navigate',
      manualContractAudit: true,
      manualContractItem: 2,
    },
    [],
  );
  assert.match(audit, /mutation-capable audit for acceptance item 2 only/);
  assert.match(audit, /next independent audit milestone can still run/);

  const proof = manualContractRuntimeGuidance(
    candidate,
    { id: 'manual-contract-final-proof', goal: 'Proof', kind: 'verify' },
    [],
  );
  assert.match(proof, /strictly read-only/);
  assert.match(proof, /Do not click Edit\/Create\/Save\/Generate\/Upload\/Submit/);
  assert.doesNotMatch(proof, /Repair only obligations/);

  const mappedTerminal = manualContractRuntimeGuidance(
    candidate,
    { id: 'final-video', goal: 'Render final video', kind: 'verify' },
    [],
  );
  assert.doesNotMatch(mappedTerminal, /strictly read-only/);
  assert.match(mappedTerminal, /Work only on contract operations/);
});

test('manual-v2 schedules a bounded repair when an audit finds a missing sub-action', () => {
  const flow: Flow = {
    id: 'manual-v2-characters',
    title: 'Manual characters',
    description: 'task graph',
    status: 'exploratory',
    entry: { pageId: 'story-type' },
    manualContract: {
      request: 'Create exactly three characters.',
      checklist: [
        'Create exactly three distinct characters: one using AI avatar generation, one by uploading a character image, and one selected from the existing character library',
      ],
    },
    manualExecution: {
      version: 1,
      sourceFlowId: 'script-video',
      primaryJourneyPageIds: ['story-type'],
      constraints: [],
      tasks: [
        {
          id: 'acceptance-1',
          requirement: 'Create exactly three distinct characters',
          targetPageId: 'story-type',
          phase: 'pre-terminal',
          dependsOn: [],
        },
      ],
      policy: {
        context: 'active-task',
        processing: 'manual-narrative-safe',
        recovery: 'bounded-modal-dismiss',
        probes: 'contract-only',
      },
    },
    milestones: [],
  };
  const milestone = {
    id: 'manual-task-1',
    goal: 'Create exactly three characters',
    kind: 'create' as const,
    manualContractAudit: true,
    manualContractItem: 1,
    manualTaskId: 'acceptance-1',
  };
  const evidence = [
    'clicked "Create AI Avatar"',
    'uploaded "pilot.png"',
    'clicked "Use existing"',
    'clicked "Add (1)"',
  ];
  assert.match(
    manualTaskGraphRepairIssue(
      flow,
      milestone,
      evidence,
      'Character 2 Use your likeness Create AI Avatar\nbutton "Next" disabled',
    ) ?? '',
    /all three character slots finalized|forward control enabled/i,
  );
  assert.equal(
    manualTaskGraphRepairIssue(
      flow,
      milestone,
      evidence,
      'Choose your characters\nEthan\nMaya\nAmara\nbutton "Next"',
    ),
    undefined,
  );
  assert.equal(
    manualTaskGraphRepairIssue(
      { ...flow, manualExecution: undefined },
      milestone,
      evidence,
      'Character 2 Use your likeness',
    ),
    undefined,
    'legacy manual/default flows must not enter task-graph repair',
  );
});

test('atomic scene and final-video audits require only their named operation', () => {
  assert.match(
    manualAuditEvidenceIssue(
      'Test the Change Scene function: Change Camera Angle for a different perspective',
      ['clicked "Edit"', 'clicked "Reshoot"'],
      'Edit scenes',
    ) ?? '',
    /Change Camera Angle/,
  );
  assert.equal(
    manualAuditEvidenceIssue(
      'Test the Change Scene function: Change Camera Angle for a different perspective',
      ['clicked "Change Camera Angle"', 'clicked "Apply Camera Angle"'],
      'Edit scenes',
    ),
    undefined,
  );
  assert.equal(
    manualAuditEvidenceIssue(
      'Test the final-video function: Edit Video and verify the updated video is playable',
      ['filled "Edit prompt" with "warmer light"', 'clicked "Submit Edit"'],
      'Video Download Video',
    ),
    undefined,
  );
  for (const [requirement, click] of [
    ['Test the final-video function: Retake', 'clicked "Retake"'],
    ['Test the final-video function: Add Reference using a file', 'clicked "Add Reference"'],
    ['Test the final-video function: Reframe', 'clicked "Reframe"'],
  ]) {
    assert.equal(
      manualAuditEvidenceIssue(requirement, [click], 'Video Download Video'),
      undefined,
    );
  }
});

test('task-graph runtime guidance exposes only the active task, not the full contract', () => {
  const candidate: Flow = {
    id: 'manual-v2-video',
    title: 'Manual v2 video',
    description: 'task graph',
    status: 'exploratory',
    entry: { pageId: 'dashboard' },
    manualContract: {
      request: 'Upload a script. Create an asset. Render a final video.',
      checklist: ['Upload a script', 'Create an asset', 'Render a final video'],
    },
    manualExecution: {
      version: 1,
      sourceFlowId: 'script-video',
      primaryJourneyPageIds: ['upload', 'assets', 'final-video'],
      constraints: [],
      tasks: [
        {
          id: 'acceptance-1',
          requirement: 'Upload a script',
          targetPageId: 'upload',
          phase: 'pre-terminal',
          dependsOn: [],
        },
        {
          id: 'acceptance-2',
          requirement: 'Create an asset',
          targetPageId: 'assets',
          phase: 'pre-terminal',
          dependsOn: ['acceptance-1'],
        },
        {
          id: 'acceptance-3',
          requirement: 'Render a final video',
          targetPageId: 'final',
          phase: 'post-terminal',
          dependsOn: ['acceptance-2'],
        },
      ],
      policy: {
        context: 'active-task',
        processing: 'manual-narrative-safe',
        recovery: 'bounded-modal-dismiss',
        probes: 'contract-only',
      },
    },
    milestones: [],
  };
  const active = manualContractRuntimeGuidance(
    candidate,
    {
      id: 'manual-task-2',
      goal: 'Create an asset',
      kind: 'navigate',
      manualContractAudit: true,
      manualContractItem: 2,
      manualTaskId: 'acceptance-2',
    },
    ['uploaded script.pdf', 'created compass'],
  );
  assert.match(active, /2: Create an asset/);
  assert.doesNotMatch(active, /Render a final video/);

  const journey = manualContractRuntimeGuidance(
    candidate,
    { id: 'journey-style', goal: 'Advance style', kind: 'navigate' },
    [],
  );
  assert.match(journey, /No acceptance task is active/);
  assert.doesNotMatch(journey, /Upload a script/);

  const proof = manualContractRuntimeGuidance(
    candidate,
    { id: 'manual-task-final-proof', goal: 'Proof', kind: 'verify' },
    [],
  );
  assert.match(proof, /runner has already adjudicated each acceptance task independently/i);
  assert.doesNotMatch(proof, /Upload a script/);
  assert.doesNotMatch(proof, /Render a final video/);
  assert.match(proof, /strictly read-only/);
});

test('manual acceptance contracts skip unrelated generic probes without changing normal flows', () => {
  const ordinary: Flow = {
    id: 'ordinary',
    title: 'Ordinary flow',
    description: 'ordinary',
    status: 'exploratory',
    entry: { pageId: 'home' },
    milestones: [],
  };
  const manual: Flow = {
    ...ordinary,
    id: 'manual',
    manualContract: {
      request: 'Create a fresh artifact and verify it.',
      checklist: ['Create a fresh artifact', 'Verify it'],
    },
  };

  assert.equal(shouldRunMilestoneProbes(ordinary), true);
  assert.equal(shouldRunMilestoneProbes(ordinary, true), false);
  assert.equal(shouldRunMilestoneProbes(manual), false);
});

test('destructive manual tasks are non-idempotent while their read-only proof remains non-mutating', () => {
  const manual: Flow = {
    ...flow('manual-delete', 'exploratory', 'learning'),
    manualContract: {
      request: 'Delete exactly 10 characters',
      checklist: ['Delete exactly 10 characters'],
    },
    milestones: [
      {
        id: 'manual-task-1',
        goal: 'Delete exactly 10 characters',
        kind: 'edit',
        manualContractAudit: true,
        manualContractItem: 1,
      },
      {
        id: 'manual-task-final-proof',
        goal: 'Read-only verification; do not delete anything',
        kind: 'verify',
      },
    ],
  };

  assert.equal(isNonIdempotentManualMilestone(manual, manual.milestones[0]), true);
  // The proof contains the word "delete" only as a prohibition. It remains
  // protected by manualReadOnly at runtime and is never a replayable mutation.
  assert.equal(isManualFinalProofMilestone(manual.milestones[1]), true);
  assert.equal(shouldRunMilestoneProbes(manual), false);
});

test('manual task-graph position may use one unique journey URL after state landmarks change', () => {
  const candidate: Flow = {
    id: 'manual-terminal',
    title: 'Manual terminal flow',
    description: 'task graph',
    status: 'exploratory',
    entry: { pageId: 'upload' },
    milestones: [],
    manualExecution: {
      version: 1,
      sourceFlowId: 'script-video',
      primaryJourneyPageIds: ['upload', 'edit-scenes', 'final-generating'],
      constraints: [],
      tasks: [],
      policy: {
        context: 'active-task',
        processing: 'manual-narrative-safe',
        recovery: 'bounded-modal-dismiss',
        probes: 'contract-only',
      },
    },
  };
  const page = (id: string, path: string) => ({
    id,
    title: id,
    description: id,
    urlPatterns: [path],
    detection: { snapshotAnyOf: [id] },
    requiresAuth: true,
    interactives: [],
    firstSeenAt: '',
    lastSeenAt: '',
  });
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: {
      upload: page('upload', '/upload'),
      'edit-scenes': page('edit-scenes', '/editscene'),
      'final-generating': {
        ...page('final-generating', '/finalvideo'),
        kind: 'processing',
      },
    },
    edges: [],
    flows: [],
    siteHints: [],
  };

  assert.equal(
    manualJourneyPageIdForUrl(candidate, sitemap, 'https://example.test/finalvideo'),
    'final-generating',
  );
  sitemap.pages['final-complete'] = {
    ...page('final-complete', '/finalvideo'),
    kind: 'terminal',
  };
  candidate.manualExecution!.primaryJourneyPageIds!.push('final-complete');
  assert.equal(
    manualJourneyPageIdForUrl(candidate, sitemap, 'https://example.test/finalvideo'),
    undefined,
    'shared stateful routes must remain landmark-driven',
  );
  assert.equal(
    manualJourneyPageIdForUrl({ ...candidate, manualExecution: undefined }, sitemap, 'https://example.test/upload'),
    undefined,
    'ordinary flows are unaffected',
  );
});
