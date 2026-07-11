import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config, readCursorScript } from '../config.js';

export interface AgentBrowserOptions {
  session?: string;
  headed?: boolean;
  json?: boolean;
  extraArgs?: string[];
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
    this.session = options.session ?? config.sessionAuth;
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
      timeout: options.timeoutMs ?? 30_000,
    });

    if (result.error?.message?.includes('ETIMEDOUT') || result.signal === 'SIGTERM') {
      throw new Error(`agent-browser timed out after 30s: ${args.join(' ')}`);
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
    const { stdout, exitCode, stderr } = this.run(['open', url]);
    if (exitCode !== 0) {
      throw new Error(`agent-browser open failed: ${stderr || stdout}`);
    }
    this.ensureCursorOverlay();
    return stdout;
  }

  close(): void {
    this.run(['close']);
    this.cursorInjected = false;
  }

  ensureCursorOverlay(): void {
    if (!this.showCursor) return;
    const script = readCursorScript();
    this.evalScript(script, { skipEnsure: true });
    this.cursorInjected = true;
  }

  click(ref: string): void {
    if (this.showCursor) this.ensureCursorOverlay();
    this.assertOk(this.run(['click', ref]), `click ${ref}`);
  }

  fill(ref: string, value: string): void {
    if (this.showCursor) this.ensureCursorOverlay();
    this.assertOk(this.run(['fill', ref, value]), `fill ${ref}`);
  }

  clickVisible(ref: string): void {
    if (config.showCursor) {
      this.pointAtRef(ref);
      this.click(ref);
      return;
    }
    this.click(ref);
  }

  fillVisible(ref: string, value: string): void {
    if (config.showCursor) {
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

  evalScript(script: string, options: { skipEnsure?: boolean } = {}): void {
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
    });
    if (result.status !== 0) {
      throw new Error(`agent-browser eval failed: ${result.stderr || result.stdout}`);
    }
  }

  findAndClick(role: string, name: string, exact = false): void {
    const args = ['find', 'role', role, 'click', '--name', name];
    if (exact) args.push('--exact');
    this.assertOk(this.run(args), `find role ${role} click "${name}"`);
  }

  findAndFill(strategy: 'label' | 'placeholder', label: string, value: string): void {
    this.assertOk(
      this.run(['find', strategy, label, 'fill', value]),
      `find ${strategy} "${label}" fill`,
    );
  }

  back(): void {
    this.assertOk(this.run(['back']), 'back');
    this.ensureCursorOverlay();
  }

  forward(): void {
    this.assertOk(this.run(['forward']), 'forward');
    this.ensureCursorOverlay();
  }

  wait(ms: number): void {
    this.assertOk(this.run(['wait', String(ms)]), `wait ${ms}`);
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
    if (filter) {
      args.push('--filter', filter);
    }
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
      throw new Error(
        `screenshot failed (annotate hung or errored; plain also failed): ${plain.stderr || plain.stdout || annotate.stderr}`,
      );
    }
  }

  stateSave(filePath: string): void {
    this.assertOk(this.run(['state', 'save', filePath]), `state save ${filePath}`);
  }

  stateLoad(filePath: string): void {
    this.assertOk(this.run(['state', 'load', filePath]), `state load ${filePath}`);
  }

  upload(selector: string, filePath: string): void {
    if (this.showCursor) this.ensureCursorOverlay();
    this.assertOk(
      this.run(['upload', selector, filePath], { timeoutMs: 60_000 }),
      `upload ${filePath}`,
    );
  }

  clearSignals(): void {
    this.run(['errors', '--clear']);
    this.run(['console', '--clear']);
    this.run(['network', 'requests', '--clear']);
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

export function snapshotIncludes(snapshot: string, text: string): boolean {
  return snapshot.toLowerCase().includes(text.toLowerCase());
}
