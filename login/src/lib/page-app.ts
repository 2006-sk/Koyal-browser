import path from 'node:path';
import fs from 'node:fs';
import { config, requireCredentials } from '../config.js';
import { APP_SHELL_CONSOLE_ALLOWLIST, isPostAuthUrl } from './auth-expectations.js';
import { APP_SHELL_NAV_ITEMS, isAppShellSnapshot, type AppShellNavItem } from './app-shell-selectors.js';
import { AgentBrowser, refForInteractiveSnapshot } from './agent-browser.js';
import { AuthPage } from './page-auth.js';

export class AppShellPage {
  private readonly auth: AuthPage;

  constructor(private readonly browser: AgentBrowser) {
    this.auth = new AuthPage(browser);
  }

  private isAuthenticated(): boolean {
    const url = this.browser.getUrl();
    const snap = this.browser.snapshotInteractive();
    return isPostAuthUrl(url) || isAppShellSnapshot(snap);
  }

  private waitForAuthenticated(): boolean {
    const deadline = Date.now() + config.verificationMaxWaitMs;
    while (Date.now() < deadline) {
      if (this.isAuthenticated()) return true;
      this.browser.wait(config.verificationPollMs);
    }
    return this.isAuthenticated();
  }

  async loginOrRestoreSession(): Promise<void> {
    const statePath = path.join(config.stateDir, `${config.sessionAuth}.json`);
    const projectsUrl = `${config.baseUrl.replace(/\/$/, '')}/projects`;

    if (fs.existsSync(statePath)) {
      try {
        this.browser.stateLoad(statePath);
        this.browser.wait(500);
      } catch {
        // continue with fresh login below
      }
    }

    this.browser.open(projectsUrl);
    if (this.waitForAuthenticated()) return;

    requireCredentials();
    this.browser.clearSignals();
    this.auth.openLogin(config.baseUrl);
    this.browser.wait(1000);
    if (this.waitForAuthenticated()) return;

    await this.auth.ensureLoginForm();
    await this.auth.fillLogin(config.testEmail, config.testPassword, true);
    await this.auth.submitLogin();
    this.browser.waitForUrl('/(projects|dashboard)', config.verificationMaxWaitMs);
    fs.mkdirSync(config.stateDir, { recursive: true });
    this.browser.stateSave(statePath);
  }

  clickSidebarItem(item: AppShellNavItem): void {
    const snap = this.browser.snapshotInteractive();
    const ref = refForInteractiveSnapshot(snap, item.linkPattern);
    if (!ref) throw new Error(`Sidebar link not found for ${item.id}`);
    this.browser.clearSignals();
    this.browser.clickVisible(ref);
    this.browser.wait(800);
  }

  async navigateSidebarAndSettle(item: AppShellNavItem): Promise<void> {
    this.clickSidebarItem(item);
    const deadline = Date.now() + config.verificationMaxWaitMs;
    while (Date.now() < deadline) {
      const url = this.browser.getUrl();
      const snap = this.browser.snapshotInteractive().toLowerCase();
      const urlOk = item.urlPattern.test(url);
      const snapOk = item.snapshotHints.some((h) => snap.includes(h.toLowerCase()));
      if (urlOk || snapOk) return;
      this.browser.wait(500);
    }
    throw new Error(
      `Timed out after ${config.verificationMaxWaitMs}ms navigating to ${item.id} (url=${this.browser.getUrl()})`,
    );
  }

  clickAccountMenuIfPresent(): boolean {
    const snap = this.browser.snapshotInteractive();
    const accountBtn = snap
      .split('\n')
      .find((line) => /button \[ref=e\d+\]/.test(line) && !/toggle|buy|create|grid|filter|recent|folders/i.test(line));
    if (!accountBtn) return false;
    const ref = accountBtn.match(/\[ref=(e\d+)\]/)?.[1];
    if (!ref) return false;
    this.browser.clickVisible(`@${ref}`);
    this.browser.wait(500);
    return true;
  }
}

export const APP_SHELL_EXPECTATION_BASE = {
  allowConsoleErrors: false,
  allowedConsoleErrorPatterns: APP_SHELL_CONSOLE_ALLOWLIST,
  maxUnexpectedNetwork5xx: 0,
  uglyErrorPatterns: [/Internal Server Error/i, /TypeError:/i, /SyntaxError:/i],
};
