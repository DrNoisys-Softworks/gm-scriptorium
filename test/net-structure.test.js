'use strict';

/*
 * Structural pins for the outgoing connection module (ADR 0024).
 *
 *   1. Only src/net/egress.js (and the listener in src/serve/server.js) may load a network module.
 *   2. src/net is made of leaves: it requires nothing outside itself except the shared errors file.
 *   3. Nothing under src/net names a fetch-style network token, and egress.js keeps to its rules.
 *   4. The test seam is named nowhere else under src/ or bin/.
 *   5. Every test that uses egress goes through test/helpers/net-stubs.js and installs the loopback
 *      guard, so no test can reach anything but this computer.
 *
 * Every regex here has a positive control. Tests that pass before the module exists and so prove
 * nothing about it: none of the pins below are vacuous without it, because each requires the
 * module's files to exist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installLoopbackGuard } = require('./helpers/net-stubs');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const ROOT = path.join(__dirname, '..');
const NET_DIR = path.join(ROOT, 'src', 'net');
const HELPER_REL = 'test/helpers/net-stubs.js';

const NETWORK_NAMES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns'];
const EXPECTED_NETWORK_FILES = ['src/net/egress.js', 'src/serve/server.js'];

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

// Copied literally from test/generator-module-graph.test.js (NETWORK_TOKEN_RE).
const NETWORK_TOKEN_RE =
  /\bfetch\w*\s*\(|\b(?:globalThis|global|window)\s*\.\s*fetch\b|\bfetch(?:Fn|Impl)\b|\b(?:WebSocket|EventSource|XMLHttpRequest)\b|require\(\s*(['"])undici\1\s*\)/;

const NAMES_ALT = NETWORK_NAMES.join('|');
// (a) raw source: a require of any network builtin, ', " or `, node: optional.
const RAW_RE = new RegExp(`\\brequire\\(\\s*(['"\`])(?:node:)?(?:${NAMES_ALT})\\1`);
// (b) comment-stripped: require, dynamic import, from, static import.
const ANY_RE = new RegExp(`(?:\\brequire\\(\\s*|\\bimport\\(\\s*|\\bfrom\\s*|\\bimport\\s*)(['"\`])(?:node:)?(?:${NAMES_ALT})\\1`);

function scanNetwork(srcRoot, root) {
  const files = listJs(srcRoot);
  const hits = files
    .filter((f) => {
      const raw = fs.readFileSync(f, 'utf8');
      return RAW_RE.test(raw) || ANY_RE.test(stripCommentsSafe(raw));
    })
    .map((f) => rel(root, f));
  return { files, hits };
}

function specifiers(source) {
  const stripped = stripCommentsSafe(source);
  return [...stripped.matchAll(/\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g)].map((m) => m[2]).sort();
}

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

// --- AC-01 ------------------------------------------------------------------------------------------

test('network modules: the files under src/ that load one are exactly the listener and egress', () => {
  const { files, hits } = scanNetwork(path.join(ROOT, 'src'), ROOT);
  assert.ok(files.length >= 100, `expected at least 100 source files, scanned ${files.length}`);
  assert.deepEqual(hits, EXPECTED_NETWORK_FILES);
});

test('network modules: positive control, a scratch tree with every form is detected and comments are not', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-net-ctl-'));
  try {
    const dir = path.join(scratch, 'src', 'x');
    fs.mkdirSync(dir, { recursive: true });
    const forms = [
      "const a = require('http');",
      'const b = require("node:https");',
      'const c = require(`net`);',
      "const d = import('tls');",
      "import { lookup } from 'node:dns';",
      "import dgram from 'dgram';",
      "const e = require('http2');",
    ];
    forms.forEach((src, i) => fs.writeFileSync(path.join(dir, `planted${i}.js`), src + '\n'));
    fs.writeFileSync(path.join(dir, 'doc.js'), "/** @type {import('http').Server} */\n// import('net')\nconst ok = 1;\n");
    fs.writeFileSync(path.join(dir, 'fine.js'), "const x = require('./y');\nconst p = require('path');\n");
    const { hits } = scanNetwork(path.join(scratch, 'src'), scratch);
    assert.deepEqual(hits, forms.map((_, i) => `src/x/planted${i}.js`));
    const doc = fs.readFileSync(path.join(dir, 'doc.js'), 'utf8');
    assert.ok(!RAW_RE.test(doc));
    assert.ok(!ANY_RE.test(stripCommentsSafe(doc)));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

const SPEC_LISTS = {
  'egress.js': ['./errors', 'http', 'https'],
  'sse.js': ['./errors'],
  'ndjson.js': ['./errors'],
  'errors.js': ['../util/errors'],
};

test('src/net: each file requires exactly its expected modules (comments stripped)', () => {
  for (const [name, expected] of Object.entries(SPEC_LISTS)) {
    const source = fs.readFileSync(path.join(NET_DIR, name), 'utf8');
    assert.deepEqual(specifiers(source), expected, name);
    const stripped = stripCommentsSafe(source);
    assert.ok(!/\bimport\s*\(|\bfrom\s*['"`]|^\s*import\s/m.test(stripped), `${name} uses require only`);
  }
});

// --- AC-04 ------------------------------------------------------------------------------------------

test('src/net is made of leaves: nothing resolves outside it except the shared errors file', () => {
  const files = listJs(NET_DIR);
  assert.ok(files.length >= 4, `src/net should hold at least 4 files, found ${files.length}`);
  for (const f of files) {
    const source = fs.readFileSync(f, 'utf8');
    assert.deepEqual(nonLiteralCalls(source), [], `${rel(ROOT, f)} has a non-literal require or import`);
    for (const spec of specifiers(source)) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(f), spec);
      const inside = resolved === NET_DIR || resolved.startsWith(NET_DIR + path.sep);
      const errors = resolved === path.join(ROOT, 'src', 'util', 'errors');
      assert.ok(inside || errors, `${rel(ROOT, f)} requires ${spec}, which leaves src/net`);
    }
  }
});

test('src/net leaf rule: positive control for the non-literal and outside-path detectors', () => {
  assert.equal(nonLiteralCalls('const z = require(name);').length, 1);
  assert.equal(nonLiteralCalls('const z = import(`x${y}`);').length, 1);
  assert.equal(nonLiteralCalls("const z = require('./y'); // require(name)").length, 0);
  assert.deepEqual(specifiers("const a = require('../vault/read'); const b = require(\"fs\");"), ['../vault/read', 'fs']);
});

// --- AC-03 ------------------------------------------------------------------------------------------

test('src/net: the fetch-style token pattern matches no raw source, comments included', () => {
  const files = listJs(NET_DIR);
  assert.ok(files.length >= 4);
  for (const f of files) {
    assert.ok(!NETWORK_TOKEN_RE.test(fs.readFileSync(f, 'utf8')), `${rel(ROOT, f)} matches a network token`);
  }
});

test('src/net: positive control, every token form is matched by the copied pattern', () => {
  const planted = [
    'fetch(url)', 'globalThis.fetch', 'const fetchImpl = 1;', 'new WebSocket(u)', 'new EventSource(u)',
    'new XMLHttpRequest()', "require('undici')",
  ];
  for (const p of planted) assert.match(p, NETWORK_TOKEN_RE, p);
  assert.ok(!NETWORK_TOKEN_RE.test('const prefetched = 1; // nothing here'));
});

// --- egress.js source rules -------------------------------------------------------------------------

const EGRESS_STRIPPED = stripCommentsSafe(fs.readFileSync(path.join(NET_DIR, 'egress.js'), 'utf8'));

const FORBIDDEN_IN_EGRESS = [
  ['process.env', /\bprocess\s*\.\s*env\b/, 'const e = process.env.HTTP_PROXY;'],
  ['globalAgent', /\bglobalAgent\b/, 'agent: http.globalAgent'],
  ['console.', /\bconsole\s*\./, 'console.log(1);'],
  ['process.stdout', /\bprocess\s*\.\s*stdout\b/, 'process.stdout.write("x");'],
  ['process.stderr', /\bprocess\s*\.\s*stderr\b/, 'process.stderr.write("x");'],
  ['setInterval', /\bsetInterval\b/, 'setInterval(f, 1);'],
  ['cause', /\bcause\b/, 'new Error("x", { cause: e });'],
  ['socketPath', /\bsocketPath\b/, 'opts.socketPath = "/x";'],
  ['location header', /\.location\b|\[\s*['"]location['"]\s*\]/i, "res.headers['location']"],
  ['location property', /\.location\b|\[\s*['"]location['"]\s*\]/i, 'res.headers.location'],
  ['rejectUnauthorized other than true', /\brejectUnauthorized\s*[:=](?!\s*true\b)/, 'rejectUnauthorized: false'],
  ['rejectUnauthorized assigned', /\brejectUnauthorized\s*[:=](?!\s*true\b)/, 'o.rejectUnauthorized = flag;'],
];

test('egress.js source: none of the forbidden constructs appear (comments stripped)', () => {
  for (const [label, re] of FORBIDDEN_IN_EGRESS) {
    assert.ok(!re.test(EGRESS_STRIPPED), `src/net/egress.js must not contain ${label}`);
  }
  assert.match(EGRESS_STRIPPED, /rejectUnauthorized: true/);
});

test('egress.js source: positive control, every forbidden regex matches a planted line', () => {
  for (const [label, re, planted] of FORBIDDEN_IN_EGRESS) assert.match(planted, re, label);
  assert.ok(!/\bcause\b/.test('because it is'));
  assert.ok(!FORBIDDEN_IN_EGRESS[10][1].test('rejectUnauthorized: true,'));
});

test('no file under src/net writes to the console or a standard stream', () => {
  for (const f of listJs(NET_DIR)) {
    const stripped = stripCommentsSafe(fs.readFileSync(f, 'utf8'));
    for (const [label, re] of FORBIDDEN_IN_EGRESS.filter(([l]) => ['console.', 'process.stdout', 'process.stderr', 'process.env'].includes(l))) {
      assert.ok(!re.test(stripped), `${rel(ROOT, f)} must not contain ${label}`);
    }
  }
});

test('egress.js source: every timer is unref-ed so none can hold the process open', () => {
  const timers = EGRESS_STRIPPED.match(/\bsetTimeout\(/g) || [];
  const unrefs = EGRESS_STRIPPED.match(/\.unref\(\)/g) || [];
  assert.ok(timers.length >= 1, 'the connect, idle and total timers exist');
  assert.ok(unrefs.length >= timers.length, `${timers.length} timers but ${unrefs.length} unref calls`);
  const planted = 'const t = setTimeout(f, 1); t.unref(); setTimeout(g, 2);';
  assert.ok((planted.match(/\bsetTimeout\(/g) || []).length > (planted.match(/\.unref\(\)/g) || []).length);
});

// --- the seam -----------------------------------------------------------------------------------------

function seamNamers(root) {
  const out = [];
  for (const dir of ['src', 'bin']) {
    for (const f of listJs(path.join(root, dir))) {
      if (fs.readFileSync(f, 'utf8').includes('createEgressForTests')) out.push(rel(root, f));
    }
  }
  return out;
}

test('the test seam is named in no file under src/ or bin/ except egress.js', () => {
  assert.deepEqual(seamNamers(ROOT), ['src/net/egress.js']);
});

test('the test seam: positive control on a scratch tree', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-seam-ctl-'));
  try {
    fs.mkdirSync(path.join(scratch, 'src', 'a'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'src', 'a', 'x.js'), 'const { createEgressForTests } = require("./egress");\n');
    fs.writeFileSync(path.join(scratch, 'bin', 'y.js'), '// createEgressForTests\n');
    fs.writeFileSync(path.join(scratch, 'src', 'a', 'clean.js'), 'module.exports = {};\n');
    assert.deepEqual(seamNamers(scratch).sort(), ['bin/y.js', 'src/a/x.js']);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// --- the loopback rule for test files ---------------------------------------------------------------

const REQUIRE_EGRESS = /require\(\s*(['"`])[^'"`]*\bnet\/egress(?:\.js)?\1\s*\)/;
const REQUIRE_HELPER = /require\(\s*(['"`])[^'"`]*\bhelpers\/net-stubs(?:\.js)?\1\s*\)|require\(\s*(['"`])\.\/net-stubs(?:\.js)?\2\s*\)/;

/** @returns {string[]} problems found in one test file's source */
function checkTestFile(source) {
  const stripped = stripCommentsSafe(source);
  if (!REQUIRE_EGRESS.test(stripped)) return [];
  const problems = [];
  if (!REQUIRE_HELPER.test(stripped)) problems.push('requires egress without requiring helpers/net-stubs');
  if (!/\binstallLoopbackGuard\(/.test(stripped)) problems.push('never calls installLoopbackGuard(');
  return problems;
}

test('loopback rule: every test file that uses egress goes through the helper and installs the guard', () => {
  const using = [];
  const problems = [];
  for (const f of listJs(path.join(ROOT, 'test'))) {
    const r = rel(ROOT, f);
    if (r === HELPER_REL) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (REQUIRE_EGRESS.test(stripCommentsSafe(src))) using.push(r);
    for (const p of checkTestFile(src)) problems.push(`${r}: ${p}`);
  }
  assert.deepEqual(problems, []);
  for (const expected of ['test/helpers/net-env-probe.js', 'test/net-egress.test.js']) {
    assert.ok(using.includes(expected), `${expected} should be among the files that use egress`);
  }
});

test('loopback rule: the helper itself does not require src/net', () => {
  const src = stripCommentsSafe(fs.readFileSync(path.join(ROOT, HELPER_REL), 'utf8'));
  assert.ok(!/require\(\s*(['"`])[^'"`]*src\/net|require\(\s*(['"`])\.\.\/\.\.\/src\/net/.test(src));
});

test('loopback rule: positive controls for every check', () => {
  const REQ = (p) => ['require', "('", p, "')"].join('');
  const good = `const e = ${REQ('../src/net/egress')};\nconst h = ${REQ('./helpers/net-stubs')};\nh.installLoopbackGuard();\n`;
  assert.deepEqual(checkTestFile(good), []);
  assert.ok(checkTestFile(`const e = ${REQ('../src/net/egress')};\nx.installLoopbackGuard();\n`).some((p) => /without requiring/.test(p)));
  assert.ok(checkTestFile(`const e = ${REQ('../src/net/egress')};\nconst h = ${REQ('./helpers/net-stubs')};\n`).some((p) => /never calls/.test(p)));
  assert.deepEqual(checkTestFile(`// ${REQ('../src/net/egress')}\n`), []);
  assert.deepEqual(checkTestFile(`const h = ${REQ('./helpers/net-stubs')};\n`), []);
  // From inside test/helpers the sibling form is accepted.
  assert.deepEqual(checkTestFile(`const e = ${REQ('../../src/net/egress')};\nconst h = ${REQ('./net-stubs')};\ninstallLoopbackGuard();\n`), []);
});
