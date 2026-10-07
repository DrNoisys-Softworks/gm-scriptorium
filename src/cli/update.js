'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { requireGh: requireGhImpl } = require('../update/gh');
const { REPO, fetchLatestRelease: fetchLatestReleaseImpl, downloadAsset: downloadAssetImpl } = require('../update/release');
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
 *   requireGh?: Function, fetchLatestRelease?: Function, downloadAsset?: Function,
 *   verifyDownload?: Function, replaceExecutable?: Function,
 * }} [deps] injectable for tests; all filesystem effects are confined to `execPath`'s
 *   directory and `tmpRoot` when both are overridden with scratch paths.
 * @returns {{ exitCode: number, human: string }}
 */
function runUpdateCommand(
  flags,
  {
    execPath = process.execPath,
    platform = process.platform,
    arch = process.arch,
    tmpRoot = os.tmpdir(),
    isPkg = typeof process.pkg !== 'undefined',
    requireGh = requireGhImpl,
    fetchLatestRelease = fetchLatestReleaseImpl,
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

  try {
    if (flags.version === true) {
      throw new ScriptoriumError('--version needs a release tag, e.g. update --version v0.2.3');
    }
    const ghPath = requireGh();
    const release = fetchLatestRelease(ghPath, { pre: Boolean(flags.pre), version: flags.version || null });
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

    if (cmp === 0) {
      return { exitCode: EXIT_CODES.OK, human: `already at the latest version (${currentVersion}). Nothing changed.` };
    }

    if (cmp > 0) {
      // The only thing gh returned is lower than (or, impossible given cmp===0 above, equal
      // to) what is already running. Never call this "updated" (required behaviour 1): no
      // download, no replace, exit 0, nothing written.
      const displayTag = tag.replace(/^v(?=\d)/, '');
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
        human: `update available: ${currentVersion} -> ${tag}. Release notes: ${release.html_url}\n(--check: nothing changed)`,
      };
    }

    if (!fs.existsSync(exeDir) || !isWritable(exeDir)) {
      throw new UpdatePrerequisiteError(`executable directory is not writable: ${exeDir}`);
    }

    const pattern = assetPatternForPlatform(platform, arch);

    // Class 1 (Issue #24): the download temp dir. try/finally so it is removed on EVERY path out
    // of this block, not only the happy one -- including a checksum mismatch (deliberately
    // diverging from `build`'s staging tree, which is kept on failure on purpose: this directory
    // holds one unverified binary blob whose entire diagnostic value is already in the error
    // message, src/update/verify.js:37). The removal itself gets its own try/catch: a `finally`
    // that itself throws would replace the genuine error above with a cleanup error, which is the
    // worst available outcome here.
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, UPDATE_TMP_PREFIX));
    let stagedPath;
    try {
      fs.writeFileSync(path.join(tmpDir, OWNER_MARKER_FILENAME), String(process.pid));

      downloadAsset(ghPath, tag, pattern, tmpDir);

      const downloadedAsset = path.join(tmpDir, pattern);
      const sumsPath = path.join(tmpDir, 'SHA256SUMS');
      verifyDownload(downloadedAsset, sumsPath);

      if (platform === 'win32' && !isWindowsExecutable(downloadedAsset)) {
        throw new ScriptoriumError('downloaded asset does not look like a Windows executable (missing MZ header)');
      }
      // P5a-FR05: the ELF mirror of the MZ check above.
      if (platform === 'linux' && !isLinuxExecutable(downloadedAsset)) {
        throw new ScriptoriumError('downloaded asset does not look like a Linux executable (missing/invalid ELF header)');
      }

      stagedPath = path.join(exeDir, stagedExecutableName(exeName, process.pid, Date.now()));
      fs.copyFileSync(downloadedAsset, stagedPath);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort only; a failed cleanup must never surface as, or mask, the update's result
      }
    }

    // Class 2 (Issue #24): the staged executable. Same try/finally shape as above, own try/catch
    // around the removal. On success replaceExecutable has already renamed stagedPath away, so
    // this unlink is a no-op (ENOENT, swallowed); on any throw -- including the
    // rollback-succeeded path inside replaceExecutable -- stagedPath is still on disk and this is
    // what actually removes it.
    let oldPath;
    try {
      ({ oldPath } = replaceExecutable(execPath, stagedPath, currentVersion));
    } finally {
      try {
        fs.unlinkSync(stagedPath);
      } catch {
        // best-effort only; see comment above
      }
    }

    // Issue #26: confined to this success path only. On every failure path above, the old
    // binary is still the one on disk and its notices file (if any) is still an accurate
    // description of it -- deleting it there would destroy correct information (see the header
    // comment on discardNoticesBesideExecutable, src/update/replace.js). Best-effort and
    // swallowed inside discardNoticesBesideExecutable itself; a failed delete must not change
    // this result any more than a failed cleanup above did.
    discardNoticesBesideExecutable(exeDir);

    return {
      exitCode: EXIT_CODES.OK,
      human:
        `updated ${currentVersion} -> ${tag}. Previous binary kept at ${oldPath}. ` +
        "Any third-party notices file beside the executable described the OLD version and has been " +
        'cleared; run --version to write the new copy, or --notices to print it without writing ' +
        `anything. Release notes: ${release.html_url}`,
    };
  } catch (err) {
    if (err instanceof UpdatePrerequisiteError) {
      return { exitCode: EXIT_CODES.UPDATE_PREREQUISITE, human: err.message };
    }
    return { exitCode: EXIT_CODES.SCRIPTORIUM_ERROR, human: `update failed: ${err.message}` };
  }
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = { runUpdateCommand, assetPatternForPlatform };
