'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/* QA F09: config add silently overwrote an existing campaign of the same name. */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');

test('F09: adding the same name twice says the second one replaced the first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-replace-'));
  try {
    const cfg = path.join(dir, 'c.toml');
    const add = (v) => spawnSync(process.execPath, [BIN, 'config', 'add', 'camp', '--vault', path.join(dir, v), '--out', path.join(dir, 'o'), '--config', cfg], { encoding: 'utf8' });
    const first = add('v1');
    const second = add('v2');
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.ok(first.stdout.startsWith('registered campaign "camp" at '), first.stdout);
    assert.ok(second.stdout.startsWith('replaced the existing campaign "camp" at '), second.stdout);
    assert.ok(fs.readFileSync(cfg, 'utf8').includes('v2'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
