'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { scratchRoot, copySample, configPathIn } = require('./helpers/setup-fixtures');
const { FIXTURE_DIR } = require('./helpers/vault-template-fixture');

const register = require('../src/setup/register');
const configWrite = require('../src/config/write');
const { runInitCommand } = require('../src/cli/init');

/*
 * The new-vault commit (docs/decisions/0048-new-campaign-vault.md, section 5): the sequence of the
 * writes, what a failure leaves behind, the race check, the refusals, and that the browser's commit
 * and `init --yes --new-vault` produce the same bytes. Expected texts are written out by hand.
 */

const QUIET = { write() {} };
const NOW = () => new Date(2026, 9, 8, 12, 0, 0);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function layout(root) {
  return { configPath: configPathIn(root), panelDir: path.join(path.dirname(configPathIn(root)), 'panel') };
}

function deps(extra = {}) {
  return { templateDir: FIXTURE_DIR, now: NOW, env: {}, ...extra };
}

function answers(root, extra = {}) {
  return {
    name: 'fresh',
    newVault: true,
    vault: path.join(root, 'New Campaign'),
    output: path.join(root, 'fresh-site'),
    title: 'The Brass Lantern',
    system: 'dnd-5e-2024',
    ...extra,
  };
}

function walk(dir) {
  const out = {};
  (function go(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[`${r}/`] = 'dir';
        go(path.join(d, e.name), r);
      } else {
        out[r] = fs.readFileSync(path.join(d, e.name), 'utf8');
      }
    }
  })(dir, '');
  return out;
}

/** Patches fs[method] for the rest of the test; the replacement gets the real function. */
function patch(t, method, replacement) {
  const real = fs[method];
  fs[method] = function patched(...args) {
    return replacement(real, args);
  };
  t.after(() => {
    fs[method] = real;
  });
}

// --- the happy path ------------------------------------------------------------------------------

test('a new vault is created, the pack is written inside it, and the campaign is registered: nothing else', async (t) => {
  const root = scratchRoot(t);
  const l = layout(root);
  const res = await register.commitSetup(answers(root), l, deps());
  assert.ok(res.created, JSON.stringify(res));
  const vault = path.join(root, 'New Campaign');
  assert.deepEqual(res.created, ['css/', 'images/', 'pack.toml', 'vault.config.json']);
  assert.deepEqual(res.untouched, []);
  assert.equal(res.packDir, path.join(vault, '_meta', 'scriptorium'));
  assert.equal(res.isDefault, true);
  assert.equal(res.vaultRoot, vault);
  assert.deepEqual(res.vaultAncestors, []);
  assert.equal(res.vaultCreated.includes('_meta/vault-config.md'), true);
  assert.equal(res.vaultCreated.includes('Factions & Organizations/'), true);

  const tree = walk(vault);
  assert.equal(
    tree['_meta/vault-config.md'],
    '---\ntype: meta\ngm_apprentice_version: "9.9.9"\npublish:\n  site: true\n  system: "dnd-5e-2024"\n---\n\n# The Brass Lantern: vault settings\n\nThis vault records the game system dnd-5e-2024.\n',
  );
  assert.equal(tree['_meta/index.md'], '---\ntype: meta\npurpose: vault-index\ngenerated: 2026-10-08\n---\n\n# Vault index\n\nGenerated 2026-10-08. Nothing else is indexed in a new vault.\n');
  assert.equal(tree['_meta/scriptorium/pack.toml'], 'theme = "gloam"\n');
  assert.equal(JSON.parse(tree['_meta/scriptorium/vault.config.json']).siteTitle, 'The Brass Lantern');
  assert.equal(tree['_meta/NOTICE.txt'].startsWith('This vault was created by GM-Scriptorium'), true);

  const cfg = fs.readFileSync(l.configPath, 'utf8');
  assert.match(cfg, /^default_campaign = "fresh"$/m);
  assert.match(cfg, new RegExp(`^vault = "${vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  assert.equal(fs.existsSync(path.join(root, 'fresh-site')), false, 'the site is built later, not here');
});

test('missing parent folders are created too, and reported', async (t) => {
  const root = scratchRoot(t);
  const vault = path.join(root, 'Games', 'Fantasy', 'New');
  const res = await register.commitSetup(answers(root, { vault, output: path.join(root, 'out') }), layout(root), deps());
  assert.ok(res.created, JSON.stringify(res));
  assert.deepEqual(res.vaultAncestors, [path.join(root, 'Games'), path.join(root, 'Games', 'Fantasy')]);
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'vault-config.md')), true);
});

test('the created date is the local day of the injected clock', async (t) => {
  const root = scratchRoot(t);
  const res = await register.commitSetup(answers(root), layout(root), deps({ now: () => new Date(2031, 0, 2, 0, 5) }));
  assert.ok(res.created);
  assert.match(fs.readFileSync(path.join(root, 'New Campaign', '_meta', 'index.md'), 'utf8'), /generated: 2031-01-02\n/);
});

test('an explicit theme is used, and system none leaves out the game system', async (t) => {
  const root = scratchRoot(t);
  const res = await register.commitSetup(answers(root, { theme: 'haze', system: 'none' }), layout(root), deps());
  assert.ok(res.created);
  const tree = walk(path.join(root, 'New Campaign'));
  assert.equal(tree['_meta/scriptorium/pack.toml'], 'theme = "haze"\n');
  assert.equal(tree['_meta/vault-config.md'].includes('system: '), false);
  assert.equal(tree['_meta/vault-config.md'].includes('  site: true\n'), true);
});

test('the title defaults to the campaign name when none is given', async (t) => {
  const root = scratchRoot(t);
  const a = answers(root);
  delete a.title;
  const res = await register.commitSetup(a, layout(root), deps());
  assert.ok(res.created);
  assert.equal(JSON.parse(walk(path.join(root, 'New Campaign'))['_meta/scriptorium/vault.config.json']).siteTitle, 'fresh');
});

test('an answer without newVault true takes the existing path: a vault that does not exist is not created', async (t) => {
  const root = scratchRoot(t);
  for (const flag of [undefined, false]) {
    const res = await register.commitSetup(answers(root, { newVault: flag }), layout(root), deps());
    assert.equal(res.invalid.field, 'vault');
    assert.match(res.invalid.rule, /configured vault path does not exist/);
  }
  assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
});

// --- the sequence of the writes ---------------------------------------------------------------------------

test('order: the whole vault, then the pack, then the one config write', async (t) => {
  const root = scratchRoot(t);
  const l = layout(root);
  const events = [];
  const realWrite = fs.writeFileSync;
  patch(t, 'writeFileSync', (real, args) => {
    const p = String(args[0]);
    if (p.startsWith(path.join(root, 'New Campaign', '_meta', 'scriptorium'))) events.push('pack');
    else if (p.startsWith(path.join(root, 'New Campaign'))) events.push('vault');
    return real(...args);
  });
  const originalConfigWrite = configWrite.writeConfigFile;
  configWrite.writeConfigFile = (...args) => {
    events.push('config');
    return originalConfigWrite(...args);
  };
  t.after(() => {
    configWrite.writeConfigFile = originalConfigWrite;
  });
  const res = await register.commitSetup(answers(root), l, deps());
  fs.writeFileSync = realWrite;
  assert.ok(res.created);
  const firstPack = events.indexOf('pack');
  const lastVault = events.lastIndexOf('vault');
  assert.ok(lastVault > 5, 'the starter has several files');
  assert.ok(lastVault < firstPack, `vault writes (last at ${lastVault}) come before pack writes (first at ${firstPack})`);
  assert.equal(events.filter((e) => e === 'config').length, 1);
  assert.equal(events[events.length - 1], 'config');
  assert.ok(events.lastIndexOf('pack') < events.indexOf('config'));
});

// --- failures ------------------------------------------------------------------------------------------

function spyConfigWrite(t) {
  const calls = [];
  const original = configWrite.writeConfigFile;
  configWrite.writeConfigFile = (...args) => {
    calls.push(args);
    return original(...args);
  };
  t.after(() => {
    configWrite.writeConfigFile = original;
  });
  return calls;
}

test('a vault that cannot be created writes nothing else: no pack, no config', async (t) => {
  const root = scratchRoot(t);
  const l = layout(root);
  const calls = spyConfigWrite(t);
  const target = path.join(root, 'New Campaign');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'notes.md'), 'mine');
  const res = await register.commitSetup(answers(root), l, deps());
  assert.deepEqual(res, { invalid: { field: 'newVault', rule: `refusing to create a vault in ${target}: it is not empty (it holds notes.md)` } });
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(l.configPath), false);
  assert.deepEqual(Object.keys(walk(target)), ['notes.md']);
});

test('a write error part-way through the vault: the message lists what was created, and no pack or config is written', async (t) => {
  const root = scratchRoot(t);
  const l = layout(root);
  const calls = spyConfigWrite(t);
  let n = 0;
  patch(t, 'writeFileSync', (real, args) => {
    if (String(args[0]).startsWith(path.join(root, 'New Campaign'))) {
      n += 1;
      if (n === 3) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
    return real(...args);
  });
  const res = await register.commitSetup(answers(root), l, deps());
  assert.equal(res.invalid.field, 'newVault');
  assert.match(res.invalid.rule, /^stopped creating the vault in .*: EACCES: permission denied; created before stopping: .*Nothing was removed\. Delete that folder, or choose a new one, and try again\.$/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'New Campaign', '_meta', 'scriptorium')), false);
  assert.equal(fs.existsSync(l.configPath), false);
});

test('a pack error after the vault exists keeps the vault, says so, and registers nothing', async (t) => {
  const root = scratchRoot(t);
  const l = layout(root);
  const calls = spyConfigWrite(t);
  patch(t, 'writeFileSync', (real, args) => {
    if (String(args[0]).endsWith('vault.config.json')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return real(...args);
  });
  const target = path.join(root, 'New Campaign');
  const res = await register.commitSetup(answers(root), l, deps());
  assert.equal(res.invalid.field, 'newVault');
  assert.match(res.invalid.rule, /EACCES: permission denied/);
  assert.equal(res.invalid.rule.endsWith(`The new vault at ${target} was created and is left as it is.`), true, res.invalid.rule);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(target, '_meta', 'vault-config.md')), true);
  assert.equal(fs.existsSync(l.configPath), false);
});

test('race: a config that already holds a campaign is refused as taken, before anything is created', async (t) => {
  const root = scratchRoot(t);
  const l = layout(root);
  const other = copySample(root, 'other-vault');
  configWrite.writeConfigFile(l.configPath, { config_version: 1, default_campaign: 'first', campaigns: { first: { vault: other, output: path.join(root, 'first-site') } } });
  const before = sha(l.configPath);
  const res = await register.commitSetup(answers(root), l, deps());
  assert.deepEqual(res, { refused: 'taken' });
  assert.equal(sha(l.configPath), before);
  assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
  assert.equal(fs.existsSync(l.panelDir), false);
});

// --- revalidation on the server ------------------------------------------------------------------------

const BAD_ANSWERS = [
  ['name', { name: 'Not A Name' }, 'name', /invalid campaign name "Not A Name"/],
  ['vault, relative', { vault: 'relative/dir' }, 'newVault', /^Use the full folder path, starting with a drive letter or \/$/],
  ['title with a quote', { title: 'Say "hi"' }, 'starterTitle', /^site title can't be written into the new vault's pages exactly as typed; leave out double quotes and backslashes$/],
  ['title with a brace word', { title: '{NAME}' }, 'starterTitle', /^site title must not hold a word in braces such as \{NAME\}$/],
  ['theme', { theme: 'nonesuch' }, 'theme', /^unknown theme "nonesuch"; valid themes: /],
  ['system', { system: 'gurps-4e' }, 'system', /^unknown game system "gurps-4e"; valid systems: dnd-5e-2024, none$/],
  ['system, missing', { system: undefined }, 'system', /^unknown game system "undefined"; valid systems: dnd-5e-2024, none$/],
];

for (const [label, extra, field, pattern] of BAD_ANSWERS) {
  test(`revalidation: a bad ${label} is refused with the shared rule, and nothing is written`, async (t) => {
    const root = scratchRoot(t);
    const l = layout(root);
    const calls = spyConfigWrite(t);
    const res = await register.commitSetup(answers(root, extra), l, deps());
    assert.equal(res.invalid.field, field, JSON.stringify(res));
    assert.match(res.invalid.rule, pattern);
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
  });
}

test('revalidation: a build with no starter is refused and nothing is written', async (t) => {
  const root = scratchRoot(t);
  const res = await register.commitSetup(answers(root), layout(root), deps({ templateDir: path.join(root, 'none-here') }));
  assert.deepEqual(res, { invalid: { field: 'starterTitle', rule: 'this build has no new-campaign starter' } });
  assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
});

test('the output folder may not be inside the new vault', async (t) => {
  const root = scratchRoot(t);
  const vault = path.join(root, 'New Campaign');
  const res = await register.commitSetup(answers(root, { output: path.join(vault, 'site') }), layout(root), deps());
  assert.equal(res.invalid.field, 'output');
  assert.match(res.invalid.rule, /^refusing to build inside the vault/);
  assert.equal(fs.existsSync(vault), false);
});

test('the new vault may not hold the config file, the panel folder, or sit inside an existing vault', async (t) => {
  const root = scratchRoot(t);
  const l = layout(root);
  // holds the config folder
  let res = await register.commitSetup(answers(root, { vault: root }), l, deps());
  assert.equal(res.invalid.field, 'newVault');
  assert.match(res.invalid.rule, /it would hold GM-Scriptorium's own settings folder/);
  // inside an existing vault
  const vault = copySample(root);
  res = await register.commitSetup(answers(root, { vault: path.join(vault, 'Nested') }), l, deps());
  assert.equal(res.invalid.field, 'newVault');
  assert.match(res.invalid.rule, /it is inside the vault at /);
  assert.equal(fs.existsSync(path.join(vault, 'Nested')), false);
  assert.equal(fs.existsSync(l.configPath), false);
});

// --- parity with `init --yes --new-vault` ------------------------------------------------------------

test('parity: a browser commit and `init --yes --new-vault` with the same answers give byte-identical vault and pack trees and the same config entry', async (t) => {
  const a = scratchRoot(t);
  const b = scratchRoot(t);
  const la = layout(a);
  const lb = layout(b);
  const done = await register.commitSetup(answers(a, { theme: 'haze' }), la, deps());
  assert.ok(done.created, JSON.stringify(done));
  await runInitCommand(
    { yes: true, name: 'fresh', 'new-vault': path.join(b, 'New Campaign'), system: 'dnd-5e-2024', title: 'The Brass Lantern', out: path.join(b, 'fresh-site'), theme: 'haze', config: lb.configPath },
    [],
    { output: QUIET, now: NOW, env: {}, templateDir: FIXTURE_DIR },
  );
  const treeA = walk(path.join(a, 'New Campaign'));
  const treeB = walk(path.join(b, 'New Campaign'));
  assert.ok(Object.keys(treeA).length > 20);
  assert.deepEqual(treeA, treeB);
  assert.equal(fs.readFileSync(la.configPath, 'utf8').split(a).join('<ROOT>'), fs.readFileSync(lb.configPath, 'utf8').split(b).join('<ROOT>'));
});

// --- a campaign registered during the last await ---------------------------------------------------

/** An fsp whose stat of `trigger` first registers a campaign, as another instance would between the early check and the re-check. */
function registeringFsp(trigger, configPath, other) {
  const real = require('fs').promises;
  return {
    stat: async (p) => {
      if (p === trigger) configWrite.writeConfigFile(configPath, { config_version: 1, default_campaign: 'first', campaigns: { first: { vault: other, output: path.join(path.dirname(other), 'first-site') } } });
      return real.stat(p);
    },
    readdir: real.readdir,
  };
}

test('race: a campaign registered during the last await is refused as taken, nothing created (new vault)', async (t) => {
  const root = scratchRoot(t);
  const l = layout(root);
  const other = copySample(root, 'other-vault');
  const a = answers(root);
  const res = await register.commitSetup(a, l, deps({ fsp: registeringFsp(a.output, l.configPath, other) }));
  assert.deepEqual(res, { refused: 'taken' });
  assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
  assert.match(fs.readFileSync(l.configPath, 'utf8'), /campaigns\.first/);
  assert.doesNotMatch(fs.readFileSync(l.configPath, 'utf8'), /fresh/);
});

test('race: the same during the last await of the existing-vault commit', async (t) => {
  const root = scratchRoot(t);
  const l = layout(root);
  const vault = copySample(root);
  const other = copySample(root, 'other-vault');
  const a = { name: 'lease', vault, output: path.join(root, 'lease-site') };
  const res = await register.commitSetup(a, l, { fsp: registeringFsp(a.output, l.configPath, other) });
  assert.deepEqual(res, { refused: 'taken' });
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'scriptorium')), false);
  assert.doesNotMatch(fs.readFileSync(l.configPath, 'utf8'), /lease/);
});

test('a folder that is already a git repository (only .git inside) is accepted, and .git is left untouched', async (t) => {
  const root = scratchRoot(t);
  const vault = path.join(root, 'New Campaign');
  fs.mkdirSync(path.join(vault, '.git'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const res = await register.commitSetup(answers(root), layout(root), deps());
  assert.ok(res.created, JSON.stringify(res));
  assert.equal(fs.readFileSync(path.join(vault, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'vault-config.md')), true);
});

test('the result times the vault, the pack and the registration separately', async (t) => {
  const root = scratchRoot(t);
  const res = await register.commitSetup(answers(root), layout(root), deps());
  assert.deepEqual(Object.keys(res.ms).sort(), ['pack', 'register', 'vault']);
  for (const v of Object.values(res.ms)) assert.equal(typeof v, 'number');
});
