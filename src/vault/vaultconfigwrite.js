'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ConfigError, ScriptoriumError } = require('../util/errors');
const { platformFoldsCase } = require('./exclusions');
const { RETRY_DELAYS_MS } = require('../build/swap');

/*
 * V1e-1 (ADR 0033, SD-1): the third, narrow vault write -- exactly <vault>/_meta/vault-config.md,
 * only through this module. Deliberately kept separate from src/vault/packwrite.js (create-only)
 * and src/vault/packreplace.js (replaces only pack.toml/vault.config.json inside
 * _meta/scriptorium/, REPLACEABLE_FILES): widening either would either give packreplace's own
 * exact-pack-dir step a second directory to know about, or give packwrite's create-only chokepoint
 * a replace path it was never meant to have. See docs/decisions/0033-vaultconfig-write-exception.md.
 *
 * The retry loop below is a deliberate structural copy of packreplace.js's own bounded rename
 * retry (SD-2 there): same RETRYABLE_CODES, same per-attempt re-hash before every rename attempt
 * (including the first), same sleep injection seam. Copied rather than shared because the two
 * chokepoints must never import from one another (ADR 0033 section 4).
 */

/** Thrown when the on-disk file no longer matches what the caller last read, or was never there. */
class VaultConfigChangedError extends ConfigError {}

/** Never ends in ".md": readFrontmatter/check never mistake a temp file for real frontmatter. */
const TMP_PREFIX = '.scriptorium-tmp-vault-config-';

/** SD-1: only these three codes are worth a bounded wait; everything else fails immediately. */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Copied verbatim from src/vault/packreplace.js:45-49 (see that file's own comment). */
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

/** The fixed target: no request ever supplies a name (FR-01). */
function targetPathFor(vaultPath) {
  return path.join(vaultPath, '_meta', 'vault-config.md');
}

/**
 * Read-only (SD-1): reused by the handler before any read, so a dry run and the `?include=`
 * shape never read through a bad target either.
 *
 * @param {string} vaultPath
 * @param {{ campaign?: string|null }} [opts]
 * @returns {{ target: string, realMeta: string }}
 * @throws {VaultConfigChangedError} the file does not exist (it is never created here)
 * @throws {ConfigError} a symlinked/escaped/misplaced target or _meta
 * @throws {ScriptoriumError} a path could not be resolved at all
 */
function checkTarget(vaultPath, { campaign = null } = {}) {
  const target = targetPathFor(vaultPath);

  // 1. realVault = realpath(vaultPath).
  const realVaultPath = realpathOrThrow(vaultPath);

  // 2. _meta must resolve to EXACTLY <realVault>/_meta -- refuses outside, ancestor (the vault
  // root itself), prefix-sibling ("_meta-evil") and descendant targets in one rule (ADR 0022 §7
  // SD-4's exact-equality idiom, applied at the _meta level rather than packreplace's pack-dir
  // level). Stricter than packreplace's own isInsideOrEqual: a symlinked _meta is refused even
  // when it points somewhere inside the vault, because that is still not vault-config.md's real
  // home and would defeat the "ancestor" refusal in AC-01.
  const metaPath = path.join(vaultPath, '_meta');
  const realMeta = realpathOrThrow(metaPath);
  if (fold(realMeta) !== fold(path.join(realVaultPath, '_meta'))) {
    throw new ConfigError(`refusing to edit vault-config.md: ${metaPath} resolves outside the vault (${realMeta})`, {
      path: metaPath,
      campaign,
    });
  }

  // 3. lstat: ENOENT means the file is never created here; not a regular file (including a
  // symlink, which lstat never follows) is a refusal.
  let lst;
  try {
    lst = fs.lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new VaultConfigChangedError('vault-config.md changed outside the panel. Reload before saving.', {
        path: target,
        campaign,
      });
    }
    throw new ScriptoriumError(`could not read ${target}: ${err.code}. vault-config.md was left unchanged.`, {
      path: target,
      campaign,
      cause: err,
    });
  }
  if (!lst.isFile() || lst.isSymbolicLink()) {
    throw new ConfigError(`refusing to edit ${target}: it is not a regular file`, { path: target, campaign });
  }

  // 4. The target's own real directory must equal realMeta EXACTLY (folded), independent of
  // step 2's own check -- catches the target itself being replaced by a directory, or resolving
  // (via its own path segments) somewhere other than the _meta step 2 already accepted.
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
 * @param {Buffer} candidateBytes the whole file's replacement bytes, preserved exactly (may carry
 *   a BOM and CR: this is the whole file, not LF-only text the way packreplace's data is)
 * @param {{ expectedSha256: string, backup: (current: Buffer) => any, campaign?: string|null, sleep?: (ms:number)=>void }} opts
 * @returns {{ path: string, sha256: string, backup: any }}
 * @throws {ScriptoriumError} a programming error (bad arguments), or an unrecoverable I/O failure
 * @throws {VaultConfigChangedError} the target changed since expectedSha256 was taken, or does not exist
 * @throws {ConfigError} a refusal from checkTarget
 */
function replaceVaultConfigMd(vaultPath, candidateBytes, { expectedSha256, backup, campaign = null, sleep = sleepSync } = {}) {
  // 1. Arguments: a programming error, not a user-facing refusal.
  if (!Buffer.isBuffer(candidateBytes) || typeof backup !== 'function') {
    throw new ScriptoriumError(
      'replaceVaultConfigMd: candidateBytes must be a Buffer and backup must be a function (programming error)',
      { campaign },
    );
  }

  // 2. checkTarget: read-only, shared with the handler.
  const { target } = checkTarget(vaultPath, { campaign });

  // 3. Precondition read and sha: a mismatch throws before any backup or temp file.
  let precheckBuf;
  try {
    precheckBuf = fs.readFileSync(target);
  } catch (err) {
    throw new ScriptoriumError(`could not read ${target}: ${err.code}. vault-config.md was left unchanged.`, {
      path: target,
      campaign,
      cause: err,
    });
  }
  if (sha256Hex(precheckBuf) !== expectedSha256) {
    throw new VaultConfigChangedError('vault-config.md changed outside the panel. Reload before saving.', {
      path: target,
      campaign,
    });
  }

  // 4. Backup, unconditionally, with the CURRENT bytes -- before any temp file exists. Any throw
  // propagates as-is: the vault is untouched and there is no temp file to clean up.
  const backupResult = backup(precheckBuf);

  // 5. A crash-safe temp file beside the target, inside _meta, never ending in ".md".
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
    throw new ScriptoriumError(`could not replace ${target}: ${err.code || err.message}. vault-config.md was left unchanged.`, {
      path: target,
      campaign,
      cause: err,
    });
  }

  // 6. The bounded rename loop: verbatim copy of packreplace's structure (SD-1).
  const maxAttempts = RETRY_DELAYS_MS.length + 1;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;

    let liveBuf;
    try {
      liveBuf = fs.readFileSync(target);
    } catch (err) {
      if (!isLastAttempt && RETRYABLE_CODES.has(err.code)) {
        sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      removeTempBestEffort(tmp);
      throw new ScriptoriumError(
        `could not replace ${target}: ${err.code}. Another program may have it open. vault-config.md was left unchanged.`,
        { path: target, campaign, cause: err },
      );
    }

    if (sha256Hex(liveBuf) !== expectedSha256) {
      removeTempBestEffort(tmp);
      throw new VaultConfigChangedError('vault-config.md changed outside the panel. Reload before saving.', {
        path: target,
        campaign,
      });
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

  // 7. Exhausted or a non-retryable code: clean up and report.
  removeTempBestEffort(tmp);
  throw new ScriptoriumError(
    `could not replace ${target}: ${lastErr.code}. Another program may have it open. vault-config.md was left unchanged.`,
    { path: target, campaign, cause: lastErr },
  );
}

module.exports = {
  VaultConfigChangedError,
  TMP_PREFIX,
  RETRYABLE_CODES,
  targetPathFor,
  checkTarget,
  replaceVaultConfigMd,
};
