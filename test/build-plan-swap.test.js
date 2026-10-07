'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertSafeOutputDir, stagingDirFor, planBuild, siteConfigOutputDirCollision } = require('../src/build/plan');
const { swapIntoPlace, sweepStaleSiblings, findLockedFile, STAGING_MAX_AGE_MS } = require('../src/build/swap');
const { ScriptoriumError } = require('../src/util/errors');

/*
 * process.platform is `configurable: true` but not `writable: true` (see
 * Object.getOwnPropertyDescriptor(process, 'platform') on any Node build),
 * so a plain assignment throws under 'use strict'. Object.defineProperty
 * still works. This lets the case-fold tests below force both the win32
 * and darwin fold-on branches AND the linux fold-off branch deterministically
 * from a single dev machine, rather than being conditionally skipped
 * (and never actually exercised) on whichever platform CI happens to run on.
 */
function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('assertSafeOutputDir refuses a filesystem root', () => {
  const root = path.parse(process.cwd()).root;
  assert.throws(() => assertSafeOutputDir('/vault', root), ScriptoriumError);
});

test('assertSafeOutputDir refuses an output dir that contains the vault', () => {
  assert.throws(() => assertSafeOutputDir('/a/b/vault', '/a/b'), ScriptoriumError);
});

test('assertSafeOutputDir refuses an output dir inside the vault', () => {
  assert.throws(() => assertSafeOutputDir('/a/b/vault', '/a/b/vault/out'), ScriptoriumError);
});

test('assertSafeOutputDir accepts a sibling output dir', () => {
  assert.doesNotThrow(() => assertSafeOutputDir('/a/b/vault', '/a/b/out'));
});

test('stagingDirFor is a sibling of finalOut, never os.tmpdir()', () => {
  const finalOut = '/a/b/out';
  const { stagingRoot } = stagingDirFor(finalOut);
  assert.equal(path.dirname(stagingRoot), path.dirname(finalOut));
  assert.ok(!stagingRoot.startsWith(os.tmpdir()));
  assert.match(path.basename(stagingRoot), /^\.scriptorium-build-/);
});

test('planBuild refuses an unsafe output dir before touching disk', () => {
  assert.throws(() => planBuild('/a/b/vault', '/a/b/vault/out'), ScriptoriumError);
});

// Issue #21, defect 1: siteConfigOutputDirCollision is the pure predicate
// src/cli/build.js uses to decide whether to refuse. It must fire ONLY when
// finalOut truly resolves to the same directory the site config's own
// outputDir names, and must not cry wolf on a legitimate, deliberately
// different output.

test('siteConfigOutputDirCollision fires when finalOut resolves to the site config\'s own outputDir', () => {
  const result = siteConfigOutputDirCollision('/a/b/out', '/a/b/site', '../out');
  assert.equal(result, path.resolve('/a/b/out'));
});

test('siteConfigOutputDirCollision does not fire on a legitimate, different output dir', () => {
  assert.equal(siteConfigOutputDirCollision('/a/b/scratch-out', '/a/b/site', '../out'), null);
});

test('siteConfigOutputDirCollision does not fire when the site config has no outputDir at all', () => {
  assert.equal(siteConfigOutputDirCollision('/a/b/out', '/a/b/site', undefined), null);
  assert.equal(siteConfigOutputDirCollision('/a/b/out', '/a/b/site', ''), null);
});

test('siteConfigOutputDirCollision resolves the site outputDir relative to the site config\'s own directory, not cwd', () => {
  const result = siteConfigOutputDirCollision(path.join('/x/y', 'published'), '/x/y/site', '../published');
  assert.equal(result, path.resolve('/x/y', 'published'));
});

// Reviewer-found fail-open gap (post-issue-#21 follow-up): path.resolve()
// equality alone misses two real ways two DIFFERENT-LOOKING path strings are
// the SAME physical directory. Both matter specifically because the frozen
// acceptance baseline this guard exists to protect lives on a Windows share,
// and Windows (and default macOS) filesystems are case-insensitive.

test('siteConfigOutputDirCollision fires on a pure case difference, on a fold-on (win32) platform', () => {
  withPlatform('win32', () => {
    // The site config's own `out` is lowercase; finalOut is `OUT`. On a
    // fold-on platform these are the same physical directory, so this
    // must fire — returning the resolved SITE-config outputDir (the
    // documented contract), not finalOut's own casing.
    const result = siteConfigOutputDirCollision('/srv/x/site/OUT', '/srv/x/site', 'out');
    assert.equal(result, path.resolve('/srv/x/site', 'out'));
  });
});

test('siteConfigOutputDirCollision fires on a pure case difference, on a fold-on (darwin) platform', () => {
  withPlatform('darwin', () => {
    const result = siteConfigOutputDirCollision('/srv/x/site/OUT', '/srv/x/site', 'out');
    assert.equal(result, path.resolve('/srv/x/site', 'out'));
  });
});

// Documents the residual gap rather than hiding it: on a fold-off (linux)
// platform, a pure case difference between two paths that do not exist on
// disk is NOT detected as a collision (the fold is a platform proxy, not a
// filesystem fact — see the comment above sameDirectory in
// src/build/plan.js). This assertion is the honest, deliberate current
// behaviour, not a wish; if it starts failing, the fold policy changed.
test('siteConfigOutputDirCollision does NOT fire on a pure case difference on a fold-off (linux) platform (documented residual gap)', () => {
  withPlatform('linux', () => {
    const result = siteConfigOutputDirCollision('/srv/x/site/OUT', '/srv/x/site', 'out');
    assert.equal(result, null);
  });
});

test('siteConfigOutputDirCollision fires when the site outputDir is a real symlink to the same physical directory as finalOut', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-collision-symlink-'));
  try {
    const realOut = path.join(dir, 'real-out');
    fs.mkdirSync(realOut);
    const siteConfigDir = path.join(dir, 'site');
    fs.mkdirSync(siteConfigDir);
    const symlinkOut = path.join(siteConfigDir, 'published-alias');
    fs.symlinkSync(realOut, symlinkOut, 'dir');

    // fs.realpathSync(symlinkOut) collapses to realOut, the identical physical
    // directory finalOut itself resolves to — confirmed independently here,
    // the same way the Reviewer confirmed it before reporting the miss.
    assert.equal(fs.realpathSync(symlinkOut), fs.realpathSync(realOut));

    // Returns the resolved SITE-config outputDir (the symlink path itself,
    // the documented contract), not finalOut's own path.
    const result = siteConfigOutputDirCollision(realOut, siteConfigDir, 'published-alias');
    assert.equal(result, symlinkOut);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('siteConfigOutputDirCollision still does not fire on two genuinely different real directories (no false positive)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-collision-distinct-'));
  try {
    const finalOut = path.join(dir, 'out-a');
    fs.mkdirSync(finalOut);
    const siteConfigDir = path.join(dir, 'site');
    fs.mkdirSync(siteConfigDir);
    fs.mkdirSync(path.join(dir, 'out-b'));

    assert.equal(siteConfigOutputDirCollision(finalOut, siteConfigDir, '../out-b'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- assertSafeOutputDir: the identical gap in the already-shipped vault-containment guard ---

test('assertSafeOutputDir refuses when finalOut is a real symlink to the vault itself', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vaultguard-symlink-'));
  try {
    const vaultPath = path.join(dir, 'vault');
    fs.mkdirSync(vaultPath);
    const finalOut = path.join(dir, 'out-alias');
    fs.symlinkSync(vaultPath, finalOut, 'dir');

    assert.throws(() => assertSafeOutputDir(vaultPath, finalOut), ScriptoriumError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertSafeOutputDir refuses on a pure case difference between finalOut and the vault, on a fold-on (win32) platform', () => {
  withPlatform('win32', () => {
    assert.throws(() => assertSafeOutputDir('/a/b/VAULT', '/a/b/vault'), ScriptoriumError);
  });
});

test('assertSafeOutputDir still accepts two genuinely different real directories (no false positive)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vaultguard-distinct-'));
  try {
    const vaultPath = path.join(dir, 'vault');
    fs.mkdirSync(vaultPath);
    const finalOut = path.join(dir, 'out');
    fs.mkdirSync(finalOut);

    assert.doesNotThrow(() => assertSafeOutputDir(vaultPath, finalOut));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Issue #23: assertSafeOutputDir's CONTAINMENT (prefix) checks, the
// second half of the fail-open gap 5d8dfb5 only closed for equality. ---

test('assertSafeOutputDir refuses when finalOut is a real symlink INTO the vault (containment, not equality)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-contain-symlink-'));
  try {
    const vaultPath = path.join(dir, 'vault');
    fs.mkdirSync(vaultPath);
    fs.mkdirSync(path.join(vaultPath, 'secret'));
    const finalOut = path.join(dir, 'out-alias');
    fs.symlinkSync(path.join(vaultPath, 'secret'), finalOut, 'dir');

    // Confirmed independently, not derived from assertSafeOutputDir itself.
    assert.equal(fs.realpathSync(finalOut), fs.realpathSync(path.join(vaultPath, 'secret')));
    assert.notEqual(fs.realpathSync(finalOut), fs.realpathSync(vaultPath));

    assert.throws(() => assertSafeOutputDir(vaultPath, finalOut), { name: 'VaultUnreachableError', message: /inside the vault/ });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertSafeOutputDir refuses when the VAULT is a real symlink into finalOut (the other containment direction)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-contain-symlink-rev-'));
  try {
    const finalOut = path.join(dir, 'out');
    fs.mkdirSync(finalOut);
    fs.mkdirSync(path.join(finalOut, 'buried-vault'));
    const vaultPath = path.join(dir, 'vault-alias');
    fs.symlinkSync(path.join(finalOut, 'buried-vault'), vaultPath, 'dir');

    assert.equal(fs.realpathSync(vaultPath), fs.realpathSync(path.join(finalOut, 'buried-vault')));

    assert.throws(() => assertSafeOutputDir(vaultPath, finalOut), { name: 'VaultUnreachableError', message: /contains the vault/ });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertSafeOutputDir refuses when an ANCESTOR of finalOut (not finalOut itself) is a symlink into the vault, and finalOut does not exist yet', () => {
  // "The common case, and the whole point" (#23): finalOut is routinely
  // never-yet-built, so only an ancestor can be resolved on disk. Proves
  // the longest-existing-ancestor walk-and-rejoin, not just a direct
  // fs.realpathSync(finalOut) success.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-contain-ancestor-symlink-'));
  try {
    const vaultPath = path.join(dir, 'vault');
    fs.mkdirSync(vaultPath);
    fs.mkdirSync(path.join(vaultPath, 'secret'));
    const ancestorAlias = path.join(dir, 'ancestor-alias');
    fs.symlinkSync(path.join(vaultPath, 'secret'), ancestorAlias, 'dir');
    const finalOut = path.join(ancestorAlias, 'site'); // does not exist on disk

    assert.equal(fs.existsSync(finalOut), false, 'finalOut itself must not exist for this to test the walk');

    assert.throws(() => assertSafeOutputDir(vaultPath, finalOut), { name: 'VaultUnreachableError', message: /inside the vault/ });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertSafeOutputDir refuses containment on a case difference in an ANCESTOR segment, on a fold-on (win32) platform', () => {
  // Issue #23's own repro shape: vault "<x>/Vault", out "<x>/vault/site" —
  // the case difference is in the PARENT segment, not a direct match at
  // the leaf, so the plain (already-fixed) equality check cannot see it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-contain-case-'));
  try {
    const vaultPath = path.join(dir, 'Vault');
    fs.mkdirSync(vaultPath);
    const finalOut = path.join(dir, 'vault', 'site'); // lowercase "vault", does not exist

    withPlatform('win32', () => {
      assert.throws(() => assertSafeOutputDir(vaultPath, finalOut), { name: 'VaultUnreachableError', message: /inside the vault/ });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertSafeOutputDir does NOT refuse the same case-different ancestor on a fold-off (linux) platform (documented residual gap)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-contain-case-linux-'));
  try {
    const vaultPath = path.join(dir, 'Vault');
    fs.mkdirSync(vaultPath);
    const finalOut = path.join(dir, 'vault', 'site');

    withPlatform('linux', () => {
      assert.doesNotThrow(() => assertSafeOutputDir(vaultPath, finalOut));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertSafeOutputDir containment still accepts two genuinely different real directories reached through an unrelated ancestor symlink (no false positive)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-contain-distinct-symlink-'));
  try {
    const vaultPath = path.join(dir, 'vault');
    fs.mkdirSync(vaultPath);
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const ancestorAlias = path.join(dir, 'alias-to-elsewhere');
    fs.symlinkSync(elsewhere, ancestorAlias, 'dir');
    const finalOut = path.join(ancestorAlias, 'site'); // does not exist; real target is unrelated to the vault

    assert.doesNotThrow(() => assertSafeOutputDir(vaultPath, finalOut));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertSafeOutputDir does not crash when an ancestor of finalOut is a DANGLING symlink, and still accepts an unrelated finalOut (documented residual: the dangling target is never resolved)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-contain-dangling-'));
  try {
    const vaultPath = path.join(dir, 'vault');
    fs.mkdirSync(vaultPath);
    const danglingAlias = path.join(dir, 'dangling-alias');
    fs.symlinkSync(path.join(dir, 'does-not-exist-at-all'), danglingAlias, 'dir');
    const finalOut = path.join(danglingAlias, 'site');

    assert.doesNotThrow(() => assertSafeOutputDir(vaultPath, finalOut));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('swapIntoPlace: first build (no existing finalOut) just moves staging into place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-swap-'));
  try {
    const finalOut = path.join(dir, 'out');
    const stagingOut = path.join(dir, 'staging-out');
    fs.mkdirSync(stagingOut);
    fs.writeFileSync(path.join(stagingOut, 'index.html'), 'v1');

    const result = swapIntoPlace(finalOut, stagingOut);
    assert.equal(result.swapped, true);
    assert.equal(fs.readFileSync(path.join(finalOut, 'index.html'), 'utf8'), 'v1');
    assert.equal(fs.existsSync(stagingOut), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('swapIntoPlace: rebuild over an existing finalOut replaces it and cleans up the old dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-swap-'));
  try {
    const finalOut = path.join(dir, 'out');
    fs.mkdirSync(finalOut);
    fs.writeFileSync(path.join(finalOut, 'index.html'), 'v1');

    const stagingOut = path.join(dir, 'staging-out');
    fs.mkdirSync(stagingOut);
    fs.writeFileSync(path.join(stagingOut, 'index.html'), 'v2');

    const result = swapIntoPlace(finalOut, stagingOut);
    assert.equal(result.staleOldDir, null);
    assert.equal(fs.readFileSync(path.join(finalOut, 'index.html'), 'utf8'), 'v2');

    const siblings = fs.readdirSync(dir);
    assert.deepEqual(
      siblings.filter((s) => s.includes('scriptorium-old')),
      [],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepStaleSiblings removes leftover .scriptorium-old-*/.scriptorium-build-* directories, ignoring failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-sweep-'));
  try {
    const finalOut = path.join(dir, 'out');
    fs.mkdirSync(finalOut);
    fs.mkdirSync(path.join(dir, '.scriptorium-old-123'));
    fs.mkdirSync(path.join(dir, '.scriptorium-build-456'));
    fs.mkdirSync(path.join(dir, 'unrelated'));

    sweepStaleSiblings(finalOut);

    const remaining = fs.readdirSync(dir).sort();
    assert.deepEqual(remaining, ['out', 'unrelated']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepStaleSiblings leaves a staging dir owned by another live process (issue #102) but sweeps dead and own-pid ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-sweep-live-'));
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  try {
    const dead = spawnDeadPid();
    const finalOut = path.join(dir, 'out');
    fs.mkdirSync(finalOut);
    const stampNow = Date.now();
    fs.mkdirSync(path.join(dir, `.scriptorium-build-${child.pid}-${stampNow}-abcd`));
    fs.mkdirSync(path.join(dir, `.scriptorium-build-${dead}-${stampNow}-abcd`));
    fs.mkdirSync(path.join(dir, `.scriptorium-build-${process.pid}-${stampNow}-abcd`));

    sweepStaleSiblings(finalOut);

    assert.deepEqual(fs.readdirSync(dir).sort(), [`.scriptorium-build-${child.pid}-${stampNow}-abcd`, 'out']);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withLiveChild(fn) {
  const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-sweep-age-'));
  try {
    fs.mkdirSync(path.join(dir, 'out'));
    fn(dir, child.pid);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('sweepStaleSiblings sweeps a staging dir older than the age ceiling even when its pid is alive (pid reuse, issue #102)', () => {
  withLiveChild((dir, pid) => {
    const fresh = `.scriptorium-build-${pid}-${Date.now()}-aaaa`;
    const old = `.scriptorium-build-${pid}-${Date.now() - STAGING_MAX_AGE_MS - 60000}-bbbb`;
    fs.mkdirSync(path.join(dir, fresh));
    fs.mkdirSync(path.join(dir, old));
    sweepStaleSiblings(path.join(dir, 'out'));
    assert.deepEqual(fs.readdirSync(dir).sort(), [fresh, 'out']);
  });
});

test('sweepStaleSiblings treats pid 0, negative-looking, unsafe-integer and garbled pids as stale (kill(0,0) signals the process group)', () => {
  withLiveChild((dir) => {
    const now = Date.now();
    const names = [
      `.scriptorium-build-0-${now}-aaaa`,
      '.scriptorium-build-99999999999999999999999-' + now + '-aaaa',
      '.scriptorium-build-abc-' + now + '-aaaa',
      '.scriptorium-build-' + process.pid + 'x-' + now + '-aaaa',
      '.scriptorium-build-',
      '.scriptorium-build-4242',
    ];
    for (const n of names) fs.mkdirSync(path.join(dir, n));
    sweepStaleSiblings(path.join(dir, 'out'));
    assert.deepEqual(fs.readdirSync(dir), ['out']);
  });
});

test('stagingDirFor names are unique per call even within one millisecond and one pid', () => {
  const names = new Set();
  for (let i = 0; i < 200; i++) names.add(stagingDirFor('/a/b/out').stagingRoot);
  assert.equal(names.size, 200);
});

function spawnDeadPid() {
  const r = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

// --- findLockedFile: naming the specific locked file, not just "the rename failed" ---

test('findLockedFile returns null when every file in the tree can be opened r+', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-lockprobe-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'index.html'), 'a');
    fs.writeFileSync(path.join(dir, 'sub', 'page.html'), 'b');

    assert.equal(findLockedFile(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLockedFile names the specific file that cannot be opened for read+write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-lockprobe-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'index.html'), 'a');
    fs.writeFileSync(path.join(dir, 'sub', 'locked.html'), 'b');

    const originalOpenSync = fs.openSync;
    fs.openSync = (p, flags) => {
      if (String(p).endsWith(path.join('sub', 'locked.html')) && flags === 'r+') {
        const err = new Error(`EBUSY: resource busy or locked, open '${p}'`);
        err.code = 'EBUSY';
        throw err;
      }
      return originalOpenSync(p, flags);
    };
    try {
      assert.equal(findLockedFile(dir), 'sub/locked.html');
    } finally {
      fs.openSync = originalOpenSync;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findLockedFile never throws, even against a directory it cannot read', () => {
  assert.doesNotThrow(() => findLockedFile(path.join(os.tmpdir(), 'scriptorium-lockprobe-does-not-exist')));
  assert.equal(findLockedFile(path.join(os.tmpdir(), 'scriptorium-lockprobe-does-not-exist')), null);
});

// --- swapIntoPlace: the failure message names the specific locked file, not just the rename ---
//
// A real Windows lock cannot be held from Linux, so this simulates it the
// same way findLockedFile's own tests do (fs.openSync throwing for one
// specific file) while also making fs.renameSync fail so swapIntoPlace
// actually reaches its failure-message path. This exercises the real
// renameWithRetry backoff (~3.1s: 100+200+400+800+1600ms) rather than
// mocking it, so it is slower than the rest of the suite by design — kept
// to exactly one such test. Confirms message wording only; the real
// Windows failure text still needs the Windows verifier to confirm on the vault that
// found this.
test(
  'swapIntoPlace names the specific locked file in its failure message, not just "the rename failed"',
  { timeout: 15000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-swap-lock-'));
    try {
      const finalOut = path.join(dir, 'out');
      const stagingOut = path.join(dir, 'staging-out');
      fs.mkdirSync(stagingOut);
      fs.writeFileSync(path.join(stagingOut, 'index.html'), 'v1');

      const originalRenameSync = fs.renameSync;
      const originalOpenSync = fs.openSync;
      fs.renameSync = (from, to) => {
        if (from === stagingOut && to === finalOut) {
          const err = new Error(`EBUSY: resource busy or locked, rename '${from}' -> '${to}'`);
          err.code = 'EBUSY';
          throw err;
        }
        return originalRenameSync(from, to);
      };
      fs.openSync = (p, flags) => {
        if (String(p).endsWith(path.join('staging-out', 'index.html')) && flags === 'r+') {
          const err = new Error(`EBUSY: resource busy or locked, open '${p}'`);
          err.code = 'EBUSY';
          throw err;
        }
        return originalOpenSync(p, flags);
      };

      try {
        assert.throws(
          () => swapIntoPlace(finalOut, stagingOut),
          (err) => {
            assert.ok(err instanceof ScriptoriumError);
            assert.match(err.message, /locked file appears to be: index\.html/);
            return true;
          },
        );
      } finally {
        fs.renameSync = originalRenameSync;
        fs.openSync = originalOpenSync;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
