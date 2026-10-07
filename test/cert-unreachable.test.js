'use strict';

/*
 * The certificate modules are not reachable from the command line yet. This walks the literal
 * require()/import() graph from bin/scriptorium.js (the same method as
 * test/generator-module-graph.test.js) and asserts nothing under src/cert is in it. It also
 * walks a scratch graph with a planted require, so a walker that reaches nothing cannot pass.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'scriptorium.js');
const CERT_DIR = path.join(ROOT, 'src', 'cert') + path.sep;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractSpecs(source) {
  const specs = [];
  const text = stripComments(source);
  const re = /(?:require|import)\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  while ((m = re.exec(text))) specs.push(m[2]);
  return specs;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return base;
}

function walk(entry) {
  const files = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!file.endsWith('.js') || !fs.existsSync(file)) continue;
    for (const spec of extractSpecs(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        queue.push(resolveRelative(file, spec));
      } else if (!spec.startsWith('node:')) {
        try {
          queue.push(require.resolve(spec, { paths: [path.dirname(file)] }));
        } catch (_) {
          /* a builtin or an unresolvable name: nothing to follow */
        }
      }
    }
  }
  return files;
}

test('positive control: the walk from bin/scriptorium.js is not empty and reaches src/serve/server.js', () => {
  const files = walk(ENTRY);
  assert.ok(files.size > 50, `walk reached only ${files.size} files`);
  assert.ok(files.has(path.join(ROOT, 'src', 'serve', 'server.js')));
});

test('nothing under src/cert is reachable from bin/scriptorium.js', () => {
  const reached = [...walk(ENTRY)].filter((f) => f.startsWith(CERT_DIR));
  assert.deepEqual(reached, []);
});

test('positive control: the walker finds a planted require of src/cert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-unreachable-'));
  try {
    const entry = path.join(dir, 'entry.js');
    fs.writeFileSync(entry, `require(${JSON.stringify(path.join(ROOT, 'src', 'cert', 'der'))});\n`);
    const reached = [...walk(entry)].filter((f) => f.startsWith(CERT_DIR));
    assert.deepEqual(reached.map((f) => path.basename(f)), ['der.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
