'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * ADR 0052: the structural pins on adding a campaign. One dispatcher and one answer-shape rule serve
 * browser setup and the add routes, so neither handler may keep a copy; register.js keeps one
 * pipeline per path; and ScriptoriumAdmin.adopt, which re-points a page at the campaign it has just
 * switched to, has one definition and one caller. The comment stripper is copied, not required.
 * Every scan has a positive control.
 */

const ROOT = path.join(__dirname, '..');
const SETUP_HANDLER = path.join(ROOT, 'src', 'admin', 'handlers', 'setup.js');
const CAMPAIGNS_HANDLER = path.join(ROOT, 'src', 'admin', 'handlers', 'campaigns.js');
const REGISTER_JS = path.join(ROOT, 'src', 'setup', 'register.js');
const ASSETS = path.join(ROOT, 'assets', 'admin');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const count = (source, token) => stripComments(source).split(token).length - 1;
const read = (f) => fs.readFileSync(f, 'utf8');

test('count helper positive control: it counts a planted token and ignores a commented one', () => {
  assert.equal(count('a.f(1); b.f(2); // c.f(3)\n/* d.f(4) */', 'f('), 2);
});

test('handlers/setup.js and handlers/campaigns.js each call checks.runCheck( and checks.answersProblem( exactly once', () => {
  for (const f of [SETUP_HANDLER, CAMPAIGNS_HANDLER]) {
    const source = read(f);
    assert.equal(count(source, 'checks.runCheck('), 1, `${path.relative(ROOT, f)} runCheck`);
    assert.equal(count(source, 'checks.answersProblem('), 1, `${path.relative(ROOT, f)} answersProblem`);
  }
});

test('handlers/campaigns.js names none of the per-field checks, so it cannot hold a second dispatcher', () => {
  const source = read(CAMPAIGNS_HANDLER);
  for (const name of ['checkVault(', 'checkOutput(', 'checkNewVault(', 'checkName(', 'checkTitle(', 'checkTheme(', 'checkSystem(', 'checkStarterTitle(']) {
    assert.equal(count(source, name), 0, name);
  }
  assert.equal(count('checkVault(x)', 'checkVault('), 1, 'positive control');
});

test('handlers/setup.js holds no copy of the field list or the answer keys either', () => {
  const source = stripComments(read(SETUP_HANDLER));
  assert.equal(/\bFIELDS\b|\bANSWER_KEYS\b|\boneParam\b/.test(source), false);
  for (const name of ['checkVault(', 'checkOutput(', 'checkNewVault(', 'checkName(']) assert.equal(source.includes(name), false, name);
});

test('register.js, comments stripped: createPackEntries( twice, createVault( once, writeConfigFile( three times (one pipeline per path)', () => {
  const source = read(REGISTER_JS);
  assert.equal(count(source, 'createPackEntries('), 2);
  assert.equal(count(source, 'createVault('), 1);
  assert.equal(count(source, 'writeConfigFile('), 3);
  assert.equal(count('// createVault(x)\ncreateVault(y)', 'createVault('), 1, 'positive control');
});

test('register.js has one gate parameter per pipeline and exactly two call sites of each phase', () => {
  const source = stripComments(read(REGISTER_JS));
  assert.equal((source.match(/gate\('early', null\)/g) || []).length, 2);
  assert.equal((source.match(/gate\('late', /g) || []).length, 2);
});

function jsFiles(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.js')).map((n) => path.join(dir, n));
}

test('adopt( appears in assets/admin/app.js once (the definition) and in assets/admin/setup.js once (the call), and nowhere else', () => {
  const found = {};
  for (const f of [...jsFiles(ASSETS), ...jsFiles(path.join(ROOT, 'src', 'admin')), ...jsFiles(path.join(ROOT, 'src', 'admin', 'handlers'))]) {
    const n = (stripComments(read(f)).match(/\badopt\(/g) || []).length;
    if (n > 0) found[path.relative(ROOT, f).split(path.sep).join('/')] = n;
  }
  assert.deepEqual(found, { 'assets/admin/app.js': 1, 'assets/admin/setup.js': 1 });
});

test('positive control: the adopt scan finds a planted second caller in a scratch asset', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-adopt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'planted.js'), 'A.adopt(name);\n');
  assert.equal((stripComments(read(path.join(dir, 'planted.js'))).match(/\badopt\(/g) || []).length, 1);
});

test('setup.js reaches the network only through ScriptoriumAdmin.api: no fetch( outside app.js', () => {
  for (const f of jsFiles(ASSETS)) {
    const n = (stripComments(read(f)).match(/\bfetch\(/g) || []).length;
    if (path.basename(f) === 'app.js') continue;
    assert.equal(n, 0, path.basename(f));
  }
});
