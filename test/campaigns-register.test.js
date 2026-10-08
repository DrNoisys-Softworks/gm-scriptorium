'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const register = require('../src/setup/register');
const configWrite = require('../src/config/write');
const welcome = require('../src/admin/welcome');
const { runConfigCommand } = require('../src/cli/config');
const { ConfigError } = require('../src/util/errors');

/*
 * ADR 0050 section 5: the panel's set-default and remove, in src/setup/register.js. Each reads the
 * config once, checks the page's sha, and only then writes. The oracle for the bytes is the CLI
 * (runConfigCommand), never register.js or serializeConfig. The sha literals below were computed
 * outside the code:
 *   printf 'config_version = 1\n' | sha256sum
 */

const EMPTY_TEXT = 'config_version = 1\n';
const EMPTY_SHA = '511fbbab94c3d38cc1b0a4672770df5b280d589722f3840d5f6bfedb550f804c';

const THREE = [
  '# my own comment, dropped on rewrite',
  'config_version = 1',
  'default_campaign = "b"',
  'extra_top = "kept"',
  '',
  '[campaigns.a]',
  'vault = "/v/a"',
  'output = "/o/a"',
  '',
  '[campaigns.b]',
  'vault = "/v/b"',
  'output = "/o/b"',
  'extra_campaign = "kept too"',
  '',
  '[campaigns.b.paths.p]',
  'vault = "/v/b-other"',
  '',
  '[campaigns.b.paths.p.match]',
  'platform = "linux"',
  '',
  '[campaigns.c]',
  'vault = "/v/c"',
  'output = "/o/c"',
  '',
].join('\n');

const MALFORMED_ENTRY = ['config_version = 1', 'default_campaign = "a"', '', '[campaigns.a]', 'vault = "/v/a"', '', '[campaigns.bad]', 'vault = 5', ''].join('\n');

function shaOf(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-campaigns-reg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(dir, name, text) {
  const file = path.join(dir, name, 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function useEnv(t, file) {
  const before = process.env.SCRIPTORIUM_CONFIG;
  process.env.SCRIPTORIUM_CONFIG = file;
  t.after(() => {
    if (before === undefined) delete process.env.SCRIPTORIUM_CONFIG;
    else process.env.SCRIPTORIUM_CONFIG = before;
  });
}

function spyWriter(t) {
  const calls = [];
  const original = configWrite.writeConfigFile;
  configWrite.writeConfigFile = (...args) => {
    calls.push(args[0]);
    return original(...args);
  };
  t.after(() => {
    configWrite.writeConfigFile = original;
  });
  return calls;
}

// --- the snapshot ---------------------------------------------------------------------------------

test('readConfigSnapshot: the sha is the sha256 of the bytes on disk (an outside literal), and the config comes from the same bytes', (t) => {
  const dir = scratch(t);
  const file = put(dir, 'x', EMPTY_TEXT);
  const snap = register.readConfigSnapshot(file, { lenient: false });
  assert.equal(snap.exists, true);
  assert.equal(snap.sha256, EMPTY_SHA);
  assert.deepEqual(snap.config, { config_version: 1 });
});

test('readConfigSnapshot: a missing file gives exists false, no sha and an empty config', (t) => {
  const dir = scratch(t);
  const snap = register.readConfigSnapshot(path.join(dir, 'nope', 'config.toml'), { lenient: false });
  assert.deepEqual(snap, { exists: false, sha256: null, config: { config_version: 1, campaigns: {} } });
});

test('readConfigSnapshot: a bad file throws ConfigError; a malformed campaign entry throws strictly and loads leniently', (t) => {
  const dir = scratch(t);
  const garbage = put(dir, 'g', 'config_version = [[[');
  assert.throws(() => register.readConfigSnapshot(garbage, { lenient: true }), ConfigError);
  const bad = put(dir, 'm', MALFORMED_ENTRY);
  assert.throws(() => register.readConfigSnapshot(bad, { lenient: false }), ConfigError);
  const snap = register.readConfigSnapshot(bad, { lenient: true });
  assert.deepEqual(Object.keys(snap.config.campaigns), ['a', 'bad']);
  assert.equal(snap.sha256, shaOf(MALFORMED_ENTRY));
});

test('readConfigSnapshot reads the file exactly once (the sha and the parse cannot come from two reads)', (t) => {
  const dir = scratch(t);
  const file = put(dir, 'x', THREE);
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === file) reads++;
    return original(p, ...rest);
  };
  t.after(() => {
    fs.readFileSync = original;
  });
  register.readConfigSnapshot(file, { lenient: false });
  assert.equal(reads, 1);
});

// --- refusals write nothing ---------------------------------------------------------------------------

function refusalCases(dir) {
  const file = put(dir, 'refuse', THREE);
  const panelDir = path.join(dir, 'refuse', 'panel');
  const good = shaOf(THREE);
  return { file, panelDir, good };
}

test('refusals write nothing: config-changed, active, unknown-campaign, config-invalid (remove and set-default)', (t) => {
  const dir = scratch(t);
  const { file, panelDir, good } = refusalCases(dir);
  const calls = spyWriter(t);
  const wrong = '0'.repeat(64);

  assert.deepEqual(register.removeFromPanel({ name: 'a', configSha256: wrong, activeCampaign: 'c' }, { configPath: file, panelDir }), { refused: 'config-changed' });
  assert.deepEqual(register.setDefaultFromPanel({ name: 'a', configSha256: wrong }, { configPath: file }), { refused: 'config-changed' });
  assert.deepEqual(register.removeFromPanel({ name: 'a', configSha256: good, activeCampaign: 'a' }, { configPath: file, panelDir }), { refused: 'active' });

  const unknownRemove = register.removeFromPanel({ name: 'ghost', configSha256: good, activeCampaign: 'a' }, { configPath: file, panelDir });
  assert.equal(unknownRemove.refused, 'unknown-campaign');
  assert.equal(unknownRemove.message, 'no campaign named "ghost" to remove');
  const unknownDefault = register.setDefaultFromPanel({ name: 'ghost', configSha256: good }, { configPath: file });
  assert.equal(unknownDefault.refused, 'unknown-campaign');
  assert.equal(unknownDefault.message, 'no campaign named "ghost"');

  const bad = put(dir, 'bad', MALFORMED_ENTRY);
  const invalid = register.setDefaultFromPanel({ name: 'a', configSha256: shaOf(MALFORMED_ENTRY) }, { configPath: bad });
  assert.equal(invalid.refused, 'config-invalid');
  assert.match(invalid.message, /"vault" must be a string/);
  const garbage = put(dir, 'garbage', 'config_version = [[[');
  const invalid2 = register.removeFromPanel({ name: 'a', configSha256: shaOf('config_version = [[['), activeCampaign: 'z' }, { configPath: garbage, panelDir });
  assert.equal(invalid2.refused, 'config-invalid');

  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(file, 'utf8'), THREE);
  assert.equal(fs.readFileSync(bad, 'utf8'), MALFORMED_ENTRY);
});

test('a refusal on a missing config file is unknown-campaign and writes nothing', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'none', 'config.toml');
  const calls = spyWriter(t);
  const res = register.removeFromPanel({ name: 'a', configSha256: shaOf(''), activeCampaign: 'z' }, { configPath: file, panelDir: path.join(dir, 'p') });
  assert.notDeepEqual(res, { ok: true });
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(file), false);
});

test('a config path inside a registered vault is refused with config-invalid and writes nothing', (t) => {
  const dir = scratch(t);
  const vault = path.join(dir, 'vault');
  const text = ['config_version = 1', '', '[campaigns.a]', `vault = ${JSON.stringify(vault)}`, '', '[campaigns.b]', 'vault = "/v/b"', ''].join('\n');
  const file = path.join(vault, 'config.toml');
  fs.mkdirSync(vault);
  fs.writeFileSync(file, text);
  const res = register.setDefaultFromPanel({ name: 'b', configSha256: shaOf(text) }, { configPath: file });
  assert.equal(res.refused, 'config-invalid');
  assert.match(res.message, /resolves inside campaign "a"'s vault/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

// --- success -------------------------------------------------------------------------------------------

test('a successful remove returns the sha of the file as written, and the welcome loses the removed name', (t) => {
  const dir = scratch(t);
  const { file, panelDir, good } = refusalCases(dir);
  welcome.addPending(panelDir, 'a');
  welcome.addPending(panelDir, 'c');
  const calls = spyWriter(t);
  const res = register.removeFromPanel({ name: 'a', configSha256: good, activeCampaign: 'b' }, { configPath: file, panelDir });
  assert.equal(res.ok, true);
  assert.equal(res.configSha256, shaOf(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(calls, [file]);
  assert.deepEqual(welcome.readPending(panelDir), ['c']);
  assert.equal(/campaigns\.a\]/.test(fs.readFileSync(file, 'utf8')), false);
});

test('a welcome that cannot be saved never undoes or fails the remove', (t) => {
  const dir = scratch(t);
  const { file, good } = refusalCases(dir);
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'a file where the panel folder should be');
  const res = register.removeFromPanel({ name: 'a', configSha256: good, activeCampaign: 'b' }, { configPath: file, panelDir: blocked });
  assert.equal(res.ok, true);
});

test('a successful set-default returns the sha as written', (t) => {
  const dir = scratch(t);
  const { file, good } = refusalCases(dir);
  const res = register.setDefaultFromPanel({ name: 'c', configSha256: good }, { configPath: file });
  assert.equal(res.ok, true);
  assert.equal(res.configSha256, shaOf(fs.readFileSync(file, 'utf8')));
  assert.match(fs.readFileSync(file, 'utf8'), /default_campaign = "c"/);
});

test('removeFromPanel with no panelDir still works', (t) => {
  const dir = scratch(t);
  const { file, good } = refusalCases(dir);
  const res = register.removeFromPanel({ name: 'a', configSha256: good, activeCampaign: 'b' }, { configPath: file });
  assert.equal(res.ok, true);
});

// --- CLI parity (the CLI is the oracle) -------------------------------------------------------------------

function parity(t, { text, name, kind, activeCampaign = 'zz' }) {
  const dir = scratch(t);
  const cliFile = put(dir, 'cli', text);
  const panelFile = put(dir, 'panel-side', text);
  useEnv(t, cliFile);
  runConfigCommand({ config: cliFile }, kind === 'remove' ? 'remove' : 'set-default', [name]);
  const panelDir = path.join(dir, 'panel-side', 'panel');
  const res =
    kind === 'remove'
      ? register.removeFromPanel({ name, configSha256: shaOf(text), activeCampaign }, { configPath: panelFile, panelDir })
      : register.setDefaultFromPanel({ name, configSha256: shaOf(text) }, { configPath: panelFile });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(fs.readFileSync(panelFile, 'utf8'), fs.readFileSync(cliFile, 'utf8'));
  return fs.readFileSync(panelFile, 'utf8');
}

test('CLI parity: remove writes the same bytes as `config remove` (unknown keys and a profile table survive)', (t) => {
  const out = parity(t, { text: THREE, name: 'c', kind: 'remove' });
  assert.match(out, /extra_top = "kept"/);
  assert.match(out, /extra_campaign = "kept too"/);
  assert.match(out, /\[campaigns\.b\.paths\.p\]/);
});

test('CLI parity: set-default writes the same bytes as `config set-default`', (t) => {
  const out = parity(t, { text: THREE, name: 'a', kind: 'set-default' });
  assert.match(out, /default_campaign = "a"/);
});

test('CLI parity: removing the default campaign drops default_campaign, like `config remove`', (t) => {
  const out = parity(t, { text: THREE, name: 'b', kind: 'remove', activeCampaign: 'a' });
  assert.equal(out.includes('default_campaign'), false);
});

test('CLI parity: a remove on a config with a malformed entry loads leniently, like `config remove`', (t) => {
  const out = parity(t, { text: MALFORMED_ENTRY, name: 'bad', kind: 'remove', activeCampaign: 'a' });
  assert.equal(out.includes('[campaigns.bad]'), false);
});

test('CLI parity: removing the malformed entry leaves a config the strict loader accepts', (t) => {
  const dir = scratch(t);
  const file = put(dir, 'x', MALFORMED_ENTRY);
  const res = register.removeFromPanel({ name: 'bad', configSha256: shaOf(MALFORMED_ENTRY), activeCampaign: 'a' }, { configPath: file, panelDir: path.join(dir, 'p') });
  assert.equal(res.ok, true);
  assert.doesNotThrow(() => register.readConfigSnapshot(file, { lenient: false }));
});
