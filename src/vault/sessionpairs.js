'use strict';

const path = require('path');
const read = require('./read');
const pinned = require('../generator/pinned');
const { toRelativePosix } = require('../util/paths');

/*
 * ADR 0036: the check-side half of session pairing (`check` recomputes; `src/build/sessionmodel.js`
 * reads what a real build actually did). This module never touches the vault except through
 * `src/vault/read.js`, and never asks the pin's own `scanAllNotes(vaultPath)` (which bypasses that
 * chokepoint and swallows read errors) -- `scanAllNotesForPairing` below is a faithful, structurally
 * change-detected port of it instead (lib/scanner.js:379-413).
 *
 * All internal calls the rest of the codebase makes go through `module.exports`, so a test can spy
 * on `adaptPage` / `scanAllNotesForPairing` independently of `computeSessionPairing`.
 */

// lib/scanner.js:377,397: the note is frontmatter-gated when its raw text matches either the
// aliases line or the session-type line. ALIASES_LINE mirrors :367's own aliases half verbatim.
const ALIASES_LINE = /^(gm_)?aliases:/m;

// lib/scanner.js:377's SESSION_TYPE_LINE, in its exact shape, built from the pin's own
// WRAP_UP_TYPES rather than a hand copy of the three type strings -- a pin bump that changes the
// Wrap-Up type list changes this gate too, by construction, and test/session-pairing.test.js's
// change detector proves the alternation still equals {'session'} union WRAP_UP_TYPES.
const SESSION_TYPE_GATE = new RegExp(
  `^type:\\s*["']?(${['session', ...pinned.WRAP_UP_TYPES].join('|')})["']?\\s*$`,
  'm',
);

/**
 * Adapts our own page shape ({ relPath, title, displayTitle, frontmatter, sourcePath, markdown, ... })
 * to the one lib/session-hub.js's pairHubs/linkKeys reads. Callers must adapt each page exactly
 * once and reuse the SAME adapted object everywhere pairHubs is given both a `corpus` and a
 * `published` array: pairHubs tests `published` membership by object identity
 * (lib/session-hub.js:111,118), so a hub linked only through its own `documents.wrap_up` never
 * pairs unless `corpus` and `published` share objects (the latent bug in the check this replaces
 * -- docs/agent-runs corrections, finding 0.1).
 *
 * @param {object} page
 * @returns {{ relPath: string, title: string, displayTitle: string, vaultPath: string,
 *   frontmatter: object, sourcePath: string, markdown: string|undefined }}
 */
function adaptPage(page) {
  return {
    relPath: page.relPath,
    title: page.title,
    displayTitle: page.displayTitle,
    vaultPath: page.relPath.replace(/\.md$/i, ''),
    frontmatter: page.frontmatter,
    sourcePath: page.sourcePath,
    markdown: page.markdown,
  };
}

/**
 * A faithful port of lib/scanner.js:379-413's scanAllNotes, routed through src/vault/read.js
 * (Structural decision 2). Every note in the vault, ignoring excludeDirs/folderMap/type, the way
 * Obsidian resolves a link to any note in the vault and a GM-only folder the site never scans is
 * the likeliest home for a secret pairing link.
 *
 * Divergence from the pin, deliberate: a filesystem read failure here throws VaultReadError and
 * aborts (the pin's own walk swallows a readdir failure and returns an empty subtree instead) --
 * the difference can only abort `check`, never silently under-report a pairing link.
 *
 * @param {string} vaultPath
 * @returns {{ notes: { relPath: string, title: string, displayTitle: string, vaultPath: string,
 *   sourcePath: string, frontmatter: object }[], symlinkedNotes: number }}
 */
function scanAllNotesForPairing(vaultPath) {
  const notes = [];
  let symlinkedNotes = 0;

  function walk(absDir) {
    for (const entry of read.listDir(absDir)) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(absDir, entry.name);

      if (entry.isDirectory) {
        walk(full);
        continue;
      }

      const lower = entry.name.toLowerCase();
      if (entry.isSymbolicLink) {
        if (lower.endsWith('.md')) symlinkedNotes += 1;
        continue;
      }
      if (!entry.isFile || !lower.endsWith('.md')) continue;

      const title = entry.name.slice(0, -3);
      const relPath = toRelativePosix(vaultPath, full);
      const result = read.readFrontmatter(full);
      const gated = ALIASES_LINE.test(result.raw) || SESSION_TYPE_GATE.test(result.raw);
      const frontmatter = result.ok && gated ? result.data || {} : {};

      notes.push({
        relPath,
        title,
        displayTitle: title.replace(/_/g, ' '),
        vaultPath: relPath.replace(/\.md$/i, ''),
        sourcePath: full,
        frontmatter,
      });
    }
  }

  walk(vaultPath);
  return { notes, symlinkedNotes };
}

const EMPTY_PAIRING = Object.freeze({
  pairs: Object.freeze([]),
  widePairs: Object.freeze([]),
  linked: Object.freeze(new Set()),
  publishedWrapUps: Object.freeze([]),
  withheldHubs: Object.freeze(new Set()),
  uncertain: false,
});

/**
 * One `pairHubs` result entry, mapped back to relPath/outputPath. `hub`/`wrapUp` are the adapted
 * objects pairHubs itself returned (always literal elements or lookups of `adapted`'s values --
 * see the module-level comment on object identity); `originalOf` maps them back to the caller's
 * own page objects, from which the real outputPath is read.
 */
function toPairEntry(hub, wrapUp, originalOf, publishedSet) {
  const hubOriginal = originalOf.get(hub);
  const wrapUpOriginal = originalOf.get(wrapUp);
  return {
    hub: {
      relPath: hub.relPath,
      outputPath: hubOriginal ? hubOriginal.outputPath : null,
      published: hubOriginal ? publishedSet.has(hubOriginal) : false,
    },
    wrapUp: {
      relPath: wrapUp.relPath,
      outputPath: wrapUpOriginal ? wrapUpOriginal.outputPath : null,
    },
  };
}

/**
 * SD-1/SD-2/SD-3 (docs/agent-runs/r2-session-wrap-architect-2026-09-30.md): the check-side
 * pairing, recomputed through the pin's own pairHubs with inputs made equal to the generator's own
 * build. Gated (SD-3): when no published page is a Wrap-Up, returns the frozen EMPTY_PAIRING
 * without walking the vault's notes at all -- this is what makes NFR-01 hold structurally.
 *
 * @param {{ vaultPath: string, publishSet: { publishedPages: object[], unpublishedPages: object[] } }} opts
 * @returns {{
 *   pairs: { hub: { relPath, outputPath, published }, wrapUp: { relPath, outputPath } }[],
 *   widePairs: { hub: { relPath, outputPath, published }, wrapUp: { relPath, outputPath } }[],
 *   linked: Set<string>,
 *   publishedWrapUps: string[],
 *   withheldHubs: Set<string>,
 *   uncertain: boolean,
 * }}
 */
function computeSessionPairing({ vaultPath, publishSet }) {
  // `unpublishedPages` defaults to [] for callers (existing unit tests, predating ADR 0036) that
  // hand-build a minimal ctx.publishSet with only `publishedPages` -- SD-3's gate below still
  // returns EMPTY_PAIRING for any such ctx that has no published Wrap-Up, well before vaultPath
  // (also potentially absent on such a ctx) would ever be read.
  const corpusPages = [...publishSet.publishedPages, ...(publishSet.unpublishedPages || [])];
  const publishedSet = new Set(publishSet.publishedPages);

  const adapted = new Map(corpusPages.map((p) => [p, module.exports.adaptPage(p)]));
  const originalOf = new Map(corpusPages.map((p) => [adapted.get(p), p]));
  const corpus = corpusPages.map((p) => adapted.get(p));
  const published = publishSet.publishedPages.map((p) => adapted.get(p));

  if (!published.some((p) => pinned.isWrapUp(p))) return EMPTY_PAIRING;

  const { notes: allNotes, symlinkedNotes } = module.exports.scanAllNotesForPairing(vaultPath);
  const uncertain = symlinkedNotes > 0;

  const standard = pinned.pairHubs(corpus, published, { allNotes, apply: false });

  const scannedSourcePaths = new Set(corpusPages.map((p) => p.sourcePath));
  const notesOutsideCorpus = allNotes.filter((n) => !scannedSourcePaths.has(n.sourcePath));
  const wide = pinned.pairHubs(corpus.concat(notesOutsideCorpus), published, { allNotes, apply: false });

  const pairs = [...standard.entries()].map(([hub, wrapUp]) => toPairEntry(hub, wrapUp, originalOf, publishedSet));
  const widePairs = [...wide.entries()].map(([hub, wrapUp]) => toPairEntry(hub, wrapUp, originalOf, publishedSet));

  const linked = new Set([...standard.linked].map((w) => w.relPath));
  const publishedWrapUps = published
    .filter((p) => pinned.isWrapUp(p))
    .map((p) => p.relPath)
    .sort();

  const withheldHubs = new Set();
  if (!uncertain) {
    for (const pair of pairs) {
      if (pair.hub.published) withheldHubs.add(pair.hub.relPath);
    }
  }

  return { pairs, widePairs, linked, publishedWrapUps, withheldHubs, uncertain };
}

module.exports = {
  adaptPage,
  scanAllNotesForPairing,
  computeSessionPairing,
  EMPTY_PAIRING,
};
