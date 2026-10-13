'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

/*
 * Structural proof for the panel's update notice (docs/decisions/0028-installer-and-first-run.md,
 * addendum "The update notice"): the check core and the setting reader stay pure, none of the four
 * new source files starts a program, opens a socket, names a fetch-style call or writes to the
 * console, and the route file holds no write of its own. Every scan has a positive control that
 * proves it can fail. The comment stripper is copied, not required.
 */

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const NEW_FILES = [
  ['src', 'config', 'updatesettings.js'],
  ['src', 'update', 'notice.js'],
  ['src', 'admin', 'updatenotice.js'],
  ['src', 'admin', 'handlers', 'updates.js'],
].map((p) => path.join(ROOT, ...p));

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function requireSpecs(source) {
  const specs = [];
  const re = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  const stripped = stripComments(source);
  while ((m = re.exec(stripped))) specs.push(m[2]);
  return specs;
}

const read = (file) => fs.readFileSync(file, 'utf8');
const specsOf = (file) => requireSpecs(read(file));

// ---- exact requires -----------------------------------------------------------------------------

test('src/config/updatesettings.js requires nothing', () => {
  assert.deepEqual(specsOf(path.join(SRC, 'config', 'updatesettings.js')), []);
});

test('src/update/notice.js requires exactly ./release, ./semver and ../util/errors', () => {
  assert.deepEqual(specsOf(path.join(SRC, 'update', 'notice.js')).sort(), ['../util/errors', './release', './semver']);
});

test('src/admin/handlers/updates.js requires only ../respond, ../body, ../context and ../../setup/register', () => {
  assert.deepEqual(specsOf(path.join(SRC, 'admin', 'handlers', 'updates.js')).sort(), ['../../setup/register', '../body', '../context', '../respond']);
});

test('src/admin/updatenotice.js requires no config writer and no handler', () => {
  const specs = specsOf(path.join(SRC, 'admin', 'updatenotice.js'));
  for (const s of specs) {
    assert.ok(!/config\/write|setup\/register|handlers\//.test(s), s);
  }
});

test('positive control: the require scan reads specifiers and ignores a commented one', () => {
  assert.deepEqual(requireSpecs("const a = require('./a'); // require('./nope')\n/* require('./nope2') */ require(\"b\");"), ['./a', 'b']);
});

// ---- no network builtin, program starter or console ---------------------------------------------

const NET_BUILTINS = new Set(['net', 'http', 'https', 'http2', 'dgram', 'dns', 'tls', 'child_process', 'worker_threads', 'cluster']);
const CONSOLE_RE = /console\.|process\.stdout|process\.stderr/;
const FETCH_RE = /fetch\w*\s*\(/;

function builtinOffenders(source) {
  return requireSpecs(source).filter((s) => NET_BUILTINS.has(s.replace(/^node:/, '')));
}

test('none of the four new source files requires a network builtin or child_process', () => {
  assert.equal(NEW_FILES.length, 4);
  for (const f of NEW_FILES) assert.deepEqual(builtinOffenders(read(f)), [], path.relative(ROOT, f));
});

test('none of the four new source files writes to the console, stdout or stderr', () => {
  for (const f of NEW_FILES) assert.equal(CONSOLE_RE.test(stripComments(read(f))), false, path.relative(ROOT, f));
});

test('none of the four new source files, nor the client script, names a fetch-style call', () => {
  for (const f of [...NEW_FILES, path.join(ROOT, 'assets', 'admin', 'updates.js')]) {
    assert.equal(FETCH_RE.test(stripComments(read(f))), false, path.relative(ROOT, f));
  }
});

test('positive controls: the scans catch a planted network require, console call and fetch-style name, and ignore comments', () => {
  assert.deepEqual(builtinOffenders("const h = require('node:https'); require('fs');"), ['node:https']);
  assert.deepEqual(builtinOffenders("const c = require('child_process');"), ['child_process']);
  assert.deepEqual(builtinOffenders("// require('http')\nrequire('fs');"), []);
  assert.equal(CONSOLE_RE.test('console.log(1)'), true);
  assert.equal(CONSOLE_RE.test('process.stderr.write(1)'), true);
  assert.equal(CONSOLE_RE.test(stripComments('// console.log(1)\nx();')), false);
  assert.equal(FETCH_RE.test('fetchRelease(1)'), true);
  assert.equal(FETCH_RE.test('lookupRelease(1)'), false);
});

// ---- the route file holds no write ---------------------------------------------------------------

const WRITE_TOKENS = [
  'writeFileSync', 'writeFile(', 'appendFileSync', 'appendFile(', 'copyFileSync', 'copyFile(', 'rmSync', 'rm(', 'unlinkSync', 'unlink(',
  'mkdirSync', 'mkdir(', 'renameSync', 'rename(', 'chmodSync', 'chmod(', 'truncateSync', 'truncate(', 'createWriteStream',
];

function writeTokensIn(source) {
  const code = stripComments(source);
  return WRITE_TOKENS.filter((t) => code.includes(t));
}

test('handlers/updates.js holds no PW15 write token and does not require the config writer', () => {
  const file = path.join(SRC, 'admin', 'handlers', 'updates.js');
  assert.deepEqual(writeTokensIn(read(file)), []);
  assert.equal(specsOf(file).some((s) => /config\/write/.test(s)), false);
  assert.equal(/writeConfigFile|serializeConfig|setUpdateSetting/.test(stripComments(read(file))), false);
});

test('positive controls: the write-token scan finds a planted write, and a planted config/write require is found', () => {
  assert.deepEqual(writeTokensIn("fs.writeFileSync('x', 'y');"), ['writeFileSync']);
  assert.deepEqual(writeTokensIn('// never writeFileSync here\nx();'), []);
  assert.equal(requireSpecs("require('../../config/write')").some((s) => /config\/write/.test(s)), true);
});

// ---- nothing else names the controller's file or the new route handlers --------------------------

test('only serve-admin.js builds the controller, and only the router requires the route file', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  const files = walk(SRC);
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  const needs = (target) =>
    files
      .filter((f) => requireSpecs(read(f)).some((s) => s.startsWith('.') && Module.builtinModules.indexOf(s) === -1 && path.resolve(path.dirname(f), s).replace(/\.js$/, '') === target.replace(/\.js$/, '')))
      .map(rel)
      .sort();
  assert.deepEqual(needs(path.join(SRC, 'admin', 'updatenotice.js')), ['src/cli/serve-admin.js']);
  assert.deepEqual(needs(path.join(SRC, 'admin', 'handlers', 'updates.js')), ['src/admin/router.js']);
  assert.deepEqual(needs(path.join(SRC, 'update', 'notice.js')), ['src/admin/updatenotice.js']);
  // positive control: the same filter finds a known importer
  assert.deepEqual(needs(path.join(SRC, 'admin', 'handlers', 'campaigns.js')), ['src/admin/router.js']);
});

test('the panel folder file name is update-check.json and the state file is written with a private temp file and a rename', () => {
  const source = read(path.join(SRC, 'admin', 'updatenotice.js'));
  assert.match(source, /FILE = 'update-check\.json'/);
  assert.match(stripComments(source), /openSync\(tmp, 'wx', 0o600\)/);
  assert.match(stripComments(source), /renameSync\(tmp, file\)/);
  assert.match(stripComments(source), /ensurePrivateDir\(panelDir\)/);
});
