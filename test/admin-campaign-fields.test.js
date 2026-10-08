'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAdminContext } = require('../src/admin/context');
const campaignstate = require('../src/admin/campaignstate');
const { makeCampaigns, startPanel, get, post, snapshotFields } = require('./helpers/campaigns-panel');

/*
 * ADR 0050 section 2: every field the panel context carries is classified as belonging to the
 * process or to one campaign, so a switch can never carry one campaign's state into another.
 * test/admin-context.test.js is frozen and is not touched: the context's literal is not changed,
 * and the classification is checked here instead, by scanning the source for every ctx.<name> and
 * by observing a started panel. The lists below are written out by hand, not read from the module.
 */

const RESOLVED = ['campaign', 'ctxInfo', 'vaultPath', 'siteSource', 'siteConfigPath', 'packDir', 'writable', 'readOnlyReason'];
const KEPT = ['previewRoot', 'previewDir', 'previewStamp', 'previewPages', 'variants', 'panelSaves'];
const RESET = ['vaultArt', 'vaultConfigReview'];
const PROCESS = [
  'token', 'adminPort', 'previewPort', 'busy', 'access', 'remote', 'sessions', 'audit', 'lockout', 'tickets', 'clock', 'signinBusy',
  'lastHashMs', 'setup', 'launchCodes', 'campaigns', 'folderDrives',
];
const UNION = [...RESOLVED, ...KEPT, ...RESET, ...PROCESS].sort();
// Names only a test ever sets on the context (test/folders-structure.test.js allows the name in one
// source file alone, so it cannot be listed in src/admin/campaignstate.js). Production never sets it.
const TEST_SEAMS = ['folderDeps'];

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listJs(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) out.push(full);
    }
  })(dir);
  return out.sort();
}

// src/admin/foldercreate.js names its options argument `ctx` (configDir, panelDir, vaults, deps); that is
// not the panel context, which reaches the folder code only through handlers/folders.js (folderDeps, folderDrives).
const NOT_THE_CONTEXT = [path.join(SRC, 'admin', 'foldercreate.js')];

function scannedFiles() {
  return [...listJs(path.join(SRC, 'admin')), path.join(SRC, 'cli', 'serve-admin.js'), path.join(SRC, 'cli', 'launch.js')].filter((f) => !NOT_THE_CONTEXT.includes(f));
}

function ctxNames(files) {
  const names = new Set();
  for (const f of files) {
    const source = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

// --- the classification --------------------------------------------------------------------------------

test('the module lists equal the hand-written literals, and the four lists are disjoint', () => {
  assert.deepEqual([...campaignstate.CAMPAIGN_FIELDS.resolved], RESOLVED);
  assert.deepEqual([...campaignstate.CAMPAIGN_FIELDS.kept], KEPT);
  assert.deepEqual([...campaignstate.CAMPAIGN_FIELDS.reset], RESET);
  assert.deepEqual([...campaignstate.PROCESS_FIELDS].sort(), [...PROCESS].sort());
  assert.equal(new Set([...RESOLVED, ...KEPT, ...RESET, ...PROCESS]).size, RESOLVED.length + KEPT.length + RESET.length + PROCESS.length);
  for (const list of [campaignstate.CAMPAIGN_FIELDS, campaignstate.PROCESS_FIELDS]) assert.ok(Object.isFrozen(list));
});

test('every ctx.<name> in src/admin, serve-admin.js and launch.js is classified, and every classified name is used', () => {
  const files = scannedFiles();
  assert.ok(files.length >= 30, `scanned ${files.length} files`);
  assert.deepEqual(ctxNames(files), [...UNION, ...TEST_SEAMS].sort());
});

test('positive control: a new ctx field in a scanned file is detected as unclassified', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fields-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planted = path.join(dir, 'planted.js');
  fs.writeFileSync(planted, "module.exports = (ctx) => { ctx.newThing = 1; };\n// ctx.onlyInAComment = 2\n");
  const names = ctxNames([...scannedFiles(), planted]);
  assert.notDeepEqual(names, [...UNION, ...TEST_SEAMS].sort());
  assert.deepEqual(names.filter((n) => !UNION.includes(n) && !TEST_SEAMS.includes(n)), ['newThing']);
});

test('the keys of a fresh createAdminContext are a subset of the classified fields', () => {
  const ctx = createAdminContext({
    ctxInfo: { campaign: 'x' },
    vaultPath: '/v',
    site: { siteSource: 'convention', siteConfigPath: '/s', siteDir: '/d' },
    token: 't',
  });
  const unclassified = Object.keys(ctx).filter((k) => !UNION.includes(k));
  assert.deepEqual(unclassified, []);
});

test('a started panel that has served state, vault-art and a preview carries only classified fields', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  assert.equal((await get(h, '/api/state?include=vocab,palette,vaultconfig,previewinfo,vaultconfigeditor,variants')).status, 200);
  assert.equal((await get(h, '/api/vault-art')).status, 200);
  const built = await post(h, '/api/preview', {});
  assert.equal(built.status, 200, built.text);
  const unclassified = Object.keys(h.ctx).filter((k) => !UNION.includes(k));
  assert.deepEqual(unclassified, []);
});

// --- switch seeding (the test's own sentinel values) -----------------------------------------------------

test('switch seeding: no A value survives on B, kept fields return on switching back, reset fields are absent', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const { ctx } = h;

  const rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-preview-seed-')));
  t.after(() => fs.rmSync(rootA, { recursive: true, force: true }));
  const A = {
    previewRoot: rootA,
    previewDir: path.join(rootA, 'site'),
    previewStamp: { builtAt: 'A-stamp', shas: {}, saves: 7 },
    previewPages: ['A-page'],
    variants: new Map([['A-variant', { stamp: 'A', pages: [], builtAtMs: 1 }]]),
    panelSaves: 7,
    vaultArt: { sentinel: 'A-art' },
    vaultConfigReview: { sentinel: 'A-review' },
  };
  Object.assign(ctx, A);
  const processBefore = snapshotFields(ctx, PROCESS.filter((f) => f !== 'busy'));

  const sw = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(sw.status, 200, sw.text);
  assert.equal(ctx.campaign, 'beta');
  assert.equal(ctx.vaultPath, fx.vaults.beta);

  // Nothing of A's is on B.
  assert.equal(ctx.previewDir, null);
  for (const f of ['previewRoot', 'previewStamp', 'previewPages', 'variants', 'panelSaves', 'vaultArt', 'vaultConfigReview']) {
    assert.equal(f in ctx, false, `${f} must be absent on a never-visited campaign, not null`);
  }
  for (const f of KEPT.concat(RESET)) {
    if (f in ctx) assert.notDeepEqual(ctx[f], A[f], f);
  }
  assert.deepEqual(snapshotFields(ctx, PROCESS.filter((f) => f !== 'busy')), processBefore, 'process-wide fields are untouched');

  // And back: the kept fields return as they were left, the reset fields stay absent.
  const back = await post(h, '/api/campaigns/switch', { name: 'alpha' }, { campaign: 'beta' });
  assert.equal(back.status, 200, back.text);
  assert.equal(ctx.campaign, 'alpha');
  for (const f of KEPT) assert.strictEqual(ctx[f], A[f], f);
  for (const f of RESET) assert.equal(f in ctx, false, f);
  assert.deepEqual([...ctx.campaigns.slots.keys()], ['beta'], 'the restored slot left the map; the campaign just left is stashed');
  // The test owns rootA; keep the panel's stop from being the thing that removes the sentinel.
  assert.equal(fs.existsSync(rootA), true);
});

test('a panel with a vaultArt read after a switch does not crash (the field is deleted, never null)', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  assert.equal((await get(h, '/api/vault-art')).status, 200);
  const sw = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(sw.status, 200, sw.text);
  assert.equal('vaultArt' in h.ctx, false);
  const art = await get(h, '/api/vault-art');
  assert.equal(art.status, 200, art.text);
});

test('applySwitch alone never restores a stash made for another vault (the slot is discarded, the kept fields are fresh)', () => {
  const ctx = {
    campaign: 'a',
    vaultPath: '/vault/a',
    campaigns: campaignstate.createCampaignsState({}),
    previewRoot: '/tmp/root-a',
    previewDir: '/tmp/root-a/site',
  };
  // B was stashed earlier for /vault/b-old, and its config now points at /vault/b-new.
  ctx.campaigns.slots.set('b', { vaultPath: '/vault/b-old', previewRoot: '/tmp/root-b-old', previewDir: '/tmp/root-b-old/site', panelSaves: 4 });
  const fresh = { campaign: 'b', ctxInfo: {}, vaultPath: '/vault/b-new', siteSource: 'convention', siteConfigPath: 's', packDir: 'p', writable: true, readOnlyReason: null };
  campaignstate.applySwitch(ctx, fresh);
  assert.equal(ctx.campaign, 'b');
  assert.equal(ctx.previewDir, null);
  for (const f of ['previewRoot', 'panelSaves', 'previewStamp', 'previewPages', 'variants']) assert.equal(f in ctx, false, f);
  assert.deepEqual([...ctx.campaigns.slots.keys()], ['a']);
  assert.equal(ctx.campaigns.slots.get('a').previewRoot, '/tmp/root-a');
});
