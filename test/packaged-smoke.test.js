'use strict';

/*
 * rc.4 #9: the packaged-binary smoke script. scripts/packaged-smoke.js runs against any argv
 * prefix, so this suite runs it against the source on every PR. (a) is the drift detector for
 * the pinned EXPECTED counts: if the example vault or a check changes the counts, it fails here
 * on the PR, not only after merge. (b) is the liveness control: with nothing planted the
 * "must find" step has to fail, otherwise a dead output scanner would pass the smoke.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'packaged-smoke.js');
const BIN = path.join(ROOT, 'bin', 'scriptorium.js');

function load() {
  return require(SCRIPT);
}

test('(a) runSmoke against the source passes every step', () => {
  const { runSmoke } = load();
  const res = runSmoke({ command: [process.execPath, BIN] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(
    res.lines.map((l) => l.split(' ')[1]),
    ['version', 'build', 'check-clean', 'check-planted', 'PASS'],
  );
});

test('(b) liveness control: nothing planted means the must-find step fails with marker-not-found', () => {
  const { runSmoke } = load();
  const res = runSmoke({ command: [process.execPath, BIN], plant: false });
  assert.equal(res.ok, false);
  assert.equal(res.step, 'check-planted');
  assert.equal(res.reason, 'marker-not-found');
});

test('(c) a missing binary exits 1 with SMOKE FAIL version', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '/nonexistent/gm-scriptorium'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^SMOKE FAIL version /m);
});

test('(d) the spawn helper isolates config five ways and the script avoids force and site_config', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // Assignments, not bare names: the file header mentions the same names in prose.
  for (const token of [
    'env.SCRIPTORIUM_CONFIG = ',
    'env.APPDATA = ',
    'env.XDG_CONFIG_HOME = ',
    "'--config'",
  ]) {
    assert.ok(src.includes(token), `script source must contain ${token}`);
  }
  assert.match(src, /delete env\.SCRIPTORIUM_PROFILE/);
  assert.equal(src.includes('site_config'), false);
  assert.equal(src.includes('--force'), false);
});

test('(e) the pin carries the measured literals and the planted name', () => {
  const { PLANTED_NAME, EXPECTED } = load();
  assert.equal(PLANTED_NAME, 'Ottoline Pardew');
  assert.equal(EXPECTED.planted.exit, 2);
  assert.equal(EXPECTED.clean.exit, 0);
  assert.deepEqual(EXPECTED.clean, { exit: 0, error: 0, warn: 0, info: 1 });
  assert.deepEqual(EXPECTED.planted, { exit: 2, error: 1, warn: 0, info: 1 });
  assert.equal(Object.isFrozen(EXPECTED), true);
});

test('(f) the planted exit is checked as the literal 2, independent of EXPECTED', () => {
  // A wrapper around the real CLI that reports exit 0 for every check, as a binary that no longer
  // signals a leak would. The planted step must fail on the exit even if the EXPECTED pin said 0.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-smoke-wrap-'));
  try {
    const wrap = path.join(dir, 'wrap.js');
    fs.writeFileSync(
      wrap,
      [
        "const { spawnSync } = require('child_process');",
        "const r = spawnSync(process.execPath, process.argv.slice(2), { encoding: 'utf8' });",
        'process.stdout.write(r.stdout);',
        'process.stderr.write(r.stderr);',
        "process.exit(process.argv[3] === 'check' ? 0 : r.status);",
        '',
      ].join('\n'),
    );
    const { runSmoke } = load();
    const res = runSmoke({ command: [process.execPath, wrap, BIN] });
    assert.equal(res.ok, false);
    assert.equal(res.step, 'check-planted');
    assert.match(res.reason, /^exit got 0 want 2$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
