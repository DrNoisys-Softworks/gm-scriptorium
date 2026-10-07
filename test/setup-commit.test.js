'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { scratchRoot, copySample, configPathIn, treeSnapshot } = require('./helpers/setup-fixtures');

const register = require('../src/setup/register');
const welcome = require('../src/admin/welcome');
const { runInitCommand } = require('../src/cli/init');
const { writeConfigFile } = require('../src/config/write');

/*
 * AC: the browser commit produces the same pack and the same config as `init --yes`, refuses (with
 * nothing written) when the config already holds a campaign, requires the explicit tick for a
 * foreign non-empty output folder, never touches an existing pack file, and keeps the panel's own
 * folder out of every vault. Expected texts are written out by hand.
 */

const QUIET = { write() {} };
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function layout(root) {
  return {
    configPath: configPathIn(root),
    panelDir: path.join(path.dirname(configPathIn(root)), 'panel'),
  };
}

function answersFor(root, extra = {}) {
  return { name: 'lease', vault: path.join(root, 'vault'), output: path.join(root, 'lease-site'), ...extra };
}

/** Everything under a folder, as relpath > sha, ignoring nothing: the pack files init and setup must agree on. */
function packBytes(vault) {
  const pack = path.join(vault, '_meta', 'scriptorium');
  const out = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[`${r}/`] = 'dir';
        walk(path.join(d, e.name), r);
      } else {
        out[r] = fs.readFileSync(path.join(d, e.name), 'utf8');
      }
    }
  })(pack, '');
  return out;
}

async function parityFor(t, { withPack }) {
  const a = scratchRoot(t);
  const b = scratchRoot(t);
  copySample(a, 'vault', { withPack });
  copySample(b, 'vault', { withPack });
  const la = layout(a);
  const lb = layout(b);

  const done = await register.commitSetup(answersFor(a), la);
  assert.ok(done.created, JSON.stringify(done));

  await runInitCommand(
    { yes: true, name: 'lease', vault: path.join(b, 'vault'), out: path.join(b, 'lease-site'), config: lb.configPath },
    [],
    { output: QUIET },
  );
  return { a, b, la, lb, done };
}

test('parity with `init --yes` on a pack-less vault: pack files byte-identical, config identical but for the scratch root, default campaign set', async (t) => {
  const { a, b, la, lb } = await parityFor(t, { withPack: false });
  const packA = packBytes(path.join(a, 'vault'));
  const packB = packBytes(path.join(b, 'vault'));
  assert.deepEqual(Object.keys(packA).sort(), ['css/', 'images/', 'pack.toml', 'vault.config.json']);
  assert.deepEqual(packA, packB);
  assert.equal(packA['pack.toml'], 'theme = "gloam"\n');
  assert.equal(JSON.parse(packA['vault.config.json']).siteTitle, 'The Long Lease');

  const cfgA = fs.readFileSync(la.configPath, 'utf8').split(a).join('<ROOT>');
  const cfgB = fs.readFileSync(lb.configPath, 'utf8').split(b).join('<ROOT>');
  assert.equal(cfgA, cfgB);
  assert.match(cfgA, /^default_campaign = "lease"$/m);
  assert.match(cfgA, /^vault = "<ROOT>\/vault"$/m);
  assert.match(cfgA, /^output = "<ROOT>\/lease-site"$/m);
});

test('parity with `init --yes` on the sample as shipped (pack present): nothing in the pack changes, the same entries are registered', async (t) => {
  const { a, b, la, lb, done } = await parityFor(t, { withPack: true });
  assert.deepEqual(packBytes(path.join(a, 'vault')), packBytes(path.join(b, 'vault')));
  assert.equal(fs.readFileSync(la.configPath, 'utf8').split(a).join('<ROOT>'), fs.readFileSync(lb.configPath, 'utf8').split(b).join('<ROOT>'));
  assert.deepEqual(done.created, ['images/']);
  assert.deepEqual(done.untouched, ['css/', 'pack.toml', 'vault.config.json']);
});

test('explicit title and theme are used when the pack is new', async (t) => {
  const root = scratchRoot(t);
  copySample(root);
  const done = await register.commitSetup(answersFor(root, { title: 'The Lease Chronicles', theme: 'haze' }), layout(root));
  assert.ok(done.created);
  const pack = packBytes(path.join(root, 'vault'));
  assert.equal(pack['pack.toml'], 'theme = "haze"\n');
  assert.equal(JSON.parse(pack['vault.config.json']).siteTitle, 'The Lease Chronicles');
});

test('commitSetup returns what it did: created entries (dirs suffixed /), no untouched, the pack folder, the config path, and isDefault', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const l = layout(root);
  const done = await register.commitSetup(answersFor(root), l);
  assert.deepEqual(done, {
    created: ['css/', 'images/', 'pack.toml', 'vault.config.json'],
    untouched: [],
    packDir: path.join(vault, '_meta', 'scriptorium'),
    configPath: l.configPath,
    isDefault: true,
  });
});

test('race: a config that already holds a campaign is refused as taken, with the config unchanged and no pack folder written', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const l = layout(root);
  const other = copySample(root, 'other-vault');
  writeConfigFile(l.configPath, { config_version: 1, default_campaign: 'first', campaigns: { first: { vault: other, output: path.join(root, 'first-site') } } });
  const before = sha(l.configPath);
  const res = await register.commitSetup(answersFor(root), l);
  assert.deepEqual(res, { refused: 'taken' });
  assert.equal(sha(l.configPath), before);
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'scriptorium')), false);
  assert.equal(fs.existsSync(l.panelDir), false);
});

test('a malformed answer is refused as invalid with the field and the shared rule, and nothing is written', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const l = layout(root);
  const res = await register.commitSetup(answersFor(root, { name: 'Bad Name' }), l);
  assert.deepEqual(res, {
    invalid: {
      field: 'name',
      rule: 'invalid campaign name "Bad Name": use 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit',
    },
  });
  const res2 = await register.commitSetup(answersFor(root, { output: path.join(vault, 'site') }), l);
  assert.deepEqual(res2, { invalid: { field: 'output', rule: `refusing to build inside the vault: ${path.join(vault, 'site')}` } });
  const res3 = await register.commitSetup(answersFor(root, { theme: 'nonesuch' }), l);
  assert.deepEqual(res3, { invalid: { field: 'theme', rule: 'unknown theme "nonesuch"; valid themes: gloam, haze, plain' } });
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'scriptorium')), false);
  assert.equal(fs.existsSync(l.configPath), false);
});

test('a non-empty output folder that is not an earlier build needs outputConfirmed: without it the refusal is init\'s text; with it the commit goes through', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const l = layout(root);
  const out = path.join(root, 'lease-site');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'notes.txt'), 'x');

  for (const flag of [undefined, false, 'yes', 1]) {
    const res = await register.commitSetup(answersFor(root, { outputConfirmed: flag }), l);
    assert.deepEqual(res, {
      invalid: {
        field: 'output',
        rule:
          `refusing to use ${out} as the output folder: it exists and is not empty and does not look like a ` +
          'previous build; choose an empty or new folder',
      },
    });
  }
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'scriptorium')), false);
  assert.equal(fs.existsSync(l.configPath), false);

  const ok = await register.commitSetup(answersFor(root, { outputConfirmed: true }), l);
  assert.ok(ok.created);
  assert.equal(fs.readFileSync(path.join(out, 'notes.txt'), 'utf8'), 'x', 'registering never touches the output folder');
});

test('the panel folder inside any vault is refused, with nothing written', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const l = { configPath: configPathIn(root), panelDir: path.join(vault, 'panel') };
  const res = await register.commitSetup(answersFor(root), l);
  assert.ok(res.invalid, JSON.stringify(res));
  assert.equal(res.invalid.field, 'config');
  assert.match(res.invalid.rule, /remote access keeps its files beside the config, never inside a vault/);
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'scriptorium')), false);
  assert.equal(fs.existsSync(l.configPath), false);
});

test('a config path inside the vault is refused before anything is written', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const l = { configPath: path.join(vault, 'config.toml'), panelDir: path.join(root, 'panel') };
  const res = await register.commitSetup(answersFor(root), l);
  assert.equal(res.invalid.field, 'config');
  assert.match(res.invalid.rule, /^refusing to write config to .* it resolves inside campaign "lease"'s vault$/);
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'scriptorium')), false);
});

test('existing pack files are left untouched (hash and mtime) and listed; only the missing entry is created', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root, 'vault', { withPack: true });
  const pack = path.join(vault, '_meta', 'scriptorium');
  const files = ['pack.toml', 'vault.config.json'].map((f) => path.join(pack, f));
  // Age the files so a rewrite would show in the mtime even on a coarse clock.
  const old = new Date(Date.now() - 86400000);
  for (const f of files) fs.utimesSync(f, old, old);
  const before = files.map((f) => ({ sha: sha(f), mtime: fs.statSync(f).mtimeMs }));
  const res = await register.commitSetup(answersFor(root), layout(root));
  assert.deepEqual(res.untouched, ['css/', 'pack.toml', 'vault.config.json']);
  assert.deepEqual(res.created, ['images/']);
  assert.deepEqual(files.map((f) => ({ sha: sha(f), mtime: fs.statSync(f).mtimeMs })), before);
});

test('the title and theme of an existing pack win over anything the browser sends (read-only)', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root, 'vault', { withPack: true });
  const before = sha(path.join(vault, '_meta', 'scriptorium', 'pack.toml'));
  const res = await register.commitSetup(answersFor(root, { title: 'Ignored', theme: 'plain' }), layout(root));
  assert.ok(res.created);
  assert.equal(sha(path.join(vault, '_meta', 'scriptorium', 'pack.toml')), before);
});

test('the only config write goes through writeConfigFile on the module object (so a test can spy on it), once', async (t) => {
  const root = scratchRoot(t);
  copySample(root);
  const cfgWrite = require('../src/config/write');
  const original = cfgWrite.writeConfigFile;
  const calls = [];
  cfgWrite.writeConfigFile = (...args) => {
    calls.push(args[0]);
    return original(...args);
  };
  t.after(() => {
    cfgWrite.writeConfigFile = original;
  });
  const l = layout(root);
  await register.commitSetup(answersFor(root), l);
  assert.deepEqual(calls, [l.configPath]);
});

test('a successful commit adds the campaign to the welcome list beside the config, and a failed one does not', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const l = layout(root);
  await register.commitSetup(answersFor(root, { name: 'Bad Name' }), l);
  assert.deepEqual(welcome.readPending(l.panelDir), []);
  await register.commitSetup(answersFor(root), l);
  assert.deepEqual(welcome.readPending(l.panelDir), ['lease']);
  assert.ok(treeSnapshot(vault).every((e) => !e.includes('welcome')), 'the welcome list is never written into the vault');
});

test('an unreachable vault at commit time is refused as invalid with the unreachable message', async (t) => {
  const root = scratchRoot(t);
  const l = layout(root);
  const hang = { stat: () => new Promise(() => {}) };
  const iv = setInterval(() => {}, 20);
  t.after(() => clearInterval(iv));
  const res = await register.commitSetup({ name: 'lease', vault: '//nas/share/vault', output: path.join(root, 'o') }, l, { fsp: hang, timeoutMs: 50 });
  assert.equal(res.invalid.field, 'vault');
  assert.match(res.invalid.rule, /within a few seconds/);
  assert.equal(fs.existsSync(l.configPath), false);
});
