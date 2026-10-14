'use strict';

/*
 * The leak demo generator. It reads the sample vault and the site that was built from it, and
 * returns one self-contained HTML page: the GM's private note, the player page built from the
 * same file, and the statement that the withheld name is on neither. It only reads. Writing the
 * page into the staged site is done by scripts/sample-site.js.
 *
 * Nothing here knows the withheld name. It comes from the vault's publish manifest, from the one
 * entry under "Excluded", and is confirmed by that page's own `withheld: true` flag. If any
 * premise of the demo stops being true, buildLeakDemo returns a reason and no page.
 *
 * Limits, written down rather than rediscovered: this proves the name and the GM Notes text are
 * absent from one player page at the time the demo is built. It does not follow aliases, and the
 * GM-text rule looks for whole plain runs (what is left of the note after the [[links]] are cut
 * out), so a leak that rewords or splits a run is not caught by this rule. The output-leak check
 * in the build is the broad net; this is the demonstration.
 */

const fs = require('fs');
const path = require('path');

const DEMO_FILE = 'leak-demo.html';
const DEMO_SOURCE = Object.freeze({
  note: 'Locations/Summerhythe.md',
  section: 'GM Notes',
  playerPage: 'locations/summerhythe.html',
  playerProbe: 'Trade is brisk and sleep is poor.',
});
const REPO_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium';
const MIN_RUN = 20;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The entries under "## Excluded" in the publish manifest, as vault-relative paths. */
function excludedEntries(manifestText) {
  const lines = manifestText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Excluded\s*$/.test(l));
  if (start < 0) return [];
  const entries = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const m = /^- \[[ xX]\]\s+(.+?)\s*$/.exec(lines[i]);
    if (m) entries.push(m[1]);
  }
  return entries;
}

/** True when the frontmatter (between the first two --- lines) has a withheld: true line. */
function hasWithheldFlag(pageText) {
  const lines = pageText.split(/\r?\n/);
  if (lines[0] !== '---') return false;
  const end = lines.indexOf('---', 1);
  if (end < 0) return false;
  return lines.slice(1, end).some((l) => /^withheld:\s*true\s*$/.test(l));
}

function withheldName(vaultDir) {
  const manifest = readText(path.join(vaultDir, '_meta', 'publish-manifest.md'));
  const entries = manifest === null ? [] : excludedEntries(manifest);
  if (entries.length === 0) return { ok: false, reason: 'no-withheld-entry' };
  if (entries.length > 1) return { ok: false, reason: 'several-withheld-entries' };
  const page = readText(path.join(vaultDir, ...entries[0].split('/')));
  if (page === null || !hasWithheldFlag(page)) return { ok: false, reason: 'withheld-flag-missing' };
  return { ok: true, name: path.posix.basename(entries[0]).replace(/\.md$/i, '') };
}

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Applies a replacement until the string stops changing, so overlapping fragments cannot survive. */
function replaceUntilStable(text, re, sub) {
  let prev;
  let cur = text;
  do {
    prev = cur;
    cur = cur.replace(re, sub);
  } while (cur !== prev);
  return cur;
}

/** Cuts out script and style blocks and every tag, then any stray angle bracket. Never leaves a "<". */
function stripTags(html, sub) {
  const noBlocks = replaceUntilStable(html, /<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const noTags = replaceUntilStable(noBlocks, /<[^>]*>/g, sub);
  return noTags.replace(/[<>]/g, sub);
}

/** Page text, two ways (tags cut out with and without a space), decoded and whitespace-collapsed. */
function pageTexts(html) {
  return [collapse(decodeEntities(stripTags(html, ' '))), collapse(decodeEntities(stripTags(html, '')))];
}

/** The plain runs of a note excerpt: what is left after cutting out [[...]] links. */
function excerptRuns(excerpt) {
  return excerpt
    .split(/\[\[[^\]]*\]\]/)
    .map(collapse)
    .filter((r) => r.length >= MIN_RUN);
}

/** True when the page shows any run of the GM note, or the words "GM Notes". */
function findGmText(html, runs) {
  const texts = pageTexts(html);
  if (texts.some((t) => /gm notes/i.test(t))) return true;
  return runs.some((r) => texts.some((t) => t.includes(r)));
}

function nameTokens(name) {
  return name.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
}

function hasNameToken(text, name) {
  const lower = text.toLowerCase();
  return nameTokens(name).some((t) => lower.includes(t));
}

/** The text of the section: from its heading to the next heading of level 1 or 2, trimmed. */
function sectionExcerpt(noteText, section) {
  const lines = noteText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${section}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const text = lines.slice(start + 1, end).join('\n').trim();
  return text.length > 0 ? { text, headingIndex: start, lines } : null;
}

const STYLE = [
  'body { margin: 0; padding: 1rem; font-family: Georgia, serif; line-height: 1.5; color: #231f1a; background: #faf6ec; }',
  'main { max-width: 44rem; margin: 0 auto; }',
  'h1 { font-size: 1.6rem; line-height: 1.2; }',
  'h2 { font-size: 1.2rem; margin-top: 2rem; }',
  'pre { white-space: pre-wrap; overflow-wrap: anywhere; }',
  'pre { background: #efe7d2; padding: 1rem; margin: 1rem 0; }',
  'blockquote { margin: 1rem 0; padding: 0 1rem; border-left: 0.25rem solid #8a6d2f; }',
  'code { overflow-wrap: anywhere; }',
  'a { color: #1d4f7a; overflow-wrap: anywhere; }',
  '.small { font-size: 0.9rem; }',
].join('\n');

function renderDemo({ name, excerpt }) {
  const e = escapeHtml;
  const note = DEMO_SOURCE.note;
  const page = DEMO_SOURCE.playerPage;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>What stays private: a leak demo</title>',
    '<style>',
    STYLE,
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<h1>What stays private</h1>',
    '<p>A GM writes private notes beside what the players may read. GM-Scriptorium keeps the notes off the site. This page shows one real case from the sample campaign.</p>',
    '<p class="small"><a href="index.html">Back to the sample site</a></p>',
    "<h2>1. The GM's private note</h2>",
    `<p>From <code>${e(note)}</code>, under <code>## ${e(DEMO_SOURCE.section)}</code>. It names a character the players have not met:</p>`,
    `<pre>${e(excerpt)}</pre>`,
    '<h2>2. The player page built from the same file</h2>',
    `<p>This is <a href="${e(page)}">the Summerhythe page</a> on this site. The section just before the private one reads:</p>`,
    `<blockquote>${e(DEMO_SOURCE.playerProbe)}</blockquote>`,
    '<p>The private section is not there.</p>',
    '<h2>3. What was checked</h2>',
    `<p>When this page was built, the name <strong>${e(name)}</strong> and the ${e(DEMO_SOURCE.section)} section were on neither the player page above nor any other player page on this site.</p>`,
    '<h2>What this does not show</h2>',
    '<p>It shows one page at the moment of the build. It does not follow nicknames. The checks that guard every page of your own campaign are described in the guide.</p>',
    '<h2>Learn more</h2>',
    '<ul>',
    `<li><a href="${e(REPO_URL)}/blob/main/examples/README.md">About this sample campaign</a></li>`,
    `<li><a href="${e(REPO_URL)}/blob/main/docs/using.md#leak-checks">How the leak checks work</a></li>`,
    `<li><a href="${e(REPO_URL)}">GM-Scriptorium on GitHub</a></li>`,
    '</ul>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function buildLeakDemo({ vaultDir, siteDir }) {
  const fail = (reason) => ({ ok: false, reason });

  const who = withheldName(vaultDir);
  if (!who.ok) return fail(who.reason);
  const name = who.name;

  let excluded = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(vaultDir, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));
    excluded = Array.isArray(cfg.excludeSections) ? cfg.excludeSections : [];
  } catch {
    excluded = [];
  }
  if (!excluded.includes(DEMO_SOURCE.section)) return fail('section-not-excluded');

  const noteText = readText(path.join(vaultDir, ...DEMO_SOURCE.note.split('/')));
  const sec = noteText === null ? null : sectionExcerpt(noteText, DEMO_SOURCE.section);
  if (!sec) return fail('excerpt-not-found');
  if (!nameTokens(name).every((t) => sec.text.toLowerCase().includes(t))) return fail('excerpt-missing-name');

  const before = sec.lines.slice(0, sec.headingIndex).join('\n');
  if (!before.includes(DEMO_SOURCE.playerProbe)) return fail('probe-not-in-source');

  const html = readText(path.join(siteDir, ...DEMO_SOURCE.playerPage.split('/')));
  if (html === null) return fail('player-page-missing');
  if (!pageTexts(html).some((t) => t.includes(DEMO_SOURCE.playerProbe))) return fail('player-page-mismatch');
  if (hasNameToken(html, name) || pageTexts(html).some((t) => hasNameToken(t, name))) return fail('player-page-has-name');
  const runs = excerptRuns(sec.text);
  if (findGmText(html, runs)) return fail('player-page-has-gm-text');

  return { ok: true, html: renderDemo({ name, excerpt: sec.text }), name, runs };
}

module.exports = {
  DEMO_FILE,
  DEMO_SOURCE,
  withheldName,
  buildLeakDemo,
  excerptRuns,
  stripTags,
  findGmText,
  hasNameToken,
};
