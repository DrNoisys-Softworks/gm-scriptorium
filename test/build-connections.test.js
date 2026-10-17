'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const htmltext = require('../src/build/htmltext');
const { SITE_SCRIPT_MARKER } = require('../src/build/sitescript');
const {
  CONNECTIONS_MARKER,
  trimLine,
  readCxData,
  ownTargets,
  collectConnections,
  renderLane,
  transformConnections,
  applyConnections,
} = require('../src/build/connections');
const { runAtomicBuild } = require('../src/build/run');

/*
 * From publish-v1.18.0 the pin draws a page's Connections as one <section class="cx"> holding the
 * same content as data (lib/templates/connections.js). The lane replaces that section and reads its
 * data block. The fixtures below build that section in the shape a real build writes (checked
 * against a story-vault build at publish-v1.21.0); the last tests build real fixtures, so a change in
 * the pin's own markup fails here by name rather than passing on hand-written HTML.
 */

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-connections-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -- the pin's section, as lib/templates/connections.js writes it ----------------------------

// item: { t: title, h: href or null, k: kind label, l: lines, f: how many lines are this page's own }
function item(t, h, { k = 'NPC', l = [], f = 0 } = {}) {
  return { t, h, k, o: null, l, f, s: null, i: null };
}

function cxSection({ subject = 'Page', tabs = [], mentions = [] } = {}) {
  const plain = tabs
    .map((tab) => `<h3>${tab.n}</h3>` + tab.g.map((g) => `<h4>${g.n}</h4><ul>${g.d.map((d) => `<li>${d.h ? `<a href="${d.h}">${d.t}</a>` : d.t}</li>`).join('')}</ul>`).join(''))
    .join('');
  const data = { s: subject, t: tabs.map((tab, i) => ({ id: `tab${i}`, n: tab.n, g: tab.g })), m: mentions };
  return (
    '<section class="cx" data-cx-mode="tree" aria-labelledby="cx-heading">\n' +
    '<h2 id="cx-heading">Connections</h2>\n' +
    `<div class="cx-plain">${plain}</div>\n` +
    `<script type="application/json" class="cx-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>\n` +
    '</section>'
  );
}

function page({ cx = '', prose = '<p>Prose.</p>', pc = false, before = '' } = {}) {
  const body = pc ? `<div class="tab-panel" id="tab-journey">\n${before}\n${cx}\n</div>` : `${prose}\n${cx}`;
  return (
    '<html><head></head><body>\n<main class="content" data-previews="on">\n<h1 class="page-title">Page</h1>\n' +
    `${body}\n</main>\n<script src="../../js/nav.js"></script>\n<script src="../../js/connections.js"></script>\n</body></html>`
  );
}

const people = (groups) => ({ n: 'People', g: groups });

// -- reading the data block ---------------------------------------------------------------------

test('readCxData: items keep their group label, lines and own count; mentions keep title and href', () => {
  const html = cxSection({
    subject: 'Grix',
    tabs: [people([{ n: 'Ally', d: [item('Tilda', '../npcs/tilda.html', { l: ['Trusts Tilda.'], f: 1 })] }])],
    mentions: [{ n: 'Sessions', d: [['Session 01', '../../sessions/session-01.html']] }],
  });
  assert.deepEqual(readCxData(html), {
    subject: 'Grix',
    items: [{ title: 'Tilda', rawHref: '../npcs/tilda.html', label: 'Ally', lines: ['Trusts Tilda.'], own: 1 }],
    mentions: [{ title: 'Session 01', rawHref: '../../sessions/session-01.html' }],
  });
});

test('collectConnections: a data block that does not parse leaves the page to the pin, with a warning (T-C9)', () => {
  const broken = page({ cx: '<section class="cx"><h2>Connections</h2><script type="application/json" class="cx-data">{not json</script></section>' });
  const { pageModels, warnings } = collectConnections({ 'locations/x.html': broken }, new Map());
  assert.equal(pageModels.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^locations\/x\.html: the Connections section's data could not be read/);
});

// -- T-C1: what is a lane item ----------------------------------------------------------------

test('collectConnections: meta types and sessions are not lane items; mentions are (T-C1)', () => {
  const html = page({
    cx: cxSection({
      tabs: [people([{ n: 'Knows', d: [item('Tilda', '../characters/npcs/tilda.html')] }]), { n: 'Sessions', g: [{ n: 'Appearing', d: [item('Session 01', '../sessions/session-01.html', { k: 'Session' })] }] }],
      mentions: [{ n: 'Other', d: [['Campaign', '../campaign/index.html'], ['Ghost', '../characters/npcs/ghost.html']] }],
    }),
  });
  const published = new Map([
    ['locations/x.html', { displayTitle: 'X', type: 'location' }],
    ['characters/npcs/tilda.html', { displayTitle: 'Tilda', type: 'npc' }],
    ['characters/npcs/ghost.html', { displayTitle: 'Ghost', type: 'npc' }],
    ['sessions/session-01.html', { displayTitle: 'Session 01', type: 'session' }],
    ['campaign/index.html', { displayTitle: 'Campaign', type: 'campaign_overview' }],
  ]);
  const { pageModels } = collectConnections({ 'locations/x.html': html }, published);
  const names = pageModels[0].items.map((i) => i.name).sort();
  assert.deepEqual(names, ['Ghost', 'Tilda']);
});

// -- T-C2: tie, named and mention -----------------------------------------------------------

test('collectConnections: tie (this page names it), named (the other page does, in its words), mention (T-C2)', () => {
  const grix = page({
    pc: true,
    cx: cxSection({
      subject: 'Grix',
      tabs: [people([
        { n: 'Ally', d: [item('Tilda', '../npcs/tilda.html', { l: ['Trusts Tilda completely.'], f: 1 })] },
        { n: 'Knows', d: [item('Doran', '../npcs/doran.html', { l: ['Doran once helped Grix.'], f: 0 })] },
      ])],
      mentions: [{ n: 'People', d: [['Mira', '../npcs/mira.html']] }],
    }),
  });
  const doran = page({ cx: cxSection({ subject: 'Doran', tabs: [people([{ n: 'Knows', d: [item('Grix', '../pcs/grix.html', { k: 'Player character', l: ['Doran once helped Grix.'], f: 1 })] }])] }) });
  const mira = page({ prose: '<p>Mira saw <a href="../pcs/grix.html">Grix</a> at the gate.</p>' });
  const htmlByPath = { 'characters/pcs/grix.html': grix, 'characters/npcs/doran.html': doran, 'characters/npcs/mira.html': mira };
  const published = new Map([
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
    ['characters/npcs/tilda.html', { displayTitle: 'Tilda', type: 'npc' }],
    ['characters/npcs/doran.html', { displayTitle: 'Doran', type: 'npc' }],
    ['characters/npcs/mira.html', { displayTitle: 'Mira', type: 'npc' }],
  ]);
  const ownByPath = new Map([
    ['characters/pcs/grix.html', new Set(['characters/npcs/tilda.html'])],
    ['characters/npcs/doran.html', new Set(['characters/pcs/grix.html'])],
  ]);
  const { pageModels } = collectConnections(htmlByPath, published, undefined, undefined, ownByPath);
  const m = pageModels.find((p) => p.outputPath === 'characters/pcs/grix.html');
  const by = (name) => m.items.find((i) => i.name === name);
  assert.deepEqual([by('Tilda').kind, by('Tilda').rel, by('Tilda').line], ['tie', 'ally', 'Trusts Tilda completely.']);
  assert.deepEqual([by('Doran').kind, by('Doran').rel, by('Doran').line], ['named', 'knows Grix', 'Doran once helped Grix.']);
  assert.deepEqual([by('Mira').kind, by('Mira').line], ['mention', 'Mira saw Grix at the gate.']);
});

test('collectConnections: a named item reads in the other page\'s own wording, not the inverse label this page shows (T-C2)', () => {
  // Doran's note says he serves Grix. Grix's section files Doran under the inverse, "Served by".
  const grix = page({ pc: true, cx: cxSection({ subject: 'Grix', tabs: [people([{ n: 'Served by', d: [item('Doran', '../npcs/doran.html')] }])] }) });
  const doran = page({ cx: cxSection({ subject: 'Doran', tabs: [people([{ n: 'Serves', d: [item('Grix', '../pcs/grix.html', { k: 'Player character' })] }])] }) });
  const published = new Map([
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
    ['characters/npcs/doran.html', { displayTitle: 'Doran', type: 'npc' }],
  ]);
  const ownByPath = new Map([['characters/npcs/doran.html', new Set(['characters/pcs/grix.html'])]]);
  const { pageModels } = collectConnections({ 'characters/pcs/grix.html': grix, 'characters/npcs/doran.html': doran }, published, undefined, undefined, ownByPath);
  const doranOnGrix = pageModels.find((p) => p.outputPath === 'characters/pcs/grix.html').items[0];
  assert.deepEqual([doranOnGrix.kind, doranOnGrix.rel], ['named', 'serves Grix']);
});

// -- T-C3: full names; a target with no page is this page's own, unlinked -------------------------

test('collectConnections: names are never truncated; an item with no page is a tie and renders sc-cx-nolink (T-C3)', () => {
  const longName = 'A Very Long Twenty Char Name';
  const html = page({ cx: cxSection({ tabs: [{ n: 'Other', g: [{ n: 'Ally', d: [item(longName, null, { k: '', l: ['An old friend.'], f: 1 })] }] }] }) });
  const published = new Map([['locations/x.html', { displayTitle: 'X', type: 'location' }]]);
  const { pageModels } = collectConnections({ 'locations/x.html': html }, published);
  const it = pageModels[0].items[0];
  assert.deepEqual([it.name, it.href, it.kind, it.line], [longName, null, 'tie', 'An old friend.']);
  const rendered = renderLane({ outputPath: 'locations/x.html', items: pageModels[0].items, sessions: [], name: 'X' });
  assert.ok(rendered.html.includes('sc-cx-nolink'));
  assert.ok(rendered.html.includes(htmltext.escapeHtml(longName)));
});

// -- Reviewer MEDIUM item: canon-check's raw-text extractor inserts a phrase boundary only on
// -- block-level tag closes (div/p/li/... -- never span/a), and its name-run regex spans a bare
// -- space, including into a trailing session numeral. The hub seal and hub name must be block
// -- elements so their closes give the extractor a real boundary.

test('renderLane: the hub seal and hub name are block elements (a <div> boundary, not a bare space) so canon-check cannot glue them into one name; session numerals stay spaced', () => {
  const model = {
    outputPath: 'characters/npcs/rasha.html',
    items: [],
    sessions: [
      { ['n']: 1, num: 'I', title: 'The Lane', outputPath: 'sessions/recap-01.html' },
      { ['n']: 2, num: 'II', title: 'Ashbourne', outputPath: 'sessions/recap-02.html' },
    ],
    name: 'Rasha Redshale',
  };
  const rendered = renderLane(model);
  assert.match(rendered.html, /<div class="sc-cx-hub">/, 'expected the hub wrapper to be a <div>, not a <p> (a <p> cannot contain a nested <div>)');
  assert.match(rendered.html, /class="sc-cx-hub-seal"[^>]*>R<\/div><div class="sc-cx-hub-name">Rasha Redshale<\/div>/);
  assert.doesNotMatch(rendered.html, /sc-cx-hub-seal[^>]*>[^<]*<\/span>/, 'the seal must not be a <span> (canon-check does not treat its close as a boundary)');
  assert.doesNotMatch(rendered.html, /sc-cx-hub-name[^>]*>[^<]*<\/span>/, 'the name must not be a <span> (canon-check does not treat its close as a boundary)');
  assert.match(rendered.html, />I<\/a> <a href="[^"]*"[^>]*>II<\/a>/);
});

// -- T-C4: unknown type -> Other -------------------------------------------------------------

test('collectConnections: a mention of an unknown type goes to Other (T-C4)', () => {
  const html = page({ cx: cxSection({ mentions: [{ n: 'Papers', d: [['Weird', '../world/weird.html']] }] }) });
  const htmlByPath = { 'locations/x.html': html, 'world/weird.html': page({}) };
  const published = new Map([
    ['locations/x.html', { displayTitle: 'X', type: 'location' }],
    ['world/weird.html', { displayTitle: 'Weird', type: 'clue' }],
  ]);
  const { pageModels } = collectConnections(htmlByPath, published);
  assert.equal(pageModels[0].items.find((i) => i.name === 'Weird').group, 'other');
});

// -- T-C5: rank ---------------------------------------------------------------------------------

test('collectConnections: rank -- 11 shared recaps (55) outranks a named item (50); code-unit tie-break (T-C5)', () => {
  const html = page({
    cx: cxSection({
      tabs: [people([{ n: 'Knows', d: [item('Named', '../characters/npcs/named.html')] }])],
      mentions: [{ n: 'People', d: [['Mention', '../characters/npcs/mention.html'], ['Zed', '../characters/npcs/zed.html'], ['Ámbar', '../characters/npcs/ambar.html']] }],
    }),
  });
  const htmlByPath = {
    'locations/x.html': html,
    'characters/npcs/named.html': page({}),
    'characters/npcs/mention.html': page({}),
    'characters/npcs/zed.html': page({}),
    'characters/npcs/ambar.html': page({}),
  };
  // 11 recaps all linking both x.html and mention.html -> mention scores 5*11=55 > named's 50
  for (let i = 1; i <= 11; i++) {
    htmlByPath[`sessions/recap-${i}.html`] =
      `<html><body><main class="content"><h1 class="page-title">S${i}</h1>` +
      `<span class="metadata-badge" data-field="session_number">${i}</span>` +
      `<span class="metadata-badge" data-field="play_date">d</span>` +
      `<p>Visits <a href="../locations/x.html">X</a> and <a href="../characters/npcs/mention.html">Mention</a>.</p>` +
      `<h2>What the Party Learned</h2><ul><li><strong>L${i}.</strong> b</li></ul></main></body></html>`;
  }
  const published = new Map([
    ['locations/x.html', { displayTitle: 'X', type: 'location' }],
    ['characters/npcs/named.html', { displayTitle: 'Named', type: 'npc' }],
    ['characters/npcs/mention.html', { displayTitle: 'Mention', type: 'npc' }],
    ['characters/npcs/zed.html', { displayTitle: 'Zed', type: 'npc' }],
    ['characters/npcs/ambar.html', { displayTitle: 'Ámbar', type: 'npc' }],
  ]);
  const ownByPath = new Map([['characters/npcs/named.html', new Set(['locations/x.html'])]]);
  const { pageModels } = collectConnections(htmlByPath, published, undefined, undefined, ownByPath);
  const m = pageModels.find((p) => p.outputPath === 'locations/x.html');
  const by = (name) => m.items.find((i) => i.name === name);
  assert.equal(by('Named').kind, 'named');
  assert.equal(by('Mention').kind, 'mention');
  assert.equal(by('Mention').shared.length, 11);
  assert.ok(by('Mention').rank < by('Named').rank, `mention rank ${by('Mention').rank} should beat named rank ${by('Named').rank}`);
  // both score 0, tie-break by code-unit order: 'Z' (0x5A) < 'Á' (0xC1)
  assert.ok(by('Zed').rank < by('Ámbar').rank);
});

// -- T-C6: trimLine -------------------------------------------------------------------------

test('trimLine: 180 unchanged, 195-with-sentence, 195-without, no-space (T-C6)', () => {
  const s180 = 'x'.repeat(180);
  assert.equal(trimLine(s180), s180);
  assert.equal(trimLine('A'.repeat(95) + '. ' + 'B'.repeat(100)), 'A'.repeat(95) + '.');
  assert.equal(trimLine('C'.repeat(195)), 'C'.repeat(189) + '…');
  assert.equal(trimLine('D'.repeat(195)), 'D'.repeat(189) + '…');
});

// -- T-C7: snippets are verbatim substrings of the other page's prose ---------------------------

test('collectConnections: mention line is a verbatim substring of the source page prose (T-C7)', () => {
  const grix = page({ pc: true, cx: cxSection({ mentions: [{ n: 'People', d: [['Doran', '../npcs/doran.html']] }] }) });
  const doran = page({ prose: '<p>Long ago Doran met <a href="../pcs/grix.html">Grix</a> near the gate, and they spoke for hours about the lane ahead and the price of duskveil in the harbor corner that season.</p>' });
  const published = new Map([
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
    ['characters/npcs/doran.html', { displayTitle: 'Doran', type: 'npc' }],
  ]);
  const { pageModels } = collectConnections({ 'characters/pcs/grix.html': grix, 'characters/npcs/doran.html': doran }, published);
  const it = pageModels.find((p) => p.outputPath === 'characters/pcs/grix.html').items.find((i) => i.name === 'Doran');
  const withoutEllipsis = it.line.replace(/…$/, '');
  assert.ok(htmltext.textOf(htmltext.proseRegion(doran)).includes(withoutEllipsis), withoutEllipsis);
});

test('mention snippet comes from the other page\'s prose, never from its Connections section (T-C7)', () => {
  const x = page({ cx: cxSection({ mentions: [{ n: 'People', d: [['Target', '../characters/npcs/target.html']] }] }) });
  // The target's own section links back to x first, in a list; its prose links x after it.
  const target = page({
    prose: '',
    cx: cxSection({ tabs: [{ n: 'Places', g: [{ n: 'Knows', d: [item('X', '../../locations/x.html', { k: 'Location' })] }] }] }),
  }).replace('</main>', '<p>This page also mentions <a href="../../locations/x.html">X</a> in prose.</p>\n</main>');
  const published = new Map([
    ['locations/x.html', { displayTitle: 'X', type: 'location' }],
    ['characters/npcs/target.html', { displayTitle: 'Target', type: 'npc' }],
  ]);
  const { pageModels } = collectConnections({ 'locations/x.html': x, 'characters/npcs/target.html': target }, published);
  assert.equal(pageModels.find((p) => p.outputPath === 'locations/x.html').items[0].line, 'This page also mentions X in prose.');
});

// -- T-C8: the section is replaced in place, and its own script goes ---------------------------

test('transformConnections: the pin\'s section is replaced, exactly one <h2>Connections</h2>, its script tag removed (T-C8)', () => {
  const html = page({ cx: cxSection({ subject: 'Tilda', tabs: [people([{ n: 'Mentor', d: [item('Grix', '../pcs/grix.html')] }])] }) });
  const published = new Map([
    ['characters/npcs/tilda.html', { displayTitle: 'Tilda', type: 'npc' }],
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
  ]);
  const ownByPath = new Map([['characters/npcs/tilda.html', new Set(['characters/pcs/grix.html'])]]);
  const { pageModels } = collectConnections({ 'characters/npcs/tilda.html': html }, published, undefined, undefined, ownByPath);
  const result = transformConnections(html, pageModels[0]);
  assert.ok(!result.html.includes('class="cx"'));
  assert.ok(!result.html.includes('class="cx-data"'));
  assert.ok(!result.html.includes('js/connections.js'));
  assert.ok(result.html.includes('js/nav.js'), 'other scripts stay');
  assert.ok(result.html.includes('<p>Prose.</p>'), 'the page body around the section stays');
  assert.equal((result.html.match(/<h2>Connections<\/h2>/g) || []).length, 1);
  assert.match(result.html, /<li class="sc-cx-kind-tie"><a href="[^"]*grix\.html">Grix<\/a> <span class="sc-cx-rel">mentor<\/span><\/li>/);
});

// -- T-C10: PC lane in the Journey tab --------------------------------------------------------

test('transformConnections: on a PC page the lane replaces the section inside #tab-journey; what comes before it is unchanged (T-C10)', () => {
  const before = '<div class="campaign-route"><h3>Campaign Route</h3></div>';
  const html = page({ pc: true, before, cx: cxSection({ tabs: [people([{ n: 'Ally', d: [item('Tilda', '../npcs/tilda.html')] }])] }) });
  const published = new Map([
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
    ['characters/npcs/tilda.html', { displayTitle: 'Tilda', type: 'npc' }],
  ]);
  const { pageModels } = collectConnections({ 'characters/pcs/grix.html': html }, published);
  const out = transformConnections(html, pageModels[0]).html;
  const journeyIdx = out.indexOf('id="tab-journey"');
  const routeIdx = out.indexOf(before);
  const laneIdx = out.indexOf('class="sc-cx"');
  assert.ok(journeyIdx < routeIdx && routeIdx < laneIdx, 'expected Route before the lane, both inside tab-journey');
});

// -- T-C11: hub-only, removed-only, no section ------------------------------------------------

test('transformConnections: no items and no sessions -> removedOnly, no script linked (T-C11)', () => {
  const html = page({ cx: cxSection({ mentions: [{ n: 'Other', d: [['Campaign', '../campaign/index.html']] }] }) });
  const published = new Map([
    ['locations/x.html', { displayTitle: 'X', type: 'location' }],
    ['campaign/index.html', { displayTitle: 'Campaign', type: 'campaign_overview' }],
  ]);
  const { pageModels } = collectConnections({ 'locations/x.html': html }, published);
  assert.equal(pageModels[0].items.length, 0);
  assert.equal(pageModels[0].sessions.length, 0);
  const result = transformConnections(html, pageModels[0]);
  assert.equal(result.removedOnly, true);
  assert.ok(!result.html.includes('sc-cx'));
  assert.ok(!result.html.includes('class="cx"'));
  assert.ok(!result.html.includes(SITE_SCRIPT_MARKER), 'the script must not be linked on a removed-only page');
});

test('collectConnections: a page with no Connections section is not in pageModels at all (byte-identical) (T-C11)', () => {
  const { pageModels } = collectConnections({ 'documents/note.html': page({ prose: '<p>Nothing here.</p>' }) }, new Map());
  assert.equal(pageModels.length, 0);
});

// -- T-C12: idempotent ------------------------------------------------------------------------

test('transformConnections: idempotent', () => {
  const html = page({ cx: cxSection({ tabs: [people([{ n: 'Ally', d: [item('Grix', '../pcs/grix.html')] }])] }) });
  const published = new Map([
    ['characters/npcs/tilda.html', { displayTitle: 'Tilda', type: 'npc' }],
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
  ]);
  const { pageModels } = collectConnections({ 'characters/npcs/tilda.html': html }, published);
  const first = transformConnections(html, pageModels[0]).html;
  assert.ok(first.includes(CONNECTIONS_MARKER));
  assert.equal(transformConnections(first, pageModels[0]), null);
});

// -- T-C13: no Intl/toLocale/localeCompare -----------------------------------------------------

test('grep: no Intl/toLocale/localeCompare in src/build modules or the asset (T-C13)', () => {
  const files = [
    'src/build/htmltext.js',
    'src/build/recaps.js',
    'src/build/timeline.js',
    'src/build/connections.js',
    'src/build/sitescript.js',
    'assets/site/scriptorium.js',
  ].map((f) => path.join(__dirname, '..', f));
  for (const f of files) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\bIntl\b|toLocale|localeCompare/, f);
  }
});

// -- ownTargets: which pages a note's own relationships name ----------------------------------

test('ownTargets: list and map forms, a labelled link, an alias and a vault path resolve; a gm_only edge and a hidden field name nothing', () => {
  const pages = [
    { title: 'Grix', rel: 'Characters/PCs/Grix.md', outputPath: 'characters/pcs/grix.html', frontmatter: { type: 'pc', relationships: [
      { target: '[[Tilda|the keeper]]', type: 'ally' },
      { target: '[[Old Doran]]', type: 'knows' },
      { target: '[[Secret]]', type: 'knows', gm_only: true },
    ] } },
    { title: 'Tilda', rel: 'Characters/NPCs/Tilda.md', outputPath: 'characters/npcs/tilda.html', frontmatter: { type: 'npc', relationships: { mentor: ['[[Characters/PCs/Grix]]'] } } },
    { title: 'Doran', rel: 'Characters/NPCs/Doran.md', outputPath: 'characters/npcs/doran.html', frontmatter: { type: 'npc', aliases: ['Old Doran'] } },
    { title: 'Secret', rel: 'Characters/NPCs/Secret.md', outputPath: 'characters/npcs/secret.html', frontmatter: { type: 'npc' } },
    { title: 'Hidden', rel: 'Characters/NPCs/Hidden.md', outputPath: 'characters/npcs/hidden.html', frontmatter: { type: 'npc', publish_exclude_fields: ['relationships'], relationships: [{ target: '[[Grix]]', type: 'knows' }] } },
    { title: 'Muted', rel: 'Characters/NPCs/Muted.md', outputPath: 'characters/npcs/muted.html', frontmatter: { type: 'npc', relationships: [{ target: '[[Grix]]', type: 'knows' }] } },
  ];
  // A campaign-wide exclude a file re-includes publishes there; the note's own publish_exclude_fields wins.
  const publishConfig = { exclude_fields: ['relationships'], overrides: { fields: { 'Characters/PCs/Grix.md': { include: ['relationships'] }, 'Characters/NPCs/Tilda.md': { include: ['relationships'] }, 'Characters/NPCs/Hidden.md': { include: ['relationships'] } } } };
  const own = ownTargets(pages, publishConfig);
  assert.deepEqual([...own.get('characters/pcs/grix.html')].sort(), ['characters/npcs/doran.html', 'characters/npcs/tilda.html']);
  assert.deepEqual([...own.get('characters/npcs/tilda.html')], ['characters/pcs/grix.html']);
  assert.deepEqual([...own.get('characters/npcs/doran.html')], []);
  assert.deepEqual([...own.get('characters/npcs/hidden.html')], [], 'a note that hides its own relationships names nothing');
  assert.deepEqual([...own.get('characters/npcs/muted.html')], [], 'a campaign-wide exclude names nothing');
});

// -- real builds: the lane reads what the pin really writes ------------------------------------

function buildStoryVault(dir) {
  const vaultPath = path.join(__dirname, 'fixtures', 'story-vault');
  const siteConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'story-vault-site-config.json'), 'utf8'));
  const siteDir = path.join(dir, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const finalOut = path.join(dir, 'out');
  const result = runAtomicBuild({ vaultPath, userJsonConfig: { ...siteConfig, vaultPath }, finalOut, siteDir, campaign: 'cx', force: true });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error && result.error.message));
  return finalOut;
}

function laneOf(finalOut, rel) {
  const html = fs.readFileSync(path.join(finalOut, rel), 'utf8');
  const m = /<script type="application\/json" class="sc-cx-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, `${rel} carries no lane`);
  return { html, data: JSON.parse(m[1]) };
}

test('real build of story-vault: each lane holds the ties and named-by items the notes declare, in their words', () => {
  withTmpDir((dir) => {
    const out = buildStoryVault(dir);
    const pick = (rel) => laneOf(out, rel).data.items.map((i) => [i.name, i.kind, i.rel, i.line]);
    // Grix.md: ally [[Tilda]] with a description. Tilda.md: mentor [[Grix]]. Doran.md: knows [[Grix]] with one.
    assert.deepEqual(pick('characters/pcs/grix.html'), [
      ['Tilda', 'tie', 'ally', 'Trusts Tilda completely, ever since the debt.'],
      ['Doran', 'named', 'knows Grix', 'Doran once helped Grix past the freight court gate.'],
    ]);
    assert.deepEqual(pick('characters/npcs/tilda.html'), [['Grix', 'tie', 'mentor', null]]);
    assert.deepEqual(pick('characters/npcs/doran.html'), [['Grix', 'tie', 'knows', 'Doran once helped Grix past the freight court gate.']]);
    for (const rel of ['characters/pcs/grix.html', 'characters/npcs/tilda.html', 'characters/npcs/doran.html']) {
      const { html } = laneOf(out, rel);
      assert.ok(!html.includes('class="cx"'), `${rel} still carries the pin's section`);
      assert.ok(!html.includes('js/connections.js'), `${rel} still loads the pin's section script`);
    }
  });
});

// -- applyConnections walk --------------------------------------------------------------------

test('applyConnections: walks the tree, patches section pages, reads ties from the vault, counts lanes', () => {
  withTmpDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    const siteRoot = path.join(dir, 'site');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Locations'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'NPCs'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: full\n---\n\nConfig.\n');
    fs.writeFileSync(path.join(vaultPath, 'Locations', 'X.md'), '---\ntype: location\nrelationships:\n  - target: "[[Tilda]]"\n    type: home_of\n---\n\nBody.\n');
    fs.writeFileSync(path.join(vaultPath, 'NPCs', 'Tilda.md'), '---\ntype: npc\n---\n\nBody.\n');

    fs.mkdirSync(path.join(siteRoot, 'locations'), { recursive: true });
    fs.writeFileSync(path.join(siteRoot, 'locations', 'x.html'), page({ cx: cxSection({ tabs: [people([{ n: 'Home of', d: [item('Tilda', '../npcs/tilda.html')] }])] }) }));
    fs.mkdirSync(path.join(siteRoot, 'npcs'), { recursive: true });
    fs.writeFileSync(path.join(siteRoot, 'npcs', 'tilda.html'), page({}));

    const result = applyConnections(siteRoot, { vaultPath, jsonConfig: { folderMap: { Locations: 'locations', NPCs: 'npcs' } } });
    assert.equal(result.pagesPatched, 1);
    assert.equal(result.lanes, 1);
    const written = fs.readFileSync(path.join(siteRoot, 'locations', 'x.html'), 'utf8');
    assert.ok(written.includes(CONNECTIONS_MARKER));
    assert.match(written, /<li class="sc-cx-kind-tie"><a href="[^"]*tilda\.html">Tilda<\/a> <span class="sc-cx-rel">home of<\/span><\/li>/);
  });
});
