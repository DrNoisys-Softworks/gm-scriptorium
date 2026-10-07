'use strict';

/*
 * The literal rules-content marker strings, and the packaged-artefact ship
 * gate built on top of them. Track DEP-c/R, docs/decisions/0007-rules-content-redaction.md.
 *
 * This file is build-time only: it is required from scripts/package.js and
 * from tests, never from src/ or bin/. That separation is deliberate
 * (Structural decision D4 in the brief): if a marker string below ever
 * landed in src/ or bin/, it would be embedded verbatim in every packaged
 * executable, and the AC-R8 ship gate in scripts/package.js would fail on
 * every build forever, because the strings would always be findable in the
 * exe it just produced. Keeping them here, and only here, is what lets the
 * gate ever pass.
 *
 * MARKERS holds the exact strings that identify the two redacted files'
 * content in a built artefact (source of truth for the ship gate and for
 * the redaction positive control). PIN_SCAN_PATTERN and PIN_SCAN_BASELINE
 * are a second, independent detector: a heuristic sweep of the whole
 * installed pin tree (not just the two known files), so a future upstream
 * bump that adds a THIRD rules-content file anywhere in the 142-file tree
 * fails a test instead of shipping silently (Structural decision D6b).
 */

const fs = require('fs');
const path = require('path');

/**
 * The literal strings that only exist because the two redacted upstream
 * files exist. Each must never appear in src/, bin/, a pkg.patches body,
 * or the notices text (see the "Marker strings must never enter src/ or
 * bin/" trap in the Engineering Brief).
 */
const MARKERS = [
  {
    id: 'gurps-reference',
    pinPath: 'lib/templates/gurps/blocks/reference.js',
    strings: [
      'Source: GURPS Basic Set 4e, p. B552',
      'Source: GURPS Basic Set 4e, p. B550',
      'Humanoid Hit Location',
    ],
  },
  {
    id: 'coc-skills-data',
    pinPath: 'lib/templates/coc/skills-data.js',
    strings: [
      'Cthulhu Mythos',
      'Spot Hidden',
    ],
  },
];

/**
 * A heuristic sweep for rules-content risk anywhere in the installed pin
 * tree, not just the two files this track redacts. Two branches: an
 * explicit page-citation shape ("Source: <book>, p. <page>", the exact
 * shape both redacted files use), and known third-party trademark names
 * written as whole words (so "GURPS_CONSUMED_TITLES" or "renderGURPSSheet"
 * do not match — no word boundary sits between "GURPS" and an adjoining
 * identifier character). This is deliberately broader than the two known
 * files: it is the backstop for a pin move that adds a third one
 * (Structural decision D6b).
 */
const PIN_SCAN_PATTERN = /Source:\s*[^\n]*?p\.\s*\S+|\bGURPS\b|\bCthulhu\b|\bChaosium\b|\bSteve Jackson\b/g;

/**
 * The committed baseline: every hit PIN_SCAN_PATTERN currently produces
 * over the installed pin tree, each with a one-line judgement of why it is
 * benign (nominative use of a trademark name in a comment, identifier or
 * warning string; no reproduced rules data) or, for the two files this
 * track redacts, a note that it is handled elsewhere. Re-derive this on
 * every pin move (docs/decisions/0005-generator-pin.md's pin-move
 * procedure) and read every changed entry by hand — do not let the test
 * pad this list to go green (test/redactions.test.js compares it against
 * a fresh scanPinTree() run and fails on any drift).
 */
const PIN_SCAN_BASELINE = [
  { pinPath: 'css/style.css', line: 3122, note: 'section-header comment naming the system a CSS block styles; presentation only (line moved from 3101 at the publish-v1.12.0 repin, content unchanged)' },
  { pinPath: 'css/style.css', line: 3446, note: 'section-header comment naming the system a CSS block styles; presentation only (line moved from 3425 at the publish-v1.12.0 repin, content unchanged)' },
  { pinPath: 'css/style.css', line: 4096, note: 'section-header comment naming the system a CSS block styles; presentation only (line moved from 3925 at the publish-v1.14.0 repin, content unchanged)' },
  { pinPath: 'css/themes/horror.css', line: 1, note: 'theme comment, trademark naming only' },
  { pinPath: 'css/themes/horror.css', line: 2, note: 'theme comment, trademark naming only' },
  { pinPath: 'css/themes/military.css', line: 2, note: 'theme comment, trademark naming only' },
  { pinPath: 'css/themes/scifi.css', line: 2, note: 'theme comment, trademark naming only' },
  { pinPath: 'js/gurps-live.js', line: 1, note: 'file-header comment naming the system this live-session script serves; no rules data' },
  { pinPath: 'js/gurps-party.js', line: 1, note: 'file-header comment naming the system this party-board script serves; no rules data' },
  { pinPath: 'lib/build.js', line: 879, note: 'new at publish-v1.14.0: comment saying a sheet renderer returns an object for three systems or a string for two; names the systems only, no rules data' },
  { pinPath: 'lib/color-mode.js', line: 19, note: 'new file at publish-v1.11.40 (Δ): comment naming "GURPS sheet chips" as one of the light-mode blocks the dark-mode attribute transform covers; nominative use describing CSS behaviour, no rules data' },
  { pinPath: 'lib/flush-cli.js', line: 64, note: 'comment naming which system a flush branch edits; no rules data (line moved from 117 at the publish-v1.14.0 repin, content unchanged; the comment at old line 43 naming the two live-state systems is gone at this pin)' },
  { pinPath: 'lib/flush/gurps-max.js', line: 3, note: 'comment naming the system a pure derive function targets; no rules data' },
  { pinPath: 'lib/flush/gurps-writeback.js', line: 3, note: 'comment naming the system a pure writeback function targets; no rules data' },
  { pinPath: 'lib/flush/gurps-writeback.js', line: 6, note: 'comment naming the system a pure writeback function targets; no rules data' },
  { pinPath: 'lib/party-board-registry.js', line: 11, note: 'system-key registry identifier; no rules data (line moved from 10 at the publish-v1.14.0 repin, content unchanged)' },
  { pinPath: 'lib/party-board-registry.js', line: 30, note: 'system-key registry mapping; no rules data (line moved from 23 at the publish-v1.14.0 repin, content unchanged)' },
  { pinPath: 'lib/pc-prose.js', line: 16, note: 'new file at publish-v1.12.0: comment explaining that a retired sheet field is reported only for the system whose renderer read it; nominative naming of two systems, no rules data' },
  { pinPath: 'lib/templates/coc/skills-data.js', line: 9, note: 'redacted by this work' },
  { pinPath: 'lib/templates/coc/skills-data.js', line: 40, note: 'redacted by this work' },
  { pinPath: 'lib/templates/gurps/blocks/reference.js', line: 3, note: 'redacted by this work' },
  { pinPath: 'lib/templates/gurps/blocks/reference.js', line: 53, note: 'redacted by this work' },
  { pinPath: 'lib/templates/gurps/blocks/reference.js', line: 65, note: 'redacted by this work' },
  { pinPath: 'lib/templates/gurps/derived.js', line: 4, note: 'comment naming the system for a pure derived-value formula; same 17 U.S.C. 102(b) reasoning as gurps-calc.js' },
  { pinPath: 'lib/templates/gurps/derived.js', line: 37, note: 'comment naming the system for a pure lifting-feats formula; same 17 U.S.C. 102(b) reasoning as gurps-calc.js' },
  { pinPath: 'lib/templates/gurps/derived.js', line: 57, note: 'comment naming the system for a pure slam-damage formula; same 17 U.S.C. 102(b) reasoning as gurps-calc.js' },
  { pinPath: 'lib/templates/gurps/derived.js', line: 86, note: 'comment naming the system for a pure slam-table formula; same 17 U.S.C. 102(b) reasoning as gurps-calc.js' },
  { pinPath: 'lib/templates/gurps/gurps-calc.js', line: 2, note: 'comment naming the source of pure formulas; same 17 U.S.C. 102(b) reasoning docs/PROVENANCE.md used for the D&D ability-modifier formula' },
  { pinPath: 'lib/templates/gurps/live-data.js', line: 116, note: 'comment naming the system for a default stat-key mapping; no rules data' },
  { pinPath: 'lib/templates/gurps/parse.js', line: 380, note: 'user-facing warning-message string naming the system; no rules data (line moved from 483 at the publish-v1.12.0 repin, content unchanged)' },
  { pinPath: 'lib/templates/gurps/parse.js', line: 384, note: 'user-facing warning-message string naming the system; no rules data (line moved from 487 at the publish-v1.12.0 repin, content unchanged)' },
  { pinPath: 'lib/templates/gurps/parse.js', line: 385, note: 'user-facing warning-message string naming the system; no rules data (line moved from 488 at the publish-v1.12.0 repin, content unchanged)' },
  { pinPath: 'lib/templates/gurps/parse.js', line: 463, note: 'user-facing warning-message string naming the system; no rules data (line moved from 566 at the publish-v1.12.0 repin, content unchanged)' },
  { pinPath: 'lib/templates/gurps/parse.js', line: 468, note: 'user-facing warning-message string naming the system; no rules data (line moved from 571 at the publish-v1.12.0 repin, content unchanged)' },
  { pinPath: 'lib/templates/gurps/parse.js', line: 474, note: 'user-facing warning-message string naming the system; no rules data (line moved from 577 at the publish-v1.12.0 repin, content unchanged)' },
  { pinPath: 'lib/templates/gurps/render.js', line: 63, note: 'comment naming the system for a pure number-formatting helper; no rules data' },
  { pinPath: 'lib/templates/gurps/render.js', line: 72, note: 'comment naming the system for a pure number-formatting helper; no rules data' },
  { pinPath: 'lib/templates/pc-registry.js', line: 34, note: 'new at publish-v1.11.43: comment saying two systems keep their own consumed-section lists in pc.js; names the systems only, no rules data' },
  { pinPath: 'lib/templates/pc.js', line: 34, note: 'comment naming which system renderer the accordion filter reacts to; no rules data (line moved from 33 at the publish-v1.12.3 repin, content unchanged)' },
  { pinPath: 'lib/templates/pc.js', line: 35, note: 'comment naming which system renderer the accordion filter reacts to; no rules data (line moved from 34 at the publish-v1.12.3 repin, content unchanged)' },
  { pinPath: 'lib/templates/pc.js', line: 57, note: 'display labels, nominative use (line moved from 56 at the publish-v1.12.3 repin, content unchanged)' },
  { pinPath: 'lib/templates/pc.js', line: 58, note: 'display labels, nominative use (line moved from 57 at the publish-v1.12.3 repin, content unchanged)' },
];

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Sweeps every file in the installed pin tree for PIN_SCAN_PATTERN,
 * returning every matching line as a pinPath (posix, relative to
 * generatorDir) + 1-based line number, sorted by pinPath then line.
 *
 * @param {string} generatorDir absolute path to the installed
 *   node_modules/gm-apprentice-publish tree
 * @returns {{ pinPath: string, line: number }[]}
 */
function scanPinTree(generatorDir) {
  const hits = [];
  for (const full of walkFiles(generatorDir)) {
    const pinPath = path.relative(generatorDir, full).split(path.sep).join('/');
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (err) {
      continue; // not a text file; nothing in this heuristic applies
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      PIN_SCAN_PATTERN.lastIndex = 0;
      if (PIN_SCAN_PATTERN.test(line)) hits.push({ pinPath, line: i + 1 });
    });
  }
  hits.sort((a, b) => (a.pinPath < b.pinPath ? -1 : a.pinPath > b.pinPath ? 1 : a.line - b.line));
  return hits;
}

/**
 * Checks a Buffer for every MARKERS string, in both latin1 and utf16le
 * byte representations (V8's serialised code cache, which a packaged exe
 * embeds, may hold either).
 *
 * @param {Buffer} buf
 * @returns {string[]} every marker string found (not encoding-tagged; a
 *   string found in only one encoding still reports once)
 */
function scanBuffer(buf) {
  const found = [];
  for (const entry of MARKERS) {
    for (const s of entry.strings) {
      const latin1 = Buffer.from(s, 'latin1');
      const utf16le = Buffer.from(s, 'utf16le');
      if (buf.includes(latin1) || buf.includes(utf16le)) found.push(s);
    }
  }
  return found;
}

/**
 * The AC-R8 ship gate's core check: scans every given file for every
 * marker string.
 *
 * @param {string[]} paths absolute paths to scan (the packaged exe, and
 *   anything else that should never carry rules content)
 * @returns {{ ok: boolean, hits: { file: string, marker: string }[] }}
 */
function assertNoRulesContent(paths) {
  const hits = [];
  for (const file of paths) {
    const buf = fs.readFileSync(file);
    for (const marker of scanBuffer(buf)) hits.push({ file, marker });
  }
  return { ok: hits.length === 0, hits };
}

module.exports = { MARKERS, PIN_SCAN_PATTERN, PIN_SCAN_BASELINE, scanPinTree, scanBuffer, assertNoRulesContent };
