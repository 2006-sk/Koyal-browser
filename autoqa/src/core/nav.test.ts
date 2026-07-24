import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentBrowser } from './agent-browser.js';
import {
  Nav,
  normalizeVolatileAccessibleName,
  parseContextualControlLabel,
  refForUniqueVolatileLabel,
} from './nav.js';

test('parses a crawler-contextualized repeated control label', () => {
  assert.deepEqual(parseContextualControlLabel('REGENERATE (Wayfinder Compass)'), {
    action: 'REGENERATE',
    owner: 'Wayfinder Compass',
  });
  assert.equal(parseContextualControlLabel('REGENERATE'), null);
  assert.equal(parseContextualControlLabel('Edit ()'), null);
});

test('Nav falls back to the repeated control inside the named owner card', () => {
  const calls: Array<[string, string]> = [];
  const browser = {
    snapshotInteractive: () => '',
    snapshotFull: () => '',
    findAndClick: () => {
      throw new Error('no accessible full-label match');
    },
    clickButtonByText: () => false,
    clickButtonWithinText: (action: string, owner: string) => {
      calls.push([action, owner]);
      return true;
    },
    dialogStatus: () => null,
    wait: () => {},
    getUrl: () => 'https://example.test/assets',
  } as unknown as AgentBrowser;

  const clicked = new Nav(browser).click({
    label: 'REGENERATE (Wayfinder Compass)',
    role: 'button',
    optional: true,
  });

  assert.equal(clicked, true);
  assert.deepEqual(calls, [['REGENERATE', 'Wayfinder Compass']]);
});

test('Nav never falls back to an unscoped generic control when owner context is absent', () => {
  const browser = {
    snapshotInteractive: () => '',
    snapshotFull: () => '',
    findAndClick: () => {
      throw new Error('no match');
    },
    clickButtonByText: () => false,
    clickButtonWithinText: () => false,
    getUrl: () => 'https://example.test/assets',
  } as unknown as AgentBrowser;

  assert.equal(
    new Nav(browser).click({
      label: 'REGENERATE (Missing Asset)',
      role: 'button',
      optional: true,
    }),
    false,
  );
});

test('volatile numeric accessible names retain stable semantics', () => {
  assert.equal(
    normalizeVolatileAccessibleName('Standard553 seconds available'),
    normalizeVolatileAccessibleName('Standard536 seconds available'),
  );
  assert.notEqual(
    normalizeVolatileAccessibleName('Standard553 seconds available'),
    normalizeVolatileAccessibleName('Pro536 seconds available'),
  );
});

test('volatile-label fallback requires one unique enabled semantic match', () => {
  const snapshot = [
    '- radio "Standard 536 seconds available" [checked=false, ref=e22]',
    '- radio "Pro 250 seconds available" [checked=false, ref=e23]',
  ].join('\n');
  assert.equal(
    refForUniqueVolatileLabel(snapshot, 'Standard 553 seconds available'),
    '@e22',
  );
  assert.equal(
    refForUniqueVolatileLabel(
      `${snapshot}\n- radio "Standard 490 seconds available" [ref=e24]`,
      'Standard 553 seconds available',
    ),
    undefined,
  );
  assert.equal(refForUniqueVolatileLabel(snapshot, 'Standard plan'), undefined);
});

test('Nav replays a control whose numeric accessible-name portion changed', () => {
  const clicked: string[] = [];
  const snapshot = [
    '- LabelText "Standard536 seconds available" [ref=e18] clickable',
    '  - radio "Standard 536 seconds available" [checked=false, ref=e22]',
    '- LabelText "Pro250 seconds available" [ref=e19] clickable',
  ].join('\n');
  const browser = {
    snapshotInteractive: () => snapshot,
    snapshotFull: () => snapshot,
    clickVisible: (ref: string) => {
      // The ordinary exact/substring paths cannot match the old 553 value.
      clicked.push(ref);
    },
    findAndClick: () => {
      throw new Error('exact name changed');
    },
    clickButtonByText: () => false,
    clickButtonWithinText: () => false,
    dialogStatus: () => null,
    wait: () => {},
    getUrl: () => 'https://example.test/upload',
  } as unknown as AgentBrowser;

  assert.equal(
    new Nav(browser).click({
      label: 'Standard553 seconds available',
      optional: true,
    }),
    true,
  );
  assert.deepEqual(clicked, ['@e18']);
});
