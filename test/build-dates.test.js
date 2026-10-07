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
