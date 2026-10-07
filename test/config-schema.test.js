'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig } = require('../src/config/load');
const { ConfigError } = require('../src/util/errors');
const { CONFIG_VERSION } = require('../src/config/schema');

const VALID = `
config_version = 1
default_campaign = "example"

[campaigns.example]
vault       = 'D:\\Campaigns\\example\\vault'
site_config = 'D:\\Campaigns\\example\\site\\vault.config.json'
output      = 'D:\\Campaigns\\example\\out'
serve_port  = 8080

[campaigns.example.paths.win-desktop]
match = { platform = "win32" }
`;

test('parses the worked example from the Engineering Brief', () => {
  const { config, warnings, needsMigration } = parseConfig(VALID);
  assert.equal(config.config_version, 1);
  assert.equal(config.default_campaign, 'example');
  assert.equal(config.campaigns.example.serve_port, 8080);
  assert.deepEqual(warnings, []);
  assert.equal(needsMigration, false);
});

test('backslash Windows paths survive verbatim (TOML literal strings)', () => {
  const { config } = parseConfig(VALID);
  assert.equal(config.campaigns.example.vault, 'D:\\Campaigns\\example\\vault');
});

test('rejects a config with no config_version', () => {
  assert.throws(() => parseConfig('default_campaign = "x"\n'), ConfigError);
});

test('rejects a config_version newer than this build understands', () => {
  assert.throws(
    () => parseConfig(`config_version = ${CONFIG_VERSION + 1}\n`),
    ConfigError,
  );
});

test('accepts an older config_version and flags needsMigration', () => {
  // schema.js only defines version 1 today, so this test documents the
  // contract for when a version 2 exists; skip if there is nothing older.
  if (CONFIG_VERSION <= 1) return;
  const { needsMigration } = parseConfig('config_version = 1\n');
  assert.equal(needsMigration, true);
});

test('rejects a non-string default_campaign', () => {
  assert.throws(
    () => parseConfig('config_version = 1\ndefault_campaign = 5\n'),
    ConfigError,
  );
});

test('rejects a campaign that is not a table', () => {
  assert.throws(
    () => parseConfig('config_version = 1\n[campaigns]\nexample = "nope"\n'),
    ConfigError,
  );
});

test('rejects a non-string campaign field', () => {
  assert.throws(
    () =>
      parseConfig(`
config_version = 1
[campaigns.example]
vault = 5
`),
    ConfigError,
  );
});

test('rejects a non-integer serve_port', () => {
  assert.throws(
    () =>
      parseConfig(`
config_version = 1
[campaigns.example]
vault = "x"
serve_port = "8080"
`),
    ConfigError,
  );
});

test('collects an unknown top-level key as a warning, not an error', () => {
  const { warnings } = parseConfig('config_version = 1\nupdate_channel = "beta"\n');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /update_channel/);
});

test('collects an unknown campaign key as a warning, not an error', () => {
  const { warnings } = parseConfig(`
config_version = 1
[campaigns.example]
vault = "x"
notes = "scratch"
`);
  assert.ok(warnings.some((w) => /notes/.test(w)));
});

test('a profile table missing match is a hard error', () => {
  assert.throws(
    () =>
      parseConfig(`
config_version = 1
[campaigns.example]
vault = "x"
[campaigns.example.paths.win-desktop]
vault = "y"
`),
    ConfigError,
  );
});

test('an unrecognised match key is a hard error, never a warning', () => {
  assert.throws(
    () =>
      parseConfig(`
config_version = 1
[campaigns.example]
vault = "x"
[campaigns.example.paths.win-desktop]
match = { platform = "win32", user = "devon" }
`),
    ConfigError,
  );
});

test('platform and hostname are both valid match keys, together or alone', () => {
  const { config } = parseConfig(`
config_version = 1
[campaigns.example]
vault = "x"
[campaigns.example.paths.a]
match = { platform = "win32" }
[campaigns.example.paths.b]
match = { hostname = "DESKTOP-1" }
[campaigns.example.paths.c]
match = { platform = "linux", hostname = "hub" }
`);
  assert.ok(config.campaigns.example.paths.a);
  assert.ok(config.campaigns.example.paths.b);
  assert.ok(config.campaigns.example.paths.c);
});

test('rejects invalid TOML with a ConfigError, not a raw parser exception', () => {
  assert.throws(() => parseConfig('this is not [ toml'), ConfigError);
});

test('an empty campaigns table is structurally valid (config-only mode)', () => {
  const { config } = parseConfig('config_version = 1\n');
  assert.deepEqual(config.campaigns, undefined);
});

// ADR 0018 (P2-FR01): "pack" is a known campaign-string field, at both the
// campaign block and the per-profile override table.

test('K1: "pack" at campaign and profile level gives no unrecognised-key warnings', () => {
  const { warnings } = parseConfig(`
config_version = 1
[campaigns.alpha]
vault = "x"
pack = "y"
[campaigns.alpha.paths.z]
match = { platform = "linux" }
pack = "w"
`);
  assert.deepEqual(warnings, []);
});

test('K2: a non-string "pack" is a ConfigError, at campaign and profile level', () => {
  assert.throws(
    () =>
      parseConfig(`
config_version = 1
[campaigns.alpha]
vault = "x"
pack = 5
`),
    ConfigError,
  );
  assert.throws(
    () =>
      parseConfig(`
config_version = 1
[campaigns.alpha]
vault = "x"
[campaigns.alpha.paths.z]
match = { platform = "linux" }
pack = 5
`),
    ConfigError,
  );
});
