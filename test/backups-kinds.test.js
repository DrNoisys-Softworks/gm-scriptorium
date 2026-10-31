'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backups = require('../src/config/backups');

/*
 * Copies of vault-config.md and of _meta/vault-config.yaml share one folder per campaign. Each
 * kind is listed, restored and pruned on its own. Expected names are literals.
 */

function scratchLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-kinds-'));
  const machineDir = path.join(root, 'machine');
  fs.mkdirSync(machineDir, { recursive: true });
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  return { root, machineDir, vaultPath };
}

function put(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'bytes\n');
}

const MD = [
  'vault-config-20260101T090000000Z-aaaaaa.md.bak',
  'vault-config-20260102T090000000Z-bbbbbb.md.bak',
  'vault-config-20260103T090000000Z-cccccc.md.bak',
];
const YAML = [
  'vault-config-20260101T100000000Z-aaaaaa.yaml.bak',
  'vault-config-20260102T100000000Z-bbbbbb.yaml.bak',
  'vault-config-20260103T100000000Z-cccccc.yaml.bak',
];
const LEFTOVER = 'vault-config-leftover-20260104T090000000Z-dddddd.md.bak';
const JSONBAK = 'vault.config-20260104T090000000Z-eeeeee.json.bak';

test('backupKindOf names the three shapes', () => {
  assert.equal(backups.backupKindOf(YAML[0]), 'yaml');
  assert.equal(backups.backupKindOf(MD[0]), 'md');
  assert.equal(backups.backupKindOf(LEFTOVER), null);
  assert.equal(backups.backupKindOf(JSONBAK), null);
  assert.equal(backups.backupKindOf('notes.txt'), null);
});

test('listBackups lists each kind apart, newest first', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const dir = backups.backupDirFor(machineDir, 'lease');
  for (const n of [...MD, ...YAML, LEFTOVER, JSONBAK]) put(dir, n);

  const y = backups.listBackups({ machineDir, campaign: 'lease', vaultPath, kind: 'yaml' });
  assert.deepEqual(y.items.map((i) => i.id), [YAML[2], YAML[1], YAML[0]]);
  assert.equal(y.items[0].takenAt, '2026-01-03T10:00:00.000Z');
  const d = backups.listBackups({ machineDir, campaign: 'lease', vaultPath });
  assert.deepEqual(d.items.map((i) => i.id), [MD[2], MD[1], MD[0]]);
});

test('readBackup refuses an id of the other kind', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const dir = backups.backupDirFor(machineDir, 'lease');
  for (const n of [...MD, ...YAML]) put(dir, n);
  const base = { machineDir, campaign: 'lease', vaultPath };

  assert.throws(() => backups.readBackup({ ...base, kind: 'yaml', id: MD[0] }), backups.BackupNotListedError);
  assert.throws(() => backups.readBackup({ ...base, id: YAML[0] }), backups.BackupNotListedError);
  assert.equal(backups.readBackup({ ...base, kind: 'yaml', id: YAML[0] }).toString(), 'bytes\n');
  assert.equal(backups.readBackup({ ...base, id: MD[0] }).toString(), 'bytes\n');
});

function saveMany(file, n, ctx, start) {
  for (let i = 0; i < n; i++) {
    backups.backupThenPrune({ ...ctx, bytes: Buffer.from('x'), file, now: () => start + i * 1000 });
  }
}

function names(ctx, kind) {
  return backups.listBackups({ ...ctx, kind }).items.map((i) => i.id);
}

test('21 yaml saves keep 20 yaml copies and all 3 md copies; labelled and json copies survive', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const ctx = { machineDir, campaign: 'lease', vaultPath };
  const dir = backups.backupDirFor(machineDir, 'lease');
  for (const n of [...MD, LEFTOVER, JSONBAK]) put(dir, n);

  saveMany('vault-config.yaml', 21, ctx, Date.UTC(2026, 5, 1));
  assert.equal(names(ctx, 'yaml').length, 20);
  assert.deepEqual(names(ctx, 'md'), [MD[2], MD[1], MD[0]]);
  assert.ok(fs.existsSync(path.join(dir, LEFTOVER)));
  assert.ok(fs.existsSync(path.join(dir, JSONBAK)));
});

test('21 md saves keep 20 md copies and all 3 yaml copies; labelled and json copies survive', () => {
  const { machineDir, vaultPath } = scratchLayout();
  const ctx = { machineDir, campaign: 'lease', vaultPath };
  const dir = backups.backupDirFor(machineDir, 'lease');
  for (const n of [...YAML, LEFTOVER, JSONBAK]) put(dir, n);

  saveMany('vault-config.md', 21, ctx, Date.UTC(2026, 5, 1));
  assert.equal(names(ctx, 'md').length, 20);
  assert.deepEqual(names(ctx, 'yaml'), [YAML[2], YAML[1], YAML[0]]);
  assert.ok(fs.existsSync(path.join(dir, LEFTOVER)));
  assert.ok(fs.existsSync(path.join(dir, JSONBAK)));
});

// Pins the documented contract; it passes on the code as it was, so it proves the JSDoc, not a fix.
test('listBackups and pruneBackups throw BackupError for an unknown kind, before reading anything', () => {
  const { root, machineDir, vaultPath } = scratchLayout();
  try {
    for (const fn of [backups.listBackups, backups.pruneBackups]) {
      assert.throws(() => fn({ machineDir, campaign: 'alpha', vaultPath, kind: 'json' }), (err) => err instanceof backups.BackupError && err.message === 'unknown backup kind "json"');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
