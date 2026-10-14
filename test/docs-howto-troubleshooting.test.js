'use strict';

/*
 * The troubleshooting, move-computer and command-line how-tos, checked against the code.
 *   1. Every message fragment in the troubleshooting table is text the program really prints.
 *   2. The settings example on the move page parses with no warnings.
 *   3. The command-line page links the exit codes page.
 *
 * The real-page checks pass today and prove nothing on their own. The planted-defect controls
 * below are what show each check can fail. Expected values are literals.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseConfig } = require('../src/config/load');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TROUBLESHOOTING = 'docs/how-to/troubleshooting.md';
const MOVE = 'docs/how-to/move-to-another-computer.md';
const CLI = 'docs/how-to/use-the-command-line-and-scripts.md';

/** Every .js file under a folder, as one string. */
function jsUnder(dir) {
  let all = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) all += jsUnder(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) all += `${fs.readFileSync(full, 'utf8')}\n`;
  }
  return all;
}

/** All of the program's source, plus the one launcher file outside src/ that prints "unknown command". */
function programSource() {
  return `${jsUnder(path.join(ROOT, 'src'))}\n${read('bin/scriptorium.js')}`;
}

/** The backticked fragments in the first cell of every row under `## Messages`. */
function messageFragments(pageText) {
  const out = [];
  let inMessages = false;
  for (const line of pageText.split('\n')) {
    if (/^##\s/.test(line)) {
      inMessages = /^##\s+Messages\s*$/.test(line);
      continue;
    }
    if (!inMessages || !line.trim().startsWith('|')) continue;
    const cells = line.trim().split('|').slice(1, -1);
    const first = cells[0].trim();
    if (first === 'What you see' || /^[-:\s]*$/.test(first)) continue;
    for (const m of first.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return out;
}

/** The fragments of the Messages table that are not substrings of `sourceText`. */
function missingFragments(pageText, sourceText) {
  return messageFragments(pageText).filter((f) => !sourceText.includes(f));
}

/** The first fenced toml block of a page. */
function firstTomlBlock(pageText) {
  const m = pageText.match(/```toml\n([\s\S]*?)\n```/);
  return m ? m[1] : null;
}

/** Every target of a Markdown link `[text](target)`, whole. */
function linkTargets(pageText) {
  return [...pageText.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

// ---- real pages ----

test('every message fragment in the troubleshooting table is in the program source', () => {
  const page = read(TROUBLESHOOTING);
  assert.ok(messageFragments(page).length >= 15, 'expected the table to hold at least 15 messages');
  assert.deepEqual(missingFragments(page, programSource()), []);
});

test('no message fragment holds a web address or a template part', () => {
  for (const f of messageFragments(read(TROUBLESHOOTING))) {
    assert.doesNotMatch(f, /:\/\//, `${f}: holds a web address`);
    assert.doesNotMatch(f, /\$\{/, `${f}: holds a template part`);
    assert.doesNotMatch(f, /\\"/, `${f}: holds an escaped quote`);
  }
});

test('every message fragment appears in the table once', () => {
  const fragments = messageFragments(read(TROUBLESHOOTING));
  assert.equal(new Set(fragments).size, fragments.length);
});

test('the first toml block on the move page parses with no warnings, with a profile that has a match', () => {
  const block = firstTomlBlock(read(MOVE));
  assert.notEqual(block, null, 'the move page has no toml block');
  const parsed = parseConfig(block);
  assert.deepEqual(parsed.warnings, []);
  const withProfiles = Object.values(parsed.config.campaigns).filter((c) => c.paths && Object.keys(c.paths).length > 0);
  assert.ok(withProfiles.length >= 1, 'no campaign has a paths table');
  for (const campaign of withProfiles) {
    for (const profile of Object.values(campaign.paths)) {
      assert.equal(typeof profile.match, 'object');
      assert.notEqual(profile.match, null);
    }
  }
});

test('the command-line page links the exit codes page', () => {
  assert.ok(linkTargets(read(CLI)).some((t) => t === '../reference/exit-codes.md'));
});

test('the three pages use no em dash, en dash or arrow', () => {
  for (const rel of [TROUBLESHOOTING, MOVE, CLI]) {
    const text = read(rel);
    assert.ok(!text.includes('—'), `${rel}: em dash`);
    assert.ok(!text.includes('–'), `${rel}: en dash`);
    assert.ok(!text.includes('→'), `${rel}: arrow`);
  }
});

// ---- planted-defect controls, on scratch strings ----

const TABLE = (rows) => [
  '# T', '', '## Messages', '',
  '| What you see | What it means | What to do |',
  '|---|---|---|',
  ...rows,
  '',
  '## Other',
  '',
  '| `not in a Messages table` | x | y |',
  '',
].join('\n');

test('control: a fragment found in the source is not reported; a planted one is', () => {
  const page = TABLE(['| `real words here` | a | b |', '| `no such message anywhere` | a | b |']);
  assert.deepEqual(missingFragments(page, 'before real words here after'), ['no such message anywhere']);
});

test('control: the header row, the separator row and tables under other headings are skipped', () => {
  const page = TABLE(['| `kept` | a | b |']);
  assert.deepEqual(messageFragments(page), ['kept']);
});

test('control: a fragment with a typo is reported', () => {
  const page = TABLE(['| `refusing to bild inside the vault` | a | b |']);
  assert.deepEqual(missingFragments(page, 'refusing to build inside the vault: /x'), ['refusing to bild inside the vault']);
});

test('control: a toml block with a misspelt key is read as a warning or an error', () => {
  const bad = ['config_version = 1', '', '[campaigns.lease]', "vualt = '/srv/lease/vault'", ''].join('\n');
  let problems = [];
  try {
    problems = parseConfig(bad).warnings;
  } catch (err) {
    problems = [err.message];
  }
  assert.ok(problems.length > 0);
});

test('control: link targets are compared whole', () => {
  const text = 'See [codes](../reference/exit-codes.md) and [other](../reference/exit-codes.md#x).';
  assert.deepEqual(linkTargets(text), ['../reference/exit-codes.md', '../reference/exit-codes.md#x']);
  assert.ok(!linkTargets('[a](../reference/exit-codes.md#x)').some((t) => t === '../reference/exit-codes.md'));
});
