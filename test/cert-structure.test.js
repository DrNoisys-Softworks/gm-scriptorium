'use strict';

/*
 * Structural pins for src/cert: crypto only, no dependency, no
 * network builtin, one key export. Raw-source scans, with a positive control that the
 * scanner really catches a planted require.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CERT_DIR = path.join(ROOT, 'src', 'cert');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Every require()/import() call, with literal or non-literal argument.
function requireCalls(source) {
  const out = [];
  const re = /\b(?:require|import)\(\s*([^)]*?)\s*\)/g;
  const text = stripComments(source);
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

const ALLOWED = new Set(["'node:crypto'", "'../util/errors'", "'./der'", "'./generate'", "'./inspect'"]);

function violations(source) {
  return requireCalls(source).filter((arg) => !ALLOWED.has(arg));
}

const files = fs.readdirSync(CERT_DIR).filter((f) => f.endsWith('.js')).sort();

test('src/cert holds exactly the three modules', () => {
  assert.deepEqual(files, ['der.js', 'generate.js', 'inspect.js']);
});

test('src/cert requires only node:crypto, ../util/errors and its own files', () => {
  for (const f of files) {
    const src = fs.readFileSync(path.join(CERT_DIR, f), 'utf8');
    assert.deepEqual(violations(src), [], f);
  }
});

test('no network builtin is named anywhere in src/cert, even as a string', () => {
  for (const f of files) {
    const src = stripComments(fs.readFileSync(path.join(CERT_DIR, f), 'utf8'));
    assert.equal(/['"`](?:node:)?(?:tls|net|http|https|http2|dgram|dns|child_process)['"`]/.test(src), false, f);
  }
});

test('positive control: the scanner catches a planted network require and a non-literal require', () => {
  assert.deepEqual(violations("const net = require('net');"), ["'net'"]);
  assert.deepEqual(violations("const t = require(\"node:tls\");"), ['"node:tls"']);
  assert.deepEqual(violations('const x = require(name);'), ['name']);
  assert.deepEqual(violations("const y = require('../remote/tls');"), ["'../remote/tls'"]);
  assert.deepEqual(violations("const ok = require('node:crypto');"), []);
});

test('generate.js exports exactly one private key: the leaf, as PKCS#8', () => {
  const src = stripComments(fs.readFileSync(path.join(CERT_DIR, 'generate.js'), 'utf8'));
  const exports_ = src.match(/\.export\(/g) || [];
  const privateExports = src.match(/privateKey\.export\(/g) || [];
  assert.equal(privateExports.length, 1);
  assert.match(src, /leafKeys\.privateKey\.export\(\{ type: 'pkcs8', format: 'pem' \}\)/);
  assert.equal(/trustKeys\.privateKey\.export/.test(src), false);
  assert.ok(exports_.length >= 3);
  // the trust key is only ever passed as a signingKey
  const uses = src.match(/trustKeys\.privateKey/g) || [];
  assert.equal(uses.length, 2);
  assert.equal((src.match(/signingKey: trustKeys\.privateKey/g) || []).length, 2);
});

test('no runtime dependency was added for certificates', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['gm-apprentice-publish', 'gray-matter', 'smol-toml']);
});
