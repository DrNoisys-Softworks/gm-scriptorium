'use strict';

/*
 * `check` must read a vault's hiding settings the way the pinned build reads them. At
 * publish-v1.26.0 the pin changed three things about an old-layout vault (settings in
 * _meta/vault-config.md):
 *   (a) a hiding list in the site's vault.config.json, with none in the vault file, now adds to the
 *       built-in list instead of replacing it (upstream #371);
 *   (b) `exclude_callouts: no` and `exclude_drafts: no` (and off, yes, on) are read as switch words;
 *       before, any text counted as on;
 *   (c) a hiding setting that cannot be read stops the build, with a reason.
 * Every expected value below is typed out by hand from the pin's documented rules (the registry's
 * defaults, the switch words, the fault texts in lib/settings/faults.js's formatFault), never read
 * from src/vault/publishset.js. The last tests compare publishset with the pin's own loader run on
 * the same files on disk, which is an independent reading.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadPublishConfig } = require('../src/vault/publishset');
const read = require('../src/vault/read');

const DEFAULT_SECTIONS = ['GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile'];
const DEFAULT_FIELDS = ['secrets', 'current_plan', 'plan_progress', 'gm_notes', 'prep_notes', 'reliability'];

function withVault(publishBlock, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-hiding-'));
  try {
    if (publishBlock !== null) {
      fs.mkdirSync(path.join(dir, '_meta'), { recursive: true });
      fs.writeFileSync(path.join(dir, '_meta', 'vault-config.md'), `---\ntype: meta\npublish:\n${publishBlock}\n---\n\nnotes\n`);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -- (a) site-file lists add to the defaults --------------------------------------------------

test('(a) a site-file list with no vault-file list adds to the built-in list', () => {
  withVault('  mode: player', (vault) => {
    const { publishConfig } = loadPublishConfig(vault, { excludeSections: ['Foo'], excludeDirs: ['Secrets/'], excludeFields: ['x'] });
    assert.deepEqual(publishConfig.exclude_sections, [...DEFAULT_SECTIONS, 'Foo']);
    assert.deepEqual(publishConfig.exclude_dirs, ['_meta', '_Templates', 'Secrets']);
    assert.deepEqual(publishConfig.exclude_fields, [...DEFAULT_FIELDS, 'x']);
  });
});

test('(a) a site-file entry that repeats a default, in another case, is not added twice', () => {
  withVault('  mode: player', (vault) => {
    const { publishConfig } = loadPublishConfig(vault, { excludeSections: ['gm notes', 'Foo'] });
    assert.deepEqual(publishConfig.exclude_sections, [...DEFAULT_SECTIONS, 'Foo']);
  });
});

test('(a) a vault-file list still replaces the defaults, and the site file\'s extra entries are added after it', () => {
  withVault('  exclude_sections:\n    - Secrets', (vault) => {
    const { publishConfig } = loadPublishConfig(vault, { excludeSections: ['Foo'] });
    assert.deepEqual(publishConfig.exclude_sections, ['Secrets', 'Foo']);
  });
});

// -- (b) switch words -------------------------------------------------------------------------

test('(b) exclude_callouts: no and exclude_drafts: no are off', () => {
  withVault('  exclude_callouts: "no"\n  exclude_drafts: "no"', (vault) => {
    const { publishConfig, stops } = loadPublishConfig(vault, {});
    assert.equal(publishConfig.exclude_callouts, false);
    assert.equal(publishConfig.exclude_drafts, false);
    assert.deepEqual(stops, []);
  });
});

test('(b) on and yes are on, in any case', () => {
  withVault('  exclude_callouts: "On"\n  exclude_drafts: "YES"', (vault) => {
    const { publishConfig } = loadPublishConfig(vault, {});
    assert.equal(publishConfig.exclude_callouts, true);
    assert.equal(publishConfig.exclude_drafts, true);
  });
});

test('(b) a word that is no switch hides (the safe reading) and stops the build', () => {
  withVault('  exclude_drafts: maybe', (vault) => {
    const { publishConfig, stops } = loadPublishConfig(vault, {});
    assert.equal(publishConfig.exclude_drafts, true);
    assert.deepEqual(stops.map((s) => s.message), ['publish.exclude_drafts is "maybe"; it takes on or off (yes, no, true and false work too).']);
  });
});

test('(b) exclude_callouts: off in the vault file and a list in the site file: the list wins (stricter)', () => {
  withVault('  exclude_callouts: "off"', (vault) => {
    const { publishConfig } = loadPublishConfig(vault, { excludeCallouts: ['secret'] });
    assert.deepEqual(publishConfig.exclude_callouts, ['secret']);
  });
});

// -- (c) faults that stop the build -----------------------------------------------------------

test('(c) a misspelt hiding setting stops the build, naming the setting it meant', () => {
  withVault('  exclude_sectoins:\n    - Secrets', (vault) => {
    const { stops } = loadPublishConfig(vault, {});
    assert.deepEqual(stops.map((s) => s.message), ['publish.exclude_sectoins is not a setting. Did you mean publish.exclude_sections?']);
  });
});

test('(c) a folder list written as one word stops the build', () => {
  withVault('  exclude_dirs: Secrets', (vault) => {
    const { publishConfig, stops } = loadPublishConfig(vault, {});
    assert.deepEqual(stops.map((s) => s.message), ['publish.exclude_dirs is "Secrets"; it takes a list of folders.']);
    assert.deepEqual(publishConfig.exclude_dirs, ['_meta', '_Templates'], 'the build falls back to the defaults');
  });
});

test('(c) a hiding list left in the site file and set wrongly there is named as the site file writes it', () => {
  withVault('  mode: player', (vault) => {
    const { stops } = loadPublishConfig(vault, { excludeSections: 'GM Notes' });
    assert.equal(stops.length, 1);
    assert.equal(stops[0].message, 'excludeSections in the site folder\'s vault.config.json is "GM Notes"; it takes a list of headings.');
  });
});

test('(c) a vault with nothing wrong has no stops, and neither does a vault with no settings file', () => {
  withVault('  mode: player\n  exclude_sections:\n    - Secrets', (vault) => {
    assert.deepEqual(loadPublishConfig(vault, {}).stops, []);
  });
  withVault(null, (vault) => {
    assert.deepEqual(loadPublishConfig(vault, {}).stops, []);
  });
});

test('(c) the site file\'s outputDir is never judged: the build replaces it with its staging folder', () => {
  withVault('  mode: player', (vault) => {
    assert.deepEqual(loadPublishConfig(vault, { outputDir: '../outside' }).stops, []);
  });
});

// -- the old reading where nothing changed ----------------------------------------------------

test('mode reads without regard to case, and withheld_words are the built-in words on an old-layout vault', () => {
  withVault('  mode: Full', (vault) => {
    const { publishConfig } = loadPublishConfig(vault, {});
    assert.equal(publishConfig.mode, 'full');
    assert.deepEqual(publishConfig.withheld_words, { person: 'someone', place: 'somewhere', thing: 'something' });
  });
});

test('a settings file whose frontmatter cannot be read leaves the built-in hiding lists in place, without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-hiding-'));
  try {
    fs.mkdirSync(path.join(dir, '_meta'));
    fs.writeFileSync(path.join(dir, '_meta', 'vault-config.md'), '---\npublish: [unclosed\n---\n');
    const { publishConfig, stops } = loadPublishConfig(dir, {});
    assert.deepEqual(publishConfig.exclude_sections, DEFAULT_SECTIONS);
    assert.deepEqual(stops, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a moved vault\'s vault-config.yaml is never read here: the old file is (moved vaults are refused before this)', () => {
  withVault('  exclude_sections:\n    - Old', (vault) => {
    fs.writeFileSync(path.join(vault, '_meta', 'vault-config.yaml'), 'player_site:\n  hide:\n    sections: [New]\n');
    assert.deepEqual(loadPublishConfig(vault, {}).publishConfig.exclude_sections, ['Old']);
  });
});

// -- the panel's edited copy (ADR 0041) -------------------------------------------------------

test('an edited copy served by the candidate overlay is what the settings are read from', () => {
  withVault('  exclude_sections:\n    - OnDisk', (vault) => {
    const target = path.join(vault, '_meta', 'vault-config.md');
    const bytes = Buffer.from('---\ntype: meta\npublish:\n  exclude_sections:\n    - Edited\n  exclude_sectoins: [x]\n---\n');
    const { value, hits } = read.withCandidateFile(target, bytes, () => loadPublishConfig(vault, {}));
    assert.ok(hits >= 1);
    assert.deepEqual(value.publishConfig.exclude_sections, ['Edited']);
    assert.equal(value.stops.length, 1);
    assert.deepEqual(loadPublishConfig(vault, {}).publishConfig.exclude_sections, ['OnDisk'], 'and the disk file afterwards');
  });
});

// -- parity with the pin's own loader, on disk ------------------------------------------------

test('parity: every hiding value equals what the pin\'s own loadPublishConfig reads from the same files', () => {
  // eslint-disable-next-line global-require
  const pinConfig = require('gm-apprentice-publish/lib/config');
  const blocks = [
    '  mode: player',
    '  mode: FULL\n  exclude_drafts: true\n  exclude_callouts: [secret, gm]',
    '  exclude_dirs:\n    - "Secrets/"\n    - ./GM\n  exclude_fields: [secrets]',
    '  exclude_callouts: "no"\n  exclude_drafts: "off"',
    '  overrides:\n    fields:\n      "Characters/NPCs/Vex.md":\n        include: [secrets]',
  ];
  const sites = [{}, { excludeSections: ['Foo'], excludeDirs: ['Private'] }, { excludeCallouts: true, excludeFields: ['plan'] }];
  for (const block of blocks) {
    for (const site of sites) {
      withVault(block, (vault) => {
        const ours = loadPublishConfig(vault, site).publishConfig;
        const theirs = pinConfig.loadPublishConfig(vault, site, () => {}, { quietStops: true });
        for (const key of ['mode', 'exclude_drafts', 'exclude_callouts', 'exclude_sections', 'exclude_fields', 'exclude_dirs']) {
          assert.deepEqual(ours[key], theirs[key], `${key} for ${JSON.stringify(block)} with ${JSON.stringify(site)}`);
        }
        assert.deepEqual(ours.overrides.fields, theirs.overrides.fields);
      });
    }
  }
});
