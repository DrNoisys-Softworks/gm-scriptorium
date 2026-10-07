'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveStaticPath } = require('../src/serve/static');

/*
 * QA close-out (phase 8, admin-qa branch). Two branches of resolveStaticPath's Rule 6
 * (src/serve/static.js:91-100, the symlink-escape / D11-M9 containment check) were unexercised
 * by test/serve-static.test.js and test/serve-emission.test.js (node --test
 * --experimental-test-coverage --test-reporter=lcov): the `catch { realRoot = rootAbs; }`
 * fallback when fs.realpathSync(rootAbs) itself throws, and the `catch { return 404; }` when
 * fs.realpathSync(filePath) throws after the preceding fs.existsSync(filePath) already passed
 * (a TOCTOU window: the file vanishes between the two calls). Both sit inside the resolver both
 * the preview listener and, after D11, plain `serve` share -- the exact containment logic that
 * closes the sibling-directory and crash-on-malformed-escape defects CLAUDE.md's own "verify the
 * artefact" story is about. Synthetic cast only; every fixture is a fresh mkdtemp root, removed
 * in t.after.
 */

function withScratchRoot(t) {
  // realpathSync: the Rule 6 tests below state that root "has no symlink component of its own".
  // os.tmpdir() is itself reached through a symlink on macOS (/var -> /private/var), so the raw
  // mkdtemp path would break that premise there. A no-op on a host whose tmpdir is already real.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-static-coverage-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('positive control: a normal file under root resolves ok (unpatched fs)', (t) => {
  const root = withScratchRoot(t);
  fs.writeFileSync(path.join(root, 'index.html'), '<html>ok</html>');
  const result = resolveStaticPath(root, '/index.html');
  assert.equal(result.ok, true);
  assert.equal(result.filePath, path.join(root, 'index.html'));
});

test('Rule 6 fallback: fs.realpathSync(rootAbs) throwing falls back to the raw rootAbs, and containment still holds for a normal file', (t) => {
  const root = withScratchRoot(t);
  fs.writeFileSync(path.join(root, 'index.html'), '<html>ok</html>');

  const original = fs.realpathSync;
  let rootCallSeen = false;
  fs.realpathSync = (p) => {
    if (p === root) {
      rootCallSeen = true;
      throw Object.assign(new Error('injected: realpathSync(rootAbs) failure'), { code: 'EINJECTED' });
    }
    return original(p);
  };
  t.after(() => {
    fs.realpathSync = original;
  });

  const result = resolveStaticPath(root, '/index.html');
  assert.equal(rootCallSeen, true, 'the injected realpathSync(rootAbs) must actually have been reached');
  // The catch's fallback (realRoot = rootAbs, uncoded) still lets a genuinely-contained file
  // through: it does not fail closed, but it does not fail open either, because path.relative
  // against the raw (non-symlink-resolved) rootAbs is still correct for a file with no symlink
  // component of its own.
  assert.equal(result.ok, true);
});

test('Rule 6 fallback: fs.realpathSync(rootAbs) throwing does not weaken the symlink-escape refusal when root itself has no symlink component', (t) => {
  const root = withScratchRoot(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-static-coverage-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.html'), '<html>secret</html>');
  fs.symlinkSync(path.join(outside, 'secret.html'), path.join(root, 'link.html'));

  const original = fs.realpathSync;
  fs.realpathSync = (p) => {
    if (p === root) throw Object.assign(new Error('injected'), { code: 'EINJECTED' });
    return original(p);
  };
  t.after(() => {
    fs.realpathSync = original;
  });

  // Positive control first, same patch active: an in-root file still resolves ok.
  fs.writeFileSync(path.join(root, 'index.html'), '<html>ok</html>');
  assert.equal(resolveStaticPath(root, '/index.html').ok, true);

  // The symlink escape is still refused: realFile's own realpathSync (unpatched) resolves to
  // the true outside path, and path.relative(rootAbs, realFile) still starts with '..'. This
  // test does not by itself prove the fallback is safe in general -- root here has no symlink
  // component of its own, so its raw form already equals its own realpath, and the fallback
  // changes nothing observable. A root directory that is ITSELF a symlink or reachable only
  // through one, combined with realpathSync(rootAbs) failing, is not exercised anywhere in the
  // suite and is a genuine residual worth naming: see the QA report.
  const escaped = resolveStaticPath(root, '/link.html');
  assert.equal(escaped.ok, false);
  assert.equal(escaped.status, 404);
});

test('Rule 6 TOCTOU: fs.realpathSync(filePath) throwing after existsSync already passed gives 404, not an uncaught exception', (t) => {
  const root = withScratchRoot(t);
  const filePath = path.join(root, 'vanishing.html');
  fs.writeFileSync(filePath, '<html>here now</html>');

  const original = fs.realpathSync;
  let filePathCallSeen = false;
  fs.realpathSync = (p) => {
    if (p === filePath) {
      filePathCallSeen = true;
      throw Object.assign(new Error('injected: ENOENT (file vanished between existsSync and realpathSync)'), { code: 'ENOENT' });
    }
    return original(p);
  };
  t.after(() => {
    fs.realpathSync = original;
  });

  const result = resolveStaticPath(root, '/vanishing.html');
  assert.equal(filePathCallSeen, true, 'the injected realpathSync(filePath) must actually have been reached');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});
