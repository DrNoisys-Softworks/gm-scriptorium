'use strict';

/*
 * Doc-vs-code facts for docs/explanation/what-players-see.md. The page is prose, so these tests
 * pin only the statements the code can check: the always-excluded folders, the two clean-run
 * sentences it quotes, the heading the README links into, and the links to the hosted sample.
 * Tests 1, 2, 4 and 5 pass today and prove nothing on their own; their evidence is the
 * mutations recorded in the pull request (delete the heading, delete `personal`, rename the
 * `## Leak checks` heading, delete the demo URL), each of which turns one of them red.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PAGE = 'docs/explanation/what-players-see.md';

test('the page has the leak-limits heading', () => {
  assert.ok(read(PAGE).split('\n').includes('## What the leak checks cannot see'));
});

test('the page names every always-excluded folder, in backticks', () => {
  const { ALWAYS_EXCLUDE_DIRS } = require('../src/generator/pinned');
  assert.ok(ALWAYS_EXCLUDE_DIRS.length > 0);
  const text = read(PAGE);
  for (const dir of ALWAYS_EXCLUDE_DIRS) {
    assert.ok(text.includes('`' + dir + '`'), `${dir} is not on the page`);
  }
});

test('the page quotes the last two sentences of the clean-run message', () => {
  const { CLEAN_RUN_MESSAGE } = require('../src/report/human');
  const lastTwo = CLEAN_RUN_MESSAGE([], false).split(/(?<=\.) /).slice(-2);
  assert.equal(lastTwo.length, 2);
  const text = read(PAGE);
  for (const s of lastTwo) assert.ok(text.includes(s), `missing: ${s}`);
});

test('using.md keeps its Leak checks heading and links the page', () => {
  const using = read('docs/using.md');
  assert.ok(using.split('\n').includes('## Leak checks'));
  assert.ok(using.includes('explanation/what-players-see.md'));
});

test('the page links the hosted sample and the leak demo', () => {
  const targets = Array.from(read(PAGE).matchAll(/\]\(([^)\s]+)\)/g), (m) => m[1]);
  const SAMPLE = 'https://drnoisys-softworks.github.io/gm-scriptorium/';
  const DEMO = 'https://drnoisys-softworks.github.io/gm-scriptorium/leak-demo.html';
  assert.equal(targets.filter((t) => t === SAMPLE).length, 1);
  assert.equal(targets.filter((t) => t === DEMO).length, 1);
});

test('the page has no em dash, en dash or arrow', () => {
  const text = read(PAGE);
  for (const ch of ['—', '–', '→']) assert.ok(!text.includes(ch), `U+${ch.codePointAt(0).toString(16)}`);
});
