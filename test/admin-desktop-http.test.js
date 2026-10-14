'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const { makeCampaigns, startPanel, get, post } = require('./helpers/campaigns-panel');

/*
 * The desktop ports card's two routes over real sockets (docs/decisions/0057-windows-desktop-app.md,
 * section 8): GET /api/desktop and POST /api/desktop/ports. The panel runs in this process on
 * OS-chosen ports with a scratch config, and the desktop host is a stand-in that records the restart
 * it is asked for, so nothing here restarts a real panel. Expected values are written out by hand.
 */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaOf = (fx) => sha256(fs.readFileSync(fx.configPath));
const CONFIG_CHANGED = { error: 'config-changed', message: 'Your settings changed outside the panel. Reload and try again.' };

/** Lets the handler's setImmediate run. */
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The desktop host's stand-in: it records every restart request. */
function fakeDesktop(h, behaviour = () => Promise.resolve()) {
  const restarts = [];
  h.ctx.desktop = {
    requestRestart: (opts) => {
      restarts.push(opts);
      return behaviour(opts);
    },
    ports: { panel: h.port, preview: h.previewPort },
  };
  return restarts;
}

/** Pretends the panel was started in a remote mode (only the mode is read by these routes). */
function remoteMode(h, mode) {
  h.ctx.remote = { ...h.ctx.remote, settings: { ...h.ctx.remote.settings, mode } };
}

async function desktopPanel(t, extraConfig = '') {
  const fx = makeCampaigns(t, ['alpha']);
  if (extraConfig) fs.appendFileSync(fx.configPath, `\n${extraConfig}\n`);
  const h = await startPanel(t, { config: fx.configPath });
  const restarts = fakeDesktop(h);
  return { fx, h, restarts };
}

const body = (fx, over = {}) => ({ port: 7410, previewPort: 7411, configSha256: shaOf(fx), ...over });
const send = (h, b, opts = {}) => post(h, '/api/desktop/ports', b, { campaign: 'alpha', ...opts });

// ---- GET /api/desktop ---------------------------------------------------------------------------

test('GET /api/desktop outside the desktop app says so and nothing else', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const h = await startPanel(t, { config: fx.configPath });
  const res = await get(h, '/api/desktop');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { desktop: false });
});

test('GET /api/desktop under the desktop app: the listening ports, their addresses and the config sha256', async (t) => {
  const { fx, h } = await desktopPanel(t);
  const res = await get(h, '/api/desktop');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, {
    desktop: true,
    mode: 'local',
    editable: true,
    port: h.port,
    previewPort: h.previewPort,
    panelUrl: `http://127.0.0.1:${h.port}`,
    previewUrl: `http://127.0.0.1:${h.previewPort}`,
    configSha256: shaOf(fx),
  });
});

test('GET /api/desktop in a remote mode is read-only and names the ports the panel is on', async (t) => {
  const { h } = await desktopPanel(t);
  remoteMode(h, 'tailscale');
  const res = await get(h, '/api/desktop');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.mode, 'tailscale');
  assert.equal(res.json.editable, false);
  assert.equal(res.json.port, h.port);
  assert.equal(res.json.previewPort, h.previewPort);
});

test('GET /api/desktop needs a signed-in session', async (t) => {
  const { h } = await desktopPanel(t);
  const res = await get({ ...h, cookie: 'scriptorium_admin_1=nope' }, '/api/desktop');
  assert.notEqual(res.status, 200);
});

// ---- POST /api/desktop/ports: the good path -----------------------------------------------------

test('a good save writes [desktop] and nothing else, replies 200, and asks for one restart that opens the panel', async (t) => {
  const { fx, h, restarts } = await desktopPanel(t);
  const before = fs.readFileSync(fx.configPath, 'utf8');
  const res = await send(h, body(fx));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.port, 7410);
  assert.equal(res.json.previewPort, 7411);
  assert.equal(res.json.restarting, true);
  assert.equal(res.json.configSha256, shaOf(fx), 'the reply carries the sha256 of the file as written');
  const after = fs.readFileSync(fx.configPath, 'utf8');
  assert.match(after, /\[desktop\]\s*\nport = 7410\s*\npreview_port = 7411/);
  assert.equal(after.includes('[remote]'), false, '[remote] is never written');
  assert.equal(after.includes('alpha'), true);
  assert.notEqual(after, before);
  await settle();
  assert.deepEqual(restarts, [{ open: true }]);
});

test('a good save keeps the sign-in confirmation already in [desktop]', async (t) => {
  const { fx, h } = await desktopPanel(t, '[desktop]\nremote_at_signin = true');
  const res = await send(h, body(fx));
  assert.equal(res.status, 200, res.text);
  const after = fs.readFileSync(fx.configPath, 'utf8');
  assert.match(after, /remote_at_signin = true/);
  assert.match(after, /port = 7410/);
});

test('the restart is asked for after the handler has replied, never inside it', async (t) => {
  const { Readable } = require('stream');
  const desktop = require('../src/admin/handlers/desktop');
  const { fx, h } = await desktopPanel(t);
  const events = [];
  h.ctx.desktop.requestRestart = (opts) => {
    events.push(['restart', opts]);
    return Promise.resolve();
  };
  const payload = Buffer.from(JSON.stringify(body(fx)));
  const req = Object.assign(Readable.from([payload]), { headers: { 'content-type': 'application/json', 'content-length': String(payload.length) } });
  const res = {
    writeHead: (status) => events.push(['head', status]),
    end: () => events.push(['end']),
  };
  await desktop.savePorts(req, res, h.ctx);
  assert.deepEqual(events.map((e) => e[0]), ['head', 'end'], 'replied, and the restart is not asked for yet');
  await settle();
  assert.deepEqual(events.map((e) => e[0]), ['head', 'end', 'restart']);
  assert.deepEqual(events[2][1], { open: true });
});

test('a restart that fails or throws does not take the panel down, and the ports stay saved', async (t) => {
  for (const behaviour of [() => Promise.reject(new Error('boom')), () => { throw new Error('boom'); }]) {
    const fx = makeCampaigns(t, ['alpha']);
    const h = await startPanel(t, { config: fx.configPath });
    const restarts = fakeDesktop(h, behaviour);
    const res = await send(h, body(fx));
    assert.equal(res.status, 200, res.text);
    await settle();
    assert.equal(restarts.length, 1);
    assert.equal((await get(h, '/api/desktop')).status, 200, 'the panel still answers');
    assert.match(fs.readFileSync(fx.configPath, 'utf8'), /port = 7410/);
  }
});

// ---- POST /api/desktop/ports: refusals ----------------------------------------------------------

test('a bad body is 400 and writes and restarts nothing', async (t) => {
  const { fx, h, restarts } = await desktopPanel(t);
  const before = fs.readFileSync(fx.configPath);
  const sha = shaOf(fx);
  const bads = [
    {},
    [],
    { port: 7410, previewPort: 7411 },
    { port: 7410, configSha256: sha },
    { previewPort: 7411, configSha256: sha },
    { port: 7410, previewPort: 7411, configSha256: sha, extra: 1 },
    { port: '7410', previewPort: 7411, configSha256: sha },
    { port: 7410, previewPort: '7411', configSha256: sha },
    { port: 7410.5, previewPort: 7411, configSha256: sha },
    { port: null, previewPort: 7411, configSha256: sha },
    { port: 7410, previewPort: 7411, configSha256: 'abc' },
    { port: 7410, previewPort: 7411, configSha256: sha.toUpperCase() },
    { port: 7410, previewPort: 7411, configSha256: 5 },
  ];
  for (const bad of bads) {
    const res = await send(h, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.json.error, 'invalid');
  }
  assert.equal((await send(h, 'nope')).status, 400, 'not JSON');
  assert.equal((await send(h, JSON.stringify({ port: 'x'.repeat(200000) }))).status, 413, 'over the cap');
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
  await settle();
  assert.deepEqual(restarts, []);
});

test('outside the desktop app the route is 409 not-desktop, with the file untouched', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const h = await startPanel(t, { config: fx.configPath });
  const before = fs.readFileSync(fx.configPath);
  const res = await send(h, body(fx));
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'not-desktop');
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
});

test('in a remote mode the route is 409 remote-mode, with the file untouched and no restart', async (t) => {
  for (const mode of ['ssh', 'tailscale', 'proxy', 'direct']) {
    const { fx, h, restarts } = await desktopPanel(t);
    remoteMode(h, mode);
    const before = fs.readFileSync(fx.configPath);
    const res = await send(h, body(fx));
    assert.equal(res.status, 409, mode);
    assert.deepEqual(res.json, { error: 'remote-mode', message: 'Remote access uses its own ports. Change them with gm-scriptorium remote set.' });
    assert.deepEqual(fs.readFileSync(fx.configPath), before, mode);
    await settle();
    assert.deepEqual(restarts, [], mode);
  }
});

test('a changed config is 409 config-changed: the file is untouched and nothing restarts', async (t) => {
  const { fx, h, restarts } = await desktopPanel(t);
  const stale = shaOf(fx);
  fs.appendFileSync(fx.configPath, '\n# edited elsewhere\n');
  const before = fs.readFileSync(fx.configPath);
  const res = await send(h, body(fx, { configSha256: stale }));
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, CONFIG_CHANGED);
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
  await settle();
  assert.deepEqual(restarts, []);
});

test('ports the config cannot hold are 409 config-invalid with the file untouched and no restart', async (t) => {
  const cases = [
    [{ port: 7410, previewPort: 7410 }, 'must differ'],
    [{ port: 0, previewPort: 7411 }, 'from 1 to 65535'],
    [{ port: 7410, previewPort: 65536 }, 'from 1 to 65535'],
    [{ port: -5, previewPort: 7411 }, 'from 1 to 65535'],
  ];
  for (const [ports, text] of cases) {
    const { fx, h, restarts } = await desktopPanel(t);
    const before = fs.readFileSync(fx.configPath);
    const res = await send(h, body(fx, ports));
    assert.equal(res.status, 409, JSON.stringify(ports));
    assert.equal(res.json.error, 'config-invalid');
    assert.ok(res.json.message.includes(text), res.json.message);
    assert.deepEqual(fs.readFileSync(fx.configPath), before);
    await settle();
    assert.deepEqual(restarts, [], JSON.stringify(ports));
  }
});

test('an unreadable [desktop] table is left as found: 409 config-invalid, no restart', async (t) => {
  const { fx, h, restarts } = await desktopPanel(t, '[desktop]\nport = "7400"');
  const before = fs.readFileSync(fx.configPath);
  const res = await send(h, body(fx));
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, 'config-invalid');
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
  await settle();
  assert.deepEqual(restarts, []);
});

test('a write already under way is 409 busy and nothing is written', async (t) => {
  const { fx, h, restarts } = await desktopPanel(t);
  h.ctx.busy = 'write';
  const before = fs.readFileSync(fx.configPath);
  const res = await send(h, body(fx));
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'busy', busy: 'write' });
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
  h.ctx.busy = null;
  await settle();
  assert.deepEqual(restarts, []);
});

test('the route is a campaign-bound, audited POST: a wrong Origin is refused before the handler', async (t) => {
  const { fx, h, restarts } = await desktopPanel(t);
  const before = fs.readFileSync(fx.configPath);
  const res = await post({ ...h, origin: 'http://evil.example' }, '/api/desktop/ports', body(fx), { campaign: 'alpha' });
  assert.notEqual(res.status, 200);
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
  await settle();
  assert.deepEqual(restarts, []);
});
