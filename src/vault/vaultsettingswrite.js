'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ConfigError, ScriptoriumError } = require('../util/errors');
const { platformFoldsCase } = require('./exclusions');
const { RETRY_DELAYS_MS } = require('../build/swap');

/*
 * The guarded write of exactly <vault>/_meta/vault-config.yaml, the settings file of a vault whose
 * settings gm-apprentice moved out of vault-config.md. A sibling of src/vault/vaultconfigwrite.js
 * (the vault-config.md writer), and like it a chokepoint of its own: only the panel's settings
 * handlers reach it, and check and build never do.
 *
 * It never imports vaultconfigwrite.js, packreplace.js or packwrite.js (ADR 0033 section 4). The
 * retry loop below is a deliberate structural copy of the one in vaultconfigwrite.js, which is
 * itself a copy of packreplace.js's. It is copied rather than shared because the chokepoints must
 * never import from one another. This loop adds one step the md loop lacks: it lstats the target
 * before every attempt, so a file swapped for a link between the first look and the rename is
 * refused.
 */

/** Thrown when the on-disk file no longer matches what the caller last read, or was never there. */
class VaultSettingsChangedError extends ConfigError {}

/** Never ends in ".yaml": the reader and check never mistake a temp file for the settings. */
const TMP_PREFIX = '.scriptorium-tmp-vault-settings-';

/** Only these three codes are worth a bounded wait; everything else fails immediately. */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const CHANGED = 'vault-config.yaml changed outside the panel. Reload before saving.';

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Best-effort temp cleanup, the single call site the structural scan expects. */
function removeTempBestEffort(tmp) {
  try {
    fs.unlinkSync(tmp);
  } catch {
    // swallowed deliberately: the caller's own error already explains what went wrong.
  }
}

function tmpNameFor() {
  return `${TMP_PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

function realpathOrThrow(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    throw new ScriptoriumError(`could not resolve ${p}: ${err.code || err.message}`, { path: p, cause: err });
  }
}

function fold(s) {
  return platformFoldsCase() ? s.toLowerCase() : s;
}

/**
 * Only a retryable code (a lock that outlasted every wait) hints at another program holding the
 * file. Any other code, such as EXDEV, is reported as it is.
 */
function replaceFailedMessage(target, code) {
  const hint = RETRYABLE_CODES.has(code) ? ' Another program may have it open.' : '';
  return `could not replace ${target}: ${code}.${hint} vault-config.yaml was left unchanged.`;
}

/** The fixed target: no request ever supplies a name. */
function targetPathFor(vaultPath) {
  return path.join(vaultPath, '_meta', 'vault-config.yaml');
}

/**
 * Read-only: reused by the handler before any read.
 *
 * @param {string} vaultPath
 * @param {{ campaign?: string|null }} [opts]
 * @returns {{ target: string, realMeta: string }}
 * @throws {VaultSettingsChangedError} the file does not exist (it is never created here)
 * @throws {ConfigError} a linked, escaped or misplaced target or _meta
 * @throws {ScriptoriumError} a path could not be resolved at all
 */
function checkTarget(vaultPath, { campaign = null } = {}) {
  const target = targetPathFor(vaultPath);
  const realVaultPath = realpathOrThrow(vaultPath);

  // _meta must resolve to exactly <realVault>/_meta: a link is refused even when it points inside
  // the vault, because that is still not the file's real home.
  const metaPath = path.join(vaultPath, '_meta');
  const realMeta = realpathOrThrow(metaPath);
  if (fold(realMeta) !== fold(path.join(realVaultPath, '_meta'))) {
    throw new ConfigError(`refusing to edit vault-config.yaml: ${metaPath} resolves outside the vault (${realMeta})`, {
      path: metaPath,
      campaign,
    });
  }

  // No vault-config.md check: a leftover md beside the yaml is still the new layout.
  let lst;
  try {
    lst = fs.lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new VaultSettingsChangedError(CHANGED, { path: target, campaign });
    }
    throw new ScriptoriumError(`could not read ${target}: ${err.code}. vault-config.yaml was left unchanged.`, {
      path: target,
      campaign,
      cause: err,
    });
  }
  if (!lst.isFile() || lst.isSymbolicLink()) {
    throw new ConfigError(`refusing to edit ${target}: it is not a regular file`, { path: target, campaign });
  }

  const realTargetDir = path.dirname(realpathOrThrow(target));
  if (fold(realTargetDir) !== fold(realMeta)) {
    throw new ConfigError(`refusing to edit ${target}: it resolves outside _meta (${realTargetDir})`, {
      path: target,
      campaign,
    });
  }

  return { target, realMeta };
}

/**
 * @param {string} vaultPath
 * @param {Buffer} candidateBytes the whole file's replacement bytes, preserved exactly
 * @param {{ expectedSha256: string, backup: (current: Buffer) => any, campaign?: string|null, sleep?: (ms:number)=>void }} opts
 * @returns {{ path: string, sha256: string, backup: any }}
 * @throws {ScriptoriumError} bad arguments, or an unrecoverable I/O failure
 * @throws {VaultSettingsChangedError} the target changed since expectedSha256 was taken, or is missing
 * @throws {ConfigError} a refusal from checkTarget, or a target that is not a regular file
 */
function replaceVaultSettingsYaml(vaultPath, candidateBytes, { expectedSha256, backup, campaign = null, sleep = sleepSync } = {}) {
  if (!Buffer.isBuffer(candidateBytes) || typeof backup !== 'function') {
    throw new ScriptoriumError(
      'replaceVaultSettingsYaml: candidateBytes must be a Buffer and backup must be a function (programming error)',
      { campaign },
    );
  }

  const { target } = checkTarget(vaultPath, { campaign });

  let precheckBuf;
  try {
    precheckBuf = fs.readFileSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') throw new VaultSettingsChangedError(CHANGED, { path: target, campaign });
    throw new ScriptoriumError(`could not read ${target}: ${err.code}. vault-config.yaml was left unchanged.`, {
      path: target,
      campaign,
      cause: err,
    });
  }
  if (sha256Hex(precheckBuf) !== expectedSha256) {
    throw new VaultSettingsChangedError(CHANGED, { path: target, campaign });
  }

  // The backup gets the current bytes, before any temp file exists. A throw propagates as it is.
  const backupResult = backup(precheckBuf);

  const tmp = path.join(path.dirname(target), tmpNameFor());
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, candidateBytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: the open/write/fsync error below is what gets reported either way.
      }
    }
    removeTempBestEffort(tmp);
    throw new ScriptoriumError(`could not replace ${target}: ${err.code || err.message}. vault-config.yaml was left unchanged.`, {
      path: target,
      campaign,
      cause: err,
    });
  }

  // The bounded rename loop: a structural copy of vaultconfigwrite.js's (see the header), plus an
  // lstat before every attempt.
  const maxAttempts = RETRY_DELAYS_MS.length + 1;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;

    let liveBuf;
    try {
      const lst = fs.lstatSync(target);
      if (!lst.isFile() || lst.isSymbolicLink()) {
        removeTempBestEffort(tmp);
        throw new ConfigError(`refusing to edit ${target}: it is not a regular file`, { path: target, campaign });
      }
      liveBuf = fs.readFileSync(target);
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      if (!isLastAttempt && RETRYABLE_CODES.has(err.code)) {
        sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      removeTempBestEffort(tmp);
      // A yaml that vanished since the first look was changed outside the panel: the same 409 as a
      // hash mismatch, never a generic I/O failure.
      if (err.code === 'ENOENT') throw new VaultSettingsChangedError(CHANGED, { path: target, campaign });
      throw new ScriptoriumError(replaceFailedMessage(target, err.code), { path: target, campaign, cause: err });
    }

    if (sha256Hex(liveBuf) !== expectedSha256) {
      removeTempBestEffort(tmp);
      throw new VaultSettingsChangedError(CHANGED, { path: target, campaign });
    }

    try {
      fs.renameSync(tmp, target);
      return { path: target, sha256: sha256Hex(candidateBytes), backup: backupResult };
    } catch (err) {
      lastErr = err;
      if (!isLastAttempt && RETRYABLE_CODES.has(err.code)) {
        sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    }
  }

  removeTempBestEffort(tmp);
  throw new ScriptoriumError(replaceFailedMessage(target, lastErr.code), { path: target, campaign, cause: lastErr });
}

module.exports = {
  VaultSettingsChangedError,
  TMP_PREFIX,
  RETRYABLE_CODES,
  targetPathFor,
  checkTarget,
  replaceVaultSettingsYaml,
};
