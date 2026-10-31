'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { moveVaultCopy, replaceChecked } = require('./helpers/moved-vault');
const { scratchRoot, configPathIn, startPanel, post } = require('./helpers/campaigns-panel');
const pinned = require('../src/generator/pinned');

/*
 * The title dry run warns that the campaign id moves when a live-play feature is on. Scriptorium
 * never names those switches in src/ (test/live-stats-off.test.js); it asks the pin's settings
 * registry which settings are the live-play features. These tests pin that answer as literals, and
 * prove the inbox switch alone triggers the warning (the live stats case is in
 * test/admin-vault-settings-title.test.js). Expected values are literals, not read from the pin.
 */

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function movedCampaign(t) {
  const root = scratchRoot(t);
  const { vaultPath } = moveVaultCopy(SAMPLE, root, { inVaultPack: true });
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = ${JSON.stringify(vaultPath)}`, `output = ${JSON.stringify(path.join(root, 'out'))}`, ''].join('\n'),
  );
  return { configPath, yaml: path.join(vaultPath, '_meta', 'vault-config.yaml') };
}

const titleBody = (fx, extra) => ({ file: 'vault-config.yaml', baseSha256: sha(fs.readFileSync(fx.yaml)), ...extra });

test('the pin names exactly two live-play settings: live stats and the inbox', () => {
  assert.deepEqual(pinned.liveFeatureSettings().slice().sort(), ['player_site.features.inbox', 'player_site.features.live_stats']);
});

test('with only the inbox on, a dry run that changes the title reports the campaign id change', async (t) => {
  const fx = movedCampaign(t);
  const text = fs.readFileSync(fx.yaml, 'utf8');
  assert.match(text, /live_stats: false/, 'precondition: live stats stays off');
  fs.writeFileSync(fx.yaml, replaceChecked(text, 'inbox: false', 'inbox: true'));
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const res = await post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name', dryRun: true }));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.campaignId, { before: 'the-long-lease', after: 'a-new-name' });
});

test('with both live-play switches off, a title dry run reports no campaign id change', async (t) => {
  const fx = movedCampaign(t);
  const h = await startPanel(t, { config: fx.configPath }, 'lease');
  const res = await post(h, '/api/vault-config/title', titleBody(fx, { title: 'A New Name', dryRun: true }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.campaignId, undefined);
});
