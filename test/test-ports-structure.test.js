'use strict';

/*
 * Structural pin for fixed test ports (issue #91).
 *
 *   1. In a test file that can bind a socket, every port literal comes from testPort(<literal>)
 *      in test/helpers/ports.js, so one variable (SCRIPTORIUM_TEST_PORT_BASE) moves them all.
 *   2. Every testPort( argument is an integer literal (no arithmetic, no variables).
 *   3. No two test files pass the same number to testPort( (so a duplicate bind can never return).
 *   4. The old per-file overrides (X_TEST_PORT, BASE_PORT) are gone.
 *   5. ALLOWED lists the values that never reach a real socket; a stale row fails.
 *
 * Every regex has a planted positive control and a negative control, in a scratch tree.
 * The comment stripper is copied from test/proc-structure.test.js; never required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SELF = 'test/test-ports-structure.test.js';
const HELPER = 'test/helpers/ports.js';
// The helper's own unit test passes a second (env) argument to testPort(, so rule 2 cannot apply to it.
const HELPER_UNIT = 'test/test-ports.test.js';

// [file, port, reason]. A row is only for a value that never reaches a real socket.
const ALLOWED = Object.freeze([
  ['test/admin-cli.test.js', 40001, 'fake listener; nothing is bound'],
  ['test/admin-cli.test.js', 40002, 'fake listener; nothing is bound'],
  ['test/admin-framing.test.js', 4099, 'a Content-Security-Policy string built by a pure function'],
  ['test/admin-framing.test.js', 4100, 'a Content-Security-Policy string built by a pure function'],
  ['test/admin-framing.test.js', 4101, 'a Content-Security-Policy string built by a pure function'],
  ['test/gm-link.test.js', 4321, 'a fake context value for a pure link builder'],
  ['test/helpers/net-stubs.js', 1234, 'ports the egress guard must refuse; never bound'],
  ['test/helpers/net-stubs.js', 11434, 'ports the egress guard must refuse; never bound'],
  ['test/launch-console.test.js', 7400, 'console text from pure functions; nothing is bound'],
  ['test/launch-console.test.js', 7401, 'console text from pure functions; nothing is bound'],
  ['test/launch-console.test.js', 7924, 'console text from pure functions; nothing is bound'],
  ['test/launch-console.test.js', 7925, 'console text from pure functions; nothing is bound'],
  ['test/launch-console.test.js', 7926, 'console text from pure functions; nothing is bound'],
  ['test/launch-console.test.js', 7927, 'console text from pure functions; nothing is bound'],
  ['test/remote-cli.test.js', 7400, 'refused before any bind (bad flag, unknown key, equal ports)'],
  ['test/remote-cli.test.js', 7930, 'refused before any bind (bad flag, unknown key, equal ports)'],
  ['test/remote-cli.test.js', 9300, 'refused before any bind (bad flag, unknown key, equal ports)'],
  ['test/remote-listener.test.js', 7400, 'invalid input that is refused'],
  ['test/remote-serve-admin.test.js', 7922, 'fake listeners; no socket is opened'],
  ['test/remote-serve-admin.test.js', 7923, 'fake listeners; no socket is opened'],
  ['test/remote-serve-admin.test.js', 9100, 'fake listeners; no socket is opened'],
  ['test/remote-serve-admin.test.js', 9200, 'fake listeners; no socket is opened'],
  ['test/remote-serve-admin.test.js', 9300, 'fake listeners; no socket is opened'],
  ['test/remote-serve-admin.test.js', 9400, 'fake listeners; no socket is opened'],
  ['test/remote-serve-admin.test.js', 50001, 'fake listeners; no socket is opened'],
  ['test/remote-serve-admin.test.js', 50002, 'fake listeners; no socket is opened'],
  ['test/serve-port.test.js', 8217, 'a fake server that only reports a port'],
  ['test/setup-mode-http.test.js', 7924, 'saved settings the test proves are never bound'],
  ['test/setup-mode-http.test.js', 7925, 'saved settings the test proves are never bound'],
  ['test/setup-mode-http.test.js', 7926, 'saved settings the test proves are never bound'],
  ['test/setup-mode-http.test.js', 7927, 'saved settings the test proves are never bound'],
  ['test/setup-mode-http.test.js', 7928, 'saved settings the test proves are never bound'],
  ['test/setup-mode-http.test.js', 7929, 'saved settings the test proves are never bound'],
  ['test/setup-mode-http.test.js', 7930, 'saved settings the test proves are never bound'],
  ['test/setup-mode-http.test.js', 7931, 'saved settings the test proves are never bound'],
]);

function stripCommentsSafe(source) {
  return source.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m) => (m.startsWith('//') || m.startsWith('/*') ? '' : m),
  );
}

const BIND_RE = /\.listen\(|\bstart(?:AdminPanel|AdminServer|LocalListener|PanelListener|Server)\(|\brunServeCommand\(|\brunLaunch\(|\[\s*['"]serve['"]/;

// Each entry: [label, regex with the 'g' flag, mode]. mode 'one' = group 1 is a port; 'many' = every
// 4 or 5 digit number inside group 1 is a port.
const PORT_RES = [
  ['listen(', /\.listen\(\s*(\d+)/g, 'one'],
  ['--port flag', /['"]--(?:preview-)?port['"]\s*,\s*['"](\d+)['"]/g, 'one'],
  ['port key', /\b\w*(?:port|Port|PORT)\w*\s*[:=]\s*['"]?(\d+)/g, 'one'],
  ['PORT constant', /\b[A-Z0-9_]*PORT[A-Z0-9_]*\s*=\s*([^;\n]+)/g, 'many'],
  ['host:port', /(?:127\.0\.0\.\d{1,3}|localhost):(\d{4,5})\b/g, 'one'],
  ['helper call', /\b(?:withServer|connect|canConnect|panelRequest|post|request)\(\s*(?:t\s*,\s*)?(\d{4,5})\b/g, 'one'],
];

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(full));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function portHits(stripped) {
  const hits = [];
  for (const [label, re, mode] of PORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped))) {
      const nums = mode === 'one' ? [m[1]] : m[1].match(/\b\d{4,5}\b/g) || [];
      for (const n of nums) {
        const port = Number(n);
        if (port >= 1024 && port <= 65535) hits.push({ port, via: label });
      }
    }
  }
  return hits;
}

// Scan root/test. Returns every finding, by rule, plus the per-file testPort arguments.
function scan(root, allowed = ALLOWED) {
  const files = listJs(path.join(root, 'test'))
    .map((f) => ({ full: f, name: rel(root, f) }))
    .filter((f) => !f.name.startsWith('test/fixtures/') && f.name !== SELF && f.name !== HELPER && f.name !== HELPER_UNIT);
  const result = { files: files.length, offenders: [], badArgs: [], duplicates: [], oldStyle: [], stale: [], args: {} };
  const seen = new Set();
  for (const { full, name } of files) {
    const stripped = stripCommentsSafe(fs.readFileSync(full, 'utf8'));
    // Rule 2 and the per-file argument sets.
    const args = [];
    const callRe = /\btestPort\(([^)]*)\)/g;
    let m;
    while ((m = callRe.exec(stripped))) {
      const arg = m[1].trim();
      if (/^\d+$/.test(arg)) args.push(Number(arg));
      else result.badArgs.push({ file: name, arg });
    }
    if (args.length) result.args[name] = [...new Set(args)].sort((a, b) => a - b);
    // Rule 4.
    for (const re of [/process\.env\.[A-Z0-9_]*_TEST_PORT\b/, /\bBASE_PORT\b/]) {
      if (re.test(stripped)) result.oldStyle.push({ file: name, pattern: String(re) });
    }
    // Rule 1: only in files that can bind, with testPort( calls blanked out first.
    if (!BIND_RE.test(stripped)) continue;
    const blanked = stripped.replace(/\btestPort\([^)]*\)/g, 'TP');
    const found = new Set();
    for (const h of portHits(blanked)) {
      const key = `${name}\u0000${h.port}`;
      seen.add(key);
      if (found.has(key)) continue;
      found.add(key);
      if (!allowed.some(([f, p]) => f === name && p === h.port)) result.offenders.push({ file: name, port: h.port, via: h.via });
    }
  }
  // Rule 3.
  const owner = new Map();
  for (const [file, ports] of Object.entries(result.args)) {
    for (const p of ports) {
      if (owner.has(p)) result.duplicates.push({ port: p, files: [owner.get(p), file] });
      else owner.set(p, file);
    }
  }
  // Rule 5.
  for (const [file, port] of allowed) {
    if (!seen.has(`${file}\u0000${port}`)) result.stale.push({ file, port });
  }
  return result;
}

function plant(files, allowed = []) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-ports-ctl-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      const full = path.join(scratch, 'test', name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    }
    return scan(scratch, allowed);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- The real tree ----

const REAL = scan(ROOT);

test('fixed ports: the scan covers the whole test tree', () => {
  assert.ok(REAL.files >= 300, `expected at least 300 test files, scanned ${REAL.files}`);
  assert.ok(Object.keys(REAL.args).length >= 20, 'expected testPort( in at least 20 files');
});

test('fixed ports: rule 1, no fixed port outside testPort() in a file that can bind', () => {
  const lines = REAL.offenders.map((o) => `${o.file} ${o.port} (${o.via})`);
  const files = new Set(REAL.offenders.map((o) => o.file));
  assert.deepEqual(lines, [], `${lines.length} offenders across ${files.size} files`);
});

test('fixed ports: rule 2, every testPort( argument is an integer literal', () => {
  assert.deepEqual(REAL.badArgs, []);
});

test('fixed ports: rule 3, no two files pass the same number to testPort(', () => {
  assert.deepEqual(REAL.duplicates, []);
});

test('fixed ports: rule 4, the old per-file overrides are gone', () => {
  assert.deepEqual(REAL.oldStyle, []);
});

test('fixed ports: rule 5, every allow row still occurs', () => {
  assert.deepEqual(REAL.stale, []);
});

// ---- Planted controls: one red per check ----

test('control: a planted .listen(7999) is an offender', () => {
  const r = plant({ 'a.test.js': "const net = require('net');\nnet.createServer().listen(7999, '127.0.0.1');\n" });
  assert.deepEqual(r.offenders.map((o) => o.port), [7999]);
});

test('control: a planted serve --port 8123 is an offender', () => {
  const r = plant({ 'a.test.js': "run(['serve', '--port', '8123']);\n" });
  assert.deepEqual(r.offenders.map((o) => o.port), [8123]);
});

test('control: a planted TOML port = 7950 in a file with startAdminPanel( is an offender', () => {
  const r = plant({ 'a.test.js': 'startAdminPanel(x);\nconst toml = `[remote]\nport = 7950\n`;\n' });
  assert.deepEqual(r.offenders.map((o) => o.port), [7950]);
});

test('control: a planted PORT constant with a test override hits rules 1 and 4', () => {
  const r = plant({ 'a.test.js': "startAdminPanel(x);\nconst PORT = Number(process.env.X_TEST_PORT || 9001);\n" });
  assert.deepEqual(r.offenders.map((o) => o.port), [9001]);
  assert.equal(r.oldStyle.length, 1);
});

test('control: a planted BASE_PORT is a rule 4 hit', () => {
  const r = plant({ 'a.test.js': 'const x = BASE_PORT + 1;\n' });
  assert.equal(r.oldStyle.length, 1);
});

test('control: a planted http://127.0.0.1:8555/ in a bind file is an offender', () => {
  const r = plant({ 'a.test.js': "startAdminPanel(x);\nconst u = 'http://127.0.0.1:8555/';\n" });
  assert.deepEqual(r.offenders.map((o) => o.port), [8555]);
});

test('control: a planted request( with a literal port is an offender', () => {
  const r = plant({ 'a.test.js': 'startAdminPanel(x);\nawait panelRequest(t, 8666, "/");\n' });
  assert.deepEqual(r.offenders.map((o) => o.port), [8666]);
});

test('control: the same testPort(7001) in two files is a rule 3 hit', () => {
  const r = plant({ 'a.test.js': 'const a = testPort(7001);\n', 'b.test.js': 'const b = testPort(7001);\n' });
  assert.deepEqual(r.duplicates, [{ port: 7001, files: ['test/a.test.js', 'test/b.test.js'] }]);
});

test('control: testPort(x) is a rule 2 hit', () => {
  const r = plant({ 'a.test.js': 'const a = testPort(x);\n' });
  assert.deepEqual(r.badArgs, [{ file: 'test/a.test.js', arg: 'x' }]);
});

test('control: an allow row suppresses its offender, and a stale row is reported', () => {
  const files = { 'a.test.js': "startAdminPanel(x);\nconst u = 'http://127.0.0.1:8555/';\n" };
  const ok = plant(files, [['test/a.test.js', 8555, 'text only']]);
  assert.deepEqual(ok.offenders, []);
  assert.deepEqual(ok.stale, []);
  const stale = plant(files, [['test/a.test.js', 8556, 'gone']]);
  assert.deepEqual(stale.stale, [{ file: 'test/a.test.js', port: 8556 }]);
});

// ---- Negative controls ----

test('control: listen(0, a commented listen, a pure file and testPort(7920) are all clean', () => {
  const r = plant({
    'a.test.js': "net.createServer().listen(0, '127.0.0.1');\n// server.listen(7999)\n/* listen(7998) */\nconst p = testPort(7920);\nserver.listen(p);\n",
    'b.test.js': 'const cfg = { port: 7400 };\n',
  });
  assert.deepEqual(r.offenders, []);
  assert.deepEqual(r.badArgs, []);
  assert.deepEqual(r.duplicates, []);
  assert.deepEqual(r.oldStyle, []);
});

test('control: the fixtures folder, the helper, its unit test and this file are not scanned', () => {
  const r = plant({
    'fixtures/x.js': 'server.listen(7999);\n',
    'helpers/ports.js': 'server.listen(7998);\n',
    'test-ports.test.js': 'testPort(7920, {});\n',
  });
  assert.equal(r.files, 0);
});
