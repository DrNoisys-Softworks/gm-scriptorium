'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');
const { asPackProblem } = require('../src/cli/check');
const { ConfigError } = require('../src/util/errors');

/*
 * Issue #108. The frozen exit taxonomy (src/util/exitcodes.js) says 1 is "Scriptorium bug".
 * Owner decision 2026-10-07: map user errors onto EXISTING codes, no new code.
 *   - config / campaign / vault problems     > 3 (vault unreachable)
 *   - every other user mistake               > stays 1, with a plain human message
 *   - `status` with no campaigns             > stays 0 (informational)
 * Pack and profile problems (issue #108, second decision) count as campaign config: a bad
 * SCRIPTORIUM_PROFILE, two equally specific profiles, a missing pack folder, a malformed pack.toml,
 * a bad pack theme all exit 3. A genuinely unexpected exception while loading a pack stays 1.
 * 2 (check failed) and 4 (update prerequisite) are never used for these.
 *
 * Expected codes below are written as literals on purpose, independent of EXIT_CODES, so a change
 * to the mapping has to change this table too. SCRIPTORIUM_TEST_BIN runs the same table against
 * the packaged binary.
 */

function writeCfg(root, body) {
  fs.writeFileSync(path.join(root, 'config.toml'), body);
}
function goodCfg(root, extra = '') {
  writeCfg(root, `config_version = 1\ndefault_campaign = "t"\n\n[campaigns.t]\nvault = '${SAMPLE}'\noutput = '${path.join(root, 'site')}'\n${extra}`);
}

function copyPackVault(root, packToml) {
  const v = path.join(root, 'v');
  fs.cpSync(SAMPLE, v, { recursive: true });
  if (packToml !== undefined) fs.writeFileSync(path.join(v, '_meta', 'scriptorium', 'pack.toml'), packToml);
  writeCfg(root, `config_version = 1\n[campaigns.t]\nvault = '${v}'\noutput = '${path.join(root, 'site')}'\n`);
  return v;
}

// [label, setup(root) -> args | {args, input}, expected code, stderr/stdout pattern]
const CASES = [
  ['check, no campaigns registered', (r) => (writeCfg(r, 'config_version = 1\n'), ['check']), 3, /no campaigns registered/],
  ['build, no campaigns registered', (r) => (writeCfg(r, 'config_version = 1\n'), ['build']), 3, /no campaigns registered/],
  ['serve, no campaigns registered', (r) => (writeCfg(r, 'config_version = 1\n'), ['serve']), 3, /no campaigns registered/],
  ['status, no campaigns registered (informational)', (r) => (writeCfg(r, 'config_version = 1\n'), ['status']), 0, /no campaigns registered/],
  ['config list, no campaigns registered (informational)', (r) => (writeCfg(r, 'config_version = 1\n'), ['config', 'list']), 0, /no campaigns registered/],
  ['unknown campaign (check)', (r) => (goodCfg(r), ['check', 'nope']), 3, /no campaign named "nope"/],
  ['unknown campaign (serve)', (r) => (goodCfg(r), ['serve', 'nope']), 3, /no campaign named "nope"/],
  ['serve --admin with an unknown campaign and none registered', (r) => (writeCfg(r, 'config_version = 1\n'), ['serve', '--admin', 'ghost']), 3, /no campaign named "ghost"/],
  ['several campaigns, none chosen', (r) => (writeCfg(r, `config_version = 1\n[campaigns.a]\nvault = '${SAMPLE}'\noutput = '${r}/a'\n[campaigns.b]\nvault = '${SAMPLE}'\noutput = '${r}/b'\n`), ['check']), 3, /no campaign specified/],
  ['--config file does not exist', (r) => ['check'], 3, /config file not found/],
  ['malformed config (not TOML)', (r) => (writeCfg(r, 'config_version = [[[\n'), ['check']), 3, /config is not valid TOML/],
  ['malformed config (no config_version)', (r) => (writeCfg(r, '[campaigns.t]\nvault = "x"\n'), ['status']), 3, /config_version/],
  ['config entry points at a missing vault', (r) => (writeCfg(r, `config_version = 1\n[campaigns.t]\nvault = '${r}/nowhere'\noutput = '${r}/site'\n`), ['check']), 3, /nowhere/],
  ['campaign has no output folder (build)', (r) => (writeCfg(r, `config_version = 1\n[campaigns.t]\nvault = '${SAMPLE}'\n`), ['build']), 3, /has no output folder/],
  ['--out inside the vault', (r) => (goodCfg(r), ['build', '--no-check', '--out', path.join(SAMPLE, 'zz-out')]), 3, /refusing to build inside the vault/],
  ['--out contains the vault', (r) => (goodCfg(r), ['build', '--no-check', '--out', path.dirname(SAMPLE)]), 3, /contains the vault/],
  ['serve before any build', (r) => (goodCfg(r), ['serve', '--port', '0']), 3, /no build exists/],
  ['config remove of a missing name', (r) => (goodCfg(r), ['config', 'remove', 'nothere']), 3, /no campaign named "nothere"/],
  ['config set-default of a missing name', (r) => (goodCfg(r), ['config', 'set-default', 'nothere']), 3, /no campaign named "nothere"/],
  ['bad SCRIPTORIUM_PROFILE', (r) => (goodCfg(r), { args: ['check'], env: { SCRIPTORIUM_PROFILE: 'nonesuch' } }), 3, /SCRIPTORIUM_PROFILE="nonesuch"/],
  ['two equally specific profiles', (r) => (goodCfg(r, `[campaigns.t.paths.a]\nmatch = { platform = '${process.platform}' }\n[campaigns.t.paths.b]\nmatch = { platform = '${process.platform}' }\n`), ['check']), 3, /equally specific/],
  ['malformed pack.toml', (r) => (copyPackVault(r, 'theme = [[[\n'), ['check']), 3, /pack\.toml/],
  ['pack.toml names an unknown theme (build)', (r) => (copyPackVault(r, 'theme = "nonesuch"\n'), ['build', '--no-check']), 3, /nonesuch/],
  ['pack image slot points at a missing vault file (build)', (r) => (copyPackVault(r, '[images]\nground = "vault:nothere.png"\n'), ['build', '--no-check']), 3, /nothere\.png/],
  ['vault with no site_config, no pack and no _meta/scriptorium (plain config add)', (r) => (writeCfg(r, `config_version = 1\n[campaigns.t]\nvault = '${r}/bare'\noutput = '${r}/site'\n`), fs.mkdirSync(path.join(r, 'bare', '_meta'), { recursive: true }), fs.writeFileSync(path.join(r, 'bare', '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n'), ['check']), 3, /has no site config.*Run "gm-scriptorium init"/],
  ['campaign entry with no vault key', (r) => (writeCfg(r, `config_version = 1\n[campaigns.t]\noutput = '${r}/site'\n`), ['check']), 3, /has no vault configured\. Set one with: gm-scriptorium config add t/],
  ['pack folder given but missing', (r) => (writeCfg(r, `config_version = 1\n[campaigns.t]\nvault = '${SAMPLE}'\npack = '${r}/nopack'\noutput = '${r}/site'\n`), ['check']), 3, /pack directory does not exist/],
  ['pack folder without vault.config.json', (r) => (fs.mkdirSync(path.join(r, 'pk')), writeCfg(r, `config_version = 1\n[campaigns.t]\nvault = '${SAMPLE}'\npack = '${r}/pk'\noutput = '${r}/site'\n`), ['check']), 3, /has no vault\.config\.json/],

  ['unknown command', () => ['chek'], 1, /unknown command: chek/],
  ['unknown flag', (r) => (goodCfg(r), ['check', '--prot']), 1, /unknown flag --prot/],
  ['--port abc', (r) => (goodCfg(r), fs.mkdirSync(path.join(r, 'site')), fs.writeFileSync(path.join(r, 'site', 'index.html'), 'x'), ['serve', '--port', 'abc']), 1, /--port must be a whole number/],
  ['--port 99999', (r) => (goodCfg(r), fs.mkdirSync(path.join(r, 'site')), fs.writeFileSync(path.join(r, 'site', 'index.html'), 'x'), ['serve', '--port', '99999']), 1, /--port must be a whole number/],
  ['--host with --admin', (r) => (goodCfg(r), ['serve', '--admin', '--host', '0.0.0.0']), 1, /does not accept --host/],
  ['--admin --port abc', (r) => (goodCfg(r), ['serve', '--admin', '--port', 'abc']), 1, /--port must be a whole number/],
  ['init --theme nonesuch', (r) => ['init', '--yes', '--name', 'x', '--vault', path.join(r, 'v'), '--theme', 'nonesuch'], 1, /unknown theme "nonesuch"/],
  ['init aborted by closed stdin', (r) => ({ args: ['init', '--name', 'x', '--vault', SAMPLE], input: '' }), 1, /init aborted; nothing written/],
  ['config add with no name', () => ['config', 'add'], 1, /usage: gm-scriptorium config add/],
  ['unknown config subcommand', () => ['config', 'frob'], 1, /unknown config subcommand: frob/],
];

for (const [label, setup, expected, pattern] of CASES) {
  test(`#108: ${label} exits ${expected}`, () => {
    withScratch((root) => {
      const spec = setup(root);
      const { args, input, env } = Array.isArray(spec) ? { args: spec } : spec;
      const res = run(root, args, { input, env });
      assert.equal(res.code, expected, res.all);
      assert.match(res.all, pattern);
      assert.doesNotMatch(res.all, /\n\s+at .*\(|TypeError|ERR_[A-Z_]+|options\.port/, 'a raw Node message or stack leaked');
      // Never use 2 (check failed) or 4 (update prerequisite) for a user mistake.
      assert.ok(![2, 4].includes(res.code));
    });
  });
}

test('#108: port already in use exits 1 with a plain message', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(8721, '127.0.0.1', resolve));
  try {
    withScratch((root) => {
      goodCfg(root);
      fs.mkdirSync(path.join(root, 'site'));
      fs.writeFileSync(path.join(root, 'site', 'index.html'), 'x');
      const res = run(root, ['serve', '--port', '8721']);
      assert.equal(res.code, 1, res.all);
      assert.match(res.all, /port 8721 is already in use on 127\.0\.0\.1/);
      assert.doesNotMatch(res.all, /EADDRINUSE|\n\s+at /);
    });
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

// A privileged port only fails where the OS actually restricts it (non-root, default sysctl).
const privilegedStart = (() => {
  try {
    return Number(fs.readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8'));
  } catch {
    return process.platform === 'win32' ? 0 : 1024;
  }
})();
if (typeof process.getuid === 'function' && process.getuid() !== 0 && privilegedStart > 80) {
  test('#108: --port 80 without rights exits 1 with a plain message', () => {
    withScratch((root) => {
      goodCfg(root);
      fs.mkdirSync(path.join(root, 'site'));
      fs.writeFileSync(path.join(root, 'site', 'index.html'), 'x');
      const res = run(root, ['serve', '--port', '80']);
      assert.equal(res.code, 1, res.all);
      assert.match(res.all, /needs administrator rights/);
      assert.doesNotMatch(res.all, /EACCES|\n\s+at /);
    });
  });
}

test('#108: only a ConfigError becomes a pack problem; an unexpected exception while loading a pack passes through (exit 1)', () => {
  const boom = new TypeError('boom');
  assert.throws(() => asPackProblem(() => { throw boom; }, 't'), (err) => err === boom);
  assert.throws(() => asPackProblem(() => { throw new ConfigError('bad pack'); }, 't'), (err) => err.name === 'VaultUnreachableError' && err.reason === 'bad-pack');
  assert.equal(asPackProblem(() => 7, 't'), 7);
});
