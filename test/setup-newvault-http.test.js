'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { scratchRoot, copySample, configPathIn } = require('./helpers/setup-fixtures');
const { FIXTURE_DIR } = require('./helpers/vault-template-fixture');

const { startAdminPanel } = require('../src/cli/serve-admin');
const { startLocalListener } = require('../src/serve/server');
const { SETUP_MODE_ROUTES } = require('../src/admin/setupmode');

/*
 * The new-campaign path over real sockets (port 0, loopback only). No route was added: the new
 * behaviour rides on GET /api/setup/state, GET /api/setup/check and POST /api/setup/commit
 * (docs/decisions/0028-installer-and-first-run.md, addendum). The starter is the test fixture,
 * injected through ctx.setup.probeDeps. Expected bodies are written out by hand.
 */

function cfgRoot(t) {
  const root = scratchRoot(t);
  return { root, configPath: configPathIn(root) };
}

async function startPanel(t, flags, deps = { templateDir: FIXTURE_DIR, now: () => new Date(2026, 9, 8, 12), env: {} }) {
  const handles = [];
  const result = await startAdminPanel({ admin: true, ...flags }, undefined, {
    emit() {},
    startLocalListener: async (handler, opts) => {
      const h = await startLocalListener(handler, opts);
      handles.push(h);
      return h;
    },
    startPanelListener: async () => {
      throw new Error('no remote listener expected');
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  t.after(async () => {
    try {
      await result.stop();
    } catch {
      // already stopped
    }
  });
  result.ctx.setup.probeDeps = deps;
  const port = result.ctx.adminPort;
  return { ...result, port, cookie: `scriptorium_admin_${port}=${result.token}`, origin: `http://127.0.0.1:${port}` };
}

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

const get = (h, pathname) => request(h.port, { pathname, headers: { Cookie: h.cookie } });
const post = (h, pathname, obj) =>
  request(h.port, {
    method: 'POST',
    pathname,
    headers: { Cookie: h.cookie, Origin: h.origin, 'Content-Type': 'application/json' },
    body: typeof obj === 'string' ? obj : JSON.stringify(obj),
  });
const json = (res) => JSON.parse(res.body.toString('utf8'));
const check = (h, params) => get(h, `/api/setup/check?${new URLSearchParams(params)}`);

function answers(root, extra = {}) {
  return { name: 'fresh', newVault: true, vault: path.join(root, 'New Campaign'), output: path.join(root, 'fresh-site'), title: 'The Brass Lantern', system: 'dnd-5e-2024', ...extra };
}

test('the setup-mode route list is exactly the six routes it had before this feature', () => {
  assert.deepEqual([...SETUP_MODE_ROUTES], [
    'GET /auth',
    'GET /api/session',
    'GET /setup',
    'GET /api/setup/state',
    'GET /api/setup/check',
    'POST /api/setup/commit',
  ]);
});

test('state: tells the page whether this build can start a new campaign, and with which systems', async (t) => {
  const { configPath, root } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath });
  assert.deepEqual(json(await get(h, '/api/setup/state')).newVault, { available: true, systems: ['dnd-5e-2024'], problem: null });
  h.ctx.setup.probeDeps = { templateDir: path.join(root, 'no-starter-here') };
  assert.deepEqual(json(await get(h, '/api/setup/state')).newVault, { available: false, systems: [], problem: 'this build has no new-campaign starter' });
});

test('check: newVault, system and starterTitle answer in the usual shape, with the validators\' words', async (t) => {
  const { configPath, root } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath });
  const target = path.join(root, 'a', 'New');

  let r = json(await check(h, { field: 'newVault', value: target, name: 'fresh' }));
  assert.deepEqual([r.field, r.state, r.value, r.rule], ['newVault', 'ok', target, null]);
  assert.deepEqual(r.facts.missingAncestors, [path.join(root, 'a')]);
  assert.equal(fs.existsSync(path.join(root, 'a')), false, 'a check creates nothing');

  const vault = copySample(root);
  r = json(await check(h, { field: 'newVault', value: path.join(vault, 'x'), name: 'fresh' }));
  assert.equal(r.state, 'bad');
  assert.equal(r.rule, `refusing to create a vault in ${path.join(vault, 'x')}: it is inside the vault at ${vault}`);

  r = json(await check(h, { field: 'newVault', value: path.join(path.dirname(configPath), 'v'), name: 'fresh' }));
  assert.equal(r.state, 'bad', 'the settings folder is refused');

  r = json(await check(h, { field: 'system', value: 'none' }));
  assert.deepEqual([r.field, r.state, r.value], ['system', 'ok', 'none']);
  r = json(await check(h, { field: 'system', value: 'gurps-4e' }));
  assert.deepEqual([r.state, r.rule], ['bad', 'unknown game system "gurps-4e"; valid systems: dnd-5e-2024, none']);

  r = json(await check(h, { field: 'starterTitle', value: ' A  B ', name: 'fresh' }));
  assert.deepEqual([r.field, r.state, r.value], ['starterTitle', 'ok', 'A B']);
  r = json(await check(h, { field: 'starterTitle', value: 'say "hi"', name: 'fresh' }));
  assert.deepEqual([r.state, r.rule], ['bad', "site title can't be written into the new vault's pages exactly as typed; leave out double quotes and backslashes"]);

  assert.equal((await check(h, { field: 'bogus', value: 'x' })).status, 400);
  assert.equal(fs.existsSync(configPath), false);
});

test('check: a UNC folder for the new vault is deferred and the server touches nothing', async (t) => {
  const { configPath } = cfgRoot(t);
  const calls = [];
  const fsp = { stat: (...a) => (calls.push(a), Promise.reject(new Error('no'))), readdir: (...a) => (calls.push(a), Promise.reject(new Error('no'))) };
  const h = await startPanel(t, { config: configPath }, { templateDir: FIXTURE_DIR, fsp });
  const res = json(await check(h, { field: 'newVault', value: '\\\\nas\\share\\fresh', name: 'fresh', commit: '0' }));
  assert.equal(res.state, 'deferred');
  assert.deepEqual(calls, []);
});

test('commit: a new campaign is created, registered and handed over in the same panel', async (t) => {
  const { configPath, root } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath });
  const res = await post(h, '/api/setup/commit', answers(root));
  assert.equal(res.status, 200, res.body.toString());
  const body = json(res);
  assert.equal(body.handover, 'ok');
  assert.equal(body.vaultRoot, path.join(root, 'New Campaign'));
  assert.equal(body.vaultCreated.includes('_meta/vault-config.md'), true);
  assert.deepEqual(body.vaultAncestors, []);
  assert.equal(fs.existsSync(path.join(root, 'New Campaign', '_meta', 'scriptorium', 'pack.toml')), true);
  assert.match(fs.readFileSync(configPath, 'utf8'), /^default_campaign = "fresh"$/m);
  const state = json(await get(h, '/api/setup/state'));
  assert.equal(state.active, false);
  assert.equal(state.campaign, 'fresh');
});

test('commit: a refusal is a 400 with the field and the rule, and nothing is created', async (t) => {
  const { configPath, root } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath });
  const target = path.join(root, 'New Campaign');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'mine.md'), 'x');
  const res = await post(h, '/api/setup/commit', answers(root));
  assert.equal(res.status, 400);
  assert.deepEqual(json(res), { error: 'invalid', field: 'newVault', rule: `refusing to create a vault in ${target}: it is not empty (it holds mine.md)` });
  assert.equal(fs.existsSync(configPath), false);
  assert.deepEqual(fs.readdirSync(target), ['mine.md']);
  assert.equal(json(await get(h, '/api/setup/state')).active, true, 'setup is still open');
});

test('commit: newVault must be true or false and system must be text; both are 400 otherwise', async (t) => {
  const { configPath, root } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath });
  assert.equal((await post(h, '/api/setup/commit', answers(root, { newVault: 'yes' }))).status, 400);
  assert.equal((await post(h, '/api/setup/commit', answers(root, { system: 7 }))).status, 400);
  assert.equal((await post(h, '/api/setup/commit', answers(root, { system: 'x'.repeat(5000) }))).status, 400);
  assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
});

test('commit: two panels started before either committed: the second is told taken, and creates nothing', async (t) => {
  const { configPath, root } = cfgRoot(t);
  const first = await startPanel(t, { config: configPath });
  const second = await startPanel(t, { config: configPath });
  assert.equal((await post(first, '/api/setup/commit', answers(root))).status, 200);
  const res = await post(second, '/api/setup/commit', answers(root, { name: 'other', vault: path.join(root, 'Other'), output: path.join(root, 'other-site') }));
  assert.equal(res.status, 409, res.body.toString());
  assert.deepEqual(json(res), { error: 'taken' });
  assert.equal(fs.existsSync(path.join(root, 'Other')), false);
});

test('state: with no injected starter the build\'s own starter is available, with its three game systems', async (t) => {
  const { configPath } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath }, {});
  assert.deepEqual(json(await get(h, '/api/setup/state')).newVault, { available: true, systems: ['dnd-5e-2024', 'fitd', 'pf2e'], problem: null });
});
