'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runConfigCommand } = require('../src/cli/config');
const { ConfigError } = require('../src/util/errors');

/*
 * `config edit` exits 0 only when the editor exits 0. Any other outcome (a non-zero status, a signal,
 * an editor that cannot start) is a ConfigError, which the CLI turns into exit 1 with a one-line
 * message. That ConfigError > exit 1 step is proven end to end by the "unknown config subcommand" row
 * in exit-codes-user-errors.test.js. Nothing here starts a program or touches process.env: the spawn
 * and the environment are injected.
 */

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.toml');
  return { configPath, flags: { config: configPath } };
}

function fake(result) {
  const calls = [];
  const spawnEditor = (...args) => (calls.push(args), result);
  return { calls, spawnEditor };
}

test('config edit: editor exits 0 gives exit 0, and is called with the config path', (t) => {
  const { configPath, flags } = setup(t);
  const f = fake({ status: 0 });
  const r = runConfigCommand(flags, 'edit', [], { env: { EDITOR: 'my-editor' }, spawnEditor: f.spawnEditor });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(f.calls, [['my-editor', [configPath], { stdio: 'inherit' }]]);
});

test('config edit: editor exits 2 throws a ConfigError naming the editor and status', (t) => {
  const { flags } = setup(t);
  const f = fake({ status: 2 });
  assert.throws(
    () => runConfigCommand(flags, 'edit', [], { env: { EDITOR: 'my-editor' }, spawnEditor: f.spawnEditor }),
    (e) => e instanceof ConfigError && /the editor "my-editor" exited with status 2/.test(e.message),
  );
});

test('config edit: editor exits 130 throws a ConfigError', (t) => {
  const { flags } = setup(t);
  const f = fake({ status: 130 });
  assert.throws(
    () => runConfigCommand(flags, 'edit', [], { env: { EDITOR: 'my-editor' }, spawnEditor: f.spawnEditor }),
    (e) => e instanceof ConfigError && /status 130/.test(e.message),
  );
});

test('config edit: editor stopped by a signal throws a ConfigError', (t) => {
  const { flags } = setup(t);
  const f = fake({ status: null, signal: 'SIGTERM' });
  assert.throws(
    () => runConfigCommand(flags, 'edit', [], { env: { EDITOR: 'my-editor' }, spawnEditor: f.spawnEditor }),
    (e) => e instanceof ConfigError && /was stopped by SIGTERM/.test(e.message),
  );
});

test('config edit: editor that cannot start throws a ConfigError', (t) => {
  const { flags } = setup(t);
  const f = fake({ status: null, error: Object.assign(new Error('spawnSync my-editor ENOENT'), { code: 'ENOENT' }) });
  assert.throws(
    () => runConfigCommand(flags, 'edit', [], { env: { EDITOR: 'my-editor' }, spawnEditor: f.spawnEditor }),
    (e) => e instanceof ConfigError && /could not start the editor "my-editor" \(ENOENT\)/.test(e.message),
  );
});

test('config edit: no editor set gives exit 0 with a note, and starts nothing', (t) => {
  const { flags } = setup(t);
  const f = fake({ status: 0 });
  const r = runConfigCommand(flags, 'edit', [], { env: {}, spawnEditor: f.spawnEditor });
  assert.equal(r.exitCode, 0);
  assert.match(r.human, /no \$EDITOR set/);
  assert.equal(f.calls.length, 0);
});

test('config edit: VISUAL is used when EDITOR is not set', (t) => {
  const { flags } = setup(t);
  const f = fake({ status: 0 });
  runConfigCommand(flags, 'edit', [], { env: { VISUAL: 'v-editor' }, spawnEditor: f.spawnEditor });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'v-editor');
});
