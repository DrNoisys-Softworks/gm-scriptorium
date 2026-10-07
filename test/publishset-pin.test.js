'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pinned = require('../src/generator/pinned');
const { loadPublishConfig, scanForPublish, computePublishedSet } = require('../src/vault/publishset');
// Test-only: getCanonStatus is not part of the facade's export list (only
// decidePage/publishesPage/ALWAYS_EXCLUDE_DIRS from publish-decision.js
// are), but its precedence rule is directly relevant to DRAFT_EXCLUDED and
// is easiest to pin down against the pin's own implementation directly.
const { getCanonStatus } = require('gm-apprentice-publish/lib/templates/base');

function basePublishConfig(overrides = {}) {
  return {
    mode: 'player',
    exclude_drafts: false,
    exclude_callouts: false,
    exclude_sections: [],
    exclude_fields: [],
    exclude_dirs: [],
    overrides: { fields: {} },
    ...overrides,
  };
}

function page(frontmatter, outputPath = 'characters/npcs/x.html') {
  return { frontmatter, outputPath };
}

// --- FR-DEP-13a/b: one test per verdict code --------------------------------

test('decidePage: DIR_ALWAYS_EXCLUDED for a path under an always-excluded segment', () => {
  const v = pinned.decidePage(page({ type: 'npc' }), {
    rel: 'Locations/personal/Hideout.md',
    publishConfig: basePublishConfig(),
    manifest: null,
  });
  assert.equal(v.code, 'DIR_ALWAYS_EXCLUDED');
  assert.equal(v.bucket, 'exclude');
});

test('decidePage: DIR_UNMAPPED when folderMapped is false', () => {
  const v = pinned.decidePage(page({ type: 'npc' }), {
    rel: 'Random/Unmapped.md',
    publishConfig: basePublishConfig(),
    manifest: null,
    folderMapped: false,
  });
  assert.equal(v.code, 'DIR_UNMAPPED');
  assert.equal(v.bucket, 'decide');
});

test('decidePage: NO_TYPE when frontmatter has no type (the scan itself never hands this through in practice)', () => {
  const v = pinned.decidePage({ frontmatter: {}, outputPath: null }, {
    rel: 'Characters/NPCs/Untyped.md',
    publishConfig: basePublishConfig(),
    manifest: null,
  });
  assert.equal(v.code, 'NO_TYPE');
  assert.equal(v.bucket, 'decide');
});

test('decidePage: STORY_COMPANION only when a pageIndex is supplied (the build itself never supplies one)', () => {
  // The NO_TYPE gate runs BEFORE the story-companion check (publish-decision.js's
  // evaluation order), so the story file's own frontmatter still needs a `type`
  // to get past it before STORY_COMPANION can override it.
  const storyFile = page({ type: 'character-story' }, null);
  const pcPage = { frontmatter: { type: 'pc' }, displayTitle: 'Rowan', title: 'Rowan', outputPath: 'characters/pcs/rowan.html' };
  const pageIndex = new Map([['Characters/PCs/Rowan.md', pcPage]]);
  const v = pinned.decidePage(storyFile, {
    rel: 'Characters/PCs/Rowan_Story.md',
    publishConfig: basePublishConfig(),
    manifest: null,
    pageIndex,
  });
  assert.equal(v.code, 'STORY_COMPANION');
  assert.equal(v.bucket, 'publish');
  assert.equal(v.outputPath, null);

  // Without pageIndex (how src/vault/publishset.js actually calls it), the
  // same rel falls through to an ordinary verdict, never STORY_COMPANION —
  // matching Track DEP-b's Risk area note, and why pairStoryFiles splices a
  // PC's _Story.md out of the page list before the verdict loop ever runs.
  const v2 = pinned.decidePage(storyFile, {
    rel: 'Characters/PCs/Rowan_Story.md',
    publishConfig: basePublishConfig(),
    manifest: null,
  });
  assert.notEqual(v2.code, 'STORY_COMPANION');
});

test('decidePage: DRAFT_EXCLUDED fires regardless of manifest listing, and getCanonStatus prefers canon_status', () => {
  const fm = { type: 'npc', canon_status: 'DRAFT', source_confidence: 'CANON' };
  assert.equal(getCanonStatus(fm), 'DRAFT', 'canon_status must win over source_confidence');
  const manifest = { publishing: ['Characters/NPCs/X.md'], excluded: [], needsDecision: [] };
  const v = pinned.decidePage(page(fm), {
    rel: 'Characters/NPCs/X.md',
    publishConfig: basePublishConfig({ exclude_drafts: true }),
    manifest,
  });
  assert.equal(v.code, 'DRAFT_EXCLUDED');
});

test('decidePage: AUTO_EXCLUDED_STATUS/STAGE/SOURCE, each only when unlisted and mode !== full', () => {
  const cases = [
    [{ type: 'npc', status: 'planned' }, 'AUTO_EXCLUDED_STATUS'],
    [{ type: 'npc', stage: 'outline' }, 'AUTO_EXCLUDED_STAGE'],
    [{ type: 'npc', source: 'prep' }, 'AUTO_EXCLUDED_SOURCE'],
  ];
  for (const [fm, code] of cases) {
    const v = pinned.decidePage(page(fm), {
      rel: 'Characters/NPCs/Auto.md',
      publishConfig: basePublishConfig(),
      manifest: null,
    });
    assert.equal(v.code, code);
  }
});

test('decidePage: SCENE_CUT_SKIPPED for a scene with status cut or skipped, unlisted', () => {
  const v = pinned.decidePage(page({ type: 'scene', status: 'cut' }), {
    rel: 'Scenes/Cut.md',
    publishConfig: basePublishConfig(),
    manifest: null,
  });
  assert.equal(v.code, 'SCENE_CUT_SKIPPED');
});

test('decidePage: MANIFEST_EXCLUDED / MANIFEST_NEEDS_DECISION / MANIFEST_UNLISTED in player mode with a manifest', () => {
  const manifest = {
    publishing: [],
    excluded: ['Characters/NPCs/Excluded.md'],
    needsDecision: ['Characters/NPCs/Needs.md'],
  };
  const excluded = pinned.decidePage(page({ type: 'npc' }), {
    rel: 'Characters/NPCs/Excluded.md',
    publishConfig: basePublishConfig(),
    manifest,
  });
  assert.equal(excluded.code, 'MANIFEST_EXCLUDED');

  const needs = pinned.decidePage(page({ type: 'npc' }), {
    rel: 'Characters/NPCs/Needs.md',
    publishConfig: basePublishConfig(),
    manifest,
  });
  assert.equal(needs.code, 'MANIFEST_NEEDS_DECISION');

  const unlisted = pinned.decidePage(page({ type: 'npc' }), {
    rel: 'Characters/NPCs/Unlisted.md',
    publishConfig: basePublishConfig(),
    manifest,
  });
  assert.equal(unlisted.code, 'MANIFEST_UNLISTED');
});

test('decidePage: PUBLISH_FALSE / PUBLISH_NONE always win, even for a manifest-listed page', () => {
  const manifest = { publishing: ['Characters/NPCs/A.md', 'Characters/NPCs/B.md'], excluded: [], needsDecision: [] };
  const a = pinned.decidePage(page({ type: 'npc', publish: false }), {
    rel: 'Characters/NPCs/A.md',
    publishConfig: basePublishConfig(),
    manifest,
  });
  assert.equal(a.code, 'PUBLISH_FALSE');
  const b = pinned.decidePage(page({ type: 'npc', publish: 'none' }), {
    rel: 'Characters/NPCs/B.md',
    publishConfig: basePublishConfig(),
    manifest,
  });
  assert.equal(b.code, 'PUBLISH_NONE');
});

test('decidePage: SUPERSEDED_NO_TARGET is the one "decide" the build still publishes', () => {
  const manifest = { publishing: ['Characters/NPCs/Vex.md'], excluded: [], needsDecision: [] };
  const v = pinned.decidePage(page({ type: 'npc', canon_status: 'SUPERSEDED' }), {
    rel: 'Characters/NPCs/Vex.md',
    publishConfig: basePublishConfig(),
    manifest,
  });
  assert.equal(v.code, 'SUPERSEDED_NO_TARGET');
  assert.equal(pinned.publishesPage(v), true);
});

test('decidePage: OK, both from a manifest listing and from full mode with no manifest', () => {
  const manifest = { publishing: ['Characters/NPCs/A.md'], excluded: [], needsDecision: [] };
  const listed = pinned.decidePage(page({ type: 'npc' }), {
    rel: 'Characters/NPCs/A.md',
    publishConfig: basePublishConfig(),
    manifest,
  });
  assert.equal(listed.code, 'OK');
  assert.equal(listed.reason, 'manifest: Publishing');

  const full = pinned.decidePage(page({ type: 'npc' }), {
    rel: 'Characters/NPCs/Anything.md',
    publishConfig: basePublishConfig({ mode: 'full' }),
    manifest: null,
  });
  assert.equal(full.code, 'OK');
});

// --- Manifest parsing (parseManifest, required unmodified) -----------------

test('parseManifest: the em dash, en dash and double-hyphen annotation forms all strip to the same path', () => {
  const md = [
    '## Publishing',
    '',
    '- [x] Characters/NPCs/A.md — approved',
    '- [x] Characters/NPCs/B.md – approved',
    '- [x] Characters/NPCs/C.md -- approved',
  ].join('\n');
  const result = pinned.parseManifest(md);
  assert.deepEqual(result.publishing, ['Characters/NPCs/A.md', 'Characters/NPCs/B.md', 'Characters/NPCs/C.md']);
});

test('parseManifest: a dash inside the filename itself is not mistaken for an annotation', () => {
  const md = ['## Publishing', '', '- [x] Items/Six — Field Sundries.md'].join('\n');
  const result = pinned.parseManifest(md);
  assert.deepEqual(result.publishing, ['Items/Six — Field Sundries.md']);
});

test('parseManifest: an NFD-typed manifest entry is canonicalized to NFC', () => {
  const nfd = 'Characters/NPCs/González.md'; // e + combining acute
  const nfc = 'Characters/NPCs/González.md';
  const md = `## Publishing\n\n- [x] ${nfd}\n`;
  const result = pinned.parseManifest(md);
  assert.deepEqual(result.publishing, [nfc]);
});

test('parseManifest: both Excluded shapes (checkbox, and grouped "Reason:" bullets)', () => {
  const md = [
    '## Excluded',
    '',
    '- [x] Characters/NPCs/Checkbox.md — no longer relevant',
    '- Reason: retired',
    '  - Characters/NPCs/Grouped.md',
  ].join('\n');
  const result = pinned.parseManifest(md);
  assert.deepEqual(result.excluded, ['Characters/NPCs/Checkbox.md', 'Characters/NPCs/Grouped.md']);
});

// --- config merge (loadPublishConfig, ported subset) ------------------------

function writeVaultConfig(vaultDir, publishBlockYaml) {
  fs.mkdirSync(path.join(vaultDir, '_meta'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, '_meta', 'vault-config.md'),
    `---\ntype: meta\npublish:\n${publishBlockYaml}\n---\n\nfixture\n`,
  );
}

function withTmpVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-publishset-pin-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('loadPublishConfig: exclude_sections/fields/dirs are a real union of vault + json, case-insensitively deduped', () => {
  withTmpVault((vaultDir) => {
    writeVaultConfig(vaultDir, '  mode: player\n  exclude_sections:\n    - "gm notes"\n    - Secrets\n');
    const { publishConfig } = loadPublishConfig(vaultDir, { excludeSections: ['GM Notes', 'Extra'] });
    assert.deepEqual(publishConfig.exclude_sections, ['gm notes', 'Secrets', 'Extra']);
  });
});

test('loadPublishConfig: defaults apply only when NEITHER source supplies a list', () => {
  withTmpVault((vaultDir) => {
    writeVaultConfig(vaultDir, '  mode: player\n');
    const { publishConfig } = loadPublishConfig(vaultDir, {});
    assert.deepEqual(publishConfig.exclude_sections, pinned.PUBLISH_DEFAULTS.exclude_sections);
    assert.deepEqual(publishConfig.exclude_fields, pinned.PUBLISH_DEFAULTS.exclude_fields);
    assert.deepEqual(publishConfig.exclude_dirs, pinned.PUBLISH_DEFAULTS.exclude_dirs);
  });
});

test('loadPublishConfig: exclude_callouts passthrough, publish block over jsonConfig over the default', () => {
  withTmpVault((vaultDir) => {
    writeVaultConfig(vaultDir, '  mode: player\n  exclude_callouts: true\n');
    const { publishConfig } = loadPublishConfig(vaultDir, { excludeCallouts: false });
    assert.equal(publishConfig.exclude_callouts, true, 'the publish block wins over the jsonConfig fallback');

    writeVaultConfig(vaultDir, '  mode: player\n');
    const { publishConfig: pc2 } = loadPublishConfig(vaultDir, { excludeCallouts: true });
    assert.equal(pc2.exclude_callouts, true, 'jsonConfig is the fallback when the publish block omits it');

    const { publishConfig: pc3 } = loadPublishConfig(vaultDir, {});
    assert.equal(pc3.exclude_callouts, pinned.PUBLISH_DEFAULTS.exclude_callouts);
  });
});

test('loadPublishConfig: a malformed overrides.fields entry is dropped, not applied', () => {
  withTmpVault((vaultDir) => {
    writeVaultConfig(
      vaultDir,
      [
        '  mode: player',
        '  overrides:',
        '    fields:',
        '      "Characters/NPCs/Good.md":',
        '        include:',
        '          - secrets',
        '      "Characters/NPCs/Bad.md":',
        '        include: "not-a-list"',
      ].join('\n'),
    );
    const { publishConfig } = loadPublishConfig(vaultDir, {});
    assert.deepEqual(publishConfig.overrides.fields['Characters/NPCs/Good.md'], { include: ['secrets'] });
    assert.equal(publishConfig.overrides.fields['Characters/NPCs/Bad.md'], undefined);
  });
});

// --- NFD filename -> slug and manifest match (built in tmp) -----------------

test('scanForPublish + manifest: an NFD-typed filename slugifies and matches an NFC manifest entry', () => {
  withTmpVault((vaultDir) => {
    fs.mkdirSync(path.join(vaultDir, 'Characters', 'NPCs'), { recursive: true });
    const nfdName = 'González.md'; // e + combining acute, decomposed
    fs.writeFileSync(
      path.join(vaultDir, 'Characters', 'NPCs', nfdName),
      '---\ntype: npc\ntitle: González\n---\n\nAn NFD-named page.\n',
    );
    writeVaultConfig(vaultDir, '  mode: player\n');
    fs.mkdirSync(path.join(vaultDir, '_meta'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, '_meta', 'publish-manifest.md'),
      '---\ntype: meta\n---\n\n## Publishing\n\n- [x] Characters/NPCs/González.md\n',
    );

    const jsonConfig = {
      vaultPath: vaultDir,
      folderMap: { 'Characters/NPCs': 'characters/npcs' },
      excludeDirs: ['_meta'],
    };
    const { pages } = scanForPublish(vaultDir, jsonConfig);
    const found = pages.find((p) => p.title.normalize('NFC') === 'González');
    assert.ok(found, 'the NFD-named file must be scanned');
    assert.equal(found.slug, 'gonzalez', 'slugify NFD-decomposes and drops combining marks');
    assert.equal(found.rel, 'Characters/NPCs/González.md', 'rel is vaultRelPath, NFC');

    const result = computePublishedSet(vaultDir, jsonConfig);
    const published = result.publishedPages.find((p) => p.slug === 'gonzalez');
    assert.ok(published, 'the manifest (NFC) must match the NFD-named page via decidePage');
    assert.equal(published.verdict.code, 'OK');
  });
});
