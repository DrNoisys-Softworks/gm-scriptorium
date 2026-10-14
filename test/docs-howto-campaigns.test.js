'use strict';

/*
 * The how-to pages for campaigns, checked. docs/using.md points at the three campaign how-tos,
 * each how-to opens the admin panel through the one shared link, every page in docs/how-to/ is on
 * the criteria list, and no how-to has a dash, an arrow or a malformed screenshot marker.
 *
 * Tests 3 to 5 below pass today and prove nothing on their own. The planted-defect controls and
 * the recorded mutations are what show they can fail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { userDocFiles } = require('./helpers/doc-criteria');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PANEL_LINK = '../using.md#quick-start';
const CAMPAIGN_PAGES = [
  'how-to/start-a-new-campaign.md',
  'how-to/add-another-campaign.md',
  'how-to/change-the-look-and-vocabulary.md',
];
const MARKER = /<!--\s*screenshot:\s*(.*?)\s*-->/g;
const MARKER_NAME = /^how-to\/[a-z0-9-]+\.png$/;
// U+2014 em dash, U+2013 en dash, U+2192 arrow, built from code points so this file stays plain.
const DASH_OR_ARROW = new RegExp('[' + String.fromCharCode(0x2014, 0x2013, 0x2192) + ']');

/** Every `[text](target)` in a text, as the whole target. */
function linkTargets(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

/** Every link target with any `#fragment` removed. */
function targetsWithoutFragment(text) {
  return linkTargets(text).map((t) => t.split('#')[0]);
}

/** Every screenshot marker name in a text. */
function markerNames(text) {
  return [...text.matchAll(MARKER)].map((m) => m[1]);
}

/** The pages on disk in docs/how-to/, as repo-relative POSIX paths. */
function howToFiles() {
  const dir = path.join(ROOT, 'docs', 'how-to');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => `docs/how-to/${f}`);
}

test('docs/using.md links each of the three campaign how-tos', () => {
  const targets = targetsWithoutFragment(read('docs/using.md'));
  for (const page of CAMPAIGN_PAGES) {
    assert.ok(targets.some((t) => t === page), `docs/using.md has no link to ${page}`);
  }
});

test('each campaign how-to opens the admin panel through the shared link', () => {
  for (const page of CAMPAIGN_PAGES) {
    const targets = linkTargets(read(`docs/${page}`));
    assert.ok(targets.some((t) => t === PANEL_LINK), `${page} has no link to ${PANEL_LINK}`);
  }
});

test('the three campaign how-tos exist', () => {
  const on = howToFiles();
  for (const page of CAMPAIGN_PAGES) assert.ok(on.some((f) => f === `docs/${page}`), `${page} is missing`);
});

test('every docs/how-to page is on the criteria list (passes today, proves nothing alone)', () => {
  const listed = userDocFiles(ROOT);
  for (const f of howToFiles()) assert.ok(listed.some((l) => l === f), `${f} has no row in docs/WRITING-DOCS.md`);
});

test('no docs/how-to page has an em dash, en dash or arrow (passes today, proves nothing alone)', () => {
  for (const f of howToFiles()) {
    const text = read(f);
    assert.ok(!DASH_OR_ARROW.test(text), `${f} has an em dash, en dash or arrow`);
  }
});

test('every screenshot marker in docs/how-to has a well-formed name (passes today, proves nothing alone)', () => {
  for (const f of howToFiles()) {
    for (const name of markerNames(read(f))) assert.match(name, MARKER_NAME, `${f}: marker "${name}"`);
  }
});

// ---- planted-defect controls, on scratch strings, with literal expectations ----

test('control: the link extractor strips a fragment and returns an external link whole', () => {
  const text = 'See [a](x.md#part), [b](../using.md#quick-start) and [c](https://example.org/p#q).';
  assert.deepEqual(targetsWithoutFragment(text), ['x.md', '../using.md', 'https://example.org/p']);
  assert.deepEqual(linkTargets(text), ['x.md#part', '../using.md#quick-start', 'https://example.org/p#q']);
});

test('control: the marker pattern accepts a good name and rejects a bad one', () => {
  assert.deepEqual(markerNames('<!-- screenshot: how-to/theme-screen.png -->'), ['how-to/theme-screen.png']);
  assert.match('how-to/theme-screen.png', MARKER_NAME);
  assert.doesNotMatch('how-to/Bad Name.png', MARKER_NAME);
  assert.doesNotMatch('../x.png', MARKER_NAME);
  assert.doesNotMatch('how-to/a/b.png', MARKER_NAME);
});
