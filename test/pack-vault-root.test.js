'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { packDirFor, isStrictlyInside, createPackEntries } = require('../src/vault/packwrite');
const { replacePackFile } = require('../src/vault/packreplace');
const { ConfigError } = require('../src/util/errors');

/*
 * Issue #80: the pack containment checks accepted a pack directory (or _meta) whose real path EQUALS
 * the vault root, so pack writes could land at <vault>/pack.toml. Each refusal test below is paired
 * with a positive control that builds the same shape with an ordinary pack. Synthetic names only.
 *
 * Deliberately NOT changed (PW8 is a frozen constraint test that accepts a pack dir symlinked to an
 * arbitrary directory inside the vault): the pack dir is not required to sit under the real _meta.
 * A pack dir that resolves to _meta itself therefore remains accepted; recorded in the report.
 */

const ENTRIES = [
  { rel: 'pack.toml', kind: 'file', data: 'theme = "plain"\n' },
  { rel: 'vault.config.json', kind: 'file', data: '{}\n' },
];

function scratch(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-packroot-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort();
}

function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function symlinkOrSkip(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return true;
  } catch (err) {
    if (err.code === 'EPERM') {
      t.skip('symlinks unavailable: EPERM');
      return false;
    }
    throw err;
  }
}

const isRootRefusal = (err) => err instanceof ConfigError && /resolves to the vault root/.test(err.message);

test('#80: isStrictlyInside refuses equal paths and string-prefix siblings, accepts real descendants', () => {
  assert.equal(isStrictlyInside('/a/vault', '/a/vault'), false);
  assert.equal(isStrictlyInside('/a/vault', '/a/vault-evil'), false);
  assert.equal(isStrictlyInside('/a/vault', '/a/vault/_meta'), true);
  assert.equal(isStrictlyInside('/a/vault', '/a'), false);
});

// --- createPackEntries ---------------------------------------------------

test('#80 create: _meta -> . (the vault root) is refused and nothing is written at the vault root', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    if (!symlinkOrSkip(t, '.', path.join(vault, '_meta'))) return;
    const before = snapshot(vault);
    assert.throws(() => createPackEntries(vault, ENTRIES), isRootRefusal);
    assert.deepEqual(snapshot(vault), before);
    assert.equal(fs.existsSync(path.join(vault, 'pack.toml')), false);
    assert.equal(fs.existsSync(path.join(vault, 'scriptorium')), false);
  });
});

test('#80 create: _meta/scriptorium -> .. (the vault root) is refused; nothing lands at the vault root', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    if (!symlinkOrSkip(t, '..', packDirFor(vault))) return;
    const before = snapshot(vault);
    assert.throws(() => createPackEntries(vault, ENTRIES), isRootRefusal);
    assert.deepEqual(snapshot(vault), before);
    assert.equal(fs.existsSync(path.join(vault, 'pack.toml')), false);
  });
});

test('#80 create (positive control): an ordinary _meta/scriptorium and a symlinked in-vault pack dir still work', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    const r = createPackEntries(vault, ENTRIES);
    assert.equal(fs.readFileSync(path.join(r.packDir, 'pack.toml'), 'utf8'), 'theme = "plain"\n');
    assert.equal(fs.existsSync(path.join(vault, 'pack.toml')), false);
  });
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'real-pack'));
    if (!symlinkOrSkip(t, '../real-pack', packDirFor(vault))) return;
    createPackEntries(vault, ENTRIES);
    assert.equal(fs.readFileSync(path.join(vault, 'real-pack', 'pack.toml'), 'utf8'), 'theme = "plain"\n');
  });
});

// --- replacePackFile -----------------------------------------------------

function replaceVault(root) {
  const vault = path.join(root, 'vault');
  const packDir = path.join(vault, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
  return { vault, packDir };
}

test('#80 replace: _meta/scriptorium -> .. is refused, the vault-root pack.toml is never written', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'pack.toml'), 'theme = "decoy"\n');
    if (!symlinkOrSkip(t, '..', packDirFor(vault))) return;
    const decoy = sha(path.join(vault, 'pack.toml'));
    assert.throws(
      () => replacePackFile(vault, 'pack.toml', 'theme = "haze"\n', { expectedSha256: decoy }),
      isRootRefusal,
    );
    assert.equal(fs.readFileSync(path.join(vault, 'pack.toml'), 'utf8'), 'theme = "decoy"\n');
    assert.deepEqual(snapshot(vault), ['_meta', 'pack.toml']);
  });
});

test('#80 replace: _meta -> . is refused, the decoy at <vault>/scriptorium/pack.toml is never written', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'scriptorium'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'scriptorium', 'pack.toml'), 'theme = "decoy"\n');
    if (!symlinkOrSkip(t, '.', path.join(vault, '_meta'))) return;
    const decoy = sha(path.join(vault, 'scriptorium', 'pack.toml'));
    assert.throws(
      () => replacePackFile(vault, 'pack.toml', 'theme = "haze"\n', { expectedSha256: decoy }),
      isRootRefusal,
    );
    assert.equal(fs.readFileSync(path.join(vault, 'scriptorium', 'pack.toml'), 'utf8'), 'theme = "decoy"\n');
  });
});

test('#80 replace (positive control): an ordinary pack still replaces', () => {
  scratch((root) => {
    const { vault, packDir } = replaceVault(root);
    replacePackFile(vault, 'pack.toml', 'theme = "haze"\n', { expectedSha256: sha(path.join(packDir, 'pack.toml')) });
    assert.equal(fs.readFileSync(path.join(packDir, 'pack.toml'), 'utf8'), 'theme = "haze"\n');
  });
});
