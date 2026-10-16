'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCheckCommand } = require('../src/cli/check');
const { runBuildCommand } = require('../src/cli/build');
const { buildCheckContext } = require('../src/checks/context');
const { runExcludedDirInOutput } = require('../src/checks/leak/l2');
const { scanStagingOutput } = require('../src/build/outputgate');

/*
 * Issue #154 (ADR 0061): leak/l2-excluded-dir-in-output judges the cover picture and section banners
 * by the file they were really copied from. Every expected value is a hand-written literal, never
 * read from src. Scratch folders are removed in `finally`. Invented names only.
 */

const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');
const L2 = 'leak/l2-excluded-dir-in-output';

const SETTING_TAIL = 'It is published because the setting names it. To keep it hidden, move the picture out of that folder or change the setting.';

const MSG = {
  coverGm:
    'images/cover.png is the cover picture set in publish.theme.campaign_image, copied from GM/cover.png, which is under excluded directory "GM". ' +
    SETTING_TAIL,
  coverMeta:
    'images/cover.png is the cover picture set in publish.theme.campaign_image, copied from _meta/cover.png, which is under excluded directory "_meta". ' +
    SETTING_TAIL,
  factionsBanner:
    'images/banners/factions/factions.png is the banner set for "factions" in the banners setting, copied from GM/factions.png, which is under excluded directory "GM". ' +
    SETTING_TAIL,
  factionsLink:
    'images/banners/factions/factions-full.png is the file the banner for "factions" links to, set in the banners setting, copied from GM/factions-full.png, which is under excluded directory "GM". It is published because the setting names it. To keep it hidden, move the file out of that folder or change the setting.',
  creaturesFound:
    'images/banners/creatures/_banner.png is the banner for "creatures", found automatically at Creatures/_banner.png, which is under excluded directory "Creatures". No setting names it, so it is treated as a leak. Move it out of that folder, or set a banner for "creatures" in the banners setting.',
  beastsFound:
    'images/banners/creatures/_banner.png is the banner for "creatures", found automatically at Beasts/_banner.png, which is under excluded directory "Beasts". No setting names it, so it is treated as a leak. Move it out of that folder, or set a banner for "creatures" in the banners setting.',
  locationsX:
    'images/banners/locations/x.png is the banner set for "locations" in the banners setting, copied from personal/x.png, which is under excluded directory "personal". ' +
    SETTING_TAIL,
  factionsF:
    'images/banners/factions/f.png is the banner set for "factions" in the banners setting, copied from GM/f.png, which is under excluded directory "GM". ' +
    SETTING_TAIL,
  locationsFound:
    'images/banners/locations/_banner.png is the banner for "locations", found automatically at Locations/_banner.png, which is under excluded directory "Locations". No setting names it, so it is treated as a leak. Move it out of that folder, or set a banner for "locations" in the banners setting.',
};

function withScratch(label, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-154-${label}-`));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(base, rel, bytes) {
  const abs = path.join(base, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

const byOutputPath = (a, b) => (a.outputPath < b.outputPath ? -1 : a.outputPath > b.outputPath ? 1 : 0);

function projectL2(findings) {
  return findings
    .filter((f) => f.id === L2)
    .map((f) => ({ severity: f.severity, path: f.path, outputPath: f.outputPath, message: f.message }))
    .sort(byOutputPath);
}

/**
 * Unit scenario: a scratch copy of vocab-vault with the given vault-config.md and source files, and a
 * staging tree holding index.html plus the staged images. A staged value of null is an exact copy of
 * the vault file at `from`; a Buffer is written as is.
 */
function unitScenario(root, { vaultConfig, jsonConfig, files, staged }) {
  const vaultPath = path.join(root, 'vault');
  fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), vaultConfig);
  for (const [rel, bytes] of Object.entries(files)) writeFile(vaultPath, rel, bytes);
  const stagingOut = path.join(root, 'staging');
  fs.mkdirSync(stagingOut, { recursive: true });
  fs.writeFileSync(path.join(stagingOut, 'index.html'), '<html><body>Home</body></html>');
  for (const item of staged) {
    if (item.from) fs.mkdirSync(path.dirname(path.join(stagingOut, ...item.to.split('/'))), { recursive: true });
    if (item.from) fs.copyFileSync(path.join(vaultPath, ...item.from.split('/')), path.join(stagingOut, ...item.to.split('/')));
    else writeFile(stagingOut, item.to, item.bytes);
  }
  const fullJson = { ...jsonConfig, vaultPath };
  const findings = scanStagingOutput({ vaultPath, jsonConfig: fullJson, stagingOut, campaign: 'unit' });
  return { vaultPath, stagingOut, fullJson, l2: projectL2(findings) };
}

const exact = (rel, to) => ({ from: rel, to });

const CONFIG_A = [
  '---',
  'type: meta',
  'publish:',
  '  mode: full',
  '  exclude_dirs: [_attachments]',
  '  theme:',
  '    campaign_image: Art/cover.png',
  '  banners:',
  '    characters/npcs: Art/npcs.png',
  '    factions:',
  '      image: Art/factions.png',
  '      link: Art/factions-full.png',
  '---',
  '',
  'Scratch config.',
  '',
].join('\n');
const JSON_A = { attachmentsDir: '_attachments', excludeDirs: ['_attachments'], folderMap: { Locations: 'locations' } };
const FILES_A = {
  'Art/cover.png': Buffer.from('cover-154'),
  'Art/npcs.png': Buffer.from('npcs-154'),
  'Art/factions.png': Buffer.from('factions-154'),
  'Art/factions-full.png': Buffer.from('factions-full-154'),
  'Locations/_banner.png': Buffer.from('locations-154'),
};

test('(a) exact copies of the cover, banners, a link and an auto-found banner from visible folders give no l2 finding', () => {
  withScratch('a', (root) => {
    const r = unitScenario(root, {
      vaultConfig: CONFIG_A,
      jsonConfig: JSON_A,
      files: FILES_A,
      staged: [
        exact('Art/cover.png', 'images/cover.png'),
        exact('Art/npcs.png', 'images/banners/characters-npcs/npcs.png'),
        exact('Art/factions.png', 'images/banners/factions/factions.png'),
        exact('Art/factions-full.png', 'images/banners/factions/factions-full.png'),
        exact('Locations/_banner.png', 'images/banners/locations/_banner.png'),
      ],
    });
    assert.deepEqual(r.l2, []);
  });
});

test('(c) a file at the cover path with different bytes is still judged as an attachment', () => {
  withScratch('c', (root) => {
    const r = unitScenario(root, {
      vaultConfig: CONFIG_A,
      jsonConfig: JSON_A,
      files: FILES_A,
      staged: [{ to: 'images/cover.png', bytes: Buffer.from('stale-154') }],
    });
    assert.deepEqual(r.l2, [
      {
        severity: 'error',
        path: '_attachments/cover.png',
        outputPath: 'images/cover.png',
        message: 'images/cover.png is copied from _attachments/cover.png, which is under excluded directory "_attachments"',
      },
    ]);
  });
});

const CONFIG_D = [
  '---',
  'type: meta',
  'publish:',
  '  mode: full',
  '  exclude_dirs: [_attachments, GM, Creatures]',
  '  theme:',
  '    campaign_image: GM/cover.png',
  '  banners:',
  '    factions:',
  '      image: GM/factions.png',
  '      link: GM/factions-full.png',
  '---',
  '',
  'Scratch config.',
  '',
].join('\n');
const JSON_D = { attachmentsDir: '_attachments', excludeDirs: ['_attachments', 'GM', 'Creatures'], folderMap: { Creatures: 'creatures' } };
const EXPECTED_D = [
  { severity: 'error', path: 'Creatures/_banner.png', outputPath: 'images/banners/creatures/_banner.png', message: MSG.creaturesFound },
  { severity: 'warn', path: 'GM/factions-full.png', outputPath: 'images/banners/factions/factions-full.png', message: MSG.factionsLink },
  { severity: 'warn', path: 'GM/factions.png', outputPath: 'images/banners/factions/factions.png', message: MSG.factionsBanner },
  { severity: 'warn', path: 'GM/cover.png', outputPath: 'images/cover.png', message: MSG.coverGm },
];

test('(d) a real source in a hidden folder: named files warn, an auto-found banner errors; check and staging agree', () => {
  withScratch('d', (root) => {
    const r = unitScenario(root, {
      vaultConfig: CONFIG_D,
      jsonConfig: JSON_D,
      files: {
        'GM/cover.png': Buffer.from('gm-cover-154'),
        'GM/factions.png': Buffer.from('gm-factions-154'),
        'GM/factions-full.png': Buffer.from('gm-factions-full-154'),
        'Creatures/_banner.png': Buffer.from('creatures-banner-154'),
      },
      staged: [
        exact('Creatures/_banner.png', 'images/banners/creatures/_banner.png'),
        exact('GM/factions-full.png', 'images/banners/factions/factions-full.png'),
        exact('GM/factions.png', 'images/banners/factions/factions.png'),
        exact('GM/cover.png', 'images/cover.png'),
      ],
    });
    assert.deepEqual(r.l2, EXPECTED_D);
    const ctx = buildCheckContext({ campaign: 'unit', vaultPath: r.vaultPath, jsonConfig: r.fullJson, outputPath: r.stagingOut });
    assert.deepEqual(projectL2(runExcludedDirInOutput(ctx)), EXPECTED_D);
  });
});

test('(e) an always-excluded real source (_meta cover, personal banner) warns', () => {
  withScratch('e', (root) => {
    const r = unitScenario(root, {
      vaultConfig: [
        '---',
        'type: meta',
        'publish:',
        '  mode: full',
        '  theme:',
        '    campaign_image: _meta/cover.png',
        '  banners:',
        '    locations: personal/x.png',
        '---',
        '',
        'Scratch config.',
        '',
      ].join('\n'),
      jsonConfig: { attachmentsDir: '_attachments', excludeDirs: ['_attachments'], folderMap: {} },
      files: { '_meta/cover.png': Buffer.from('meta-cover-154'), 'personal/x.png': Buffer.from('personal-x-154') },
      staged: [exact('personal/x.png', 'images/banners/locations/x.png'), exact('_meta/cover.png', 'images/cover.png')],
    });
    assert.deepEqual(r.l2, [
      { severity: 'warn', path: 'personal/x.png', outputPath: 'images/banners/locations/x.png', message: MSG.locationsX },
      { severity: 'warn', path: '_meta/cover.png', outputPath: 'images/cover.png', message: MSG.coverMeta },
    ]);
  });
});

test('(f) a cover value with .. is judged by its normalised real source', () => {
  withScratch('f', (root) => {
    const r = unitScenario(root, {
      vaultConfig: [
        '---',
        'type: meta',
        'publish:',
        '  mode: full',
        '  exclude_dirs: [_attachments, GM]',
        '  theme:',
        '    campaign_image: Art/../GM/cover.png',
        '---',
        '',
        'Scratch config.',
        '',
      ].join('\n'),
      jsonConfig: { attachmentsDir: '_attachments', excludeDirs: ['_attachments', 'GM'], folderMap: {} },
      files: { 'GM/cover.png': Buffer.from('gm-cover-154') },
      staged: [exact('GM/cover.png', 'images/cover.png')],
    });
    assert.deepEqual(r.l2, [{ severity: 'warn', path: 'GM/cover.png', outputPath: 'images/cover.png', message: MSG.coverGm }]);
  });
});

test('(g) an http cover and an SVG banner with no link make no copy, so stray files there are attachments', () => {
  withScratch('g', (root) => {
    const r = unitScenario(root, {
      vaultConfig: [
        '---',
        'type: meta',
        'publish:',
        '  mode: full',
        '  exclude_dirs: [_attachments]',
        '  theme:',
        '    campaign_image: https://example.invalid/cover.png',
        '  banners:',
        '    locations: Art/chart.svg',
        '---',
        '',
        'Scratch config.',
        '',
      ].join('\n'),
      jsonConfig: { attachmentsDir: '_attachments', excludeDirs: ['_attachments'], folderMap: {} },
      files: { 'Art/chart.svg': Buffer.from('<svg></svg>') },
      staged: [{ to: 'images/cover.png', bytes: Buffer.from('stray-154') }, exact('Art/chart.svg', 'images/banners/locations/chart.svg')],
    });
    assert.deepEqual(r.l2, [
      {
        severity: 'error',
        path: '_attachments/banners/locations/chart.svg',
        outputPath: 'images/banners/locations/chart.svg',
        message:
          'images/banners/locations/chart.svg is copied from _attachments/banners/locations/chart.svg, which is under excluded directory "_attachments"',
      },
      {
        severity: 'error',
        path: '_attachments/cover.png',
        outputPath: 'images/cover.png',
        message: 'images/cover.png is copied from _attachments/cover.png, which is under excluded directory "_attachments"',
      },
    ]);
  });
});

test('(h) banners and folder_map follow the generator merge: the vault file wins folder_map, the json adds banners', () => {
  withScratch('h', (root) => {
    const r = unitScenario(root, {
      vaultConfig: [
        '---',
        'type: meta',
        'publish:',
        '  mode: full',
        '  exclude_dirs: [_attachments, GM, Beasts]',
        '  banners:',
        '    locations: Art/l.png',
        '  folder_map:',
        '    Beasts: creatures',
        '---',
        '',
        'Scratch config.',
        '',
      ].join('\n'),
      jsonConfig: {
        attachmentsDir: '_attachments',
        excludeDirs: ['_attachments', 'GM', 'Beasts'],
        folderMap: { Creatures: 'creatures' },
        banners: { factions: 'GM/f.png' },
      },
      files: {
        'Art/l.png': Buffer.from('l-154'),
        'GM/f.png': Buffer.from('f-154'),
        'Beasts/_banner.png': Buffer.from('bytes-a-154'),
        'Creatures/_banner.png': Buffer.from('bytes-b-154'),
      },
      staged: [
        exact('Art/l.png', 'images/banners/locations/l.png'),
        exact('GM/f.png', 'images/banners/factions/f.png'),
        exact('Beasts/_banner.png', 'images/banners/creatures/_banner.png'),
      ],
    });
    assert.deepEqual(r.l2, [
      { severity: 'error', path: 'Beasts/_banner.png', outputPath: 'images/banners/creatures/_banner.png', message: MSG.beastsFound },
      { severity: 'warn', path: 'GM/f.png', outputPath: 'images/banners/factions/f.png', message: MSG.factionsF },
    ]);
  });
});

// --- end to end: the real pinned generator ------------------------------------------------------

function vocabScratch(root) {
  const vaultPath = path.join(root, 'vocab-vault');
  fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
  const configPath = path.join(root, 'config.toml');
  const out = path.join(root, 'out');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${vaultPath}'`, `output = '${out}'`, ''].join('\n'),
  );
  return { vaultPath, configPath, out };
}

/** Rewrites both config files: json patch is merged over the fixture's vault.config.json. */
function writeConfigs(vaultPath, { excludeDirs, folderMap, banners, publishYaml }) {
  const jsonPath = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  json.excludeDirs = excludeDirs;
  json.folderMap = folderMap;
  if (banners) json.banners = banners;
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    ['---', 'type: meta', 'publish:', '  mode: full', publishYaml, '---', '', 'Scratch config.', ''].join('\n'),
  );
}

const FOLDER_MAP_LOCATIONS = { Chronicle: 'chronicle', Episodes: 'episodes', People: 'people', Locations: 'locations' };

test('(b) (i) the issue scenario: _attachments hidden, banners and cover from visible folders build with no flags, and check is clean', () => {
  withScratch('b', (root) => {
    const { vaultPath, configPath, out } = vocabScratch(root);
    writeConfigs(vaultPath, {
      excludeDirs: ['_meta', '_attachments'],
      folderMap: FOLDER_MAP_LOCATIONS,
      publishYaml: [
        '  exclude_dirs: [_meta, _attachments]',
        '  theme:',
        '    campaign_image: Art/cover.png',
        '  banners:',
        '    characters/npcs: Art/npcs.png',
        '    factions:',
        '      image: Art/factions.png',
        '      link: Art/factions-full.png',
      ].join('\n'),
    });
    for (const [rel, bytes] of Object.entries(FILES_A)) writeFile(vaultPath, rel, bytes);
    writeFile(vaultPath, '_attachments/hidden.png', Buffer.from('hidden-154'));

    const built = runBuildCommand({ config: configPath }, 'vocab');
    assert.equal(built.exitCode, 0, built.human);
    assert.equal(built.envelope.refusedByScan, false);
    for (const rel of [
      'images/cover.png',
      'images/banners/characters-npcs/npcs.png',
      'images/banners/factions/factions.png',
      'images/banners/factions/factions-full.png',
      'images/banners/locations/_banner.png',
    ]) {
      assert.equal(fs.existsSync(path.join(out, ...rel.split('/'))), true, rel);
    }
    assert.equal(fs.existsSync(path.join(out, 'images', 'hidden.png')), false);

    const checked = runCheckCommand({ config: configPath }, 'vocab');
    assert.equal(checked.envelope.counts.error, 0, checked.human);
    assert.deepEqual(projectL2(checked.envelope.findings), []);
  });
});

test('(j) a named source in a hidden folder warns, the build goes ahead, and check shows the same warning', () => {
  withScratch('j', (root) => {
    const { vaultPath, configPath, out } = vocabScratch(root);
    writeConfigs(vaultPath, {
      excludeDirs: ['_meta', 'GM'],
      folderMap: FOLDER_MAP_LOCATIONS,
      publishYaml: ['  exclude_dirs: [_meta, GM]', '  theme:', '    campaign_image: GM/cover.png'].join('\n'),
    });
    writeFile(vaultPath, 'GM/cover.png', Buffer.from('gm-cover-154'));
    const expected = [{ severity: 'warn', path: 'GM/cover.png', outputPath: 'images/cover.png', message: MSG.coverGm }];

    const built = runBuildCommand({ config: configPath }, 'vocab');
    assert.equal(built.exitCode, 0, built.human);
    assert.equal(built.envelope.refusedByScan, false);
    assert.deepEqual(projectL2(built.envelope.outputScan.findings), expected);
    assert.equal(fs.existsSync(path.join(out, 'images', 'cover.png')), true);

    const checked = runCheckCommand({ config: configPath }, 'vocab');
    assert.equal(checked.exitCode, 0, checked.human);
    assert.deepEqual(projectL2(checked.envelope.findings), expected);
  });
});

test('(k) an auto-found banner in a hidden folder errors and the staging gate refuses the build', () => {
  withScratch('k', (root) => {
    const { vaultPath, configPath, out } = vocabScratch(root);
    writeConfigs(vaultPath, {
      excludeDirs: ['_meta', 'Locations'],
      folderMap: FOLDER_MAP_LOCATIONS,
      publishYaml: '  exclude_dirs: [_meta, Locations]',
    });
    writeFile(vaultPath, 'Locations/_banner.png', Buffer.from('locations-154'));

    const built = runBuildCommand({ config: configPath }, 'vocab');
    assert.equal(built.exitCode, 2, built.human);
    assert.equal(built.envelope.refusedByScan, true);
    assert.deepEqual(projectL2(built.envelope.outputScanFindings), [
      { severity: 'error', path: 'Locations/_banner.png', outputPath: 'images/banners/locations/_banner.png', message: MSG.locationsFound },
    ]);
    assert.equal(fs.existsSync(path.join(out, 'index.html')), false);
  });
});

test('(l) the real generator merges banners and folder_map across the two config files as the copy does', () => {
  withScratch('l', (root) => {
    const { vaultPath, configPath, out } = vocabScratch(root);
    writeConfigs(vaultPath, {
      excludeDirs: ['_meta', '_attachments'],
      folderMap: { Chronicle: 'chronicle', Episodes: 'episodes', People: 'people', Locations: 'locations', Creatures: 'creatures' },
      banners: { items: 'Art/items.png' },
      publishYaml: [
        '  exclude_dirs: [_meta, _attachments]',
        '  folder_map: {Chronicle: chronicle, Episodes: episodes, People: people, Locations: locations, Beasts: creatures}',
        '  banners: {locations: Art/l.png}',
      ].join('\n'),
    });
    writeFile(vaultPath, 'Art/l.png', Buffer.from('l-154'));
    writeFile(vaultPath, 'Art/items.png', Buffer.from('items-154'));
    writeFile(vaultPath, 'Beasts/_banner.png', Buffer.from('beasts-154'));
    writeFile(vaultPath, 'Creatures/_banner.png', Buffer.from('creatures-154'));

    const built = runBuildCommand({ config: configPath }, 'vocab');
    assert.equal(built.exitCode, 0, built.human);
    assert.deepEqual(fs.readFileSync(path.join(out, 'images', 'banners', 'creatures', '_banner.png')), Buffer.from('beasts-154'));
    assert.equal(fs.existsSync(path.join(out, 'images', 'banners', 'items', 'items.png')), true);
    assert.equal(fs.existsSync(path.join(out, 'images', 'banners', 'locations', 'l.png')), true);

    const checked = runCheckCommand({ config: configPath }, 'vocab');
    assert.deepEqual(projectL2(checked.envelope.findings), []);
  });
});

test('(m) a refusal counts only its error findings, though a WARN rides in the same list', () => {
  withScratch('m', (root) => {
    const { vaultPath, configPath } = vocabScratch(root);
    writeConfigs(vaultPath, {
      excludeDirs: ['_meta', 'Locations', 'GM'],
      folderMap: FOLDER_MAP_LOCATIONS,
      publishYaml: ['  exclude_dirs: [_meta, Locations, GM]', '  theme:', '    campaign_image: GM/cover.png'].join('\n'),
    });
    writeFile(vaultPath, 'GM/cover.png', Buffer.from('gm-cover-154'));
    writeFile(vaultPath, 'Locations/_banner.png', Buffer.from('locations-154'));

    const built = runBuildCommand({ config: configPath }, 'vocab');
    assert.equal(built.exitCode, 2, built.human);
    assert.equal(built.envelope.refusedByScan, true);
    const lines = built.human.split('\n');
    assert.deepEqual(
      lines.filter((l) => l === 'the output-leak scan found 1 error finding(s) in the staged build; refusing to swap. Nothing was written.'),
      ['the output-leak scan found 1 error finding(s) in the staged build; refusing to swap. Nothing was written.'],
    );
    const warnLine = `  WARN leak/l2-excluded-dir-in-output images/cover.png ${MSG.coverGm}`;
    const errorLine = `  ERROR leak/l2-excluded-dir-in-output images/banners/locations/_banner.png ${MSG.locationsFound}`;
    assert.deepEqual(lines.filter((l) => l === warnLine), [warnLine]);
    assert.deepEqual(lines.filter((l) => l === errorLine), [errorLine]);
    assert.equal(built.envelope.error, 'the output-leak scan found 1 error finding(s); refusing to build');
    assert.deepEqual(projectL2(built.envelope.outputScanFindings), [
      { severity: 'error', path: 'Locations/_banner.png', outputPath: 'images/banners/locations/_banner.png', message: MSG.locationsFound },
      { severity: 'warn', path: 'GM/cover.png', outputPath: 'images/cover.png', message: MSG.coverGm },
    ]);
  });
});
