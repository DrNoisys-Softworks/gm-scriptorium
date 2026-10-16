'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const smol = require('smol-toml');
const { installLoopbackGuard } = require('./helpers/net-stubs');

const { runRemoteCommand } = require('../src/cli/remote');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

/*
 * ADR 0057, section 7 ("Remote access at sign-in asks again"): `remote set` asks "Also start remote
 * access when you sign in to Windows?" when it changes the mode to a remote mode while Start with
 * Windows is on; `remote off` clears the answer. Run in process with injected streams, so nothing
 * touches a terminal, a registry or a real config.
 */

const QUESTION = 'Also start remote access when you sign in to Windows?';
const PANEL_ACCESS = { platform: 'linux', env: {} };

function fixture(t, extraToml = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-signin-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "long-lease"', '', '[campaigns.long-lease]', `vault = '${vault}'`, `output = '${path.join(root, 'out')}'`, ''].join('\n') + extraToml);
  return { root, configPath };
}

const read = (configPath) => JSON.parse(JSON.stringify(smol.parse(fs.readFileSync(configPath, 'utf8'))));

function streams({ tty, answer }) {
  const stdin = new PassThrough();
  stdin.isTTY = tty;
  if (answer !== undefined) stdin.write(answer);
  if (answer === undefined && tty) stdin.end(); // a terminal that closes: no answer
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (c) => { text += c; });
  return { stdin, stdout, text: () => text };
}

// Two obvious placeholder computers; no real name is ever used.
const PC_A = 'PC-A';
const PC_B = 'PC-B';

async function set(configPath, flags, { tty = false, answer, present = true, pc = PC_A, platform = 'linux' } = {}) {
  const s = streams({ tty, answer });
  const result = await runRemoteCommand({ config: configPath, ...flags }, 'set', [], { stdin: s.stdin, stdout: s.stdout, panelAccess: PANEL_ACCESS, runValuePresent: () => present, hostname: () => pc, platform });
  return { ...result, asked: s.text().includes(QUESTION), prompt: s.text() };
}

const SSH = { mode: 'ssh' };

test('an explicit yes, with Start with Windows on, saves the confirmation in [desktop] through the config writer', async (t) => {
  const { configPath } = fixture(t);
  const r = await set(configPath, SSH, { tty: true, answer: 'y\n' });
  assert.equal(r.exitCode, 0);
  assert.ok(r.asked, 'the question was put');
  assert.equal(read(configPath).remote.mode, 'ssh');
  assert.deepEqual(read(configPath).desktop, { remote_at_signin: true, remote_at_signin_pc: PC_A });
});

test('"yes" in any case counts; anything else, an empty answer, and a closed terminal are No', async (t) => {
  for (const [answer, expected] of [['YES\n', true], ['Yes\n', true], ['n\n', false], ['\n', false], ['no\n', false], ['sure\n', false], ['yy\n', false], [undefined, false]]) {
    const { configPath } = fixture(t);
    const r = await set(configPath, SSH, { tty: true, answer });
    assert.ok(r.asked, JSON.stringify(answer));
    assert.equal(read(configPath).desktop === undefined ? false : read(configPath).desktop.remote_at_signin === true, expected, JSON.stringify(answer));
  }
});

test('no terminal (or --json style piping) is treated as No, writes nothing, and says so', async (t) => {
  const { configPath } = fixture(t);
  const r = await set(configPath, SSH, { tty: false });
  assert.equal(r.exitCode, 0);
  assert.equal(r.asked, false, 'nothing to ask on');
  assert.equal(read(configPath).desktop, undefined);
  assert.match(r.human, /Remote access will not start when you sign in to Windows \(there was no terminal to ask\)/);
});

test('with Start with Windows off, nothing is asked and nothing is saved', async (t) => {
  const { configPath } = fixture(t);
  const r = await set(configPath, SSH, { tty: true, answer: 'y\n', present: false });
  assert.equal(r.asked, false);
  assert.equal(read(configPath).desktop, undefined);
  assert.doesNotMatch(r.human, /sign in to Windows/);
});

test('on a machine with no tray helper beside the program, the real check says "off" and nothing is asked', async (t) => {
  const { configPath } = fixture(t);
  const s = streams({ tty: true, answer: 'y\n' });
  const r = await runRemoteCommand({ config: configPath, ...SSH }, 'set', [], { stdin: s.stdin, stdout: s.stdout, panelAccess: PANEL_ACCESS });
  assert.equal(r.exitCode, 0);
  assert.ok(!s.text().includes(QUESTION));
  assert.equal(read(configPath).desktop, undefined);
});

test('moving to a different remote mode asks again, and an answer of No withdraws the earlier yes', async (t) => {
  const { configPath } = fixture(t);
  await set(configPath, SSH, { tty: true, answer: 'y\n' });
  assert.equal(read(configPath).desktop.remote_at_signin, true);
  const r = await set(configPath, { mode: 'proxy', 'admin-url': 'https://scriptorium.home.arpa', 'preview-url': 'https://preview.scriptorium.home.arpa', 'trusted-proxy': '192.0.2.10', port: '9600', 'preview-port': '9601' }, { tty: true, answer: 'n\n' });
  assert.equal(r.exitCode, 0, r.human);
  assert.ok(r.asked, 'asked again');
  assert.equal(read(configPath).remote.mode, 'proxy');
  assert.equal(read(configPath).desktop, undefined, 'the table is dropped when it empties');
});

test('moving to a different remote mode and saying yes again keeps the confirmation', async (t) => {
  const { configPath } = fixture(t);
  await set(configPath, SSH, { tty: true, answer: 'y\n' });
  const r = await set(configPath, { mode: 'tailscale', 'admin-url': 'https://panel.example-tailnet.ts.net', 'preview-url': 'https://panel.example-tailnet.ts.net:8443', port: '9600', 'preview-port': '9601' }, { tty: true, answer: 'yes\n' });
  assert.equal(r.exitCode, 0, r.human);
  assert.ok(r.asked);
  assert.equal(read(configPath).desktop.remote_at_signin, true);
});

test('changing something else while the mode stays the same asks nothing and leaves the answer alone', async (t) => {
  const { configPath } = fixture(t);
  await set(configPath, SSH, { tty: true, answer: 'y\n' });
  const r = await set(configPath, { port: '9600', 'preview-port': '9601' }, { tty: true, answer: 'n\n' });
  assert.equal(r.asked, false);
  assert.equal(read(configPath).desktop.remote_at_signin, true);
  assert.equal(read(configPath).remote.port, 9600);
});

test('going to local asks nothing', async (t) => {
  const { configPath } = fixture(t);
  await set(configPath, SSH, { tty: true, answer: 'y\n' });
  const r = await set(configPath, { mode: 'local' }, { tty: true, answer: 'n\n' });
  assert.equal(r.asked, false);
});

test('only the [remote] and [desktop] tables change; the ports already saved in [desktop] stay', async (t) => {
  const { configPath } = fixture(t, '\n[desktop]\nport = 9500\npreview_port = 9501\n\n[update]\ncheck = false\n');
  const before = read(configPath);
  await set(configPath, SSH, { tty: true, answer: 'y\n' });
  const after = read(configPath);
  assert.deepEqual(after.campaigns, before.campaigns);
  assert.deepEqual(after.update, before.update);
  assert.deepEqual(after.desktop, { port: 9500, preview_port: 9501, remote_at_signin: true, remote_at_signin_pc: PC_A });
});

test('a [desktop] table that cannot be read does not stop remote set: the mode is saved and a warning says the choice was not', async (t) => {
  const { configPath } = fixture(t, '\n[desktop]\ncolour = 1\n');
  const r = await set(configPath, SSH, { tty: true, answer: 'y\n' });
  assert.equal(r.exitCode, 0);
  assert.equal(read(configPath).remote.mode, 'ssh');
  assert.deepEqual(read(configPath).desktop, { colour: 1 }, 'left as it was');
  assert.match(r.human, /the \[desktop\] settings could not be read, so the sign-in choice was not saved/);
});

test('remote off clears the confirmation and the computer name, keeps the saved ports, and drops [desktop] when nothing else is in it', async (t) => {
  const withPorts = fixture(t, '\n[remote]\nmode = "ssh"\nport = 9600\npreview_port = 9601\n\n[desktop]\nport = 9500\npreview_port = 9501\nremote_at_signin = true\n');
  const r = await runRemoteCommand({ config: withPorts.configPath }, 'off', [], { panelAccess: PANEL_ACCESS });
  assert.equal(r.exitCode, 0);
  assert.equal(read(withPorts.configPath).remote.mode, 'local');
  assert.deepEqual(read(withPorts.configPath).desktop, { port: 9500, preview_port: 9501 });

  const only = fixture(t, '\n[remote]\nmode = "ssh"\nport = 9600\npreview_port = 9601\n\n[desktop]\nremote_at_signin = true\n');
  await runRemoteCommand({ config: only.configPath }, 'off', [], { panelAccess: PANEL_ACCESS });
  assert.equal(read(only.configPath).desktop, undefined);
});

test('remote off with the confirmation set and no [remote] table still clears it', async (t) => {
  const { configPath } = fixture(t, '\n[desktop]\nremote_at_signin = true\n');
  await runRemoteCommand({ config: configPath }, 'off', [], { panelAccess: PANEL_ACCESS });
  assert.equal(read(configPath).desktop, undefined);
});

test('remote off with nothing to clear writes the file exactly as before (no [desktop] table appears)', async (t) => {
  const { configPath } = fixture(t, '\n[remote]\nmode = "ssh"\nport = 9600\npreview_port = 9601\n');
  await runRemoteCommand({ config: configPath }, 'off', [], { panelAccess: PANEL_ACCESS });
  assert.equal(read(configPath).desktop, undefined);
  assert.equal(read(configPath).remote.mode, 'local');
});

test('remote off is still a way out when [desktop] cannot be read', async (t) => {
  const { configPath } = fixture(t, '\n[remote]\nmode = "ssh"\nport = 9600\npreview_port = 9601\n\n[desktop]\nremote_at_signin = "yes please"\n');
  const r = await runRemoteCommand({ config: configPath }, 'off', [], { panelAccess: PANEL_ACCESS });
  assert.equal(r.exitCode, 0);
  assert.equal(read(configPath).remote.mode, 'local');
  assert.equal(read(configPath).desktop.remote_at_signin, 'yes please', 'a table it cannot read is left alone');
});

// --- RV1b: the answer counts only on the computer that gave it ---------------------------------------------------------

const SAVED_A = '\n[remote]\nmode = "ssh"\nport = 9600\npreview_port = 9601\n\n[desktop]\nremote_at_signin = true\nremote_at_signin_pc = "PC-A"\n';

test('RV1b: the name of the computer that said yes is saved next to the answer', async (t) => {
  const { configPath } = fixture(t);
  await set(configPath, SSH, { tty: true, answer: 'y\n', pc: PC_B });
  assert.deepEqual(read(configPath).desktop, { remote_at_signin: true, remote_at_signin_pc: PC_B });
});

test('RV1b: on the same computer the saved answer holds, so a change of port asks nothing', async (t) => {
  const { configPath } = fixture(t, SAVED_A);
  const r = await set(configPath, { port: '9610', 'preview-port': '9611' }, { tty: true, answer: 'n\n', pc: PC_A });
  assert.equal(r.asked, false);
  assert.deepEqual(read(configPath).desktop, { remote_at_signin: true, remote_at_signin_pc: PC_A });
});

test('RV1b: on another computer the question is asked again even with the same mode, and a No clears both keys', async (t) => {
  const { configPath } = fixture(t, SAVED_A);
  const r = await set(configPath, { port: '9610', 'preview-port': '9611' }, { tty: true, answer: 'n\n', pc: PC_B });
  assert.ok(r.asked, 'asked on the other computer');
  assert.equal(read(configPath).desktop, undefined);
});

test('RV1b: on another computer a Yes replaces the name with this computer', async (t) => {
  const { configPath } = fixture(t, SAVED_A);
  await set(configPath, { port: '9610', 'preview-port': '9611' }, { tty: true, answer: 'y\n', pc: PC_B });
  assert.deepEqual(read(configPath).desktop, { remote_at_signin: true, remote_at_signin_pc: PC_B });
});

test('RV1b: a legacy true with no computer name counts as no, so it is asked again', async (t) => {
  const { configPath } = fixture(t, '\n[remote]\nmode = "ssh"\nport = 9600\npreview_port = 9601\n\n[desktop]\nremote_at_signin = true\n');
  const r = await set(configPath, { port: '9610', 'preview-port': '9611' }, { tty: true, answer: 'y\n' });
  assert.ok(r.asked);
  assert.deepEqual(read(configPath).desktop, { remote_at_signin: true, remote_at_signin_pc: PC_A });
});

test('RV1b: with no terminal, a stale answer from another computer is cleared and the output says why', async (t) => {
  const { configPath } = fixture(t, SAVED_A);
  const r = await set(configPath, { port: '9610', 'preview-port': '9611' }, { tty: false, pc: PC_B });
  assert.equal(r.asked, false);
  assert.equal(read(configPath).desktop, undefined);
  assert.match(r.human, /will not start when you sign in to Windows \(there was no terminal to ask\)/);
});

test('RV1b: names are compared without regard to case on Windows, and exactly elsewhere', async (t) => {
  const win = fixture(t, SAVED_A);
  const w = await set(win.configPath, { port: '9610', 'preview-port': '9611' }, { tty: true, answer: 'n\n', pc: 'pc-a', platform: 'win32' });
  assert.equal(w.asked, false, 'win32: pc-a is PC-A');
  const nix = fixture(t, SAVED_A);
  const n = await set(nix.configPath, { port: '9610', 'preview-port': '9611' }, { tty: true, answer: 'n\n', pc: 'pc-a', platform: 'linux' });
  assert.ok(n.asked, 'linux: pc-a is not PC-A');
});

test('RV1b: remote off clears the answer and the computer name together', async (t) => {
  const { configPath } = fixture(t, SAVED_A);
  await runRemoteCommand({ config: configPath }, 'off', [], { panelAccess: PANEL_ACCESS });
  assert.equal(read(configPath).desktop, undefined);
  const named = fixture(t, '\n[desktop]\nport = 9500\npreview_port = 9501\nremote_at_signin_pc = "PC-A"\n');
  await runRemoteCommand({ config: named.configPath }, 'off', [], { panelAccess: PANEL_ACCESS });
  assert.deepEqual(read(named.configPath).desktop, { port: 9500, preview_port: 9501 }, 'a leftover name is cleared too');
});

test('RV1b: a bad computer name in [desktop] is refused with one line', () => {
  const { parseDesktopTable } = require('../src/config/desktopsettings');
  for (const bad of [5, true, '', '   ', 'a\nb', 'x'.repeat(300)]) {
    assert.throws(() => parseDesktopTable({ remote_at_signin_pc: bad }), /^ConfigError: desktop: remote_at_signin_pc must be the name of a computer$|desktop: remote_at_signin_pc must be the name of a computer/);
  }
  assert.doesNotThrow(() => parseDesktopTable({ remote_at_signin_pc: 'PC-A' }));
});

test('RV1b: confirmedHere is true only for a true answer naming this computer', () => {
  const { confirmedHere } = require('../src/config/desktopsettings');
  assert.equal(confirmedHere({ remote_at_signin: true, remote_at_signin_pc: PC_A }, PC_A), true);
  assert.equal(confirmedHere({ remote_at_signin: true, remote_at_signin_pc: PC_A }, PC_B), false);
  assert.equal(confirmedHere({ remote_at_signin: true }, PC_A), false, 'legacy');
  assert.equal(confirmedHere({ remote_at_signin: false, remote_at_signin_pc: PC_A }, PC_A), false);
  assert.equal(confirmedHere({ remote_at_signin_pc: PC_A }, PC_A), false);
  assert.equal(confirmedHere(undefined, PC_A), false);
  assert.equal(confirmedHere({ remote_at_signin: true, remote_at_signin_pc: PC_A }, ''), false);
  assert.equal(confirmedHere({ remote_at_signin: true, remote_at_signin_pc: PC_A }, undefined), false);
});
