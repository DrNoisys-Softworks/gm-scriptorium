'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { SAMPLE, withScratch, run } = require('./helpers/b4-cli');
const { makeCampaigns, startPanel, get, post } = require('./helpers/campaigns-panel');
const { packFromSiteConfig } = require('./helpers/site-pack');

/*
 * Issue 21 (ADR 0018 addendum): the site_config campaign key and the --site-config flag are retired.
 * Either one exits 3 with one line that points at the pack docs and at "gm-scriptorium init", and
 * nothing is read from the path or written to config.toml. Every expected message below is written
 * out by hand, never built from the constants in the code under test.
 */

const POINTER =
  'Move the site folder into the vault\'s campaign pack, as "Moving a site folder into a pack" in ' +
  'https://github.com/DrNoisys-Softworks/gm-scriptorium/blob/main/docs/using.md#moving-a-site-folder-into-a-pack ' +
  'explains, or run "gm-scriptorium init" to make a new pack. Nothing was changed.';
const FLAG_MESSAGE = `--site-config is no longer accepted. ${POINTER}`;
const keyMessage = (name, configPath) =>
  `campaign "${name}" still sets site_config, which this version no longer reads; remove that line from ${configPath} once the pack is in place. ${POINTER}`;

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A config with one campaign whose site_config is a DIRECTORY, so any read of it would throw. */
function legacyConfig(root, { extra = '' } = {}) {
  const trap = path.join(root, 'trap-dir');
  fs.mkdirSync(trap, { recursive: true });
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    `config_version = 1\ndefault_campaign = "c177"\n\n[campaigns.c177]\nvault = '${SAMPLE}'\nsite_config = '${trap}'\noutput = '${path.join(root, 'site')}'\n${extra}`,
  );
  return { configPath, trap };
}

function oneLine(res) {
  return res.err.trim().split('\n');
}

// --- the key -----------------------------------------------------------------------------------------------------

for (const args of [['check'], ['build'], ['serve'], ['status', 'c177'], ['serve', '--admin', 'c177']]) {
  test(`key: "${args.join(' ')}" exits 3 with the one-line message, never reads the path, leaves config.toml unchanged`, () => {
    withScratch((root) => {
      const { configPath } = legacyConfig(root);
      const before = sha(configPath);
      const res = run(root, args);
      assert.equal(res.code, 3, res.all);
      assert.deepEqual(oneLine(res), [keyMessage('c177', configPath)]);
      assert.equal(sha(configPath), before);
    });
  });
}

test('key: a matched profile that sets site_config is refused with the same message', () => {
  withScratch((root) => {
    const { configPath } = legacyConfig(root, { extra: '' });
    const base = fs.readFileSync(configPath, 'utf8').replace(/site_config = .*\n/, '');
    fs.writeFileSync(configPath, `${base}\n[campaigns.c177.paths.here]\nmatch = { platform = '${process.platform}' }\nsite_config = '${path.join(root, 'trap-dir')}'\n`);
    const before = sha(configPath);
    const res = run(root, ['check']);
    assert.equal(res.code, 3, res.all);
    assert.deepEqual(oneLine(res), [keyMessage('c177', configPath)]);
    assert.equal(sha(configPath), before);
  });
});

test('key: an empty site_config in a matched profile switches a base value off, so the campaign is accepted', () => {
  withScratch((root) => {
    const { configPath } = legacyConfig(root, { extra: `\n[campaigns.c177.paths.here]\nmatch = { platform = '${process.platform}' }\nsite_config = ""\n` });
    const res = run(root, ['check']);
    assert.doesNotMatch(res.all, /site_config/);
    assert.notEqual(res.code, 3, res.all);
    assert.ok(configPath);
  });
});

test('key: an empty base site_config is accepted silently', () => {
  withScratch((root) => {
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(configPath, `config_version = 1\n[campaigns.t]\nvault = '${SAMPLE}'\nsite_config = ""\noutput = '${path.join(root, 'site')}'\n`);
    const res = run(root, ['check']);
    assert.doesNotMatch(res.all, /site_config/);
    assert.notEqual(res.code, 3, res.all);
  });
});

test('key: the list forms still list a campaign that sets it, exit 0', () => {
  withScratch((root) => {
    const { configPath } = legacyConfig(root);
    const before = sha(configPath);
    const list = run(root, ['config', 'list']);
    assert.equal(list.code, 0, list.all);
    assert.match(list.out, /c177/);
    const status = run(root, ['status']);
    assert.equal(status.code, 0, status.all);
    assert.match(status.out, /c177/);
    assert.equal(sha(configPath), before);
  });
});

test('key: a campaign that sets pack as well is refused just the same', () => {
  withScratch((root) => {
    const { configPath } = legacyConfig(root, { extra: '' });
    const pack = packFromSiteConfig(path.join(__dirname, 'fixtures', 'mini-vault-site-config.json'), path.join(root, 'pack'));
    fs.appendFileSync(configPath, `pack = '${pack}'\n`);
    const res = run(root, ['check']);
    assert.equal(res.code, 3, res.all);
    assert.deepEqual(oneLine(res), [keyMessage('c177', configPath)]);
  });
});

// --- the flag ----------------------------------------------------------------------------------------------------

test('flag: --site-config exits 3 with the one-line message on check, build, status, serve, config add, update and remote show', () => {
  const rows = [
    (r) => ['check', '--site-config', path.join(r, 'x.json')],
    (r) => ['build', '--site-config', path.join(r, 'x.json')],
    (r) => ['status', '--site-config', path.join(r, 'x.json')],
    (r) => ['serve', '--site-config', path.join(r, 'x.json')],
    (r) => ['config', 'add', 'z', '--vault', path.join(r, 'v'), '--out', path.join(r, 'o'), '--site-config', path.join(r, 'x.json')],
    (r) => ['update', '--site-config', path.join(r, 'x.json')],
    (r) => ['remote', 'show', '--site-config', path.join(r, 'x.json')],
    (r) => ['check', '--site-config'],
  ];
  for (const args of rows) {
    withScratch((root) => {
      const res = run(root, args(root));
      assert.equal(res.code, 3, `${args(root).join(' ')}: ${res.all}`);
      assert.deepEqual(oneLine(res), [FLAG_MESSAGE]);
      assert.equal(fs.existsSync(path.join(root, 'config.toml')), false, 'nothing may be written');
    });
  }
});

test('flag: --site-config on config add leaves an existing config.toml byte for byte unchanged', () => {
  withScratch((root) => {
    const { configPath } = legacyConfig(root);
    const before = sha(configPath);
    const res = run(root, ['config', 'add', 'z', '--vault', SAMPLE, '--out', path.join(root, 'o'), '--site-config', path.join(root, 'x.json')]);
    assert.equal(res.code, 3, res.all);
    assert.equal(sha(configPath), before);
  });
});

// --- no read, no probe -------------------------------------------------------------------------------------------

test('no read: resolveCampaignContext and runCheckCommand make no fs call that touches the site_config path', () => {
  withScratch((root) => {
    const { configPath, trap } = legacyConfig(root);
    const names = ['statSync', 'lstatSync', 'existsSync', 'readFileSync', 'realpathSync', 'accessSync', 'readdirSync', 'openSync'];
    const original = {};
    const touched = [];
    for (const name of names) {
      original[name] = fs[name];
      fs[name] = function spy(...args) {
        if (typeof args[0] === 'string' && args[0].startsWith(trap)) touched.push(`${name} ${args[0]}`);
        return original[name].apply(this, args);
      };
    }
    try {
      const { resolveCampaignContext } = require('../src/cli/args');
      const { runCheckCommand } = require('../src/cli/check');
      assert.throws(() => resolveCampaignContext({ config: configPath }, 'c177'), (err) => err.message === keyMessage('c177', configPath) && err.reason === 'site-config-retired');
      assert.throws(() => runCheckCommand({ config: configPath }, 'c177'), (err) => err.message === keyMessage('c177', configPath));
    } finally {
      for (const name of names) fs[name] = original[name];
    }
    assert.deepEqual(touched, []);
  });
});

// --- the panel ---------------------------------------------------------------------------------------------------

test('panel: switching to a campaign that sets site_config fails with the message, and the campaign list does not throw', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const trap = path.join(fx.root, 'trap-dir');
  fs.mkdirSync(trap);
  fs.appendFileSync(fx.configPath, `[campaigns.legacy]\nvault = '${fx.vaults.alpha}'\nsite_config = '${trap}'\noutput = '${path.join(fx.root, 'out-legacy')}'\n`);
  const before = sha(fx.configPath);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');

  const list = await get(h, '/api/campaigns');
  assert.equal(list.status, 200, list.text);
  const legacy = list.json.campaigns.find((c) => c.name === 'legacy');
  assert.equal(legacy.readOnly, false);

  const res = await post(h, '/api/campaigns/switch', { name: 'legacy' }, { campaign: 'alpha' });
  assert.equal(res.status, 422, res.text);
  assert.equal(res.json.message, keyMessage('legacy', fx.configPath));
  assert.equal(h.ctx.campaign, 'alpha');
  assert.equal(sha(fx.configPath), before);
});

// --- config writing ----------------------------------------------------------------------------------------------

test('addCampaign ignores a siteConfig option and keeps an existing site_config untouched', () => {
  const { addCampaign } = require('../src/config/write');
  const fresh = addCampaign({ config_version: 1, campaigns: {} }, 'n', { vault: '/v', output: '/o', siteConfig: '/s.json' });
  assert.deepEqual(fresh.campaigns.n, { vault: '/v', output: '/o' });
  const kept = addCampaign({ config_version: 1, campaigns: { n: { vault: '/v', site_config: '/old.json' } } }, 'n', { vault: '/v2' });
  assert.deepEqual(kept.campaigns.n, { vault: '/v2', site_config: '/old.json' });
});

// --- the shadow check is gone ------------------------------------------------------------------------------------

test('config/pack-shadowed is not registered and has no runner', () => {
  const { getCheck, CHECKS_BY_ID } = require('../src/checks/registry');
  const { RUNNERS } = require('../src/checks/run');
  assert.throws(() => getCheck('config/pack-shadowed'), /unknown check id: config\/pack-shadowed/);
  assert.equal(Object.prototype.hasOwnProperty.call(CHECKS_BY_ID, 'config/pack-shadowed'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(RUNNERS, 'config/pack-shadowed'), false);
});

// --- the docs ----------------------------------------------------------------------------------------------------

test('docs/using.md has the heading the pointer links to', () => {
  const using = fs.readFileSync(path.join(__dirname, '..', 'docs', 'using.md'), 'utf8');
  assert.match(using, /^## Moving a site folder into a pack$/m);
  assert.ok(POINTER.includes('docs/using.md#moving-a-site-folder-into-a-pack '));
});
