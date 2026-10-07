'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { scratchRoot, copySample, configPathIn } = require('./helpers/setup-fixtures');

const { runServeCommand } = require('../src/cli/serve');
const { startAdminPanel } = require('../src/cli/serve-admin');
const { startLocalListener } = require('../src/serve/server');
const { ADMIN_ROUTES } = require('../src/admin/router');
const { writeConfigFile } = require('../src/config/write');

/*
 * Browser setup over real sockets (port 0, loopback only): `serve --admin` with no campaign starts
 * setup mode, serves only the setup routes, commits through the shared writers and hands over to
 * the normal panel in the same process. Expected bodies and messages are written out by hand.
 */

const SETUP_LINE = 'setup: no campaign yet, so the panel starts with setup';
const FENCE_BODY = '{"error":"setup","message":"There is no campaign yet. Finish setup first."}';
const ADMIN_ASSETS = path.join(__dirname, '..', 'assets', 'admin');

// --- harness ------------------------------------------------------------------------

function cfgRoot(t) {
  const root = scratchRoot(t);
  return { root, configPath: configPathIn(root) };
}

function tokenFromLine(line) {
  return /token=([A-Za-z0-9_-]{43})$/.exec(line)[1];
}

/** runServeCommand with real loopback listeners, recording every listener call and every line. */
function launch(t, flags, campaignArg, extra = {}) {
  const handles = [];
  const localCalls = [];
  const panelCalls = [];
  const emitted = [];
  const signals = new EventEmitter();
  const resultPromise = runServeCommand({ admin: true, ...flags }, campaignArg, {
    emit: (l) => emitted.push(l),
    signals,
    startLocalListener: async (handler, opts) => {
      localCalls.push(opts);
      const h = await startLocalListener(handler, opts);
      handles.push(h);
      return h;
    },
    startPanelListener: async (...args) => {
      panelCalls.push(args);
      throw new Error('setup mode must never open a remote listener');
    },
    ...extra,
  });
  t.after(async () => {
    for (const h of handles) {
      try {
        await h.close();
      } catch {
        // already closed
      }
    }
  });
  return { resultPromise, handles, localCalls, panelCalls, emitted, signals };
}

async function waitFor(fn, what, ms = 8000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function stopRun(run) {
  run.signals.emit('SIGINT');
  return run.resultPromise;
}

/** startAdminPanel directly, so a test can reach ctx. */
async function startPanel(t, flags, campaignArg) {
  const handles = [];
  const emitted = [];
  const result = await startAdminPanel({ admin: true, ...flags }, campaignArg, {
    emit: (l) => emitted.push(l),
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
  const port = result.ctx.adminPort;
  return { ...result, emitted, port, previewPort: result.ctx.previewPort, cookie: `scriptorium_admin_${port}=${result.token}`, origin: `http://127.0.0.1:${port}` };
}

function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const get = (h, pathname, headers = {}) => request(h.port, { pathname, headers: { Cookie: h.cookie, ...headers } });
const post = (h, pathname, obj, headers = {}) =>
  request(h.port, {
    method: 'POST',
    pathname,
    headers: { Cookie: h.cookie, Origin: h.origin, 'Content-Type': 'application/json', ...headers },
    body: obj === undefined ? undefined : typeof obj === 'string' ? obj : JSON.stringify(obj),
  });
const json = (res) => JSON.parse(res.body.toString('utf8'));

function answers(root, extra = {}) {
  return { name: 'lease', vault: path.join(root, 'vault'), output: path.join(root, 'lease-site'), ...extra };
}

// --- AC-A01: entry --------------------------------------------------------------------

test('A01: setup mode starts for a missing explicit --config, with the usual lines first and one setup line after them', async (t) => {
  const { configPath } = cfgRoot(t);
  const run = launch(t, { config: configPath });
  await waitFor(() => run.emitted.includes(SETUP_LINE), 'the setup line');
  assert.match(run.emitted[0], /^admin panel: http:\/\/127\.0\.0\.1:\d+\/auth\?token=[A-Za-z0-9_-]{43}$/, 'the token line stays first');
  assert.equal(run.emitted[run.emitted.length - 1], SETUP_LINE);
  assert.equal(run.emitted.filter((l) => l === SETUP_LINE).length, 1);
  assert.equal(fs.existsSync(configPath), false, 'starting setup writes nothing');
  const result = await stopRun(run);
  assert.deepEqual(result, { exitCode: 0, human: 'stopped.' });
});

test('A01: the lines before the setup line are exactly the lines a normal start prints (ports and token aside)', async (t) => {
  const a = cfgRoot(t);
  const setupRun = launch(t, { config: a.configPath });
  await waitFor(() => setupRun.emitted.includes(SETUP_LINE), 'setup lines');

  const b = cfgRoot(t);
  const vault = copySample(b.root, 'vault', { withPack: true });
  fs.mkdirSync(path.dirname(b.configPath), { recursive: true });
  writeConfigFile(b.configPath, { config_version: 1, default_campaign: 'x', campaigns: { x: { vault, output: path.join(b.root, 'o') } } });
  const normalRun = launch(t, { config: b.configPath });
  await waitFor(() => normalRun.emitted.length >= 2, 'normal lines');

  const norm = (lines) => lines.map((l) => l.replace(/:\d+/g, ':<port>').replace(/token=[A-Za-z0-9_-]{43}/, 'token=<token>'));
  assert.deepEqual(norm(setupRun.emitted.slice(0, -1)), norm(normalRun.emitted));
  await stopRun(setupRun);
  await stopRun(normalRun);
});

test('A01: setup mode starts for a config with zero campaigns', async (t) => {
  const { configPath } = cfgRoot(t);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'config_version = 1\n');
  const run = launch(t, { config: configPath });
  await waitFor(() => run.emitted.includes(SETUP_LINE), 'the setup line');
  await stopRun(run);
});

test('A01: setup mode starts when no --config is given and the environment config does not exist', async (t) => {
  const { configPath } = cfgRoot(t);
  const saved = process.env.SCRIPTORIUM_CONFIG;
  process.env.SCRIPTORIUM_CONFIG = configPath;
  t.after(() => {
    if (saved === undefined) delete process.env.SCRIPTORIUM_CONFIG;
    else process.env.SCRIPTORIUM_CONFIG = saved;
  });
  const run = launch(t, {});
  await waitFor(() => run.emitted.includes(SETUP_LINE), 'the setup line');
  await stopRun(run);
});

test('A01: with --json the readiness line gains setup:true, and a normal start has no such key', async (t) => {
  const a = cfgRoot(t);
  const run = launch(t, { config: a.configPath, json: true });
  const readyLine = await waitFor(() => run.emitted.find((l) => l.includes('"event":"ready"')), 'ready');
  const ready = JSON.parse(readyLine);
  assert.equal(ready.setup, true);
  assert.deepEqual(Object.keys(ready).sort(), ['adminPort', 'adminUrl', 'event', 'mode', 'previewPort', 'previewUrl', 'setup']);
  await stopRun(run);

  const b = cfgRoot(t);
  const vault = copySample(b.root, 'vault', { withPack: true });
  fs.mkdirSync(path.dirname(b.configPath), { recursive: true });
  writeConfigFile(b.configPath, { config_version: 1, default_campaign: 'x', campaigns: { x: { vault, output: path.join(b.root, 'o') } } });
  const normal = launch(t, { config: b.configPath, json: true });
  const normalReady = JSON.parse(await waitFor(() => normal.emitted.find((l) => l.includes('"event":"ready"')), 'ready'));
  assert.equal('setup' in normalReady, false);
  await stopRun(normal);
});

test('A01: an unknown campaign argument, --campaign, and plain serve keep exit 3 and their messages when none is registered', async (t) => {
  const { configPath } = cfgRoot(t);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'config_version = 1\n');
  await assert.rejects(() => runServeCommand({ admin: true, config: configPath }, 'ghost', { emit() {} }), (err) => {
    assert.match(err.message, /no campaign named "ghost"/);
    assert.equal(err.name, 'VaultUnreachableError');
    return true;
  });
  await assert.rejects(() => runServeCommand({ admin: true, config: configPath, campaign: 'ghost' }, undefined, { emit() {} }), /no campaign named "ghost"/);
  await assert.rejects(() => runServeCommand({ config: configPath }, undefined, { emit() {} }), /no campaigns registered; run "gm-scriptorium config add" first/);
});

test('A01: --vault is refused in setup mode with one plain line (exit 1), and nothing listens', async (t) => {
  const { configPath } = cfgRoot(t);
  let listened = 0;
  await assert.rejects(
    () =>
      runServeCommand({ admin: true, config: configPath, vault: '/somewhere' }, undefined, {
        emit() {},
        startLocalListener: async () => {
          listened++;
          throw new Error('should not listen');
        },
      }),
    (err) => {
      assert.equal(err.name, 'ConfigError');
      assert.equal(err.message, 'serve --admin does not accept --vault while no campaign is registered; browser setup starts instead');
      return true;
    },
  );
  assert.equal(listened, 0);
});

// --- AC-A02: loopback only, per mode ---------------------------------------------------

const MODES = {
  local: null,
  ssh: { mode: 'ssh', port: 7930, preview_port: 7931 },
  tailscale: { mode: 'tailscale', port: 7926, preview_port: 7927, admin_url: 'https://panel-host.example-tailnet.ts.net', preview_url: 'https://panel-host.example-tailnet.ts.net:8443' },
  proxy: { mode: 'proxy', port: 7924, preview_port: 7925, admin_url: 'https://scriptorium.home.arpa', preview_url: 'https://preview.scriptorium.home.arpa', bind: '127.0.0.1', trusted_proxies: ['127.0.0.2'] },
  direct: { mode: 'direct', port: 7928, preview_port: 7929, bind: '127.0.0.1', tls: 'generated' },
};

for (const [mode, table] of Object.entries(MODES)) {
  test(`A02: with [remote] mode ${mode}, setup opens only the two loopback listeners (OS-assigned ports), runs no readiness check, and names the deferred mode`, async (t) => {
    const { configPath } = cfgRoot(t);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const lines = ['config_version = 1', ''];
    if (table) {
      lines.push('[remote]');
      for (const [k, v] of Object.entries(table)) lines.push(`${k} = ${JSON.stringify(v)}`);
    }
    fs.writeFileSync(configPath, `${lines.join('\n')}\n`);
    const run = launch(t, { config: configPath });
    await waitFor(() => run.emitted.includes(SETUP_LINE), 'the setup line');
    assert.equal(run.panelCalls.length, 0, 'startPanelListener was never called');
    assert.equal(run.localCalls.length, 2, 'admin and preview, on the loopback listener');
    assert.deepEqual(run.localCalls.map((c) => c.port), [0, 0], 'OS-assigned ports, never the saved ones');
    const deferred = `setup mode listens on 127.0.0.1 only; remote access (mode ${mode}) starts the next time GM-Scriptorium starts`;
    if (mode === 'local') {
      assert.equal(run.emitted.some((l) => l.includes('remote access (mode')), false);
    } else {
      assert.equal(run.emitted.filter((l) => l === deferred).length, 1);
      assert.ok(run.emitted.indexOf(deferred) < run.emitted.findIndex((l) => l.startsWith('admin panel: ')), 'the line comes before any listener opens');
    }
    await stopRun(run);
  });
}

test('A02: a [remote] table that does not parse never stops setup', async (t) => {
  const { configPath } = cfgRoot(t);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'config_version = 1\n\n[remote]\nmode = "proxy"\nport = "nope"\n');
  const run = launch(t, { config: configPath });
  await waitFor(() => run.emitted.includes(SETUP_LINE), 'the setup line');
  assert.equal(run.panelCalls.length, 0);
  await stopRun(run);
});

// --- AC-A03: the fence ----------------------------------------------------------------

test('A03: GET / serves the setup page and GET /setup too; a request without the session gets the locked page for / and /setup, text for the rest', async (t) => {
  const { configPath } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath });
  const page = fs.readFileSync(path.join(ADMIN_ASSETS, 'setup.html'));
  for (const p of ['/', '/setup']) {
    const res = await get(h, p);
    assert.equal(res.status, 200, p);
    assert.deepEqual(res.body, page, p);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  }
  const locked = fs.readFileSync(path.join(ADMIN_ASSETS, 'locked.html'));
  for (const p of ['/', '/setup']) {
    const res = await request(h.port, { pathname: p });
    assert.equal(res.status, 403, p);
    assert.deepEqual(res.body, locked, p);
  }
  for (const p of ['/api/setup/state', '/api/setup/check']) {
    const res = await request(h.port, { pathname: p });
    assert.equal(res.status, 403, p);
    assert.equal(res.body.toString(), 'refused: token', p);
  }
});

test('A03: every route outside the setup list answers 409 with the fixed JSON body, never a 500 (the table is swept)', async (t) => {
  const { configPath } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath });
  const allowed = new Set(['GET /auth', 'GET /', 'GET /api/session', 'GET /setup', 'GET /api/setup/state', 'GET /api/setup/check', 'POST /api/setup/commit']);
  const seen = [];
  for (const r of ADMIN_ROUTES.filter((x) => x.path !== undefined)) {
    const key = `${r.method} ${r.path}`;
    if (allowed.has(key)) continue;
    if (key === 'POST /auth/password') {
      // The gate refuses the password route for a loopback request before any route runs (unchanged).
      assert.equal((await post(h, r.path, {})).status, 403, key);
      continue;
    }
    const res = r.method === 'POST' ? await post(h, r.path, {}) : await get(h, r.path);
    assert.equal(res.status, 409, key);
    assert.equal(res.body.toString(), FENCE_BODY, key);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8', key);
    seen.push(key);
  }
  assert.ok(seen.length >= 25, `swept ${seen.length} routes`);
  assert.ok(seen.includes('GET /api/state') && seen.includes('POST /api/preview') && seen.includes('POST /api/pack/theme') && seen.includes('POST /api/welcome/dismiss'));
});

test('A03: session and Origin: setup POSTs need the exact Origin; setup GETs need the session', async (t) => {
  const { root, configPath } = cfgRoot(t);
  copySample(root);
  const h = await startPanel(t, { config: configPath });
  const noOrigin = await request(h.port, { method: 'POST', pathname: '/api/setup/commit', headers: { Cookie: h.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.toString(), 'refused: origin');
  const foreign = await post(h, '/api/setup/commit', {}, { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.toString(), 'refused: origin');
  const noCookie = await request(h.port, { method: 'POST', pathname: '/api/setup/commit', headers: { Origin: h.origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCookie.status, 403);
  assert.equal(noCookie.body.toString(), 'refused: token');
  assert.equal(fs.existsSync(configPath), false);
});

test('A03: the setup handlers refuse a remote-kind request with 403 (defence in depth: the gate never lets one through in setup mode)', async () => {
  const handlers = require('../src/admin/handlers/setup');
  for (const name of ['setupPage', 'state', 'check', 'commit', 'welcomeDismiss']) {
    const res = fakeRes();
    await handlers[name]({ headers: {}, method: 'GET' }, res, { setup: { active: true }, audit: null }, { kind: 'remote', query: new URLSearchParams(), pathname: '/x', isHead: false });
    assert.equal(res.status, 403, name);
    assert.match(res.body, /"error":"forbidden"/, name);
  }
});

function fakeRes() {
  return {
    status: null,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(b) {
      this.body = b === undefined ? '' : String(b);
    },
  };
}

test('A03: a bad commit is audited as a request then a response with the route and no body content', async (t) => {
  const { root, configPath } = cfgRoot(t);
  copySample(root);
  const h = await startPanel(t, { config: configPath });
  const res = await post(h, '/api/setup/commit', answers(root, { name: 'Bad Name' }));
  assert.equal(res.status, 400);
  const auditFile = path.join(path.dirname(configPath), 'panel', 'audit.log');
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const mine = lines.filter((l) => l.route === '/api/setup/commit');
  assert.deepEqual(mine.map((l) => l.event), ['request', 'response']);
  assert.equal(mine[0].method, 'POST');
  assert.equal(mine[1].status, 400);
  assert.equal(mine[0].via, 'loopback');
  assert.ok(!fs.readFileSync(auditFile, 'utf8').includes('Bad Name'), 'no request content in the log');
});

// --- state, checks, commit over HTTP ------------------------------------------------------

test('state: reports setup active with the config path, the three themes, the default and the separator', async (t) => {
  const { configPath } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath });
  const res = await get(h, '/api/setup/state');
  assert.equal(res.status, 200);
  assert.deepEqual(json(res), {
    active: true,
    configPath,
    campaign: null,
    themes: ['plain', 'haze', 'gloam'],
    defaultTheme: 'gloam',
    remoteDeferred: null,
    welcome: false,
    sep: path.sep,
  });
});

test('state: names the deferred remote mode', async (t) => {
  const { configPath } = cfgRoot(t);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'config_version = 1\n\n[remote]\nmode = "ssh"\n');
  const h = await startPanel(t, { config: configPath });
  assert.equal(json(await get(h, '/api/setup/state')).remoteDeferred, 'ssh');
});

test('check: name, vault, output, title and theme answer over GET with the shared rules; unknown fields and oversize values are 400', async (t) => {
  const { root, configPath } = cfgRoot(t);
  const vault = copySample(root);
  const h = await startPanel(t, { config: configPath });
  const q = (params) => get(h, `/api/setup/check?${new URLSearchParams(params)}`);

  const name = json(await q({ field: 'name', value: 'Bad Name' }));
  assert.equal(name.state, 'bad');
  assert.equal(name.rule, 'invalid campaign name "Bad Name": use 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit');

  const v = json(await q({ field: 'vault', value: vault, name: 'lease' }));
  assert.equal(v.state, 'ok');
  assert.equal(v.facts.campaignTitle, 'The Long Lease');

  const o = json(await q({ field: 'output', value: path.join(vault, 'site'), name: 'lease', vault }));
  assert.equal(o.state, 'bad');
  assert.equal(o.rule, `refusing to build inside the vault: ${path.join(vault, 'site')}`);

  assert.equal(json(await q({ field: 'title', value: '', name: 'lease', vault })).state, 'bad');
  assert.equal(json(await q({ field: 'theme', value: '', name: 'lease', vault })).value, 'gloam');

  assert.equal((await q({ field: 'bogus', value: 'x' })).status, 400);
  assert.equal((await q({ value: 'x' })).status, 400);
  assert.equal((await q({ field: 'name', value: 'x'.repeat(5000) })).status, 400);
  assert.equal(fs.existsSync(configPath), false, 'checking writes nothing');
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'scriptorium')), false);
});

test('check: a UNC-looking vault with commit=0 is deferred, and the server touches nothing', async (t) => {
  const { configPath } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath });
  const calls = [];
  h.ctx.setup.probeDeps = { fsp: { stat: (...a) => (calls.push(a), Promise.reject(new Error('no'))), readdir: (...a) => (calls.push(a), Promise.reject(new Error('no'))) } };
  const res = await get(h, `/api/setup/check?${new URLSearchParams({ field: 'vault', value: '\\\\nas\\share\\vault', name: 'lease', commit: '0' })}`);
  assert.equal(json(res).state, 'deferred');
  assert.deepEqual(calls, []);
});

test('a hanging network check never delays another request: /api/session answers in under a second while a vault check is stuck', async (t) => {
  const { configPath } = cfgRoot(t);
  const h = await startPanel(t, { config: configPath });
  const pending = [];
  h.ctx.setup.probeDeps = {
    timeoutMs: 4000,
    fsp: {
      stat: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      readdir: () => new Promise(() => {}),
    },
  };
  t.after(() => pending.splice(0).forEach((p) => p.reject(Object.assign(new Error('x'), { code: 'ENOENT' }))));
  const stuck = get(h, `/api/setup/check?${new URLSearchParams({ field: 'vault', value: '//nas/share/vault', name: 'lease', commit: '1' })}`);
  await waitFor(() => pending.length > 0, 'the probe to start');
  const started = Date.now();
  const session = await get(h, '/api/session');
  const took = Date.now() - started;
  assert.equal(session.status, 200);
  assert.ok(took < 1000, `the session answered in ${took} ms`);
  // Release the hung call: the check settles as missing (not found) rather than hanging for ever.
  pending.splice(0).forEach((p) => p.reject(Object.assign(new Error('x'), { code: 'ENOENT' })));
  const done = json(await stuck);
  assert.equal(done.state, 'bad');
});

test('commit: bad JSON is 400, an unknown field is 400, a non-string answer is 400, and nothing is written', async (t) => {
  const { root, configPath } = cfgRoot(t);
  const vault = copySample(root);
  const h = await startPanel(t, { config: configPath });
  assert.equal((await post(h, '/api/setup/commit', '{nope')).status, 400);
  assert.equal((await post(h, '/api/setup/commit', answers(root, { extra: 1 }))).status, 400);
  assert.equal((await post(h, '/api/setup/commit', answers(root, { name: 7 }))).status, 400);
  assert.equal((await post(h, '/api/setup/commit', answers(root, { outputConfirmed: 'yes' }))).status, 400);
  assert.equal((await post(h, '/api/setup/commit', '[]')).status, 400);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'scriptorium')), false);
});

test('commit: an invalid answer is 400 with the field and the shared rule', async (t) => {
  const { root, configPath } = cfgRoot(t);
  copySample(root);
  const h = await startPanel(t, { config: configPath });
  const res = await post(h, '/api/setup/commit', answers(root, { theme: 'nonesuch' }));
  assert.equal(res.status, 400);
  assert.deepEqual(json(res), { error: 'invalid', field: 'theme', rule: 'unknown theme "nonesuch"; valid themes: gloam, haze, plain' });
});

test('commit: a config that gained a campaign meanwhile is refused as taken, with the config unchanged and no pack written', async (t) => {
  const { root, configPath } = cfgRoot(t);
  const vault = copySample(root);
  const other = copySample(root, 'other');
  const h = await startPanel(t, { config: configPath });
  writeConfigFile(configPath, { config_version: 1, default_campaign: 'first', campaigns: { first: { vault: other, output: path.join(root, 'first-site') } } });
  const before = fs.readFileSync(configPath, 'utf8');
  const res = await post(h, '/api/setup/commit', answers(root));
  assert.equal(res.status, 409);
  assert.deepEqual(json(res), { error: 'taken' });
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'scriptorium')), false);
});

// --- handover ----------------------------------------------------------------------------

async function commitOk(t, { vaultFix } = {}) {
  const { root, configPath } = cfgRoot(t);
  const vault = copySample(root);
  if (vaultFix) vaultFix(vault);
  const h = await startPanel(t, { config: configPath });
  const portsBefore = { admin: h.ctx.adminPort, preview: h.ctx.previewPort };
  const ctxBefore = h.ctx;
  const res = await post(h, '/api/setup/commit', answers(root));
  return { root, configPath, vault, h, res, portsBefore, ctxBefore };
}

test('handover: the commit answers 200 with what it did, then the same process serves the campaign on the same ports with the same cookie', async (t) => {
  const { root, configPath, vault, h, res, portsBefore, ctxBefore } = await commitOk(t);
  assert.equal(res.status, 200, res.body.toString());
  assert.deepEqual(json(res), {
    created: ['css/', 'images/', 'pack.toml', 'vault.config.json'],
    untouched: [],
    packDir: path.join(vault, '_meta', 'scriptorium'),
    configPath,
    isDefault: true,
    handover: 'ok',
  });
  assert.equal(h.ctx, ctxBefore, 'the handover mutates the one context the handlers closed over');
  assert.deepEqual({ admin: h.ctx.adminPort, preview: h.ctx.previewPort }, portsBefore);

  const state = await get(h, '/api/state');
  assert.equal(state.status, 200, state.body.toString());
  assert.equal(json(state).campaign, 'lease');
  assert.equal(json(await get(h, '/api/session')).campaign, 'lease');

  const root2 = await get(h, '/');
  assert.deepEqual(root2.body, fs.readFileSync(path.join(ADMIN_ASSETS, 'index.html')), '/ is the panel now');

  const setupPage = await get(h, '/setup');
  assert.equal(setupPage.status, 303);
  assert.equal(setupPage.headers.location, '/#/overview');
  const again = await post(h, '/api/setup/commit', answers(root));
  assert.equal(again.status, 409);
  assert.deepEqual(json(again), { error: 'setup-done' });
  const check = await get(h, '/api/setup/check?field=name&value=x');
  assert.equal(check.status, 409);
  assert.deepEqual(json(check), { error: 'setup-done' });
  assert.equal(fs.existsSync(path.join(root, 'lease-site')), false, 'registering never creates the output folder');
  assert.ok(fs.existsSync(configPath));
});

test('handover: a first check then a first preview build into the panel\'s preview folder, and the output folder is never created', async (t) => {
  const { root, h, res } = await commitOk(t);
  assert.equal(res.status, 200);
  const check = await post(h, '/api/check', {});
  assert.equal(check.status, 200);
  assert.equal(json(check).exitCode, 0, JSON.stringify(json(check)).slice(0, 400));
  const built = await post(h, '/api/preview', {});
  assert.equal(built.status, 200);
  assert.equal(json(built).exitCode, 0, JSON.stringify(json(built)).slice(0, 400));
  assert.ok(h.ctx.previewDir.startsWith(path.join(os.tmpdir(), 'scriptorium-preview-')));
  assert.ok(fs.existsSync(path.join(h.ctx.previewDir, 'index.html')));
  assert.equal(fs.existsSync(path.join(root, 'lease-site')), false);
  const previewRoot = h.ctx.previewRoot;
  await h.stop();
  assert.equal(fs.existsSync(previewRoot), false, 'stopping removes the preview folder');
});

test('handover: a vault with a check error gives a check error and a refused preview, never a ready screen', async (t) => {
  const { root, h, res } = await commitOk(t, { vaultFix: (v) => fs.writeFileSync(path.join(v, '_meta', 'stray.md'), '---\n---\n') });
  assert.equal(res.status, 200, 'registration is kept');
  const check = json(await post(h, '/api/check', {}));
  assert.equal(check.exitCode, 2);
  assert.ok(check.envelope.findings.some((f) => f.id === 'frontmatter/missing-type'));
  const built = json(await post(h, '/api/preview', {}));
  assert.equal(built.exitCode, 2, 'the preview is refused');
  assert.equal(fs.existsSync(path.join(root, 'lease-site')), false);
});

test('handover: a failed handover is reported as handover:failed with a message, and the registration stands', async (t) => {
  const { root, configPath } = cfgRoot(t);
  const vault = copySample(root);
  const h = await startPanel(t, { config: configPath });
  // Make the pack unusable after the commit has written it: the handover re-reads the campaign.
  const setupmode = require('../src/admin/setupmode');
  const original = setupmode.applyHandover;
  setupmode.applyHandover = () => {
    throw new Error('simulated handover failure');
  };
  t.after(() => {
    setupmode.applyHandover = original;
  });
  const res = await post(h, '/api/setup/commit', answers(root));
  assert.equal(res.status, 200);
  const body = json(res);
  assert.equal(body.handover, 'failed');
  assert.equal(body.message, 'simulated handover failure');
  assert.ok(fs.existsSync(path.join(vault, '_meta', 'scriptorium', 'pack.toml')), 'nothing is rolled back');
  assert.ok(fs.existsSync(configPath));
});

// --- the welcome ----------------------------------------------------------------------------

test('welcome: shown after a setup commit and not for an existing campaign; dismissed for good; not dismissable while setup is active', async (t) => {
  const { root, configPath } = cfgRoot(t);
  copySample(root);
  const h = await startPanel(t, { config: configPath });
  assert.equal((await post(h, '/api/welcome/dismiss', {})).status, 409, 'while setup is active');
  assert.equal(json(await get(h, '/api/setup/state')).welcome, false);

  assert.equal((await post(h, '/api/setup/commit', answers(root))).status, 200);
  const state = json(await get(h, '/api/setup/state'));
  assert.equal(state.active, false);
  assert.equal(state.campaign, 'lease');
  assert.equal(state.welcome, true);

  const dismissed = await post(h, '/api/welcome/dismiss', {});
  assert.equal(dismissed.status, 200);
  assert.deepEqual(json(dismissed), { ok: true });
  assert.equal(json(await get(h, '/api/setup/state')).welcome, false);
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(configPath), 'panel')).filter((f) => f === 'welcome.json'), ['welcome.json']);
});

test('welcome: a campaign that was registered before (not created by setup) never shows it', async (t) => {
  const { root, configPath } = cfgRoot(t);
  const vault = copySample(root, 'vault', { withPack: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfigFile(configPath, { config_version: 1, default_campaign: 'old', campaigns: { old: { vault, output: path.join(root, 'old-site') } } });
  const h = await startPanel(t, { config: configPath });
  const state = json(await get(h, '/api/setup/state'));
  assert.equal(state.active, false);
  assert.equal(state.welcome, false);
  assert.equal((await post(h, '/api/welcome/dismiss', {})).status, 200, 'a no-op, not an error');
  assert.equal((await get(h, '/setup')).status, 303);
});
