'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  REPO,
  isSafeTag,
  releaseNotesUrl,
  lookupRelease: lookupReleaseImpl,
  downloadAsset: downloadAssetImpl,
} = require('../update/release');
const { verifyDownload: verifyDownloadImpl, isWindowsExecutable, isLinuxExecutable } = require('../update/verify');
const { compareVersions } = require('../update/semver');
const {
  replaceExecutable: replaceExecutableImpl,
  sweepOldExecutables,
  sweepStaleUpdateDirs,
  sweepStaleStagedExecutables,
  stagedExecutableName,
  UPDATE_TMP_PREFIX,
  OWNER_MARKER_FILENAME,
  discardNoticesBesideExecutable,
} = require('../update/replace');
const { UpdatePrerequisiteError, ScriptoriumError } = require('../util/errors');
const { EXIT_CODES } = require('../util/exitcodes');
const pkg = require('../../package.json');

// ADR 0057, section 11: an installed Windows copy has the tray helper beside the exe, and `update`
// replaces both. The release asset and the installed file have different names.
const TRAY_EXE_NAME = 'gm-scriptorium-tray.exe';
const TRAY_ASSET = 'gm-scriptorium-tray-win-x64.exe';
const QUIT_AND_RESTART = 'If GM-Scriptorium is running in the system tray, quit it and start it again to use the new version.';

/**
 * P5a-FR02/FR04: the Linux asset is named `gm-scriptorium-linux-x64` (D-12). Only x64 is in
 * scope (arm64 is out of scope for 5a); a non-x64 Linux host falls through to the same "no
 * release asset pattern known" error as any other unsupported platform, rather than silently
 * returning the x64 asset.
 */
function assetPatternForPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'gm-scriptorium-win-x64.exe';
  if (platform === 'linux' && arch === 'x64') return 'gm-scriptorium-linux-x64';
  throw new ScriptoriumError(`no release asset pattern known for platform "${platform}"`);
}

/**
 * @param {object} flags
 * @param {{
 *   execPath?: string, platform?: string, arch?: string, tmpRoot?: string, isPkg?: boolean,
 *   lookupRelease?: Function, downloadAsset?: Function,
 *   verifyDownload?: Function, replaceExecutable?: Function,
 * }} [deps] injectable for tests; all filesystem effects are confined to `execPath`'s
 *   directory and `tmpRoot` when both are overridden with scratch paths.
 * @returns {Promise<{ exitCode: number, human: string }>}
 */
async function runUpdateCommand(
  flags,
  {
    execPath = process.execPath,
    platform = process.platform,
    arch = process.arch,
    tmpRoot = os.tmpdir(),
    isPkg = typeof process.pkg !== 'undefined',
    lookupRelease = lookupReleaseImpl,
    downloadAsset = downloadAssetImpl,
    verifyDownload = verifyDownloadImpl,
    replaceExecutable = replaceExecutableImpl,
  } = {},
) {
  // P5a-FR07 (closes F8): `update` replaces process.execPath (see replaceExecutable below), so
  // running it from source would replace the running `node` binary itself. This guard fires on
  // every platform, before the sweeps a few lines down (both file effects) and before any
  // network call, so a source-mode invocation has zero side effects. `isPkg` is injectable
  // (default: `typeof process.pkg !== 'undefined'`, the same test src/generator/bootstrap.js
  // and src/util/notices.js already use) so tests can drive both branches without needing a
  // real packaged binary.
  if (!isPkg) {
    // Mirrors the try/catch's own UpdatePrerequisiteError -> EXIT_CODES.UPDATE_PREREQUISITE
    // mapping below, without going through the try/catch itself: this guard must run before
    // the sweeps just below, which are outside that try block too.
    const err = new UpdatePrerequisiteError(
      'update only runs inside a packaged GM-Scriptorium executable. Running it from source would ' +
        'replace the currently-running node binary, not GM-Scriptorium. Download a release from ' +
        `https://github.com/${REPO}/releases and run update from there.`,
    );
    return { exitCode: EXIT_CODES.UPDATE_PREREQUISITE, human: err.message };
  }

  const currentVersion = pkg.version;
  const exeDir = path.dirname(execPath);
  const exeName = path.basename(execPath);

  // Issue #24: swept before any network call, so an early UpdatePrerequisiteError below still
  // performs it. sweepOldExecutables (running-binary renames) was already here; the two new
  // sweeps (abandoned download temp dirs, abandoned staged executables) run alongside it.
  sweepOldExecutables(exeDir, exeName);
  sweepStaleUpdateDirs(tmpRoot);
  sweepStaleStagedExecutables(exeDir, exeName);
  if (platform === 'win32') {
    // The helper's own leftovers, by the same rules (its running copy cannot be deleted, so it stays until next time).
    sweepOldExecutables(exeDir, TRAY_EXE_NAME);
    sweepStaleStagedExecutables(exeDir, TRAY_EXE_NAME);
  }

  try {
    if (flags.version === true) {
      throw new ScriptoriumError('--version needs a release tag like v0.4.0');
    }
    if (flags.version !== undefined && flags.version !== false && !isSafeTag(flags.version)) {
      throw new ScriptoriumError('--version needs a release tag like v0.4.0');
    }
    const release = await lookupRelease({ pre: Boolean(flags.pre), version: flags.version || null });
    const tag = release.tag_name;

    // Defect fix: compare by real semver precedence (src/update/semver.js), not by string
    // equality. This single check now covers both `update` and `update --check` (it runs
    // before flags.check is examined below), so a prerelease user can never be offered or
    // silently "updated" to an older-or-equal stable release (the rc.2 -> 0.2.3 defect).
    // `update --version <tag>` reaches here because parseArgv gives --version a value after
    // `update` and bin/scriptorium.js only prints the running version for non-update commands
    // (issue #83). A pinned tag at or below the running version is still refused below.
    const cmp = compareVersions(currentVersion, tag);
    if (cmp === null) {
      throw new ScriptoriumError(`release tag "${tag}" is not a well-formed version; refusing to compare or install it`);
    }

    const newVersion = tag.replace(/^v(?=\d)/, '');

    if (cmp === 0) {
      return { exitCode: EXIT_CODES.OK, human: `already at the latest version (${currentVersion}). Nothing changed.` };
    }

    if (cmp > 0) {
      // The only thing the lookup returned is lower than (or, impossible given cmp===0 above, equal
      // to) what is already running. Never call this "updated" (required behaviour 1): no
      // download, no replace, exit 0, nothing written.
      const displayTag = newVersion;
      const human = flags.pre
        ? `You're on ${currentVersion}, which is already the newest release available, including prereleases ` +
          `(highest found: ${displayTag}). Nothing changed.`
        : `You're on ${currentVersion}, which is newer than the latest stable release (${displayTag}). ` +
          'Nothing changed. Run `update --pre` to get newer prereleases.';
      return { exitCode: EXIT_CODES.OK, human };
    }

    if (flags.check) {
      return {
        exitCode: EXIT_CODES.OK,
        human: `update available: ${currentVersion} -> ${tag}. Release notes: ${releaseNotesUrl(tag)}\n(--check: nothing changed)`,
      };
    }

    if (!fs.existsSync(exeDir) || !isWritable(exeDir)) {
      throw new UpdatePrerequisiteError(`executable directory is not writable: ${exeDir}`);
    }

    const pattern = assetPatternForPlatform(platform, arch);

    // The helper is updated with the exe, or not at all: it counts only on Windows, only when it sits
    // beside the exe (a copy from before the desktop app, or a portable one, has none).
    const trayPath = path.join(exeDir, TRAY_EXE_NAME);
    const hasTray = platform === 'win32' && fs.existsSync(trayPath);

    /**
     * Downloads one release asset into a download folder of its own and checks it, then stages a copy
     * beside the exe under `targetName`'s staged-file name. A folder of its own because downloadAsset
     * writes SHA256SUMS with the wx flag, so a second asset in the same folder would collide.
     */
    const stage = async (assetName, targetName) => {
      // Class 1 (Issue #24): the download temp dir. try/finally so it is removed on EVERY path out
      // of this block, not only the happy one -- including a checksum mismatch (deliberately
      // diverging from `build`'s staging tree, which is kept on failure on purpose: this directory
      // holds one unverified binary blob whose entire diagnostic value is already in the error
      // message, src/update/verify.js:37). The removal itself gets its own try/catch: a `finally`
      // that itself throws would replace the genuine error above with a cleanup error, which is the
      // worst available outcome here.
      const tmpDir = fs.mkdtempSync(path.join(tmpRoot, UPDATE_TMP_PREFIX));
      try {
        fs.writeFileSync(path.join(tmpDir, OWNER_MARKER_FILENAME), String(process.pid));

        await downloadAsset(tag, assetName, tmpDir);

        const downloadedAsset = path.join(tmpDir, assetName);
        const sumsPath = path.join(tmpDir, 'SHA256SUMS');
        verifyDownload(downloadedAsset, sumsPath);

        if (platform === 'win32' && !isWindowsExecutable(downloadedAsset)) {
          throw new ScriptoriumError('downloaded asset does not look like a Windows executable (missing MZ header)');
        }
        // P5a-FR05: the ELF mirror of the MZ check above.
        if (platform === 'linux' && !isLinuxExecutable(downloadedAsset)) {
          throw new ScriptoriumError('downloaded asset does not look like a Linux executable (missing/invalid ELF header)');
        }

        const staged = path.join(exeDir, stagedExecutableName(targetName, process.pid, Date.now()));
        fs.copyFileSync(downloadedAsset, staged);
        return staged;
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best-effort only; a failed cleanup must never surface as, or mask, the update's result
        }
      }
    };

    // Class 2 (Issue #24): the staged executables. Same try/finally shape, own try/catch around each
    // removal. On success replaceExecutable has already renamed a staged file away, so its unlink is a
    // no-op (ENOENT, swallowed); on any throw -- including the rollback-succeeded path inside
    // replaceExecutable -- the staged file is still on disk and this is what actually removes it.
    let stagedPath = null;
    let stagedTrayPath = null;
    let oldPath;
    try {
      // Everything is fetched and checked before anything is replaced: a helper that fails here means
      // the exe is not replaced either (a new exe beside an old helper would be a stale tray).
      stagedPath = await stage(pattern, exeName);
      if (hasTray) {
        try {
          stagedTrayPath = await stage(TRAY_ASSET, TRAY_EXE_NAME);
        } catch (err) {
          throw new ScriptoriumError(`the tray helper (${TRAY_ASSET}) could not be fetched or checked: ${err.message}. Nothing changed.`);
        }
      }

      ({ oldPath } = replaceExecutable(execPath, stagedPath, currentVersion));

      if (stagedTrayPath !== null) {
        try {
          replaceExecutable(trayPath, stagedTrayPath, currentVersion);
        } catch (trayErr) {
          // The exe is already the new one. Never leave a new exe beside an old helper: put the old exe back.
          return undoExeReplace({ execPath, oldPath, trayPath, newVersion, currentVersion, trayErr });
        }
      }
    } finally {
      for (const staged of [stagedPath, stagedTrayPath]) {
        if (staged === null) continue;
        try {
          fs.unlinkSync(staged);
        } catch {
          // best-effort only; see comment above
        }
      }
    }

    // Issue #26: confined to this success path only. On every failure path above, the old
    // binary is still the one on disk and its notices file (if any) is still an accurate
    // description of it -- deleting it there would destroy correct information (see the header
    // comment on discardNoticesBesideExecutable, src/update/replace.js). Best-effort and
    // swallowed inside discardNoticesBesideExecutable itself; a failed delete must not change
    // this result any more than a failed cleanup above did. The message names the clearing
    // only when a file was actually removed (issue #119).
    const noticesCleared = discardNoticesBesideExecutable(exeDir);

    let human =
      `updated ${currentVersion} -> ${tag}. Previous binary kept at ${oldPath}. ` +
      (noticesCleared
        ? 'Any third-party notices file beside the executable described the OLD version and has been ' +
          'cleared; run --notices to print the new one. '
        : '') +
      `Release notes: ${releaseNotesUrl(tag)}`;
    // Installed copies only (a helper was beside the exe): the running tray app is the old version.
    if (stagedTrayPath !== null) human += `\nThe tray helper was updated too. ${QUIT_AND_RESTART}`;
    return { exitCode: EXIT_CODES.OK, human };
  } catch (err) {
    if (err instanceof UpdatePrerequisiteError) {
      return { exitCode: EXIT_CODES.UPDATE_PREREQUISITE, human: err.message };
    }
    return { exitCode: EXIT_CODES.SCRIPTORIUM_ERROR, human: `update failed: ${err.message}` };
  }
}

/**
 * The helper could not be replaced after the exe was. Takes the new exe out of the way and renames the
 * old one (kept as .old-<version> by replaceExecutable) back into place, then reports. If that cannot be
 * done, the message names which file is at which version and says to run the installer.
 *
 * Moving the new exe aside rather than deleting it keeps every step a rename, which Windows allows on
 * a running program; the next command's sweep removes it.
 */
function undoExeReplace({ execPath, oldPath, trayPath, newVersion, currentVersion, trayErr }) {
  const exeName = path.basename(execPath);
  const trayName = path.basename(trayPath);
  const aside = `${execPath}.old-${newVersion}`;
  let undone = false;
  try {
    fs.renameSync(execPath, aside);
    try {
      fs.renameSync(oldPath, execPath);
      undone = true;
    } catch {
      try {
        fs.renameSync(aside, execPath); // at least leave an exe at its own name
      } catch {
        // reported below as missing
      }
    }
  } catch {
    // the new exe could not be moved aside: it stays in place
  }

  // The helper's own replace rolls itself back, so it is normally still the old one; say so only when it is there.
  const trayIntact = fs.existsSync(trayPath);
  const reason = String(trayErr && trayErr.message ? trayErr.message : trayErr).replace(/\.\s*$/, '');
  if (undone && trayIntact) {
    return {
      exitCode: EXIT_CODES.SCRIPTORIUM_ERROR,
      human:
        `update failed: the tray helper could not be replaced (${reason}). ` +
        `The new ${exeName} was taken out again. Nothing changed: ${exeName} and ${trayName} are both still version ${currentVersion}.`,
    };
  }
  let exeState;
  if (undone) exeState = `is still version ${currentVersion}`;
  else if (fs.existsSync(execPath)) exeState = `is now version ${newVersion}`;
  else exeState = `is missing (the previous copy is kept at ${oldPath})`;
  const trayState = trayIntact ? `is still version ${currentVersion}` : `is missing (see ${trayPath}.old-${currentVersion})`;
  return {
    exitCode: EXIT_CODES.SCRIPTORIUM_ERROR,
    human:
      'update failed part-way and could not be fully undone. ' +
      `${exeName} ${exeState}, and ${trayName} ${trayState}. ` +
      'Run the GM-Scriptorium installer to put both programs right.',
  };
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = { runUpdateCommand, assetPatternForPlatform, TRAY_ASSET, TRAY_EXE_NAME };
