'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { plain } = require('./helpers/toml-plain');
const { installLoopbackGuard } = require('./helpers/net-stubs');
const TOML = require('smol-toml');

const { DESKTOP_DEFAULTS, parseDesktopTable } = require('../src/config/desktopsettings');
const { setDesktopPorts, setRemoteAtSignin, serializeConfig } = require('../src/config/write');
const { parseConfig } = require('../src/config/load');
const { TOP_LEVEL_KEYS } = require('../src/config/schema');
const { ConfigError } = require('../src/util/errors');

// Nothing here may reach a network.
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

/*
 * ADR 0057 section 8: the [desktop] table. Expected values below are written by hand, not computed
 * by the code under test.
 */

const GOOD = { config_version: 1, campaigns: {} };

test('the defaults are 7400 and 7401, frozen', () => {
  assert.deepEqual({ ...DESKTOP_DEFAULTS }, { port: 7400, previewPort: 7401 });
  assert.ok(Object.isFrozen(DESKTOP_DEFAULTS));
});

test('an absent table gives the defaults, not saved, and no sign-in confirmation', () => {
  assert.deepEqual(parseDesktopTable(undefined), { port: 7400, previewPort: 7401, remoteAtSignin: false, saved: false });
});

test('literal accepted cases', () => {
  assert.deepEqual(parseDesktopTable({}), { port: 7400, previewPort: 7401, remoteAtSignin: false, saved: false });
  assert.deepEqual(parseDesktopTable({ port: 8123, preview_port: 8124 }), { port: 8123, previewPort: 8124, remoteAtSignin: false, saved: true });
  assert.deepEqual(parseDesktopTable({ port: 9000 }), { port: 9000, previewPort: 7401, remoteAtSignin: false, saved: true });
  assert.deepEqual(parseDesktopTable({ preview_port: 9001 }), { port: 7400, previewPort: 9001, remoteAtSignin: false, saved: true });
  assert.deepEqual(parseDesktopTable({ port: 1, preview_port: 65535 }), { port: 1, previewPort: 65535, remoteAtSignin: false, saved: true });
  assert.deepEqual(parseDesktopTable({ remote_at_signin: true }), { port: 7400, previewPort: 7401, remoteAtSignin: true, saved: false });
  assert.deepEqual(parseDesktopTable({ remote_at_signin: false, port: 7500, preview_port: 7501 }), { port: 7500, previewPort: 7501, remoteAtSignin: false, saved: true });
});

const REFUSED = [
  ['not a table: a string', 'x', /^desktop must be a table$/],
  ['not a table: an array', [1], /^desktop must be a table$/],
  ['not a table: null', null, /^desktop must be a table$/],
  ['an unknown key', { port: 7500, colour: 'red' }, /^desktop: unrecognised key "colour"$/],
  ['a string port', { port: '7400' }, /^desktop: port must be a whole number from 1 to 65535$/],
  ['a string preview port', { preview_port: '7401' }, /^desktop: preview_port must be a whole number from 1 to 65535$/],
  ['a float port', { port: 7400.5 }, /^desktop: port must be a whole number from 1 to 65535$/],
  ['a boolean port', { port: true }, /^desktop: port must be a whole number from 1 to 65535$/],
  ['port zero', { port: 0 }, /^desktop: port must be a whole number from 1 to 65535$/],
  ['port 65536', { port: 65536 }, /^desktop: port must be a whole number from 1 to 65535$/],
  ['a negative preview port', { preview_port: -1 }, /^desktop: preview_port must be a whole number from 1 to 65535$/],
  ['equal explicit ports', { port: 8000, preview_port: 8000 }, /^desktop: the panel and preview ports must differ$/],
  ['port equal to the default preview', { port: 7401 }, /^desktop: the panel and preview ports must differ$/],
  ['preview equal to the default port', { preview_port: 7400 }, /^desktop: the panel and preview ports must differ$/],
  ['a string sign-in flag', { remote_at_signin: 'yes' }, /^desktop: remote_at_signin must be true or false$/],
  ['a numeric sign-in flag', { remote_at_signin: 1 }, /^desktop: remote_at_signin must be true or false$/],
];
for (const [label, raw, pattern] of REFUSED) {
  test(`refused: ${label}`, () => {
    assert.throws(() => parseDesktopTable(raw), (err) => err instanceof ConfigError && pattern.test(err.message) && !err.message.includes('\n'));
  });
}

test('a hostile key is shown cleaned and bounded in the one-line message', () => {
  assert.throws(() => parseDesktopTable({ ['bad\nkey' + 'x'.repeat(200)]: 1 }), (err) => {
    assert.ok(!err.message.includes('\n'));
    assert.ok(err.message.length < 120, err.message);
    return err instanceof ConfigError;
  });
});

test('parsed TOML (null-prototype tables) is read the same as a literal', () => {
  const parsed = TOML.parse('[desktop]\nport = 7600\npreview_port = 7601\n');
  assert.deepEqual(parseDesktopTable(parsed.desktop), { port: 7600, previewPort: 7601, remoteAtSignin: false, saved: true });
  const strings = TOML.parse('[desktop]\nport = "7600"\n');
  assert.throws(() => parseDesktopTable(strings.desktop), ConfigError);
});

test('desktopsettings requires exactly ../util/errors and ../setup/validate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'desktopsettings.js'), 'utf8');
  const specs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(specs, ['../setup/validate', '../util/errors']);
});

test('schema: desktop is a known top-level key, so no unknown-key warning', () => {
  assert.ok(TOP_LEVEL_KEYS.includes('desktop'));
  const { warnings } = parseConfig('config_version = 1\n[desktop]\nport = 7500\npreview_port = 7501\n');
  assert.deepEqual(warnings.filter((w) => /desktop/.test(w)), []);
});

test('load.js does not validate [desktop]: a bad table never stops loading', () => {
  for (const toml of ['[desktop]\nport = "7400"\n', '[desktop]\nport = 8000\npreview_port = 8000\n', '[desktop]\ncolour = 1\n', 'desktop = "x"\n']) {
    assert.doesNotThrow(() => parseConfig(`config_version = 1\n${toml}`), toml);
  }
});

test('setDesktopPorts returns a clone with both keys set, and keeps every other table byte-identical', () => {
  const config = {
    config_version: 1,
    default_campaign: 'long-lease',
    campaigns: { 'long-lease': { vault: '/v', output: '/o' } },
    remote: { mode: 'tailscale', port: 7700, preview_port: 7701, admin_url: 'https://home.example.net' },
    update: { check: false, channel: 'beta' },
    desktop: { remote_at_signin: true },
  };
  const before = JSON.stringify(config);
  const next = setDesktopPorts(config, { port: 7500, previewPort: 7501 });
  assert.equal(JSON.stringify(config), before, 'input not mutated');
  assert.notEqual(next, config);
  assert.deepEqual(next.desktop, { remote_at_signin: true, port: 7500, preview_port: 7501 });
  assert.deepEqual(next.remote, config.remote);
  assert.deepEqual(next.update, config.update);
  assert.deepEqual(next.campaigns, config.campaigns);
  assert.equal(next.default_campaign, 'long-lease');
});

test('setDesktopPorts refuses what the reader refuses, and writes nothing into the clone it returns', () => {
  assert.throws(() => setDesktopPorts(GOOD, { port: 8000, previewPort: 8000 }), /must differ/);
  assert.throws(() => setDesktopPorts(GOOD, { port: '7500', previewPort: 7501 }), /desktop: port must be a whole number/);
  assert.throws(() => setDesktopPorts(GOOD, { port: 7500, previewPort: 0 }), /desktop: preview_port must be a whole number/);
  assert.throws(() => setDesktopPorts({ ...GOOD, desktop: 'x' }, { port: 7500, previewPort: 7501 }), /desktop must be a table/);
  assert.throws(() => setDesktopPorts({ ...GOOD, desktop: { colour: 1 } }, { port: 7500, previewPort: 7501 }), /unrecognised key "colour"/);
});

test('setDesktopPorts survives the canonical emitter and reads back', () => {
  const text = serializeConfig(setDesktopPorts(GOOD, { port: 7500, previewPort: 7501 }));
  assert.match(text, /\[desktop\]\nport = 7500\npreview_port = 7501\n/);
  assert.deepEqual(plain(TOML.parse(text).desktop), { port: 7500, preview_port: 7501 });
});

test('setRemoteAtSignin: true sets the flag, keeps the ports and the other tables', () => {
  const config = { ...GOOD, remote: { mode: 'ssh', port: 7700 }, desktop: { port: 7500, preview_port: 7501 } };
  const next = setRemoteAtSignin(config, true);
  assert.deepEqual(next.desktop, { port: 7500, preview_port: 7501, remote_at_signin: true });
  assert.deepEqual(next.remote, { mode: 'ssh', port: 7700 });
  assert.deepEqual(config.desktop, { port: 7500, preview_port: 7501 }, 'input not mutated');
  assert.equal(parseDesktopTable(next.desktop).remoteAtSignin, true);
});

test('setRemoteAtSignin: false clears the flag, keeps the ports, and drops a table it leaves empty', () => {
  const withPorts = setRemoteAtSignin({ ...GOOD, desktop: { port: 7500, preview_port: 7501, remote_at_signin: true } }, false);
  assert.deepEqual(withPorts.desktop, { port: 7500, preview_port: 7501 });
  const only = setRemoteAtSignin({ ...GOOD, desktop: { remote_at_signin: true } }, false);
  assert.equal('desktop' in only, false);
  const absent = setRemoteAtSignin(GOOD, false);
  assert.equal('desktop' in absent, false);
});

test('setRemoteAtSignin: only a real boolean, and only over a readable table', () => {
  assert.throws(() => setRemoteAtSignin(GOOD, 'yes'), ConfigError);
  assert.throws(() => setRemoteAtSignin(GOOD, undefined), ConfigError);
  assert.throws(() => setRemoteAtSignin({ ...GOOD, desktop: 'x' }, true), /desktop must be a table/);
  assert.throws(() => setRemoteAtSignin({ ...GOOD, desktop: { port: '7400' } }, true), /desktop: port must be a whole number/);
});

test('the flag round-trips through the emitter as a TOML boolean', () => {
  const text = serializeConfig(setRemoteAtSignin(GOOD, true));
  assert.match(text, /\[desktop\]\nremote_at_signin = true\n/);
  assert.equal(parseDesktopTable(TOML.parse(text).desktop).remoteAtSignin, true);
});
