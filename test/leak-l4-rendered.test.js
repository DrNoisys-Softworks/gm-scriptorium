'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildCheckContext } = require('../src/checks/context');
const { runHiddenName } = require('../src/checks/leak/l4');

const PIN_VAULT = path.join(__dirname, 'fixtures', 'pin-vault');
const PIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'pin-vault-site-config.json'));

function pinContext() {
  return buildCheckContext({
    campaign: 'pin-vault',
    vaultPath: PIN_VAULT,
    jsonConfig: { ...PIN_SITE_CONFIG, vaultPath: PIN_VAULT },
  });
}

/** Read a fixture file and return its 1-based line `n`'s text, trimmed. */
function fixtureLine(relPath, n) {
  const text = fs.readFileSync(path.join(PIN_VAULT, relPath), 'utf8');
  const lines = text.split('\n');
  return lines[n - 1];
}

// --- AC-D3-01: the body arm reads rendered text, never raw page.markdown ---

test('AC-D3-01: l4.js\'s body arm never matches against raw page.markdown', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'checks', 'leak', 'l4.js'), 'utf8');
  assert.ok(
    !/findWholeWordOccurrences\(\s*page\.markdown/.test(src),
    'no code path may search page.markdown directly any more',
  );
  assert.ok(
    /findWholeWordOccurrences\(\s*rendered\.bodyText/.test(src),
    'the body arm must search rendered.bodyText',
  );
  assert.ok(
    /findWholeWordOccurrences\(\s*rendered\.storyText/.test(src),
    'the story arm must search rendered.storyText',
  );
});

// --- AC-D3-02: seven named tests, one per stripped construct, each giving no finding ---

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

function minimalPage(overrides = {}) {
  return {
    sourcePath: '/vault/Page.md',
    relPath: 'Page.md',
    rel: 'Page.md',
    title: 'Page',
    displayTitle: 'Page',
    slug: 'page',
    outputPath: 'page.html',
    outputDir: '',
    frontmatter: { type: 'npc' },
    markdown: '',
    bodyLineOffset: 0,
    storyMarkdown: undefined,
    storySourcePath: undefined,
    storyRelPath: undefined,
    storyLineOffset: undefined,
    storyOutputPath: undefined,
    verdict: null,
    ...overrides,
  };
}

function minimalEntity(overrides = {}) {
  return {
    ok: true,
    relPath: 'Hidden.md',
    data: { type: 'npc', withheld: true, title: 'Secret Name' },
    ...overrides,
  };
}

function minimalCtx({ entities = [minimalEntity()], pages = [], publishConfig = basePublishConfig() } = {}) {
  return {
    campaign: 'unit',
    index: { files: entities },
    publishSet: { publishedPages: pages, publishConfig },
  };
}

test('strip-shape 1/7: a name only under an excluded section (exact-match filterSections) gives no finding', () => {
  const ctx = minimalCtx({
    pages: [minimalPage({ markdown: 'Visible intro.\n\n## GM Notes\nSecret Name lives here.\n' })],
    publishConfig: basePublishConfig({ exclude_sections: ['GM Notes'] }),
  });
  assert.deepEqual(runHiddenName(ctx), []);
});

test('strip-shape 2/7: a name only inside a <!-- gm-only --> block gives no finding', () => {
  const ctx = minimalCtx({
    pages: [
      minimalPage({
        markdown: 'Visible intro.\n\n<!-- gm-only -->\nSecret Name is dangerous.\n<!-- /gm-only -->\n\nVisible outro.\n',
      }),
    ],
  });
  assert.deepEqual(runHiddenName(ctx), []);
});

test('strip-shape 3/7: a name only inside a <!-- spoiler --> block gives no finding', () => {
  const ctx = minimalCtx({
    pages: [
      minimalPage({
        markdown: 'Visible intro.\n\n<!-- spoiler -->\nSecret Name is the killer.\n<!-- /spoiler -->\n\nVisible outro.\n',
      }),
    ],
  });
  assert.deepEqual(runHiddenName(ctx), []);
});

test('strip-shape 4/7: a name only inside a plain HTML comment gives no finding', () => {
  const ctx = minimalCtx({
    pages: [minimalPage({ markdown: '<!-- Secret Name is a plain comment. -->\n\nVisible text.\n' })],
  });
  assert.deepEqual(runHiddenName(ctx), []);
});

test('strip-shape 5/7: a name only inside an excluded callout gives no finding', () => {
  const ctx = minimalCtx({
    pages: [
      minimalPage({
        markdown: '> [!warning] Careful\n> Secret Name must stay hidden.\n\nVisible text.\n',
      }),
    ],
    publishConfig: basePublishConfig({ exclude_callouts: true }),
  });
  assert.deepEqual(runHiddenName(ctx), []);
});

test('strip-shape 6/7: a name only inside a dataview block gives no finding', () => {
  const ctx = minimalCtx({
    pages: [minimalPage({ markdown: '```dataview\nTABLE Secret Name FROM "x"\n```\n\nVisible text.\n' })],
  });
  assert.deepEqual(runHiddenName(ctx), []);
});

test('strip-shape 7/7: a name only in a section publish: stub dropped gives no finding', () => {
  const ctx = minimalCtx({
    pages: [
      minimalPage({
        frontmatter: { type: 'pc', publish: 'stub', publish_include_sections: ['Public Bio'] },
        markdown: '## Public Bio\nKept text.\n\n## GM Notes\nSecret Name lives here.\n',
      }),
    ],
  });
  assert.deepEqual(runHiddenName(ctx), []);
});

// --- Integration: the same seven constructs, against the real pin-vault fixture ---

test('integration: GmNotesOnly.md (excluded section) gives no finding on the real fixture vault', () => {
  const ctx = pinContext();
  const findings = runHiddenName(ctx).filter((f) => f.path.includes('GmNotesOnly'));
  assert.deepEqual(findings, []);
});

test('integration: Strip-Shapes.md (gm-only + spoiler + comment + callout + dataview, combined) gives no finding on the real fixture vault', () => {
  const ctx = pinContext();
  const findings = runHiddenName(ctx).filter((f) => f.path.includes('Strip-Shapes'));
  assert.deepEqual(findings, []);
});

// --- AC-D3-05: a name inside a fenced code block still gives a finding ---

test('AC-D3-05: a withheld name inside a code fence still gives a finding, at the real file line', () => {
  const ctx = pinContext();
  const hit = runHiddenName(ctx).find((f) => f.path === 'Characters/NPCs/Fenced-Leak.md');
  assert.ok(hit, 'a fenced occurrence must still be reported: fences survive the strip chain');
  assert.equal(hit.data.arm, 'body');
  assert.equal(hit.data.hiddenName, 'Gus Marzone');
  assert.ok(hit.line !== null, 'the fenced hit must resolve to a real line');
  assert.match(fixtureLine('Characters/NPCs/Fenced-Leak.md', hit.line), /Gus Marzone/);
});

// --- AC-D3-04: visible prose + preceding dataview + inline comment on the hit line ---

test('AC-D3-04: visible prose with a preceding dataview block and an inline comment on the hit line gives the TRUE file line', () => {
  const ctx = pinContext();
  const hit = runHiddenName(ctx).find((f) => f.path === 'Characters/NPCs/Visible-Leak.md');
  assert.ok(hit);
  assert.equal(hit.data.arm, 'body');
  assert.ok(hit.line !== null, 'this hit must resolve, not fall back to null');
  assert.match(fixtureLine('Characters/NPCs/Visible-Leak.md', hit.line), /Gus Marzone/);
  // frontmatter is included in the offset: the fixture's frontmatter block is 4 lines.
  assert.ok(hit.line > 4, 'line must already include the frontmatter offset, not just the body-relative index');
});

// --- AC-D3-03: a withheld name in a published PC's _Story.md ---

test('AC-D3-03: a withheld name in a published PC\'s _Story.md gives exactly one finding, the story\'s own path, the correct line, and data.renderedAt naming both pages', () => {
  const ctx = pinContext();
  const findings = runHiddenName(ctx).filter((f) => f.data.hiddenName === 'Gus Marzone' && f.data.arm === 'story');
  assert.equal(findings.length, 1);
  const hit = findings[0];
  assert.equal(hit.path, 'Characters/PCs/Tamsin_Story.md');
  assert.ok(hit.line !== null);
  assert.match(fixtureLine('Characters/PCs/Tamsin_Story.md', hit.line), /Gus Marzone/);
  assert.equal(hit.outputPath, 'characters/pcs/tamsin.html');
  assert.deepEqual(hit.data.renderedAt, ['characters/pcs/tamsin.html', 'story/characters/tamsin.html']);

  // No body-arm finding for Tamsin's own page: the name is only in the story.
  const bodyHit = runHiddenName(ctx).find((f) => f.path === 'Characters/PCs/Tamsin.md');
  assert.equal(bodyHit, undefined);
});

test('Rowan\'s story: a name under the story\'s own "## GM Notes" (publish: stub reduction) gives nothing', () => {
  const ctx = pinContext();
  const findings = runHiddenName(ctx).filter((f) => f.path && f.path.includes('Rowan'));
  assert.deepEqual(findings, [], 'Rowan_Story.md\'s GM Notes section is dropped by the stub reduction before the strip chain even runs');
});

// --- AC-D3-06 (fail-closed): a mapping failure never suppresses a finding ---

test('AC-D3-06: with alignStrippedToSource forced to return all-null, every finding is still emitted with line: null', () => {
  const textmodel = require('../src/checks/leak/textmodel');
  const original = textmodel.alignStrippedToSource;
  const l4Path = require.resolve('../src/checks/leak/l4');
  const originalL4Cache = require.cache[l4Path];

  textmodel.alignStrippedToSource = (sourceMarkdown, strippedText) =>
    String(strippedText == null ? '' : strippedText)
      .split('\n')
      .map(() => null);
  delete require.cache[l4Path];

  try {
    const freshL4 = require('../src/checks/leak/l4');
    const ctx = pinContext();
    const findings = freshL4.runHiddenName(ctx);

    const bodyOrStory = findings.filter((f) => f.data.arm === 'body' || f.data.arm === 'story');
    assert.ok(bodyOrStory.length > 0, 'the fixture vault must still produce body/story findings to prove this on');
    for (const f of bodyOrStory) {
      assert.equal(f.line, null, `${f.path}: a forced alignment failure must still emit the finding, with line: null`);
    }
  } finally {
    textmodel.alignStrippedToSource = original;
    delete require.cache[l4Path];
    if (originalL4Cache) require.cache[l4Path] = originalL4Cache;
    else require('../src/checks/leak/l4');
  }
});

// --- Novelle / Tanmora sanity is verified against the real 91d8a7b export, not this fixture ---
