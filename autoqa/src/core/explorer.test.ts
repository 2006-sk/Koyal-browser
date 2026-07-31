import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { config } from '../config.js';
import type { AgentBrowser } from './agent-browser.js';
import type { LlmClient, LlmCompletionOptions } from './llm/client.js';
import {
  Explorer,
  EXPLORER_STATE_VISIT_LIMIT,
  doneHasObservableProgress,
  explorerStateSignature,
  explicitGoalValue,
  identityReassertionsForReview,
  hasPendingArtifactBadge,
  hasBlockingValidationState,
  hasRecoverableFieldValidation,
  hasInlineProcessing,
  isGroundedManualUnlabelledClick,
  isManualMutationAction,
  isSensitiveFieldLabel,
  isSafeStateCycleRecoveryLabel,
  isVisionIdentifiedUnlabelledDismiss,
  llmInfrastructureBlockReason,
  PROCESSING_VISION_POLL_THRESHOLD,
  requiresFreshArtifactIdentity,
  shouldDeferUnlabelledProgressClick,
  snapshotRefIsDisabled,
  uniquePostProcessingCompletionControl,
  uniqueSafeStateCycleRecoveryControl,
  visibleManualProductError,
  type ExplorerResult,
} from './explorer.js';

test('disabled GENERATING button is treated as active processing', () => {
  assert.equal(hasInlineProcessing('- button "GENERATING" [disabled]'), true);
});

test('static generation copy is not treated as active processing', () => {
  assert.equal(hasInlineProcessing('- heading "AI Image Generation"'), false);
});

test('manual mode recognizes a raw product contract error without matching ordinary missing-field copy', () => {
  assert.equal(
    visibleManualProductError(
      'Missing storyInstructions, storyElement for edit-story',
    ),
    'Missing storyInstructions, storyElement for edit-story',
  );
  assert.equal(
    visibleManualProductError('Please complete the missing required fields'),
    undefined,
  );
});

test('avatar generation overlay is treated as active processing', () => {
  assert.equal(hasInlineProcessing('- status "Generating avatar..."'), true);
});

test('rendering status prose is treated as active processing', () => {
  assert.equal(
    hasInlineProcessing('YOUR FILM IS RENDERING. CUSTOMIZE YOUR TITLE CARD AND EXPLORE FUN FACTS WHILE YOU WAIT.'),
    true,
  );
  assert.equal(hasInlineProcessing('NOW IN PRODUCTION 00:10'), true);
});

test('server-busy timeout prose is treated as active processing', () => {
  assert.equal(hasInlineProcessing('Taking longer than expected. Server may be busy. 5:28 elapsed'), true);
});

test('disabled refs are recognized regardless of accessibility attribute order', () => {
  assert.equal(
    snapshotRefIsDisabled('- button "Next" [disabled, ref=e14]', '@e14'),
    true,
  );
  assert.equal(
    snapshotRefIsDisabled('- button "Next" [ref=e14, aria-disabled=true]', 'e14'),
    true,
  );
  assert.equal(snapshotRefIsDisabled('- button "Next" [ref=e14]', '@e14'), false);
});

test('bare Processing badge is recognized only by the post-mutation detector', async () => {
  const { hasPostMutationProcessing } = await import('./explorer.js');
  assert.equal(hasInlineProcessing('- text "Processing"'), false);
  assert.equal(hasPostMutationProcessing('- text "Processing"'), true);
  assert.equal(hasPostMutationProcessing('- heading "Image Processing Settings"'), false);
});

test('persisted pending badge prevents vision from releasing artifact processing', () => {
  assert.equal(
    hasPendingArtifactBadge(
      '- article\n  - heading "Ranger Binoculars"\n  - StaticText "PROCESSING"\n  - button "REGENERATE" [disabled]',
    ),
    true,
  );
  assert.equal(
    hasPendingArtifactBadge(
      '- article\n  - heading "Ranger Binoculars"\n  - button "REGENERATE"',
    ),
    false,
  );
  // Static generation copy on an ordinary form is not a persisted pending badge.
  assert.equal(hasPendingArtifactBadge('- heading "AI Image Generation"'), false);
});

test('static rendering settings copy is not treated as active processing', () => {
  assert.equal(hasInlineProcessing('- heading "Video Rendering Settings"'), false);
});

test('manual mode ignores narrative remaining but preserves main crawler behavior', () => {
  const narrative =
    '- paragraph "The foam pattern on top remaining perfectly intact as the cup glides to a stop."';
  assert.equal(hasInlineProcessing(narrative), true);
  assert.equal(
    hasInlineProcessing(narrative, { manualNarrativeSafe: true }),
    false,
  );
  assert.equal(
    hasInlineProcessing('- status "2 minutes remaining"', { manualNarrativeSafe: true }),
    true,
  );
  assert.equal(
    hasInlineProcessing('- status "Remaining: 01:42"', { manualNarrativeSafe: true }),
    true,
  );
});

test('vision affirmation is scheduled early in a prolonged processing wait', () => {
  assert.equal(PROCESSING_VISION_POLL_THRESHOLD, 3);
});

test('post-processing completion detection requires one unique enabled finalizer', () => {
  assert.deepEqual(
    uniquePostProcessingCompletionControl(
      '- button "Add Character" [ref=e1]\n- button "Review and finalize" [ref=e2]\n- button "Next" [disabled, ref=e3]',
    ),
    { ref: '@e2', label: 'Review and finalize' },
  );
  assert.equal(
    uniquePostProcessingCompletionControl(
      '- button "Finalize Asset" [ref=e1]\n- button "Save changes" [ref=e2]',
    ),
    null,
  );
  assert.equal(
    uniquePostProcessingCompletionControl(
      '- button "Review and finalize" [disabled, ref=e2]',
    ),
    null,
  );
});

test('state signature ignores ref and timing noise but preserves semantic state', () => {
  assert.equal(
    explorerStateSignature(
      'https://example.test/edit',
      '- button "Create" [ref=e12] [disabled]\n- text "Est. 42 seconds"',
    ),
    explorerStateSignature(
      'https://example.test/edit',
      '- button "Create" [ref=e91] [disabled]\n- text "Est. 17 seconds"',
    ),
  );
  assert.notEqual(
    explorerStateSignature('https://example.test/edit', '- button "Create" [disabled]'),
    explorerStateSignature('https://example.test/edit', '- button "Create"'),
  );
  assert.equal(
    explorerStateSignature(
      'https://example.test/edit',
      '- image "variant" https://cdn.example/a/8e7c26b4239840f2b221c624.png?v=1784789001\n- button "Finalize" [disabled]',
    ),
    explorerStateSignature(
      'https://example.test/edit',
      '- image "variant" https://cdn.example/b/6a3d906eff6dd09252f04142.png?v=1784789123\n- button "Finalize" [disabled]',
    ),
  );
});

test('state-cycle recovery allowlist accepts navigation but rejects mutations and modal experiments', () => {
  assert.equal(isSafeStateCycleRecoveryLabel('Next'), true);
  assert.equal(isSafeStateCycleRecoveryLabel('Save and Continue'), true);
  assert.equal(isSafeStateCycleRecoveryLabel('Create'), false);
  assert.equal(isSafeStateCycleRecoveryLabel('Regenerate'), false);
  assert.equal(isSafeStateCycleRecoveryLabel('Close'), false);
  assert.equal(isSafeStateCycleRecoveryLabel('Close', { manualDismiss: true }), true);
  assert.equal(isSafeStateCycleRecoveryLabel('Cancel', { manualDismiss: true }), true);
});

test('manual vision may identify one unlabeled close button but cannot bless arbitrary unlabeled actions', () => {
  assert.equal(
    isVisionIdentifiedUnlabelledDismiss(
      'button',
      '',
      'A Scene 1 detail panel is blocking the journey; click its X button to close it.',
      true,
    ),
    true,
  );
  assert.equal(
    isVisionIdentifiedUnlabelledDismiss(
      'button',
      '',
      'Try this unlabeled button to see what happens.',
      true,
    ),
    false,
  );
  assert.equal(
    isVisionIdentifiedUnlabelledDismiss(
      'button',
      '',
      'Close the blocking modal with its X button.',
      false,
    ),
    false,
  );
  assert.equal(
    isVisionIdentifiedUnlabelledDismiss(
      'button',
      'Regenerate',
      'Close the blocking modal.',
      true,
    ),
    false,
  );
});

test('manual icon clicks require explicit visual grounding and reject positional guesses', () => {
  assert.equal(
    isGroundedManualUnlabelledClick(
      'button',
      undefined,
      'The bottom-right button is likely the add control.',
      true,
    ),
    false,
  );
  assert.equal(
    isGroundedManualUnlabelledClick(
      'button',
      undefined,
      'VISUALLY CONFIRMED: the button shows a plus icon labeled by the surrounding Create panel.',
      true,
    ),
    true,
  );
  assert.equal(
    isGroundedManualUnlabelledClick(
      'button',
      undefined,
      'VISUALLY CONFIRMED: the button shows a plus icon.',
      false,
    ),
    false,
  );
});

test('manual read-only policy recognizes destructive and form-changing actions', () => {
  assert.equal(isManualMutationAction('click', 'Delete', 'confirm deletion'), true);
  assert.equal(isManualMutationAction('fill', 'Project name'), true);
  assert.equal(isManualMutationAction('click', 'Next page'), false);
  assert.equal(isManualMutationAction('click', 'ADD ASSET', 'open the asset dialog'), false);
  assert.equal(isManualMutationAction('click', 'Add Assets', 'apply assets to the scene'), true);
});

test('provider outages are classified as infrastructure blocks without exposing response bodies', () => {
  assert.equal(
    llmInfrastructureBlockReason(
      'Anthropic request failed (529): {"type":"overloaded_error"}',
    ),
    'Infrastructure blocked: LLM provider overloaded (HTTP 529) after retries.',
  );
  assert.equal(llmInfrastructureBlockReason('Invalid explorer JSON'), undefined);
});

test('state-cycle recovery resolves only one unique enabled safe forward control', () => {
  assert.deepEqual(
    uniqueSafeStateCycleRecoveryControl(
      '- button "Edit dialogue" [ref=e3]\n- button "Next" [ref=e19]',
    ),
    { ref: '@e19', label: 'Next', role: 'button' },
  );
  assert.equal(
    uniqueSafeStateCycleRecoveryControl(
      '- button "Next" [disabled, ref=e19]\n- button "Edit dialogue" [ref=e3]',
    ),
    null,
  );
  assert.equal(
    uniqueSafeStateCycleRecoveryControl(
      '- button "Next" [ref=e19]\n- link "Continue" [ref=e20]',
    ),
    null,
  );
  assert.equal(
    uniqueSafeStateCycleRecoveryControl(
      '- button "Create Video" [ref=e19]\n- button "Close" [ref=e20]',
    ),
    null,
  );
  assert.deepEqual(
    uniqueSafeStateCycleRecoveryControl(
      '- button "Save" [ref=e19]\n- button "Close" [ref=e20]',
      { manualDismiss: true },
    ),
    { ref: '@e20', label: 'Close', role: 'button' },
  );
});

test('alternating actions in a recurring page-state cycle abort well before maxSteps', async () => {
  let modalOpen = false;
  let llmCalls = 0;
  const base = '- button "Scene one" [ref=e1]\n- button "Scene two" [ref=e2]\n- button "Report a Bug" [ref=e3]';
  const modal = '- dialog "Report a Bug"\n- button "Close" [ref=e4]';
  const browser = {
    getUrl: () => 'https://example.test/edit-scenes',
    snapshotInteractive: () => (modalOpen ? modal : base),
    snapshotFull: () => (modalOpen ? modal : base),
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => undefined,
    screenshotAnnotated: (filePath: string) => fs.writeFileSync(filePath, Buffer.from('cycle')),
    clickVisible: (ref: string) => {
      if (ref === '@e3') modalOpen = true;
      if (ref === '@e4') modalOpen = false;
    },
  } as unknown as AgentBrowser;
  const decisions = [
    '{"action":"click","ref":"@e1","reason":"try scene one"}',
    '{"action":"click","ref":"@e2","reason":"try scene two"}',
    '{"action":"click","ref":"@e3","reason":"try report control"}',
    '{"action":"click","ref":"@e4","reason":"close modal"}',
  ];
  const llm = {
    async complete(options: LlmCompletionOptions) {
      llmCalls++;
      if (options.image) {
        return '{"action":"fail","reason":"The same scene-selection screen is visible with no progress."}';
      }
      return decisions.shift() ?? '{"action":"click","ref":"@e1","reason":"repeat"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Edit one scene', { maxSteps: 40 });
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /state-cycle detected/i);
  assert.ok(llmCalls <= EXPLORER_STATE_VISIT_LIMIT + 1, `expected bounded calls, got ${llmCalls}`);
});

test('state-cycle arbitration directs the LLM to one safe Next and executes its choice', async () => {
  let url = 'https://example.test/upload';
  let llmCalls = 0;
  let textCalls = 0;
  const attached =
    '- text "test-script.pdf"\n- button "Upload file" [ref=e5]\n- button "Choose PDF File" [ref=e6]\n- button "Next" [ref=e14]';
  const browser = {
    getUrl: () => url,
    snapshotInteractive: () => attached,
    snapshotFull: () => attached,
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => undefined,
    screenshotAnnotated: (filePath: string) => fs.writeFileSync(filePath, Buffer.from('attached-file')),
    clickVisible: (ref: string) => {
      if (ref === '@e14') url = 'https://example.test/story-type';
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete(options: LlmCompletionOptions) {
      llmCalls++;
      if (options.image) {
        assert.match(
          options.messages.map((message) => message.content).join('\n'),
          /exactly one enabled safe forward control exists:[^]*button "Next" \(@e14\)\. Choose that click now/i,
        );
        return '{"action":"click","ref":"@e14","reason":"Next is the only safe non-repetitive forward action."}';
      }
      textCalls++;
      return textCalls % 2 === 1
        ? '{"action":"click","ref":"@e5","reason":"retry upload control"}'
        : '{"action":"click","ref":"@e6","reason":"retry file picker"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Advance the attached PDF', {
    maxSteps: 40,
    returnOnUrlChange: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.finalUrl, 'https://example.test/story-type');
  assert.equal(llmCalls, EXPLORER_STATE_VISIT_LIMIT);
  assert.match(result.stepsTaken.join('\n'), /bounded safe advance click/i);
});

test('disabled completion plus visible validation triggers narrow vision', () => {
  assert.equal(
    hasBlockingValidationState(
      '- textbox "Character name"\n- text "This name is already used"\n- button "Finalize character" [disabled]',
    ),
    true,
  );
  assert.equal(hasBlockingValidationState('- button "Finalize character" [disabled]'), false);
  assert.equal(hasBlockingValidationState('- text "This name is already used"\n- button "Cancel"'), false);
  assert.equal(
    hasRecoverableFieldValidation(
      '- textbox "Enter the name"\n- text "This Avatar name is already in use"\n- button "Finalize character" [disabled]',
    ),
    true,
  );
  assert.equal(
    hasRecoverableFieldValidation(
      '- textbox "Description"\n- text "Missing required data"\n- button "Create Location" [disabled]',
    ),
    false,
  );
});

test('name-like fills in nested creation goals require a fresh saved identity', () => {
  assert.equal(
    requiresFreshArtifactIdentity(
      "Select the Character Driven story type, create a character, and click Next",
      'Enter the name',
      [],
    ),
    true,
  );
  assert.equal(
    requiresFreshArtifactIdentity('Filter the existing character list', 'Search by name', []),
    false,
  );
  assert.equal(
    requiresFreshArtifactIdentity('Edit profile details', 'Username', []),
    false,
  );
});

test('remounted generated review forms re-assert identity but never the generation prompt', () => {
  const refills = identityReassertionsForReview(
    'Create a new character and finalize it',
    [
      {
        action: 'fill',
        resolvedLabel: 'Describe your character',
        value: 'A friendly young pilot with short brown hair.',
      },
      {
        action: 'fill',
        resolvedLabel: 'Enter the name',
        value: 'Adrian',
      },
      {
        action: 'click',
        resolvedLabel: 'Create',
      },
    ],
    [
      '- textbox "Describe your character" [ref=e33]',
      '- textbox "Enter the name" [ref=e35]',
      '- button "Finalize character" [ref=e36]',
    ].join('\n'),
  );
  assert.deepEqual(refills, [
    { ref: '@e35', label: 'Enter the name', value: 'Adrian' },
  ]);
});

test('one-screen walks defer unlabeled icons until vision grounds them', () => {
  assert.equal(shouldDeferUnlabelledProgressClick(true, undefined, false), true);
  assert.equal(shouldDeferUnlabelledProgressClick(true, undefined, true), false);
  assert.equal(shouldDeferUnlabelledProgressClick(true, 'Next', false), false);
  assert.equal(shouldDeferUnlabelledProgressClick(false, undefined, false), false);
});

test('action goals cannot accept done when the semantic page never changed', () => {
  const snapshot = '- article "Cozy Coffee Shop"\n  - button "Edit" [ref=e5]';
  const signature = explorerStateSignature('https://example.test/locations', snapshot);
  assert.equal(
    doneHasObservableProgress(
      'Click Edit to open the location editor.',
      'https://example.test/locations',
      signature,
      'https://example.test/locations',
      snapshot,
      'The location card is visible.',
    ),
    false,
  );
  assert.equal(
    doneHasObservableProgress(
      'Click Edit to open the location editor.',
      'https://example.test/locations',
      signature,
      'https://example.test/locations',
      `${snapshot}\n- dialog "Edit location"\n  - textbox "Description" [ref=e9]`,
      'The editor is open.',
    ),
    true,
  );
  assert.equal(
    doneHasObservableProgress(
      'Verify the location card is visible.',
      'https://example.test/locations',
      signature,
      'https://example.test/locations',
      snapshot,
      'The card is visible.',
    ),
    true,
  );
  assert.equal(
    doneHasObservableProgress(
      'Click Save. If it appears already done, skip it.',
      'https://example.test/locations',
      signature,
      'https://example.test/locations',
      snapshot,
      'The requested change is already saved.',
    ),
    true,
  );
});

test('one-screen walks use a DOM label for nested radio controls instead of deferring them as icons', async () => {
  let url = 'https://example.test/upload';
  let clicks = 0;
  const snapshot = [
    '- LabelText "Standard 536 seconds available" [ref=e18] clickable',
    '  - radio [checked=false, ref=e22]',
    '- button "Continue" [disabled, ref=e21]',
  ].join('\n');
  const browser = {
    getUrl: () => url,
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    dialogStatus: () => undefined,
    fieldLabelAtRef: (ref: string) =>
      ref === '@e22' ? 'Standard 536 seconds available' : '',
    clickVisible: (ref: string) => {
      assert.equal(ref, '@e22');
      clicks++;
      url = 'https://example.test/story-type';
    },
    wait: () => undefined,
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      return '{"action":"click","ref":"@e22","reason":"Select the Standard plan"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal(
    'Select a plan, then advance one screen.',
    { maxSteps: 2, returnOnUrlChange: true },
  );

  assert.equal(result.success, true);
  assert.equal(clicks, 1);
  assert.equal(result.actions[0]?.resolvedLabel, 'Standard 536 seconds available');
  assert.doesNotMatch(result.stepsTaken.join('\n'), /deferred unlabeled progress click/i);
});

test('visible duplicate validation replaces and refills a rejected saved value once', async () => {
  let filledValue = '';
  let replacementCalls = 0;
  let llmCalls = 0;
  const initial = '- textbox "Enter the name" [ref=e1]\n- button "Create" [ref=e2]';
  const rejected =
    '- textbox "Enter the name" [ref=e9]\n' +
    '- text "This Avatar name is already in use"\n' +
    '- button "Finalize character" [ref=e10] [disabled]';
  const accepted =
    '- textbox "Enter the name" [ref=e9]\n' +
    '- button "Finalize character" [ref=e10]';
  const browser = {
    getUrl: () => 'https://example.test/character',
    snapshotInteractive: () => (filledValue === 'Jason' ? rejected : filledValue === 'Maya' ? accepted : initial),
    snapshotFull: () => (filledValue === 'Jason' ? rejected : filledValue === 'Maya' ? accepted : initial),
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => 'Enter the name',
    wait: () => undefined,
    screenshotAnnotated: (filePath: string) => fs.writeFileSync(filePath, Buffer.from('duplicate-name')),
    fillVisible: (_ref: string, value: string) => { filledValue = value; },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      if (!filledValue) return '{"action":"fill","ref":"@e1","value":"Jason","reason":"name the character"}';
      if (filledValue === 'Maya') return '{"action":"done","reason":"the replacement name is accepted"}';
      return '{"action":"fail","reason":"duplicate name"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, {
    llm,
    hooks: {
      onFillRequested: async (_label, proposed) => proposed,
      onRejectedFill: async () => {
        replacementCalls++;
        return 'Maya';
      },
    },
  }).achieveGoal('Create a character', { maxSteps: 6 });

  assert.equal(result.success, true);
  assert.equal(filledValue, 'Maya');
  assert.equal(replacementCalls, 1);
  assert.equal(llmCalls, 2);
  assert.match(result.stepsTaken.join('\n'), /human supplied a different value/i);
});

test('screenshot-only validation can replace and refill the most recent non-secret value', async () => {
  const fills: Array<[string, string]> = [];
  const snapshot = [
    '- textbox "Enter the name" [ref=e9]',
    '- button "Finalize character" [ref=e10] [disabled]',
  ].join('\n');
  const browser = {
    getUrl: () => 'https://example.test/character',
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    wait: () => undefined,
    fillVisible: (ref: string, value: string) => fills.push([ref, value]),
  } as unknown as AgentBrowser;
  const explorer = new Explorer(browser, {
    hooks: {
      onRejectedFill: async () => 'Nora',
    },
  });
  const result: ExplorerResult = {
    goal: 'Create a character',
    success: false,
    actions: [
      {
        action: 'fill',
        ref: 'e2',
        value: 'Nora Bennett',
        proposedValue: 'Jason',
        resolvedLabel: 'Enter the name',
        resolvedRole: 'textbox',
      },
    ],
    stepsTaken: [],
    finalUrl: 'https://example.test/character',
    finalSnapshot: snapshot,
  };

  assert.equal(
    await explorer.recoverRejectedFillFromVision(
      result,
      'Only letters are allowed. No spaces, numbers, or special characters.',
    ),
    true,
  );
  assert.deepEqual(fills, [['@e9', 'Nora']]);
  assert.equal(result.actions.at(-1)?.value, 'Nora');
  assert.match(result.stepsTaken.join('\n'), /vision rejected "Nora Bennett"/i);
});

test('validation owned by a later field does not invalidate an earlier field that remains visible', async () => {
  let postGeneration = false;
  let rejectedCalls = 0;
  const initial = '- textbox "Asset description" [ref=e1]';
  const final = [
    '- textbox "Asset description" [ref=e1]',
    '- textbox "Only letters and spaces are allowed" [ref=e2]',
    '- button "Finalize Asset" [ref=e3] [disabled]',
    '- text "Only letters and spaces are allowed"',
  ].join('\n');
  const browser = {
    getUrl: () => 'https://example.test/assets',
    snapshotInteractive: () => (postGeneration ? final : initial),
    snapshotFull: () => (postGeneration ? final : initial),
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => undefined,
    fillVisible: () => {
      postGeneration = true;
    },
  } as unknown as AgentBrowser;
  let llmCalls = 0;
  const llm = {
    async complete() {
      llmCalls++;
      return llmCalls === 1
        ? '{"action":"fill","ref":"@e1","value":"A red bicycle","reason":"describe asset"}'
        : '{"action":"fail","reason":"asset name is still required"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, {
    llm,
    hooks: {
      onFillRequested: async (_label, proposed) => proposed,
      onRejectedFill: async () => {
        rejectedCalls++;
        return 'A blue bicycle';
      },
    },
  }).achieveGoal('Create an asset', { maxSteps: 2 });

  assert.equal(result.success, false);
  assert.equal(rejectedCalls, 0);
  assert.match(result.stepsTaken.join('\n'), /different unfilled field.*refusing to overwrite/is);
});

test('a later distinct validation state may recover after an earlier constraint state', async () => {
  let stage = 0;
  let replacementCalls = 0;
  const snapshots = [
    '- textbox "Asset description" [ref=e1]\n- button "Generate Asset" [ref=e9]',
    [
      '- textbox "Asset description" [ref=e1]',
      '- textbox "Only letters and spaces are allowed" [ref=e2]',
      '- button "Finalize Asset" [ref=e3] [disabled]',
    ].join('\n'),
    [
      '- textbox "Asset description" [ref=e1]',
      '- textbox "Only letters and spaces are allowed" [ref=e2]',
      '- text "This asset name is already in use"',
      '- button "Finalize Asset" [ref=e3] [disabled]',
    ].join('\n'),
    [
      '- textbox "Asset description" [ref=e1]',
      '- textbox "Only letters and spaces are allowed" [ref=e2]',
      '- button "Finalize Asset" [ref=e3]',
    ].join('\n'),
  ];
  const browser = {
    getUrl: () => 'https://example.test/assets',
    snapshotInteractive: () => snapshots[stage],
    snapshotFull: () => snapshots[stage],
    dialogStatus: () => undefined,
    fieldLabelAtRef: (ref: string) =>
      ref.includes('e1') ? 'Asset description' : 'Only letters and spaces are allowed',
    wait: () => undefined,
    fillVisible: (ref: string, value: string) => {
      if (ref.includes('e1')) stage = 1;
      else if (value === 'Walnut Clock') stage = 2;
      else if (value === 'Maple Clock') stage = 3;
    },
    screenshotAnnotated: (filePath: string) => fs.writeFileSync(filePath, Buffer.from('validation-state')),
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      if (stage === 0) {
        return '{"action":"fill","ref":"@e1","value":"A walnut clock","reason":"describe asset"}';
      }
      if (stage === 1) {
        return '{"action":"fill","ref":"@e2","value":"Walnut Clock","reason":"name asset"}';
      }
      if (stage === 3) return '{"action":"done","reason":"replacement name accepted"}';
      return '{"action":"fail","reason":"duplicate name"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, {
    llm,
    hooks: {
      onFillRequested: async (_label, proposed) => proposed,
      onRejectedFill: async () => {
        replacementCalls++;
        return 'Maple Clock';
      },
    },
  }).achieveGoal('Create an asset', { maxSteps: 6 });

  assert.equal(result.success, true);
  assert.equal(replacementCalls, 1);
  assert.equal(stage, 3);
  assert.match(result.stepsTaken.join('\n'), /different unfilled field/i);
  assert.match(result.stepsTaken.join('\n'), /human supplied a different value/i);
});

test('prolonged text-only processing is released by visual completion after three polls', async () => {
  let waits = 0;
  let llmCalls = 0;
  const processingSnapshot = '- text "Generating location..."\n- button "Regenerate"';
  const browser = {
    getUrl: () => 'https://example.test/locations',
    snapshotInteractive: () => processingSnapshot,
    snapshotFull: () => processingSnapshot,
    dialogStatus: () => undefined,
    wait: () => {
      waits++;
    },
    screenshotAnnotated: (filePath: string) => fs.writeFileSync(filePath, Buffer.from('completed-location')),
    errorsJson: () => ({ data: { errors: [] } }),
    consoleJson: () => ({ data: { messages: [] } }),
    networkRequestsJson: () => ({ data: { requests: [] } }),
    clearSignals: () => undefined,
  } as unknown as AgentBrowser;
  const llm = {
    async complete(options: LlmCompletionOptions) {
      llmCalls++;
      if (options.image) {
        return '{"status":"complete","summary":"The generated location and post-generation controls are visible."}';
      }
      return '{"action":"done","reason":"The location generation has finished."}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Generate a location image', { maxSteps: 2 });
  assert.equal(result.success, true);
  assert.equal(waits, PROCESSING_VISION_POLL_THRESHOLD + 1);
  assert.equal(llmCalls, 2);
  assert.match(result.stepsTaken.join('\n'), /vision processing affirmation: complete/i);
});

test('processing release waits for controls to settle and finalizes before permitting another mutation', async () => {
  let waits = 0;
  let clickCalls = 0;
  let started = false;
  let finalized = false;
  const browser = {
    getUrl: () => 'https://example.test/character',
    snapshotInteractive: () => {
      if (!started) return '- button "Create" [ref=e0]';
      if (finalized) return '- text "Character saved"';
      if (waits < 2) return '- text "Generating avatar..."';
      if (waits === 2) return '- button "Add Character" [ref=e1]';
      return '- button "Review and finalize" [ref=e2]';
    },
    snapshotFull: () => {
      if (!started) return '- button "Create" [ref=e0]';
      if (finalized) return '- text "Character saved"';
      if (waits < 2) return '- text "Generating avatar..."';
      if (waits === 2) return '- button "Add Character" [ref=e1]';
      return '- button "Review and finalize" [ref=e2]';
    },
    dialogStatus: () => undefined,
    wait: () => {
      waits++;
    },
    clickVisible: (ref: string) => {
      clickCalls++;
      if (ref === '@e0') started = true;
      if (ref === '@e2') finalized = true;
    },
    errorsJson: () => ({ data: { errors: [] } }),
    consoleJson: () => ({ data: { messages: [] } }),
    networkRequestsJson: () => ({ data: { requests: [] } }),
    clearSignals: () => undefined,
  } as unknown as AgentBrowser;
  let llmCalls = 0;
  const llm = {
    async complete(_options: LlmCompletionOptions) {
      llmCalls++;
      if (llmCalls === 1) {
        return '{"action":"click","ref":"@e0","reason":"generate the character"}';
      }
      return '{"action":"done","reason":"the character was finalized"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Generate one character', { maxSteps: 2 });
  assert.equal(result.success, true);
  assert.equal(waits, 4);
  assert.equal(clickCalls, 2);
  assert.match(result.stepsTaken.join('\n'), /render stabilization/i);
  assert.match(result.stepsTaken.join('\n'), /post-processing continuation/i);
});

test('processing that exceeds its deterministic ceiling returns a structured timeout', async () => {
  const originalWait = config.deep.processingWaitMs;
  config.deep.processingWaitMs = 5;
  const processingSnapshot = '- text "Taking longer than expected. Server may be busy."';
  const browser = {
    getUrl: () => 'https://example.test/scriptEdit',
    snapshotInteractive: () => processingSnapshot,
    snapshotFull: () => processingSnapshot,
    dialogStatus: () => undefined,
    wait: () => {
      const deadline = Date.now() + 6;
      while (Date.now() < deadline) {
        // Simulate the browser's blocking wait without spending real seconds.
      }
    },
    errorsJson: () => ({ data: { errors: [] } }),
    consoleJson: () => ({ data: { messages: [] } }),
    networkRequestsJson: () => ({ data: { requests: [] } }),
    clearSignals: () => undefined,
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      throw new Error('LLM must not be called after a deterministic processing timeout');
    },
  } as unknown as LlmClient;

  try {
    const result = await new Explorer(browser, { llm }).achieveGoal('Wait for script generation', { maxSteps: 2 });
    assert.equal(result.success, false);
    assert.equal(result.processingTimedOut, true);
    assert.match(result.error ?? '', /processing-timeout/i);
  } finally {
    config.deep.processingWaitMs = originalWait;
  }
});

test('execution-level mutation denylist suppresses a repeated create click', async () => {
  let clickCalls = 0;
  const snapshot = '- button "Create" [ref=e1]';
  const browser = {
    getUrl: () => 'https://example.test/characters',
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => undefined,
    clickVisible: () => {
      clickCalls++;
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      return '{"action":"click","ref":"@e1","reason":"Create another character"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Recover without duplicating the artifact', {
    maxSteps: 1,
    blockedClickLabels: ['Create'],
  });
  assert.equal(result.success, false);
  assert.equal(clickCalls, 0);
  assert.equal(result.actions[0]?.executionFailed, true);
  assert.match(result.stepsTaken.join('\n'), /suppressed duplicate mutation click/i);
});

test('exact walk-entry fallback executes a mutation only once even when the LLM asks again', async () => {
  let clickCalls = 0;
  let llmCalls = 0;
  const snapshot = '- button "REGENERATE" [ref=e1]';
  const browser = {
    getUrl: () => 'https://example.test/assets',
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => undefined,
    clickVisible: () => {
      clickCalls++;
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      return '{"action":"click","ref":"@e1","reason":"start regeneration"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal(
    'Click the element labeled exactly "REGENERATE" to start that flow — not a similarly-named sidebar item. Use "done" once the screen changes.',
    { maxSteps: 3 },
  );
  assert.equal(result.success, true);
  assert.equal(clickCalls, 1);
  assert.equal(llmCalls, 2);
  assert.equal(result.actions[1]?.executionFailed, true);
  assert.match(result.stepsTaken.join('\n'), /already fired once/i);
});

test('exact walk-entry mutation is one-shot when its contextual accessible label becomes generic', async () => {
  let clickCalls = 0;
  let llmCalls = 0;
  let contextual = true;
  const browser = {
    getUrl: () => 'https://example.test/assets',
    snapshotInteractive: () =>
      contextual
        ? '- button "REGENERATE (Wayfinder Compass)" [ref=e1]'
        : '- button "REGENERATE" [ref=e1]',
    snapshotFull: () =>
      contextual
        ? '- button "REGENERATE (Wayfinder Compass)" [ref=e1]'
        : '- button "REGENERATE" [ref=e1]',
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => undefined,
    clickVisible: () => {
      clickCalls++;
      contextual = false;
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      return '{"action":"click","ref":"@e1","reason":"start regeneration"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal(
    'On "Your Assets": click "REGENERATE (Wayfinder Compass)" once, then wait until the named item is visibly finished and usable. Remaining on the same page is valid.',
    { maxSteps: 3 },
  );
  assert.equal(result.success, true);
  assert.equal(clickCalls, 1);
  assert.equal(llmCalls, 2);
  assert.match(result.stepsTaken.join('\n'), /already fired once/i);
});

test('an exact user-denied click is not sent through the guard twice', async () => {
  let guardCalls = 0;
  let llmCalls = 0;
  const snapshot = '- button "Buy Credits" [ref=e1]';
  const browser = {
    getUrl: () => 'https://example.test/pricing',
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => undefined,
    clickVisible: () => {
      throw new Error('denied click must never reach the page');
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      if (llmCalls < 3) return '{"action":"click","ref":"@e1","reason":"open checkout"}';
      return '{"action":"fail","reason":"the required action was denied"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, {
    llm,
    hooks: {
      beforeClick: async () => {
        guardCalls++;
        return false;
      },
    },
  }).achieveGoal('Open checkout', { maxSteps: 3 });

  assert.equal(result.success, false);
  assert.equal(guardCalls, 1);
  assert.match(result.stepsTaken.join('\n'), /suppressed retry of user-denied click/i);
});

test('an intervening edit starts a new mutation segment and permits Save again', async () => {
  let clickCalls = 0;
  let fillCalls = 0;
  let llmCalls = 0;
  const snapshot = [
    '- textbox "Dialogue" [ref=e1]',
    '- button "Save" [ref=e2]',
  ].join('\n');
  const browser = {
    getUrl: () => 'https://example.test/scriptEdit',
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => undefined,
    clickVisible: () => {
      clickCalls++;
    },
    fillVisible: () => {
      fillCalls++;
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      if (llmCalls === 1) return '{"action":"click","ref":"@e2","reason":"save first edit"}';
      if (llmCalls === 2) return '{"action":"fill","ref":"@e1","value":"Revised dialogue","reason":"revise again"}';
      return '{"action":"click","ref":"@e2","reason":"save revised edit"}';
    },
  } as unknown as LlmClient;

  await new Explorer(browser, {
    llm,
    hooks: { onFillRequested: async (_label, proposed) => proposed },
  }).achieveGoal('Edit and save the dialogue', { maxSteps: 3 });

  assert.equal(clickCalls, 2);
  assert.equal(fillCalls, 1);
});

test('a click that caused deterministic processing is not resubmitted after a failed verification edit', async () => {
  let clickCalls = 0;
  let processing = false;
  let llmCalls = 0;
  const readySnapshot = [
    '- textbox "Location description" [ref=e1]',
    '- button "Change Location" [ref=e2]',
  ].join('\n');
  const browser = {
    getUrl: () => 'https://example.test/locations',
    snapshotInteractive: () => (processing ? '- text "Generating location..."' : readySnapshot),
    snapshotFull: () => (processing ? '- text "Generating location..."' : readySnapshot),
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: (ms: number) => {
      if (ms >= 5000) processing = false;
    },
    clickVisible: () => {
      clickCalls++;
      processing = true;
    },
    fillVisible: () => undefined,
    errorsJson: () => ({ data: { errors: [] } }),
    consoleJson: () => ({ data: { messages: [] } }),
    networkRequestsJson: () => ({ data: { requests: [] } }),
    clearSignals: () => undefined,
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      if (llmCalls === 1) return '{"action":"click","ref":"@e2","reason":"generate changed location"}';
      if (llmCalls === 2) return '{"action":"fill","ref":"@e1","value":"Coastal station","reason":"restore requested text"}';
      return '{"action":"click","ref":"@e2","reason":"generate changed location again"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, {
    llm,
    hooks: { onFillRequested: async (_label, proposed) => proposed },
  }).achieveGoal('Change the location and verify the edit persists', { maxSteps: 3 });

  assert.equal(clickCalls, 1);
  assert.match(result.stepsTaken.join('\n'), /suppressed duplicate mutation click/i);
});

test('manual mode keeps distinct Add controls separate after later processing', async () => {
  let stage = 0;
  let processing = false;
  let addSelectionCalls = 0;
  let llmCalls = 0;
  let imageCalls = 0;
  const snapshot = () => {
    if (processing) return '- status "Saving uploaded character..."';
    if (stage >= 3) return '- text "Three persisted characters"\n- button "Next" [ref=e4]';
    return [
      '- button "Add Character" [ref=e1]',
      '- button "Save All" [ref=e2]',
      '- button "Add (1)" [ref=e3]',
    ].join('\n');
  };
  const browser = {
    getUrl: () => 'https://example.test/characters',
    snapshotInteractive: snapshot,
    snapshotFull: snapshot,
    dialogStatus: () => undefined,
    fieldLabelAtRef: (ref: string) => (ref === '@e3' ? 'Add (1)' : ''),
    wait: (ms: number) => {
      if (processing && ms >= 5000) processing = false;
    },
    clickVisible: (ref: string) => {
      if (ref === '@e1') stage = 1;
      if (ref === '@e2') {
        stage = 2;
        processing = true;
      }
      if (ref === '@e3') {
        addSelectionCalls++;
        stage = 3;
      }
    },
    screenshotAnnotated: (filePath: string) => {
      imageCalls++;
      fs.writeFileSync(filePath, Buffer.from('manual-state'));
    },
    errorsJson: () => ({ data: { errors: [] } }),
    consoleJson: () => ({ data: { messages: [] } }),
    networkRequestsJson: () => ({ data: { requests: [] } }),
    clearSignals: () => undefined,
  } as unknown as AgentBrowser;
  const llm = {
    async complete(options: LlmCompletionOptions) {
      llmCalls++;
      assert.ok(options.image, 'manual decisions should include the current screenshot');
      if (llmCalls === 1) return '{"action":"click","ref":"@e1","reason":"add a character slot"}';
      if (llmCalls === 2) return '{"action":"click","ref":"@e2","reason":"save the uploaded character"}';
      if (llmCalls === 3) {
        return '{"action":"click","ref":"@e3","reason":"VISUALLY CONFIRMED: the button shows Add (1), committing the selected existing character"}';
      }
      return '{"action":"done","reason":"three persisted characters are visible"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal(
    'Create three characters using three different methods and visibly verify them',
    { maxSteps: 4, manualMode: true },
  );

  assert.equal(result.success, true);
  assert.equal(addSelectionCalls, 1, result.stepsTaken.join('\n'));
  assert.equal(imageCalls, llmCalls);
  assert.doesNotMatch(
    result.stepsTaken.join('\n'),
    /suppressed duplicate mutation click .*"Add \(1\)"/i,
  );
});

test('manual no-effect mutations stay unproven and are not saved as successful actions', async () => {
  let llmCalls = 0;
  let clickCalls = 0;
  const snapshot = '- button "Add (1)" [ref=e1]';
  const browser = {
    getUrl: () => 'https://example.test/characters',
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => undefined,
    clickVisible: () => {
      clickCalls++;
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      if (llmCalls === 1) {
        return '{"action":"click","ref":"@e1","reason":"commit the selected character"}';
      }
      return '{"action":"fail","reason":"the enabled control had no observable effect"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal(
    'Commit the selected character',
    { maxSteps: 2, manualMode: true },
  );

  assert.equal(result.success, false);
  assert.equal(clickCalls, 1);
  assert.equal(result.actions[0]?.executionFailed, true);
  assert.match(result.stepsTaken.join('\n'), /no observable application-state change/i);
});

test('manual read-only proof blocks a destructive click before it reaches the browser', async () => {
  let llmCalls = 0;
  let clickCalls = 0;
  const snapshot = '- button "Delete" [ref=e1]\n- text "Existing item remains"';
  const browser = {
    getUrl: () => 'https://example.test/items',
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => 'Delete',
    wait: () => undefined,
    clickVisible: () => {
      clickCalls++;
    },
    screenshotAnnotated: (filePath: string) =>
      fs.writeFileSync(filePath, Buffer.from('proof')),
    errorsJson: () => ({ data: { errors: [] } }),
    consoleJson: () => ({ data: { messages: [] } }),
    networkRequestsJson: () => ({ data: { requests: [] } }),
    clearSignals: () => undefined,
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      return llmCalls === 1
        ? '{"action":"click","ref":"@e1","reason":"delete another item"}'
        : '{"action":"done","reason":"the existing state is visible"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal(
    'Read-only verification of the existing state',
    { maxSteps: 2, manualMode: true, manualReadOnly: true },
  );

  assert.equal(result.success, true);
  assert.equal(clickCalls, 0);
  assert.match(result.stepsTaken.join('\n'), /blocked mutation during manual read-only proof/i);
});

test('one-screen deep-walk goal returns immediately after a URL transition', async () => {
  let url = 'https://example.test/upload';
  let llmCalls = 0;
  const snapshot = '- button "Continue" [ref=e1]';
  const browser = {
    getUrl: () => url,
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => undefined,
    clickVisible: () => {
      url = 'https://example.test/theme';
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      return '{"action":"click","ref":"@e1","reason":"Advance one screen"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Advance exactly one screen', {
    maxSteps: 8,
    returnOnUrlChange: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.finalUrl, 'https://example.test/theme');
  assert.equal(llmCalls, 1);
  assert.match(result.stepsTaken.join('\n'), /returning control to the deep walker/i);
});

test('one-screen deep-walk goal also returns when navigation completes during a wait', async () => {
  let url = 'https://example.test/transcript';
  let llmCalls = 0;
  let waits = 0;
  const snapshot = '- button "Save and Continue" [ref=e1]';
  const browser = {
    getUrl: () => url,
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => {
      waits++;
      url = 'https://example.test/theme';
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      return '{"action":"wait","reason":"Save was submitted; wait for the next screen"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Advance exactly one screen', {
    maxSteps: 8,
    returnOnUrlChange: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.finalUrl, 'https://example.test/theme');
  assert.equal(llmCalls, 1);
  assert.ok(waits >= 1);
  assert.match(result.stepsTaken.join('\n'), /returning control to the deep walker/i);
});

test('one-screen deep-walk goal catches navigation that commits after the post-action check', async () => {
  let urlReads = 0;
  let llmCalls = 0;
  const browser = {
    getUrl: () => {
      urlReads++;
      // Initial URL, first loop URL, and immediate post-click boundary are
      // still stale. The SPA commits before the next loop begins.
      return urlReads <= 3
        ? 'https://example.test/upload'
        : 'https://example.test/select-story-type';
    },
    snapshotInteractive: () => '- button "Open details" [ref=e1]',
    snapshotFull: () => '- button "Open details" [ref=e1]',
    clickVisible: () => undefined,
    dialogStatus: () => undefined,
    wait: () => undefined,
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      return '{"action":"click","ref":"@e1","reason":"open details"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Open details', {
    maxSteps: 4,
    returnOnUrlChange: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.finalUrl, 'https://example.test/select-story-type');
  assert.equal(llmCalls, 1);
  assert.match(result.stepsTaken.join('\n'), /delayed URL transition at loop start/i);
});

test('one-screen Next waits for a delayed SPA route before asking the LLM again', async () => {
  let urlReads = 0;
  let llmCalls = 0;
  let waits = 0;
  const browser = {
    getUrl: () => {
      urlReads++;
      return urlReads <= 3
        ? 'https://example.test/upload'
        : 'https://example.test/story-type';
    },
    snapshotInteractive: () => '- button "Next" [ref=e1]',
    snapshotFull: () => '- button "Next" [ref=e1]',
    clickVisible: () => undefined,
    dialogStatus: () => undefined,
    wait: () => {
      waits++;
    },
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      return '{"action":"click","ref":"@e1","reason":"advance"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Advance exactly one screen', {
    maxSteps: 4,
    returnOnUrlChange: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.finalUrl, 'https://example.test/story-type');
  assert.equal(llmCalls, 1);
  assert.ok(waits >= 2);
  assert.match(result.stepsTaken.join('\n'), /one-screen goal advanced by URL transition/i);
});

test('one-screen boundary is rechecked after a processing transition', async () => {
  let url = 'https://example.test/upload';
  let started = false;
  let waits = 0;
  let llmCalls = 0;
  const browser = {
    getUrl: () => url,
    snapshotInteractive: () =>
      !started
        ? '- button "Upload" [ref=e1]'
        : waits < 2
          ? '- status "Processing upload..."'
          : '- button "Character Driven" [ref=e2]',
    snapshotFull: () =>
      !started
        ? '- button "Upload" [ref=e1]'
        : waits < 2
          ? '- status "Processing upload..."'
          : '- button "Character Driven" [ref=e2]',
    dialogStatus: () => undefined,
    fieldLabelAtRef: () => '',
    wait: () => {
      waits++;
      if (started && waits >= 2) url = 'https://example.test/story-type';
    },
    clickVisible: () => {
      started = true;
    },
    errorsJson: () => ({ data: { errors: [] } }),
    consoleJson: () => ({ data: { messages: [] } }),
    networkRequestsJson: () => ({ data: { requests: [] } }),
    clearSignals: () => undefined,
  } as unknown as AgentBrowser;
  const llm = {
    async complete() {
      llmCalls++;
      return '{"action":"click","ref":"@e1","reason":"upload is ready; advance"}';
    },
  } as unknown as LlmClient;

  const result = await new Explorer(browser, { llm }).achieveGoal('Complete upload only', {
    maxSteps: 8,
    returnOnUrlChange: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.finalUrl, 'https://example.test/story-type');
  assert.equal(llmCalls, 1);
  assert.match(result.stepsTaken.join('\n'), /advanced after processing/i);
});

test('extracts the authoritative explicit edit value from a goal', () => {
  assert.equal(
    explicitGoalValue('Edit transcript\nWhen entering test text, use exactly: "The quiet dawn"'),
    'The quiet dawn',
  );
});

test('credential labels use the protected fill channel', () => {
  assert.equal(isSensitiveFieldLabel('PASSWORD'), true);
  assert.equal(isSensitiveFieldLabel('Email address'), true);
  assert.equal(isSensitiveFieldLabel('Character name'), false);
});
