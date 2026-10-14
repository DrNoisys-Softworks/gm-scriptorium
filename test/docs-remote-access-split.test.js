'use strict';

/*
 * The remote access page is split in two: the how-to stays at docs/remote-access.md, and the
 * rules for accounts, sign-in and what is protected live on docs/reference/remote-access.md.
 *
 * The Windows runbook (.agents/windows-verification.md) cites "docs/remote-access.md section 7"
 * and runs the Tailscale commands from it. Criterion text must not be rewritten, so the how-to
 * keeps its numbered headings, and the three Tailscale command lines stay exactly as they were.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const howTo = fs.readFileSync(path.join(root, 'docs', 'remote-access.md'), 'utf8');
const reference = fs.readFileSync(path.join(root, 'docs', 'reference', 'remote-access.md'), 'utf8');

const howToLines = howTo.split('\n');
const referenceLines = reference.split('\n');

function countLine(lines, wanted) {
  return lines.filter((l) => l === wanted).length;
}

function linkTargets(text) {
  const out = [];
  const re = /\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function stripFragment(target) {
  return target.split('#')[0];
}

function headings(lines) {
  return lines.filter((l) => /^## /.test(l));
}

test('the how-to keeps the Tailscale and SSH headings the runbook cites', () => {
  assert.equal(countLine(howToLines, '## 7. With Tailscale'), 1);
  assert.equal(countLine(howToLines, '## 8. Over an SSH tunnel'), 1);
});

test('the how-to keeps sections 1 to 8 in order, then Everyday tasks', () => {
  assert.deepEqual(headings(howToLines), [
    '## 1. What remote access is',
    '## 2. The modes',
    '## 3. Setting it up from the command line',
    '## 4. Behind Caddy',
    '## 5. Behind nginx',
    '## 6. The plain hop',
    '## 7. With Tailscale',
    '## 8. Over an SSH tunnel',
    '## Everyday tasks',
  ]);
});

test('section 7 keeps the commands the runbook runs, exactly as before', () => {
  const setLine =
    'gm-scriptorium remote set --mode tailscale --admin-url https://panel-host.example-tailnet.ts.net --preview-url https://panel-host.example-tailnet.ts.net:8443 --port 7400 --preview-port 7401';
  assert.equal(countLine(howToLines, setLine), 1);
  assert.equal(countLine(howToLines, 'tailscale serve --bg --https=443 7400'), 1);
  assert.equal(countLine(howToLines, 'tailscale serve --bg --https=8443 7401'), 1);
});

test('the how-to links the reference page, and the reference links back', () => {
  const fromHowTo = linkTargets(howTo).map(stripFragment);
  assert.ok(fromHowTo.filter((t) => t === 'reference/remote-access.md').length >= 1);
  const fromReference = linkTargets(reference).map(stripFragment);
  assert.ok(fromReference.filter((t) => t === '../remote-access.md').length >= 1);
});

test('the reference page has exactly the six moved sections, in order', () => {
  assert.deepEqual(headings(referenceLines), [
    '## Accounts',
    '## Other commands',
    '## Signing in',
    '## The audit log',
    '## What is and is not protected',
    '## Files, permissions and backups',
  ]);
});

test('the reference page opens with the reference opening line', () => {
  assert.equal(referenceLines[0], '# Remote access: accounts, sign-in and what is protected');
  const first = referenceLines.slice(1).find((l) => l.trim() !== '');
  assert.match(first, /^This page is for someone who has set up remote access and wants to look up /);
});

test('neither page has an em dash, an en dash or an arrow', () => {
  for (const [name, text] of [['how-to', howTo], ['reference', reference]]) {
    assert.equal(/[—–→]/.test(text), false, name);
  }
});
