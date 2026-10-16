'use strict';

/*
 * Pins the README's proof links, the two anchors it uses, the leak-check caveat, the reader
 * key line, the removal of two claims that were false for the published release, and the
 * house no-dash rule. Expected values are literals; URLs and paths are compared with ===.
 * No test here pins the exact text of the "Use it" prose, so that line can be rewritten.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function linkTargets(text) {
  const out = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[2]);
  return out;
}

function dashHits(text) {
  const hits = [];
  if (text.indexOf('\u2014') !== -1) hits.push('em dash');
  if (text.indexOf('\u2013') !== -1) hits.push('en dash');
  if (text.indexOf('\u2192') !== -1) hits.push('arrow');
  return hits;
}

const README = read('README.md');
const README_LINES = README.split('\n');
const targets = linkTargets(README);

test('RC1: the README links the releases page, the sample site and the leak demo', () => {
  for (const url of [
    'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases',
    'https://drnoisys-softworks.github.io/gm-scriptorium/',
    'https://drnoisys-softworks.github.io/gm-scriptorium/leak-demo.html',
  ]) {
    assert.ok(targets.some((t) => t === url), url);
  }
});

test('RC2: the README links the leak-check limits and the vault requirements', () => {
  assert.ok(
    targets.some((t) => t === 'docs/explanation/what-players-see.md#what-the-leak-checks-cannot-see'),
  );
  assert.ok(targets.some((t) => t === 'docs/using.md#what-you-need'));
});

test('RC3: the two anchor headings exist as whole lines', () => {
  assert.ok(
    read('docs/explanation/what-players-see.md').split('\n').some((l) => l === '## What the leak checks cannot see'),
  );
  assert.ok(read('docs/using.md').split('\n').some((l) => l === '## What you need'));
});

test('RC4: the README has no em dash, en dash or arrow', () => {
  assert.deepEqual(dashHits(README), []);
});

test('RC5: the README no longer promises GM notes are never put on the site', () => {
  assert.ok(!README_LINES.some((l) => l.includes('are never put on the site')));
});

test('RC6: the reader key line is present', () => {
  assert.ok(
    README_LINES.some(
      (l) => l === 'Anything this page marks "Since 0.5.0" needs version 0.5.0 or later; `gm-scriptorium --version` shows yours.',
    ),
  );
});

test('RC7: the README no longer claims browser setup for the published release', () => {
  assert.ok(
    !README_LINES.some((l) => l.includes('With no campaign yet, the panel starts with setup. Close the window to stop it.')),
  );
  assert.ok(
    !README_LINES.some((l) => l.includes('With no campaign yet, `gm-scriptorium serve --admin` starts setup')),
  );
});

test('C1 control: dashHits finds all three planted characters', () => {
  assert.deepEqual(dashHits('a \u2014 b \u2013 c \u2192 d'), ['em dash', 'en dash', 'arrow']);
});

test('C2 control: link comparison is exact, so a missing trailing slash does not match', () => {
  const planted = linkTargets('[x](https://drnoisys-softworks.github.io/gm-scriptorium)');
  assert.ok(!planted.some((t) => t === 'https://drnoisys-softworks.github.io/gm-scriptorium/'));
});
