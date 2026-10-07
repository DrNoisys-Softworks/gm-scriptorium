'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectRecaps } = require('../src/build/recaps');

function recapPage({ num, title, date, learnedLis, prose }) {
  return (
    '<main class="content">' +
    `<h1 class="page-title">${title}</h1>` +
    `<span class="metadata-badge" data-field="session_number">${num}</span>` +
    `<span class="metadata-badge" data-field="play_date">${date}</span>` +
    `<p>${prose || 'Recap prose.'}</p>` +
    '<h2>What the Party Learned</h2>\n<ul>\n' +
    learnedLis.map((li) => `<li>${li}</li>`).join('\n') +
    '\n</ul>' +
    '</main>'
  );
}

test('collectRecaps: basic session/title/date/learned parse', () => {
  const html = {
    'sessions/recap-01.html': recapPage({
      num: 1,
      title: 'Session 01',
      date: '2 October 2026',
      learnedLis: ['<strong>The debt is a trap.</strong> Talven lies about the debt.'],
    }),
  };
  const recaps = collectRecaps(html);
  assert.equal(recaps.size, 1);
  const r = recaps.get(1);
  assert.equal(r.outputPath, 'sessions/recap-01.html');
  assert.equal(r.num, 'I');
  assert.equal(r.title, 'Session 01');
  assert.equal(r.date, '2 October 2026');
  assert.equal(r.learned.length, 1);
  assert.equal(r.learned[0].title, 'The debt is a trap');
  assert.equal(r.learned[0].body, 'Talven lies about the debt.');
});

test('collectRecaps: no leading <strong> uses whole item as lead and warns', () => {
  const html = {
    'sessions/recap-01.html': recapPage({ num: 1, title: 'S1', date: 'd', learnedLis: ['Plain text lesson.'] }),
  };
  const recaps = collectRecaps(html);
  const r = recaps.get(1);
  assert.equal(r.learned[0].title, 'Plain text lesson');
  assert.equal(r.learned[0].body, '');
  assert.ok(recaps.warnings.some((w) => w.includes('no leading <strong>')));
});

test('collectRecaps: duplicate session_number keeps the first by sorted path, warns', () => {
  const html = {
    'sessions/recap-01a.html': recapPage({ num: 1, title: 'First', date: 'd', learnedLis: ['<strong>A.</strong> x'] }),
    'sessions/recap-01b.html': recapPage({ num: 1, title: 'Second', date: 'd', learnedLis: ['<strong>B.</strong> y'] }),
  };
  const recaps = collectRecaps(html);
  assert.equal(recaps.size, 1);
  assert.equal(recaps.get(1).outputPath, 'sessions/recap-01a.html');
  assert.ok(recaps.warnings.some((w) => w.includes('duplicate session_number')));
});

test('collectRecaps: links come from proseRegion, resolved', () => {
  const html = {
    'sessions/recap-01.html': recapPage({
      num: 1,
      title: 'S1',
      date: 'd',
      learnedLis: ['<strong>A.</strong> x'],
      prose: 'Visits <a href="../characters/npcs/tilda.html">Tilda</a>.',
    }),
  };
  const recaps = collectRecaps(html);
  const r = recaps.get(1);
  assert.ok(r.links.has('characters/npcs/tilda.html'));
});

test('collectRecaps: an earlier <h2> not immediately followed by <ul> does not swallow the real "What the Party Learned" heading (regression)', () => {
  const html =
    '<main class="content">' +
    '<h1 class="page-title">Session 01</h1>' +
    '<span class="metadata-badge" data-field="session_number">1</span>' +
    '<span class="metadata-badge" data-field="play_date">2 October 2026</span>' +
    '<h2>Narrative Recap</h2>' +
    '<p>Prose with an <h3>inline-looking</h3> aside and more prose.</p>' +
    '<h2>What the Party Learned</h2>\n<ul>\n<li><strong>The debt is a trap.</strong> Talven lies.</li>\n</ul>' +
    '<h2>Where We Left Off</h2>\n<p>Camped short of Ashbourne.</p>' +
    '</main>';
  const recaps = collectRecaps({ 'sessions/recap-01.html': html });
  const r = recaps.get(1);
  assert.equal(r.learned.length, 1);
  assert.equal(r.learned[0].title, 'The debt is a trap');
});

test('collectRecaps: a page with no session_number is not a recap', () => {
  const html = { 'campaign/timeline.html': '<main class="content"><h1 class="page-title">Timeline</h1></main>' };
  const recaps = collectRecaps(html);
  assert.equal(recaps.size, 0);
});
