'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { moveVaultCopy, assertMovedLayout } = require('./helpers/moved-vault');
const {
  VaultSettingsChangedError,
  TMP_PREFIX,
  RETRYABLE_CODES,
  targetPathFor,
  checkTarget,
  replaceVaultSettingsYaml,
} = require('../src/vault/vaultsettingswrite');
const { ConfigError, ScriptoriumError } = require('../src/util/errors');

/*
 * The guarded writer for <vault>/_meta/vault-config.yaml. Every case starts from a copy of the
 * sample vault that the pin's own move has run on. Expected values are literals.
 */

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');

function withMoved(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vsw-'));
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    assertMovedLayout(vaultPath);
    const metaDir = path.join(vaultPath, '_meta');
    return fn({ root, vaultPath, metaDir, target: path.join(metaDir, 'vault-config.yaml') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmpLeft = (metaDir) => fs.readdirSync(metaDir).filter((n) => n.startsWith('.scriptorium-tmp-vault-settings-'));

function recordingBackup(calls) {
  return (buf) => {
    calls.push(buf);
    return { path: '/fake/backup/path' };
  };
}

function withRename(impl, fn) {
  const original = fs.renameSync;
  fs.renameSync = impl;
  try {
    return fn();
  } finally {
    fs.renameSync = original;
  }
}

const CAND = Buffer.from('version: 1\nplayer_site:\n  title: Candidate\n');

test('constants: the temp prefix never ends in .yaml, and the retryable codes are the three', () => {
  assert.equal(TMP_PREFIX, '.scriptorium-tmp-vault-settings-');
  assert.deepEqual([...RETRYABLE_CODES].sort(), ['EACCES', 'EBUSY', 'EPERM']);
});

test('targetPathFor is <vault>/_meta/vault-config.yaml', () => {
  assert.equal(targetPathFor('/some/vault'), path.join('/some/vault', '_meta', 'vault-config.yaml'));
});

test('checkTarget: a moved vault passes, even with a leftover vault-config.md beside the yaml', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    assert.equal(checkTarget(vaultPath).target, target);
    fs.writeFileSync(path.join(metaDir, 'vault-config.md'), '---\ntype: meta\n---\n');
    assert.equal(checkTarget(vaultPath).target, target);
  });
});

test('happy path: bytes replaced, backup called once with the old bytes, no temp left', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    const old = fs.readFileSync(target);
    const calls = [];
    const result = replaceVaultSettingsYaml(vaultPath, CAND, {
      expectedSha256: sha256(old),
      backup: recordingBackup(calls),
    });
    assert.deepEqual(fs.readFileSync(target), CAND);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], old);
    assert.equal(result.path, target);
    assert.equal(result.sha256, sha256(CAND));
    assert.deepEqual(result.backup, { path: '/fake/backup/path' });
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('bad arguments are a programming error', () => {
  withMoved(({ vaultPath }) => {
    assert.throws(() => replaceVaultSettingsYaml(vaultPath, 'text', { expectedSha256: 'x', backup: () => ({}) }), ScriptoriumError);
    assert.throws(() => replaceVaultSettingsYaml(vaultPath, CAND, { expectedSha256: 'x' }), ScriptoriumError);
  });
});

test('sha mismatch: VaultSettingsChangedError before the backup, yaml untouched, no temp', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    const old = fs.readFileSync(target);
    const calls = [];
    assert.throws(
      () => replaceVaultSettingsYaml(vaultPath, CAND, { expectedSha256: 'a'.repeat(64), backup: recordingBackup(calls) }),
      (err) => err instanceof VaultSettingsChangedError && err instanceof ConfigError && err.message === 'vault-config.yaml changed outside the panel. Reload before saving.',
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(fs.readFileSync(target), old);
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('a change during the backup is caught by the re-hash before the rename', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    const old = fs.readFileSync(target);
    assert.throws(
      () =>
        replaceVaultSettingsYaml(vaultPath, CAND, {
          expectedSha256: sha256(old),
          backup: () => {
            fs.writeFileSync(target, 'version: 1\n# edited elsewhere\n');
            return {};
          },
        }),
      VaultSettingsChangedError,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'version: 1\n# edited elsewhere\n');
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('a symlinked yaml is refused with the not-a-regular-file message, link and target unchanged', () => {
  withMoved(({ root, vaultPath, metaDir, target }) => {
    const real = path.join(root, 'elsewhere.yaml');
    fs.copyFileSync(target, real);
    const before = fs.readFileSync(real);
    fs.rmSync(target);
    fs.symlinkSync(real, target);
    assert.throws(
      () => replaceVaultSettingsYaml(vaultPath, CAND, { expectedSha256: sha256(before), backup: () => ({}) }),
      (err) => err instanceof ConfigError && !(err instanceof VaultSettingsChangedError) && err.message === `refusing to edit ${target}: it is not a regular file`,
    );
    assert.ok(fs.lstatSync(target).isSymbolicLink());
    assert.deepEqual(fs.readFileSync(real), before);
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('a symlinked _meta is refused, even when it points inside the vault', () => {
  withMoved(({ root, vaultPath, metaDir }) => {
    const moved = path.join(vaultPath, 'meta-copy');
    fs.renameSync(metaDir, moved);
    fs.symlinkSync(moved, metaDir);
    assert.throws(
      () => checkTarget(vaultPath),
      (err) => err instanceof ConfigError && err.message.startsWith('refusing to edit vault-config.yaml: ') && err.message.includes('resolves outside the vault ('),
    );
    const outside = path.join(root, 'outside-meta');
    fs.mkdirSync(outside);
    fs.rmSync(metaDir);
    fs.symlinkSync(outside, metaDir);
    assert.throws(() => checkTarget(vaultPath), ConfigError);
  });
});

test('a symlinked _meta refuses the save itself: yaml bytes unchanged, no temp file', () => {
  withMoved(({ vaultPath, metaDir }) => {
    const moved = path.join(vaultPath, 'meta-copy');
    fs.renameSync(metaDir, moved);
    fs.symlinkSync(moved, metaDir);
    const realYaml = path.join(moved, 'vault-config.yaml');
    const before = fs.readFileSync(realYaml);
    const calls = [];
    assert.throws(
      () => replaceVaultSettingsYaml(vaultPath, CAND, { expectedSha256: sha256(before), backup: recordingBackup(calls) }),
      (err) => err instanceof ConfigError && !(err instanceof VaultSettingsChangedError) && err.message.startsWith('refusing to edit vault-config.yaml: '),
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(fs.readFileSync(realYaml), before);
    assert.deepEqual(tmpLeft(moved), []);
  });
});

test('a yaml replaced by a folder is refused and nothing is written', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    fs.rmSync(target);
    fs.mkdirSync(target);
    assert.throws(
      () => replaceVaultSettingsYaml(vaultPath, CAND, { expectedSha256: 'a'.repeat(64), backup: () => ({}) }),
      (err) => err instanceof ConfigError && err.message === `refusing to edit ${target}: it is not a regular file`,
    );
    assert.ok(fs.statSync(target).isDirectory());
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('a missing yaml is VaultSettingsChangedError and is never created', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    fs.rmSync(target);
    assert.throws(
      () => replaceVaultSettingsYaml(vaultPath, CAND, { expectedSha256: 'a'.repeat(64), backup: () => ({}) }),
      VaultSettingsChangedError,
    );
    assert.throws(() => checkTarget(vaultPath), VaultSettingsChangedError);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('a yaml that disappears during the save is VaultSettingsChangedError, never created, no temp', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    const old = fs.readFileSync(target);
    assert.throws(
      () =>
        replaceVaultSettingsYaml(vaultPath, CAND, {
          expectedSha256: sha256(old),
          backup: () => {
            fs.rmSync(target);
            return {};
          },
        }),
      (err) => err instanceof VaultSettingsChangedError && err.message === 'vault-config.yaml changed outside the panel. Reload before saving.',
    );
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('a yaml that vanishes between the first look and the first read is VaultSettingsChangedError', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    const old = fs.readFileSync(target);
    const realRead = fs.readFileSync;
    const calls = [];
    fs.readFileSync = (p, ...rest) => {
      if (p === target) {
        const err = new Error('gone');
        err.code = 'ENOENT';
        throw err;
      }
      return realRead(p, ...rest);
    };
    try {
      assert.throws(
        () => replaceVaultSettingsYaml(vaultPath, CAND, { expectedSha256: sha256(old), backup: recordingBackup(calls) }),
        (err) => err instanceof VaultSettingsChangedError && err.message === 'vault-config.yaml changed outside the panel. Reload before saving.',
      );
    } finally {
      fs.readFileSync = realRead;
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(fs.readFileSync(target), old);
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('EBUSY then success: one sleep of 100 ms, bytes replaced, no temp left', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    const old = fs.readFileSync(target);
    const sleeps = [];
    const real = fs.renameSync;
    let calls = 0;
    withRename(
      (a, b) => {
        calls += 1;
        if (calls === 1) {
          const err = new Error('busy');
          err.code = 'EBUSY';
          throw err;
        }
        return real(a, b);
      },
      () => replaceVaultSettingsYaml(vaultPath, CAND, { expectedSha256: sha256(old), backup: () => ({}), sleep: (ms) => sleeps.push(ms) }),
    );
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [100]);
    assert.deepEqual(fs.readFileSync(target), CAND);
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('EBUSY every time: six attempts, five sleeps, yaml unchanged, no temp left', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    const old = fs.readFileSync(target);
    const sleeps = [];
    let calls = 0;
    withRename(
      () => {
        calls += 1;
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      },
      () =>
        assert.throws(
          () => replaceVaultSettingsYaml(vaultPath, CAND, { expectedSha256: sha256(old), backup: () => ({}), sleep: (ms) => sleeps.push(ms) }),
          (err) => err instanceof ScriptoriumError && err.message === `could not replace ${target}: EBUSY. Another program may have it open. vault-config.yaml was left unchanged.`,
        ),
    );
    assert.equal(calls, 6);
    assert.deepEqual(sleeps, [100, 200, 400, 800, 1600]);
    assert.deepEqual(fs.readFileSync(target), old);
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('a non-retryable rename code fails at once, yaml unchanged, no temp left', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    const old = fs.readFileSync(target);
    const sleeps = [];
    let calls = 0;
    withRename(
      () => {
        calls += 1;
        const err = new Error('nope');
        err.code = 'EXDEV';
        throw err;
      },
      () =>
        assert.throws(
          () => replaceVaultSettingsYaml(vaultPath, CAND, { expectedSha256: sha256(old), backup: () => ({}), sleep: (ms) => sleeps.push(ms) }),
          (err) => err instanceof ScriptoriumError && err.message === `could not replace ${target}: EXDEV. vault-config.yaml was left unchanged.`,
        ),
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
    assert.deepEqual(fs.readFileSync(target), old);
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('a backup that throws propagates, with no temp file and the yaml untouched', () => {
  withMoved(({ vaultPath, metaDir, target }) => {
    const old = fs.readFileSync(target);
    assert.throws(
      () =>
        replaceVaultSettingsYaml(vaultPath, CAND, {
          expectedSha256: sha256(old),
          backup: () => {
            throw new ScriptoriumError('no room for a backup');
          },
        }),
      /no room for a backup/,
    );
    assert.deepEqual(fs.readFileSync(target), old);
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});

test('S5: the backup swaps the yaml for a symlink to the same bytes; only the loop lstat refuses it', () => {
  withMoved(({ root, vaultPath, metaDir, target }) => {
    const old = fs.readFileSync(target);
    const real = path.join(root, 'same-bytes.yaml');
    fs.writeFileSync(real, old);
    assert.throws(
      () =>
        replaceVaultSettingsYaml(vaultPath, CAND, {
          expectedSha256: sha256(old),
          backup: () => {
            fs.rmSync(target);
            fs.symlinkSync(real, target);
            return {};
          },
        }),
      (err) => err instanceof ConfigError && !(err instanceof VaultSettingsChangedError) && err.message === `refusing to edit ${target}: it is not a regular file`,
    );
    assert.ok(fs.lstatSync(target).isSymbolicLink());
    assert.equal(fs.readlinkSync(target), real);
    assert.deepEqual(fs.readFileSync(real), old);
    assert.deepEqual(tmpLeft(metaDir), []);
  });
});
