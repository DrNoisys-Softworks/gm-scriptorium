'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/* QA F10: --config pointing at a file that does not exist. */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input: '', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

for (const cmd of ['check', 'build', 'serve']) {
  test(`F10: ${cmd} with a missing --config says the file was not found (exit code 3, issue #108)`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cfgmiss-'));
    try {
      const missing = path.join(dir, 'nope', 'x.toml');
      const r = run([cmd, '--config', missing], { SCRIPTORIUM_CONFIG: path.join(dir, 'other.toml') });
      assert.equal(r.code, 3);
      assert.ok(r.err.includes(`config file not found: ${missing}`), r.err);
      assert.ok(!r.err.includes('no campaigns registered'), r.err);
      assert.ok(!r.err.includes('at '), 'no stack trace');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('F10: config add --config still creates a new file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cfgmiss-'));
  try {
    const cfg = path.join(dir, 'new.toml');
    const r = run(['config', 'add', 'x', '--vault', path.join(dir, 'v'), '--out', path.join(dir, 'o'), '--config', cfg]);
    assert.equal(r.code, 0, r.err + r.out);
    assert.ok(fs.existsSync(cfg));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F10: no --config and no default config keeps the old "no campaigns registered" message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cfgmiss-'));
  try {
    const r = run(['check'], { SCRIPTORIUM_CONFIG: path.join(dir, 'absent.toml') });
    assert.equal(r.code, 3); // #108
    assert.ok(r.err.includes('no campaigns registered'), r.err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
