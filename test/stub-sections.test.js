'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pinned = require('../src/generator/pinned');
const { deriveRenderedText } = require('../src/checks/leak/textmodel');

/*
 * Stub pages (`publish: stub`): what the pin keeps, and what check's model reads. Issue #100 was
 * a Scriptorium guard on keepOnlySections until publish-v1.14.0; from publish-v1.17.0 the pin
 * withholds an excluded parent's sub-headings itself, in its own order (strips, then the exclude
 * list, then the cut; #320 there), and the guard is retired (ADR 0042, "Retired"). These tests
 * now pin that behaviour through the facade, with the build's withhold object (lib/build.js:589).
 * The real-build proof is test/stub-heading-collision.test.js. Synthetic text only.
 *
 * Controls that pass whatever the exclude list says, and so prove nothing on their own: the
 * "top-level include is kept" and "nested excluded heading inside a kept section is dropped" case.
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

// A gm-only block that opens under the withheld GM Notes heading and closes after a kept heading.
// Cutting the excluded section before the strips would drop the opener and keep the closer.
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

const keep = (md, include, withhold) => pinned.keepOnlySections(md, include, { warn: () => {}, ...withhold });

const PUBLISH_CONFIG = {
  mode: 'player', exclude_drafts: false, exclude_callouts: false, exclude_sections: ['GM Notes'],
  exclude_fields: [], exclude_dirs: [], overrides: { fields: {} },
};

function stubPage(markdown, frontmatter = {}) {
  return {
    rel: 'Characters/NPCs/X.md',
    relPath: 'Characters/NPCs/X.md',
    frontmatter: { type: 'npc', publish: 'stub', publish_include_sections: ['Appearance'], ...frontmatter },
    markdown,
  };
}

test('pin: a sub-heading matching an include entry under an excluded parent is withheld (the parent wins)', () => {
  assert.ok(!keep(MD, ['Appearance'], { excludeSections: ['GM Notes'] }).includes('WITHHELD-TEXT'));
});

test('pin (control): the top-level include is kept and a nested excluded heading inside it is dropped', () => {
  const out = keep(MD, ['Appearance'], { excludeSections: ['GM Notes'] });
  assert.ok(out.includes('public appearance text'));
  assert.ok(!out.includes('nested prep inside a kept section'));
  assert.ok(!out.includes('dropped by the stub include list'));
});

test('pin: case-insensitive on both lists, and CRLF input behaves the same', () => {
  const out = keep(MD.replace(/\n/g, '\r\n'), ['aPPearance'], { excludeSections: ['gm notes'] });
  assert.ok(!out.includes('WITHHELD-TEXT'));
  assert.ok(out.includes('public appearance text'));
});

test('pin: a gm-only block opened inside an excluded section stays withheld', () => {
  const out = keep(ORDER_MD, ['Appearance'], { excludeSections: ['GM Notes'] });
  assert.ok(!out.includes('ORDER-SECRET-TEXT'), out);
  assert.ok(out.includes('public appearance text'), out);
});

test('pin: a stub handout\'s Keeper "Clues" section is withheld when the frontmatter says document', () => {
  const md = ['## Clues', 'KEEPER-CLUE-TEXT', '', '## Text', 'The letter reads plainly.'].join('\n');
  const out = keep(md, ['Clues', 'Text'], { excludeSections: ['GM Notes'], frontmatter: { type: 'document' } });
  assert.ok(!out.includes('KEEPER-CLUE-TEXT'), out);
  assert.ok(out.includes('The letter reads plainly.'), out);
});

test('pin: withhold.warn hears the warning about an unclosed marker', () => {
  const heard = [];
  pinned.keepOnlySections(['<!-- gm-only -->', 'hidden', '', '## Text', 'ok'].join('\n'), ['Text'], {
    excludeSections: [],
    warn: (message) => heard.push(message),
  });
  assert.equal(heard.length, 1, JSON.stringify(heard));
});

test('check model: deriveRenderedText on a stub page withholds the excluded parent\'s sub-heading', () => {
  const rendered = deriveRenderedText(stubPage(MD), PUBLISH_CONFIG);
  assert.ok(!rendered.fullText.includes('WITHHELD-TEXT'));
  assert.ok(rendered.fullText.includes('public appearance text'));
});

test('check model: the model uses the page build\'s own exclude_sections, not just the defaults (custom heading)', () => {
  const md = ['## Appearance', 'public appearance text', '## Hush', '### Appearance', 'HUSHED-TEXT'].join('\n');
  const rendered = deriveRenderedText(stubPage(md), { ...PUBLISH_CONFIG, exclude_sections: ['Hush'] });
  assert.ok(!rendered.fullText.includes('HUSHED-TEXT'));
  assert.ok(rendered.fullText.includes('public appearance text'));
});

test('check model: a gm-only block opened inside an excluded section stays withheld, body and story', () => {
  const rendered = deriveRenderedText({ ...stubPage(ORDER_MD), storyMarkdown: ORDER_MD }, PUBLISH_CONFIG);
  assert.ok(!rendered.fullText.includes('ORDER-SECRET-TEXT'), rendered.fullText);
  assert.ok(rendered.bodyText.includes('public appearance text'));
  assert.ok(rendered.storyText.includes('public appearance text'));
});

// The build strips the campaign's excluded callouts before the cut (lib/build.js:589). A callout
// holding a "## GM Notes" line must not make the model withhold the text after it.
test('check model: an excluded callout is stripped before the cut, as the build strips it', () => {
  const md = ['## Appearance', 'intro', '> [!secret]', '> ## GM Notes', '> hidden', '', 'PUBLIC-AFTER-CALLOUT'].join('\n');
  const rendered = deriveRenderedText(stubPage(md), { ...PUBLISH_CONFIG, exclude_callouts: ['secret'] });
  assert.ok(rendered.bodyText.includes('PUBLIC-AFTER-CALLOUT'), rendered.bodyText);
  assert.ok(!rendered.bodyText.includes('hidden'), rendered.bodyText);
});
