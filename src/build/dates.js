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
 *
 * From publish-v1.16.0 the pin prints a YAML date as "2026-07-11" (lib/processor.js dateText) in
 * most places, and Date.toString() text survives only where a template still prints String(date)
 * (the landing page's "Last Played"). transformIsoDates puts the "D Month YYYY" form back in the
 * three places the pin prints a YAML date as ISO: a metadata badge, a header line
 * (`<span class="label">Date</span> ...`) and a timeline entry. It rewrites the text only when the
 * page it belongs to (the page itself, or the event a timeline entry links to) has a YAML date that
 * the pin's own dateText prints as exactly that text, so a date the GM typed as text prints as
 * typed, as it always did. See docs/decisions/0016-book-leaves-and-page-motion.md's last addendum.
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

const ISO_RE = '(\\d{4})-(\\d{2})-(\\d{2})';
// The three places the pin prints a YAML date as ISO, each with the date's text as groups 2-4.
const ISO_BADGE_RE = new RegExp(`(<span class="metadata-badge"[^>]*>)${ISO_RE}(</span>)`, 'g');
const ISO_HEADER_RE = new RegExp(`(<span class="label">[^<]*</span> )${ISO_RE}(</span>)`, 'g');
const ISO_TIMELINE_RE = new RegExp(`(<span class="timeline-date">)${ISO_RE}(</span>\\s*<a href="([^"]*)")`, 'g');

/**
 * outputPath -> the text the pin prints for each YAML date in that page's frontmatter (top-level
 * values, and dates inside a top-level list).
 *
 * @param {{ outputPath: string, frontmatter: object }[]} pages
 * @returns {Map<string, Set<string>>}
 */
function isoDatesByPath(pages) {
  const out = new Map();
  if (!pages.length) return out;
  // Loaded here, not at the top: the Date.toString() path above must load and run with the ICU-backed
  // globals deleted (build-dates.test.js), and loading the pin needs them. A build has loaded it anyway.
  // eslint-disable-next-line global-require
  const pinned = require('../generator/pinned');
  for (const p of pages) {
    const set = new Set();
    for (const v of Object.values(p.frontmatter || {})) {
      for (const x of Array.isArray(v) ? v : [v]) {
        if (x instanceof Date && !isNaN(x)) set.add(pinned.dateText(x));
      }
    }
    if (set.size) out.set(p.outputPath, set);
  }
  return out;
}

const longForm = (y, m, d) => `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;

/**
 * The pin's ISO dates in one page, as "D Month YYYY", or null if nothing changed.
 *
 * @param {string} html
 * @param {string} pagePath the page's output path
 * @param {{ outputPath: string, frontmatter: object }[] | Map<string, Set<string>>} pages
 * @returns {string | null}
 */
function transformIsoDates(html, pagePath, pages) {
  const byPath = pages instanceof Map ? pages : isoDatesByPath(pages);
  if (byPath.size === 0) return null;
  // eslint-disable-next-line global-require
  const { resolveHref } = require('./htmltext'); // loaded late, as pinned is above
  const own = byPath.get(pagePath);
  let changed = false;
  const swap = (dates) => (match, open, y, m, d, close) => {
    if (!dates || !dates.has(`${y}-${m}-${d}`) || !MONTHS[Number(m) - 1]) return match;
    changed = true;
    return `${open}${longForm(y, m, d)}${close}`;
  };
  let out = html.replace(ISO_BADGE_RE, swap(own)).replace(ISO_HEADER_RE, swap(own));
  out = out.replace(ISO_TIMELINE_RE, (match, open, y, m, d, close, href) => swap(byPath.get(resolveHref(pagePath, href)))(match, open, y, m, d, close));
  return changed ? out : null;
}

/**
 * Walks every `.html` file under `siteRoot` (search-index.json is deliberately untouched, a
 * residual — see the ADR) and applies transformDates to each, writing back only the pages that
 * actually changed. With `pages` (the published pages, with their frontmatter), the pin's ISO dates
 * are rewritten too (transformIsoDates); `isoReplacements` counts those.
 *
 * @param {string} siteRoot
 * @param {{ pages?: { outputPath: string, frontmatter: object }[] }} [opts]
 * @returns {{ pagesPatched: number, replacements: number, isoReplacements: number }}
 */
function applyDateFormat(siteRoot, { pages = [] } = {}) {
  const byPath = isoDatesByPath(pages);
  let pagesPatched = 0;
  let replacements = 0;
  let isoReplacements = 0;
  (function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, entryRel);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(full, 'utf8');
      const matches = html.match(DATE_TOSTRING_RE);
      const once = transformDates(html);
      const before = once === null ? html : once;
      const iso = transformIsoDates(before, entryRel, byPath);
      if (once === null && iso === null) continue;
      fs.writeFileSync(full, iso === null ? before : iso);
      pagesPatched++;
      replacements += once === null ? 0 : (matches ? matches.length : 0);
      if (iso !== null) isoReplacements += countIso(before) - countIso(iso);
    }
  })(siteRoot, '');
  return { pagesPatched, replacements, isoReplacements };
}

// How many of the three ISO places a page still holds (any date), for the replacement count.
function countIso(html) {
  return (html.match(ISO_BADGE_RE) || []).length + (html.match(ISO_HEADER_RE) || []).length + (html.match(ISO_TIMELINE_RE) || []).length;
}

module.exports = { DATE_TOSTRING_RE, transformDates, transformIsoDates, applyDateFormat };
