'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { parsePackToml, loadPackToml } = require('../src/build/packtoml');
const { ConfigError } = require('../src/util/errors');

/*
 * The opt-in [gm_link] table in pack.toml: absent means off, present means on and then `url`
 * is required and must be an https origin. Expected messages are written out by hand, never
 * read from the validator under test.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const T = '/scratch/pack.toml';

function parse(text) {
  return parsePackToml(text, { tomlPath: T, campaign: 'alpha' });
}

function refusal(text) {
  try {
    parse(text);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${err && err.constructor && err.constructor.name}`);
    return err.message;
  }
  assert.fail('expected a ConfigError');
}

test('absent: gmLink is null and there is no warning', () => {
  const r = parse('theme = "plain"\n');
  assert.equal(r.gmLink, null);
  assert.deepEqual(r.warnings, []);
});

test('absent file: loadPackToml reports gmLink null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gml-load-'));
  try {
    assert.equal(loadPackToml(dir, { campaign: 'alpha' }).gmLink, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('present file: loadPackToml returns the gmLink origin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gml-load-'));
  try {
    fs.writeFileSync(path.join(dir, 'pack.toml'), '[gm_link]\nurl = "https://gm.example.net"\n');
    assert.deepEqual(loadPackToml(dir, { campaign: 'alpha' }).gmLink, { url: 'https://gm.example.net' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('valid: the stored value is the origin, lowercased, default port dropped', () => {
  const r = parse('[gm_link]\nurl = "https://GM.Example.NET:443"\n');
  assert.deepEqual(r.gmLink, { url: 'https://gm.example.net' });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(parse('[gm_link]\nurl = "https://gm.example.net:8443/"\n').gmLink, { url: 'https://gm.example.net:8443' });
});

test('http:// is refused with the HTTPS message', () => {
  assert.equal(
    refusal('[gm_link]\nurl = "http://gm.example.net"\n'),
    `campaign "alpha": ${T}: [gm_link] url: remote access needs HTTPS: http://gm.example.net`,
  );
});

test('userinfo is refused', () => {
  assert.equal(
    refusal('[gm_link]\nurl = "https://user:pw@gm.example.net"\n'),
    `campaign "alpha": ${T}: [gm_link] url: the address must not carry a user name or password: https://user:pw@gm.example.net`,
  );
});

test('loopback is refused: 127.0.0.1 and localhost', () => {
  for (const u of ['https://127.0.0.1', 'https://localhost']) {
    assert.equal(
      refusal(`[gm_link]\nurl = "${u}"\n`),
      `campaign "alpha": ${T}: [gm_link] url: the address must not be this machine's own loopback name or address: ${u}`,
    );
  }
});

test('not a url is refused', () => {
  assert.equal(
    refusal('[gm_link]\nurl = "not a url"\n'),
    `campaign "alpha": ${T}: [gm_link] url: "not a url" is not a web address such as https://scriptorium.home.arpa`,
  );
});

test('a path, query or fragment is refused', () => {
  for (const u of ['https://gm.example.net/console', 'https://gm.example.net/?a=1', 'https://gm.example.net/#x']) {
    assert.equal(
      refusal(`[gm_link]\nurl = "${u}"\n`),
      `campaign "alpha": ${T}: [gm_link] url: the address must be just a host and optional port, with no path, query or fragment: ${u}`,
    );
  }
});

test('a table with no url is refused', () => {
  assert.equal(refusal('[gm_link]\n'), `campaign "alpha": ${T}: [gm_link] needs url = "https://..."`);
});

test('a non-string url is refused', () => {
  assert.equal(
    refusal('[gm_link]\nurl = 5\n'),
    `campaign "alpha": ${T}: [gm_link] url: the address must be a web address such as https://scriptorium.home.arpa`,
  );
});

test('gm_link that is not a table is refused', () => {
  assert.equal(refusal('gm_link = "https://gm.example.net"\n'), `campaign "alpha": ${T}: [gm_link] must be a table`);
  assert.equal(refusal('gm_link = [1]\n'), `campaign "alpha": ${T}: [gm_link] must be a table`);
});

test('an address with characters that cannot go in a link is refused', () => {
  const m = refusal('[gm_link]\nurl = "https://a&b.example.net"\n');
  assert.match(m, /^campaign "alpha": \/scratch\/pack\.toml: \[gm_link\] url: /);
});

test('an unknown inner key is a warning, and the link is still on', () => {
  const r = parse('[gm_link]\nurl = "https://gm.example.net"\ncolour = "red"\n');
  assert.deepEqual(r.gmLink, { url: 'https://gm.example.net' });
  assert.deepEqual(r.warnings, [`${T}: [gm_link] unrecognised key "colour" (ignored)`]);
});

test('gm_link is not reported as an unrecognised top-level key', () => {
  const r = parse('[gm_link]\nurl = "https://gm.example.net"\n');
  assert.deepEqual(r.warnings, []);
});

// --- through the real bin: check and build exit 3 -----------------------------------------------

function scratchVault(packText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gml-cli-'));
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(path.join(vaultPath, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\ncampaign: Alpha\n---\n\n# vault config body\n');
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'publish-manifest.md'),
    '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Notes/Fine.md\n',
  );
  fs.writeFileSync(path.join(packDir, 'pack.toml'), packText);
  fs.writeFileSync(
    path.join(packDir, 'vault.config.json'),
    JSON.stringify({ siteTitle: 'Alpha Test', folderMap: { Notes: 'notes' }, excludeDirs: ['_meta'] }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(vaultPath, 'Notes', 'Fine.md'), '---\ntype: character\n---\n\n# Fine\n');
  const configPath = path.join(root, 'config.toml');
  const output = path.join(root, 'out');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${output}'`, ''].join('\n'),
  );
  return { root, configPath, output };
}

function runBin(args, root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg');
  const res = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assert.equal(res.error, undefined);
  return res;
}

test('check and build exit 3 for every refused address, with one plain line and nothing written', () => {
  for (const u of ['http://gm.example.net', 'https://user:pw@gm.example.net', 'https://127.0.0.1', 'https://localhost', 'not a url']) {
    const { root, configPath, output } = scratchVault(`theme = "plain"\n[gm_link]\nurl = "${u}"\n`);
    try {
      const check = runBin(['check', 'alpha', '--config', configPath], root);
      assert.equal(check.status, 3, `check ${u}: ${check.stdout}${check.stderr}`);
      const build = runBin(['build', 'alpha', '--config', configPath], root);
      assert.equal(build.status, 3, `build ${u}: ${build.stdout}${build.stderr}`);
      assert.match(build.stdout + build.stderr, /\[gm_link\] url:/);
      assert.doesNotMatch(build.stdout + build.stderr, /\n\s+at /, 'no stack trace');
      assert.equal(fs.existsSync(output), false, 'nothing is written');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('positive control: a valid [gm_link] checks and builds with exit 0', () => {
  const { root, configPath, output } = scratchVault('theme = "plain"\n[gm_link]\nurl = "https://gm.example.net"\n');
  try {
    assert.equal(runBin(['check', 'alpha', '--config', configPath], root).status, 0);
    const build = runBin(['build', 'alpha', '--config', configPath], root);
    assert.equal(build.status, 0, build.stdout + build.stderr);
    assert.ok(fs.existsSync(path.join(output, 'index.html')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
