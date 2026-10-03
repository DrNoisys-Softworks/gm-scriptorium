'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const { ADMIN_ASSET_ROUTES, ADMIN_ASSETS_DIR } = require('../src/admin/assets');

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-s1-engineering-brief-2026-09-28.md, "Test-first order"
 * item 6). Structural: source-text and HTML-text scans, plus a module-graph walk scoped to
 * src/cli/serve-admin.js (FR35, NFR05).
 */

const ROOT = path.join(__dirname, '..');

test('ADMIN_ASSET_ROUTES keys equal a literal list of 28 names (panel v2 V1b: 20 -> 23, diff/outcome/slip; V1e-3 SD-26: 23 -> 24, sitepane.js; V1e-9 SD-100: 24 -> 25, vaultcfg.js; V1e-7 SD-69: 25 -> 26, variants.js; V1.5a ADR 0029: 26 -> 28, signin.js and remote.js)', () => {
  assert.deepEqual(
    Object.keys(ADMIN_ASSET_ROUTES).sort(),
    [
      'admin.css',
      'tokens.css',
      'app.js',
      'store.js',
      'icons.js',
      'nav.js',
      'frame.js',
      'diff.js',
      'outcome.js',
      'slip.js',
      'views.js',
      'pack.js',
      'sitepane.js',
      'variants.js',
      'signin.js',
      'remote.js',
      'vaultcfg.js',
      'vocab.js',
      'images.js',
      'favicon.svg',
      'fonts/IMFeENrm28P.ttf',
      'fonts/IMFeENsc28P.ttf',
      'fonts/AlegreyaSans-Regular.ttf',
      'fonts/AlegreyaSans-Medium.ttf',
      'fonts/AlegreyaSans-Bold.ttf',
      'fonts/AlegreyaSans-Italic.ttf',
      'fonts/IBMPlexMono-Regular.woff2',
      'fonts/IBMPlexMono-SemiBold.woff2',
    ].sort(),
  );
});

function htmlAssetRefs(html) {
  const refs = [];
  const re = /(?:src|href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) refs.push(m[1]);
  return refs;
}

test('HTML src/href all start with /assets/ and name a route', () => {
  for (const file of ['index.html', 'locked.html']) {
    const html = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, file), 'utf8');
    const refs = htmlAssetRefs(html);
    assert.ok(refs.length > 0, `${file} has no src/href references`);
    for (const ref of refs) {
      assert.ok(ref.startsWith('/assets/'), `${file}: "${ref}" does not start with /assets/`);
      const name = ref.slice('/assets/'.length);
      assert.ok(
        Object.prototype.hasOwnProperty.call(ADMIN_ASSET_ROUTES, name),
        `${file}: "${ref}" does not name a route in ADMIN_ASSET_ROUTES`,
      );
    }
  }
});

test('No inline script, <style>, style= or on*= in either HTML file', () => {
  for (const file of ['index.html', 'locked.html']) {
    const html = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, file), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i, `${file}: inline <script>`);
    assert.doesNotMatch(html, /<style[\s>]/i, `${file}: <style>`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${file}: style=`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${file}: on*=`);
  }
});

test('JS assets contain none of the forbidden DOM/eval tokens', () => {
  const forbidden = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function'];
  for (const name of Object.keys(ADMIN_ASSET_ROUTES)) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, name), 'utf8');
    for (const token of forbidden) {
      assert.ok(!src.includes(token), `${name} contains forbidden token "${token}"`);
    }
  }
});

// --- FR35: the serve-admin graph never reaches the config writers ----------

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractRequireSpecs(source) {
  const specs = [];
  const stripped = stripComments(source);
  const re = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  while ((m = re.exec(stripped))) specs.push(m[2]);
  return specs;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  if (fs.existsSync(`${base}.json`)) return `${base}.json`;
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    if (fs.existsSync(path.join(base, 'index.js'))) return path.join(base, 'index.js');
  }
  return base;
}

function walkGraph(entry) {
  const files = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!fs.existsSync(file) || !file.endsWith('.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of extractRequireSpecs(source)) {
      if (Module.builtinModules.includes(spec.replace(/^node:/, ''))) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        queue.push(resolveRelative(file, spec));
        continue;
      }
      try {
        queue.push(require.resolve(spec, { paths: [path.dirname(file)] }));
      } catch {
        // ignore unresolved bare specifiers here; generator-module-graph.test.js owns that check
      }
    }
  }
  return files;
}

test('FR35: the graph from src/cli/serve-admin.js never reaches src/config/write.js, src/cli/config.js or src/cli/init.js', () => {
  const entry = path.join(ROOT, 'src', 'cli', 'serve-admin.js');
  const graph = walkGraph(entry);
  const forbidden = [
    path.join(ROOT, 'src', 'config', 'write.js'),
    path.join(ROOT, 'src', 'cli', 'config.js'),
    path.join(ROOT, 'src', 'cli', 'init.js'),
  ];
  const hits = forbidden.filter((f) => graph.has(f));
  assert.deepEqual(hits, [], `serve-admin.js's graph must not reach: ${hits.join(', ')}`);
});

// --- NFR05: no admin asset name reachable from src/build or src/generator --

test('No file under src/build/ or src/generator/ contains "assets/admin" or \'assets\', \'admin\'', () => {
  const offenders = [];
  for (const rootDir of [path.join(ROOT, 'src', 'build'), path.join(ROOT, 'src', 'generator')]) {
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.js')) {
          const source = fs.readFileSync(full, 'utf8');
          if (source.includes('assets/admin') || /['"]assets['"]\s*,\s*['"]admin['"]/.test(source)) {
            offenders.push(full);
          }
        }
      }
    })(rootDir);
  }
  assert.deepEqual(offenders, []);
});

// --- No network builtin, on raw source --------------------------------------

test('No file under src/admin/ or src/cli/serve-admin.js matches the network-builtin regex on raw source', () => {
  const FORBIDDEN = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns'];
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(path.join(ROOT, 'src', 'admin'));
  files.push(path.join(ROOT, 'src', 'cli', 'serve-admin.js'));

  const offenders = [];
  for (const f of files) {
    const source = fs.readFileSync(f, 'utf8'); // raw, unstripped -- deliberately not comment-stripped
    for (const name of FORBIDDEN) {
      if (new RegExp(`require\\(\\s*(['"])(node:)?${name}\\1\\s*\\)`).test(source)) {
        offenders.push(`${path.relative(ROOT, f)} (${name})`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
