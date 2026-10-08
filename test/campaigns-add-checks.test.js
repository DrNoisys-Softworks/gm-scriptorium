'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scratchRoot } = require('./helpers/setup-fixtures');
const { FIXTURE_DIR } = require('./helpers/vault-template-fixture');

const checks = require('../src/setup/checks');

/*
 * ADR 0052, sections 3 and 4: the shared check dispatcher, the answer-shape rules and the lexical
 * clash rules. Every rule string is written out by hand, word for word, never read back from the
 * code under test. registeredClash must touch no file system at all, so a dead share belonging to
 * another campaign can never stall an add.
 */

const config = (campaigns) => ({ config_version: 1, campaigns });

function spyFsp() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    return Promise.reject(Object.assign(new Error('spy'), { code: 'ENOENT' }));
  };
  return { calls, stat: record('stat'), readdir: record('readdir') };
}

/** Runs fn with every file system probe registeredClash could reach patched to throw. */
function withNoFs(fn) {
  const names = ['statSync', 'existsSync', 'realpathSync', 'lstatSync', 'readdirSync'];
  const saved = {};
  for (const n of names) {
    saved[n] = fs[n];
    fs[n] = () => {
      throw new Error(`fs.${n} must not be called`);
    };
  }
  const savedStat = fs.promises.stat;
  fs.promises.stat = () => {
    throw new Error('fs.promises.stat must not be called');
  };
  try {
    return fn();
  } finally {
    for (const n of names) fs[n] = saved[n];
    fs.promises.stat = savedStat;
  }
}

// --- registeredClash ---------------------------------------------------------------------------------

const REGISTERED = config({
  harrowmoor: { vault: 'D:\\Campaigns\\Harrowmoor', output: 'D:\\Sites\\harrowmoor' },
  'the-long-lease': { vault: '/srv/vaults/lease', output: '/srv/sites/lease' },
});

test('registeredClash: a name already registered, with the exact rule', () => {
  const hit = checks.registeredClash(REGISTERED, { name: 'harrowmoor' });
  assert.deepEqual(hit, { field: 'name', kind: 'name', campaign: 'harrowmoor', rule: 'campaign "harrowmoor" is already registered; choose another name' });
});

test('registeredClash: a vault equal to another campaign vault, printed as the other one wrote it', () => {
  const hit = checks.registeredClash(REGISTERED, { vault: 'D:\\Campaigns\\Harrowmoor\\' });
  assert.deepEqual(hit, {
    field: 'vault',
    kind: 'vault-equal',
    campaign: 'harrowmoor',
    rule: 'D:\\Campaigns\\Harrowmoor\\ is already registered as campaign "harrowmoor"',
  });
});

test('registeredClash: mixed slashes, case and a trailing separator all compare equal', () => {
  assert.equal(checks.registeredClash(REGISTERED, { vault: 'd:/campaigns/HARROWMOOR/' }).kind, 'vault-equal');
  assert.equal(checks.registeredClash(REGISTERED, { vault: '/SRV/vaults/lease' }).kind, 'vault-equal');
  assert.equal(checks.registeredClash(REGISTERED, { output: 'D:/sites/HARROWMOOR' }).kind, 'output-overlap-output');
});

test('registeredClash: a vault equal to a vault in a paths.<profile> table is found, and the profile value is the one printed', () => {
  const cfg = config({ other: { vault: '/a/main', output: '/a/out', paths: { laptop: { match: { hostname: 'x' }, vault: '/b/laptop-vault', output: '/b/laptop-out' } } } });
  assert.deepEqual(checks.registeredClash(cfg, { vault: '/b/laptop-vault' }), {
    field: 'vault',
    kind: 'vault-equal',
    campaign: 'other',
    rule: '/b/laptop-vault is already registered as campaign "other"',
  });
  assert.equal(checks.registeredClash(cfg, { output: '/b/laptop-out/site' }).kind, 'output-overlap-output');
});

test('registeredClash: a vault inside another output, and a vault containing one', () => {
  const inside = checks.registeredClash(REGISTERED, { vault: 'D:\\Sites\\harrowmoor\\notes' });
  assert.deepEqual(inside, {
    field: 'vault',
    kind: 'vault-in-output',
    campaign: 'harrowmoor',
    rule: 'D:\\Sites\\harrowmoor\\notes overlaps the output folder of campaign "harrowmoor" (D:\\Sites\\harrowmoor), which every build of "harrowmoor" replaces',
  });
  const containing = checks.registeredClash(REGISTERED, { vault: 'D:\\Sites' });
  assert.equal(containing.kind, 'vault-in-output');
  assert.equal(containing.campaign, 'harrowmoor');
});

test('registeredClash: an output equal to, or inside, another output', () => {
  const equal = checks.registeredClash(REGISTERED, { output: 'D:\\Sites\\harrowmoor' });
  assert.deepEqual(equal, {
    field: 'output',
    kind: 'output-overlap-output',
    campaign: 'harrowmoor',
    rule: 'D:\\Sites\\harrowmoor overlaps the output folder of campaign "harrowmoor" (D:\\Sites\\harrowmoor); each campaign needs its own output folder',
  });
  assert.equal(checks.registeredClash(REGISTERED, { output: 'D:\\Sites\\harrowmoor\\v2' }).kind, 'output-overlap-output');
});

test('registeredClash: an output inside another vault, and an output containing one', () => {
  const inside = checks.registeredClash(REGISTERED, { output: 'D:\\Campaigns\\Harrowmoor\\site' });
  assert.deepEqual(inside, {
    field: 'output',
    kind: 'output-in-vault',
    campaign: 'harrowmoor',
    rule: 'D:\\Campaigns\\Harrowmoor\\site overlaps the vault of campaign "harrowmoor" (D:\\Campaigns\\Harrowmoor); a build replaces its whole output folder, so it must stay clear of every vault',
  });
  const containing = checks.registeredClash(REGISTERED, { output: 'D:\\Campaigns' });
  assert.equal(containing.kind, 'output-in-vault');
});

test('registeredClash: the rules are tried in order and the first hit wins', () => {
  // name first
  assert.equal(checks.registeredClash(REGISTERED, { name: 'harrowmoor', vault: 'D:\\Campaigns\\Harrowmoor', output: 'D:\\Sites\\harrowmoor' }).kind, 'name');
  // then vault equal, before a vault inside an output
  assert.equal(checks.registeredClash(REGISTERED, { vault: 'D:\\Campaigns\\Harrowmoor', output: 'D:\\Sites\\harrowmoor' }).kind, 'vault-equal');
  // a vault clash is found before an output clash
  assert.equal(checks.registeredClash(REGISTERED, { vault: 'D:\\Sites\\harrowmoor\\n', output: 'D:\\Sites\\harrowmoor' }).kind, 'vault-in-output');
  // an output equal to an output is found before an output inside a vault
  const cfg = config({ a: { vault: '/x', output: '/x/out' } });
  assert.equal(checks.registeredClash(cfg, { output: '/x/out' }).kind, 'output-overlap-output');
});

test('registeredClash: no clash is null, a sibling folder with a shared prefix is not a clash, and empty or odd input is skipped', () => {
  assert.equal(checks.registeredClash(REGISTERED, { name: 'new', vault: 'D:\\Campaigns\\Saltmarsh', output: 'D:\\Sites\\saltmarsh' }), null);
  assert.equal(checks.registeredClash(REGISTERED, { vault: 'D:\\Campaigns\\Harrowmoor2', output: 'D:\\Sites\\harrowmoor-2' }), null, 'a shared prefix is not containment');
  assert.equal(checks.registeredClash(REGISTERED, {}), null);
  assert.equal(checks.registeredClash(REGISTERED, { name: '', vault: '', output: '' }), null);
  assert.equal(checks.registeredClash(REGISTERED, { vault: '/', output: '\\' }), null, 'a value that normalises to nothing is skipped');
  const odd = config({ broken: 'not a table', nul: null, arr: [1], empty: { vault: '/', output: '' }, good: { vault: '/g/v', output: '/g/o' } });
  assert.equal(checks.registeredClash(odd, { vault: '/g/v' }).campaign, 'good', 'non-object entries and empty values are skipped');
  assert.equal(checks.registeredClash({ config_version: 1 }, { name: 'a' }), null, 'a config with no campaigns');
});

test('registeredClash touches no file system: fs.statSync, existsSync, realpathSync and fs.promises.stat are patched to throw', () => {
  withNoFs(() => {
    assert.equal(checks.registeredClash(REGISTERED, { name: 'x', vault: 'D:\\v', output: 'D:\\o' }), null);
    assert.equal(checks.registeredClash(REGISTERED, { vault: 'D:\\Campaigns\\Harrowmoor' }).kind, 'vault-equal');
  });
  assert.throws(() => withNoFs(() => fs.statSync('.')), /must not be called/, 'positive control: the patch does throw');
});

// --- deferUntilCommit ----------------------------------------------------------------------------------

test('deferUntilCommit: a vault, a new vault and an output are deferred with no probe until the commit, then probed', async (t) => {
  const root = scratchRoot(t);
  const vault = path.join(root, 'vault');
  const typed = path.join(root, 'somewhere');

  const fsp = spyFsp();
  const v = await checks.checkVault(typed, { name: 'lease', commit: false, deferUntilCommit: true }, { fsp });
  assert.equal(v.state, 'deferred');
  assert.equal(v.facts.unc, false, 'facts still say whether it is a network path');
  const nv = await checks.checkNewVault(typed, { name: 'lease', commit: false, deferUntilCommit: true }, { fsp, templateDir: FIXTURE_DIR });
  assert.equal(nv.state, 'deferred');
  const out = await checks.checkOutput(typed, { vault, name: 'lease', commit: false, deferUntilCommit: true }, { fsp });
  assert.equal(out.state, 'deferred');
  assert.equal(out.facts.default, path.join(root, 'lease-site'), 'the suggested folder is still worked out');
  assert.deepEqual(fsp.calls, [], 'nothing was probed');

  await checks.checkVault(typed, { name: 'lease', commit: true, deferUntilCommit: true }, { fsp });
  assert.ok(fsp.calls.length > 0, 'vault probes with commit true');
  const before = fsp.calls.length;
  await checks.checkNewVault(typed, { name: 'lease', commit: true, deferUntilCommit: true }, { fsp, templateDir: FIXTURE_DIR });
  assert.ok(fsp.calls.length > before, 'new vault probes with commit true');
  const before2 = fsp.calls.length;
  await checks.checkOutput(typed, { vault, name: 'lease', commit: true, deferUntilCommit: true }, { fsp });
  assert.ok(fsp.calls.length > before2, 'output probes with commit true');
});

test('without deferUntilCommit a local path is probed at once, as in browser setup (and a UNC path is still deferred)', async (t) => {
  const root = scratchRoot(t);
  const fsp = spyFsp();
  await checks.checkVault(path.join(root, 'v'), { commit: false }, { fsp });
  assert.ok(fsp.calls.length > 0);
  const unc = await checks.checkVault('\\\\server\\share\\v', { commit: false }, { fsp: spyFsp() });
  assert.equal(unc.state, 'deferred');
  assert.equal(unc.facts.unc, true);
});

// --- parseCheckQuery, runCheck, setupFacts, answersProblem -----------------------------------------------

test('parseCheckQuery: the field list, the length caps, and commit', () => {
  const q = (s) => checks.parseCheckQuery(new URLSearchParams(s));
  assert.deepEqual(q('field=name&value=abc'), { ok: true, field: 'name', value: 'abc', name: undefined, vault: undefined, commit: false });
  assert.deepEqual(q('field=output&value=o&name=n&vault=v&commit=1'), { ok: true, field: 'output', value: 'o', name: 'n', vault: 'v', commit: true });
  assert.equal(q('field=output&commit=true').commit, false, 'only 1 is a commit');
  const bad = 'field must be one of name, vault, output, title, theme, newVault, system, starterTitle';
  assert.deepEqual(q('field=nope'), { ok: false, message: bad });
  assert.deepEqual(q(''), { ok: false, message: bad });
  assert.equal(q(`field=name&value=${'x'.repeat(2048)}`).ok, true);
  assert.deepEqual(q(`field=name&value=${'x'.repeat(2049)}`), { ok: false, message: 'a value is too long' });
  assert.deepEqual(q(`field=name&vault=${'x'.repeat(2049)}`), { ok: false, message: 'a value is too long' });
  assert.equal(q(`field=name&name=${'x'.repeat(200)}`).ok, true);
  assert.deepEqual(q(`field=name&name=${'x'.repeat(201)}`), { ok: false, message: 'a value is too long' });
  assert.deepEqual([...checks.CHECK_FIELDS], ['name', 'vault', 'output', 'title', 'theme', 'newVault', 'system', 'starterTitle']);
});

test('runCheck answers the name check and the theme check through the one dispatcher', async () => {
  const name = await checks.runCheck({ field: 'name', value: 'the-long-lease' }, {});
  assert.equal(name.state, 'ok');
  assert.equal(name.value, 'the-long-lease');
  const badName = await checks.runCheck({ field: 'name', value: 'Not Valid' }, {});
  assert.equal(badName.state, 'bad');
  const theme = await checks.runCheck({ field: 'theme', value: 'gloam', name: 'x' }, {});
  assert.equal(theme.field, 'theme');
});

test('setupFacts: the themes, the default theme, the separator and whether a new vault can be started', () => {
  const facts = checks.setupFacts({ templateDir: FIXTURE_DIR });
  assert.deepEqual(Object.keys(facts), ['themes', 'defaultTheme', 'sep', 'newVault']);
  assert.ok(facts.themes.includes('gloam'));
  assert.equal(facts.defaultTheme, 'gloam');
  assert.equal(facts.sep, path.sep);
  assert.equal(facts.newVault.available, true);
  assert.equal(facts.newVault.problem, null);
  const broken = checks.setupFacts({ templateDir: path.join(__dirname, 'no-such-template-folder') });
  assert.equal(broken.newVault.available, false);
  assert.deepEqual(broken.newVault.systems, []);
  assert.equal(typeof broken.newVault.problem, 'string');
});

test('answersProblem: the same messages as browser setup, word for word', () => {
  const ok = { name: 'a', vault: '/v', output: '/o' };
  assert.equal(checks.answersProblem(ok), null);
  assert.equal(checks.answersProblem({ ...ok, outputConfirmed: true, title: 't', theme: 'gloam', newVault: true, system: 'none' }), null);
  assert.equal(checks.answersProblem({ ...ok, extra: 1 }), 'unknown field: extra');
  assert.equal(checks.answersProblem({ ...ok, extra: 1, more: 2 }), 'unknown fields: extra, more');
  assert.equal(checks.answersProblem({}), 'name must be text');
  assert.equal(checks.answersProblem({ name: 'a' }), 'vault must be text');
  assert.equal(checks.answersProblem({ name: 'a', vault: '/v' }), 'output must be text');
  assert.equal(checks.answersProblem({ ...ok, name: 5 }), 'name must be text');
  assert.equal(checks.answersProblem({ ...ok, vault: 'x'.repeat(2049) }), 'vault must be text');
  assert.equal(checks.answersProblem({ ...ok, title: 5 }), 'title must be text');
  assert.equal(checks.answersProblem({ ...ok, theme: 5 }), 'theme must be text');
  assert.equal(checks.answersProblem({ ...ok, system: 5 }), 'system must be text');
  assert.equal(checks.answersProblem({ ...ok, outputConfirmed: 'yes' }), 'outputConfirmed must be true or false');
  assert.equal(checks.answersProblem({ ...ok, newVault: 'yes' }), 'newVault must be true or false');
  assert.deepEqual([...checks.ANSWER_KEYS], ['name', 'vault', 'output', 'outputConfirmed', 'title', 'theme', 'newVault', 'system']);
});

test('answersProblem accepts an extra allowed key only when the caller lists it', () => {
  const body = { name: 'a', vault: '/v', output: '/o', configSha256: 'f'.repeat(64) };
  assert.equal(checks.answersProblem(body), 'unknown field: configSha256');
  assert.equal(checks.answersProblem(body, [...checks.ANSWER_KEYS, 'configSha256']), null);
});
