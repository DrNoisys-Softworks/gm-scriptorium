'use strict';

// I2a-1: the win-x64 exe gets the Lantern icon and GM-Scriptorium version strings by editing
// the pkg BASE binary (scripts/winres.js). Expected values below are literals, never read from
// the code under test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const winres = require('../scripts/winres');
const { pkgEnvFor } = require('../scripts/package');

const ROOT = path.join(__dirname, '..');
const EXPECTED_BASE_SHA256 = '555d3dceaaf1c5628ac8fa23d1ebde46a424d2ad6782cc2412be8eed4a7a6b69';
const CACHED_BASE = path.join(process.env.PKG_CACHE_PATH || path.join(os.homedir(), '.pkg-cache'), 'v3.6', 'fetched-v22.23.2-win-x64');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-winres-test-'));
}

test('versionStrings: exactly the eight keys, with the stated values', () => {
  assert.deepEqual(winres.versionStrings('0.4.0-rc.3'), {
    CompanyName: 'DrNoisys Softworks',
    FileDescription: 'GM-Scriptorium',
    FileVersion: '0.4.0-rc.3',
    InternalName: 'gm-scriptorium',
    LegalCopyright: 'DrNoisys Softworks. MIT licence.',
    OriginalFilename: 'gm-scriptorium-win-x64.exe',
    ProductName: 'GM-Scriptorium',
    ProductVersion: '0.4.0-rc.3',
  });
});

test('versionStrings: throws on a version that is not semver', () => {
  for (const bad of ['', 'abc', '1.2', '1.2.3.4', undefined, null]) {
    assert.throws(() => winres.versionStrings(bad), /bad-version/, String(bad));
  }
});

test('fixedVersion: major.minor.patch.0 always, a prerelease never reaches the fourth field', () => {
  assert.deepEqual(winres.fixedVersion('0.4.0-rc.3'), [0, 4, 0, 0]);
  assert.deepEqual(winres.fixedVersion('1.12.7'), [1, 12, 7, 0]);
  assert.throws(() => winres.fixedVersion('nope'), /bad-version/);
});

test('pkgEnvFor: win sets PKG_NODE_PATH to the branded base, without touching the caller env', () => {
  const caller = { PATH: '/bin', KEEP: 'x' };
  const env = pkgEnvFor('node22-win-x64', '/tmp/branded');
  assert.equal(env.PKG_NODE_PATH, '/tmp/branded');
  assert.equal(pkgEnvFor('node22-win-x64', '/tmp/branded', caller).KEEP, 'x');
  assert.equal('PKG_NODE_PATH' in caller, false);
});

test('pkgEnvFor: linux deletes PKG_NODE_PATH even when the caller env carries it', () => {
  const caller = { PATH: '/bin', PKG_NODE_PATH: '/some/windows/base' };
  const env = pkgEnvFor('node22-linux-x64', '/tmp/branded', caller);
  assert.equal('PKG_NODE_PATH' in env, false);
  assert.equal(env.PATH, '/bin');
  assert.equal(caller.PKG_NODE_PATH, '/some/windows/base', 'the caller env is not mutated');
});

test('pkgEnvFor: a win call with no branded base also never inherits a stray PKG_NODE_PATH', () => {
  const env = pkgEnvFor('node22-win-x64', null, { PKG_NODE_PATH: '/stray' });
  assert.equal('PKG_NODE_PATH' in env, false);
});

test('checkBaseHash: a file with the wrong bytes is refused (fails closed)', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'base');
    fs.writeFileSync(f, 'not the node binary');
    assert.throws(() => winres.checkBaseHash(f, EXPECTED_BASE_SHA256), (e) => e.reason === 'base-hash');
    assert.throws(() => winres.checkBaseHash(f, undefined), (e) => e.reason === 'base-hash');
    const right = crypto.createHash('sha256').update('not the node binary').digest('hex');
    assert.equal(winres.checkBaseHash(f, right), right);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('brandBase on a file with no PE structure fails with edit-failed and writes nothing', async () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'src');
    fs.writeFileSync(src, 'MZ not really');
    const out = path.join(dir, 'out');
    await assert.rejects(winres.brandBase({ src, out, version: '1.2.3' }), (e) => e.reason === 'edit-failed');
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed .ico holds the eight sizes, 16 to 256', () => {
  assert.deepEqual(winres.icoSizes(fs.readFileSync(path.join(ROOT, 'packaging', 'windows', 'gm-scriptorium.ico'))), [16, 20, 24, 32, 40, 48, 64, 256]);
});

test('the .ico is not under assets/ (the embedded-asset count and change detector would move)', () => {
  for (const sub of ['admin', 'site', 'themes']) {
    const dir = path.join(ROOT, 'assets', sub);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]));
    assert.equal(walk(dir).some((n) => n.endsWith('.ico')), false, sub);
  }
});

const haveBase = fs.existsSync(CACHED_BASE);
test('real base: branding gives one icon group, the eight sizes, the eight strings and no Node.js', { skip: haveBase ? false : `the pkg win-x64 base is not cached at ${CACHED_BASE}` }, async () => {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(CACHED_BASE)).digest('hex'), EXPECTED_BASE_SHA256);
  const dir = tmp();
  try {
    const out = path.join(dir, 'branded.exe');
    await winres.brandBase({ src: CACHED_BASE, out, version: '1.2.3-rc.4' });

    const stock = await winres.readBranding(CACHED_BASE);
    assert.ok(JSON.stringify(stock.strings).includes('Node.js'), 'the stock base carries Node.js strings, so the replacement is meaningful');

    const b = await winres.readBranding(out);
    assert.equal(b.iconGroups, 1);
    assert.deepEqual(b.iconSizes, [16, 20, 24, 32, 40, 48, 64, 256]);
    assert.equal(b.iconCount, 8);
    assert.equal(b.strings.length, 1);
    assert.deepEqual(b.strings[0], {
      CompanyName: 'DrNoisys Softworks',
      FileDescription: 'GM-Scriptorium',
      FileVersion: '1.2.3-rc.4',
      InternalName: 'gm-scriptorium',
      LegalCopyright: 'DrNoisys Softworks. MIT licence.',
      OriginalFilename: 'gm-scriptorium-win-x64.exe',
      ProductName: 'GM-Scriptorium',
      ProductVersion: '1.2.3-rc.4',
    });
    assert.deepEqual(b.fixed[0], [1, 2, 3, 0]);
    assert.equal(JSON.stringify(b.strings).includes('Node.js'), false);

    // the judge, with the sizes stated independently of the .ico
    assert.equal(winres.judge(b, '1.2.3-rc.4', [16, 20, 24, 32, 40, 48, 64, 256]), null);
    assert.equal(winres.judge(b, '1.2.4', [16, 20, 24, 32, 40, 48, 64, 256]), 'version-value-FileVersion');
    assert.equal(winres.judge(b, '1.2.3-rc.4', [16, 32]), 'icon-sizes=16,20,24,32,40,48,64,256');

    // never overwrites
    await assert.rejects(winres.brandBase({ src: CACHED_BASE, out, version: '1.2.3' }), (e) => e.reason === 'out-exists');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI check refuses a file that is not an exe', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'x.exe');
    fs.writeFileSync(f, 'nope');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'winres.js'), 'check', f], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^WINRES-CHECK fail reason=/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
