'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgv } = require('../src/cli/args');

/* Issue #83: `update --version <tag>` must reach the update command; plain --version still prints the version. */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('parseArgv: update --version TAG carries the tag as the flag value, not a positional', () => {
  const r = parseArgv(['update', '--version', 'v0.2.3']);
  assert.deepEqual(r._, ['update']);
  assert.equal(r.flags.version, 'v0.2.3');
});

test('parseArgv: plain --version stays a boolean, and does not swallow a following word', () => {
  assert.equal(parseArgv(['--version']).flags.version, true);
  const r = parseArgv(['--version', 'check']);
  assert.equal(r.flags.version, true);
  assert.deepEqual(r._, ['check']);
});

test('CLI: scriptorium --version still prints the running version, exit 0', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split('\n')[0], require('../package.json').version);
});

test('CLI: update --version TAG reaches runUpdateCommand (source-mode guard, exit 4)', () => {
  const r = run(['update', '--version', 'v0.0.1']);
  assert.equal(r.status, 4, r.stderr + r.stdout);
  assert.match(r.stdout + r.stderr, /only runs inside a packaged/);
  assert.doesNotMatch(r.stdout, /^\d+\.\d+\.\d+/m, 'must not print the running version');
});

test('runUpdateCommand: bare --version (no tag) is refused before any gh call', () => {
  const { runUpdateCommand } = require('../src/cli/update');
  let ghCalled = false;
  const r = runUpdateCommand({ version: true }, {
    isPkg: true, platform: 'linux', execPath: '/nonexistent/dir/scriptorium', tmpRoot: '/nonexistent/tmp',
    requireGh: () => { ghCalled = true; return 'gh'; },
  });
  assert.equal(ghCalled, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.human, /needs a release tag/);
});
