'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

/*
 * ADR 0056. Structural pins on the panel access-list step, each with a planted control that proves
 * the scan can fail. The step (applyPanelAccess) is called from exactly two places, the panel start
 * and the remote CLI; the set of src/cli entry points whose require graph reaches the private-file
 * writer is pinned as a literal, so a new entry point that writes into the panel folder cannot slip
 * in without this list (and ADR 0056) being revisited; the module itself names no process
 * environment and no process-starting module of its own.
 *
 * walkGraph and its helpers are copied from test/remote-structure.test.js (lines 17 to 64 there),
 * not required.
 */

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const at = (...parts) => path.join(SRC, ...parts);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractRequireSpecs(source) {
  const specs = [];
  const re = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  const stripped = stripComments(source);
  while ((m = re.exec(stripped))) specs.push(m[2]);
  return specs;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  if (fs.existsSync(`${base}.json`)) return `${base}.json`;
  if (fs.existsSync(base) && fs.statSync(base).isDirectory() && fs.existsSync(path.join(base, 'index.js'))) return path.join(base, 'index.js');
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
    for (const spec of extractRequireSpecs(fs.readFileSync(file, 'utf8'))) {
      if (Module.builtinModules.includes(spec.replace(/^node:/, ''))) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        queue.push(resolveRelative(file, spec));
        continue;
      }
      try {
        queue.push(require.resolve(spec, { paths: [path.dirname(file)] }));
      } catch {
        // unresolved bare specifiers are generator-module-graph.test.js's business
      }
    }
  }
  return files;
}

function listJs(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  })(dir);
  return out.sort();
}

const PRIVATEFILE = at('remote', 'privatefile.js');
const CALL_RE = /\bapplyPanelAccess\(/;

/** Files (relative to the repository) under `roots` that call applyPanelAccess, other than panelaccess.js itself. */
function callers(roots) {
  return roots
    .flatMap((r) => listJs(r))
    .filter((f) => f !== at('remote', 'panelaccess.js'))
    .filter((f) => CALL_RE.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(ROOT, f))
    .sort();
}

/** The src/cli entry points (files directly in src/cli) whose require graph reaches privatefile.js. */
function cliEntriesReachingPrivateFile(dir) {
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.js'))
    .filter((n) => walkGraph(path.join(dir, n)).has(PRIVATEFILE))
    .sort();
}

test('applyPanelAccess( is called only from the panel start and the remote CLI', () => {
  assert.deepEqual(callers([SRC, path.join(ROOT, 'bin')]), [path.join('src', 'cli', 'remote.js'), path.join('src', 'cli', 'serve-admin.js')]);
});

test('the src/cli entry points that reach the private-file writer are exactly desktop, launch, remote, serve-admin and serve', () => {
  assert.deepEqual(cliEntriesReachingPrivateFile(at('cli')), ['desktop.js', 'launch.js', 'remote.js', 'serve-admin.js', 'serve.js']);
});

test('src/remote/panelaccess.js names no process environment and no process-starting module of its own', () => {
  const code = stripComments(fs.readFileSync(at('remote', 'panelaccess.js'), 'utf8'));
  assert.ok(!/process\s*\.\s*env/.test(code));
  assert.ok(!/child_process/.test(code));
  assert.ok(/require\('\.\.\/proc\/run'\)/.test(code), 'positive control: it does reach the one spawner');
});

test('controls: each scan finds a planted offender and passes a planted clean file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pas-struct-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // a third caller of applyPanelAccess( is seen
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'third.js'), "const x = await applyPanelAccess(paths, {}, {});\n// applyPanelAccess( in a comment is not a call\n");
  fs.writeFileSync(path.join(srcDir, 'clean.js'), "// applyPanelAccess( only in a comment\nmodule.exports = 1;\n");
  assert.deepEqual(callers([srcDir]).map((p) => path.basename(p)), ['third.js']);

  // an entry point that requires the private-file writer is seen, and one that does not is not
  const cli = path.join(dir, 'cli');
  fs.mkdirSync(cli);
  fs.writeFileSync(path.join(cli, 'writes.js'), `require(${JSON.stringify(PRIVATEFILE)});\n`);
  fs.writeFileSync(path.join(cli, 'plain.js'), "module.exports = 1;\n");
  assert.deepEqual(cliEntriesReachingPrivateFile(cli), ['writes.js']);

  // the environment and process-module scans see planted lines
  assert.ok(/process\s*\.\s*env/.test('const a = process.env.X;'));
  assert.ok(/child_process/.test("const c = require('child_process');"));
});
