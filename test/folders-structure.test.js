'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

/*
 * ADR 0049: the folder picker's structural fence. The listing lives in src/setup, so
 * test/setup-structure.test.js already holds it read-only (PW15 tokens, no computed require). Its
 * one folder write is a single non-recursive create in src/admin/foldercreate.js, and this file
 * pins who may reach it, what it may name, and that every filesystem call goes through the shared
 * bounded probe. stripComments, extractRequireSpecs, walkGraph and importersOf are copied from
 * test/setup-structure.test.js, not required (the precedent of the other structure tests). Every
 * scan has a positive control on a scratch tree.
 */

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const at = (...p) => path.join(SRC, ...p);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractRequireSpecs(source) {
  const specs = [];
  const re = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  const stripped = stripComments(source);
  while ((m = re.exec(stripped))) specs.push(m[2]);
  return specs;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  if (fs.existsSync(`${base}.json`)) return `${base}.json`;
  if (fs.existsSync(base) && fs.statSync(base).isDirectory() && fs.existsSync(path.join(base, 'index.js'))) return path.join(base, 'index.js');
  return base;
}

function walkGraph(entry) {
  const files = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!fs.existsSync(file) || !file.endsWith('.js')) continue;
    for (const spec of extractRequireSpecs(fs.readFileSync(file, 'utf8'))) {
      if (Module.builtinModules.includes(spec.replace(/^node:/, ''))) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        queue.push(resolveRelative(file, spec));
        continue;
      }
      try {
        queue.push(require.resolve(spec, { paths: [path.dirname(file)] }));
      } catch {
        // unresolved bare specifiers are generator-module-graph.test.js's business
      }
    }
  }
  return files;
}

function importersOf(graph, target) {
  return [...graph]
    .filter((f) => f.endsWith('.js') && fs.existsSync(f))
    .filter((f) => extractRequireSpecs(fs.readFileSync(f, 'utf8')).some((spec) => (spec.startsWith('.') || spec.startsWith('/')) && resolveRelative(f, spec) === target))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .sort();
}

function listJs(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) out.push(full);
    }
  })(dir);
  return out.sort();
}

const FOLDERS_JS = at('setup', 'folders.js');
const CREATE_JS = at('admin', 'foldercreate.js');
const HANDLER_JS = at('admin', 'handlers', 'folders.js');
const ROUTER_JS = at('admin', 'router.js');
const PANEL_ENTRY = at('cli', 'serve-admin.js');

const stripped = (file) => stripComments(fs.readFileSync(file, 'utf8'));
const specsOf = (file) => extractRequireSpecs(fs.readFileSync(file, 'utf8'));

// --- (a) the require lists --------------------------------------------------------------------------

test('(a) src/setup/folders.js requires exactly fs, os, path, ./probe, ../admin/uploadname and the error classes', () => {
  assert.deepEqual(specsOf(FOLDERS_JS).sort(), ['../admin/uploadname', '../util/errors', './probe', 'fs', 'os', 'path']);
});

test('(a) src/admin/foldercreate.js requires exactly fs, path, ../setup/probe, ../setup/folders, ../vault/packwrite and the error classes', () => {
  assert.deepEqual(specsOf(CREATE_JS).sort(), ['../setup/folders', '../setup/probe', '../vault/packwrite', 'fs', 'path']);
});

test('(a) neither module names a process, thread or network builtin', () => {
  const banned = ['child_process', 'worker_threads', 'cluster', 'net', 'http', 'https', 'http2', 'dgram', 'dns', 'tls', 'vm'];
  for (const file of [FOLDERS_JS, CREATE_JS]) {
    for (const spec of specsOf(file)) assert.equal(banned.includes(spec.replace(/^node:/, '')), false, `${path.relative(ROOT, file)} requires ${spec}`);
  }
});

// --- (b) what the mkdir module may say ----------------------------------------------------------------

const FORBIDDEN_IN_CREATE = [
  'rmSync', 'rm(', 'rmdir', 'unlink', 'rename', 'copyFile', 'cpSync', 'cp(', 'appendFile', 'truncate', 'chmod', 'createWriteStream',
  'writeFile', 'symlink', 'link(', 'mkdtemp', 'mkdirSync', 'recursive', 'openSync', 'open(',
];
const MKDIR_CALL_RE = /\.mkdir\(/g;
const COMPUTED_FS_RE = /\b(fs|fsp|promises)\s*\[/;

function forbiddenTokensIn(source) {
  const s = stripComments(source);
  return FORBIDDEN_IN_CREATE.filter((t) => s.includes(t));
}
const mkdirCalls = (source) => (stripComments(source).match(MKDIR_CALL_RE) || []).length;
const hasComputedFsAccess = (source) => COMPUTED_FS_RE.test(stripComments(source));

test('(b) foldercreate.js carries no deletion, rename, copy, link, recursive or other write token, and exactly one .mkdir( call', () => {
  const source = fs.readFileSync(CREATE_JS, 'utf8');
  assert.deepEqual(forbiddenTokensIn(source), []);
  assert.equal(mkdirCalls(source), 1);
  assert.equal(hasComputedFsAccess(source), false);
});

// --- (c) who says mkdir -------------------------------------------------------------------------------

function mkdirNamers(dirs) {
  return dirs
    .flatMap((d) => listJs(d))
    .filter((f) => stripped(f).includes('mkdir'))
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    .sort();
}

test('(c) under src/admin and src/setup the token mkdir appears only in foldercreate.js and variants.js', () => {
  assert.deepEqual(mkdirNamers([at('admin'), at('setup')]), ['admin/foldercreate.js', 'admin/variants.js']);
});

// --- (d) importers ------------------------------------------------------------------------------------

test('(d) in the panel graph foldercreate.js is imported only by its handler, the handler only by the router, folders.js only by those two', () => {
  const graph = walkGraph(PANEL_ENTRY);
  assert.ok(graph.has(CREATE_JS));
  assert.deepEqual(importersOf(graph, CREATE_JS), ['src/admin/handlers/folders.js']);
  assert.deepEqual(importersOf(graph, HANDLER_JS), ['src/admin/router.js']);
  assert.deepEqual(importersOf(graph, FOLDERS_JS), ['src/admin/foldercreate.js', 'src/admin/handlers/folders.js']);
});

// --- (e) createFolder has one caller --------------------------------------------------------------------

test('(e) createFolder( is called in src/ only inside the create function of handlers/folders.js', () => {
  const callers = listJs(SRC).filter((f) => f !== CREATE_JS && /\bcreateFolder\s*\(/.test(stripped(f)));
  assert.deepEqual(callers.map((f) => path.relative(ROOT, f).split(path.sep).join('/')), ['src/admin/handlers/folders.js']);
  const source = stripped(HANDLER_JS);
  const start = source.indexOf('async function create(');
  assert.ok(start > 0, 'handlers/folders.js defines async function create(');
  const end = source.indexOf('module.exports', start);
  assert.ok(end > start);
  assert.equal((source.match(/\bcreateFolder\s*\(/g) || []).length, 1);
  assert.ok(source.slice(start, end).includes('createFolder('));
});

// --- (f) the test seam is named in one place -----------------------------------------------------------------

test('(f) folderDeps is named under src/ only in handlers/folders.js', () => {
  const namers = listJs(SRC).filter((f) => /\bfolderDeps\b/.test(stripped(f)));
  assert.deepEqual(namers.map((f) => path.relative(ROOT, f).split(path.sep).join('/')), ['src/admin/handlers/folders.js']);
});

// --- (g) the route table --------------------------------------------------------------------------------------

test('(g) the route table: GET /api/folders has no audit flag, POST /api/folders/create is audited, both need auth, setup mode admits both', () => {
  const { ADMIN_ROUTES } = require('../src/admin/router');
  const setupmode = require('../src/admin/setupmode');
  const get = ADMIN_ROUTES.find((r) => r.method === 'GET' && r.path === '/api/folders');
  const post = ADMIN_ROUTES.find((r) => r.method === 'POST' && r.path === '/api/folders/create');
  assert.ok(get && post);
  assert.equal(Object.prototype.hasOwnProperty.call(get, 'audit'), false);
  assert.equal(post.audit, true);
  assert.equal(get.auth, true);
  assert.equal(post.auth, true);
  assert.ok(setupmode.SETUP_MODE_ROUTES.includes('GET /api/folders'));
  assert.ok(setupmode.SETUP_MODE_ROUTES.includes('POST /api/folders/create'));
  assert.equal(setupmode.SETUP_MODE_ROUTES.length, 8);
  assert.equal(ADMIN_ROUTES.filter((r) => r.path !== undefined && /folders/.test(r.path)).length, 2);
  assert.ok(fs.readFileSync(ROUTER_JS, 'utf8').includes('handlers/folders'));
});

// --- (h) no computed require ---------------------------------------------------------------------------------

const DYNAMIC_RE = /\brequire\(\s*[^'"\s]|\bmodule\.require\b|\brequire\.cache\b|\bprocess\.mainModule\b|\brequire\.resolve\b|\bimport\(/;

test('(h) DYNAMIC_RE matches neither new source file, or the handler', () => {
  for (const f of [FOLDERS_JS, CREATE_JS, HANDLER_JS]) assert.equal(DYNAMIC_RE.test(stripped(f)), false, path.relative(ROOT, f));
});

// --- every filesystem call goes through the bounded probe ---------------------------------------------------

test('every fsp call in both modules sits inside a probe.bounded( op: no bare await on fsp or fs.promises', () => {
  for (const f of [FOLDERS_JS, CREATE_JS]) {
    const s = stripped(f);
    assert.equal(/\bawait\s+(fsp|fs\.promises|deps\.fsp)\./.test(s), false, `${path.relative(ROOT, f)}: a bare await on the filesystem`);
    assert.equal(/\bfs\.(?!promises\b)[a-zA-Z]+Sync\b/.test(s), false, `${path.relative(ROOT, f)}: a synchronous fs call`);
    assert.equal(/\brealpathLoose\b|\bexistsSync\b/.test(s), false, path.relative(ROOT, f));
  }
});

// --- (i) positive controls -----------------------------------------------------------------------------------

test('(i) positive controls: each scan fails on a planted violation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-folders-fence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plant = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };

  const sync = plant('sync.js', "const fs = require('fs'); fs.mkdirSync('x');\n");
  assert.ok(forbiddenTokensIn(fs.readFileSync(sync, 'utf8')).includes('mkdirSync'));

  const rec = plant('rec.js', "async function f(fsp) { await fsp.mkdir('x', { recursive: true }); }\n");
  assert.ok(forbiddenTokensIn(fs.readFileSync(rec, 'utf8')).includes('recursive'));

  const delTokens = plant('del.js', "fs.rmSync(a); fsp.unlink(a); fsp.rename(a, b); fsp.copyFile(a, b); fsp.writeFile(a, b);\n");
  const found = forbiddenTokensIn(fs.readFileSync(delTokens, 'utf8'));
  for (const t2 of ['rmSync', 'unlink', 'rename', 'copyFile', 'writeFile']) assert.ok(found.includes(t2), t2);

  const computed = plant('computed.js', "async function f(fsp) { await fsp['mkdir']('x'); }\n");
  assert.equal(hasComputedFsAccess(fs.readFileSync(computed, 'utf8')), true);
  assert.equal(mkdirCalls(fs.readFileSync(computed, 'utf8')), 0, 'a computed call also breaks the exactly-one rule');

  const two = plant('two.js', 'async function f(fsp) { await fsp.mkdir(a); await fsp.mkdir(b); }\n');
  assert.equal(mkdirCalls(fs.readFileSync(two, 'utf8')), 2);

  const commented = plant('commented.js', "// fs.mkdirSync('x') and recursive: true are explained here\n/* rmSync */\nmodule.exports = 1;\n");
  assert.deepEqual(forbiddenTokensIn(fs.readFileSync(commented, 'utf8')), []);
  assert.equal(mkdirCalls(fs.readFileSync(commented, 'utf8')), 0);

  // the mkdir-namer scan sees a planted namer
  fs.mkdirSync(path.join(dir, 'admin'));
  fs.writeFileSync(path.join(dir, 'admin', 'sneaky.js'), "module.exports = require('fs').promises.mkdir;\n");
  assert.equal(listJs(path.join(dir, 'admin')).filter((f) => stripped(f).includes('mkdir')).length, 1);

  // the importer scan sees a planted second importer of foldercreate.js
  const second = plant('second.js', `require(${JSON.stringify(CREATE_JS)});\n`);
  const entry = plant('entry.js', `require(${JSON.stringify(PANEL_ENTRY)}); require('./second');\n`);
  const graph = walkGraph(entry);
  assert.deepEqual(importersOf(graph, CREATE_JS), [path.relative(ROOT, second).split(path.sep).join('/'), 'src/admin/handlers/folders.js'].sort());
  assert.notDeepEqual(importersOf(graph, CREATE_JS), ['src/admin/handlers/folders.js'], 'the assertion in (d) would be red');

  // DYNAMIC_RE and the bounded-call scan see planted violations
  assert.equal(DYNAMIC_RE.test('const x = require(name);'), true);
  assert.equal(/\bawait\s+(fsp|fs\.promises|deps\.fsp)\./.test('await fsp.lstat(p)'), true);
  assert.equal(/\bfs\.(?!promises\b)[a-zA-Z]+Sync\b/.test('fs.statSync(p)'), true);

  // the createFolder and folderDeps scans see planted callers
  assert.equal(/\bcreateFolder\s*\(/.test('createFolder({})'), true);
  assert.equal(/\bfolderDeps\b/.test('ctx.folderDeps'), true);
});
