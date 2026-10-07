'use strict';

/*
 * ADR 0036 (docs/agent-runs/r2-session-wrap-architect-2026-09-30.md), SD-5: a published hub's
 * body reads as empty to the body leak checks (L3/L4/L5, configdiv's headingSurvives) once it
 * pairs with a published Wrap-Up -- frontmatter is unaffected, every other page is checked exactly
 * as today, and a Wrap-Up itself is never weakened.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');
const { runBuildCommand } = require('../src/cli/build');
const { runCheckCommand } = require('../src/cli/check');

const CHAIN_VAULT = path.join(__dirname, 'fixtures', 'session-chain-vault');
const CHAIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'session-chain-vault-site-config.json'));

const SENTINELS = ['R2SENTINEL-SCENE', 'R2SENTINEL-DOCS', 'R2SENTINEL-HUB-BODY', 'R2SENTINEL-WRAP-GM'];

function writeConfigToml(configPath, { vaultDir, siteConfigPath, outDir, campaign }) {
  fs.writeFileSync(
    configPath,
    [
      'config_version = 1',
      `default_campaign = "${campaign}"`,
      '',
      `[campaigns.${campaign}]`,
      `vault = '${vaultDir}'`,
      `site_config = '${siteConfigPath}'`,
      `output = '${outDir}'`,
      '',
    ].join('\n'),
  );
}

function variant(scratch, campaign, { mutate, siteConfig = CHAIN_SITE_CONFIG } = {}) {
  const dir = path.join(scratch, campaign);
  const vaultDir = path.join(dir, 'vault');
  fs.cpSync(CHAIN_VAULT, vaultDir, { recursive: true });
  if (mutate) mutate(vaultDir);
  // `outputDir` is dropped: it exists only for src/build/plan.js's siteConfigOutputDirCollision
  // guard, and every variant here writes to its own scratch `out/` anyway -- carrying the
  // fixture's own relative `./out` forward would collide with config.toml's `output` and refuse
  // every build with exit 2 for a reason unrelated to what each test is proving.
  const { outputDir, ...siteConfigRest } = siteConfig;
  const siteConfigPath = path.join(dir, 'vault.config.json');
  fs.writeFileSync(siteConfigPath, JSON.stringify({ ...siteConfigRest, vaultPath: vaultDir }));
  const configPath = path.join(dir, 'config.toml');
  const outDir = path.join(dir, 'out');
  writeConfigToml(configPath, { vaultDir, siteConfigPath, outDir, campaign });
  return { vaultDir, siteConfigPath, configPath, outDir };
}

function checkOf(v, campaign) {
  return runCheckCommand({ config: v.configPath }, campaign);
}

function findingsOf(result, id) {
  return result.envelope.findings.filter((f) => f.id === id);
}

function readTree(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, entryRel);
      else out[entryRel] = fs.readFileSync(full, 'utf8');
    }
  })(dir, '');
  return out;
}

// ---------------------------------------------------------------------------
// (b) through the check CLI: 0 findings for Session 2; build exits 0
// ---------------------------------------------------------------------------

test('(b): 0 leak findings for Sessions/Session 2.md; build exits 0 with 0 output-scan findings', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-b-'));
  try {
    const v = variant(scratch, 'b');
    const result = checkOf(v, 'b');
    const forSession2 = (id) => findingsOf(result, id).filter((f) => f.path === 'Sessions/Session 2.md');
    assert.deepEqual(forSession2('leak/l4-hidden-name'), []);
    assert.deepEqual(forSession2('leak/l3-unpublished-link'), []);
    assert.deepEqual(forSession2('leak/l5-gm-heading-survives'), []);

    const build = runBuildCommand({ config: v.configPath, force: true }, 'b');
    assert.equal(build.exitCode, 0, build.human);
    assert.deepEqual(findingsOf({ envelope: { findings: build.envelope.outputScanFindings || [] } }, 'leak/l4-output-name'), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unpaired control: every finding fires; build exits 2; --force reports the output-scan hit
// ---------------------------------------------------------------------------

function removeHubLink(vaultDir) {
  const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
  let hub = fs.readFileSync(hubPath, 'utf8');
  hub = hub.replace(/documents:\n {2}wrap_up: "\[\[Session 2 Wrap-Up\]\]"\n {2}prep: "R2SENTINEL-DOCS"\n/, '');
  fs.writeFileSync(hubPath, hub);
}

test('unpaired control: L3/L4/L5 all fire for the unpaired hub; build exits 2; --force reports the output-scan finding', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-unpaired-'));
  try {
    const v = variant(scratch, 'unpaired', { mutate: removeHubLink });
    const result = checkOf(v, 'unpaired');
    const forSession2 = (id) => findingsOf(result, id).filter((f) => f.path === 'Sessions/Session 2.md');
    assert.ok(forSession2('leak/l4-hidden-name').length > 0, 'L4 must fire on the unpaired hub body');
    assert.ok(forSession2('leak/l3-unpublished-link').length > 0, 'L3 must fire on the unpaired hub body');
    assert.ok(forSession2('leak/l5-gm-heading-survives').length > 0, 'L5 must fire on "GM Notes (prep)"');

    const build = runBuildCommand({ config: v.configPath }, 'unpaired');
    assert.equal(build.exitCode, 2, build.human);

    const forced = runBuildCommand({ config: v.configPath, force: true }, 'unpaired');
    assert.ok(forced.human.includes('output-leak scan') || forced.human.includes('OVERRIDDEN'), forced.human);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// configdiv: WARN at (b) (body withheld, so the heading never renders); ERROR when unpaired
// ---------------------------------------------------------------------------

function addDmNotesDivergence(vaultDir) {
  const configPath = path.join(vaultDir, '_meta', 'vault-config.md');
  let cfg = fs.readFileSync(configPath, 'utf8');
  cfg = cfg.replace('publish:\n  mode: gm\n', 'publish:\n  mode: gm\n  exclude_sections: ["GM Notes"]\n');
  fs.writeFileSync(configPath, cfg);

  const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
  let hub = fs.readFileSync(hubPath, 'utf8');
  hub += '\n## DM Notes\n\nStaging notes that a divergent exclude_sections list would otherwise drop.\n';
  fs.writeFileSync(hubPath, hub);
}

test('configdiv (b): the exclude_sections divergence on "DM Notes" is WARN because the hub body is withheld', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-configdiv-b-'));
  try {
    const v = variant(scratch, 'configdiv-b', { mutate: addDmNotesDivergence });
    const result = checkOf(v, 'configdiv-b');
    const hits = findingsOf(result, 'config/exclude-sections-divergence').filter((f) => f.data.section === 'DM Notes');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].severity, 'warn');
    assert.equal(hits[0].data.appliesInOutput, false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('configdiv (unpaired): the same divergence is ERROR because the hub body actually renders', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-configdiv-unpaired-'));
  try {
    const v = variant(scratch, 'configdiv-unpaired', {
      mutate: (vaultDir) => {
        addDmNotesDivergence(vaultDir);
        removeHubLink(vaultDir);
      },
    });
    const result = checkOf(v, 'configdiv-unpaired');
    const hits = findingsOf(result, 'config/exclude-sections-divergence').filter((f) => f.data.section === 'DM Notes');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].severity, 'error');
    assert.equal(hits[0].data.appliesInOutput, true);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Frontmatter arm: a withheld name in scenes: still gives an L4 finding (SD-6 residual)
// ---------------------------------------------------------------------------

test('frontmatter arm: a withheld name added to the hub\'s scenes: still gives an L4 finding, arm "frontmatter"', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-frontmatter-'));
  try {
    const v = variant(scratch, 'frontmatter-arm', {
      mutate: (vaultDir) => {
        const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
        let hub = fs.readFileSync(hubPath, 'utf8');
        hub = hub.replace('scenes:\n  - "R2SENTINEL-SCENE"', 'scenes:\n  - "R2SENTINEL-SCENE"\n  - "Brannoc Vey"');
        fs.writeFileSync(hubPath, hub);
      },
    });
    const result = checkOf(v, 'frontmatter-arm');
    const hits = findingsOf(result, 'leak/l4-hidden-name').filter((f) => f.path === 'Sessions/Session 2.md' && f.data.arm === 'frontmatter');
    assert.equal(hits.length, 1, JSON.stringify(hits));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c): a withheld name planted in Session 1's unpaired body gives a finding
// ---------------------------------------------------------------------------

test('(c): a withheld name planted in Session 1\'s (now unpaired) body gives an L4 finding', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-c-'));
  try {
    const v = variant(scratch, 'c', {
      mutate: (vaultDir) => {
        fs.rmSync(path.join(vaultDir, 'WrapUps', 'Session 1 Wrap-Up.md'));
        const hubPath = path.join(vaultDir, 'Sessions', 'Session 1.md');
        let hub = fs.readFileSync(hubPath, 'utf8');
        hub = hub.replace(/documents:\n {2}wrap_up: "\[\[Session 1 Wrap-Up\]\]"\n/, '');
        hub += '\nPlanted for the leak: [[Brannoc Vey]] is mentioned here.\n';
        fs.writeFileSync(hubPath, hub);
      },
    });
    const result = checkOf(v, 'c');
    const hits = findingsOf(result, 'leak/l4-hidden-name').filter((f) => f.path === 'Sessions/Session 1.md');
    assert.ok(hits.length > 0, 'the unpaired Session 1 body must leak the planted name');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FR-10: Wrap-Ups are ordinary published pages -- nothing weakens a check on them
// ---------------------------------------------------------------------------

test('AC-06: L5 fires on the Wrap-Up\'s novel "GM Notes (spoilers)" heading', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-ac06-'));
  try {
    const v = variant(scratch, 'ac06', {
      mutate: (vaultDir) => {
        const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
        let wrap = fs.readFileSync(wrapPath, 'utf8');
        wrap += '\n## GM Notes (spoilers)\n\nThis must never publish.\n';
        fs.writeFileSync(wrapPath, wrap);
      },
    });
    const result = checkOf(v, 'ac06');
    const hits = findingsOf(result, 'leak/l5-gm-heading-survives').filter((f) => f.path === 'WrapUps/Session 2 Wrap-Up.md');
    assert.ok(hits.length > 0, 'L5 must still fire on a Wrap-Up page');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('FR-10: a withheld name in a Wrap-Up body gives a finding outside a gm-only fence, and none inside it', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-wrapup-fence-'));
  try {
    const outside = variant(scratch, 'wrapup-outside', {
      mutate: (vaultDir) => {
        const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
        let wrap = fs.readFileSync(wrapPath, 'utf8');
        // Inserted before "## GM Notes" (a pin default excluded section), so this really is in
        // the Wrap-Up's own published prose, not accidentally swallowed by that section.
        wrap = wrap.replace('## GM Notes', 'Named in the open: [[Brannoc Vey]].\n\n## GM Notes');
        fs.writeFileSync(wrapPath, wrap);
      },
    });
    const outsideResult = checkOf(outside, 'wrapup-outside');
    const outsideHits = findingsOf(outsideResult, 'leak/l4-hidden-name').filter((f) => f.path === 'WrapUps/Session 2 Wrap-Up.md');
    assert.ok(outsideHits.length > 0, 'a withheld name outside a fence must leak');

    const inside = variant(scratch, 'wrapup-inside', {
      mutate: (vaultDir) => {
        const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
        let wrap = fs.readFileSync(wrapPath, 'utf8');
        wrap = wrap.replace('## GM Notes', '<!-- gm-only -->\nFenced: [[Brannoc Vey]].\n<!-- /gm-only -->\n\n## GM Notes');
        fs.writeFileSync(wrapPath, wrap);
      },
    });
    const insideResult = checkOf(inside, 'wrapup-inside');
    const insideHits = findingsOf(insideResult, 'leak/l4-hidden-name').filter((f) => f.path === 'WrapUps/Session 2 Wrap-Up.md');
    assert.deepEqual(insideHits, []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('FR-10: a withheld name in gm_notes: (a pin default exclusion) gives none; in an un-excluded field gives a finding', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-wrapup-field-'));
  try {
    const excluded = variant(scratch, 'wrapup-field-excluded', {
      mutate: (vaultDir) => {
        const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
        let wrap = fs.readFileSync(wrapPath, 'utf8');
        wrap = wrap.replace('---\ntype: session_wrap', '---\ntype: session_wrap\ngm_notes: "Brannoc Vey did it"');
        fs.writeFileSync(wrapPath, wrap);
      },
    });
    const excludedResult = checkOf(excluded, 'wrapup-field-excluded');
    const excludedHits = findingsOf(excludedResult, 'leak/l4-hidden-name').filter((f) => f.path === 'WrapUps/Session 2 Wrap-Up.md' && f.data.arm === 'frontmatter');
    assert.deepEqual(excludedHits, []);

    const notExcluded = variant(scratch, 'wrapup-field-open', {
      mutate: (vaultDir) => {
        const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
        let wrap = fs.readFileSync(wrapPath, 'utf8');
        wrap = wrap.replace('---\ntype: session_wrap', '---\ntype: session_wrap\ncustom_notes: "Brannoc Vey did it"');
        fs.writeFileSync(wrapPath, wrap);
      },
    });
    const openResult = checkOf(notExcluded, 'wrapup-field-open');
    const openHits = findingsOf(openResult, 'leak/l4-hidden-name').filter((f) => f.path === 'WrapUps/Session 2 Wrap-Up.md' && f.data.arm === 'frontmatter');
    assert.ok(openHits.length > 0, 'a withheld name in a field that is not excluded must leak');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('(d2) stub: a withheld name outside the included sections gives none', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-stub-'));
  try {
    const v = variant(scratch, 'stub', {
      mutate: (vaultDir) => {
        const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
        let wrap = fs.readFileSync(wrapPath, 'utf8');
        wrap = wrap.replace(
          '---\ntype: session_wrap',
          '---\ntype: session_wrap\npublish: stub\npublish_include_sections: ["Narrative Recap"]',
        );
        wrap += '\n## Excluded Section\n\nNot included: [[Brannoc Vey]].\n';
        fs.writeFileSync(wrapPath, wrap);
      },
    });
    const result = checkOf(v, 'stub');
    const hits = findingsOf(result, 'leak/l4-hidden-name').filter((f) => f.path === 'WrapUps/Session 2 Wrap-Up.md');
    assert.deepEqual(hits, []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FR-11: no R2SENTINEL-* token anywhere in the built (b) tree
// ---------------------------------------------------------------------------

test('FR-11: a (b) build contains 0 R2SENTINEL-* tokens anywhere in the tree', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-fr11-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(scratch, 'out');
    const result = runAtomicBuild({
      vaultPath: CHAIN_VAULT,
      userJsonConfig: { ...CHAIN_SITE_CONFIG, vaultPath: CHAIN_VAULT },
      finalOut,
      siteDir,
      campaign: 'fr11-b',
      force: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));
    const tree = readTree(finalOut);
    for (const [file, content] of Object.entries(tree)) {
      for (const sentinel of SENTINELS) {
        assert.ok(!content.includes(sentinel), `${file} must not contain ${sentinel}`);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('FR-11: in the unpaired control, R2SENTINEL-HUB-BODY is present in the hub page and in search-index.json', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-fr11-unpaired-'));
  try {
    const vaultDir = path.join(scratch, 'vault');
    fs.cpSync(CHAIN_VAULT, vaultDir, { recursive: true });
    removeHubLink(vaultDir);
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(scratch, 'out');
    const result = runAtomicBuild({
      vaultPath: vaultDir,
      userJsonConfig: { ...CHAIN_SITE_CONFIG, vaultPath: vaultDir },
      finalOut,
      siteDir,
      campaign: 'fr11-unpaired',
      force: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));
    const hubHtml = fs.readFileSync(path.join(finalOut, 'sessions', 'session-2.html'), 'utf8');
    assert.ok(hubHtml.includes('R2SENTINEL-HUB-BODY'));
    // lunr's default tokenizer splits on the hyphens, so the indexed term is the lower-cased,
    // stemmed fragment, not the literal sentinel string.
    const searchIndex = fs.readFileSync(path.join(finalOut, 'search-index.json'), 'utf8');
    assert.ok(searchIndex.toLowerCase().includes('r2sentinel'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Symlink variant: fail-safe -- suppression switches off, so L4 still fires (fail-safe, never
// fail-open)
// ---------------------------------------------------------------------------

test('symlink variant: the fail-safe keeps L4 firing on Session 2\'s hub body', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-leak-symlink-'));
  try {
    const vaultDir = path.join(scratch, 'vault');
    fs.cpSync(CHAIN_VAULT, vaultDir, { recursive: true });
    fs.mkdirSync(path.join(vaultDir, 'Notes'));
    const outsideFile = path.join(scratch, 'Outside.md');
    fs.writeFileSync(outsideFile, '---\ntype: npc\n---\n');
    try {
      fs.symlinkSync(outsideFile, path.join(vaultDir, 'Notes', 'Link.md'));
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlink creation refused by the sandbox (EPERM)');
        return;
      }
      throw err;
    }

    const siteConfigPath = path.join(scratch, 'vault.config.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify({ ...CHAIN_SITE_CONFIG, vaultPath: vaultDir }));
    const configPath = path.join(scratch, 'config.toml');
    writeConfigToml(configPath, { vaultDir, siteConfigPath, outDir: path.join(scratch, 'out'), campaign: 'symlink' });

    const result = checkOf({ configPath }, 'symlink');
    const hits = findingsOf(result, 'leak/l4-hidden-name').filter((f) => f.path === 'Sessions/Session 2.md');
    assert.ok(hits.length > 0, 'the fail-safe must keep checking the hub body when the note sources might diverge');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
