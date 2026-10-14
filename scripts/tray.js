#!/usr/bin/env node
'use strict';

/*
 * Builds and checks the Windows tray helper, gm-scriptorium-tray.exe (ADR 0057, section 2).
 *
 *   node scripts/tray.js build --out <abs>/gm-scriptorium-tray-win-x64.exe
 *   node scripts/tray.js check <abs exe>
 *
 * The helper is C17 against Win32 only, cross-compiled on Linux with mingw-w64 (the Debian
 * packages gcc-mingw-w64-x86-64-win32, binutils-mingw-w64-x86-64 and mingw-w64-x86-64-dev). The
 * win32 thread model matters: the posix one brings in winpthread. scripts/package.js runs this as
 * gate 8, after both program targets have passed.
 *
 * Build: a version resource is written into a fresh temporary folder from scripts/winres.js's
 * versionStrings(version, 'tray') and fixedVersion(version); windres compiles it and
 * packaging/windows/tray/tray-dialogs.rc (the Lantern icon, the manifest and the change-ports
 * window); gcc compiles and links with the pinned flags in gccArgs(). Then the output is checked:
 *
 *   - PE32+ for x86-64, GUI subsystem (2);
 *   - address-space randomisation, data execution prevention and high-entropy addresses on;
 *   - stripped (no COFF symbol table);
 *   - imports only from the seven system DLLs in ALLOWED_IMPORTS, compared case-insensitively,
 *     delay-loaded imports included;
 *   - the manifest bytes hold level="asInvoker" and PerMonitorV2;
 *   - `node scripts/winres.js check-tray <exe>`: the Lantern icon group and the tray version strings.
 *
 * Fail-closed, like scripts/installer.js: on any failure the output file is removed and the exit
 * code is 1. Nothing falls back to anything else when mingw is missing.
 *
 * Output lines, in this order:
 *   MINGW version=<first line of x86_64-w64-mingw32-gcc --version>
 *   TRAY sha256=<h> path=<p>
 *   TRAY-CHECK ok
 *   failure: FAIL <reason>, one of mingw-missing, compile-failed, not-pe, wrong-machine,
 *            wrong-subsystem, import-not-allowed, no-asinvoker, no-dpi, branding, usage, bad-path,
 *            out-exists, and two beyond the original list: no-hardening (a mitigation flag is
 *            missing) and not-stripped (a symbol table survived).
 *
 * What this does not prove: anything about how Windows runs the helper. That is criteria C190,
 * C192, C194 and C203 in the Windows verification runbook.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { versionStrings, fixedVersion } = require('./winres');

const ROOT = path.join(__dirname, '..');
const TRAY_SRC = path.join(ROOT, 'packaging', 'windows', 'tray');
const ICON_DIR = path.join(ROOT, 'packaging', 'windows');
const WINRES_PATH = path.join(ROOT, 'scripts', 'winres.js');
const GCC = 'x86_64-w64-mingw32-gcc';
const WINDRES = 'x86_64-w64-mingw32-windres';

// Same rules as scripts/installer.js: absolute, and no space, quote or shell character.
const PATH_RE = /^\/[A-Za-z0-9/._-]+$/;
// X.Y.Z or X.Y.Z-rc.N, the only versions the release tooling makes. It goes into a -D define.
const VERSION_RE = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})(?:-rc\.(0|[1-9]\d{0,8}))?$/;

const CFLAGS = Object.freeze([
  '-std=c17',
  '-Os',
  '-municode',
  '-mwindows',
  '-static',
  '-static-libgcc',
  '-s',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-Wl,--no-insert-timestamp',
  '-Wl,--dynamicbase',
  '-Wl,--nxcompat',
  '-Wl,--high-entropy-va',
]);
const LIBS = Object.freeze(['-lcomctl32', '-lshell32', '-luser32', '-ladvapi32', '-lgdi32']);

/** Lower-case names. A system DLL outside this list, winpthread above all, fails the build. */
const ALLOWED_IMPORTS = Object.freeze(['kernel32.dll', 'user32.dll', 'shell32.dll', 'advapi32.dll', 'gdi32.dll', 'comctl32.dll', 'msvcrt.dll']);

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const PE32_PLUS = 0x20b;
const SUBSYSTEM_WINDOWS_GUI = 2;
const DLLCHAR_HIGH_ENTROPY_VA = 0x0020;
const DLLCHAR_DYNAMIC_BASE = 0x0040;
const DLLCHAR_NX_COMPAT = 0x0100;

class TrayError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

function checkVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new TrayError('branding', `bad version ${JSON.stringify(version)}`);
  return version;
}

/**
 * The gcc argument list. The flags are pinned by test/tray-build.test.js.
 * @param {{ out: string, version: string, sources: string[], objects: string[] }} opts
 * @returns {string[]}
 */
function gccArgs({ out, version, sources, objects }) {
  checkVersion(version);
  return [...CFLAGS, `-DTRAY_APP_VERSION="${version}"`, '-o', out, ...sources, ...objects, ...LIBS];
}

/** windres for one resource script, with the folders its file names are found in. */
function windresArgs(input, output, includeDirs) {
  const inc = includeDirs.flatMap((d) => ['-I', d]);
  return ['--input-format=rc', '--output-format=coff', ...inc, '-i', input, '-o', output];
}

/** The version resource for the helper, from the same strings and numbers as the program's. */
function versionRc(version) {
  const strings = versionStrings(version, 'tray');
  const [a, b, c, d] = fixedVersion(version);
  const values = Object.entries(strings)
    .map(([k, v]) => `            VALUE "${k}", "${v}"`)
    .join('\n');
  return [
    '1 VERSIONINFO',
    `FILEVERSION ${a},${b},${c},${d}`,
    `PRODUCTVERSION ${a},${b},${c},${d}`,
    'FILEFLAGSMASK 0x3fL',
    'FILEFLAGS 0x0L',
    'FILEOS 0x40004L',
    'FILETYPE 0x1L',
    'FILESUBTYPE 0x0L',
    'BEGIN',
    '    BLOCK "StringFileInfo"',
    '    BEGIN',
    '        BLOCK "040904b0"',
    '        BEGIN',
    values,
    '        END',
    '    END',
    '    BLOCK "VarFileInfo"',
    '    BEGIN',
    '        VALUE "Translation", 0x409, 1200',
    '    END',
    'END',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Reading a PE file, by hand, so the check trusts nothing it is checking
// ---------------------------------------------------------------------------------------------

function u16(buf, off) {
  if (off < 0 || off + 2 > buf.length) throw new TrayError('not-pe', `read past the end at ${off}`);
  return buf.readUInt16LE(off);
}

function u32(buf, off) {
  if (off < 0 || off + 4 > buf.length) throw new TrayError('not-pe', `read past the end at ${off}`);
  return buf.readUInt32LE(off);
}

/** The headers this check needs. Throws TrayError('not-pe') on anything that is not a PE32+. */
function peHeaders(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) throw new TrayError('not-pe', 'no MZ header');
  const pe = u32(buf, 0x3c);
  if (u32(buf, pe) !== 0x00004550) throw new TrayError('not-pe', 'no PE signature');
  const fh = pe + 4;
  const machine = u16(buf, fh);
  const sectionCount = u16(buf, fh + 2);
  const symbolTable = u32(buf, fh + 8);
  const symbols = u32(buf, fh + 12);
  const optSize = u16(buf, fh + 16);
  const oh = fh + 20;
  const magic = u16(buf, oh);
  if (magic !== PE32_PLUS) return { machine, magic };
  const subsystem = u16(buf, oh + 68);
  const dllChars = u16(buf, oh + 70);
  const dirCount = u32(buf, oh + 108);
  const dir = (i) => (i < dirCount ? { rva: u32(buf, oh + 112 + i * 8), size: u32(buf, oh + 112 + i * 8 + 4) } : { rva: 0, size: 0 });
  const sections = [];
  const sh = oh + optSize;
  for (let i = 0; i < sectionCount; i++) {
    const s = sh + i * 40;
    sections.push({ vsize: u32(buf, s + 8), rva: u32(buf, s + 12), rawSize: u32(buf, s + 16), raw: u32(buf, s + 20) });
  }
  return { machine, magic, subsystem, dllChars, symbolTable, symbols, sections, imports: dir(1), delayImports: dir(13) };
}

function rvaToOffset(h, rva) {
  for (const s of h.sections) {
    const span = Math.max(s.vsize, s.rawSize);
    if (rva >= s.rva && rva < s.rva + span) return s.raw + (rva - s.rva);
  }
  throw new TrayError('not-pe', `rva ${rva} is in no section`);
}

function cString(buf, off) {
  const end = buf.indexOf(0, off);
  if (end < 0 || end - off > 260) throw new TrayError('not-pe', 'unterminated DLL name');
  return buf.toString('latin1', off, end);
}

/**
 * The DLL names a PE32+ imports, the ordinary import table first, then the delay-load table.
 * @param {Buffer} buf
 * @returns {string[]}
 */
function parsePeImports(buf) {
  const h = peHeaders(buf);
  if (h.magic !== PE32_PLUS) throw new TrayError('not-pe', 'not PE32+');
  const names = [];
  if (h.imports.rva !== 0) {
    for (let off = rvaToOffset(h, h.imports.rva); ; off += 20) {
      const nameRva = u32(buf, off + 12);
      if (nameRva === 0 && u32(buf, off) === 0 && u32(buf, off + 16) === 0) break;
      names.push(cString(buf, rvaToOffset(h, nameRva)));
      if (names.length > 256) throw new TrayError('not-pe', 'too many imports');
    }
  }
  if (h.delayImports.rva !== 0) {
    for (let off = rvaToOffset(h, h.delayImports.rva); ; off += 32) {
      const nameRva = u32(buf, off + 4);
      if (nameRva === 0) break;
      names.push(cString(buf, rvaToOffset(h, nameRva)));
      if (names.length > 256) throw new TrayError('not-pe', 'too many imports');
    }
  }
  return names;
}

/** The optional header's Subsystem field (2 is the Windows GUI, 3 the console). */
function peSubsystem(buf) {
  const h = peHeaders(buf);
  if (h.magic !== PE32_PLUS) throw new TrayError('not-pe', 'not PE32+');
  return h.subsystem;
}

/**
 * Judges the bytes of a built helper. Branding is checked separately by scripts/winres.js.
 * @param {Buffer} buf
 * @returns {string|null} a FAIL reason, or null when every check passes
 */
function checkPe(buf) {
  let h;
  let imports;
  try {
    h = peHeaders(buf);
    if (h.machine !== IMAGE_FILE_MACHINE_AMD64) return 'wrong-machine';
    if (h.magic !== PE32_PLUS) return 'not-pe';
    imports = parsePeImports(buf);
  } catch (err) {
    if (err instanceof TrayError) return err.reason;
    return 'not-pe';
  }
  if (h.subsystem !== SUBSYSTEM_WINDOWS_GUI) return 'wrong-subsystem';
  const need = DLLCHAR_HIGH_ENTROPY_VA | DLLCHAR_DYNAMIC_BASE | DLLCHAR_NX_COMPAT;
  if ((h.dllChars & need) !== need) return 'no-hardening';
  if (h.symbolTable !== 0 || h.symbols !== 0) return 'not-stripped';
  for (const dll of imports) if (!ALLOWED_IMPORTS.includes(dll.toLowerCase())) return 'import-not-allowed';
  if (buf.indexOf('level="asInvoker"') === -1) return 'no-asinvoker';
  if (buf.indexOf('PerMonitorV2') === -1) return 'no-dpi';
  return null;
}

// ---------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------

function checkPath(value, what) {
  if (typeof value !== 'string' || !PATH_RE.test(value) || value.split('/').includes('..')) {
    throw new TrayError('bad-path', `${what} ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * @param {string[]} argv
 * @returns {{ mode: 'build', out: string } | { mode: 'check', exe: string }}
 */
function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'build') {
    if (rest.length !== 2 || rest[0] !== '--out') throw new TrayError('usage', 'build --out <absolute path>');
    return { mode, out: checkPath(rest[1], '--out') };
  }
  if (mode === 'check') {
    if (rest.length !== 1) throw new TrayError('usage', 'check <absolute path>');
    return { mode, exe: checkPath(rest[0], 'check') };
  }
  throw new TrayError('usage', `unknown mode ${JSON.stringify(mode)}`);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function removeQuietly(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // best effort: the failure being reported matters more than a cleanup that could not run
  }
}

function defaultExec(file, args, opts) {
  return execFileSync(file, args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 16 * 1024 * 1024, ...opts });
}

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

/** Runs the byte checks and the branding check on `exe`; throws TrayError on the first failure. */
function judgeExe(exe, exec) {
  const reason = checkPe(fs.readFileSync(exe));
  if (reason) throw new TrayError(reason);
  try {
    exec(process.execPath, [WINRES_PATH, 'check-tray', exe]);
  } catch (err) {
    throw new TrayError('branding', String((err && err.stdout) || (err && err.message) || err).trim());
  }
}

/**
 * @param {{ argv?: string[], exec?: Function, version?: string,
 *   stdout?: (line: string) => void, stderr?: (line: string) => void }} [deps]
 * @returns {number} the process exit code
 */
function run({ argv = process.argv.slice(2), exec = defaultExec, version, stdout = console.log, stderr = console.error } = {}) {
  let outFile = null;
  let workDir = null;
  try {
    const args = parseArgs(argv);
    if (args.mode === 'check') {
      judgeExe(args.exe, exec);
      stdout(`TRAY sha256=${sha256(fs.readFileSync(args.exe))} path=${args.exe}`);
      stdout('TRAY-CHECK ok');
      return 0;
    }

    const v = checkVersion(version === undefined ? readPackageVersion() : version);
    if (fs.existsSync(args.out)) throw new TrayError('out-exists', args.out);

    let gccVersion;
    try {
      gccVersion = String(exec(GCC, ['--version'])).split('\n')[0].trim();
    } catch (err) {
      throw new TrayError('mingw-missing', err && err.message);
    }
    stdout(`MINGW version=${gccVersion}`);
    if (!/-win32\b/.test(gccVersion)) throw new TrayError('mingw-missing', 'the compiler is not the win32 thread model build (gcc-mingw-w64-x86-64-win32)');

    outFile = args.out;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-scriptorium-tray-build-'));
    const versionSrc = path.join(workDir, 'version.rc');
    fs.writeFileSync(versionSrc, versionRc(v));
    const dialogsObj = path.join(workDir, 'tray-dialogs.o');
    const versionObj = path.join(workDir, 'version.o');
    try {
      exec(WINDRES, windresArgs(path.join(TRAY_SRC, 'tray-dialogs.rc'), dialogsObj, [TRAY_SRC, ICON_DIR]));
      exec(WINDRES, windresArgs(versionSrc, versionObj, [workDir]));
      exec(GCC, gccArgs({ out: args.out, version: v, sources: [path.join(TRAY_SRC, 'tray.c'), path.join(TRAY_SRC, 'host.c')], objects: [dialogsObj, versionObj] }));
    } catch (err) {
      if (err && err.stdout) stderr(String(err.stdout).trim());
      if (err && err.stderr) stderr(String(err.stderr).trim());
      throw new TrayError('compile-failed', err && err.message);
    }
    if (!fs.existsSync(args.out)) throw new TrayError('compile-failed', `gcc wrote no ${args.out}`);
    fs.chmodSync(args.out, 0o644);

    judgeExe(args.out, exec);
    stdout(`TRAY sha256=${sha256(fs.readFileSync(args.out))} path=${args.out}`);
    stdout('TRAY-CHECK ok');
    return 0;
  } catch (err) {
    if (outFile) removeQuietly(outFile);
    const reason = err instanceof TrayError ? err.reason : 'compile-failed';
    stdout(`FAIL ${reason}`);
    stderr(err && err.message ? err.message : String(err));
    return 1;
  } finally {
    if (workDir) removeQuietly(workDir);
  }
}

if (require.main === module) {
  process.exit(run());
}

module.exports = { parseArgs, gccArgs, windresArgs, versionRc, parsePeImports, peSubsystem, checkPe, run, ALLOWED_IMPORTS, TrayError, PATH_RE };
