'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scratchRoot, copySample } = require('./helpers/setup-fixtures');

/*
 * writeConfigFile moves from src/cli/config.js into src/config/write.js (ADR 0028 section 2), so
 * the panel's one config write can sit beside addCampaign without the panel ever reaching
 * src/cli/config.js (which spawns the editor). cli/config.js re-exports the same function.
 */

test('src/config/write.js exports writeConfigFile, and src/cli/config.js re-exports the identical function (wiring only)', () => {
  const write = require('../src/config/write');
  const cliConfig = require('../src/cli/config');
  assert.equal(typeof write.writeConfigFile, 'function');
  assert.equal(cliConfig.writeConfigFile, write.writeConfigFile);
});

test('writeConfigFile creates the folder, writes the canonical emitter output, and refuses a config path inside a vault', (t) => {
  const { writeConfigFile, serializeConfig } = require('../src/config/write');
  const root = scratchRoot(t);
  const file = path.join(root, 'deep', 'er', 'config.toml');
  const cfg = { config_version: 1, default_campaign: 'a', campaigns: { a: { vault: path.join(root, 'v'), output: path.join(root, 'o') } } };
  writeConfigFile(file, cfg);
  assert.equal(fs.readFileSync(file, 'utf8'), serializeConfig(cfg));
  assert.match(fs.readFileSync(file, 'utf8'), /^# Scriptorium config\./);

  const vault = copySample(root, 'vault');
  const inside = path.join(vault, 'config.toml');
  assert.throws(
    () => writeConfigFile(inside, { config_version: 1, campaigns: { a: { vault, output: path.join(root, 'o2') } } }),
    /refusing to write config to .* it resolves inside campaign "a"'s vault/,
  );
  assert.equal(fs.existsSync(inside), false);
});
