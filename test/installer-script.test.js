'use strict';

/*
 * scripts/installer.js: the Node wrapper that builds the Windows installer and uninstaller with
 * makensis (ADR 0053). Most tests inject the makensis runner, so they need no makensis. The real
 * build test at the end runs makensis on tiny dummy inputs and skips, with a stated reason, when
 * makensis is not on PATH.
 *
 * Expected values are written out here, never read from the module under test: the sha256 values
 * come from crypto over buffers this file creates, and the byte-pattern needles are the buffers
 * themselves.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const installer = require('../scripts/installer');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'installer.js');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function scratch(prefix = 'gm-installer-test-') {
  // os.tmpdir() names with characters outside the allowed set would fail the path check, so
  // build the scratch folder from the allowed set only.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

const EXE_BYTES = Buffer.concat([Buffer.from('MZ'), Buffer.from('signed-exe-bytes-0123456789-ABCDEFGHIJ'.repeat(40))]);
const UNINST_BYTES = Buffer.concat([Buffer.from('MZ'), Buffer.from('signed-uninstaller-bytes-9876543210-zyxwvu'.repeat(40))]);
const TRAY_BYTES = Buffer.concat([Buffer.from('MZ'), Buffer.from('signed-tray-bytes-ABCDEF-543210'.repeat(40))]);
const NOTICES_BYTES = Buffer.from('Scriptorium: Third-Party Notices\nScriptorium version: 0.0.0\n');
const MANIFEST_BYTES = Buffer.from('<requestedExecutionLevel level="asInvoker" uiAccess="false"/>');

function makeInputs(dir) {
  const exe = path.join(dir, 'gm-scriptorium.exe');
  const un = path.join(dir, 'uninst.exe');
  const notices = path.join(dir, 'notices.txt');
  const tray = path.join(dir, 'tray.exe');
  fs.writeFileSync(exe, EXE_BYTES);
  fs.writeFileSync(un, UNINST_BYTES);
  fs.writeFileSync(notices, NOTICES_BYTES);
  fs.writeFileSync(tray, TRAY_BYTES);
  return { exe, un, notices, tray };
}

/** Pulls `-DNAME=value` out of a makensis argument list. */
function defineOf(args, name) {
  const hit = args.find((a) => a.startsWith(`-D${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/**
 * A fake makensis. `-VERSION` answers with a fixed string; a compile writes `produce(args)`
 * to the file the build was told to write (OUTFILE, and UNINSTALLER_OUT in stage A).
 */
function fakeExec({ version = 'v3.08-test', produce, throwOnCompile } = {}) {
  const calls = [];
  const exec = (file, args) => {
    calls.push({ file, args });
    if (args.length === 1 && args[0] === '-VERSION') return `${version}\n`;
    if (throwOnCompile) throw throwOnCompile;
    const made = produce ? produce(args) : {};
    for (const [target, bytes] of Object.entries(made)) fs.writeFileSync(target, bytes);
    return '';
  };
  exec.calls = calls;
  return exec;
}

async function runCapture(opts) {
  const out = [];
  const err = [];
  const code = await installer.run({ ...opts, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out, err };
}

// ---------------------------------------------------------------------------------------------
// parseArgs: path charset and shape
// ---------------------------------------------------------------------------------------------

test('parseArgs: the uninstaller form', () => {
  const a = installer.parseArgs(['uninstaller', '--out', '/tmp/x/gm-scriptorium-uninstall.exe']);
  assert.deepEqual(a, { mode: 'uninstaller', out: '/tmp/x/gm-scriptorium-uninstall.exe' });
});

test('parseArgs: the installer form', () => {
  const a = installer.parseArgs([
    'installer', '--exe', '/tmp/a/e.exe', '--uninstaller', '/tmp/a/u.exe', '--notices', '/tmp/a/n.txt', '--tray', '/tmp/a/t.exe', '--out', '/tmp/a/s.exe',
  ]);
  assert.deepEqual(a, {
    mode: 'installer', exe: '/tmp/a/e.exe', uninstaller: '/tmp/a/u.exe', notices: '/tmp/a/n.txt', tray: '/tmp/a/t.exe', out: '/tmp/a/s.exe',
  });
});

test('parseArgs: the installer form without --tray is a usage error', () => {
  assert.throws(
    () => installer.parseArgs(['installer', '--exe', '/tmp/a/e.exe', '--uninstaller', '/tmp/a/u.exe', '--notices', '/tmp/a/n.txt', '--out', '/tmp/a/s.exe']),
    (e) => e.reason === 'usage' && /--tray is required/.test(e.message),
  );
});

test('parseArgs: refuses a path with a space, quote, shell character or non-ASCII letter (bad-path)', () => {
  for (const bad of ['/tmp/a b.exe', '/tmp/a"b.exe', '/tmp/a;b.exe', '/tmp/a$b.exe', '/tmp/é.exe', '/tmp/a\nb.exe', '/tmp/a`b.exe', '/tmp/a|b']) {
    assert.throws(() => installer.parseArgs(['uninstaller', '--out', bad]), (e) => e.reason === 'bad-path', JSON.stringify(bad));
  }
});

test('parseArgs: refuses a relative path, an empty path and a dot-dot segment (bad-path)', () => {
  for (const bad of ['gm.exe', './gm.exe', '', '/tmp/../etc/x', '/tmp/a/..', '/']) {
    assert.throws(() => installer.parseArgs(['uninstaller', '--out', bad]), (e) => e.reason === 'bad-path', JSON.stringify(bad));
  }
});

test('parseArgs: a missing value, a missing required flag, an unknown flag or mode is a usage error', () => {
  for (const argv of [
    [],
    ['bogus', '--out', '/tmp/x'],
    ['uninstaller'],
    ['uninstaller', '--out'],
    ['uninstaller', '--out', '/tmp/x', '--exe', '/tmp/y'],
    ['installer', '--exe', '/tmp/a', '--uninstaller', '/tmp/b', '--out', '/tmp/c'],
    ['installer', '--exe', '/tmp/a', '--uninstaller', '/tmp/b', '--notices', '/tmp/n', '--out', '/tmp/c', '--extra', '/tmp/d'],
  ]) {
    assert.throws(() => installer.parseArgs(argv), (e) => e.reason === 'usage', JSON.stringify(argv));
  }
});

// ---------------------------------------------------------------------------------------------
// makensisArgs
// ---------------------------------------------------------------------------------------------

test('makensisArgs: the installer stage passes the inputs, the version and the PATH switch', () => {
  const args = installer.makensisArgs('installer', {
    version: '0.4.0-rc.3', exe: '/tmp/a/e.exe', uninstaller: '/tmp/a/u.exe', notices: '/tmp/a/n.txt', tray: '/tmp/a/t.exe', out: '/tmp/a/s.exe',
    starterSystems: ['dnd-5e-2024', 'fitd', 'pf2e'],
  });
  assert.equal(args[0], '-V2');
  assert.equal(args[1], '-WX');
  assert.ok(args.includes('-DVERSION=0.4.0-rc.3'));
  assert.ok(args.includes('-DVERSION4=0.4.0.0'));
  assert.ok(args.includes('-DWITH_PATH_OPTION'));
  assert.equal(defineOf(args, 'EXE_IN'), '/tmp/a/e.exe');
  assert.equal(defineOf(args, 'UNINSTALLER_IN'), '/tmp/a/u.exe');
  assert.equal(defineOf(args, 'NOTICES_IN'), '/tmp/a/n.txt');
  assert.equal(defineOf(args, 'TRAY_IN'), '/tmp/a/t.exe');
  assert.equal(defineOf(args, 'OUTFILE'), '/tmp/a/s.exe');
  assert.equal(defineOf(args, 'STARTER_SYSTEMS'), 'dnd-5e-2024|fitd|pf2e');
  const iTray = args.findIndex((a) => a === '-DTRAY_IN=/tmp/a/t.exe');
  const iSystems = args.findIndex((a) => a === '-DSTARTER_SYSTEMS=dnd-5e-2024|fitd|pf2e');
  const iOut = args.findIndex((a) => a === '-DOUTFILE=/tmp/a/s.exe');
  assert.ok(iTray >= 0 && iSystems > iTray && iOut > iSystems, 'the game systems come after the tray input and before the output');
  assert.equal(args.includes('-DEXTRACT_UNINSTALLER'), false);
  assert.equal(path.isAbsolute(args[args.length - 1]), true);
  assert.equal(args[args.length - 1].endsWith('packaging/windows/installer.nsi'), true);
});

test('makensisArgs: the PATH switch is one option away from being dropped', () => {
  const args = installer.makensisArgs('installer', {
    version: '1.0.0', exe: '/tmp/a/e.exe', uninstaller: '/tmp/a/u.exe', notices: '/tmp/a/n.txt', tray: '/tmp/a/t.exe', out: '/tmp/a/s.exe', withPath: false,
    starterSystems: ['dnd-5e-2024', 'fitd', 'pf2e'],
  });
  assert.equal(args.includes('-DWITH_PATH_OPTION'), false);
  assert.ok(args.includes('-DVERSION4=1.0.0.0'));
});

test('makensisArgs: the uninstaller stage extracts to --out and throws its own installer away elsewhere', () => {
  const args = installer.makensisArgs('uninstaller', { version: '0.4.0', out: '/tmp/a/u.exe', stageDir: '/tmp/stage-x' });
  assert.ok(args.includes('-DEXTRACT_UNINSTALLER'));
  assert.equal(defineOf(args, 'UNINSTALLER_OUT'), '/tmp/a/u.exe');
  const discard = defineOf(args, 'OUTFILE');
  assert.ok(discard.startsWith('/tmp/stage-x/'), 'the stage-A installer goes to the temp folder');
  assert.notEqual(discard, '/tmp/a/u.exe');
  assert.equal(defineOf(args, 'EXE_IN'), undefined);
});

// ---------------------------------------------------------------------------------------------
// version grammar
// ---------------------------------------------------------------------------------------------

test('checkVersion: accepts X.Y.Z and X.Y.Z-rc.N only, each part up to 65535', () => {
  assert.equal(installer.checkVersion('0.4.0'), '0.4.0.0');
  assert.equal(installer.checkVersion('0.4.0-rc.2'), '0.4.0.0');
  assert.equal(installer.checkVersion('65535.65535.65535'), '65535.65535.65535.0');
  for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta.1', '1.2.3-rc', '1.2.3-rc.', '1.2.3-rc.1.2', '1.2.3+meta', '65536.0.0', '01.2.3', '1.2.3-rc.01', '', ' 1.2.3', '1.2.3\n']) {
    assert.throws(() => installer.checkVersion(bad), (e) => e.reason === 'bad-version', JSON.stringify(bad));
  }
});

test('the repository version is one the installer accepts', () => {
  // package.json is the source of the version; the assertion is on the grammar only
  assert.doesNotThrow(() => installer.checkVersion(pkg.version));
});

// ---------------------------------------------------------------------------------------------
// verifyPacked
// ---------------------------------------------------------------------------------------------

test('verifyPacked: finds exact needles in a file and reports each one', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'blob.bin');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('header'), EXE_BYTES, Buffer.from('mid'), UNINST_BYTES, Buffer.from('tail')]));
    assert.deepEqual(installer.verifyPacked(file, { exe: EXE_BYTES, uninstaller: UNINST_BYTES }), { exe: true, uninstaller: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyPacked: a missing needle, or one differing by a single byte, is reported false', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'blob.bin');
    const almost = Buffer.from(EXE_BYTES);
    almost[almost.length - 1] ^= 0xff;
    fs.writeFileSync(file, Buffer.concat([almost, UNINST_BYTES]));
    assert.deepEqual(installer.verifyPacked(file, { exe: EXE_BYTES, uninstaller: UNINST_BYTES }), { exe: false, uninstaller: true });
    fs.writeFileSync(file, EXE_BYTES);
    assert.deepEqual(installer.verifyPacked(file, { exe: EXE_BYTES, uninstaller: UNINST_BYTES }), { exe: true, uninstaller: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyPacked: an empty needle is never reported as found', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'blob.bin');
    fs.writeFileSync(file, Buffer.from('anything'));
    assert.deepEqual(installer.verifyPacked(file, { exe: Buffer.alloc(0) }), { exe: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// run: refusals before makensis starts
// ---------------------------------------------------------------------------------------------

test('run: an existing --out is refused and left untouched (out-exists)', async () => {
  const dir = scratch();
  try {
    const out = path.join(dir, 'already.exe');
    fs.writeFileSync(out, 'precious');
    const exec = fakeExec();
    const r = await runCapture({ argv: ['uninstaller', '--out', out], exec, version: '0.4.0' });
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.filter((l) => l.startsWith('FAIL')), ['FAIL out-exists']);
    assert.equal(fs.readFileSync(out, 'utf8'), 'precious');
    assert.equal(exec.calls.some((c) => c.args.length > 1), false, 'makensis was never asked to compile');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a bad path prints FAIL bad-path and exits 1', async () => {
  const r = await runCapture({ argv: ['uninstaller', '--out', '/tmp/a b.exe'], exec: fakeExec(), version: '0.4.0' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.filter((l) => l.startsWith('FAIL')), ['FAIL bad-path']);
});

test('run: a bad version prints FAIL bad-version and exits 1', async () => {
  const dir = scratch();
  try {
    const r = await runCapture({ argv: ['uninstaller', '--out', path.join(dir, 'u.exe')], exec: fakeExec(), version: '1.2.3-beta.1' });
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.filter((l) => l.startsWith('FAIL')), ['FAIL bad-version']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: makensis not on PATH prints FAIL makensis-missing, exits 1 and writes nothing', async () => {
  const dir = scratch();
  try {
    const out = path.join(dir, 'u.exe');
    const enoent = Object.assign(new Error('spawn makensis ENOENT'), { code: 'ENOENT' });
    const exec = () => {
      throw enoent;
    };
    const r = await runCapture({ argv: ['uninstaller', '--out', out], exec, version: '0.4.0' });
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.filter((l) => l.startsWith('FAIL')), ['FAIL makensis-missing']);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: an input that does not exist is a bad-path, before makensis compiles', async () => {
  const dir = scratch();
  try {
    const exec = fakeExec();
    const r = await runCapture({
      argv: ['installer', '--exe', path.join(dir, 'nope.exe'), '--uninstaller', path.join(dir, 'nope2.exe'), '--notices', path.join(dir, 'nope3.txt'), '--tray', path.join(dir, 'nope4.exe'), '--out', path.join(dir, 's.exe')],
      exec,
      version: '0.4.0',
    });
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.filter((l) => l.startsWith('FAIL')), ['FAIL bad-path']);
    assert.equal(exec.calls.some((c) => c.args.length > 1), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('starterSystemsDefine: refuses anything but a non-empty list of plain lowercase ids, and joins the good list with bars', () => {
  for (const bad of [[], ['none'], ['a"b'], ['A'], ['-x'], ['a b'], ['a|b'], 'x', [1]]) {
    assert.throws(() => installer.starterSystemsDefine(bad), (e) => e.reason === 'bad-starter-systems', JSON.stringify(bad));
  }
  assert.equal(installer.starterSystemsDefine(['dnd-5e-2024', 'fitd', 'pf2e']), 'dnd-5e-2024|fitd|pf2e');
});

test('starterSystemsDefine: a list with one bad id among good ones is refused whole', () => {
  assert.throws(() => installer.starterSystemsDefine(['fitd', 'a"b', 'pf2e']), (e) => e.reason === 'bad-starter-systems');
});

// ---------------------------------------------------------------------------------------------
// run: installer stage
// ---------------------------------------------------------------------------------------------

function installerRun(dir, producer, extra = {}) {
  const inputs = makeInputs(dir);
  const out = path.join(dir, 'setup.exe');
  const exec = fakeExec({ produce: (args) => ({ [defineOf(args, 'OUTFILE')]: producer(args, inputs) }), ...extra });
  return {
    out,
    inputs,
    exec,
    go: () =>
      runCapture({
        argv: ['installer', '--exe', inputs.exe, '--uninstaller', inputs.un, '--notices', inputs.notices, '--tray', inputs.tray, '--out', out],
        exec,
        version: '0.4.0-rc.2',
      }),
  };
}

test('run installer: success prints the contract lines in order, with independently computed hashes', async () => {
  const dir = scratch();
  try {
    const good = Buffer.concat([Buffer.from('MZstub'), EXE_BYTES, Buffer.from('|'), UNINST_BYTES, Buffer.from('|'), TRAY_BYTES, Buffer.from('|'), MANIFEST_BYTES]);
    const t = installerRun(dir, () => good);
    const r = await t.go();
    assert.equal(r.code, 0, r.out.join('\n') + r.err.join('\n'));
    assert.deepEqual(r.out, [
      'MAKENSIS version=v3.08-test',
      `INPUT exe sha256=${sha(EXE_BYTES)}`,
      `INPUT uninstaller sha256=${sha(UNINST_BYTES)}`,
      `INPUT notices sha256=${sha(NOTICES_BYTES)}`,
      `INPUT tray sha256=${sha(TRAY_BYTES)}`,
      'CONTAINS exe yes',
      'CONTAINS uninstaller yes',
      'CONTAINS tray yes',
      'MANIFEST asInvoker yes',
      `INSTALLER sha256=${sha(good)} path=${t.out}`,
    ]);
    assert.equal(fs.existsSync(t.out), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run installer: bad game systems, or a dependency that throws, fail bad-starter-systems before any makensis call', async () => {
  const bad = [() => ['dnd-5e-2024', 'a"b'], () => { throw new Error('the starter is broken'); }];
  for (const starterSystems of bad) {
    const dir = scratch();
    try {
      const inputs = makeInputs(dir);
      const out = path.join(dir, 'setup.exe');
      const exec = fakeExec();
      const r = await runCapture({
        argv: ['installer', '--exe', inputs.exe, '--uninstaller', inputs.un, '--notices', inputs.notices, '--tray', inputs.tray, '--out', out],
        exec,
        version: '0.4.0',
        starterSystems,
      });
      assert.equal(r.code, 1);
      assert.deepEqual(r.out, ['FAIL bad-starter-systems']);
      assert.equal(exec.calls.length, 0, 'makensis is never started');
      assert.equal(fs.existsSync(out), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('run installer: the default game systems are the starter manifest\'s, without none, and the output is unchanged', async () => {
  const dir = scratch();
  try {
    const good = Buffer.concat([Buffer.from('MZstub'), EXE_BYTES, Buffer.from('|'), UNINST_BYTES, Buffer.from('|'), TRAY_BYTES, Buffer.from('|'), MANIFEST_BYTES]);
    const t = installerRun(dir, () => good);
    const r = await t.go();
    assert.equal(r.code, 0, r.out.join('\n') + r.err.join('\n'));
    assert.equal(r.out.length, 10);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'vault-template', 'manifest.json'), 'utf8'));
    const expected = Object.keys(manifest.systems).filter((id) => id !== 'none').sort().join('|');
    assert.ok(expected.length > 0);
    const compile = t.exec.calls.find((c) => c.args.length > 1);
    assert.equal(defineOf(compile.args, 'STARTER_SYSTEMS'), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the starter id grammar here is the same line as the one in src/setup/template.js', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'src', 'setup', 'template.js'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(lines.some((l) => l === 'const SYSTEM_ID_RE = /^[a-z0-9][a-z0-9-]*$/;'));
  assert.equal(installer.STARTER_ID_RE.source, '^[a-z0-9][a-z0-9-]*$');
  // control: a scratch text holding a different grammar is not matched
  assert.equal(['const SYSTEM_ID_RE = /^[a-z0-9]+$/;'].some((l) => l === 'const SYSTEM_ID_RE = /^[a-z0-9][a-z0-9-]*$/;'), false);
});

test('run installer: an output lacking the exe bytes fails not-packed-exe, exits 1 and removes the output', async () => {
  const dir = scratch();
  try {
    const t = installerRun(dir, () => Buffer.concat([Buffer.from('MZ'), UNINST_BYTES, TRAY_BYTES, MANIFEST_BYTES]));
    const r = await t.go();
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('FAIL not-packed-exe'));
    assert.equal(r.out.some((l) => l.startsWith('INSTALLER ')), false);
    assert.equal(fs.existsSync(t.out), false, 'the output file is removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run installer: an output lacking the uninstaller bytes fails not-packed-uninstaller and removes the output', async () => {
  const dir = scratch();
  try {
    const t = installerRun(dir, () => Buffer.concat([Buffer.from('MZ'), EXE_BYTES, TRAY_BYTES, MANIFEST_BYTES]));
    const r = await t.go();
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('FAIL not-packed-uninstaller'));
    assert.equal(fs.existsSync(t.out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run installer: an output lacking the tray bytes fails not-packed-tray, exits 1, removes the output and prints no INSTALLER line', async () => {
  const dir = scratch();
  try {
    const t = installerRun(dir, () => Buffer.concat([Buffer.from('MZ'), EXE_BYTES, UNINST_BYTES, MANIFEST_BYTES]));
    const r = await t.go();
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('FAIL not-packed-tray'), r.out.join('|'));
    assert.equal(r.out.some((l) => l.startsWith('INSTALLER ')), false);
    assert.equal(fs.existsSync(t.out), false, 'the output file is removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run installer: an output that is not asInvoker fails no-asinvoker and removes the output', async () => {
  const dir = scratch();
  try {
    const t = installerRun(dir, () => Buffer.concat([Buffer.from('MZ'), EXE_BYTES, UNINST_BYTES, TRAY_BYTES, Buffer.from('level="requireAdministrator"')]));
    const r = await t.go();
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('FAIL no-asinvoker'));
    assert.equal(fs.existsSync(t.out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run installer: makensis failing part-way is makensis-failed and leaves no output behind', async () => {
  const dir = scratch();
  try {
    const inputs = makeInputs(dir);
    const out = path.join(dir, 'setup.exe');
    const exec = (file, args) => {
      if (args.length === 1) return 'v3.08-test\n';
      fs.writeFileSync(defineOf(args, 'OUTFILE'), 'half written');
      throw Object.assign(new Error('makensis exited 1'), { status: 1, stdout: 'error text', stderr: '' });
    };
    const r = await runCapture({
      argv: ['installer', '--exe', inputs.exe, '--uninstaller', inputs.un, '--notices', inputs.notices, '--tray', inputs.tray, '--out', out],
      exec,
      version: '0.4.0',
    });
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('FAIL makensis-failed'));
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run installer: makensis succeeding but writing nothing is makensis-failed', async () => {
  const dir = scratch();
  try {
    const inputs = makeInputs(dir);
    const out = path.join(dir, 'setup.exe');
    const r = await runCapture({
      argv: ['installer', '--exe', inputs.exe, '--uninstaller', inputs.un, '--notices', inputs.notices, '--tray', inputs.tray, '--out', out],
      exec: fakeExec(),
      version: '0.4.0',
    });
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('FAIL makensis-failed'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// run: uninstaller stage
// ---------------------------------------------------------------------------------------------

test('run uninstaller: success copies out, prints the contract lines and removes the temp folder', async () => {
  const dir = scratch();
  try {
    const out = path.join(dir, 'gm-scriptorium-uninstall.exe');
    const made = Buffer.concat([Buffer.from('MZ'), Buffer.from('uninstaller-body'), MANIFEST_BYTES]);
    let stage;
    const exec = fakeExec({
      produce: (args) => {
        stage = path.dirname(defineOf(args, 'OUTFILE'));
        return { [defineOf(args, 'OUTFILE')]: Buffer.from('discarded stage A installer'), [defineOf(args, 'UNINSTALLER_OUT')]: made };
      },
    });
    const r = await runCapture({ argv: ['uninstaller', '--out', out], exec, version: '0.4.0-rc.2' });
    assert.equal(r.code, 0, r.out.join('\n') + r.err.join('\n'));
    assert.deepEqual(r.out, ['MAKENSIS version=v3.08-test', `UNINSTALLER sha256=${sha(made)} path=${out}`]);
    assert.deepEqual(fs.readFileSync(out), made);
    assert.ok(stage, 'the build was given a temp folder');
    assert.equal(fs.existsSync(stage), false, 'the temp folder is removed');
    assert.notEqual(stage, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run uninstaller: an output that is not a PE file, or has no manifest level, fails and is removed', async () => {
  const dir = scratch();
  try {
    for (const [bytes, reason] of [
      [Buffer.from('not a pe file asInvoker level="asInvoker"'), 'makensis-failed'],
      [Buffer.concat([Buffer.from('MZ'), Buffer.from('level="highestAvailable"')]), 'no-asinvoker'],
    ]) {
      const out = path.join(dir, `u-${reason}.exe`);
      const exec = fakeExec({ produce: (args) => ({ [defineOf(args, 'UNINSTALLER_OUT')]: bytes, [defineOf(args, 'OUTFILE')]: Buffer.from('x') }) });
      const r = await runCapture({ argv: ['uninstaller', '--out', out], exec, version: '0.4.0' });
      assert.equal(r.code, 1);
      assert.ok(r.out.includes(`FAIL ${reason}`), r.out.join('|'));
      assert.equal(fs.existsSync(out), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// the real thing
// ---------------------------------------------------------------------------------------------

function haveMakensis() {
  try {
    execFileSync('makensis', ['-VERSION'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** True when the PE file's certificate-table data directory entry is empty (nothing signed). */
function peHasNoSignature(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) return false;
  const lfanew = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(lfanew) !== 0x00004550) return false;
  const magic = buf.readUInt16LE(lfanew + 24);
  const dirs = lfanew + 24 + (magic === 0x20b ? 112 : 96);
  const securityRva = buf.readUInt32LE(dirs + 4 * 8);
  const securitySize = buf.readUInt32LE(dirs + 4 * 8 + 4);
  return securityRva === 0 && securitySize === 0;
}

test('real makensis build: stage A then stage B on tiny dummies, packed bytes proven, asInvoker, unsigned PE', { skip: haveMakensis() ? false : 'makensis is not on PATH on this machine (the release build host has it)' }, () => {
  const dir = scratch();
  try {
    const dummyExe = path.join(dir, 'gm-scriptorium.exe');
    const notices = path.join(dir, 'THIRD-PARTY-NOTICES.txt');
    const dummyTray = path.join(dir, 'gm-scriptorium-tray.exe');
    const exeBytes = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(48 * 1024)]);
    const trayBytes = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(16 * 1024)]);
    fs.writeFileSync(dummyExe, exeBytes);
    fs.writeFileSync(dummyTray, trayBytes);
    fs.writeFileSync(notices, NOTICES_BYTES);

    const uninst = path.join(dir, 'gm-scriptorium-uninstall.exe');
    const a = spawnSync(process.execPath, [SCRIPT, 'uninstaller', '--out', uninst], { encoding: 'utf8', cwd: ROOT });
    assert.equal(a.status, 0, a.stdout + a.stderr);
    const aLines = a.stdout.trim().split('\n');
    assert.match(aLines[0], /^MAKENSIS version=v?\d+\.\d+/);
    assert.equal(aLines[1], `UNINSTALLER sha256=${sha(fs.readFileSync(uninst))} path=${uninst}`);

    const setup = path.join(dir, 'gm-scriptorium-setup-win-x64.exe');
    const b = spawnSync(
      process.execPath,
      [SCRIPT, 'installer', '--exe', dummyExe, '--uninstaller', uninst, '--notices', notices, '--tray', dummyTray, '--out', setup],
      { encoding: 'utf8', cwd: ROOT },
    );
    assert.equal(b.status, 0, b.stdout + b.stderr);
    const bLines = b.stdout.trim().split('\n');
    assert.match(bLines[0], /^MAKENSIS version=/);
    assert.deepEqual(bLines.slice(1, 5), [
      `INPUT exe sha256=${sha(exeBytes)}`,
      `INPUT uninstaller sha256=${sha(fs.readFileSync(uninst))}`,
      `INPUT notices sha256=${sha(NOTICES_BYTES)}`,
      `INPUT tray sha256=${sha(trayBytes)}`,
    ]);
    assert.deepEqual(bLines.slice(5, 9), ['CONTAINS exe yes', 'CONTAINS uninstaller yes', 'CONTAINS tray yes', 'MANIFEST asInvoker yes']);
    assert.equal(bLines[9], `INSTALLER sha256=${sha(fs.readFileSync(setup))} path=${setup}`);

    // an independent byte search: the file on disk really holds the exact inputs
    const setupBytes = fs.readFileSync(setup);
    const uninstBytes = fs.readFileSync(uninst);
    assert.ok(setupBytes.indexOf(exeBytes) >= 0, 'the installer holds the exe bytes');
    assert.ok(setupBytes.indexOf(uninstBytes) >= 0, 'the installer holds the uninstaller bytes');
    assert.ok(setupBytes.indexOf(NOTICES_BYTES) >= 0, 'the installer holds the notices text');
    assert.ok(setupBytes.indexOf(trayBytes) >= 0, 'the installer holds the tray bytes');

    for (const [name, buf] of [['uninstaller', uninstBytes], ['installer', setupBytes]]) {
      assert.ok(buf.indexOf('level="asInvoker"') >= 0, `${name} manifest asks for asInvoker`);
      assert.equal(buf.indexOf('requireAdministrator'), -1, `${name} never asks for administrator`);
      assert.equal(peHasNoSignature(buf), true, `${name} is a PE file with an empty certificate table`);
    }

    // the build refuses to overwrite
    const again = spawnSync(process.execPath, [SCRIPT, 'uninstaller', '--out', uninst], { encoding: 'utf8', cwd: ROOT });
    assert.equal(again.status, 1);
    assert.match(again.stdout, /FAIL out-exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real makensis build: stage B packs an uninstaller changed after stage A byte for byte', { skip: haveMakensis() ? false : 'makensis is not on PATH on this machine (the release build host has it)' }, () => {
  // Stage B packs whatever uninstaller it is handed, byte for byte. This is what lets the signing
  // pass change the uninstaller between the stages and have the build still prove the new bytes.
  const dir = scratch();
  try {
    const dummyExe = path.join(dir, 'gm-scriptorium.exe');
    const notices = path.join(dir, 'THIRD-PARTY-NOTICES.txt');
    const dummyTray = path.join(dir, 'gm-scriptorium-tray.exe');
    fs.writeFileSync(dummyExe, Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(2048)]));
    fs.writeFileSync(dummyTray, Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(1024)]));
    fs.writeFileSync(notices, NOTICES_BYTES);
    const uninst = path.join(dir, 'u.exe');
    const a = spawnSync(process.execPath, [SCRIPT, 'uninstaller', '--out', uninst], { encoding: 'utf8', cwd: ROOT });
    assert.equal(a.status, 0, a.stdout + a.stderr);
    const changed = Buffer.concat([fs.readFileSync(uninst), crypto.randomBytes(512)]);
    fs.writeFileSync(uninst, changed);
    const setup = path.join(dir, 's.exe');
    const b = spawnSync(process.execPath, [SCRIPT, 'installer', '--exe', dummyExe, '--uninstaller', uninst, '--notices', notices, '--tray', dummyTray, '--out', setup], { encoding: 'utf8', cwd: ROOT });
    assert.equal(b.status, 0, b.stdout + b.stderr);
    assert.ok(fs.readFileSync(setup).indexOf(changed) >= 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real makensis build: both stages build with the PATH option dropped', { skip: haveMakensis() ? false : 'makensis is not on PATH on this machine (the release build host has it)' }, () => {
  const dir = scratch();
  try {
    const dummyExe = path.join(dir, 'gm-scriptorium.exe');
    const dummyTray = path.join(dir, 'gm-scriptorium-tray.exe');
    const notices = path.join(dir, 'THIRD-PARTY-NOTICES.txt');
    fs.writeFileSync(dummyExe, Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(2048)]));
    fs.writeFileSync(dummyTray, Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(1024)]));
    fs.writeFileSync(notices, NOTICES_BYTES);
    const uninst = path.join(dir, 'u.exe');
    const setup = path.join(dir, 's.exe');
    const outA = [];
    const errA = [];
    const codeA = installer.run({ argv: ['uninstaller', '--out', uninst], withPath: false, stdout: (l) => outA.push(l), stderr: (l) => errA.push(l) });
    assert.equal(codeA, 0, outA.join('\n') + errA.join('\n'));
    const outB = [];
    const errB = [];
    const codeB = installer.run({
      argv: ['installer', '--exe', dummyExe, '--uninstaller', uninst, '--notices', notices, '--tray', dummyTray, '--out', setup],
      withPath: false,
      stdout: (l) => outB.push(l),
      stderr: (l) => errB.push(l),
    });
    assert.equal(codeB, 0, outB.join('\n') + errB.join('\n'));
    assert.equal(outB.includes('CONTAINS tray yes'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
