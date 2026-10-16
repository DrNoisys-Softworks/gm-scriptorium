'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { installLoopbackGuard } = require('./helpers/net-stubs');

const { runDesktopCommand } = require('../src/cli/desktop');
const { parseArgv, validateFlags, COMMAND_FLAGS } = require('../src/cli/args');
const { commandHelp } = require('../src/cli/help');
const writeLib = require('../src/config/write');
const { ConfigError } = require('../src/util/errors');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

/*
 * ADR 0057 section 8: `gm-scriptorium desktop set [--port N] [--preview-port N]`.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');

function fixture(t, extraToml = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-dcli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const configPath = path.join(root, 'config.toml');
  const base = ['config_version = 1', 'default_campaign = "long-lease"', '', '[campaigns.long-lease]', `vault = '${vault}'`, `output = '${path.join(root, 'out')}'`, ''].join('\n');
  fs.writeFileSync(configPath, base + extraToml);
  return { root, configPath, vault };
}

function run(configPath, args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--config', configPath], { encoding: 'utf8', input: '' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const REMOTE_TOML = '\n[remote]\nmode = "ssh"\nport = 7700\npreview_port = 7701\n';
const UPDATE_TOML = '\n[update]\ncheck = false\nchannel = "beta"\n';

function tables(configPath, names) {
  const text = fs.readFileSync(configPath, 'utf8');
  const parsed = require('smol-toml').parse(text);
  return Object.fromEntries(names.map((n) => [n, JSON.stringify(parsed[n])]));
}

test('set writes both ports, prints the two lines, and exits 0', (t) => {
  const { configPath } = fixture(t);
  const r = run(configPath, ['desktop', 'set', '--port', '7500', '--preview-port', '7501']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'desktop app ports: panel 7500, preview 7501\nchanges take effect the next time the desktop app starts its panel\n');
  assert.match(fs.readFileSync(configPath, 'utf8'), /\[desktop\]\nport = 7500\npreview_port = 7501\n/);
});

test('a missing flag keeps the current value, or the default when none is saved', (t) => {
  const { configPath } = fixture(t);
  let r = run(configPath, ['desktop', 'set', '--port', '7600']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^desktop app ports: panel 7600, preview 7401\n/);
  r = run(configPath, ['desktop', 'set', '--preview-port', '7700']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^desktop app ports: panel 7600, preview 7700\n/);
  assert.match(fs.readFileSync(configPath, 'utf8'), /\[desktop\]\nport = 7600\npreview_port = 7700\n/);
});

test('campaigns, [remote] and [update] stay byte-identical; the sign-in flag is kept', (t) => {
  const { configPath } = fixture(t, `${REMOTE_TOML}${UPDATE_TOML}\n[desktop]\nremote_at_signin = true\n`);
  const before = tables(configPath, ['campaigns', 'remote', 'update', 'default_campaign']);
  const r = run(configPath, ['desktop', 'set', '--port', '7500', '--preview-port', '7501']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(tables(configPath, ['campaigns', 'remote', 'update', 'default_campaign']), before);
  const desktop = require('smol-toml').parse(fs.readFileSync(configPath, 'utf8')).desktop;
  assert.equal(desktop.remote_at_signin, true);
  assert.equal(desktop.port, 7500);
});

test('it writes only through writeConfigFile, once, and only the desktop table changes', (t) => {
  const { configPath } = fixture(t, REMOTE_TOML);
  const calls = [];
  const real = writeLib.writeConfigFile;
  // src/cli/config.js re-exports the same function object; the CLI must call through that export.
  const cfg = require('../src/cli/config');
  const original = cfg.writeConfigFile;
  cfg.writeConfigFile = (p, c) => {
    calls.push([p, JSON.parse(JSON.stringify(c))]);
    return real(p, c);
  };
  t.after(() => {
    cfg.writeConfigFile = original;
  });
  const result = runDesktopCommand({ config: configPath, port: '7500', 'preview-port': '7501' }, 'set', []);
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], configPath);
  assert.deepEqual(calls[0][1].desktop, { port: 7500, preview_port: 7501 });
  assert.deepEqual(calls[0][1].remote, { mode: 'ssh', port: 7700, preview_port: 7701 });
});

test('a missing config file is created with just the settings', (t) => {
  const { root } = fixture(t);
  const fresh = path.join(root, 'sub', 'fresh.toml');
  const r = run(fresh, ['desktop', 'set', '--port', '7500']);
  assert.equal(r.code, 0, r.err);
  const parsed = require('smol-toml').parse(fs.readFileSync(fresh, 'utf8'));
  assert.equal(parsed.config_version, 1);
  assert.equal(parsed.desktop.port, 7500);
  assert.equal(parsed.desktop.preview_port, 7401);
});

const BAD_ARGS = [
  ['a string that is not a number', ['--port', 'abc'], /--port must be a whole number from 1 to 65535/],
  ['port zero', ['--port', '0'], /--port must be a whole number from 1 to 65535/],
  ['port 65536', ['--preview-port', '65536'], /--preview-port must be a whole number from 1 to 65535/],
  ['six digits', ['--port', '100000'], /--port must be a whole number from 1 to 65535/],
  ['a decimal', ['--port', '7400.5'], /--port must be a whole number from 1 to 65535/],
  ['equal ports', ['--port', '8000', '--preview-port', '8000'], /must differ/],
  ['a port equal to the saved other one', ['--port', '7401'], /must differ/],
  ['no flags at all', [], /nothing to change; pass at least one of --port, --preview-port/],
  ['a flag with no value', ['--port'], /--port needs a value/],
];
for (const [label, args, pattern] of BAD_ARGS) {
  test(`exit 1 and nothing written: ${label}`, (t) => {
    const { configPath } = fixture(t);
    const before = fs.readFileSync(configPath, 'utf8');
    const r = run(configPath, ['desktop', 'set', ...args]);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, pattern);
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  });
}

test('flags that do not belong to set are refused (--background is reserved for a later subcommand)', (t) => {
  const { configPath } = fixture(t);
  const before = fs.readFileSync(configPath, 'utf8');
  for (const extra of [['--background'], ['--campaign', 'long-lease'], ['--vault', '/x']]) {
    const r = run(configPath, ['desktop', 'set', '--port', '7500', ...extra]);
    assert.equal(r.code, 1, extra.join(' '));
    assert.match(r.err, /desktop set does not accept --/);
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
});

test('no subcommand, an unknown one, or extra words give the usage line and exit 1', (t) => {
  const { configPath } = fixture(t);
  for (const args of [['desktop'], ['desktop', 'sett'], ['desktop', 'set', 'extra', '--port', '7500']]) {
    const r = run(configPath, args);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.err, 'usage: gm-scriptorium desktop set [--port N] [--preview-port N]\n', args.join(' '));
  }
});

test('a malformed config exits 3 through loadConfig', (t) => {
  const { configPath } = fixture(t);
  fs.writeFileSync(configPath, 'config_version = [\n');
  const r = run(configPath, ['desktop', 'set', '--port', '7500']);
  assert.equal(r.code, 3, r.err);
});

test('an unreadable existing [desktop] table exits 1 and is left as it was', (t) => {
  const { configPath } = fixture(t, '\n[desktop]\ncolour = 1\n');
  const before = fs.readFileSync(configPath, 'utf8');
  const r = run(configPath, ['desktop', 'set', '--port', '7500']);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /unrecognised key "colour"/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
});

test('a bad [desktop] does not stop status', (t) => {
  const { configPath } = fixture(t, '\n[desktop]\nport = "7400"\npreview_port = 7400\n');
  // The fixture vault is empty, so status may still exit 3 for the vault; what matters is that
  // [desktop] is never the reason, and that a command that reads only the config still succeeds.
  const r = run(configPath, ['status']);
  assert.ok(!/desktop/.test(r.err + r.out), r.err + r.out);
  const list = run(configPath, ['config', 'list']);
  assert.equal(list.code, 0, list.err);
});

test('runDesktopCommand throws ConfigError for a bad subcommand (the dispatcher maps it to exit 1)', () => {
  assert.throws(() => runDesktopCommand({}, undefined, []), ConfigError);
});

test('args: desktop accepts --port, --preview-port and --background, and nothing invented', () => {
  assert.deepEqual(COMMAND_FLAGS.desktop.filter((f) => ['port', 'preview-port', 'background'].includes(f)).sort(), ['background', 'port', 'preview-port']);
  const { flags } = parseArgv(['desktop', 'set', '--background', '--port', '7500']);
  assert.equal(flags.background, true, '--background is boolean, so it must not swallow the next word');
  assert.equal(flags.port, '7500');
  assert.doesNotThrow(() => validateFlags('desktop', flags));
  assert.throws(() => validateFlags('desktop', { colour: true }), /unknown flag --colour/);
});

test('help: desktop --help lists its flags and exit codes 0, 1, 3', () => {
  const text = commandHelp('desktop');
  assert.ok(text.startsWith('gm-scriptorium desktop set'));
  assert.ok(text.includes('--port') && text.includes('--preview-port'));
  assert.ok(text.includes('Exit codes:'));
  assert.ok(!text.includes('—'));
  const r = spawnSync(process.execPath, [BIN, 'desktop', '--help'], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, text + '\n');
  const top = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', input: '' });
  assert.match(top.stdout, /^ {2}desktop {2}set \[--port N\] \[--preview-port N\]$/m);
});

// --- desktop set --remote-at-signin on|off [--yes] (ADR 0057 section 7, "Turning it on and off from the tray") --------------------

const { PassThrough } = require('stream');
const smol = require('smol-toml');

// The wording, typed from the ADR and the help text.
const SIGNIN_WARNING = 'Anyone your remote access setup lets through can reach the sign-in page whenever this PC is on.';
const SIGNIN_QUESTION = 'Start remote access when you sign in to Windows? [y/N] ';
const SIGNIN_NEEDS_YES = 'turning on remote access at sign-in asks first; run it in a terminal on this PC, or add --yes';
const SIGNIN_ON = 'remote access at sign-in: on for this PC\nit takes effect the next time you sign in to Windows; a panel that is already running is not changed';
const SIGNIN_OFF = 'remote access at sign-in: off\nthe next start at sign-in runs the panel for this PC only';

const readParsed = (configPath) => JSON.parse(JSON.stringify(smol.parse(fs.readFileSync(configPath, 'utf8'))));
const SAVED_PC_A = '\n[desktop]\nport = 7500\npreview_port = 7501\nremote_at_signin = true\nremote_at_signin_pc = "PC-A"\n';

function signinStreams({ tty, answer }) {
  const stdin = new PassThrough();
  stdin.isTTY = tty;
  if (answer !== undefined) stdin.write(answer);
  if (answer === undefined && tty) stdin.end(); // a terminal that closes: no answer
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (c) => { text += c; });
  return { stdin, stdout, text: () => text };
}

/** Runs `desktop set` in process; a throw (sync or async) comes back as { error }. */
async function setSignin(configPath, extra, { tty = false, answer, pc = 'PC-A' } = {}) {
  const s = signinStreams({ tty, answer });
  try {
    const result = await runDesktopCommand({ config: configPath, ...extra }, 'set', [], { stdin: s.stdin, stdout: s.stdout, hostname: () => pc });
    return { result, stdout: s.text(), unread: String(s.stdin.read()) };
  } catch (error) {
    return { error, stdout: s.text(), unread: String(s.stdin.read()) };
  }
}

test('D1: on --yes writes both keys with this PC, keeps the ports and every other table, and prints the two lines', async (t) => {
  const { configPath } = fixture(t, `${REMOTE_TOML}${UPDATE_TOML}\n[desktop]\nport = 7500\npreview_port = 7501\n`);
  const before = readParsed(configPath);
  const r = await setSignin(configPath, { 'remote-at-signin': 'on', yes: true });
  assert.equal(r.error, undefined);
  assert.equal(r.result.exitCode, 0);
  assert.equal(r.result.human, SIGNIN_ON);
  const after = readParsed(configPath);
  assert.deepEqual(after.desktop, { port: 7500, preview_port: 7501, remote_at_signin: true, remote_at_signin_pc: 'PC-A' });
  assert.deepEqual(after.campaigns, before.campaigns);
  assert.deepEqual(after.remote, before.remote);
  assert.deepEqual(after.update, before.update);
  assert.equal(r.stdout, '', 'nothing was asked');
});

test('D2: off clears both keys, keeps the ports, drops an emptied table, and prints the two lines', async (t) => {
  const withPorts = fixture(t, SAVED_PC_A);
  const a = await setSignin(withPorts.configPath, { 'remote-at-signin': 'off' });
  assert.equal(a.error, undefined);
  assert.equal(a.result.exitCode, 0);
  assert.equal(a.result.human, SIGNIN_OFF);
  assert.deepEqual(readParsed(withPorts.configPath).desktop, { port: 7500, preview_port: 7501 });
  const only = fixture(t, '\n[desktop]\nremote_at_signin = true\nremote_at_signin_pc = "PC-A"\n');
  const b = await setSignin(only.configPath, { 'remote-at-signin': 'off' });
  assert.equal(b.result.human, SIGNIN_OFF);
  assert.equal(readParsed(only.configPath).desktop, undefined);
});

test('D3: at a terminal on asks the warning and the question, and only y or yes in any case turns it on; every other answer cancels', async (t) => {
  for (const answer of ['YES\n', 'Yes\n', 'y\n', 'yes\n']) {
    const { configPath } = fixture(t);
    const r = await setSignin(configPath, { 'remote-at-signin': 'on' }, { tty: true, answer });
    assert.equal(r.error, undefined, JSON.stringify(answer));
    assert.equal(r.result.human, SIGNIN_ON);
    assert.equal(r.stdout, `${SIGNIN_WARNING}\n${SIGNIN_QUESTION}\n`, JSON.stringify(answer));
    assert.deepEqual(readParsed(configPath).desktop, { remote_at_signin: true, remote_at_signin_pc: 'PC-A' });
  }
  for (const answer of ['n\n', '\n', 'no\n', 'sure\n', 'yy\n', undefined]) {
    const { configPath } = fixture(t);
    const before = fs.readFileSync(configPath);
    const r = await setSignin(configPath, { 'remote-at-signin': 'on' }, { tty: true, answer });
    assert.ok(r.error instanceof ConfigError, JSON.stringify(answer));
    assert.equal(r.error.message, 'cancelled; nothing changed');
    assert.deepEqual(fs.readFileSync(configPath), before, JSON.stringify(answer));
    if (answer !== undefined) assert.equal(r.stdout, `${SIGNIN_WARNING}\n${SIGNIN_QUESTION}\n`, JSON.stringify(answer));
  }
});

test('D4: on with no terminal and no --yes is refused with the one line, nothing is written and stdin is not read', async (t) => {
  const { configPath } = fixture(t);
  const before = fs.readFileSync(configPath);
  const r = await setSignin(configPath, { 'remote-at-signin': 'on' }, { tty: false, answer: 'y\n' });
  assert.ok(r.error instanceof ConfigError);
  assert.equal(r.error.message, SIGNIN_NEEDS_YES);
  assert.deepEqual(fs.readFileSync(configPath), before);
  assert.equal(r.unread, 'y\n');
  assert.equal(r.stdout, '');
});

test('D5: off with no terminal works and asks nothing', async (t) => {
  const { configPath } = fixture(t, SAVED_PC_A);
  const r = await setSignin(configPath, { 'remote-at-signin': 'off' }, { tty: false, answer: 'y\n' });
  assert.equal(r.error, undefined);
  assert.equal(r.result.human, SIGNIN_OFF);
  assert.equal(r.unread, 'y\n');
  assert.equal(r.stdout, '');
});

test('D6: a value that is not on or off, and a missing value, exit 1 with the whole line', (t) => {
  const { configPath } = fixture(t);
  const before = fs.readFileSync(configPath);
  const bad = run(configPath, ['desktop', 'set', '--remote-at-signin', 'maybe']);
  assert.equal(bad.code, 1, bad.out + bad.err);
  assert.equal(bad.err, '--remote-at-signin must be on or off\n');
  const missing = run(configPath, ['desktop', 'set', '--remote-at-signin']);
  assert.equal(missing.code, 1, missing.out + missing.err);
  assert.equal(missing.err, '--remote-at-signin needs a value: desktop --remote-at-signin <value>\n');
  assert.deepEqual(fs.readFileSync(configPath), before);
});

test('D7: --remote-at-signin together with --port or --preview-port exits 1 and writes nothing', (t) => {
  const { configPath } = fixture(t);
  const before = fs.readFileSync(configPath);
  for (const extra of [['--port', '7500'], ['--preview-port', '7501']]) {
    const r = run(configPath, ['desktop', 'set', '--remote-at-signin', 'off', ...extra]);
    assert.equal(r.code, 1, r.out + r.err);
    assert.equal(r.err, 'desktop set: give --remote-at-signin on its own, not with --port or --preview-port\n');
  }
  assert.deepEqual(fs.readFileSync(configPath), before);
});

test('D8: --yes with the ports is refused', (t) => {
  const { configPath } = fixture(t);
  const before = fs.readFileSync(configPath);
  const r = run(configPath, ['desktop', 'set', '--yes', '--port', '7500']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.err, 'desktop set: --yes only goes with --remote-at-signin\n');
  assert.deepEqual(fs.readFileSync(configPath), before);
});

test('D9: an unreadable [desktop] table is refused before anything is asked, and nothing is written', async (t) => {
  const { configPath } = fixture(t, '\n[desktop]\ncolour = 1\n');
  const before = fs.readFileSync(configPath);
  const r = await setSignin(configPath, { 'remote-at-signin': 'on' }, { tty: true, answer: 'y\n' });
  assert.ok(r.error instanceof ConfigError);
  assert.match(r.error.message, /unrecognised key "colour"/);
  assert.deepEqual(fs.readFileSync(configPath), before);
  assert.equal(r.stdout, '');
  assert.equal(r.unread, 'y\n');
});

test('D10: a yes saved for another PC is replaced by this PC', async (t) => {
  const { configPath } = fixture(t, '\n[desktop]\nremote_at_signin = true\nremote_at_signin_pc = "PC-B"\n');
  const r = await setSignin(configPath, { 'remote-at-signin': 'on', yes: true }, { pc: 'PC-A' });
  assert.equal(r.error, undefined);
  assert.deepEqual(readParsed(configPath).desktop, { remote_at_signin: true, remote_at_signin_pc: 'PC-A' });
});

test('D11: on then off puts a canonical file back byte for byte', async (t) => {
  const { configPath } = fixture(t, `${REMOTE_TOML}${UPDATE_TOML}\n[desktop]\nport = 7500\npreview_port = 7501\n`);
  writeLib.writeConfigFile(configPath, smol.parse(fs.readFileSync(configPath, 'utf8')));
  const bytes = fs.readFileSync(configPath);
  await setSignin(configPath, { 'remote-at-signin': 'on', yes: true });
  assert.notDeepEqual(fs.readFileSync(configPath), bytes, 'on changed the file');
  await setSignin(configPath, { 'remote-at-signin': 'off' });
  assert.deepEqual(fs.readFileSync(configPath), bytes);
});

test('D12: the flags are accepted by desktop, --remote-at-signin takes a value, --yes does not, and the help names both', () => {
  assert.deepEqual(COMMAND_FLAGS.desktop.filter((f) => ['remote-at-signin', 'yes'].includes(f)).sort(), ['remote-at-signin', 'yes']);
  const { flags } = parseArgv(['desktop', 'set', '--remote-at-signin', 'on', '--yes']);
  assert.equal(flags['remote-at-signin'], 'on');
  assert.equal(flags.yes, true);
  assert.doesNotThrow(() => validateFlags('desktop', flags));
  assert.throws(
    () => validateFlags('desktop', { 'remote-at-signin': true }),
    (e) => e instanceof ConfigError && e.message === '--remote-at-signin needs a value: desktop --remote-at-signin <value>',
  );
  const text = commandHelp('desktop');
  assert.ok(text.includes('--remote-at-signin'));
  assert.ok(text.includes('--yes'));
});
