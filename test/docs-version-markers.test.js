'use strict';

/*
 * Words that exist only from 0.5.0, checked against the pages written for GMs.
 *
 * The published release is v0.4.0-rc.1, and these pages describe the code on main. Anything that
 * release does not have must carry a version marker on the smallest thing it belongs to (a table
 * row, a list item, a paragraph, a fenced command, or a whole section whose first line is the
 * marker). This test holds a fixed list of terms that rc.1 lacks and fails when one of them sits
 * outside a marker. It reads no git history and no tags, only the pages in this checkout.
 *
 * Markers stay in place after a release ships (docs/WRITING-DOCS.md), so the list does not go
 * stale and the test never needs updating for a release.
 *
 * Residual: a new feature that is not on the list is not caught. Add its words here when it lands.
 *
 * Tests R2 and R3 pass today and prove nothing alone. R1 fails on main before the pages are
 * marked, and the planted-defect controls (C1 to C10) show the scan can fail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { userDocFiles } = require('./helpers/doc-criteria');

const ROOT = path.join(__dirname, '..');

const TERMS = [
  'remote account', // not in v0.4.0-rc.1: src/cli/remote.js there has no account subcommand
  '--account', // likewise: signing out one account came with accounts
  'accounts.json', // not in v0.4.0-rc.1: src/remote/accounts.js does not exist there
  '--new-vault', // not in v0.4.0-rc.1: no new-vault in src or bin, and no src/vault/vaultcreate.js
  '--force-check', // not in v0.4.0-rc.1: no force-check or force-out in src or bin
  '--force-out', // likewise
  'gm-scriptorium-setup-win-x64.exe', // not among the v0.4.0-rc.1 release assets
  'Installed apps', // the installer's entry; the installer is not on the v0.4.0-rc.1 release
  'Start menu', // the installer's shortcut; likewise
  'desktop set', // not in v0.4.0-rc.1: src/cli/desktop.js does not exist there
  'desktop run', // likewise
  'tray helper', // the tray helper: src/desktop/host.js does not exist in v0.4.0-rc.1
  'tray app', // the tray helper: src/desktop/host.js does not exist in v0.4.0-rc.1
  'system tray', // the tray helper: src/desktop/host.js does not exist in v0.4.0-rc.1
  'gm-scriptorium-tray', // the tray helper: src/desktop/host.js does not exist in v0.4.0-rc.1
  'Add a campaign', // not in v0.4.0-rc.1: no match in src or assets, and no assets/admin/campaigns.js
  'Updates card', // not in v0.4.0-rc.1: src/admin/updatenotice.js does not exist there
  'SYSTEM and Administrators', // not in v0.4.0-rc.1: no icacls in src
  'press O', // not in v0.4.0-rc.1: src/cli/launch.js does not exist there
  'username', // not in v0.4.0-rc.1: no username in src/remote, src/admin or assets/admin
];

// "Since 0.5.0", "Coming in 0.5.0" and the README's plain "coming in 0.5.0". Case-sensitive on S.
const MARKER = /\b(?:Since|[Cc]oming in) 0\.5\.0\b/;
const SECTION_MARKERS = ['*Since 0.5.0.*', '*Coming in 0.5.0.*'];

const countOf = (text, term) => text.split(term).length - 1;

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s/;
const TABLE_ROW = /^\s*\|/;
const ITEM_START = /^\s*(?:[-*]|\d+\.)\s/;

/** Which lines sit inside a section whose first non-blank line is exactly a marker. */
function markedLines(lines, fenceLine) {
  const covered = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (fenceLine[i]) continue;
    const h = lines[i].match(HEADING);
    if (!h) continue;
    const level = h[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const hj = fenceLine[j] ? null : lines[j].match(HEADING);
      if (hj && hj[1].length <= level) { end = j; break; }
    }
    let k = i + 1;
    while (k < end && lines[k].trim() === '') k += 1;
    if (k < end && SECTION_MARKERS.some((m) => lines[k].trim() === m)) {
      for (let j = i; j < end; j += 1) covered[j] = true;
    }
  }
  return covered;
}

/** Split a page into units: fences, headings, table rows, list items and paragraphs. */
function toUnits(text) {
  const lines = text.split('\n');
  const fenceLine = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) { fenceLine[i] = true; open = !open; } else if (open) fenceLine[i] = true;
  }
  const inMarkedSection = markedLines(lines, fenceLine);
  const units = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fenceLine[i]) {
      let j = i;
      if (FENCE.test(line)) {
        j = i + 1;
        while (j < lines.length && !(fenceLine[j] && FENCE.test(lines[j]))) j += 1;
      }
      units.push({ kind: 'fence', start: i + 1, lines: lines.slice(i, j + 1), section: inMarkedSection[i] });
      i = j + 1;
    } else if (line.trim() === '') {
      i += 1;
    } else if (HEADING.test(line)) {
      units.push({ kind: 'heading', start: i + 1, lines: [line], section: inMarkedSection[i] });
      i += 1;
    } else if (TABLE_ROW.test(line)) {
      units.push({ kind: 'row', start: i + 1, lines: [line], section: inMarkedSection[i] });
      i += 1;
    } else {
      const isItem = ITEM_START.test(line);
      let j = i + 1;
      while (
        j < lines.length && lines[j].trim() !== '' && !fenceLine[j] && !HEADING.test(lines[j])
        && !TABLE_ROW.test(lines[j]) && !ITEM_START.test(lines[j])
      ) j += 1;
      units.push({ kind: isItem ? 'item' : 'paragraph', start: i + 1, lines: lines.slice(i, j), section: inMarkedSection[i] });
      i = j;
    }
  }
  return units;
}

const joined = (unit) => unit.lines.map((l) => l.trim()).join(' ');
const ownCover = (unit) => unit.section || MARKER.test(joined(unit));

/** Is the unit at index n covered? A fence also takes cover from its nearest neighbour text. */
function isCovered(units, n) {
  const unit = units[n];
  if (unit.kind !== 'fence') return ownCover(unit);
  if (unit.section) return true;
  for (const step of [-1, 1]) {
    for (let k = n + step; k >= 0 && k < units.length; k += step) {
      if (units[k].kind === 'fence') continue;
      if (units[k].kind === 'heading') break;
      if (ownCover(units[k])) return true;
      break;
    }
  }
  return false;
}

/** Every term found, in page order: `{ line, term, covered }`. */
function scan(text, terms) {
  const units = toUnits(text);
  const out = [];
  units.forEach((unit, n) => {
    const body = joined(unit);
    const covered = isCovered(units, n);
    for (const term of terms) {
      if (countOf(body, term) > 0) out.push({ line: unit.start, term, covered });
    }
  });
  return out;
}

function uncoveredHits(rel, text, terms) {
  return scan(text, terms).filter((h) => !h.covered).map((h) => `${rel}:${h.line}: ${h.term}`);
}

const PAGES = () => [...userDocFiles(ROOT), 'README.md'];
const readPage = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---- the real pages ----

test('R1: every 0.5.0-only term on a GM page sits under a version marker', () => {
  const hits = [];
  for (const rel of PAGES()) hits.push(...uncoveredHits(rel, readPage(rel), TERMS));
  assert.deepEqual(hits, []);
});

test('R2: the scan covers every criteria page and the README (passes today, proves nothing alone)', () => {
  const pages = PAGES();
  assert.ok(pages.length >= 28, `only ${pages.length} pages`);
  for (const rel of pages) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is missing`);
});

test('R3: the scan finds many terms, covered or not (passes today, proves nothing alone)', () => {
  let total = 0;
  for (const rel of PAGES()) total += scan(readPage(rel), TERMS).length;
  assert.ok(total >= 40, `only ${total} hits`);
});

// ---- planted-defect controls, on scratch strings, with literal expectations ----

const doc = (lines) => lines.join('\n');

test('C1: a planted unmarked paragraph is reported', () => {
  const text = doc(['# T', '', 'This page is for a GM.', '', 'Run `gm-scriptorium remote account add rook` first.', '']);
  assert.deepEqual(uncoveredHits('x.md', text, TERMS), ['x.md:5: remote account']);
});

test('C2: the same paragraph with a marker is not reported', () => {
  const text = doc(['# T', '', 'This page is for a GM.', '', '*Since 0.5.0.* Run `gm-scriptorium remote account add rook` first.', '']);
  assert.deepEqual(uncoveredHits('x.md', text, TERMS), []);
});

test('C3: a marker covers only its own paragraph', () => {
  const text = doc(['# T', '', '*Since 0.5.0.* Uses `desktop set`.', '', 'Also `desktop set`.', '']);
  assert.deepEqual(uncoveredHits('x.md', text, TERMS), ['x.md:5: desktop set']);
});

test('C4: a marked section covers nested sections and fences, and stops at the next section', () => {
  const text = doc([
    '# T', '', '## New', '', '*Since 0.5.0.*', '', '### Sub', '', '```', 'gm-scriptorium desktop set --port 7500', '```', '',
    '## Old', '', 'Use `desktop set`.', '',
  ]);
  assert.deepEqual(uncoveredHits('x.md', text, TERMS), ['x.md:15: desktop set']);
});

test('C5: a section marker must be the whole line', () => {
  const text = doc(['# T', '', '## S', '', '*Since 0.5.0.* Uses `desktop set`.', '', 'Also `desktop set`.', '']);
  assert.deepEqual(uncoveredHits('x.md', text, TERMS), ['x.md:7: desktop set']);
});

test('C6: a fence takes cover from the text beside it, and from nowhere else', () => {
  const marked = doc(['# T', '', '*Since 0.5.0.* To sign out one account:', '', '```', 'gm-scriptorium remote signout-all --account rook', '```', '']);
  assert.deepEqual(uncoveredHits('x.md', marked, TERMS), []);
  const unmarked = doc(['# T', '', 'To sign out one account:', '', '```', 'gm-scriptorium remote signout-all --account rook', '```', '']);
  assert.deepEqual(uncoveredHits('x.md', unmarked, TERMS), ['x.md:5: --account']);
  const after = doc(['# T', '', '```', 'gm-scriptorium init --new-vault x', '```', '', '*Since 0.5.0.* Makes a vault.', '']);
  assert.deepEqual(uncoveredHits('x.md', after, TERMS), []);
  const heading = doc(['# T', '', '*Since 0.5.0.* Intro.', '', '## Next', '', '```', 'gm-scriptorium desktop run', '```', '']);
  assert.deepEqual(uncoveredHits('x.md', heading, TERMS), ['x.md:7: desktop run']);
});

test('C7: table rows are separate units', () => {
  const text = doc(['| a | *Since 0.5.0.* `desktop run` |', '| b | `desktop run` |']);
  assert.deepEqual(uncoveredHits('x.md', text, TERMS), ['x.md:2: desktop run']);
});

test('C8: the README forms of the marker', () => {
  const plain = doc(['A Windows installer, with a Start menu shortcut, is', 'coming in 0.5.0.', '']);
  assert.deepEqual(uncoveredHits('x.md', plain, TERMS), []);
  const lower = doc(['since 0.5.0 the Start menu.', '']);
  assert.deepEqual(uncoveredHits('x.md', lower, TERMS), ['x.md:1: Start menu']);
});

test('C9: list item continuation lines belong to the item', () => {
  const text = doc(['- *Since 0.5.0.* First line', '  and `desktop set` here.', '- Next `desktop set`.']);
  assert.deepEqual(uncoveredHits('x.md', text, TERMS), ['x.md:3: desktop set']);
});

test('C10: terms use the plain hyphen-minus, and the dash check can fail', () => {
  const DASHES = /[\u2010-\u2015\u2212]/;
  assert.ok(TERMS.every((t) => !DASHES.test(t)));
  assert.ok(DASHES.test('\u2013force-check'));
});

test('C11: a marked paragraph directly above a table does not cover the rows', () => {
  const text = doc(['# T', '', '*Since 0.5.0.* Intro.', '| a | `desktop run` |', '']);
  assert.deepEqual(uncoveredHits('x.md', text, TERMS), ['x.md:4: desktop run']);
});
