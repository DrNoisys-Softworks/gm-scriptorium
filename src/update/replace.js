'use strict';

const fs = require('fs');
const path = require('path');
const { ScriptoriumError } = require('../util/errors');
// src/util/notices.js requires only fs and path (verified): importing NOTICES_FILENAME here
// cannot pull src/vault or src/build into src/update/'s module graph.
const { NOTICES_FILENAME } = require('../util/notices');

/*
 * Self-replacement on Windows (Engineering Brief section 6): a running
 * executable cannot be deleted or overwritten, but CAN be renamed within
 * its own directory. The downloaded temp file must already be in the same
 * directory as the running executable (same directory implies same
 * volume, so this rename can never hit EXDEV).
 */

/**
 * @param {string} currentExePath absolute path to the currently-running executable
 * @param {string} newExePath absolute path to the verified, downloaded replacement (same directory)
 * @param {string} oldVersion
 * @returns {{ oldPath: string }}
 * @throws {ScriptoriumError} leaving the old binary intact and working on any failure
 */
function replaceExecutable(currentExePath, newExePath, oldVersion) {
  if (path.dirname(currentExePath) !== path.dirname(newExePath)) {
    throw new ScriptoriumError('update replacement must be staged in the same directory as the running executable');
  }
  const oldPath = `${currentExePath}.old-${oldVersion}`;

  try {
    fs.renameSync(currentExePath, oldPath);
  } catch (err) {
    throw new ScriptoriumError(`could not rename the running executable aside: ${err.message}. Nothing changed.`);
  }

  // P5a-FR06: the staged file gets mode 0755 before the swap, not after -- so the file that
  // lands at currentExePath is never, even momentarily, non-executable. Grouped in the same
  // try/catch as the rename below: a chmod failure gets the identical rollback (the old
  // binary renamed back into place) as a rename failure would, because at this point the old
  // binary is already moved aside and something has to be done either way.
  try {
    fs.chmodSync(newExePath, 0o755);
    fs.renameSync(newExePath, currentExePath);
  } catch (err) {
    try {
      fs.renameSync(oldPath, currentExePath);
    } catch (rollbackErr) {
      throw new ScriptoriumError(
        `update failed (${err.message}) and rollback also failed (${rollbackErr.message}). ` +
          `Recover manually: move "${oldPath}" back to "${currentExePath}".`,
      );
    }
    throw new ScriptoriumError(`could not move the new executable into place: ${err.message}. Rolled back; the old binary still runs.`);
  }

  return { oldPath };
}

/** Sweeps `<exe>.old-*` at the start of every command (the process may still be executing from one). Ignores failures. */
function sweepOldExecutables(exeDir, exeName) {
  let entries;
  try {
    entries = fs.readdirSync(exeDir);
  } catch {
    return;
  }
  const prefix = `${exeName}.old-`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      fs.unlinkSync(path.join(exeDir, entry));
    } catch {
      // still executing from it, or otherwise locked: leave it, try again next run
    }
  }
}

/*
 * Issue #24: two more orphan classes `sweepOldExecutables` above does not touch, both left behind
 * by an `update` that never reached its own happy-path cleanup (a thrown verify/replace error, or
 * a hard kill mid-download): the download's temp dir under the OS temp root, and a staged,
 * full-size replacement executable copied beside the running one. Both are swept at the START of
 * the next run (`src/cli/update.js`, alongside the call to `sweepOldExecutables` above), because
 * neither can be cleaned up by a `finally` in the run that leaked them -- a hard kill runs no
 * `finally` at all.
 *
 * The guard is ownership by live pid, not a blind sweep or a bare age threshold: a blind sweep
 * would delete a concurrently running `update`'s in-flight download, and an age threshold alone
 * degenerates the moment the holder is SIGKILLed, which is the main case this exists for.
 *
 * Why the two arms use different mechanisms, so they are never "unified" later:
 * - The temp DIRECTORY can hold an owner-marker FILE inside it
 *   (`OWNER_MARKER_FILENAME`, written right after `mkdtempSync`), because Scriptorium controls
 *   every file under it.
 * - The staged EXECUTABLE is a raw copy of someone else's binary (the downloaded release asset).
 *   Writing a marker inside it would mean editing that binary, which is exactly the kind of
 *   surprise byte this project does not want to introduce into something about to become the
 *   running executable. So its ownership goes in the filename instead
 *   (`stagedExecutableName`: `<exeName>-update-<pid>-<timestamp>.tmp`).
 *
 * What this sweep will not catch (residual limits, written down rather than left for the next
 * person to rediscover by testing):
 *
 * - An orphan survives until the NEXT `update` run. A user who never updates again keeps it
 *   forever. Same structural limit as `sweepStaleSiblings` (src/build/swap.js).
 * - Pid reuse: a dead Scriptorium's pid reassigned to an unrelated live process makes the sweep
 *   skip that orphan permanently. The direction of error is safe (a leak, not a wrongful delete
 *   of someone else's live work), but it is permanent, and no mitigation was chosen -- an age
 *   threshold on TOP of a live marker would reintroduce the exact SIGKILL-degenerates-to-age-alone
 *   problem the marker exists to avoid.
 * - `os.tmpdir()` resolving differently between the run that leaked and the run that sweeps: a
 *   different `TEMP`, a different user, or a service context versus an interactive session. This
 *   is a live Windows case; `docs/HANDOVER-WINDOWS.md` C20 already documents the same
 *   session-context problem for mapped drives.
 * - A different user's directory in a shared temp root: `rmSync`/`unlinkSync` fails EPERM,
 *   swallowed, retried next run.
 * - An artefact held open by antivirus or a file indexer: `unlinkSync` throws, swallowed, retried
 *   next run.
 * - A directory or file from another tool that happens to match `scriptorium-update-*` (temp-dir
 *   arm) or `<exeName>-update-*` (staged-executable arm) would be removed. Accepted: the prefixes
 *   are namespaced to this project.
 */

const UPDATE_TMP_PREFIX = 'scriptorium-update-';
const OWNER_MARKER_FILENAME = '.scriptorium-update-owner';
const LEGACY_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @param {number} pid
 * @returns {boolean} true if `pid` names a live process, including one owned by another user
 *   (EPERM: the process exists but this user cannot signal it, which still means it is alive).
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** @returns {string} `<exeName>-update-<pid>-<timestamp>.tmp`, the staged-executable filename shape this sweep owns. */
function stagedExecutableName(exeName, pid, timestamp) {
  return `${exeName}-update-${pid}-${timestamp}.tmp`;
}

function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sweeps stale `scriptorium-update-*` directories under `tmpRoot` left behind by an `update` that
 * never reached its own cleanup (Issue #24). Directories only, matched via `withFileTypes`, so an
 * unrelated file whose name happens to match is never recursively removed.
 *
 * @param {string} tmpRoot
 * @param {{ isProcessAlive?: (pid: number) => boolean, minLegacyAgeMs?: number, now?: () => number }} [opts]
 * @returns {void} never throws; every filesystem failure is swallowed and retried on the next run
 */
function sweepStaleUpdateDirs(tmpRoot, { isProcessAlive: checkAlive = isProcessAlive, minLegacyAgeMs = LEGACY_MIN_AGE_MS, now = Date.now } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(UPDATE_TMP_PREFIX)) continue;
    const dirPath = path.join(tmpRoot, entry.name);

    let markerPid = null;
    try {
      const raw = fs.readFileSync(path.join(dirPath, OWNER_MARKER_FILENAME), 'utf8').trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isInteger(parsed)) markerPid = parsed;
    } catch {
      // marker absent (or unreadable): treated the same as absent, below.
    }

    if (markerPid !== null) {
      let alive;
      try {
        alive = checkAlive(markerPid);
      } catch {
        alive = true; // uncertain: skip, the safe direction
      }
      if (alive) continue; // a concurrent update, or a pid-reuse false positive: skip
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // still locked, EPERM, or otherwise unremovable: leave it, try again next run
      }
      continue;
    }

    // No marker: a directory left by 0.2.2 or earlier (exactly what this sweep exists to catch),
    // or the sub-millisecond window between mkdtempSync and the marker write in a concurrent
    // new-version run. Age-gate rather than remove immediately: 24h clears the first case and can
    // never touch the second.
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(dirPath).mtimeMs;
    } catch {
      continue; // gone already, or unreadable: nothing to do
    }
    if (now() - mtimeMs < minLegacyAgeMs) continue;
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // still locked, EPERM, or otherwise unremovable: leave it, try again next run
    }
  }
}

/**
 * Sweeps stale staged-executable `.tmp` files beside the running executable, left behind by an
 * `update` that never reached its own cleanup (Issue #24). Recognises two mutually exclusive,
 * anchored, digits-only shapes: the new `<exeName>-update-<pid>-<timestamp>.tmp`
 * (`stagedExecutableName`) and the legacy (0.2.2 and earlier) `<exeName>-update-<timestamp>.tmp`.
 *
 * Deliberately not the unconditional `.old-*` policy `sweepOldExecutables` uses above:
 * `sweepOldExecutables` is safe because Windows locks a RUNNING executable; a staged `.tmp` copy
 * is not executing, so file locking protects nothing here.
 *
 * @param {string} exeDir
 * @param {string} exeName
 * @param {{ isProcessAlive?: (pid: number) => boolean, minLegacyAgeMs?: number, now?: () => number }} [opts]
 * @returns {void} never throws; every filesystem failure is swallowed and retried on the next run
 */
function sweepStaleStagedExecutables(
  exeDir,
  exeName,
  { isProcessAlive: checkAlive = isProcessAlive, minLegacyAgeMs = LEGACY_MIN_AGE_MS, now = Date.now } = {},
) {
  let entries;
  try {
    entries = fs.readdirSync(exeDir);
  } catch {
    return;
  }

  const escapedName = escapeForRegex(exeName);
  const newShapeRe = new RegExp(`^${escapedName}-update-(\\d+)-(\\d+)\\.tmp$`);
  const legacyShapeRe = new RegExp(`^${escapedName}-update-(\\d+)\\.tmp$`);

  for (const entry of entries) {
    const filePath = path.join(exeDir, entry);

    const newMatch = entry.match(newShapeRe);
    if (newMatch) {
      const pid = Number.parseInt(newMatch[1], 10);
      let alive;
      try {
        alive = checkAlive(pid);
      } catch {
        alive = true; // uncertain: skip, the safe direction
      }
      if (alive) continue; // a concurrent update, or a pid-reuse false positive: skip
      try {
        fs.unlinkSync(filePath);
      } catch {
        // still locked, EPERM, or otherwise unremovable: leave it, try again next run
      }
      continue;
    }

    if (!legacyShapeRe.test(entry)) continue;
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue; // gone already, or unreadable: nothing to do
    }
    if (now() - mtimeMs < minLegacyAgeMs) continue;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // still locked, EPERM, or otherwise unremovable: leave it, try again next run
    }
  }
}

/*
 * Issue #26: `update`'s success path deletes THIRD-PARTY-NOTICES.txt beside the executable, so a
 * stale (old-version) copy is never left silently claiming to describe the new binary --
 * `deliverNotices()` (`src/util/notices.js`) rewrites it on the very next `--version`. Confined to
 * the success path only (`src/cli/update.js`, after `replaceExecutable` returns): on every
 * FAILURE path the old binary is still the one on disk, and its notices file is still an accurate
 * description of it, so deleting it there would destroy correct information for no reason. See
 * `docs/decisions/0011-notices-beside-the-executable.md`.
 */

/**
 * @param {string} text
 * @returns {boolean} true if `text` looks like a Scriptorium-generated notices file (the
 *   section-0 title and a version stamp), not merely a same-named file dropped there by
 *   something else. A filename match alone is not sufficient authority to delete a file in the
 *   user's own program folder.
 */
function looksLikeScriptoriumNotices(text) {
  return text.includes('Scriptorium: Third-Party Notices') && /^Scriptorium version: /m.test(text);
}

/**
 * Best-effort delete of THIRD-PARTY-NOTICES.txt beside the executable, scoped to Scriptorium's
 * own file (see `looksLikeScriptoriumNotices` above): a same-named file without the recognisable
 * header and version stamp is left untouched.
 *
 * @param {string} exeDir
 * @returns {boolean} true only if a recognised notices file was actually removed; false if
 *   absent, unrecognised, or the removal itself failed. Never throws; every filesystem failure is
 *   treated as "nothing to report".
 */
function discardNoticesBesideExecutable(exeDir) {
  const noticesPath = path.join(exeDir, NOTICES_FILENAME);
  let text;
  try {
    text = fs.readFileSync(noticesPath, 'utf8');
  } catch {
    return false; // absent, or unreadable: nothing to discard
  }
  if (!looksLikeScriptoriumNotices(text)) return false; // not recognisably ours: leave it alone
  try {
    fs.unlinkSync(noticesPath);
    return true;
  } catch {
    return false; // still locked, EPERM, or otherwise unremovable: leave it, retried next successful update
  }
}

module.exports = {
  replaceExecutable,
  sweepOldExecutables,
  UPDATE_TMP_PREFIX,
  OWNER_MARKER_FILENAME,
  LEGACY_MIN_AGE_MS,
  isProcessAlive,
  stagedExecutableName,
  sweepStaleUpdateDirs,
  sweepStaleStagedExecutables,
  discardNoticesBesideExecutable,
};
