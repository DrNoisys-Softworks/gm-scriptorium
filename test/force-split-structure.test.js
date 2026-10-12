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

/** Index just past the bracket that closes the one opening at `open` (strings are skipped), or -1. */
function matchClose(s, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const stack = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === '}' || c === ')' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** The top-level comma-separated entries of the object literal whose '{' is at `open`. */
function topLevelEntries(s, open) {
  const end = matchClose(s, open);
  if (end === -1) return null;
  const inner = s.slice(open + 1, end - 1);
  const entries = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < inner.length && inner[i] !== c; i++) if (inner[i] === '\\') i++;
      continue;
    }
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      entries.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  entries.push(inner.slice(start).trim());
  return entries.filter((e) => e !== '');
}

/**
 * ADR 0055. Every appearance of the identifier runAtomicBuild in `source` (comments stripped) must be
 * one of: the function's own declaration; the plain destructured require (no rename); a shorthand
 * entry of module.exports; or a call `runAtomicBuild({...})` whose object literal has no spread and
 * exactly one top-level `force` entry, whose value is the literal `false`. Anything else (an alias,
 * .call or .apply, a member or bracket access, a reassignment, passing it as a value, a call with a
 * non-literal argument) is a violation. Returns violation strings; empty means acceptable.
 */
function forceViolations(source) {
  const s = stripComments(source);
  const out = [];
  const allowedRanges = [];
  for (const re of [/const\s*\{[^}]*\}\s*=\s*require\([^)]*\)/g, /module\.exports\s*=\s*\{[^}]*\}/g]) {
    let r;
    while ((r = re.exec(s))) allowedRanges.push([r.index, r.index + r[0].length]);
  }
  const re = /runAtomicBuild/g;
  let m;
  while ((m = re.exec(s))) {
    const i = m.index;
    const before = s.slice(Math.max(0, i - 40), i);
    const after = s.slice(i + m[0].length);
    const ctx = s.slice(Math.max(0, i - 20), i + 50).replace(/\s+/g, ' ');
    if (/[A-Za-z0-9_$]$/.test(before) || /^[A-Za-z0-9_$]/.test(after)) continue; // part of a longer identifier
    if (/function\s+$/.test(before)) continue; // the declaration itself
    const inAllowed = allowedRanges.some(([a, b]) => i >= a && i < b);
    if (inAllowed) {
      if (/^\s*[,}]/.test(after) && !/:\s*$/.test(before)) continue; // plain destructure or shorthand export
      out.push(`renamed or aliased in a destructure or export: ${ctx}`);
      continue;
    }
    if (/\.\s*$/.test(before)) {
      out.push(`member access: ${ctx}`);
      continue;
    }
    const call = /^\s*\(\s*(\{)/.exec(after);
    if (!call) {
      out.push(`not a direct runAtomicBuild({...}) call (alias, value, bracket access or non-literal argument): ${ctx}`);
      continue;
    }
    const open = i + m[0].length + call[0].length - 1;
    const entries = topLevelEntries(s, open);
    if (!entries) {
      out.push(`unbalanced call: ${ctx}`);
      continue;
    }
    let forceFalse = 0;
    for (const e of entries) {
      if (e.startsWith('...')) out.push(`object spread in call: ${e.slice(0, 60)}`);
      else if (e.startsWith('[')) out.push(`computed key in call: ${e.slice(0, 60)}`);
      else if (/^(['"]?)force\1\s*:\s*false$/.test(e)) forceFalse++;
      else if (/^(['"]?)force\1\s*(:|=|$)/.test(e)) out.push(`force is not the literal false: ${e.slice(0, 60)}`);
    }
    if (forceFalse !== 1) out.push(`expected exactly one top-level force: false, found ${forceFalse}: ${ctx}`);
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
    if (!/runAtomicBuild/.test(stripComments(source))) continue;
    const violations = forceViolations(source);
    assert.deepEqual(violations, [], `${path.relative(ROOT, file)}: ${violations.join(' | ')}`);
    if (path.relative(ROOT, file) !== path.join('src', 'build', 'run.js')) callers++;
  }
  assert.ok(callers >= 1, 'expected at least one product caller of runAtomicBuild in the graph (non-vacuous)');
  const build = fs.readFileSync(path.join(ROOT, 'src', 'cli', 'build.js'), 'utf8');
  assert.equal((stripComments(build).match(/runAtomicBuild\s*\(/g) || []).length, 1, 'src/cli/build.js has exactly one call site');
});

test('predicate controls: the check accepts the sanctioned shapes and flags every other shape', () => {
  // accepted
  assert.deepEqual(forceViolations('runAtomicBuild({ campaign, force: false, themePlan })'), []);
  assert.deepEqual(forceViolations('runAtomicBuild({\n  force: false\n})'), []);
  assert.deepEqual(forceViolations('function runAtomicBuild({ campaign, force = false }) {}'), []);
  assert.deepEqual(forceViolations("const { runAtomicBuild } = require('../build/run');"), []);
  assert.deepEqual(forceViolations('module.exports = { runAtomicBuild, generatorWarningLines };'), []);
  assert.deepEqual(forceViolations('// runAtomicBuild({ force: true })\nconst x = 1;'), []);
  // wrong value
  assert.ok(forceViolations('runAtomicBuild({ campaign, force: forced })').length >= 1);
  assert.ok(forceViolations('runAtomicBuild({ campaign, force: forceCheck })').length >= 1);
  assert.ok(forceViolations('runAtomicBuild({ campaign, force: true })').length >= 1);
  assert.ok(forceViolations('runAtomicBuild({ campaign, force: falsey })').length >= 1);
  assert.ok(forceViolations('runAtomicBuild({ campaign })').length >= 1);
  assert.equal(forceViolations('runAtomicBuild({ campaign, force })').length >= 1, true);
  // nested force must not satisfy the check
  assert.ok(forceViolations('runAtomicBuild({ force: forceCheck, meta: { force: false } })').length >= 1);
  // spread, before or after
  assert.ok(forceViolations('runAtomicBuild({ force: false, ...{ force: forceCheck } })').length >= 1);
  assert.ok(forceViolations('runAtomicBuild({ ...o, force: false })').length >= 1);
  // computed key
  assert.ok(forceViolations("runAtomicBuild({ force: false, ['force']: true })").length >= 1);
  // two force entries
  assert.ok(forceViolations('runAtomicBuild({ force: false, force: forceCheck })').length >= 1);
  // non-literal argument
  assert.ok(forceViolations('runAtomicBuild(opts)').length >= 1);
  assert.ok(forceViolations('runAtomicBuild(buildOpts({ force: false }))').length >= 1);
  // aliases and indirect use
  assert.ok(forceViolations("const { runAtomicBuild: rab } = require('../build/run'); rab({ ...o, force: true });").length >= 1);
  assert.ok(forceViolations('module.exports = { runAtomicBuild: other };').length >= 1);
  assert.ok(forceViolations('runAtomicBuild.call(null, { force: true })').length >= 1);
  assert.ok(forceViolations('runAtomicBuild.apply(null, [{ force: true }])').length >= 1);
  assert.ok(forceViolations('run.runAtomicBuild({ force: false })').length >= 1);
  assert.ok(forceViolations("run['runAtomicBuild']({ force: true })").length >= 1);
  assert.ok(forceViolations('const f = runAtomicBuild; f({ force: true });').length >= 1);
  assert.ok(forceViolations('go(runAtomicBuild);').length >= 1);
  assert.ok(forceViolations('runAtomicBuild = other;').length >= 1);
});
