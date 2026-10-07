'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const htmltext = require('../src/build/htmltext');

test('decodeEntities: named and numeric entities', () => {
  assert.equal(htmltext.decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), `a & b <c> "d" 'e'`);
  assert.equal(htmltext.decodeEntities('&mdash;&ndash;&hellip;'), '—–…');
  assert.equal(htmltext.decodeEntities('&#65;&#x42;'), 'AB');
});

test('textOf: strips tags, decodes entities, collapses whitespace, trims', () => {
  assert.equal(htmltext.textOf('  <strong>Grix</strong>  goes   through &amp; back  '), 'Grix goes through & back');
});

test('escapeHtml: escapes only & < > "', () => {
  assert.equal(htmltext.escapeHtml(`<a href="x">A & B</a>`), '&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;');
});

test('foldTypographer: mirrors outputscan.js', () => {
  assert.equal(htmltext.foldTypographer('‘many folk’ – “ok”…'), `'many folk' -- "ok"...`);
});

test('foldKey: case/typography/whitespace/trailing punctuation insensitive', () => {
  const a = htmltext.foldKey('<strong>The Meteor Falls.</strong>');
  const b = htmltext.foldKey('the meteor falls');
  assert.equal(a, b);
  assert.equal(htmltext.foldKey('  <b>Dorvan  Turns</b>  '), 'dorvan turns');
});

test('resolveHref: relative path resolution, query/hash stripped, absolute -> null', () => {
  assert.equal(htmltext.resolveHref('characters/npcs/tilda.html', '../../locations/ashbourne.html'), 'locations/ashbourne.html');
  assert.equal(htmltext.resolveHref('campaign/timeline.html', 'index.html'), 'campaign/index.html');
  assert.equal(htmltext.resolveHref('a.html', 'sub/b.html#frag'), 'sub/b.html');
  assert.equal(htmltext.resolveHref('a.html', 'sub/b.html?x=1'), 'sub/b.html');
  assert.equal(htmltext.resolveHref('a.html', 'https://example.com/x'), null);
  assert.equal(htmltext.resolveHref('a.html', '//example.com/x'), null);
});

test('resolveHref: percent-decodes segments', () => {
  assert.equal(htmltext.resolveHref('items/index.html', '../items/six%20%E2%80%94%20field.html'), 'items/six — field.html');
});

test('sliceBalanced: finds the matching close tag across nested tags of the same name', () => {
  const html = '<div class="a"><div class="b">x</div>y</div>z';
  const end = htmltext.sliceBalanced(html, 0, 'div');
  assert.equal(html.slice(0, end), '<div class="a"><div class="b">x</div>y</div>');
});

test('proseRegion: strips graph/sidebar/relationship-list/breadcrumbs/story-nav/badges/whos-here', () => {
  const html =
    '<main class="content">' +
    '<nav class="breadcrumbs">Home</nav>' +
    '<div class="metadata-badges"><span>x</span></div>' +
    '<p>Real prose with an <a href="../npc.html">NPC</a>.</p>' +
    '<ul class="relationship-list"><li>tie</li></ul>' +
    '<aside class="context-sidebar">side</aside>' +
    '<div class="relationship-graph"><svg></svg></div>' +
    '<div class="whos-here"><h2>Connections</h2></div>' +
    '</main>';
  const region = htmltext.proseRegion(html);
  assert.equal(region, '<p>Real prose with an <a href="../npc.html">NPC</a>.</p>');
});

test('proseRegion: empty when no <main class="content">', () => {
  assert.equal(htmltext.proseRegion('<div>no main</div>'), '');
});

test('toRoman: 1-3999', () => {
  assert.equal(htmltext.toRoman(1), 'I');
  assert.equal(htmltext.toRoman(2), 'II');
  assert.equal(htmltext.toRoman(3), 'III');
  assert.equal(htmltext.toRoman(4), 'IV');
  assert.equal(htmltext.toRoman(9), 'IX');
  assert.equal(htmltext.toRoman(1994), 'MCMXCIV');
});

test('cmpCodeUnit: code-unit order, not locale order', () => {
  const arr = ['Zed', 'Ámbar'].sort(htmltext.cmpCodeUnit);
  assert.deepEqual(arr, ['Zed', 'Ámbar']); // 'Z' (0x5A) < 'Á' (0xC1) in code-unit order
});
