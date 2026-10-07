'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Runs under plain node (the same {TL, CX} = module.exports branch site-runtime.test.js uses).
const { TL, CX } = require(path.join(__dirname, '..', 'assets', 'site', 'scriptorium.js'));

/*
 * ADR 0020: the client's pure, label-bearing functions. Every expected value below is a literal,
 * either hand-typed from the pre-ADR-0020 scriptorium.js (R1's glyph paths and R1/R2's default
 * strings) or independently computed from the rules stated in the Engineering Brief (R3-R6) --
 * never read back off TL.* / CX.* / TL_GLYPH, which is the thing under test.
 */

function svg(inner) {
  return '<svg class="sc-tl-g" viewBox="0 0 20 20" aria-hidden="true">' + inner + '</svg>';
}

// Hand-copied from assets/site/scriptorium.js's TL_GLYPH, before this ADR (unchanged strings).
const GLYPH_FIGHT = '<path d="M4 4l10.5 10.5M16 4L5.5 14.5M11.6 16l4.4-4.4M4 11.6L8.4 16M14.5 14.5l2.3 2.3M5.5 14.5l-2.3 2.3"/>';
const GLYPH_MEETING =
  '<circle cx="7" cy="7.2" r="2.5"/><circle cx="13.4" cy="7.2" r="2.5"/><path d="M2.6 16.2c.6-2.9 2.3-4.4 4.4-4.4s3.8 1.5 4.4 4.4M9 16.2c.6-2.9 2.3-4.4 4.4-4.4s3.8 1.5 4.4 4.4"/>';
const GLYPH_DISCOVERY = '<path d="M2 10s3-5.4 8-5.4 8 5.4 8 5.4-3 5.4-8 5.4S2 10 2 10z"/><circle cx="10" cy="10" r="2.3"/>';
const GLYPH_JOURNEY =
  '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="1.5"/><path d="M10 3v5.5M10 11.5V17M3 10h5.5M11.5 10H17M5.1 5.1l3.8 3.8M11.1 11.1l3.8 3.8M14.9 5.1l-3.8 3.8M8.9 11.1l-3.8 3.8"/>';
const GLYPH_LEARNED = '<path d="M10 5.6C8 4.3 5.5 4.1 3 4.6v10.2c2.5-.5 5-.3 7 1 2-1.3 4.5-1.5 7-1V4.6c-2.5-.5-5-.3-7 1zM10 5.6v10.2"/>';
const GLYPH_BACKSTORY = '<path d="M10 2.2l1.8 5.3 5.6.4-4.4 3.4 1.6 5.5L10 13.6l-4.6 3.2L7 11.3 2.6 7.9l5.6-.4z"/>';
const GLYPH_DOT = '<circle cx="10" cy="10" r="3.5"/>';

const EXPECTED_LEGEND_TRUE =
  '<ul class="sc-tl-legend" aria-label="Key">' +
  '<li><span class="sc-tl-kind sc-tl-k-fight">' + svg(GLYPH_FIGHT) + '</span><span>Fight</span></li>' +
  '<li><span class="sc-tl-kind sc-tl-k-meeting">' + svg(GLYPH_MEETING) + '</span><span>Meeting</span></li>' +
  '<li><span class="sc-tl-kind sc-tl-k-discovery">' + svg(GLYPH_DISCOVERY) + '</span><span>Discovery</span></li>' +
  '<li><span class="sc-tl-kind sc-tl-k-journey">' + svg(GLYPH_JOURNEY) + '</span><span>Journey</span></li>' +
  '<li><span class="sc-tl-star">' + svg(GLYPH_BACKSTORY) + '</span><span>Backstory</span></li>' +
  '<li><span class="sc-tl-book">' + svg(GLYPH_LEARNED) + '</span><span>Learned</span></li>' +
  '</ul>';

const EXPECTED_LENS_BAR_FALSE_TRUE =
  '<div class="sc-tl-top"><div class="sc-tl-lens" role="group" aria-label="Show">' +
  '<button type="button" data-lens="0" aria-pressed="true">The story</button>' +
  '<button type="button" data-lens="1" aria-pressed="false">What the party learned</button>' +
  '</div>' + EXPECTED_LEGEND_TRUE + '</div>';

const SAMPLE_DATA = { ch: { 1: { num: 'I', title: 'Dockside Way' } } };
const SAMPLE_POINT = { s: 1, when: 'week 1', t: 'The Brawl', k: 'fight', w: 3, x: 'A fight broke out.', links: [['Recap I, Dockside Way', 'sessions/recap-01.html']] };

const EXPECTED_CARD_BODY =
  '<p class="sc-tl-meta"><span>week 1</span><span>Chapter I, Dockside Way</span></p>' +
  '<h3 class="sc-tl-dt">The Brawl</h3>' +
  '<p class="sc-tl-kl">A fight, a turning point</p>' +
  '<p class="sc-tl-dx">A fight broke out.</p>' +
  '<p class="sc-tl-dl"><span>Read on:</span> <a href="sessions/recap-01.html">Recap I, Dockside Way</a></p>';

const HUB_SESS_DATA = { sessions: [{ num: 'I', title: 'Dockside Way', href: 'sessions/recap-01.html' }] };
const EXPECTED_HUB_SESS = ' <span class="sc-cx-sess"><a href="sessions/recap-01.html" title="Recap I, Dockside Way">I</a></span>';

const TRAY_SAME_SEL = { shared: [1, 2] };
const TRAY_SAME_DATA = { sessions: [{ ['n']: 1, num: 'I', title: 'Dockside Way' }, { ['n']: 2, num: 'II', title: 'Reedmarsh' }] };
const EXPECTED_TRAY_SAME = '<div class="sc-cx-same"><b>Same recap</b>Recap I, Dockside Way<br>Recap II, Reedmarsh</div>';

// === R1: default-V output equals today's exact literal ============================================

test('R1: TL.legend(true) equals today\'s exact literal', () => {
  assert.equal(TL.legend(true), EXPECTED_LEGEND_TRUE);
});

test('R1: TL.lensBar(false,true) equals today\'s exact literal', () => {
  assert.equal(TL.lensBar(false, true), EXPECTED_LENS_BAR_FALSE_TRUE);
});

test('R1: TL.cardBody(sample) equals today\'s exact literal', () => {
  assert.equal(TL.cardBody(SAMPLE_POINT, SAMPLE_DATA), EXPECTED_CARD_BODY);
});

test('R1: CX.hubSess(sample) equals today\'s exact literal', () => {
  assert.equal(CX.hubSess(HUB_SESS_DATA), EXPECTED_HUB_SESS);
});

test('R1: CX.traySame(sample) equals today\'s exact literal', () => {
  assert.equal(CX.traySame(TRAY_SAME_SEL, TRAY_SAME_DATA), EXPECTED_TRAY_SAME);
});

// === R2: the client defaults deep-equal the same literal as L1 (restricted to client keys) ========

test('R2: TL.vocab()\'s labels/kinds/weights match table B, restricted to the client keys', () => {
  const V = TL.vocab();
  assert.deepEqual(V.labels, {
    learned_lens: 'What the party learned',
    learned_legend: 'Learned',
    story_lens: 'The story',
    chapter: 'Chapter',
  });
  assert.deepEqual(V.kinds, [
    { key: 'fight', label: 'fight', glyph: 'fight', before: false },
    { key: 'meeting', label: 'meeting', glyph: 'meeting', before: false },
    { key: 'discovery', label: 'discovery', glyph: 'discovery', before: false },
    { key: 'journey', label: 'journey', glyph: 'journey', before: false },
    { key: 'backstory', label: 'backstory', glyph: 'backstory', before: true },
  ]);
  assert.deepEqual(V.weights, ['aside', 'scene', 'turning point']);
});

test('R2: CX.vocab()\'s labels match table B, restricted to the client keys', () => {
  assert.deepEqual(CX.vocab().labels, {
    recap: 'Recap',
    same_recap: 'Same recap',
    group_tie: 'Ties',
    group_named: 'Named by',
    group_pc: 'The party',
    group_npc: 'People',
    group_faction: 'Factions',
    group_location: 'Places',
    group_thing: 'Things',
    group_event: 'Events',
    group_other: 'Other',
  });
});

// === R3: a non-default voc gives the independently stated legend, lens bar and kind lines =========

const CUSTOM_VOC = {
  labels: { story_lens: 'The tale', learned_lens: 'What the crew found out' },
  kinds: [{ key: 'omen', label: 'omen', glyph: 'M10 2 L18 18 L2 18 Z', before: false }],
  weights: ['footnote', 'scene', 'watershed'],
};

test('R3: TL.kindLine gives "An omen, a footnote" for the omen kind at weight 1', () => {
  const V = TL.vocab(CUSTOM_VOC);
  assert.equal(TL.kindLine({ k: 'omen', w: 1 }, V), 'An omen, a footnote');
});

test('R3: TL.legend(false, V) lists only the omen kind, with its path-data glyph', () => {
  const V = TL.vocab(CUSTOM_VOC);
  const expected =
    '<ul class="sc-tl-legend" aria-label="Key"><li><span class="sc-tl-kind sc-tl-k-omen">' +
    svg('<path d="M10 2 L18 18 L2 18 Z"/>') +
    '</span><span>Omen</span></li></ul>';
  assert.equal(TL.legend(false, V), expected);
});

test('R3: TL.lensBar uses the custom story_lens/learned_lens labels', () => {
  const V = TL.vocab(CUSTOM_VOC);
  const legend = TL.legend(false, V);
  const expected =
    '<div class="sc-tl-top"><div class="sc-tl-lens" role="group" aria-label="Show">' +
    '<button type="button" data-lens="0" aria-pressed="true">The tale</button>' +
    '</div>' + legend + '</div>';
  assert.equal(TL.lensBar(false, false, V), expected);
});

// === R4: escaping ==================================================================================

test('R4: a story_lens of <img src=x onerror=1> comes out escaped in TL.lensBar', () => {
  const V = TL.vocab({ labels: { story_lens: '<img src=x onerror=1>' } });
  const out = TL.lensBar(false, false, V);
  assert.doesNotMatch(out, /<img src=x onerror=1>/);
  assert.match(out, /&lt;img src=x onerror=1&gt;/);
});

test('R4: a recap label of <b> comes out escaped in CX.hubSess', () => {
  const V = CX.vocab({ labels: { recap: '<b>' } });
  const out = CX.hubSess(HUB_SESS_DATA, V);
  assert.doesNotMatch(out, /title="<b>/);
  assert.match(out, /title="&lt;b&gt;/);
});

// === R5: glyph re-validation ========================================================================

test('R5: a glyph of <script> gives the neutral dot', () => {
  const V = TL.vocab({ kinds: [{ key: 'bad', label: 'bad', glyph: '<script>', before: false }] });
  assert.equal(TL.glyph('bad', V), GLYPH_DOT);
});

test('R5: path data gives <path d="...">', () => {
  const V = TL.vocab({ kinds: [{ key: 'pathy', label: 'pathy', glyph: 'M0 0L1 1Z', before: false }] });
  assert.equal(TL.glyph('pathy', V), '<path d="M0 0L1 1Z"/>');
});

// === R6: kind key "constructor" ======================================================================

test('R6: kind key "constructor" resolves via its own glyph (own-property lookup, not inherited)', () => {
  const V = TL.vocab({ kinds: [{ key: 'constructor', label: 'ctor', glyph: 'fight', before: false }] });
  assert.equal(TL.glyph('constructor', V), GLYPH_FIGHT);
  assert.equal(TL.kindLine({ k: 'constructor', w: 2 }, V), 'A ctor, a scene');
});

test('R6: kind key "constructor" absent from V.byKey never falls back to Object.prototype.constructor', () => {
  // Default V has no kind literally named "constructor": a naive `V.byKey['constructor']` truthy
  // check would otherwise silently resolve to Function (the inherited Object.prototype.constructor).
  assert.equal(TL.glyph('constructor'), GLYPH_DOT);
});
