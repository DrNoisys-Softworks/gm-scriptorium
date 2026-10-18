'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DATES_PATH = path.join(__dirname, '..', 'src', 'build', 'dates.js');
const { DATE_TOSTRING_RE, transformDates, applyDateFormat } = require('../src/build/dates');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-dates-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Runs transformDates in a fresh child process under a given TZ (and, optionally, with
// globalThis.Intl deleted first), so the assertion is never contaminated by this test runner's
// own process-wide TZ / Intl state. Builds String(new Date(Date.UTC(y,m,d))) inside the child --
// the exact shape a date-only vault frontmatter value round-trips to through gray-matter and
// String(Date) -- and asserts the LITERAL expected output text, never derived from dates.js itself.
function runInChildTz({ tz, y, m, d, deleteIntl }) {
  const script = `
${deleteIntl ? 'delete globalThis.Intl;' : ''}
const { transformDates } = require(${JSON.stringify(DATES_PATH)});
const raw = String(new Date(Date.UTC(${y}, ${m}, ${d})));
const html = '<span class="metadata-badge">' + raw + '</span>';
const out = transformDates(html);
process.stdout.write(out === null ? html : out);
`;
  const res = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `child exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

function assertTzCase(tz, y, m, d, expectedDate) {
  test(`TZ matrix: ${tz} on ${y}-${m + 1}-${d} -> "${expectedDate}"`, () => {
    const out = runInChildTz({ tz, y, m, d });
    assert.equal(out, `<span class="metadata-badge">${expectedDate}</span>`);
  });
}

// -- TZ matrix (brief section "build-dates.test.js") --------------------------------------------

assertTzCase('UTC', 2026, 8, 17, '17 September 2026');
assertTzCase('Australia/Melbourne', 2026, 8, 17, '17 September 2026');
assertTzCase('America/Los_Angeles', 2026, 8, 17, '17 September 2026');
assertTzCase('Australia/Melbourne', 2026, 0, 5, '5 January 2026'); // DST, +1100
assertTzCase('Pacific/Kiritimati', 2026, 8, 4, '4 September 2026'); // +14
assertTzCase('Pacific/Pago_Pago', 2026, 8, 4, '4 September 2026'); // -11
// America/St_Johns is -0230: this is the case that catches dropping the offset's minutes.
assertTzCase('America/St_Johns', 2026, 8, 11, '11 September 2026');

test('with globalThis.Intl deleted before requiring dates.js, the transform still works', () => {
  const out = runInChildTz({ tz: 'Australia/Melbourne', y: 2026, m: 8, d: 17, deleteIntl: true });
  assert.equal(out, '<span class="metadata-badge">17 September 2026</span>');
});

test('source grep: dates.js uses no Intl and no toLocale*', () => {
  const src = fs.readFileSync(DATES_PATH, 'utf8');
  assert.doesNotMatch(src, /\bIntl\b/);
  assert.doesNotMatch(src, /toLocale/);
});

// -- Untouched cases ------------------------------------------------------------------------------

test('a weekday that does not match the parsed date is left untouched', () => {
  // 17 September 2026 is actually a Thursday; claim Sunday instead.
  const html = '<span>Sun Sep 17 2026 10:00:00 GMT+1000 (Australian Eastern Standard Time)</span>';
  assert.equal(transformDates(html), null);
});

test('a bare date with no time/offset is left untouched', () => {
  const html = '<span>Thu Sep 17 2026</span>';
  assert.equal(transformDates(html), null);
});

test('ordinary prose is left untouched', () => {
  const html = '<p>The party regrouped at the Splinter Hollow on a quiet afternoon.</p>';
  assert.equal(transformDates(html), null);
});

test('idempotent: a second pass over the transformed output returns null', () => {
  const raw = String(new Date(Date.UTC(2026, 8, 17)));
  const html = `<span class="metadata-badge">${raw}</span>`;
  const once = transformDates(html);
  assert.notEqual(once, null);
  assert.equal(transformDates(once), null);
});

// -- applyDateFormat / walk ------------------------------------------------------------------------

test('applyDateFormat patches every .html under siteRoot and reports counts', () => {
  withTmpDir((dir) => {
    const raw = String(new Date(Date.UTC(2026, 8, 17)));
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'campaign'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'campaign', 'index.html'), `<p>Last Played: ${raw}</p>`);
    fs.writeFileSync(path.join(dir, 'sessions', 'recap-03.html'), `<span class="metadata-badge">${raw}</span>`);
    fs.writeFileSync(path.join(dir, 'sessions', 'plain.html'), '<p>no date here</p>');
    fs.writeFileSync(path.join(dir, 'search-index.json'), JSON.stringify({ raw }));

    const result = applyDateFormat(dir);
    assert.equal(result.pagesPatched, 2);
    assert.equal(result.replacements, 2);

    assert.match(
      fs.readFileSync(path.join(dir, 'campaign', 'index.html'), 'utf8'),
      /Last Played: 17 September 2026/,
    );
    assert.match(
      fs.readFileSync(path.join(dir, 'sessions', 'recap-03.html'), 'utf8'),
      /17 September 2026/,
    );
    // search-index.json is deliberately untouched.
    assert.match(fs.readFileSync(path.join(dir, 'search-index.json'), 'utf8'), /GMT/);
  });
});

test('DATE_TOSTRING_RE matches with and without the trailing parenthetical', () => {
  DATE_TOSTRING_RE.lastIndex = 0;
  assert.ok(DATE_TOSTRING_RE.test('Thu Sep 17 2026 10:00:00 GMT+1000 (Australian Eastern Standard Time)'));
  DATE_TOSTRING_RE.lastIndex = 0;
  assert.ok(DATE_TOSTRING_RE.test('Thu Sep 17 2026 10:00:00 GMT+1000'));
});

// -- Mutation proofs (recorded manually in the Engineer report; this suite is the gate) -----------
// getDate instead of getUTCDate: makes the America/Los_Angeles case red (local getDate() differs
// from the UTC calendar date once the offset is applied).
// dropping the offset sign: makes any negative-offset case (St_Johns, Pago_Pago) red.
// dropping the offset minutes: makes the America/St_Johns (-0230) case red.
// removing the weekday guard: makes the "weekday mismatch" case red (it would silently patch).

// -- the pin's ISO dates (publish-v1.16.0 on): docs/decisions/0016-book-leaves-and-page-motion.md ------
//
// From publish-v1.16.0 the pin prints a YAML date as 2026-07-11 (lib/processor.js dateText), which the
// Date.toString() pattern above never matches. These tests pin the three places the pin prints one, and
// that only a real YAML date of the page the text belongs to is rewritten. Expected text is literal.

const { transformIsoDates } = require('../src/build/dates');

// outputPath -> frontmatter, as computePublishedSet's pages carry it (a YAML date parses as UTC midnight).
const ymd = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const isoPages = (entries) => entries.map(([outputPath, frontmatter]) => ({ outputPath, frontmatter }));

test('ISO dates: a session badge, an event header and a timeline entry print "D Month YYYY" for a real YAML date', () => {
  const pages = isoPages([
    ['sessions/session-01.html', { type: 'session', play_date: ymd(2026, 7, 11) }],
    ['events/the-signing.html', { type: 'event', in_game_date: ymd(2031, 2, 12) }],
    ['locations/the-keep.html', { type: 'location' }],
  ]);
  const badge = '<div class="metadata-badges"><span class="metadata-badge" data-field="play_date">2026-07-11</span></div>';
  assert.equal(transformIsoDates(badge, 'sessions/session-01.html', pages), '<div class="metadata-badges"><span class="metadata-badge" data-field="play_date">11 July 2026</span></div>');

  const header = '<div class="meta"><span><span class="label">Date</span> 2031-02-12</span></div>';
  assert.equal(transformIsoDates(header, 'events/the-signing.html', pages), '<div class="meta"><span><span class="label">Date</span> 12 February 2031</span></div>');

  // A location's timeline shows the linked event's date, so the event's frontmatter decides.
  const node = '<div class="timeline-node">\n  <span class="timeline-date">2031-02-12</span>\n  <a href="../events/the-signing.html">The Signing</a>';
  assert.equal(transformIsoDates(node, 'locations/the-keep.html', pages), '<div class="timeline-node">\n  <span class="timeline-date">12 February 2031</span>\n  <a href="../events/the-signing.html">The Signing</a>');
});

test('ISO dates: text that only looks like a date is left alone', () => {
  const pages = isoPages([
    ['sessions/session-01.html', { type: 'session', play_date: '2026-07-11' }], // quoted in YAML: a string
    ['events/the-signing.html', { type: 'event', in_game_date: ymd(2031, 2, 12) }],
    ['locations/the-keep.html', { type: 'location' }],
  ]);
  const typed = '<span class="metadata-badge" data-field="play_date">2026-07-11</span>';
  assert.equal(transformIsoDates(typed, 'sessions/session-01.html', pages), null, 'a date typed as text prints as typed, as it did before');
  // The event's date, but on a page whose own frontmatter has no such date, in a badge.
  assert.equal(transformIsoDates('<span class="metadata-badge">2031-02-12</span>', 'locations/the-keep.html', pages), null);
  // A timeline entry whose link goes somewhere without that date.
  assert.equal(transformIsoDates('<span class="timeline-date">2031-02-12</span>\n  <a href="../sessions/session-01.html">S1</a>', 'locations/the-keep.html', pages), null);
  // The same date in prose, or in Scriptorium's own timeline text, is not one of the pin's three places.
  assert.equal(transformIsoDates('<p>Signed 2031-02-12.</p><li>S1, 2031-02-12</li>', 'events/the-signing.html', pages), null);
});

test('ISO dates: idempotent, and a date with no page is never looked up', () => {
  const pages = isoPages([['events/the-signing.html', { type: 'event', in_game_date: ymd(2031, 2, 12) }]]);
  const once = transformIsoDates('<span><span class="label">Date</span> 2031-02-12</span>', 'events/the-signing.html', pages);
  assert.equal(transformIsoDates(once, 'events/the-signing.html', pages), null);
  assert.equal(transformIsoDates('<span class="metadata-badge">2031-02-12</span>', 'index.html', pages), null);
});

// Real builds. examples/the-long-lease writes play_date as YAML dates; on main (publish-v1.14.0) its
// session badges read "11 July 2026", "25 July 2026" and "8 August 2026", and they must still.
const { runAtomicBuild } = require('../src/build/run');

function buildVault(vaultPath, cfgPath, dir) {
  const siteDir = path.join(dir, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const finalOut = path.join(dir, 'out');
  const userJsonConfig = { ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), vaultPath };
  const result = runAtomicBuild({ vaultPath, userJsonConfig, finalOut, siteDir, campaign: 'dates', force: true });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error && result.error.message));
  return finalOut;
}

const LONG_LEASE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const LONG_LEASE_CFG = path.join(LONG_LEASE, '_meta', 'scriptorium', 'vault.config.json');

test('real build of the-long-lease: the session badges read as they did at publish-v1.14.0', () => {
  withTmpDir((dir) => {
    const out = buildVault(LONG_LEASE, LONG_LEASE_CFG, dir);
    const badges = [];
    for (const f of fs.readdirSync(path.join(out, 'sessions')).filter((n) => n.endsWith('.html')).sort()) {
      const m = /<span class="metadata-badge" data-field="play_date">([^<]*)<\/span>/.exec(fs.readFileSync(path.join(out, 'sessions', f), 'utf8'));
      if (m) badges.push(m[1]);
    }
    assert.deepEqual(badges, ['11 July 2026', '25 July 2026', '8 August 2026']);
  });
});

// Change detector: a copy of the-long-lease with a YAML date in every date field of every typed note.
// After the build, no page may print any of those dates as YYYY-MM-DD in its readable text. If a later
// pin prints a YAML date somewhere new, this fails at the pin bump, naming the page and the text.
test('real build with YAML dates everywhere: no page prints one of them as YYYY-MM-DD', () => {
  withTmpDir((dir) => {
    const vault = path.join(dir, 'vault');
    fs.cpSync(LONG_LEASE, vault, { recursive: true });
    const DATED = { date: '2031-01-11', in_game_date: '2031-02-12', updated: '2031-03-13', last_seen: '2031-04-14', play_date: '2031-05-15' };
    let dated = 0;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.md')) continue;
        const s = fs.readFileSync(p, 'utf8');
        const m = /^---\n([\s\S]*?)\n---/.exec(s);
        if (!m || !/^type:/m.test(m[1])) continue;
        const head = m[1].split('\n').filter((l) => !Object.prototype.hasOwnProperty.call(DATED, l.split(':')[0]));
        fs.writeFileSync(p, `---\n${head.concat(Object.entries(DATED).map(([k, v]) => `${k}: ${v}`)).join('\n')}\n---${s.slice(m[0].length)}`);
        dated++;
      }
    })(vault);
    assert.ok(dated > 20, `positive control: only ${dated} notes dated`);
    const out = buildVault(vault, path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), dir);
    const leftovers = [];
    let longForms = 0;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.html')) continue;
        const text = fs.readFileSync(p, 'utf8').replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ');
        for (const iso of Object.values(DATED)) if (text.includes(iso)) leftovers.push(`${path.relative(out, p)}: ${iso}`);
        longForms += (text.match(/\b(11 January|12 February|13 March|14 April|15 May) 2031\b/g) || []).length;
      }
    })(out);
    assert.deepEqual(leftovers, []);
    assert.ok(longForms > 0, 'positive control: no date printed at all');
  });
});
