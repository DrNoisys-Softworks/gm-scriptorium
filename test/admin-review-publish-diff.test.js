'use strict';

/*
 * The panel's review compares which pages the site would publish before and after a settings edit,
 * each side read the way the generator reads it, so an edit that would publish more pages always
 * asks for the GM's tick. These cases map a folder the vault's settings did not map before, on both
 * layouts, and expect the review to name the page that would newly publish and the folder. Expected
 * values are typed out by hand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite } = require('../src/cli/check');
const candidatecheck = require('../src/admin/candidatecheck');
const publishset = require('../src/vault/publishset');
const read = require('../src/vault/read');
const { moveVaultCopy, assertMovedLayout, replaceChecked } = require('./helpers/moved-vault');
const { scratchRoot, configPathIn, startPanel, post } = require('./helpers/campaigns-panel');
const vaultconfigedit = require('../src/admin/vaultconfigedit');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');

function packMapOf(vault) {
  return JSON.parse(fs.readFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), 'utf8')).folderMap;
}

function addSecretNote(vault) {
  fs.mkdirSync(path.join(vault, 'Secret'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Secret', 'Plot.md'), '---\ntitle: Plot\ntype: location\n---\n# Plot\n\nOttoline Pardew is behind it all.\n');
  const man = path.join(vault, '_meta', 'publish-manifest.md');
  fs.writeFileSync(man, replaceChecked(fs.readFileSync(man, 'utf8'), '## Publishing\n\n', '## Publishing\n\n- [x] Secret/Plot.md\n'));
}

// A scratch campaign on one layout, with Secret/Plot.md present but not mapped.
function makeCampaign(root, layout) {
  let vault;
  if (layout === 'new') {
    vault = moveVaultCopy(SAMPLE, root, { inVaultPack: true }).vaultPath;
    assertMovedLayout(vault);
  } else {
    vault = path.join(root, 'vault');
    fs.cpSync(SAMPLE, vault, { recursive: true });
  }
  addSecretNote(vault);
  const cfg = path.join(root, 'config.toml');
  fs.writeFileSync(
    cfg,
    `config_version = 1\ndefault_campaign = "s"\n\n[campaigns.s]\nvault = ${JSON.stringify(vault)}\noutput = ${JSON.stringify(path.join(root, 'out'))}\npack = ${JSON.stringify(path.join(vault, '_meta', 'scriptorium'))}\n`,
  );
  const ctxInfo = resolveCampaignContext({ config: cfg }, 's');
  return { vault, ctx: { vaultPath: resolveVaultSite(ctxInfo).vaultPath, ctxInfo } };
}

// The settings file's bytes with Secret mapped, and the file's vault-relative name.
function candidateMappingSecret(vault, layout) {
  if (layout === 'new') {
    const text = fs.readFileSync(path.join(vault, '_meta', 'vault-config.yaml'), 'utf8');
    return { targetRel: '_meta/vault-config.yaml', bytes: Buffer.from(replaceChecked(text, '  folder_map:\n', '  folder_map:\n    Secret: secret\n')) };
  }
  // The markdown file's map replaces the pack's (no per-key merge), so it carries the whole map.
  const map = { ...packMapOf(vault), Secret: 'secret' };
  const block = '  folder_map:\n' + Object.entries(map).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}\n`).join('');
  const text = fs.readFileSync(path.join(vault, '_meta', 'vault-config.md'), 'utf8');
  return { targetRel: '_meta/vault-config.md', bytes: Buffer.from(replaceChecked(text, 'publish:\n', 'publish:\n' + block)) };
}

function inScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-review-pubdiff-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const layout of ['legacy', 'new']) {
  test(`${layout}: mapping a new folder names the page that would newly publish, and the folder`, () => {
    inScratch((root) => {
      const { vault, ctx } = makeCampaign(root, layout);
      const { targetRel, bytes } = candidateMappingSecret(vault, layout);
      const rv = candidatecheck.runReview(ctx, { candidateBytes: bytes, withCheck: true, targetRel });
      assert.deepEqual(rv.publishDiff.newlyPublished, [{ rel: 'Secret/Plot.md', title: 'Plot' }]);
      assert.deepEqual(rv.publishDiff.foldersAdded, [{ folder: 'Secret', output: 'secret' }]);
      assert.deepEqual(rv.publishDiff.foldersRemoved, []);
      assert.equal(rv.check.ran, true);
      assert.equal(rv.check.newFindings.filter((f) => f.id === 'leak/l4-hidden-name' && f.path === 'Secret/Plot.md').length, 1);
    });
  });

  test(`${layout}: without the check (the live effects route), there is no publish comparison`, () => {
    inScratch((root) => {
      const { vault, ctx } = makeCampaign(root, layout);
      const { targetRel, bytes } = candidateMappingSecret(vault, layout);
      const rv = candidatecheck.runReview(ctx, { candidateBytes: bytes, withCheck: false, targetRel });
      assert.equal(rv.publishDiff, null);
    });
  });

  test(`${layout}: control, the file as it is now publishes nothing new and maps no new folder`, () => {
    inScratch((root) => {
      const { vault, ctx } = makeCampaign(root, layout);
      const targetRel = layout === 'new' ? '_meta/vault-config.yaml' : '_meta/vault-config.md';
      const bytes = fs.readFileSync(path.join(vault, targetRel));
      const rv = candidatecheck.runReview(ctx, { candidateBytes: bytes, withCheck: true, targetRel });
      assert.deepEqual(rv.publishDiff, { newlyPublished: [], foldersAdded: [], foldersRemoved: [] });
    });
  });
}

// A side that cannot be resolved leaves no comparison. Reached here by making the candidate side's
// scan throw; the check itself scans through its own copy of the function, so it still runs.
test('legacy: a publish set that cannot be computed gives no publish comparison', () => {
  inScratch((root) => {
    const { vault, ctx } = makeCampaign(root, 'legacy');
    const { targetRel, bytes } = candidateMappingSecret(vault, 'legacy');
    const original = publishset.computePublishedSet;
    let calls = 0;
    publishset.computePublishedSet = (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('injected: the candidate side cannot be read');
      return original(...args);
    };
    try {
      const rv = candidatecheck.runReview(ctx, { candidateBytes: bytes, withCheck: true, targetRel });
      assert.equal(calls, 2);
      assert.equal(rv.publishDiff, null);
      assert.equal(rv.check.ran, true);
      assert.equal(rv.publishDiffReason, 'injected: the candidate side cannot be read');
    } finally {
      publishset.computePublishedSet = original;
    }
  });
});

// Through the panel: on the old layout, mapping a new folder in vault-config.md now needs the tick.
test('legacy, through the panel: mapping a new folder needs the tick and names the page and the folder', async (t) => {
  const root = scratchRoot(t);
  const { vault } = makeCampaign(root, 'legacy');
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = ${JSON.stringify(vault)}`, `output = ${JSON.stringify(path.join(root, 'out'))}`, ''].join('\n'));
  const current = fs.readFileSync(path.join(vault, '_meta', 'vault-config.md'));
  const { bytes } = candidateMappingSecret(vault, 'legacy');
  const frontmatterText = vaultconfigedit.splitFile(bytes).frontmatterText;
  const baseSha256 = crypto.createHash('sha256').update(current).digest('hex');

  const h = await startPanel(t, { config: configPath }, 'lease');
  const dry = await post(h, '/api/vault-config/text', { frontmatterText, baseSha256, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.needsAck, true);
  assert.ok(dry.json.reasons.includes('privacy'), JSON.stringify(dry.json.reasons));
  const lines = dry.json.effects.filter((e) => e.id === 'published-more' || e.id === 'folder-map-added').map((e) => [e.id, e.level, e.path, e.title, e.detail]);
  assert.deepEqual(lines, [
    ['published-more', 'bad', null, '1 page would be published that is not today', 'Secret/Plot.md'],
    ['folder-map-added', 'info', 'publish.folder_map', 'Publishes the folder Secret as /secret/', ''],
  ]);

  const confirm = await post(h, '/api/vault-config/text', { frontmatterText, baseSha256, dryRun: false, reviewedSha256: dry.json.candidateSha256 });
  assert.equal(confirm.status, 422, confirm.text);
  assert.equal(confirm.json.error, 'needs-ack');
  assert.deepEqual(fs.readFileSync(path.join(vault, '_meta', 'vault-config.md')), current);
});

// Through the panel: a review that could not compare the publish sets fails closed. The scan throws
// only while the candidate overlay is active, so the injection does not depend on call order; the
// check scans through its own copy of the function, so the check itself still runs.
test('legacy, through the panel: no publish comparison counts as the check not having run, and needs the tick', async (t) => {
  const root = scratchRoot(t);
  const { vault } = makeCampaign(root, 'legacy');
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = ${JSON.stringify(vault)}`, `output = ${JSON.stringify(path.join(root, 'out'))}`, ''].join('\n'));
  const mdPath = path.join(vault, '_meta', 'vault-config.md');
  const current = fs.readFileSync(mdPath);
  // A harmless edit, so nothing else asks for the tick.
  const bytes = Buffer.from(replaceChecked(current.toString('utf8'), '    max_npcs: 8\n', '    max_npcs: 7\n'));
  const frontmatterText = vaultconfigedit.splitFile(bytes).frontmatterText;
  const baseSha256 = crypto.createHash('sha256').update(current).digest('hex');

  const originalScan = publishset.computePublishedSet;
  const originalOverlay = read.withCandidateFile;
  let underOverlay = false;
  let injected = 0;
  read.withCandidateFile = (absPath, b, fn) =>
    originalOverlay(absPath, b, () => {
      underOverlay = true;
      try {
        return fn();
      } finally {
        underOverlay = false;
      }
    });
  publishset.computePublishedSet = (...args) => {
    if (underOverlay) {
      injected += 1;
      throw new Error('injected: the candidate side cannot be read');
    }
    return originalScan(...args);
  };
  t.after(() => {
    publishset.computePublishedSet = originalScan;
    read.withCandidateFile = originalOverlay;
  });

  const h = await startPanel(t, { config: configPath }, 'lease');
  const dry = await post(h, '/api/vault-config/text', { frontmatterText, baseSha256, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.ok(injected >= 1, 'the candidate-side scan was reached');
  assert.equal(dry.json.check.ran, true);
  assert.deepEqual(dry.json.reasons, ['check-did-not-run']);
  assert.equal(dry.json.needsAck, true);
  assert.ok(
    dry.json.notes.includes('The page comparison could not run (injected: the candidate side cannot be read), so this save needs your tick.'),
    JSON.stringify(dry.json.notes),
  );

  const confirm = await post(h, '/api/vault-config/text', { frontmatterText, baseSha256, dryRun: false, reviewedSha256: dry.json.candidateSha256 });
  assert.equal(confirm.status, 422, confirm.text);
  assert.equal(confirm.json.error, 'needs-ack');
  assert.deepEqual(fs.readFileSync(mdPath), current);
});
