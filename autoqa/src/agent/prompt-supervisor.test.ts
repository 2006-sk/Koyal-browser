import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LlmClient, LlmCompletionOptions } from '../core/llm/client.js';
import { ProductionPromptSupervisor } from './prompt-supervisor.js';

function supervisorWith(reply: string): ProductionPromptSupervisor {
  return new ProductionPromptSupervisor({
    complete: async () => reply,
  } as unknown as LlmClient);
}

test('production supervisor refuses secrets without calling the LLM', async () => {
  let called = false;
  const supervisor = new ProductionPromptSupervisor({
    complete: async () => {
      called = true;
      return '{}';
    },
  } as unknown as LlmClient);
  assert.equal(await supervisor.answer('Enter account password'), undefined);
  assert.equal(called, false);
});

test('production supervisor denies an unallowlisted destructive action', async () => {
  const decision = await supervisorWith('{}').answer(
    'About to click "Delete Project" on page "projects" — this looks destructive/irreversible. Allow? [y]es / [n]o / [a]lways / [n]ever',
  );
  assert.equal(decision?.answer, 'no');
});

test('production supervisor permits only a browser-grounded empty draft-slot cleanup', async () => {
  const supervisor = supervisorWith('{}');
  const decision = await supervisor.answer(
    'About to click "Remove character" on page "wizard-story-type" — this looks destructive/irreversible. Allow? [y]es / [n]o / [a]lways / [n]ever\n' +
      'Current browser-agent evidence: Character 1 is an empty unfinalized placeholder slot that disables Next; remove this extra slot.',
  );
  assert.equal(decision?.answer, 'yes');

  const confirmation = await supervisor.answer(
    'About to click "Remove" on page "wizard-story-type" — this looks destructive/irreversible. Allow? [y]es / [n]o / [a]lways / [n]ever\n' +
      'Current browser-agent evidence: Confirm removal of the empty extra character slot that blocks Next.',
  );
  assert.equal(confirmation?.answer, 'yes');
});

test('production supervisor permits a grounded duplicate asset hindrance but not unrelated deletion', async () => {
  const supervisor = supervisorWith('{}');
  const assetCleanup = await supervisor.answer(
    'About to click "Delete asset" on page "assets-list" — this looks destructive/irreversible. Allow? [y]es / [n]o / [a]lways / [n]ever\n' +
      'Current browser-agent evidence: This duplicate stale asset is blocking creation with the required unique name.',
  );
  assert.equal(assetCleanup?.answer, 'yes');

  const projectDeletion = await supervisor.answer(
    'About to click "Delete Project" on page "projects" — this looks destructive/irreversible. Allow? [y]es / [n]o / [a]lways / [n]ever\n' +
      'Current browser-agent evidence: Delete the current project.',
  );
  assert.equal(projectDeletion?.answer, 'no');
});

test('production supervisor does not allow deleting a required finalized character without a hindrance', async () => {
  const decision = await supervisorWith('{}').answer(
    'About to click "Remove character" on page "wizard-story-type" — this looks destructive/irreversible. Allow? [y]es / [n]o / [a]lways / [n]ever\n' +
      'Current browser-agent evidence: TheoSullivan is a finalized required character.',
  );
  assert.equal(decision?.answer, 'no');
});

test('production supervisor selects only an existing suggested upload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-supervisor-'));
  const file = path.join(dir, 'script.pdf');
  fs.writeFileSync(file, 'fixture');
  try {
    const decision = await supervisorWith('{}').answer(
      `The agent needs a pdf file to upload. Local path?\n  suggestions:\n    ${file}\n    /not/real.pdf`,
    );
    assert.equal(decision?.answer, file);
    const downstreamAudioDecision = await supervisorWith('{}').answer(
      `The agent needs a pdf file to upload (Upload this script to generate audio). Local path?\n  suggestions:\n    ${file}`,
    );
    assert.equal(
      downstreamAudioDecision?.answer,
      file,
      'the explicit upload type outranks incidental downstream output wording',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production supervisor selects the semantically requested file type, not the first path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-supervisor-'));
  const audio = path.join(dir, 'voice.wav');
  const image = path.join(dir, 'avatar.png');
  fs.writeFileSync(audio, 'audio');
  fs.writeFileSync(image, 'image');
  try {
    const decision = await supervisorWith('{}').answer(
      `Upload the provided character image. Local path?\n  suggestions:\n    ${audio}\n    ${image}`,
    );
    assert.equal(decision?.answer, image);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production supervisor reads image-upload intent from an owning character-slot reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-supervisor-'));
  const audio = path.join(dir, 'voice.wav');
  const image = path.join(dir, 'avatar.png');
  fs.writeFileSync(audio, 'audio');
  fs.writeFileSync(image, 'image');
  try {
    const decision = await supervisorWith('{}').answer(
      `The agent needs a file to upload (Use the in-flow character slot's own Choose files upload control to perform the image-upload character method for the empty Character 1 slot.). Local path?\n` +
        `  suggestions:\n    ${audio}\n    ${image}`,
    );
    assert.equal(decision?.answer, image);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production supervisor uses vision only as a constrained fallback for ambiguous mixed uploads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-supervisor-'));
  const audio = path.join(dir, 'voice.wav');
  const image = path.join(dir, 'avatar.png');
  const screenshot = path.join(dir, 'screen.png');
  for (const file of [audio, image, screenshot]) fs.writeFileSync(file, 'fixture');
  let sawImage = false;
  const supervisor = new ProductionPromptSupervisor(
    {
      complete: async (options: LlmCompletionOptions) => {
        sawImage = Boolean(options.image);
        return JSON.stringify({
          answer: image,
          reason: 'The visible owning control is a character image uploader.',
        });
      },
    } as unknown as LlmClient,
    () => ({
      screenshotPath: screenshot,
      snapshot: 'Create character — Choose files — image preview',
      url: 'https://example.test/characters',
    }),
  );
  try {
    const decision = await supervisor.answer(
      `The agent needs a file to upload. Local path?\n  suggestions:\n    ${audio}\n    ${image}`,
    );
    assert.equal(sawImage, true);
    assert.equal(decision?.answer, image);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vision fallback cannot invent an upload path outside the offered files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-supervisor-'));
  const audio = path.join(dir, 'voice.wav');
  const image = path.join(dir, 'avatar.png');
  const screenshot = path.join(dir, 'screen.png');
  for (const file of [audio, image, screenshot]) fs.writeFileSync(file, 'fixture');
  const supervisor = new ProductionPromptSupervisor(
    { complete: async () => JSON.stringify({ answer: '/tmp/invented.png', reason: 'guess' }) } as unknown as LlmClient,
    () => ({ screenshotPath: screenshot, snapshot: 'Choose files', url: 'https://example.test' }),
  );
  try {
    assert.equal(
      await supervisor.answer(`The agent needs a file to upload. Local path?\n  suggestions:\n    ${audio}\n    ${image}`),
      undefined,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production supervisor ignores mixed suggestion filenames when inferring the requested type', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-supervisor-'));
  const pdf = path.join(dir, 'script.pdf');
  const audio = path.join(dir, 'voice.wav');
  const image = path.join(dir, 'avatar.png');
  const video = path.join(dir, 'reference.mp4');
  for (const file of [pdf, audio, image, video]) fs.writeFileSync(file, 'fixture');
  const suggestions = `  suggestions:\n    ${pdf}\n    ${audio}\n    ${image}\n    ${video}`;
  try {
    const supervisor = supervisorWith('{}');
    const pdfDecision = await supervisor.answer(`The agent needs a pdf file to upload. Local path?\n${suggestions}`);
    const audioDecision = await supervisor.answer(`The agent needs an audio file to upload. Local path?\n${suggestions}`);
    const imageDecision = await supervisor.answer(`The agent needs a character image file. Local path?\n${suggestions}`);
    const videoDecision = await supervisor.answer(`The agent needs a reference video file. Local path?\n${suggestions}`);
    assert.equal(pdfDecision?.answer, pdf);
    assert.equal(audioDecision?.answer, audio);
    assert.equal(imageDecision?.answer, image);
    assert.equal(videoDecision?.answer, video);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production supervisor refuses a mismatched upload when no compatible file exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-supervisor-'));
  const audio = path.join(dir, 'voice.wav');
  fs.writeFileSync(audio, 'audio');
  try {
    const decision = await supervisorWith('{}').answer(
      `Upload the provided character image. Local path?\n  suggestions:\n    ${audio}`,
    );
    assert.equal(decision, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production supervisor never substitutes image or audio for a required reference video', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-supervisor-'));
  const audio = path.join(dir, 'voice.wav');
  const image = path.join(dir, 'avatar.png');
  fs.writeFileSync(audio, 'audio');
  fs.writeFileSync(image, 'image');
  try {
    const decision = await supervisorWith('{}').answer(
      `Upload reference video for motion capture. Local path?\n  suggestions:\n    ${audio}\n    ${image}`,
    );
    assert.equal(decision, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production supervisor rejects an answer outside offered choices', async () => {
  const supervisor = supervisorWith('{"answer":"maybe","reason":"uncertain"}');
  assert.equal(
    await supervisor.answer('Classify this statement [s]uccess / [f]ailure / [n]oise'),
    undefined,
  );
});

test('production supervisor accepts only the exact offered audit choice', async () => {
  const decision = await supervisorWith('{"answer":"skip","reason":"evidence is ambiguous"}').answer(
    'Step is ambiguous. Verdict? [p]ass / [f]ail / [s]kip',
  );
  assert.equal(decision?.answer, 'skip');
});

test('production supervisor accepts a realistic semantic field answer', async () => {
  let optionsSeen: { temperature?: number } | undefined;
  const supervisor = new ProductionPromptSupervisor({
    complete: async (options: LlmCompletionOptions) => {
      optionsSeen = options;
      return '{"answer":"Riverside Café 27","reason":"realistic unique location name"}';
    },
  } as unknown as LlmClient);
  const decision = await supervisor.answer(
    'What should AutoQA enter for the Location Name field? Suggested value: Pink Sports Car',
  );
  assert.equal(decision?.answer, 'Riverside Café 27');
  assert.equal(optionsSeen?.temperature, undefined);
});

test('production supervisor keeps constrained artifact names single-token and rotates after rejection', async () => {
  const supervisor = supervisorWith('{"answer":"should not be called","reason":"fallback"}');
  const first = await supervisor.answer(
    'A new artifact is being created, so field ""Enter the name"" needs a fresh value.\nPrevious value (do not reuse): Ronan\nSuggestion (copy or edit it if it is different): Jason',
  );
  assert.equal(first?.answer, 'Jason');
  const replacement = await supervisor.answer(
    'The site rejected "Jason" for field "Enter the name".\nEnter a different realistic value.',
  );
  assert.equal(replacement?.answer, 'NolanMercer');
  const third = await supervisor.answer(
    'The site rejected "NolanMercer" for field "Enter the name".\nEnter a different realistic value.',
  );
  assert.equal(third?.answer, 'PriyaKapoor');
});

test('production supervisor rotates names for generated upload name modals', async () => {
  const supervisor = supervisorWith('{}');
  const question =
    'A new artifact is being created, so field ""Add a name for image 1..."" on "wizard-story-type" needs a fresh value.\n' +
    'Previous value (do not reuse): Jason\nSuggestion (copy or edit it if it is different): Jason';
  const first = await supervisor.answer(question);
  const second = await supervisor.answer(question);
  assert.match(first?.answer ?? '', /^[A-Za-z]+$/);
  assert.match(second?.answer ?? '', /^[A-Za-z]+$/);
  assert.notEqual(first?.answer, 'Jason');
  assert.notEqual(first?.answer, second?.answer);
});

test('production supervisor rotates a rejected multiword asset name immediately', async () => {
  const supervisor = supervisorWith('{"answer":"Scarlet Roadster","reason":"bad repeat"}');
  const first = await supervisor.answer(
    'The site rejected "Scarlet Roadster" for field "Only letters and spaces between words are allowed (a-z, A-Z).". Enter a different realistic value.',
  );
  const second = await supervisor.answer(
    `The site rejected "${first?.answer}" for field "Asset name". Enter a different realistic value.`,
  );
  assert.notEqual(first?.answer, 'Scarlet Roadster');
  assert.notEqual(second?.answer, first?.answer);
});

test('production supervisor preserves grounded dialogue and story suggestions for blank labels', async () => {
  const supervisor = supervisorWith('{"answer":"wrong fallback","reason":"should not run"}');
  const dialogue = await supervisor.answer(
    'Value needed for field """" on "wizard-edit-script".\nSuggestion (copy or edit it if you want): [exhales] Perfect, thank you so much.',
  );
  const theme = await supervisor.answer(
    'Value needed for field """" on "wizard-theme".\nSuggestion (copy or edit it if you want): Two engineers share a quiet moment at a warm coffee shop after work.',
  );
  assert.equal(dialogue?.answer, '[exhales] Perfect, thank you so much.');
  assert.equal(theme?.answer, 'Two engineers share a quiet moment at a warm coffee shop after work.');
});

test('production supervisor fails an audit that explicitly lacks same-run creation proof', async () => {
  const decision = await supervisorWith('{"answer":"pass","reason":"old item visible"}').answer(
    'Step "Create and verify character" is ambiguous (Creation milestone filled content but did not prove a Create/Generate/Finalize/Save action and persisted item). Verdict? [p]ass / [f]ail / [s]kip',
  );
  assert.equal(decision?.answer, 'fail');
  assert.match(decision?.reason ?? '', /not proven/i);
});
