'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { spawn } = require('child_process');

const { runRemoteCommand } = require('../src/cli/remote');
const { readSecret, createSecretReader } = require('../src/cli/secretprompt');
const { runServeCommand } = require('../src/cli/serve');
const { runBuildCommand } = require('../src/cli/build');
const { runStatusCommand } = require('../src/cli/status');
const { parseConfig } = require('../src/config/load');
const { ConfigError } = require('../src/util/errors');
const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');
const { createSessionStore } = require('../src/remote/sessions');

/*
 * V1.5a (SD-a13). `gm-scriptorium remote`: set / show / password / signout-all / off, readSecret, and
 * the CLI-driven sign-out-all against a RUNNING panel (fixed ports 7928-7929). Passwords here are
 * test fixtures only.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new passphrase';

function fixture(t, remoteToml = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-rcli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n');
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Alpha Test', excludeDirs: [], folderMap: {} })}\n`);
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'pack.toml'), 'theme = "plain"\n');
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(configPath, `${['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vault}'`, `output = '${path.join(root, 'out')}'`, ''].join('\n')}${remoteToml}`);
  return { root, vault, configPath, panelDir: path.join(root, 'panel') };
}

const PROXY_TOML = `
[remote]
mode = "proxy"
port = 7928
preview_port = 7929
admin_url = "https://scriptorium.home.arpa"
preview_url = "https://preview.scriptorium.home.arpa"
bind = "192.0.2.42"
trusted_proxies = ["198.51.100.20"]
`;

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pwFile = (fx) => path.join(fx.panelDir, 'password.json');

/** A stdin/stdout pair for a non-TTY run: lines go in, the output is collected. */
function pipes(lines) {
  const input = new PassThrough();
  const chunks = [];
  const output = new Writable({
    write(c, _e, cb) {
      chunks.push(c.toString());
      cb();
    },
  });
  if (lines !== undefined) input.end(lines.map((l) => `${l}\n`).join(''));
  return { input, output, out: () => chunks.join('') };
}

async function run(fx, sub, flags = {}, args = [], lines) {
  const p = pipes(lines);
  const result = await runRemoteCommand({ config: fx.configPath, ...flags }, sub, args, { stdin: p.input, stdout: p.output });
  return { ...result, out: p.out() };
}

async function refuses(promise, message) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
    assert.equal(err.message, message);
    return true;
  });
}

function readAudit(fx) {
  const file = path.join(fx.panelDir, 'audit.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function spawnBin(args, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// --- dispatch and flags --------------------------------------------------------------

test('an unknown or missing subcommand is a usage error', async (t) => {
  const fx = fixture(t);
  await refuses(runRemoteCommand({ config: fx.configPath }, undefined, []), 'usage: gm-scriptorium remote show | set | password | signout-all | off');
  await refuses(runRemoteCommand({ config: fx.configPath }, 'bogus', []), 'usage: gm-scriptorium remote show | set | password | signout-all | off');
});

test('each subcommand has a flag allowlist (config is always allowed), and takes no positional arguments', async (t) => {
  const fx = fixture(t);
  await refuses(run(fx, 'show', { port: '1' }), 'remote show does not accept --port');
  await refuses(run(fx, 'set', { host: '0.0.0.0', port: '7400' }), 'remote set does not accept --host');
  await refuses(run(fx, 'password', { mode: 'proxy' }), 'remote password does not accept --mode');
  await refuses(run(fx, 'signout-all', { bind: '1.2.3.4' }), 'remote signout-all does not accept --bind');
  await refuses(run(fx, 'off', { yes: true }), 'remote off does not accept --yes');
  await refuses(run(fx, 'show', {}, ['extra']), 'remote show takes no arguments');
  await refuses(run(fx, 'set', { port: '7400' }, ['extra']), 'remote set takes no arguments');
  await refuses(run(fx, 'password', {}, ['hunter2hunter2']), 'remote password takes no arguments');
});

// --- show ----------------------------------------------------------------------------

test('show on a fresh config: mode local, nothing configured, ready, and no panel folder created', async (t) => {
  const fx = fixture(t);
  const r = await run(fx, 'show');
  assert.equal(r.exitCode, 0);
  assert.equal(r.human, ['mode: local (This computer only)', 'https: not needed on this computer', 'password: not set', 'remote sessions: 0 signed in', 'ready: yes', `files: ${fx.panelDir}`].join('\n'));
  assert.equal(fs.existsSync(fx.panelDir), false);
});

test('show for a proxy configuration lists only what applies, and says what is missing (not ready: the first problem)', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  const r = await run(fx, 'show');
  assert.equal(
    r.human,
    [
      'mode: proxy (Behind your reverse proxy)',
      'admin address: https://scriptorium.home.arpa',
      'preview address: https://preview.scriptorium.home.arpa',
      'listening: 192.0.2.42 and 127.0.0.1, ports 7928 (panel) and 7929 (preview)',
      'trusted proxy: 198.51.100.20',
      'https: by your proxy (the hop to GM-Scriptorium is plain HTTP)',
      'password: not set',
      'remote sessions: 0 signed in',
      'not ready: remote access (mode proxy) needs a password: run "gm-scriptorium remote password"',
      `files: ${fx.panelDir}`,
    ].join('\n'),
  );
});

test('show: with a password and sessions it says "set <date>", counts sessions and is ready, and prints NO secret', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  const record = await pw.hashPassword(PASSWORD, { now: () => Date.UTC(2026, 9, 1, 12) });
  pwWrite.writePasswordRecord(pwFile(fx), record);
  const store = createSessionStore({ file: path.join(fx.panelDir, 'sessions.json') });
  store.load();
  const a = store.create('admin');
  store.create('admin');
  const r = await run(fx, 'show');
  assert.match(r.human, /^password: set 2026-10-01 12:00 UTC$/m);
  assert.match(r.human, /^remote sessions: 2 signed in$/m);
  assert.match(r.human, /^ready: yes$/m);
  for (const secret of [record.hash, record.salt, a.id, a.credential, PASSWORD]) assert.ok(!r.human.includes(secret), 'show leaked a secret');
});

test('show for tailscale and ssh', async (t) => {
  const fx = fixture(t, '\n[remote]\nmode = "ssh"\nport = 7928\npreview_port = 7929\n');
  const ssh = await run(fx, 'show');
  assert.match(ssh.human, /^mode: ssh \(SSH tunnel\)$/m);
  assert.match(ssh.human, /^listening: 127\.0\.0\.1, ports 7928 \(panel\) and 7929 \(preview\)$/m);
  assert.match(ssh.human, /^https: by SSH/m);
  assert.match(ssh.human, /^ready: yes$/m);
  assert.ok(!/admin address/.test(ssh.human));
});

test('an unrecognised [remote] key is a hard error for remote (and for show)', async (t) => {
  const fx = fixture(t, '\n[remote]\nmode = "ssh"\nport = 7928\npreview_port = 7929\npasword = "x"\n');
  await refuses(run(fx, 'show'), 'remote: unrecognised key "pasword"');
  await refuses(run(fx, 'set', { port: '7930' }), 'remote: unrecognised key "pasword"');
});

// --- set -----------------------------------------------------------------------------

test('set writes [remote] to config.toml and preserves the campaigns, prints the show summary and the restart note', async (t) => {
  const fx = fixture(t);
  const before = parseConfig(fs.readFileSync(fx.configPath, 'utf8')).config;
  const r = await run(fx, 'set', { mode: 'proxy', 'admin-url': 'https://Scriptorium.Home.Arpa', 'preview-url': 'https://preview.scriptorium.home.arpa', bind: '192.0.2.42', 'trusted-proxy': '198.51.100.20', port: '7928', 'preview-port': '7929' });
  assert.equal(r.exitCode, 0);
  const after = parseConfig(fs.readFileSync(fx.configPath, 'utf8')).config;
  assert.deepEqual(after.campaigns, before.campaigns);
  assert.equal(after.default_campaign, 'alpha');
  assert.deepEqual(after.remote, {
    mode: 'proxy',
    port: 7928,
    preview_port: 7929,
    admin_url: 'https://scriptorium.home.arpa',
    preview_url: 'https://preview.scriptorium.home.arpa',
    bind: '192.0.2.42',
    trusted_proxies: ['198.51.100.20'],
  });
  assert.match(r.human, /^mode: proxy \(Behind your reverse proxy\)$/m);
  assert.match(r.human, /^not ready: remote access \(mode proxy\) needs a password/m);
  assert.ok(r.human.endsWith('changes take effect the next time serve --admin starts'));
});

test('set changes only what is given: a second set keeps every other key', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  await run(fx, 'set', { 'trusted-proxy': '198.51.100.21,198.51.100.22' });
  const remote = parseConfig(fs.readFileSync(fx.configPath, 'utf8')).config.remote;
  assert.deepEqual(remote.trusted_proxies, ['198.51.100.21', '198.51.100.22']);
  assert.equal(remote.admin_url, 'https://scriptorium.home.arpa');
  assert.equal(remote.port, 7928);
});

test('set --admin-url http://... is refused with the exact HTTPS message and config.toml is byte-unchanged', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  const before = sha(fx.configPath);
  await refuses(run(fx, 'set', { 'admin-url': 'http://scriptorium.home.arpa' }), 'remote access needs HTTPS: http://scriptorium.home.arpa');
  assert.equal(sha(fx.configPath), before);
});

test('set validates every value before writing: bad port, bad ip, bad mode, direct (V1.5b), nothing to change: the file never changes', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  const before = sha(fx.configPath);
  await refuses(run(fx, 'set', { port: '0' }), '--port must be a whole number from 1 to 65535');
  await refuses(run(fx, 'set', { 'preview-port': '65536' }), '--preview-port must be a whole number from 1 to 65535');
  await refuses(run(fx, 'set', { bind: 'example.test' }), '"example.test" is not an IP address (no names, ports or prefix lengths)');
  await refuses(run(fx, 'set', { mode: 'open' }), '--mode must be one of local, ssh, tailscale, proxy');
  await refuses(run(fx, 'set', { mode: 'direct' }), '--mode must be one of local, ssh, tailscale, proxy');
  await refuses(run(fx, 'set', {}), 'remote set: nothing to change; pass at least one of --mode, --admin-url, --preview-url, --bind, --trusted-proxy, --port, --preview-port');
  await refuses(run(fx, 'set', { mode: true }), '--mode needs a value');
  assert.equal(sha(fx.configPath), before);
});

test('set on a machine with no config creates one (config_version 1, no campaigns) holding only [remote]', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-rcli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'cfg', 'config.toml');
  const result = await runRemoteCommand({ config: configPath, mode: 'ssh', port: '7928', 'preview-port': '7929' }, 'set', [], { stdin: new PassThrough(), stdout: new PassThrough() });
  assert.equal(result.exitCode, 0);
  const parsed = parseConfig(fs.readFileSync(configPath, 'utf8')).config;
  assert.equal(parsed.config_version, 1);
  assert.deepEqual(parsed.campaigns, {});
  assert.equal(parsed.remote.mode, 'ssh');
});

test('set audits settings-change by cli with the changed KEY NAMES (never values)', async (t) => {
  const fx = fixture(t);
  await run(fx, 'set', { mode: 'proxy', 'admin-url': 'https://scriptorium.home.arpa', bind: '192.0.2.42' });
  const entry = readAudit(fx).find((e) => e.event === 'settings-change');
  assert.equal(entry.by, 'cli');
  assert.equal(entry.mode, 'proxy');
  assert.deepEqual(entry.changed, ['mode', 'admin_url', 'bind']);
  const text = fs.readFileSync(path.join(fx.panelDir, 'audit.log'), 'utf8');
  assert.ok(!text.includes('scriptorium.home.arpa') && !text.includes('192.0.2.42'));
  // setting the same value again records no entry (nothing changed)
  const before = readAudit(fx).length;
  await run(fx, 'set', { bind: '192.0.2.42' });
  assert.equal(readAudit(fx).length, before);
});

// --- password ------------------------------------------------------------------------

test('password over piped stdin: set (first time: one line), then change (two lines: the current, then the new), which signs every device out', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  const first = await run(fx, 'password', {}, [], [PASSWORD]);
  assert.equal(first.exitCode, 0);
  assert.equal(first.human, 'panel password set. Every remote device is signed out.');
  const set = pw.readPasswordRecord(pwFile(fx));
  assert.equal(set.state, 'set');
  assert.equal(await pw.verifyPassword(PASSWORD, set.record), true);

  const store = createSessionStore({ file: path.join(fx.panelDir, 'sessions.json') });
  store.load();
  const session = store.create('admin');

  const changed = await run(fx, 'password', {}, [], [PASSWORD, NEW_PASSWORD]);
  assert.equal(changed.exitCode, 0);
  const now = pw.readPasswordRecord(pwFile(fx));
  assert.equal(await pw.verifyPassword(NEW_PASSWORD, now.record), true);
  assert.equal(await pw.verifyPassword(PASSWORD, now.record), false);
  const reread = createSessionStore({ file: path.join(fx.panelDir, 'sessions.json') });
  reread.load();
  assert.equal(reread.verify('admin', session.credential), null, 'the change signed every remote session out');
  assert.deepEqual(readAudit(fx).filter((e) => e.event.startsWith('password')).map((e) => [e.event, e.by]), [['password-set', 'cli'], ['password-change', 'cli']]);
});

test('password: a wrong current password is refused and nothing changes (record bytes and sessions intact)', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  await run(fx, 'password', {}, [], [PASSWORD]);
  const before = sha(pwFile(fx));
  const store = createSessionStore({ file: path.join(fx.panelDir, 'sessions.json') });
  store.load();
  const session = store.create('admin');
  await refuses(run(fx, 'password', {}, [], ['not the current one', NEW_PASSWORD]), 'that is not the current panel password; nothing changed');
  assert.equal(sha(pwFile(fx)), before);
  const reread = createSessionStore({ file: path.join(fx.panelDir, 'sessions.json') });
  reread.load();
  assert.ok(reread.verify('admin', session.credential));
});

test('password: too short is refused (12 characters), and end of input is "cancelled"', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  await refuses(run(fx, 'password', {}, [], ['short']), 'the panel password must be at least 12 characters');
  assert.equal(fs.existsSync(pwFile(fx)), false);
  await refuses(run(fx, 'password', {}, [], []), 'cancelled; nothing changed');
  await run(fx, 'password', {}, [], [PASSWORD]);
  await refuses(run(fx, 'password', {}, [], [PASSWORD]), 'cancelled; nothing changed');
});

test('password: an unreadable existing record is refused with a way out, not overwritten silently', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  fs.mkdirSync(fx.panelDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pwFile(fx), '{broken', { mode: 0o600 });
  await assert.rejects(run(fx, 'password', {}, [], [PASSWORD]), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /^the panel password file cannot be used \(.*\); run "gm-scriptorium remote off" and set a new password$/);
    return true;
  });
});

test('password never reads argv or the environment (real process: piped stdin wins, an env var is ignored)', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  const viaArgv = await spawnBin(['remote', 'password', 'hunter2hunter2hunter', '--config', fx.configPath]);
  assert.equal(viaArgv.code, 1);
  assert.equal(viaArgv.stderr.trim().split('\n').length, 1);
  assert.equal(viaArgv.stderr.trim(), 'remote password takes no arguments');
  assert.ok(!viaArgv.stderr.includes('hunter2hunter2hunter'));
  assert.equal(fs.existsSync(pwFile(fx)), false);

  const piped = await spawnBin(['remote', 'password', '--config', fx.configPath], {
    input: `${PASSWORD}\n`,
    env: { SCRIPTORIUM_PANEL_PASSWORD: 'from the environment!', SCRIPTORIUM_PASSWORD: 'from the environment!', PASSWORD: 'from the environment!' },
  });
  assert.equal(piped.code, 0, piped.stderr);
  const record = pw.readPasswordRecord(pwFile(fx)).record;
  assert.equal(await pw.verifyPassword(PASSWORD, record), true);
  assert.equal(await pw.verifyPassword('from the environment!', record), false);
  assert.ok(!piped.stdout.includes(PASSWORD));
});

test('the real bin: set --admin-url http://... exits 1 with one stderr line and an unchanged file; --help lists remote', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  const before = sha(fx.configPath);
  const res = await spawnBin(['remote', 'set', '--admin-url', 'http://scriptorium.home.arpa', '--config', fx.configPath]);
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr.trim(), 'remote access needs HTTPS: http://scriptorium.home.arpa');
  assert.equal(sha(fx.configPath), before);
  const help = await spawnBin(['--help']);
  assert.ok(help.stdout.includes('  remote   show | set [--mode local|ssh|tailscale|proxy] [--admin-url URL] [--preview-url URL] [--bind ADDR]'));
  assert.ok(help.stdout.includes('           [--trusted-proxy ADDR,...] [--port N] [--preview-port N] | password | signout-all | off'));
});

test('the real bin: show exits 0 and prints the summary', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  const res = await spawnBin(['remote', 'show', '--config', fx.configPath]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^mode: proxy \(Behind your reverse proxy\)$/m);
});

// --- signout-all and off -----------------------------------------------------------------

test('signout-all signs every session out, prints the count, and audits it by cli', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  const store = createSessionStore({ file: path.join(fx.panelDir, 'sessions.json') });
  store.load();
  const a = store.create('admin');
  const b = store.create('admin');
  const r = await run(fx, 'signout-all');
  assert.equal(r.human, 'signed out 2 remote session(s)');
  const reread = createSessionStore({ file: path.join(fx.panelDir, 'sessions.json') });
  reread.load();
  for (const s of [a, b]) assert.equal(reread.verify('admin', s.credential), null);
  const entry = readAudit(fx).find((e) => e.event === 'signout-all');
  assert.deepEqual([entry.by, entry.count], ['cli', 2]);
  assert.equal((await run(fx, 'signout-all')).human, 'signed out 0 remote session(s)');
});

test('off: mode goes to local (other keys kept), every session is revoked, the password is cleared, and it is audited', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  await run(fx, 'password', {}, [], [PASSWORD]);
  const store = createSessionStore({ file: path.join(fx.panelDir, 'sessions.json') });
  store.load();
  const session = store.create('admin');
  const r = await run(fx, 'off');
  assert.equal(r.human, 'remote access is off. A running serve --admin refuses remote sign-in now and stops listening remotely when restarted.');
  const remote = parseConfig(fs.readFileSync(fx.configPath, 'utf8')).config.remote;
  assert.equal(remote.mode, 'local');
  assert.equal(remote.admin_url, 'https://scriptorium.home.arpa', 'the other keys are kept so turning it back on is easy');
  assert.deepEqual(pw.readPasswordRecord(pwFile(fx)), { state: 'cleared' });
  const reread = createSessionStore({ file: path.join(fx.panelDir, 'sessions.json') });
  reread.load();
  assert.equal(reread.verify('admin', session.credential), null);
  assert.ok(readAudit(fx).some((e) => e.event === 'remote-off' && e.by === 'cli'));
  // a forgotten password: off, then a new one
  const again = await run(fx, 'password', {}, [], [NEW_PASSWORD]);
  assert.equal(again.exitCode, 0);
  assert.equal(pw.readPasswordRecord(pwFile(fx)).state, 'set');
});

test('off on a machine that never configured remote access creates nothing', async (t) => {
  const fx = fixture(t);
  const before = sha(fx.configPath);
  const r = await run(fx, 'off');
  assert.equal(r.exitCode, 0);
  assert.equal(sha(fx.configPath), before);
  assert.equal(pw.readPasswordRecord(pwFile(fx)).state, 'unset');
  assert.equal(fs.existsSync(path.join(fx.panelDir, 'password.json')), false);
});

test('the CLI refuses to write its files inside a vault (the config folder inside the vault)', async (t) => {
  const fx = fixture(t);
  const inVault = path.join(fx.vault, 'config.toml');
  fs.copyFileSync(fx.configPath, inVault);
  await assert.rejects(runRemoteCommand({ config: inVault }, 'password', [], { stdin: pipes([PASSWORD]).input, stdout: pipes().output }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /inside the vault of campaign "alpha"/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(fx.vault, 'panel')), false);
  await assert.rejects(runRemoteCommand({ config: inVault }, 'signout-all', [], {}), ConfigError);
  await assert.rejects(runRemoteCommand({ config: inVault }, 'off', [], {}), ConfigError);
});

test('a log that cannot be written is a warning on the command, never a failure', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  fs.mkdirSync(path.join(fx.panelDir, 'audit.log'), { recursive: true });
  const r = await run(fx, 'signout-all');
  assert.equal(r.exitCode, 0);
  assert.match(r.human, /^signed out 0 remote session\(s\)\nwarning: could not write the audit log at /);
});

// --- check, build, status ignore [remote] -----------------------------------------------------

test('SD-a1: build and status ignore [remote] entirely, even a broken table (build exits 0)', async (t) => {
  const fx = fixture(t, '\n[remote]\nmode = "banana"\nport = 0\nnonsense = true\n');
  const status = runStatusCommand({ config: fx.configPath }, 'alpha');
  assert.equal(status.exitCode, 0);
  const build = runBuildCommand({ config: fx.configPath, 'no-check': true, force: true }, 'alpha');
  assert.equal(build.exitCode, 0, build.human);
  // while serve --admin and remote refuse the same table
  await refuses(run(fx, 'show'), 'remote: unrecognised key "nonsense"');
});

// --- readSecret ---------------------------------------------------------------------------

function fakeTty() {
  const input = new EventEmitter();
  const calls = [];
  input.isTTY = true;
  input.setRawMode = (v) => calls.push(`raw:${v}`);
  input.resume = () => calls.push('resume');
  input.pause = () => calls.push('pause');
  input.setEncoding = () => calls.push('encoding');
  const written = [];
  const output = { isTTY: true, write: (s) => written.push(s) };
  const type = (...chunks) => chunks.forEach((c) => input.emit('data', c));
  return { input, output, calls, written, type };
}

async function readWith(chunks, { prompt = 'Password: ' } = {}) {
  const tty = fakeTty();
  const promise = readSecret({ input: tty.input, output: tty.output, prompt });
  await new Promise((r) => setImmediate(r));
  tty.type(...chunks);
  return { value: await promise, tty };
}

test('readSecret (TTY): setRawMode(true) first and setRawMode(false) after, NOTHING echoed (the prompt and one newline only)', async () => {
  const { value, tty } = await readWith(['hunter', '2hunter2\r']);
  assert.equal(value, 'hunter2hunter2');
  const raw = tty.calls.filter((c) => c.startsWith('raw:'));
  assert.deepEqual(raw, ['raw:true', 'raw:false']);
  assert.ok(tty.calls.indexOf('raw:true') < tty.calls.indexOf('raw:false'));
  assert.deepEqual(tty.written, ['Password: ', '\n']);
  assert.equal(tty.input.listenerCount('data'), 0, 'the data listener is removed');
});

test('readSecret (TTY): backspace removes one code point (DEL and ^H), including an astral one', async () => {
  const { value } = await readWith(['abc\u007fd\bX\u{1F600}\u007fY\r']);
  assert.equal(value, 'abXY');
  assert.equal((await readWith(['\u007f\u007f\u007fok\r'])).value, 'ok', 'backspace on an empty line is harmless');
});

test('readSecret (TTY): Ctrl-C aborts (null), with or without typed characters, and raw mode is restored', async () => {
  const a = await readWith(['\u0003']);
  assert.equal(a.value, null);
  assert.deepEqual(a.tty.calls.filter((c) => c.startsWith('raw:')), ['raw:true', 'raw:false']);
  assert.deepEqual(a.tty.written, ['Password: ', '\n']);
  const b = await readWith(['half typed', '\u0003', 'ignored after']);
  assert.equal(b.value, null);
  assert.deepEqual(b.tty.calls.filter((c) => c.startsWith('raw:')), ['raw:true', 'raw:false']);
});

test('readSecret (TTY): Ctrl-D aborts only on an empty line', async () => {
  assert.equal((await readWith(['\u0004'])).value, null);
  assert.equal((await readWith(['ab\u0004cd\r'])).value, 'abcd');
});

test('readSecret (TTY): CR or LF finishes; escape sequences (arrows, Delete, F1) and other control characters are swallowed; characters after Enter are ignored', async () => {
  assert.equal((await readWith(['ab\u001b[Acd\u001b[3~ef\u001bOPgh\u0001\u0002ij\n'])).value, 'abcdefghij');
  assert.equal((await readWith(['pass\rEXTRA'])).value, 'pass');
  assert.equal((await readWith(['x\u001b[1;5Cy\r'])).value, 'xy');
});

test('readSecret (TTY): input split across chunks, a paste in one chunk, and an empty line all work', async () => {
  assert.equal((await readWith(['a', 'b', 'c', '\r'])).value, 'abc');
  assert.equal((await readWith(['pasted password value 123\r'])).value, 'pasted password value 123');
  assert.equal((await readWith(['\r'])).value, '');
  assert.equal((await readWith(['café über\r'])).value, 'café über');
});

test('readSecret (non-TTY): one line per secret from a shared reader, in order; null at end of input; the prompt is not printed', async () => {
  const p = pipes(['first secret', 'second secret']);
  const reader = createSecretReader({ input: p.input, output: p.output });
  assert.equal(reader.isTTY, false);
  assert.equal(await reader.read('Never shown: '), 'first secret');
  assert.equal(await reader.read('Never shown: '), 'second secret');
  assert.equal(await reader.read('Never shown: '), null);
  reader.close();
  assert.ok(!p.out().includes('Never shown'));
  assert.ok(!p.out().includes('secret'));
});

test('readSecret (one-shot, non-TTY) reads the first line only', async () => {
  const p = pipes(['only this one', 'not this']);
  assert.equal(await readSecret({ input: p.input, output: p.output, prompt: 'x' }), 'only this one');
});

// --- the CLI against a RUNNING panel ---------------------------------------------------------

function panelRequest(port, { method = 'GET', pathname = '/', host, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const h = { Host: host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '198.51.100.77', ...headers };
    if (body !== undefined) h['Content-Length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h, setHost: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('Ma11: `remote signout-all` run as a separate process revokes a RUNNING panel\'s session at once (tailscale shape, fixed ports 7928-7929)', { skip: process.platform !== 'linux' }, async (t) => {
  const fx = fixture(t, '\n[remote]\nmode = "tailscale"\nport = 7928\npreview_port = 7929\nadmin_url = "https://panel-host.example-tailnet.ts.net"\npreview_url = "https://panel-host.example-tailnet.ts.net:8443"\n');
  const set = await spawnBin(['remote', 'password', '--config', fx.configPath], { input: `${PASSWORD}\n` });
  assert.equal(set.code, 0, set.stderr);
  const signals = new EventEmitter();
  const emitted = [];
  const done = runServeCommand({ config: fx.configPath, admin: true }, 'alpha', { emit: (l) => emitted.push(l), signals });
  t.after(async () => {
    signals.emit('SIGINT');
    await done;
  });
  while (!emitted.some((l) => /Press Ctrl-C/.test(l))) await new Promise((r) => setTimeout(r, 10));
  const host = 'panel-host.example-tailnet.ts.net';
  const signin = await panelRequest(7928, { method: 'POST', pathname: '/auth/password', host, headers: { Origin: `https://${host}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(signin.status, 200, signin.text);
  const cookie = /__Host-scriptorium_session=([^;]+)/.exec(signin.headers['set-cookie'][0])[1];
  const ok = await panelRequest(7928, { pathname: '/api/session', host, headers: { Cookie: `__Host-scriptorium_session=${cookie}` } });
  assert.equal(ok.status, 200);

  const out = await spawnBin(['remote', 'signout-all', '--config', fx.configPath]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout.trim(), 'signed out 1 remote session(s)');

  const after = await panelRequest(7928, { pathname: '/api/session', host, headers: { Cookie: `__Host-scriptorium_session=${cookie}` } });
  assert.equal(after.status, 403);
  assert.equal(after.text, 'refused: session');
  // and a password change from the CLI applies at once to the next sign-in attempt
  const change = await spawnBin(['remote', 'password', '--config', fx.configPath], { input: `${PASSWORD}\n${NEW_PASSWORD}\n` });
  assert.equal(change.code, 0, change.stderr);
  const stale = await panelRequest(7928, { method: 'POST', pathname: '/auth/password', host, headers: { Origin: `https://${host}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(stale.status, 403);
  const fresh = await panelRequest(7928, { method: 'POST', pathname: '/auth/password', host, headers: { Origin: `https://${host}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: NEW_PASSWORD }) });
  assert.equal(fresh.status, 200);
});

test('U4: switching the mode drops the old admin and preview addresses unless the same command gives new ones; other keys are kept', async (t) => {
  const fx = fixture(t, PROXY_TOML);
  const r = await run(fx, 'set', { mode: 'tailscale' });
  assert.match(r.human, /^admin address: not set$/m);
  const remote = parseConfig(fs.readFileSync(fx.configPath, 'utf8')).config.remote;
  assert.equal(remote.mode, 'tailscale');
  assert.equal(remote.admin_url, undefined);
  assert.equal(remote.preview_url, undefined);
  assert.equal(remote.bind, '192.0.2.42');
  assert.deepEqual(remote.trusted_proxies, ['198.51.100.20']);
  const again = await run(fx, 'set', { mode: 'proxy', 'admin-url': 'https://scriptorium.home.arpa' });
  const after = parseConfig(fs.readFileSync(fx.configPath, 'utf8')).config.remote;
  assert.equal(after.admin_url, 'https://scriptorium.home.arpa');
  assert.equal(after.preview_url, undefined);
  assert.ok(again.human.length > 0);
});

test('U4: remote <sub> --help prints that subcommand\'s help (and exits 0); remote --help lists them all', async () => {
  for (const sub of ['show', 'set', 'password', 'signout-all', 'off']) {
    const res = await spawnBin(['remote', sub, '--help']);
    assert.equal(res.code, 0, sub);
    assert.ok(res.stdout.startsWith(`gm-scriptorium remote ${sub}`), `${sub}: ${res.stdout.slice(0, 60)}`);
    assert.ok(!res.stdout.includes('Commands:'), 'not the global help');
  }
  const all = await spawnBin(['remote', '--help']);
  assert.equal(all.code, 0);
  for (const sub of ['show', 'set', 'password', 'signout-all', 'off']) assert.ok(all.stdout.includes(`gm-scriptorium remote ${sub}`));
});
