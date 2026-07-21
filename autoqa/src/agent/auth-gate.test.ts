import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLoginShapedGoal } from './flow-runner.js';
import { looksLikeAuthGate } from './page-classifier.js';

/**
 * Characterization tests: they lock in the CURRENT, hardened behavior of the
 * auth-gate detectors (the project's #2 recurring bug source, patched in nearly
 * every batch). Each case is a documented real-world site scenario. The point is
 * not to change behavior but to make the NEXT edit unable to silently regress a
 * case that some past batch fixed — see tasks.md #auth-gate-convergence.
 */

const many = (n: number) => Array.from({ length: n }, (_, i) => `heading "Card ${i}"`).join('\n');

test('looksLikeAuthGate: minimal real gate on a non-login URL (ParaBank-shaped) → true', () => {
  const snap = 'heading "Customer Login"\nheading "Welcome"\ntextbox "Username"\ntextbox "Password"\nbutton "Log In"';
  assert.equal(looksLikeAuthGate('https://parabank.parasoft.com/parabank/index.htm', snap, true), true);
});

test('looksLikeAuthGate: content-dense practice hub with a decorative login widget (webdriveruniversity-shaped) → false', () => {
  const snap = `${many(28)}\ntextbox "Password"\nbutton "Login"`;
  assert.equal(looksLikeAuthGate('https://webdriveruniversity.com/AI-Testing-Playground/index.html', snap, true), false);
});

test('looksLikeAuthGate: an unambiguous /login URL is trusted even with many headings → true', () => {
  const snap = `${many(28)}\ntextbox "Password"\nbutton "Login"`;
  assert.equal(looksLikeAuthGate('https://example.com/login', snap, true), true);
});

test('looksLikeAuthGate: no visible password input → false', () => {
  assert.equal(looksLikeAuthGate('https://example.com/login', 'button "Login"', false), false);
});

test('looksLikeAuthGate: a password field with no login wording (e.g. a settings page) → false', () => {
  assert.equal(looksLikeAuthGate('https://example.com/settings', 'textbox "Password"', true), false);
});

test('isLoginShapedGoal: positive-path login goal → true', () => {
  assert.equal(isLoginShapedGoal('Log in with valid credentials'), true);
});

test('isLoginShapedGoal: enter username AND password and submit → true', () => {
  assert.equal(isLoginShapedGoal('Enter your username and password and submit the form'), true);
});

test('isLoginShapedGoal: filling a lone password-type field → false (password in isolation)', () => {
  assert.equal(isLoginShapedGoal('Enter a value into the Input: Password field'), false);
});

test('isLoginShapedGoal: a quoted clicked control label containing "Login" → false (quote-stripped)', () => {
  assert.equal(isLoginShapedGoal("Click 'Customer Login' to reach the customer selection screen"), false);
});

test('isLoginShapedGoal: bare "login form/tab" UI-nav with no credential wording → false (filmarena case)', () => {
  assert.equal(isLoginShapedGoal("Switch back to the 'Login' tab and confirm the login form is shown"), false);
});

test('isLoginShapedGoal: negative-path (invalid credentials) stays with the explorer → false', () => {
  assert.equal(isLoginShapedGoal('Enter invalid credentials and expect an error'), false);
});
