'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCheckContext } = require('../src/checks/context');
const { runNoManifest } = require('../src/checks/leak/l1');
const { runExcludedDirInOutput } = require('../src/checks/leak/l2');
const { runUnpublishedLink } = require('../src/checks/leak/l3');
const { runHiddenName } = require('../src/checks/leak/l4');
const { runGmHeadingSurvives } = require('../src/checks/leak/l5');
const {
  runExcludeSectionsDivergence,
  runExcludeDirsDivergence,
  runExcludeFieldsDivergence,
} = require('../src/checks/configdiv');

/*
 * One test per row of Track DEP-b's semantics table (DEP-AC-06). All but L1
 * use test/fixtures/pin-vault, built for exactly this purpose; see its
 * _meta/vault-config.md and _meta/publish-manifest.md for the setup each
 * row depends on.
 */

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const MINI_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'mini-vault-site-config.json'));

const PIN_VAULT = path.join(__dirname, 'fixtures', 'pin-vault');
const PIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'pin-vault-site-config.json'));

function pinVaultConfig(overrides = {}) {
  return { ...PIN_SITE_CONFIG, vaultPath: PIN_VAULT, ...overrides };
}

function pinContext(opts = {}) {
  return buildCheckContext({
    campaign: 'pin-vault',
    vaultPath: PIN_VAULT,
    jsonConfig: pinVaultConfig(),
    ...opts,
  });
}

// --- L1: unchanged -----------------------------------------------------

test('L1 (unchanged, build.js:780-790): player mode with no manifest fires leak/l1-no-manifest', () => {
  const ctx = buildCheckContext({
    campaign: 'mini-vault',
    vaultPath: MINI_VAULT,
    jsonConfig: { ...MINI_SITE_CONFIG, vaultPath: MINI_VAULT },
  });
  assert.equal(ctx.publishSet.manifest, null);
  assert.equal(ctx.publishSet.publishConfig.mode, 'player');
  const findings = runNoManifest(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'leak/l1-no-manifest');
});

// --- L2 ------------------------------------------------------------------

test('L2: still fires for a vault-only excluded directory (Scenes) left over from a stale build', () => {
  // A fresh build now correctly excludes Scenes (lib/build.js's scanConfigFor, Δ #209 follow-up;
  // see publish-equivalence.test.js), so this simulates the defense-in-depth case: a STALE build
  // made before the vault-side exclusion existed, with Scenes content still sitting in `out/`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-l2-sem-'));
  try {
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'index.html'), '<html></html>');
    fs.mkdirSync(path.join(out, 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(out, 'scenes', 'active-scene.html'), '<html>active</html>');

    const ctx = pinContext({ outputPath: out });
    const findings = runExcludedDirInOutput(ctx);
    const hit = findings.find((f) => f.path === 'Scenes/Active-Scene.md');
    assert.ok(hit, 'Scenes/Active-Scene.md must fire: Scenes is vault-only-excluded and contributed output');
    assert.equal(hit.severity, 'error');
    assert.match(hit.message, /Scenes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('L2: an output image under _attachments/personal/ fires via the always-excluded segment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-l2-sem-'));
  try {
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'index.html'), '<html></html>');
    fs.mkdirSync(path.join(out, 'images', 'personal'), { recursive: true });
    fs.writeFileSync(path.join(out, 'images', 'personal', 'hidden-map.png'), 'x');

    // "personal" is not in any configured excludeDirs (vault or json) for
    // this fixture — only ALWAYS_EXCLUDE_DIRS makes this fire.
    const ctx = pinContext({ outputPath: out });
    const jsonExcludeDirs = ctx.jsonConfig.excludeDirs || [];
    const vaultExcludeDirs = ctx.publishSet.publishConfig.exclude_dirs || [];
    assert.ok(!jsonExcludeDirs.includes('personal') && !vaultExcludeDirs.some((d) => d.includes('personal')));

    const findings = runExcludedDirInOutput(ctx);
    const hit = findings.find((f) => f.outputPath === 'images/personal/hidden-map.png');
    assert.ok(hit, 'the personal-dir image must fire via the always-excluded segment');
    assert.equal(hit.severity, 'error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('L2: the page arm attributes "González.md" to "gonzalez.html"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-l2-sem-'));
  try {
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'index.html'), '<html></html>');
    fs.mkdirSync(path.join(out, 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(out, 'scenes', 'gonzalez.html'), '<html>gonzalez</html>');

    const ctx = pinContext({ outputPath: out });
    // Scenes is vault-excluded, so Scenes/González.md is correctly ABSENT from
    // ctx.publishSet.publishedPages (a fresh build would not publish it either) -- it is still a
    // candidate via ctx.allCandidatePages, which is what leak/l2's own page arm uses (see its doc
    // comment: defense-in-depth against a stale build).
    const page = ctx.allCandidatePages.find((p) => p.relPath === 'Scenes/González.md');
    assert.ok(page, 'the fixture page must exist as a candidate');
    assert.equal(page.outputPath, 'scenes/gonzalez.html');
    assert.ok(
      !ctx.publishSet.publishedPages.some((p) => p.relPath === 'Scenes/González.md'),
      'Scenes is vault-excluded, so a fresh build would not actually publish this page',
    );

    const findings = runExcludedDirInOutput(ctx);
    const hit = findings.find((f) => f.path === 'Scenes/González.md');
    assert.ok(hit);
    assert.equal(hit.outputPath, 'scenes/gonzalez.html');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- L3 --------------------------------------------------------------------

test('L3: a link to a publish: false page is a finding', () => {
  const ctx = pinContext();
  const findings = runUnpublishedLink(ctx);
  const hit = findings.find((f) => f.path === 'Characters/NPCs/Alice.md' && f.data.target === 'Nobody-False');
  assert.ok(hit, 'Alice links Nobody-False, which is publish: false');
  assert.equal(hit.severity, 'warn'); // not withheld: true
});

test('L3: a gm_only edge to a withheld entity is not a finding', () => {
  const ctx = pinContext();
  const findings = runUnpublishedLink(ctx);
  const hit = findings.find((f) => f.path === 'Characters/NPCs/GmOnlyEdge.md');
  assert.equal(hit, undefined, 'the gm_only edge must not surface as an L3 finding at all');
});

test('L3: an annotated manifest entry counts as published (no finding for a link to it)', () => {
  const ctx = pinContext();
  const findings = runUnpublishedLink(ctx);
  const hit = findings.find((f) => f.data && f.data.target === 'Marisol');
  assert.equal(hit, undefined, 'Marisol is published via an annotated manifest entry ("— cleared by the GM")');
});

// #77 regression guard: extractWikiLinks(rendered.strippedBody) at src/checks/leak/l3.js's own
// call site must NEVER gain { ignoreCode: true }. resolveWikiLinks collapses an unmapped target
// to plain display text on the rendered page identically whether the [[wikilink]] was written in
// prose or inside a code span/fenced block, so a withheld name "documented" as a syntax example
// still leaks. Mutating that one call site to pass ignoreCode leaves every other test in the
// suite green (the golden-master test in test/vault-links-backcompat.test.js only protects the
// primitive's no-args default, not this call site) -- these two are the ones that catch it.
test('L3 (#77 regression guard): a withheld target referenced ONLY from inside an inline code span still fires', () => {
  const ctx = pinContext();
  const findings = runUnpublishedLink(ctx);
  const hit = findings.find((f) => f.path === 'Characters/NPCs/Code-Span-Leak.md');
  assert.ok(
    hit,
    'Code-Span-Leak.md references [[Gus-Hidden]] only inside `single backticks`; L3 must still catch it',
  );
  assert.equal(hit.data.target, 'Gus-Hidden');
  assert.equal(hit.severity, 'error'); // Gus-Hidden.md carries withheld: true
});

test('L3 (#77 regression guard): a withheld target referenced ONLY from inside a fenced code block still fires', () => {
  const ctx = pinContext();
  const findings = runUnpublishedLink(ctx);
  const hit = findings.find((f) => f.path === 'Characters/NPCs/Fenced-Block-Link.md');
  assert.ok(
    hit,
    'Fenced-Block-Link.md references [[Gus-Hidden]] only inside a ``` fenced block; L3 must still catch it',
  );
  assert.equal(hit.data.target, 'Gus-Hidden');
  assert.equal(hit.severity, 'error');
});

// --- L4 (frontmatter arm) ---------------------------------------------------

test('L4: a withheld name reachable only via a gm_only edge gives no finding', () => {
  const ctx = pinContext();
  const findings = runHiddenName(ctx);
  const hit = findings.find((f) => f.path === 'Characters/NPCs/GmOnlyEdge.md');
  assert.equal(hit, undefined);
});

test('L4: a withheld name reachable only via publish_exclude_fields gives no finding', () => {
  const ctx = pinContext();
  const findings = runHiddenName(ctx);
  const hit = findings.find((f) => f.path === 'Characters/NPCs/ExcludeFieldNPC.md');
  assert.equal(hit, undefined);
});

test('L4: the same withheld name in a normal (non-excluded) field gives a finding', () => {
  const ctx = pinContext();
  const findings = runHiddenName(ctx);
  const hit = findings.find((f) => f.path === 'Characters/NPCs/Callout-Page.md');
  assert.ok(hit, 'Callout-Page.md carries "Gus Marzone" in an un-excluded "summary" field');
  assert.equal(hit.data.hiddenName, 'Gus Marzone');
  assert.match(hit.message, /published frontmatter/);
});

// --- L5 ----------------------------------------------------------------

test('L5: an orphan <!-- /spoiler --> closer fires', () => {
  const ctx = pinContext();
  const findings = runGmHeadingSurvives(ctx);
  const hit = findings.find(
    (f) => f.path === 'Characters/NPCs/Spoiler-Fences.md' && /without a matching/.test(f.message),
  );
  assert.ok(hit);
});

test('L5: an unclosed spoiler fires', () => {
  const ctx = pinContext();
  const findings = runGmHeadingSurvives(ctx);
  const hit = findings.find(
    (f) => f.path === 'Characters/NPCs/Spoiler-Fences.md' && /unclosed <!-- spoiler -->/.test(f.message),
  );
  assert.ok(hit);
});

test('L5: an unclosed comment fires', () => {
  const ctx = pinContext();
  const findings = runGmHeadingSurvives(ctx);
  const hit = findings.find(
    (f) => f.path === 'Characters/NPCs/Comment-Fences.md' && /unclosed <!-- comment/.test(f.message),
  );
  assert.ok(hit);
});

test('L5: "## GM Notes (spoilers)" survives filterSections\' exact match and fires', () => {
  const ctx = pinContext();
  const findings = runGmHeadingSurvives(ctx);
  const hit = findings.find(
    (f) => f.path === 'Characters/NPCs/Spoiler-Fences.md' && f.data && f.data.heading === 'GM Notes (spoilers)',
  );
  assert.ok(hit);
});

// --- L6 sections -------------------------------------------------------

test('L6 sections: a pin default missing from the effective union fires (WARN, or ERROR when it renders)', () => {
  const ctx = pinContext();
  const findings = runExcludeSectionsDivergence(ctx);
  const dmNotes = findings.find((f) => f.data.section === 'DM Notes');
  assert.ok(dmNotes, 'DM Notes is a pin default missing from this fixture\'s vault-supplied list');
  assert.equal(dmNotes.severity, 'error', 'Locations/Town.md renders a literal "## DM Notes" heading');
  assert.equal(dmNotes.data.appliesInOutput, true);

  const playerNotes = findings.find((f) => f.data.section === 'Player Notes');
  assert.ok(playerNotes, 'Player Notes is also a missing default, but nothing renders it');
  assert.equal(playerNotes.severity, 'warn');
});

test('L6 sections: "Needs" in JSON only is no finding (it is not a pin default)', () => {
  const ctx = pinContext();
  const findings = runExcludeSectionsDivergence(ctx);
  assert.ok(!findings.some((f) => f.data.section === 'Needs'));
});

test('L6 sections: when neither source gives a list, there are no findings', () => {
  // mini-vault's own _meta/vault-config.md DOES supply exclude_sections
  // (["GM Notes"]), which alone is still "either source"; use a scratch
  // copy with the publish block's exclude_sections stripped, and a
  // jsonConfig with none either, so neither surface supplies a list.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-l6-none-'));
  try {
    const vaultCopy = path.join(scratch, 'vault');
    fs.cpSync(MINI_VAULT, vaultCopy, { recursive: true });
    fs.writeFileSync(
      path.join(vaultCopy, '_meta', 'vault-config.md'),
      '---\ntype: meta\npublish:\n  mode: player\n---\n\nNo publish.exclude_sections here.\n',
    );
    const ctx = buildCheckContext({
      campaign: 'no-list',
      vaultPath: vaultCopy,
      jsonConfig: { ...MINI_SITE_CONFIG, vaultPath: vaultCopy, excludeSections: undefined },
    });
    assert.equal(ctx.publishSet.configSources.vault.exclude_sections, undefined);
    assert.equal(ctx.publishSet.configSources.json.excludeSections, undefined);
    assert.deepEqual(runExcludeSectionsDivergence(ctx), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// --- L6 dirs -------------------------------------------------------------

test('L6 dirs: the vault-side list comes from configSources.vault.exclude_dirs, never the merged union', () => {
  const ctx = pinContext();
  assert.deepEqual(ctx.publishSet.configSources.vault.exclude_dirs, ['Scenes']);
  // the merged union additionally carries the pin defaults (_meta, _Templates) —
  // those must NOT be treated as vault entries by the divergence check.
  assert.ok(ctx.publishSet.publishConfig.exclude_dirs.includes('_meta'));

  const findings = runExcludeDirsDivergence(ctx);
  assert.ok(
    !findings.some((f) => f.data && f.data.dir === '_meta' && !f.data.jsonOnly),
    '_meta is a pin default, not a vault-declared entry, so it must never appear as a vault-side divergence',
  );
  const scenesHit = findings.find((f) => f.data && f.data.dir === 'Scenes' && !f.data.jsonOnly);
  assert.ok(scenesHit, 'Scenes is vault-declared and contributed real output, so it must fire');
  assert.equal(scenesHit.severity, 'error');
});

// --- L6 fields -------------------------------------------------------------

test('L6 fields: pin defaults (including gm_notes and prep_notes) missing from the union fire WARN', () => {
  const ctx = pinContext();
  const findings = runExcludeFieldsDivergence(ctx);
  const fields = findings.map((f) => f.data.field).sort();
  // 'reliability' is a new PUBLISH_DEFAULTS.exclude_fields entry at publish-v1.11.40
  // (lib/config.js:18, the party-board/In Memoriam feature, Δ); everything else unchanged.
  assert.deepEqual(fields, ['current_plan', 'gm_notes', 'plan_progress', 'prep_notes', 'reliability']);
  for (const f of findings) assert.equal(f.severity, 'warn');
});
