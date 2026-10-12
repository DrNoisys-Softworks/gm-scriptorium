'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

/*
 * Structural pins for the published GM link (data-scriptorium-gm-access). test/gm-link-structure.test.js
 * is unchanged and keeps guarding the preview marker; these guard the second marker and the one
 * place that writes it. Every scan has a planted-offender control, so a scan that finds nothing
 * because it reads nothing cannot pass. The module-graph walker is copied (never require another
 * test file), as in test/gm-link-structure.test.js.
 */

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const ASSETS_DIR = path.join(ROOT, 'assets');
const BUILD_ENTRY = path.join(ROOT, 'src', 'cli', 'build.js');
const SERVE_ADMIN_ENTRY = path.join(ROOT, 'src', 'cli', 'serve-admin.js');
const GMLINK_FILE = path.join(ROOT, 'src', 'admin', 'gmlink.js');
const REMOTE_DIR = path.join(ROOT, 'src', 'remote');

const BUILTIN_NAMES = new Set(Module.builtinModules);
const normalizeSpec = (spec) => (spec.startsWith('node:') ? spec.slice('node:'.length) : spec);
const isBuiltinSpec = (spec) => BUILTIN_NAMES.has(normalizeSpec(spec));

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractSpecs(source) {
  const specs = [];
  const stripped = stripComments(source);
  const reRequire = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  const reImport = /import\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  while ((m = reRequire.exec(stripped))) specs.push(m[2]);
  while ((m = reImport.exec(stripped))) specs.push(m[2]);
  return specs;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  if (fs.existsSync(`${base}.json`)) return `${base}.json`;
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    if (fs.existsSync(path.join(base, 'index.js'))) return path.join(base, 'index.js');
    if (fs.existsSync(path.join(base, 'index.json'))) return path.join(base, 'index.json');
  }
  return base;
}

function walkModuleGraph(entryFiles) {
  const files = new Set();
  const unresolved = [];
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!fs.existsSync(file)) {
      unresolved.push(file);
      continue;
    }
    if (!file.endsWith('.js')) continue;
    for (const spec of extractSpecs(fs.readFileSync(file, 'utf8'))) {
      if (isBuiltinSpec(spec)) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        queue.push(resolveRelative(file, spec));
        continue;
      }
      try {
        queue.push(require.resolve(spec, { paths: [path.dirname(file)] }));
      } catch {
        unresolved.push(spec);
      }
    }
  }
  return { files, unresolved };
}

function walkAllFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  })(dir);
  return out;
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/** Every .js under src/ as { rel, source }. */
function srcSources() {
  return walkAllFiles(SRC_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ rel: rel(f), source: fs.readFileSync(f, 'utf8') }));
}

/** The shared scan: rels of entries whose source contains `needle`. */
function offenders(entries, needle) {
  return entries.filter((e) => e.source.includes(needle)).map((e) => e.rel).sort();
}

const PLANTED = (needle) => [{ rel: 'src/planted.js', source: `const x = '${needle}';\n` }];

// 1. the literal lives in one file

test('the literal "data-scriptorium-gm-access" appears under src/ only in src/build/gmaccess.js', () => {
  assert.deepEqual(offenders(srcSources(), 'data-scriptorium-gm-access'), ['src/build/gmaccess.js']);
});

test('control: the literal scan finds a planted offender', () => {
  assert.deepEqual(offenders([...srcSources(), ...PLANTED('data-scriptorium-gm-access')], 'data-scriptorium-gm-access'), [
    'src/build/gmaccess.js',
    'src/planted.js',
  ]);
});

// 2. the identifier lives in one file

test('the identifier GM_ACCESS_MARKER appears under src/ only in src/build/gmaccess.js', () => {
  assert.deepEqual(offenders(srcSources(), 'GM_ACCESS_MARKER'), ['src/build/gmaccess.js']);
});

test('control: the identifier scan finds a planted offender', () => {
  assert.deepEqual(offenders([...srcSources(), ...PLANTED('GM_ACCESS_MARKER')], 'GM_ACCESS_MARKER'), [
    'src/build/gmaccess.js',
    'src/planted.js',
  ]);
});

// 3. the two markers never contain each other

test('the two marker constants do not contain each other', () => {
  const { GM_ACCESS_MARKER } = require('../src/build/gmaccess');
  const { GM_LINK_MARKER } = require('../src/build/gmmarker');
  assert.ok(!GM_ACCESS_MARKER.includes(GM_LINK_MARKER));
  assert.ok(!GM_LINK_MARKER.includes(GM_ACCESS_MARKER));
});

// 4. no asset carries the literal

test('no file under assets/ contains the new literal', () => {
  const needle = Buffer.from('data-scriptorium-gm-access', 'utf8');
  const hits = walkAllFiles(ASSETS_DIR).filter((f) => fs.readFileSync(f).includes(needle)).map(rel);
  assert.deepEqual(hits, []);
});

test('control: the asset scan sees a planted literal in a byte buffer', () => {
  const needle = Buffer.from('data-scriptorium-gm-access', 'utf8');
  assert.ok(Buffer.from('<a data-scriptorium-gm-access>').includes(needle));
});

// 5. one caller

test('injectGmAccessLink is called under src/ only from src/build/run.js (plus its own definition)', () => {
  const entries = srcSources().filter((e) => e.rel !== 'src/build/gmaccess.js');
  assert.deepEqual(offenders(entries, 'injectGmAccessLink'), ['src/build/run.js']);
});

test('control: the caller scan finds a planted second caller', () => {
  const entries = [...srcSources().filter((e) => e.rel !== 'src/build/gmaccess.js'), ...PLANTED('injectGmAccessLink')];
  assert.deepEqual(offenders(entries, 'injectGmAccessLink'), ['src/build/run.js', 'src/planted.js']);
});

// 6. the preview writer stays apart

test('src/admin/gmlink.js does not require gmaccess', () => {
  const source = fs.readFileSync(GMLINK_FILE, 'utf8');
  assert.ok(!extractSpecs(source).some((s) => /gmaccess/.test(s)));
  assert.ok(!/gmaccess/.test(stripComments(source)));
});

test('control: the require extractor sees a planted gmaccess require', () => {
  assert.ok(extractSpecs("const g = require('../build/gmaccess');").some((s) => /gmaccess/.test(s)));
});

// 7. build stays unaware of [remote]

let buildGraph;
let serveAdminGraph;
test.before(() => {
  buildGraph = walkModuleGraph([BUILD_ENTRY]);
  serveAdminGraph = walkModuleGraph([SERVE_ADMIN_ENTRY]);
});

function remoteFilesIn(graph) {
  return [...graph.files].filter((f) => f.startsWith(REMOTE_DIR + path.sep)).map(rel).sort();
}

test('graph walks resolve every specifier', () => {
  assert.deepEqual(buildGraph.unresolved, []);
  assert.deepEqual(serveAdminGraph.unresolved, []);
});

test('the src/remote files reachable from src/cli/build.js are a subset of [src/remote/addr.js]', () => {
  const reached = remoteFilesIn(buildGraph);
  const extra = reached.filter((f) => f !== 'src/remote/addr.js');
  assert.deepEqual(extra, [], `build reaches remote code: ${extra.join(', ')}`);
});

test('control: the walk from src/cli/serve-admin.js reaches src/remote/settings.js', () => {
  assert.ok(remoteFilesIn(serveAdminGraph).includes('src/remote/settings.js'));
});

test('control: a planted require of a remote file from a build entry is caught', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-gma-graph-'));
  try {
    const entry = path.join(dir, 'planted-entry.js');
    fs.writeFileSync(entry, `require(${JSON.stringify(path.join(REMOTE_DIR, 'settings'))});\n`);
    assert.ok(remoteFilesIn(walkModuleGraph([entry])).includes('src/remote/settings.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
