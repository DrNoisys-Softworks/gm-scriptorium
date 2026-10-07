'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const { replacePackFile, PackChangedError, REPLACEABLE_FILES, RETRYABLE_CODES } = require('../src/vault/packreplace');
const { ConfigError, ScriptoriumError } = require('../src/util/errors');

/*
 * Phase 8 slice S3 (P8-D01's default; test-first order item 2). Synthetic names only
 * (NFR-10/NFR-11); every vault is built fresh in os.tmpdir(), never in test/fixtures.
 */

/* Copied verbatim from test/build-plan-swap.test.js:21-29 (also test/pack-write.test.js:20-28). */
function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function withScratchDir(fn) {
  // realpathSync: several tests below intercept fs.realpathSync and hand back a path built from
  // this directory as "what the real filesystem would already report". That is only true when the
  // directory's own path is already real, which os.tmpdir() is not on macOS (/var -> /private/var).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-packreplace-')));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** A minimal vault with a real, on-disk convention pack: pack.toml and vault.config.json. */
function makeVault(root, { tomlBytes = 'theme = "plain"\n', jsonBytes = '{}\n' } = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), tomlBytes);
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), jsonBytes);
  return { vaultPath, packDir };
}

function listPackDir(packDir) {
  return fs.readdirSync(packDir).sort();
}

function shaOf(p) {
  return sha256(fs.readFileSync(p));
}

// --- Success -----------------------------------------------------------

test('a success replaces the file with exactly the literal bytes, LF, no BOM, and leaves no temp file', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = listPackDir(packDir);
    const result = replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: shaOf(tomlPath) });

    const onDisk = fs.readFileSync(tomlPath);
    assert.equal(onDisk.toString('utf8'), 'theme = "haze"\n');
    assert.notEqual(onDisk[0], 0xef, 'no UTF-8 BOM byte');
    assert.equal(result.path, tomlPath);
    assert.equal(result.sha256, sha256(onDisk));
    assert.deepEqual(listPackDir(packDir), before, 'no temp file left behind');
  });
});

// --- Data check (step 2): a programming-error guard, own mutation beyond the brief's table ---

test('a non-string data throws the specific step-2 programming-error message (not a downstream I/O wrapper), and the file is unchanged', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = listPackDir(packDir);
    assert.throws(
      () => replacePackFile(vaultPath, 'pack.toml', 42, { expectedSha256: shaOf(tomlPath) }),
      (err) =>
        err instanceof ScriptoriumError &&
        err.message === 'replacePackFile: data must be an LF-only string with no leading byte-order mark (programming error)',
    );
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
    assert.deepEqual(listPackDir(packDir), before, 'no temp file left behind by the rejected write attempt');
  });
});

test('data starting with a UTF-8 BOM throws ScriptoriumError, and the file is unchanged', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    assert.throws(
      () => replacePackFile(vaultPath, 'pack.toml', '﻿theme = "haze"\n', { expectedSha256: shaOf(tomlPath) }),
      ScriptoriumError,
    );
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
  });
});

test('data containing a CR throws ScriptoriumError, and the file is unchanged (positive control: plain LF data above succeeds)', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    assert.throws(
      () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\r\n', { expectedSha256: shaOf(tomlPath) }),
      ScriptoriumError,
    );
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
  });
});

// --- Refusals: name allowlist (step 1) ----------------------------------

for (const badName of ['notes.md', 'PACK.TOML', '../x']) {
  test(`refuses an out-of-allowlist name: "${badName}"`, () => {
    withScratchDir((root) => {
      const { vaultPath, packDir } = makeVault(root);
      const before = listPackDir(packDir);
      assert.throws(
        () => replacePackFile(vaultPath, badName, 'x', { expectedSha256: 'a'.repeat(64) }),
        (err) =>
          err instanceof ConfigError &&
          err.message ===
            `refusing to replace "${badName}" in the campaign pack: only pack.toml and vault.config.json can be edited`,
      );
      assert.deepEqual(listPackDir(packDir), before);
    });
  });
}

test('REPLACEABLE_FILES is exactly pack.toml and vault.config.json', () => {
  assert.deepEqual([...REPLACEABLE_FILES], ['pack.toml', 'vault.config.json']);
});

// --- Refusals: the target itself (step 4) -------------------------------

test('refuses a symlinked pack.toml, unchanged bytes and listing', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const outsideFile = path.join(root, 'outside.toml');
    fs.writeFileSync(outsideFile, 'theme = "evil"\n');
    fs.unlinkSync(tomlPath);
    fs.symlinkSync(outsideFile, tomlPath);
    const before = listPackDir(packDir);

    assert.throws(
      () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: 'a'.repeat(64) }),
      (err) => err instanceof ConfigError && err.message === `refusing to replace ${tomlPath}: it is not a regular file`,
    );
    assert.deepEqual(listPackDir(packDir), before);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'theme = "evil"\n');
  });
});

test('refuses a directory named pack.toml', () => {
  withScratchDir((root) => {
    const vaultPath = path.join(root, 'vault');
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.mkdirSync(packDir);
    fs.mkdirSync(path.join(packDir, 'pack.toml'));
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), '{}\n');
    const before = listPackDir(packDir);

    assert.throws(
      () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: 'a'.repeat(64) }),
      (err) =>
        err instanceof ConfigError &&
        err.message === `refusing to replace ${path.join(packDir, 'pack.toml')}: it is not a regular file`,
    );
    assert.deepEqual(listPackDir(packDir), before);
  });
});

test('a missing target throws PackChangedError, not a generic I/O error (positive control: the "success" test above shows the same vault shape succeeding when the file is present with a matching hash)', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    fs.unlinkSync(path.join(packDir, 'pack.toml'));

    assert.throws(
      () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: 'a'.repeat(64) }),
      (err) => err instanceof PackChangedError && err.message === 'pack.toml changed outside the panel. Reload before saving.',
    );
  });
});

// --- Refusals: containment escapes (steps 3 and 5) ----------------------

test('refuses a symlinked pack dir pointing outside the vault', () => {
  withScratchDir((root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    const outsideDir = path.join(root, 'outside-pack');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'pack.toml'), 'theme = "evil"\n');
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.symlinkSync(outsideDir, packDir);
    const realPackDir = fs.realpathSync(packDir);

    assert.throws(
      () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: 'a'.repeat(64) }),
      (err) =>
        err instanceof ConfigError &&
        err.message === `refusing to write the campaign pack: ${packDir} resolves outside the vault (${realPackDir})`,
    );
    assert.equal(fs.readFileSync(path.join(outsideDir, 'pack.toml'), 'utf8'), 'theme = "evil"\n');
  });
});

test('refuses a symlinked _meta pointing outside the vault', () => {
  withScratchDir((root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(vaultPath, { recursive: true });
    const outsideMeta = path.join(root, 'outside-meta');
    const outsidePack = path.join(outsideMeta, 'scriptorium');
    fs.mkdirSync(outsidePack, { recursive: true });
    fs.writeFileSync(path.join(outsidePack, 'pack.toml'), 'theme = "evil"\n');
    const metaPath = path.join(vaultPath, '_meta');
    fs.symlinkSync(outsideMeta, metaPath);
    const realMeta = fs.realpathSync(metaPath);

    assert.throws(
      () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: 'a'.repeat(64) }),
      (err) =>
        err instanceof ConfigError &&
        err.message === `refusing to write the campaign pack: ${metaPath} resolves outside the vault (${realMeta})`,
    );
    assert.equal(fs.readFileSync(path.join(outsidePack, 'pack.toml'), 'utf8'), 'theme = "evil"\n');
  });
});

// Reviewer re-check on fe76efb: the original version of the test below (from 8247718) never
// actually routed a write through the sibling at all -- it only checked that a normal,
// successful replace of the REAL pack.toml leaves the sibling untouched, which is true no matter
// what isInsideOrEqual does, because `target` is always literally `path.join(packDir, name)` and
// the sibling is never a candidate path in the first place. Rewritten to actually try to fool
// step 5 into believing the target lives in the sibling, via the same realpath-interception
// pattern as the ancestor/descendant tests below. This also needed packreplace.js to call
// isInsideOrEqual through the packwrite module object rather than a destructured import, so the
// separator-boundary mutation below can be applied to it without editing packwrite.js.
test('refuses when the target resolves into a string-prefix sibling directory (<pack>-evil/), via realpath interception (replaces the vacuous 8247718 version)', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const evilDir = `${packDir}-evil`;
    fs.mkdirSync(evilDir);
    const before = listPackDir(packDir);
    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (p) => (p === tomlPath ? path.join(evilDir, 'pack.toml') : originalRealpath(p));

    try {
      assert.throws(
        () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: shaOf(tomlPath) }),
        (err) =>
          err instanceof ConfigError &&
          err.message === `refusing to replace ${tomlPath}: it resolves outside the campaign pack (${evilDir})`,
      );
    } finally {
      fs.realpathSync = originalRealpath;
    }
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
    assert.deepEqual(listPackDir(packDir), before);
  });
});

// --- Step 5's exact-directory match (Reviewer re-check on fe76efb, item 1; tightened per the
// coordinator's call) -----------------------------------------------------------------------
//
// packreplace.js originally used isInsideOrEqual's direction-sensitive, nesting-permissive
// compare at step 5, which accepted a target whose own real directory was a DESCENDANT of the
// pack dir (a subfolder). The Reviewer showed that accept branch is unreachable through any real
// call: REPLACEABLE_FILES names are always slash-free and `target` is always literally
// `path.join(packDir, name)`, so the target's own resolution can only ever coincide exactly with
// the pack dir's, never land one level deeper. Accepting a descendant only widened the TOCTOU
// residual for a case that can never legitimately arise, so step 5 now requires the target's own
// real directory to EQUAL the real pack dir exactly, folded the same way isInsideOrEqual folds
// (platformFoldsCase(), reused directly rather than a new fold strategy).
//
// The tests below pin three things: an ANCESTOR of the pack dir (the vault root, or _meta) must
// still be refused, a DESCENDANT (a subfolder) must NOW be refused too (this test used to be a
// positive control accepting it, before the tightening), and the trivial positive control (the
// realpath equals the pack dir exactly) must still succeed. `if (false)` must still be caught by
// the ancestor and sibling tests; dropping the fold must be caught by the win32-fold test;
// reverting to isInsideOrEqual must be caught by the descendant test going from refuse back to
// (wrongly) accept.

test("refuses when the target's own real directory reports the VAULT ROOT (an ancestor of the pack dir)", () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = listPackDir(packDir);
    const realVaultPath = fs.realpathSync(vaultPath);
    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (p) => (p === tomlPath ? path.join(realVaultPath, 'pack.toml') : originalRealpath(p));

    try {
      assert.throws(
        () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: shaOf(tomlPath) }),
        (err) =>
          err instanceof ConfigError &&
          err.message === `refusing to replace ${tomlPath}: it resolves outside the campaign pack (${realVaultPath})`,
      );
    } finally {
      fs.realpathSync = originalRealpath;
    }
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
    assert.deepEqual(listPackDir(packDir), before);
  });
});

test("refuses when the target's own real directory reports _meta (also an ancestor of the pack dir, one level closer)", () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = listPackDir(packDir);
    const realMeta = fs.realpathSync(path.join(vaultPath, '_meta'));
    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (p) => (p === tomlPath ? path.join(realMeta, 'pack.toml') : originalRealpath(p));

    try {
      assert.throws(
        () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: shaOf(tomlPath) }),
        (err) =>
          err instanceof ConfigError &&
          err.message === `refusing to replace ${tomlPath}: it resolves outside the campaign pack (${realMeta})`,
      );
    } finally {
      fs.realpathSync = originalRealpath;
    }
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
    assert.deepEqual(listPackDir(packDir), before);
  });
});

test("refuses when the target's own real directory reports a DESCENDANT of the pack dir (a subfolder) -- exact-directory match, not nesting", () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const subDir = path.join(packDir, 'images');
    fs.mkdirSync(subDir);
    const before = listPackDir(packDir);
    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (p) => (p === tomlPath ? path.join(subDir, 'pack.toml') : originalRealpath(p));

    try {
      assert.throws(
        () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: shaOf(tomlPath) }),
        (err) =>
          err instanceof ConfigError &&
          err.message === `refusing to replace ${tomlPath}: it resolves outside the campaign pack (${subDir})`,
      );
    } finally {
      fs.realpathSync = originalRealpath;
    }
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
    assert.deepEqual(listPackDir(packDir), before);
  });
});

test("positive control: the target's own real directory reporting EXACTLY the pack dir succeeds", () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const originalRealpath = fs.realpathSync;
    // Same interception shape as the ancestor/descendant refusals, differing only in reporting
    // the true pack dir back, unchanged.
    fs.realpathSync = (p) => (p === tomlPath ? path.join(packDir, 'pack.toml') : originalRealpath(p));

    try {
      const result = replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: shaOf(tomlPath) });
      assert.equal(result.path, tomlPath);
    } finally {
      fs.realpathSync = originalRealpath;
    }
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');
  });
});

// --- Step 5's own re-derivation (Reviewer finding on 8247718): step 3's checks alone are not
// enough to prove step 5 is doing anything. The win32-fold test above only ever exercises the
// ACCEPT path (both call sites folded to the same directory); nothing forced step 5's own
// isInsideOrEqual(realPackDir, realTargetDir) compare to ever see two genuinely DIFFERENT
// directories. Reproduced first: mutating the condition to `if (false)` left all 62 tests in
// this file plus test/admin-pack.test.js green (recorded below).

test("refuses when the target's own real directory genuinely diverges from the pack dir (step 5, independent of step 3)", () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = listPackDir(packDir);
    // A real, unrelated directory elsewhere in the scratch tree. Step 3 never sees it (packDir
    // and _meta resolve normally); only step 5's own realpathOrThrow(target) call is
    // intercepted, keyed on the exact target path, to report pack.toml as if it actually lived
    // there instead -- a genuinely different directory, not merely a different case.
    const bogusDir = path.join(root, 'bogus-elsewhere');
    fs.mkdirSync(bogusDir);
    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (p) => (p === tomlPath ? path.join(bogusDir, 'pack.toml') : originalRealpath(p));

    try {
      assert.throws(
        () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: shaOf(tomlPath) }),
        (err) =>
          err instanceof ConfigError &&
          err.message === `refusing to replace ${tomlPath}: it resolves outside the campaign pack (${bogusDir})`,
      );
    } finally {
      fs.realpathSync = originalRealpath;
    }
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
    assert.deepEqual(listPackDir(packDir), before);
  });
});

test("positive control: the same intercepted realpathSync call site, reporting the TRUE pack dir, succeeds (differs from the refusal above only in what realpathSync(target) returns)", () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const originalRealpath = fs.realpathSync;
    // Same interception shape as the refusal test, but this time the intercepted value is
    // exactly what the real filesystem would already report.
    fs.realpathSync = (p) => (p === tomlPath ? path.join(packDir, 'pack.toml') : originalRealpath(p));

    try {
      const result = replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: shaOf(tomlPath) });
      assert.equal(result.path, tomlPath);
    } finally {
      fs.realpathSync = originalRealpath;
    }
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');
  });
});

// --- Hard link -----------------------------------------------------------

test('a hard link to the target keeps the old bytes after a successful replace', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const linkPath = path.join(root, 'linked.toml');
    fs.linkSync(tomlPath, linkPath);
    const before = fs.readFileSync(linkPath, 'utf8');
    assert.equal(before, 'theme = "plain"\n');

    replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: shaOf(tomlPath) });

    assert.equal(fs.readFileSync(linkPath, 'utf8'), before, "the other hard link's bytes must be unchanged");
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');
  });
});

// --- Concurrency (step 6) -------------------------------------------------

test('a stale expectedSha256 throws PackChangedError and leaves the bytes unchanged', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');

    assert.throws(
      () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: 'f'.repeat(64) }),
      (err) => err instanceof PackChangedError && err.message === 'pack.toml changed outside the panel. Reload before saving.',
    );
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
  });
});

// --- Retry: success, exhaustion, no-retry, external edit, cleanup --------

test('RETRYABLE_CODES is exactly EPERM, EBUSY, EACCES', () => {
  assert.deepEqual([...RETRYABLE_CODES].sort(), ['EACCES', 'EBUSY', 'EPERM']);
});

function withPatchedRename(fn) {
  const original = fs.renameSync;
  try {
    return fn(original);
  } finally {
    fs.renameSync = original;
  }
}

test('retry, success: EBUSY twice then a real rename; the injected sleep records [100, 200] and the file is written', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const sleeps = [];
    let calls = 0;

    withPatchedRename((original) => {
      fs.renameSync = (from, to) => {
        calls += 1;
        if (calls <= 2) {
          const err = new Error('busy');
          err.code = 'EBUSY';
          throw err;
        }
        return original(from, to);
      };
      const result = replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', {
        expectedSha256: shaOf(tomlPath),
        sleep: (ms) => sleeps.push(ms),
      });
      assert.equal(result.path, tomlPath);
    });

    assert.deepEqual(sleeps, [100, 200]);
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');
  });
});

test('retry, exhausted: EBUSY every time gives 6 attempts, sleeps [100,200,400,800,1600], the exact error, unchanged bytes, no temp left', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = listPackDir(packDir);
    const sleeps = [];
    let calls = 0;

    withPatchedRename(() => {
      fs.renameSync = () => {
        calls += 1;
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      };
      assert.throws(
        () =>
          replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', {
            expectedSha256: shaOf(tomlPath),
            sleep: (ms) => sleeps.push(ms),
          }),
        (err) =>
          err instanceof ScriptoriumError &&
          err.message === `could not replace ${tomlPath}: EBUSY. Another program may have it open. The file was left unchanged.`,
      );
    });

    assert.equal(calls, 6);
    assert.deepEqual(sleeps, [100, 200, 400, 800, 1600]);
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
    assert.deepEqual(listPackDir(packDir), before);
  });
});

for (const code of ['ENOENT', 'EISDIR']) {
  test(`no retry on a permanent code (${code}): 1 attempt, empty sleep log`, () => {
    withScratchDir((root) => {
      const { vaultPath, packDir } = makeVault(root);
      const tomlPath = path.join(packDir, 'pack.toml');
      const sleeps = [];
      let calls = 0;

      withPatchedRename(() => {
        fs.renameSync = () => {
          calls += 1;
          const err = new Error(code);
          err.code = code;
          throw err;
        };
        assert.throws(
          () =>
            replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', {
              expectedSha256: shaOf(tomlPath),
              sleep: (ms) => sleeps.push(ms),
            }),
          ScriptoriumError,
        );
      });

      assert.equal(calls, 1);
      assert.deepEqual(sleeps, []);
      assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
    });
  });
}

test('an external edit during the retry window is caught by the per-attempt re-hash: PackChangedError, the file keeps the external edit, no temp left, and renameSync is never called a second time', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = listPackDir(packDir);
    let calls = 0;

    withPatchedRename(() => {
      fs.renameSync = () => {
        calls += 1;
        // Only ever reached on the first attempt: the second attempt's own re-hash (run before
        // renameSync would be called again) must catch the external edit and throw first.
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      };

      assert.throws(
        () =>
          replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', {
            expectedSha256: shaOf(tomlPath),
            sleep: () => {
              fs.writeFileSync(tomlPath, 'theme = "externally-edited"\n');
            },
          }),
        (err) => err instanceof PackChangedError && err.message === 'pack.toml changed outside the panel. Reload before saving.',
      );
    });

    assert.equal(calls, 1, 'renameSync must not be attempted again once the re-hash has already caught the change');
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "externally-edited"\n');
    assert.deepEqual(listPackDir(packDir), before);
  });
});

test('temp cleanup that fails: a patched unlinkSync that throws still produces the original rename-exhaustion error', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const originalUnlink = fs.unlinkSync;
    let unlinkCalled = false;
    fs.unlinkSync = (p) => {
      unlinkCalled = true;
      const err = new Error('EBUSY: cannot unlink');
      err.code = 'EBUSY';
      throw err;
    };

    try {
      withPatchedRename(() => {
        fs.renameSync = () => {
          const err = new Error('busy');
          err.code = 'EBUSY';
          throw err;
        };
        assert.throws(
          () =>
            replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', {
              expectedSha256: shaOf(tomlPath),
              sleep: () => {},
            }),
          (err) =>
            err instanceof ScriptoriumError &&
            err.message === `could not replace ${tomlPath}: EBUSY. Another program may have it open. The file was left unchanged.`,
        );
      });
    } finally {
      fs.unlinkSync = originalUnlink;
    }

    assert.equal(unlinkCalled, true, 'the temp-cleanup unlink must have been attempted');
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
  });
});

// --- admin-fix-1 item 4: two uncovered error branches (NFR09) --------------

function withPatchedReadFileSync(fn) {
  const original = fs.readFileSync;
  try {
    return fn(original);
  } finally {
    fs.readFileSync = original;
  }
}

test('precondition-read TOCTOU catch (step 6): a non-ENOENT read failure right after lstat succeeded is a ScriptoriumError, not a refusal, and the file is left unchanged', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const expectedSha256 = shaOf(tomlPath);

    withPatchedReadFileSync((original) => {
      fs.readFileSync = (p, ...rest) => {
        if (p === tomlPath) {
          const err = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return original(p, ...rest);
      };
      assert.throws(
        () => replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256 }),
        (err) => err instanceof ScriptoriumError && err.message === `could not read ${tomlPath}: EACCES. The file was left unchanged.`,
      );
    });

    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n', 'the file must be untouched');
    assert.deepEqual(
      fs.readdirSync(packDir).filter((n) => n.includes('.scriptorium-tmp-')),
      [],
      'no temp file: the failure is before step 7 ever opens one',
    );
  });
});

test('retry-loop re-hash (step 8): a retryable error (EBUSY) on the per-attempt re-hash sleeps once, then succeeds on retry', () => {
  withScratchDir((root) => {
    const { vaultPath, packDir } = makeVault(root);
    const tomlPath = path.join(packDir, 'pack.toml');
    const expectedSha256 = shaOf(tomlPath);
    const sleeps = [];
    let readCalls = 0;

    withPatchedReadFileSync((original) => {
      fs.readFileSync = (p, ...rest) => {
        if (p === tomlPath) {
          readCalls += 1;
          // Call 1 is step 6's own precondition read (must succeed normally). Call 2 is the
          // retry loop's FIRST re-hash, attempt 0 (throw EBUSY: retryable). Call 3 is the loop's
          // SECOND re-hash, attempt 1 (must succeed normally, then renameSync itself succeeds
          // unpatched).
          if (readCalls === 2) {
            const err = new Error('EBUSY: resource busy or locked');
            err.code = 'EBUSY';
            throw err;
          }
        }
        return original(p, ...rest);
      };

      const result = replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', {
        expectedSha256,
        sleep: (ms) => sleeps.push(ms),
      });
      assert.equal(result.path, tomlPath);
    });

    assert.deepEqual(sleeps, [100], 'exactly one retry delay, for the single injected EBUSY');
    assert.equal(readCalls, 3);
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');
    assert.deepEqual(
      fs.readdirSync(packDir).filter((n) => n.includes('.scriptorium-tmp-')),
      [],
      'no temp file left behind after the eventual success',
    );
  });
});

// --- Structural scan -------------------------------------------------------

test('structural: packreplace.js uses exactly one wx openSync and one each of writeSync/fsyncSync/renameSync/unlinkSync, no forbidden tokens', () => {
  const fullSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'vault', 'packreplace.js'), 'utf8');
  const source = fullSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const forbidden = [
    'writeFileSync',
    'appendFile',
    'copyFile',
    'rmSync',
    'rm(',
    'rmdir',
    'truncate',
    'chmod',
    'createWriteStream',
    'recursive',
    'mkdir',
  ];
  assert.deepEqual(
    forbidden.filter((t) => source.includes(t)),
    [],
  );

  const openCalls = source.match(/openSync\([^)]*\)/g) || [];
  assert.equal(openCalls.length, 1);
  assert.match(openCalls[0], /'wx'/);

  for (const token of ['writeSync(', 'fsyncSync(', 'renameSync(', 'unlinkSync(']) {
    const count = (source.match(new RegExp(token.replace('(', '\\('), 'g')) || []).length;
    assert.equal(count, 1, `expected exactly one ${token}, found ${count}`);
  }
});

// --- Graph walk: init.js must never reach packreplace.js -------------------

function scanRequires(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const specs = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(stripped))) specs.push(m[1]);
  return specs;
}

test('graph walk: src/cli/init.js never reaches src/vault/packreplace.js', () => {
  const root = path.join(__dirname, '..');
  const target = path.join(root, 'src', 'vault', 'packreplace.js');
  const seen = new Set();
  const queue = [path.join(root, 'src', 'cli', 'init.js')];

  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.notEqual(file, target, `init.js's module graph reached ${target}`);

    let resolved;
    try {
      resolved = Module.createRequire(file);
    } catch {
      continue;
    }
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const spec of scanRequires(source)) {
      if (!spec.startsWith('.')) continue; // only follow relative specifiers into our own src
      let full;
      try {
        full = resolved.resolve(spec);
      } catch {
        continue;
      }
      if (!full.startsWith(path.join(root, 'src'))) continue;
      queue.push(full);
    }
  }
});

// --- Case folding under forced win32 ---------------------------------------

test('case folding under forced win32: a pack dir whose real path differs only in case from the target is accepted', () => {
  withPlatform('win32', () => {
    withScratchDir((root) => {
      const { vaultPath, packDir } = makeVault(root);
      const tomlPath = path.join(packDir, 'pack.toml');
      const target = tomlPath;
      const originalRealpath = fs.realpathSync;
      fs.realpathSync = (p) => {
        const real = originalRealpath(p);
        // Step 3's realpathOrThrow(packDir) call resolves the pack dir itself normally (lower
        // case, as created); step 5's realpathOrThrow(target) resolves the SAME directory via a
        // different call site (following the target path) to an UPPER-CASE report of that same
        // directory. The two values genuinely differ as strings and are equal only once folded
        // -- unlike a mock that folds both call sites to the same case, which would pass even
        // with folding removed.
        if (real === target) return path.join(packDir.toUpperCase(), path.basename(real));
        return real;
      };
      try {
        const result = replacePackFile(vaultPath, 'pack.toml', 'theme = "haze"\n', { expectedSha256: shaOf(tomlPath) });
        assert.equal(result.path, tomlPath);
      } finally {
        fs.realpathSync = originalRealpath;
      }
      assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "haze"\n');
    });
  });
});
