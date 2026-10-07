'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

/*
 * QA F08: `<command> --help` printed the global usage block for every command. Each command now
 * has its own text; the global block stays as it was, plus one pointer line.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
function help(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input: '' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const GLOBAL_MARKER = 'Global flags:';

// Independent expectations: a phrase each command's help must carry, written by hand.
const EXPECT = {
  init: 'Walks you through registering a vault',
  check: 'changes nothing. Run it before every build',
  build: 'writes the player-facing website',
  serve: 'http://127.0.0.1:8080',
  status: 'last and next session',
  config: 'remove <name>',
  update: 'GitHub command',
};

for (const [cmd, phrase] of Object.entries(EXPECT)) {
  test(`F08: ${cmd} --help prints its own usage with exit codes, not the global block`, () => {
    const r = help([cmd, '--help']);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes(phrase), r.out);
    assert.ok(r.out.includes('Exit codes:'), r.out);
    assert.ok(!r.out.includes(GLOBAL_MARKER), 'must not be the global block');
    assert.ok(r.out.startsWith(`gm-scriptorium ${cmd}`));
  });
}

test('F08: help flag position does not matter', () => {
  assert.equal(help(['--help', 'build']).out, help(['build', '--help']).out);
});

test('F08: global --help keeps its command lines and gains the pointer line', () => {
  const r = help(['--help']);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('  build    [campaign] [--no-check] [--force] [--out <path>] [--json]'));
  assert.ok(r.out.includes(GLOBAL_MARKER));
  assert.ok(r.out.includes('Run "gm-scriptorium <command> --help"'));
});

test('F08: --help on an unknown command falls back to the global block', () => {
  const r = help(['chek', '--help']);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes(GLOBAL_MARKER));
});

test('F08: help text has no em dashes', () => {
  for (const cmd of Object.keys(EXPECT)) assert.ok(!help([cmd, '--help']).out.includes('—'));
});
