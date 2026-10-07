'use strict';

/*
 * Structural pins for the one process spawner (ADR 0046).
 *
 *   1. Only src/proc/run.js (plus the two older spawners) may start a program.
 *   2. src/proc/run.js itself keeps to its rules: no shell, no ambient environment, no console.
 *   3. Every test file that uses the spawner goes through test/helpers/proc-fakebin.js, so no
 *      test can start a program outside the scratch folder (the PATH-scrub assertion, rule f),
 *      and none touches the process PATH (rule g).
 *
 * Every regex here has a positive control. Tests that pass before the spawner exists and so prove
 * nothing about it: the allowed-name literal pin (it proves the list, not that it is enforced).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ALLOWED_COMMANDS,
  BASE_ENV_POSIX,
  BASE_ENV_WIN32,
  STRIPPED_ENV_NAMES,
  STRIPPED_ENV_PREFIXES,
  WINDOWS_EXTENSIONS,
  MAX_LIVE_RUNS,
  DEFAULTS,
  ProcError,
  buildChildEnv,
  buildInvocation,
  resolveCommand,
  killAll,
  liveRunCount,
} = require('../src/proc/run');
const { makeFakeBin } = require('./helpers/proc-fakebin');

const ROOT = path.join(__dirname, '..');
const RUN_FILE = path.join(ROOT, 'src', 'proc', 'run.js');
const HELPER_REL = 'test/helpers/proc-fakebin.js';

const EXPECTED_SPAWNERS = ['src/cli/config.js', 'src/proc/run.js', 'src/update/gh.js'];

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

// A local copy of the comment stripper in test/generator-module-graph.test.js, not an import.
function stripCommentsSafe(source) {
  return source.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m) => (m.startsWith('//') || m.startsWith('/*') ? '' : m),
  );
}

// Any way of naming the module: require, dynamic import, or a static import/from, with ', " or `,
// with or without the node: prefix.
const CP_RE = /(?:\brequire\(\s*|\bimport\(\s*|\bfrom\s*|\bimport\s*)(['"`])(?:node:)?child_process\1/;

// A require( or import( whose argument is not a plain quoted literal.
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

function scanSpawners(srcRoot, root) {
  const files = listJs(srcRoot);
  const spawners = files.filter((f) => CP_RE.test(fs.readFileSync(f, 'utf8'))).map((f) => rel(root, f));
  return { files, spawners };
}

test('one spawner: the files under src/ that name child_process are exactly the three expected', () => {
  const { files, spawners } = scanSpawners(path.join(ROOT, 'src'), ROOT);
  assert.ok(files.length >= 100, `expected at least 100 source files, scanned ${files.length}`);
  assert.deepEqual(spawners, EXPECTED_SPAWNERS);
});

test('one spawner: the admin, ai and publish folders are named, and admin is real', () => {
  const present = {};
  for (const name of ['admin', 'ai', 'publish']) {
    const dir = path.join(ROOT, 'src', name);
    present[name] = fs.existsSync(dir) ? listJs(dir).length : 0;
  }
  assert.ok(present.admin >= 1, 'src/admin must exist and hold source files');
  for (const name of ['admin', 'ai', 'publish']) {
    const { spawners } = scanSpawners(path.join(ROOT, 'src', name), ROOT);
    assert.deepEqual(spawners, [], `src/${name} must not start programs`);
  }
});

test('one spawner: cluster is required nowhere under src/', () => {
  const re = /(?:\brequire\(\s*|\bimport\(\s*|\bfrom\s*)(['"`])(?:node:)?cluster\1/;
  const offenders = listJs(path.join(ROOT, 'src'))
    .filter((f) => re.test(fs.readFileSync(f, 'utf8')))
    .map((f) => rel(ROOT, f));
  assert.deepEqual(offenders, []);
});

test('one spawner: no non-literal require( or import( under admin, ai, publish or proc', () => {
  const offenders = [];
  for (const name of ['admin', 'ai', 'publish', 'proc']) {
    for (const f of listJs(path.join(ROOT, 'src', name))) {
      if (nonLiteralCalls(fs.readFileSync(f, 'utf8')).length > 0) offenders.push(rel(ROOT, f));
    }
  }
  assert.deepEqual(offenders, []);
});

test('one spawner: positive control, a scratch tree with every form under admin and ai is detected', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-structure-ctl-'));
  try {
    const forms = [
      "const a = require('child_process');",
      'const b = require("node:child_process");',
      'const c = require(`child_process`);',
      "const d = import('child_process');",
      "import { spawn } from 'node:child_process';",
      'const e = require(variable);',
    ];
    for (const sub of ['admin', 'ai']) {
      const dir = path.join(scratch, 'src', sub);
      fs.mkdirSync(dir, { recursive: true });
      forms.forEach((src, i) => fs.writeFileSync(path.join(dir, `planted${i}.js`), src + '\n'));
    }
    fs.mkdirSync(path.join(scratch, 'src', 'ok'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'src', 'ok', 'fine.js'), "const x = require('./y');\n// require('child_process') in a comment is not code\n");
    const { spawners } = scanSpawners(path.join(scratch, 'src'), scratch);
    const expected = [];
    for (const sub of ['admin', 'ai']) for (let i = 0; i < 5; i++) expected.push(`src/${sub}/planted${i}.js`);
    // The comment-only file is still caught by the raw scan: that is deliberate, a comment can be edited into code.
    expected.push('src/ok/fine.js');
    assert.deepEqual(spawners.sort(), expected.sort());
    assert.equal(nonLiteralCalls(fs.readFileSync(path.join(scratch, 'src', 'admin', 'planted5.js'), 'utf8')).length, 1);
    assert.equal(nonLiteralCalls("const z = require('./y');").length, 0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// --- the literal pins ------------------------------------------------------------------------------

test('allowlist literal pin (proves the list, not that it is enforced)', () => {
  assert.deepEqual([...ALLOWED_COMMANDS], ['claude', 'codex', 'gemini', 'git', 'rsync', 'ssh', 'whisper-cli']);
  assert.ok(Object.isFrozen(ALLOWED_COMMANDS));
});

test('base environment lists and strip rules are pinned as literals', () => {
  assert.deepEqual([...BASE_ENV_POSIX], [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  ]);
  assert.deepEqual([...STRIPPED_ENV_NAMES], ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  assert.deepEqual([...STRIPPED_ENV_PREFIXES], ['CLAUDE_CODE_USE_']);
  for (const k of ['SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
    assert.ok(!BASE_ENV_POSIX.includes(k) && !BASE_ENV_WIN32.includes(k), `${k} must not be in a base list`);
  }
});

test('defaults and limits are pinned as literals', () => {
  assert.deepEqual({ ...DEFAULTS }, { timeoutMs: 600000, killGraceMs: 5000, maxStdoutBytes: 8388608, maxStderrBytes: 1048576 });
  assert.equal(MAX_LIVE_RUNS, 8);
  assert.deepEqual([...WINDOWS_EXTENSIONS], ['.exe', '.cmd']);
});

test('the documented functions are exported as functions', () => {
  for (const fn of [buildChildEnv, buildInvocation, resolveCommand, killAll, liveRunCount, ProcError]) {
    assert.equal(typeof fn, 'function');
  }
});

test('helper control: an empty scratch bin resolves none of the allowed names', (t) => {
  const fb = makeFakeBin(t, { empty: true });
  for (const name of ALLOWED_COMMANDS) {
    assert.throws(
      () => resolveCommand(name, { env: { PATH: fb.dir }, platform: process.platform }),
      (e) => e instanceof ProcError && e.code === 'E_PROC_NOT_FOUND',
    );
  }
});

// --- run.js source checks ---------------------------------------------------------------------------

const RUN_SOURCE = fs.readFileSync(RUN_FILE, 'utf8');
const RUN_STRIPPED = stripCommentsSafe(RUN_SOURCE);

const FORBIDDEN_IN_RUN = [
  ['process.env', /\bprocess\s*\.\s*env\b/],
  ['shell: true', /shell\s*:\s*true/],
  ['execSync', /\bexecSync\b/],
  ['exec(', /\bexec\(/],
  ['execFile', /\bexecFile/],
  ['spawnSync', /\bspawnSync\b/],
  ['fork(', /\bfork\(/],
  ['console.', /\bconsole\s*\./],
  ['process.stdout', /\bprocess\s*\.\s*stdout\b/],
  ['process.stderr', /\bprocess\s*\.\s*stderr\b/],
];

test('run.js source: none of the forbidden constructs appear (comments stripped)', () => {
  for (const [label, re] of FORBIDDEN_IN_RUN) {
    assert.ok(!re.test(RUN_STRIPPED), `src/proc/run.js must not contain ${label}`);
  }
});

test('run.js source: positive control, every forbidden regex matches a planted line', () => {
  const planted = {
    'process.env': 'const e = process.env.PATH;',
    'shell: true': 'spawn(a, b, { shell: true });',
    execSync: 'execSync("ls");',
    'exec(': 'exec("ls");',
    execFile: 'execFileSync("ls");',
    spawnSync: 'spawnSync("ls");',
    'fork(': 'fork("x.js");',
    'console.': 'console.log(1);',
    'process.stdout': 'process.stdout.write("x");',
    'process.stderr': 'process.stderr.write("x");',
  };
  for (const [label, re] of FORBIDDEN_IN_RUN) assert.match(planted[label], re, label);
  assert.ok(!/\bexec\(/.test('regex.test(x)'));
});

test('run.js source: shell: false is present and child_process is imported as exactly { spawn }', () => {
  assert.match(RUN_STRIPPED, /shell\s*:\s*false/);
  const imports = RUN_STRIPPED.match(/require\(\s*(['"])child_process\1\s*\)/g) || [];
  assert.equal(imports.length, 1);
  assert.match(RUN_STRIPPED, /const\s*\{\s*spawn\s*\}\s*=\s*require\(\s*(['"])child_process\1\s*\)\s*;/);
});

test('run.js source: requires only child_process, fs, os, path and the shared errors module', () => {
  const specs = [...RUN_STRIPPED.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]).sort();
  assert.deepEqual(specs, ['../util/errors', 'child_process', 'fs', 'os', 'path']);
});

test('run.js source: a ProcError never carries a cause', () => {
  assert.ok(!/\bcause\b/.test(RUN_STRIPPED), 'no cause anywhere in the executable source');
  const err = new ProcError('E_PROC_SPAWN', 'x', { syscallCode: 'ENOENT' });
  assert.equal(err.cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(err, 'cause'));
});

// --- (f) and (g): tests may only reach the spawner through the helper ------------------------------

const REQUIRE_RUN_ANY = /require\(\s*(['"`])[^'"`]*\bproc\/run(?:\.js)?\1\s*\)/g;
const REQUIRE_RUN_DESTRUCTURED = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"`])[^'"`]*\bproc\/run(?:\.js)?\2\s*\)/g;
const REQUIRE_HELPER = /require\(\s*(['"`])[^'"`]*\bhelpers\/proc-fakebin(?:\.js)?\1\s*\)|require\(\s*(['"`])\.\/proc-fakebin(?:\.js)?\2\s*\)/;
const PATH_MUTATIONS = [
  /\bprocess\s*\.\s*env\s*\.\s*PATH\s*=[^=]/,
  /\bprocess\s*\.\s*env\s*\[\s*(['"`])PATH\1\s*\]\s*=[^=]/,
  /\bdelete\s+process\s*\.\s*env\s*\.\s*PATH\b/,
  /\bdelete\s+process\s*\.\s*env\s*\[\s*(['"`])PATH\1\s*\]/,
  /\bprocess\s*\.\s*env\s*=[^=]/,
  /\bObject\s*\.\s*assign\(\s*process\s*\.\s*env\b/,
];

function boundNames(clause) {
  return clause
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((part) => part.split(':').map((x) => x.trim()));
}

/** @returns {string[]} problems found in one test file's source */
function checkTestFile(source, isHelper) {
  const problems = [];
  const stripped = stripCommentsSafe(source);
  const any = stripped.match(REQUIRE_RUN_ANY) || [];
  const uses = any.length > 0;
  if (!isHelper && uses) {
    if (!REQUIRE_HELPER.test(stripped)) problems.push('requires the spawner without requiring helpers/proc-fakebin');
    if (!/\bmakeFakeBin\(/.test(stripped)) problems.push('never calls makeFakeBin(');
    const destructured = [...stripped.matchAll(REQUIRE_RUN_DESTRUCTURED)];
    if (destructured.length !== any.length) problems.push('requires the spawner other than by destructuring');
    for (const m of destructured) {
      if (boundNames(m[1]).includes('run')) problems.push('destructures run from the spawner');
    }
  }
  if (isHelper || uses || REQUIRE_HELPER.test(stripped)) {
    for (const re of PATH_MUTATIONS) if (re.test(stripped)) problems.push('mutates process.env or its PATH');
  }
  return problems;
}

test('rule f and g: every test file that uses the spawner goes through the helper', () => {
  const files = listJs(path.join(ROOT, 'test'));
  const using = [];
  const problems = [];
  for (const f of files) {
    const r = rel(ROOT, f);
    const src = fs.readFileSync(f, 'utf8');
    const isHelper = r === HELPER_REL;
    if (!isHelper && (stripCommentsSafe(src).match(REQUIRE_RUN_ANY) || []).length > 0) using.push(r);
    for (const p of checkTestFile(src, isHelper)) problems.push(`${r}: ${p}`);
  }
  assert.deepEqual(problems, []);
  for (const expected of ['test/proc-run.test.js', 'test/proc-windows.test.js', 'test/proc-structure.test.js']) {
    assert.ok(using.includes(expected), `${expected} should be among the files that use the spawner`);
  }
});

test('rule f and g: positive controls for every check', () => {
  const REQ = (p) => ['require', "('", p, "')"].join('');
  const good =
    `const { ProcError } = ${REQ('../src/proc/run')};\nconst { makeFakeBin } = ${REQ('./helpers/proc-fakebin')};\nmakeFakeBin(t);\n`;
  assert.deepEqual(checkTestFile(good, false), []);
  // no helper
  assert.ok(checkTestFile(`const { ProcError } = ${REQ('../src/proc/run')};\nmakeFakeBin(t);\n`, false).some((p) => /without requiring/.test(p)));
  // no makeFakeBin call
  assert.ok(checkTestFile(`const { ProcError } = ${REQ('../src/proc/run')};\nconst h = ${REQ('./helpers/proc-fakebin')};\n`, false).some((p) => /never calls/.test(p)));
  // whole-module require
  assert.ok(checkTestFile(`const proc = ${REQ('../src/proc/run')};\n${REQ('./helpers/proc-fakebin')};\nmakeFakeBin(t);\n`, false).some((p) => /other than by destructuring/.test(p)));
  // run destructured, plain and renamed both ways
  for (const clause of ['run', 'ProcError, run', 'run: go', 'go: run']) {
    const src = `const { ${clause} } = ${REQ('../src/proc/run')};\n${REQ('./helpers/proc-fakebin')};\nmakeFakeBin(t);\n`;
    assert.ok(checkTestFile(src, false).some((p) => /destructures run/.test(p)), clause);
  }
  // a comment mentioning the require is not a require
  assert.deepEqual(checkTestFile(`// ${REQ('../src/proc/run')}\n`, false), []);
  // PATH mutation, five spellings
  // Built from pieces so this file does not itself contain a PATH mutation.
  const penv = ['process', '.env'].join('');
  const spellings = [
    penv + '.PATH = "x";',
    penv + '["PATH"] = "x";',
    'delete ' + penv + '.PATH;',
    'delete ' + penv + "['PATH'];",
    penv + ' = {};',
    'Object.assign(' + penv + ', {});',
  ];
  for (const s of spellings) {
    const src = `${REQ('./helpers/proc-fakebin')};\n${s}\n`;
    assert.ok(checkTestFile(src, false).some((p) => /mutates/.test(p)), s);
  }
  // reading and comparing is fine
  assert.deepEqual(checkTestFile(`${REQ('./helpers/proc-fakebin')};\nif (${penv}.PATH === x) {}\n`, false), []);
  // the helper is subject to (g) but exempt from (f)
  assert.deepEqual(checkTestFile(`const { run } = ${REQ('../../src/proc/run')};\n`, true), []);
  assert.ok(checkTestFile(penv + '.PATH = "x";', true).length > 0);
});

// --- timers -------------------------------------------------------------------------------------------

test('run.js source: every timer is unref-ed so none can hold the process open', () => {
  const timers = RUN_STRIPPED.match(/\bsetTimeout\(/g) || [];
  const unrefs = RUN_STRIPPED.match(/\.unref\(\)/g) || [];
  assert.ok(timers.length >= 1, 'the kill, timeout and drain timers exist');
  assert.ok(unrefs.length >= timers.length, `${timers.length} timers but ${unrefs.length} unref calls`);
  assert.ok(!/\bsetInterval\(/.test(RUN_STRIPPED), 'no interval timers');
});
