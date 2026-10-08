'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scratchRoot, copySample, configPathIn } = require('./helpers/setup-fixtures');
const { FIXTURE_DIR } = require('./helpers/vault-template-fixture');

const checks = require('../src/setup/checks');
const { validateSystem, validateStarterTitle } = require('../src/setup/validate');
const template = require('../src/setup/template');
const { ConfigError } = require('../src/util/errors');
const { getRenderer } = require('gm-apprentice-publish/lib/templates/pc-registry');

/*
 * The new-vault field checks (docs/decisions/0048-new-campaign-vault.md, section 5). Every rule is
 * written out by hand, word for word, never read back from the code under test.
 */

const RELATIVE_RULE = 'Use the full folder path, starting with a drive letter or /';
const DEPS = { templateDir: FIXTURE_DIR };

function layout(root) {
  const configPath = configPathIn(root);
  return { configPath, panelDir: path.join(path.dirname(configPath), 'panel') };
}

function spyFsp() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    return Promise.reject(Object.assign(new Error('spy'), { code: 'ENOENT' }));
  };
  return { calls, stat: record('stat'), readdir: record('readdir') };
}

/** A fake fsp whose calls answer only after `ms`, so a probe with a shorter bound times out and the slot is freed after. */
function slowFsp(ms) {
  const later = () => new Promise((resolve) => setTimeout(() => resolve({ isDirectory: () => true }), ms));
  return { stat: later, readdir: later };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- validateSystem ---------------------------------------------------------------------------------

test('validateSystem accepts a shipped id and none, and returns it unchanged', () => {
  assert.equal(validateSystem('pf2e', ['pf2e', 'fitd']), 'pf2e');
  assert.equal(validateSystem('none', ['pf2e', 'fitd']), 'none');
  assert.equal(validateSystem('none', []), 'none');
});

test('validateSystem refuses anything else with the list of valid systems, sorted, none last', () => {
  assert.throws(
    () => validateSystem('coc-7e', ['pf2e', 'dnd-5e-2024', 'fitd']),
    (err) => err instanceof ConfigError && err.message === 'unknown game system "coc-7e"; valid systems: dnd-5e-2024, fitd, pf2e, none',
  );
  assert.throws(() => validateSystem('', ['pf2e']), (err) => err.message === 'unknown game system ""; valid systems: pf2e, none');
  assert.throws(() => validateSystem(undefined, ['pf2e']), (err) => err.message === 'unknown game system "undefined"; valid systems: pf2e, none');
  assert.throws(() => validateSystem('PF2E', ['pf2e']), ConfigError, 'ids are exact');
  assert.throws(() => validateSystem('__proto__', ['pf2e']), ConfigError);
});

test('every game system the starter ships is one the generator renders sheets for', () => {
  const tpl = template.loadTemplate({ dir: FIXTURE_DIR });
  const ids = template.starterSystems(tpl);
  assert.ok(ids.length >= 1);
  for (const id of ids) assert.equal(typeof getRenderer(id), 'function', id);
  assert.equal(getRenderer('nonesuch'), null, 'the lookup can fail');
});

// --- checkSystem and checkStarterTitle --------------------------------------------------------------

test('checkSystem: a shipped id and none are ok; an unknown one is bad with the validator message; the facts list the ids', async () => {
  const ok = await checks.checkSystem('dnd-5e-2024', DEPS);
  assert.deepEqual([ok.field, ok.state, ok.value, ok.rule], ['system', 'ok', 'dnd-5e-2024', null]);
  assert.deepEqual(ok.facts.systems, ['dnd-5e-2024']);
  // the folders and files the starter holds for this system, for the review's full list (hand-written from the fixture)
  assert.deepEqual(ok.facts.layout.dirs, ['Characters', 'Characters/NPCs', 'Characters/PCs', 'Factions & Organizations', 'Items & Artifacts', 'Locations', '_Campaign', '_Templates', '_attachments', '_attachments/characters', '_meta']);
  assert.deepEqual(ok.facts.layout.files, ['_Campaign/Player Characters.md', '_Campaign/Timeline.md', '_Campaign/Welcome.md', '_Templates/npc.md', '_Templates/pc.md', '_meta/NOTICE.txt', '_meta/entity-types.md', '_meta/index.md', '_meta/publish-manifest.md', '_meta/relationship-types.md', '_meta/vault-config.md']);
  assert.deepEqual((await checks.checkSystem('none', DEPS)).facts.layout.files.includes('_Templates/pc.md'), true);
  assert.equal(ok.facts.layout.files.includes('_Templates/pc.md'), true);
  assert.equal((await checks.checkSystem('none', DEPS)).state, 'ok');
  const bad = await checks.checkSystem('gurps-4e', DEPS);
  assert.equal(bad.state, 'bad');
  assert.equal('layout' in bad.facts, false);
  assert.equal(bad.rule, 'unknown game system "gurps-4e"; valid systems: dnd-5e-2024, none');
  assert.equal((await checks.checkSystem(undefined, DEPS)).state, 'bad');
});

test('checkSystem and checkStarterTitle: a build with no starter says so and is bad', async (t) => {
  const root = scratchRoot(t);
  const empty = { templateDir: path.join(root, 'no-template') };
  for (const r of [await checks.checkSystem('none', empty), await checks.checkStarterTitle('T', { name: 'x' }, empty)]) {
    assert.equal(r.state, 'bad');
    assert.equal(r.rule, 'this build has no new-campaign starter');
  }
});

test('checkStarterTitle: normalises, defaults to the campaign name, and refuses what the pages cannot hold', async () => {
  const ok = await checks.checkStarterTitle('  The  Brass Lantern ', { name: 'lantern' }, DEPS);
  assert.deepEqual([ok.field, ok.state, ok.value, ok.rule], ['starterTitle', 'ok', 'The Brass Lantern', null]);
  assert.deepEqual(ok.facts, { default: 'lantern' });
  const dflt = await checks.checkStarterTitle(undefined, { name: 'lantern' }, DEPS);
  assert.deepEqual([dflt.state, dflt.value], ['ok', 'lantern']);

  const cases = [
    ['', 'site title must be one non-empty line'],
    ['Say "hi"', "site title can't be written into the new vault's pages exactly as typed; leave out double quotes and backslashes"],
    ['a\\b', "site title can't be written into the new vault's pages exactly as typed; leave out double quotes and backslashes"],
    ['{NAME}', 'site title must not hold a word in braces such as {NAME}'],
    ['a\u0085b', 'site title must not hold control or invisible characters'],
  ];
  for (const [raw, rule] of cases) {
    const r = await checks.checkStarterTitle(raw, { name: 'x' }, DEPS);
    assert.deepEqual([r.state, r.rule], ['bad', rule], JSON.stringify(raw));
  }
  assert.equal((await checks.checkStarterTitle('Tomb: Part 1', { name: 'x' }, DEPS)).value, 'Tomb: Part 1');
});

test('validateStarterTitle returns what checkStarterTitle reports as the value', async () => {
  for (const raw of ['A  B', ' lone ', 'Café']) {
    assert.equal((await checks.checkStarterTitle(raw, { name: 'x' }, DEPS)).value, validateStarterTitle(raw));
  }
});

// --- checkNewVault -------------------------------------------------------------------------------------

test('checkNewVault: a folder that does not exist yet, under one that does, is ok with the facts', async (t) => {
  const root = scratchRoot(t);
  const target = path.join(root, 'New Campaign');
  const r = await checks.checkNewVault(target, { name: 'fresh', ...layout(root) }, DEPS);
  assert.deepEqual([r.field, r.state, r.value, r.rule], ['newVault', 'ok', target, null]);
  assert.deepEqual(r.facts, { exists: false, litter: [], missingAncestors: [], unc: false, oneDrive: false, refusal: null });
});

test('checkNewVault: the missing parent folders are listed, so the review can show them', async (t) => {
  const root = scratchRoot(t);
  const target = path.join(root, 'a', 'b', 'New');
  const r = await checks.checkNewVault(target, { name: 'fresh', ...layout(root) }, DEPS);
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.facts.missingAncestors, [path.join(root, 'a'), path.join(root, 'a', 'b')]);
  assert.equal(fs.existsSync(path.join(root, 'a')), false, 'a check creates nothing');
});

test('checkNewVault: an empty folder is ok and says it exists; litter is reported, never touched', async (t) => {
  const root = scratchRoot(t);
  const target = path.join(root, 'empty');
  fs.mkdirSync(path.join(target, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(target, 'desktop.ini'), 'x');
  const r = await checks.checkNewVault(target, { name: 'fresh', ...layout(root) }, DEPS);
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.facts, { exists: true, litter: ['.obsidian/', 'desktop.ini'], missingAncestors: [], unc: false, oneDrive: false, refusal: null });
});

test('checkNewVault: each refusal is bad, and its rule is the writer\'s message word for word', async (t) => {
  const root = scratchRoot(t);
  const w = layout(root);
  const busy = path.join(root, 'busy');
  fs.mkdirSync(busy);
  fs.writeFileSync(path.join(busy, 'notes.md'), 'x');
  let r = await checks.checkNewVault(busy, { name: 'f', ...w }, DEPS);
  assert.deepEqual([r.state, r.rule], ['bad', `refusing to create a vault in ${busy}: it is not empty (it holds notes.md)`]);

  const file = path.join(root, 'afile');
  fs.writeFileSync(file, 'x');
  r = await checks.checkNewVault(file, { name: 'f', ...w }, DEPS);
  assert.deepEqual([r.state, r.rule], ['bad', `refusing to create a vault in ${file}: it is a file`]);

  const vault = copySample(root);
  r = await checks.checkNewVault(path.join(vault, 'sub'), { name: 'f', ...w }, DEPS);
  assert.deepEqual([r.state, r.rule], ['bad', `refusing to create a vault in ${path.join(vault, 'sub')}: it is inside the vault at ${vault}`]);

  const cfgDir = path.dirname(w.configPath);
  r = await checks.checkNewVault(path.join(cfgDir, 'v'), { name: 'f', ...w }, DEPS);
  assert.equal(r.state, 'bad');
  assert.match(r.rule, /it is inside GM-Scriptorium's own settings folder/);
});

test('checkNewVault: a relative path is bad with the existing wording', async (t) => {
  const root = scratchRoot(t);
  for (const value of ['New', '', './New', '~/New']) {
    const r = await checks.checkNewVault(value, { name: 'f', ...layout(root) }, DEPS);
    assert.deepEqual([r.state, r.rule], ['bad', RELATIVE_RULE], JSON.stringify(value));
  }
});

test('checkNewVault: a UNC path is deferred until commit, and makes ZERO filesystem calls', async (t) => {
  const root = scratchRoot(t);
  const fsp = spyFsp();
  const before = fs.readdirSync(root);
  for (const unc of ['\\\\ledger-nas\\campaigns\\fresh', '//ledger-nas/campaigns/fresh']) {
    const r = await checks.checkNewVault(unc, { name: 'f', commit: false, ...layout(root) }, { ...DEPS, fsp });
    assert.equal(r.state, 'deferred', unc);
    assert.equal(r.facts.unc, true);
    assert.equal(r.rule, null);
  }
  assert.deepEqual(fsp.calls, []);
  assert.deepEqual(fs.readdirSync(root), before);
});

test('checkNewVault: a UNC path at commit is probed with the bound; a share that does not answer is unreachable', async (t) => {
  const root = scratchRoot(t);
  const fsp = slowFsp(150);
  const r = await checks.checkNewVault('\\\\ledger-nas\\campaigns\\fresh', { name: 'f', commit: true, ...layout(root) }, { ...DEPS, fsp, timeoutMs: 20 });
  assert.equal(r.state, 'unreachable');
  assert.equal(r.facts.unc, true);
  assert.equal(r.rule, "Can't reach that folder within a few seconds. If it is on a network share, check that the share is online, then check again.");
  await wait(250);
});

test('checkNewVault: a path under OneDrive is ok and carries the OneDrive fact; the env is injectable', async (t) => {
  const root = scratchRoot(t);
  const drive = path.join(root, 'OneDrive');
  fs.mkdirSync(drive);
  const target = path.join(drive, 'Campaigns', 'New');
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const r = await checks.checkNewVault(target, { name: 'f', ...layout(root) }, { ...DEPS, env: { [key]: drive } });
    assert.equal(r.state, 'ok', key);
    assert.equal(r.facts.oneDrive, true, key);
  }
  const elsewhere = await checks.checkNewVault(path.join(root, 'New'), { name: 'f', ...layout(root) }, { ...DEPS, env: { OneDrive: drive } });
  assert.equal(elsewhere.facts.oneDrive, false);
  const unset = await checks.checkNewVault(target, { name: 'f', ...layout(root) }, { ...DEPS, env: {} });
  assert.equal(unset.facts.oneDrive, false);
  const sibling = await checks.checkNewVault(path.join(root, 'OneDrive2', 'x'), { name: 'f', ...layout(root) }, { ...DEPS, env: { OneDrive: drive } });
  assert.equal(sibling.facts.oneDrive, false, 'OneDrive2 is not inside OneDrive');
});

test('checkNewVault: the OneDrive comparison ignores case where the platform does', async (t) => {
  const root = scratchRoot(t);
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try {
    const drive = path.join(root, 'ONEDRIVE');
    const r = await checks.checkNewVault(path.join(root, 'onedrive', 'x'), { name: 'f', ...layout(root) }, { ...DEPS, env: { OneDrive: drive } });
    assert.equal(r.facts.oneDrive, true);
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});

test('checkNewVault: the probe is bounded and a hung local folder is unreachable, not a stall', async (t) => {
  const root = scratchRoot(t);
  const fsp = slowFsp(150);
  const started = Date.now();
  const r = await checks.checkNewVault(path.join(root, 'x'), { name: 'f', ...layout(root) }, { ...DEPS, fsp, timeoutMs: 20 });
  assert.equal(r.state, 'unreachable');
  assert.ok(Date.now() - started < 140);
  await wait(250);
});

test('checkNewVault: a refusal names its kind and the facts the screen draws from', async (t) => {
  const root = scratchRoot(t);
  const w = layout(root);
  const busy = path.join(root, 'busy');
  fs.mkdirSync(busy);
  for (const n of ['b.md', 'a.md']) fs.writeFileSync(path.join(busy, n), 'x');
  let r = await checks.checkNewVault(busy, { name: 'f', ...w }, DEPS);
  assert.deepEqual([r.state, r.facts.refusal, r.facts.holds], ['bad', 'not-empty', ['a.md', 'b.md']]);
  const file = path.join(root, 'f');
  fs.writeFileSync(file, 'x');
  assert.equal((await checks.checkNewVault(file, { name: 'f', ...w }, DEPS)).facts.refusal, 'file');
  const link = path.join(root, 'l');
  fs.symlinkSync(busy, link, 'dir');
  assert.equal((await checks.checkNewVault(link, { name: 'f', ...w }, DEPS)).facts.refusal, 'link');
  const vault = copySample(root);
  r = await checks.checkNewVault(path.join(vault, 'x'), { name: 'f', ...w }, DEPS);
  assert.deepEqual([r.facts.refusal, r.facts.ancestor], ['inside-vault', vault]);
  r = await checks.checkNewVault(path.join(path.dirname(w.configPath), 'v'), { name: 'f', ...w }, DEPS);
  assert.equal(r.facts.refusal, 'settings');
  r = await checks.checkNewVault('relative', { name: 'f', ...w }, DEPS);
  assert.equal(r.facts.refusal, 'relative');
  r = await checks.checkNewVault(path.join(root, 'ok'), { name: 'f', ...w }, DEPS);
  assert.equal(r.facts.refusal, null);
});

test('checkNewVault: a folder holding only a git folder is ok, and the facts list it as litter', async (t) => {
  const root = scratchRoot(t);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const r = await checks.checkNewVault(repo, { name: 'f', ...layout(root) }, DEPS);
  assert.deepEqual([r.state, r.facts.exists, r.facts.litter], ['ok', true, ['.git/']]);
});
