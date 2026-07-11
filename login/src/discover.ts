#!/usr/bin/env node
import { config } from './config.js';
import { AgentBrowser } from './lib/agent-browser.js';
import { AuthPage } from './lib/page-auth.js';

/** Lightweight discovery pass — snapshots auth pages without credentials. */
async function main(): Promise<void> {
  const browser = new AgentBrowser({ session: 'discover', headed: config.headed });
  const auth = new AuthPage(browser);

  try {
    auth.openLogin(config.baseUrl);
    console.log('=== SIGNUP (default) ===');
    console.log(browser.snapshotInteractive());

    await auth.ensureLoginForm();
    console.log('\n=== LOGIN FORM ===');
    console.log(browser.snapshotInteractive());

    await auth.ensureSignupForm();
    console.log('\n=== SIGNUP FORM (toggled) ===');
    console.log(browser.snapshotInteractive());

    console.log('\n=== URL ===');
    console.log(browser.getUrl());
    console.log('\nCursor overlay:', config.showCursor ? 'enabled' : 'disabled');
    console.log('LLM exploration:', config.llm.enabled ? 'enabled' : 'disabled');
  } finally {
    browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
