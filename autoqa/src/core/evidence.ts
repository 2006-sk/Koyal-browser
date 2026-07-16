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

/**
 * Patch just the Verdict/Reasons lines of an ALREADY-WRITTEN step-summary.md.
 *
 * `recordVerifiedStep` (scenario-runner.ts) writes this file with the raw,
 * immediate deterministic verdict and returns — but `flow-runner.ts`'s
 * `runMilestone` goes on to mutate `step.result.verdict` in-memory several
 * times AFTER that point (explorer-failure downgrade, KB-statement verdict
 * flip, human-escalation override). Those mutations correctly flow into the
 * final aggregate report (same in-memory `TestStep` object), but nothing ever
 * went back and updated the per-step file already on disk — confirmed live on
 * webdriveruniversity.com: a to-do-list milestone whose explorer never
 * confirmed the goal (no Enter-key action available, see the `press` explorer
 * action fix) got its file written as "Verdict: pass" with no reasons, then
 * downgraded to needs-review and left there after human triage — the file
 * kept saying "pass" forever, disagreeing with both the console's later human
 * escalation and the correct final count. Call this once the verdict is truly
 * final, only when it actually changed from what was originally written.
 */
export function patchStepSummaryVerdict(artifactDir: string, verdict: string, reasons?: string[]): void {
  const filePath = path.join(artifactDir, 'step-summary.md');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const reasonsLine = reasons?.length ? `**Reasons:** ${reasons.join('; ')}` : '';
    let updated = content.replace(/\*\*Verdict:\*\*.*/, `**Verdict:** ${verdict}`);
    if (/^\*\*Reasons:\*\*.*/m.test(updated)) {
      updated = reasonsLine
        ? updated.replace(/^\*\*Reasons:\*\*.*/m, reasonsLine)
        : updated.replace(/\n\*\*Reasons:\*\*.*/, '');
    } else if (reasonsLine) {
      updated = updated.replace(/(\*\*Verdict:\*\*.*)/, `$1\n${reasonsLine}`);
    }
    fs.writeFileSync(filePath, updated, 'utf8');
  } catch {
    // best-effort — never let report-patching break an otherwise-successful run
  }
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
