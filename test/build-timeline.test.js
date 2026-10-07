'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectRecaps } = require('../src/build/recaps');
const {
  TIMELINE_MARKER,
  stripTimestamps,
  extractPoints,
  buildTimelineModel,
  transformTimeline,
} = require('../src/build/timeline');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-timeline-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -- T-T1: stripTimestamps literal table ---------------------------------------------------

test('stripTimestamps: literal cases (T-T1)', () => {
  const cases = [
    ['toll asked 00:38:33, a javelin 00:57:02, surrender 01:28:54', 'toll asked, a javelin, surrender'],
    ['“many folk” 01:33:31; ropes slipped 01:49:48; “be kind” 01:51:30', '“many folk”; ropes slipped; “be kind”'],
    ['A quarrel 03:41-03:47; the cook: “no” 03:47:26; burned 03:49:14', 'A quarrel; the cook: “no”; burned'],
    ['Recorded (00:10:00) at camp', 'Recorded at camp'],
    ['Seen (dawn, 05:10) twice', 'Seen (dawn) twice'],
    ['odds 123:45', 'odds 123:45'],
    ['(perception 19), 3h 53m, +30 min', '(perception 19), 3h 53m, +30 min'],
    ['ends 12:00.', 'ends.'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(stripTimestamps(input), expected, input);
  }
});

// -- table fixture builders -----------------------------------------------------------------

function timelinePage({ backstoryRows, campaignRows, campaignHeaders, anchorRows, includeAnchor = true }) {
  const bsHeader = '<tr><th>Title</th><th>Kind</th><th>Weight</th><th>Place</th><th>When</th><th>What</th></tr>';
  const bsRows = backstoryRows
    .map((r) => `<tr><td>${r.title}</td><td>${r.kind}</td><td>${r.weight}</td><td>${r.place}</td><td>${r.when}</td><td>${r.what}</td></tr>`)
    .join('\n');

  const headers = campaignHeaders || ['Title', 'Kind', 'Weight', 'Place', 'In-game', 'Real-world', 'What'];
  const cHeader = `<tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>`;
  const cellFor = (r, h) => {
    const map = { Title: r.title, Kind: r.kind, Weight: r.weight, Place: r.place, 'In-game': r.when, 'Real-world': r.realWorld, What: r.what };
    return map[h] !== undefined ? map[h] : '';
  };
  const cRows = campaignRows.map((r) => `<tr>${headers.map((h) => `<td>${cellFor(r, h)}</td>`).join('')}</tr>`).join('\n');

  const anchorTable = includeAnchor
    ? '<h2>Learned anchors</h2>\n<table>\n<thead>\n<tr><th>Session</th><th>Learned</th><th>After</th></tr>\n</thead>\n<tbody>\n' +
      anchorRows.map((r) => `<tr><td>${r.session}</td><td>${r.learned}</td><td>${r.after}</td></tr>`).join('\n') +
      '\n</tbody>\n</table>\n'
    : '';

  return (
    '<html><head></head><body>\n' +
    '<main class="content">\n' +
    '<h1 class="page-title">Timeline</h1>\n' +
    '<p>Intro paragraph.</p>\n' +
    '<h2>Backstory and setting</h2>\n' +
    `<table>\n<thead>\n${bsHeader}\n</thead>\n<tbody>\n${bsRows}\n</tbody>\n</table>\n` +
    '<h2>The campaign</h2>\n' +
    `<table>\n<thead>\n${cHeader}\n</thead>\n<tbody>\n${cRows}\n</tbody>\n</table>\n` +
    anchorTable +
    '<h2>Session log</h2>\n<ul><li>log</li></ul>\n' +
    '</main>\n</body></html>'
  );
}

function recapHtml({ num, title, date, learnedLis }) {
  return (
    '<html><head></head><body>\n<main class="content">\n' +
    `<h1 class="page-title">${title}</h1>\n` +
    `<span class="metadata-badge" data-field="session_number">${num}</span>\n` +
    `<span class="metadata-badge" data-field="play_date">${date}</span>\n` +
    '<h2>What the Party Learned</h2>\n<ul>\n' +
    learnedLis.map((li) => `<li>${li}</li>`).join('\n') +
    '\n</ul>\n</main>\n</body></html>'
  );
}

function baseFixture() {
  const backstoryRows = [{ title: 'The Meteor', kind: 'backstory', weight: '2', place: 'Before', when: '15 years ago', what: 'The meteor falls.' }];
  const campaignRows = [
    { title: 'The Hire', kind: 'meeting', weight: '2', place: 'The lane', when: 'Road, week 1', realWorld: '2026-10-02 (S1)', what: 'The party leaves Fenmoor 00:07:18.' },
    { title: "Talven's Shakedown", kind: 'fight', weight: '3', place: 'The lane', when: 'Road, week 2', realWorld: 'S1', what: 'toll demanded 00:38:33, javelin 00:57:02, Talven surrenders 01:28:54' },
    { title: 'Arrival', kind: 'journey', weight: '3', place: 'Ashbourne', when: 'Ashbourne, day 1, dusk', realWorld: 'S2', what: 'The party arrives 00:37:44.' },
  ];
  const anchorRows = [
    { session: 'S1', learned: 'The debt is a trap', after: "Talven's Shakedown" },
    { session: 'S2', learned: 'Renwick pays 25gp each', after: 'Arrival' },
  ];
  const html = timelinePage({ backstoryRows, campaignRows, anchorRows });
  const recaps = collectRecaps({
    'sessions/recap-01.html': recapHtml({ num: 1, title: 'Session 01', date: '2 October 2026', learnedLis: ['<strong>The debt is a trap.</strong> Talven lies.'] }),
    'sessions/recap-02.html': recapHtml({ num: 2, title: 'Session 02', date: '9 October 2026', learnedLis: ['<strong>Renwick pays 25gp each.</strong> Outside the signalpost.'] }),
  });
  return { html, recaps };
}

// -- T-T2: column-by-name (shuffled headers) ---------------------------------------------------

test('extractPoints: columns are located by name, not position (T-T2)', () => {
  const { html, recaps } = baseFixture();
  const warnings = [];
  const model1 = extractPoints(html, 'campaign/timeline.html', recaps, warnings);

  const shuffledHtml = timelinePage({
    backstoryRows: [{ title: 'The Meteor', kind: 'backstory', weight: '2', place: 'Before', when: '15 years ago', what: 'The meteor falls.' }],
    campaignHeaders: ['Kind', 'In-game', 'Title', 'Real-world', 'What', 'Place', 'Weight'],
    campaignRows: [
      { title: 'The Hire', kind: 'meeting', weight: '2', place: 'The lane', when: 'Road, week 1', realWorld: '2026-10-02 (S1)', what: 'The party leaves Fenmoor 00:07:18.' },
      { title: "Talven's Shakedown", kind: 'fight', weight: '3', place: 'The lane', when: 'Road, week 2', realWorld: 'S1', what: 'toll demanded 00:38:33, javelin 00:57:02, Talven surrenders 01:28:54' },
      { title: 'Arrival', kind: 'journey', weight: '3', place: 'Ashbourne', when: 'Ashbourne, day 1, dusk', realWorld: 'S2', what: 'The party arrives 00:37:44.' },
    ],
    anchorRows: [
      { session: 'S1', learned: 'The debt is a trap', after: "Talven's Shakedown" },
      { session: 'S2', learned: 'Renwick pays 25gp each', after: 'Arrival' },
    ],
  });
  const model2 = extractPoints(shuffledHtml, 'campaign/timeline.html', recaps, []);

  assert.deepEqual(
    model1.points.map((p) => [p.t, p.k, p.w, p.when, p.x]),
    model2.points.map((p) => [p.t, p.k, p.w, p.when, p.x]),
  );
});

// -- T-T3: unknown Kind ---------------------------------------------------------------------

test('extractPoints: unknown Kind gives k:"" and one warning (T-T3)', () => {
  const html = timelinePage({
    backstoryRows: [],
    campaignRows: [{ title: 'A brawl', kind: 'brawl', weight: '2', place: 'The lane', when: 'Road, week 1', realWorld: 'S1', what: 'A fight.' }],
    anchorRows: [],
  });
  const warnings = [];
  const model = extractPoints(html, 'campaign/timeline.html', new Map(), warnings);
  assert.equal(model.points[0].k, '');
  assert.ok(warnings.some((w) => w.includes('unknown Kind')));
});

// -- T-T4: missing Title -------------------------------------------------------------------

test('extractPoints: missing Title falls back to the when-label, warns (T-T4)', () => {
  const html = timelinePage({
    backstoryRows: [],
    campaignRows: [{ title: '', kind: 'meeting', weight: '2', place: 'The lane', when: 'Road, week 1', realWorld: 'S1', what: 'x' }],
    anchorRows: [],
  });
  const warnings = [];
  const model = extractPoints(html, 'campaign/timeline.html', new Map(), warnings);
  assert.equal(model.points[0].t, 'Road, week 1');
  assert.ok(warnings.some((w) => w.includes('empty Title')));
});

// -- T-T5: Weight ---------------------------------------------------------------------------

test('extractPoints: invalid/empty Weight defaults to 2 with a warning; missing column warns once per table (T-T5)', () => {
  const htmlInvalid = timelinePage({
    backstoryRows: [],
    campaignRows: [
      { title: 'A', kind: 'meeting', weight: '4', place: 'The lane', when: 'Road, week 1', realWorld: 'S1', what: 'x' },
      { title: 'B', kind: 'meeting', weight: '', place: 'The lane', when: 'Road, week 1', realWorld: 'S1', what: 'y' },
    ],
    anchorRows: [],
  });
  const warnings1 = [];
  const model1 = extractPoints(htmlInvalid, 'campaign/timeline.html', new Map(), warnings1);
  assert.equal(model1.points[0].w, 2);
  assert.equal(model1.points[1].w, 2);
  assert.equal(warnings1.filter((w) => w.includes('invalid Weight')).length, 2);

  const htmlNoCol = timelinePage({
    backstoryRows: [],
    campaignHeaders: ['Title', 'Kind', 'In-game', 'Real-world', 'What'],
    campaignRows: [{ title: 'A', kind: 'meeting', when: 'Road, week 1', realWorld: 'S1', what: 'x' }],
    anchorRows: [],
  });
  const warnings2 = [];
  extractPoints(htmlNoCol, 'campaign/timeline.html', new Map(), warnings2);
  assert.equal(warnings2.filter((w) => w.includes('no Weight column')).length, 1);
});

// -- T-T6: Place inherits ------------------------------------------------------------------

test('extractPoints: an empty Place inherits the previous row\'s Place, across tables (T-T6)', () => {
  const html = timelinePage({
    backstoryRows: [{ title: 'The Meteor', kind: 'backstory', weight: '2', place: 'Before', when: '15 years ago', what: 'x' }],
    campaignRows: [
      { title: 'A', kind: 'meeting', weight: '2', place: 'The lane', when: 'Road, week 1', realWorld: 'S1', what: 'x' },
      { title: 'B', kind: 'meeting', weight: '2', place: '', when: 'Road, week 2', realWorld: 'S1', what: 'y' },
    ],
    anchorRows: [],
  });
  const model = extractPoints(html, 'campaign/timeline.html', new Map(), []);
  // backstory's Place ('Before') must NOT leak into the campaign table's first row ('The lane' is explicit)
  assert.equal(model.points[0].seg, model.segments[0].id);
  assert.equal(model.segments[0].tier, 'Before');
  const bIdx = model.points.findIndex((p) => p.t === 'B');
  const segForB = model.segments.find((s) => s.id === model.points[bIdx].seg);
  assert.equal(segForB.tier, 'The lane');
});

// -- T-T7: segments -------------------------------------------------------------------------

test('extractPoints: segment labels and (Place,label) changes (T-T7)', () => {
  const html = timelinePage({
    backstoryRows: [{ title: 'The Meteor', kind: 'backstory', weight: '2', place: 'Before', when: '15 years ago', what: 'x' }],
    campaignRows: [
      { title: 'A', kind: 'meeting', weight: '2', place: 'The lane', when: 'Road, week 2', realWorld: 'S1', what: 'x' },
      { title: 'B', kind: 'meeting', weight: '2', place: 'The lane', when: 'Road, week 2, +30 min', realWorld: 'S1', what: 'y' },
      { title: 'C', kind: 'meeting', weight: '2', place: 'Ashbourne', when: 'Ashbourne, day 1, dusk', realWorld: 'S2', what: 'z' },
    ],
    anchorRows: [],
  });
  const model = extractPoints(html, 'campaign/timeline.html', new Map(), []);
  const labels = model.segments.map((s) => s.label);
  assert.equal(labels[0], '15 years ago');
  assert.equal(labels[1], 'Week 2'); // both A and B fold into one segment (same Place+label)
  assert.equal(model.segments.length, 3); // Before, Week 2 (road), Day 1 (ashbourne)
  assert.equal(model.segments[0].before, true);
  assert.equal(model.segments[1].before, false);
});

// -- T-T9/T-T10/T-T11: transform output ------------------------------------------------------

test('transformTimeline: helper cells stripped, anchor table+h2 removed, wrapper present, intro/log unchanged (T-T9)', () => {
  const { html, recaps } = baseFixture();
  const warnings = [];
  const patched = require('../src/build/timeline').transformTimeline(html, 'campaign/timeline.html', recaps, warnings);
  assert.notEqual(patched, null);
  assert.ok(patched.includes('<p>Intro paragraph.</p>'));
  assert.ok(patched.includes('<h2>Session log</h2>'));
  assert.ok(patched.includes('<li>log</li>'));
  assert.ok(!patched.includes('Learned anchors'));
  assert.ok(!patched.includes('<th>Title</th>'));
  assert.ok(!patched.includes('<th>Kind</th>'));
  assert.ok(patched.includes('class="sc-tl-src"'));
  assert.ok(patched.includes(TIMELINE_MARKER));
  assert.ok(patched.includes('class="sc-tl-data"'));
});

test('transformTimeline: a page with no opted-in table returns null, byte-untouched (T-T10)', () => {
  const html = '<html><head></head><body><main class="content"><h1 class="page-title">Timeline</h1><table><thead><tr><th>When</th><th>What</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table></main></body></html>';
  const patched = require('../src/build/timeline').transformTimeline(html, 'campaign/timeline.html', new Map(), []);
  assert.equal(patched, null);
});

test('transformTimeline: idempotent (T-T11)', () => {
  const { html, recaps } = baseFixture();
  const first = transformTimeline(html, 'campaign/timeline.html', recaps, []);
  const second = transformTimeline(first, 'campaign/timeline.html', recaps, []);
  assert.equal(second, null);
});

// -- T-T8: anchors --------------------------------------------------------------------------

test('placeLearnedItems: curly/straight quotes, case, trailing punctuation ignored; unmatched -> last row of session; every learned item present (T-T8)', () => {
  const html = timelinePage({
    backstoryRows: [],
    campaignRows: [
      { title: 'Row One', kind: 'meeting', weight: '2', place: 'The lane', when: 'Road, week 1', realWorld: 'S1', what: 'x' },
      { title: 'Row Two', kind: 'meeting', weight: '2', place: 'The lane', when: 'Road, week 2', realWorld: 'S1', what: 'y' },
    ],
    anchorRows: [
      { session: 'S1', learned: '“Curly quotes match”', after: 'Row One' },
      { session: 'S1', learned: 'No matching lead', after: 'Row One' },
    ],
  });
  const recaps = collectRecaps({
    'sessions/recap-01.html': recapHtml({
      num: 1,
      title: 'Session 01',
      date: 'd',
      learnedLis: ['<strong>"Curly quotes match".</strong> body one.', '<strong>Unrelated lead.</strong> body two, After names no row.'],
    }),
  });
  const warnings = [];
  const model = buildTimelineModel(html, 'campaign/timeline.html', recaps, warnings);
  assert.equal(model.learned.total, 2);
  assert.equal(model.island.learned.length, 2);
  // the matched one resolves to Row One's point id
  const rowOneId = model.points.find((p) => p.t === 'Row One').id;
  const matched = model.island.learned.find((l) => l.t === '"Curly quotes match"');
  assert.equal(matched.after, rowOneId);
  const unmatched = model.island.learned.find((l) => l.t === 'Unrelated lead');
  // "Unrelated lead" has no matching (session,key) anchor row at all -> placed after the last row of its session
  const rowTwoId = model.points.find((p) => p.t === 'Row Two').id;
  assert.equal(unmatched.after, rowTwoId);
});

// -- T-T12: target selection ------------------------------------------------------------------

test('applyTimeline: target selection, type:timeline wins over x/timeline.html (T-T12)', () => {
  withTmpDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    const siteRoot = path.join(dir, 'site');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Campaign'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: full\n---\n\nConfig.\n');
    fs.writeFileSync(path.join(vaultPath, 'Campaign', 'Timeline.md'), '---\ntype: timeline\n---\n\nBody.\n');

    fs.mkdirSync(path.join(siteRoot, 'campaign'), { recursive: true });
    fs.mkdirSync(path.join(siteRoot, 'other'), { recursive: true });
    const { html } = baseFixture();
    fs.writeFileSync(path.join(siteRoot, 'campaign', 'timeline.html'), html);
    // a decoy page also named timeline.html but NOT type: timeline (unmapped folder so it isn't
    // in publishedPages either way -- this just proves type:timeline is what wins when present)
    fs.writeFileSync(path.join(siteRoot, 'other', 'timeline.html'), '<html><body><main class="content"></main></body></html>');

    const jsonConfig = { folderMap: { Campaign: 'campaign' } };
    const { applyTimeline } = require('../src/build/timeline');
    const result = applyTimeline(siteRoot, { vaultPath, jsonConfig });
    assert.equal(result.target, 'campaign/timeline.html');
    assert.equal(result.pagesPatched, 1);
    assert.equal(result.points, 4);
  });
});

// -- T-T13: no timestamp survives in any point body -------------------------------------------

test('no point x in any island matches /\\d{1,2}:\\d{2}/ (T-T13)', () => {
  const { html, recaps } = baseFixture();
  const model = buildTimelineModel(html, 'campaign/timeline.html', recaps, []);
  for (const p of model.points) {
    assert.doesNotMatch(p.x, /\d{1,2}:\d{2}/, p.x);
  }
});
