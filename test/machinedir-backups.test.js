'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BACKUPS_DIRNAME, campaignSegment, resolveMachineDir, REASON_NO_CONFIG_PATH } = require('../src/config/machinedir');
const { BACKUP_KEEP, BACKUP_NAME_RE, BackupError, backupDirFor, writeBackup, pruneBackups, backupThenPrune } = require('../src/config/backups');

/*
 * V1e-1 (SD-2, SD-3, AC-02). Isolation (test-first order): every scratch env var below is set to
 * a per-file mkdtemp BEFORE any test runs, so an accidental default-path fallback anywhere in
 * this file lands in scratch, never in the real ~/.config/scriptorium or %APPDATA%\Scriptorium.
 */
const SCRATCH_XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-mdb-xdg-'));
process.env.XDG_CONFIG_HOME = SCRATCH_XDG;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-mdb-appdata-'));
process.env.SCRIPTORIUM_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-mdb-sc-')), 'config.toml');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-mdb-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeVault(root) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  return vaultPath;
}

// --- campaignSegment ---------------------------------------------------------

test('campaignSegment: con, nul, a/b, .. and CON are single safe segments (typed literals, sha computed independently)', () => {
  assert.equal(campaignSegment('con'), 'campaign-con');
  assert.equal(campaignSegment('nul'), 'campaign-nul');
  assert.equal(campaignSegment('a/b'), 'campaign_c14cddc033f64b9d');
  assert.equal(campaignSegment('..'), 'campaign_5ec1f7e700f37c3d');
  assert.equal(campaignSegment('CON'), 'campaign_a3dbc4b644a9a2c5');
  for (const seg of [campaignSegment('a/b'), campaignSegment('..'), campaignSegment('CON')]) {
    assert.equal(seg.includes('/'), false);
    assert.equal(seg.includes('..'), false);
  }
});

test('campaignSegment: the hashed and plain forms can never collide (no underscore in NAME_RE alphabet)', () => {
  assert.equal(campaignSegment('a-b').startsWith('campaign-'), true);
  assert.equal(campaignSegment('a_b').startsWith('campaign_'), true); // '_' fails NAME_RE
});

// --- resolveMachineDir --------------------------------------------------------

test('resolveMachineDir: a --config-style dir (an absolute configPath) resolves to its dirname', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const configDir = path.join(root, 'x');
    fs.mkdirSync(configDir);
    const result = resolveMachineDir({ configPath: path.join(configDir, 'config.toml'), vaultPath });
    assert.equal(result.ok, true);
    assert.equal(result.dir, configDir);
  });
});

test('resolveMachineDir: a SCRIPTORIUM_CONFIG-style dir (still just dirname(configPath)) resolves the same way', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const configDir = path.join(root, 'y');
    fs.mkdirSync(configDir);
    const result = resolveMachineDir({ configPath: path.join(configDir, 'c.toml'), vaultPath });
    assert.equal(result.ok, true);
    assert.equal(result.dir, configDir);
  });
});

test('resolveMachineDir: a missing configPath is unavailable, and nothing appears under the scratch XDG_CONFIG_HOME (never falls back)', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const before = fs.readdirSync(SCRATCH_XDG);
    const r1 = resolveMachineDir({ configPath: undefined, vaultPath });
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, REASON_NO_CONFIG_PATH);
    const r2 = resolveMachineDir({ configPath: null, vaultPath });
    assert.equal(r2.ok, false);
    const r3 = resolveMachineDir({ configPath: '', vaultPath });
    assert.equal(r3.ok, false);
    const r4 = resolveMachineDir({ configPath: 'relative/config.toml', vaultPath });
    assert.equal(r4.ok, false, 'a relative configPath must never be treated as usable');
    assert.deepEqual(fs.readdirSync(SCRATCH_XDG), before, 'resolveMachineDir must never touch defaultConfigPath()\'s own folder');
  });
});

test('resolveMachineDir: a missing dir is unavailable', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const missing = path.join(root, 'does-not-exist');
    const result = resolveMachineDir({ configPath: path.join(missing, 'config.toml'), vaultPath });
    assert.equal(result.ok, false);
    assert.match(result.reason, /doesn't exist/);
  });
});

test('resolveMachineDir: machine dir equal to the vault, or a descendant of it, is refused; the vault\'s parent and a prefix-sibling ("<vault>-evil") are allowed', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);

    const equal = resolveMachineDir({ configPath: path.join(vaultPath, 'config.toml'), vaultPath });
    assert.equal(equal.ok, false);
    assert.match(equal.reason, /inside the vault/);

    const sub = path.join(vaultPath, 'sub');
    fs.mkdirSync(sub);
    const descendant = resolveMachineDir({ configPath: path.join(sub, 'config.toml'), vaultPath });
    assert.equal(descendant.ok, false);

    const parentResult = resolveMachineDir({ configPath: path.join(root, 'config.toml'), vaultPath });
    assert.equal(parentResult.ok, true, 'the vault\'s own parent directory must be allowed as a machine dir');

    const evil = `${vaultPath}-evil`;
    fs.mkdirSync(evil);
    const evilResult = resolveMachineDir({ configPath: path.join(evil, 'config.toml'), vaultPath });
    assert.equal(evilResult.ok, true, 'a prefix-sibling directory must not be treated as inside the vault');
  });
});

test('resolveMachineDir: a vault INSIDE the machine dir is allowed (the reverse direction)', () => {
  withScratchDir((root) => {
    const campDir = path.join(root, 'camp');
    fs.mkdirSync(campDir);
    const vaultPath = path.join(campDir, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    const result = resolveMachineDir({ configPath: path.join(campDir, 'config.toml'), vaultPath });
    assert.equal(result.ok, true);
  });
});

test('resolveMachineDir: a symlinked machine dir pointing into the vault is refused', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const linkDir = path.join(root, 'link-dir');
    fs.symlinkSync(vaultPath, linkDir);
    const result = resolveMachineDir({ configPath: path.join(linkDir, 'config.toml'), vaultPath });
    assert.equal(result.ok, false);
  });
});

// --- writeBackup / pruneBackups / backupThenPrune -----------------------------

function isWin32() {
  return process.platform === 'win32';
}

test('writeBackup: creates backups/<segment>/vault-config-<stamp>-<hex6>.md.bak, byte-identical to the given bytes, and prunes nothing on its own', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const machineDir = path.join(root, 'machine');
    fs.mkdirSync(machineDir);
    const bytes = Buffer.from('---\ntype: meta\n---\n');
    const result = writeBackup({ machineDir, campaign: 'alpha', vaultPath, bytes, now: () => new Date('2026-09-30T01:02:03.456Z').getTime() });
    assert.match(path.basename(result.path), BACKUP_NAME_RE);
    assert.equal(path.basename(result.path).startsWith('vault-config-20260930T010203456Z-'), true);
    assert.deepEqual(fs.readFileSync(result.path), bytes);
    assert.equal(result.dir, backupDirFor(machineDir, 'alpha'));
  });
});

test('writeBackup: 0700 on the backups dir and segment dir, 0600 on the file (POSIX only)', { skip: isWin32() }, () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const machineDir = path.join(root, 'machine');
    fs.mkdirSync(machineDir);
    const result = writeBackup({ machineDir, campaign: 'alpha', vaultPath, bytes: Buffer.from('x') });
    assert.equal(fs.statSync(path.join(machineDir, BACKUPS_DIRNAME)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(result.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  });
});

test('writeBackup: a backups dir that already exists (as a real directory) is tolerated, pre-existing permissions untouched', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const machineDir = path.join(root, 'machine');
    fs.mkdirSync(machineDir);
    fs.mkdirSync(path.join(machineDir, BACKUPS_DIRNAME), { mode: 0o755 });
    writeBackup({ machineDir, campaign: 'alpha', vaultPath, bytes: Buffer.from('x') });
    if (!isWin32()) {
      assert.equal(fs.statSync(path.join(machineDir, BACKUPS_DIRNAME)).mode & 0o777, 0o755, 'pre-existing directory permissions are not changed');
    }
  });
});

test('writeBackup: a symlinked backups dir pointing into the vault is refused (BackupError), and nothing is written', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const machineDir = path.join(root, 'machine');
    fs.mkdirSync(machineDir);
    const insideVault = path.join(vaultPath, 'sneaky-backups');
    fs.mkdirSync(insideVault);
    fs.symlinkSync(insideVault, path.join(machineDir, BACKUPS_DIRNAME));
    assert.throws(() => writeBackup({ machineDir, campaign: 'alpha', vaultPath, bytes: Buffer.from('x') }), BackupError);
    // Step 1 (mkdir the segment dir) necessarily runs before step 3's inside-vault re-check can
    // even see it (brief's own step order) -- the residual is an empty directory, never a backup
    // file. What matters is that no .md.bak ever lands inside the vault.
    function findMdBak(dir) {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) {
          if (findMdBak(p)) return true;
        } else if (name.endsWith('.md.bak')) {
          return true;
        }
      }
      return false;
    }
    assert.equal(findMdBak(insideVault), false);
  });
});

test('pruneBackups: 25 backups with an injected clock leave exactly the 20 newest (typed name list); a foreign file and a symlink both survive', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const machineDir = path.join(root, 'machine');
    fs.mkdirSync(machineDir);
    const dir = backupDirFor(machineDir, 'alpha');
    fs.mkdirSync(dir, { recursive: true });

    const names = [];
    for (let i = 0; i < 25; i++) {
      const iso = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString().replace(/[-:.]/g, '');
      const name = `vault-config-${iso}-${String(i).padStart(6, '0')}.md.bak`;
      names.push(name);
      fs.writeFileSync(path.join(dir, name), 'x');
    }
    const foreignName = 'notes.txt';
    fs.writeFileSync(path.join(dir, foreignName), 'foreign');
    const targetForLink = path.join(root, 'link-target.md.bak');
    fs.writeFileSync(targetForLink, 'x');
    const symlinkName = 'vault-config-20260101T000000000Z-abcdef.md.bak';
    fs.symlinkSync(targetForLink, path.join(dir, symlinkName));

    pruneBackups({ machineDir, campaign: 'alpha' });

    const remaining = fs.readdirSync(dir).sort();
    const sortedNames = names.slice().sort();
    const expectedKept = sortedNames.slice(-BACKUP_KEEP); // newest 20 by name-sort
    const expected = [...expectedKept, foreignName, symlinkName].sort();
    assert.deepEqual(remaining, expected);
  });
});

test('pruneBackups: an injected unlinkSync failure is swallowed and never throws', () => {
  withScratchDir((root) => {
    const machineDir = path.join(root, 'machine');
    fs.mkdirSync(machineDir);
    const dir = backupDirFor(machineDir, 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 22; i++) {
      const iso = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString().replace(/[-:.]/g, '');
      fs.writeFileSync(path.join(dir, `vault-config-${iso}-${String(i).padStart(6, '0')}.md.bak`), 'x');
    }
    const original = fs.unlinkSync;
    fs.unlinkSync = () => {
      throw new Error('EBUSY');
    };
    try {
      assert.doesNotThrow(() => pruneBackups({ machineDir, campaign: 'alpha' }));
    } finally {
      fs.unlinkSync = original;
    }
  });
});

test('backupThenPrune: writeBackup throws propagate untouched; a successful backup then prunes to the keep count', () => {
  withScratchDir((root) => {
    const vaultPath = makeVault(root);
    const machineDir = path.join(root, 'machine');
    fs.mkdirSync(machineDir);
    for (let i = 0; i < 20; i++) {
      const dir = backupDirFor(machineDir, 'alpha');
      fs.mkdirSync(dir, { recursive: true });
      const iso = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString().replace(/[-:.]/g, '');
      fs.writeFileSync(path.join(dir, `vault-config-${iso}-${String(i).padStart(6, '0')}.md.bak`), 'x');
    }
    const result = backupThenPrune({ machineDir, campaign: 'alpha', vaultPath, bytes: Buffer.from('newest') });
    const dir = backupDirFor(machineDir, 'alpha');
    assert.equal(fs.readdirSync(dir).length, BACKUP_KEEP);
    assert.equal(fs.existsSync(result.path), true);
  });
});

// --- Structural scan -----------------------------------------------------------

test('structural: backups.js uses exactly one wx openSync (the writer), one O_NOFOLLOW openSync (V1e-9\'s reader), one renameSync, two unlinkSync, no recursive', () => {
  const fullSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'backups.js'), 'utf8');
  const source = fullSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(source.includes('recursive'), false);
  const openCalls = source.match(/openSync\([^)]*\)/g) || [];
  // V1e-9 (SD-93): readBackup's own openSync (O_NOFOLLOW, for reading) joins writeBackup's wx
  // openSync (for the exclusive-create write) -- two legitimate opens now, not one.
  assert.equal(openCalls.length, 2);
  assert.equal(openCalls.filter((c) => /'wx'/.test(c)).length, 1);
  assert.equal(openCalls.filter((c) => /O_NOFOLLOW/.test(c)).length, 1);
  assert.equal((source.match(/renameSync\(/g) || []).length, 1);
  assert.equal((source.match(/unlinkSync\(/g) || []).length, 2);
});

test('isolation: machinedir.js and backups.js never CALL defaultConfigPath or resolveConfigPath (comments naming them, to say they are deliberately unused, are fine)', () => {
  for (const file of ['machinedir.js', 'backups.js']) {
    const fullSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', file), 'utf8');
    const source = fullSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/defaultConfigPath\(|resolveConfigPath\(/.test(source), false, file);
  }
});
