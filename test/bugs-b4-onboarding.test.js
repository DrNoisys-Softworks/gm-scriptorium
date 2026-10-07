'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withScratch, run } = require('./helpers/b4-cli');
const { locateVault } = require('../src/vault/locate');

/*
 * Issue #107: a new GM could not tell what a vault is, how to get one, or what to do about the two
 * first errors they hit. The README now says so, and both errors name a next step.
 */

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const UPSTREAM = 'https://github.com/AntTheLimey/gm-apprentice';

function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `README has no "## ${heading}" section`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n## ', 3);
  return next === -1 ? rest : rest.slice(0, next);
}

test('B4-107-1: the README has a "What you need" section before Quick start, with the three pointers', () => {
  assert.ok(README.indexOf('\n## What you need\n') !== -1);
  assert.ok(README.indexOf('\n## What you need\n') < README.indexOf('\n## Quick start\n'));
  const need = section(README, 'What you need');
  assert.match(need, /_meta\/vault-config\.md/);
  assert.match(need, /_meta\/publish-manifest\.md/);
  assert.ok(need.includes('examples/the-long-lease'));
  assert.ok(need.includes(UPSTREAM));
});

test('B4-107-2: the Quick start mentions the sample vault', () => {
  const quick = section(README, 'Quick start');
  assert.ok(quick.includes('examples/the-long-lease'), 'Quick start should point at the sample');
});

test('B4-107-3: the new README text follows the house style (no em dashes, no spaced double hyphens, no arrows, no emojis)', () => {
  const text = `${section(README, 'What you need')}${section(README, 'Quick start')}`;
  assert.doesNotMatch(text, /—|–/);
  assert.doesNotMatch(text, / -- /);
  assert.doesNotMatch(text, /→|-->|=>/);
  assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
});

test('B4-107-4: the "not a gm-apprentice vault" error says what a vault needs and where to get one', () => {
  withScratch((root) => {
    fs.mkdirSync(path.join(root, 'plain'));
    assert.throws(
      () => locateVault(path.join(root, 'plain'), 'emp'),
      (err) =>
        err.reason === 'not-a-vault' &&
        err.message.includes('is not a gm-apprentice vault') &&
        err.message.includes('_meta/vault-config.md') &&
        err.message.includes('examples/the-long-lease') &&
        err.message.includes(UPSTREAM) &&
        !/—/.test(err.message),
    );
  });
});

test('B4-107-5: init on an ordinary folder exits 3 and prints the next step', () => {
  withScratch((root) => {
    fs.mkdirSync(path.join(root, 'plain'));
    const res = run(root, ['init', '--vault', path.join(root, 'plain'), '--name', 'emp', '--yes']);
    assert.equal(res.code, 3);
    assert.match(res.err, /not a gm-apprentice vault/);
    assert.ok(res.err.includes(UPSTREAM));
  });
});

test('B4-107-6: the l1-no-manifest error says what to do, with the file layout and a pointer to the sample', () => {
  withScratch((root) => {
    const vault = path.join(root, 'v');
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\ncampaign: T\npublish:\n  mode: player\n---\n');
    assert.equal(run(root, ['init', '--vault', vault, '--name', 't', '--yes', '--out', path.join(root, 'o')]).code, 0);
    const res = run(root, ['check', 't', '--json']);
    const finding = JSON.parse(res.out).findings.find((f) => f.id === 'leak/l1-no-manifest');
    assert.ok(finding, res.all);
    assert.match(finding.message, /_meta\/publish-manifest\.md is missing/);
    assert.match(finding.message, /## Publishing/);
    assert.match(finding.message, /- \[x\] Locations\/Some Place\.md/);
    assert.ok(finding.message.includes('examples/the-long-lease/_meta/publish-manifest.md'));
    assert.doesNotMatch(finding.message, /—/);
  });
});
