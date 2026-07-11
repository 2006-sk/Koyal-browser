import fs from 'node:fs';
import path from 'node:path';
import { config, requireCredentials } from '../config.js';
import { POST_AUTH_URL } from './audio-expectations.js';
import {
  AgentBrowser,
  refForInteractiveSnapshot,
  snapshotIncludes,
} from './agent-browser.js';

export class SessionPage {
  constructor(private readonly browser: AgentBrowser) {}

  private isAuthenticated(): boolean {
    const url = this.browser.getUrl();
    if (/\/login/i.test(url)) return false;
    const snap = this.browser.snapshotInteractive();
    if (/sign up|full name\*|textbox "full name/i.test(snap)) return false;
    const onApp =
      snapshotIncludes(snap, 'link "Projects"') ||
      snapshotIncludes(snap, 'Create Your Next Video') ||
      snapshotIncludes(snap, 'Good afternoon');
    return onApp && (POST_AUTH_URL.test(url) || /\/projects/i.test(url));
  }

  private waitForAuthenticated(maxMs = config.verificationMaxWaitMs): boolean {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (this.isAuthenticated()) return true;
      this.browser.wait(config.verificationPollMs);
    }
    return this.isAuthenticated();
  }

  async loginOrRestoreSession(): Promise<void> {
    const projectsUrl = `${config.baseUrl.replace(/\/$/, '')}${config.paths.projects}`;

    if (fs.existsSync(config.loginStatePath)) {
      try {
        this.browser.stateLoad(config.loginStatePath);
        this.browser.wait(500);
        this.browser.open(projectsUrl);
        this.browser.wait(2000);
        if (this.isAuthenticated()) return;
      } catch {
        // fall through to fresh login
      }
    }

    requireCredentials();
    this.loginFresh();
    fs.mkdirSync(path.dirname(config.loginStatePath), { recursive: true });
    this.browser.stateSave(config.loginStatePath);
  }

  loginFresh(): void {
    requireCredentials();
    const loginUrl = `${config.baseUrl.replace(/\/$/, '')}${config.paths.login}`;
    this.browser.clearSignals();
    this.browser.open(loginUrl);
    this.browser.wait(1500);

    let snap = this.browser.snapshotInteractive();
    if (snapshotIncludes(snap, 'FULL NAME') || snapshotIncludes(snap, 'textbox "FULL NAME')) {
      const toggle = refForInteractiveSnapshot(snap, /button "Log In"/i);
      if (!toggle) throw new Error('Sign Up form visible but Log In toggle not found');
      this.browser.clickVisible(toggle);
      this.browser.wait(1000);
      snap = this.browser.snapshotInteractive();
    }

    const email = refForInteractiveSnapshot(snap, /textbox "EMAIL/i);
    const password = refForInteractiveSnapshot(snap, /textbox "PASSWORD/i);
    const submit = refForInteractiveSnapshot(snap, /button "Start Creating"/i);
    if (!email || !password || !submit) {
      throw new Error('Login form fields not found in snapshot');
    }

    this.browser.fillVisible(email, config.testEmail);
    this.browser.fillVisible(password, config.testPassword);
    this.browser.clearSignals();
    this.browser.clickVisible(submit);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (this.isAuthenticated()) break;
      this.browser.wait(2000);
    }
    this.browser.wait(2000);
    if (!this.isAuthenticated()) {
      throw new Error(`Login submit did not reach authenticated app (url=${this.browser.getUrl()})`);
    }
  }
}
