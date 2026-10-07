'use strict';

const fs = require('fs');
const path = require('path');
const { ScriptoriumError } = require('../util/errors');

/*
 * UI-01 / issue 214 (https://github.com/AntTheLimey/gm-apprentice/issues/214) FIXED upstream as of
 * publish-v1.11.40 (R1 repin, 2026-09-30): `sessions` is now present in DIR_LABELS
 * (lib/templates/base.js:3-25, 'sessions': 'Sessions' at :21), so `lib/build.js:1180-1218`'s
 * unconditional per-DIR_LABELS-entry index write (Object.entries(DIR_LABELS) loop) now writes
 * sessions/index.html itself, the same way it always wrote every other section's index. Every
 * page's nav has always linked "Sessions" at that path regardless (lib/templates/nav.js:9,54).
 * Site UI Engineering Brief 2026-09-17, SD-3/SD-4; docs/decisions/0006-post-build-page-writer.md
 * carries the full reasoning, plus its own addendum confirming this fix (Δ, #214 follow-up).
 *
 * SD-3: this writer skips (reason 'already-generated') the moment sessions/index.html already
 * exists. That is no longer a hypothetical: at this pin it is the ordinary path every real build
 * with session content takes, proven by a real build in test/build-sessions-index.test.js's FR-07
 * test. Do not remove that check to "simplify" this module -- it is what makes the self-retirement
 * automatic, and it costs nothing if a future pin ever regresses issue 214.
 *
 * SD-4: rather than reimplementing baseShell (lib/templates/base.js:52-118), this transforms a
 * donor page: read the first sessions/*.html, splice new content between the first
 * `<main class="content">` (lib/templates/base.js:84) and the first `</main>` (:87), rewrite
 * `<title>`. Nav, CSS links, relative depth and the notice footer link all come from the donor's
 * own shell and cannot drift from it. (This module is now a no-op at every real build -- see
 * SD-3 above -- but the donor-transform logic stays, both as the escape hatch's own fallback path
 * and as the regression guard if issue 214 is ever reverted upstream.)
 */

const MAIN_OPEN = '<main class="content">';
const MAIN_CLOSE = '</main>';
const TITLE_TAG_RE = /<title>[\s\S]*?<\/title>/;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `<title>` is rendered by baseShell as `${title} — ${siteTitle}` (lib/templates/base.js:76,
 * literal " — " separator). Strip that suffix to recover the page's own title for the listing.
 */
function extractEntryTitle(html, siteTitle) {
  const match = html.match(TITLE_TAG_RE);
  if (!match) return null;
  let title = match[0].slice('<title>'.length, -'</title>'.length);
  const suffix = ` — ${siteTitle}`;
  if (siteTitle && title.endsWith(suffix)) {
    title = title.slice(0, -suffix.length);
  }
  return title;
}

function buildIndexContent(entries) {
  const cards = entries
    .map((entry) => `<a class="entity-card" href="${escapeHtml(entry.href)}"><h4>${escapeHtml(entry.title)}</h4></a>`)
    .join('\n');
  return `
<div class="index-header">
  <h1 class="page-title">Sessions</h1>
  <span class="index-count">${entries.length} session${entries.length === 1 ? '' : 's'}</span>
</div>
<div class="card-grid">${cards}</div>
`;
}

/**
 * writeSessionsIndex(siteRoot, { siteTitle }) -> { written, reason, entries }
 *
 * @param {string} siteRoot the staging output directory (stagingOut in src/build/run.js)
 * @param {{ siteTitle: string }} opts
 * @returns {{ written: boolean, reason: string|null, entries: number }}
 * @throws {ScriptoriumError} if the donor page has no `<main class="content">` or no `</main>`
 */
function writeSessionsIndex(siteRoot, { siteTitle }) {
  const sessionsDir = path.join(siteRoot, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    return { written: false, reason: 'no-sessions-dir', entries: 0 };
  }

  const indexPath = path.join(sessionsDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    // SD-3's escape hatch: an existing sessions/index.html is either a prior run of this same
    // writer (re-run safety) or, post-issue-214, the generator's own DIR_LABELS output. Either
    // way, leave it byte-identical rather than overwrite it.
    return { written: false, reason: 'already-generated', entries: 0 };
  }

  const donorNames = fs
    .readdirSync(sessionsDir)
    .filter((name) => name.endsWith('.html') && name !== 'index.html')
    .sort();

  if (donorNames.length === 0) {
    return { written: false, reason: 'no-sessions-dir', entries: 0 };
  }

  const donorName = donorNames[0];
  const donorPath = path.join(sessionsDir, donorName);
  const donorHtml = fs.readFileSync(donorPath, 'utf8');

  const mainOpenAt = donorHtml.indexOf(MAIN_OPEN);
  if (mainOpenAt === -1) {
    throw new ScriptoriumError(
      `sessions donor page has no <main class="content">, cannot build sessions/index.html (SD-4, docs/decisions/0006-post-build-page-writer.md)`,
      { path: donorPath },
    );
  }
  const spanStart = mainOpenAt + MAIN_OPEN.length;
  const mainCloseAt = donorHtml.indexOf(MAIN_CLOSE, spanStart);
  if (mainCloseAt === -1) {
    throw new ScriptoriumError(
      `sessions donor page has no </main> after its <main class="content">, cannot build sessions/index.html (SD-4, docs/decisions/0006-post-build-page-writer.md)`,
      { path: donorPath },
    );
  }

  const entries = donorNames.map((name) => {
    const html = name === donorName ? donorHtml : fs.readFileSync(path.join(sessionsDir, name), 'utf8');
    const title = extractEntryTitle(html, siteTitle) || name.replace(/\.html$/, '');
    return { href: name, title };
  });

  const spliced = donorHtml.slice(0, spanStart) + buildIndexContent(entries) + donorHtml.slice(mainCloseAt);
  const withTitle = spliced.replace(TITLE_TAG_RE, `<title>Sessions — ${escapeHtml(siteTitle)}</title>`);

  fs.writeFileSync(indexPath, withTitle);

  return { written: true, reason: null, entries: entries.length };
}

module.exports = { writeSessionsIndex };
