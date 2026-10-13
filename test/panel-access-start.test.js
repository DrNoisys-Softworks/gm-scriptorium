'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startAdminPanel } = require('../src/cli/serve-admin');
const { apiRemote } = require('../src/admin/handlers/remote');
const { ConfigError } = require('../src/util/errors');
const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');

/*
 * ADR 0056. `startAdminPanel` with a simulated Windows (panelAccess: { platform, env, run }) and
 * fake listeners that never open a socket: no fixed port is bound. The access-list step must run
 * before the session store, the audit log and any listener; on failure every non-local mode refuses
 * with exactly one ConfigError, and local mode warns on the console and on the Remote access screen.
 * This proves the sequence of steps and the text, not how Windows treats the list (C180 to C183).
 *
 * The settings carry port numbers because the settings validator needs them; the fakes never listen.
 * Synthetic identity: EXAMPLEPC / examplegm.
 */

const { testPort } = require('./helpers/ports');

const ADMIN_PORT = testPort(7940);
const PREVIEW_PORT = testPort(7941);
const LAUNCH_CODE = 'ABCD'.repeat(11);
const ENV = { USERDOMAIN: 'EXAMPLEPC', USERNAME: 'examplegm', SystemRoot: 'C:\\Windows', PATH: 'C:\\x' };

const MODES = {
  proxy: { mode: 'proxy', port: ADMIN_PORT, preview_port: PREVIEW_PORT, admin_url: 'https://scriptorium.home.arpa', preview_url: 'https://preview.scriptorium.home.arpa', bind: '192.0.2.42', trusted_proxies: ['127.0.0.2'] },
  tailscale: { mode: 'tailscale', port: ADMIN_PORT, preview_port: PREVIEW_PORT, admin_url: 'https://panel-host.example-tailnet.ts.net', preview_url: 'https://panel-host.example-tailnet.ts.net:8443' },
  ssh: { mode: 'ssh', port: ADMIN_PORT, preview_port: PREVIEW_PORT },
};

function tomlOf(remote) {
  if (!remote) return '';
  return ['', '[remote]', ...Object.entries(remote).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)].join('\n') + '\n';
}

function fixture(t, remote, { configInVault = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pas-')));
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

/** An account in accounts.json so a remote mode passes its readiness check (no listener, no icacls yet). */
async function seedAccount(panelDir) {
  fs.mkdirSync(panelDir, { recursive: true });
  pwWrite.writeAccounts(path.join(panelDir, 'accounts.json'), [{ name: 'gm', record: await pw.hashPassword('correct horse battery'), fromEarlierPassword: false }]);
}

function harness(panelDir) {
  const log = [];
  const emitted = [];
  const handle = (port) => ({ port, hosts: ['127.0.0.1'], close: async () => {} });
  const seen = () => ({ sessions: fs.existsSync(path.join(panelDir, 'sessions.json')), audit: fs.existsSync(path.join(panelDir, 'audit.log')) });
  const listener = (kind) => async (handler, opts) => {
    log.push({ what: `listen:${kind}`, ...seen() });
    return handle(opts.port === 0 ? 50000 + log.length : opts.port);
  };
  return {
    log,
    emitted,
    emit: (line) => {
      emitted.push(line);
      log.push({ what: `emit:${line}` });
    },
    startLocalListener: listener('local'),
    startPanelListener: listener('panel'),
    listens: () => log.filter((e) => e.what.startsWith('listen:')).length,
  };
}

/** A recording icacls fake that also notes which panel files exist at the moment it is called. */
function icacls(panelDir, h, exitCode = 0) {
  const calls = [];
  const run = async (opts) => {
    calls.push(opts);
    h.log.push({ what: 'icacls', sessions: fs.existsSync(path.join(panelDir, 'sessions.json')), audit: fs.existsSync(path.join(panelDir, 'audit.log')) });
    return { exitCode, timedOut: false };
  };
  run.calls = calls;
  return run;
}

function start(fx, h, run, panelAccess = {}) {
  return startAdminPanel({ admin: true, config: fx.configPath }, 'alpha', {
    emit: h.emit,
    startLocalListener: h.startLocalListener,
    startPanelListener: h.startPanelListener,
    createToken: () => LAUNCH_CODE,
    panelAccess: { platform: 'win32', env: ENV, run, ...panelAccess },
  });
}

function refusalText(mode, panelDir) {
  return `remote access (mode ${mode}) needs ${panelDir} limited to your account, SYSTEM and Administrators, and that could not be done (icacls exited 5); nothing was started`;
}

test('proxy mode, list applied: starts, and icacls ran before sessions.json, audit.log and the first listener', async (t) => {
  const fx = fixture(t, MODES.proxy);
  await seedAccount(fx.panelDir);
  const h = harness(fx.panelDir);
  const run = icacls(fx.panelDir, h, 0);
  const started = await start(fx, h, run);
  t.after(() => started.ok && started.stop());
  assert.equal(started.ok, true);
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].command, 'icacls');
  assert.equal(run.calls[0].args[0], fx.panelDir);
  const order = h.log.map((e) => e.what);
  assert.equal(order.indexOf('icacls'), 0);
  assert.ok(order.indexOf('icacls') < order.findIndex((w) => w.startsWith('listen:')));
  const atCall = h.log[0];
  assert.equal(atCall.sessions, false);
  assert.equal(atCall.audit, false);
  assert.equal(started.ctx.remote.panelAccess.state, 'applied');
  assert.equal(h.emitted.some((l) => l.startsWith('warning: ') && l.includes('could not be limited')), false);
});

for (const mode of ['ssh', 'tailscale', 'proxy']) {
  test(`${mode} mode, list fails: exactly one ConfigError with the refusal text, no listener, nothing emitted`, async (t) => {
    const fx = fixture(t, MODES[mode]);
    await seedAccount(fx.panelDir);
    const h = harness(fx.panelDir);
    const run = icacls(fx.panelDir, h, 5);
    await assert.rejects(
      start(fx, h, run),
      (err) => err instanceof ConfigError && err.message === refusalText(mode, fx.panelDir),
    );
    assert.equal(h.listens(), 0);
    assert.deepEqual(h.emitted, []);
    assert.equal(run.calls.length, 1);
    assert.equal(fs.existsSync(path.join(fx.panelDir, 'sessions.json')), false);
    assert.equal(fs.existsSync(path.join(fx.panelDir, 'audit.log')), false);
  });
}

test('direct mode: refused on readiness (no certificate support yet) before icacls is reached, no listener; the access-list refusal for it is the same branch as the other modes', async (t) => {
  const fx = fixture(t, { mode: 'direct', port: ADMIN_PORT, preview_port: PREVIEW_PORT, admin_url: 'https://scriptorium.home.arpa', preview_url: 'https://preview.scriptorium.home.arpa', bind: '192.0.2.42' });
  await seedAccount(fx.panelDir);
  const h = harness(fx.panelDir);
  const run = icacls(fx.panelDir, h, 5);
  await assert.rejects(start(fx, h, run), ConfigError);
  assert.equal(h.listens(), 0);
  assert.deepEqual(h.emitted, []);
  assert.equal(run.calls.length, 0);
});

test('local mode, list fails: starts, the warning comes before the first listener, and the Remote access screen lists the folder', async (t) => {
  const fx = fixture(t, undefined);
  const h = harness(fx.panelDir);
  const run = icacls(fx.panelDir, h, 5);
  const started = await start(fx, h, run);
  t.after(() => started.ok && started.stop());
  assert.equal(started.ok, true);
  const warning = `warning: ${fx.panelDir} could not be limited to your account, SYSTEM and Administrators (icacls exited 5); remote access will refuse to start until it can`;
  assert.ok(h.emitted.includes(warning));
  const order = h.log.map((e) => e.what);
  assert.ok(order.indexOf(`emit:${warning}`) < order.findIndex((w) => w.startsWith('listen:')));
  assert.equal(started.ctx.remote.panelAccess.state, 'failed');

  const sent = [];
  const res = { writeHead: (status, headers) => sent.push({ status, headers }), end: (body) => sent.push({ body }) };
  apiRemote({ method: 'GET', headers: {} }, res, started.ctx, { kind: 'loopback' });
  const body = JSON.parse(sent.find((s) => s.body !== undefined).body);
  assert.deepEqual(body.files, { looseModes: [fx.panelDir] });
});

test('local mode, list applied: no warning, and the screen shows no loose folder', async (t) => {
  const fx = fixture(t, undefined);
  const h = harness(fx.panelDir);
  const started = await start(fx, h, icacls(fx.panelDir, h, 0));
  t.after(() => started.ok && started.stop());
  assert.equal(h.emitted.some((l) => l.includes('could not be limited')), false);
  const sent = [];
  apiRemote({ method: 'GET', headers: {} }, { writeHead: () => {}, end: (b) => sent.push(b) }, started.ctx, { kind: 'loopback' });
  assert.deepEqual(JSON.parse(sent[0]).files, { looseModes: [] });
});

test('config inside a vault (local mode): icacls is never run and the panel folder is not created', async (t) => {
  const fx = fixture(t, undefined, { configInVault: true });
  const h = harness(fx.panelDir);
  const run = icacls(fx.panelDir, h, 0);
  const started = await start(fx, h, run);
  t.after(() => started.ok && started.stop());
  assert.equal(run.calls.length, 0);
  assert.equal(started.ctx.remote.panelAccess.state, 'inside-vault');
  assert.equal(fs.existsSync(fx.panelDir), false);
});

test('a missing account name on Windows refuses a remote mode with the account reason', async (t) => {
  const fx = fixture(t, MODES.proxy);
  await seedAccount(fx.panelDir);
  const h = harness(fx.panelDir);
  const run = icacls(fx.panelDir, h, 0);
  await assert.rejects(
    start(fx, h, run, { env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\x' } }),
    (err) => err instanceof ConfigError && err.message.endsWith('(the account name could not be read); nothing was started'),
  );
  assert.equal(run.calls.length, 0);
  assert.equal(h.listens(), 0);
});

test('POSIX (the real platform, no panelAccess override): icacls is never run and the behaviour is unchanged', async (t) => {
  if (process.platform === 'win32') return t.skip('this check is for a non-Windows platform');
  const fx = fixture(t, undefined);
  const h = harness(fx.panelDir);
  const run = icacls(fx.panelDir, h, 5);
  const started = await startAdminPanel({ admin: true, config: fx.configPath }, 'alpha', {
    emit: h.emit,
    startLocalListener: h.startLocalListener,
    startPanelListener: h.startPanelListener,
    createToken: () => LAUNCH_CODE,
    panelAccess: { run },
  });
  t.after(() => started.ok && started.stop());
  assert.equal(started.ok, true);
  assert.equal(run.calls.length, 0);
  assert.equal(started.ctx.remote.panelAccess.state, 'posix');
  assert.deepEqual(h.emitted, []);
});
