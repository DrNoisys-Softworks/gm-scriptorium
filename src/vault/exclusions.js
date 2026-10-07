'use strict';

const pinned = require('../generator/pinned');

/*
 * ADR 0019, Structural decision 7: the excluded-directory union and matcher L2
 * (src/checks/leak/l2.js) already computed inline, extracted so the asset step
 * (src/build/themeassets.js) can reuse the identical semantics rather than
 * duplicating them, plus two asset-step-only additions (excludedSegmentHit,
 * platformFoldsCase) that L2 itself does not use.
 *
 * FR06's "any segment is in the G5 union" is implemented as the union of four
 * rules ("Things you need to know first" #3 of the Engineering Brief):
 *   - L2's own matcher (excludedDirHit): a prefix match on union entries,
 *     plus ALWAYS_EXCLUDE_DIRS segments
 *   - excludedSegmentHit: a single-segment union entry matching at any depth
 *   - excludedSegmentHit: any segment starting with "."
 *   - foldCase on win32 and darwin (platformFoldsCase)
 * A pure segment match would miss multi-segment union entries such as the
 * live vault's `_attachments/maps`, which is why excludedDirHit's prefix
 * match against the whole union stays separate from excludedSegmentHit.
 */

/**
 * Exactly l2.js's old inline union: json excludeDirs then
 * publishConfig.exclude_dirs, exact-string dedupe, first-seen order.
 *
 * @param {object} jsonConfig
 * @param {object} publishConfig
 * @returns {string[]}
 */
function excludedDirUnion(jsonConfig, publishConfig) {
  const jsonExcludeDirs = (jsonConfig && jsonConfig.excludeDirs) || [];
  const vaultExcludeDirs = (publishConfig && publishConfig.exclude_dirs) || [];
  return [...new Set([...jsonExcludeDirs, ...vaultExcludeDirs])];
}

/**
 * L2's matcher, moved: the first union entry relPath equals or sits under
 * (union order), else the first ALWAYS_EXCLUDE_DIRS directory segment
 * (filename popped), else null. foldCase lowercases both sides of every
 * comparison; the ORIGINAL entry/segment text is returned.
 *
 * @param {string} relPath
 * @param {string[]} union
 * @param {{ foldCase?: boolean }} [opts]
 * @returns {string|null}
 */
function excludedDirHit(relPath, union, { foldCase = false } = {}) {
  const rel = String(relPath == null ? '' : relPath);
  const fold = (s) => (foldCase ? s.toLowerCase() : s);
  const foldedRel = fold(rel);

  for (const entry of union) {
    const foldedEntry = fold(entry);
    if (foldedRel === foldedEntry || foldedRel.startsWith(`${foldedEntry}/`)) return entry;
  }

  const segments = rel.split('/');
  segments.pop(); // the filename is popped: this arm is directory-only
  const hit = segments.find((s) => pinned.ALWAYS_EXCLUDE_DIRS.some((a) => fold(a) === fold(s)));
  return hit || null;
}

/**
 * Asset-step addition: the first segment of relPath (directories and
 * filename) that starts with "." or equals (folded) a union entry
 * containing no "/".
 *
 * @param {string} relPath
 * @param {string[]} union
 * @param {{ foldCase?: boolean }} [opts]
 * @returns {string|null}
 */
function excludedSegmentHit(relPath, union, { foldCase = false } = {}) {
  const rel = String(relPath == null ? '' : relPath);
  const fold = (s) => (foldCase ? s.toLowerCase() : s);
  const singleSegmentUnion = union.filter((e) => !e.includes('/')).map(fold);

  for (const seg of rel.split('/')) {
    if (seg.startsWith('.')) return seg;
    if (singleSegmentUnion.includes(fold(seg))) return seg;
  }
  return null;
}

/** process.platform === 'win32' || 'darwin', evaluated per call (plan.js:75-78). */
function platformFoldsCase() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

module.exports = { excludedDirUnion, excludedDirHit, excludedSegmentHit, platformFoldsCase };
