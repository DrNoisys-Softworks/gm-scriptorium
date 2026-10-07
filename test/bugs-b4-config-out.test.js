'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');

/*
 * Issue #104: `config add` with no --out registered a campaign with no output folder, and the next
 * `build` died with a raw TypeError and a stack trace. The docs define no default for --out, so
 * `config add` now refuses, and `build` and `serve` give a plain message for a config that already
 * lacks one (hand-edited, or written by an older version). Exit code is 3 for the missing output folder on build/serve (issue #108), 1 for the config add refusal.
 */

function cfgPath(root) {
  return path.join(root, 'config.toml');
}

test('B4-104-1: config add with no --out refuses, says what to pass, and writes nothing', () => {
  withScratch((root) => {
    const res = run(root, ['config', 'add', 'nout', '--vault', SAMPLE]);
    assert.equal(res.code, 1);
    assert.match(res.err, /needs --out <folder>/);
    assert.match(res.err, /config add nout --vault <vault folder> --out <output folder>/);
    assert.equal(fs.existsSync(cfgPath(root)), false);
  });
});

test('B4-104-2: build on a campaign that has no output folder gives a clear message, never a TypeError', () => {
  withScratch((root) => {
    fs.writeFileSync(cfgPath(root), `config_version = 1\n\n[campaigns.nout]\nvault = '${SAMPLE}'\n`);
    const res = run(root, ['build', 'nout']);
    assert.equal(res.code, 3); // #108: a campaign problem, exit 3
    assert.match(res.err, /campaign "nout" has no output folder/);
    assert.match(res.err, /--out <folder>/);
    assert.doesNotMatch(res.all, /TypeError|ERR_INVALID_ARG_TYPE|\n\s+at /);
  });
});

test('B4-104-3: serve on a campaign that has no output folder gives the same clear message', () => {
  withScratch((root) => {
    fs.writeFileSync(cfgPath(root), `config_version = 1\n\n[campaigns.nout]\nvault = '${SAMPLE}'\n`);
    const res = run(root, ['serve', 'nout']);
    assert.equal(res.code, 3); // #108: a campaign problem, exit 3
    assert.match(res.err, /campaign "nout" has no output folder/);
    assert.doesNotMatch(res.all, /TypeError|\n\s+at /);
  });
});

test('B4-104-4: build --out <folder> still works for a campaign with no output folder registered', () => {
  withScratch((root) => {
    fs.writeFileSync(cfgPath(root), `config_version = 1\n\n[campaigns.nout]\nvault = '${SAMPLE}'\n`);
    const out = path.join(root, 'site');
    const res = run(root, ['build', 'nout', '--no-check', '--out', out]);
    assert.equal(res.code, 0, res.all);
    assert.equal(fs.existsSync(path.join(out, 'index.html')), true);
  });
});

test('B4-104-5: re-adding a campaign that already has an output folder needs no --out and keeps it', () => {
  withScratch((root) => {
    const out = path.join(root, 'site');
    assert.equal(run(root, ['config', 'add', 'lease', '--vault', SAMPLE, '--out', out]).code, 0);
    assert.equal(run(root, ['config', 'add', 'lease', '--vault', SAMPLE]).code, 0);
    assert.match(fs.readFileSync(cfgPath(root), 'utf8'), new RegExp(`output = '?"?${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});
