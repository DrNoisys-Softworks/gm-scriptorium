'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const pinned = require('../src/generator/pinned');
const { deriveRenderedText } = require('../src/checks/leak/textmodel');

/*
 * Issue #100 unit coverage for the stub-page section guard (src/generator/pinned.js). The
 * real-build proof is test/stub-heading-collision.test.js. Synthetic text only.
 *
 * Tests that pass against the unguarded pin and so prove nothing as evidence for the fix: the
 * "top-level include is kept" and "nested excluded heading inside a kept section is dropped"
 * cases (the pin already handles both; they are controls so the guard is shown not to over-drop).
 */

const MD = [
  '# Page',
  'preamble',
  '## Appearance',
  'public appearance text',
  '### GM Notes',
  'nested prep inside a kept section',
  '## GM Notes',
  'prep',
  '### Appearance',
  'WITHHELD-TEXT',
  '## Public Bio',
  'dropped by the stub include list',
].join('\n');

test('guard: a sub-heading matching an include entry under an excluded parent is dropped (the withheld parent wins)', () => {
  const out = pinned.keepOnlySections(MD, ['Appearance'], ['GM Notes']);
  assert.ok(!out.includes('WITHHELD-TEXT'), out);
});

test('guard (control): the top-level include is kept and a nested excluded heading inside it is dropped', () => {
  const out = pinned.keepOnlySections(MD, ['Appearance'], ['GM Notes']);
  assert.ok(out.includes('public appearance text'));
  assert.ok(!out.includes('nested prep inside a kept section'));
  assert.ok(!out.includes('dropped by the stub include list'));
});

test('guard: case-insensitive on both lists, and CRLF input behaves the same', () => {
  const out = pinned.keepOnlySections(MD.replace(/\n/g, '\r\n'), ['aPPearance'], ['gm notes']);
  assert.ok(!out.includes('WITHHELD-TEXT'));
  assert.ok(out.includes('public appearance text'));
});

test('guard: with no explicit list and none set for a build, PUBLISH_DEFAULTS.exclude_sections still apply', () => {
  assert.ok(pinned.PUBLISH_DEFAULTS.exclude_sections.map((s) => s.toLowerCase()).includes('gm notes'));
  const out = pinned.keepOnlySections(MD, ['Appearance']);
  assert.ok(!out.includes('WITHHELD-TEXT'));
});

test('guard: the per-build list set by setStubExcludeSections is used, and clearing it reverts to the defaults', () => {
  const md = ['## Appearance', 'keep', '## Hush', '### Appearance', 'HUSHED-TEXT'].join('\n');
  assert.ok(pinned.keepOnlySections(md, ['Appearance']).includes('HUSHED-TEXT'), 'Hush is not excluded by default');
  pinned.setStubExcludeSections(['Hush']);
  try {
    assert.ok(!pinned.keepOnlySections(md, ['Appearance']).includes('HUSHED-TEXT'));
  } finally {
    pinned.setStubExcludeSections(null);
  }
  assert.ok(pinned.keepOnlySections(md, ['Appearance']).includes('HUSHED-TEXT'));
});

// From publish-v1.17.0 the pin's keepOnlySections takes a third argument, the build's `withhold`
// object: { excludeSections, excludeCallouts, frontmatter, warn } (lib/processor.js:474, #320
// there). lib/build.js passes it for a stub PC's story. The guard must hand it on, not drop it.

test('guard: the build\'s withhold object reaches the pin, so a stub handout\'s Keeper "Clues" is withheld', () => {
  const md = ['## Clues', 'KEEPER-CLUE-TEXT', '', '## Text', 'The letter reads plainly.'].join('\n');
  const out = pinned.keepOnlySections(md, ['Clues', 'Text'], {
    excludeSections: ['GM Notes'],
    frontmatter: { type: 'document' },
    warn: () => {},
  });
  assert.ok(!out.includes('KEEPER-CLUE-TEXT'), out);
  assert.ok(out.includes('The letter reads plainly.'), out);
});

test('guard: the build\'s withhold.warn hears the pin\'s warning about an unclosed marker', () => {
  const heard = [];
  pinned.keepOnlySections(['<!-- gm-only -->', 'hidden', '', '## Text', 'ok'].join('\n'), ['Text'], {
    excludeSections: [],
    warn: (message) => heard.push(message),
  });
  assert.equal(heard.length, 1, JSON.stringify(heard));
});

// #320 in the pin: the strips run on the whole note before the exclude list and the cut. Cutting
// the excluded section first drops the gm-only opener inside it and leaves its closer, so the text
// between them would publish. Both argument forms must keep the pin's order.
const ORDER_MD = [
  '## GM Notes',
  '<!-- gm-only -->',
  '## Appearance',
  'ORDER-SECRET-TEXT',
  '<!-- /gm-only -->',
  '',
  '## Appearance',
  'public appearance text',
].join('\n');

test('guard: a gm-only block opened inside an excluded section stays withheld (withhold object)', () => {
  const out = pinned.keepOnlySections(ORDER_MD, ['Appearance'], { excludeSections: ['GM Notes'], warn: () => {} });
  assert.ok(!out.includes('ORDER-SECRET-TEXT'), out);
  assert.ok(out.includes('public appearance text'), out);
});

test('guard: a gm-only block opened inside an excluded section stays withheld (exclude list)', () => {
  const out = pinned.keepOnlySections(ORDER_MD, ['Appearance'], ['GM Notes']);
  assert.ok(!out.includes('ORDER-SECRET-TEXT'), out);
  assert.ok(out.includes('public appearance text'), out);
});

test('guard: a withhold object with no excludeSections still gets the build\'s list, then the defaults', () => {
  const md = ['## Appearance', 'keep', '## Hush', '### Appearance', 'HUSHED-TEXT'].join('\n');
  pinned.setStubExcludeSections(['Hush']);
  try {
    assert.ok(!pinned.keepOnlySections(md, ['Appearance'], { warn: () => {} }).includes('HUSHED-TEXT'));
  } finally {
    pinned.setStubExcludeSections(null);
  }
  assert.ok(!pinned.keepOnlySections(MD, ['Appearance'], { warn: () => {} }).includes('WITHHELD-TEXT'));
});

test('guard: the processor export lib/build.js binds is the guard, and assertStubGuardLive passes', () => {
  // eslint-disable-next-line global-require
  const processor = require('gm-apprentice-publish/lib/processor');
  assert.equal(processor.keepOnlySections.scriptoriumStubGuard, true);
  assert.doesNotThrow(() => pinned.assertStubGuardLive());
});

test('guard: assertStubGuardLive fails closed when the export has been replaced', () => {
  // eslint-disable-next-line global-require
  const processor = require('gm-apprentice-publish/lib/processor');
  const guard = processor.keepOnlySections;
  processor.keepOnlySections = () => '';
  try {
    assert.throws(() => pinned.assertStubGuardLive(), /not live/);
  } finally {
    processor.keepOnlySections = guard;
  }
});

test('guard: when lib/build.js was loaded BEFORE the facade, the guard reports not live and a build is refused', () => {
  const root = path.join(__dirname, '..');
  const script = `
    process.chdir(${JSON.stringify(root)});
    require('gm-apprentice-publish');            // loads lib/build.js, binding the unguarded export
    const pinned = require(${JSON.stringify(path.join(root, 'src/generator/pinned.js'))});
    try { pinned.assertStubGuardLive(); console.log('LIVE'); } catch (e) { console.log('REFUSED:' + e.message.slice(0, 40)); }
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.match(r.stdout, /REFUSED:the stub-page section guard/, r.stdout + r.stderr);
});

test('check model: deriveRenderedText on a stub page models the guarded build (no withheld sub-heading in the text)', () => {
  const rendered = deriveRenderedText(
    {
      rel: 'Characters/NPCs/X.md',
      relPath: 'Characters/NPCs/X.md',
      frontmatter: { type: 'npc', publish: 'stub', publish_include_sections: ['Appearance'] },
      markdown: MD,
    },
    { mode: 'player', exclude_drafts: false, exclude_callouts: false, exclude_sections: ['GM Notes'], exclude_fields: [], exclude_dirs: [], overrides: { fields: {} } },
  );
  assert.ok(!rendered.fullText.includes('WITHHELD-TEXT'));
  assert.ok(rendered.fullText.includes('public appearance text'));
});

test('bootstrap: runGeneratorBuild refuses (fails closed, no output written) when the guard is not live', () => {
  const root = path.join(__dirname, '..');
  const script = `
    const fs = require('fs'), os = require('os'), path = require('path');
    process.chdir(${JSON.stringify(root)});
    const { runGeneratorBuild } = require(${JSON.stringify(path.join(root, 'src/generator/bootstrap.js'))});
    // Something replaces the guarded export after the facade installed it (the redaction guard would
    // trip first if lib/build.js were loaded early, so this is the isolated way to break liveness).
    require('gm-apprentice-publish/lib/processor').keepOnlySections = () => '';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-guard-'));
    const out = path.join(dir, 'out');
    const cfg = path.join(dir, 'vault.config.json');
    fs.writeFileSync(cfg, JSON.stringify({ siteTitle: 'x', vaultPath: ${JSON.stringify(path.join(__dirname, 'fixtures', 'stub-heading-collision-vault'))}, outputDir: out, folderMap: {}, excludeSections: ['GM Notes'] }));
    const r = runGeneratorBuild(cfg);
    console.log('RESULT:' + (r.error ? r.error.message.slice(0, 40) : 'BUILT') + ':' + fs.existsSync(out));
    fs.rmSync(dir, { recursive: true, force: true });
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.match(r.stdout, /RESULT:the stub-page section guard[^:]*:false/, r.stdout + r.stderr);
});

test('check model: the model uses the page build\'s own exclude_sections, not just the defaults (custom heading)', () => {
  const md = ['## Appearance', 'public appearance text', '## Hush', '### Appearance', 'HUSHED-TEXT'].join('\n');
  const rendered = deriveRenderedText(
    {
      rel: 'Characters/NPCs/X.md',
      relPath: 'Characters/NPCs/X.md',
      frontmatter: { type: 'npc', publish: 'stub', publish_include_sections: ['Appearance'] },
      markdown: md,
    },
    { mode: 'player', exclude_drafts: false, exclude_callouts: false, exclude_sections: ['Hush'], exclude_fields: [], exclude_dirs: [], overrides: { fields: {} } },
  );
  assert.ok(!rendered.fullText.includes('HUSHED-TEXT'));
  assert.ok(rendered.fullText.includes('public appearance text'));
});
