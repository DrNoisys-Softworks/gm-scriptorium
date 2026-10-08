'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

/*
 * V1.5a (SD-a15, ADR 0029 section 9; SD-doc section 15 (a) to (e)). Structural pins on the remote
 * access code, each with a positive control that proves the scan can fail: the walker is pointed at
 * a missing file (it then reaches nothing), and every source scan is run over a planted offender.
 * walkGraph is copied from test/admin-assets.test.js, not required.
 */

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

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

const at = (...parts) => path.join(SRC, ...parts);

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

// --- (a), (b): the panel's module graph --------------------------------------------------

const PANEL_ENTRY = at('cli', 'serve-admin.js');
// ADR 0028 (section 2): src/config/write.js left this list. It is reachable from the panel through
// one chain only (src/setup/register.js), which the fenced test just below and the FR35 test in
// test/admin-assets.test.js pin. Every other entry is as strict as before.
const FORBIDDEN_FROM_PANEL = [at('remote', 'passwordwrite.js'), at('cli', 'remote.js'), at('cli', 'config.js'), at('cli', 'init.js')];
const REQUIRED_FROM_PANEL = [at('remote', 'sessions.js'), at('remote', 'audit.js'), at('remote', 'password.js'), at('remote', 'privatefile.js')];

test('(a) the graph from src/cli/serve-admin.js never reaches the password writer, the remote CLI, or any config writer', () => {
  const graph = walkGraph(PANEL_ENTRY);
  const hits = FORBIDDEN_FROM_PANEL.filter((f) => graph.has(f));
  assert.deepEqual(hits.map((f) => path.relative(ROOT, f)), []);
});

test('(a) the graph from src/cli/serve-admin.js reaches the config writer (src/config/write.js) only through src/setup/register.js (ADR 0028)', () => {
  const graph = walkGraph(PANEL_ENTRY);
  const write = at('config', 'write.js');
  assert.ok(graph.has(write), 'positive control: the setup chain reaches it');
  const importers = [...graph]
    .filter((f) => f.endsWith('.js') && fs.existsSync(f))
    .filter((f) => extractRequireSpecs(fs.readFileSync(f, 'utf8')).some((spec) => spec.startsWith('.') && resolveRelative(f, spec) === write))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(importers, [path.join('src', 'setup', 'register.js')]);
});

test('(b) positive control: the same graph DOES reach the session store, the audit log, the password reader and privatefile', () => {
  const graph = walkGraph(PANEL_ENTRY);
  const missing = REQUIRED_FROM_PANEL.filter((f) => !graph.has(f));
  assert.deepEqual(missing.map((f) => path.relative(ROOT, f)), []);
  assert.ok(graph.size > 30, 'the walker really walked');
});

test('(b) positive control: from src/cli/remote.js the walker reaches passwordwrite.js (and the panel graph does not, above)', () => {
  assert.ok(walkGraph(at('cli', 'remote.js')).has(at('remote', 'passwordwrite.js')));
});

test('(b) the controls have teeth: pointing the walker at a missing file reaches nothing, so the required-file assertion would fail', () => {
  const graph = walkGraph(at('cli', 'does-not-exist.js'));
  assert.equal(graph.size, 1);
  assert.ok(REQUIRED_FROM_PANEL.some((f) => !graph.has(f)), 'the positive control is red on a broken walker');
  assert.ok(!walkGraph(at('cli', 'does-not-exist.js')).has(at('remote', 'passwordwrite.js')));
});

test('(a) the walker would see a forbidden edge: a planted entry that requires passwordwrite.js reaches it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-struct-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planted = path.join(dir, 'entry.js');
  fs.writeFileSync(planted, `require(${JSON.stringify(at('remote', 'passwordwrite.js'))});\n`);
  assert.ok(walkGraph(planted).has(at('remote', 'passwordwrite.js')));
});

// --- (c): who may write remote-access files ------------------------------------------------

const WRITER_RE = /\b(writePrivateFileAtomic|appendPrivateLine)\(/;

/** Files under `dir` (relative to src) that call a private-file writer, other than privatefile.js itself. */
function privateWriters(dir) {
  return listJs(dir)
    .filter((f) => path.basename(f) !== 'privatefile.js' || path.dirname(f) !== at('remote'))
    .filter((f) => WRITER_RE.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(SRC, f));
}

test('(c) writePrivateFileAtomic( and appendPrivateLine( are called, outside privatefile.js, only by sessions.js, audit.js, passwordwrite.js and (ADR 0028) the launcher file writer', () => {
  assert.deepEqual(privateWriters(SRC), ['launch/launcherfile.js', 'remote/audit.js', 'remote/passwordwrite.js', 'remote/sessions.js']);
});

test('(c) positive control: a planted caller anywhere under the scanned folder is reported', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-struct-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'admin'));
  fs.writeFileSync(path.join(dir, 'admin', 'sneaky.js'), "const x = require('../remote/privatefile'); x.appendPrivateLine('f', 'l');\n");
  fs.writeFileSync(path.join(dir, 'admin', 'innocent.js'), "// appendPrivateLine( in a comment only\nmodule.exports = {};\n");
  const found = listJs(dir).filter((f) => WRITER_RE.test(stripComments(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(dir, f));
  assert.deepEqual(found, [path.join('admin', 'sneaky.js')]);
});

// --- (d): no scryptSync ---------------------------------------------------------------------

test('(d) no file under src/ calls scryptSync, and the password module uses the asynchronous crypto.scrypt', () => {
  const offenders = listJs(SRC).filter((f) => /scryptSync/.test(stripComments(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, []);
  const passwordSrc = fs.readFileSync(at('remote', 'password.js'), 'utf8');
  assert.match(passwordSrc, /crypto\.scrypt\(/);
  assert.match(passwordSrc, /timingSafeEqual\(/, 'the compare is constant-time');
});

test('(d) positive control: the scan finds a planted scryptSync', () => {
  assert.ok(/scryptSync/.test(stripComments('const k = crypto.scryptSync(pw, salt, 64);')));
  assert.ok(!/scryptSync/.test(stripComments('const k = await scryptAsync(pw, salt, 64); // never scryptSync')));
});

// --- (e): no environment reads in the remote code ---------------------------------------------

function envReaders() {
  const files = [...listJs(at('remote')), at('cli', 'remote.js'), at('cli', 'secretprompt.js')];
  return files.filter((f) => /process\.env/.test(stripComments(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(SRC, f));
}

test('(e) no process.env in src/remote/**, src/cli/remote.js or src/cli/secretprompt.js (the password is never read from the environment)', () => {
  assert.deepEqual(envReaders(), []);
  assert.ok(listJs(at('remote')).length >= 10, 'the scan covered the remote modules');
});

test('(e) positive control: the matcher finds process.env and ignores a comment', () => {
  assert.ok(/process\.env/.test(stripComments('const p = process.env.SECRET;')));
  assert.ok(!/process\.env/.test(stripComments('// never process.env\nconst a = 1;')));
});

// --- the remote modules stay free of network builtins and of the child_process module ------------

test('src/remote/** requires no network builtin, child_process or the panel handlers (NFR-03)', () => {
  const FORBIDDEN = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process'];
  const offenders = [];
  for (const f of [...listJs(at('remote')), at('cli', 'remote.js'), at('cli', 'secretprompt.js')]) {
    for (const spec of extractRequireSpecs(fs.readFileSync(f, 'utf8'))) {
      const bare = spec.replace(/^node:/, '');
      if (FORBIDDEN.includes(bare)) offenders.push(`${path.relative(SRC, f)} (${bare})`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the audit hook is the only place that calls audit.append with a request body: no handler passes req or a body into an audit entry, and the one handler-supplied value is the affected campaign name (ADR 0050)', () => {
  const routerSrc = stripComments(fs.readFileSync(at('admin', 'router.js'), 'utf8'));
  const appendCalls = routerSrc.match(/audit\.append\([^)]*\)/g) || [];
  assert.equal(appendCalls.length, 2, 'the request line and the response line');
  for (const call of appendCalls) assert.ok(!/body|req\b/.test(call.replace(/req\.method/, '')), call);
  assert.deepEqual([...new Set(routerSrc.match(/\bnote\.[A-Za-z_]+/g) || [])], ['note.affected']);

  const assigners = listJs(at('admin'))
    .filter((f) => /\bauditNote\.[A-Za-z_]+\s*=(?!=)/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'));
  assert.deepEqual(assigners, ['admin/handlers/campaigns.js']);
  const assigned = stripComments(fs.readFileSync(at('admin', 'handlers', 'campaigns.js'), 'utf8')).match(/\bauditNote\.[A-Za-z_]+(?=\s*=(?!=))/g) || [];
  assert.deepEqual([...new Set(assigned)], ['auditNote.affected']);
});

test('positive control: the auditNote assignment scan finds a planted second field and ignores a comment', () => {
  const re = /\bauditNote\.[A-Za-z_]+\s*=(?!=)/;
  assert.ok(re.test(stripComments('auditNote.other = 1;')));
  assert.ok(!re.test(stripComments('// auditNote.other = 1\nconst a = auditNote.affected === 1;')));
});
