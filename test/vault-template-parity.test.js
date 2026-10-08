'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const template = require('../src/setup/template');
const { validateStarterTitle } = require('../src/setup/validate');
const { FIXTURE_DIR, EXPECTED_DIR, OWN_FILES, sha, walkFiles } = require('./helpers/vault-template-fixture');

/*
 * Byte parity (docs/decisions/0048-new-campaign-vault.md, section 3). For each parity vector the
 * render, with the declared deviations reversed, must equal the output the scaffold gave, file for
 * file and byte for byte. Today the "scaffold output" is the hand-written tree under
 * test/fixtures/vault-template-expected. Those files were written by hand and are NOT derived from
 * the template files, the manifest or src/setup/template.js. When the real starter is pinned, the
 * vectors carry the scaffold's own sha256 values instead.
 *
 * Passes today and proves nothing about the real scaffold: this whole file, because the fixture
 * is not upstream. It proves the renderer against our own expectation, which is still worth
 * having (whitespace collapse, the local date, single-pass substitution, the one deviation).
 */

const tpl = template.loadTemplate({ dir: FIXTURE_DIR });

/** Reverses the declared deviations on one rendered file; each "to" must occur exactly once. */
function reverse(rel, text) {
  let out = text;
  for (const dev of tpl.manifest.deviations) {
    if (dev.file !== rel) continue;
    assert.equal(out.split(dev.to).length - 1, 1, `${rel}: the deviation text occurs exactly once`);
    out = out.replace(dev.to, () => dev.from);
  }
  return out;
}

test('the fixture has one hand-written parity vector per system, with a title that needs normalising', () => {
  const vectors = tpl.manifest.parity;
  assert.deepEqual(vectors.map((v) => v.system).sort(), ['dnd-5e-2024', 'none']);
  for (const v of vectors) {
    assert.equal(v.name, 'Qzx  Echo Ünï:  #1 ---');
    assert.equal(v.campaign, 'Qzx Echo Ünï: #1 ---');
    assert.equal(v.created, '2034-11-29');
  }
});

for (const vector of tpl.manifest.parity) {
  test(`parity: ${vector.system} renders to the expected tree, byte for byte, once the deviation is reversed`, () => {
    const title = validateStarterTitle(vector.name);
    assert.equal(title, 'Qzx Echo Ünï: #1 ---', 'the hand-typed expectation');
    const out = template.renderStarter(tpl, { system: vector.system, title, created: vector.created });

    const expectedDir = path.join(EXPECTED_DIR, vector.system);
    const expectedRels = walkFiles(expectedDir);
    const upstreamRels = out.files.map((f) => f.rel).filter((rel) => !OWN_FILES.has(rel)).sort();
    assert.deepEqual(upstreamRels, expectedRels, 'the same set of files');

    for (const file of out.files) {
      if (OWN_FILES.has(file.rel)) continue;
      const expected = fs.readFileSync(path.join(expectedDir, ...file.rel.split('/')));
      const got = Buffer.from(reverse(file.rel, file.data.toString('utf8')), 'utf8');
      assert.equal(got.equals(expected), true, `${file.rel} differs from the expected tree`);
    }
  });

  test(`parity: the manifest's recorded vector for ${vector.system} agrees with the hand-written tree`, () => {
    const expectedDir = path.join(EXPECTED_DIR, vector.system);
    const recorded = {};
    for (const rel of walkFiles(expectedDir)) recorded[rel] = sha(fs.readFileSync(path.join(expectedDir, ...rel.split('/'))));
    assert.deepEqual(vector.files, recorded);
  });
}

test('parity: the three files this program writes itself are never in a parity vector', () => {
  for (const v of tpl.manifest.parity) for (const rel of OWN_FILES) assert.equal(rel in v.files, false, rel);
  for (const id of ['none', 'dnd-5e-2024']) {
    const own = Object.entries(tpl.manifest.systems[id].files).filter(([, e]) => e.origin === 'scriptorium').map(([rel]) => rel).sort();
    assert.deepEqual(own, ['_Campaign/Welcome.md', '_meta/NOTICE.txt', '_meta/publish-manifest.md']);
  }
});

test('parity: the one declared deviation is site off to site on in the vault settings, and nothing else differs', () => {
  assert.deepEqual(tpl.manifest.deviations.map((d) => [d.file, d.from, d.to]), [['_meta/vault-config.md', '  site: false', '  site: true']]);
  const out = template.renderStarter(tpl, { system: 'none', title: 'Qzx Echo Ünï: #1 ---', created: '2034-11-29' });
  const settings = out.files.find((f) => f.rel === '_meta/vault-config.md').data.toString('utf8');
  const expected = fs.readFileSync(path.join(EXPECTED_DIR, 'none', '_meta', 'vault-config.md'), 'utf8');
  assert.equal(settings, expected.replace('  site: false', '  site: true'));
});
