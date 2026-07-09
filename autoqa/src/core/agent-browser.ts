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
  /** Consecutive subprocess timeouts — a wedged daemon; drives recycle decisions in the runner. */
  consecutiveTimeouts = 0;

  constructor(options: AgentBrowserOptions = {}) {
    this.session = options.session ?? config.session;
    this.headed = options.headed ?? config.headed;
    // The cursor overlay injects an extra eval on every action. On heavy pages
    // (Koyal's wizard) that CDP traffic helps wedge the daemon, so drop it in
    // deep/exhaustive runs where throughput + stability matter more than the demo cursor.
    this.showCursor = config.showCursor && !config.probes.exhaustive;
    this.binary = path.join(config.projectRoot, 'node_modules', '.bin', 'agent-browser');
  }

  /**
   * Force-kill the browser daemon + its Chrome tree when it has wedged (graceful
   * `close` hangs on a dead CDP connection, so kill hard). The next command
   * lazily respawns a fresh daemon. Session cookies are reloaded by the caller
   * via ensureAuthenticated/stateLoad. Returns true if a kill was issued.
   */
  recycle(): boolean {
    console.log('[browser] recycling wedged daemon (force-kill + respawn)');
    // Prefer a SESSION-SCOPED kill: `session info --json` exposes this session's
    // own daemon PID, so we only tear down THIS session's Chrome tree — a blind
    // `pkill -f agent-browser` kills every concurrent session on the machine,
    // which breaks the (established) pattern of running several sites' explores
    // at once. Fall back to the broad kill only if we can't resolve a specific PID.
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
        spawnSync('pkill', ['-9', '-P', String(pid)], { timeout: 5_000 }); // Chrome children
        spawnSync('kill', ['-9', String(pid)], { timeout: 5_000 }); // the daemon itself
        killedSpecific = true;
      }
    } catch {
      // best-effort — fall through to the broad kill below
    }
    if (!killedSpecific) {
      console.warn('[browser] could not resolve a session-specific PID — falling back to a broad kill (affects ALL sessions)');
      try {
        spawnSync('pkill', ['-9', '-f', 'agent-browser'], { timeout: 10_000 });
        spawnSync('pkill', ['-9', '-f', 'Chrome for Testing'], { timeout: 10_000 });
      } catch {
        // best-effort
      }
    }
    // give the OS a moment to reap and free ports/memory before respawn
    spawnSync('sleep', ['3']);
    this.cursorInjected = false;
    this.consecutiveTimeouts = 0;
    return true;
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

    // A transient CDP stall on a heavy page often clears on a second try. Auto-retry
    // ONCE, but only for idempotent read/navigation commands — never for mutating
    // actions (click/fill/upload) where a retry could double-act.
    const cmd = args[0] ?? '';
    const retrySafe = ['open', 'snapshot', 'url', 'title', 'errors', 'console', 'network', 'screenshot'].includes(cmd);
    let result = spawnSync(this.binary, fullArgs, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
      timeout: timeoutMs,
    });
    const timedOut = (r: typeof result) =>
      r.error?.message?.includes('ETIMEDOUT') || r.signal === 'SIGTERM';

    if (timedOut(result) && retrySafe) {
      console.warn(`[browser] ${cmd} timed out — one retry after 2s`);
      spawnSync('sleep', ['2']);
      result = spawnSync(this.binary, fullArgs, {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        env: process.env,
        timeout: timeoutMs,
      });
    }

    if (timedOut(result)) {
      this.consecutiveTimeouts++;
      throw new Error(`agent-browser timed out after ${timeoutMs}ms: ${args.join(' ')}`);
    }
    this.consecutiveTimeouts = 0;

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

    // Trusted clicks can be silently lost: the driver reports success while the
    // browser routes input to a stale page target (agent-browser 0.31.1 +
    // Chromium 150; /json shows a zombie pre-navigation target). Eval always
    // reaches the live page, so arm a one-shot probe there and verify the click
    // actually arrived; if it provably didn't (probe reads 0 on the same,
    // un-navigated document), activate the element through the DOM instead.
    let urlBefore = '';
    try {
      urlBefore = this.getUrl();
      this.evalScript(
        `window.__abClickLanded=0;window.addEventListener('click',function(){window.__abClickLanded=1;},{capture:true,once:true});'armed'`,
        { skipEnsure: true },
      );
    } catch {
      // probe is best-effort — plain click semantics below still apply
    }

    this.assertOk(this.run(['click', ref]), `click ${ref}`);

    try {
      const landed = this.evalScript('window.__abClickLanded', { skipEnsure: true }).trim();
      // "0" = listener still armed on the same document and no click arrived.
      // "1"/undefined/anything else = click landed or the document changed
      // (navigation replaces the probe) — never double-click those.
      if (landed !== '0') return;
      if (urlBefore && this.getUrl() !== urlBefore) return;
      console.log(`[browser] trusted click on ${ref} never reached the page — DOM activation fallback`);
      this.domActivate(ref);
    } catch {
      // eval failing here usually means mid-navigation — the click worked
    }
  }

  /** Click an element through the DOM (used when trusted input is lost). */
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
    // element not at point (scrolled away / covered) — focus route
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
      // eval is on the hottest path (cursor overlay, click-landed probe, edits);
      // without a timeout a wedged daemon or a never-resolving injected script
      // hangs the entire run with no recovery
      timeout: 30_000,
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error('agent-browser eval timed out after 30s');
    }
    if (result.status !== 0) {
      throw new Error(`agent-browser eval failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout ?? '';
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
    if (stdout.includes('NO_MATCH')) return false;
    return true;
  }

  /** DOM-level password-input check — catches login forms whose <input type=password> has no accessible name/label, which the accessibility-tree snapshot then renders as an unlabeled "textbox" the text-based auth-gate heuristic can't see. */
  hasVisiblePasswordInput(): boolean {
    try {
      const stdout = this.evalScript(`
        (function() {
          for (const el of document.querySelectorAll('input[type=password]')) {
            if (el.offsetParent !== null || el.getClientRects().length) return 'YES';
          }
          return 'NO';
        })();
      `);
      return stdout.includes('YES');
    } catch {
      return false;
    }
  }

  /** Visible text of navigational clickables that are NOT plain <a href> anchors — JS-routed cards, role=button/tab/menuitem, [onclick] divs. For SPAs (e.g. demoqa) whose nav has no hrefs. */
  findClickableCandidates(max = 25): string[] {
    try {
      const stdout = this.evalScript(`
        (function() {
          const sel = 'a:not([href]),[role=button],[role=link],[role=tab],[role=menuitem],[onclick],button,[class*="card"],[class*="tile"],[class*="menu-item"]';
          const out = [];
          const seen = new Set();
          for (const el of document.querySelectorAll(sel)) {
            if (!(el.offsetParent !== null || el.getClientRects().length)) continue;
            const t = (el.textContent || '').replace(/\\s+/g,' ').trim();
            if (!t || t.length > 40 || seen.has(t)) continue;
            seen.add(t);
            out.push(t);
            if (out.length >= ${max}) break;
          }
          return JSON.stringify(out);
        })();
      `);
      const match = stdout.match(/\[[\s\S]*\]/);
      return match ? (JSON.parse(match[0]) as string[]) : [];
    } catch {
      return [];
    }
  }

  /** JS-click the innermost visible element whose trimmed text equals `text`. Safe interpolation via JSON.stringify. */
  clickByText(text: string): boolean {
    const stdout = this.evalScript(`
      (function() {
        const target = ${JSON.stringify(text)};
        const els = [...document.querySelectorAll('a,button,[role],[onclick],div,span,li')];
        // innermost match first (most specific clickable), must be visible
        for (let i = els.length - 1; i >= 0; i--) {
          const el = els[i];
          const t = (el.textContent || '').replace(/\\s+/g,' ').trim();
          if (t !== target) continue;
          if (!(el.offsetParent !== null || el.getClientRects().length)) continue;
          el.scrollIntoView({block:'center'});
          (el.closest('a,button,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]') || el).click();
          return 'CLICKED';
        }
        return 'NO_MATCH';
      })();
    `);
    this.wait(config.actionDelayMs);
    return stdout.includes('CLICKED');
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
