'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { scratchRoot, copySample, configPathIn, treeSnapshot } = require('./helpers/setup-fixtures');
const { FIXTURE_DIR } = require('./helpers/vault-template-fixture');

const register = require('../src/setup/register');
const welcome = require('../src/admin/welcome');
const probe = require('../src/setup/probe');
const { runInitCommand } = require('../src/cli/init');
const { runConfigCommand } = require('../src/cli/config');
const { writeConfigFile } = require('../src/config/write');

/*
 * ADR 0052, sections 3 to 5: adding a campaign to an existing config. The same pipeline as first
 * run behind the add gate, so what is asserted here is what the gate adds: the sha precondition,
 * the clash refusals, the default campaign, and that every refusal writes nothing. Parity is
 * checked against `init --yes`, which is the oracle, never against register.js. Expected texts
 * are written out by hand.
 */

const QUIET = { write() {} };
const NOW = () => new Date(2026, 9, 8, 12, 0, 0);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function layout(root) {
  return { configPath: configPathIn(root), panelDir: path.join(path.dirname(configPathIn(root)), 'panel') };
}

/** A scratch root holding campaign x (and a pack-less vault y ready to add), and a config with only x. */
function fixture(t, { withDefault = true } = {}) {
  const root = scratchRoot(t);
  const vaultX = copySample(root, 'vault-x', { withPack: true });
  const vaultY = copySample(root, 'vault-y');
  const l = layout(root);
  fs.mkdirSync(path.dirname(l.configPath), { recursive: true });
  const config = { config_version: 1, campaigns: { x: { vault: vaultX, output: path.join(root, 'ox') } } };
  if (withDefault) config.default_campaign = 'x';
  writeConfigFile(l.configPath, config);
  return { root, vaultX, vaultY, ...l };
}

function addAnswers(fx, extra = {}) {
  return { name: 'y', vault: fx.vaultY, output: path.join(fx.root, 'oy'), ...extra };
}

const where = (fx) => ({ configPath: fx.configPath, panelDir: fx.panelDir, configSha256: sha(fx.configPath) });

function deps(extra = {}) {
  return { templateDir: FIXTURE_DIR, now: NOW, env: {}, ...extra };
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

// --- success -------------------------------------------------------------------------------------------------

test('an existing vault is added: one entry, the default stays, the pack is created, the welcome lists the name', async (t) => {
  const fx = fixture(t);
  const done = await register.addFromPanel(addAnswers(fx), where(fx));
  assert.ok(done.created, JSON.stringify(done));
  assert.deepEqual(done.created, ['css/', 'images/', 'pack.toml', 'vault.config.json']);
  assert.equal(done.isDefault, false);
  assert.equal(done.configPath, fx.configPath);
  const text = fs.readFileSync(fx.configPath, 'utf8');
  assert.match(text, /^default_campaign = "x"$/m);
  assert.match(text, /^\[campaigns\.x\]$/m);
  assert.match(text, /^\[campaigns\.y\]$/m);
  assert.equal((text.match(/^\[campaigns\./gm) || []).length, 2);
  assert.ok(fs.existsSync(path.join(fx.vaultY, '_meta', 'scriptorium', 'pack.toml')));
  assert.deepEqual(welcome.readPending(fx.panelDir), ['y']);
});

test('with no default campaign set, the added campaign becomes the default and isDefault says so', async (t) => {
  const fx = fixture(t, { withDefault: false });
  const done = await register.addFromPanel(addAnswers(fx), where(fx));
  assert.ok(done.created, JSON.stringify(done));
  assert.equal(done.isDefault, true);
  assert.match(fs.readFileSync(fx.configPath, 'utf8'), /^default_campaign = "y"$/m);
});

test('a new vault is added: the vault tree, the pack and the entry, with the default unchanged', async (t) => {
  const fx = fixture(t);
  const target = path.join(fx.root, 'New Campaign');
  const done = await register.addFromPanel(
    { name: 'fresh', newVault: true, vault: target, output: path.join(fx.root, 'fresh-site'), title: 'The Brass Lantern', system: 'none' },
    where(fx),
    deps(),
  );
  assert.ok(done.created, JSON.stringify(done));
  assert.equal(done.isDefault, false);
  assert.equal(done.vaultRoot, target);
  assert.ok(fs.existsSync(path.join(target, '_meta', 'vault-config.md')));
  assert.ok(fs.existsSync(path.join(target, '_meta', 'scriptorium', 'pack.toml')));
  assert.match(fs.readFileSync(fx.configPath, 'utf8'), /^default_campaign = "x"$/m);
  assert.match(fs.readFileSync(fx.configPath, 'utf8'), /^\[campaigns\.fresh\]$/m);
  assert.deepEqual(welcome.readPending(fx.panelDir), ['fresh']);
});

// --- refusals write nothing ------------------------------------------------------------------------------------

async function assertNothingWritten(t, fx, answers, expected, depsArg, whereOver = {}) {
  const treeBefore = treeSnapshot(fx.root);
  const shaBefore = sha(fx.configPath);
  const res = await register.addFromPanel(answers, { ...where(fx), ...whereOver }, depsArg || {});
  assert.deepEqual(res, expected);
  assert.deepEqual(treeSnapshot(fx.root), treeBefore, 'the scratch root is byte for byte as it was');
  assert.equal(sha(fx.configPath), shaBefore);
  assert.equal(fs.existsSync(fx.panelDir), false, 'no welcome list was started');
}

test('a stale sha is refused as config-changed, with nothing written', async (t) => {
  const fx = fixture(t);
  await assertNothingWritten(t, fx, addAnswers(fx), { refused: 'config-changed' }, undefined, { configSha256: 'a'.repeat(64) });
});

test('a config that no longer parses is refused as config-invalid with the loader message, and nothing is written', async (t) => {
  const fx = fixture(t);
  const bad = 'this is = = not toml';
  fs.writeFileSync(fx.configPath, bad);
  const treeBefore = treeSnapshot(fx.root);
  const res = await register.addFromPanel(addAnswers(fx), { ...where(fx), configSha256: sha(fx.configPath) });
  assert.equal(res.refused, 'config-invalid');
  assert.equal(typeof res.message, 'string');
  assert.ok(res.message.length > 0);
  assert.deepEqual(treeSnapshot(fx.root), treeBefore);
  assert.equal(fs.readFileSync(fx.configPath, 'utf8'), bad);
});

test('a name that is already registered is refused with the exact rule, and nothing is written', async (t) => {
  const fx = fixture(t);
  await assertNothingWritten(t, fx, addAnswers(fx, { name: 'x' }), { invalid: { field: 'name', rule: 'campaign "x" is already registered; choose another name' } });
});

test('a vault equal to another campaign vault is refused, printing the other one as written, and nothing is written', async (t) => {
  const fx = fixture(t);
  const copy = copySample(fx.root, 'vault-z');
  const cfg = fs.readFileSync(fx.configPath, 'utf8');
  fs.writeFileSync(fx.configPath, cfg.replace(JSON.stringify(fx.vaultX), JSON.stringify(copy)));
  await assertNothingWritten(t, fx, addAnswers(fx, { vault: `${copy}${path.sep}` }), {
    invalid: { field: 'vault', rule: `${copy} is already registered as campaign "x"` },
  });
});

test('an output inside another campaign vault is refused as an output clash, and nothing is written', async (t) => {
  const fx = fixture(t);
  const inside = path.join(fx.vaultX, 'site');
  await assertNothingWritten(t, fx, addAnswers(fx, { output: inside }), {
    invalid: {
      field: 'output',
      rule: `${inside} overlaps the vault of campaign "x" (${fx.vaultX}); a build replaces its whole output folder, so it must stay clear of every vault`,
    },
  });
});

test('an output equal to another campaign output is refused, and nothing is written', async (t) => {
  const fx = fixture(t);
  const theirs = path.join(fx.root, 'ox');
  await assertNothingWritten(t, fx, addAnswers(fx, { output: theirs }), {
    invalid: { field: 'output', rule: `${theirs} overlaps the output folder of campaign "x" (${theirs}); each campaign needs its own output folder` },
  });
});

test('a new vault inside another campaign output is refused as newVault, and its folder is never created', async (t) => {
  const fx = fixture(t);
  const theirs = path.join(fx.root, 'ox');
  fs.mkdirSync(theirs);
  const target = path.join(theirs, 'notes');
  await assertNothingWritten(
    t,
    fx,
    { name: 'fresh', newVault: true, vault: target, output: path.join(fx.root, 'fresh-site'), title: 'Fresh', system: 'none' },
    { invalid: { field: 'newVault', rule: `${target} overlaps the output folder of campaign "x" (${theirs}), which every build of "x" replaces` } },
    deps(),
  );
  assert.equal(fs.existsSync(target), false, 'a new-vault clash leaves the target missing');
});

test('a new-vault name clash is refused with the name rule, and the target is never created', async (t) => {
  const fx = fixture(t);
  const target = path.join(fx.root, 'New Campaign');
  await assertNothingWritten(
    t,
    fx,
    { name: 'x', newVault: true, vault: target, output: path.join(fx.root, 'fresh-site'), title: 'Fresh', system: 'none' },
    { invalid: { field: 'name', rule: 'campaign "x" is already registered; choose another name' } },
    deps(),
  );
  assert.equal(fs.existsSync(target), false);
});

// --- the late gate ---------------------------------------------------------------------------------------------

/** An fsp whose stat of `trigger` first runs `act`, as a terminal would between the early check and the late one. */
function actingFsp(trigger, act) {
  const real = fs.promises;
  return {
    stat: async (p) => {
      if (p === trigger) act();
      return real.stat(p);
    },
    readdir: real.readdir,
  };
}

test('late gate: a terminal `config add` during the last await gives config-changed with nothing written, and the terminal entry is kept', async (t) => {
  const fx = fixture(t);
  const other = copySample(fx.root, 'vault-c', { withPack: true });
  const a = addAnswers(fx);
  const whereArg = where(fx);
  const fsp = actingFsp(a.output, () => {
    const res = runConfigCommand({ config: fx.configPath, vault: other, out: path.join(fx.root, 'oc') }, 'add', ['c']);
    assert.equal(res.exitCode, 0);
  });
  const res = await register.addFromPanel(a, whereArg, { fsp });
  assert.deepEqual(res, { refused: 'config-changed' });
  assert.equal(fs.existsSync(path.join(fx.vaultY, '_meta', 'scriptorium')), false, 'no pack was written');
  const text = fs.readFileSync(fx.configPath, 'utf8');
  assert.match(text, /^\[campaigns\.c\]$/m);
  assert.doesNotMatch(text, /campaigns\.y/);
  assert.equal(fs.existsSync(fx.panelDir), false);
});

test('a hung probe on one path does not leave the shared probe slots taken once it settles', async (t) => {
  const fx = fixture(t);
  const a = addAnswers(fx);
  const fsp = {
    stat(p) {
      if (p !== a.output) return fs.promises.stat(p);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('late'), { code: 'EIO' })), 1200);
        timer.unref();
      });
    },
    readdir: fs.promises.readdir,
  };
  // The probe's own timer and the hung stat's late timer are both unref'd, so hold the loop open for the call.
  const keepAlive = setInterval(() => {}, 20);
  let res;
  try {
    res = await register.addFromPanel(a, where(fx), { fsp, timeoutMs: 100 });
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(res.invalid.field, 'output', 'a probe that does not answer is a refusal, not a hang');
  const started = Date.now();
  while (probe.inFlightCount() > 0) {
    if (Date.now() - started > 8000) throw new Error('probe cap did not drain');
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(probe.inFlightCount(), 0);
});

// --- parity with `init --yes` ----------------------------------------------------------------------------------

function twin(t) {
  const a = scratchRoot(t);
  const b = scratchRoot(t);
  const out = [a, b].map((root) => {
    const vaultX = copySample(root, 'vault-x', { withPack: true });
    copySample(root, 'vault-y');
    const l = layout(root);
    fs.mkdirSync(path.dirname(l.configPath), { recursive: true });
    writeConfigFile(l.configPath, { config_version: 1, default_campaign: 'x', campaigns: { x: { vault: vaultX, output: path.join(root, 'ox') } } });
    return { root, ...l };
  });
  return out;
}

test('parity with `init --yes` onto an existing config: pack bytes identical, config identical but for the scratch root, default unchanged', async (t) => {
  const [a, b] = twin(t);
  const done = await register.addFromPanel(
    { name: 'y', vault: path.join(a.root, 'vault-y'), output: path.join(a.root, 'oy'), title: 'The Y Chronicles', theme: 'haze' },
    { configPath: a.configPath, panelDir: a.panelDir, configSha256: sha(a.configPath) },
  );
  assert.ok(done.created, JSON.stringify(done));
  await runInitCommand(
    { yes: true, name: 'y', vault: path.join(b.root, 'vault-y'), out: path.join(b.root, 'oy'), title: 'The Y Chronicles', theme: 'haze', config: b.configPath },
    [],
    { output: QUIET },
  );
  const packA = walk(path.join(a.root, 'vault-y', '_meta', 'scriptorium'));
  const packB = walk(path.join(b.root, 'vault-y', '_meta', 'scriptorium'));
  assert.deepEqual(Object.keys(packA).sort(), ['css/', 'images/', 'pack.toml', 'vault.config.json']);
  assert.deepEqual(packA, packB);
  assert.equal(packA['pack.toml'], 'theme = "haze"\n');
  const cfgA = fs.readFileSync(a.configPath, 'utf8').split(a.root).join('<ROOT>');
  const cfgB = fs.readFileSync(b.configPath, 'utf8').split(b.root).join('<ROOT>');
  assert.equal(cfgA, cfgB);
  assert.match(cfgA, /^default_campaign = "x"$/m);
  assert.match(cfgA, /^vault = "<ROOT>\/vault-y"$/m);
});

test('parity with `init --yes --new-vault --system none` onto an existing config: byte-identical vault and pack trees, the same config entry', async (t) => {
  const [a, b] = twin(t);
  const done = await register.addFromPanel(
    { name: 'fresh', newVault: true, vault: path.join(a.root, 'New Campaign'), output: path.join(a.root, 'fresh-site'), title: 'The Brass Lantern', system: 'none' },
    { configPath: a.configPath, panelDir: a.panelDir, configSha256: sha(a.configPath) },
    deps(),
  );
  assert.ok(done.created, JSON.stringify(done));
  await runInitCommand(
    { yes: true, name: 'fresh', 'new-vault': path.join(b.root, 'New Campaign'), system: 'none', title: 'The Brass Lantern', out: path.join(b.root, 'fresh-site'), config: b.configPath },
    [],
    { output: QUIET, now: NOW, env: {}, templateDir: FIXTURE_DIR },
  );
  const treeA = walk(path.join(a.root, 'New Campaign'));
  const treeB = walk(path.join(b.root, 'New Campaign'));
  assert.ok(Object.keys(treeA).length > 15);
  assert.deepEqual(treeA, treeB);
  assert.equal(fs.readFileSync(a.configPath, 'utf8').split(a.root).join('<ROOT>'), fs.readFileSync(b.configPath, 'utf8').split(b.root).join('<ROOT>'));
});

test('browser setup is unchanged: a first-run commit on an empty config still works through the same pipeline and a second one is refused as taken', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root, 'vault-a');
  const other = copySample(root, 'vault-b');
  const l = layout(root);
  const first = await register.commitSetup({ name: 'a', vault, output: path.join(root, 'oa') }, l);
  assert.equal(first.isDefault, true);
  const second = await register.commitSetup({ name: 'b', vault: other, output: path.join(root, 'ob') }, l);
  assert.deepEqual(second, { refused: 'taken' });
});
