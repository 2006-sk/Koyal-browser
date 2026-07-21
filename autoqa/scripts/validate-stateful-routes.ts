import fs from 'node:fs';
import { AgentBrowser } from '../src/core/agent-browser.js';
import { SiteState } from '../src/agent/site-state.js';
import { matchPage } from '../src/agent/sitemap.js';

const baseUrl = process.argv[2];
const session = process.argv[3] ?? 'autoqa-route-validation';
if (!baseUrl) throw new Error('Usage: tsx scripts/validate-stateful-routes.ts <base-url> [session]');

const state = new SiteState(baseUrl);
const browser = new AgentBrowser({ session });
const paths = [
  '/space/characters',
  '/titanic/characters',
  '/space/export',
  '/titanic/export',
  '/bollywood/export',
];

try {
  if (fs.existsSync(state.authStatePath)) browser.stateLoad(state.authStatePath);
  for (const pathname of paths) {
    browser.open(`${state.sitemap.origin}${pathname}`);
    browser.wait(1500);
    const url = browser.getUrl();
    const page = matchPage(state.sitemap, url, browser.snapshotInteractive());
    console.log(`${new URL(url).pathname} -> ${page?.id ?? 'unmapped'}`);
  }
} finally {
  browser.close();
}
