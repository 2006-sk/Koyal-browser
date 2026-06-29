import fs from 'node:fs';
import path from 'node:path';
import type { SignalBundle, TestStep, VerificationResult } from './types.js';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

export function writeJson(filePath: string, data: unknown): void {
  writeText(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export interface StepArtifactMeta {
  workflow: string;
  action: string;
  verdict: string;
  reasons?: string[];
  explorerSteps?: string[];
}

export async function captureStepArtifacts(
  evidenceDir: string,
  slug: string,
  signals: SignalBundle,
  stepsToReproduce: string[],
  meta: StepArtifactMeta,
  browserScreenshot: (filePath: string) => void,
): Promise<string[]> {
  ensureDir(evidenceDir);
  const stepDir = path.join(evidenceDir, slug);
  ensureDir(stepDir);
  const files: string[] = [];

  const screenshotPath = path.join(stepDir, 'screenshot.png');
  try {
    browserScreenshot(screenshotPath);
    files.push(screenshotPath);
  } catch (error) {
    const errPath = path.join(stepDir, 'screenshot-error.txt');
    writeText(errPath, String(error));
    files.push(errPath);
  }

  writeJson(path.join(stepDir, 'signals.json'), signals);
  files.push(path.join(stepDir, 'signals.json'));

  writeJson(path.join(stepDir, 'console.json'), {
    all: signals.consoleMessages,
    errors: signals.consoleErrors,
  });
  files.push(path.join(stepDir, 'console.json'));

  writeJson(path.join(stepDir, 'network.json'), {
    filtered: signals.networkRequests,
    note: 'Filtered requests from verification expectation; see network-all.json for unfiltered capture.',
  });
  files.push(path.join(stepDir, 'network.json'));

  writeText(path.join(stepDir, 'snapshot-interactive.txt'), signals.snapshot.interactive);
  files.push(path.join(stepDir, 'snapshot-interactive.txt'));

  writeText(path.join(stepDir, 'snapshot-full.txt'), signals.snapshot.raw);
  files.push(path.join(stepDir, 'snapshot-full.txt'));

  writeText(
    path.join(stepDir, 'step-summary.md'),
    [
      `# ${meta.workflow}`,
      '',
      `**Action:** ${meta.action}`,
      `**Verdict:** ${meta.verdict}`,
      meta.reasons?.length ? `**Reasons:** ${meta.reasons.join('; ')}` : '',
      `**URL:** ${signals.url}`,
      `**Title:** ${signals.title}`,
      '',
      '## Explorer / agent actions',
      ...(meta.explorerSteps?.length
        ? meta.explorerSteps.map((s, i) => `${i + 1}. ${s}`)
        : ['_No LLM explorer steps recorded for this verification point._']),
      '',
      '## Reproduction steps',
      ...stepsToReproduce.map((s, i) => `${i + 1}. ${s}`),
      '',
      '## Artifacts in this folder',
      '- `screenshot.png` — annotated screenshot',
      '- `snapshot-interactive.txt` — interactive accessibility tree (`snapshot -i`)',
      '- `snapshot-full.txt` — full accessibility tree',
      '- `console.json` — browser console (all + errors)',
      '- `network.json` — network requests (filtered)',
      '- `network-all.json` — all captured network requests',
      '- `page-errors.json` — uncaught JS exceptions',
      '- `signals.json` — combined signal bundle',
    ].join('\n'),
  );
  files.push(path.join(stepDir, 'step-summary.md'));

  writeText(
    path.join(stepDir, 'repro-steps.md'),
    stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join('\n'),
  );
  files.push(path.join(stepDir, 'repro-steps.md'));

  return files;
}

export function captureNetworkAll(
  stepDir: string,
  networkAll: unknown[],
): string {
  const filePath = path.join(stepDir, 'network-all.json');
  writeJson(filePath, networkAll);
  return filePath;
}

export function capturePageErrors(stepDir: string, errors: unknown[]): string {
  const filePath = path.join(stepDir, 'page-errors.json');
  writeJson(filePath, errors);
  return filePath;
}

/** @deprecated use captureStepArtifacts */
export async function captureEvidence(
  evidenceDir: string,
  slug: string,
  signals: SignalBundle,
  stepsToReproduce: string[],
  browserScreenshot: (filePath: string) => void,
): Promise<string[]> {
  return captureStepArtifacts(
    evidenceDir,
    slug,
    signals,
    stepsToReproduce,
    { workflow: slug, action: slug, verdict: 'unknown' },
    browserScreenshot,
  );
}

export function attachEvidenceToStep(step: TestStep, evidenceDir: string, files: string[]): TestStep {
  return {
    ...step,
    evidenceDir,
    evidenceFiles: files,
    artifactDir: files.find((f) => f.endsWith('step-summary.md'))?.replace(/\/step-summary\.md$/, ''),
  };
}

export function relativeEvidencePath(runDir: string, filePath: string): string {
  return path.relative(runDir, filePath);
}

export function writeArtifactsIndex(runDir: string, scenarios: Array<{ id: string; steps: TestStep[] }>): void {
  const lines: string[] = [
    '# Run Artifacts Index',
    '',
    'Every verification step saves a folder under `<scenario>/<step-slug>/` with screenshots, snapshots, console, and network data.',
    '',
  ];

  for (const scenario of scenarios) {
    lines.push(`## ${scenario.id}`);
    lines.push('');
    for (const step of scenario.steps) {
      const dir = step.artifactDir ?? step.evidenceDir ?? '—';
      const rel = path.relative(runDir, dir);
      lines.push(
        `- **${step.workflow}** (${step.result.verdict}) → [\`step-summary.md\`](${rel}/step-summary.md)`,
      );
    }
    lines.push('');
  }

  writeText(path.join(runDir, 'ARTIFACTS.md'), lines.join('\n'));
}
