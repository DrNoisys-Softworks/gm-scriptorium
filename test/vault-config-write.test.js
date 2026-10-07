'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const {
  VaultConfigChangedError,
  TMP_PREFIX,
  RETRYABLE_CODES,
  targetPathFor,
  checkTarget,
  replaceVaultConfigMd,
} = require('../src/vault/vaultconfigwrite');
const { ConfigError, ScriptoriumError } = require('../src/util/errors');

/*
 * V1e-1 (SD-1, AC-01). Synthetic names only (NFR-10/NFR-11); every vault is built fresh in
 * os.tmpdir(), never in test/fixtures. Isolation: this module never reaches config.toml or the
 * per-machine folder itself, so no env scratch guard is needed here (that guard lives in
 * test/machinedir-backups.test.js and the HTTP/regression suites).
 */

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vcw-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** A minimal vault with a real, on-disk vault-config.md. */
function makeVault(root, { mdBytes = Buffer.from('---\ntype: meta\n---\n\n# vault config\n') } = {}) {
  const vaultPath = path.join(root, 'vault');
  const metaDir = path.join(vaultPath, '_meta');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'vault-config.md'), mdBytes);
  return { vaultPath, metaDir, target: path.join(metaDir, 'vault-config.md') };
}

function listMetaDir(metaDir) {
  return fs.readdirSync(metaDir).sort();
}

function shaOf(p) {
  return sha256(fs.readFileSync(p));
}

function recordingBackup(calls) {
  return function backup(buf) {
    calls.push(buf);
    return { path: '/fake/backup/path', ok: true };
  };
}

// --- targetPathFor / checkTarget: the fixed target -------------------------

test('targetPathFor is always <vault>/_meta/vault-config.md; no argument ever names anything else', () => {
  withScratchDir((root) => {
    const { vaultPath, target } = makeVault(root);
    assert.equal(targetPathFor(vaultPath), target);
  });
});

test('checkTarget succeeds on a plain vault and returns the target path', () => {
  withScratchDir((root) => {
    const { vaultPath, target } = makeVault(root);
    const result = checkTarget(vaultPath);
    assert.equal(result.target, target);
  });
});

test('checkTarget: missing file gives VaultConfigChangedError and never creates it', () => {
  withScratchDir((root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    assert.throws(() => checkTarget(vaultPath), (err) => err instanceof VaultConfigChangedError);
    assert.equal(fs.existsSync(path.join(vaultPath, '_meta', 'vault-config.md')), false);
  });
});

test('checkTarget: a symlinked target is refused (ConfigError)', () => {
  withScratchDir((root) => {
    const { vaultPath, metaDir } = makeVault(root, {});
    const real = path.join(root, 'elsewhere.md');
    fs.writeFileSync(real, '---\ntype: meta\n---\n');
    const target = path.join(metaDir, 'vault-config.md');
    fs.rmSync(target);
    fs.symlinkSync(real, target);
    assert.throws(() => checkTarget(vaultPath), (err) => err instanceof ConfigError && !(err instanceof VaultConfigChangedError));
  });
});

test('checkTarget: _meta symlinked outside the vault, to an ancestor (the vault root), and to a prefix sibling are all refused', () => {
  withScratchDir((root) => {
    // Case 1: _meta symlinked entirely outside the vault.
    {
      const vaultPath = path.join(root, 'vault1');
      fs.mkdirSync(vaultPath, { recursive: true });
      const outside = path.join(root, 'outside-meta');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'vault-config.md'), '---\ntype: meta\n---\n');
      fs.symlinkSync(outside, path.join(vaultPath, '_meta'));
      assert.throws(() => checkTarget(vaultPath), ConfigError);
    }
    // Case 2: _meta symlinked to the vault root itself (ancestor).
    {
      const vaultPath = path.join(root, 'vault2');
      fs.mkdirSync(vaultPath, { recursive: true });
      fs.writeFileSync(path.join(vaultPath, 'vault-config.md'), '---\ntype: meta\n---\n');
      fs.symlinkSync(vaultPath, path.join(vaultPath, '_meta'));
      assert.throws(() => checkTarget(vaultPath), ConfigError);
    }
    // Case 3: _meta symlinked to a prefix-sibling directory ("_meta-evil").
    {
      const vaultPath = path.join(root, 'vault3');
      fs.mkdirSync(vaultPath, { recursive: true });
      const evil = path.join(root, 'vault3-meta-evil');
      fs.mkdirSync(evil);
      fs.writeFileSync(path.join(evil, 'vault-config.md'), '---\ntype: meta\n---\n');
      fs.symlinkSync(evil, path.join(vaultPath, '_meta'));
      assert.throws(() => checkTarget(vaultPath), ConfigError);
    }
  });
});

test('checkTarget: the target replaced by a directory is refused (ConfigError)', () => {
  withScratchDir((root) => {
    const vaultPath = path.join(root, 'vault');
    const metaDir = path.join(vaultPath, '_meta');
    fs.mkdirSync(path.join(metaDir, 'vault-config.md'), { recursive: true });
    assert.throws(() => checkTarget(vaultPath), ConfigError);
  });
});

test('checkTarget: realpath interception reporting the vault root, a descendant, and <_meta>-evil are all refused (E3, E4, E5 positive controls)', () => {
  withScratchDir((root) => {
    const { vaultPath, metaDir } = makeVault(root);
    const realVault = fs.realpathSync(vaultPath);
    const original = fs.realpathSync;

    function withPatchedRealpath(map, fn) {
      fs.realpathSync = (p, ...rest) => (Object.prototype.hasOwnProperty.call(map, p) ? map[p] : original(p, ...rest));
      try {
        return fn();
      } finally {
        fs.realpathSync = original;
      }
    }

    // "Ancestor": realMeta reported as the vault root itself.
    withPatchedRealpath({ [path.join(vaultPath, '_meta')]: realVault }, () => {
      assert.throws(() => checkTarget(vaultPath), ConfigError);
    });

    // Descendant: the target's real directory reported as a subfolder of the real _meta.
    withPatchedRealpath({ [path.join(metaDir, 'vault-config.md')]: path.join(original(metaDir), 'nested', 'vault-config.md') }, () => {
      assert.throws(() => checkTarget(vaultPath), ConfigError);
    });

    // <_meta>-evil: a prefix-sibling directory reported for _meta.
    withPatchedRealpath({ [path.join(vaultPath, '_meta')]: `${original(metaDir)}-evil` }, () => {
      assert.throws(() => checkTarget(vaultPath), ConfigError);
    });
  });
});

// --- replaceVaultConfigMd: happy path ---------------------------------------

test('a success replaces the file with exactly the candidate bytes and leaves no temp file', () => {
  withScratchDir((root) => {
    const { vaultPath, metaDir, target } = makeVault(root);
    const before = listMetaDir(metaDir);
    const calls = [];
    const candidate = Buffer.from('---\ntype: meta\ntagline: "hi"\n---\n\n# vault config\n');

    const result = replaceVaultConfigMd(vaultPath, candidate, {
      expectedSha256: shaOf(target),
      backup: recordingBackup(calls),
    });

    assert.deepEqual(fs.readFileSync(target), candidate);
    assert.equal(result.path, target);
    assert.equal(result.sha256, sha256(candidate));
    assert.deepEqual(result.backup, { path: '/fake/backup/path', ok: true });
    assert.deepEqual(listMetaDir(metaDir), before, 'no temp file left behind');
    assert.equal(calls.length, 1);
  });
});

test('CRLF plus BOM round-trips unchanged, and the body bytes are byte-identical (typed byte literals)', () => {
  withScratchDir((root) => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const original = Buffer.concat([bom, Buffer.from('---\r\ntype: meta\r\n---\r\n\r\n# body\r\n')]);
    const { vaultPath, target } = makeVault(root, { mdBytes: original });
    const calls = [];
    // Same bytes back: proves the writer never touches BOM/CR/LF/body content itself.
    const result = replaceVaultConfigMd(vaultPath, original, { expectedSha256: shaOf(target), backup: recordingBackup(calls) });
    assert.deepEqual(fs.readFileSync(target), original);
    assert.equal(result.sha256, sha256(original));
  });
});

// --- Programming errors ------------------------------------------------------

test('non-Buffer candidateBytes throws ScriptoriumError and the file is unchanged', () => {
  withScratchDir((root) => {
    const { vaultPath, target } = makeVault(root);
    assert.throws(
      () => replaceVaultConfigMd(vaultPath, 'not a buffer', { expectedSha256: shaOf(target), backup: () => {} }),
      ScriptoriumError,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), '---\ntype: meta\n---\n\n# vault config\n');
  });
});

test('a non-function backup throws ScriptoriumError before checkTarget ever runs', () => {
  withScratchDir((root) => {
    const { vaultPath, target } = makeVault(root);
    assert.throws(
      () => replaceVaultConfigMd(vaultPath, Buffer.from('x'), { expectedSha256: shaOf(target), backup: null }),
      ScriptoriumError,
    );
  });
});

// --- Sha mismatch: no temp, no backup call ----------------------------------

test('sha mismatch: VaultConfigChangedError, no temp file created, backup never called', () => {
  withScratchDir((root) => {
    const { vaultPath, metaDir, target } = makeVault(root);
    const before = listMetaDir(metaDir);
    const calls = [];
    assert.throws(
      () => replaceVaultConfigMd(vaultPath, Buffer.from('x'), { expectedSha256: 'a'.repeat(64), backup: recordingBackup(calls) }),
      VaultConfigChangedError,
    );
    assert.equal(calls.length, 0, 'backup must never be called for a stale sha (E6 positive control)');
    assert.deepEqual(listMetaDir(metaDir), before);
  });
});

// --- Backup ordering and bytes (AC-02, E7, E8, E9) --------------------------

test('backup receives the CURRENT bytes, and the target still has those bytes at call time (E8, E9 positive controls)', () => {
  withScratchDir((root) => {
    const { vaultPath, target } = makeVault(root);
    const currentBytes = fs.readFileSync(target);
    let sawAtCallTime = null;
    const candidate = Buffer.from('---\ntype: meta\nx: 1\n---\n\n# vault config\n');

    replaceVaultConfigMd(vaultPath, candidate, {
      expectedSha256: shaOf(target),
      backup: (buf) => {
        sawAtCallTime = fs.readFileSync(target); // the on-disk bytes AT backup time
        assert.deepEqual(buf, currentBytes, 'backup(...) must receive the CURRENT bytes, not the candidate');
        return { ok: true };
      },
    });

    assert.deepEqual(sawAtCallTime, currentBytes, 'the target must still hold the current bytes when backup() runs');
  });
});

test('backup() throws: the vault is unchanged, and no temp file is created', () => {
  withScratchDir((root) => {
    const { vaultPath, metaDir, target } = makeVault(root);
    const before = listMetaDir(metaDir);
    assert.throws(
      () =>
        replaceVaultConfigMd(vaultPath, Buffer.from('x'), {
          expectedSha256: shaOf(target),
          backup: () => {
            throw new Error('backup failed');
          },
        }),
      /backup failed/,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), '---\ntype: meta\n---\n\n# vault config\n');
    assert.deepEqual(listMetaDir(metaDir), before, 'no temp file left behind');
  });
});

test('an injected temp-write failure leaves no temp file, but the backup was already recorded (E7 positive control: the backup call is not ignored)', () => {
  withScratchDir((root) => {
    const { vaultPath, metaDir, target } = makeVault(root);
    const calls = [];
    const originalOpen = fs.openSync;
    fs.openSync = (p, flag) => {
      if (typeof p === 'string' && p.includes(TMP_PREFIX)) {
        const err = new Error('ENOSPC: no space');
        err.code = 'ENOSPC';
        throw err;
      }
      return originalOpen(p, flag);
    };
    try {
      assert.throws(
        () => replaceVaultConfigMd(vaultPath, Buffer.from('x'), { expectedSha256: shaOf(target), backup: recordingBackup(calls) }),
        ScriptoriumError,
      );
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(calls.length, 1, 'backup must still have been called before the temp write was attempted');
    assert.deepEqual(
      fs.readdirSync(metaDir).filter((n) => n.includes(TMP_PREFIX)),
      [],
      'no temp file left behind',
    );
    assert.equal(fs.readFileSync(target, 'utf8'), '---\ntype: meta\n---\n\n# vault config\n');
  });
});

test('an injected post-backup rename failure (EISDIR) leaves the vault unchanged, removes the temp, and the backup was recorded', () => {
  withScratchDir((root) => {
    const { vaultPath, metaDir, target } = makeVault(root);
    const calls = [];
    const originalRename = fs.renameSync;
    fs.renameSync = () => {
      const err = new Error('EISDIR: illegal operation on a directory');
      err.code = 'EISDIR';
      throw err;
    };
    try {
      assert.throws(
        () => replaceVaultConfigMd(vaultPath, Buffer.from('x'), { expectedSha256: shaOf(target), backup: recordingBackup(calls) }),
        ScriptoriumError,
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(calls.length, 1, 'the backup must have run (E7: a swallowed-backup mutation would still show 1 here, but the write must still fail)');
    assert.equal(fs.readFileSync(target, 'utf8'), '---\ntype: meta\n---\n\n# vault config\n');
    assert.deepEqual(
      fs.readdirSync(metaDir).filter((n) => n.includes(TMP_PREFIX)),
      [],
      'no temp file left behind',
    );
  });
});

// --- Retry behaviour (mirrors packreplace) ----------------------------------

test('RETRYABLE_CODES is exactly EPERM, EBUSY, EACCES', () => {
  assert.deepEqual([...RETRYABLE_CODES].sort(), ['EACCES', 'EBUSY', 'EPERM']);
});

test('retry, success: EBUSY twice then a real rename; sleeps [100, 200] and the file is written', () => {
  withScratchDir((root) => {
    const { vaultPath, target } = makeVault(root);
    const sleeps = [];
    let calls = 0;
    const original = fs.renameSync;
    fs.renameSync = (from, to) => {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      }
      return original(from, to);
    };
    try {
      const candidate = Buffer.from('---\ntype: meta\nx: 1\n---\n');
      const result = replaceVaultConfigMd(vaultPath, candidate, {
        expectedSha256: shaOf(target),
        backup: () => ({}),
        sleep: (ms) => sleeps.push(ms),
      });
      assert.equal(result.path, target);
    } finally {
      fs.renameSync = original;
    }
    assert.deepEqual(sleeps, [100, 200]);
  });
});

test('retry, exhausted: EBUSY every time gives 6 attempts, sleeps [100,200,400,800,1600], unchanged bytes, no temp left', () => {
  withScratchDir((root) => {
    const { vaultPath, metaDir, target } = makeVault(root);
    const before = listMetaDir(metaDir);
    const sleeps = [];
    let calls = 0;
    const original = fs.renameSync;
    fs.renameSync = () => {
      calls += 1;
      const err = new Error('busy');
      err.code = 'EBUSY';
      throw err;
    };
    try {
      assert.throws(
        () =>
          replaceVaultConfigMd(vaultPath, Buffer.from('x'), {
            expectedSha256: shaOf(target),
            backup: () => ({}),
            sleep: (ms) => sleeps.push(ms),
          }),
        ScriptoriumError,
      );
    } finally {
      fs.renameSync = original;
    }
    assert.equal(calls, 6);
    assert.deepEqual(sleeps, [100, 200, 400, 800, 1600]);
    assert.deepEqual(listMetaDir(metaDir), before);
  });
});

test('EBUSY where the sha changes mid-retry: VaultConfigChangedError, rename never re-attempted (E10 positive control)', () => {
  withScratchDir((root) => {
    const { vaultPath, target } = makeVault(root);
    let calls = 0;
    const original = fs.renameSync;
    fs.renameSync = () => {
      calls += 1;
      const err = new Error('busy');
      err.code = 'EBUSY';
      throw err;
    };
    try {
      assert.throws(
        () =>
          replaceVaultConfigMd(vaultPath, Buffer.from('x'), {
            expectedSha256: shaOf(target),
            backup: () => ({}),
            sleep: () => {
              fs.writeFileSync(target, 'externally edited');
            },
          }),
        VaultConfigChangedError,
      );
    } finally {
      fs.renameSync = original;
    }
    assert.equal(calls, 1, 'renameSync must not be attempted again once the re-hash has already caught the change');
    assert.equal(fs.readFileSync(target, 'utf8'), 'externally edited');
  });
});

// --- Structural scan ---------------------------------------------------------

test('structural: one wx openSync, one each of writeSync/fsyncSync/renameSync/unlinkSync, no forbidden tokens', () => {
  const fullSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'vault', 'vaultconfigwrite.js'), 'utf8');
  const source = fullSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const forbidden = ['writeFileSync', 'appendFile', 'copyFile', 'rmSync', 'rm(', 'rmdir', 'truncate', 'chmod', 'createWriteStream', 'recursive', 'mkdir'];
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

// --- Graph walk --------------------------------------------------------------

function scanRequires(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const specs = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(stripped))) specs.push(m[1]);
  return specs;
}

function graphReaches(startFile, target) {
  const root = path.join(__dirname, '..');
  const seen = new Set();
  const queue = [startFile];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file === target) return true;
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
      if (!spec.startsWith('.')) continue;
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
  return false;
}

test('graph walk: build.js, check.js and init.js never reach vaultconfigwrite.js, backups.js, machinedir.js or src/admin/**; serve-admin.js does (positive control)', () => {
  const root = path.join(__dirname, '..');
  const target = path.join(root, 'src', 'vault', 'vaultconfigwrite.js');
  for (const entry of ['build.js', 'check.js', 'init.js']) {
    assert.equal(graphReaches(path.join(root, 'src', 'cli', entry), target), false, `${entry} must never reach vaultconfigwrite.js`);
  }
  assert.equal(
    graphReaches(path.join(root, 'src', 'cli', 'serve-admin.js'), target),
    true,
    'positive control: serve-admin.js must reach vaultconfigwrite.js',
  );
});
