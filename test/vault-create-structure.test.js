'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Structural pins for the new-vault writer (docs/decisions/0048-new-campaign-vault.md, section 2),
 * in the family of PW14 in test/pack-write.test.js. Every scan has a positive control that proves
 * it can fail. The stated limits: these read the source text, so they prove the shape of the file,
 * not the behaviour (test/vault-create.test.js proves that).
 */

const ROOT = path.join(__dirname, '..');
const WRITER = path.join(ROOT, 'src', 'vault', 'vaultcreate.js');
const TEMPLATE = path.join(ROOT, 'src', 'setup', 'template.js');

function strip(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN = ['rmSync', 'rm(', 'rmdir', 'unlink', 'rename', 'copyFile', 'appendFile', 'truncate', 'chmod', 'createWriteStream', 'writeFile(', 'recursive'];

function forbiddenIn(source) {
  return FORBIDDEN.filter((token) => strip(source).includes(token));
}

function writeFlagMismatch(source) {
  const s = strip(source);
  return { writes: (s.match(/writeFileSync\(/g) || []).length, wx: (s.match(/flag: 'wx'/g) || []).length };
}

function mkdirWithOptions(source) {
  return strip(source).match(/mkdirSync\([^)]*,/g) || [];
}

function specsOf(source) {
  const out = [];
  const re = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  const s = strip(source);
  while ((m = re.exec(s))) out.push(m[2]);
  return out.sort();
}

const NETWORK_OR_PROCESS = /(?:\brequire\(\s*)(['"`])(?:node:)?(?:child_process|net|http|https|http2|dgram|dns|tls|cluster|worker_threads)\1|\bfetch\(/;

const writer = fs.readFileSync(WRITER, 'utf8');

test('the writer names no delete, rename, append, truncate, chmod, stream, async write or recursive option', () => {
  assert.deepEqual(forbiddenIn(writer), []);
});

test('every writeFileSync in the writer carries flag: wx, and there is at least one', () => {
  const { writes, wx } = writeFlagMismatch(writer);
  assert.ok(writes >= 1);
  assert.equal(writes, wx);
});

test('no mkdirSync in the writer is given an options argument', () => {
  assert.deepEqual(mkdirWithOptions(writer), []);
});

test('the writer requires exactly fs, path, the error classes and the exclusions module', () => {
  assert.deepEqual(specsOf(writer), ['../util/errors', './exclusions', 'fs', 'path']);
});

test('neither new module names child_process or a network builtin', () => {
  for (const file of [WRITER, TEMPLATE]) {
    assert.equal(NETWORK_OR_PROCESS.test(strip(fs.readFileSync(file, 'utf8'))), false, path.relative(ROOT, file));
  }
});

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

test('createVault is named only in the writer, the setup commit and init, across src and bin', () => {
  const files = [...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'bin'))];
  assert.ok(files.length >= 100);
  const users = files.filter((f) => /\bcreateVault\b/.test(strip(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  assert.deepEqual(users, ['src/cli/init.js', 'src/setup/register.js', 'src/vault/vaultcreate.js']);
});

// --- positive controls ---------------------------------------------------------------------------------

test('positive controls: each scan detects what it is meant to detect', () => {
  assert.deepEqual(forbiddenIn("fs.rmSync(p); fs.renameSync(a, b); fs.mkdirSync(p, { recursive: true });"), ['rmSync', 'rename', 'recursive']);
  assert.deepEqual(forbiddenIn("// rmSync is never used here\nconst x = 1;"), []);
  assert.deepEqual(writeFlagMismatch("fs.writeFileSync(a, b, { flag: 'wx' }); fs.writeFileSync(c, d);"), { writes: 2, wx: 1 });
  assert.equal(mkdirWithOptions("fs.mkdirSync(p, { recursive: true });").length, 1);
  assert.equal(mkdirWithOptions("fs.mkdirSync(p);").length, 0);
  assert.deepEqual(specsOf("const a = require('fs'); const b = require(\"../x\");"), ['../x', 'fs']);
  assert.equal(NETWORK_OR_PROCESS.test("require('node:child_process')"), true);
  assert.equal(NETWORK_OR_PROCESS.test("require('net')"), true);
  assert.equal(NETWORK_OR_PROCESS.test("fetch('x')"), true);
  assert.equal(NETWORK_OR_PROCESS.test("require('path')"), false);
});

test('positive control: a scratch file naming createVault is found by the same filter, a comment-only mention is not', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'named.js'), 'const { createVault } = require("x"); createVault();\n');
  fs.writeFileSync(path.join(dir, 'comment.js'), '// createVault is not used here\n/* createVault */\nmodule.exports = 1;\n');
  const hits = listJs(dir).filter((f) => /\bcreateVault\b/.test(strip(fs.readFileSync(f, 'utf8')))).map((f) => path.basename(f));
  assert.deepEqual(hits, ['named.js']);
});
