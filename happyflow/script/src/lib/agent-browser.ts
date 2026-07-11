import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config, readCursorScript } from '../config.js';

export interface AgentBrowserOptions {
  session?: string;
  headed?: boolean;
}

export interface AgentBrowserJsonResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string | null;
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class AgentBrowser {
  readonly session: string;
  private readonly headed: boolean;
  private readonly showCursor: boolean;
  private readonly binary: string;
  private cursorInjected = false;

  constructor(options: AgentBrowserOptions = {}) {
    this.session = options.session ?? config.sessionScript;
    this.headed = options.headed ?? config.headed;
    this.showCursor = config.showCursor;
    this.binary = path.join(config.projectRoot, 'node_modules', '.bin', 'agent-browser');
  }

  run(args: string[], options: { json?: boolean; timeoutMs?: number } = {}): {
    stdout: string;
    stderr: string;
    exitCode: number;
    parsed?: AgentBrowserJsonResponse;
  } {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const fullArgs = [
      '--session',
      this.session,
      ...(this.headed ? ['--headed'] : []),
      ...(options.json || args.includes('--json') ? ['--json'] : []),
      ...args,
    ];

    const result = spawnSync(this.binary, fullArgs, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
      timeout: timeoutMs,
    });

    if (result.error?.message?.includes('ETIMEDOUT') || result.signal === 'SIGTERM') {
      throw new Error(`agent-browser timed out after ${timeoutMs}ms: ${args.join(' ')}`);
    }

    const stdout = (result.stdout ?? '').trim();
    const stderr = (result.stderr ?? '').trim();
    let parsed: AgentBrowserJsonResponse | undefined;

    if (options.json || args.includes('--json')) {
      parsed = this.tryParseJson(stdout);
    }

    return {
      stdout,
      stderr,
      exitCode: result.status ?? 1,
      parsed,
    };
  }

  private tryParseJson(stdout: string): AgentBrowserJsonResponse | undefined {
    try {
      return JSON.parse(stdout) as AgentBrowserJsonResponse;
    } catch {
      const line = stdout
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('{'));
      if (!line) return undefined;
      try {
        return JSON.parse(line) as AgentBrowserJsonResponse;
      } catch {
        return undefined;
      }
    }
  }

  open(url: string): string {
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { stdout, exitCode, stderr } = this.run(['open', url], { timeoutMs: 90_000 });
      if (exitCode === 0) {
        this.ensureCursorOverlay();
        return stdout;
      }
      lastError = stderr || stdout;
      this.wait(2000 * attempt);
    }
    throw new Error(`agent-browser open failed: ${lastError}`);
  }

  close(): void {
    this.run(['close']);
    this.cursorInjected = false;
  }

  recycle(): boolean {
    console.log('[browser] recycling wedged daemon (force-kill + respawn)');
    let killedSpecific = false;
    try {
      const infoResult = spawnSync(
        this.binary,
        ['--session', this.session, 'session', 'info', '--json'],
        { encoding: 'utf8', timeout: 8_000 },
      );
      const parsed = this.tryParseJson((infoResult.stdout ?? '').trim());
      const pid = (parsed?.data as { pid?: number } | undefined)?.pid;
      if (pid) {
        spawnSync('pkill', ['-9', '-P', String(pid)], { timeout: 5_000 });
        spawnSync('kill', ['-9', String(pid)], { timeout: 5_000 });
        killedSpecific = true;
      }
    } catch {
      // fall through
    }
    if (!killedSpecific) {
      try {
        spawnSync('pkill', ['-9', '-f', 'agent-browser'], { timeout: 10_000 });
        spawnSync('pkill', ['-9', '-f', 'Chrome for Testing'], { timeout: 10_000 });
      } catch {
        // best-effort
      }
    }
    spawnSync('sleep', ['3']);
    this.cursorInjected = false;
    return true;
  }

  ensureCursorOverlay(): void {
    if (!this.showCursor) return;
    const script = readCursorScript();
    this.evalScript(script, { skipEnsure: true });
    this.cursorInjected = true;
  }

  click(ref: string): void {
    if (this.showCursor) this.ensureCursorOverlay();

    let urlBefore = '';
    try {
      urlBefore = this.getUrl();
      this.evalScript(
        `window.__abClickLanded=0;window.addEventListener('click',function(){window.__abClickLanded=1;},{capture:true,once:true});'armed'`,
        { skipEnsure: true },
      );
    } catch {
      // probe is best-effort
    }

    this.assertOk(this.run(['click', ref]), `click ${ref}`);

    try {
      const landed = this.evalScript('window.__abClickLanded', { skipEnsure: true }).trim();
      if (landed !== '0') return;
      if (urlBefore && this.getUrl() !== urlBefore) return;
      console.log(`[browser] trusted click on ${ref} never reached the page — DOM activation fallback`);
      this.domActivate(ref);
    } catch {
      // eval failing here usually means mid-navigation — the click worked
    }
  }

  private domActivate(ref: string): void {
    const box = this.getBox(ref);
    if (box) {
      const cx = Math.round(box.x + box.width / 2);
      const cy = Math.round(box.y + box.height / 2);
      const out = this.evalScript(
        `(function(){var el=document.elementFromPoint(${cx},${cy});if(el){el.click();return 'clicked';}return 'miss';})()`,
        { skipEnsure: true },
      );
      if (out.includes('clicked')) return;
    }
    this.assertOk(this.run(['focus', ref]), `focus ${ref}`);
    this.evalScript(
      `(function(){var el=document.activeElement;if(el&&el!==document.body)el.click();})()`,
      { skipEnsure: true },
    );
  }

  fill(ref: string, value: string): void {
    if (this.showCursor) this.ensureCursorOverlay();
    this.assertOk(this.run(['fill', ref, value]), `fill ${ref}`);
  }

  clickVisible(ref: string): void {
    if (this.showCursor) {
      this.pointAtRef(ref);
      this.click(ref);
      return;
    }
    this.click(ref);
  }

  fillVisible(ref: string, value: string): void {
    if (this.showCursor) {
      this.pointAtRef(ref);
      this.fill(ref, value);
      return;
    }
    this.fill(ref, value);
  }

  highlight(ref: string): void {
    this.run(['highlight', ref]);
  }

  pointAtRef(ref: string): void {
    this.ensureCursorOverlay();
    const box = this.getBox(ref);
    if (!box) return;

    const centerX = Math.round(box.x + box.width / 2);
    const centerY = Math.round(box.y + box.height / 2);

    this.run(['mouse', 'move', String(centerX), String(centerY)]);
    this.moveOverlayCursor(centerX, centerY);
    this.highlight(ref);
    this.wait(config.actionDelayMs);
  }

  getBox(ref: string): BoundingBox | null {
    const result = this.run(['get', 'box', ref], { json: true });
    const data = result.parsed?.data as BoundingBox | undefined;
    if (data && typeof data.x === 'number') return data;

    const stdout = result.stdout;
    const match = stdout.match(/x[=:]\s*([\d.]+).*y[=:]\s*([\d.]+).*width[=:]\s*([\d.]+).*height[=:]\s*([\d.]+)/i);
    if (!match) return null;
    return {
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    };
  }

  moveOverlayCursor(x: number, y: number): void {
    this.evalScript(
      `(function(){if(window.__qaAgentCursorEnsure)window.__qaAgentCursorEnsure();window.dispatchEvent(new CustomEvent('qa-cursor-move',{detail:{x:${x},y:${y}}}));})();`,
      { skipEnsure: true },
    );
  }

  evalScript(script: string, options: { skipEnsure?: boolean } = {}): string {
    if (this.showCursor && !options.skipEnsure) this.ensureCursorOverlay();
    const fullArgs = [
      '--session',
      this.session,
      ...(this.headed ? ['--headed'] : []),
      'eval',
      '--stdin',
    ];
    const result = spawnSync(this.binary, fullArgs, {
      input: script,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`agent-browser eval failed: ${result.stderr || result.stdout}`);
    }
    return (result.stdout ?? '').trim();
  }

  upload(selector: string, filePath: string): void {
    if (this.showCursor) this.ensureCursorOverlay();
    this.assertOk(
      this.run(['upload', selector, filePath], { timeoutMs: 60_000 }),
      `upload ${filePath}`,
    );
  }

  findAndClick(role: string, name: string, exact = false): void {
    if (this.showCursor) this.ensureCursorOverlay();
    const args = ['find', 'role', role, 'click', '--name', name];
    if (exact) args.push('--exact');
    this.assertOk(this.run(args, { timeoutMs: 45_000 }), `find role ${role} click "${name}"`);
  }

  findAndFill(strategy: 'label' | 'placeholder', label: string, value: string): void {
    this.assertOk(
      this.run(['find', strategy, label, 'fill', value], { timeoutMs: 45_000 }),
      `find ${strategy} "${label}" fill`,
    );
  }

  back(): void {
    this.assertOk(this.run(['back'], { timeoutMs: 60_000 }), 'back');
    this.ensureCursorOverlay();
  }

  forward(): void {
    this.assertOk(this.run(['forward'], { timeoutMs: 60_000 }), 'forward');
    this.ensureCursorOverlay();
  }

  wait(ms: number): void {
    const result = this.run(['wait', String(ms)]);
    if (result.exitCode !== 0) {
      spawnSync('sleep', [String(Math.max(1, Math.ceil(ms / 1000)))]);
    }
  }

  waitForUrl(pattern: string, timeoutMs = 10000): void {
    this.assertOk(this.run(['wait', '--url', pattern, String(timeoutMs)]), `wait url ${pattern}`);
  }

  waitForText(text: string, timeoutMs = 10000): void {
    this.assertOk(this.run(['wait', '--text', text, String(timeoutMs)]), `wait text ${text}`);
  }

  getUrl(): string {
    const { stdout, exitCode } = this.run(['get', 'url']);
    if (exitCode !== 0) return '';
    return stdout.split('\n').pop()?.trim() ?? stdout.trim();
  }

  getTitle(): string {
    const { stdout, exitCode } = this.run(['get', 'title']);
    if (exitCode !== 0) return '';
    return stdout.split('\n').pop()?.trim() ?? stdout.trim();
  }

  snapshotInteractive(): string {
    if (this.showCursor) this.ensureCursorOverlay();
    const { stdout, exitCode } = this.run(['snapshot', '-i']);
    if (exitCode !== 0) return '';
    return stdout;
  }

  snapshotFull(): string {
    const { stdout, exitCode } = this.run(['snapshot']);
    if (exitCode !== 0) return '';
    return stdout;
  }

  errorsJson(): AgentBrowserJsonResponse<{ errors: Array<{ message?: string; stack?: string }> }> {
    const result = this.run(['errors'], { json: true });
    return (result.parsed ?? { success: false, error: result.stderr || result.stdout }) as AgentBrowserJsonResponse<{
      errors: Array<{ message?: string; stack?: string }>;
    }>;
  }

  consoleJson(): AgentBrowserJsonResponse<{
    messages: Array<{ text: string; type: string; timestamp?: number }>;
  }> {
    const result = this.run(['console'], { json: true });
    return (result.parsed ?? { success: false, error: result.stderr || result.stdout }) as AgentBrowserJsonResponse<{
      messages: Array<{ text: string; type: string; timestamp?: number }>;
    }>;
  }

  networkRequestsJson(filter?: string): AgentBrowserJsonResponse<{ requests: unknown[] }> {
    const args = ['network', 'requests'];
    if (filter) args.push('--filter', filter);
    const result = this.run(args, { json: true });
    return (result.parsed ?? { success: false, error: result.stderr || result.stdout }) as AgentBrowserJsonResponse<{
      requests: unknown[];
    }>;
  }

  screenshotAnnotated(filePath: string): void {
    const baseArgs = ['--session', this.session, ...(this.headed ? ['--headed'] : [])];
    const annotate = spawnSync(
      this.binary,
      [...baseArgs, 'screenshot', '--annotate', filePath],
      { encoding: 'utf8', timeout: 10_000 },
    );
    if (annotate.status === 0) return;

    const plain = spawnSync(this.binary, [...baseArgs, 'screenshot', filePath], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (plain.status !== 0) {
      throw new Error(`screenshot failed: ${plain.stderr || plain.stdout || annotate.stderr}`);
    }
  }

  stateSave(filePath: string): void {
    this.assertOk(this.run(['state', 'save', filePath]), `state save ${filePath}`);
  }

  stateLoad(filePath: string): void {
    this.assertOk(this.run(['state', 'load', filePath]), `state load ${filePath}`);
  }

  dialogAccept(): void {
    this.run(['dialog', 'accept']);
    this.wait(300);
  }

  dialogDismiss(): void {
    this.run(['dialog', 'dismiss']);
  }

  clearSignals(): void {
    this.run(['errors', '--clear']);
    this.run(['console', '--clear']);
    this.run(['network', 'requests', '--clear']);
  }

  clickButtonByText(text: string, exact = false): boolean {
    const escaped = text.replace(/'/g, "\\'");
    const stdout = this.evalScript(`
      (function() {
        const buttons = [...document.querySelectorAll('button,a,[role=button],label')];
        for (const b of buttons) {
          const t = (b.textContent || '').trim();
          const match = ${exact ? `t === '${escaped}'` : `t.includes('${escaped}')`};
          if (match && !b.disabled) { b.scrollIntoView({block:'center'}); b.click(); return 'CLICKED'; }
        }
        return 'NO_MATCH';
      })();
    `);
    this.wait(config.actionDelayMs);
    return !stdout.includes('NO_MATCH');
  }

  clickNextIfEnabled(): boolean {
    const snap = this.snapshotInteractive();
    const line = snap.split('\n').find((l) => /button "Next"/.test(l) && !/\[disabled/.test(l));
    if (!line) return false;
    const ref = line.match(/\[ref=(e\d+)\]/)?.[1];
    if (!ref) return false;
    this.evalScript(`
      const btn = document.querySelector('[data-ref="${ref}"]') ||
        [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Next' && !b.disabled);
      if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); }
    `);
    try {
      this.clickVisible(`@${ref}`);
    } catch {
      this.clickButtonByText('Next', true);
    }
    this.wait(config.actionDelayMs);
    return true;
  }

  private assertOk(
    result: { stdout: string; stderr: string; exitCode: number },
    action: string,
  ): void {
    if (result.exitCode !== 0) {
      throw new Error(
        `agent-browser ${action} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
  }
}

export function refForInteractiveSnapshot(snapshot: string, pattern: RegExp): string | null {
  const line = snapshot.split('\n').find((l) => pattern.test(l));
  if (!line) return null;
  const match = line.match(/\[ref=(e\d+)\]/);
  return match ? `@${match[1]}` : null;
}

export function refForEnabledButton(snapshot: string, label: string): string | null {
  const lines = snapshot.split('\n').filter((l) => new RegExp(`button "${label}"`, 'i').test(l));
  const enabled = lines.find((l) => !/\[disabled/.test(l));
  if (!enabled) return null;
  const match = enabled.match(/\[ref=(e\d+)\]/);
  return match ? `@${match[1]}` : null;
}

export function snapshotIncludes(snapshot: string, text: string): boolean {
  return snapshot.toLowerCase().includes(text.toLowerCase());
}

export function snapshotIncludesAny(snapshot: string, texts: string[]): boolean {
  const lower = snapshot.toLowerCase();
  return texts.some((t) => lower.includes(t.toLowerCase()));
}

export function isButtonDisabled(snapshot: string, label: string): boolean {
  const line = snapshot.split('\n').find((l) => new RegExp(`button "${label}"`, 'i').test(l));
  return line ? /\[disabled/.test(line) : true;
}
