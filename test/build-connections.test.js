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
  collectConnections,
  transformConnections,
  applyConnections,
} = require('../src/build/connections');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-connections-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -- SVG node fixture builder (mirrors lib/relationship-graph.js's renderRelationshipSVG shape) --

function svgNode({ href, label, opacity }) {
  const a = href !== undefined && href !== null;
  return (
    (a ? `<a href="${href}">` : '') +
    `<g opacity="${opacity}">\n` +
    `    <circle cx="1" cy="1" r="1"/>\n` +
    `    <text x="1" y="1" text-anchor="middle" font-size="11">${label}</text>\n` +
    `  </g>` +
    (a ? '</a>' : '') +
    '\n'
  );
}

function graphBlock(shape, nodesHtml) {
  if (shape === 'pc') {
    return `<h2>Connections</h2>\n<div class="relationship-graph"><svg viewBox="0 0 1 1">\n${nodesHtml}</svg></div>`;
  }
  const heading = shape === 'npc' ? 'Connections Graph' : 'Connections';
  return `<div class="relationship-graph"><h2>${heading}</h2><svg viewBox="0 0 1 1">\n${nodesHtml}</svg></div>`;
}

function relList(entries) {
  if (!entries.length) return '';
  const items = entries
    .map((e) => {
      const link = e.href ? `<a href="${e.href}" class="entity-link">${e.name}</a>` : e.name;
      const desc = e.description ? ` &mdash; ${e.description}` : '';
      return `<li><strong class="rel-label">${e.type}</strong> ${link}${desc}</li>`;
    })
    .join('\n');
  return `<h2>Relationships</h2>\n<ul class="relationship-list">\n${items}\n</ul>`;
}

function sidebar(entries) {
  if (!entries.length) return '';
  const items = entries
    .map((e) => {
      const link = e.href ? `<a href="${e.href}">${e.name}</a>` : e.name;
      return `<li>${link} <span class="sidebar-badge">${e.type}</span></li>`;
    })
    .join('\n');
  return `<aside class="context-sidebar">\n<h3>Relationships</h3>\n<ul>${items}</ul>\n</aside>`;
}

function whosHereConnections(cards) {
  return `<div class="whos-here">\n  <h2>Connections</h2>\n  <div class="relationship-cards">${cards}</div>\n</div>`;
}
function whosHereStoryArc() {
  return `<div class="whos-here">\n  <h2>Story Arc</h2>\n  <div class="entity-timeline"><div class="timeline-node"><a href="../../sessions/recap-01.html">Session 01</a></div></div>\n</div>`;
}

function page({ graph, relList: rl = '', sidebar: sb = '', whosHere = '', prose = '<p>Prose.</p>', pc = false, campaignRoute = false }) {
  const route = campaignRoute ? '<div class="relationship-graph" style="margin-bottom:2rem"><h3>Campaign Route</h3><svg></svg></div>' : '';
  const journeyWrap = (inner) => `<div class="tab-panel" id="tab-journey">\n${route}\n${inner}\n</div>`;
  const body = pc ? journeyWrap(graph || '') : `${prose}\n${rl}\n${sb}\n${whosHere}\n${graph || ''}`;
  return `<html><head></head><body>\n<main class="content">\n<h1 class="page-title">Page</h1>\n${body}\n</main>\n<script src="../../js/nav.js"></script>\n</body></html>`;
}

// -- T-C1: hop-1 comes from the SVG only ----------------------------------------------------

test('collectConnections: hop-1 excludes 0.5 (hop-2) nodes and meta types (T-C1)', () => {
  const nodes =
    svgNode({ href: '', label: 'Self', opacity: '1' }) +
    svgNode({ href: '../npcs/tilda.html', label: 'Tilda', opacity: '1' }) +
    svgNode({ href: '../npcs/ghost.html', label: 'Ghost', opacity: '0.5' }) +
    svgNode({ href: '../campaign/index.html', label: 'Campaign', opacity: '1' });
  const html = page({ graph: graphBlock('standard', nodes) });
  const htmlByPath = { 'locations/x.html': html };
  const published = new Map([
    ['locations/x.html', { displayTitle: 'X', type: 'location' }],
    ['characters/npcs/tilda.html', { displayTitle: 'Tilda', type: 'npc' }],
    ['characters/npcs/ghost.html', { displayTitle: 'Ghost', type: 'npc' }],
    ['campaign/index.html', { displayTitle: 'Campaign', type: 'campaign_overview' }],
  ]);
  const { pageModels } = collectConnections(htmlByPath, published);
  const m = pageModels.find((p) => p.outputPath === 'locations/x.html');
  const names = m.items.map((i) => i.name);
  assert.ok(names.includes('Tilda'));
  assert.ok(!names.includes('Ghost')); // hop-2 excluded
  assert.ok(!names.includes('Campaign')); // meta type excluded
});

// -- T-C2: classification tie/named/mention, object-form ties from the sidebar -----------------

test('collectConnections: tie (sidebar object-form), named (backlink), mention classification (T-C2)', () => {
  const tildaGraph = graphBlock('npc', svgNode({ href: '', label: 'H', opacity: '1' }) + svgNode({ href: '../pcs/grix.html', label: 'Grix', opacity: '1' }));
  const tildaPage = page({
    graph: tildaGraph,
    sidebar: sidebar([{ name: 'Grix', href: '../pcs/grix.html', type: 'Mentor' }]),
    whosHere: whosHereConnections('<a class="rel-card" href="../pcs/grix.html"><div class="rel-type">Mentor</div><div class="rel-name">Grix</div></a>') + whosHereStoryArc(),
  });

  const grixGraph = graphBlock('pc', svgNode({ href: '', label: 'B', opacity: '1' }) + svgNode({ href: '../npcs/tilda.html', label: 'Tilda', opacity: '1' }) + svgNode({ href: '../npcs/doran.html', label: 'Doran', opacity: '1' }));
  const grixPage = page({ graph: grixGraph, pc: true });

  const doranPage = page({
    graph: '',
    prose: '<p>Doran once helped <a href="../pcs/grix.html">Grix</a> at the gate.</p>',
  });

  const htmlByPath = {
    'characters/npcs/tilda.html': tildaPage,
    'characters/pcs/grix.html': grixPage,
    'characters/npcs/doran.html': doranPage,
  };
  const published = new Map([
    ['characters/npcs/tilda.html', { displayTitle: 'Tilda', type: 'npc' }],
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
    ['characters/npcs/doran.html', { displayTitle: 'Doran', type: 'npc' }],
  ]);

  const { pageModels } = collectConnections(htmlByPath, published);

  const tildaModel = pageModels.find((p) => p.outputPath === 'characters/npcs/tilda.html');
  const grixOnTilda = tildaModel.items.find((i) => i.name === 'Grix');
  assert.equal(grixOnTilda.kind, 'tie');
  assert.equal(grixOnTilda.rel, 'mentor');

  const grixModel = pageModels.find((p) => p.outputPath === 'characters/pcs/grix.html');
  const tildaOnGrix = grixModel.items.find((i) => i.name === 'Tilda');
  assert.equal(tildaOnGrix.kind, 'named');
  assert.equal(tildaOnGrix.rel, 'mentor Grix');

  const doranOnGrix = grixModel.items.find((i) => i.name === 'Doran');
  assert.equal(doranOnGrix.kind, 'mention');
  assert.equal(doranOnGrix.line, 'Doran once helped Grix at the gate.');
});

// -- T-C3: full names, never truncated; unlinked declared target renders nolink ----------------

test('collectConnections: names are never truncated; unlinked declared node renders sc-cx-nolink (T-C3)', () => {
  const longName = 'A Very Long Twenty Char Name'; // > 20 chars, would be truncated at 15/13 graphemes in the SVG label
  const nodes = svgNode({ href: '', label: 'Self', opacity: '1' }) + svgNode({ opacity: '1', label: 'A Very Long T\u2026', href: undefined });
  const html = page({
    graph: graphBlock('standard', nodes),
    relList: relList([{ name: longName, href: null, type: 'Ally', description: 'An old friend.' }]),
  });
  const htmlByPath = { 'locations/x.html': html };
  const published = new Map([['locations/x.html', { displayTitle: 'X', type: 'location' }]]);
  const { pageModels, warnings } = collectConnections(htmlByPath, published);
  const item = pageModels[0].items[0];
  assert.equal(item.name, longName);
  assert.equal(item.href, null);

  const model = { outputPath: 'locations/x.html', items: pageModels[0].items, sessions: [], name: 'X', start: 0, end: 0 };
  const rendered = require('../src/build/connections').renderLane(model);
  assert.ok(rendered.html.includes('sc-cx-nolink'));
  assert.ok(rendered.html.includes(htmltext.escapeHtml(longName)));
  void warnings;
});

// -- Reviewer MEDIUM item: canon-check's raw-text extractor inserts a phrase boundary only on
// -- block-level tag closes (div/p/li/... -- never span/a), and its name-run regex spans a bare
// -- space, including into a trailing session numeral. A literal space between <span>s is NOT
// -- enough (confirmed against a live canon-check run: "R Rasha Redshale II" still glued with a
// -- plain-space fix). The hub seal and hub name must be block elements (a <p> cannot legally
// -- contain a nested <div>, so the hub wrapper itself is a <div> too) so their closes give the
// -- extractor a real boundary. Consecutive session numeral <a> tags still get a plain space,
// -- which is enough there since the preceding hub-name boundary already stops the run.

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
  const rendered = require('../src/build/connections').renderLane(model);
  assert.match(rendered.html, /<div class="sc-cx-hub">/, 'expected the hub wrapper to be a <div>, not a <p> (a <p> cannot contain a nested <div>)');
  assert.match(rendered.html, /class="sc-cx-hub-seal"[^>]*>R<\/div><div class="sc-cx-hub-name">Rasha Redshale<\/div>/);
  assert.doesNotMatch(rendered.html, /sc-cx-hub-seal[^>]*>[^<]*<\/span>/, 'the seal must not be a <span> (canon-check does not treat its close as a boundary)');
  assert.doesNotMatch(rendered.html, /sc-cx-hub-name[^>]*>[^<]*<\/span>/, 'the name must not be a <span> (canon-check does not treat its close as a boundary)');
  assert.match(rendered.html, />I<\/a> <a href="[^"]*"[^>]*>II<\/a>/);
});

// -- T-C4: unknown type -> Other -------------------------------------------------------------

test('collectConnections: an unknown type goes to Other (T-C4)', () => {
  const nodes = svgNode({ href: '', label: 'Self', opacity: '1' }) + svgNode({ href: '../world/weird.html', label: 'Weird', opacity: '1' });
  const html = page({ graph: graphBlock('standard', nodes) });
  const htmlByPath = { 'locations/x.html': html, 'world/weird.html': page({}) };
  const published = new Map([
    ['locations/x.html', { displayTitle: 'X', type: 'location' }],
    ['world/weird.html', { displayTitle: 'Weird', type: 'clue' }],
  ]);
  const { pageModels } = collectConnections(htmlByPath, published);
  const item = pageModels[0].items.find((i) => i.name === 'Weird');
  assert.equal(item.group, 'other');
});

// -- T-C5: rank ---------------------------------------------------------------------------------

test('collectConnections: rank -- 11 shared recaps (55) outranks a named item (50); code-unit tie-break (T-C5)', () => {
  const nodes =
    svgNode({ href: '', label: 'Self', opacity: '1' }) +
    svgNode({ href: '../characters/npcs/named.html', label: 'Named', opacity: '1' }) +
    svgNode({ href: '../characters/npcs/mention.html', label: 'Mention', opacity: '1' }) +
    svgNode({ href: '../characters/npcs/zed.html', label: 'Zed', opacity: '1' }) +
    svgNode({ href: '../characters/npcs/ambar.html', label: 'Ámbar', opacity: '1' });
  const html = page({ graph: graphBlock('standard', nodes) });

  const namedPage = page({ relList: relList([{ name: 'X', href: '../../locations/x.html', type: 'Knows', description: null }]) });
  // sanity: the relList href above must actually resolve back to this page's own outputPath
  assert.equal(htmltext.resolveHref('characters/npcs/named.html', '../../locations/x.html'), 'locations/x.html');
  const htmlByPath = {
    'locations/x.html': html,
    'characters/npcs/named.html': namedPage,
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

  const { pageModels } = collectConnections(htmlByPath, published);
  const m = pageModels.find((p) => p.outputPath === 'locations/x.html');
  const named = m.items.find((i) => i.name === 'Named');
  const mention = m.items.find((i) => i.name === 'Mention');
  assert.equal(named.kind, 'named');
  assert.equal(mention.kind, 'mention');
  assert.equal(mention.shared.length, 11);
  assert.ok(mention.rank < named.rank, `mention rank ${mention.rank} should beat named rank ${named.rank}`);

  const zed = m.items.find((i) => i.name === 'Zed');
  const ambar = m.items.find((i) => i.name === 'Ámbar');
  // both score 0, tie-break by code-unit order: 'Z' (0x5A) < 'Á' (0xC1)
  assert.ok(zed.rank < ambar.rank);
});

// -- T-C6: trimLine -------------------------------------------------------------------------

test('trimLine: 180 unchanged, 195-with-sentence, 195-without, no-space (T-C6)', () => {
  const s180 = 'x'.repeat(180);
  assert.equal(trimLine(s180), s180);

  const withSentence = 'A'.repeat(95) + '. ' + 'B'.repeat(100);
  const trimmed = trimLine(withSentence);
  assert.equal(trimmed, 'A'.repeat(95) + '.');

  const withoutSentence = 'C'.repeat(195);
  const trimmedNoSentence = trimLine(withoutSentence);
  assert.equal(trimmedNoSentence, 'C'.repeat(189) + '…');

  const noSpace195 = 'D'.repeat(195);
  assert.equal(trimLine(noSpace195), 'D'.repeat(189) + '…');
});

// -- T-C7: snippets are verbatim substrings of the pre-transform page -----------------------

test('collectConnections: mention line is a verbatim substring of the source page prose (T-C7)', () => {
  const nodes = svgNode({ href: '', label: 'Self', opacity: '1' }) + svgNode({ href: '../npcs/doran.html', label: 'Doran', opacity: '1' });
  const grixPage = page({ graph: graphBlock('pc', nodes), pc: true });
  const doranPage = page({ prose: '<p>Long ago Doran met <a href="../pcs/grix.html">Grix</a> near the gate, and they spoke for hours about the lane ahead and the price of duskveil in the harbor corner that season.</p>' });

  const htmlByPath = { 'characters/pcs/grix.html': grixPage, 'characters/npcs/doran.html': doranPage };
  const published = new Map([
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
    ['characters/npcs/doran.html', { displayTitle: 'Doran', type: 'npc' }],
  ]);
  const { pageModels } = collectConnections(htmlByPath, published);
  const grixModel = pageModels.find((p) => p.outputPath === 'characters/pcs/grix.html');
  const item = grixModel.items.find((i) => i.name === 'Doran');
  const sourceText = htmltext.textOf(htmltext.proseRegion(doranPage));
  const withoutEllipsis = item.line.replace(/…$/, '');
  assert.ok(sourceText.includes(withoutEllipsis), `"${withoutEllipsis}" not found in "${sourceText}"`);
});

test('mention snippet prefers a <p> over a relationship-list <li> on the same page (T-C7)', () => {
  const nodes = svgNode({ href: '', label: 'Self', opacity: '1' }) + svgNode({ href: '../characters/npcs/target.html', label: 'Target', opacity: '1' });
  const sourcePage = page({
    graph: '',
    relList: relList([{ name: 'Someone Else', href: '../npcs/other.html', type: 'ally', description: null }]),
    prose: '<p>This page also mentions <a href="../../locations/x.html">X</a> in prose.</p>',
  });
  const mainPage = page({ graph: graphBlock('standard', nodes) });
  const htmlByPath = { 'locations/x.html': mainPage, 'characters/npcs/target.html': sourcePage };
  const published = new Map([
    ['locations/x.html', { displayTitle: 'X', type: 'location' }],
    ['characters/npcs/target.html', { displayTitle: 'Target', type: 'npc' }],
  ]);
  const { pageModels } = collectConnections(htmlByPath, published);
  const m = pageModels.find((p) => p.outputPath === 'locations/x.html');
  assert.equal(m.items[0].line, 'This page also mentions X in prose.');
});

// -- T-C8: NPC rel-cards removed, Story Arc stays, one <h2>Connections</h2> -------------------

test('transformConnections: NPC rel-cards whos-here removed, Story Arc stays, exactly one <h2>Connections</h2> (T-C8)', () => {
  const nodes = svgNode({ href: '', label: 'H', opacity: '1' }) + svgNode({ href: '../pcs/grix.html', label: 'Grix', opacity: '1' });
  const html = page({
    graph: graphBlock('npc', nodes),
    sidebar: sidebar([{ name: 'Grix', href: '../pcs/grix.html', type: 'Mentor' }]),
    whosHere: whosHereConnections('<a class="rel-card" href="../pcs/grix.html"><div class="rel-type">Mentor</div><div class="rel-name">Grix</div></a>') + whosHereStoryArc(),
  });
  const htmlByPath = { 'characters/npcs/tilda.html': html, 'characters/pcs/grix.html': page({ pc: true }) };
  const published = new Map([
    ['characters/npcs/tilda.html', { displayTitle: 'Tilda', type: 'npc' }],
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
  ]);
  const { pageModels } = collectConnections(htmlByPath, published);
  const model = pageModels.find((p) => p.outputPath === 'characters/npcs/tilda.html');
  const result = transformConnections(html, model);
  assert.notEqual(result, null);
  assert.ok(!result.html.includes('relationship-cards'));
  assert.ok(result.html.includes('Story Arc'));
  const count = (result.html.match(/<h2>Connections<\/h2>/g) || []).length;
  assert.equal(count, 1);
});

test('WHOS_HERE_CX_RE matches only the Connections rel-cards whos-here, never the Story Arc one, regardless of order (T-C8 mutation guard)', () => {
  const { WHOS_HERE_CX_RE } = require('../src/build/connections');
  assert.doesNotMatch(whosHereStoryArc(), WHOS_HERE_CX_RE);
  assert.match(whosHereConnections('<a class="rel-card"></a>'), WHOS_HERE_CX_RE);
  // Story Arc first, Connections second: a regex loosened to match "any h2" would hit Story
  // Arc's whos-here first (leftmost match) and remove the wrong block.
  const storyArcFirst = whosHereStoryArc() + whosHereConnections('<a class="rel-card"></a>');
  const m = storyArcFirst.match(WHOS_HERE_CX_RE);
  assert.ok(m);
  assert.equal(m.index, whosHereStoryArc().length);
});

// -- T-C10: PC lane in Journey tab, Campaign Route untouched ----------------------------------

test('transformConnections: PC lane replaces the h2+div inside #tab-journey; Campaign Route bytes unchanged (T-C10)', () => {
  const nodes = svgNode({ href: '', label: 'B', opacity: '1' }) + svgNode({ href: '../npcs/tilda.html', label: 'Tilda', opacity: '1' });
  const html = page({ graph: graphBlock('pc', nodes), pc: true, campaignRoute: true });
  const htmlByPath = { 'characters/pcs/grix.html': html, 'characters/npcs/tilda.html': page({}) };
  const published = new Map([
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
    ['characters/npcs/tilda.html', { displayTitle: 'Tilda', type: 'npc' }],
  ]);
  const { pageModels } = collectConnections(htmlByPath, published);
  const model = pageModels.find((p) => p.outputPath === 'characters/pcs/grix.html');
  const result = transformConnections(html, model);
  assert.ok(result.html.includes('<h3>Campaign Route</h3>'));
  const routeIdx = result.html.indexOf('<h3>Campaign Route</h3>');
  const journeyIdx = result.html.indexOf('id="tab-journey"');
  const laneIdx = result.html.indexOf('class="sc-cx"');
  assert.ok(journeyIdx < routeIdx && routeIdx < laneIdx, 'expected Route before the lane, both inside tab-journey');
});

// -- T-C11: hub-only, removed-only, no-graph byte-identical -----------------------------------

test('transformConnections: no items but sessions present -> hub-only; no items and no sessions -> removedOnly (T-C11)', () => {
  const nodes = svgNode({ href: '', label: 'X', opacity: '1' }) + svgNode({ href: '../campaign/index.html', label: 'Campaign', opacity: '1' });
  const html = page({ graph: graphBlock('standard', nodes) });
  const htmlByPath = { 'locations/x.html': html };
  const published = new Map([
    ['locations/x.html', { displayTitle: 'X', type: 'location' }],
    ['campaign/index.html', { displayTitle: 'Campaign', type: 'campaign_overview' }],
  ]);
  const { pageModels } = collectConnections(htmlByPath, published);
  const model = pageModels[0];
  assert.equal(model.items.length, 0);
  assert.equal(model.sessions.length, 0);
  const result = transformConnections(html, model);
  assert.equal(result.removedOnly, true);
  assert.ok(!result.html.includes('sc-cx'));
  assert.ok(!result.html.includes(SITE_SCRIPT_MARKER), 'the script must not be linked on a removed-only page');
});

test('transformConnections: a page with no graph is not in pageModels at all (byte-identical) (T-C11)', () => {
  const html = page({ graph: '', prose: '<p>Nothing here.</p>' });
  const htmlByPath = { 'documents/note.html': html };
  const published = new Map([['documents/note.html', { displayTitle: 'Note', type: 'document' }]]);
  const { pageModels } = collectConnections(htmlByPath, published);
  assert.equal(pageModels.length, 0);
});

// -- T-C12: idempotent ------------------------------------------------------------------------

test('transformConnections: idempotent', () => {
  const nodes = svgNode({ href: '', label: 'H', opacity: '1' }) + svgNode({ href: '../pcs/grix.html', label: 'Grix', opacity: '1' });
  const html = page({ graph: graphBlock('standard', nodes), sidebar: sidebar([{ name: 'Grix', href: '../pcs/grix.html', type: 'ally' }]) });
  const htmlByPath = { 'characters/npcs/tilda.html': html, 'characters/pcs/grix.html': page({}) };
  const published = new Map([
    ['characters/npcs/tilda.html', { displayTitle: 'Tilda', type: 'npc' }],
    ['characters/pcs/grix.html', { displayTitle: 'Grix', type: 'pc' }],
  ]);
  const { pageModels } = collectConnections(htmlByPath, published);
  const model = pageModels.find((p) => p.outputPath === 'characters/npcs/tilda.html');
  const first = transformConnections(html, model).html;
  assert.ok(first.includes(CONNECTIONS_MARKER));
  const second = transformConnections(first, model);
  assert.equal(second, null);
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
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\bIntl\b|toLocale|localeCompare/, f);
  }
});

// -- applyConnections walk --------------------------------------------------------------------

test('applyConnections: walks the tree, patches graph pages, counts lanes/hubOnly/removedOnly', () => {
  withTmpDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    const siteRoot = path.join(dir, 'site');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Locations'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: full\n---\n\nConfig.\n');
    fs.writeFileSync(path.join(vaultPath, 'Locations', 'X.md'), '---\ntype: location\n---\n\nBody.\n');

    fs.mkdirSync(path.join(siteRoot, 'locations'), { recursive: true });
    const nodes = svgNode({ href: '', label: 'X', opacity: '1' }) + svgNode({ href: '../npcs/tilda.html', label: 'Tilda', opacity: '1' });
    fs.writeFileSync(path.join(siteRoot, 'locations', 'x.html'), page({ graph: graphBlock('standard', nodes) }));
    fs.mkdirSync(path.join(siteRoot, 'characters', 'npcs'), { recursive: true });
    fs.writeFileSync(path.join(siteRoot, 'characters', 'npcs', 'tilda.html'), page({}));

    const jsonConfig = { folderMap: { Locations: 'locations' } };
    const result = applyConnections(siteRoot, { vaultPath, jsonConfig });
    assert.equal(result.pagesPatched, 1);
    assert.equal(result.lanes, 1);
    const written = fs.readFileSync(path.join(siteRoot, 'locations', 'x.html'), 'utf8');
    assert.ok(written.includes(CONNECTIONS_MARKER));
  });
});
