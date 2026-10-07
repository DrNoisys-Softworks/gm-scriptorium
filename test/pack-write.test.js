'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { packDirFor, isInsideOrEqual, createPackEntries } = require('../src/vault/packwrite');
const { ConfigError, ScriptoriumError } = require('../src/util/errors');

/*
 * ADR 0021. Synthetic names only (NFR-08). Vaults are built fresh in
 * os.tmpdir(), never in shared fixtures.
 */

/* Copied verbatim from test/build-plan-swap.test.js:21-29 (process.platform
 * is configurable but not writable; withPlatform lets PW13 force win32 and
 * darwin deterministically from a single dev machine). */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-packwrite-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A minimal vault with _meta present, but no campaign pack yet. */
function makeVault(root) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    '---\ntype: meta\ncampaign: alpha\n---\n\n# Vault config\n',
  );
  return vaultPath;
}

const FRESH_ENTRIES = [
  { rel: 'css', kind: 'dir' },
  { rel: 'images', kind: 'dir' },
  { rel: 'pack.toml', kind: 'file', data: 'theme = "plain"\n' },
  { rel: 'vault.config.json', kind: 'file', data: '{}\n' },
];

test('PW1: a fresh pack is created in order, exact bytes, createdPackDir true', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const result = createPackEntries(vaultPath, FRESH_ENTRIES, { campaign: 'alpha' });
    assert.deepEqual(result.created, ['css/', 'images/', 'pack.toml', 'vault.config.json']);
    assert.equal(result.createdPackDir, true);
    const packDir = packDirFor(vaultPath);
    assert.equal(result.packDir, packDir);
    assert.ok(fs.statSync(path.join(packDir, 'css')).isDirectory());
    assert.ok(fs.statSync(path.join(packDir, 'images')).isDirectory());
    assert.equal(fs.readFileSync(path.join(packDir, 'pack.toml'), 'utf8'), 'theme = "plain"\n');
    assert.equal(fs.readFileSync(path.join(packDir, 'vault.config.json'), 'utf8'), '{}\n');
  });
});

test('PW2: an existing pack.toml with sentinel bytes gives W-EXISTS naming earlier-created paths; sentinel and mtime unchanged; vault.config.json absent', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const packDir = packDirFor(vaultPath);
    fs.mkdirSync(packDir, { recursive: true });
    const sentinelPath = path.join(packDir, 'pack.toml');
    fs.writeFileSync(sentinelPath, 'theme = "sentinel"\n# hand-made\n');
    const past = new Date('2001-02-03T04:05:06Z');
    fs.utimesSync(sentinelPath, past, past);
    const mtimeBefore = fs.statSync(sentinelPath).mtimeMs;

    assert.throws(
      () => createPackEntries(vaultPath, FRESH_ENTRIES, { campaign: 'alpha' }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.startsWith(`refusing to overwrite ${sentinelPath}: it already exists`));
        assert.ok(err.message.includes(path.join(packDir, 'css')));
        assert.ok(err.message.includes(path.join(packDir, 'images')));
        return true;
      },
    );
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'theme = "sentinel"\n# hand-made\n');
    assert.equal(fs.statSync(sentinelPath).mtimeMs, mtimeBefore);
    assert.equal(fs.existsSync(path.join(packDir, 'vault.config.json')), false);
  });
});

test('PW3: an existing css/ directory is tolerated and is not in created', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const packDir = packDirFor(vaultPath);
    fs.mkdirSync(path.join(packDir, 'css'), { recursive: true });
    const result = createPackEntries(vaultPath, FRESH_ENTRIES, { campaign: 'alpha' });
    assert.deepEqual(result.created, ['images/', 'pack.toml', 'vault.config.json']);
  });
});

test('PW4: notes.md and A.MD give W-MARKDOWN, and the pack directory is not created', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    for (const rel of ['notes.md', 'A.MD']) {
      assert.throws(
        () => createPackEntries(vaultPath, [{ rel, kind: 'file', data: 'x' }], { campaign: 'alpha' }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(
            err.message,
            `refusing to write ${rel} into the campaign pack: check reads every Markdown file under _meta (docs/decisions/0018-campaign-pack.md)`,
          );
          return true;
        },
      );
    }
    assert.equal(fs.existsSync(packDirFor(vaultPath)), false);
  });
});

test('PW5: W-REL for each malformed rel; nothing is created', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const bad = ['', '../x', '/x', 'C:/x', 'a\\b', 'a//b', './x', 'a/..'];
    for (const rel of bad) {
      assert.throws(
        () => createPackEntries(vaultPath, [{ rel, kind: 'file', data: 'x' }], { campaign: 'alpha' }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.message, `refusing to write "${rel}" into the campaign pack: not a plain relative path`);
          return true;
        },
      );
    }
    assert.equal(fs.existsSync(packDirFor(vaultPath)), false);
  });
});

test('PW6: _meta as a symlink to an outside directory gives W-ESCAPE; the outside directory is unchanged', (t) => {
  withScratchDir((root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(vaultPath, { recursive: true });
    const outside = path.join(root, 'outside-meta');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'untouched');
    try {
      fs.symlinkSync(outside, path.join(vaultPath, '_meta'), 'dir');
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlinks unavailable: EPERM creating a symlink in this environment');
        return;
      }
      throw err;
    }
    const before = fs.readdirSync(outside).sort();
    assert.throws(
      () => createPackEntries(vaultPath, FRESH_ENTRIES, { campaign: 'alpha' }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.startsWith('refusing to write the campaign pack:'));
        assert.ok(err.message.includes('resolves outside the vault'));
        return true;
      },
    );
    assert.deepEqual(fs.readdirSync(outside).sort(), before);
  });
});

test('PW7: _meta/scriptorium as a symlink outside the vault gives W-ESCAPE', (t) => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const outside = path.join(root, 'outside-pack');
    fs.mkdirSync(outside, { recursive: true });
    try {
      fs.symlinkSync(outside, packDirFor(vaultPath), 'dir');
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlinks unavailable: EPERM creating a symlink in this environment');
        return;
      }
      throw err;
    }
    assert.throws(
      () => createPackEntries(vaultPath, FRESH_ENTRIES, { campaign: 'alpha' }),
      (err) => err instanceof ConfigError && err.message.includes('resolves outside the vault'),
    );
  });
});

test('PW8: _meta/scriptorium as a symlink to a directory inside the vault is accepted', (t) => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const insideTarget = path.join(vaultPath, 'real-pack-dir');
    fs.mkdirSync(insideTarget, { recursive: true });
    try {
      fs.symlinkSync(insideTarget, packDirFor(vaultPath), 'dir');
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlinks unavailable: EPERM creating a symlink in this environment');
        return;
      }
      throw err;
    }
    const result = createPackEntries(vaultPath, FRESH_ENTRIES, { campaign: 'alpha' });
    assert.equal(result.createdPackDir, false);
    assert.equal(fs.readFileSync(path.join(insideTarget, 'pack.toml'), 'utf8'), 'theme = "plain"\n');
  });
});

test('PW9: _meta/scriptorium as a regular file gives the W-NOTDIR message', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    fs.writeFileSync(packDirFor(vaultPath), 'not a directory');
    assert.throws(
      () => createPackEntries(vaultPath, FRESH_ENTRIES, { campaign: 'alpha' }),
      (err) =>
        err instanceof ConfigError &&
        err.message === `refusing to write the campaign pack: ${packDirFor(vaultPath)} exists and is not a folder`,
    );
  });
});

test('PW10: a dangling pack.toml symlink gives W-EXISTS, and the link target is never created', (t) => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const packDir = packDirFor(vaultPath);
    fs.mkdirSync(packDir, { recursive: true });
    const target = path.join(root, 'nowhere.toml');
    try {
      fs.symlinkSync(target, path.join(packDir, 'pack.toml'));
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlinks unavailable: EPERM creating a symlink in this environment');
        return;
      }
      throw err;
    }
    assert.throws(
      () => createPackEntries(vaultPath, FRESH_ENTRIES, { campaign: 'alpha' }),
      (err) => err instanceof ConfigError && err.message.startsWith(`refusing to overwrite ${path.join(packDir, 'pack.toml')}: it already exists`),
    );
    assert.equal(fs.existsSync(target), false);
  });
});

test('PW11: no _meta gives W-NOMETA', () => {
  withScratchDir((root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(vaultPath, { recursive: true });
    assert.throws(
      () => createPackEntries(vaultPath, FRESH_ENTRIES, { campaign: 'alpha' }),
      (err) =>
        err instanceof ConfigError &&
        err.message === `refusing to write the campaign pack: ${path.join(vaultPath, '_meta')} does not exist`,
    );
  });
});

test('PW12: packDirFor builds the conventional pack path', () => {
  assert.equal(packDirFor('/v'), path.join('/v', '_meta', 'scriptorium'));
});

test('PW13: isInsideOrEqual folds case per platform, and requires the separator boundary', () => {
  withPlatform('win32', () => {
    assert.equal(isInsideOrEqual('/a/Vault', '/a/vault/_meta'), true);
  });
  withPlatform('linux', () => {
    assert.equal(isInsideOrEqual('/a/Vault', '/a/vault/_meta'), false);
  });
  assert.equal(isInsideOrEqual('/a/vault', '/a/vault2'), false);
  assert.equal(isInsideOrEqual('/a/vault', '/a/vault'), true);
});

test('PW14 (structural): packwrite.js never deletes/renames/appends, and every writeFileSync uses flag: wx', () => {
  const fullSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'vault', 'packwrite.js'), 'utf8');
  const source = fullSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const forbidden = [
    'rmSync',
    'rm(',
    'rmdir',
    'unlink',
    'rename',
    'copyFile',
    'appendFile',
    'truncate',
    'chmod',
    'createWriteStream',
    'writeFile(',
    'recursive',
  ];
  const hits = forbidden.filter((token) => source.includes(token));
  assert.deepEqual(hits, []);
  const writeFileSyncCount = (source.match(/writeFileSync\(/g) || []).length;
  const wxCount = (source.match(/flag: 'wx'/g) || []).length;
  assert.equal(writeFileSyncCount, wxCount);
});

test("PW15 (structural): init.js and prompt.js are structurally write-free, and init.js does not name the pin directly", () => {
  const tokens = [
    'writeFileSync',
    'writeFile(',
    'appendFileSync',
    'appendFile(',
    'copyFileSync',
    'copyFile(',
    'rmSync',
    'rm(',
    'unlinkSync',
    'unlink(',
    'mkdirSync',
    'mkdir(',
    'renameSync',
    'rename(',
    'chmodSync',
    'chmod(',
    'truncateSync',
    'truncate(',
    'createWriteStream',
  ];
  for (const rel of [path.join('src', 'cli', 'init.js'), path.join('src', 'cli', 'prompt.js')]) {
    const full = path.join(__dirname, '..', rel);
    const fullSource = fs.readFileSync(full, 'utf8');
    const source = fullSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const hits = tokens.filter((token) => source.includes(token));
    assert.deepEqual(hits, [], `${rel} must stay write-free; found: ${hits}`);
  }
  const initSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli', 'init.js'), 'utf8');
  assert.ok(!initSource.includes('gm-apprentice-publish'));
});
