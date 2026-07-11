#!/usr/bin/env node
/**
 * Script path probe — LLM + snapshot discovery (no hardcoded navigation).
 * Artifacts: happyflow/script-path-probe/reports/<runId>/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, requireLlm } from './config.js';
import { AgentBrowser } from './lib/agent-browser.js';
import { runScriptPathProbe } from './probe/script-milestones.js';
import { describeScriptPhase } from './probe/script-phase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const happyflowRoot = path.resolve(__dirname, '../../happyflow');
const defaultScript = path.join(happyflowRoot, 'sample-script.txt');
const fallbackScript = path.join(happyflowRoot, 'test-script-coffee-shop-heist.txt');
const reportsRoot = path.join(happyflowRoot, 'script-path-probe/reports');

function resolveScript(): string {
  const fromEnv = process.env.SCRIPT_FILE;
  if (fromEnv) {
    const p = path.resolve(fromEnv);
    if (!fs.existsSync(p)) throw new Error(`Script file not found: ${p}`);
    return p;
  }
  const rootSample = path.resolve(__dirname, '../../sample-script.txt');
  if (fs.existsSync(rootSample)) return rootSample;
  if (fs.existsSync(defaultScript)) return defaultScript;
  if (fs.existsSync(fallbackScript)) return fallbackScript;
  throw new Error('No script file found — add sample-script.txt or set SCRIPT_FILE');
}

async function main(): Promise<void> {
  requireLlm();

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(reportsRoot, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const scriptPath = resolveScript();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Script path probe — LLM discovery mode');
  console.log(`Run ID:    ${runId}`);
  console.log(`Script:    ${scriptPath}`);
  console.log(`LLM:       ${config.llm.provider} / ${config.llm.model}`);
  console.log(`Headed:    ${config.headed} | Cursor: ${config.showCursor}`);
  console.log(`Artifacts: ${outDir}/`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const browser = new AgentBrowser({
    session: process.env.KOYAL_SESSION_SCRIPT ?? 'script-probe-llm',
    headed: config.headed,
  });

  try {
    const milestones = await runScriptPathProbe(browser, {
      scriptPath,
      outDir,
      maxProcessingMs: Number(process.env.SCRIPT_PROCESSING_WAIT_MS ?? '300000'),
    });
    const finalSnap = browser.snapshotInteractive();
    const finalUrl = browser.getUrl();
    const finalPhase = describeScriptPhase(finalUrl, finalSnap);

    const summary = {
      runId,
      script: scriptPath,
      finalUrl,
      finalPhase,
      milestones,
      reachedScriptEdit: milestones.some((m) => m.id === '09-script-edit' && m.reached),
    };

    fs.writeFileSync(path.join(outDir, 'SUMMARY.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(
      path.join(outDir, 'REPORT.md'),
      [
        `# Script path probe — ${runId}`,
        '',
        '**Mode:** LLM + snapshot discovery (no hardcoded path)',
        '',
        `- **Script:** \`${path.basename(scriptPath)}\``,
        `- **Final URL:** ${finalUrl}`,
        `- **Final phase:** ${finalPhase}`,
        `- **Reached script edit:** ${summary.reachedScriptEdit}`,
        '',
        '## Milestones',
        ...milestones.map(
          (m) =>
            `- ${m.reached ? '✅' : '⚠️'} **${m.id}** — ${m.label} (phase: ${m.phase})${m.error ? ` — ${m.error}` : ''}`,
        ),
      ].join('\n'),
    );

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Final: ${finalPhase} @ ${finalUrl}`);
    console.log(`Report: ${outDir}/REPORT.md`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } finally {
    browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
