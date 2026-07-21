#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const hostname = process.argv[2];
if (!hostname || !/^[a-z0-9.-]+$/i.test(hostname)) {
  throw new Error('Usage: node scripts/scrub-site-secrets.mjs <hostname>');
}

const root = process.cwd();
const stateDir = path.join(root, '.autoqa-state', hostname);
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const secrets = readJson(path.join(stateDir, 'secrets.json'), {});
const fieldValuesPath = path.join(stateDir, 'field-values.json');
const fieldValues = readJson(fieldValuesPath, {});
const sensitiveLabel = /password|passcode|pin|secret|token|api[-_ ]?key|email|e-mail|username/i;
const replacements = new Map();
if (secrets.email) replacements.set(String(secrets.email), '«redacted-email»');
if (secrets.password) replacements.set(String(secrets.password), '«redacted-password»');

for (const [key, entry] of Object.entries(fieldValues)) {
  if (sensitiveLabel.test(`${key} ${entry?.label ?? ''}`)) {
    if (entry?.value) replacements.set(String(entry.value), sensitiveLabel.test(entry?.label ?? '') && /pass|pin/i.test(entry?.label ?? '') ? '«redacted-password»' : '«redacted-credential»');
    delete fieldValues[key];
  }
}
if (fs.existsSync(fieldValuesPath)) fs.writeFileSync(fieldValuesPath, `${JSON.stringify(fieldValues, null, 2)}\n`);

const files = [];
const collect = (target) => {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) collect(path.join(target, name));
  } else if (/\.(json|md|txt|log)$/i.test(target)) files.push(target);
};
collect(path.join(root, 'reports', hostname));
collect(path.join(stateDir, 'recipes.json'));
collect(path.join(stateDir, 'inbox'));

let changed = 0;
for (const file of files) {
  let text = fs.readFileSync(file, 'utf8');
  const before = text;
  for (const [secret, replacement] of replacements) {
    if (secret) text = text.split(secret).join(replacement);
  }
  if (text !== before) {
    fs.writeFileSync(file, text);
    changed++;
  }
}
console.log(`Scrubbed sensitive field storage and ${changed} historical evidence file(s) for ${hostname}.`);
