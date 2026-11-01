'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withScratch, run } = require('./helpers/b4-cli');
const { moveVaultCopy, assertMovedLayout, replaceYamlFolderMap } = require('./helpers/moved-vault');
// Test-only: the pin's own settings writer, to give the yaml the folder map (as a GM's yaml would have it).
const { applyChanges } = require('gm-apprentice-publish/lib/settings/write');

/*
 * Something only the campaign pack hides, built with the check skipped or forced, on both settings
 * layouts. On the old layout the build reads the pack, so what it hides stays hidden whatever the
 * flags. On the moved layout the generator no longer reads the pack's hide lists or folder map, and
 * the check that says so does not run under --no-check and is overridden by --force-check. The build
 * itself must refuse, with exit 3, and write nothing, until the GM runs the carry.
 *
 * Every case runs the real command line and greps every output file for a marker text. The markers,
 * the exit codes and the refusal line are literals.
 */

const MINI = path.join(__dirname, 'fixtures', 'mini-vault');
const SECTION_MARKER = 'ZQ-PACKONLY-SECTION-5521';
const FOLDER_MARKER = 'ZQ-PACKONLY-FOLDER-5522';
const PUBLIC_TEXT = 'Runs the general store.';
const FOLDER_MAP = { Locations: 'locations', Recaps: 'sessions', NPCs: 'npcs', Secrets: 'secrets' };

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
 * A copy of the mini vault with a pack that hides more than the vault's settings do. 'legacy' keeps
 * the old settings page; 'new' runs the pin's own move WITHOUT folding the pack in, so the pack still
 * holds what only it hides. `yamlMap` gives the moved yaml the folder map (a GM's moved vault has one).
 */
function fixture(root, layout, pack, { yamlMap = true } = {}) {
  const src = path.join(root, 'src');
  fs.cpSync(MINI, src, { recursive: true });
  fs.rmSync(path.join(src, 'Characters'), { recursive: true });
  fs.rmSync(path.join(src, 'Locations', 'Ambiguous-Beta.md'));
  fs.mkdirSync(path.join(src, 'NPCs'));
  fs.mkdirSync(path.join(src, 'Secrets'));
  fs.writeFileSync(path.join(src, 'NPCs', 'Alice.md'), page('npc', 'Alice', PUBLIC_TEXT));
  fs.writeFileSync(path.join(src, 'Secrets', 'Hidden.md'), page('location', 'Hidden Room', FOLDER_MARKER));
  fs.writeFileSync(
    path.join(src, 'Locations', 'Town-Square.md'),
    page('location', 'Town Square', `The heart of the settlement.\n\n## Pack Secret\n\n${SECTION_MARKER}`),
  );
  fs.writeFileSync(path.join(src, '_meta', 'publish-manifest.md'), MANIFEST);
  const packDir = path.join(src, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'vault.config.json'),
    JSON.stringify({ excludeDirs: ['_meta', '_Templates'], folderMap: FOLDER_MAP, ...pack }, null, 2),
  );
  let vault = fs.realpathSync.native(src);
  if (layout === 'new') {
    ({ vaultPath: vault } = moveVaultCopy(src, root));
    assertMovedLayout(vault);
    if (yamlMap) applyChanges(vault, [{ op: 'set', name: 'player_site.folder_map', value: FOLDER_MAP }]);
  } else {
    assert.ok(fs.existsSync(path.join(vault, '_meta', 'vault-config.md')), 'the legacy copy must keep its settings page');
    assert.ok(!fs.existsSync(path.join(vault, '_meta', 'vault-config.yaml')), 'the legacy copy must hold no vault-config.yaml');
  }
  const site = path.join(root, 'site');
  fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${vault}'\noutput = '${site}'\n`);
  return { vault, site, pack: path.join(vault, '_meta', 'scriptorium', 'vault.config.json') };
}

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

function filesHolding(dir, marker) {
  return filesUnder(dir).filter((f) => fs.readFileSync(path.join(dir, f)).includes(Buffer.from(marker)));
}

/** The one refusal line, typed out: the pack's path, the entries, and the carry command. */
const refusal = (packPath, entries) =>
  `campaign "t": ${packPath} still holds settings that _meta/vault-config.yaml does not, and the build no longer reads them there: ${entries}. ` +
  'Run "gm-scriptorium carry t" to move them into _meta/vault-config.yaml. Nothing was written.';

function assertRefused(res, f, entries) {
  assert.equal(res.code, 3, res.all);
  assert.ok(res.all.split('\n').includes(refusal(f.pack, entries)), res.all);
  assert.doesNotMatch(res.all, /\n\s+at .*\(|TypeError/, 'no stack trace');
  assert.ok(!fs.existsSync(f.site), 'a refused build writes nothing');
}

for (const flag of ['--no-check', '--force-check']) {
  test(`legacy, build ${flag}: a section only the pack hides stays out of every output file`, () => {
    withScratch((root) => {
      const f = fixture(root, 'legacy', { excludeSections: ['GM Notes', 'Pack Secret'] });
      const res = run(root, ['build', flag]);
      assert.equal(res.code, 0, res.all);
      assert.notDeepEqual(filesHolding(f.site, 'The heart of the settlement.'), [], 'the page itself is published');
      assert.deepEqual(filesHolding(f.site, SECTION_MARKER), []);
    });
  });

  test(`moved and not carried, build ${flag}: a section only the pack hides refuses the build with exit 3`, () => {
    withScratch((root) => {
      const f = fixture(root, 'new', { excludeSections: ['GM Notes', 'Pack Secret'] });
      assertRefused(run(root, ['build', flag]), f, 'excludeSections ("Pack Secret")');
    });
  });

  test(`legacy, build ${flag}: a folder only the pack hides stays out of every output file`, () => {
    withScratch((root) => {
      const f = fixture(root, 'legacy', { excludeDirs: ['_meta', '_Templates', 'Secrets/'] });
      const res = run(root, ['build', flag]);
      assert.equal(res.code, 0, res.all);
      assert.notDeepEqual(filesHolding(f.site, PUBLIC_TEXT), []);
      assert.deepEqual(filesHolding(f.site, FOLDER_MARKER), []);
    });
  });

  test(`moved and not carried, build ${flag}: a folder only the pack hides refuses the build with exit 3`, () => {
    withScratch((root) => {
      const f = fixture(root, 'new', { excludeDirs: ['_meta', '_Templates', 'Secrets/'] });
      assertRefused(run(root, ['build', flag]), f, 'excludeDirs ("Secrets/")');
    });
  });

  test(`legacy, build ${flag}: the pack's folder map is read, so the mapped page is published`, () => {
    withScratch((root) => {
      const f = fixture(root, 'legacy', {});
      const res = run(root, ['build', flag]);
      assert.equal(res.code, 0, res.all);
      assert.deepEqual(filesHolding(f.site, PUBLIC_TEXT).filter((p) => p.endsWith('.html')), ['npcs/alice.html']);
    });
  });

  test(`moved and not carried, build ${flag}: a folder map only the pack holds refuses the build with exit 3`, () => {
    withScratch((root) => {
      const f = fixture(root, 'new', {}, { yamlMap: false });
      assertRefused(run(root, ['build', flag]), f, 'folderMap');
    });
  });
}

test('moved and not carried, build --no-check: several entries are named on the one line', () => {
  withScratch((root) => {
    const f = fixture(root, 'new', { excludeSections: ['GM Notes', 'Pack Secret'], excludeDirs: ['_meta', '_Templates', 'Secrets/'] }, { yamlMap: false });
    assertRefused(run(root, ['build', '--no-check']), f, 'folderMap, excludeDirs ("Secrets/"), excludeSections ("Pack Secret")');
  });
});

test('moved and not carried, serve --build: the check step refuses first (exit 2), and nothing is written or served', () => {
  withScratch((root) => {
    // serve --build takes no --no-check or --force-check, so its build always runs the check, which
    // refuses before the build's own refusal is reached. Either way nothing is published.
    const f = fixture(root, 'new', { excludeSections: ['GM Notes', 'Pack Secret'] });
    const res = run(root, ['serve', '--build', '--port', '0']);
    assert.equal(res.code, 2, res.all);
    assert.match(res.all, /ERROR config\/pack-hiding-not-carried/);
    assert.ok(!fs.existsSync(f.site));
  });
});

test('moved, after the carry: build --no-check publishes and the section is in no output file', () => {
  withScratch((root) => {
    const f = fixture(root, 'new', { excludeSections: ['GM Notes', 'Pack Secret'] });
    assert.equal(run(root, ['carry', '--yes']).code, 0);
    const res = run(root, ['build', '--no-check']);
    assert.equal(res.code, 0, res.all);
    assert.notDeepEqual(filesHolding(f.site, 'The heart of the settlement.'), []);
    assert.deepEqual(filesHolding(f.site, SECTION_MARKER), []);
  });
});

test('a campaign whose site config is not the pack in the vault: the line says to move the settings by hand', () => {
  withScratch((root) => {
    const f = fixture(root, 'new', { excludeSections: ['GM Notes', 'Pack Secret'] });
    const outside = path.join(root, 'outside-site', 'vault.config.json');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.copyFileSync(f.pack, outside);
    fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${f.vault}'\noutput = '${f.site}'\nsite_config = '${outside}'\n`);
    const res = run(root, ['build', '--no-check']);
    assert.equal(res.code, 3, res.all);
    const line =
      `campaign "t": ${outside} still holds settings that _meta/vault-config.yaml does not, and the build no longer reads them there: excludeSections ("Pack Secret"). ` +
      'Move them into _meta/vault-config.yaml by hand: the carry only rewrites the pack in the vault. Nothing was written.';
    assert.ok(res.all.split('\n').includes(line), res.all);
    assert.ok(!fs.existsSync(f.site));
  });
});

test('moved, with a yaml folder map the generator cannot read: build --no-check refuses with exit 3 and says to fix the yaml', () => {
  withScratch((root) => {
    const f = fixture(root, 'new', {}, { yamlMap: false });
    const yaml = path.join(f.vault, '_meta', 'vault-config.yaml');
    const text = fs.readFileSync(yaml, 'utf8');
    assert.ok(text.includes('player_site:\n'));
    fs.writeFileSync(yaml, text.replace('player_site:\n', 'player_site:\n  folder_map: "not a map"\n'));
    const res = run(root, ['build', '--no-check']);
    assert.equal(res.code, 3, res.all);
    const line =
      `campaign "t": ${f.pack} still holds settings that _meta/vault-config.yaml does not, and the build no longer reads them there: ` +
      'folderMap (player_site.folder_map in _meta/vault-config.yaml is "not a map", which cannot be read). ' +
      'Fix player_site.folder_map in _meta/vault-config.yaml; the carry leaves it as it is. Nothing was written.';
    assert.ok(res.all.split('\n').includes(line), res.all);
    assert.ok(!fs.existsSync(f.site));
  });
});

/*
 * N1: the vault's own folder map, after a carry. The pack is then empty, so no carry check names a
 * folder map, but a yaml map that cannot be read, or one deleted afterwards, still maps no folder: the
 * build would publish almost nothing over the players' site. Check calls it an error and the build
 * refuses it whatever its flags. The carry's own copy of the yaml is named.
 */
function carried(root) {
  // The reviewer's shape: the yaml has no folder map until the carry writes the pack's into it.
  const f = fixture(root, 'new', {}, { yamlMap: false });
  const res = run(root, ['carry', '--yes']);
  assert.equal(res.code, 0, res.all);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pack, 'utf8')), {}, 'the carry emptied the pack');
  const backups = path.join(root, 'backups', 'campaign-t');
  // The carry's copy of the yaml is from before it wrote the folder map; the pack's copy holds folderMap.
  const packCopy = fs.readdirSync(backups).filter((n) => /^vault\.config-.*\.json\.bak$/.test(n));
  assert.equal(packCopy.length, 1);
  return { ...f, packCopy: path.join(backups, packCopy[0]) };
}

const UNREADABLE = (packCopy) =>
  'campaign "t": player_site.folder_map in _meta/vault-config.yaml is "Sessions", which cannot be read, so the build would publish none of the vault\'s folders. ' +
  `Fix player_site.folder_map in _meta/vault-config.yaml. The pack's folderMap as it was before the carry is kept at ${packCopy}. Nothing was written.`;
const MISSING = (packCopy) =>
  'campaign "t": _meta/vault-config.yaml sets no player_site.folder_map, so the build would publish none of the vault\'s folders. ' +
  `Set player_site.folder_map in _meta/vault-config.yaml.${packCopy ? ` The pack's folderMap as it was before the carry is kept at ${packCopy}.` : ''} Nothing was written.`;

for (const flag of ['--no-check', '--force-check']) {
  test(`N1, carried, build ${flag}: a yaml folder map that cannot be read refuses with exit 3 and names the pack's copy`, () => {
    withScratch((root) => {
      const f = carried(root);
      replaceYamlFolderMap(f.vault, '  folder_map: "Sessions"');
      const res = run(root, ['build', flag]);
      assert.equal(res.code, 3, res.all);
      assert.ok(res.all.split('\n').includes(UNREADABLE(f.packCopy)), res.all);
      assert.ok(!fs.existsSync(f.site));
    });
  });

  test(`N1, carried, build ${flag}: a yaml folder map deleted after the carry refuses with exit 3`, () => {
    withScratch((root) => {
      const f = carried(root);
      replaceYamlFolderMap(f.vault, null);
      const res = run(root, ['build', flag]);
      assert.equal(res.code, 3, res.all);
      assert.ok(res.all.split('\n').includes(MISSING(f.packCopy)), res.all);
      assert.ok(!fs.existsSync(f.site));
    });
  });
}

test('N1, carried: plain build stops at the check with exit 2, and check names the folder-map-missing error', () => {
  withScratch((root) => {
    const f = carried(root);
    replaceYamlFolderMap(f.vault, '  folder_map: "Sessions"');
    const checked = run(root, ['check']);
    assert.equal(checked.code, 2, checked.all);
    assert.match(checked.all, /^ERROR config\/folder-map-missing {2}player_site\.folder_map in _meta\/vault-config\.yaml is "Sessions", which cannot be read/m);
    assert.equal(run(root, ['build']).code, 2);
    assert.ok(!fs.existsSync(f.site));
  });
});

test('N1, moved with no folder map anywhere and no backup: build --no-check refuses with exit 3 and says it plainly', () => {
  withScratch((root) => {
    const f = fixture(root, 'new', { folderMap: undefined }, { yamlMap: false });
    const res = run(root, ['build', '--no-check']);
    assert.equal(res.code, 3, res.all);
    assert.ok(res.all.split('\n').includes(MISSING(null)), res.all);
    assert.ok(!fs.existsSync(f.site));
  });
});
