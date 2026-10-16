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
 * ADR 0057, section 7 ("Turning it on and off from the tray"): `remote set` never asks. A change to a
 * different remote mode clears remote access at sign-in and, when the tray helper sits beside the program,
 * says where the tray item is; `remote off` clears it too. Turning it on is the tray's tick box and
 * `desktop set --remote-at-signin on` (test/desktop-cli.test.js). Run in process with injected streams,
 * so nothing touches a terminal, a registry or a real config.
 */

// The line `remote set` adds when the helper sits beside the program, typed from the ADR.
const TRAY_POINTER = '\nRemote access does not start when you sign in to Windows. To change that on this PC, tick "Remote access at sign-in" in the menu of the GM-Scriptorium icon in the system tray, or run "gm-scriptorium desktop set --remote-at-signin on".';
const PANEL_WARNING = '\nwarning: the [desktop] settings could not be read, so remote access at sign-in was left as it was';
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
  return { ...result, stdoutText: s.text(), unread: String(s.stdin.read()) };
}

const SSH = { mode: 'ssh' };

test('on a machine with no tray helper beside the program, the real check says "off": nothing is asked and no pointer is added', async (t) => {
  const { configPath } = fixture(t);
  const s = streams({ tty: true, answer: 'y\n' });
  const r = await runRemoteCommand({ config: configPath, ...SSH }, 'set', [], { stdin: s.stdin, stdout: s.stdout, panelAccess: PANEL_ACCESS });
  assert.equal(r.exitCode, 0);
  assert.equal(s.text(), '');
  assert.equal(String(s.stdin.read()), 'y\n');
  assert.equal(r.human.includes(TRAY_POINTER), false);
  assert.equal(read(configPath).desktop, undefined);
});

test('R1: remote set never asks, even at a terminal with an answer waiting; the mode is saved and no [desktop] table appears', async (t) => {
  const { configPath } = fixture(t);
  const r = await set(configPath, SSH, { tty: true, answer: 'y\n' });
  assert.equal(r.exitCode, 0);
  assert.equal(r.unread, 'y\n');
  assert.equal(r.stdoutText, '');
  assert.equal(read(configPath).remote.mode, 'ssh');
  assert.equal(read(configPath).desktop, undefined);
});

test('R2: with the helper beside the program and no terminal, the output ends with the tray pointer and never says there was no terminal', async (t) => {
  const { configPath } = fixture(t);
  const r = await set(configPath, SSH, { tty: false, present: true });
  assert.equal(r.exitCode, 0);
  assert.equal(r.human.endsWith(TRAY_POINTER), true, r.human);
  assert.equal(r.human.includes('there was no terminal to ask'), false);
});

test('R3: with no helper beside the program there is no pointer', async (t) => {
  const { configPath } = fixture(t);
  const r = await set(configPath, SSH, { tty: true, answer: 'y\n', present: false });
  assert.equal(r.stdoutText, '');
  assert.equal(r.human.includes(TRAY_POINTER), false);
  assert.equal(r.human.includes('Remote access at sign-in'), false);
  assert.equal(read(configPath).desktop, undefined);
});

const PROXY_FLAGS = { mode: 'proxy', 'admin-url': 'https://scriptorium.home.arpa', 'preview-url': 'https://preview.scriptorium.home.arpa', 'trusted-proxy': '192.0.2.10', port: '9600', 'preview-port': '9601' };

test('R4: moving to a different remote mode clears a saved yes (both keys), asks nothing and drops the emptied table', async (t) => {
  const { configPath } = fixture(t, SAVED_A);
  const r = await set(configPath, PROXY_FLAGS, { tty: true, answer: 'y\n' });
  assert.equal(r.exitCode, 0, r.human);
  assert.equal(r.stdoutText, '');
  assert.equal(r.unread, 'y\n');
  assert.equal(read(configPath).remote.mode, 'proxy');
  assert.equal(read(configPath).desktop, undefined);
});

test('R5: a mode change clears only the two keys: the saved ports, campaigns and [update] stay', async (t) => {
  const { configPath } = fixture(t, '\n[desktop]\nport = 9500\npreview_port = 9501\nremote_at_signin = true\nremote_at_signin_pc = "PC-A"\n\n[update]\ncheck = false\n');
  const before = read(configPath);
  await set(configPath, SSH, { tty: true });
  const after = read(configPath);
  assert.deepEqual(after.desktop, { port: 9500, preview_port: 9501 });
  assert.deepEqual(after.campaigns, before.campaigns);
  assert.deepEqual(after.update, before.update);
});

test('changing something else while the mode stays the same asks nothing and leaves the answer alone', async (t) => {
  const { configPath } = fixture(t, SAVED_A);
  const r = await set(configPath, { port: '9610', 'preview-port': '9611' }, { tty: true, answer: 'n\n' });
  assert.equal(r.stdoutText, '');
  assert.equal(r.unread, 'n\n');
  assert.equal(read(configPath).desktop.remote_at_signin, true);
  assert.equal(read(configPath).remote.port, 9610);
});

test('going to local asks nothing', async (t) => {
  const { configPath } = fixture(t, SAVED_A);
  const r = await set(configPath, { mode: 'local' }, { tty: true, answer: 'n\n' });
  assert.equal(r.stdoutText, '');
  assert.equal(r.unread, 'n\n');
});

test('a [desktop] table that cannot be read does not stop remote set: the mode is saved and a warning says the setting was left as it was', async (t) => {
  const { configPath } = fixture(t, '\n[desktop]\ncolour = 1\n');
  const r = await set(configPath, SSH, { tty: true, answer: 'y\n' });
  assert.equal(r.exitCode, 0);
  assert.equal(read(configPath).remote.mode, 'ssh');
  assert.deepEqual(read(configPath).desktop, { colour: 1 }, 'left as it was');
  assert.equal(r.human.endsWith(`${TRAY_POINTER}${PANEL_WARNING}`), true, r.human);
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

test('RV1b: on the same computer the saved answer holds, so a change of port asks nothing', async (t) => {
  const { configPath } = fixture(t, SAVED_A);
  const r = await set(configPath, { port: '9610', 'preview-port': '9611' }, { tty: true, answer: 'n\n', pc: PC_A });
  assert.equal(r.stdoutText, '');
  assert.deepEqual(read(configPath).desktop, { remote_at_signin: true, remote_at_signin_pc: PC_A });
});

test('R7: on another computer a same-mode remote set leaves the stale answer alone and asks nothing (it is inert there)', async (t) => {
  const { configPath } = fixture(t, SAVED_A);
  const r = await set(configPath, { port: '9610', 'preview-port': '9611' }, { tty: true, answer: 'y\n', pc: PC_B });
  assert.equal(r.stdoutText, '');
  assert.equal(r.unread, 'y\n');
  assert.deepEqual(read(configPath).desktop, { remote_at_signin: true, remote_at_signin_pc: PC_A });
});

test('R8: a legacy true with no computer name is left alone by a same-mode remote set', async (t) => {
  const { configPath } = fixture(t, '\n[remote]\nmode = "ssh"\nport = 9600\npreview_port = 9601\n\n[desktop]\nremote_at_signin = true\n');
  const r = await set(configPath, { port: '9610', 'preview-port': '9611' }, { tty: true, answer: 'y\n' });
  assert.equal(r.stdoutText, '');
  assert.deepEqual(read(configPath).desktop, { remote_at_signin: true });
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
  assert.equal(confirmedHere({ remote_at_signin: true, remote_at_signin_pc: 'PC-A' }, 'pc-a', 'win32'), true, 'win32: without regard to case');
  assert.equal(confirmedHere({ remote_at_signin: true, remote_at_signin_pc: 'PC-A' }, 'pc-a', 'linux'), false, 'elsewhere: exactly');
});
