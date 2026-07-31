import { spawnSync } from 'node:child_process';

const tests = [
  {
    id: 1,
    name: 'create-ai-character',
    prompt:
      'Go to Characters and create exactly one new AI-generated character with a realistic human name and description. Finalize it and verify it persists in the character library.',
  },
  {
    id: 2,
    name: 'create-existing-character',
    prompt:
      'Start a new character-driven project, select exactly one character from the existing character library, confirm the selection, and verify that character is attached to the project.',
  },
  {
    id: 3,
    name: 'upload-character',
    prompt:
      'Go to Characters and create exactly one new character using a character image file I provide. Use a realistic human name, finalize it, and verify it persists in the character library.',
  },
  {
    id: 4,
    name: 'outfit-for-aditi',
    prompt:
      'Go to Outfits, search for Aditi, visibly confirm Aditi is the selected character, create one new professional black evening outfit for Aditi, and verify the outfit persists under Aditi.',
  },
  {
    id: 5,
    name: 'create-reusable-asset',
    prompt:
      'Go to Assets and create exactly one new reusable vintage roadster asset with a realistic name and description. Finalize it and verify it persists in the asset library.',
  },
  {
    id: 6,
    name: 'location-lifecycle',
    prompt:
      'Go to Locations, create exactly one new disposable test location with a realistic name and description, edit its name, verify the edit persists, then delete only that newly created location and verify it is gone.',
  },
  {
    id: 7,
    name: 'dialogue-and-voice',
    prompt:
      'Open a project transcript editor, change one character voice, change the emotion of one dialogue line, edit the spoken text of a different line, and verify all three changes persist.',
  },
  {
    id: 8,
    name: 'scene-camera-angle',
    prompt:
      'Open a project with generated scenes, change the camera angle of exactly one scene to a clearly different perspective, wait for processing, and verify the changed scene persists.',
  },
  {
    id: 9,
    name: 'delete-ten-characters',
    prompt:
      'Go to Characters and delete exactly 10 existing characters. Record each character name before deleting it, confirm each deletion through the normal safety prompt, verify each character disappears, and stop after exactly 10 deletions.',
  },
  {
    id: 10,
    name: 'delete-ten-projects',
    prompt:
      'Go to Projects and delete exactly 10 existing projects total, including both In Progress and Completed or Exported projects when both statuses are available. Record each project title and status before deleting it, confirm each deletion through the normal safety prompt, verify each project disappears, and stop after exactly 10 deletions.',
  },
];

function valueAfter(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const url = valueAfter('--url', 'https://beta.koyal.ai');
const requestedTests = new Set(
  valueAfter('--tests', tests.map((test) => test.id).join(','))
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite),
);
const engines = valueAfter('--engines', 'v1,v2')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter((value) => value === 'v1' || value === 'v2');
const budget = valueAfter('--budget', '250');
const maxSteps = valueAfter('--max-steps', '40');

if (engines.length === 0) {
  throw new Error('Use --engines v1,v2, v1, or v2.');
}

const selected = tests.filter((test) => requestedTests.has(test.id));
if (selected.length === 0) {
  throw new Error('No matching matrix tests. Use --tests with IDs 1-10.');
}

const results = [];
for (const test of selected) {
  for (const engine of engines) {
    const session = `autoqa-manual-matrix-${engine}-${test.id}-${Date.now()}`;
    console.log(`\n[matrix] ▶ test ${test.id} ${test.name} · ${engine}`);
    const args = [
      '--import',
      'tsx',
      'src/cli.ts',
      'run',
      '--url',
      url,
      '--manual',
      test.prompt,
      '--budget',
      budget,
      '--max-steps',
      maxSteps,
    ];
    if (engine === 'v2') args.splice(args.indexOf('--manual'), 0, '--manual-v2');
    const run = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTOQA_SESSION: session,
        AUTOQA_EXHAUSTIVE: 'true',
      },
      stdio: 'inherit',
    });
    results.push({
      test: test.id,
      name: test.name,
      engine,
      exitCode: run.status ?? 1,
    });
  }
}

console.log('\n[matrix] results');
for (const result of results) {
  console.log(
    `[matrix] ${result.exitCode === 0 ? 'completed' : 'reported failure'} · ` +
      `test ${result.test} ${result.name} · ${result.engine} · exit ${result.exitCode}`,
  );
}
