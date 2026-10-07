'use strict';

const fs = require('fs');
const path = require('path');
const { ScriptoriumError } = require('../util/errors');

/*
 * The atomic-ish build swap (Engineering Brief section 3, "The swap and
 * its Windows failure modes"):
 *
 *   1. if exists(finalOut): rename(finalOut, finalOut + ".scriptorium-old-<ts>")
 *   2.                      rename(staging/out, finalOut)
 *   3. best-effort:         rmdir -r finalOut + ".scriptorium-old-<ts>"
 *
 * A locked file / open handle makes a Windows rename throw EPERM/EBUSY/
 * EACCES. Retry is bounded: 5 attempts, backoff 100/200/400/800/1600ms.
 * If step 1 never succeeds, nothing changed and the old site is intact.
 * If step 2 fails after step 1 succeeded, roll back by renaming the old
 * directory back; if THAT also fails, this is the one moment the site
 * does not exist, and it must be reported loudly with both absolute paths
 * and the manual `move` command, never swallowed.
 */

const RETRY_DELAYS_MS = [100, 200, 400, 800, 1600];

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Best-effort diagnostic for a rename that failed with every retry
 * exhausted: walk `dir` (the rename's source, so every file it needs still
 * lives there) and return the relative path of the first file that cannot
 * even be opened for read+write, which is normally exactly what an
 * exclusive OS-level lock (Windows share-deny-write) leaves in that state.
 * This does not change WHY the rename failed, only tries to say WHICH file
 * inside blocked it, since "rename X -> Y failed: EBUSY" alone does not
 * tell someone holding a handle open which of possibly hundreds of staged
 * files is theirs. Never throws; returns null if nothing is found or `dir`
 * cannot even be walked.
 */
function findLockedFile(dir) {
  let found = null;
  (function walk(d, rel) {
    if (found) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found) return;
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, r);
      } else {
        try {
          const fd = fs.openSync(full, 'r+');
          fs.closeSync(fd);
        } catch {
          found = r;
        }
      }
    }
  })(dir, '');
  return found;
}

function lockedFileSuffix(dir) {
  const lockedFile = findLockedFile(dir);
  return lockedFile ? ` The locked file appears to be: ${lockedFile}` : '';
}

function renameWithRetry(from, to) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) sleepSync(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

/**
 * Sweep stale `.scriptorium-old-*` and `.scriptorium-build-*` siblings of
 * finalOut left behind by a previous interrupted build, ignoring failures
 * (section 3: "Sweep stale siblings at the start of the next build").
 */
// A real build takes seconds to minutes; 6 hours is far beyond any build of any vault, yet short
// enough that a leftover whose pid has since been reused by an unrelated process is still swept.
const STAGING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * True only for a staging dir that is plausibly another live build's in-flight work: a well-formed
 * name (`.scriptorium-build-<pid>-<ms>-...`), a safe positive-integer pid (pid 0 would make
 * kill(0, 0) signal the whole process group and report "alive"), not our own pid, younger than
 * STAGING_MAX_AGE_MS, and a pid that is alive (EPERM counts as alive). Anything else is stale.
 */
function isLiveForeignStaging(entry, now) {
  const m = /^\.scriptorium-build-(\d+)-(\d+)-/.exec(entry);
  if (!m) return false;
  const pid = Number(m[1]);
  const stamp = Number(m[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(stamp)) return false;
  if (pid === process.pid) return false;
  if (now - stamp >= STAGING_MAX_AGE_MS) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function sweepStaleSiblings(finalOut, { now = Date.now } = {}) {
  const parent = path.dirname(path.resolve(finalOut));
  let entries;
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^\.scriptorium-(old|build)-/.test(entry)) continue;
    // Issue #102: two builds whose outputs share a parent stage in the same parent. A staging dir
    // stamped with another LIVE process's pid is that build's in-flight work, not a leftover;
    // sweeping it made the other build fail with ENOENT mid-build.
    if (isLiveForeignStaging(entry, now())) continue;
    try {
      fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
    } catch {
      // best-effort only
    }
  }
}

/**
 * @param {string} finalOut absolute
 * @param {string} stagingOut absolute, the freshly built site
 * @returns {{ swapped: true }} on success
 * @throws {ScriptoriumError} naming the exact recovery path if anything
 *         other than a clean swap happens
 */
function swapIntoPlace(finalOut, stagingOut) {
  const oldDir = `${finalOut}.scriptorium-old-${Date.now()}`;
  const hadExisting = fs.existsSync(finalOut);

  if (hadExisting) {
    try {
      renameWithRetry(finalOut, oldDir);
    } catch (err) {
      throw new ScriptoriumError(
        `could not move the existing site out of the way at ${finalOut}: ${err.message}.${lockedFileSuffix(finalOut)} ` +
          'Nothing was changed; the previous site is intact and the new build remains staged at ' +
          stagingOut,
      );
    }
  }

  try {
    renameWithRetry(stagingOut, finalOut);
  } catch (err) {
    const lockedSuffix = lockedFileSuffix(stagingOut);
    if (hadExisting) {
      try {
        renameWithRetry(oldDir, finalOut);
        throw new ScriptoriumError(
          `could not move the new build into place at ${finalOut}: ${err.message}.${lockedSuffix} ` +
            `Rolled back successfully; the previous site is intact. The new build remains staged at ${stagingOut}.`,
        );
      } catch (rollbackErr) {
        if (rollbackErr instanceof ScriptoriumError) throw rollbackErr;
        throw new ScriptoriumError(
          `SITE DOES NOT CURRENTLY EXIST at ${finalOut}. The swap failed (${err.message}) and the ` +
            `rollback also failed (${rollbackErr.message}).${lockedSuffix} Recover manually: ` +
            `move "${oldDir}" to "${finalOut}", or move "${stagingOut}" to "${finalOut}" for the new build.`,
        );
      }
    }
    throw new ScriptoriumError(
      `could not move the new build into place at ${finalOut}: ${err.message}.${lockedSuffix} The new build remains staged at ${stagingOut}.`,
    );
  }

  if (hadExisting) {
    try {
      fs.rmSync(oldDir, { recursive: true, force: true });
    } catch {
      // Step 3 failure: warn, leave the directory, exit 0 (caller's job to warn).
      return { swapped: true, staleOldDir: oldDir };
    }
  }

  return { swapped: true, staleOldDir: null };
}

module.exports = { swapIntoPlace, sweepStaleSiblings, STAGING_MAX_AGE_MS, renameWithRetry, RETRY_DELAYS_MS, findLockedFile };
