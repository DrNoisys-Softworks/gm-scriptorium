'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { buildNoticesText } = require('../scripts/generate-notices');

/*
 * Section 8 of THIRD-PARTY-NOTICES.txt: the new-campaign starter (docs/decisions/0048-new-campaign-vault.md,
 * section 4). The expected facts are written out by hand from the pin record.
 */

const LICENSE_FILE = path.join(__dirname, '..', 'scripts', 'vendor', 'gm-apprentice-LICENSE-CC-BY-SA-4.0.txt');

test('the vendored CC BY-SA 4.0 text is upstream\'s LICENSE at the pinned commit, byte for byte', () => {
  // sha256 of upstream's LICENSE at a0215b1f2e688c476e37d372fd647935360f00b8, taken from a fresh clone
  const hash = crypto.createHash('sha256').update(fs.readFileSync(LICENSE_FILE)).digest('hex');
  assert.equal(hash, '28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5');
});

test('Section 8 comes after Section 7 and names upstream, the commit, the author, the licence and its URI', () => {
  const text = buildNoticesText();
  const s7 = text.indexOf('SECTION 7: ');
  const s8 = text.indexOf('SECTION 8: THE STARTER FOR NEW VAULTS');
  assert.ok(s7 > 0 && s8 > s7);
  const section = text.slice(s8);
  for (const needle of [
    'https://github.com/AntTheLimey/gm-apprentice',
    'a0215b1f2e688c476e37d372fd647935360f00b8',
    '1.10.37',
    'AntTheLimey',
    'CC-BY-SA-4.0',
    'https://creativecommons.org/licenses/by-sa/4.0/legalcode',
    'skills/shared/scripts/vault_scaffold.py',
    '  site: false',
    '  site: true',
  ]) {
    assert.equal(section.includes(needle), true, needle);
  }
  assert.equal(section.includes(fs.readFileSync(LICENSE_FILE, 'utf8').trim()), true, 'the whole licence text is included');
});

test('Section 8 lists every starter file with its sha256 once, and says which three are not upstream\'s', () => {
  const text = buildNoticesText();
  const section = text.slice(text.indexOf('SECTION 8: THE STARTER FOR NEW VAULTS'));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'vault-template', 'manifest.json'), 'utf8'));
  const stored = new Map();
  for (const s of Object.values(manifest.systems)) for (const e of Object.values(s.files)) stored.set(e.store, e);
  assert.equal(stored.size, 42);
  for (const [store, e] of stored) assert.equal(section.includes(`${store} (sha256 ${e.sha256})`), true, store);
  for (const rel of ['_meta/publish-manifest.md', '_Campaign/Welcome.md', '_meta/NOTICE.txt']) assert.equal(section.includes(rel), true, rel);
});
