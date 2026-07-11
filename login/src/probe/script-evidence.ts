import fs from 'node:fs';
import path from 'node:path';
import type { AgentBrowser } from '../lib/agent-browser.js';
import type { ExplorerResult } from '../lib/explorer.js';
import { describeScriptPhase } from './script-phase.js';

export interface ProbeCapture {
  id: string;
  label: string;
  url: string;
  phase: string;
  explorer?: ExplorerResult;
}

export function captureProbeStep(
  browser: AgentBrowser,
  outDir: string,
  id: string,
  label: string,
  explorer?: ExplorerResult,
): ProbeCapture {
  const dir = path.join(outDir, id);
  fs.mkdirSync(dir, { recursive: true });

  const url = browser.getUrl();
  const snap = browser.snapshotInteractive();
  const phase = describeScriptPhase(url, snap);

  browser.screenshotAnnotated(path.join(dir, 'screenshot.png'));
  fs.writeFileSync(path.join(dir, 'url.txt'), `${url}\n`);
  fs.writeFileSync(path.join(dir, 'phase.txt'), `${phase}\n`);
  fs.writeFileSync(path.join(dir, 'snapshot-interactive.txt'), snap);
  fs.writeFileSync(path.join(dir, 'console.json'), JSON.stringify(browser.consoleJson(), null, 2));
  fs.writeFileSync(path.join(dir, 'network.json'), JSON.stringify(browser.networkRequestsJson(), null, 2));
  fs.writeFileSync(path.join(dir, 'page-errors.json'), JSON.stringify(browser.errorsJson(), null, 2));

  if (explorer) {
    fs.writeFileSync(path.join(dir, 'explorer.json'), JSON.stringify(explorer, null, 2));
    fs.writeFileSync(
      path.join(dir, 'step-summary.md'),
      [
        `# ${label}`,
        '',
        `- **URL:** ${url}`,
        `- **Phase:** ${phase}`,
        `- **Explorer:** ${explorer.success ? 'success' : 'failed'}`,
        explorer.error ? `- **Error:** ${explorer.error}` : '',
        '',
        '## Explorer steps',
        ...explorer.stepsTaken.map((s, i) => `${i + 1}. ${s}`),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  } else {
    fs.writeFileSync(
      path.join(dir, 'step-summary.md'),
      `# ${label}\n\n- **URL:** ${url}\n- **Phase:** ${phase}\n`,
    );
  }

  console.log(`\n📸 ${id} | ${label} | phase=${phase} | ${url}`);
  return { id, label, url, phase, explorer };
}
