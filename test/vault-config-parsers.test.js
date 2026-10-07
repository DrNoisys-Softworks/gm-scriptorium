'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pinned = require('../src/generator/pinned');
const read = require('../src/vault/read');

/*
 * V1e-1 (ADR 0033, SD-5). The identity test is the whole point of the two-parser guard: as long
 * as it is green, pinned.generatorGrayMatter really is the SAME resolved module the pin's own
 * lib/config.js would use, so src/admin/vaultconfigedit.js's "both parsers agree" semantic guard
 * is comparing against the real thing.
 *
 * R1 repin (2026-09-30): the predicted moment arrived. At `78696167` gray-matter is bundled
 * (SD-17's lunr precedent), pinned.js's literal was repointed to the bundled path, and this file's
 * own second test is rewritten below (not merely left red) to record the new fact it now proves:
 * the generator's gray-matter and Scriptorium's own hoisted one are two separate resolved
 * modules from here on, at the same npm version (4.0.3) but never the same object. That is exactly
 * why src/admin/vaultconfigedit.js's "both parsers agree" check is no longer vacuous -- two real,
 * independently-resolved parsers can now genuinely diverge, and only content-level agreement
 * (proven below, and by test/admin-vault-config-edit.test.js) stands behind that guard, not
 * identity.
 */

test('identity: pinned.generatorGrayMatter is exactly the gray-matter the pin itself would resolve from lib/config.js', () => {
  const pinDir = path.dirname(require.resolve('gm-apprentice-publish/lib/config.js'));
  const resolved = require.resolve('gray-matter', { paths: [pinDir] });
  assert.equal(pinned.generatorGrayMatter, require(resolved));
});

test('identity: pinned.generatorGrayMatter is NOT Scriptorium\'s own top-level gray-matter (M22-shaped negative control)', () => {
  // eslint-disable-next-line global-require
  const topLevel = require('gray-matter');
  assert.notEqual(pinned.generatorGrayMatter, topLevel);
});

test('at this pin, the generator\'s bundled gray-matter and Scriptorium\'s own hoisted gray-matter are two separate resolved modules at the same version (a fact this slice records, not creates)', () => {
  // eslint-disable-next-line global-require
  const topLevel = require('gray-matter');
  const topLevelPkg = require('gray-matter/package.json');
  // eslint-disable-next-line global-require
  const pinDir = path.dirname(require.resolve('gm-apprentice-publish/lib/config.js'));
  const bundledPkgPath = require.resolve('gray-matter/package.json', { paths: [pinDir] });
  const bundledPkg = require(bundledPkgPath);
  assert.notEqual(pinned.generatorGrayMatter, topLevel);
  assert.equal(bundledPkg.version, topLevelPkg.version, 'expected the two copies to still be the same published version, just not the same resolved module');
});

test('parseFrontmatterText deep-equals readFrontmatter on every fixture vault\'s _meta/vault-config.md', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');
  const vaults = fs.readdirSync(fixturesDir).filter((name) => fs.existsSync(path.join(fixturesDir, name, '_meta', 'vault-config.md')));
  assert.ok(vaults.length > 0, 'expected at least one fixture vault with a vault-config.md');

  for (const vault of vaults) {
    const mdPath = path.join(fixturesDir, vault, '_meta', 'vault-config.md');
    const raw = fs.readFileSync(mdPath, 'utf8');
    const viaFile = read.readFrontmatter(mdPath);
    const viaText = read.parseFrontmatterText(raw);
    assert.equal(viaText.ok, viaFile.ok, vault);
    if (viaFile.ok) {
      assert.deepEqual(viaText.data, viaFile.data, vault);
      assert.equal(viaText.content, viaFile.content, vault);
    }
  }
});

test('parseFrontmatterText returns { ok: false, error } for invalid frontmatter, never throwing', () => {
  const result = read.parseFrontmatterText('---\n[bad yaml\n---\nbody\n');
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof Error);
});

test('parseFrontmatterText bypasses gray-matter\'s content-keyed cache: a string that already threw once still throws again, never silently serving the pre-parse placeholder', () => {
  const bad = '---\n[bad yaml\n---\nbody\n';
  const first = read.parseFrontmatterText(bad);
  const second = read.parseFrontmatterText(bad);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false, 'gray-matter\'s cache must not serve an unparsed placeholder as a success on the second call');
});
