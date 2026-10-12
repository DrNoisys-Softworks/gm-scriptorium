'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

/*
 * ADR 0055: no command-line flag reaches the output-leak scan override. The only lever is
 * runAtomicBuild's `force` argument (src/build/run.js), so this test walks the module graph from
 * bin/scriptorium.js and proves that every runAtomicBuild call reachable from the command line
 * is an object literal whose `force` is the literal `false`. A call that passes anything else
 * (a variable, `true`, an `opts` object built elsewhere, a member call) fails here.
 *
 * The maintainer scripts (scripts/equivalence-check.js, scripts/l4-render-audit.js) hardcode
 * `force: true` on purpose; they must stay OUT of the graph, which is asserted below.
 *
 * The module-graph walker is copied from test/gm-link-structure.test.js (normalizeSpec to
 * walkModuleGraph) with no changes, because tests never require another test file.
 */

const ROOT = path.join(__dirname, '..');
const BIN_ENTRY = path.join(ROOT, 'bin', 'scriptorium.js');

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

/**
 * Every runAtomicBuild( occurrence in `source` (comments stripped) that is not the function's own
 * declaration, with a reason when it is not an object literal whose force is exactly `false`.
 * Returns the violations as strings; an empty list means every call is acceptable.
 */
function forceViolations(source) {
  const stripped = stripComments(source);
  const out = [];
  const re = /runAtomicBuild\s*\(/g;
  let m;
  while ((m = re.exec(stripped))) {
    const before = stripped.slice(0, m.index);
    if (/function\s+$/.test(before)) continue; // the declaration itself
    const after = stripped.slice(m.index + m[0].length);
    const text = stripped.slice(m.index, m.index + 60).replace(/\s+/g, ' ');
    if (!/^\s*\{/.test(after)) {
      out.push(`not an object literal: ${text}`);
      continue;
    }
    const open = after.indexOf('{');
    let depth = 0;
    let end = -1;
    for (let i = open; i < after.length; i++) {
      if (after[i] === '{') depth++;
      else if (after[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const body = end === -1 ? after.slice(open) : after.slice(open, end + 1);
    if (!/\bforce\s*:\s*false\s*(,|\})/.test(body)) out.push(`force is not the literal false: ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  return out;
}

let graph;
function getGraph() {
  if (!graph) graph = walkModuleGraph([BIN_ENTRY]);
  return graph;
}

function repoFilesInGraph() {
  const { files } = getGraph();
  return [...files].filter((f) => f.startsWith(path.join(ROOT, 'src') + path.sep) || f.startsWith(path.join(ROOT, 'bin') + path.sep));
}

test('positive controls: the graph from bin reaches the product call site and the build module', () => {
  const { files, unresolved } = getGraph();
  assert.deepEqual(unresolved, []);
  assert.ok(files.has(path.join(ROOT, 'src', 'cli', 'build.js')), 'src/cli/build.js must be in the graph');
  assert.ok(files.has(path.join(ROOT, 'src', 'build', 'run.js')), 'src/build/run.js must be in the graph');
  assert.ok(files.has(path.join(ROOT, 'src', 'admin', 'preview.js')), 'the admin preview path must be in the graph');
});

test('the maintainer scripts that hardcode force: true are not reachable from bin/scriptorium.js', () => {
  const { files } = getGraph();
  for (const script of ['equivalence-check.js', 'l4-render-audit.js']) {
    assert.ok(!files.has(path.join(ROOT, 'scripts', script)), `scripts/${script} must not be in the command-line module graph`);
  }
  for (const f of files) assert.ok(!f.startsWith(path.join(ROOT, 'scripts') + path.sep), `${f} is a script reachable from bin`);
});

test('every runAtomicBuild call reachable from bin passes the literal force: false', () => {
  let callers = 0;
  for (const file of repoFilesInGraph()) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/runAtomicBuild\s*\(/.test(stripComments(source))) continue;
    const violations = forceViolations(source);
    assert.deepEqual(violations, [], `${path.relative(ROOT, file)}: ${violations.join(' | ')}`);
    if (path.relative(ROOT, file) !== path.join('src', 'build', 'run.js')) callers++;
  }
  assert.ok(callers >= 1, 'expected at least one product caller of runAtomicBuild in the graph (non-vacuous)');
  const build = fs.readFileSync(path.join(ROOT, 'src', 'cli', 'build.js'), 'utf8');
  assert.equal((stripComments(build).match(/runAtomicBuild\s*\(/g) || []).length, 1, 'src/cli/build.js has exactly one call site');
});

test('predicate controls: the check accepts force: false and flags every other shape', () => {
  assert.deepEqual(forceViolations('runAtomicBuild({ campaign, force: false, themePlan })'), []);
  assert.deepEqual(forceViolations('runAtomicBuild({\n  force: false\n})'), []);
  assert.deepEqual(forceViolations('function runAtomicBuild({ campaign, force = false }) {}'), []);
  assert.equal(forceViolations('runAtomicBuild({ campaign, force: forced })').length, 1);
  assert.equal(forceViolations('runAtomicBuild({ campaign, force: forceCheck })').length, 1);
  assert.equal(forceViolations('runAtomicBuild({ campaign, force: true })').length, 1);
  assert.equal(forceViolations('runAtomicBuild({ campaign, force: falsey })').length, 1);
  assert.equal(forceViolations('runAtomicBuild({ campaign })').length, 1);
  // A non-literal argument slips past any text match on the object, so it is refused outright.
  assert.equal(forceViolations('runAtomicBuild(opts)').length, 1);
  assert.equal(forceViolations('run.runAtomicBuild(opts)').length, 1);
  assert.equal(forceViolations('const r = cliBuild.runAtomicBuild(buildOpts({ force: false }))').length, 1);
  // Comments are not code.
  assert.deepEqual(forceViolations('// runAtomicBuild({ force: true })\nconst x = 1;'), []);
});
