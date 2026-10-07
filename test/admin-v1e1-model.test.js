'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ST } = require(path.join(__dirname, '..', 'assets', 'admin', 'store.js'));
const { SL } = require(path.join(__dirname, '..', 'assets', 'admin', 'slip.js'));
const { NV } = require(path.join(__dirname, '..', 'assets', 'admin', 'nav.js'));

/*
 * V1e-1 (SD-7). Pure model tests, loaded via require() (the VB pattern). Independent literals
 * throughout -- none of the expected values below are derived from the code under test.
 */

const VALID_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const THIRD_SHA = 'c'.repeat(64);

// === ST.fileShas: 3-key and 2-key =============================================================

test('ST.fileShas: with a vaultConfigFile key present, the result carries all three files', () => {
  const body = {
    packToml: { exists: true, sha256: VALID_SHA },
    vaultConfigJson: { exists: true, sha256: OTHER_SHA },
    vaultConfigFile: { exists: true, sha256: THIRD_SHA },
  };
  assert.deepEqual(ST.fileShas(body), { 'pack.toml': VALID_SHA, 'vault.config.json': OTHER_SHA, 'vault-config.md': THIRD_SHA });
});

test('ST.fileShas: with no vaultConfigFile key at all, the result stays exactly the 2-key literal (admin-store-v1b.test.js stays green unedited)', () => {
  const body = { packToml: { exists: true, sha256: VALID_SHA }, vaultConfigJson: { exists: true, sha256: OTHER_SHA } };
  assert.deepEqual(ST.fileShas(body), { 'pack.toml': VALID_SHA, 'vault.config.json': OTHER_SHA });
});

test('ST.fileShas: vaultConfigFile present but exists:false gives null for vault-config.md', () => {
  const body = { vaultConfigFile: { exists: false, sha256: null } };
  assert.deepEqual(ST.fileShas(body)['vault-config.md'], null);
});

// === ST.applySaveResult: vault-config.md exact equality (E24) ================================

test('ST.applySaveResult accepts vault-config.md by exact equality', () => {
  const files = { 'pack.toml': VALID_SHA };
  const next = ST.applySaveResult(files, { ok: true, file: 'vault-config.md', sha256: THIRD_SHA });
  assert.equal(next['vault-config.md'], THIRD_SHA);
});

test('ST.applySaveResult refuses ../vault-config.md, vault-config.mdx and _meta/vault-config.md (E24: no startsWith/indexOf)', () => {
  const files = {};
  for (const badName of ['../vault-config.md', 'vault-config.mdx', '_meta/vault-config.md']) {
    const next = ST.applySaveResult(files, { ok: true, file: badName, sha256: THIRD_SHA });
    assert.deepEqual(next, {}, badName);
  }
});

// === SL: tagline rows and effects =============================================================

test("SL.buildSlip (kind: 'tagline'): one row when the value differs, none when it matches", () => {
  const state = { vaultConfigFile: { tagline: 'Old' } };
  const changed = SL.buildSlip({
    kind: 'tagline',
    payload: { tagline: 'New' },
    state,
    dry: { ok: true, dryRun: true, file: 'vault-config.md', before: 'tagline: Old\n', after: 'tagline: "New"\n', backupDir: '/x/backups/campaign-a', warnings: [] },
  });
  assert.deepEqual(changed.rows, [{ where: 'vault-config.md', key: 'publish.theme.tagline', now: 'Old', nowNote: undefined, after: 'New', afterNote: undefined }]);

  const unchanged = SL.buildSlip({
    kind: 'tagline',
    payload: { tagline: 'Old' },
    state,
    dry: { ok: true, dryRun: true, file: 'vault-config.md', before: 'tagline: Old\n', after: 'tagline: Old\n', backupDir: '/x', warnings: [] },
  });
  assert.deepEqual(unchanged.rows, []);
});

test("SL.buildSlip (kind: 'tagline'): normalises null/undefined as '' for the row comparison", () => {
  const state = { vaultConfigFile: { tagline: null } };
  const slip = SL.buildSlip({
    kind: 'tagline',
    payload: { tagline: 'New' },
    state,
    dry: { ok: true, dryRun: true, file: 'vault-config.md', before: '', after: 'tagline: "New"\n', backupDir: '/x', warnings: [] },
  });
  assert.equal(slip.rows[0].now, '');
});

test("SL.buildSlip (kind: 'tagline'): always carries the backup and frontmatter-only info effects, naming the real backup dir", () => {
  const slip = SL.buildSlip({
    kind: 'tagline',
    payload: { tagline: 'New' },
    state: { vaultConfigFile: { tagline: 'Old' } },
    dry: { ok: true, dryRun: true, file: 'vault-config.md', before: 'x', after: 'y', backupDir: '/machine/backups/campaign-alpha', warnings: [] },
  });
  assert.ok(slip.effects.some((e) => e.id === 'backup' && e.text === 'vault-config.md is backed up first, to /machine/backups/campaign-alpha.'));
  assert.ok(slip.effects.some((e) => e.id === 'frontmatter-only' && e.text === 'Only the frontmatter is shown. The rest of the note is not changed.'));
});

test("SL.buildSlip (kind: 'tagline'): filePath and saveLabel name vault-config.md, outside _meta/scriptorium/", () => {
  const slip = SL.buildSlip({
    kind: 'tagline',
    payload: { tagline: 'New' },
    state: { vaultConfigFile: { tagline: 'Old' } },
    dry: { ok: true, dryRun: true, file: 'vault-config.md', before: 'x', after: 'y', backupDir: '/x', warnings: [] },
  });
  assert.equal(slip.filePath, '_meta/vault-config.md');
  assert.equal(slip.saveLabel, 'Back up and save vault-config.md');
});

test('SL.TITLES tagline is "Save tagline" (title of the tagline-only slip)', () => {
  const slip = SL.buildSlip({
    kind: 'tagline',
    payload: { tagline: 'New' },
    state: { vaultConfigFile: { tagline: 'Old' } },
    dry: { ok: true, dryRun: true, file: 'vault-config.md', before: 'x', after: 'y', backupDir: '/x', warnings: [] },
  });
  assert.equal(slip.title, 'Save tagline');
});

// === buildSettingsRows ignores a landingTagline payload (dead key, D-20) =======================

test('SL.buildSlip (kind: settings): a landingTagline key in the payload is silently ignored -- no row, ever', () => {
  const slip = SL.buildSlip({
    kind: 'settings',
    payload: { siteTitle: 'Same', landingTagline: 'anything at all' },
    state: { vaultConfigJson: { siteTitle: 'Same' } },
    dry: { ok: true, dryRun: true, file: 'vault.config.json', before: '{}', after: '{}', commentsLost: false, warnings: [] },
  });
  assert.deepEqual(slip.rows, []);
});

// === SL.buildCombined ==========================================================================

function taglinePart(tagline, now) {
  return {
    kind: 'tagline',
    payload: { tagline },
    dry: { ok: true, dryRun: true, file: 'vault-config.md', before: 'tagline: ' + now + '\n', after: 'tagline: "' + tagline + '"\n', backupDir: '/x/backups/campaign-a', warnings: [] },
  };
}

function settingsPart(siteTitle, now) {
  return {
    kind: 'settings',
    payload: { siteTitle },
    dry: { ok: true, dryRun: true, file: 'vault.config.json', before: '{"siteTitle":"' + now + '"}', after: '{"siteTitle":"' + siteTitle + '"}', commentsLost: false, warnings: [] },
  };
}

test('SL.buildCombined: one part gives a single-file review (saveLabel from that file, FOOT singular)', () => {
  const state = { vaultConfigFile: { tagline: 'Old' } };
  const combined = SL.buildCombined({ parts: [taglinePart('New', 'Old')], state });
  assert.equal(combined.title, 'Save title and tagline');
  assert.equal(combined.files.length, 1);
  assert.equal(combined.saveLabel, 'Back up and save vault-config.md');
  assert.match(combined.foot, /this one file/);
});

test('SL.buildCombined: two parts gives "Save both files" and the two-file foot text', () => {
  const state = { vaultConfigJson: { siteTitle: 'Old' }, vaultConfigFile: { tagline: 'Old' } };
  const combined = SL.buildCombined({ parts: [settingsPart('New', 'Old'), taglinePart('New', 'Old')], state });
  assert.equal(combined.files.length, 2);
  assert.equal(combined.saveLabel, 'Save both files');
  assert.match(combined.foot, /these two files/);
});

// === SL.postInOrder =============================================================================

test('SL.postInOrder: sequential, in order, and always attempts the SECOND request even after the first fails', () => {
  const calls = [];
  const post = (req) => {
    calls.push(req);
    if (req === 'a') return Promise.resolve({ ok: false, status: 409, body: { error: 'changed' } });
    return Promise.resolve({ ok: true, status: 200, body: { ok: true, file: req } });
  };
  return SL.postInOrder(['a', 'b'], post).then((results) => {
    assert.deepEqual(calls, ['a', 'b'], 'the second request must still be attempted after the first failed');
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, false);
    assert.equal(results[1].ok, true);
  });
});

test('SL.postInOrder: keeps request order in the results, even when the SECOND resolves before being awaited (still sequential)', () => {
  const order = [];
  const post = (req) =>
    new Promise((resolve) => {
      setTimeout(() => {
        order.push(req);
        resolve({ ok: true, status: 200, body: { file: req } });
      }, req === 'first' ? 20 : 0);
    });
  return SL.postInOrder(['first', 'second'], post).then((results) => {
    assert.deepEqual(order, ['first', 'second'], 'second must not start until first has resolved');
    assert.deepEqual(results.map((r) => r.body.file), ['first', 'second']);
  });
});

test('SL.postInOrder: a rejected post() is mapped to {ok:false, status:0, body:null}, not thrown', () => {
  const post = () => Promise.reject(new Error('network down'));
  return SL.postInOrder(['x'], post).then((results) => {
    assert.deepEqual(results, [{ ok: false, status: 0, body: null }]);
  });
});

// === SL.partSummary =============================================================================

function fakeMapOutcome(result) {
  if (result.ok && result.body && result.body.ok) return { kind: 'saved' };
  return { kind: 'changed', message: (result.body && result.body.message) || 'failed' };
}

test('SL.partSummary: allSaved true and one "<file> saved." line per part when every part saved', () => {
  const results = [
    { file: 'vault.config.json', ok: true, body: { ok: true } },
    { file: 'vault-config.md', ok: true, body: { ok: true } },
  ];
  const summary = SL.partSummary(results, fakeMapOutcome);
  assert.equal(summary.allSaved, true);
  assert.deepEqual(summary.lines, ['vault.config.json saved.', 'vault-config.md saved.']);
});

test('SL.partSummary: a failed part gives allSaved false and a "not saved: <message>" line', () => {
  const results = [
    { file: 'vault.config.json', ok: true, body: { ok: true } },
    { file: 'vault-config.md', ok: false, body: { message: 'vault-config.md changed outside the panel. Reload before saving.' } },
  ];
  const summary = SL.partSummary(results, fakeMapOutcome);
  assert.equal(summary.allSaved, false);
  assert.deepEqual(summary.lines, [
    'vault.config.json saved.',
    'vault-config.md not saved: vault-config.md changed outside the panel. Reload before saving.',
  ]);
});

// === NV title item eyebrow/lede (drift with the SL/store test above) ===========================

test('NV title item: eyebrow and lede name both files', () => {
  const item = NV.item('title');
  assert.equal(item.eyebrow, 'vault.config.json · vault-config.md');
  assert.match(item.lede, /vault\.config\.json/);
  assert.match(item.lede, /vault-config\.md/);
});

// === Structural: the Overview hero and the Title screen source ================================

test('structural: views.js reads the tagline from state.vaultConfigFile, never from vaultConfigJson.landingTagline', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'views.js'), 'utf8');
  assert.match(src, /state\.vaultConfigFile && state\.vaultConfigFile\.tagline/);
  assert.equal(/vcj\.landingTagline/.test(src), false, 'the hero must never read the dead landingTagline key');
});

test('structural: pack.js never sends landingTagline in any request body', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'pack.js'), 'utf8');
  assert.equal(/landingTagline:\s*taglineInput\.value/.test(src), false);
  // The dead-key display note is allowed to name the literal (D-20's read-only notice).
  assert.match(src, /landingTagline/);
});

test('structural: slip.js never writes a landingTagline row for a tagline-kind part', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'slip.js'), 'utf8');
  assert.equal(/buildTaglineRows[\s\S]{0,300}landingTagline/.test(src), false);
});

test('structural: slip.js\'s buildDone uses "are updated" for the plural (two-file) case, "is updated" for one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'slip.js'), 'utf8');
  assert.match(src, /plural \? ' are updated' : ' is updated'/);
  assert.match(src, /buildDone\(fileBase, \{ onBuildPreview: args\.onBuildPreview \}, combined\.files\.length > 1\)/);
});
