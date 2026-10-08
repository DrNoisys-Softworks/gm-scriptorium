'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { scratchRoot, copySample, configPathIn, treeSnapshot } = require('./helpers/setup-fixtures');

const { startAdminPanel } = require('../src/cli/serve-admin');
const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');
const { writeConfigFile } = require('../src/config/write');
const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');
const { createTestProxy } = require('./helpers/remote-test-proxy');
const remoteHandlers = require('../src/admin/handlers/remote');

/*
 * ADR 0049 over real sockets: GET /api/folders and POST /api/folders/create, in setup mode and in
 * normal mode, from loopback and from a remote session (the repo's test proxy, fixed ports
 * 7936/7937, Linux only). Expected bodies and numbers are written out by hand. Everything the OS
 * could do badly is an injected ctx.folderDeps, never a real unreachable share.
 */

const linuxOnly = { skip: process.platform !== 'linux' ? 'Linux accepts every 127/8 address; other platforms do not' : false };
const AUDIT_503 = '{"error":"audit","message":"The panel could not write its audit log, so changes from other devices are paused. Use the panel on this machine, or fix the disk and try again."}';
const mkErr = (code) => Object.assign(new Error(code), { code });
const statOf = (kind) => ({ isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' });
const settle = () => new Promise((r) => setImmediate(r));

// --- loopback harness (setup mode and normal mode) ---------------------------------------------------------

function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
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

const get = (h, pathname, headers = {}) => request(h.port, { pathname, headers: { Cookie: h.cookie, ...headers } });
const folders = (h, query = '') => get(h, `/api/folders${query ? `?${query}` : ''}`);
const json = (res) => JSON.parse(res.text);
const q = (obj) => new URLSearchParams(obj).toString();

function post(h, body, { origin = h.origin, cookie = h.cookie, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return request(h.port, { method: 'POST', pathname: '/api/folders/create', headers, body: raw !== undefined ? raw : JSON.stringify(body) });
}

/** A scratch world: a work tree with files, links and folders, and a config folder beside it. */
function world(t) {
  const root = fs.realpathSync(scratchRoot(t));
  const work = path.join(root, 'work');
  for (const d of ['Alpha', 'beta', 'Zeta', '.hidden-dir', 'Target']) fs.mkdirSync(path.join(work, d), { recursive: true });
  fs.mkdirSync(path.join(work, 'Target', 'sentinel-child-folder'));
  fs.writeFileSync(path.join(work, 'notes.md'), 'x');
  fs.writeFileSync(path.join(work, 'SENTINEL-FILE-NAME.txt'), 'x');
  fs.symlinkSync(path.join(work, 'Target'), path.join(work, 'linkdir'));
  fs.symlinkSync(path.join(work, 'notes.md'), path.join(work, 'filelink'));
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  return { root, work, configPath };
}

function auditLines(configPath) {
  const file = path.join(path.dirname(configPath), 'panel', 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function normalPanel(t) {
  const w = world(t);
  const vault = copySample(w.root, 'vault', { withPack: true });
  writeConfigFile(w.configPath, { config_version: 1, default_campaign: 'x', campaigns: { x: { vault, output: path.join(w.root, 'o') } } });
  const h = await startPanel(t, { config: w.configPath });
  return { ...w, vault, h };
}

// --- the gate -----------------------------------------------------------------------------------------------

test('both routes need a session: no cookie is refused, and a POST without or with a foreign Origin is refused', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const anon = await request(h.port, { pathname: '/api/folders' });
  assert.equal(anon.status, 403);
  assert.equal(anon.text, 'refused: token');
  const anonPost = await post(h, { parent: w.work, name: 'x' }, { cookie: null });
  assert.equal(anonPost.status, 403);
  const noOrigin = await post(h, { parent: w.work, name: 'x' }, { origin: null });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.text, 'refused: origin');
  const foreign = await post(h, { parent: w.work, name: 'x' }, { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.deepEqual(fs.readdirSync(w.work).includes('x'), false);
});

// --- GET /api/folders, setup mode -----------------------------------------------------------------------------

test('setup mode: no query is the roots view', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const res = await folders(h);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  const body = json(res);
  assert.equal(body.view, 'roots');
  assert.equal(body.platform, 'posix');
  assert.deepEqual(body.roots[0], { path: '/', name: '/', state: 'ok' });
  assert.equal(body.home, os.homedir());
});

test('AC-01/02/03 setup mode: path lists folders only, marks links, hides hidden ones until asked, narrows by filter', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const res = await folders(h, q({ path: w.work }));
  assert.equal(res.status, 200);
  const body = json(res);
  assert.deepEqual(Object.keys(body).sort(), ['entries', 'parent', 'path', 'state', 'truncated', 'view']);
  assert.equal(body.state, 'ok');
  assert.equal(body.path, w.work);
  assert.equal(body.parent, w.root);
  assert.deepEqual(body.entries.map((e) => e.name), ['Alpha', 'beta', 'linkdir', 'Target', 'Zeta']);
  assert.equal(body.entries.find((e) => e.name === 'linkdir').link, true);
  for (const forbidden of ['notes.md', 'SENTINEL-FILE-NAME', 'filelink', 'sentinel-child-folder']) assert.equal(res.text.includes(forbidden), false, forbidden);

  const hidden = json(await folders(h, q({ path: w.work, hidden: '1' })));
  assert.equal(hidden.entries.find((e) => e.name === '.hidden-dir').hidden, true);
  const narrowed = json(await folders(h, q({ path: w.work, filter: 'ET' })));
  assert.deepEqual(narrowed.entries.map((e) => e.name), ['beta', 'Target', 'Zeta']);
});

test('AC-02 a link, a file and an absent path answer a state, with the path', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const link = path.join(w.work, 'linkdir');
  assert.deepEqual(json(await folders(h, q({ path: link }))), { view: 'folder', state: 'link', path: link });
  const file = path.join(w.work, 'notes.md');
  assert.deepEqual(json(await folders(h, q({ path: file }))), { view: 'folder', state: 'not-folder', path: file });
  const gone = path.join(w.work, 'gone');
  assert.deepEqual(json(await folders(h, q({ path: gone }))), { view: 'folder', state: 'missing', path: gone });
});

test('AC-04 an unreadable folder answers permission with 200, never a 403 or 500 from the handler', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  h.ctx.folderDeps = { fsp: { lstat: () => Promise.resolve(statOf('dir')), opendir: () => Promise.reject(mkErr('EACCES')) } };
  const res = await folders(h, q({ path: w.work }));
  assert.equal(res.status, 200);
  assert.deepEqual(json(res), { view: 'folder', state: 'permission', path: w.work });
});

test('bad input is a 400 {error:invalid, reason}: relative, too long, NUL, filter over 128, path with start, repeated keys', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const cases = [
    [q({ path: 'relative/dir' }), 'path'],
    [q({ path: '' }), 'path'],
    [q({ path: `/${'a'.repeat(2048)}` }), 'path'],
    ['path=%2Fa%00b', 'path'],
    [q({ path: w.work, filter: 'x'.repeat(129) }), 'filter'],
    [q({ path: w.work, start: w.work }), 'params'],
    [`path=${encodeURIComponent(w.work)}&path=${encodeURIComponent(w.root)}`, 'params'],
    [q({ start: 'x'.repeat(2049) }), 'path'],
  ];
  for (const [query, reason] of cases) {
    const res = await folders(h, query);
    assert.equal(res.status, 400, query.slice(0, 60));
    assert.deepEqual(json(res), { error: 'invalid', reason }, query.slice(0, 60));
  }
  assert.equal((await folders(h, q({ path: w.work, filter: 'x'.repeat(128) }))).status, 200);
});

test('HEAD /api/folders answers the status and headers with no body', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const res = await request(h.port, { method: 'HEAD', pathname: `/api/folders?${q({ path: w.work })}`, headers: { Cookie: h.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
});

test('AC-06 start: the deepest existing folder of the value; a UNC value is never probed and comes back deferred', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const deep = path.join(w.work, 'Alpha', 'not', 'yet');
  assert.deepEqual(json(await folders(h, q({ start: deep }))), { view: 'start', path: path.join(w.work, 'Alpha'), deferred: false });
  const calls = [];
  const spy = (name) => (...a) => (calls.push([name, ...a]), Promise.reject(mkErr('ENOENT')));
  h.ctx.folderDeps = { fsp: { lstat: spy('lstat'), stat: spy('stat'), opendir: spy('opendir'), realpath: spy('realpath') } };
  for (const unc of ['\\\\host\\share\\x', '//host/share/x']) {
    assert.deepEqual(json(await folders(h, q({ start: unc }))), { view: 'start', path: null, deferred: true });
  }
  assert.deepEqual(calls, []);
});

test('AC-10 a hung filesystem answers not-responding within the bound, a third call answers busy, and another request is never held up', { timeout: 15000 }, async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const pending = [];
  t.after(async () => {
    pending.splice(0).forEach((p) => p.reject(mkErr('ENOENT')));
    await settle();
  });
  const calls = [];
  h.ctx.folderDeps = {
    timeoutMs: 300,
    fsp: {
      lstat: (p) => (calls.push(p), new Promise((resolve, reject) => pending.push({ resolve, reject }))),
    },
  };
  const a = folders(h, q({ path: w.work }));
  const b = folders(h, q({ path: w.root }));
  const waitStart = Date.now();
  while (calls.length < 2) {
    assert.ok(Date.now() - waitStart < 3000, 'both listings reached the filesystem');
    await new Promise((r) => setTimeout(r, 5));
  }
  const started = Date.now();
  const third = await folders(h, q({ path: w.work }));
  assert.deepEqual(json(third), { view: 'folder', state: 'busy', path: w.work });
  const session = await get(h, '/api/session');
  assert.equal(session.status, 200);
  assert.ok(Date.now() - started < 250, 'nothing waited on the hung calls');
  assert.equal(json(await a).state, 'not-responding');
  assert.equal(json(await b).state, 'not-responding');
  assert.equal(calls.length, 2);
});

test('AC-06 roots on win32 (injected): a drive that does not answer is remembered across requests and asked again only on refresh', { timeout: 15000 }, async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const pending = [];
  t.after(async () => {
    pending.splice(0).forEach((p) => p.reject(mkErr('ENOENT')));
    await settle();
  });
  const asked = [];
  h.ctx.folderDeps = {
    platform: 'win32',
    homedir: 'C:\\People\\gm',
    timeoutMs: 50,
    fsp: {
      stat: (p) => {
        asked.push(p);
        if (p === 'E:\\') return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        return p === 'C:\\' ? Promise.resolve(statOf('dir')) : Promise.reject(mkErr('ENOENT'));
      },
    },
  };
  const first = json(await folders(h));
  assert.equal(first.platform, 'win32');
  assert.deepEqual(first.roots.slice(0, 2), [{ path: 'C:\\', name: 'C:', state: 'ok' }, { path: 'E:\\', name: 'E:', state: 'not-responding' }]);
  assert.equal(first.roots[2].state, 'unchecked');
  assert.equal(asked.filter((p) => p === 'E:\\').length, 1);
  const second = json(await folders(h));
  assert.equal(second.roots.find((r) => r.name === 'E:').state, 'not-responding');
  assert.equal(asked.filter((p) => p === 'E:\\').length, 1, 'not asked again');
  await folders(h, 'refresh=1');
  assert.equal(asked.filter((p) => p === 'E:\\').length, 2, 'refresh asks again');
});

// --- POST /api/folders/create ----------------------------------------------------------------------------------------

test('AC-07/08 setup mode admits the POST: it makes one folder, answers its path, and a repeat is exists', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const before = treeSnapshot(w.root);
  const res = await post(h, { parent: w.work, name: 'Session Art' });
  assert.equal(res.status, 200);
  assert.deepEqual(json(res), { created: true, path: path.join(w.work, 'Session Art') });
  assert.equal(fs.statSync(path.join(w.work, 'Session Art')).isDirectory(), true);
  const after = treeSnapshot(w.root).filter((x) => !before.includes(x));
  assert.deepEqual(after.filter((x) => !x.startsWith('cfg/')), ['work/Session Art/']);
  const again = await post(h, { parent: w.work, name: 'Session Art' });
  assert.equal(again.status, 409);
  assert.deepEqual(json(again), { error: 'exists' });
});

test('AC-07 a bad name or parent is a 400 naming the field and the validator message; a bad body is a 400 on body', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const before = treeSnapshot(w.work);
  const name = await post(h, { parent: w.work, name: '.x' });
  assert.equal(name.status, 400);
  assert.deepEqual(json(name), { error: 'invalid', field: 'name', message: 'folder name must not start with a dot' });
  for (const bad of ['a/b', 'a\\b', '..', 'CON', 'x.']) {
    const r = await post(h, { parent: w.work, name: bad });
    assert.equal(r.status, 400, bad);
    assert.equal(json(r).field, 'name', bad);
  }
  const parent = await post(h, { parent: 'relative', name: 'ok' });
  assert.equal(parent.status, 400);
  assert.equal(json(parent).field, 'parent');
  for (const body of [{}, { parent: w.work }, { parent: w.work, name: 'x', extra: 1 }, [], 'text', null]) {
    const r = await post(h, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(json(r).field, 'body');
  }
  const notJson = await post(h, null, { raw: '{nope' });
  assert.equal(notJson.status, 400);
  assert.equal(json(notJson).field, 'body');
  assert.equal(json(await post(h, { parent: 5, name: 'x' })).field, 'parent');
  assert.equal(json(await post(h, { parent: w.work, name: 5 })).field, 'name');
  assert.deepEqual(treeSnapshot(w.work), before);
});

test('a body over the JSON cap is a 413', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const res = await post(h, { parent: w.work, name: 'x', pad: 'y'.repeat(70000) });
  assert.equal(res.status, 413);
});

test('refusals are 409 with the reason: missing parent, a file, a link, inside the config folder', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const cases = [
    [path.join(w.work, 'gone'), 'missing'],
    [path.join(w.work, 'notes.md'), 'not-folder'],
    [path.join(w.work, 'linkdir'), 'link'],
    [path.dirname(w.configPath), 'inside-config'],
  ];
  for (const [parent, error] of cases) {
    const r = await post(h, { parent, name: 'x' });
    assert.equal(r.status, 409, error);
    assert.deepEqual(json(r), { error }, error);
  }
  assert.equal(fs.existsSync(path.join(path.dirname(w.configPath), 'x')), false);
});

test('a create while another check or write runs is a 409 busy naming it', async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  h.ctx.busy = 'check';
  const r = await post(h, { parent: w.work, name: 'x' });
  assert.equal(r.status, 409);
  assert.deepEqual(json(r), { error: 'busy', busy: 'check' });
  assert.equal(fs.existsSync(path.join(w.work, 'x')), false);
  h.ctx.busy = null;
  assert.equal((await post(h, { parent: w.work, name: 'x' })).status, 200);
  assert.equal(h.ctx.busy, null, 'the mutex is released');
});

test('AC-07 a hung parent check is a 409 not-responding within the bound', { timeout: 15000 }, async (t) => {
  const w = world(t);
  const h = await startPanel(t, { config: w.configPath });
  const pending = [];
  t.after(async () => {
    pending.splice(0).forEach((p) => p.reject(mkErr('ENOENT')));
    await settle();
  });
  h.ctx.folderDeps = { timeoutMs: 40, fsp: { lstat: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } };
  const r = await post(h, { parent: w.work, name: 'x' });
  assert.equal(r.status, 409);
  assert.deepEqual(json(r), { error: 'not-responding' });
});

test('after setup commits the same routes keep working in the same process (normal mode, no restart)', async (t) => {
  const w = world(t);
  const vault = copySample(w.root, 'vault');
  const h = await startPanel(t, { config: w.configPath });
  const commit = await request(h.port, {
    method: 'POST',
    pathname: '/api/setup/commit',
    headers: { Cookie: h.cookie, Origin: h.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'lease', vault, output: path.join(w.root, 'lease-site') }),
  });
  assert.equal(commit.status, 200, commit.text);
  assert.equal(h.ctx.setup.active, false);
  assert.equal(json(await folders(h, q({ path: w.work }))).state, 'ok');
  const made = await post(h, { parent: w.work, name: 'After' });
  assert.equal(made.status, 200);
  const inVault = await post(h, { parent: vault, name: 'nope' });
  assert.equal(inVault.status, 409);
  assert.deepEqual(json(inVault), { error: 'inside-vault' });
});

// --- audit, loopback ---------------------------------------------------------------------------------------------

test('AC-08 loopback: a listing writes no audit line; a create writes a request and a response', async (t) => {
  const n = await normalPanel(t);
  const before = auditLines(n.configPath).length;
  await folders(n.h, q({ path: n.work }));
  await folders(n.h);
  await folders(n.h, q({ start: n.work }));
  assert.equal(auditLines(n.configPath).length, before, 'listings are not audited on loopback');

  const res = await post(n.h, { parent: n.work, name: 'Audited' });
  assert.equal(res.status, 200);
  const lines = auditLines(n.configPath).slice(before);
  assert.deepEqual(lines.map((l) => l.event), ['request', 'response']);
  for (const l of lines) {
    assert.equal(l.via, 'loopback');
    assert.equal(l.route, '/api/folders/create');
    assert.equal(l.campaign, 'x');
  }
  assert.equal(lines[0].method, 'POST');
  assert.equal(lines[1].status, 200);
});

test('a create refused as a bad request leaves only the router pair', async (t) => {
  const n = await normalPanel(t);
  const before = auditLines(n.configPath).length;
  const res = await post(n.h, { parent: n.work, name: '.bad' });
  assert.equal(res.status, 400);
  assert.deepEqual(auditLines(n.configPath).slice(before).map((l) => l.event), ['request', 'response']);
});

test('M13/M10 normal mode: creating inside a registered vault or the config folder is refused 409', async (t) => {
  const n = await normalPanel(t);
  const inVault = await post(n.h, { parent: n.vault, name: 'x' });
  assert.deepEqual([inVault.status, json(inVault)], [409, { error: 'inside-vault' }]);
  const inSub = await post(n.h, { parent: path.join(n.vault, '_meta'), name: 'x' });
  assert.deepEqual([inSub.status, json(inSub)], [409, { error: 'inside-vault' }]);
  const inCfg = await post(n.h, { parent: path.dirname(n.configPath), name: 'x' });
  assert.deepEqual([inCfg.status, json(inCfg)], [409, { error: 'inside-config' }]);
  assert.equal(fs.existsSync(path.join(n.vault, 'x')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(n.configPath), 'x')), false);
  // the listing itself is allowed in a vault: it only names folders
  assert.equal(json(await folders(n.h, q({ path: n.vault }))).state, 'ok');
});

// --- remote ---------------------------------------------------------------------------------------------------------

const ADMIN_HOST = 'scriptorium.home.arpa';
const PREVIEW_HOST = 'preview.scriptorium.home.arpa';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
const PASSWORD = 'correct horse battery';
const PORTS = [7936, 7937];

function remoteFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fh-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // the vault is beside the config folder too, so a refusal inside it is the vault's, not the config folder's
  const vroot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fv-')));
  t.after(() => fs.rmSync(vroot, { recursive: true, force: true }));
  const vault = path.join(vroot, 'vault');
  fs.mkdirSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n');
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Alpha Test' })}\n`);
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'pack.toml'), 'theme = "plain"\n');
  // beside, not inside, the config folder (the panel's config folder is `root`)
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fw-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.mkdirSync(path.join(work, 'Alpha'));
  fs.mkdirSync(path.join(work, 'beta'));
  fs.writeFileSync(path.join(work, 'a-file.txt'), 'x');
  const configPath = path.join(root, 'config.toml');
  const remote = { mode: 'proxy', port: PORTS[0], preview_port: PORTS[1], admin_url: ADMIN_ORIGIN, preview_url: `https://${PREVIEW_HOST}`, bind: '127.0.0.1', trusted_proxies: ['127.0.0.2'] };
  const lines = ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vault}'`, `output = '${path.join(root, 'out')}'`, '', '[remote]'];
  for (const [k, v] of Object.entries(remote)) lines.push(`${k} = ${JSON.stringify(v)}`);
  fs.writeFileSync(configPath, `${lines.join('\n')}\n`);
  return { root, vault, work, configPath, panelDir: path.join(root, 'panel') };
}

async function startRemote(t, { clientAddress = '198.51.100.77' } = {}) {
  const fx = remoteFixture(t);
  await pwWrite.writePasswordRecord(path.join(fx.panelDir, 'password.json'), await pw.hashPassword(PASSWORD));
  const emitted = [];
  const signals = new EventEmitter();
  const done = runServeCommand({ config: fx.configPath, admin: true }, 'alpha', { emit: (l) => emitted.push(l), signals });
  let early = null;
  done.then((r) => {
    early = r;
  });
  const started = Date.now();
  while (!emitted.some((l) => /Press Ctrl-C to stop|open the admin panel link/.test(l))) {
    if (early) throw new Error(`panel exited early: ${JSON.stringify(early)}`);
    if (Date.now() - started > 10000) throw new Error(`panel did not start: ${emitted.join(' | ')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  const tokenLine = emitted.find((l) => /token=/.test(l));
  const adminPort = Number(/127\.0\.0\.1:(\d+)\/auth/.exec(tokenLine)[1]);
  const token = /token=(\S+)/.exec(tokenLine)[1];
  const proxy = await createTestProxy({ upstreamPort: adminPort, localAddress: '127.0.0.2', clientAddress });
  const env = { fx, adminPort, token, proxy, stopped: false };
  env.stop = async () => {
    if (env.stopped) return;
    env.stopped = true;
    signals.emit('SIGINT');
    await done;
    await proxy.close();
  };
  t.after(() => env.stop());
  const realSleep = remoteHandlers.timing.sleep;
  remoteHandlers.timing.sleep = async () => {};
  t.after(() => {
    remoteHandlers.timing.sleep = realSleep;
  });
  return env;
}

function remoteRequest(env, { method = 'GET', pathname, headers = {}, body }) {
  const h = { Host: ADMIN_HOST, ...headers };
  if (body !== undefined) h['Content-Length'] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: env.proxy.port, method, path: pathname, headers: h, setHost: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function remoteSession(env) {
  const res = await remoteRequest(env, { method: 'POST', pathname: '/auth/password', headers: { 'Content-Type': 'application/json', Origin: ADMIN_ORIGIN }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(res.status, 200, res.text);
  const raw = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('__Host-scriptorium_session='));
  return raw.split(';')[0];
}

const remoteGet = (env, cookie, query) => remoteRequest(env, { pathname: `/api/folders${query ? `?${query}` : ''}`, headers: { Cookie: cookie } });
const remotePost = (env, cookie, body) =>
  remoteRequest(env, { method: 'POST', pathname: '/api/folders/create', headers: { Cookie: cookie, Origin: ADMIN_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const loopbackGet = (env, query) =>
  request(env.adminPort, { pathname: `/api/folders${query ? `?${query}` : ''}`, headers: { Cookie: `scriptorium_admin_${env.adminPort}=${env.token}`, Host: `127.0.0.1:${env.adminPort}` } });

/** Counts filesystem calls aimed at a folder, on the process's real fs.promises (the panel runs in this process). */
function watchFs(t, folder) {
  const seen = [];
  for (const m of ['lstat', 'stat', 'opendir', 'realpath', 'mkdir']) {
    const real = fs.promises[m];
    fs.promises[m] = function watched(...args) {
      if (typeof args[0] === 'string' && (args[0] === folder || args[0].startsWith(folder + path.sep))) seen.push([m, args[0]]);
      return real.apply(this, args);
    };
    t.after(() => {
      fs.promises[m] = real;
    });
  }
  return seen;
}

test('M6/AC-08 remote: a listing writes exactly one folders line (before the listing) with via and from; a loopback listing writes none', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const cookie = await remoteSession(env);
  const before = auditLines(env.fx.configPath).length;
  const res = await remoteGet(env, cookie, q({ path: env.fx.work }));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text).entries.map((e) => e.name), ['Alpha', 'beta']);
  assert.equal(res.text.includes('a-file.txt'), false);
  const lines = auditLines(env.fx.configPath).slice(before);
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], t: undefined }, {
    t: undefined,
    event: 'folders',
    method: 'GET',
    route: '/api/folders',
    via: 'remote',
    from: '198.51.100.77',
    campaign: 'alpha',
  });

  const roots = await remoteGet(env, cookie, '');
  assert.equal(roots.status, 200);
  const rootLine = auditLines(env.fx.configPath).slice(before)[1];
  assert.equal(rootLine.event, 'folders');

  const count = auditLines(env.fx.configPath).length;
  assert.equal((await loopbackGet(env, q({ path: env.fx.work }))).status, 200);
  assert.equal(auditLines(env.fx.configPath).length, count, 'loopback listings are not audited');

  const head = await remoteRequest(env, { method: 'HEAD', pathname: `/api/folders?${q({ path: env.fx.work })}`, headers: { Cookie: cookie } });
  assert.equal(head.status, 200);
  assert.equal(auditLines(env.fx.configPath).length, count + 1, 'a HEAD is audited too');
});

test('M6/E3 remote: with the audit log unwritable a listing is refused 503 before the filesystem is touched; loopback still lists', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const cookie = await remoteSession(env);
  const log = path.join(env.fx.panelDir, 'audit.log');
  fs.rmSync(log, { force: true });
  fs.mkdirSync(log);
  const seen = watchFs(t, env.fx.work);
  const res = await remoteGet(env, cookie, q({ path: env.fx.work }));
  assert.equal(res.status, 503);
  assert.equal(res.text, AUDIT_503);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.deepEqual(seen, [], 'nothing was listed');
  const loop = await loopbackGet(env, q({ path: env.fx.work }));
  assert.equal(loop.status, 200);
  assert.equal(seen.length > 0, true, 'the watcher does see a real listing');
});

test('AC-08 remote: a create is audited as a request and a response; it works from a remote session', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const cookie = await remoteSession(env);
  const before = auditLines(env.fx.configPath).length;
  const res = await remotePost(env, cookie, { parent: env.fx.work, name: 'Remote Made' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(JSON.parse(res.text), { created: true, path: path.join(env.fx.work, 'Remote Made') });
  assert.equal(fs.statSync(path.join(env.fx.work, 'Remote Made')).isDirectory(), true);
  const lines = auditLines(env.fx.configPath).slice(before);
  assert.deepEqual(lines.map((l) => l.event), ['request', 'response']);
  for (const l of lines) {
    assert.equal(l.via, 'remote');
    assert.equal(l.from, '198.51.100.77');
  }
  assert.equal(lines[1].status, 200);
  const inVault = await remotePost(env, cookie, { parent: env.fx.vault, name: 'x' });
  assert.equal(inVault.status, 409);
  assert.deepEqual(JSON.parse(inVault.text), { error: 'inside-vault' });
});

test('E3 remote: with the audit log unwritable a create is refused 503 and nothing is made; a loopback create still works', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const cookie = await remoteSession(env);
  const log = path.join(env.fx.panelDir, 'audit.log');
  fs.rmSync(log, { force: true });
  fs.mkdirSync(log);
  const res = await remotePost(env, cookie, { parent: env.fx.work, name: 'Nope' });
  assert.equal(res.status, 503);
  assert.equal(res.text, AUDIT_503);
  assert.equal(fs.existsSync(path.join(env.fx.work, 'Nope')), false);
  const loop = await request(env.adminPort, {
    method: 'POST',
    pathname: '/api/folders/create',
    headers: { Cookie: `scriptorium_admin_${env.adminPort}=${env.token}`, Host: `127.0.0.1:${env.adminPort}`, Origin: `http://127.0.0.1:${env.adminPort}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: env.fx.work, name: 'Loop' }),
  });
  assert.equal(loop.status, 200, loop.text);
  assert.equal(fs.existsSync(path.join(env.fx.work, 'Loop')), true);
});

test('a remote request with no session, or a create from a foreign origin, is refused', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const cookie = await remoteSession(env);
  assert.equal((await remoteRequest(env, { pathname: '/api/folders' })).status, 403);
  const foreign = await remoteRequest(env, {
    method: 'POST',
    pathname: '/api/folders/create',
    headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: env.fx.work, name: 'Evil' }),
  });
  assert.equal(foreign.status, 403);
  assert.equal(fs.existsSync(path.join(env.fx.work, 'Evil')), false);
});
