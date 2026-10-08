'use strict';

/*
 * Structural pins for launch mode (ADR 0028). The browser opener is named only where it belongs, launch
 * code requires no spawner but the one in src/proc/run.js, no non-literal require hides anything, the
 * single Origin exception stays one expression in the gate, and every test that loads launch mode
 * injects its own opener so no test can open a real browser. Every check has a positive control.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

function rel(root, f) {
  return path.relative(root, f).split(path.sep).join('/');
}

function listJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

// A local copy of the comment stripper used by the other structural tests (not an import).
function stripCommentsSafe(source) {
  return source.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m) => (m.startsWith('//') || m.startsWith('/*') ? '' : m),
  );
}

const CP_RE = /(?:\brequire\(\s*|\bimport\(\s*|\bfrom\s*|\bimport\s*)(['"`])(?:node:)?child_process\1/;

function nonLiteralCalls(source) {
  const stripped = stripCommentsSafe(source);
  const out = [];
  const re = /\b(?:require|import)\(/g;
  let m;
  while ((m = re.exec(stripped))) {
    const rest = stripped.slice(m.index);
    if (!/^(?:require|import)\(\s*(['"])[^'"\n]*\1\s*\)/.test(rest)) out.push(m.index);
  }
  return out;
}

const NAMES_OPENER = /\bopenFile\b/;

/** Files under the roots whose comment-stripped source names the opener. */
function openerNamers(roots, base) {
  const out = [];
  for (const root of roots) {
    for (const f of listJs(root)) if (NAMES_OPENER.test(stripCommentsSafe(fs.readFileSync(f, 'utf8')))) out.push(rel(base, f));
  }
  return out;
}

function requireSpecs(source) {
  const specs = [];
  const re = /require\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  const stripped = stripCommentsSafe(source);
  let m;
  while ((m = re.exec(stripped))) specs.push(m[2]);
  return specs;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return base;
}

function graphOf(entry) {
  const files = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file) || !fs.existsSync(file) || !file.endsWith('.js')) continue;
    files.add(file);
    for (const spec of requireSpecs(fs.readFileSync(file, 'utf8'))) {
      if (Module.builtinModules.includes(spec.replace(/^node:/, ''))) continue;
      if (spec.startsWith('.')) queue.push(resolveRelative(file, spec));
    }
  }
  return [...files];
}

/** problems with one test file's use of launch mode */
function checkLaunchTestFile(source) {
  const stripped = stripCommentsSafe(source);
  const loads = /require\(\s*(['"`])[^'"`]*\bcli\/launch(?:\.js)?\1\s*\)/.test(stripped);
  if (!loads) return [];
  return /\bopenFile\s*:/.test(stripped) ? [] : ['loads cli/launch without an injected openFile:'];
}

// --- the opener is named in two files ---------------------------------------------------------------------

test('openFile is named only in src/proc/run.js and src/cli/launch.js (nothing under src/ or bin/ else)', () => {
  const found = openerNamers([path.join(ROOT, 'src'), path.join(ROOT, 'bin')], ROOT);
  assert.ok(found.length >= 2);
  assert.deepEqual(found, ['src/cli/launch.js', 'src/proc/run.js']);
});

test('positive control: a scratch tree that names the opener elsewhere is detected, a comment is not', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-launch-ctl-'));
  try {
    fs.mkdirSync(path.join(scratch, 'src', 'a'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'src', 'a', 'sneaky.js'), `const x = ${['require', "('../proc/ru" + "n')"].join('')}.openFile;\n`);
    fs.writeFileSync(path.join(scratch, 'src', 'a', 'quiet.js'), '// openFile is mentioned only in this comment\nmodule.exports = 1;\n');
    assert.deepEqual(openerNamers([path.join(scratch, 'src')], scratch), ['src/a/sneaky.js']);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// --- launch code starts nothing itself ----------------------------------------------------------------------

const LAUNCH_FILES = [...listJs(path.join(ROOT, 'src', 'launch')), path.join(ROOT, 'src', 'cli', 'launch.js'), path.join(ROOT, 'src', 'admin', 'handlers', 'launch.js')];

test('launch code (src/launch, src/cli/launch.js, the exchange handler) has no non-literal require and does not name child_process', () => {
  assert.ok(LAUNCH_FILES.length >= 5, `expected at least five launch files, found ${LAUNCH_FILES.length}`);
  for (const f of LAUNCH_FILES) {
    const src = fs.readFileSync(f, 'utf8');
    assert.deepEqual(nonLiteralCalls(src), [], `${rel(ROOT, f)}: non-literal require`);
    assert.ok(!CP_RE.test(src), `${rel(ROOT, f)}: names child_process`);
    assert.ok(!/\bprocess\s*\.\s*binding\b|\bmodule\s*\.\s*require\b|\brequire\s*\.\s*cache\b|\bprocess\s*\.\s*mainModule\b/.test(stripCommentsSafe(src)), `${rel(ROOT, f)}: a require side door`);
  }
});

test('the only file in the launch code graph that names child_process is src/proc/run.js', () => {
  const graph = graphOf(path.join(ROOT, 'src', 'cli', 'launch.js'));
  assert.ok(graph.length > 20, `the graph walk saw ${graph.length} files`);
  const spawners = graph.filter((f) => CP_RE.test(fs.readFileSync(f, 'utf8'))).map((f) => rel(ROOT, f));
  assert.deepEqual(spawners, ['src/proc/run.js']);
  assert.ok(graph.some((f) => rel(ROOT, f) === 'src/proc/run.js'));
});

test('positive control: the non-literal and spawner scans catch planted launch files', () => {
  assert.equal(nonLiteralCalls('const a = require(name);').length, 1);
  assert.equal(nonLiteralCalls("const a = require('./x');").length, 0);
  assert.ok(CP_RE.test("const cp = require('child_process');"));
  assert.ok(CP_RE.test('import { spawn } from "node:child_process";'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-launch-ctl-'));
  try {
    fs.writeFileSync(path.join(scratch, 'entry.js'), "const a = require('./mid');\n");
    fs.writeFileSync(path.join(scratch, 'mid.js'), "const cp = require('child_process');\nconst b = require('./leaf');\n");
    fs.writeFileSync(path.join(scratch, 'leaf.js'), 'module.exports = 1;\n');
    const g = graphOf(path.join(scratch, 'entry.js')).map((f) => rel(scratch, f)).sort();
    assert.deepEqual(g, ['entry.js', 'leaf.js', 'mid.js']);
    assert.deepEqual(g.filter((f) => CP_RE.test(fs.readFileSync(path.join(scratch, f), 'utf8'))), ['mid.js']);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// --- no test can open a real browser ---------------------------------------------------------------------------

test('every test file that loads cli/launch injects openFile: so no test opens a real browser', () => {
  const loaders = [];
  const problems = [];
  for (const f of listJs(path.join(ROOT, 'test'))) {
    const src = fs.readFileSync(f, 'utf8');
    if (/require\(\s*(['"`])[^'"`]*\bcli\/launch(?:\.js)?\1\s*\)/.test(stripCommentsSafe(src))) loaders.push(rel(ROOT, f));
    for (const p of checkLaunchTestFile(src)) problems.push(`${rel(ROOT, f)}: ${p}`);
  }
  assert.deepEqual(problems, []);
  for (const expected of ['test/launch-console.test.js', 'test/launch-exchange-http.test.js', 'test/launch-opener.test.js']) {
    assert.ok(loaders.includes(expected), `${expected} should be among the files that load launch mode`);
  }
});

test('positive control: the loader check flags a test that loads launch mode without injecting an opener', () => {
  const REQ = ['require', "('../src/cli/launch')"].join('');
  assert.deepEqual(checkLaunchTestFile(`const { runLaunch } = ${REQ};\nrunLaunch({}, { input, openFile: async () => ({}) });\n`), []);
  assert.equal(checkLaunchTestFile(`const { runLaunch } = ${REQ};\nrunLaunch({}, { input });\n`).length, 1);
  assert.equal(checkLaunchTestFile(`const { runLaunch } = ${REQ};\n// openFile: only in a comment\n`).length, 1);
  assert.deepEqual(checkLaunchTestFile('const x = 1;\n'), []);
});

// --- the Origin exception stays one expression ------------------------------------------------------------------

test('the gate holds the only Origin: null comparison under src/, in one expression keyed on launchExchange, loopback kind and the exact path', () => {
  const hits = [];
  for (const f of listJs(path.join(ROOT, 'src'))) {
    const stripped = stripCommentsSafe(fs.readFileSync(f, 'utf8'));
    if (/origin\s*===\s*'null'|origin\s*==\s*'null'|'null'\s*===\s*[\w.]*origin/i.test(stripped)) hits.push(rel(ROOT, f));
  }
  assert.deepEqual(hits, ['src/admin/gate.js']);
  const gate = stripCommentsSafe(fs.readFileSync(path.join(ROOT, 'src', 'admin', 'gate.js'), 'utf8'));
  assert.match(gate, /const launchPost = launchExchange === true && kind === 'loopback' && pathname === '\/auth\/launch';/);
  assert.match(gate, /headers\.origin !== expected && !\(launchPost && headers\.origin === 'null'\)/);
  assert.equal((gate.match(/'null'/g) || []).length, 1);
});

test('launchExchange is set from the code store in one place (the router) and the store is created in one place (launch mode)', () => {
  const router = stripCommentsSafe(fs.readFileSync(path.join(ROOT, 'src', 'admin', 'router.js'), 'utf8'));
  assert.equal((router.match(/launchExchange:\s*Boolean\(ctx\.launchCodes\)/g) || []).length, 1);
  assert.equal((router.match(/\blaunchExchange\s*:/g) || []).length, 1, 'only one key named launchExchange is passed to the gate');
  const assigners = [];
  const creators = [];
  for (const f of [...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'bin'))]) {
    const stripped = stripCommentsSafe(fs.readFileSync(f, 'utf8'));
    if (/\.launchCodes\s*=[^=]/.test(stripped)) assigners.push(rel(ROOT, f));
    if (/\bcreateLaunchCodeStore\s*\(/.test(stripped)) creators.push(rel(ROOT, f));
  }
  assert.deepEqual(assigners, ['src/cli/launch.js']);
  assert.deepEqual(creators.sort(), ['src/cli/launch.js', 'src/launch/codes.js']);
});

test('SIGHUP is named in the stop-signal list only, and POSIX gets it only through { hup: true }', () => {
  const namers = [];
  for (const f of listJs(path.join(ROOT, 'src'))) if (/\bSIGHUP\b/.test(stripCommentsSafe(fs.readFileSync(f, 'utf8')))) namers.push(rel(ROOT, f));
  assert.deepEqual(namers, ['src/util/stop-signals.js']);
  const calls = [];
  for (const f of [...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'bin'))]) {
    const stripped = stripCommentsSafe(fs.readFileSync(f, 'utf8'));
    if (/hup\s*:\s*true/.test(stripped)) calls.push(rel(ROOT, f));
  }
  assert.deepEqual(calls, ['src/cli/launch.js']);
});
