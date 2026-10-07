'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ScriptoriumError } = require('../util/errors');
const { platformFoldsCase } = require('../vault/exclusions');
const packwrite = require('../vault/packwrite');
const { BACKUPS_DIRNAME, campaignSegment } = require('./machinedir');

/*
 * V1e-1 (ADR 0033, SD-3): vault-config.md backups, written OUTSIDE the vault, in the per-machine
 * folder machinedir.js resolves. Newest BACKUP_KEEP survive; pruning runs only after a successful
 * backup and never fails the save (src/build/run.js's swallowed-cleanup pattern, CLAUDE.md).
 */

const BACKUP_KEEP = 20;
const BACKUP_NAME_RE = /^vault-config-\d{8}T\d{9}Z-[0-9a-f]{6}\.md\.bak$/;

/** V1e-9 (SD-93): readBackup's own size cap, independent of JSON_BODY_CAP (the whole file, not JSON). */
const BACKUP_MAX_BYTES = 4194304;

class BackupError extends ScriptoriumError {}

/** V1e-9 (SD-93): the id regex-matched but was not an exact member of a fresh listing. */
class BackupNotListedError extends BackupError {}

/** V1e-9 (SD-93): the backup file is over BACKUP_MAX_BYTES. */
class BackupTooLargeError extends BackupError {}

function fold(s) {
  return platformFoldsCase() ? s.toLowerCase() : s;
}

function backupDirFor(machineDir, campaign) {
  return path.join(machineDir, BACKUPS_DIRNAME, campaignSegment(campaign));
}

/** Non-recursive mkdir; EEXIST tolerated only when the pre-existing entry is genuinely a directory. */
function mkdirTolerant(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const st = fs.statSync(dir);
    if (!st.isDirectory()) throw err;
  }
}

function removeTempBestEffort(tmp) {
  try {
    fs.unlinkSync(tmp);
  } catch {
    // swallowed deliberately: the caller's own error already explains what went wrong.
  }
}

function stampFor(now) {
  return new Date(now()).toISOString().replace(/[-:.]/g, '');
}

/**
 * @param {{ machineDir: string, campaign: string|null, vaultPath: string, bytes: Buffer, now?: () => number }} opts
 * @returns {{ path: string, dir: string }}
 * @throws {BackupError} vault-config.md is left unchanged
 */
function writeBackup({ machineDir, campaign, vaultPath, bytes, now = Date.now }) {
  const backupsDir = path.join(machineDir, BACKUPS_DIRNAME);
  const segment = campaignSegment(campaign);
  const segmentDir = path.join(backupsDir, segment);

  try {
    mkdirTolerant(backupsDir);
    mkdirTolerant(segmentDir);
  } catch (err) {
    throw new BackupError(`could not back up vault-config.md to ${segmentDir}: ${err.code || err.message}. vault-config.md was left unchanged.`, {
      path: segmentDir,
      campaign,
      cause: err,
    });
  }

  const realBackupsDir = fs.realpathSync(backupsDir);
  const realSegmentDir = fs.realpathSync(segmentDir);
  if (fold(realSegmentDir) !== fold(path.join(realBackupsDir, segment))) {
    throw new BackupError(`could not back up vault-config.md to ${segmentDir}: it resolves outside the backups folder. vault-config.md was left unchanged.`, {
      path: segmentDir,
      campaign,
    });
  }

  const realVault = fs.realpathSync(vaultPath);
  if (packwrite.isInsideOrEqual(realVault, realSegmentDir)) {
    throw new BackupError(`could not back up vault-config.md to ${segmentDir}: it is inside the vault. vault-config.md was left unchanged.`, {
      path: segmentDir,
      campaign,
    });
  }

  const stamp = stampFor(now);
  const hex6 = crypto.randomBytes(3).toString('hex');
  const name = `vault-config-${stamp}-${hex6}.md.bak`;
  const finalPath = path.join(segmentDir, name);
  const tmp = path.join(segmentDir, `.${name}.scriptorium-tmp`);

  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, finalPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: the underlying error is what gets reported either way.
      }
    }
    removeTempBestEffort(tmp);
    throw new BackupError(`could not back up vault-config.md to ${segmentDir}: ${err.code || err.message}. vault-config.md was left unchanged.`, {
      path: segmentDir,
      campaign,
      cause: err,
    });
  }

  return { path: finalPath, dir: segmentDir };
}

/**
 * Never throws. Lists the segment directory's direct children only; keeps names matching
 * BACKUP_NAME_RE whose lstat is a regular file (a foreign file or a symlink is left alone and
 * never counted), sorted by name descending (the stamp sorts lexically = chronologically), and
 * unlinks anything beyond `keep`, each removal in its own try/catch.
 *
 * @param {{ machineDir: string, campaign: string|null, keep?: number }} opts
 */
function pruneBackups({ machineDir, campaign, keep = BACKUP_KEEP }) {
  const dir = backupDirFor(machineDir, campaign);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  const backups = [];
  for (const name of entries) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    let st;
    try {
      st = fs.lstatSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    backups.push(name);
  }
  backups.sort().reverse();

  for (const name of backups.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // swallowed deliberately: a prune failure must never fail the save (CLAUDE.md, src/build/run.js).
    }
  }
}

/**
 * @param {{ machineDir: string, campaign: string|null, vaultPath: string, bytes: Buffer, now?: () => number }} opts
 * @returns {{ path: string, dir: string }}
 * @throws {BackupError}
 */
function backupThenPrune(opts) {
  const result = writeBackup(opts);
  try {
    pruneBackups({ machineDir: opts.machineDir, campaign: opts.campaign });
  } catch {
    // swallowed: pruneBackups itself never throws, but this stays defensive (same pattern).
  }
  return result;
}

const NOT_PLAIN_REASON = "The backups folder for this campaign isn't a plain folder, so the panel won't read it.";

function ioReason(err) {
  return `GM-Scriptorium could not read the backups folder: ${err.code}.`;
}

/** The ISO-8601 moment a backup's own stamp encodes, or null if `name` doesn't match BACKUP_NAME_RE. */
function takenAtFor(name) {
  const m = /^vault-config-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
}

/**
 * V1e-9 (SD-93): never throws. Lists exactly the segment directory's own regular-file entries
 * matching BACKUP_NAME_RE (a foreign name, or a symlink whether or not its name matches, is
 * excluded), newest first by name (the stamp sorts lexically = chronologically).
 *
 * @param {{ machineDir: string, campaign: string|null, vaultPath: string }} opts
 * @returns {{ ok: true, dir: string, items: { id: string, takenAt: string, size: number }[] } |
 *   { ok: false, reason: string }}
 */
function listBackups({ machineDir, campaign, vaultPath }) {
  const backupsDir = path.join(machineDir, BACKUPS_DIRNAME);
  const segmentDir = backupDirFor(machineDir, campaign);
  const segment = campaignSegment(campaign);

  let lst;
  try {
    lst = fs.lstatSync(segmentDir);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, dir: segmentDir, items: [] };
    return { ok: false, reason: ioReason(err) };
  }
  // A symlink's own lstat never reports isDirectory() true (lstat does not follow it), so a
  // symlinked segment dir is refused here regardless of what it points at.
  if (!lst.isDirectory()) {
    return { ok: false, reason: NOT_PLAIN_REASON };
  }

  let realSegment;
  let realBackupsDir;
  let realMachineDir;
  try {
    realSegment = fs.realpathSync(segmentDir);
    realBackupsDir = fs.realpathSync(backupsDir);
    realMachineDir = fs.realpathSync(machineDir);
  } catch (err) {
    return { ok: false, reason: ioReason(err) };
  }
  // The writer's own rule (writeBackup above, :74-81): segmentDir must resolve to exactly
  // backupsDir/<segment>. Strengthened here with a second anchor -- backupsDir itself must
  // resolve to exactly machineDir/BACKUPS_DIRNAME -- because the first identity alone still
  // holds even when BACKUPS_DIRNAME itself has been swapped for a symlink to an ancestor
  // (machineDir, or further up): both sides of that one check still agree with each other in
  // that case, so a listing could otherwise walk a directory that was never really "the backups
  // folder" at all.
  if (
    fold(realSegment) !== fold(path.join(realBackupsDir, segment)) ||
    fold(realBackupsDir) !== fold(path.join(realMachineDir, BACKUPS_DIRNAME))
  ) {
    return { ok: false, reason: NOT_PLAIN_REASON };
  }

  let realVault;
  try {
    realVault = fs.realpathSync(vaultPath);
  } catch (err) {
    return { ok: false, reason: ioReason(err) };
  }
  if (packwrite.isInsideOrEqual(realVault, realSegment)) {
    return { ok: false, reason: "The backups folder for this campaign is inside the vault, so the panel won't read it." };
  }

  let entries;
  try {
    entries = fs.readdirSync(segmentDir);
  } catch (err) {
    return { ok: false, reason: ioReason(err) };
  }

  const items = [];
  for (const name of entries) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    let st;
    try {
      st = fs.lstatSync(path.join(segmentDir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue; // a symlink (even with a valid name) is excluded
    items.push({ id: name, takenAt: takenAtFor(name), size: st.size });
  }
  items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  return { ok: true, dir: segmentDir, items };
}

/**
 * V1e-9 (SD-93): reads one backup's whole bytes. Outside the vault, so this uses plain fs (the
 * loadSiteConfig precedent), never src/vault/read.js.
 *
 * @param {{ machineDir: string, campaign: string|null, vaultPath: string, id: string }} opts
 * @returns {Buffer}
 * @throws {BackupNotListedError} `id` doesn't regex-match, or isn't an exact member of a FRESH listing
 * @throws {BackupTooLargeError} the file is over BACKUP_MAX_BYTES
 * @throws {BackupError} any other read failure
 */
function readBackup({ machineDir, campaign, vaultPath, id }) {
  if (typeof id !== 'string' || !BACKUP_NAME_RE.test(id)) {
    throw new BackupNotListedError('That backup is not in the list. Reload the backups.');
  }
  // Through module.exports (self-reference), not the bare local function: a test can inject a
  // stale listing here deterministically, to simulate a backup swapped to a symlink in the
  // narrow window between this very re-check and the fs.openSync below (the TOCTOU O_NOFOLLOW
  // exists for).
  const list = module.exports.listBackups({ machineDir, campaign, vaultPath });
  if (!list.ok || !list.items.some((i) => i.id === id)) {
    throw new BackupNotListedError('That backup is not in the list. Reload the backups.');
  }

  const target = path.join(list.dir, id);
  let fd;
  try {
    // O_NOFOLLOW (POSIX only; 0 on platforms without it, e.g. Windows -- a documented residual,
    // ADR 0041 "will not catch") refuses to open the final path component if it is a symlink,
    // closing the TOCTOU window between listBackups' own lstat and this open.
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (err) {
    throw new BackupError(`could not read that backup: ${err.code}.`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new BackupError('could not read that backup: not a regular file.');
    }
    if (st.size > BACKUP_MAX_BYTES) {
      throw new BackupTooLargeError("That backup is larger than 4 MiB, so the panel won't restore it.");
    }
    const buf = Buffer.alloc(st.size);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
    }
    return buf.subarray(0, total);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // best-effort only, following the run.js swallowed-cleanup pattern
    }
  }
}

module.exports = {
  BACKUP_KEEP,
  BACKUP_MAX_BYTES,
  BACKUP_NAME_RE,
  BackupError,
  BackupNotListedError,
  BackupTooLargeError,
  backupDirFor,
  writeBackup,
  pruneBackups,
  backupThenPrune,
  listBackups,
  readBackup,
};
