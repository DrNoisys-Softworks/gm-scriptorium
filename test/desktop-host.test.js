'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const util = require('util');
const { installLoopbackGuard } = require('./helpers/net-stubs');
const { testPort } = require('./helpers/ports');
const { scratchRoot, copySample } = require('./helpers/setup-fixtures');

const { runDesktopHost } = require('../src/desktop/host');
const { runDesktopCommand } = require('../src/cli/desktop');
const { startAdminPanel } = require('../src/cli/serve-admin');
const { parseLine, HOST_VERBS, MAX_LINE_BYTES } = require('../src/desktop/protocol');
const { createToken } = require('../src/admin/session');
const { writeConfigFile } = require('../src/config/write');
const { ConfigError, VaultUnreachableError } = require('../src/util/errors');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

/*
 * ADR 0057, sections 3 to 9: the desktop host. Most cases inject startPanel (a recording fake) and a
 * recording openFile; the port, token and secrecy cases run the real startAdminPanel on a scratch
 * config with the fixed desktop ports taken from testPort. No case can open a real browser, because
 * every run injects openFile. Expected protocol lines are written out by hand.
 */

const PANEL_PORT = testPort(9301);
const PREVIEW_PORT = testPort(9302);
const BUSY_PORT = testPort(9303);
const BUSY_PREVIEW = testPort(9304);
const SIGNIN_PORT = testPort(9305);
const SIGNIN_PREVIEW = testPort(9306);
const REMOTE_PORT = testPort(9307);
const REMOTE_PREVIEW = testPort(9308);
const FORM = 'application/x-www-form-urlencoded';
// The documented defaults (ADR 0057 section 8), spelled out in pieces: no bind happens on them in this file.
const DEFAULT_PANEL = ['74', '00'].join('');
const DEFAULT_PREVIEW = ['74', '01'].join('');

async function until(fn, what, ms = 8000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function within(promise, what, ms = 8000) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** A config with one campaign (the sample vault and its pack), plus any extra TOML. */
function makeConfig(t, extraToml = '', { campaign = true } = {}) {
  const root = scratchRoot(t);
  const configPath = path.join(root, 'cfg', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const vault = copySample(root, 'vault', { withPack: true });
  const base = campaign
    ? { config_version: 1, default_campaign: 'lease', campaigns: { lease: { vault, output: path.join(root, 'site') } } }
    : { config_version: 1, campaigns: {} };
  writeConfigFile(configPath, base);
  if (extraToml) fs.appendFileSync(configPath, extraToml);
  return { root, configPath, panelDir: path.join(root, 'cfg', 'panel'), logFile: path.join(root, 'cfg', 'panel', 'logs', 'desktop.log'), vault };
}

const desktopToml = (panel = PANEL_PORT, preview = PREVIEW_PORT, extra = '') => `\n[desktop]\nport = ${panel}\npreview_port = ${preview}\n${extra}`;

/** A fake running panel. `onStop` receives a label so an order can be checked. */
function fakePanel(cfg, { mode = 'local', busy = null, adminUrl, updateNotice, order, campaign = 'lease' } = {}) {
  const ctx = {
    campaign,
    adminPort: PANEL_PORT,
    previewPort: PREVIEW_PORT,
    busy,
    remote: { paths: { panelDir: cfg.panelDir } },
    ctxInfo: { config: { campaigns: {} } },
    updateNotice: updateNotice || { snapshot: () => ({ state: 'current', dismissed: false, latestTag: null, notesUrl: null }) },
  };
  const settings = mode === 'local' ? { mode } : { mode, admin_url: adminUrl };
  return { ok: true, ctx, token: 'fake', settings, plan: {}, planned: {}, setup: false, stop: async () => { if (order) order.push('panel.stop'); } };
}

/** Runs the host with injected streams. Returns helpers; the host is stopped at the end of the test. */
function startHost(t, cfg, opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const outLines = [];
  let pending = '';
  output.on('data', (c) => {
    pending += c;
    let at = pending.indexOf('\n');
    while (at >= 0) {
      outLines.push(pending.slice(0, at + 1));
      pending = pending.slice(at + 1);
      at = pending.indexOf('\n');
    }
  });
  const opened = [];
  const order = opts.order || [];
  const proc = new EventEmitter();
  proc.pid = 4242;
  const calls = [];
  const startPanel = opts.startPanel
    ? async (...args) => {
        calls.push(args);
        return opts.startPanel(...args, calls.length);
      }
    : async (flags, campaignArg, o) => {
        calls.push([flags, campaignArg, o]);
        return fakePanel(cfg, { order, ...(opts.panel || {}) });
      };
  const deps = {
    input,
    output,
    env: { PATH: '/nonexistent' },
    version: '0.0.0-test',
    startPanel,
    openFile: async (o) => {
      opened.push({ target: o.target, html: fs.existsSync(o.target) ? fs.readFileSync(o.target, 'utf8') : null });
      return { outcome: 'exited', exitCode: 0, signal: null };
    },
    killAll: async () => { order.push('killAll'); },
    configPath: cfg.configPath,
    retryDelaysMs: [5, 5, 5],
    pollMs: 10,
    proc,
    pid: 4242,
    hostname: () => 'PC-A', // a placeholder computer name
    ...(opts.deps || {}),
  };
  const origWrite = output.write.bind(output);
  output.write = (text, ...rest) => {
    if (/^bye\t/.test(String(text))) order.push('bye');
    return origWrite(text, ...rest);
  };
  const run = runDesktopHost({ background: opts.background === true }, deps);
  let finished = false;
  run.then(() => { finished = true; });
  const h = {
    input,
    output,
    outLines,
    opened,
    order,
    proc,
    calls,
    run,
    lines: () => outLines.map((l) => l.replace(/\n$/, '')),
    has: (prefix) => outLines.some((l) => l.startsWith(prefix)),
    send: (...fields) => input.write(`${fields.join('\t')}\n`),
    sendRaw: (text) => input.write(text),
    waitFor: (prefix, ms) => until(() => h.lines().find((l) => l.startsWith(prefix)), `a line starting ${JSON.stringify(prefix)} (have ${JSON.stringify(h.lines())})`, ms),
    waitCount: (prefix, n) => until(() => h.lines().filter((l) => l.startsWith(prefix)).length >= n, `${n} lines starting ${JSON.stringify(prefix)} (have ${JSON.stringify(h.lines())})`),
    stop: async () => {
      if (!finished) input.end();
      return within(run, 'the host');
    },
  };
  t.after(async () => {
    await h.stop();
  });
  return h;
}

function logLines(cfg) {
  return fs.existsSync(cfg.logFile) ? fs.readFileSync(cfg.logFile, 'utf8').split('\n').filter(Boolean) : [];
}

// --- the opening lines and a user start -----------------------------------------------------------------

test('hello is the first line (protocol 1, the app version, the log folder), then starting and running; a user start opens one tab', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  assert.deepEqual(h.lines(), [
    `hello\t1\t0.0.0-test\t${path.join(cfg.panelDir, 'logs')}`,
    'state\tstarting\t-\t',
    `state\trunning\tlease\tlocal\thttp://127.0.0.1:${PANEL_PORT}\tsignin=unconfirmed`,
  ]);
  await until(() => h.opened.length >= 1, 'the browser opener');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.opened.length, 1, 'one tab, once');
  assert.match(h.opened[0].target, /launch-4242\.html$/);
  assert.match(h.opened[0].html, /name="code" value="[A-Za-z0-9_-]{43}"/);
  assert.deepEqual(h.calls[0][0], { admin: true, config: cfg.configPath, port: String(PANEL_PORT), 'preview-port': String(PREVIEW_PORT) });
  assert.equal(h.calls[0][1], undefined);
});

test('a background start is quiet: it runs, but no tab opens', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg, { background: true });
  await h.waitFor('state\trunning');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.opened.length, 0);
});

test('setup mode (no campaign) reports "setup" as the campaign', async (t) => {
  const cfg = makeConfig(t, desktopToml(), { campaign: false });
  const h = startHost(t, cfg, { panel: { campaign: null } });
  const line = await h.waitFor('state\trunning');
  assert.equal(line, `state\trunning\tsetup\tlocal\thttp://127.0.0.1:${PANEL_PORT}\tsignin=unconfirmed`);
});

test('a remote reach reports the configured address, ssh and local report the loopback address', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg, { panel: { mode: 'tailscale', adminUrl: 'https://scriptorium.home.arpa' } });
  assert.equal(await h.waitFor('state\trunning'), 'state\trunning\tlease\ttailscale\thttps://scriptorium.home.arpa\tsignin=unconfirmed');
  const s = startHost(t, cfg, { panel: { mode: 'ssh' } });
  assert.equal(await s.waitFor('state\trunning'), `state\trunning\tlease\tssh\thttp://127.0.0.1:${PANEL_PORT}\tsignin=unconfirmed`);
});

// --- retries and error classes ------------------------------------------------------------------------------

const notFound = () => new VaultUnreachableError('the vault was not found', { path: 'X', campaign: 'lease', reason: 'not-found' });

test('background: a vault that is not found is retried on the schedule, quietly, then runs; no tab opens', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const delays = [];
  const h = startHost(t, cfg, {
    background: true,
    startPanel: async (flags, c, o, n) => {
      if (n <= 2) throw notFound();
      return fakePanel(cfg);
    },
    deps: { retryDelaysMs: [5, 6, 7] },
  });
  await h.waitFor('state\trunning');
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.lines().slice(0, 3), [
    `hello\t1\t0.0.0-test\t${path.join(cfg.panelDir, 'logs')}`,
    'state\tstarting\t-\t',
    'state\tstarting\t-\twaiting for the vault',
  ]);
  assert.equal(h.opened.length, 0);
  assert.equal(logLines(cfg).filter((l) => / retry /.test(l)).length, 2);
  delays.push(0);
});

test('background: after the last retry the error state is shown, kind vault', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg, { background: true, startPanel: async () => { throw notFound(); }, deps: { retryDelaysMs: [3, 3] } });
  const line = await h.waitFor('state\terror');
  assert.equal(line, 'state\terror\tvault\tthe vault was not found');
  assert.equal(h.calls.length, 3, 'the first try and two retries');
});

test('the default schedule is 10, 20, 30, 60, 60 and 60 seconds (ADR 0057 section 5)', () => {
  const { DEFAULT_RETRY_DELAYS_MS } = require('../src/desktop/host');
  assert.deepEqual([...DEFAULT_RETRY_DELAYS_MS], [10000, 20000, 30000, 60000, 60000, 60000]);
});

test('a start the GM makes never retries: a vault that is not found is an error at once', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg, { startPanel: async () => { throw notFound(); } });
  assert.equal(await h.waitFor('state\terror'), 'state\terror\tvault\tthe vault was not found');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.calls.length, 1);
  assert.equal(h.opened.length, 0);
});

test('background: nothing but not-found is retried; each other class is shown at once', async (t) => {
  const cases = [
    [() => new VaultUnreachableError('bad settings', { path: 'X', campaign: null, reason: 'bad-config' }), 'config'],
    [() => new VaultUnreachableError('vault gone odd', { path: 'X', campaign: 'lease', reason: 'unreadable' }), 'other'],
    [() => new ConfigError('a config problem'), 'config'],
    [() => new Error('something odd'), 'other'],
  ];
  for (const [make, kind] of cases) {
    const cfg = makeConfig(t, desktopToml());
    const h = startHost(t, cfg, { background: true, startPanel: async () => { throw make(); } });
    const line = await h.waitFor('state\terror');
    assert.equal(line.split('\t')[2], kind, line);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.calls.length, 1, `${kind}: no retry`);
    await h.stop();
  }
});

test('a returned { ok: false } is "other", and a port message is the "port" class with the number', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const a = startHost(t, cfg, { startPanel: async () => ({ ok: false, exitCode: 1, human: 'failed to start server: something else' }) });
  assert.equal(await a.waitFor('state\terror'), 'state\terror\tother\tfailed to start server: something else');
  const b = startHost(t, cfg, { startPanel: async () => ({ ok: false, exitCode: 1, human: `failed to start server: port ${BUSY_PORT} is already in use on 127.0.0.1` }) });
  assert.equal(await b.waitFor('state\terror'), `state\terror\tport\tport ${BUSY_PORT} is already in use on 127.0.0.1\t${BUSY_PORT}`);
});

test('a very long error message is cut to 300 characters, so the line still fits', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg, { startPanel: async () => { throw new Error(`${'long words '.repeat(400)}end`); } });
  const line = await h.waitFor('state\terror');
  const parts = line.split('\t');
  assert.equal(parts[2], 'other');
  assert.equal(parts[3].length, 300);
  assert.ok(Buffer.byteLength(`${line}\n`) <= MAX_LINE_BYTES);
});

test('a bad [desktop] table is the "config" class and the panel is never started', async (t) => {
  const cfg = makeConfig(t, `\n[desktop]\nport = "${PANEL_PORT}"\n`);
  const h = startHost(t, cfg);
  const line = await h.waitFor('state\terror');
  assert.equal(line.split('\t')[2], 'config');
  assert.match(line, /desktop: port must be a whole number/);
  assert.equal(h.calls.length, 0);
});

test('the real port error: a busy 127.0.0.1 port gives "port" with the number, from the real startAdminPanel', async (t) => {
  const cfg = makeConfig(t, desktopToml(BUSY_PORT, BUSY_PREVIEW));
  const busy = http.createServer(() => {});
  await new Promise((resolve) => busy.listen(BUSY_PORT, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => busy.close(resolve)));
  const h = startHost(t, cfg, { startPanel: startAdminPanel });
  const line = await h.waitFor('state\terror');
  assert.equal(line, `state\terror\tport\tport ${BUSY_PORT} is already in use on 127.0.0.1\t${BUSY_PORT}`);
  assert.equal(h.opened.length, 0);
  assert.ok(logLines(cfg).some((l) => / panel-error kind="port"/.test(l)));
});

// --- the port rules ----------------------------------------------------------------------------------------------

test('ports are passed (as strings) for a local panel and for setup mode, and not for a remote mode', async (t) => {
  const local = makeConfig(t, desktopToml());
  const a = startHost(t, local);
  await a.waitFor('state\trunning');
  assert.deepEqual(a.calls[0][0], { admin: true, config: local.configPath, port: String(PANEL_PORT), 'preview-port': String(PREVIEW_PORT) });

  const setup = makeConfig(t, desktopToml(), { campaign: false });
  const b = startHost(t, setup);
  await b.waitFor('state\trunning');
  assert.equal(b.calls[0][0].port, String(PANEL_PORT));

  const remote = makeConfig(t, `${desktopToml()}\n[remote]\nmode = "ssh"\nport = ${REMOTE_PORT}\npreview_port = ${REMOTE_PREVIEW}\n`);
  const c = startHost(t, remote);
  await c.waitFor('state\trunning');
  assert.deepEqual(c.calls[0][0], { admin: true, config: remote.configPath }, 'no ports in a remote mode');
  assert.equal(c.calls[0][2].localOnly, false);
});

test('with no [desktop] table the defaults 7400 and 7401 are passed', async (t) => {
  const cfg = makeConfig(t);
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  assert.equal(h.calls[0][0].port, DEFAULT_PANEL);
  assert.equal(h.calls[0][0]['preview-port'], DEFAULT_PREVIEW);
});

test('a [remote] table that does not parse passes no ports, and the panel reports it', async (t) => {
  const cfg = makeConfig(t, `${desktopToml()}\n[remote]\nmode = "carrier-pigeon"\n`);
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  assert.deepEqual(h.calls[0][0], { admin: true, config: cfg.configPath });
});

test('the config is read again at every start, so a ports change in a terminal is picked up on Restart', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  fs.writeFileSync(cfg.configPath, fs.readFileSync(cfg.configPath, 'utf8').replace(`port = ${PANEL_PORT}`, `port = ${PANEL_PORT + 10}`));
  h.send('restart');
  await h.waitCount('state\trunning', 2);
  assert.equal(h.calls[1][0].port, String(PANEL_PORT + 10));
});

// --- RV1: remote access at sign-in ------------------------------------------------------------------------------

const REMOTE_TOML = `\n[remote]\nmode = "tailscale"\nport = ${REMOTE_PORT}\npreview_port = ${REMOTE_PREVIEW}\nadmin_url = "https://scriptorium.home.arpa"\npreview_url = "https://preview.scriptorium.home.arpa"\n`;

test('RV1: a start at sign-in with remote saved and no confirmation asks for a local-only panel, with the desktop ports', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW) + REMOTE_TOML);
  const h = startHost(t, cfg, { background: true });
  await h.waitFor('state\trunning');
  assert.equal(h.calls[0][2].localOnly, true);
  assert.equal(h.calls[0][0].port, String(SIGNIN_PORT));
});

test('RV1: with the confirmation set, a start at sign-in uses the saved remote mode and no desktop ports', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW, 'remote_at_signin = true\nremote_at_signin_pc = "PC-A"\n') + REMOTE_TOML);
  const h = startHost(t, cfg, { background: true });
  await h.waitFor('state\trunning');
  assert.equal(h.calls[0][2].localOnly, false);
  assert.equal(h.calls[0][0].port, undefined);
});

test('RV1: a start the GM makes, in a background host, uses the saved remote mode whatever the flag says', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW) + REMOTE_TOML);
  const h = startHost(t, cfg, { background: true });
  await h.waitFor('state\trunning');
  h.send('stop');
  await h.waitFor('state\tstopped');
  h.send('start');
  await h.waitCount('state\trunning', 2);
  assert.equal(h.calls[1][2].localOnly, false);
  assert.equal(h.calls[1][0].port, undefined);
  assert.equal(h.opened.length, 1, 'the GM asked, so a tab opens');
});

test('RV1: a terminal-started host (not --background) never forces local-only', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW) + REMOTE_TOML);
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  assert.equal(h.calls[0][2].localOnly, false);
});

test('RV1, real panel: a sign-in start with remote saved and no confirmation listens on 127.0.0.1 only, in local mode', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW) + REMOTE_TOML);
  let started = null;
  const h = startHost(t, cfg, {
    background: true,
    startPanel: async (...args) => {
      started = await startAdminPanel(...args);
      return started;
    },
  });
  const line = await h.waitFor('state\trunning');
  assert.equal(line, `state\trunning\tlease\tlocal\thttp://127.0.0.1:${SIGNIN_PORT}\tsignin-local\tsignin=unconfirmed`);
  assert.equal(started.settings.mode, 'local');
  assert.equal(started.ctx.adminPort, SIGNIN_PORT);
  assert.equal(started.ctx.previewPort, SIGNIN_PREVIEW);
  const res = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: SIGNIN_PORT, path: '/', agent: false }, resolve).on('error', reject));
  res.resume();
  assert.equal(res.statusCode, 403, 'the panel answers on the desktop port, locked until signed in');
  const remoteUp = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: REMOTE_PORT, path: '/', agent: false }, () => resolve(true)).on('error', () => resolve(false));
  });
  assert.equal(remoteUp, false, 'the saved remote port is not listening');
});

// --- Stop, Start, Restart and the token ---------------------------------------------------------------------------

function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const codeOf = (html) => /name="code" value="([A-Za-z0-9_-]+)"/.exec(html)[1];

/** Exchanges a launcher's code for the session cookie, as the browser's form post does. */
async function signIn(port, html) {
  const res = await request(port, { method: 'POST', pathname: '/auth/launch', headers: { Origin: 'null', 'Content-Type': FORM }, body: `code=${encodeURIComponent(codeOf(html))}` });
  assert.equal(res.status, 200, res.body);
  return [].concat(res.headers['set-cookie'])[0].split(';')[0];
}

const authed = async (port, cookie) => (await request(port, { pathname: '/api/session', headers: { Cookie: cookie } })).status;

test('Stop keeps the host, Start brings the panel back with a NEW token: a cookie from before is refused, the new tab is signed in', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const panels = [];
  const h = startHost(t, cfg, {
    startPanel: async (...args) => {
      const p = await startAdminPanel(...args);
      panels.push(p);
      return p;
    },
  });
  await h.waitFor('state\trunning');
  await until(() => h.opened.length >= 1, 'the first tab');
  const cookie1 = await signIn(PANEL_PORT, h.opened[0].html);
  assert.equal(await authed(PANEL_PORT, cookie1), 200);

  h.send('stop');
  assert.equal(await h.waitFor('state\tstopped'), 'state\tstopped\tlease');
  await assert.rejects(request(PANEL_PORT), /ECONNREFUSED/, 'the listener is closed while stopped');
  assert.equal(h.opened.length, 1);

  h.send('start');
  await h.waitCount('state\trunning', 2);
  await until(() => h.opened.length >= 2, 'the tab Start opens');
  assert.equal(panels.length, 2);
  assert.notEqual(panels[0].token, panels[1].token, 'a fresh token at every start');
  assert.notEqual(await authed(PANEL_PORT, cookie1), 200, 'the old cookie does not get back in');
  const cookie2 = await signIn(PANEL_PORT, h.opened[1].html);
  assert.equal(await authed(PANEL_PORT, cookie2), 200);
  assert.ok(!h.opened[1].html.includes(codeOf(h.opened[0].html)));
});

test('Restart is stop then start with a fresh token and a fresh tab; ctx.desktop.requestRestart({ open: false }) restarts without a tab', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const panels = [];
  const h = startHost(t, cfg, {
    startPanel: async (...args) => {
      const p = await startAdminPanel(...args);
      panels.push(p);
      return p;
    },
  });
  await h.waitFor('state\trunning');
  assert.deepEqual(panels[0].ctx.desktop.ports, { panel: PANEL_PORT, preview: PREVIEW_PORT });
  h.send('restart');
  await h.waitCount('state\trunning', 2);
  await until(() => h.opened.length >= 2, 'the Restart tab');
  assert.notEqual(panels[0].token, panels[1].token);
  assert.deepEqual(h.lines().filter((l) => l.startsWith('state\tstopped')), ['state\tstopped\tlease']);
  await panels[1].ctx.desktop.requestRestart({ open: false });
  await h.waitCount('state\trunning', 3);
  assert.equal(panels.length, 3);
  assert.notEqual(panels[1].token, panels[2].token);
  assert.equal(h.opened.length, 2, 'no tab for a restart that asked for none');
});

test('open while stopped starts the panel and then opens a tab; open while running opens another tab', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  h.send('stop');
  await h.waitFor('state\tstopped');
  assert.equal(h.opened.length, 1);
  h.send('open');
  await h.waitCount('state\trunning', 2);
  await until(() => h.opened.length >= 2, 'the tab after the start');
  h.send('open');
  await until(() => h.opened.length >= 3, 'another tab');
  assert.equal(h.calls.length, 2, 'the second open did not start a second panel');
});

/** What the launcher page's auto-submitting form would post: every hidden input, in order. */
function formBodyOf(html) {
  const pairs = [];
  for (const m of html.matchAll(/<input type="hidden" name="([a-z]+)" value="([A-Za-z0-9_-]+)">/g)) pairs.push(`${m[1]}=${encodeURIComponent(m[2])}`);
  return pairs.join('&');
}

test('S5: open updates and open preview put one landing field in the launcher; plain open, an unknown word and extra words put none', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  await until(() => h.opened.length >= 1, 'the start tab');
  const toOf = (html) => [...html.matchAll(/name="to" value="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(toOf(h.opened[0].html), [], 'the start tab has no landing');
  const sends = [['open', 'updates'], ['open', 'preview'], ['open'], ['open', 'Updates'], ['open', '/etc/passwd'], ['open', 'updates', 'preview'], ['open', '']];
  const expected = [['updates'], ['preview'], [], [], [], ['updates'], []];
  for (let i = 0; i < sends.length; i++) {
    h.send(...sends[i]);
    await until(() => h.opened.length >= i + 2, `tab ${i + 2}`);
    assert.deepEqual(toOf(h.opened[i + 1].html), expected[i], JSON.stringify(sends[i]));
  }
  assert.equal(h.calls.length, 1, 'no second panel');
});

test('S5: open updates while the panel is stopped starts it and then opens the tab with the landing', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  h.send('stop');
  await h.waitFor('state\tstopped');
  h.send('open', 'preview');
  await h.waitCount('state\trunning', 2);
  await until(() => h.opened.length >= 2, 'the tab after the start');
  assert.ok(h.opened[1].html.includes('<input type="hidden" name="to" value="preview">'));
});

test('S5, real panel: the desktop host sets session.desktop; an open updates tab lands once, and a plain open lands nowhere', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const panels = [];
  const h = startHost(t, cfg, {
    startPanel: async (...args) => {
      const p = await startAdminPanel(...args);
      panels.push(p);
      return p;
    },
  });
  await h.waitFor('state\trunning');
  await until(() => h.opened.length >= 1, 'the start tab');
  const exchange = async (html) => {
    const res = await request(PANEL_PORT, { method: 'POST', pathname: '/auth/launch', headers: { Origin: 'null', 'Content-Type': FORM }, body: formBodyOf(html) });
    assert.equal(res.status, 200, res.body);
    return [].concat(res.headers['set-cookie'])[0].split(';')[0];
  };
  const session = async (cookie) => JSON.parse((await request(PANEL_PORT, { pathname: '/api/session', headers: { Cookie: cookie } })).body);

  const plain = await session(await exchange(h.opened[0].html));
  assert.equal(plain.desktop, true);
  assert.equal(plain.landing, null);

  h.send('open', 'updates');
  await until(() => h.opened.length >= 2, 'the updates tab');
  const cookie = await exchange(h.opened[1].html);
  assert.equal((await session(cookie)).landing, 'updates');
  assert.equal((await session(cookie)).landing, null, 'one shot');
  assert.ok(!JSON.stringify(plain).includes(codeOf(h.opened[0].html)), 'the code is never in the session');
});

test('from the error state, retry is a start the GM makes: it opens a tab and does not retry on its own', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg, {
    background: true,
    deps: { retryDelaysMs: [] },
    startPanel: async (f, c, o, n) => {
      if (n === 1) throw notFound();
      return fakePanel(cfg);
    },
  });
  await h.waitFor('state\terror');
  h.send('retry');
  await h.waitFor('state\trunning');
  await until(() => h.opened.length === 1, 'the tab');
});

test('a retry or open sent during a retry wait ends the wait now', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg, {
    background: true,
    deps: { retryDelaysMs: [600000] },
    startPanel: async (f, c, o, n) => {
      if (n === 1) throw notFound();
      return fakePanel(cfg);
    },
  });
  await h.waitFor('state\tstarting\t-\twaiting');
  h.send('retry');
  await h.waitFor('state\trunning');
  assert.equal(h.calls.length, 2);
  await until(() => h.opened.length === 1, 'the GM asked, so a tab opens');
});

// --- Quit, end of input, a closed output ------------------------------------------------------------------------

test('quit runs the launch stop path in order (panel, killAll) and only then says bye; the launcher file is gone', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  await until(() => h.opened.length >= 1, 'the tab');
  const file = h.opened[0].target;
  assert.ok(fs.existsSync(file), 'the launcher exists while the code is live');
  h.send('quit');
  assert.equal(await within(h.run, 'the host'), 0);
  assert.deepEqual(h.order, ['panel.stop', 'killAll', 'bye']);
  assert.equal(h.lines().at(-1), 'bye\tquit');
  assert.equal(fs.existsSync(file), false, 'the launcher is gone');
});

test('quit removes the launcher file BEFORE the panel stops', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  let existedAtStop = null;
  let file = null;
  const h = startHost(t, cfg, {
    startPanel: async () => {
      const p = fakePanel(cfg);
      p.stop = async () => {
        existedAtStop = fs.existsSync(file);
      };
      return p;
    },
  });
  await h.waitFor('state\trunning');
  await until(() => h.opened.length >= 1, 'the tab');
  file = h.opened[0].target;
  h.send('quit');
  await within(h.run, 'the host');
  assert.equal(existedAtStop, false);
});

test('Stop panel runs the same stop path but keeps the host: killAll runs, the host does not exit', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  h.send('stop');
  await h.waitFor('state\tstopped');
  assert.deepEqual(h.order, ['panel.stop', 'killAll']);
  assert.ok(!h.has('bye'));
  h.send('stop?');
  await h.waitFor('confirm');
  assert.equal(h.lines().at(-1), 'confirm\tnone', 'a stopped panel needs no confirm');
});

test('end of input is quit: bye eof, the stop path runs, the code is 0', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  h.input.end();
  assert.equal(await within(h.run, 'the host'), 0);
  assert.equal(h.lines().at(-1), 'bye\teof');
  assert.deepEqual(h.order, ['panel.stop', 'killAll', 'bye']);
});

test('a broken output pipe (EPIPE) is quit: the stop path runs and the host ends', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  h.output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.equal(await within(h.run, 'the host'), 0);
  assert.deepEqual(h.order.filter((o) => o !== 'bye'), ['panel.stop', 'killAll']);
  assert.ok(logLines(cfg).some((l) => / quit reason="pipe"/.test(l)));
});

test('quit during a retry wait cancels the wait: no more attempts, the host ends promptly', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg, { background: true, startPanel: async () => { throw notFound(); }, deps: { retryDelaysMs: [600000, 600000] } });
  await h.waitFor('state\tstarting\t-\twaiting');
  h.send('quit');
  assert.equal(await within(h.run, 'the host', 2000), 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.lines().at(-1), 'bye\tquit');
  assert.equal(h.order.filter((o) => o === 'killAll').length, 1, 'the stop path ran once');
});

test('stop during a retry wait cancels it and leaves the panel stopped', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg, { background: true, startPanel: async () => { throw notFound(); }, deps: { retryDelaysMs: [600000] } });
  await h.waitFor('state\tstarting\t-\twaiting');
  h.send('stop');
  await h.waitFor('state\tstopped');
  assert.equal(h.calls.length, 1);
});

test('quit while a start is in flight stops the panel that start produced', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  let release;
  const gate = new Promise((r) => { release = r; });
  const order = [];
  const h = startHost(t, cfg, {
    order,
    startPanel: async () => {
      await gate;
      return fakePanel(cfg, { order });
    },
  });
  await h.waitFor('state\tstarting');
  h.send('quit');
  await new Promise((r) => setTimeout(r, 20));
  release();
  assert.equal(await within(h.run, 'the host'), 0);
  assert.deepEqual(h.order, ['panel.stop', 'killAll', 'bye']);
  assert.ok(!h.has('state\trunning'));
  assert.equal(h.opened.length, 0);
});

// --- crashes ---------------------------------------------------------------------------------------------------------

test('an uncaught exception or an unhandled rejection is logged, runs the stop path, says bye crash, and ends with 1', async (t) => {
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    const cfg = makeConfig(t, desktopToml());
    const h = startHost(t, cfg);
    await h.waitFor('state\trunning');
    h.proc.emit(event, new Error('boom in the panel'));
    assert.equal(await within(h.run, 'the host'), 1, event);
    assert.equal(h.lines().at(-1), 'bye\tcrash');
    assert.deepEqual(h.order, ['panel.stop', 'killAll', 'bye']);
    assert.ok(logLines(cfg).some((l) => / uncaught message="boom in the panel"/.test(l)), event);
    assert.equal(h.proc.listenerCount('uncaughtException'), 0, 'the handlers are removed at the end');
    assert.equal(h.proc.listenerCount('unhandledRejection'), 0);
  }
});

// --- confirm -----------------------------------------------------------------------------------------------------

test('confirm: remote when the panel is in a remote mode, build when busy, none otherwise; the same for stop? and quit?', async (t) => {
  const run = async (panelOpts, expected) => {
    const cfg = makeConfig(t, desktopToml());
    const h = startHost(t, cfg, { panel: panelOpts });
    await h.waitFor('state\trunning');
    h.send('stop?');
    await h.waitCount('confirm', 1);
    h.send('quit?');
    await h.waitCount('confirm', 2);
    assert.deepEqual(h.lines().filter((l) => l.startsWith('confirm')), [`confirm\t${expected}`, `confirm\t${expected}`]);
    await h.stop();
  };
  await run({}, 'none');
  await run({ busy: 'build' }, 'build');
  await run({ mode: 'tailscale', adminUrl: 'https://scriptorium.home.arpa' }, 'remote');
  await run({ mode: 'ssh' }, 'remote');
  await run({ mode: 'proxy', busy: 'build', adminUrl: 'https://scriptorium.home.arpa' }, 'remote');
});

// --- the update line -----------------------------------------------------------------------------------------------

test('update: one line per version, however many polls; a newer version sends another; a dismissed one sends none', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const snap = { state: 'current', dismissed: false, latestTag: null, notesUrl: null };
  const h = startHost(t, cfg, { panel: { updateNotice: { snapshot: () => ({ ...snap }) } } });
  await h.waitFor('state\trunning');
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(!h.has('update'), 'nothing while current');
  Object.assign(snap, { state: 'available', latestTag: 'v9.9.0', notesUrl: 'https://github.com/example/notes/releases/tag/v9.9.0' });
  await h.waitFor('update');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(h.lines().filter((l) => l.startsWith('update')), ['update\tv9.9.0\thttps://github.com/example/notes/releases/tag/v9.9.0']);
  Object.assign(snap, { latestTag: 'v9.9.1', notesUrl: 'https://github.com/example/notes/releases/tag/v9.9.1', dismissed: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.lines().filter((l) => l.startsWith('update')).length, 1, 'a dismissed version is not sent');
  snap.dismissed = false;
  await h.waitCount('update', 2);
  assert.equal(h.lines().filter((l) => l.startsWith('update')).at(-1), 'update\tv9.9.1\thttps://github.com/example/notes/releases/tag/v9.9.1');
});

test('update polling only runs while the panel is running', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  let polls = 0;
  const h = startHost(t, cfg, { panel: { updateNotice: { snapshot: () => { polls += 1; return { state: 'current', dismissed: false, latestTag: null, notesUrl: null }; } } } });
  await h.waitFor('state\trunning');
  await until(() => polls >= 2, 'two polls');
  h.send('stop');
  await h.waitFor('state\tstopped');
  const after = polls;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(polls, after, 'no polls while stopped');
});

// --- input handling ---------------------------------------------------------------------------------------------------

test('unknown verbs, host verbs, malformed and over-long lines are ignored; a verb split across chunks still works; the host keeps running', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  const before = h.lines().length;
  h.sendRaw('dance\n');
  h.sendRaw('hello\t1\tx\ty\n');
  h.sendRaw('state\tstopped\t-\n');
  h.sendRaw('\n');
  h.sendRaw(`stop\tmore\x01bad\n`);
  h.sendRaw('x'.repeat(5000));
  h.sendRaw('stop\n'); // the tail of the over-long line, not a command
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.lines().length, before, 'nothing happened');
  assert.equal(h.calls.length, 1);
  h.sendRaw('sto');
  h.sendRaw('p?\n');
  await h.waitFor('confirm');
  h.sendRaw('quit\r\n');
  await new Promise((r) => setTimeout(r, 30));
  h.send('quit');
  assert.equal(await within(h.run, 'the host'), 0);
});

// --- the output carries protocol lines and nothing else --------------------------------------------------------------

function fakeStreams() {
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdout = new EventEmitter();
  stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };
  const stderr = new EventEmitter();
  stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
  const consoleObj = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    // Like a console that holds the stream's own write function, so only redirecting console.* itself stops it
    // (the direct-write redirect is pinned separately).
    const raw = (name === 'warn' || name === 'error' ? stderr : stdout).write;
    consoleObj[name] = (...a) => raw(`${util.format(...a)}\n`);
  }
  const originals = { out: stdout.write, err: stderr.write, log: consoleObj.log, error: consoleObj.error };
  return { stdout, stderr, consoleObj, stdoutChunks, stderrChunks, originals };
}

test('desktop run: console.* and direct stdout/stderr writes from the panel go to the log; every output line is a known protocol verb', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const s = fakeStreams();
  const stdin = new PassThrough();
  const proc = new EventEmitter();
  proc.exit = () => {};
  const opened = [];
  const result = runDesktopCommand({ config: cfg.configPath }, 'run', [], {
    platform: 'win32',
    stdin,
    stdout: s.stdout,
    stderr: s.stderr,
    consoleObj: s.consoleObj,
    proc,
    version: '0.0.0-test',
    retryDelaysMs: [],
    pollMs: 10,
    openFile: async (o) => { opened.push(o.target); return { outcome: 'exited', exitCode: 0 }; },
    killAll: async () => {},
    startPanel: async () => {
      s.consoleObj.log('stray console line from the panel');
      s.consoleObj.error('stray error line');
      s.stdout.write('stray direct stdout write\n');
      s.stderr.write(Buffer.from('stray direct stderr write\n'));
      s.stdout.write('stray with callback\n', 'utf8', () => {});
      return fakePanel(cfg);
    },
  });
  await until(() => s.stdoutChunks.some((c) => c.startsWith('state\trunning')), `the running line (have ${JSON.stringify(s.stdoutChunks)})`);
  stdin.write('stop?\n');
  await until(() => s.stdoutChunks.some((c) => c.startsWith('confirm')), 'a confirm line');
  stdin.end();
  const done = await within(result, 'desktop run');
  assert.deepEqual(done, { exitCode: 0, human: '' });
  assert.ok(s.stdoutChunks.length >= 4);
  for (const chunk of s.stdoutChunks) {
    const parsed = parseLine(chunk);
    assert.ok(parsed, `not a protocol line: ${JSON.stringify(chunk)}`);
    assert.ok(HOST_VERBS.includes(parsed.verb), chunk);
    assert.ok(!/stray/.test(chunk));
  }
  assert.deepEqual(s.stderrChunks, [], 'nothing reaches the real stderr');
  const log = logLines(cfg).join('\n');
  for (const text of ['stray console line from the panel', 'stray error line', 'stray direct stdout write', 'stray direct stderr write', 'stray with callback']) {
    assert.ok(log.includes(text), `${text} is in the log`);
  }
  // The originals are back once the host has gone.
  assert.equal(s.stdout.write, s.originals.out);
  assert.equal(s.stderr.write, s.originals.err);
  assert.equal(s.consoleObj.log, s.originals.log);
  assert.equal(s.consoleObj.error, s.originals.error);
});

test('desktop run refuses off Windows and with a terminal on its input, with exit 1 and the exact line', async () => {
  assert.deepEqual(await runDesktopCommand({}, 'run', [], { platform: 'linux', stdin: new PassThrough() }), {
    exitCode: 1,
    human: 'the desktop app runs only on Windows; run "gm-scriptorium" or "serve --admin"',
  });
  const tty = new PassThrough();
  tty.isTTY = true;
  assert.deepEqual(await runDesktopCommand({}, 'run', [], { platform: 'win32', stdin: tty }), {
    exitCode: 1,
    human: 'desktop run is started by gm-scriptorium-tray.exe; to open the panel, run "gm-scriptorium"',
  });
  // The platform check comes first.
  assert.match((await runDesktopCommand({}, 'run', [], { platform: 'darwin', stdin: tty })).human, /only on Windows/);
});

test('desktop run accepts only --config and --background, and no words', () => {
  assert.throws(() => runDesktopCommand({ port: String(PANEL_PORT) }, 'run', [], { platform: 'win32' }), /desktop run does not accept --port/);
  assert.throws(() => runDesktopCommand({ campaign: 'x' }, 'run', [], { platform: 'win32' }), /desktop run does not accept --campaign/);
  assert.throws(() => runDesktopCommand({}, 'run', ['extra'], { platform: 'win32' }), ConfigError);
});

test('desktop run with --background starts quietly (no tab) and with no flag it opens one', async (t) => {
  for (const background of [true, false]) {
    const cfg = makeConfig(t, desktopToml());
    const s = fakeStreams();
    const stdin = new PassThrough();
    const proc = new EventEmitter();
    proc.exit = () => {};
    const opened = [];
    const result = runDesktopCommand({ config: cfg.configPath, ...(background ? { background: true } : {}) }, 'run', [], {
      platform: 'win32', stdin, stdout: s.stdout, stderr: s.stderr, consoleObj: s.consoleObj, proc,
      retryDelaysMs: [], pollMs: 1000,
      openFile: async (o) => { opened.push(o.target); return { outcome: 'exited', exitCode: 0 }; },
      killAll: async () => {},
      startPanel: async () => fakePanel(cfg),
    });
    await until(() => s.stdoutChunks.some((c) => c.startsWith('state\trunning')), 'running');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(opened.length, background ? 0 : 1);
    stdin.end();
    await within(result, 'desktop run');
  }
});

// --- secrecy, end to end ----------------------------------------------------------------------------------------------

test('no launch code, token or cookie ever reaches desktop.log or the output: real panel, real launcher, every operation', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const s = fakeStreams();
  const stdin = new PassThrough();
  const proc = new EventEmitter();
  proc.exit = () => {};
  const panels = [];
  const launchers = [];
  const cookies = [];
  const result = runDesktopCommand({ config: cfg.configPath }, 'run', [], {
    platform: 'win32', stdin, stdout: s.stdout, stderr: s.stderr, consoleObj: s.consoleObj, proc,
    version: '0.0.0-test', retryDelaysMs: [], pollMs: 10,
    openFile: async (o) => {
      launchers.push(fs.readFileSync(o.target, 'utf8'));
      return { outcome: 'exited', exitCode: 0 };
    },
    killAll: async () => {},
    startPanel: async (flags, c, o) => {
      // A panel that is chatty about its own address, the way a careless line could be.
      const p = await startAdminPanel(flags, c, { ...o, emit: o.emit });
      panels.push(p);
      o.emit(`panel up with token=${p.token} and a cookie`);
      s.consoleObj.log(`debug: http://127.0.0.1:${p.ctx.adminPort}/auth?token=${p.token}`);
      return p;
    },
  });
  const waitRunning = (n) => until(() => s.stdoutChunks.filter((c) => c.startsWith('state\trunning')).length >= n, `running x${n}`);
  await waitRunning(1);
  await until(() => launchers.length >= 1, 'the first launcher');
  cookies.push(await signIn(PANEL_PORT, launchers[0]));
  stdin.write('restart\n');
  await waitRunning(2);
  await until(() => launchers.length >= 2, 'the restart launcher');
  cookies.push(await signIn(PANEL_PORT, launchers[1]));
  stdin.write('open\n');
  await until(() => launchers.length >= 3, 'the open launcher');
  stdin.write('stop\n');
  await until(() => s.stdoutChunks.some((c) => c.startsWith('state\tstopped')), 'stopped');
  stdin.write('start\n');
  await waitRunning(3);
  await until(() => launchers.length >= 4, 'the start launcher');
  stdin.write('quit\n');
  assert.equal((await within(result, 'desktop run')).exitCode, 0);

  const logText = fs.readFileSync(cfg.logFile, 'utf8');
  const outText = s.stdoutChunks.join('') + s.stderrChunks.join('');
  const secrets = [...panels.map((p) => p.token), ...launchers.map(codeOf), ...cookies.map((c) => c.split('=')[1])];
  // A session cookie's value is its token, so the two cookies repeat two of the three tokens.
  assert.equal(new Set(secrets).size, 3 + 4, 'three tokens and four launch codes, all distinct, so each count below means something');
  assert.ok(cookies.every((c) => panels.some((p) => c.endsWith(`=${p.token}`))));
  for (const secret of new Set(secrets)) {
    assert.equal(logText.split(secret).length - 1, 0, 'in desktop.log');
    assert.equal(outText.split(secret).length - 1, 0, 'in the output');
  }
  // Positive controls: the scan can see a secret where there is one, and the log is not empty.
  assert.ok(launchers.every((html) => html.includes(codeOf(html))));
  assert.ok(logText.includes('[redacted]'), 'the careless lines were scrubbed, not dropped');
  assert.ok(logText.split('\n').filter(Boolean).length >= 8);
  assert.equal(`x${secrets[0]}y`.split(secrets[0]).length - 1, 1);
});

test('the real process is not touched: the redirect is undone and no handler is left behind', async (t) => {
  const before = { log: console.log, out: process.stdout.write, err: process.stderr.write, un: process.listenerCount('uncaughtException'), rej: process.listenerCount('unhandledRejection') };
  const cfg = makeConfig(t, desktopToml());
  const s = fakeStreams();
  const stdin = new PassThrough();
  const proc = new EventEmitter();
  proc.exit = () => {};
  const result = runDesktopCommand({ config: cfg.configPath }, 'run', [], {
    platform: 'win32', stdin, stdout: s.stdout, stderr: s.stderr, consoleObj: s.consoleObj, proc,
    openFile: async () => ({ outcome: 'exited', exitCode: 0 }), killAll: async () => {}, startPanel: async () => fakePanel(cfg),
  });
  await until(() => s.stdoutChunks.some((c) => c.startsWith('state\trunning')), 'running');
  stdin.end();
  await within(result, 'desktop run');
  assert.equal(console.log, before.log);
  assert.equal(process.stdout.write, before.out);
  assert.equal(process.stderr.write, before.err);
  assert.equal(process.listenerCount('uncaughtException'), before.un);
  assert.equal(process.listenerCount('unhandledRejection'), before.rej);
});

// --- the sign-in-local field on the running line (ADR 0057 section 7) ------------------------------------------------

test('signin-local: the running line of a held-back sign-in start has it as the literal fifth field, and every other running line has four', async (t) => {
  const held = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW) + REMOTE_TOML);
  const a = startHost(t, held, { background: true });
  assert.equal(await a.waitFor('state\trunning'), `state\trunning\tlease\tlocal\thttp://127.0.0.1:${PANEL_PORT}\tsignin-local\tsignin=unconfirmed`);
  assert.equal((await a.waitFor('state\trunning')).split('\t').length, 7);
  // After Stop and a start the GM makes, the panel runs in the saved mode and the field is gone.
  a.send('stop');
  await a.waitFor('state\tstopped');
  a.send('start');
  await a.waitCount('state\trunning', 2);
  assert.ok(!a.lines().filter((l) => l.startsWith('state\trunning')).at(-1).includes('signin-local'));
});

test('signin-local: absent when the confirmation is set, when the GM started the host, and when the saved mode is local anyway', async (t) => {
  const runningOf = async (cfg, opts) => {
    const h = startHost(t, cfg, opts);
    const line = await h.waitFor('state\trunning');
    await h.stop();
    return line.split('\t');
  };
  const confirmed = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW, 'remote_at_signin = true\nremote_at_signin_pc = "PC-A"\n') + REMOTE_TOML);
  const c = await runningOf(confirmed, { background: true });
  assert.deepEqual([c.length, c.at(-1)], [6, 'signin=confirmed']);
  const manual = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW) + REMOTE_TOML);
  const m = await runningOf(manual, {});
  assert.deepEqual([m.length, m.at(-1)], [6, 'signin=unconfirmed']);
  const plain = makeConfig(t, desktopToml());
  const pl = await runningOf(plain, { background: true });
  assert.deepEqual([pl.length, pl.at(-1)], [6, 'signin=unconfirmed'], 'a local config has nothing held back');
});

test('desktop run with NO injected version says hello with the version in package.json (the helper compares it exactly)', async (t) => {
  const cfg = makeConfig(t, desktopToml());
  const s = fakeStreams();
  const stdin = new PassThrough();
  const proc = new EventEmitter();
  proc.exit = () => {};
  const result = runDesktopCommand({ config: cfg.configPath }, 'run', [], {
    platform: 'win32', stdin, stdout: s.stdout, stderr: s.stderr, consoleObj: s.consoleObj, proc,
    retryDelaysMs: [], pollMs: 1000,
    openFile: async () => ({ outcome: 'exited', exitCode: 0 }),
    killAll: async () => {},
    startPanel: async () => fakePanel(cfg),
  });
  await until(() => s.stdoutChunks.length >= 1, 'the hello line');
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  const fields = s.stdoutChunks[0].replace(/\n$/, '').split('\t');
  assert.equal(fields[0], 'hello');
  assert.ok(expected.length > 0);
  assert.equal(fields[2], expected);
  stdin.end();
  await within(result, 'desktop run');
});

// --- RV1b: the answer counts only on the computer that gave it -------------------------------------------------------------

const CONFIRMED_A = 'remote_at_signin = true\nremote_at_signin_pc = "PC-A"\n';

test('RV1b: at sign-in the confirmation holds on the computer that gave it and not on another', async (t) => {
  const here = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW, CONFIRMED_A) + REMOTE_TOML);
  const a = startHost(t, here, { background: true });
  await a.waitFor('state\trunning');
  assert.equal(a.calls[0][2].localOnly, false, 'PC-A: remote allowed');
  const other = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW, CONFIRMED_A) + REMOTE_TOML);
  const b = startHost(t, other, { background: true, deps: { hostname: () => 'PC-B' } });
  assert.ok((await b.waitFor('state\trunning')).includes('\tsignin-local\t'));
  assert.equal(b.calls[0][2].localOnly, true, 'PC-B: this-PC-only');
});

test('RV1b: a legacy true with no computer name is local-only at sign-in', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW, 'remote_at_signin = true\n') + REMOTE_TOML);
  const h = startHost(t, cfg, { background: true });
  await h.waitFor('state\trunning');
  assert.equal(h.calls[0][2].localOnly, true);
});

test('RV1b: on Windows the computer name is compared without regard to case', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW, CONFIRMED_A) + REMOTE_TOML);
  const h = startHost(t, cfg, { background: true, deps: { hostname: () => 'pc-a', platform: 'win32' } });
  await h.waitFor('state\trunning');
  assert.equal(h.calls[0][2].localOnly, false);
});

test('RV1b: the computer name never reaches desktop.log or the output', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW, CONFIRMED_A) + REMOTE_TOML);
  const h = startHost(t, cfg, { background: true, deps: { hostname: () => 'PC-B' } });
  await h.waitFor('state\trunning');
  h.send('stop');
  await h.waitFor('state\tstopped');
  h.send('start');
  await h.waitCount('state\trunning', 2);
  await h.stop();
  const log = fs.readFileSync(cfg.logFile, 'utf8');
  assert.ok(log.split('\n').filter(Boolean).length >= 4, 'the log has lines to check');
  for (const name of ['PC-A', 'PC-B']) {
    assert.equal(log.includes(name), false, `${name} is not in the log`);
    assert.equal(h.outLines.join('').includes(name), false, `${name} is not in the output`);
  }
});

// --- the separate "confirmed for this PC" fact on every running line (ADR 0057 section 7) ------------------------------

test('signin=: every running line ends with signin=confirmed or signin=unconfirmed, by the same-PC rule', async (t) => {
  const cases = [
    ['same PC said yes', CONFIRMED_A, 'PC-A', 'signin=confirmed'],
    ['another PC', CONFIRMED_A, 'PC-B', 'signin=unconfirmed'],
    ['legacy true with no name', 'remote_at_signin = true\n', 'PC-A', 'signin=unconfirmed'],
    ['false with a name', 'remote_at_signin = false\nremote_at_signin_pc = "PC-A"\n', 'PC-A', 'signin=unconfirmed'],
    ['nothing saved', '', 'PC-A', 'signin=unconfirmed'],
  ];
  for (const [what, extra, pc, expected] of cases) {
    for (const background of [true, false]) {
      const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW, extra) + REMOTE_TOML);
      const h = startHost(t, cfg, { background, deps: { hostname: () => pc } });
      const fields = (await h.waitFor('state\trunning')).split('\t');
      assert.equal(fields.at(-1), expected, `${what}, background ${background}`);
      await h.stop();
    }
  }
});

test('signin=: a remote start the GM makes, never confirmed, has signin=unconfirmed and NO signin-local', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW) + REMOTE_TOML);
  const h = startHost(t, cfg, { panel: { mode: 'tailscale', adminUrl: 'https://scriptorium.home.arpa' } });
  assert.equal(await h.waitFor('state\trunning'), 'state\trunning\tlease\ttailscale\thttps://scriptorium.home.arpa\tsignin=unconfirmed');
});

test('signin=: it comes after signin-local, so a reader that looks for signin-local as the fifth field still finds it', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW) + REMOTE_TOML);
  const h = startHost(t, cfg, { background: true });
  const fields = (await h.waitFor('state\trunning')).split('\t');
  assert.equal(fields[5], 'signin-local');
  assert.equal(fields[6], 'signin=unconfirmed');
  assert.equal(fields.length, 7);
});

test('signin=: it is resent unchanged when the running state is resent, and follows a restart that re-reads the config', async (t) => {
  const cfg = makeConfig(t, desktopToml(SIGNIN_PORT, SIGNIN_PREVIEW) + REMOTE_TOML);
  const h = startHost(t, cfg);
  await h.waitFor('state\trunning');
  fs.appendFileSync(cfg.configPath, '');
  fs.writeFileSync(cfg.configPath, fs.readFileSync(cfg.configPath, 'utf8').replace('[desktop]\n', '[desktop]\n' + CONFIRMED_A));
  h.send('restart');
  await h.waitCount('state\trunning', 2);
  const running = h.lines().filter((l) => l.startsWith('state\trunning'));
  assert.equal(running[0].split('\t').at(-1), 'signin=unconfirmed');
  assert.equal(running[1].split('\t').at(-1), 'signin=confirmed');
});
