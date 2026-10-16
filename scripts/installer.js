#!/usr/bin/env node
'use strict';

/*
 * Builds the Windows installer and uninstaller with makensis (ADR 0053).
 *
 *   node scripts/installer.js uninstaller --out <abs>/gm-scriptorium-uninstall.exe
 *   node scripts/installer.js installer --exe <abs exe> --uninstaller <abs uninstaller> \
 *        --notices <abs notices> --tray <abs tray> --out <abs>/gm-scriptorium-setup-win-x64.exe
 *
 * Two stages, because the uninstaller is signed before it is packed. Stage A compiles the script
 * with -DEXTRACT_UNINSTALLER, whose `!uninstfinalize` line copies the uninstaller makensis builds
 * to --out; the installer stage A also produces goes to a temp folder and is thrown away. Stage B
 * compiles the real installer, which packs the (by then signed) exe and uninstaller with
 * `SetCompress off`, and this script then proves by a byte search that the output holds exactly
 * those bytes. The installer is therefore about the exe's uncompressed size; ADR 0053 says so.
 *
 * Fail-closed, like scripts/package.js: on any failure the output file is removed and the exit
 * code is 1. A release build never falls back to anything else when makensis is missing.
 *
 * Output lines (one per line, in this order; the release tooling reads them):
 *   MAKENSIS version=<makensis -VERSION>
 *   uninstaller: UNINSTALLER sha256=<h> path=<p>
 *   installer:   INPUT exe sha256=<h> / INPUT uninstaller sha256=<h> / INPUT notices sha256=<h> /
 *                INPUT tray sha256=<h>
 *                CONTAINS exe yes / CONTAINS uninstaller yes / CONTAINS tray yes / MANIFEST asInvoker yes
 *                INSTALLER sha256=<h> path=<p>
 *   failure:     FAIL <reason>  (makensis-missing, makensis-failed, bad-path, out-exists,
 *                not-packed-exe, not-packed-uninstaller, not-packed-tray, no-asinvoker, bad-version, usage)
 *
 * `usage` is the one reason beyond the contract: a mode or flag this script does not know.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NSI_PATH = path.join(ROOT, 'packaging', 'windows', 'installer.nsi');

// Every path handed to makensis is absolute and drawn from this set, so none can carry a space, a
// quote, a shell character or an NSIS escape into a -D define.
const PATH_RE = /^\/[A-Za-z0-9/._-]+$/;
// The one grammar packaging/windows/version.nsh parses: X.Y.Z or X.Y.Z-rc.N, numerics only. Each
// X, Y and Z must also fit the 16-bit fields of the PE version resource.
const VERSION_RE = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})(?:-rc\.(0|[1-9]\d{0,8}))?$/;

class InstallerError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

/** @returns {string} the four-part numeric version for VIProductVersion, e.g. "0.4.0.0" */
function checkVersion(version) {
  const m = typeof version === 'string' ? VERSION_RE.exec(version) : null;
  if (!m || [m[1], m[2], m[3]].some((n) => Number(n) > 65535)) throw new InstallerError('bad-version', JSON.stringify(version));
  return `${m[1]}.${m[2]}.${m[3]}.0`;
}

function checkPath(value, flag) {
  if (typeof value !== 'string' || !PATH_RE.test(value) || value.split('/').includes('..')) {
    throw new InstallerError('bad-path', `${flag} ${JSON.stringify(value)}`);
  }
  return value;
}

const FLAGS = {
  uninstaller: ['out'],
  installer: ['exe', 'uninstaller', 'notices', 'tray', 'out'],
};

/**
 * @param {string[]} argv
 * @returns {{ mode: string, out: string, exe?: string, uninstaller?: string, notices?: string, tray?: string }}
 * @throws {InstallerError} usage (unknown mode or flag, missing flag or value) or bad-path
 */
function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(FLAGS, mode)) throw new InstallerError('usage', `unknown mode ${JSON.stringify(mode)}`);
  const wanted = FLAGS[mode];
  const out = { mode };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const name = flag && flag.startsWith('--') ? flag.slice(2) : null;
    if (!name || !wanted.includes(name)) throw new InstallerError('usage', `unknown argument ${JSON.stringify(flag)}`);
    if (i + 1 >= rest.length) throw new InstallerError('usage', `${flag} needs a value`);
    if (Object.prototype.hasOwnProperty.call(out, name)) throw new InstallerError('usage', `${flag} given twice`);
    out[name] = checkPath(rest[i + 1], flag);
  }
  for (const name of wanted) if (!out[name]) throw new InstallerError('usage', `--${name} is required`);
  return out;
}

/**
 * The makensis argument list for one stage.
 *
 * @param {'installer'|'uninstaller'} mode
 * @param {{ version: string, out: string, exe?: string, uninstaller?: string, notices?: string, tray?: string,
 *   stageDir?: string, withPath?: boolean }} opts withPath defaults to true: the PATH option is
 *   compiled in, and is dropped for a build by passing false (ADR 0053, "The PATH option").
 * @returns {string[]}
 */
function makensisArgs(mode, opts) {
  const version4 = checkVersion(opts.version);
  const args = ['-V2', '-WX', `-DVERSION=${opts.version}`, `-DVERSION4=${version4}`];
  if (opts.withPath !== false) args.push('-DWITH_PATH_OPTION');
  if (mode === 'uninstaller') {
    args.push('-DEXTRACT_UNINSTALLER', `-DUNINSTALLER_OUT=${opts.out}`, `-DOUTFILE=${path.join(opts.stageDir, 'stage-a-setup.exe')}`);
  } else {
    args.push(`-DEXE_IN=${opts.exe}`, `-DUNINSTALLER_IN=${opts.uninstaller}`, `-DNOTICES_IN=${opts.notices}`, `-DTRAY_IN=${opts.tray}`, `-DOUTFILE=${opts.out}`);
  }
  args.push(NSI_PATH);
  return args;
}

/**
 * Byte-searches `installerPath` for each needle.
 *
 * @param {string} installerPath
 * @param {Record<string, Buffer>} needles
 * @returns {Record<string, boolean>} true for each needle found exactly; an empty needle is false
 */
function verifyPacked(installerPath, needles) {
  const haystack = fs.readFileSync(installerPath);
  const result = {};
  for (const [name, needle] of Object.entries(needles)) {
    result[name] = needle.length > 0 && haystack.indexOf(needle) !== -1;
  }
  return result;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function removeQuietly(file) {
  try {
    fs.rmSync(file, { recursive: true, force: true });
  } catch {
    // best effort: the failure being reported matters more than a cleanup that could not run
  }
}

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

function defaultExec(file, args, opts) {
  return execFileSync(file, args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...opts });
}

function mustExist(file, flag) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new InstallerError('bad-path', `${flag} ${file} does not exist`);
  }
  if (!st.isFile()) throw new InstallerError('bad-path', `${flag} ${file} is not a file`);
}

/**
 * @param {{ argv?: string[], exec?: Function, version?: string, withPath?: boolean,
 *   stdout?: (line: string) => void, stderr?: (line: string) => void }} [deps]
 * @returns {number} the process exit code
 */
function run({ argv = process.argv.slice(2), exec = defaultExec, version, withPath, stdout = console.log, stderr = console.error } = {}) {
  let outFile = null;
  let stageDir = null;
  try {
    const args = parseArgs(argv);
    const v = version === undefined ? readPackageVersion() : version;
    checkVersion(v);
    if (fs.existsSync(args.out)) throw new InstallerError('out-exists', args.out);
    if (args.mode === 'installer') {
      mustExist(args.exe, '--exe');
      mustExist(args.uninstaller, '--uninstaller');
      mustExist(args.notices, '--notices');
      mustExist(args.tray, '--tray');
    }

    let makensisVersion;
    try {
      makensisVersion = String(exec('makensis', ['-VERSION'])).trim();
    } catch (err) {
      throw new InstallerError(err && err.code === 'ENOENT' ? 'makensis-missing' : 'makensis-failed', err && err.message);
    }
    stdout(`MAKENSIS version=${makensisVersion}`);

    outFile = args.out;
    let exeBytes;
    let uninstBytes;
    let trayBytes;
    if (args.mode === 'installer') {
      exeBytes = fs.readFileSync(args.exe);
      uninstBytes = fs.readFileSync(args.uninstaller);
      stdout(`INPUT exe sha256=${sha256(exeBytes)}`);
      stdout(`INPUT uninstaller sha256=${sha256(uninstBytes)}`);
      stdout(`INPUT notices sha256=${sha256(fs.readFileSync(args.notices))}`);
      trayBytes = fs.readFileSync(args.tray);
      stdout(`INPUT tray sha256=${sha256(trayBytes)}`);
    } else {
      stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-scriptorium-installer-'));
    }

    const makeArgs = makensisArgs(args.mode, { ...args, version: v, stageDir, withPath });
    try {
      const log = exec('makensis', makeArgs);
      if (log && String(log).trim()) stderr(String(log).trim());
    } catch (err) {
      if (err && err.stdout) stderr(String(err.stdout).trim());
      if (err && err.stderr) stderr(String(err.stderr).trim());
      throw new InstallerError(err && err.code === 'ENOENT' ? 'makensis-missing' : 'makensis-failed', err && err.message);
    }
    if (!fs.existsSync(args.out)) throw new InstallerError('makensis-failed', `makensis wrote no ${args.out}`);

    const bytes = fs.readFileSync(args.out);
    if (args.mode === 'uninstaller') {
      if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new InstallerError('makensis-failed', 'the uninstaller is not a PE file');
      if (bytes.indexOf('level="asInvoker"') === -1) throw new InstallerError('no-asinvoker', 'the uninstaller manifest');
      fs.chmodSync(args.out, 0o644);
      stdout(`UNINSTALLER sha256=${sha256(bytes)} path=${args.out}`);
      return 0;
    }

    const found = verifyPacked(args.out, { exe: exeBytes, uninstaller: uninstBytes, tray: trayBytes });
    if (!found.exe) throw new InstallerError('not-packed-exe');
    stdout('CONTAINS exe yes');
    if (!found.uninstaller) throw new InstallerError('not-packed-uninstaller');
    stdout('CONTAINS uninstaller yes');
    if (!found.tray) throw new InstallerError('not-packed-tray');
    stdout('CONTAINS tray yes');
    if (bytes.indexOf('level="asInvoker"') === -1) throw new InstallerError('no-asinvoker', 'the installer manifest');
    stdout('MANIFEST asInvoker yes');
    stdout(`INSTALLER sha256=${sha256(bytes)} path=${args.out}`);
    return 0;
  } catch (err) {
    if (outFile) removeQuietly(outFile);
    const reason = err instanceof InstallerError ? err.reason : 'makensis-failed';
    stdout(`FAIL ${reason}`);
    stderr(err && err.message ? err.message : String(err));
    return 1;
  } finally {
    if (stageDir) removeQuietly(stageDir);
  }
}

if (require.main === module) {
  process.exit(run());
}

module.exports = { parseArgs, makensisArgs, verifyPacked, checkVersion, run, InstallerError, PATH_RE, VERSION_RE };
