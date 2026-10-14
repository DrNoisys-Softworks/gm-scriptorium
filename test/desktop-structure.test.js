'use strict';

/*
 * Structural pins for the desktop host (ADR 0057, "How they talk"). Under src/desktop there is no
 * network module, no spawner and no fetch-style call (the browser opener comes only through the one
 * spawner's openFile, which the launch structure test pins); nothing there writes to the process's
 * own output streams or builds a console line or a token-bearing address (so the protocol stream and
 * the log stay clean); and every test file that loads the host injects its own opener, so no test
 * can open a real browser. Every check has a positive control.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'src', 'desktop');

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

const NETWORK_NAMES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process'];
const LOADS_FORBIDDEN = new RegExp(`(?:\\brequire\\(\\s*|\\bimport\\(\\s*|\\bfrom\\s*|\\bimport\\s*)(['"\`])(?:node:)?(?:${NETWORK_NAMES.join('|')})(?:/[a-z]+)?\\1`);
const FETCH_CALL = /\bfetch\w*\(/;
const OWN_STREAMS = /\bprocess\s*\.\s*(?:stdout|stderr)\b|\bstartupText\(|\blaunchLines\(|\badminUrl\(/;

/** Problems in one source file under src/desktop. */
function networkProblems(source) {
  const stripped = stripCommentsSafe(source);
  const out = [];
  if (LOADS_FORBIDDEN.test(stripped)) out.push('loads a network builtin or child_process');
  if (FETCH_CALL.test(stripped)) out.push('calls a fetch-style function');
  return out;
}

function streamProblems(source) {
  return OWN_STREAMS.test(stripCommentsSafe(source)) ? ['names process.stdout/stderr, startupText(, launchLines( or adminUrl('] : [];
}

const FILES = listJs(DESKTOP);

// --- src/desktop has no network or spawner -----------------------------------------------------------------

// handoff.js is the terminal side (the one command-line hand-off to the tray helper); it prints a status to the
// terminal and starts the helper through the one spawner, so it is not held to the host's stream rule below.
const HOST_SIDE = FILES.filter((f) => rel(DESKTOP, f) !== 'handoff.js');

test('src/desktop holds the hand-off, host, log and protocol, and none loads a network builtin, child_process or a fetch-style call', () => {
  assert.deepEqual(FILES.map((f) => rel(DESKTOP, f)), ['handoff.js', 'host.js', 'log.js', 'protocol.js']);
  for (const f of FILES) assert.deepEqual(networkProblems(fs.readFileSync(f, 'utf8')), [], rel(ROOT, f));
});

test('positive control: the network scan catches each planted load and call, and ignores a comment', () => {
  for (const name of NETWORK_NAMES) {
    for (const quote of ["'", '"', '`']) {
      const load = ['const x = req', 'uire(', quote, name, quote, ');'].join('');
      assert.equal(networkProblems(load).length, 1, load);
      const withPrefix = ['const x = req', 'uire(', quote, 'node:', name, quote, ');'].join('');
      assert.equal(networkProblems(withPrefix).length, 1, withPrefix);
    }
  }
  assert.equal(networkProblems(['import h from ', "'node:", 'http', "';"].join('')).length, 1);
  assert.equal(networkProblems('const r = await fetch(url);').length, 1);
  assert.equal(networkProblems('const r = fetchJson(url);').length, 1);
  assert.deepEqual(networkProblems('// the helper never calls fetch( or loads net\nconst a = 1; /* child_process */'), []);
  assert.deepEqual(networkProblems("const p = require('path');\nconst fs = require('fs');"), []);
});

// --- the protocol stream and the log stay clean ---------------------------------------------------------------

test('nothing in the host side of src/desktop (host, log, protocol) names process.stdout, process.stderr, startupText(, launchLines( or adminUrl(', () => {
  assert.deepEqual(HOST_SIDE.map((f) => rel(DESKTOP, f)), ['host.js', 'log.js', 'protocol.js']);
  for (const f of HOST_SIDE) assert.deepEqual(streamProblems(fs.readFileSync(f, 'utf8')), [], rel(ROOT, f));
});

test('positive control: each of the five names is caught when planted, and a comment or an unrelated name is not', () => {
  for (const planted of ['process.stdout.write(x)', 'process . stderr . write(x)', 'startupText(a)', 'launchLines(a)', 'adminUrl(1, t)']) {
    assert.equal(streamProblems(planted).length, 1, planted);
  }
  assert.deepEqual(streamProblems('// process.stdout and adminUrl( are not allowed\nconst a = 1;'), []);
  assert.deepEqual(streamProblems('const adminUrlish = 1; const stdoutLike = 2; const w = output.write(line);'), []);
});

// --- no test can open a real browser through the host -------------------------------------------------------------

const HOST_LOAD = new RegExp(['require\\(\\s*([\'"`])[^\'"`]*\\bdesktop', '/host(?:\\.js)?\\1\\s*\\)'].join(''));

/** problems with one test file's use of the host */
function checkHostTestFile(source) {
  const stripped = stripCommentsSafe(source);
  if (!HOST_LOAD.test(stripped)) return [];
  return /\bopenFile\s*:/.test(stripped) ? [] : ['loads the desktop host without an injected openFile:'];
}

test('every test file that loads src/desktop/host injects openFile: so no test opens a real browser', () => {
  const loaders = [];
  const problems = [];
  for (const f of listJs(path.join(ROOT, 'test'))) {
    const src = fs.readFileSync(f, 'utf8');
    if (HOST_LOAD.test(stripCommentsSafe(src))) loaders.push(rel(ROOT, f));
    for (const p of checkHostTestFile(src)) problems.push(`${rel(ROOT, f)}: ${p}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(loaders.includes('test/desktop-host.test.js'), `the host test is among the loaders (${loaders.join(', ')})`);
});

test('positive control: the loader check flags a test that loads the host without an opener, and not one that injects it or one that does not load it', () => {
  const REQ = ['require', "('../src/desktop/ho", "st')"].join('');
  assert.deepEqual(checkHostTestFile(`const { runDesktopHost } = ${REQ};\nrunDesktopHost({}, { input, openFile: async () => ({}) });\n`), []);
  assert.equal(checkHostTestFile(`const { runDesktopHost } = ${REQ};\nrunDesktopHost({}, { input });\n`).length, 1);
  assert.equal(checkHostTestFile(`const { runDesktopHost } = ${REQ};\n// openFile: only in a comment\n`).length, 1);
  assert.deepEqual(checkHostTestFile("const log = require('../src/desktop/log');\n"), []);
});

test('positive control: a scratch tree with a planted network load is found by the same folder walk', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-desktop-ctl-'));
  try {
    fs.mkdirSync(path.join(scratch, 'desktop'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'desktop', 'sneaky.js'), `const h = ${['req', "uire('htt", "p')"].join('')};\n`);
    fs.writeFileSync(path.join(scratch, 'desktop', 'quiet.js'), "const p = require('path');\n");
    const bad = listJs(path.join(scratch, 'desktop')).filter((f) => networkProblems(fs.readFileSync(f, 'utf8')).length > 0).map((f) => rel(scratch, f));
    assert.deepEqual(bad, ['desktop/sneaky.js']);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
