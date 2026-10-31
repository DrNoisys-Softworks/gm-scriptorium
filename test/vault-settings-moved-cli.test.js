'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');
const { moveVaultCopy } = require('./helpers/moved-vault');

/*
 * The CLI on a vault whose settings are in _meta/vault-config.yaml (moved), or that holds both
 * files (mixed). Before this version these exited 3 with a refusal (issue #171); that rule is gone
 * on purpose. `check` and `build` now read the yaml. SCRIPTORIUM_TEST_BIN runs this same file
 * against the packaged binary.
 */

function register(root, vault, siteConfig, out = 'site') {
  const site = siteConfig ? `site_config = '${siteConfig}'\n` : '';
  fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${vault}'\n${site}output = '${path.join(root, out)}'\n`);
}

/**
 * A moved copy of the sample (its pack kept), registered as campaign "t". The yaml gets the folder map the
 * sample's pack has (the pin's own writer, test-only), because a pack map the yaml lacks is its own error
 * (config/folder-map-not-carried); `withMap: false` leaves it out.
 */
function moved(root, { withMap = true } = {}) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root);
  if (withMap) {
    const pack = JSON.parse(fs.readFileSync(path.join(SAMPLE, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));
    require('gm-apprentice-publish/lib/settings/write').applyChanges(vaultPath, [{ op: 'set', name: 'player_site.folder_map', value: pack.folderMap }]);
  }
  register(root, vaultPath);
  return vaultPath;
}

/**
 * A moved copy of the sample whose pack settings the move already carried into the yaml (the
 * site title, folder map and hide lists are in vault-config.yaml), registered with the site file
 * the move left behind.
 */
function carried(root) {
  const pack = JSON.parse(fs.readFileSync(path.join(SAMPLE, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));
  const { vaultPath, siteConfig } = moveVaultCopy(SAMPLE, root, { siteConfig: pack });
  const left = path.join(root, 'site-left.json');
  fs.writeFileSync(left, JSON.stringify(siteConfig, null, 2));
  fs.rmSync(path.join(vaultPath, '_meta', 'scriptorium'), { recursive: true, force: true });
  // The build goes to root/out: the move's helper keeps the site file under root/site.
  register(root, vaultPath, left, 'out');
  return vaultPath;
}

/** Add one entry to the pack's excludeSections, which the yaml does not hold. */
function addUncarriedHide(vault, entry) {
  const file = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.excludeSections.push(entry);
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

test('check on a moved vault exits 0', () => {
  withScratch((root) => {
    moved(root);
    const res = run(root, ['check']);
    assert.equal(res.code, 0, res.all);
  });
});

test('a pack folder map the yaml lacks gives check exit 2, build exit 2, and build --force-check exit 3, with nothing written', () => {
  withScratch((root) => {
    moved(root, { withMap: false });
    const checked = run(root, ['check']);
    assert.equal(checked.code, 2, checked.all);
    assert.match(checked.all, /^ERROR config\/folder-map-not-carried /m);
    const built = run(root, ['build']);
    assert.equal(built.code, 2, built.all);
    assert.ok(!fs.existsSync(path.join(root, 'out')) && !fs.existsSync(path.join(root, 'site')), 'a refused build writes no output folder');
    const forced = run(root, ['build', '--force-check']);
    assert.equal(forced.code, 3, forced.all);
    assert.match(forced.all, /the build no longer reads them there: folderMap\. Run "gm-scriptorium carry t"/);
    assert.ok(!fs.existsSync(path.join(root, 'out')) && !fs.existsSync(path.join(root, 'site')), 'a refused forced build writes no output folder');
  });
});

test('build on a moved vault exits 0 and builds the title the yaml holds', () => {
  withScratch((root) => {
    carried(root);
    const res = run(root, ['build']);
    assert.equal(res.code, 0, res.all);
    assert.match(fs.readFileSync(path.join(root, 'out', 'index.html'), 'utf8'), /The Long Lease/);
  });
});

test('check and build on a mixed vault exit 0, and the left over file is reported', () => {
  withScratch((root) => {
    const vault = carried(root);
    fs.copyFileSync(path.join(SAMPLE, '_meta', 'vault-config.md'), path.join(vault, '_meta', 'vault-config.md'));
    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    assert.match(checked.all, /^WARN config\/leftover-settings-file/m);
    const built = run(root, ['build']);
    assert.equal(built.code, 0, built.all);
    // The build repeats the generator's own warning line.
    assert.match(built.all, /_meta\/vault-config\.md is left over from before the update and is not read/);
  });
});

test('a left over vault-config.md with broken frontmatter does not block check or build: the generator never reads it', () => {
  // Intended outcome, and why: with a vault-config.yaml beside it the pin does not read
  // vault-config.md at all (it reports it as left over and not read), so a broken one cannot change
  // the site, and a note nobody reads must not stop the GM. Only the leftover warning is given.
  withScratch((root) => {
    const vault = carried(root);
    fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\npublish: [unclosed\n  : : :\n---\n');
    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    assert.match(checked.all, /config\/leftover-settings-file/);
    assert.doesNotMatch(checked.all, /^ERROR frontmatter\/parse-error/m);
    const built = run(root, ['build']);
    assert.equal(built.code, 0, built.all);
  });
});

test('a vault-config.md with broken frontmatter is still an error when it is the only settings file', () => {
  withScratch((root) => {
    const vault = path.join(root, 'v');
    fs.cpSync(SAMPLE, vault, { recursive: true });
    fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\npublish: [unclosed\n  : : :\n---\n');
    register(root, vault);
    const res = run(root, ['check']);
    assert.equal(res.code, 2, res.all);
    assert.match(res.all, /^ERROR frontmatter\/parse-error/m);
  });
});

test('a pack hide entry the yaml lacks gives check exit 2, and build exit 2 with the output folder untouched', () => {
  withScratch((root) => {
    const vault = moved(root);
    addUncarriedHide(vault, 'Secret Plans');
    const checked = run(root, ['check']);
    assert.equal(checked.code, 2, checked.all);
    assert.match(checked.all, /config\/pack-hiding-not-carried/);
    assert.match(checked.all, /Run "gm-scriptorium carry t" to move it into the vault's settings\./);
    const built = run(root, ['build']);
    assert.equal(built.code, 2, built.all);
    assert.equal(fs.existsSync(path.join(root, 'site')), false);
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.scriptorium-')), []);
  });
});

test('build --force-check does not build past the uncarried hide entry: exit 3, nothing written', () => {
  withScratch((root) => {
    const vault = moved(root);
    addUncarriedHide(vault, 'Secret Plans');
    const res = run(root, ['build', '--force-check']);
    assert.equal(res.code, 3, res.all);
    assert.match(res.all, /the build no longer reads them there: excludeSections \("Secret Plans"\)\./);
    assert.equal(fs.existsSync(path.join(root, 'site')), false);
  });
});

test('a pack siteTitle that differs from the yaml gives check exit 0 with the warning', () => {
  withScratch((root) => {
    const vault = moved(root);
    const file = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    json.siteTitle = 'A Different Title';
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
    const res = run(root, ['check']);
    assert.equal(res.code, 0, res.all);
    assert.match(res.all, /config\/pack-setting-differs/);
  });
});

test('a malformed vault-config.yaml gives check exit 2 naming the file, with no stack trace', () => {
  withScratch((root) => {
    const vault = moved(root);
    fs.writeFileSync(path.join(vault, '_meta', 'vault-config.yaml'), 'type: meta\nplayer_site:\n  hide:\n    sections: [unclosed\n');
    const res = run(root, ['check']);
    assert.equal(res.code, 2, res.all);
    assert.match(res.all, /^ERROR config\/settings-fault _meta\/vault-config\.yaml\s+_meta\/vault-config\.yaml is not valid YAML/m);
    assert.doesNotMatch(res.all, /\n\s+at .*\(.*:\d+:\d+\)/);
  });
});

test('build on a malformed vault-config.yaml gives exit 2 at the check step and writes no output', () => {
  withScratch((root) => {
    const vault = moved(root);
    fs.writeFileSync(path.join(vault, '_meta', 'vault-config.yaml'), 'type: meta\nplayer_site:\n  hide:\n    sections: [unclosed\n');
    const res = run(root, ['build']);
    assert.equal(res.code, 2, res.all);
    assert.match(res.all, /^check found 1 error\(s\); refusing to build\. Nothing was written\./m);
    assert.match(res.all, /^ERROR config\/settings-fault _meta\/vault-config\.yaml /m);
    assert.equal(fs.existsSync(path.join(root, 'site')), false);
  });
});

test('status and config list call a moved vault reachable, not unreachable (settings-moved)', () => {
  withScratch((root) => {
    moved(root);
    const status = run(root, ['status']);
    assert.equal(status.code, 0, status.all);
    assert.match(status.out, /^t: reachable \(/m);
    assert.doesNotMatch(status.all, /unreachable|settings-moved/);
    const list = run(root, ['config', 'list']);
    assert.equal(list.code, 0, list.all);
    assert.match(list.out, /\[reachable\]/);
    assert.doesNotMatch(list.all, /unreachable|settings-moved/);
  });
});

/** The site-relative addresses (href and src) a built page links to. */
const linksIn = (html) => [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);

test('a pack siteUrl the yaml does not set reaches the 404 page as on the old layout (the address prefix)', () => {
  withScratch((root) => {
    const SITE_URL = 'https://example.org/longlease/';
    // Old layout: a copy of the sample with siteUrl in its pack.
    const legacyRoot = path.join(root, 'legacy');
    fs.mkdirSync(legacyRoot);
    const legacy = path.join(legacyRoot, 'vault');
    fs.cpSync(SAMPLE, legacy, { recursive: true });
    const legacyPack = path.join(legacy, '_meta', 'scriptorium', 'vault.config.json');
    fs.writeFileSync(legacyPack, JSON.stringify({ ...JSON.parse(fs.readFileSync(legacyPack, 'utf8')), siteUrl: SITE_URL }, null, 2));
    register(legacyRoot, legacy);
    const legacyBuilt = run(legacyRoot, ['build']);
    assert.equal(legacyBuilt.code, 0, legacyBuilt.all);

    // Moved layout: the pack folded into the yaml, then siteUrl added to the pack after the move.
    const movedRoot = path.join(root, 'moved');
    fs.mkdirSync(movedRoot);
    const { vaultPath } = moveVaultCopy(SAMPLE, movedRoot, { inVaultPack: true });
    assert.doesNotMatch(fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.yaml'), 'utf8'), /^\s*url:/m, 'the yaml sets no player_site.url');
    const movedPack = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
    fs.writeFileSync(movedPack, JSON.stringify({ ...JSON.parse(fs.readFileSync(movedPack, 'utf8')), siteUrl: SITE_URL }, null, 2));
    register(movedRoot, vaultPath, null, 'out');
    const movedBuilt = run(movedRoot, ['build']);
    assert.equal(movedBuilt.code, 0, movedBuilt.all);

    const legacy404 = linksIn(fs.readFileSync(path.join(legacyRoot, 'site', '404.html'), 'utf8'));
    const moved404 = linksIn(fs.readFileSync(path.join(movedRoot, 'out', '404.html'), 'utf8'));
    assert.ok(legacy404.includes('/longlease/css/style.css'), `the old layout's 404 page links the prefixed stylesheet: ${legacy404.join(' ')}`);
    assert.ok(moved404.includes('/longlease/css/style.css'), `the moved layout's 404 page links the prefixed stylesheet: ${moved404.join(' ')}`);
    assert.deepEqual(moved404.filter((l) => !l.startsWith('/longlease/')), [], 'every site-relative link on the moved 404 page carries the prefix');
    assert.deepEqual(moved404, legacy404);
  });
});
