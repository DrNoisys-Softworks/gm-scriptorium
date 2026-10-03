'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const { ConfigError } = require('../src/util/errors');
const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');
const { ADMIN_ALLOWED_FLAGS } = require('../src/cli/serve-admin');

/*
 * V1.5a (SD-a14). Startup of `serve --admin` with injected listener fakes: every readiness refusal
 * as exactly one ConfigError with the listener fakes never called, the warning strictly before
 * startPanelListener on a shared ordering log, the per-mode lines, --preview-port, the remote
 * modes refusing --port, and the bind-failure path (no second call on a wider host). The fixed
 * ports 7922-7923 appear in the settings only: the fakes never open a socket.
 */

const A = 7922;
const B = 7923;
const TOKEN = 'TOKENTOKENTOKENTOKENTOKENTOKENTOKENTOKEN123';

const PROXY = {
  mode: 'proxy',
  port: A,
  preview_port: B,
  admin_url: 'https://scriptorium.home.arpa',
  preview_url: 'https://preview.scriptorium.home.arpa',
  bind: '192.0.2.42',
  trusted_proxies: ['127.0.0.2'],
};
const TAILSCALE = {
  mode: 'tailscale',
  port: A,
  preview_port: B,
  admin_url: 'https://panel-host.example-tailnet.ts.net',
  preview_url: 'https://panel-host.example-tailnet.ts.net:8443',
};
const SSH = { mode: 'ssh', port: A, preview_port: B };

function tomlOf(remote) {
  if (remote === undefined) return '';
  const lines = ['', '[remote]'];
  for (const [k, v] of Object.entries(remote)) {
    lines.push(`${k} = ${JSON.stringify(v)}`);
  }
  return lines.join('\n') + '\n';
}

function fixture(t, remote, { password = true, configInVault = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-rsa-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n');
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), JSON.stringify({ siteTitle: 'Alpha Test' }) + '\n');
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'pack.toml'), 'theme = "plain"\n');
  const configDir = configInVault ? vault : root;
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vault}'`, `output = '${path.join(root, 'out')}'`, ''].join('\n') + tomlOf(remote),
  );
  return { root, vault, configPath, panelDir: path.join(configDir, 'panel') };
}

async function setPassword(panelDir, text = 'correct horse battery') {
  pwWrite.writePasswordRecord(path.join(panelDir, 'password.json'), await pw.hashPassword(text));
}

function harness({ failAdmin = false, failPreview = false, failLocalPreview = false } = {}) {
  const log = [];
  const emitted = [];
  let panelCalls = 0;
  let localCalls = 0;
  const handle = (kind, port, host) => ({ server: {}, servers: [], port, hosts: host, close: async () => void log.push(`close:${kind}:${port}`) });
  const startPanelListener = async (handler, opts) => {
    panelCalls++;
    log.push(`panel:${JSON.stringify({ port: opts.port, hosts: opts.hosts, hasAllowPeer: typeof opts.allowPeer === 'function' })}`);
    log.panelOpts = (log.panelOpts || []).concat([opts]);
    if ((panelCalls === 1 && failAdmin) || (panelCalls === 2 && failPreview)) throw new Error(`port ${opts.port} is already in use on ${opts.hosts[opts.hosts.length - 1]}`);
    return handle('panel', opts.port, opts.hosts);
  };
  const startLocalListener = async (handler, opts) => {
    localCalls++;
    log.push(`local:${JSON.stringify(opts)}`);
    log.localOpts = (log.localOpts || []).concat([opts]);
    if (localCalls === 2 && failLocalPreview) throw new Error('boom');
    return handle('local', opts.port === 0 ? 50000 + localCalls : opts.port, ['127.0.0.1']);
  };
  const emit = (line) => {
    emitted.push(line);
    log.push(`emit:${line}`);
  };
  const signals = new EventEmitter();
  return { log, emitted, emit, signals, startPanelListener, startLocalListener, calls: () => ({ panel: panelCalls, local: localCalls }) };
}

async function run(t, remote, { flags = {}, password = true, configInVault = false, h = harness(), now, identity } = {}) {
  const fx = fixture(t, remote, { configInVault });
  if (password && remote && remote.mode !== 'local' && remote.mode !== 'ssh') await setPassword(fx.panelDir);
  const opts = {
    emit: h.emit,
    signals: h.signals,
    startLocalListener: h.startLocalListener,
    startPanelListener: h.startPanelListener,
    createToken: () => TOKEN,
  };
  if (now) opts.now = now;
  if (identity) opts.identity = identity;
  return { fx, h, promise: () => runServeCommand({ config: fx.configPath, admin: true, ...flags }, 'alpha', opts) };
}

/** Settles a startup promise; if it did not refuse promptly (a mutation or a bug let it start) it is stopped, so a test can never hang. */
async function settle(promise, signals) {
  const wrapped = promise.then((value) => ({ value }), (error) => ({ error }));
  const early = await Promise.race([wrapped, new Promise((r) => setTimeout(() => r(null), 1500))]);
  if (early) return early;
  signals.emit('SIGINT');
  return wrapped;
}

async function stop(h, promise) {
  await new Promise((r) => setImmediate(r));
  h.signals.emit('SIGINT');
  return promise;
}

async function refusal(t, remote, message, extra = {}) {
  const { h, promise } = await run(t, remote, extra);
  const outcome = await settle(promise(), h.signals);
  const err = outcome.error;
  assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${err ? err.constructor.name + ': ' + err.message : 'a started server'}`);
  assert.equal(err.message, message);
  assert.deepEqual(h.calls(), { panel: 0, local: 0 }, 'no listener was started');
  assert.deepEqual(h.emitted, [], 'nothing was printed');
}

// --- flags --------------------------------------------------------------------

test('ADMIN_ALLOWED_FLAGS gains exactly preview-port', () => {
  assert.deepEqual([...ADMIN_ALLOWED_FLAGS], ['admin', 'campaign', 'config', 'vault', 'port', 'preview-port']);
});

test('--host is refused in every form with the new message, before config is read', async (t) => {
  const message = 'serve --admin does not accept --host; remote access comes only from saved settings (see "gm-scriptorium remote")';
  for (const flags of [{ host: '0.0.0.0' }, { host: true }, { 'host=1.2.3.4': true }]) {
    await refusal(t, undefined, message, { flags });
  }
});

// --- local mode (FR-01) ----------------------------------------------------------

test('FR-01: with no [remote] table, startup is exactly the old behaviour: two local listeners on {port: 0}, the three exact lines', async (t) => {
  const { h, promise } = await run(t, undefined);
  const p = promise();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.log.localOpts, [{ port: 0 }, { port: 0 }]);
  assert.equal(h.calls().panel, 0);
  assert.deepEqual(h.emitted, [
    `admin panel: http://127.0.0.1:50001/auth?token=${TOKEN}`,
    'preview: http://127.0.0.1:50002/',
    'open the admin panel link in your browser. Press Ctrl-C to stop.',
  ]);
  assert.deepEqual(await stop(h, p), { exitCode: 0, human: 'stopped.' });
  assert.deepEqual(h.log.filter((l) => l.startsWith('close:')), ['close:local:50001', 'close:local:50002']);
});

test('FR-01: an explicit [remote] mode = "local" behaves the same, and --port N is passed through', async (t) => {
  const { h, promise } = await run(t, { mode: 'local' }, { flags: { port: '9100' } });
  const p = promise();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.log.localOpts, [{ port: 9100 }, { port: 0 }]);
  assert.equal(h.emitted.length, 3);
  await stop(h, p);
});

test('local mode creates no panel folder and prints no warning (the audit file appears only on first use)', async (t) => {
  const { fx, h, promise } = await run(t, undefined);
  const p = promise();
  await stop(h, p);
  assert.equal(fs.existsSync(fx.panelDir), false);
  assert.ok(!h.emitted.some((l) => /warning|WARNING/.test(l)));
});

// --- --preview-port (FR-04) -------------------------------------------------------

test('--preview-port N goes to the preview listener in local mode, and the printed preview URL uses it', async (t) => {
  const { h, promise } = await run(t, undefined, { flags: { 'preview-port': '9200' } });
  const p = promise();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.log.localOpts, [{ port: 0 }, { port: 9200 }]);
  assert.equal(h.emitted[1], 'preview: http://127.0.0.1:9200/');
  await stop(h, p);
});

test('--preview-port: 1 and 65535 are accepted; 0, 65536, junk and a bare flag are refused with the exact message', async (t) => {
  const msg = 'serve --admin: --preview-port must be a whole number from 1 to 65535';
  for (const bad of ['0', '65536', 'abc', '12.5', '-1', '', true]) await refusal(t, undefined, msg, { flags: { 'preview-port': bad } });
  for (const ok of ['1', '65535']) {
    const { h, promise } = await run(t, undefined, { flags: { 'preview-port': ok } });
    const p = promise();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.log.localOpts[1].port, Number(ok));
    await stop(h, p);
  }
});

test('--preview-port must differ from --port', async (t) => {
  await refusal(t, undefined, 'serve --admin: --preview-port must differ from --port', { flags: { port: '9300', 'preview-port': '9300' } });
});

// --- remote modes refuse the port flags ----------------------------------------------

test('a remote mode refuses --port and --preview-port, one line, nothing started', async (t) => {
  for (const [remote, name] of [[SSH, 'ssh'], [TAILSCALE, 'tailscale'], [PROXY, 'proxy']]) {
    const message = `serve --admin: remote access (mode ${name}) uses the ports saved in its settings, so it does not accept --port or --preview-port`;
    await refusal(t, remote, message, { flags: { port: '9400' } });
    await refusal(t, remote, message, { flags: { 'preview-port': '9401' } });
  }
});

// --- readiness refusals (SD-doc 14 step 6) --------------------------------------------

test('each readiness problem is exactly one ConfigError, with no listener started and nothing printed', async (t) => {
  await refusal(t, { mode: 'ssh' }, 'remote access (mode ssh) needs fixed ports: run "gm-scriptorium remote set --port N --preview-port N"');
  await refusal(t, { ...PROXY, preview_port: A }, 'remote access (mode proxy): the panel and preview ports must differ');
  const { admin_url, ...noAdmin } = PROXY;
  void admin_url;
  await refusal(t, noAdmin, 'remote access (mode proxy) needs an admin address: run "gm-scriptorium remote set --admin-url https://..."');
  const { preview_url, ...noPreview } = PROXY;
  void preview_url;
  await refusal(t, noPreview, 'remote access (mode proxy) needs a preview address: run "gm-scriptorium remote set --preview-url https://..."');
  await refusal(t, { ...PROXY, preview_url: PROXY.admin_url }, 'remote access (mode proxy): the preview address must differ from the admin address');
  const { bind, ...noBind } = PROXY;
  void bind;
  await refusal(t, noBind, 'remote access (mode proxy) needs a bind address: run "gm-scriptorium remote set --bind ADDR"');
  const { trusted_proxies, ...noProxy } = PROXY;
  void trusted_proxies;
  await refusal(t, noProxy, 'remote access (mode proxy) needs a trusted proxy address: run "gm-scriptorium remote set --trusted-proxy ADDR"');
  await refusal(t, PROXY, 'remote access (mode proxy) needs a password: run "gm-scriptorium remote password"', { password: false });
  await refusal(t, TAILSCALE, 'remote access (mode tailscale) needs a password: run "gm-scriptorium remote password"', { password: false });
});

test('V1.5a refuses direct mode, and proxy with tls, for lack of certificate support', async (t) => {
  const direct = { ...PROXY, mode: 'direct', admin_url: 'https://192.0.2.42:7922', preview_url: 'https://192.0.2.42:7923' };
  delete direct.trusted_proxies;
  await refusal(t, direct, 'remote access (mode direct) needs certificate support, which this version of GM-Scriptorium does not have');
  await refusal(t, { ...PROXY, tls: 'generated' }, 'remote access (mode proxy) needs certificate support, which this version of GM-Scriptorium does not have');
});

test('a cleared, invalid or missing password file all read as "needs a password"', async (t) => {
  const fx = fixture(t, PROXY);
  fs.mkdirSync(fx.panelDir, { recursive: true, mode: 0o700 });
  const file = path.join(fx.panelDir, 'password.json');
  const h = harness();
  for (const content of ['{"version":1,"cleared":true,"clearedAt":"2026-10-03T00:00:00.000Z"}', '{not json', null]) {
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content, { mode: 0o600 });
    const outcome = await settle(
      runServeCommand({ config: fx.configPath, admin: true }, 'alpha', { emit: h.emit, signals: h.signals, startLocalListener: h.startLocalListener, startPanelListener: h.startPanelListener, createToken: () => TOKEN }),
      h.signals,
    );
    assert.equal(outcome.error && outcome.error.message, 'remote access (mode proxy) needs a password: run "gm-scriptorium remote password"');
  }
  assert.deepEqual(h.calls(), { panel: 0, local: 0 });
});

test('an unrecognised [remote] key is a hard error for serve --admin', async (t) => {
  await refusal(t, { mode: 'ssh', port: A, preview_port: B, pasword: 'x' }, 'remote: unrecognised key "pasword"');
});

test('an http:// address in the saved settings is refused at startup with the HTTPS message', async (t) => {
  await refusal(t, { ...PROXY, admin_url: 'http://scriptorium.home.arpa' }, 'remote access needs HTTPS: http://scriptorium.home.arpa');
});

test('Ma15c at startup: the panel folder inside a registered vault is refused, naming the campaign, before any socket', async (t) => {
  const h = harness();
  const { promise } = await run(t, TAILSCALE, { configInVault: true, h });
  const outcome = await settle(promise(), h.signals);
  assert.ok(outcome.error instanceof ConfigError);
  assert.match(outcome.error.message, /inside the vault of campaign "alpha"/);
  assert.deepEqual(h.calls(), { panel: 0, local: 0 });
});

test('readiness runs before any socket and without a wider fallback: a refused proxy never calls the local listener either', async (t) => {
  const h = harness();
  const { promise } = await run(t, { ...PROXY, bind: undefined }, { h });
  const outcome = await settle(promise(), h.signals);
  assert.ok(outcome.error instanceof ConfigError);
  assert.deepEqual(h.log.filter((l) => /^(panel|local):/.test(l)), []);
});

// --- ordering and per-mode lines (FR-20) ------------------------------------------------

test('proxy: the WARNING precedes startPanelListener on a shared ordering log, then the five lines after both listeners', async (t) => {
  const { h, promise } = await run(t, PROXY);
  const p = promise();
  await new Promise((r) => setImmediate(r));
  const warning = 'WARNING: remote access is on (mode proxy). It answers 127.0.0.2 (your proxy) and this machine, on 192.0.2.42 ports 7922 and 7923.';
  assert.equal(h.log[0], `emit:${warning}`);
  const firstListen = h.log.findIndex((l) => l.startsWith('panel:'));
  assert.ok(firstListen > 0, 'a listener was started');
  assert.ok(h.log.indexOf(`emit:${warning}`) < firstListen);
  assert.deepEqual(h.log.filter((l) => l.startsWith('panel:')), [
    'panel:{"port":7922,"hosts":["192.0.2.42","127.0.0.1"],"hasAllowPeer":true}',
    'panel:{"port":7923,"hosts":["192.0.2.42","127.0.0.1"],"hasAllowPeer":true}',
  ]);
  assert.equal(h.calls().local, 0, 'startLocalListener is not used in proxy mode');
  assert.deepEqual(h.emitted.slice(1), [
    'remote admin panel: https://scriptorium.home.arpa/ (sign in with the panel password)',
    'remote preview: https://preview.scriptorium.home.arpa/',
    'listening on 192.0.2.42 and 127.0.0.1 port 7922 (panel) and 7923 (preview)',
    `on this machine: http://127.0.0.1:7922/auth?token=${TOKEN}`,
    'Press Ctrl-C to stop.',
  ]);
  assert.deepEqual(await stop(h, p), { exitCode: 0, human: 'stopped.' });
});

test('proxy: the peer predicate handed to the listener is exact (trusted 127.0.0.2: 127.0.0.20 and 127.0.0.3 refused, loopback allowed)', async (t) => {
  const { h, promise } = await run(t, PROXY);
  const p = promise();
  await new Promise((r) => setImmediate(r));
  const allow = h.log.panelOpts[0].allowPeer;
  for (const ok of ['127.0.0.2', '::ffff:127.0.0.2', '127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(allow(ok), true, ok);
  for (const no of ['127.0.0.20', '127.0.0.3', '127.0.0.200', '192.0.2.42', undefined, 'junk']) assert.equal(allow(no), false, String(no));
  assert.equal(h.log.panelOpts[1].allowPeer('127.0.0.20'), false);
  await stop(h, p);
});

test('tailscale: the tailnet sentence in the warning (never "only your devices"), loopback only, loopback peers only', async (t) => {
  const { h, promise } = await run(t, TAILSCALE);
  const p = promise();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.emitted[0], "WARNING: remote access is on (mode tailscale). Any device your tailnet's access rules allow can reach its sign-in page through tailscale serve.");
  assert.ok(!h.emitted.join('\n').toLowerCase().includes('only your devices'));
  assert.equal(h.log.filter((l) => l.startsWith('panel:'))[0], 'panel:{"port":7922,"hosts":["127.0.0.1"],"hasAllowPeer":true}');
  const allow = h.log.panelOpts[0].allowPeer;
  assert.equal(allow('127.0.0.1'), true);
  assert.equal(allow('127.0.0.2'), false);
  assert.equal(h.emitted[3], 'listening on 127.0.0.1 port 7922 (panel) and 7923 (preview)');
  await stop(h, p);
});

test('ssh: the pre line, local listeners on the fixed ports, the exact ssh -L command', async (t) => {
  const { h, promise } = await run(t, SSH, { identity: { user: 'gm', host: 'panel-host' } });
  const p = promise();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.log[0], 'emit:remote access: ssh tunnel (the panel listens on 127.0.0.1 only)');
  assert.deepEqual(h.log.localOpts, [{ port: 7922 }, { port: 7923 }]);
  assert.equal(h.calls().panel, 0);
  assert.deepEqual(h.emitted, [
    'remote access: ssh tunnel (the panel listens on 127.0.0.1 only)',
    `admin panel: http://127.0.0.1:7922/auth?token=${TOKEN}`,
    'preview: http://127.0.0.1:7923/',
    'tunnel from your desktop: ssh -L 7922:127.0.0.1:7922 -L 7923:127.0.0.1:7923 gm@panel-host',
    'open the admin panel link in your browser. Press Ctrl-C to stop.',
  ]);
  await stop(h, p);
});

test('a loose mode on the panel files gets one warning line each, after the WARNING and before any listener (POSIX)', { skip: process.platform === 'win32' }, async (t) => {
  const h = harness();
  const fx = fixture(t, PROXY);
  await setPassword(fx.panelDir);
  fs.chmodSync(fx.panelDir, 0o755);
  const p = runServeCommand({ config: fx.configPath, admin: true }, 'alpha', { emit: h.emit, signals: h.signals, startLocalListener: h.startLocalListener, startPanelListener: h.startPanelListener, createToken: () => TOKEN });
  await new Promise((r) => setImmediate(r));
  const warn = `warning: ${fx.panelDir} can be read by other users on this machine`;
  assert.ok(h.log.includes(`emit:${warn}`));
  assert.ok(h.log.indexOf(`emit:${warn}`) < h.log.findIndex((l) => l.startsWith('panel:')));
  assert.ok(h.log.findIndex((l) => l.startsWith('emit:WARNING')) < h.log.indexOf(`emit:${warn}`));
  await stop(h, p);
});

test('no per-request console output and no secret is printed apart from the one token line', async (t) => {
  const { h, promise } = await run(t, PROXY);
  const p = promise();
  await new Promise((r) => setImmediate(r));
  const all = h.emitted.join('\n');
  assert.equal(all.split(TOKEN).length - 1, 1, 'the token appears exactly once');
  assert.ok(!all.includes('correct horse battery'));
  await stop(h, p);
});

// --- failure paths ---------------------------------------------------------------------

test('a bind failure on the admin listener: exit 1 with the message, no second call, nothing wider tried', async (t) => {
  const h = harness({ failAdmin: true });
  const { promise } = await run(t, PROXY, { h });
  const result = await promise();
  assert.deepEqual(result, { exitCode: 1, human: 'failed to start server: port 7922 is already in use on 127.0.0.1' });
  assert.deepEqual(h.calls(), { panel: 1, local: 0 });
  assert.deepEqual(h.log.filter((l) => l.startsWith('panel:')).length, 1);
});

test('a bind failure on the preview listener closes the admin handle and exits 1', async (t) => {
  const h = harness({ failPreview: true });
  const { promise } = await run(t, PROXY, { h });
  const result = await promise();
  assert.equal(result.exitCode, 1);
  assert.match(result.human, /^failed to start server: port 7923 is already in use/);
  assert.deepEqual(h.log.filter((l) => l.startsWith('close:')), ['close:panel:7922']);
  assert.equal(h.calls().panel, 2);
});

test('local mode: a preview listener failure still closes the admin handle (unchanged)', async (t) => {
  const h = harness({ failLocalPreview: true });
  const { promise } = await run(t, undefined, { h });
  const result = await promise();
  assert.deepEqual(result, { exitCode: 1, human: 'failed to start server: boom' });
  assert.deepEqual(h.log.filter((l) => l.startsWith('close:')), ['close:local:50001']);
});

// --- stores --------------------------------------------------------------------------------

test('startup prunes audit entries older than 90 days (best-effort) using the injected clock', async (t) => {
  const fx = fixture(t, PROXY);
  await setPassword(fx.panelDir);
  const now = Date.UTC(2026, 9, 3);
  const old = new Date(now - 91 * 86400000).toISOString();
  const fresh = new Date(now - 86400000).toISOString();
  fs.writeFileSync(path.join(fx.panelDir, 'audit.log'), `${JSON.stringify({ t: old, event: 'old' })}\n${JSON.stringify({ t: fresh, event: 'fresh' })}\n`, { mode: 0o600 });
  const h = harness();
  const p = runServeCommand({ config: fx.configPath, admin: true }, 'alpha', { emit: h.emit, signals: h.signals, startLocalListener: h.startLocalListener, startPanelListener: h.startPanelListener, createToken: () => TOKEN, now: () => now });
  await new Promise((r) => setImmediate(r));
  const kept = fs.readFileSync(path.join(fx.panelDir, 'audit.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).event);
  assert.deepEqual(kept, ['fresh']);
  await stop(h, p);
});

test('a prune failure never blocks startup or changes the exit code (the audit file is a directory)', async (t) => {
  const fx = fixture(t, TAILSCALE);
  await setPassword(fx.panelDir);
  fs.mkdirSync(path.join(fx.panelDir, 'audit.log'));
  const h = harness();
  const p = runServeCommand({ config: fx.configPath, admin: true }, 'alpha', { emit: h.emit, signals: h.signals, startLocalListener: h.startLocalListener, startPanelListener: h.startPanelListener, createToken: () => TOKEN });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls().panel, 2);
  assert.deepEqual(await stop(h, p), { exitCode: 0, human: 'stopped.' });
});

test('with several problems at once only the FIRST (in the documented order) is reported', async (t) => {
  await refusal(t, { mode: 'proxy' }, 'remote access (mode proxy) needs fixed ports: run "gm-scriptorium remote set --port N --preview-port N"', { password: false });
  await refusal(
    t,
    { mode: 'tailscale', port: A, preview_port: B },
    'remote access (mode tailscale) needs an admin address: run "gm-scriptorium remote set --admin-url https://..."',
    { password: false },
  );
  await refusal(
    t,
    (({ trusted_proxies, ...rest }) => ({ ...rest, tls: 'generated' }))(PROXY),
    'remote access (mode proxy) needs a trusted proxy address: run "gm-scriptorium remote set --trusted-proxy ADDR"',
    { password: false },
  );
});
