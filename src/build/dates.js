'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Engineering Brief: "Book leaves + motion" (docs/agent-runs/bookleaves-engineering-brief-2026-09-24.md),
 * Structural decision 7 / FR-08 (#40 date transform).
 *
 * Rewrites every Date.prototype.toString()-shaped substring in built HTML ("Thu Sep 17 2026
 * 10:00:00 GMT+1000 (Australian Eastern Standard Time)") to "D Month YYYY" ("17 September 2026").
 * Pure string arithmetic, deliberately avoiding the ICU-backed date formatting APIs, because the
 * packaged exe's small-icu build does not fully support them (CLAUDE.md).
 *
 * A date-only frontmatter YAML value parses (via gray-matter, on both the vault and pin sides) as
 * UTC midnight, so recovering the UTC instant from the printed local wall-clock time plus its
 * printed offset always recovers the authored calendar date, in any build-machine time zone,
 * whether the offset is positive, negative, zero, or has non-zero minutes (e.g. -0230).
 */

const DATE_TOSTRING_RE =
  /\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT([+-])(\d{2})(\d{2})(?: \([^()<>\n]*\))?/g;

const PRINTED_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PRINTED_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Full English month names for the output, a literal array independent of any locale data.
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Computes the patched HTML for one page, or null if no Date.toString()-shaped text was found (or
 * none of it was actually rewritten). Idempotent by construction: the output never re-matches
 * DATE_TOSTRING_RE (it has no "GMT" in it), so a second pass always returns null.
 *
 * @param {string} html
 * @returns {string | null}
 */
function transformDates(html) {
  let changed = false;
  const out = html.replace(
    DATE_TOSTRING_RE,
    (match, weekday, mon, day, year, hh, mm, ss, sign, offHours, offMinutes) => {
      const monthIndex = PRINTED_MONTHS.indexOf(mon);
      const localMs = Date.UTC(Number(year), monthIndex, Number(day), Number(hh), Number(mm), Number(ss));

      // Guard: the printed weekday must agree with the parsed date, or the text is left alone
      // rather than guessing (build-dates.test.js's "weekday mismatch" case).
      if (PRINTED_WEEKDAYS[new Date(localMs).getUTCDay()] !== weekday) return match;

      const offsetMs = (Number(offHours) * 60 + Number(offMinutes)) * 60000 * (sign === '-' ? -1 : 1);
      const utcMs = localMs - offsetMs;
      const d = new Date(utcMs);
      changed = true;
      return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    },
  );
  return changed ? out : null;
}

/**
 * Walks every `.html` file under `siteRoot` (search-index.json is deliberately untouched, a
 * residual — see the ADR) and applies transformDates to each, writing back only the pages that
 * actually changed.
 *
 * @param {string} siteRoot
 * @returns {{ pagesPatched: number, replacements: number }}
 */
function applyDateFormat(siteRoot) {
  let pagesPatched = 0;
  let replacements = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(full, 'utf8');
      const matches = html.match(DATE_TOSTRING_RE);
      const patched = transformDates(html);
      if (patched === null) continue;
      fs.writeFileSync(full, patched);
      pagesPatched++;
      replacements += matches ? matches.length : 0;
    }
  })(siteRoot);
  return { pagesPatched, replacements };
}

module.exports = { DATE_TOSTRING_RE, transformDates, applyDateFormat };
