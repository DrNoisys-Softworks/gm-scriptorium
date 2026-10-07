'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ConfigError, ScriptoriumError } = require('../util/errors');
// isInsideOrEqual called through the module object (packwrite.isInsideOrEqual), not
// destructured, so a test can patch it to simulate a separator-boundary regression
// deterministically, without editing packwrite.js itself (same reason
// src/admin/handlers/pack.js calls packwrite.createPackEntries the same way).
const packwrite = require('./packwrite');
const { packDirFor } = packwrite;
const { RETRY_DELAYS_MS } = require('../build/swap');
// The same case-folding primitive isInsideOrEqual itself uses (src/vault/packwrite.js:40),
// reused directly for step 5's exact-directory compare below rather than a new fold strategy.
const { platformFoldsCase } = require('./exclusions');

/*
 * Phase 8 slice S3 (P8-D01's default, SD-1 through SD-4): the panel's only edit path for an
 * EXISTING pack file. This is a second, narrower chokepoint deliberately kept separate from
 * src/vault/packwrite.js: packwrite.js stays create-only (its own `wx` writes, PW14's structural
 * scan, and PW1-PW15 all stay untouched, comments included), and this module never creates or
 * deletes a real pack file -- only replaces one, atomically, in place. Creating a missing
 * pack.toml still goes through packwrite.js's createPackEntries (FR22).
 *
 * The rejected alternative (amending packwrite.js's PW14 so it can rename) is recorded in
 * docs/decisions/0022-gm-admin-panel.md section 6, alongside the reasoning below.
 */

/** Thrown when the on-disk file no longer matches what the caller last read. */
class PackChangedError extends ConfigError {}

/** SD-4: a fixed allowlist, matched in exact case. Nothing else can ever be named here. */
const REPLACEABLE_FILES = Object.freeze(['pack.toml', 'vault.config.json']);

/** SD-2: only these three codes are worth a bounded wait; everything else fails immediately. */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/*
 * Copied verbatim from src/build/swap.js:26-30 (not exported there). SD-2 rejects reusing
 * renameWithRetry itself -- it retries codes that will never succeed and has no per-attempt sha
 * check -- but this exact four-line synchronous wait is the one piece worth reusing as-is. Kept
 * as a plain function (not the module default) so a test can inject its own in `sleep`.
 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Best-effort temp cleanup, the single call site the structural scan expects. If the temp was
 * never created, or removing it also fails, there is nothing more useful to do here: the
 * caller's own error already explains what went wrong.
 */
function removeTempBestEffort(tmp) {
  try {
    fs.unlinkSync(tmp);
  } catch {
    // swallowed deliberately -- see the doc comment above.
  }
}

function tmpNameFor(name) {
  return `.${name}.scriptorium-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

function realpathOrThrow(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    throw new ScriptoriumError(`could not resolve ${p}: ${err.code || err.message}`, { path: p, cause: err });
  }
}

/**
 * @param {string} vaultPath absolute, already through locateVault
 * @param {'pack.toml'|'vault.config.json'} name
 * @param {string} data the full replacement text, LF-only, no BOM
 * @param {{ expectedSha256?: string|null, campaign?: string|null, sleep?: (ms:number)=>void }} [opts]
 * @returns {{ path: string, sha256: string }}
 * @throws {ConfigError} a refusal (name, symlink, non-regular target, containment escape)
 * @throws {PackChangedError} the target changed since expectedSha256 was taken
 * @throws {ScriptoriumError} an unrecoverable I/O failure; the file is left unchanged
 */
function replacePackFile(vaultPath, name, data, { expectedSha256, campaign = null, sleep = sleepSync } = {}) {
  // 1. Name.
  if (!REPLACEABLE_FILES.includes(name)) {
    throw new ConfigError(
      `refusing to replace "${name}" in the campaign pack: only pack.toml and vault.config.json can be edited`,
      { campaign },
    );
  }

  // 2. Data: a programming error, not a user-facing refusal.
  if (typeof data !== 'string' || data.startsWith('﻿') || data.includes('\r')) {
    throw new ScriptoriumError(
      'replacePackFile: data must be an LF-only string with no leading byte-order mark (programming error)',
      { campaign },
    );
  }

  // 3. _meta and the pack dir must both resolve inside the vault.
  const realVaultPath = realpathOrThrow(vaultPath);
  const metaPath = path.join(vaultPath, '_meta');
  const realMeta = realpathOrThrow(metaPath);
  if (!packwrite.isInsideOrEqual(realVaultPath, realMeta)) {
    throw new ConfigError(`refusing to write the campaign pack: ${metaPath} resolves outside the vault (${realMeta})`, {
      path: metaPath,
      campaign,
    });
  }
  // Issue #80: resolving to the vault root itself is not "inside" it.
  if (!packwrite.isStrictlyInside(realVaultPath, realMeta)) {
    throw new ConfigError(
      `refusing to write the campaign pack: ${metaPath} resolves to the vault root, not inside it (${realMeta})`,
      { path: metaPath, campaign },
    );
  }
  const packDir = packDirFor(vaultPath);
  const realPackDir = realpathOrThrow(packDir);
  if (!packwrite.isInsideOrEqual(realVaultPath, realPackDir)) {
    throw new ConfigError(`refusing to write the campaign pack: ${packDir} resolves outside the vault (${realPackDir})`, {
      path: packDir,
      campaign,
    });
  }
  if (!packwrite.isStrictlyInside(realVaultPath, realPackDir)) {
    throw new ConfigError(
      `refusing to write the campaign pack: ${packDir} resolves to the vault root, not inside it (${realPackDir})`,
      { path: packDir, campaign },
    );
  }

  const target = path.join(packDir, name);

  // 4. The target itself: a regular file, not a symlink.
  let lst;
  try {
    lst = fs.lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PackChangedError(`${name} changed outside the panel. Reload before saving.`, { path: target, campaign });
    }
    throw new ScriptoriumError(`could not read ${target}: ${err.code}. The file was left unchanged.`, {
      path: target,
      campaign,
      cause: err,
    });
  }
  if (!lst.isFile() || lst.isSymbolicLink()) {
    throw new ConfigError(`refusing to replace ${target}: it is not a regular file`, { path: target, campaign });
  }

  // 5. Target containment: re-derived independently of step 3, and re-derived as an EXACT
  // directory match, not "inside or equal" the way step 3's own checks are. REPLACEABLE_FILES
  // names are always slash-free and `target` is always literally `path.join(packDir, name)`, so
  // under any real, non-adversarial call the two resolutions can only ever coincide exactly --
  // a genuine descendant (the target's own directory resolving to a SUBFOLDER of the pack dir)
  // is never reachable through this module's own call shape, and accepting it would only widen
  // the TOCTOU residual for no benefit any legitimate caller could ever see. Folded the same way
  // isInsideOrEqual folds, reusing platformFoldsCase() directly rather than a new fold strategy,
  // so a case-differing but equivalent path (Windows, macOS) is still accepted.
  const fold = (s) => (platformFoldsCase() ? s.toLowerCase() : s);
  const realTargetDir = path.dirname(realpathOrThrow(target));
  if (fold(realTargetDir) !== fold(realPackDir)) {
    throw new ConfigError(`refusing to replace ${target}: it resolves outside the campaign pack (${realTargetDir})`, {
      path: target,
      campaign,
    });
  }

  // 6. Precondition read: no retry here, by design (SD-2's residual TOCTOU window opens after
  // this point, and is what the rename loop's own re-check narrows).
  let precheckBuf;
  try {
    precheckBuf = fs.readFileSync(target);
  } catch (err) {
    throw new ScriptoriumError(`could not read ${target}: ${err.code}. The file was left unchanged.`, {
      path: target,
      campaign,
      cause: err,
    });
  }
  if (sha256Hex(precheckBuf) !== expectedSha256) {
    throw new PackChangedError(`${name} changed outside the panel. Reload before saving.`, { path: target, campaign });
  }

  // 7. SD-3: write a crash-safe temp file beside the target, inside the pack dir.
  const tmp = path.join(packDir, tmpNameFor(name));
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, data, null, 'utf8');
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
    throw new ScriptoriumError(`could not replace ${target}: ${err.code || err.message}. The file was left unchanged.`, {
      path: target,
      campaign,
      cause: err,
    });
  }

  // 8. The bounded rename loop: 1 attempt plus RETRY_DELAYS_MS.length retries (SD-2).
  const maxAttempts = RETRY_DELAYS_MS.length + 1;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;

    // Re-hash the target before every attempt, including the first: the window between the
    // precondition read (step 6) and this very first attempt is real, and on Windows the
    // program holding a lock is often the one about to write.
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
        `could not replace ${target}: ${err.code}. Another program may have it open. The file was left unchanged.`,
        { path: target, campaign, cause: err },
      );
    }

    if (sha256Hex(liveBuf) !== expectedSha256) {
      removeTempBestEffort(tmp);
      throw new PackChangedError(`${name} changed outside the panel. Reload before saving.`, { path: target, campaign });
    }

    try {
      fs.renameSync(tmp, target);
      return { path: target, sha256: sha256Hex(Buffer.from(data, 'utf8')) };
    } catch (err) {
      lastErr = err;
      if (!isLastAttempt && RETRYABLE_CODES.has(err.code)) {
        sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    }
  }

  // 9. Exhausted or a non-retryable code: clean up and report.
  removeTempBestEffort(tmp);
  throw new ScriptoriumError(
    `could not replace ${target}: ${lastErr.code}. Another program may have it open. The file was left unchanged.`,
    { path: target, campaign, cause: lastErr },
  );
}

module.exports = { PackChangedError, REPLACEABLE_FILES, RETRYABLE_CODES, replacePackFile };
