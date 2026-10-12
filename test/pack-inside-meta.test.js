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
 * Issue #24 (docs/decisions/0021-init-first-run-setup.md, "Amended for issue 24"): both pack writers
 * refuse a pack folder whose real path is not strictly inside the vault's real _meta. Each refusal is
 * paired with a positive control. Synthetic names only.
 */

const ENTRIES = [
  { rel: 'pack.toml', kind: 'file', data: 'theme = "plain"\n' },
  { rel: 'vault.config.json', kind: 'file', data: '{}\n' },
];

function scratch(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-inmeta-'));
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

function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const isRootRefusal = (err) => err instanceof ConfigError && /resolves to the vault root/.test(err.message);
const isOutsideMeta = (err) => err instanceof ConfigError && /resolves outside the vault's _meta folder/.test(err.message);

const NEW = 'theme = "haze"\n';

// --- create refusals -----------------------------------------------------

test('#24 create (a): _meta/scriptorium -> .. is refused as the vault root', (t) => {
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

test('#24 create (b): _meta -> . is refused as the vault root', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    if (!symlinkOrSkip(t, '.', path.join(vault, '_meta'))) return;
    assert.throws(() => createPackEntries(vault, ENTRIES), isRootRefusal);
    assert.deepEqual(snapshot(vault), ['_meta']);
  });
});

test('#24 create (c): _meta/scriptorium -> an in-vault folder outside _meta is refused', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'Notes'));
    fs.writeFileSync(path.join(vault, 'Notes', 'keep.txt'), 'x');
    if (!symlinkOrSkip(t, '../Notes', packDirFor(vault))) return;
    assert.throws(() => createPackEntries(vault, ENTRIES), isOutsideMeta);
    assert.deepEqual(snapshot(path.join(vault, 'Notes')), ['keep.txt']);
    assert.equal(fs.existsSync(path.join(vault, 'Notes', 'pack.toml')), false);
  });
});

test('#24 create (d): _meta/scriptorium -> . (resolving to _meta itself) is refused', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    if (!symlinkOrSkip(t, '.', packDirFor(vault))) return;
    assert.throws(() => createPackEntries(vault, ENTRIES), isOutsideMeta);
    assert.deepEqual(snapshot(path.join(vault, '_meta')), ['scriptorium']);
    assert.equal(fs.existsSync(path.join(vault, '_meta', 'pack.toml')), false);
  });
});

// --- create positive controls -------------------------------------------

test('#24 create (positive control): an ordinary pack works', () => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    const r = createPackEntries(vault, ENTRIES);
    assert.equal(fs.readFileSync(path.join(r.packDir, 'pack.toml'), 'utf8'), 'theme = "plain"\n');
  });
});

test('#24 create (positive control): _meta/scriptorium -> packs/real inside _meta works', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '_meta', 'packs', 'real'), { recursive: true });
    if (!symlinkOrSkip(t, 'packs/real', packDirFor(vault))) return;
    createPackEntries(vault, ENTRIES);
    assert.equal(fs.readFileSync(path.join(vault, '_meta', 'packs', 'real', 'pack.toml'), 'utf8'), 'theme = "plain"\n');
  });
});

test('#24 create (positive control): _meta linked to an in-vault folder is accepted', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'meta-real'), { recursive: true });
    if (!symlinkOrSkip(t, 'meta-real', path.join(vault, '_meta'))) return;
    createPackEntries(vault, ENTRIES);
    assert.equal(fs.readFileSync(path.join(vault, 'meta-real', 'scriptorium', 'pack.toml'), 'utf8'), 'theme = "plain"\n');
  });
});

// --- replace -------------------------------------------------------------

test('#24 replace (c): a pack folder linked to an in-vault folder outside _meta is refused, pack.toml unchanged', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'Notes'));
    const file = path.join(vault, 'Notes', 'pack.toml');
    fs.writeFileSync(file, 'theme = "decoy"\n');
    if (!symlinkOrSkip(t, '../Notes', packDirFor(vault))) return;
    const before = sha(file);
    assert.throws(() => replacePackFile(vault, 'pack.toml', NEW, { expectedSha256: before }), isOutsideMeta);
    assert.equal(sha(file), before);
    assert.deepEqual(snapshot(path.join(vault, 'Notes')), ['pack.toml']);
  });
});

test('#24 replace (d): a pack folder linked to _meta itself is refused, pack.toml unchanged', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
    const file = path.join(vault, '_meta', 'pack.toml');
    fs.writeFileSync(file, 'theme = "decoy"\n');
    if (!symlinkOrSkip(t, '.', packDirFor(vault))) return;
    const before = sha(file);
    assert.throws(() => replacePackFile(vault, 'pack.toml', NEW, { expectedSha256: before }), isOutsideMeta);
    assert.equal(sha(file), before);
    assert.deepEqual(snapshot(path.join(vault, '_meta')), ['pack.toml', 'scriptorium']);
  });
});

test('#24 replace (positive control): an ordinary pack replaces', () => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    const packDir = packDirFor(vault);
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
    replacePackFile(vault, 'pack.toml', NEW, { expectedSha256: sha(path.join(packDir, 'pack.toml')) });
    assert.equal(fs.readFileSync(path.join(packDir, 'pack.toml'), 'utf8'), NEW);
  });
});

test('#24 replace (positive control): a pack folder linked to packs/real inside _meta replaces', (t) => {
  scratch((root) => {
    const vault = path.join(root, 'vault');
    const real = path.join(vault, '_meta', 'packs', 'real');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'pack.toml'), 'theme = "plain"\n');
    if (!symlinkOrSkip(t, 'packs/real', packDirFor(vault))) return;
    replacePackFile(vault, 'pack.toml', NEW, { expectedSha256: sha(path.join(real, 'pack.toml')) });
    assert.equal(fs.readFileSync(path.join(real, 'pack.toml'), 'utf8'), NEW);
  });
});

// --- case folding --------------------------------------------------------

test('#24 isStrictlyInside folds case on win32 and not on linux', () => {
  withPlatform('win32', () => {
    assert.equal(isStrictlyInside('/Vault/_Meta', '/vault/_meta/scriptorium'), true);
    assert.equal(isStrictlyInside('/Vault/_Meta', '/VAULT/_META'), false);
    assert.equal(isStrictlyInside('/vault/_meta', '/vault/_metax/scriptorium'), false);
    assert.equal(isStrictlyInside('/vault/_meta', '/vault/Notes'), false);
  });
  withPlatform('linux', () => {
    assert.equal(isStrictlyInside('/Vault/_Meta', '/vault/_meta/scriptorium'), false);
    assert.equal(isStrictlyInside('/vault/_meta', '/vault/_meta/scriptorium'), true);
  });
});
