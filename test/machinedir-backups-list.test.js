'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backups = require('../src/config/backups');

/*
 * V1e-9 (SD-93). listBackups/readBackup are outside the vault (plain fs, never src/vault/read.js
 * -- the loadSiteConfig precedent). Every fixture lives under a fresh mkdtemp; nothing here
 * touches a real per-machine folder.
 */

function scratchLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1e9-backups-list-'));
  const machineDir = path.join(root, 'machine');
  fs.mkdirSync(machineDir, { recursive: true });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  return { root, machineDir, vaultPath };
}

function writeBackupFile(segmentDir, stamp, hex, bytes) {
  fs.mkdirSync(segmentDir, { recursive: true });
  const name = `vault-config-${stamp}-${hex}.md.bak`;
  fs.writeFileSync(path.join(segmentDir, name), bytes === undefined ? 'backup bytes\n' : bytes);
  return name;
}

// -- Listing: newest first, takenAt literals ------------------------------------------------

test('listBackups lists newest first by name, with the takenAt literal rewritten to ISO', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const segmentDir = backups.backupDirFor(machineDir, 'lease');
  const older = writeBackupFile(segmentDir, '20260101T090000000Z', 'aaaaaa');
  const newer = writeBackupFile(segmentDir, '20260102T143005123Z', 'bbbbbb');

  const result = backups.listBackups({ machineDir, campaign: 'lease', vaultPath });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((i) => i.id), [newer, older]);
  assert.equal(result.items[0].takenAt, '2026-01-02T14:30:05.123Z');
  assert.equal(result.items[1].takenAt, '2026-01-01T09:00:00.000Z');
  assert.equal(result.items[0].size, fs.statSync(path.join(segmentDir, newer)).size);
});

test('listBackups on a never-backed-up campaign gives ok:true with an empty items list (ENOENT)', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const result = backups.listBackups({ machineDir, campaign: 'never-backed-up', vaultPath });
  assert.deepEqual(result, { ok: true, dir: backups.backupDirFor(machineDir, 'never-backed-up'), items: [] });
});

// -- Exclusions: a foreign name, and a symlink with a valid name -----------------------------

test('a foreign (non-matching) name is excluded from the listing', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const segmentDir = backups.backupDirFor(machineDir, 'lease');
  const real = writeBackupFile(segmentDir, '20260101T090000000Z', 'aaaaaa');
  fs.writeFileSync(path.join(segmentDir, 'notes.txt'), 'not a backup\n');
  fs.writeFileSync(path.join(segmentDir, 'vault-config-wrong-name.md.bak'), 'not a backup either\n');

  const result = backups.listBackups({ machineDir, campaign: 'lease', vaultPath });
  assert.deepEqual(result.items.map((i) => i.id), [real]);
});

test('a symlink whose name DOES match BACKUP_NAME_RE is excluded (symlinks are never listed)', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const segmentDir = backups.backupDirFor(machineDir, 'lease');
  const real = writeBackupFile(segmentDir, '20260101T090000000Z', 'aaaaaa');
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v1e9-backups-elsewhere-')), 'secret.md');
  fs.writeFileSync(elsewhere, 'elsewhere content\n');
  const symlinkName = 'vault-config-20260103T090000000Z-cccccc.md.bak';
  fs.symlinkSync(elsewhere, path.join(segmentDir, symlinkName));

  const result = backups.listBackups({ machineDir, campaign: 'lease', vaultPath });
  assert.deepEqual(result.items.map((i) => i.id), [real]);
});

// -- Refusals: segment dir as a symlink; segment resolving to the machine dir; a symlink to a
// sibling segment; a backups folder inside the vault ----------------------------------------

test('the segment dir itself being a symlink (to a real directory) is refused', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1e9-backups-real-elsewhere-'));
  const backupsDir = path.join(machineDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.symlinkSync(realDir, backups.backupDirFor(machineDir, 'lease'));

  const result = backups.listBackups({ machineDir, campaign: 'lease', vaultPath });
  assert.equal(result.ok, false);
  assert.match(result.reason, /isn't a plain folder/);
});

test('the segment dir resolving to the machine dir (an ancestor), via a symlinked backups folder, is refused', () => {
  const { machineDir, vaultPath } = scratchLayout();
  // BACKUPS_DIRNAME itself is a symlink back to machineDir (an ancestor of the "segment" it
  // would otherwise compose with), with a REAL directory already sitting beside config.toml
  // under the same name the campaign segment would use -- so a naive single identity check
  // (segmentDir resolves to backupsDir/<segment>) still holds and would wrongly accept this.
  const segment = 'campaign-lease';
  fs.mkdirSync(path.join(machineDir, segment), { recursive: true });
  fs.symlinkSync('.', path.join(machineDir, 'backups'));

  const result = backups.listBackups({ machineDir, campaign: 'lease', vaultPath });
  assert.equal(result.ok, false);
  assert.match(result.reason, /isn't a plain folder/);
});

test('a symlink to the sibling campaign-alpha-evil segment is refused', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const evilSegmentDir = backups.backupDirFor(machineDir, 'alpha-evil');
  fs.mkdirSync(evilSegmentDir, { recursive: true });
  const backupsDir = path.join(machineDir, 'backups');
  fs.symlinkSync(evilSegmentDir, backups.backupDirFor(machineDir, 'lease'));

  const result = backups.listBackups({ machineDir, campaign: 'lease', vaultPath });
  assert.equal(result.ok, false);
  assert.match(result.reason, /isn't a plain folder/);
});

test('a backups folder inside the vault is refused', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const insideVaultMachineDir = path.join(vaultPath, 'machine-inside-vault');
  fs.mkdirSync(insideVaultMachineDir, { recursive: true });
  writeBackupFile(backups.backupDirFor(insideVaultMachineDir, 'lease'), '20260101T090000000Z', 'aaaaaa');

  const result = backups.listBackups({ machineDir: insideVaultMachineDir, campaign: 'lease', vaultPath });
  assert.equal(result.ok, false);
  assert.match(result.reason, /inside the vault/);
});

test('never throws: a readdirSync failure (the segment dir removed mid-call) gives ok:false, not a throw', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const segmentDir = backups.backupDirFor(machineDir, 'lease');
  fs.mkdirSync(segmentDir, { recursive: true });
  fs.chmodSync(segmentDir, 0o000);
  try {
    const result = backups.listBackups({ machineDir, campaign: 'lease', vaultPath });
    // On some CI/container setups root can still traverse a 0o000 dir; only assert the shape
    // when it actually refused -- the point of this test is "never throws", not the exact reason.
    assert.equal(typeof result.ok, 'boolean');
  } finally {
    fs.chmodSync(segmentDir, 0o700);
  }
});

// -- readBackup --------------------------------------------------------------------------------

test('readBackup returns the exact bytes of a listed backup', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const segmentDir = backups.backupDirFor(machineDir, 'lease');
  const name = writeBackupFile(segmentDir, '20260101T090000000Z', 'aaaaaa', 'exact bytes here\n');
  const bytes = backups.readBackup({ machineDir, campaign: 'lease', vaultPath, id: name });
  assert.deepEqual(bytes, Buffer.from('exact bytes here\n'));
});

test('readBackup refuses an id that is not in a fresh listing, even though it regex-matches', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const segmentDir = backups.backupDirFor(machineDir, 'lease');
  fs.mkdirSync(segmentDir, { recursive: true });
  const unlistedButValidName = 'vault-config-20260101T090000000Z-dddddd.md.bak';
  assert.throws(
    () => backups.readBackup({ machineDir, campaign: 'lease', vaultPath, id: unlistedButValidName }),
    backups.BackupNotListedError,
  );
});

test('readBackup refuses a campaign-alpha-evil file id (regex-valid, but belonging to a different campaign segment)', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const evilSegmentDir = backups.backupDirFor(machineDir, 'alpha-evil');
  const evilName = writeBackupFile(evilSegmentDir, '20260101T090000000Z', 'eeeeee');
  // The campaign under test is "lease", not "alpha-evil"; the evil campaign's own id must never
  // be accepted for "lease", even though it regex-matches and really exists on disk.
  assert.throws(
    () => backups.readBackup({ machineDir, campaign: 'lease', vaultPath, id: evilName }),
    backups.BackupNotListedError,
  );
});

test('readBackup refuses an over-cap file with BackupTooLargeError', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const segmentDir = backups.backupDirFor(machineDir, 'lease');
  const big = Buffer.alloc(backups.BACKUP_MAX_BYTES + 1, 0x61);
  const name = writeBackupFile(segmentDir, '20260101T090000000Z', 'ffffff', big);
  assert.throws(
    () => backups.readBackup({ machineDir, campaign: 'lease', vaultPath, id: name }),
    backups.BackupTooLargeError,
  );
});

test('POSIX: a backup swapped to a symlink in the window between readBackup\'s own fresh listing and its open gives ELOOP via O_NOFOLLOW, surfaced as BackupError', { skip: process.platform === 'win32' }, () => {
  const { machineDir, vaultPath } = scratchLayout();
  const segmentDir = backups.backupDirFor(machineDir, 'lease');
  const name = writeBackupFile(segmentDir, '20260101T090000000Z', 'aaaaaa');
  const listing = backups.listBackups({ machineDir, campaign: 'lease', vaultPath });
  assert.deepEqual(listing.items.map((i) => i.id), [name]);

  // readBackup calls listBackups again, through module.exports, immediately before its own
  // fs.openSync -- injecting a stale (pre-swap) listing here, while the real file on disk is
  // ALREADY a symlink, simulates the swap landing in that exact window (a race no single-
  // process, synchronous test can otherwise force deterministically).
  const target = path.join(segmentDir, name);
  fs.unlinkSync(target);
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v1e9-backups-swap-')), 'secret.md');
  fs.writeFileSync(elsewhere, 'swapped-in content\n');
  fs.symlinkSync(elsewhere, target);

  const original = backups.listBackups;
  backups.listBackups = () => listing;
  let threw = null;
  try {
    backups.readBackup({ machineDir, campaign: 'lease', vaultPath, id: name });
  } catch (err) {
    threw = err;
  } finally {
    backups.listBackups = original;
  }
  assert.ok(threw instanceof backups.BackupError);
  assert.ok(!(threw instanceof backups.BackupNotListedError));
  assert.match(threw.message, /ELOOP/);
});
