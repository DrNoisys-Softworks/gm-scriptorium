'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeCampaigns, startPanel, post, get, previewGet } = require('./helpers/campaigns-panel');

/*
 * ADR 0050 section 3: one preview listener, one temp root per campaign. These tests build real
 * previews of two sample vaults whose titles differ, so "whose bytes are these" is readable in the
 * page itself. The expected titles are written out by hand.
 */

const NO_PREVIEW = 'no preview has been built yet';

function retitle(vault, title) {
  const file = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.siteTitle = title;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function twoSites(t) {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  retitle(fx.vaults.alpha, 'Alpha Title Marker');
  retitle(fx.vaults.beta, 'Beta Title Marker');
  return fx;
}

async function build(h, campaign) {
  const res = await post(h, '/api/preview', {}, campaign === undefined ? {} : { campaign });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.exitCode, 0, res.text);
}

async function switchTo(h, name, from) {
  const res = await post(h, '/api/campaigns/switch', { name }, { campaign: from });
  assert.equal(res.status, 200, res.text);
}

test('a preview is never served under the wrong campaign: after a switch the listener answers 404, and each campaign gets its own bytes', async (t) => {
  const fx = twoSites(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');

  await build(h);
  const rootA = h.ctx.previewRoot;
  const a = await previewGet(h, '/');
  assert.equal(a.status, 200);
  assert.match(a.text, /Alpha Title Marker/);

  await switchTo(h, 'beta', 'alpha');
  const none = await previewGet(h, '/');
  assert.equal(none.status, 404);
  assert.equal(none.text, NO_PREVIEW);
  assert.equal(none.text.includes('Alpha'), false);

  await build(h, 'beta');
  const rootB = h.ctx.previewRoot;
  assert.notEqual(rootA, rootB, 'each campaign has its own root');
  const b = await previewGet(h, '/');
  assert.equal(b.status, 200);
  assert.match(b.text, /Beta Title Marker/);
  assert.equal(b.text.includes('Alpha Title Marker'), false);

  await switchTo(h, 'alpha', 'beta');
  assert.equal(h.ctx.previewRoot, rootA);
  const again = await previewGet(h, '/');
  assert.equal(again.status, 200);
  assert.match(again.text, /Alpha Title Marker/, 'A\'s last preview comes back from A\'s root');
  assert.equal(fs.existsSync(rootB), true, 'B\'s root is kept while B is stashed');
});

test('preview info follows the campaign: B has none after a switch, A\'s freshness stamp returns', async (t) => {
  const fx = twoSites(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  await build(h);
  const builtAt = h.ctx.previewStamp.builtAt;
  await switchTo(h, 'beta', 'alpha');
  const info = await get(h, '/api/state?include=previewinfo');
  assert.equal(info.status, 200);
  assert.equal(info.json.previewInfo.built, false);
  await switchTo(h, 'alpha', 'beta');
  const back = await get(h, '/api/state?include=previewinfo');
  assert.equal(back.json.previewInfo.built, true);
  assert.equal(back.json.previewInfo.builtAt, builtAt);
});

test('variants follow the root: a variant built on A is not served on B and is served again on return', async (t) => {
  const fx = twoSites(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  await build(h);
  const built = await post(h, '/api/variants/theme', { theme: 'haze' });
  assert.equal(built.status, 200, built.text);
  assert.equal(built.json.exitCode, 0, built.text);
  const id = built.json.variant.id;
  const url = `/:variant/${id}/`;
  assert.equal((await previewGet(h, url)).status, 200);

  await switchTo(h, 'beta', 'alpha');
  assert.equal(h.ctx.variants, undefined);
  assert.equal((await previewGet(h, url)).status, 404);

  await switchTo(h, 'alpha', 'beta');
  const back = await previewGet(h, url);
  assert.equal(back.status, 200);
});

test('removing a stashed campaign deletes its preview root from disk', async (t) => {
  const fx = twoSites(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  await switchTo(h, 'beta', 'alpha');
  await build(h, 'beta');
  const rootB = h.ctx.previewRoot;
  assert.equal(fs.existsSync(rootB), true);
  await switchTo(h, 'alpha', 'beta');
  assert.equal(h.ctx.campaigns.slots.has('beta'), true);

  const listed = await get(h, '/api/campaigns');
  const res = await post(h, '/api/campaigns/remove', { name: 'beta', configSha256: listed.json.configSha256 }, { campaign: 'alpha' });
  assert.equal(res.status, 200, res.text);
  assert.equal(fs.existsSync(rootB), false, 'B\'s root is gone');
  assert.equal(h.ctx.campaigns.slots.has('beta'), false);
});

test('a stashed campaign whose vault path changed is discarded: its root is removed and the preview is not shown', async (t) => {
  const fx = twoSites(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  await switchTo(h, 'beta', 'alpha');
  await build(h, 'beta');
  const rootB = h.ctx.previewRoot;
  await switchTo(h, 'alpha', 'beta');

  // Point beta at a different vault (a copy with another title) while it is stashed.
  const moved = path.join(fx.root, 'vault-moved');
  fs.cpSync(fx.vaults.beta, moved, { recursive: true });
  retitle(moved, 'Moved Title Marker');
  fs.writeFileSync(fx.configPath, fs.readFileSync(fx.configPath, 'utf8').split(JSON.stringify(fx.vaults.beta)).join(JSON.stringify(moved)));

  await switchTo(h, 'beta', 'alpha');
  assert.equal(h.ctx.vaultPath, moved);
  assert.equal(fs.existsSync(rootB), false, 'the old root was removed');
  const none = await previewGet(h, '/');
  assert.equal(none.status, 404);
  assert.equal(none.text, NO_PREVIEW);
  assert.equal(h.ctx.previewRoot, undefined);
});

test('stop() removes the current root and every stashed root', async (t) => {
  const fx = twoSites(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  await build(h);
  const rootA = h.ctx.previewRoot;
  await switchTo(h, 'beta', 'alpha');
  await build(h, 'beta');
  const rootB = h.ctx.previewRoot;
  assert.equal(fs.existsSync(rootA) && fs.existsSync(rootB), true);
  await h.stop();
  assert.equal(fs.existsSync(rootA), false);
  assert.equal(fs.existsSync(rootB), false);
});
