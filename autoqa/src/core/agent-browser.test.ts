import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentBrowser } from './agent-browser.js';

class ModalBrowserDouble extends AgentBrowser {
  readonly calls: string[] = [];
  private statusChecks = 0;

  constructor(private readonly goneAfter: 'close' | 'escape' | 'backdrop' | 'never') {
    super({ session: 'modal-test', headed: false });
  }

  override getBox(): { x: number; y: number; width: number; height: number } {
    return { x: 10, y: 10, width: 20, height: 20 };
  }

  override evalScript(script: string): string {
    if (script.includes('window.__autoqaActiveModalPanel = dialog')) {
      this.calls.push('close');
      return 'CLICKED_MODAL_DISMISS';
    }
    if (script.includes('MODAL_STILL_VISIBLE')) {
      this.statusChecks++;
      const gone =
        this.goneAfter === 'close' ||
        (this.goneAfter === 'escape' && this.calls.includes('escape')) ||
        (this.goneAfter === 'backdrop' && this.calls.includes('backdrop'));
      return gone ? 'MODAL_GONE' : 'MODAL_STILL_VISIBLE';
    }
    if (script.includes('CLICKED_MODAL_BACKDROP')) {
      this.calls.push('backdrop');
      return 'CLICKED_MODAL_BACKDROP';
    }
    throw new Error(`unexpected eval (${this.statusChecks} checks)`);
  }

  override press(key: string): void {
    assert.equal(key, 'Escape');
    this.calls.push('escape');
  }

  override wait(): void {
    // deterministic unit double
  }
}

test('modal dismissal verifies the scoped close before trying broader fallbacks', () => {
  const browser = new ModalBrowserDouble('close');
  assert.equal(browser.dismissVisibleModalOverlay('@e1', true), true);
  assert.deepEqual(browser.calls, ['close']);
});

test('modal dismissal falls back through Escape and the owning backdrop with verification', () => {
  const escapeBrowser = new ModalBrowserDouble('escape');
  assert.equal(escapeBrowser.dismissVisibleModalOverlay('@e1', true), true);
  assert.deepEqual(escapeBrowser.calls, ['close', 'escape']);

  const backdropBrowser = new ModalBrowserDouble('backdrop');
  assert.equal(backdropBrowser.dismissVisibleModalOverlay('@e1', true), true);
  assert.deepEqual(backdropBrowser.calls, ['close', 'escape', 'backdrop']);
});

test('modal dismissal never claims success while the overlay remains visible', () => {
  const browser = new ModalBrowserDouble('never');
  assert.equal(browser.dismissVisibleModalOverlay('@e1', true), false);
  assert.deepEqual(browser.calls, ['close', 'escape', 'backdrop']);
});
