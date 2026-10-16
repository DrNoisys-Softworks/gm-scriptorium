'use strict';

/*
 * The tray helper's build gate (scripts/tray.js, ADR 0057 section 2): the compiler flags, the
 * PE checks on synthetic files built here, fail-closed removal with an injected exec, and the
 * package.js wiring that adds the helper to SHA256SUMS.
 *
 * Two tests need tools that are not part of npm ci and skip without them, naming what is missing:
 * the host C compiler (cc) for the pure-C unit tests, and mingw-w64 for a real cross build. On the
 * release machine and in CI's packaged-smoke job both are present.
 *
 * Expected values are typed here, never read back from scripts/tray.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const tray = require('../scripts/tray');
const packageJs = require('../scripts/package');
const protocol = require('../src/desktop/protocol');

const ROOT = path.join(__dirname, '..');
const TRAY_DIR = path.join(ROOT, 'packaging', 'windows', 'tray');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-tray-test-'));
}

// ---------------------------------------------------------------------------------------------
// Synthetic PE32+ files
// ---------------------------------------------------------------------------------------------

/**
 * A minimal PE32+ image: DOS header, PE signature, file header, a 240-byte optional header and one
 * section holding import descriptors and DLL names, then `extra` bytes (a stand-in manifest).
 */
function makePe({
  machine = 0x8664,
  magic = 0x20b,
  subsystem = 2,
  dllChars = 0x0020 | 0x0040 | 0x0100,
  symbols = 0,
  imports = ['KERNEL32.dll'],
  delayImports = [],
  extra = '<requestedExecutionLevel level="asInvoker"/><dpiAwareness>PerMonitorV2</dpiAwareness>',
} = {}) {
  const SECTION_RVA = 0x1000;
  const SECTION_RAW = 0x200;
  const body = Buffer.alloc(0x400);
  // import descriptors (20 bytes each, null-terminated list), then delay descriptors (32 bytes each)
  const importDir = 0;
  const delayDir = (imports.length + 1) * 20;
  let names = delayDir + (delayImports.length + 1) * 32;
  imports.forEach((dll, i) => {
    body.writeUInt32LE(SECTION_RVA + names, importDir + i * 20 + 12);
    body.write(`${dll}\0`, names, 'latin1');
    names += dll.length + 1;
  });
  delayImports.forEach((dll, i) => {
    body.writeUInt32LE(1, delayDir + i * 32);
    body.writeUInt32LE(SECTION_RVA + names, delayDir + i * 32 + 4);
    body.write(`${dll}\0`, names, 'latin1');
    names += dll.length + 1;
  });

  const head = Buffer.alloc(SECTION_RAW);
  head.write('MZ', 0, 'latin1');
  head.writeUInt32LE(0x40, 0x3c);
  head.write('PE\0\0', 0x40, 'latin1');
  const fh = 0x44;
  head.writeUInt16LE(machine, fh);
  head.writeUInt16LE(1, fh + 2); // sections
  head.writeUInt32LE(symbols ? 0x300 : 0, fh + 8);
  head.writeUInt32LE(symbols, fh + 12);
  head.writeUInt16LE(240, fh + 16);
  head.writeUInt16LE(0x0022, fh + 18);
  const oh = fh + 20;
  head.writeUInt16LE(magic, oh);
  head.writeUInt16LE(subsystem, oh + 68);
  head.writeUInt16LE(dllChars, oh + 70);
  head.writeUInt32LE(16, oh + 108);
  head.writeUInt32LE(SECTION_RVA + importDir, oh + 112 + 8 * 1);
  head.writeUInt32LE((imports.length + 1) * 20, oh + 112 + 8 * 1 + 4);
  if (delayImports.length > 0) {
    head.writeUInt32LE(SECTION_RVA + delayDir, oh + 112 + 8 * 13);
    head.writeUInt32LE((delayImports.length + 1) * 32, oh + 112 + 8 * 13 + 4);
  }
  const sh = oh + 240;
  head.write('.idata\0\0', sh, 'latin1');
  head.writeUInt32LE(body.length, sh + 8);
  head.writeUInt32LE(SECTION_RVA, sh + 12);
  head.writeUInt32LE(body.length, sh + 16);
  head.writeUInt32LE(SECTION_RAW, sh + 20);
  return Buffer.concat([head, body, Buffer.from(extra, 'utf8')]);
}

const GOOD_IMPORTS = ['KERNEL32.dll', 'USER32.dll', 'SHELL32.dll', 'ADVAPI32.dll', 'GDI32.dll', 'COMCTL32.dll', 'msvcrt.dll'];

test('the synthetic PE builder makes something the parser reads back (control for the tests below)', () => {
  const pe = makePe({ imports: ['A.dll', 'B.dll'], delayImports: ['C.dll'] });
  assert.deepEqual(tray.parsePeImports(pe), ['A.dll', 'B.dll', 'C.dll']);
  assert.equal(tray.peSubsystem(pe), 2);
});

// ---------------------------------------------------------------------------------------------
// The compiler invocation
// ---------------------------------------------------------------------------------------------

test('gccArgs: the pinned flags, the version define, the output, sources, objects, then the libraries', () => {
  assert.deepEqual(
    tray.gccArgs({ out: '/o/t.exe', version: '1.2.3-rc.4', sources: ['/s/tray.c', '/s/host.c'], objects: ['/t/res.o', '/t/ver.o'] }),
    [
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
      '-DTRAY_APP_VERSION="1.2.3-rc.4"',
      '-o',
      '/o/t.exe',
      '/s/tray.c',
      '/s/host.c',
      '/t/res.o',
      '/t/ver.o',
      '-lcomctl32',
      '-lshell32',
      '-luser32',
      '-ladvapi32',
      '-lgdi32',
    ],
  );
});

test('gccArgs refuses a version that could carry anything into the define', () => {
  for (const bad of ['1.2', '1.2.3"', '1.2.3 -DX', '1.2.3-beta.1', '', undefined]) {
    assert.throws(() => tray.gccArgs({ out: '/o', version: bad, sources: [], objects: [] }), (e) => e.reason === 'branding', String(bad));
  }
});

test('the allowed imports are exactly the seven system DLLs', () => {
  assert.deepEqual([...tray.ALLOWED_IMPORTS].sort(), ['advapi32.dll', 'comctl32.dll', 'gdi32.dll', 'kernel32.dll', 'msvcrt.dll', 'shell32.dll', 'user32.dll']);
});

test('versionRc writes the eight tray strings and the numeric version, and nothing that names Node', () => {
  const rc = tray.versionRc('1.2.3-rc.4');
  for (const line of [
    'FILEVERSION 1,2,3,0',
    'PRODUCTVERSION 1,2,3,0',
    'VALUE "CompanyName", "DrNoisys Softworks"',
    'VALUE "FileDescription", "GM-Scriptorium"',
    'VALUE "FileVersion", "1.2.3-rc.4"',
    'VALUE "InternalName", "gm-scriptorium-tray"',
    'VALUE "LegalCopyright", "DrNoisys Softworks. MIT licence."',
    'VALUE "OriginalFilename", "gm-scriptorium-tray-win-x64.exe"',
    'VALUE "ProductName", "GM-Scriptorium"',
    'VALUE "ProductVersion", "1.2.3-rc.4"',
  ]) {
    assert.equal(rc.includes(line), true, line);
  }
  assert.equal((rc.match(/VALUE "/g) || []).length, 9, 'eight strings plus the translation');
  assert.equal(rc.includes('Node'), false);
});

// ---------------------------------------------------------------------------------------------
// The PE judge
// ---------------------------------------------------------------------------------------------

test('checkPe passes a GUI x64 image with the seven system imports, the mitigations and the manifest', () => {
  assert.equal(tray.checkPe(makePe({ imports: GOOD_IMPORTS })), null);
  // case-insensitive names
  assert.equal(tray.checkPe(makePe({ imports: ['kernel32.DLL', 'Msvcrt.dll'] })), null);
});

test('checkPe refuses each failure with its own reason', () => {
  assert.equal(tray.checkPe(Buffer.from('not a pe at all')), 'not-pe');
  assert.equal(tray.checkPe(makePe({ magic: 0x10b })), 'not-pe');
  assert.equal(tray.checkPe(makePe({ machine: 0x14c })), 'wrong-machine');
  assert.equal(tray.checkPe(makePe({ subsystem: 3 })), 'wrong-subsystem');
  assert.equal(tray.checkPe(makePe({ imports: [...GOOD_IMPORTS, 'WS2_32.dll'] })), 'import-not-allowed');
  assert.equal(tray.checkPe(makePe({ imports: ['KERNEL32.dll', 'libwinpthread-1.dll'] })), 'import-not-allowed');
  assert.equal(tray.checkPe(makePe({ delayImports: ['WININET.dll'] })), 'import-not-allowed');
  assert.equal(tray.checkPe(makePe({ extra: '<dpiAwareness>PerMonitorV2</dpiAwareness>' })), 'no-asinvoker');
  assert.equal(tray.checkPe(makePe({ extra: '<requestedExecutionLevel level="asInvoker"/>' })), 'no-dpi');
  assert.equal(tray.checkPe(makePe({ dllChars: 0x0040 | 0x0100 })), 'no-hardening');
  assert.equal(tray.checkPe(makePe({ dllChars: 0x0020 | 0x0100 })), 'no-hardening');
  assert.equal(tray.checkPe(makePe({ dllChars: 0x0020 | 0x0040 })), 'no-hardening');
  assert.equal(tray.checkPe(makePe({ symbols: 12 })), 'not-stripped');
});

test('peSubsystem reads the console subsystem too', () => {
  assert.equal(tray.peSubsystem(makePe({ subsystem: 3 })), 3);
});

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

test('parseArgs: build --out <abs> and check <exe>', () => {
  assert.deepEqual(tray.parseArgs(['build', '--out', '/a/b/gm-scriptorium-tray-win-x64.exe']), { mode: 'build', out: '/a/b/gm-scriptorium-tray-win-x64.exe' });
  assert.deepEqual(tray.parseArgs(['check', '/a/b.exe']), { mode: 'check', exe: '/a/b.exe' });
});

test('parseArgs: usage and bad-path refusals', () => {
  for (const argv of [[], ['make'], ['build'], ['build', '--out'], ['build', '--outt', '/a'], ['build', '--out', '/a', '--out', '/b'], ['check'], ['check', '/a', '/b']]) {
    assert.throws(() => tray.parseArgs(argv), (e) => e.reason === 'usage', JSON.stringify(argv));
  }
  for (const p of ['relative/x.exe', '/a b/x.exe', '/a/../x.exe', '/a/"x".exe', '/a/$(x).exe']) {
    assert.throws(() => tray.parseArgs(['build', '--out', p]), (e) => e.reason === 'bad-path', p);
  }
});

// ---------------------------------------------------------------------------------------------
// run(), with exec injected
// ---------------------------------------------------------------------------------------------

/** An exec that answers like mingw and writes `pe` as the output when gcc is asked to link. */
function fakeExec({ pe = makePe({ imports: GOOD_IMPORTS }), gccVersion = 'x86_64-w64-mingw32-gcc (GCC) 12-win32', fail = {}, calls = [] } = {}) {
  return (file, args) => {
    calls.push([file, ...args]);
    const key = file.endsWith('gcc') && args[0] === '--version' ? 'version' : file.endsWith('windres') ? 'windres' : file.endsWith('gcc') ? 'gcc' : 'winres';
    if (fail[key]) throw fail[key];
    if (key === 'version') return `${gccVersion}\nCopyright (C) 2022 Free Software Foundation, Inc.\n`;
    if (key === 'windres') {
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'coff');
      return '';
    }
    if (key === 'gcc') {
      fs.writeFileSync(args[args.indexOf('-o') + 1], pe);
      return '';
    }
    return 'WINRES-CHECK ok icons=8 strings=8\n';
  };
}

function runWith(dir, opts = {}) {
  const lines = [];
  const errs = [];
  const out = path.join(dir, 'gm-scriptorium-tray-win-x64.exe');
  const code = tray.run({ argv: opts.argv || ['build', '--out', out], exec: opts.exec || fakeExec(opts), version: opts.version || '1.2.3', stdout: (l) => lines.push(l), stderr: (l) => errs.push(l) });
  return { code, lines, errs, out };
}

test('run build: prints MINGW, TRAY and TRAY-CHECK lines and keeps the output', () => {
  const dir = tmp();
  try {
    const calls = [];
    const r = runWith(dir, { calls });
    assert.equal(r.code, 0, r.errs.join('\n'));
    assert.equal(r.lines[0], 'MINGW version=x86_64-w64-mingw32-gcc (GCC) 12-win32');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(r.out)).digest('hex');
    assert.equal(r.lines[1], `TRAY sha256=${hash} path=${r.out}`);
    assert.equal(r.lines[2], 'TRAY-CHECK ok');
    assert.equal(r.lines.length, 3);
    const winres = calls.find((c) => c[0] === process.execPath);
    assert.ok(winres, 'the branding check ran');
    assert.deepEqual(winres.slice(2), ['check-tray', r.out]);
    assert.ok(calls.some((c) => c[0] === 'x86_64-w64-mingw32-windres'), 'windres ran');
    const gcc = calls.find((c) => c[0] === 'x86_64-w64-mingw32-gcc' && c[1] !== '--version');
    assert.ok(gcc.includes('-DTRAY_APP_VERSION="1.2.3"'));
    assert.equal(gcc.some((a) => a.includes('TRAY_PURE_ONLY')), false, 'the test-only switch never reaches the real build');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run build: mingw missing fails closed with FAIL mingw-missing and writes nothing', () => {
  const dir = tmp();
  try {
    const enoent = Object.assign(new Error('spawn x86_64-w64-mingw32-gcc ENOENT'), { code: 'ENOENT' });
    const r = runWith(dir, { fail: { version: enoent } });
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ['FAIL mingw-missing']);
    assert.equal(fs.existsSync(r.out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run build: a mingw without the win32 thread model is refused (it would bring winpthread)', () => {
  const dir = tmp();
  try {
    const r = runWith(dir, { gccVersion: 'x86_64-w64-mingw32-gcc (GCC) 12-posix' });
    assert.equal(r.code, 1);
    assert.equal(r.lines.at(-1), 'FAIL mingw-missing');
    assert.equal(fs.existsSync(r.out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run build: each later failure removes the output and names its reason', () => {
  const cases = [
    [{ fail: { windres: new Error('windres: syntax error') } }, 'compile-failed'],
    [{ fail: { gcc: new Error('error: unused variable') } }, 'compile-failed'],
    [{ pe: makePe({ subsystem: 3 }) }, 'wrong-subsystem'],
    [{ pe: makePe({ imports: ['KERNEL32.dll', 'WS2_32.dll'] }) }, 'import-not-allowed'],
    [{ pe: makePe({ machine: 0x14c }) }, 'wrong-machine'],
    [{ pe: Buffer.from('MZ junk') }, 'not-pe'],
    [{ fail: { winres: Object.assign(new Error('exit 1'), { stdout: 'WINRES-CHECK fail reason=version-value-OriginalFilename\n' }) } }, 'branding'],
  ];
  for (const [opts, reason] of cases) {
    const dir = tmp();
    try {
      const r = runWith(dir, opts);
      assert.equal(r.code, 1, reason);
      assert.equal(r.lines.at(-1), `FAIL ${reason}`);
      assert.equal(fs.existsSync(r.out), false, `${reason}: the output is removed`);
      assert.deepEqual(fs.readdirSync(dir), [], `${reason}: nothing else is left behind`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('run build: never overwrites an existing output', () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'gm-scriptorium-tray-win-x64.exe');
    fs.writeFileSync(out, 'keep me');
    const r = runWith(dir);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ['FAIL out-exists']);
    assert.equal(fs.readFileSync(out, 'utf8'), 'keep me');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run build: the temporary resource folder is removed on success and on failure', () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gm-scriptorium-tray-build-')).length;
  for (const opts of [{}, { fail: { gcc: new Error('x') } }]) {
    const dir = tmp();
    try {
      runWith(dir, opts);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gm-scriptorium-tray-build-')).length;
  assert.equal(after, before);
});

test('run check: judges an existing exe without building, and leaves it alone on failure', () => {
  const dir = tmp();
  try {
    const exe = path.join(dir, 'x.exe');
    fs.writeFileSync(exe, makePe({ imports: GOOD_IMPORTS }));
    const ok = runWith(dir, { argv: ['check', exe] });
    assert.equal(ok.code, 0);
    assert.equal(ok.lines.at(-1), 'TRAY-CHECK ok');
    fs.writeFileSync(exe, makePe({ subsystem: 3 }));
    const bad = runWith(dir, { argv: ['check', exe] });
    assert.equal(bad.code, 1);
    assert.equal(bad.lines.at(-1), 'FAIL wrong-subsystem');
    assert.equal(fs.existsSync(exe), true, 'check never deletes what it was asked to read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a usage error prints FAIL usage', () => {
  const r = runWith(os.tmpdir(), { argv: ['frobnicate'] });
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines, ['FAIL usage']);
});

// ---------------------------------------------------------------------------------------------
// package.js: gate 8 and SHA256SUMS
// ---------------------------------------------------------------------------------------------

function fakeTarget(dir, assetName, content) {
  return () => {
    const outPath = path.join(dir, assetName);
    fs.writeFileSync(outPath, content);
    return { ok: true, outPath, assetName, hash: crypto.createHash('sha256').update(content).digest('hex') };
  };
}

test('package run: the tray is built after both targets and gets the third hash line, before the notices', () => {
  const dir = tmp();
  try {
    const order = [];
    const builds = { 'node22-win-x64': fakeTarget(dir, 'gm-scriptorium-win-x64.exe', 'win'), 'node22-linux-x64': fakeTarget(dir, 'gm-scriptorium-linux-x64', 'linux') };
    packageJs.run({}, {
      outDir: dir,
      buildTarget: ({ target }) => {
        order.push(target);
        return builds[target]();
      },
      buildTray: (outPath) => {
        order.push('tray');
        assert.equal(outPath, path.join(dir, 'gm-scriptorium-tray-win-x64.exe'));
        return fakeTarget(dir, 'gm-scriptorium-tray-win-x64.exe', 'tray')();
      },
      exit: (code) => assert.fail(`exit ${code}`),
    });
    assert.deepEqual(order, ['node22-win-x64', 'node22-linux-x64', 'tray']);
    const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const notices = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.txt'))).digest('hex');
    assert.equal(
      fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'),
      `${sha('win')}  gm-scriptorium-win-x64.exe\n${sha('linux')}  gm-scriptorium-linux-x64\n${sha('tray')}  gm-scriptorium-tray-win-x64.exe\n${notices}  THIRD-PARTY-NOTICES.txt\n`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('package run: a tray failure removes every output, writes no SHA256SUMS and exits 1', () => {
  const dir = tmp();
  try {
    let exitCode = null;
    packageJs.run({}, {
      outDir: dir,
      buildTarget: ({ target }) => (target === 'node22-win-x64' ? fakeTarget(dir, 'gm-scriptorium-win-x64.exe', 'w') : fakeTarget(dir, 'gm-scriptorium-linux-x64', 'l'))(),
      buildTray: (outPath) => {
        fs.writeFileSync(outPath, 'half-built');
        return { ok: false };
      },
      exit: (code) => {
        exitCode = code;
      },
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('package run: single-target mode (--target or --out) builds no tray', () => {
  const dir = tmp();
  try {
    let trayCalls = 0;
    packageJs.run({ out: path.join(dir, 'x.exe') }, {
      buildTarget: () => fakeTarget(dir, 'x.exe', 'x')(),
      buildTray: () => {
        trayCalls++;
        return { ok: false };
      },
      exit: (code) => assert.fail(`exit ${code}`),
    });
    assert.equal(trayCalls, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('package.js runs scripts/tray.js build with --out and clears a stale helper first', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'package.js'), 'utf8');
  assert.match(source, /\[TRAY_SCRIPT, 'build', '--out', outPath\]/);
  const fn = source.slice(source.indexOf('function buildTray('));
  const clear = fn.indexOf('fs.rmSync(outPath, { force: true })');
  const build = fn.indexOf("[TRAY_SCRIPT, 'build'");
  assert.ok(clear > 0 && build > clear, 'a helper left by an earlier run is removed before the build');
});

// ---------------------------------------------------------------------------------------------
// The pure C, built for this machine (no Win32), and the real cross build
// ---------------------------------------------------------------------------------------------

const haveCc = spawnSync('cc', ['--version'], { encoding: 'utf8' }).status === 0;
const haveMingw = spawnSync('x86_64-w64-mingw32-gcc', ['--version'], { encoding: 'utf8' }).status === 0;

const HARNESS = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "tray.h"

static int unhex(const char *h, char *out, size_t cap)
{
    size_t n = strlen(h) / 2;
    if (n > cap) return -1;
    for (size_t i = 0; i < n; i++) {
        unsigned v;
        if (sscanf(h + 2 * i, "%2x", &v) != 1) return -1;
        out[i] = (char)v;
    }
    return (int)n;
}

static void hex(const char *s, size_t n)
{
    for (size_t i = 0; i < n; i++) printf("%02x", (unsigned char)s[i]);
}

static void emit(void *ctx, const char *line, size_t len)
{
    (void)ctx;
    printf("L ");
    hex(line, len);
    printf("\n");
}

int main(void)
{
    static char in[1 << 16];
    static char buf[1 << 15];
    while (fgets(in, sizeof in, stdin)) {
        in[strcspn(in, "\n")] = 0;
        if (in[0] == 'P') {
            int n = unhex(in + 2, buf, sizeof buf);
            struct proto_line pl;
            if (n < 0 || !proto_parse_line(buf, (size_t)n, &pl)) { printf("NULL\n"); continue; }
            printf("OK %s %zu", pl.is_host ? proto_host_verb(pl.verb) : proto_helper_verb(pl.verb), pl.nargs);
            for (size_t i = 0; i < pl.nargs && i < TRAY_MAX_FIELDS; i++) { printf(" "); hex(pl.args[i], strlen(pl.args[i])); printf("."); }
            printf("\n");
        } else if (in[0] == 'E') {
            const char *fields[16];
            static char store[16][2048];
            size_t nf = 0;
            char *p = in + 2;
            for (;;) {
                char *comma = strchr(p, ',');
                if (comma) *comma = 0;
                int n = unhex(p, store[nf], sizeof store[nf] - 1);
                store[nf][n < 0 ? 0 : n] = 0;
                fields[nf] = store[nf];
                nf++;
                if (!comma) break;
                p = comma + 1;
            }
            char out[TRAY_MAX_LINE_BYTES + 1];
            int len = proto_encode_line(fields, nf, out, sizeof out);
            if (len < 0) printf("ERR\n");
            else { printf("OK "); hex(out, (size_t)len); printf("\n"); }
        } else if (in[0] == 'S') {
            struct line_splitter sp;
            splitter_init(&sp);
            int n = unhex(in + 2, buf, sizeof buf);
            size_t half = (size_t)n / 2;
            splitter_feed(&sp, buf, half, emit, NULL);
            splitter_feed(&sp, buf + half, (size_t)n - half, emit, NULL);
            splitter_finish(&sp, emit, NULL);
            printf("END\n");
        } else if (in[0] == 'U') {
            printf("%d\n", notes_url_ok(in + 2));
        } else if (in[0] == 'H') {
            char *tab = strchr(in + 2, '\t');
            if (tab) *tab = 0;
            printf("%d\n", hello_matches(in + 2, tab ? tab + 1 : ""));
        } else if (in[0] == 'D') {
            wchar_t w[64];
            mbstowcs(w, in + 2, 63);
            w[63] = 0;
            printf("%d\n", port_field_ok(w));
        } else if (in[0] == 'A') {
            wchar_t w[300];
            mbstowcs(w, in + 2, 299);
            w[299] = 0;
            printf("%d\n", path_is_absolute(w));
        } else if (in[0] == 'B') {
            int kind = atoi(in + 2);
            enum { W = 32 };
            uint32_t px[W * W];
            for (int i = 0; i < W * W; i++) px[i] = 0x11223344u;
            badge_paint(px, W, W, kind);
            int changed = 0;
            for (int i = 0; i < W * W; i++) changed += px[i] != 0x11223344u;
            printf("%08x %08x %d\n", (unsigned)px[0], (unsigned)px[(W - 7) * W + (W - 7)], changed);
        } else if (in[0] == 'V') {
            /* env block: entries separated by | in the input */
            static wchar_t block[4096];
            wchar_t *q = block;
            char *dir = in + 2;
            char *bar = strchr(dir, ' ');
            *bar = 0;
            char *e = bar + 1;
            while (*e) {
                char *sep = strchr(e, '|');
                if (sep) *sep = 0;
                size_t k = mbstowcs(q, e, 512);
                q += k + 1;
                if (!sep) break;
                e = sep + 1;
            }
            *q = 0;
            wchar_t wdir[300];
            mbstowcs(wdir, dir, 299);
            wchar_t *outb = env_with_path_first(block, wdir);
            if (!outb) { printf("NULL\n"); continue; }
            for (wchar_t *r = outb; *r; r += wcslen(r) + 1) printf("[%ls]", r);
            printf("\n");
            free(outb);
        } else if (in[0] == 'T') {
            wchar_t w[300], d[8];
            mbstowcs(w, in + 2, 299);
            w[299] = 0;
            wtrunc(d, 8, w);
            printf("[%ls]\n", d);
        } else if (in[0] == 'G') {
            const char *fields[16];
            static char gstore[16][256];
            size_t nf = 0;
            char *p = in + 2;
            for (;;) {
                char *comma = strchr(p, ',');
                if (comma) *comma = 0;
                int n = unhex(p, gstore[nf], sizeof gstore[nf] - 1);
                gstore[nf][n < 0 ? 0 : n] = 0;
                fields[nf] = gstore[nf];
                nf++;
                if (!comma) break;
                p = comma + 1;
            }
            printf("%d\n", signin_confirmed(fields, nf));
        } else if (in[0] == 'K') {
            int a = 0, b = 0, c = 0, d = 0;
            if (sscanf(in + 2, "%d %d %d %d", &a, &b, &c, &d) != 4) { printf("BAD\n"); continue; }
            printf("%d\n", signin_item(a, b, c, d));
        } else if (in[0] == 'Q') {
            int a = 0, b = 0;
            if (sscanf(in + 2, "%d %d", &a, &b) != 2) { printf("BAD\n"); continue; }
            printf("%d\n", signin_header_shown(a, b));
        } else if (in[0] == 'J') {
            int a = 0, b = 0;
            if (sscanf(in + 2, "%d %d", &a, &b) != 2) { printf("BAD\n"); continue; }
            printf("%d\n", signin_write_failed(a, b));
        } else if (in[0] == 'R') {
            /* A whole host line, read the way tray.c reads it: the protocol parser, signin-local as the
             * fifth argument (pinned in tray-structure), signin_confirmed(), a remote reach, signin_item(),
             * signin_header_shown(). */
            int n = unhex(in + 2, buf, sizeof buf);
            struct proto_line pl;
            if (n < 0 || !proto_parse_line(buf, (size_t)n, &pl) || !pl.is_host || pl.verb != HOST_STATE || pl.nargs < 4 || strcmp(pl.args[0], "running") != 0) { printf("NOT-RUNNING\n"); continue; }
            size_t na = pl.nargs < TRAY_MAX_FIELDS ? pl.nargs : TRAY_MAX_FIELDS;
            int sl = na > 4 && strcmp(pl.args[4], "signin-local") == 0;
            int conf = signin_confirmed((const char *const *)pl.args, na);
            const char *r = pl.args[2];
            int remote = strcmp(r, "ssh") == 0 || strcmp(r, "tailscale") == 0 || strcmp(r, "proxy") == 0 || strcmp(r, "direct") == 0;
            printf("%d %d %d %d %d\n", sl, conf, remote, signin_item(1, remote, sl, 1), signin_header_shown(sl, conf));
        }
        fflush(stdout);
    }
    return 0;
}
`;

function buildHarness(dir) {
  const src = path.join(dir, 'harness.c');
  fs.writeFileSync(src, HARNESS);
  const exe = path.join(dir, 'harness');
  const r = spawnSync('cc', ['-std=c17', '-Wall', '-Wextra', '-Werror', '-DTRAY_PURE_ONLY', '-DTRAY_APP_VERSION="9.8.7"', '-I', TRAY_DIR, '-o', exe, src, path.join(TRAY_DIR, 'host.c')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return exe;
}

function harness(exe, lines) {
  const r = spawnSync(exe, [], { input: `${lines.join('\n')}\n`, encoding: 'utf8', env: { LC_ALL: 'C.UTF-8' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trimEnd().split('\n');
}

const hx = (s) => Buffer.from(s, 'utf8').toString('hex');

/** What src/desktop/protocol.js says for a line, in the harness's output format. */
function jsParse(text) {
  const p = protocol.parseLine(text);
  if (p === null) return 'NULL';
  const args = p.args.slice(0, 8).map((a) => ` ${hx(a)}.`).join('');
  return `OK ${p.verb} ${p.args.length}${args}`;
}

function jsEncode(fields) {
  try {
    return `OK ${hx(protocol.encodeLine(fields))}`;
  } catch {
    return 'ERR';
  }
}

const PARSE_CASES = [
  'hello\t1\t0.5.0\tD:\\scratch\\Scriptorium\\panel\\logs\n',
  'state\trunning\tlong-lease\tlocal\thttp://127.0.0.1:7400\n',
  'state\trunning\tharbour-watch\tlocal\thttp://127.0.0.1:7400',
  'state\terror\tport\tfailed to start server: port 7400 is already in use on 127.0.0.1\t7400\n',
  'state\tstarting\t-\tOpening your vault\n',
  'confirm\tremote\n',
  'update\t0.5.1\thttps://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v0.5.1\n',
  'bye\tquit\n',
  'open\n',
  'open\tpreview\n',
  'stop?\n',
  'quit?\n',
  'quit',
  'state\n',
  'signin\ton\n',
  'state\t\t\t\n',
  'state\trunning\tcaf\u00e9 \u4e2d\u6587\tlocal\thttp://127.0.0.1:7400\n',
  'a\tb\tc\td\te\tf\tg\th\ti\tj\tk\n',
  'state\ta\tb\tc\td\te\tf\tg\th\ti\tj\tk\n',
  '',
  '\n',
  '\n\n',
  'hello\r\n',
  'state\trunning\r',
  'state\tx\ny\n',
  'state\tx\u0001\n',
  'state\tx\u007f\n',
  'state\tx\u0000y\n',
  'Hello\n',
  'helloo\n',
  ' hello\n',
  '\thello\n',
  'ping\n',
  `state\t${'a'.repeat(1017)}\n`,
  `state\t${'a'.repeat(1018)}\n`,
  `state\t${'a'.repeat(1018)}`,
  `state\t${'a'.repeat(1019)}`,
  `state\t${'\u00e9'.repeat(509)}\n`,
  `state\t${'\u00e9'.repeat(510)}\n`,
];

const ENCODE_CASES = [
  ['quit'],
  ['open', 'preview'],
  ['signin', 'on'],
  ['state', 'running', 'long-lease', 'local', 'http://127.0.0.1:7400'],
  ['state', 'x\ty', 'a\nb', 'c\rd'],
  ['state', '\u0000\u0001\u001f\u007f'],
  ['bye', ''],
  ['', ''],
  ['state', 'caf\u00e9'],
  ['state', 'a'.repeat(1017)],
  ['state', 'a'.repeat(1018)],
  ['state', `${'a'.repeat(1017)}\u0001\u0002`],
  ['state', '\u00e9'.repeat(509)],
  ['state', '\u00e9'.repeat(510)],
];

test('pure C, built for this machine: parse and encode agree with src/desktop/protocol.js', { skip: haveCc ? false : 'no host C compiler (cc) on PATH' }, () => {
  const dir = tmp();
  try {
    const exe = buildHarness(dir);
    const parsed = harness(exe, PARSE_CASES.map((c) => `P ${hx(c)}`));
    assert.deepEqual(parsed, PARSE_CASES.map(jsParse));
    const encoded = harness(exe, ENCODE_CASES.map((f) => `E ${f.map(hx).join(',')}`));
    assert.deepEqual(encoded, ENCODE_CASES.map(jsEncode));
    // A few typed independently of protocol.js, so a change on both sides still shows.
    assert.equal(harness(exe, [`P ${hx('hello\r\n')}`])[0], 'NULL');
    assert.equal(harness(exe, [`P ${hx('quit')}`])[0], 'OK quit 0');
    assert.equal(harness(exe, [`E ${[hx('open'), hx('pre\tview')].join(',')}`])[0], `OK ${hx('open\tpreview\n')}`);
    assert.equal(harness(exe, [`E ${[hx('state'), hx('a'.repeat(1018))].join(',')}`])[0], 'ERR');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pure C: the reader splits lines, drops an over-long one whole, and keeps a last line with no LF', { skip: haveCc ? false : 'no host C compiler (cc) on PATH' }, () => {
  const dir = tmp();
  try {
    const exe = buildHarness(dir);
    const long = `state\t${'a'.repeat(1100)}\n`;
    const exact = `state\t${'b'.repeat(1017)}\n`; // 1024 bytes with the LF
    const over = `state\t${'c'.repeat(1018)}\n`; // 1025 bytes
    const input = `hello\t1\nopen\n${long}${exact}${over}quit`;
    assert.deepEqual(harness(exe, [`S ${hx(input)}`]), [`L ${hx('hello\t1\n')}`, `L ${hx('open\n')}`, `L ${hx(exact)}`, `L ${hx('quit')}`, 'END']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pure C: the patch-notes address, the hello check, the port fields and absolute paths', { skip: haveCc ? false : 'no host C compiler (cc) on PATH' }, () => {
  const dir = tmp();
  try {
    const exe = buildHarness(dir);
    const base = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v';
    const urls = [
      [`${base}0.5.1`, 1],
      [`${base}1.0.0-rc.1`, 1],
      [`${base}${'a'.repeat(40)}`, 1],
      [`${base}${'a'.repeat(41)}`, 0],
      [base, 0],
      [`${base}0.5.1/`, 0],
      [`${base}0.5.1?x=1`, 0],
      [`${base}0.5.1#x`, 0],
      [`${base}0.5_1`, 0],
      [`http://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v0.5.1`, 0],
      [`https://github.com.evil.example/DrNoisys-Softworks/gm-scriptorium/releases/tag/v0.5.1`, 0],
      [`https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/x0.5.1`, 0],
      [`https://github.com/other/gm-scriptorium/releases/tag/v0.5.1`, 0],
      [`HTTPS://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v0.5.1`, 0],
      ['', 0],
    ];
    assert.deepEqual(harness(exe, urls.map(([u]) => `U ${u}`)), urls.map(([, v]) => String(v)));
    // the harness was built with TRAY_APP_VERSION "9.8.7"
    assert.deepEqual(harness(exe, ['H 1\t9.8.7', 'H 1\t9.8.8', 'H 2\t9.8.7', 'H 1\t9.8.7 ', 'H 01\t9.8.7', 'H 1\t']), ['1', '0', '0', '0', '0', '0']);
    const ports = [['7400', 1], ['1', 1], ['65535', 1], ['99999', 1], ['123456', 0], ['', 0], ['74 0', 0], ['-1', 0], ['7400a', 0], ['+74', 0], ['0x1F', 0]];
    assert.deepEqual(harness(exe, ports.map(([p]) => `D ${p}`)), ports.map(([, v]) => String(v)));
    const paths = [['D:\\scratch\\panel\\logs', 1], ['c:\\x', 1], ['\\\\server\\share\\logs', 1], ['C:logs', 0], ['logs', 0], ['\\logs', 0], ['', 0], ['C:/x', 0]];
    assert.deepEqual(harness(exe, paths.map(([p]) => `A ${p}`)), paths.map(([, v]) => String(v)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pure C: the badges paint the corner only, each kind in its own colour', { skip: haveCc ? false : 'no host C compiler (cc) on PATH' }, () => {
  const dir = tmp();
  try {
    const exe = buildHarness(dir);
    // kinds 0 none, 1 starting, 2 error, 3 update, 4 stopped; the sampled point is inside the badge
    const out = harness(exe, ['B 0', 'B 1', 'B 2', 'B 3', 'B 4']).map((l) => l.split(' '));
    assert.deepEqual(out[0], ['11223344', '11223344', '0']);
    for (const row of out.slice(1)) {
      assert.equal(row[0], '11223344', 'the top-left corner is untouched');
      assert.ok(Number(row[2]) > 50, 'a badge was painted');
    }
    assert.equal(out[2][1], 'ffc42b1c', 'error red');
    assert.equal(out[3][1], 'ff0f6cbd', 'update blue');
    assert.equal(out[4][1], 'ff8a8a8a', 'stopped grey');
    assert.equal(out[1][1], 'ffffffff', 'starting is a white dot in a ring');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pure C: the command line environment puts the install folder first on PATH, nowhere else', { skip: haveCc ? false : 'no host C compiler (cc) on PATH' }, () => {
  const dir = tmp();
  try {
    const exe = buildHarness(dir);
    assert.deepEqual(harness(exe, ['V C:\\GM =C:=C:\\|ALLUSERSPROFILE=C:\\ProgramData|Path=C:\\Windows;C:\\bin|USERPROFILE=D:\\profile']), [
      '[=C:=C:\\][ALLUSERSPROFILE=C:\\ProgramData][Path=C:\\GM;C:\\Windows;C:\\bin][USERPROFILE=D:\\profile]',
    ]);
    assert.deepEqual(harness(exe, ['V C:\\GM =C:=C:\\|ALLUSERSPROFILE=C:\\ProgramData|USERPROFILE=D:\\profile']), [
      '[=C:=C:\\][ALLUSERSPROFILE=C:\\ProgramData][PATH=C:\\GM][USERPROFILE=D:\\profile]',
    ]);
    assert.deepEqual(harness(exe, ['V C:\\GM PATH=x|PATHEXT=.EXE']), ['[PATH=C:\\GM;x][PATHEXT=.EXE]']);
    assert.deepEqual(harness(exe, ['T abcdefghij', 'T abc']), ['[abcdefg]', '[abc]']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real cross build: the helper builds, passes every check, and builds the same bytes twice', { skip: haveMingw ? false : 'mingw-w64 (x86_64-w64-mingw32-gcc) is not installed' }, () => {
  const dir = tmp();
  try {
    const hashes = [];
    for (const name of ['a.exe', 'b.exe']) {
      const out = path.join(dir, name);
      const lines = [];
      const errs = [];
      const code = tray.run({ argv: ['build', '--out', out], stdout: (l) => lines.push(l), stderr: (l) => errs.push(l) });
      assert.equal(code, 0, `${lines.join('\n')}\n${errs.join('\n')}`);
      assert.match(lines[0], /^MINGW version=x86_64-w64-mingw32-gcc .*-win32/);
      assert.equal(lines.at(-1), 'TRAY-CHECK ok');
      const pe = fs.readFileSync(out);
      assert.equal(tray.peSubsystem(pe), 2);
      for (const dll of tray.parsePeImports(pe)) assert.ok(tray.ALLOWED_IMPORTS.includes(dll.toLowerCase()), dll);
      hashes.push(crypto.createHash('sha256').update(pe).digest('hex'));
    }
    assert.equal(hashes[0], hashes[1], 'two builds of the same source give the same bytes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real build uses the package.json version for the define', () => {
  assert.ok(tray.gccArgs({ out: '/o', version: VERSION, sources: [], objects: [] }).includes(`-DTRAY_APP_VERSION="${VERSION}"`));
});

test('CI packaged-smoke installs the three mingw-w64 packages, and records their versions, before it packages', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const lines = yml.split('\n');
  const start = lines.indexOf('  packaged-smoke:');
  assert.ok(start > 0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const job = lines.slice(start, end);
  const at = (text) => job.indexOf(text);
  const update = at('      - run: sudo apt-get update');
  const install = at('      - run: sudo apt-get install -y --no-install-recommends gcc-mingw-w64-x86-64-win32 binutils-mingw-w64-x86-64 mingw-w64-x86-64-dev');
  const policy = at('      - run: apt-cache policy gcc-mingw-w64-x86-64-win32 binutils-mingw-w64-x86-64 mingw-w64-x86-64-dev');
  const pkg = at('      - run: npm run package');
  assert.ok(update > 0 && install > update && policy > install && pkg > policy, 'update, install, policy, then package');
  const testJob = yml.slice(yml.indexOf('\n  test:'), yml.indexOf('\n  packaged-smoke:'));
  assert.equal(testJob.includes('mingw'), false, 'the pull-request test job stays as it was');
});

test('pure C: signin= on a running line is found by exact text after the address, and missing means unconfirmed', { skip: haveCc ? false : 'no host C compiler (cc) on PATH' }, () => {
  const dir = tmp();
  try {
    const exe = buildHarness(dir);
    // args after the verb, as the host sends them (ADR 0057 section 7 and Protocol v1)
    const cases = [
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa', 'signin=confirmed'], 1],
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa', 'signin=unconfirmed'], 0],
      [['running', 'long-lease', 'local', 'http://127.0.0.1:7400', 'signin-local', 'signin=unconfirmed'], 0],
      [['running', 'long-lease', 'local', 'http://127.0.0.1:7400', 'signin-local', 'signin=confirmed'], 1],
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa'], 0],
      [['running', 'long-lease', 'local', 'http://127.0.0.1:7400', 'signin-local'], 0],
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa', 'later=1', 'signin=confirmed'], 1],
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa', 'signin=confirmed', 'later=1'], 1],
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa', 'signin=unconfirmed', 'signin=confirmed'], 1],
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa', 'signin=confirmed', 'signin=unconfirmed'], 0],
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa', 'signin=CONFIRMED'], 0],
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa', 'signin=confirmed '], 0],
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa', 'signin=yes'], 0],
      [['running', 'long-lease', 'proxy', 'https://scriptorium.home.arpa', 'signin='], 0],
      [['running', 'signin=confirmed', 'proxy', 'https://scriptorium.home.arpa'], 0],
      [['running', 'long-lease', 'proxy', 'signin=confirmed'], 0],
      [['running'], 0],
    ];
    assert.deepEqual(harness(exe, cases.map(([f]) => `G ${f.map(hx).join(',')}`)), cases.map(([, v]) => String(v)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pure C: signin_item, signin_header_shown and signin_write_failed for each case', { skip: haveCc ? false : 'no host C compiler (cc) on PATH' }, () => {
  const dir = tmp();
  try {
    const exe = buildHarness(dir);
    // signin_item(running, remote reach, signin-local, Start with Windows ticked) > 0 hidden, 1 greyed, 2 enabled
    const item = [
      ['0 1 0 1', 0], ['0 0 1 1', 0], ['1 0 0 1', 0], ['1 0 0 0', 0],
      ['1 1 0 1', 2], ['1 1 0 0', 1], ['1 0 1 1', 2], ['1 0 1 0', 1], ['1 1 1 1', 2],
    ];
    assert.deepEqual(harness(exe, item.map(([a]) => `K ${a}`)), item.map(([, v]) => String(v)));
    // signin_header_shown(signin-local, signin=confirmed)
    const header = [['0 0', 0], ['0 1', 0], ['1 0', 1], ['1 1', 0]];
    assert.deepEqual(harness(exe, header.map(([a]) => `Q ${a}`)), header.map(([, v]) => String(v)));
    // signin_write_failed(asked: 0 none, 1 off, 2 on; signin=confirmed)
    const failed = [['0 0', 0], ['0 1', 0], ['1 0', 0], ['1 1', 1], ['2 0', 1], ['2 1', 0]];
    assert.deepEqual(harness(exe, failed.map(([a]) => `J ${a}`)), failed.map(([, v]) => String(v)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Contract: the real host (src/desktop/host.js) writes the running lines, the tray's C reads them
// ---------------------------------------------------------------------------------------------

const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const { runDesktopHost } = require('../src/desktop/host');
const { writeConfigFile } = require('../src/config/write');
const { scratchRoot, copySample } = require('./helpers/setup-fixtures');
const { testPort } = require('./helpers/ports');

const CONTRACT_PANEL = testPort(9476);
const CONTRACT_PREVIEW = testPort(9477);
const CONTRACT_REMOTE_PORT = testPort(9478);
const CONTRACT_REMOTE_PREVIEW = testPort(9479);
const CONTRACT_REMOTE = `\n[remote]\nmode = "tailscale"\nport = ${CONTRACT_REMOTE_PORT}\npreview_port = ${CONTRACT_REMOTE_PREVIEW}\nadmin_url = "https://scriptorium.home.arpa"\npreview_url = "https://preview.scriptorium.home.arpa"\n`;

/**
 * The first state running line main's host writes for this config, with a stand-in panel (no port is bound).
 * With signinOn, the helper's `signin on` is sent after that line and the line the host sends next is returned.
 */
async function hostRunningLine(t, { extraDesktop = '', background, panelMode, signinOn = false }) {
  const root = scratchRoot(t);
  const configPath = path.join(root, 'cfg', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const vault = copySample(root, 'vault', { withPack: true });
  writeConfigFile(configPath, { config_version: 1, default_campaign: 'lease', campaigns: { lease: { vault, output: path.join(root, 'site') } } });
  fs.appendFileSync(configPath, `\n[desktop]\nport = ${CONTRACT_PANEL}\npreview_port = ${CONTRACT_PREVIEW}\n${extraDesktop}` + CONTRACT_REMOTE);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c; });
  const settings = panelMode === 'local' ? { mode: 'local' } : { mode: panelMode, admin_url: 'https://scriptorium.home.arpa' };
  const panel = () => ({
    ok: true,
    ctx: { campaign: 'lease', adminPort: CONTRACT_PANEL, previewPort: CONTRACT_PREVIEW, busy: null, remote: { paths: { panelDir: path.join(root, 'cfg', 'panel') } }, ctxInfo: { config: { campaigns: {} } }, updateNotice: { snapshot: () => ({ state: 'current', dismissed: false, latestTag: null, notesUrl: null }) } },
    token: 'fake', settings, plan: {}, planned: {}, setup: false, stop: async () => {},
  });
  const proc = new EventEmitter();
  proc.pid = 4243;
  let sent = false;
  const run = runDesktopHost({ background }, {
    input, output, env: { PATH: '/nonexistent' }, version: '0.0.0-test', startPanel: async () => panel(),
    openFile: async () => ({ outcome: 'exited', exitCode: 0, signal: null }), killAll: async () => {},
    configPath, retryDelaysMs: [5], pollMs: 10, proc, pid: 4243, hostname: () => 'PC-A',
  });
  const started = Date.now();
  const runningLines = () => text.split('\n').filter((l) => l.startsWith('state\trunning\t'));
  const want = signinOn ? 2 : 1;
  while (runningLines().length < want) {
    if (Date.now() - started > 8000) throw new Error(`no running line (have ${JSON.stringify(text)})`);
    if (signinOn && runningLines().length === 1 && !input.writableEnded && !sent) {
      sent = true;
      input.write('signin\ton\n');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  const line = runningLines()[want - 1];
  input.end();
  await run;
  return `${line}\n`;
}

test('contract: the tray reads the running lines main\'s host writes, and shows the ruled line for each case', { skip: haveCc ? false : 'no host C compiler (cc) on PATH' }, async (t) => {
  const confirmed = await hostRunningLine(t, { extraDesktop: 'remote_at_signin = true\nremote_at_signin_pc = "PC-A"\n', background: true, panelMode: 'tailscale' });
  const gmRemote = await hostRunningLine(t, { background: false, panelMode: 'tailscale' });
  const signinLocal = await hostRunningLine(t, { background: true, panelMode: 'local' });
  const signinLocalTicked = await hostRunningLine(t, { background: true, panelMode: 'local', signinOn: true });
  // The host side, as S2 defines it (ADR 0057 "Protocol v1")
  assert.match(confirmed, /\tsignin=confirmed\n$/);
  assert.equal(confirmed.includes('signin-local'), false);
  assert.match(gmRemote, /\ttailscale\t[^\t]+\tsignin=unconfirmed\n$/);
  assert.match(signinLocal, /\tlocal\thttp:\/\/127\.0\.0\.1:\d+\tsignin-local\tsignin=unconfirmed\n$/);
  // After the helper ticks the item the panel is still held back (signin-local stays) and the line says confirmed.
  assert.match(signinLocalTicked, /\tlocal\thttp:\/\/127\.0\.0\.1:\d+\tsignin-local\tsignin=confirmed\n$/);
  const dir = tmp();
  try {
    const exe = buildHarness(dir);
    // signin-local, signin=confirmed, remote reach, signin_item (2 enabled), signin_header_shown
    assert.deepEqual(harness(exe, [confirmed, gmRemote, signinLocal].map((l) => `R ${hx(l)}`)), ['0 1 1 2 0', '0 0 1 2 0', '1 0 0 2 1']);
    assert.deepEqual(harness(exe, [`R ${hx(signinLocalTicked)}`]), ['1 1 0 2 0']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
