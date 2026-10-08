'use strict';

/*
 * Launch mode's console, keys, pause, signals and remote-mode behaviour, with injected streams
 * (isTTY and setRawMode stubs), an EventEmitter for signals and a recording opener (openFile:
 * below never opens anything). Expected console text is written out by hand; ports for the remote
 * cases are fixed in the 9460s and bound under the shared test lock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const { scratchRoot, copySample, configPathIn } = require('./helpers/setup-fixtures');

const { shouldLaunch, runLaunch } = require('../src/cli/launch');
const { startAdminPanel } = require('../src/cli/serve-admin');
const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');
const { launchLines, attachKeys } = require('../src/launch/console');
const { remoteAddressLines, parseRemoteTable, listenPlan } = require('../src/remote/settings');
const { VaultUnreachableError } = require('../src/util/errors');
const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');

const REPO = path.join(__dirname, '..');
const PRESS_ENTER = 'Press Enter to close this window.';
const APOS = '\u2019';

async function until(fn, what, ms = 8000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// --- shouldLaunch -------------------------------------------------------------------------------------

test('shouldLaunch: only no command, no flag but --config <path>, and a terminal on both ends', () => {
  const base = { positional: [], flags: {}, stdinIsTTY: true, stdoutIsTTY: true };
  assert.equal(shouldLaunch(base), true);
  assert.equal(shouldLaunch({ ...base, flags: { config: 'C:\\x\\config.toml' } }), true);
  assert.equal(shouldLaunch({ ...base, positional: ['check'] }), false, 'a command');
  assert.equal(shouldLaunch({ ...base, positional: ['init'] }), false);
  assert.equal(shouldLaunch({ ...base, flags: { config: true } }), false, '--config with no value');
  assert.equal(shouldLaunch({ ...base, flags: { help: true } }), false);
  assert.equal(shouldLaunch({ ...base, flags: { version: true } }), false);
  assert.equal(shouldLaunch({ ...base, flags: { notices: true } }), false);
  assert.equal(shouldLaunch({ ...base, flags: { json: true } }), false);
  assert.equal(shouldLaunch({ ...base, flags: { admin: true } }), false);
  assert.equal(shouldLaunch({ ...base, flags: { config: 'x', json: true } }), false, 'config plus another flag');
  assert.equal(shouldLaunch({ ...base, flags: { campaign: 'x' } }), false);
  assert.equal(shouldLaunch({ ...base, stdinIsTTY: false }), false, 'stdin is not a terminal');
  assert.equal(shouldLaunch({ ...base, stdoutIsTTY: false }), false, 'stdout is not a terminal');
  assert.equal(shouldLaunch({ ...base, stdinIsTTY: undefined }), false);
});

// --- launchLines and attachKeys (pure) ------------------------------------------------------------------

test('launchLines: the console text, in the mock order, with U+2019 in the last line', () => {
  assert.deepEqual(launchLines({ version: '1.2.3', port: 7400, setupMode: true }), [
    'GM-Scriptorium 1.2.3',
    '',
    'GM-Scriptorium is running. Your panel is open in your browser.',
    'Close this window to stop.',
    '',
    '  Panel    http://127.0.0.1:7400   this PC only',
    '  Setup    no campaign yet, so the panel starts with setup',
    '',
    `Browser didn${APOS}t open? Press O to open it again.`,
  ]);
  assert.deepEqual(launchLines({ version: '1.2.3', port: 7400, setupMode: false, campaign: 'lease' }).slice(5, 8), [
    '  Panel    http://127.0.0.1:7400   this PC only',
    '  Campaign lease',
    '',
  ]);
  assert.equal(APOS, '\u2019');
  assert.equal(launchLines({ version: 'v', port: 1, setupMode: true }).at(-1).charCodeAt(12), 0x2019);
});

test('launchLines: a remote mode says "on this machine" and lists the remote addresses before the Setup or Campaign line', () => {
  const lines = launchLines({ version: 'v', port: 7926, setupMode: false, campaign: 'lease', remoteLines: ['remote admin panel: https://a.example/ (sign in with the panel password)', 'remote preview: https://p.example/'] });
  assert.deepEqual(lines.slice(5, 9), [
    '  Panel    http://127.0.0.1:7926   on this machine',
    '  remote admin panel: https://a.example/ (sign in with the panel password)',
    '  remote preview: https://p.example/',
    '  Campaign lease',
  ]);
});

test('remoteAddressLines: local has none; ssh has the tunnel line; tailscale, proxy and direct have the three address lines; never a token', () => {
  const plan = (mode, extra) => {
    const settings = parseRemoteTable({ mode, ...extra });
    return { settings, plan: listenPlan(settings, {}) };
  };
  const info = { adminPort: 7400, previewPort: 7401, user: 'gm', host: 'box' };
  const local = plan('local', {});
  assert.deepEqual(remoteAddressLines(local.settings, local.plan, info), []);
  const ssh = plan('ssh', {});
  assert.deepEqual(remoteAddressLines(ssh.settings, ssh.plan, info), ['tunnel from your desktop: ssh -L 7400:127.0.0.1:7400 -L 7401:127.0.0.1:7401 gm@box']);
  const ts = plan('tailscale', { port: 7926, preview_port: 7927, admin_url: 'https://panel-host.example-tailnet.ts.net', preview_url: 'https://panel-host.example-tailnet.ts.net:8443' });
  assert.deepEqual(remoteAddressLines(ts.settings, ts.plan, { adminPort: 7926, previewPort: 7927 }), [
    'remote admin panel: https://panel-host.example-tailnet.ts.net/ (sign in with the panel password)',
    'remote preview: https://panel-host.example-tailnet.ts.net:8443/',
    'listening on 127.0.0.1 port 7926 (panel) and 7927 (preview)',
  ]);
  const proxy = plan('proxy', { port: 7924, preview_port: 7925, admin_url: 'https://scriptorium.home.arpa', preview_url: 'https://preview.scriptorium.home.arpa', bind: '192.0.2.42', trusted_proxies: ['198.51.100.20'] });
  assert.equal(remoteAddressLines(proxy.settings, proxy.plan, { adminPort: 7924, previewPort: 7925 })[2], 'listening on 192.0.2.42 and 127.0.0.1 port 7924 (panel) and 7925 (preview)');
  for (const l of [...remoteAddressLines(ts.settings, ts.plan, info), ...remoteAddressLines(proxy.settings, proxy.plan, info)]) assert.ok(!/token/.test(l));
});

test('attachKeys: O and o call onOpen, byte 0x03 calls onStop and nothing after it, every other key (and any escape sequence) is ignored, detach restores the terminal', () => {
  const input = new PassThrough();
  const rawCalls = [];
  input.setRawMode = (on) => rawCalls.push(on);
  const events = [];
  const detach = attachKeys(input, { onOpen: () => events.push('open'), onStop: () => events.push('stop') });
  assert.deepEqual(rawCalls, [true]);
  for (const chunk of ['o', 'O', 'x', '\r', 'q', ' ', '\u001b[A', '\u001bOA', '\u001b', '0', 'ó']) input.emit('data', Buffer.from(chunk, 'utf8'));
  assert.deepEqual(events, ['open', 'open']);
  input.emit('data', Buffer.from('xoO\u0003oo'));
  assert.deepEqual(events, ['open', 'open', 'open', 'open', 'stop'], 'o before the 0x03 count; nothing after it');
  assert.equal(input.listenerCount('data'), 1);
  detach();
  detach();
  assert.deepEqual(rawCalls, [true, false]);
  assert.equal(input.listenerCount('data'), 0);
  const plain = new PassThrough(); // no setRawMode (a pipe): still works
  const seen = [];
  const d2 = attachKeys(plain, { onOpen: () => seen.push('o'), onStop: () => seen.push('s') });
  plain.emit('data', 'o');
  d2();
  assert.deepEqual(seen, ['o']);
});

// --- runLaunch harness ------------------------------------------------------------------------------------------

function makeStreams() {
  const input = new PassThrough();
  input.isTTY = true;
  input.rawCalls = [];
  input.setRawMode = (on) => {
    input.rawCalls.push(on);
    input.raw = on;
    return input;
  };
  const output = new PassThrough();
  output.isTTY = true;
  const state = { text: '' };
  output.on('data', (c) => {
    state.text += c;
  });
  return { input, output, state };
}

function listenerTotals(em, names = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  return Object.fromEntries(names.map((n) => [n, em.listenerCount(n)]));
}

/** Starts runLaunch with injected everything. `startPanel` may wrap the real one. */
async function launch(t, { flags, root = scratchRoot(t), configPath = configPathIn(root), openResult, platform = 'linux', startPanelWrap, deps = {} } = {}) {
  const { input, output, state } = makeStreams();
  const signals = new EventEmitter();
  const opened = [];
  const errors = [];
  const order = [];
  let panel = null;
  const runDeps = {
    input,
    output,
    signals,
    platform,
    env: { PATH: '/nonexistent', DISPLAY: ':1' },
    openFile: async (opts) => {
      opened.push({ opts, html: fs.existsSync(opts.target) ? fs.readFileSync(opts.target, 'utf8') : null });
      const r = typeof openResult === 'function' ? await openResult(opts, opened.length) : openResult;
      if (r instanceof Error) throw r;
      return r || { outcome: 'exited', exitCode: 0, signal: null };
    },
    killAll: async () => {
      order.push('killAll');
    },
    startPanel: async (f, c, o) => {
      panel = await (startPanelWrap ? startPanelWrap(f, c, o, order) : startAdminPanel(f, c, o));
      if (panel.ok) {
        const realStop = panel.stop;
        panel.stop = async () => {
          order.push(opened.length > 0 && opened[0].html !== null && fs.existsSync(opened[0].opts.target) ? 'panel.stop(file present)' : 'panel.stop(file gone)');
          return realStop();
        };
      }
      return panel;
    },
    version: '9.9.9',
    reportError: (err) => (errors.push(err), 3),
    ...deps,
  };
  const origRaw = input.setRawMode;
  input.setRawMode = (on) => {
    if (on === false) order.push('raw off');
    return origRaw(on);
  };
  const run = runLaunch(flags === undefined ? { config: configPath } : flags, runDeps);
  let finished = false;
  run.then(() => {
    finished = true;
  });
  t.after(async () => {
    if (!finished) {
      signals.emit('SIGINT');
      await run.catch(() => {});
    }
  });
  return { input, output, state, signals, opened, errors, order, run, root, configPath, get panel() { return panel; }, get finished() { return finished; } };
}

const codeOf = (html) => /name="code" value="([A-Za-z0-9_-]+)"/.exec(html)[1];

// --- the console text in setup mode and campaign mode ------------------------------------------------------------------

test('setup mode: the console text is exactly the mock text, with the real port, and no token', async (t) => {
  const h = await launch(t);
  await until(() => h.opened.length === 1 && h.panel && h.panel.ok, 'startup');
  const port = h.panel.ctx.adminPort;
  const expected = [
    'GM-Scriptorium 9.9.9',
    '',
    'GM-Scriptorium is running. Your panel is open in your browser.',
    'Close this window to stop.',
    '',
    `  Panel    http://127.0.0.1:${port}   this PC only`,
    '  Setup    no campaign yet, so the panel starts with setup',
    '',
    `Browser didn${APOS}t open? Press O to open it again.`,
    '',
  ].join('\n');
  await until(() => h.state.text.length >= expected.length, 'the console text');
  assert.equal(h.state.text, expected);
  assert.ok(!h.state.text.includes(h.panel.token), 'the token is never printed');
  assert.ok(!h.state.text.includes('token='));
  assert.ok(!h.state.text.includes('/auth'));
  assert.equal(h.input.raw, true, 'raw keys are on while running');
});

test('campaign mode: a Campaign line instead of the Setup line', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root, 'vault', { withPack: true });
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = '${vault}'`, `output = '${path.join(root, 'site')}'`, ''].join('\n'));
  const h = await launch(t, { root, configPath });
  await until(() => h.opened.length === 1, 'startup');
  const lines = h.state.text.split('\n');
  assert.equal(lines[6], '  Campaign lease');
  assert.ok(!lines.some((l) => l.includes('Setup')));
  assert.ok(!h.state.text.includes(h.panel.token));
});

test('after startup the console is silent: other keys, Enter and arrows write nothing', async (t) => {
  const h = await launch(t);
  await until(() => h.opened.length === 1, 'startup');
  const before = h.state.text;
  for (const k of ['x', '\r', 'q', '\u001b[A', '\u001bOA', ' ', '\u007f']) h.input.write(k);
  await until(() => h.input.readableLength === 0, 'the keys to be read');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.state.text, before);
  assert.equal(h.opened.length, 1, 'no key but O opens anything');
});

// --- O -----------------------------------------------------------------------------------------------------------------

test('O mints a fresh code and opens again; the opener is given the file and the environment only', async (t) => {
  const h = await launch(t);
  await until(() => h.opened.length === 1, 'the first open');
  h.input.write('O');
  await until(() => h.opened.length === 2, 'the second open');
  assert.notEqual(codeOf(h.opened[0].html), codeOf(h.opened[1].html));
  for (const o of h.opened) {
    assert.deepEqual(Object.keys(o.opts).sort(), ['env', 'target']);
    assert.equal(path.basename(o.opts.target), `launch-${process.pid}.html`);
    assert.deepEqual(o.opts.env, { PATH: '/nonexistent', DISPLAY: ':1' });
  }
  assert.equal(h.state.text.split('Press O').length - 1, 1, 'nothing extra is printed for a successful O');
});

// --- Ctrl+C --------------------------------------------------------------------------------------------------------------

test('byte 0x03 in raw mode stops cleanly: exit 0, no pause, raw mode off, no listener left, launcher gone', async (t) => {
  const h = await launch(t);
  await until(() => h.opened.length === 1, 'startup');
  const file = h.opened[0].opts.target;
  assert.ok(fs.existsSync(file));
  assert.equal(h.input.raw, true);
  h.input.write('\u0003');
  assert.equal(await h.run, 0);
  assert.ok(!h.state.text.includes(PRESS_ENTER), 'a deliberate stop does not pause');
  assert.equal(h.input.raw, false);
  assert.equal(h.input.listenerCount('data'), 0);
  assert.deepEqual(listenerTotals(h.signals), { SIGINT: 0, SIGTERM: 0, SIGBREAK: 0, SIGHUP: 0 });
  assert.equal(fs.existsSync(file), false);
});

test('the stop path runs in order: launcher file, then the listeners and preview folder, then killAll, then the terminal is restored', async (t) => {
  const h = await launch(t);
  await until(() => h.opened.length === 1, 'startup');
  h.input.write('\u0003');
  await h.run;
  assert.deepEqual(h.order, ['panel.stop(file gone)', 'killAll', 'raw off']);
});

for (const [signal, platform] of [['SIGINT', 'linux'], ['SIGTERM', 'linux'], ['SIGHUP', 'linux'], ['SIGHUP', 'win32'], ['SIGBREAK', 'win32']]) {
  test(`${signal} on ${platform} stops launch mode the same way (exit 0, no pause)`, async (t) => {
    const h = await launch(t, { platform });
    await until(() => h.opened.length === 1, 'startup');
    h.signals.emit(signal);
    assert.equal(await h.run, 0);
    assert.ok(!h.state.text.includes(PRESS_ENTER));
    assert.equal(h.input.raw, false);
    assert.deepEqual(h.order, ['panel.stop(file gone)', 'killAll', 'raw off']);
  });
}

// --- SIGHUP listener counts (nohup safety) -----------------------------------------------------------------------------------

test('SIGHUP listeners: linux launch 1, win32 launch 1; linux serve --admin 0 (a nohup keeps its ignore); all removed after the stop', async (t) => {
  const linux = await launch(t, { platform: 'linux' });
  await until(() => linux.opened.length === 1, 'linux startup');
  assert.equal(linux.signals.listenerCount('SIGHUP'), 1);
  assert.equal(linux.signals.listenerCount('SIGBREAK'), 0);
  const win = await launch(t, { platform: 'win32' });
  await until(() => win.opened.length === 1, 'win32 startup');
  assert.equal(win.signals.listenerCount('SIGHUP'), 1);
  assert.equal(win.signals.listenerCount('SIGBREAK'), 1);

  const root = scratchRoot(t);
  const signals = new EventEmitter();
  const emitted = [];
  const serving = runServeCommand({ admin: true, config: configPathIn(root) }, undefined, { emit: (l) => emitted.push(l), signals });
  await until(() => emitted.some((l) => l.startsWith('setup:')), 'serve --admin startup');
  if (process.platform === 'win32') assert.equal(signals.listenerCount('SIGHUP'), 1);
  else assert.equal(signals.listenerCount('SIGHUP'), 0, 'serve --admin on POSIX does not listen for SIGHUP');
  assert.equal(signals.listenerCount('SIGINT'), 1);
  signals.emit('SIGINT');
  await serving;

  linux.signals.emit('SIGINT');
  win.signals.emit('SIGINT');
  await Promise.all([linux.run, win.run]);
  assert.deepEqual(listenerTotals(linux.signals), { SIGINT: 0, SIGTERM: 0, SIGBREAK: 0, SIGHUP: 0 });
  assert.deepEqual(listenerTotals(win.signals), { SIGINT: 0, SIGTERM: 0, SIGBREAK: 0, SIGHUP: 0 });
});

// --- errors pause --------------------------------------------------------------------------------------------------------------

async function pausedRun(t, h, wantCode) {
  await until(() => h.state.text.includes(PRESS_ENTER), 'the pause prompt');
  assert.equal(h.finished, false, 'the window waits for Enter');
  h.input.write('\n');
  assert.equal(await h.run, wantCode);
}

test('a malformed config: the one-line message, the pause, and the exit code the mapper gives (3 for a config problem)', async (t) => {
  const root = scratchRoot(t);
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'config_version = [[[\n');
  const h = await launch(t, { root, configPath });
  await pausedRun(t, h, 3);
  assert.equal(h.errors.length, 1);
  assert.ok(h.errors[0] instanceof VaultUnreachableError, 'a config problem is the exit-3 error class');
  assert.match(h.errors[0].message, /config is not valid TOML/);
  assert.equal(h.opened.length, 0, 'nothing was opened');
});

test('two campaigns and no default: the message names both campaigns, then the pause', async (t) => {
  const root = scratchRoot(t);
  const configPath = configPathIn(root);
  const a = copySample(root, 'vault-a', { withPack: true });
  const b = copySample(root, 'vault-b', { withPack: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, ['config_version = 1', '', '[campaigns.alpha]', `vault = '${a}'`, '', '[campaigns.bravo]', `vault = '${b}'`, ''].join('\n'));
  const h = await launch(t, { root, configPath });
  await pausedRun(t, h, 3);
  assert.ok(h.errors[0] instanceof VaultUnreachableError);
  assert.match(h.errors[0].message, /alpha/);
  assert.match(h.errors[0].message, /bravo/);
  assert.match(h.errors[0].message, /no campaign specified and no default_campaign set, with 2 campaigns registered/);
});

test('a failed listener start prints its message, pauses, and returns the panel exit code', async (t) => {
  const h = await launch(t, { startPanelWrap: async () => ({ ok: false, exitCode: 1, human: 'failed to start server: port 8080 is already in use on 127.0.0.1' }) });
  await pausedRun(t, h, 1);
  assert.ok(h.state.text.startsWith('failed to start server: port 8080 is already in use on 127.0.0.1\n'));
  assert.ok(h.state.text.indexOf('failed to start server') < h.state.text.indexOf(PRESS_ENTER), 'the message comes before the pause prompt');
  assert.equal(h.opened.length, 0);
});

test('an unexpected error after the panel is up stops the panel, restores the terminal, then pauses and reports', async (t) => {
  const boom = new Error('boom after start');
  const h = await launch(t, {
    startPanelWrap: async (f, c, o) => {
      const r = await startAdminPanel(f, c, o);
      Object.defineProperty(r.ctx, 'campaign', { get() { throw boom; } });
      return r;
    },
  });
  await pausedRun(t, h, 3);
  assert.equal(h.errors[0], boom);
  assert.deepEqual(h.order.slice(0, 3), ['panel.stop(file gone)', 'killAll', 'raw off']);
  assert.deepEqual(h.input.rawCalls.slice(0, 2), [true, false], 'our raw keys were switched off before the prompt took the terminal');
  assert.deepEqual(listenerTotals(h.signals), { SIGINT: 0, SIGTERM: 0, SIGBREAK: 0, SIGHUP: 0 });
});

// --- opener failure -------------------------------------------------------------------------------------------------------------

test('an opener that rejects, or exits non-zero, prints the fallback with the token link; one that works, or is still running, prints nothing', async (t) => {
  const cases = [
    [Object.assign(new Error('no display'), { code: 'E_PROC_NO_DISPLAY' }), true],
    [{ outcome: 'exited', exitCode: 1, signal: null }, true],
    [{ outcome: 'exited', exitCode: null, signal: 'SIGKILL' }, true],
    [{ outcome: 'exited', exitCode: 0, signal: null }, false],
    [{ outcome: 'running' }, false],
  ];
  for (const [openResult, fallback] of cases) {
    const h = await launch(t, { openResult });
    await until(() => h.opened.length === 1, 'startup');
    if (fallback) {
      await until(() => h.state.text.includes('admin panel: '), 'the fallback line');
      const port = h.panel.ctx.adminPort;
      assert.ok(h.state.text.includes(`The browser couldn't be opened. Open this link instead:\nadmin panel: http://127.0.0.1:${port}/auth?token=${h.panel.token}\n`));
    } else {
      await new Promise((r) => setImmediate(r));
      assert.ok(!h.state.text.includes('The browser couldn'));
    }
    h.input.write('\u0003');
    await h.run;
  }
});

test('O after a failed open prints the fallback again (O retries)', async (t) => {
  let n = 0;
  const h = await launch(t, { openResult: () => (++n === 1 ? new Error('no') : { outcome: 'exited', exitCode: 0, signal: null }) });
  await until(() => h.state.text.includes('admin panel: '), 'the first fallback');
  h.input.write('o');
  await until(() => h.opened.length === 2, 'the retry');
  assert.equal(h.state.text.split('admin panel: ').length - 1, 1, 'the second open worked, so no second fallback');
});

// --- remote mode ---------------------------------------------------------------------------------------------------------------

function remoteConfig(root, remote) {
  const vault = copySample(root, 'vault', { withPack: true });
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const lines = ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = '${vault}'`, `output = '${path.join(root, 'site')}'`, '', '[remote]'];
  for (const [k, v] of Object.entries(remote)) lines.push(`${k} = ${JSON.stringify(v)}`);
  fs.writeFileSync(configPath, `${lines.join('\n')}\n`);
  return configPath;
}

test('ssh mode: the warning is emitted before the first listener opens, the console lists the tunnel line, the launcher targets loopback, no token anywhere', async (t) => {
  const root = scratchRoot(t);
  const configPath = remoteConfig(root, { mode: 'ssh', port: 9461, preview_port: 9462 });
  const seen = [];
  const h = await launch(t, {
    root,
    configPath,
    startPanelWrap: (f, c, o, order) =>
      startAdminPanel(f, c, {
        ...o,
        identity: { user: 'gm', host: 'box' },
        emit: (line) => {
          order.push(`emit:${line}`);
          seen.push(line);
          o.emit(line);
        },
        startLocalListener: async (handler, opts) => {
          order.push(`listen:${opts.port}`);
          return startLocalListener(handler, opts);
        },
      }),
  });
  await until(() => h.opened.length === 1, 'startup');
  const firstListen = h.order.findIndex((x) => x.startsWith('listen:'));
  const warning = h.order.findIndex((x) => x === 'emit:remote access: ssh tunnel (the panel listens on 127.0.0.1 only)');
  assert.ok(warning !== -1 && firstListen !== -1 && warning < firstListen, `the warning comes before the first listener: ${JSON.stringify(h.order)}`);
  const lines = h.state.text.split('\n');
  assert.ok(lines[0].startsWith('remote access: ssh tunnel'), 'the warning is the first thing printed');
  assert.ok(lines.includes('  Panel    http://127.0.0.1:9461   on this machine'));
  assert.ok(lines.includes('  tunnel from your desktop: ssh -L 9461:127.0.0.1:9461 -L 9462:127.0.0.1:9462 gm@box'));
  assert.ok(h.opened[0].html.includes('action="http://127.0.0.1:9461/auth/launch"'), 'auto-open targets the loopback address');
  assert.ok(!h.state.text.includes(h.panel.token));
});

test('tailscale mode: the warning first, the remote addresses without a token, the launcher exchange works over loopback and a remote-kind request is refused', async (t) => {
  const root = scratchRoot(t);
  const remote = { mode: 'tailscale', port: 9463, preview_port: 9464, admin_url: 'https://panel-host.example-tailnet.ts.net', preview_url: 'https://panel-host.example-tailnet.ts.net:8443' };
  const configPath = remoteConfig(root, remote);
  await pwWrite.writePasswordRecord(path.join(root, 'cfg', 'panel', 'password.json'), await pw.hashPassword('correct horse battery staple'));
  const panelCalls = [];
  const h = await launch(t, {
    root,
    configPath,
    startPanelWrap: (f, c, o, order) =>
      startAdminPanel(f, c, {
        ...o,
        emit: (line) => {
          order.push(`emit:${line}`);
          o.emit(line);
        },
        startPanelListener: async (handler, opts) => {
          panelCalls.push(opts);
          order.push(`listen:${opts.port}`);
          return require('../src/serve/server').startPanelListener(handler, opts);
        },
      }),
  });
  await until(() => h.opened.length === 1, 'startup');
  assert.equal(panelCalls.length, 2);
  const warningIdx = h.order.findIndex((x) => x.startsWith('emit:WARNING: remote access is on (mode tailscale)'));
  const listenIdx = h.order.findIndex((x) => x.startsWith('listen:'));
  assert.ok(warningIdx !== -1 && warningIdx < listenIdx, JSON.stringify(h.order));
  const lines = h.state.text.split('\n');
  assert.ok(lines[0].startsWith('WARNING: remote access is on (mode tailscale)'));
  assert.ok(lines.includes('  Panel    http://127.0.0.1:9463   on this machine'));
  assert.ok(lines.includes('  remote admin panel: https://panel-host.example-tailnet.ts.net/ (sign in with the panel password)'));
  assert.ok(lines.includes('  remote preview: https://panel-host.example-tailnet.ts.net:8443/'));
  assert.ok(lines.includes('  listening on 127.0.0.1 port 9463 (panel) and 9464 (preview)'));
  assert.ok(!h.state.text.includes(h.panel.token));
  assert.ok(!h.state.text.includes('token='));

  const post = (headers, body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: 9463, method: 'POST', path: '/auth/launch', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers }, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(body);
    });
  const code = codeOf(h.opened[0].html);
  // A remote-kind request (the configured external Host, via a trusted forwarder) is refused at the gate.
  const fwd = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' };
  const remoteExact = await post({ Host: 'panel-host.example-tailnet.ts.net', Origin: 'https://panel-host.example-tailnet.ts.net', ...fwd }, `code=${code}`);
  assert.equal(remoteExact.status, 403);
  assert.equal(remoteExact.text, 'refused: kind');
  const remoteNull = await post({ Host: 'panel-host.example-tailnet.ts.net', Origin: 'null', ...fwd }, `code=${code}`);
  assert.equal(remoteNull.status, 403);
  assert.equal(remoteNull.text, 'refused: origin');
  // The same code, over loopback, still works (neither refusal spent it).
  const ok = await post({ Origin: 'null' }, `code=${code}`);
  assert.equal(ok.status, 200);
  assert.match([].concat(ok.headers['set-cookie'])[0], /^scriptorium_admin_9463=/);
});

// --- flags and the real bin under a terminal ------------------------------------------------------------------------------------

test('--config is passed to the panel as the config flag, with no campaign argument; no flag means none', async (t) => {
  const calls = [];
  const h = await launch(t, {
    flags: {},
    startPanelWrap: async (f, c, o) => {
      calls.push([f, c]);
      return { ok: false, exitCode: 1, human: 'stop here' };
    },
  });
  await pausedRun(t, h, 1);
  const withConfig = await launch(t, {
    flags: { config: '/some/where/config.toml' },
    startPanelWrap: async (f, c) => {
      calls.push([f, c]);
      return { ok: false, exitCode: 1, human: 'stop here' };
    },
  });
  await pausedRun(t, withConfig, 1);
  assert.deepEqual(calls, [
    [{ admin: true }, undefined],
    [{ admin: true, config: '/some/where/config.toml' }, undefined],
  ]);
});

function whichScript() {
  return ['/usr/bin/script', '/bin/script', '/usr/local/bin/script'].find((p) => fs.existsSync(p));
}

/** Runs the real bin under a pseudo terminal (util-linux script) with a scratch PATH that holds no opener at all. */
function runBinUnderPty(root, args, { feed = [] } = {}) {
  const script = whichScript();
  const emptyBin = path.join(root, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  const cmd = [process.execPath, path.join(REPO, 'bin', 'scriptorium.js'), ...args].join(' ');
  const env = { PATH: emptyBin, HOME: root, SCRIPTORIUM_CONFIG: path.join(root, 'unused.toml'), XDG_CONFIG_HOME: path.join(root, 'xdg'), APPDATA: path.join(root, 'ad'), TERM: 'xterm' };
  const child = spawn(script, ['-qec', cmd, '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => {
    out += c;
  });
  const exit = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return { child, exit, out: () => out };
}

test('the real bin under a terminal: a malformed config prints the message, waits for Enter and exits 3', { skip: process.platform === 'win32' ? 'util-linux script is POSIX only' : false }, async (t) => {
  assert.ok(whichScript(), 'util-linux script is required for this test');
  const root = scratchRoot(t);
  const configPath = path.join(root, 'cfg', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'config_version = [[[\n');
  const r = runBinUnderPty(root, ['--config', configPath]);
  t.after(() => r.child.kill('SIGKILL'));
  await until(() => r.out().includes(PRESS_ENTER), 'the pause prompt');
  assert.match(r.out(), /config is not valid TOML/);
  r.child.stdin.write('\n');
  assert.equal(await r.exit, 3);
});

test('the real bin under a terminal: two campaigns and no default pauses and exits 3, naming both', { skip: process.platform === 'win32' ? 'util-linux script is POSIX only' : false }, async (t) => {
  const root = scratchRoot(t);
  const configPath = path.join(root, 'cfg', 'config.toml');
  const a = copySample(root, 'vault-a', { withPack: true });
  const b = copySample(root, 'vault-b', { withPack: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, ['config_version = 1', '', '[campaigns.alpha]', `vault = '${a}'`, '', '[campaigns.bravo]', `vault = '${b}'`, ''].join('\n'));
  const r = runBinUnderPty(root, ['--config', configPath]);
  t.after(() => r.child.kill('SIGKILL'));
  await until(() => r.out().includes(PRESS_ENTER), 'the pause prompt');
  assert.match(r.out(), /alpha/);
  assert.match(r.out(), /bravo/);
  r.child.stdin.write('\n');
  assert.equal(await r.exit, 3);
});
