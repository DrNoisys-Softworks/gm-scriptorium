'use strict';

/*
 * `update` on an installed Windows copy replaces two programs, the exe and the tray helper beside it
 * (ADR 0057 section 11). The rules under test: both are downloaded and checked before either is
 * replaced; a failure at any step leaves the install as it was (rolling the exe back when only the
 * helper failed); and only when that cannot be done does the message say which file is at which
 * version. The release lookup and download are fakes; every file effect is real, in a scratch folder
 * with the platform reported as win32. Which rename steps fail is injected at the fs.renameSync call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runUpdateCommand } = require('../src/cli/update');
const { EXIT_CODES } = require('../src/util/exitcodes');
const pkg = require('../package.json');
const { installLoopbackGuard } = require('./helpers/net-stubs');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const CURRENT = pkg.version; // the running version; the fake release is far above it
const NEW_TAG = 'v9.9.9';
const NEW_VERSION = '9.9.9';
const EXE_ASSET = 'gm-scriptorium-win-x64.exe';
const TRAY_ASSET = 'gm-scriptorium-tray-win-x64.exe';
const MZ = Buffer.from([0x4d, 0x5a, 0x00, 0x00]);
const QUIT_AND_RESTART = 'If GM-Scriptorium is running in the system tray, quit it and start it again to use the new version.';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeInstall(t, { tray = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-twoexe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exeDir = path.join(root, 'GM-Scriptorium');
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(exeDir);
  fs.mkdirSync(tmpRoot);
  const execPath = path.join(exeDir, 'gm-scriptorium.exe');
  const trayPath = path.join(exeDir, 'gm-scriptorium-tray.exe');
  fs.writeFileSync(execPath, 'OLD-EXE');
  if (tray) fs.writeFileSync(trayPath, 'OLD-TRAY');
  return { root, exeDir, tmpRoot, execPath, trayPath };
}

/**
 * A fake download that writes the asset and SHA256SUMS the way the real one does: the sums file with
 * flag 'wx', so a second asset fetched into the same folder collides exactly as it would for real.
 */
function fakeRelease(log, { badSum = null, missing = null, body = null, onDownload = null } = {}) {
  return {
    lookupRelease: async () => ({ tag_name: NEW_TAG, html_url: 'https://example.test/releases/' + NEW_TAG }),
    downloadAsset: async (tag, asset, dir) => {
      log.push({ tag, asset, dir });
      if (onDownload) onDownload(asset);
      if (missing === asset) throw new Error(`download failed: ${asset} was not found in the release (HTTP 404)`);
      const bytes = body && body[asset] ? body[asset] : Buffer.concat([MZ, Buffer.from('NEW-' + asset)]);
      fs.writeFileSync(path.join(dir, asset), bytes);
      const sum = badSum === asset ? '0'.repeat(64) : sha256(bytes);
      fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sum}  ${asset}\n`, { flag: 'wx' });
    },
  };
}

function deps(install, release, over = {}) {
  return { execPath: install.execPath, platform: 'win32', arch: 'x64', tmpRoot: install.tmpRoot, isPkg: true, ...release, ...over };
}

function listing(dir) {
  return fs.readdirSync(dir).sort();
}

/** Escapes every regular-expression metacharacter, the backslash included, so a value matches literally. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('control: escapeRegExp matches a Windows path with backslashes and dots literally, and nothing looser', () => {
  const winPath = 'C:\\Tools\\GM-Scriptorium\\gm-scriptorium.exe.old-0.4.0';
  assert.match(winPath, new RegExp(`^${escapeRegExp(winPath)}$`));
  assert.doesNotMatch('C:ToolsXGM-ScriptoriumXgm-scriptorium.exe.old-0.4.0', new RegExp(escapeRegExp(winPath)));
  assert.doesNotMatch('0x4x0', new RegExp(escapeRegExp('0.4.0')));
  assert.equal(escapeRegExp('a\\b'), 'a\\\\b');
});

const read = (p) => fs.readFileSync(p, 'utf8');

// --- both programs ----------------------------------------------------------------------------------------

test('with the helper beside the exe, both are downloaded into separate folders and both are replaced', async (t) => {
  const install = makeInstall(t);
  const log = [];
  const result = await runUpdateCommand({}, deps(install, fakeRelease(log)));
  assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
  assert.deepEqual(log.map((l) => [l.tag, l.asset]), [[NEW_TAG, EXE_ASSET], [NEW_TAG, TRAY_ASSET]]);
  assert.notEqual(log[0].dir, log[1].dir, 'a second asset in one folder would collide on SHA256SUMS');
  assert.equal(read(install.execPath), 'MZ\x00\x00NEW-' + EXE_ASSET);
  assert.equal(read(install.trayPath), 'MZ\x00\x00NEW-' + TRAY_ASSET);
  assert.equal(read(`${install.execPath}.old-${CURRENT}`), 'OLD-EXE');
  assert.equal(read(`${install.trayPath}.old-${CURRENT}`), 'OLD-TRAY');
});

test('the success message names the helper and tells the GM to quit and start the tray app again', async (t) => {
  const install = makeInstall(t);
  const result = await runUpdateCommand({}, deps(install, fakeRelease([])));
  assert.match(result.human, new RegExp(`^updated ${escapeRegExp(CURRENT)} -> ${NEW_TAG}\\. Previous binary kept at `));
  assert.ok(result.human.includes('The tray helper was updated too.'), result.human);
  assert.ok(result.human.includes(QUIT_AND_RESTART), result.human);
  assert.ok(result.human.includes('Release notes: '), result.human);
});

test('nothing is left behind on success: no download folders, no staged files', async (t) => {
  const install = makeInstall(t);
  await runUpdateCommand({}, deps(install, fakeRelease([])));
  assert.deepEqual(listing(install.tmpRoot), []);
  assert.deepEqual(listing(install.exeDir), [
    'gm-scriptorium-tray.exe',
    `gm-scriptorium-tray.exe.old-${CURRENT}`,
    'gm-scriptorium.exe',
    `gm-scriptorium.exe.old-${CURRENT}`,
  ].sort());
});

test('with no helper beside the exe there is one download, only the exe changes, and the message is the old one', async (t) => {
  const install = makeInstall(t, { tray: false });
  const log = [];
  const result = await runUpdateCommand({}, deps(install, fakeRelease(log)));
  assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
  assert.deepEqual(log.map((l) => l.asset), [EXE_ASSET]);
  assert.equal(fs.existsSync(install.trayPath), false);
  assert.ok(!result.human.includes('tray'), result.human);
  assert.ok(!result.human.includes('system tray'), result.human);
});

test('off Windows a file named like the helper is not a helper: one download', async (t) => {
  const install = makeInstall(t);
  const log = [];
  const elf = Buffer.alloc(20);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elf.writeUInt16LE(0x3e, 18);
  const release = fakeRelease(log, { body: { 'gm-scriptorium-linux-x64': elf } });
  const result = await runUpdateCommand({}, deps(install, release, { platform: 'linux' }));
  assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
  assert.deepEqual(log.map((l) => l.asset), ['gm-scriptorium-linux-x64']);
  assert.equal(read(install.trayPath), 'OLD-TRAY');
});

test('update --check does not download or touch either program', async (t) => {
  const install = makeInstall(t);
  const log = [];
  const result = await runUpdateCommand({ check: true }, deps(install, fakeRelease(log)));
  assert.equal(result.exitCode, EXIT_CODES.OK);
  assert.deepEqual(log, []);
  assert.equal(read(install.execPath), 'OLD-EXE');
  assert.equal(read(install.trayPath), 'OLD-TRAY');
});

// --- all or nothing before any replace -----------------------------------------------------------------------

function assertUntouched(install, result) {
  assert.equal(result.exitCode, EXIT_CODES.SCRIPTORIUM_ERROR, result.human);
  assert.equal(read(install.execPath), 'OLD-EXE');
  assert.equal(read(install.trayPath), 'OLD-TRAY');
  assert.deepEqual(listing(install.exeDir), ['gm-scriptorium-tray.exe', 'gm-scriptorium.exe'], 'no .old file, no staged file');
  assert.deepEqual(listing(install.tmpRoot), [], 'no download folder');
}

test('a helper that fails its checksum replaces nothing, and the exe is not replaced first', async (t) => {
  const install = makeInstall(t);
  const result = await runUpdateCommand({}, deps(install, fakeRelease([], { badSum: TRAY_ASSET })));
  assertUntouched(install, result);
  assert.match(result.human, /tray helper/);
  assert.match(result.human, /checksum mismatch/);
  assert.match(result.human, /Nothing changed/);
});

test('the exe is still the old one at the moment the helper is being downloaded', async (t) => {
  const install = makeInstall(t);
  const seen = [];
  const release = fakeRelease([], {
    onDownload: (asset) => {
      if (asset === TRAY_ASSET) seen.push([read(install.execPath), fs.existsSync(`${install.execPath}.old-${CURRENT}`)]);
    },
  });
  await runUpdateCommand({}, deps(install, release));
  assert.deepEqual(seen, [['OLD-EXE', false]]);
});

test('a release that has no helper asset replaces nothing', async (t) => {
  const install = makeInstall(t);
  const result = await runUpdateCommand({}, deps(install, fakeRelease([], { missing: TRAY_ASSET })));
  assertUntouched(install, result);
  assert.match(result.human, /tray helper/);
  assert.match(result.human, /404/);
});

test('a helper download that is not a Windows program (no MZ header) replaces nothing', async (t) => {
  const install = makeInstall(t);
  const result = await runUpdateCommand({}, deps(install, fakeRelease([], { body: { [TRAY_ASSET]: Buffer.from('<html>not found</html>') } })));
  assertUntouched(install, result);
  assert.match(result.human, /Windows executable/);
});

test('an exe that fails its checksum replaces nothing and never asks for the helper', async (t) => {
  const install = makeInstall(t);
  const log = [];
  const result = await runUpdateCommand({}, deps(install, fakeRelease(log, { badSum: EXE_ASSET })));
  assertUntouched(install, result);
  assert.deepEqual(log.map((l) => l.asset), [EXE_ASSET]);
});

// --- a failure after the checks: rename failures at each step ----------------------------------------------------

/**
 * Makes the nth rename whose arguments satisfy `matches(from, to)` throw. Restored by the returned
 * function; `hits()` says how many times it fired, so a test can prove the failure really happened.
 */
function failRename(matches, nth = 1) {
  const original = fs.renameSync;
  let seen = 0;
  let hit = 0;
  fs.renameSync = function renameSync(from, to) {
    if (matches(String(from), String(to))) {
      seen += 1;
      if (seen === nth) {
        hit += 1;
        const err = new Error('EBUSY: resource busy or locked, rename (simulated)');
        err.code = 'EBUSY';
        throw err;
      }
    }
    return original.call(fs, from, to);
  };
  const restore = () => {
    fs.renameSync = original;
  };
  restore.hits = () => hit;
  return restore;
}

async function updateWithFailures(install, failures) {
  const restores = failures.map((f) => failRename(f.matches, f.nth));
  try {
    const result = await runUpdateCommand({}, deps(install, fakeRelease([])));
    return { result, hits: restores.map((r) => r.hits()) };
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

const isStaged = (p, name) => path.basename(p).startsWith(`${name}-update-`);

const STEPS = {
  exeAside: (i) => ({ matches: (from, to) => from === i.execPath && to === `${i.execPath}.old-${CURRENT}` }),
  exeIntoPlace: (i) => ({ matches: (from, to) => to === i.execPath && isStaged(from, 'gm-scriptorium.exe') }),
  trayAside: (i) => ({ matches: (from, to) => from === i.trayPath && to === `${i.trayPath}.old-${CURRENT}` }),
  trayIntoPlace: (i) => ({ matches: (from, to) => to === i.trayPath && isStaged(from, 'gm-scriptorium-tray.exe') }),
  rollbackMoveNewExeAside: (i) => ({ matches: (from, to) => from === i.execPath && to === `${i.execPath}.old-${NEW_VERSION}` }),
  rollbackRestoreOldExe: (i) => ({ matches: (from, to) => from === `${i.execPath}.old-${CURRENT}` && to === i.execPath }),
  rollbackPutNewExeBack: (i) => ({ matches: (from, to) => from === `${i.execPath}.old-${NEW_VERSION}` && to === i.execPath }),
};

for (const step of ['exeAside', 'exeIntoPlace', 'trayAside', 'trayIntoPlace']) {
  test(`a rename failure at "${step}" leaves both programs at the old version and says nothing changed`, async (t) => {
    const install = makeInstall(t);
    const { result, hits } = await updateWithFailures(install, [STEPS[step](install)]);
    assert.deepEqual(hits, [1], 'the injected failure fired exactly once');
    assert.equal(result.exitCode, EXIT_CODES.SCRIPTORIUM_ERROR, result.human);
    assert.match(result.human, /Nothing changed|Rolled back/);
    assert.ok(!/^updated /.test(result.human), result.human);
    assert.equal(read(install.execPath), 'OLD-EXE', 'the exe is the old one again, at its own name');
    assert.equal(read(install.trayPath), 'OLD-TRAY');
    assert.equal(fs.existsSync(`${install.execPath}.old-${CURRENT}`), false, 'the old exe is back in place, not left aside');
    assert.equal(fs.existsSync(`${install.trayPath}.old-${CURRENT}`), false);
    const leftovers = listing(install.exeDir).filter((n) => !['gm-scriptorium-tray.exe', 'gm-scriptorium.exe'].includes(n));
    assert.deepEqual(leftovers.filter((n) => n.includes('-update-')), [], 'no staged file left');
    assert.deepEqual(listing(install.tmpRoot), []);
  });
}

test('a helper failure after the exe was replaced rolls the exe back: new exe moved aside, old one renamed back', async (t) => {
  const install = makeInstall(t);
  const { result } = await updateWithFailures(install, [STEPS.trayAside(install)]);
  assert.match(result.human, /tray helper/);
  assert.match(result.human, /Nothing changed/);
  assert.equal(read(install.execPath), 'OLD-EXE');
  assert.equal(read(`${install.execPath}.old-${NEW_VERSION}`), 'MZ\x00\x00NEW-' + EXE_ASSET, 'the new exe was moved aside, where the next run sweeps it');
});

test('if the exe cannot be moved aside during the rollback, the message names which file is at which version', async (t) => {
  const install = makeInstall(t);
  const { result, hits } = await updateWithFailures(install, [STEPS.trayAside(install), STEPS.rollbackMoveNewExeAside(install)]);
  assert.deepEqual(hits, [1, 1]);
  assert.equal(result.exitCode, EXIT_CODES.SCRIPTORIUM_ERROR);
  assert.match(result.human, new RegExp(`gm-scriptorium\\.exe is now version ${NEW_VERSION}`));
  assert.match(result.human, new RegExp(`gm-scriptorium-tray\\.exe is still version ${escapeRegExp(CURRENT)}`));
  assert.match(result.human, /installer/);
  assert.doesNotMatch(result.human, /Nothing changed/);
  assert.equal(read(install.execPath), 'MZ\x00\x00NEW-' + EXE_ASSET);
  assert.equal(read(install.trayPath), 'OLD-TRAY');
});

test('if the old exe cannot be renamed back, the new exe is put back so an exe still exists, and the message names the versions', async (t) => {
  const install = makeInstall(t);
  const { result, hits } = await updateWithFailures(install, [STEPS.trayIntoPlace(install), STEPS.rollbackRestoreOldExe(install)]);
  assert.deepEqual(hits, [1, 1]);
  assert.match(result.human, new RegExp(`gm-scriptorium\\.exe is now version ${NEW_VERSION}`));
  assert.match(result.human, new RegExp(`gm-scriptorium-tray\\.exe is still version ${escapeRegExp(CURRENT)}`));
  assert.match(result.human, /installer/);
  assert.equal(read(install.execPath), 'MZ\x00\x00NEW-' + EXE_ASSET, 'an exe exists at its own name');
  assert.equal(read(install.trayPath), 'OLD-TRAY', 'the helper rolled itself back');
});

test('if even putting the new exe back fails, the message says the exe is missing and where the old one is kept', async (t) => {
  const install = makeInstall(t);
  const { result, hits } = await updateWithFailures(install, [
    STEPS.trayAside(install),
    STEPS.rollbackRestoreOldExe(install),
    STEPS.rollbackPutNewExeBack(install),
  ]);
  assert.deepEqual(hits, [1, 1, 1]);
  assert.equal(fs.existsSync(install.execPath), false);
  assert.match(result.human, /gm-scriptorium\.exe is missing/);
  assert.ok(result.human.includes(`${install.execPath}.old-${CURRENT}`), result.human);
  assert.match(result.human, /installer/);
});

test('a rollback failure message never claims the update worked or that nothing changed', async (t) => {
  const install = makeInstall(t);
  const { result } = await updateWithFailures(install, [STEPS.trayAside(install), STEPS.rollbackMoveNewExeAside(install)]);
  assert.ok(!/^updated /.test(result.human));
  assert.ok(!result.human.includes(QUIT_AND_RESTART));
});

// --- the sweeps ---------------------------------------------------------------------------------------------------

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number.parseInt(r.stdout, 10);
}

test('the start-of-run sweeps cover the helper: its .old-* copies and its abandoned staged files go', async (t) => {
  const install = makeInstall(t);
  const oldCopy = path.join(install.exeDir, 'gm-scriptorium-tray.exe.old-0.3.0');
  const exeOldCopy = path.join(install.exeDir, 'gm-scriptorium.exe.old-0.3.0');
  const staged = path.join(install.exeDir, `gm-scriptorium-tray.exe-update-${deadPid()}-1700000000000.tmp`);
  const livePid = path.join(install.exeDir, `gm-scriptorium-tray.exe-update-${process.pid}-1700000000000.tmp`);
  for (const f of [oldCopy, exeOldCopy, staged, livePid]) fs.writeFileSync(f, 'x');
  const result = await runUpdateCommand({ check: true }, deps(install, fakeRelease([])));
  assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
  assert.equal(fs.existsSync(oldCopy), false, 'the helper .old copy is swept');
  assert.equal(fs.existsSync(exeOldCopy), false, 'the exe .old copy is still swept');
  assert.equal(fs.existsSync(staged), false, 'an abandoned staged helper is swept');
  assert.equal(fs.existsSync(livePid), true, 'a staged helper owned by a live update is left alone');
});
