'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withScratch, run } = require('./helpers/b4-cli');
const { moveVaultCopy, assertMovedLayout } = require('./helpers/moved-vault');
// Test-only: the pin's own settings writer, to give the yaml a value the vault already holds.
const { applyChanges } = require('gm-apprentice-publish/lib/settings/write');

/*
 * Each carry rule, proved on the built site (ADR 0071). A fixture is a copy of test/fixtures/mini-vault
 * with its broken pages taken out (so a clean check is possible) and a few pages added that hold one
 * marker text each. The pin's own move has run on it WITHOUT folding the pack in, so the pack at
 * _meta/scriptorium/vault.config.json still holds settings the yaml lacks. Every case then builds
 * through the real command line and greps every file of the output for the marker, before the carry
 * and after it. The marker texts and the expected exit codes are literals.
 */

const MINI = path.join(__dirname, 'fixtures', 'mini-vault');

const SECTION_MARKER = 'ZQ-SECTION-MARKER-4471';
const FOLDER_MARKER = 'ZQ-FOLDER-MARKER-4472';
const CALLOUT_MARKER = 'ZQ-CALLOUT-MARKER-4473';

const MANIFEST = [
  '---',
  'type: meta',
  '---',
  '',
  '# Publish manifest',
  '',
  '## Publishing',
  '',
  '- [x] Locations/Town-Square.md',
  '- [x] Locations/Old-Mill.md',
  '- [x] Recaps/session-01.md',
  '- [x] NPCs/Alice.md',
  '- [x] Secrets/Hidden.md',
  '',
].join('\n');

const page = (type, title, body) => `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}\n`;

/**
 * Builds a moved fixture: returns { vault, site, root }. `pack` is merged over the base pack, and
 * `yaml` is a list of the pin writer's changes applied to the yaml after the move.
 */
function fixture(root, { pack = {}, yaml = [], vaultMap = true } = {}) {
  const src = path.join(root, 'src');
  fs.cpSync(MINI, src, { recursive: true });
  // The fixture's own broken pages and ambiguous names would fail every check; none of them matter here.
  fs.rmSync(path.join(src, 'Characters'), { recursive: true });
  fs.rmSync(path.join(src, 'Locations', 'Ambiguous-Beta.md'));
  fs.mkdirSync(path.join(src, 'NPCs'));
  fs.mkdirSync(path.join(src, 'Secrets'));
  fs.writeFileSync(path.join(src, 'NPCs', 'Alice.md'), page('npc', 'Alice', 'Runs the general store.'));
  fs.writeFileSync(path.join(src, 'Secrets', 'Hidden.md'), page('location', 'Hidden Room', FOLDER_MARKER));
  fs.writeFileSync(
    path.join(src, 'Locations', 'Town-Square.md'),
    page('location', 'Town Square', `The heart of the settlement.\n\n## Pack Secret\n\n${SECTION_MARKER}\n\n> [!gm]\n> ${CALLOUT_MARKER}`),
  );
  fs.writeFileSync(path.join(src, '_meta', 'publish-manifest.md'), MANIFEST);
  const baseFolderMap = { Locations: 'locations', Recaps: 'sessions', NPCs: 'npcs', Secrets: 'secrets' };
  const packDir = path.join(src, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'vault.config.json'),
    JSON.stringify({ siteUrl: 'https://example.invalid', excludeDirs: ['_meta', '_Templates'], folderMap: baseFolderMap, ...pack }, null, 2),
  );
  const { vaultPath } = moveVaultCopy(src, root); // no site config given: the pack is NOT folded in
  assertMovedLayout(vaultPath);
  // Without a folder map in the yaml nothing is published at all (the build no longer reads the pack's),
  // so the cases that are about something else give the yaml the same map the pack has.
  const changes = vaultMap ? [{ op: 'set', name: 'player_site.folder_map', value: baseFolderMap }, ...yaml] : yaml;
  if (changes.length) applyChanges(vaultPath, changes);
  const site = path.join(root, 'site');
  fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${vaultPath}'\noutput = '${site}'\n`);
  return { vault: vaultPath, site, root };
}

/** Every file under `dir`, as relative paths. */
function filesUnder(dir) {
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else found.push(path.relative(dir, full));
    }
  })(dir);
  return found.sort();
}

/** The output files that contain `marker`, anywhere in their bytes. */
function filesHolding(dir, marker) {
  return filesUnder(dir).filter((f) => fs.readFileSync(path.join(dir, f)).includes(Buffer.from(marker)));
}

const packOf = (vault) => path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
const readPack = (vault) => JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));

/**
 * The three states of a hide rule: before the carry (check and build refuse, and so does a build with
 * --force-check, with exit 3: ADR 0071, section 12), then after it (clean, and the marker is in no output file).
 */
function assertHideRule({ root, site, vault }, marker, packKey) {
  const finding = `${packKey} in the pack hides more than the vault's settings do`;
  const checked = run(root, ['check']);
  assert.equal(checked.code, 2, checked.all);
  assert.ok(checked.out.includes(`ERROR config/pack-hiding-not-carried  ${finding}`), checked.out);

  const refused = run(root, ['build']);
  assert.equal(refused.code, 2, refused.all);
  assert.ok(!fs.existsSync(site), 'a refused build must write nothing');

  const forced = run(root, ['build', '--force-check']);
  assert.equal(forced.code, 3, forced.all);
  assert.match(forced.all, new RegExp(`still holds settings that _meta/vault-config\\.yaml does not, and the build no longer reads them there: ${packKey} \\(`));
  assert.ok(!fs.existsSync(site), `--force-check does not publish ${marker} either: nothing is written`);

  const carried = run(root, ['carry', '--yes']);
  assert.equal(carried.code, 0, carried.all);
  assert.ok(!(packKey in readPack(vault)), `the carry takes ${packKey} out of the pack`);

  // The forced build's output is still there, and check reads an existing output for leaks: clear it.
  fs.rmSync(site, { recursive: true, force: true });
  const after = run(root, ['check']);
  assert.equal(after.code, 0, after.all);
  const built = run(root, ['build']);
  assert.equal(built.code, 0, built.all);
  assert.ok(filesUnder(site).length > 0, 'the build wrote a site');
  assert.deepEqual(filesHolding(site, marker), [], `${marker} must be in no output file after the carry`);
}

test('section entry: the pack hides "Pack Secret"; refused before the carry, absent from every file after it', () => {
  withScratch((root) => {
    const f = fixture(root, { pack: { excludeSections: ['GM Notes', 'Pack Secret'] } });
    assertHideRule(f, SECTION_MARKER, 'excludeSections');
  });
});

test('folder entry: the pack hides "Secrets/"; refused before the carry, absent from every file after it', () => {
  withScratch((root) => {
    const f = fixture(root, { pack: { excludeDirs: ['_meta', '_Templates', 'Secrets/'] } });
    assertHideRule(f, FOLDER_MARKER, 'excludeDirs');
  });
});

test('stricter callouts: the pack hides the gm callout, the vault none; the marker is gone after the carry', () => {
  withScratch((root) => {
    const f = fixture(root, { pack: { excludeCallouts: ['gm'] } });
    const checked = run(root, ['check']);
    assert.equal(checked.code, 2, checked.all);
    assert.ok(checked.out.includes('ERROR config/pack-hiding-not-carried  excludeCallouts in the pack hides more than the vault\'s settings do'), checked.out);
    assert.equal(run(root, ['build']).code, 2);
    const forced = run(root, ['build', '--force-check']);
    assert.equal(forced.code, 3, forced.all);
    assert.ok(forced.all.includes('the build no longer reads them there: excludeCallouts ("gm").'), forced.all);
    assert.ok(!fs.existsSync(f.site), 'before the carry the gm callout is not published: nothing is written');

    assert.equal(run(root, ['carry', '--yes']).code, 0);
    assert.ok(!('excludeCallouts' in readPack(f.vault)));
    fs.rmSync(f.site, { recursive: true, force: true });
    assert.equal(run(root, ['check']).code, 0);
    assert.equal(run(root, ['build']).code, 0);
    assert.deepEqual(filesHolding(f.site, CALLOUT_MARKER), []);
    // Only the callout went: the page itself, and its other text, are still published.
    assert.notDeepEqual(filesHolding(f.site, 'The heart of the settlement.'), []);
  });
});

test('vault value wins: the yaml title "Vault Title" shows before and after the carry, and the pack loses its title', () => {
  withScratch((root) => {
    const f = fixture(root, { pack: { siteTitle: 'Pack Title' }, yaml: [{ op: 'set', name: 'player_site.title', value: 'Vault Title' }] });
    const forced = run(root, ['build', '--force-check']);
    assert.equal(forced.code, 0, forced.all);
    const before = fs.readFileSync(path.join(f.site, 'index.html'), 'utf8');
    assert.ok(before.includes('Vault Title'));
    assert.ok(!before.includes('Pack Title'));
    assert.deepEqual(filesHolding(f.site, 'Pack Title'), [], 'before the carry the pack title is in no output file');

    const carried = run(root, ['carry', '--yes']);
    assert.equal(carried.code, 0, carried.all);
    assert.ok(!('siteTitle' in readPack(f.vault)));
    fs.rmSync(f.site, { recursive: true, force: true });
    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    const built = run(root, ['build']);
    assert.equal(built.code, 0, built.all);
    const after = fs.readFileSync(path.join(f.site, 'index.html'), 'utf8');
    assert.ok(after.includes('Vault Title'));
    assert.deepEqual(filesHolding(f.site, 'Pack Title'), []);
  });
});

test('a key the vault lacks: the pack folder map puts NPCs at "people"; the build reads it only after the carry', () => {
  withScratch((root) => {
    // The yaml has no folder map. Before the carry the build reads no map at all (the pack's is not read),
    // so Alice's page is not published anywhere; the pack's map would have put her under npcs/ or people/.
    const f = fixture(root, { vaultMap: false, pack: { folderMap: { Locations: 'locations', Recaps: 'sessions', NPCs: 'people' } } });
    const checked = run(root, ['check']);
    // A map only the pack holds would publish a near-empty site over the players' one, so it is an error.
    assert.equal(checked.code, 2, checked.all);
    assert.ok(checked.out.includes('ERROR config/folder-map-not-carried'), checked.out);
    assert.ok(!checked.out.includes('config/pack-setting-not-carried  folderMap'), checked.out);
    const plain = run(root, ['build']);
    assert.equal(plain.code, 2, plain.all);
    assert.ok(!fs.existsSync(f.site), 'a refused build must write nothing');
    const forced = run(root, ['build', '--force-check']);
    assert.equal(forced.code, 3, forced.all);
    assert.ok(forced.all.includes('the build no longer reads them there: folderMap. Run "gm-scriptorium carry t"'), forced.all);
    assert.ok(!fs.existsSync(f.site), 'a near-empty site is not published over the players\' one: nothing is written');

    const carried = run(root, ['carry', '--yes']);
    assert.equal(carried.code, 0, carried.all);
    assert.ok(!('folderMap' in readPack(f.vault)));
    fs.rmSync(f.site, { recursive: true, force: true });
    const after = run(root, ['check']);
    assert.ok(!after.out.includes('config/folder-map-not-carried  '), after.out);
    const built = run(root, ['build']);
    assert.equal(built.code, 0, built.all);
    assert.deepEqual(filesUnder(f.site).filter((p) => /alice/i.test(p)), ['people/alice.html']);
    assert.deepEqual(filesHolding(f.site, 'Runs the general store.').filter((p) => p.startsWith('npcs/')), []);
  });
});
