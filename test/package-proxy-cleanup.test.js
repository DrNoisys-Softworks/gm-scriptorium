'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeProxyBuildDir } = require('../scripts/package');

/*
 * #28: `npm run package`'s startup self-test proxy build used to write its
 * throwaway exe as a bare file directly under os.tmpdir(), and clean up
 * only that file by name. Running `--version` on that exe writes
 * THIRD-PARTY-NOTICES.txt beside whatever binary it runs (confirmed
 * separately: scripts/generate-notices.js's own output path, used by the
 * CLI's `--version` handler) -- landing in os.tmpdir() itself, under a
 * fixed filename, and surviving every run's cleanup.
 *
 * These tests exercise the real filesystem (no pkg invocation, no exec):
 * makeProxyBuildDir()'s own contract, then a literal before/after of the
 * two cleanup shapes using Node's actual fs.rmSync semantics as the
 * independent ground truth, not anything read back from scripts/package.js.
 */

function cleanupIfExists(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

test('makeProxyBuildDir(): creates a real directory directly under os.tmpdir()', () => {
  const { dir } = makeProxyBuildDir();
  try {
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.statSync(dir).isDirectory(), true);
    assert.equal(path.dirname(dir), os.tmpdir());
  } finally {
    cleanupIfExists(dir);
  }
});

test('makeProxyBuildDir(): the returned exePath is inside the returned dir', () => {
  const { dir, exePath } = makeProxyBuildDir();
  try {
    assert.equal(path.dirname(exePath), dir);
  } finally {
    cleanupIfExists(dir);
  }
});

test('makeProxyBuildDir(): two calls return two distinct directories', () => {
  const first = makeProxyBuildDir();
  // Force a distinct Date.now() tick so the directory name (which embeds
  // process.pid and Date.now()) cannot collide within this test.
  const start = Date.now();
  while (Date.now() === start) {
    /* spin until the millisecond ticks over */
  }
  const second = makeProxyBuildDir();
  try {
    assert.notEqual(first.dir, second.dir);
  } finally {
    cleanupIfExists(first.dir);
    cleanupIfExists(second.dir);
  }
});

test('#28 fix: fs.rmSync(dir, { recursive: true, force: true }) removes the exe AND a sibling file the self-test wrote beside it', () => {
  const { dir, exePath } = makeProxyBuildDir();
  try {
    fs.writeFileSync(exePath, 'fake-exe-bytes');
    const noticesPath = path.join(dir, 'THIRD-PARTY-NOTICES.txt');
    fs.writeFileSync(noticesPath, 'fake-notices-bytes');
    assert.equal(fs.existsSync(exePath), true);
    assert.equal(fs.existsSync(noticesPath), true);

    // The actual finally-block cleanup, #28's fix.
    fs.rmSync(dir, { recursive: true, force: true });

    assert.equal(fs.existsSync(dir), false, 'the whole probe directory must be gone');
    assert.equal(fs.existsSync(exePath), false);
    assert.equal(fs.existsSync(noticesPath), false);
  } finally {
    cleanupIfExists(dir);
  }
});

test('#28 defect, reproduced literally: the OLD single-file cleanup (fs.rmSync(exePath, { force: true })) leaves a sibling file and the directory behind', () => {
  const { dir, exePath } = makeProxyBuildDir();
  try {
    fs.writeFileSync(exePath, 'fake-exe-bytes');
    const noticesPath = path.join(dir, 'THIRD-PARTY-NOTICES.txt');
    fs.writeFileSync(noticesPath, 'fake-notices-bytes');

    // Exactly what scripts/package.js's finally block did before #28.
    fs.rmSync(exePath, { force: true });

    assert.equal(fs.existsSync(exePath), false, 'the exe itself is removed, same as before');
    assert.equal(fs.existsSync(noticesPath), true, 'the pre-#28 cleanup left the notices file behind — the bug');
    assert.equal(fs.existsSync(dir), true, 'the pre-#28 cleanup left the probe directory behind — the bug');
  } finally {
    cleanupIfExists(dir);
  }
});
