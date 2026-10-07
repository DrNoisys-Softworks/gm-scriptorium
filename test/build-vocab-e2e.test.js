'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runAtomicBuild } = require('../src/build/run');
const { runBuildCommand } = require('../src/cli/build');
const { runCheckCommand } = require('../src/cli/check');
const { loadPackToml } = require('../src/build/packtoml');
const { EXIT_CODES } = require('../src/util/exitcodes');

/*
 * ADR 0020 ("Labels and vocabulary"), fixture builds. Synthetic names only (NFR-11(c)). E1/E3
 * build a fresh, throwaway vault per test (theme-build.test.js's style, :70-112/:134-199/:783-820);
 * E2 builds the committed test/fixtures/vocab-vault fixture.
 */

const VOCAB_VAULT = path.join(__dirname, 'fixtures', 'vocab-vault');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vocab-e2e-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Copied from test/theme-build.test.js:49-61.
function sha256Manifest(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = [];
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else entries.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  })(dir, '');
  return entries.sort().join('\n');
}

function writeConfigToml(root, { vaultPath, finalOut, campaign = 'alpha' }) {
  const configPath = path.join(root, 'config.toml');
  const lines = ['config_version = 1', `default_campaign = "${campaign}"`, '', `[campaigns.${campaign}]`, `vault = '${vaultPath}'`, `output = '${finalOut}'`, ''];
  fs.writeFileSync(configPath, lines.join('\n'));
  return configPath;
}

function walkHtml(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) out.push(full);
    }
  })(dir);
  return out;
}

// === E1: byte identity ============================================================================

/** A small, real vault + convention pack whose timeline/session/people content never changes
 * across the five pack.toml variants below (default-vocab everywhere: standard S tokens, the
 * default "What the Party Learned" heading, standard column headers and kind values). */
function buildE1Vault(root) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, 'Chronicle'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, 'People'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });

  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    '---\ntype: meta\npublish:\n  mode: full\n---\n\nADR 0020 E1 fixture vault. Invented names only.\n',
  );

  fs.writeFileSync(
    path.join(vaultPath, 'Chronicle', 'Log.md'),
    [
      '---',
      'type: timeline',
      'title: Log',
      '---',
      'Invented setting for byte-identity testing.',
      '',
      '## Backstory and setting',
      '',
      '| Title | Kind | Weight | Place | When | What |',
      '|---|---|---|---|---|---|',
      '| The Old Signal | backstory | 2 | Nowhere | long ago | An old signal predates the crew. |',
      '',
      '## The campaign',
      '',
      '| Title | Kind | Weight | Place | When | Real-world | What |',
      '|---|---|---|---|---|---|---|',
      '| The Landing | meeting | 2 | Harbour | week 1 | S1 | [[Nera Kest]] meets the crew at the landing. |',
      '| The Skirmish | fight | 3 | Harbour | week 2 | S2 | A skirmish breaks out near the landing. |',
      '',
      '## Learned anchors',
      '',
      '| Session | Learned | After |',
      '|---|---|---|',
      '| S1 | The tide is watched | The Landing |',
      '',
      '## Session log',
      '',
      '- Session 01: the landing.',
      '- Session 02: the skirmish.',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(vaultPath, 'Sessions', 'Session-01.md'),
    [
      '---',
      'type: session',
      'title: Session 01',
      'session_number: 1',
      'play_date: 4 September 2026',
      '---',
      'The crew met [[Nera Kest]] at the landing.',
      '',
      '## What the Party Learned',
      '',
      '- **The tide is watched.** Someone reports every new arrival.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(vaultPath, 'Sessions', 'Session-02.md'),
    ['---', 'type: session', 'title: Session 02', 'session_number: 2', 'play_date: 11 September 2026', '---', 'A skirmish near the landing.', '', '## What the Party Learned', ''].join('\n'),
  );

  fs.writeFileSync(
    path.join(vaultPath, 'People', 'Nera-Kest.md'),
    [
      '---',
      'type: npc',
      'title: Nera Kest',
      'relationships:',
      '  - target: "[[Tomas Rell]]"',
      '    type: knows',
      '    description: Nera vouched for Tomas at the landing.',
      '---',
      'Nera Kest keeps the harbour ledger.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(vaultPath, 'People', 'Tomas-Rell.md'),
    ['---', 'type: pc', 'title: Tomas Rell', '---', 'Tomas Rell is new in town.', ''].join('\n'),
  );

  const siteDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(siteDir, { recursive: true });
  const jsonConfig = {
    siteTitle: 'E1 Vault',
    siteUrl: 'https://example.invalid',
    attachmentsDir: '_attachments',
    excludeDirs: ['_meta'],
    folderMap: { Chronicle: 'chronicle', Sessions: 'sessions', People: 'people' },
  };
  fs.writeFileSync(path.join(siteDir, 'vault.config.json'), JSON.stringify(jsonConfig, null, 2));

  return { vaultPath, siteDir, jsonConfig: { ...jsonConfig, vaultPath }, finalOut: path.join(root, 'out') };
}

function writePackToml(siteDir, text) {
  fs.writeFileSync(path.join(siteDir, 'pack.toml'), text);
}

// D-block: the maximal restatement of every default (Engineering Brief, "D-block"; L8(b) reuses
// the same text in test/build-labels.test.js).
const D_BLOCK = `
[labels]
learned_lens = "What the party learned"
learned_legend = "Learned"
story_lens = "The story"
chapter = "Chapter"
recap = "Recap"
recap_learned_link = "What the Party Learned"
same_recap = "Same recap"
connections_heading = "Connections"
group_tie = "Ties"
group_named = "Named by"
group_pc = "The party"
group_npc = "People"
group_faction = "Factions"
group_location = "Places"
group_thing = "Things"
group_event = "Events"
group_other = "Other"

[timeline]
weights = ["aside", "scene", "turning point"]
session_token = '\\bS(\\d+)\\b'
segment_units = '\\b(week|day)\\s+(\\d+)\\b'

[[timeline.kinds]]
key = "fight"
label = "fight"
glyph = "fight"
aliases = []
before = false

[[timeline.kinds]]
key = "meeting"
label = "meeting"
glyph = "meeting"
aliases = []
before = false

[[timeline.kinds]]
key = "discovery"
label = "discovery"
glyph = "discovery"
aliases = []
before = false

[[timeline.kinds]]
key = "journey"
label = "journey"
glyph = "journey"
aliases = []
before = false

[[timeline.kinds]]
key = "backstory"
label = "backstory"
glyph = "backstory"
aliases = []
before = true

[timeline.columns]
title = ["title"]
kind = ["kind"]
weight = ["weight"]
place = ["place"]
in_game = ["in-game"]
when = ["when"]
real_world = ["real-world"]
what = ["what"]
session = ["session"]
learned = ["learned"]
after = ["after"]

[recaps]
learned_heading = "what the party learned"
`;

// M-block: five [[timeline.kinds]] entries with key only, plus before = true on backstory.
const M_BLOCK = `
[[timeline.kinds]]
key = "fight"

[[timeline.kinds]]
key = "meeting"

[[timeline.kinds]]
key = "discovery"

[[timeline.kinds]]
key = "journey"

[[timeline.kinds]]
key = "backstory"
before = true
`;

test('E1: no pack.toml, theme-only, D-block, M-block and labels={} are all byte-identical, and no HTML carries "voc"', () => {
  withScratchDir((root) => {
    const variants = {
      a: null, // no pack.toml
      b: 'theme = "plain"\n',
      c: D_BLOCK,
      d: M_BLOCK,
      e: 'theme = "plain"\n\n[labels]\n',
    };

    const manifests = {};
    for (const [key, text] of Object.entries(variants)) {
      const sub = path.join(root, key);
      const { vaultPath, siteDir, jsonConfig, finalOut } = buildE1Vault(sub);
      if (text !== null) writePackToml(siteDir, text);
      const packToml = loadPackToml(siteDir, { campaign: 'alpha' });
      const result = runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir, campaign: 'alpha', force: true, vocab: packToml.vocab });
      assert.equal(result.ok, true, `variant ${key}: ${result.ok ? '' : JSON.stringify(result.error && result.error.message)}`);
      manifests[key] = sha256Manifest(finalOut);

      assert.ok(fs.existsSync(path.join(finalOut, 'chronicle', 'log.html')), `variant ${key}: the timeline page must exist`);
      const peopleFiles = fs.readdirSync(path.join(finalOut, 'people'));
      assert.ok(peopleFiles.some((f) => f.endsWith('.html')), `variant ${key}: a lane page must exist`);

      for (const file of walkHtml(finalOut)) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /"voc"/, `variant ${key}, ${file}: no HTML may carry "voc"`);
      }
    }

    assert.ok(manifests.a, 'sanity: variant (a) produced a non-empty manifest');
    for (const key of ['b', 'c', 'd', 'e']) {
      assert.equal(manifests[key], manifests.a, `variant (${key}) must be byte-identical to (a)`);
    }
  });
});

// === E2: the vocab-vault fixture ===================================================================

function vocabConfig(root) {
  const jsonConfig = { ...require(path.join(VOCAB_VAULT, '_meta', 'scriptorium', 'vault.config.json')), vaultPath: VOCAB_VAULT };
  const finalOut = path.join(root, 'out');
  const configPath = writeConfigToml(root, { vaultPath: VOCAB_VAULT, finalOut, campaign: 'vocab' });
  return { jsonConfig, finalOut, configPath };
}

test('E2: vocab-vault builds with exit 0 and exactly one warning line (the unknown Kind "riddle")', () => {
  withScratchDir((root) => {
    const { configPath, finalOut } = vocabConfig(root);
    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'vocab');
    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);

    const warningLines = result.human.split('\n').filter((l) => l.startsWith('warning:'));
    assert.equal(warningLines.length, 1, JSON.stringify(warningLines));
    assert.match(warningLines[0], /unknown Kind "riddle"/);

    // -- timeline island -----------------------------------------------------------------------
    const chronHtml = fs.readFileSync(path.join(finalOut, 'chronicle', 'chronology.html'), 'utf8');
    const tlIslandText = chronHtml.match(/class="sc-tl-data">([\s\S]*?)<\/script>/)[1];
    const tlIsland = JSON.parse(tlIslandText);

    assert.deepEqual(tlIsland.voc, {
      labels: { learned_lens: 'What the crew found out', story_lens: 'The tale', chapter: 'Episode' },
      kinds: [
        { key: 'clash', label: 'clash', glyph: 'fight', before: false },
        { key: 'parley', label: 'parley', glyph: 'meeting', before: false },
        { key: 'omen', label: 'omen', glyph: 'M10 2 L18 18 L2 18 Z', before: false },
        { key: 'origin', label: 'origin', glyph: 'backstory', before: true },
      ],
      weights: ['footnote', 'scene', 'watershed'],
    });

    const byKind = {};
    for (const p of tlIsland.points) byKind[p.t] = p;
    assert.equal(byKind['The Old Chart'].k, 'origin');
    assert.equal(byKind['The Hiring'].k, 'parley');
    assert.equal(byKind['The Hiring'].s, 1);
    assert.equal(byKind['The Hiring'].w, 2);
    assert.equal(byKind['Dock Brawl'].k, 'clash', 'the alias "battle" must resolve to "clash"');
    assert.equal(byKind['Dock Brawl'].s, 1);
    assert.equal(byKind['Dock Brawl'].w, 3);
    assert.equal(byKind['Red Gulls'].k, 'omen');
    assert.equal(byKind['Red Gulls'].s, 2);
    assert.equal(byKind['Red Gulls'].w, 1);
    assert.equal(byKind['Stone Door'].k, '', 'the unrecognised kind "riddle" must fall back to neutral');
    assert.equal(byKind['Stone Door'].s, 2);
    assert.equal(byKind['Stone Door'].w, 2);

    assert.deepEqual(
      tlIsland.segs.map((s) => s.label),
      ['long ago', 'League 1', 'Night 3', 'League 2'],
    );

    assert.equal(tlIsland.learned.length, 1);
    assert.equal(tlIsland.learned[0].links[0][0], 'Episode I, Episode 01: Lessons Gathered');

    // -- connections lane island ----------------------------------------------------------------
    const laneHtml = fs.readFileSync(path.join(finalOut, 'people', 'sera-wick.html'), 'utf8');
    const cxIslandText = laneHtml.match(/class="sc-cx-data">([\s\S]*?)<\/script>/)[1];
    const cxIsland = JSON.parse(cxIslandText);
    assert.deepEqual(cxIsland.voc, {
      labels: { recap: 'Episode', same_recap: 'Same episode', group_npc: 'Folk' },
    });
    assert.match(laneHtml, /<h2>Ties and threads<\/h2>/);

    // -- check exits 0 -----------------------------------------------------------------------
    const checkResult = runCheckCommand({ config: configPath }, 'vocab');
    assert.equal(checkResult.exitCode, EXIT_CODES.OK, checkResult.human);
  });
});

// === E3 (P4-FR09): a withheld name used as a label ==================================================

const WITHHELD_NAME = 'Fenn Órla'; // synthetic, two-word, non-ASCII letter (Ó = 'Ó')

function buildE3Vault(root) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, 'Chronicle'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, 'People'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });

  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\nADR 0020 E3 fixture vault.\n');
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'publish-manifest.md'),
    '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Chronicle/Log.md\n',
  );

  fs.writeFileSync(
    path.join(vaultPath, 'Chronicle', 'Log.md'),
    [
      '---',
      'type: timeline',
      'title: Log',
      '---',
      '',
      '## The campaign',
      '',
      '| Title | Kind | Weight | Place | When | Real-world | What |',
      '|---|---|---|---|---|---|---|',
      '| A Quiet Row | fight | 2 | Harbour | week 1 | S1 | Nothing of note. |',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    // The file is not named "Withheld": the note's file name is itself a withheld name, and the pin's
    // stylesheet has carried a `.sheet-withheld` class since publish-v1.12.0, which the output scan
    // rightly reads as that word appearing in built output.
    path.join(vaultPath, 'People', 'Quillmarrow.md'),
    `---\ntype: npc\ntitle: ${WITHHELD_NAME}\nwithheld: true\n---\nNever meant to reach a player.\n`,
  );

  const siteDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(siteDir, { recursive: true });
  const jsonConfig = {
    siteTitle: 'E3 Vault',
    siteUrl: 'https://example.invalid',
    attachmentsDir: '_attachments',
    excludeDirs: ['_meta'],
    folderMap: { Chronicle: 'chronicle', People: 'people' },
  };
  fs.writeFileSync(path.join(siteDir, 'vault.config.json'), JSON.stringify(jsonConfig, null, 2));

  const finalOut = path.join(root, 'out');
  const configPath = writeConfigToml(root, { vaultPath, finalOut, campaign: 'e3' });
  return { vaultPath, siteDir, finalOut, configPath };
}

test('E3: a withheld name in [labels] learned_lens makes the build refuse', () => {
  withScratchDir((root) => {
    const { siteDir, configPath } = buildE3Vault(root);
    writePackToml(siteDir, `[labels]\nlearned_lens = "${WITHHELD_NAME}"\n`);

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'e3');
    assert.equal(result.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.equal(result.envelope.refusedByScan, true);

    const findings = result.envelope.outputScanFindings;
    const hit = findings.find((f) => f.data && f.data.hiddenName === WITHHELD_NAME);
    assert.ok(hit, JSON.stringify(findings));
    assert.equal(hit.outputPath, 'chronicle/log.html');
    assert.equal(hit.data.arm, 'text');
  });
});

test('E3: a withheld name in a kind\'s label also makes the build refuse', () => {
  withScratchDir((root) => {
    const { siteDir, configPath } = buildE3Vault(root);
    writePackToml(siteDir, `[[timeline.kinds]]\nkey = "fight"\nlabel = "${WITHHELD_NAME}"\n`);

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'e3');
    assert.equal(result.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.equal(result.envelope.refusedByScan, true);

    const findings = result.envelope.outputScanFindings;
    const hit = findings.find((f) => f.data && f.data.hiddenName === WITHHELD_NAME);
    assert.ok(hit, JSON.stringify(findings));
    assert.equal(hit.outputPath, 'chronicle/log.html');
    assert.equal(hit.data.arm, 'text');
  });
});

test('E3 control: a plain label gives exit 0 and the island contains it', () => {
  withScratchDir((root) => {
    const { siteDir, finalOut, configPath } = buildE3Vault(root);
    writePackToml(siteDir, '[labels]\nlearned_lens = "An ordinary label"\n');

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'e3');
    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);

    const html = fs.readFileSync(path.join(finalOut, 'chronicle', 'log.html'), 'utf8');
    assert.match(html, /An ordinary label/);
  });
});
