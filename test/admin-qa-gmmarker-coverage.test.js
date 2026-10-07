'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GM_LINK_MARKER, findGmLinkMarker } = require('../src/build/gmmarker');

/*
 * QA close-out (phase 8, admin-qa branch). Two branches of findGmLinkMarker's walk were
 * unexercised by the S6 suite (node --test --experimental-test-coverage --test-reporter=lcov
 * over test/admin-*.test.js, test/gm-link*.test.js, test/pack-replace.test.js,
 * test/serve-static.test.js, test/serve-emission.test.js): the `catch { return; }` on a
 * readdirSync failure (gmmarker.js:39) and the `if (!entry.isFile()) continue;` skip for a
 * non-file directory entry (gmmarker.js:49). Both sit inside the walk the unconditional
 * output-gate (FR34(b), src/build/outputgate.js) relies on to refuse ANY build carrying the GM
 * link, so an untested branch here is exactly CLAUDE.md's "an untested branch in the request
 * gate is a finding" concern applied to the gate's own scanner. Synthetic cast only; every fixture
 * is built in a fresh mkdtemp root and removed in t.after.
 */

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gmmarker-coverage-'));
}

test('positive control: a marker in a plain, readable file is found', (t) => {
  const root = scratchDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, 'page.html'), `<body>hi <a ${GM_LINK_MARKER}>x</a></body>`);
  const hits = findGmLinkMarker(root);
  assert.deepEqual(hits, ['page.html']);
});

test('an unreadable subdirectory is skipped (walk continues), not thrown -- and a marker only inside it is MISSED', (t) => {
  const root = scratchDir();
  t.after(() => {
    // Restore permissions before recursive removal, or rmSync itself cannot descend into it.
    fs.chmodSync(locked, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'hidden.html'), `<body>hi <a ${GM_LINK_MARKER}>x</a></body>`);
  fs.writeFileSync(path.join(root, 'sibling.html'), `<body>hi <a ${GM_LINK_MARKER}>x</a></body>`);

  // A directory with no read/execute permission makes readdirSync throw EACCES for a
  // non-root user (this test process is never expected to run as root; if it does, this
  // is a false pass -- documented, not worked around, matching the repo's own convention of
  // recording residuals rather than papering over them).
  fs.chmodSync(locked, 0o000);
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root: chmod 000 does not block readdirSync, so this branch cannot be forced this way');
    return;
  }

  const hits = findGmLinkMarker(root);

  // The walk does not throw (confirms the catch swallows the readdirSync failure)...
  assert.deepEqual(hits, ['sibling.html']);
  // ...but the marker inside the unreadable subtree was never seen. This is the exact residual:
  // an output tree containing an unreadable directory with leaked GM-link content would NOT be
  // refused by the unconditional gate, because the scanner silently skips what it cannot read.
  // In `scriptorium build`'s own pipeline this is low-likelihood (the tool created every file
  // in the staging tree itself, at its own default permissions), but it is untested behaviour in
  // a gate whose entire purpose is "no override, ever" -- flagged in the QA report, not fixed
  // here.
});

test('a symlinked file, even one whose target contains the marker, is never read (never followed)', (t) => {
  const root = scratchDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = path.join(root, 'target.html');
  fs.writeFileSync(target, `<body>hi <a ${GM_LINK_MARKER}>x</a></body>`);
  fs.symlinkSync(target, path.join(root, 'link.html'));
  fs.writeFileSync(path.join(root, 'real.html'), `<body>hi <a ${GM_LINK_MARKER}>x</a></body>`);

  const hits = findGmLinkMarker(root);
  // target.html is found because it is a real file, walked directly. link.html (the symlink to
  // it) is NOT in the results even though it points at a file containing the marker: it is a
  // symlink, so `entry.isFile()` is false for its own dirent (readdirSync's own reported type,
  // not a followed stat), and `if (!entry.isFile()) continue;` skips it without ever opening it.
  assert.deepEqual(hits.sort(), ['real.html', 'target.html']);
});

test('a symlinked directory is never recursed into, even when it points at a directory containing the marker', (t) => {
  const root = scratchDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const realSubdir = path.join(root, 'real-subdir');
  fs.mkdirSync(realSubdir);
  fs.writeFileSync(path.join(realSubdir, 'inner.html'), `<body>hi <a ${GM_LINK_MARKER}>x</a></body>`);
  fs.symlinkSync(realSubdir, path.join(root, 'linked-subdir'));
  fs.writeFileSync(path.join(root, 'top.html'), `<body>hi <a ${GM_LINK_MARKER}>x</a></body>`);

  const hits = findGmLinkMarker(root);
  // The symlinked directory alias never appears (not recursed into): only the real path and the
  // top-level file are found. Confirms `entry.isDirectory()` is false for a directory symlink's
  // own dirent, exactly like the file case above.
  assert.deepEqual(hits.sort(), ['real-subdir/inner.html', 'top.html']);
});
