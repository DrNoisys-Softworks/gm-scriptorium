'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');
const { scratchRoot, copySample, configPathIn } = require('./helpers/setup-fixtures');

/*
 * ADR 0028 section 2: the panel's one write to config.toml is fenced. Structurally: the config
 * writer is reachable from the admin panel through ONE chain (handlers/setup.js > setup/register.js >
 * config/write.js), setup code is write-free except through src/vault/packwrite.js, and no module
 * under src/admin or src/setup names the writer except register.js. Behaviourally: with the writer
 * spied, every route of the table is hit in normal mode and in setup mode, and the writer is called
 * exactly once, by one valid setup commit. Every scan has a positive control that proves it can
 * fail. walkGraph and the comment stripper are copied, not required (the precedent of
 * test/remote-structure.test.js).
 */

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const at = (...p) => path.join(SRC, ...p);

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

function importersOf(graph, target) {
  return [...graph]
    .filter((f) => f.endsWith('.js') && fs.existsSync(f))
    .filter((f) => extractRequireSpecs(fs.readFileSync(f, 'utf8')).some((spec) => (spec.startsWith('.') || spec.startsWith('/')) && resolveRelative(f, spec) === target))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .sort();
}

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

const WRITE_JS = at('config', 'write.js');
const REGISTER_JS = at('setup', 'register.js');
const SETUP_HANDLER = at('admin', 'handlers', 'setup.js');
const PANEL_ENTRY = at('cli', 'serve-admin.js');

// --- the fence (graph importers) ------------------------------------------------------------------

test('the panel graph reaches the config writer only through setup/register.js, and only handlers/setup.js requires register.js', () => {
  const graph = walkGraph(PANEL_ENTRY);
  assert.ok(graph.has(WRITE_JS));
  assert.deepEqual(importersOf(graph, WRITE_JS), ['src/setup/register.js']);
  assert.deepEqual(importersOf(graph, REGISTER_JS), ['src/admin/handlers/setup.js']);
  assert.deepEqual(importersOf(graph, SETUP_HANDLER), ['src/admin/router.js']);
});

test('the panel graph never reaches src/cli/config.js, src/cli/init.js, child_process or the password writer', () => {
  const graph = walkGraph(PANEL_ENTRY);
  for (const f of [at('cli', 'config.js'), at('cli', 'init.js'), at('remote', 'passwordwrite.js'), at('cli', 'remote.js')]) {
    assert.equal(graph.has(f), false, path.relative(ROOT, f));
  }
  for (const f of [...graph].filter((x) => x.startsWith(SRC) && fs.existsSync(x))) {
    assert.ok(!extractRequireSpecs(fs.readFileSync(f, 'utf8')).some((s) => s.replace(/^node:/, '') === 'child_process') || f === at('proc', 'run.js'), `${path.relative(ROOT, f)} requires child_process`);
  }
});

test('positive controls: from src/cli/init.js the walk DOES reach write.js; a planted second importer inside the panel graph is detected', (t) => {
  assert.ok(walkGraph(at('cli', 'init.js')).has(WRITE_JS));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planted = path.join(dir, 'sneaky.js');
  fs.writeFileSync(planted, `require(${JSON.stringify(WRITE_JS)});\n`);
  const entry = path.join(dir, 'entry.js');
  fs.writeFileSync(entry, `require(${JSON.stringify(PANEL_ENTRY)}); require('./sneaky');\n`);
  const graph = walkGraph(entry);
  assert.deepEqual(
    importersOf(graph, WRITE_JS).sort(),
    [path.relative(ROOT, planted).split(path.sep).join('/'), 'src/setup/register.js'].sort(),
  );
  assert.notDeepEqual(importersOf(graph, WRITE_JS), ['src/setup/register.js'], 'the fence assertion would be red');
});

// --- write-free setup code (PW15's tokens) -----------------------------------------------------------

const WRITE_TOKENS = [
  'writeFileSync', 'writeFile(', 'appendFileSync', 'appendFile(', 'copyFileSync', 'copyFile(', 'rmSync', 'rm(', 'unlinkSync', 'unlink(',
  'mkdirSync', 'mkdir(', 'renameSync', 'rename(', 'chmodSync', 'chmod(', 'truncateSync', 'truncate(', 'createWriteStream',
];

function writeTokensIn(file) {
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  return WRITE_TOKENS.filter((t) => source.includes(t));
}

const SETUP_CODE = [...listJs(at('setup')), SETUP_HANDLER];

test('PW15 tokens are absent from every file in src/setup and from src/admin/handlers/setup.js (vault writes only via src/vault/packwrite.js and src/vault/vaultcreate.js)', () => {
  assert.ok(SETUP_CODE.length >= 7, "the scan covers src/setup and the handler");
  for (const f of SETUP_CODE) assert.deepEqual(writeTokensIn(f), [], path.relative(ROOT, f));
});

test('positive control: the token scan finds a planted write and ignores a comment', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'bad.js');
  fs.writeFileSync(bad, "const fs = require('fs'); fs.writeFileSync('x', 'y');\n");
  const fine = path.join(dir, 'fine.js');
  fs.writeFileSync(fine, "// never writeFileSync here\nmodule.exports = 1;\n");
  assert.deepEqual(writeTokensIn(bad), ['writeFileSync']);
  assert.deepEqual(writeTokensIn(fine), []);
});

test('the only vault write helpers setup code names are createPackEntries (src/vault/packwrite.js) and createVault (src/vault/vaultcreate.js), each only in src/setup/register.js', () => {
  for (const [helper, mod] of [['createPackEntries', 'packwrite'], ['createVault', 'vaultcreate']]) {
    const users = listJs(at('setup')).filter((f) => new RegExp(`\\b${helper}\\b`).test(stripComments(fs.readFileSync(f, 'utf8'))));
    assert.deepEqual(users.map((f) => path.relative(ROOT, f)), [path.join('src', 'setup', 'register.js')], helper);
    assert.match(stripComments(fs.readFileSync(REGISTER_JS, 'utf8')), new RegExp(`require\\('\\.\\./vault/${mod}'\\)`));
  }
});

test('positive control: a scratch file naming createVault is found by the same filter, and a comment-only mention is not', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'named.js'), "const { createVault } = require('x'); createVault();\n");
  fs.writeFileSync(path.join(dir, 'comment.js'), '// createVault is not used here\n/* createVault */\nmodule.exports = 1;\n');
  const users = listJs(dir).filter((f) => new RegExp('\\bcreateVault\\b').test(stripComments(fs.readFileSync(f, 'utf8'))));
  assert.deepEqual(users.map((f) => path.basename(f)), ['named.js']);
});

// --- no computed requires ------------------------------------------------------------------------------

const DYNAMIC_RE = /\brequire\(\s*[^'"\s]|\bmodule\.require\b|\brequire\.cache\b|\bprocess\.mainModule\b|\brequire\.resolve\b|\bimport\(/;

test('no non-literal require, module.require, require.cache or process.mainModule in src/setup or src/admin/handlers/setup.js', () => {
  for (const f of SETUP_CODE) assert.equal(DYNAMIC_RE.test(stripComments(fs.readFileSync(f, 'utf8'))), false, path.relative(ROOT, f));
  assert.equal(DYNAMIC_RE.test("const x = require(name);"), true, 'positive control');
  assert.equal(DYNAMIC_RE.test("module.require('./a')"), true, 'positive control');
  assert.equal(DYNAMIC_RE.test("require('./a')"), false);
});

// --- who names the writer -------------------------------------------------------------------------------

function namers(identifier) {
  const re = new RegExp(`\\b${identifier}\\b`);
  return [...listJs(at('admin')), ...listJs(at('setup'))]
    .filter((f) => re.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'));
}

test('writeConfigFile is named under src/admin/** and src/setup/** only in setup/register.js; serializeConfig in none', () => {
  assert.deepEqual(namers('writeConfigFile'), ['setup/register.js']);
  assert.deepEqual(namers('serializeConfig'), []);
});

test('commitSetup is called from exactly one place: the commit function of handlers/setup.js', () => {
  const callers = listJs(SRC).filter((f) => /\bcommitSetup\s*\(/.test(stripComments(fs.readFileSync(f, 'utf8'))) && f !== REGISTER_JS);
  assert.deepEqual(callers.map((f) => path.relative(SRC, f)), [path.join('admin', 'handlers', 'setup.js')]);
  const source = stripComments(fs.readFileSync(SETUP_HANDLER, 'utf8'));
  const start = source.indexOf('async function commit(');
  const end = source.indexOf('async function welcomeDismiss(');
  assert.ok(start > 0 && end > start);
  assert.equal((source.match(/commitSetup\s*\(/g) || []).length, 1);
  assert.ok(source.slice(start, end).includes('commitSetup('));
});

// --- the behavioural sweep -----------------------------------------------------------------------------

const { startAdminPanel } = require('../src/cli/serve-admin');
const { startLocalListener } = require('../src/serve/server');
const { ADMIN_ROUTES } = require('../src/admin/router');
const configWrite = require('../src/config/write');
const { writeConfigFile } = configWrite;

function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function startPanel(t, flags) {
  const result = await startAdminPanel({ admin: true, ...flags }, undefined, {
    emit() {},
    startLocalListener,
    startPanelListener: async () => {
      throw new Error('no remote listener expected');
    },
  });
  assert.equal(result.ok, true);
  t.after(async () => {
    try {
      await result.stop();
    } catch {
      // already stopped
    }
  });
  const port = result.ctx.adminPort;
  return { ctx: result.ctx, port, cookie: `scriptorium_admin_${port}=${result.token}`, origin: `http://127.0.0.1:${port}` };
}

function installSpy(t) {
  const calls = [];
  configWrite.writeConfigFile = (...args) => {
    calls.push(args[0]);
    return writeConfigFile(...args);
  };
  t.after(() => {
    configWrite.writeConfigFile = writeConfigFile;
  });
  return calls;
}

async function sweep(h) {
  for (const r of ADMIN_ROUTES.filter((x) => x.path !== undefined && x.path !== '/auth' && x.path !== '/auth/password')) {
    const headers = { Cookie: h.cookie };
    if (r.method === 'POST') Object.assign(headers, { Origin: h.origin, 'Content-Type': 'application/json' });
    const res = await request(h.port, { method: r.method, pathname: r.path, headers, body: r.method === 'POST' ? '{}' : undefined });
    assert.notEqual(res.status, 500, `${r.method} ${r.path}`);
  }
}

test('behavioural sweep, normal mode: every route of the table is hit with {} and the config writer is never called', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root, 'vault', { withPack: true });
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfigFile(configPath, { config_version: 1, default_campaign: 'x', campaigns: { x: { vault, output: path.join(root, 'o') } } });
  const calls = installSpy(t);
  const h = await startPanel(t, { config: configPath });
  await sweep(h);
  assert.deepEqual(calls, []);
});

test('behavioural sweep, setup mode: every route is hit with {} (all fenced or refused), then ONE valid commit calls the writer exactly once', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const configPath = configPathIn(root);
  const calls = installSpy(t);
  const h = await startPanel(t, { config: configPath });
  await sweep(h);
  assert.deepEqual(calls, [], 'nothing before the commit');
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'scriptorium')), false);

  const res = await request(h.port, {
    method: 'POST',
    pathname: '/api/setup/commit',
    headers: { Cookie: h.cookie, Origin: h.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'lease', vault, output: path.join(root, 'lease-site') }),
  });
  assert.equal(res.status, 200, res.body.toString());
  assert.deepEqual(calls, [configPath]);

  await sweep(h);
  assert.deepEqual(calls, [configPath], 'after the handover the sweep still never calls the writer');
});

test('positive control: the spy sees a call (a direct commit through register.commitSetup is counted)', async (t) => {
  const root = scratchRoot(t);
  copySample(root);
  const calls = installSpy(t);
  const l = configPathIn(root);
  const done = await require('../src/setup/register').commitSetup(
    { name: 'lease', vault: path.join(root, 'vault'), output: path.join(root, 'o') },
    { configPath: l, panelDir: path.join(path.dirname(l), 'panel') },
  );
  assert.ok(done.created);
  assert.deepEqual(calls, [l]);
});
