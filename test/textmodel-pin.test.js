'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveRenderedText, extractHeadings, buildPublishedNameIndex } = require('../src/checks/leak/textmodel');

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

function page(overrides = {}) {
  return {
    rel: 'Characters/NPCs/X.md',
    relPath: 'Characters/NPCs/X.md',
    frontmatter: { type: 'npc' },
    markdown: '',
    storyMarkdown: undefined,
    ...overrides,
  };
}

// --- nesting (stripGmOnly / stripSpoiler are depth-aware, not boolean) -----

test('deriveRenderedText: a nested <!-- gm-only --> block closes only itself, the outer block survives', () => {
  const md = [
    '<!-- gm-only -->',
    'Outer secret start.',
    '<!-- gm-only -->',
    'Inner secret.',
    '<!-- /gm-only -->',
    'Outer secret continues — must still be stripped.',
    '<!-- /gm-only -->',
    'Visible text after the whole block.',
  ].join('\n');
  const rendered = deriveRenderedText(page({ markdown: md }), basePublishConfig());
  assert.ok(!rendered.bodyText.includes('secret'), 'nothing inside either gm-only layer may survive');
  assert.ok(rendered.bodyText.includes('Visible text after'));
});

// --- fence inertness ---------------------------------------------------

test('deriveRenderedText: a marker shown inside a ~~~ fence is inert (documentation, not a real directive)', () => {
  const md = ['~~~', '<!-- gm-only -->', 'example only, not a real strip', '~~~', 'Real visible text.'].join('\n');
  const rendered = deriveRenderedText(page({ markdown: md }), basePublishConfig());
  assert.ok(rendered.bodyText.includes('example only, not a real strip'));
  assert.ok(rendered.bodyText.includes('Real visible text.'));
});

test('deriveRenderedText: a fence of four or more backticks is still a real fence', () => {
  const md = ['````', '<!-- gm-only -->', 'still just an example', '````', 'Visible after.'].join('\n');
  const rendered = deriveRenderedText(page({ markdown: md }), basePublishConfig());
  assert.ok(rendered.bodyText.includes('still just an example'));
  assert.ok(rendered.bodyText.includes('Visible after.'));
});

// --- spoiler, comments, callouts --------------------------------------

test('deriveRenderedText: stripSpoiler removes a <!-- spoiler --> block', () => {
  const md = ['Visible before.', '<!-- spoiler -->', 'Hidden spoiler text.', '<!-- /spoiler -->', 'Visible after.'].join('\n');
  const rendered = deriveRenderedText(page({ markdown: md }), basePublishConfig());
  assert.ok(!rendered.bodyText.includes('Hidden spoiler text.'));
  assert.ok(rendered.bodyText.includes('Visible before.'));
  assert.ok(rendered.bodyText.includes('Visible after.'));
});

test('deriveRenderedText: stripHtmlComments removes an HTML comment, including a multi-line one', () => {
  const md = ['Kept line.', '<!-- a comment', 'spanning two lines -->', 'Also kept.'].join('\n');
  const rendered = deriveRenderedText(page({ markdown: md }), basePublishConfig());
  assert.ok(!rendered.bodyText.includes('spanning two lines'));
  assert.ok(rendered.bodyText.includes('Kept line.'));
  assert.ok(rendered.bodyText.includes('Also kept.'));
});

test('deriveRenderedText: stripCallouts removes a callout only when exclude_callouts is on', () => {
  const md = ['Intro.', '> [!warning] Alert', '> Secret callout body.', 'Outro.'].join('\n');
  const stripped = deriveRenderedText(page({ markdown: md }), basePublishConfig({ exclude_callouts: true }));
  assert.ok(!stripped.bodyText.includes('Secret callout body.'));

  const kept = deriveRenderedText(page({ markdown: md }), basePublishConfig({ exclude_callouts: false }));
  assert.ok(kept.bodyText.includes('Secret callout body.'));
});

// --- CRLF ----------------------------------------------------------------

test('deriveRenderedText: CRLF line endings are normalised before any marker/heading match', () => {
  const md = [
    'Visible.\r',
    '<!-- gm-only -->\r',
    'Also secret.\r',
    '<!-- /gm-only -->\r',
    '## GM Notes\r',
    'Secret.\r',
  ].join('\n');
  const rendered = deriveRenderedText(page({ markdown: md }), basePublishConfig({ exclude_sections: ['GM Notes'] }));
  assert.ok(!rendered.bodyText.includes('Secret.'));
  assert.ok(!rendered.bodyText.includes('Also secret.'));
  assert.ok(rendered.bodyText.includes('Visible.'));
  assert.ok(!rendered.bodyText.includes('\r'));
});

// --- stub applied to both body and story ------------------------------

test('deriveRenderedText: publish: stub + publish_include_sections reduces both body and story before the strip chain', () => {
  const p = page({
    frontmatter: { type: 'pc', publish: 'stub', publish_include_sections: ['Public Bio'] },
    markdown: '## Public Bio\nKept body text.\n\n## GM Notes\nDropped body text.',
    storyMarkdown: '## Public Bio\nKept story text.\n\n## GM Notes\nDropped story text.',
  });
  const rendered = deriveRenderedText(p, basePublishConfig());
  assert.ok(rendered.bodyText.includes('Kept body text.'));
  assert.ok(!rendered.bodyText.includes('Dropped body text.'));
  assert.ok(rendered.storyText.includes('Kept story text.'));
  assert.ok(!rendered.storyText.includes('Dropped story text.'));
});

// --- gm_only edges dropped, publish_exclude_fields over include override, control fields removed ---

test('deriveRenderedText: gm_only relationship edges are dropped from publishedFrontmatter/frontmatterText', () => {
  const p = page({
    frontmatter: {
      type: 'npc',
      relationships: [
        { target: '[[Hidden]]', type: 'knows', gm_only: true, description: 'secret link' },
        { target: '[[Visible]]', type: 'knows', description: 'open link' },
      ],
    },
  });
  const rendered = deriveRenderedText(p, basePublishConfig());
  assert.equal(rendered.publishedFrontmatter.relationships.length, 1);
  assert.equal(rendered.publishedFrontmatter.relationships[0].target, '[[Visible]]');
  assert.ok(!rendered.frontmatterText.includes('Hidden'));
  assert.ok(!rendered.frontmatterText.includes('secret link'));
  assert.ok(rendered.frontmatterText.includes('Visible'));
});

test('deriveRenderedText: publish_exclude_fields wins over an overrides.fields include for that same file', () => {
  const p = page({
    rel: 'Characters/NPCs/Y.md',
    frontmatter: { type: 'npc', secrets: 'top secret', publish_exclude_fields: ['secrets'] },
  });
  const publishConfig = basePublishConfig({
    exclude_fields: ['secrets'],
    overrides: { fields: { 'Characters/NPCs/Y.md': { include: ['secrets'] } } },
  });
  const rendered = deriveRenderedText(p, publishConfig);
  assert.equal(rendered.publishedFrontmatter.secrets, undefined);
  assert.ok(!rendered.frontmatterText.includes('top secret'));
});

test('deriveRenderedText: control fields (publish, publish_exclude_fields, publish_include_sections) are never reader-facing', () => {
  const p = page({
    frontmatter: {
      type: 'npc',
      publish: 'stub',
      publish_exclude_fields: ['secrets'],
      publish_include_sections: ['Bio'],
    },
  });
  const rendered = deriveRenderedText(p, basePublishConfig());
  assert.equal(rendered.publishedFrontmatter.publish, undefined);
  assert.equal(rendered.publishedFrontmatter.publish_exclude_fields, undefined);
  assert.equal(rendered.publishedFrontmatter.publish_include_sections, undefined);
});

// --- a handout's Keeper sections (publish-v1.11.41, upstream #280) ---------
//
// At publish-v1.11.41 the pin's filterSections takes the page's own frontmatter as a third
// argument, and on a `type: document` (or `handout`) page withholds four `## ` sections whatever
// exclude_sections says: Context, Clues..., Prop Notes, Delivery (lib/processor.js:93-115). A
// real build passes that frontmatter for a page's body (lib/build.js:506, :764;
// lib/processor.js:655). The model has to pass it too, or check reads text a build never
// publishes and reports a withheld name there as a leak. Story text is rendered from a page
// object whose frontmatter is `{}` (lib/build.js:775-779, :1153), so the rule never reaches it.
// Expected strings below are literals from the test's own markdown, never read back from the pin.

const HANDOUT_MD = [
  'The letter itself, as the players read it.',
  '',
  '## Context',
  'Keeper analysis naming the secret patron.',
  '',
  '## Clues Embedded',
  'The watermark points at the quarry.',
  '',
  '## The Text',
  'Visible body of the handout.',
  '',
  '### Delivery',
  'A nested delivery note that is part of the handout.',
  '',
  '## Prop Notes',
  'Age the paper with tea.',
  '',
  '## Delivery ##',
  'Hand it over once the cellar door is open.',
].join('\n');

test('deriveRenderedText: a document page withholds its Keeper sections with an empty exclude_sections, as a real build does', () => {
  const p = page({ rel: 'Documents/Letter.md', relPath: 'Documents/Letter.md', frontmatter: { type: 'document' }, markdown: HANDOUT_MD });
  const rendered = deriveRenderedText(p, basePublishConfig());
  assert.ok(!rendered.bodyText.includes('secret patron'), '## Context is withheld on a document page');
  assert.ok(!rendered.bodyText.includes('watermark'), '## Clues Embedded is withheld on a document page');
  assert.ok(rendered.bodyText.includes('The letter itself'));
  assert.ok(rendered.bodyText.includes('Visible body of the handout.'));
  assert.ok(rendered.bodyText.includes('A nested delivery note'), 'a ### Delivery inside a kept section is part of the handout');
  assert.ok(!rendered.bodyText.includes('Age the paper'), '## Prop Notes is withheld on a document page');
  assert.ok(!rendered.bodyText.includes('cellar door'), '## Delivery is withheld, ATX closing sequence and all');
});

test('deriveRenderedText: the `handout` alias withholds the same sections', () => {
  const p = page({ frontmatter: { type: 'handout' }, markdown: HANDOUT_MD });
  const rendered = deriveRenderedText(p, basePublishConfig());
  assert.ok(!rendered.bodyText.includes('secret patron'));
  assert.ok(rendered.bodyText.includes('Visible body of the handout.'), 'the handout text itself still publishes');
});

// The build keeps the file's original frontmatter for the section strip (`page.sourceFrontmatter`,
// lib/build.js:484) exactly so that hiding `type` from the published copy cannot switch the rule
// off. The model reads the raw frontmatter, so it must hold here too.
test('deriveRenderedText: hiding `type` with exclude_fields does not publish a document page\'s Keeper sections', () => {
  const p = page({ frontmatter: { type: 'document' }, markdown: HANDOUT_MD });
  const rendered = deriveRenderedText(p, basePublishConfig({ exclude_fields: ['type'] }));
  assert.equal(rendered.publishedFrontmatter.type, undefined, 'type is hidden from the published frontmatter');
  assert.ok(!rendered.bodyText.includes('secret patron'));
  assert.ok(rendered.bodyText.includes('Visible body of the handout.'));
});

// Passes before and after the fix, so it is no evidence for it: it is the control that the rule
// stays scoped to document pages and does not start hiding an NPC's own `## Context`.
test('deriveRenderedText: the same headings on an npc page still publish (control)', () => {
  const p = page({ frontmatter: { type: 'npc' }, markdown: HANDOUT_MD });
  const rendered = deriveRenderedText(p, basePublishConfig());
  assert.ok(rendered.bodyText.includes('secret patron'));
  assert.ok(rendered.bodyText.includes('watermark'));
});

// Not reachable today: story text only attaches to a `type: pc` page. It pins the direction the
// model must fail in if that ever changes. The build renders story text with an empty frontmatter,
// so the Keeper rule does not apply to it, and a model that withheld these sections would hide
// text the site publishes.
test('deriveRenderedText: story text is not subject to the document rule, as in a real build', () => {
  const p = page({ frontmatter: { type: 'document' }, markdown: 'Body.', storyMarkdown: HANDOUT_MD });
  const rendered = deriveRenderedText(p, basePublishConfig());
  assert.ok(rendered.storyText.includes('secret patron'));
  assert.ok(rendered.storyText.includes('Visible body of the handout.'));
});

// --- extractHeadings / buildPublishedNameIndex (unchanged surface) --------

test('extractHeadings: level and 1-based line number', () => {
  const headings = extractHeadings('intro\n## Two\ntext\n### Three');
  assert.deepEqual(headings, [
    { level: 2, title: 'Two', line: 2 },
    { level: 3, title: 'Three', line: 4 },
  ]);
});

test('buildPublishedNameIndex: keys are NFC-canonicalized then lowercased', () => {
  const nfdTitle = 'González'; // decomposed
  const pages = [{ title: nfdTitle, frontmatter: { aliases: ['G'] } }];
  const index = buildPublishedNameIndex(pages);
  assert.ok(index.has('gonzález'.normalize('NFC').toLowerCase()));
  assert.ok(index.has('g'));
});
