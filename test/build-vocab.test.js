'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractPoints, buildTimelineModel } = require('../src/build/timeline');
const { collectRecaps } = require('../src/build/recaps');
const { renderLane, transformConnections } = require('../src/build/connections');
const { DEFAULT_VOCAB, parseVocab } = require('../src/build/labels');

/*
 * ADR 0020: timeline.js, recaps.js and connections.js exercised WITH a custom vocab, using
 * inline synthetic HTML (never story-vault/pin-vault/grapheme-vault, NFR-11(c)). Synthetic names
 * only.
 */

const T = '/vault/_meta/scriptorium/pack.toml';
const C = 'alpha';

function vocabFrom(raw) {
  return parseVocab(raw, { T, c: C }).vocab;
}

// === V1: custom columns, kinds and aliases =========================================================

test('V1: a before-kind makes a before:true segment, and an alias maps to its canonical key', () => {
  const vocab = vocabFrom({
    timeline: {
      columns: { title: ['heading'], kind: ['sort'] },
      kinds: [
        { key: 'origin', glyph: 'backstory', before: true },
        { key: 'clash', glyph: 'fight', aliases: ['battle'] },
      ],
    },
  });

  const html =
    '<table><thead><tr><th>Heading</th><th>Sort</th><th>Weight</th><th>Place</th><th>When</th><th>What</th></tr></thead><tbody>' +
    '<tr><td>Origin story</td><td>origin</td><td>2</td><td>Nowhere</td><td>long ago</td><td>Backstory bit.</td></tr>' +
    '<tr><td>The Brawl</td><td>battle</td><td>3</td><td>Harbour</td><td>week 1</td><td>A fight broke out.</td></tr>' +
    '</tbody></table>';

  const warnings = [];
  const recaps = new Map();
  const extracted = extractPoints(html, 'out.html', recaps, warnings, vocab);

  assert.equal(extracted.points.length, 2);
  assert.equal(extracted.points[0].k, 'origin');
  assert.equal(extracted.points[1].k, 'clash', 'the alias "battle" must resolve to its canonical key "clash"');

  assert.equal(extracted.segments.length, 2);
  assert.equal(extracted.segments[0].before, true, 'a segment made entirely of before-kind rows is before:true');
  assert.equal(extracted.segments[1].before, false);
});

// === V2: session group-1 digit guard; segment fallback when a group is undefined ==================

test('V2: a non-digit session-token capture is rejected (treated as session 0, with the existing warning)', () => {
  const vocab = vocabFrom({ timeline: { session_token: 'Ep(\\w+)' } });

  const html =
    '<table><thead><tr><th>Title</th><th>Kind</th><th>Weight</th><th>Place</th><th>When</th><th>Real-world</th><th>What</th></tr></thead><tbody>' +
    '<tr><td>Row A</td><td>fight</td><td>2</td><td>Place</td><td>week 1</td><td>EpFive</td><td>x</td></tr>' +
    '<tr><td>Row B</td><td>fight</td><td>2</td><td>Place</td><td>week 2</td><td>Ep5</td><td>x</td></tr>' +
    '</tbody></table>';

  const warnings = [];
  const extracted = extractPoints(html, 'out.html', new Map(), warnings, vocab);
  assert.equal(extracted.points[0].s, 0, 'a non-digit capture must not be accepted as a session number');
  assert.ok(warnings.some((w) => w.includes('no session token (S<n>) found for row "week 1"')));
  assert.equal(extracted.points[1].s, 5, 'an all-digit capture is accepted');
});

test('V2: segmentLabel falls back to the pre-comma text when the regex matches without capturing both groups', () => {
  // Three capturing groups total (>= the required 2): the first two belong to the week/day
  // alternative, the third to a bare "era" alternative that captures neither of the first two.
  const vocab = vocabFrom({ timeline: { segment_units: '(week|day)\\s+(\\d+)|(era)' } });

  const html =
    '<table><thead><tr><th>Title</th><th>Kind</th><th>Weight</th><th>Place</th><th>When</th><th>What</th></tr></thead><tbody>' +
    '<tr><td>Row A</td><td>fight</td><td>2</td><td>Place</td><td>week 3</td><td>x</td></tr>' +
    '<tr><td>Row B</td><td>fight</td><td>2</td><td>Place</td><td>long era, nowhere</td><td>x</td></tr>' +
    '</tbody></table>';

  const warnings = [];
  const extracted = extractPoints(html, 'out.html', new Map(), warnings, vocab);
  assert.equal(extracted.segments[0].label, 'Week 3');
  assert.equal(extracted.segments[1].label, 'long era', 'both groups undefined: falls back to split(",")[0].trim()');
});

// === V3: collectRecaps with learned_heading ========================================================

function recapPage({ num, title, date, heading, learnedLis }) {
  return (
    '<main class="content">' +
    `<h1 class="page-title">${title}</h1>` +
    `<span class="metadata-badge" data-field="session_number">${num}</span>` +
    `<span class="metadata-badge" data-field="play_date">${date}</span>` +
    `<h2>${heading}</h2>\n<ul>\n` +
    learnedLis.map((li) => `<li>${li}</li>`).join('\n') +
    '\n</ul>' +
    '</main>'
  );
}

test('V3: collectRecaps matches a custom learned_heading, case-insensitively, and not the default', () => {
  const vocab = vocabFrom({ recaps: { learned_heading: 'Lessons Gathered' } });

  const withCustomHeading = {
    'sessions/recap-01.html': recapPage({
      num: 1,
      title: 'Episode 01',
      date: 'd',
      heading: 'LESSONS gathered',
      learnedLis: ['<strong>The quay is watched.</strong> Body text.'],
    }),
  };
  const recaps = collectRecaps(withCustomHeading, vocab);
  assert.equal(recaps.get(1).learned.length, 1);
  assert.equal(recaps.get(1).learned[0].title, 'The quay is watched');

  // Control: the DEFAULT vocab's heading does not match this page's custom heading.
  const recapsDefault = collectRecaps(withCustomHeading, DEFAULT_VOCAB);
  assert.equal(recapsDefault.get(1).learned.length, 0);

  // Control: a page using the OLD default heading text no longer matches the custom vocab.
  const withDefaultHeading = {
    'sessions/recap-01.html': recapPage({ num: 1, title: 'S1', date: 'd', heading: 'What the Party Learned', learnedLis: ['<strong>X.</strong> Y'] }),
  };
  assert.equal(collectRecaps(withDefaultHeading, vocab).get(1).learned.length, 0);
});

// === V4: renderLane escaping =======================================================================

test('V4: renderLane escapes a <b>&"</b> heading, group title and recap title', () => {
  const vocab = vocabFrom({
    labels: {
      connections_heading: 'Ties <b>&"</b>',
      group_npc: 'Folk <b>&"</b>',
      recap: 'Recap <b>&"</b>',
    },
  });

  const model = {
    outputPath: 'characters/npcs/x.html',
    items: [{ name: 'NPC <b>&"</b>', href: null, type: 'npc', group: 'npc', kind: 'mention', rel: null, line: null, src: null, shared: [], rank: 1 }],
    sessions: [{ ['n']: 1, num: 'I', title: 'Session <b>&"</b>', outputPath: 'sessions/recap-01.html' }],
    name: 'Hub <b>&"</b>',
  };

  const rendered = renderLane(model, vocab);
  assert.doesNotMatch(rendered.html, /<b>&"<\/b>/, 'the raw, unescaped tag must never appear');
  assert.match(rendered.html, /<h2>Ties &lt;b&gt;&amp;&quot;&lt;\/b&gt;<\/h2>/, 'connections_heading (H, :481) must be escaped');
  assert.ok(rendered.html.includes('Folk &lt;b&gt;&amp;&quot;&lt;/b&gt;'), 'the group title must be escaped');
  assert.ok(
    rendered.html.includes('title="Recap &lt;b&gt;&amp;&quot;&lt;/b&gt; I, Session &lt;b&gt;&amp;&quot;&lt;/b&gt;"'),
    'the recap label in the title attribute (H, :398) must be escaped',
  );
  assert.ok(rendered.html.includes('Hub &lt;b&gt;&amp;&quot;&lt;/b&gt;'), 'the hub name must be escaped');
});

test('V4 control: an npc group under the DEFAULT vocab renders the literal default title "People"', () => {
  const model = {
    outputPath: 'characters/npcs/x.html',
    items: [{ name: 'Plain NPC', href: null, type: 'npc', group: 'npc', kind: 'mention', rel: null, line: null, src: null, shared: [], rank: 1 }],
    sessions: [],
    name: 'Hub',
  };
  const rendered = renderLane(model, DEFAULT_VOCAB);
  assert.match(rendered.html, /<h3 class="sc-cx-gh">People<\/h3>/);
});

// === V5: island key shape under the default vocab (no voc key) ====================================

test('V5: buildTimelineModel(...DEFAULT_VOCAB).island has exactly [v,segs,ch,points,learned]', () => {
  const html =
    '<table><thead><tr><th>Title</th><th>Kind</th><th>Weight</th><th>Place</th><th>When</th><th>Real-world</th><th>What</th></tr></thead><tbody>' +
    '<tr><td>Row A</td><td>fight</td><td>2</td><td>Place</td><td>week 1</td><td>S1</td><td>x</td></tr>' +
    '</tbody></table>';
  const model = buildTimelineModel(html, 'out.html', new Map(), [], DEFAULT_VOCAB);
  assert.deepEqual(Object.keys(model.island), ['v', 'segs', 'ch', 'points', 'learned']);
});

test('V5: the lane island has exactly [v,name,seal,sessions,items] under the default vocab', () => {
  const model = { outputPath: 'x.html', items: [], sessions: [{ ['n']: 1, num: 'I', title: 'T', outputPath: 'sessions/recap-01.html' }], name: 'Hub' };
  const rendered = renderLane(model, DEFAULT_VOCAB);
  const islandMatch = rendered.html.match(/<script type="application\/json" class="sc-cx-data">([\s\S]*?)<\/script>/);
  assert.ok(islandMatch);
  const island = JSON.parse(islandMatch[1]);
  assert.deepEqual(Object.keys(island), ['v', 'name', 'seal', 'sessions', 'items']);
});

// === V6: the island for the X vocab carries voc last ===============================================

const X_VOCAB_RAW = {
  labels: { chapter: 'Episode' },
  timeline: { weights: ['footnote', 'scene', 'watershed'] },
};

test('V6: the timeline island carries voc as its last key', () => {
  const vocab = vocabFrom(X_VOCAB_RAW);
  assert.notEqual(vocab.tlVoc, null);
  const html =
    '<table><thead><tr><th>Title</th><th>Kind</th><th>Weight</th><th>Place</th><th>When</th><th>Real-world</th><th>What</th></tr></thead><tbody>' +
    '<tr><td>Row A</td><td>fight</td><td>2</td><td>Place</td><td>week 1</td><td>S1</td><td>x</td></tr>' +
    '</tbody></table>';
  const model = buildTimelineModel(html, 'out.html', new Map(), [], vocab);
  const keys = Object.keys(model.island);
  assert.equal(keys[keys.length - 1], 'voc');
  assert.deepEqual(keys, ['v', 'segs', 'ch', 'points', 'learned', 'voc']);
});

test('V6: the connections lane island carries voc as its last key', () => {
  const vocab = vocabFrom({ labels: { group_npc: 'Folk' } });
  assert.notEqual(vocab.cxVoc, null);
  const model = { outputPath: 'x.html', items: [], sessions: [{ ['n']: 1, num: 'I', title: 'T', outputPath: 'sessions/recap-01.html' }], name: 'Hub' };
  const rendered = renderLane(model, vocab);
  const islandMatch = rendered.html.match(/<script type="application\/json" class="sc-cx-data">([\s\S]*?)<\/script>/);
  const island = JSON.parse(islandMatch[1]);
  const keys = Object.keys(island);
  assert.equal(keys[keys.length - 1], 'voc');
  assert.deepEqual(keys, ['v', 'name', 'seal', 'sessions', 'items', 'voc']);
});

// -- sanity: transformConnections still accepts a vocab and does not throw -------------------------

test('transformConnections: accepts an explicit vocab (sanity; full coverage is E2)', () => {
  const html = '<div class="relationship-graph"><h2>Connections</h2><svg></svg></div>';
  const model = {
    start: 0,
    end: html.length,
    outputPath: 'x.html',
    items: [],
    sessions: [{ ['n']: 1, num: 'I', title: 'T', outputPath: 'sessions/recap-01.html' }],
    name: 'Hub',
  };
  const result = transformConnections(html, model, DEFAULT_VOCAB);
  assert.ok(result.html.includes('Hub'));
});
