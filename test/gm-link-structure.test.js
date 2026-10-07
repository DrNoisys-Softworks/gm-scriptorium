'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

/*
 * Phase 8 slice S6 (docs/agent-runs/admin-s6-engineering-brief-2026-09-28.md, "Test-first order"
 * item 4). FR34(a): a structural test that src/cli/build.js's module graph cannot reach the
 * GM-link writer, paired with a positive control (src/cli/serve.js's graph DOES reach it -- a
 * walker that resolves nothing would also find no gmlink.js, which proves nothing). The walker
 * itself is copied from test/generator-module-graph.test.js:69-155 verbatim (comment: "never
 * require another test file"), retargeted at these two entrypoints instead of
 * bin/scriptorium.js.
 */

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const ASSETS_DIR = path.join(ROOT, 'assets');
const BUILD_ENTRY = path.join(ROOT, 'src', 'cli', 'build.js');
const SERVE_ENTRY = path.join(ROOT, 'src', 'cli', 'serve.js');
const GMLINK_FILE = path.join(ROOT, 'src', 'admin', 'gmlink.js');

const BUILTIN_NAMES = new Set(Module.builtinModules);

function normalizeSpec(spec) {
  return spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
}

function isBuiltinSpec(spec) {
  return BUILTIN_NAMES.has(normalizeSpec(spec));
}

/** Strip /* *\/ and // comments before scanning (test/generator-module-graph.test.js's own precedent). */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Literal require('x') and import('x') specifiers only. */
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

/** Mirrors Node's real resolution order: LOAD_AS_FILE (exact, .js, .json) before LOAD_AS_DIRECTORY. */
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

/**
 * @param {string[]} entryFiles
 * @returns {{ files: Set<string>, builtins: Set<string>, unresolved: string[] }}
 */
function walkModuleGraph(entryFiles) {
  const files = new Set();
  const builtins = new Set();
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

    const source = fs.readFileSync(file, 'utf8');
    for (const spec of extractSpecs(source)) {
      if (isBuiltinSpec(spec)) {
        builtins.add(normalizeSpec(spec));
        continue;
      }
      if (spec.startsWith('.') || spec.startsWith('/')) {
        queue.push(resolveRelative(file, spec));
        continue;
      }
      try {
        queue.push(require.resolve(spec, { paths: [path.dirname(file)] }));
      } catch (err) {
        unresolved.push(spec);
      }
    }
  }

  return { files, builtins, unresolved };
}

/** Every regular file under `dir`, recursing directories only (no symlink following). */
function walkAllFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile()) out.push(abs);
    }
  })(dir);
  return out;
}

let buildGraph;
let serveGraph;
test.before(() => {
  buildGraph = walkModuleGraph([BUILD_ENTRY]);
  serveGraph = walkModuleGraph([SERVE_ENTRY]);
});

test('every specifier in both graphs resolves (no unresolvable require/import)', () => {
  assert.deepEqual(buildGraph.unresolved, [], `build.js graph: unresolvable specifier(s): ${buildGraph.unresolved.join(', ')}`);
  assert.deepEqual(serveGraph.unresolved, [], `serve.js graph: unresolvable specifier(s): ${serveGraph.unresolved.join(', ')}`);
});

// --- FR34(a): the negative and its positive control ------------------------

test("FR34(a): the module graph from src/cli/build.js does not reach src/admin/gmlink.js, or any file under src/admin/", () => {
  assert.ok(!buildGraph.files.has(GMLINK_FILE), 'src/cli/build.js graph must not reach src/admin/gmlink.js');
  const adminHits = [...buildGraph.files].filter((f) => f.startsWith(path.join(SRC_DIR, 'admin') + path.sep));
  assert.deepEqual(adminHits, [], `src/cli/build.js graph must not reach any file under src/admin/, found: ${adminHits.join(', ')}`);
});

test('FR34(a) positive control: the module graph from src/cli/serve.js DOES reach src/admin/gmlink.js', () => {
  // Without this, a walker that resolves nothing (e.g. a broken relative-path resolver) would
  // also report "build.js does not reach gmlink.js" -- proving nothing (CLAUDE.md's "tests that
  // pass today and prove nothing" standard, and the brief's own "a graph test with no positive
  // control" example).
  assert.ok(serveGraph.files.has(GMLINK_FILE), 'src/cli/serve.js graph is expected to reach src/admin/gmlink.js (it is the real launch path for the panel)');
});

// --- SD-1's "the marker literal must live in exactly one file" -------------

test('the literal string "data-scriptorium-gm-link" appears under src/ only in src/build/gmmarker.js', () => {
  const offenders = [];
  for (const f of walkAllFiles(SRC_DIR)) {
    if (!f.endsWith('.js')) continue;
    const source = fs.readFileSync(f, 'utf8');
    if (source.includes('data-scriptorium-gm-link')) offenders.push(path.relative(ROOT, f).split(path.sep).join('/'));
  }
  assert.deepEqual(offenders.sort(), ['src/build/gmmarker.js']);
});

test('the identifier "GM_LINK_MARKER" appears under src/ only in gmmarker.js, gmlink.js and outputgate.js', () => {
  const offenders = [];
  for (const f of walkAllFiles(SRC_DIR)) {
    if (!f.endsWith('.js')) continue;
    const source = fs.readFileSync(f, 'utf8');
    if (source.includes('GM_LINK_MARKER')) offenders.push(path.relative(ROOT, f).split(path.sep).join('/'));
  }
  assert.deepEqual(
    offenders.sort(),
    ['src/admin/gmlink.js', 'src/build/gmmarker.js', 'src/build/outputgate.js'].sort(),
  );
});

test('no file under assets/ contains the marker literal', () => {
  const offenders = [];
  for (const f of walkAllFiles(ASSETS_DIR)) {
    const bytes = fs.readFileSync(f);
    if (bytes.includes(Buffer.from('data-scriptorium-gm-link', 'utf8'))) offenders.push(path.relative(ROOT, f).split(path.sep).join('/'));
  }
  assert.deepEqual(offenders, [], `expected no file under assets/ to contain the marker literal, found: ${offenders.join(', ')}`);
});
