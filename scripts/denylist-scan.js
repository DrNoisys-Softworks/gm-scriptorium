'use strict';

/*
 * A local, read-only, count-only denylist scanner (S0 Engineering Brief,
 * public-sweep FR-01/NFR-11). It never prints a matched term: every printed
 * line -- stdout or stderr -- passes through exactly one masking chokepoint
 * (maskLine, below) before it leaves this process (Structural decision 6).
 *
 * Usage:
 *   node denylist-scan.js [options] tree [<rev>] [-- <pathspec>...]
 *   node denylist-scan.js [options] commits <rev-list-arg>...
 *   node denylist-scan.js [options] files <path>...
 * Options (repeatable list flags; each replaces its env var, never merges):
 *   --terms <file>      (env SCRIPTORIUM_DENYLIST_TERMS)
 *   --patterns <file>   (env SCRIPTORIUM_DENYLIST_PATTERNS)
 *   --allow <file>      (env SCRIPTORIUM_DENYLIST_ALLOW)
 *   --match word|substring   (default word)
 *   --lines             (tree/files only; usage error with commits)
 *   -h, --help
 * Exit codes (local to this script, not src/util/exitcodes.js -- SD-9):
 *   0 no hit outside the allowlist; 1 one or more such hits; 2 any listed
 *   error (usage, no-lists, no-entries, list-unreadable, list-in-repo,
 *   bad-entry, bad-allow, not-a-repo, bad-rev, no-targets, missing-path).
 *
 * Decisions (Structural decisions in the brief; only the load-bearing ones
 * are repeated here):
 * - SD-1: one file, never required from src/ or bin/, so it never ships.
 * - SD-2: lists are consumed, never harvested; no vault read of any kind.
 * - SD-4: matching semantics equal src/checks/leak/l4.js's
 *   findWholeWordOccurrences (whole word, case-insensitive, NFC needle vs
 *   normalised haystack) -- but re-derived as one compiled alternation per
 *   category (longest value first) rather than a per-entry loop, because a
 *   per-entry loop over 664+ terms was measured too slow against binaries.
 *   Every regex-kind pattern entry is compiled individually with 'giu' and
 *   is never boundary-wrapped, even in word mode (SD-4's `--match substring`
 *   clause is literal-only). test/denylist-scan.test.js's parity suite
 *   proves this compiled form agrees with calling findWholeWordOccurrences
 *   per entry on a synthetic corpus.
 * - SD-5: every byte is read. No extension or NUL skip (the precedent NOT
 *   to copy is outputscan.js's BINARY_EXTENSIONS list). A buffer containing
 *   a NUL is decoded and scanned as UTF-8, plus UTF-16LE from BOTH possible
 *   byte alignments (decodeVariants, below) -- a single-phase UTF-16LE
 *   decode only recovers an occurrence whose 2-byte code units happen to
 *   start on an even offset within the buffer; one starting at an odd
 *   offset decodes as unrelated garbage and would otherwise be silently
 *   missed. A path/label is always its own haystack, in addition to any content.
 *   Symlinks are never followed; lstat + readlink supplies their link text
 *   as the haystack instead of whatever they point at.
 * - SD-6: exactly one output chokepoint (maskLine). new RegExp's
 *   SyntaxError is caught at parse time and never surfaced (its message
 *   echoes the offending source), so a bad regex becomes a bare
 *   `bad-entry` with a line number only.
 * - SD-7: list-outside-repo is checked with isInside(listPath, repoRoot) --
 *   realpath plus path.relative, never a string prefix (see M1/M3 in the
 *   Engineer's report for why a naive check is wrong twice over).
 * - SD-8: an allowlist entry always needs a non-empty reason. `term` allow
 *   entries suppress a loaded literal (from either list) everywhere it
 *   would otherwise hit, compared after NFC + lowercase; `path` allow
 *   entries suppress every hit inside one exact target. Both track use
 *   across the whole run; entries that never suppressed anything are
 *   reported as UNUSED lines by line number and folded into
 *   TOTAL's unused-allow count.
 * - SD-10: read-only. No fs write call anywhere in this file. Only
 *   ls-files, ls-tree, cat-file, rev-list, diff-tree and rev-parse are ever
 *   invoked, always with `-c core.quotePath=false`, `-z` where a NUL
 *   delimiter is actually meaningful (path-listing forms; omitted for the
 *   per-file patch call, which has no use for it), and diff-tree always
 *   carries `--no-ext-diff --no-textconv` so a .gitattributes textconv
 *   filter can never hide real content from the scan.
 *
 * A commit's "message" target (label `<sha12>:message`) is the WHOLE raw
 * `cat-file commit` object -- tree/parent lines, author, committer and the
 * message body together -- scanned as one haystack. That single target
 * covers both "message" and "author identity" without a second git call.
 * A commit's per-path targets (label `<sha12>:<path>`) come from a
 * `diff-tree --raw` listing against the first parent (the well-known empty
 * tree for a root commit), restricted to added/modified/typechanged paths;
 * a path's post-image blob is fetched once, and classified by this
 * script's OWN NUL test (not git's textconv-independent binary heuristic,
 * to keep exactly one definition of "binary" in play): a NUL anywhere in
 * the blob makes it a binary change (the full post-image blob is the
 * haystack, dual-decoded per SD-5); otherwise a per-file `diff-tree -p`
 * patch supplies the added (`+`, never `+++`) lines only, so a pre-existing
 * line is never counted twice.
 *
 * The MODE line's third field is WORKTREE (tree, no rev), the rev string
 * (tree <rev>), or "<n> targets" where n is the count of raw positional
 * arguments given to `files`/`commits` (this isn't spelled out character
 * for character in the brief's contract table; recorded here so a reader
 * doesn't have to reverse-engineer it from the tests).
 *
 * `no-targets` (exit 2) fires for `tree` and `files` when the resolved
 * target list is empty -- an empty commit range is deliberately NOT this
 * error (see the brief's risk area 2: a swapped range legitimately gives
 * `COMMITS 0`, and the dogfood gate catches that class of mistake by
 * cross-checking COMMITS against `rev-list --count` independently, not by
 * this script refusing to run).
 *
 * Will catch: a denylisted term or pattern anywhere in a tracked or
 * untracked-but-unignored file's path or content, in a commit's author,
 * committer or message text, in an added line of a text diff, in a
 * binary diff's full post-image blob (as UTF-8, and as UTF-16LE at both
 * byte alignments), and in a `files`-mode notes/dist tree.
 *
 * Will not catch, deliberately:
 * - Compressed payloads (.tgz, zip, woff2, PNG zTXt/iTXt chunks): the bytes
 *   inside are opaque to a byte-level literal/regex scan without inflating
 *   them first, which this read-only, no-new-dependency script doesn't do.
 * - A term split across two lines (word-mode boundaries operate within a
 *   single haystack string; a line break inside a name defeats it).
 * - Word-mode misses on a hit embedded in a longer identifier (that's what
 *   `--match substring` is for; it is not the default because it also
 *   surfaces far more incidental noise).
 * - Any term that was never added to a list. This scans against what it is
 *   given, nothing more.
 * - Numbers (e.g. how many people were really in a scene) -- someone still
 *   has to read for those, same finding as the Lead's ADR 0023 note.
 * - Merge-commit content beyond the first parent (SD-4 note above): a
 *   merge's diff is only ever computed against parents[0].
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { normaliseEmitted } = require('../src/checks/leak/outputscan');
const { canonicalNfc } = require('../src/generator/pinned');

const CATEGORIES = Object.freeze(['term', 'name', 'place', 'path', 'ip', 'domain', 'email', 'agent', 'host', 'other']);
const PATTERN_CATEGORIES = new Set(['name', 'place', 'path', 'ip', 'domain', 'email', 'agent', 'host', 'other']);
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// The l4.js boundary, reproduced literally (l4.js:23) rather than required,
// because it's inlined into a per-category alternation there, not exported
// on its own. `test/denylist-scan.test.js`'s parity suite is what keeps this
// honest against the real findWholeWordOccurrences.
const WORD_LEFT = '(?<![\\p{L}\\p{N}])';
const WORD_RIGHT = '(?![\\p{L}\\p{N}])';

class ScanError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.list = extra.list;
    this.line = extra.line;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitLines(text) {
  return String(text).split(/\r\n|\r|\n/);
}

// ---------------------------------------------------------------------------
// List parsing
// ---------------------------------------------------------------------------

function parseTermList(text) {
  const entries = [];
  const errors = [];
  splitLines(text).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    entries.push({ kind: 'literal', category: 'term', value: line, line: i + 1 });
  });
  return { entries, errors };
}

function parsePatternList(text) {
  const entries = [];
  const errors = [];
  splitLines(text).forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const m = /^(\S+)\s+(\S+)\s+(.*)$/.exec(trimmed);
    if (!m) {
      errors.push({ line: i + 1, code: 'bad-entry' });
      return;
    }
    const [, kind, category, rawValue] = m;
    const value = rawValue.trim();
    if ((kind !== 'literal' && kind !== 'regex') || !PATTERN_CATEGORIES.has(category) || value === '') {
      errors.push({ line: i + 1, code: 'bad-entry' });
      return;
    }
    if (kind === 'regex') {
      try {
        // eslint-disable-next-line no-new
        new RegExp(value, 'giu');
      } catch {
        // Never surfaced: the SyntaxError's message echoes the pattern (SD-6).
        errors.push({ line: i + 1, code: 'bad-entry' });
        return;
      }
    }
    entries.push({ kind, category, value, line: i + 1 });
  });
  return { entries, errors };
}

function parseAllowList(text) {
  const allows = [];
  const errors = [];
  splitLines(text).forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    // The trailing `\s*` (not `\s+`) is deliberate: the outer `trimmed` already had trailing
    // whitespace stripped, so "kind target --" (a genuinely missing reason) would never match a
    // `\s+` here -- it would always fail this regex outright and get the generic bad-allow from
    // the `if (!m)` branch below, never reaching the reason === '' check, which would make that
    // check dead code no mutation could ever exercise (found while proving M17).
    const m = /^(\S+)\s+(.+?)\s+--\s*(.*)$/.exec(trimmed);
    if (!m) {
      errors.push({ line: i + 1, code: 'bad-allow' });
      return;
    }
    const [, kind, target, rawReason] = m;
    const reason = rawReason.trim();
    if ((kind !== 'term' && kind !== 'path') || target === '' || reason === '') {
      errors.push({ line: i + 1, code: 'bad-allow' });
      return;
    }
    allows.push({ kind, target, reason, line: i + 1, used: false });
  });
  return { allows, errors };
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

function buildMatcher(entries, { match = 'word' } = {}) {
  const literalsByCategory = new Map();
  const regexEntries = [];
  for (const e of entries) {
    if (e.kind === 'regex') {
      let re;
      try {
        re = new RegExp(e.value, 'giu');
      } catch {
        continue; // pre-validated by parsePatternList; defensive only.
      }
      regexEntries.push({ category: e.category, regex: re });
    } else {
      const nfc = canonicalNfc(String(e.value));
      if (!literalsByCategory.has(e.category)) literalsByCategory.set(e.category, new Set());
      literalsByCategory.get(e.category).add(nfc);
    }
  }
  const categoryRegexes = [];
  for (const [category, valueSet] of literalsByCategory) {
    const values = [...valueSet].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    const alt = values.map(escapeRegExp).join('|');
    const pattern = match === 'substring' ? `(?:${alt})` : `${WORD_LEFT}(?:${alt})${WORD_RIGHT}`;
    categoryRegexes.push({ category, regex: new RegExp(pattern, 'giu') });
  }
  return { categoryRegexes, regexEntries, match };
}

/** Appends every match of one compiled sub-pattern to `spans` (shared by both loops below, so the
 * match-position lookup exists exactly once in this file, not once per loop). */
function collectSpans(regex, text, category, spans) {
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text))) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    const at = m.index;
    spans.push({ start: at, end: at + m[0].length, category });
  }
}

/** Every non-overlapping match span across every compiled sub-pattern, sorted left to right. */
function findMatches(text, matcher) {
  const spans = [];
  for (const { category, regex } of matcher.categoryRegexes) collectSpans(regex, text, category, spans);
  for (const { category, regex } of matcher.regexEntries) collectSpans(regex, text, category, spans);
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start >= lastEnd) {
      accepted.push(s);
      lastEnd = s.end;
    }
  }
  return accepted;
}

function lineIndexForOffset(text, offset) {
  let count = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

function countHits(text, matcher) {
  const matches = findMatches(text, matcher);
  const byCategory = {};
  const byLine = {};
  for (const m of matches) {
    byCategory[m.category] = (byCategory[m.category] || 0) + 1;
    const line = lineIndexForOffset(text, m.start) + 1;
    if (!byLine[line]) byLine[line] = {};
    byLine[line][m.category] = (byLine[line][m.category] || 0) + 1;
  }
  return { total: matches.length, byCategory, byLine };
}

/**
 * Every text-decoding variant a byte buffer must be scanned as. UTF-8 is
 * always included. A NUL anywhere (SD-5) also gets UTF-16LE decoded from
 * BOTH possible 2-byte-code-unit alignments: byte offset 0 and byte offset
 * 1. A single-phase decode (offset 0 only) only recovers UTF-16LE text
 * whose code units happen to start on an even byte offset within THIS
 * buffer; an occurrence starting at an odd offset decodes as unrelated
 * garbage and was silently missed (found in review: an 18-char UTF-16LE
 * term placed after a 7-byte header reproduced this exactly, and one byte
 * of padding flipped it back to found -- test/denylist-scan.test.js's
 * misalignedBinaryFixture() proves both parities). A real occurrence sits
 * at one fixed byte offset, so it surfaces from exactly one of the two
 * phases, never both -- summing them adds full-text scan cost, not
 * double-counted hits.
 */
function decodeVariants(buf) {
  const variants = [normaliseEmitted(buf.toString('utf8'))];
  if (buf.includes(0)) {
    variants.push(normaliseEmitted(buf.toString('utf16le')));
    variants.push(normaliseEmitted(buf.subarray(1).toString('utf16le')));
  }
  return variants;
}

function countInBuffer(buf, matcher) {
  let total = 0;
  const byCategory = {};
  const merge = (res) => {
    total += res.total;
    for (const [cat, n] of Object.entries(res.byCategory)) byCategory[cat] = (byCategory[cat] || 0) + n;
  };
  for (const text of decodeVariants(buf)) merge(countHits(text, matcher));
  return { total, byCategory };
}

function maskLabel(label, matcher) {
  const nfc = canonicalNfc(String(label));
  const matches = findMatches(nfc, matcher);
  if (matches.length === 0) return nfc;
  let out = '';
  let pos = 0;
  for (const m of matches) {
    out += nfc.slice(pos, m.start) + `[${m.category}]`;
    pos = m.end;
  }
  out += nfc.slice(pos);
  return out;
}

function isInside(child, parent) {
  const rc = fs.realpathSync(child);
  const rp = fs.realpathSync(parent);
  if (rc === rp) return true;
  const rel = path.relative(rp, rc);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Allow-list classification (internal; not part of the exported API)
// ---------------------------------------------------------------------------

function canonFold(value) {
  return canonicalNfc(String(value)).toLowerCase();
}

function buildAllowIndex(allows) {
  const termIndex = new Map(); // canonFold(target) -> allow entry[]
  const pathIndex = new Map(); // exact target string -> allow entry[]
  for (const a of allows) {
    if (a.kind === 'term') {
      const key = canonFold(a.target);
      if (!termIndex.has(key)) termIndex.set(key, []);
      termIndex.get(key).push(a);
    } else {
      // Exact string, no normalisation: git sees an NFC and an NFD spelling as two files.
      const key = a.target;
      if (!pathIndex.has(key)) pathIndex.set(key, []);
      pathIndex.get(key).push(a);
    }
  }
  return { termIndex, pathIndex };
}

/** Classifies every match in `text` as effective (counts toward HIT) or allowed (counts toward ALLOWED). */
function classifyText(text, matcher, termIndex) {
  const matches = findMatches(text, matcher);
  const effective = { total: 0, byCategory: {}, byLine: {} };
  const allowed = { total: 0, byCategory: {} };
  for (const m of matches) {
    const key = text.slice(m.start, m.end).toLowerCase();
    const allowEntries = termIndex.get(key);
    if (allowEntries) {
      allowed.total++;
      allowed.byCategory[m.category] = (allowed.byCategory[m.category] || 0) + 1;
      for (const e of allowEntries) e.used = true;
    } else {
      effective.total++;
      effective.byCategory[m.category] = (effective.byCategory[m.category] || 0) + 1;
      const line = lineIndexForOffset(text, m.start) + 1;
      if (!effective.byLine[line]) effective.byLine[line] = {};
      effective.byLine[line][m.category] = (effective.byLine[line][m.category] || 0) + 1;
    }
  }
  return { effective, allowed };
}

function classifyBuffer(buf, matcher, termIndex) {
  const effective = { total: 0, byCategory: {} };
  const allowed = { total: 0, byCategory: {} };
  for (const text of decodeVariants(buf)) {
    const r = classifyText(text, matcher, termIndex);
    effective.total += r.effective.total;
    allowed.total += r.allowed.total;
    for (const [c, n] of Object.entries(r.effective.byCategory)) effective.byCategory[c] = (effective.byCategory[c] || 0) + n;
    for (const [c, n] of Object.entries(r.allowed.byCategory)) allowed.byCategory[c] = (allowed.byCategory[c] || 0) + n;
  }
  return { effective, allowed };
}

function mergeCounts(a, b) {
  const total = a.total + b.total;
  const byCategory = { ...a.byCategory };
  for (const [c, n] of Object.entries(b.byCategory)) byCategory[c] = (byCategory[c] || 0) + n;
  return { total, byCategory };
}

function mergeByLine(a, b) {
  const out = {};
  for (const [line, cats] of Object.entries(a)) out[line] = { ...cats };
  for (const [line, cats] of Object.entries(b)) {
    out[line] = out[line] || {};
    for (const [c, n] of Object.entries(cats)) out[line][c] = (out[line][c] || 0) + n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git plumbing (read-only subset only: ls-files, ls-tree, cat-file,
// rev-list, diff-tree, rev-parse -- SD-10)
// ---------------------------------------------------------------------------

function git(args, { cwd, env, input } = {}) {
  return spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    env,
    input,
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function resolveTopLevel(cwd, env) {
  const res = git(['rev-parse', '--show-toplevel'], { cwd, env });
  if (res.status !== 0) throw new ScanError('not-a-repo');
  return res.stdout.toString('utf8').trim();
}

// ---------------------------------------------------------------------------
// Target collection per mode
// ---------------------------------------------------------------------------

function collectTreeWorktree(cwd, env, pathspec) {
  const topLevel = resolveTopLevel(cwd, env);
  const args = ['ls-files', '-z', '--full-name', '--cached', '--others', '--exclude-standard'];
  if (pathspec.length) args.push('--', ...pathspec);
  const res = git(args, { cwd: topLevel, env });
  if (res.status !== 0) throw new ScanError('not-a-repo');
  const relPaths = res.stdout.toString('utf8').split('\0').filter(Boolean).sort();
  const targets = [];
  for (const relPath of relPaths) {
    const full = path.join(topLevel, relPath);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      targets.push({ label: relPath, pathText: relPath, buf: null, missing: true, symlink: false });
      continue;
    }
    if (stat.isSymbolicLink()) {
      const linkText = fs.readlinkSync(full);
      targets.push({ label: relPath, pathText: relPath, buf: Buffer.from(linkText, 'utf8'), missing: false, symlink: true });
    } else {
      try {
        const buf = fs.readFileSync(full);
        targets.push({ label: relPath, pathText: relPath, buf, missing: false, symlink: false });
      } catch {
        targets.push({ label: relPath, pathText: relPath, buf: null, missing: true, symlink: false });
      }
    }
  }
  return targets;
}

function collectTreeRev(cwd, env, rev, pathspec) {
  const args = ['ls-tree', '-r', '-z', '--full-tree', rev];
  if (pathspec.length) args.push('--', ...pathspec);
  const res = git(args, { cwd, env });
  if (res.status !== 0) throw new ScanError('bad-rev');
  const records = res.stdout.toString('utf8').split('\0').filter(Boolean);
  const targets = [];
  for (const record of records) {
    const tabIdx = record.indexOf('\t');
    const meta = record.slice(0, tabIdx);
    const relPath = record.slice(tabIdx + 1);
    const parts = meta.split(' ');
    const type = parts[1];
    const sha = parts[2];
    if (type !== 'blob') continue;
    targets.push({ label: relPath, pathText: relPath, sha, missing: false, symlink: false });
  }
  targets.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  for (const t of targets) {
    const blobRes = git(['cat-file', 'blob', t.sha], { cwd, env });
    t.buf = blobRes.status === 0 ? blobRes.stdout : null;
    if (blobRes.status !== 0) t.missing = true;
  }
  return targets;
}

function firstParentAndBody(commitBuf) {
  const text = commitBuf.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const parents = [];
  for (const m of header.matchAll(/^parent (\S+)$/gm)) parents.push(m[1]);
  return parents.length ? parents[0] : EMPTY_TREE_SHA;
}

function collectCommits(cwd, env, revListArgs) {
  const revRes = git(['rev-list', ...revListArgs], { cwd, env });
  if (revRes.status !== 0) throw new ScanError('bad-rev');
  const shas = revRes.stdout.toString('utf8').split('\n').filter(Boolean);
  const targets = [];
  for (const sha of shas) {
    const sha12 = sha.slice(0, 12);
    const objRes = git(['cat-file', 'commit', sha], { cwd, env });
    if (objRes.status !== 0) throw new ScanError('bad-rev');
    const objBuf = objRes.stdout;
    targets.push({ label: `${sha12}:message`, pathText: null, buf: objBuf, missing: false, symlink: false });

    const parentTree = firstParentAndBody(objBuf);
    const rawRes = git(
      ['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-abbrev', parentTree, sha],
      { cwd, env },
    );
    const records = rawRes.stdout.toString('utf8').split('\0').filter(Boolean);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec.startsWith(':')) continue;
      const fields = rec.slice(1).trim().split(/\s+/);
      const newSha = fields[3];
      const status = fields[4] ? fields[4][0] : '';
      const relPath = records[i + 1];
      i++;
      if (status !== 'A' && status !== 'M' && status !== 'T') continue;
      const blobRes = git(['cat-file', 'blob', newSha], { cwd, env });
      const blobBuf = blobRes.status === 0 ? blobRes.stdout : Buffer.alloc(0);
      let contentBuf;
      if (blobBuf.includes(0)) {
        contentBuf = blobBuf;
      } else {
        const patchRes = git(
          ['diff-tree', '-p', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', parentTree, sha, '--', relPath],
          { cwd, env },
        );
        const patchText = patchRes.stdout.toString('utf8');
        const addedLines = patchText
          .split('\n')
          .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
          .map((l) => l.slice(1));
        contentBuf = Buffer.from(addedLines.join('\n'), 'utf8');
      }
      targets.push({ label: `${sha12}:${relPath}`, pathText: relPath, buf: contentBuf, missing: false, symlink: false });
    }
  }
  return { commitCount: shas.length, targets };
}

function walkDirSorted(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkDirSorted(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function collectFiles(paths) {
  const targets = [];
  for (const argPath of paths) {
    let stat;
    try {
      stat = fs.lstatSync(argPath);
    } catch {
      throw new ScanError('missing-path');
    }
    const base = path.basename(argPath);
    if (stat.isDirectory()) {
      for (const full of walkDirSorted(argPath)) {
        const rel = path.relative(argPath, full).split(path.sep).join('/');
        const label = `${base}/${rel}`;
        const leafStat = fs.lstatSync(full);
        if (leafStat.isSymbolicLink()) {
          const linkText = fs.readlinkSync(full);
          targets.push({ label, pathText: label, buf: Buffer.from(linkText, 'utf8'), missing: false, symlink: true });
        } else {
          try {
            targets.push({ label, pathText: label, buf: fs.readFileSync(full), missing: false, symlink: false });
          } catch {
            targets.push({ label, pathText: label, buf: null, missing: true, symlink: false });
          }
        }
      }
    } else if (stat.isSymbolicLink()) {
      const linkText = fs.readlinkSync(argPath);
      targets.push({ label: base, pathText: base, buf: Buffer.from(linkText, 'utf8'), missing: false, symlink: true });
    } else {
      try {
        targets.push({ label: base, pathText: base, buf: fs.readFileSync(argPath), missing: false, symlink: false });
      } catch {
        targets.push({ label: base, pathText: base, buf: null, missing: true, symlink: false });
      }
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const HELP_TEXT = [
  'usage: denylist-scan.js [options] tree [<rev>] [-- <pathspec>...]',
  '       denylist-scan.js [options] commits <rev-list-arg>...',
  '       denylist-scan.js [options] files <path>...',
  '',
  'options:',
  '  --terms <file>     repeatable; falls back to SCRIPTORIUM_DENYLIST_TERMS',
  '  --patterns <file>  repeatable; falls back to SCRIPTORIUM_DENYLIST_PATTERNS',
  '  --allow <file>     repeatable; falls back to SCRIPTORIUM_DENYLIST_ALLOW',
  '  --match word|substring   (default word)',
  '  --lines            tree/files only; a usage error with commits',
  '  -h, --help',
].join('\n');

function parseArgv(argv) {
  const options = { terms: [], patterns: [], allow: [], match: 'word', lines: false, noPathAllow: false, help: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      options.help = true;
      i++;
      continue;
    }
    if (a === '--terms' || a === '--patterns' || a === '--allow') {
      if (i + 1 >= argv.length) throw new ScanError('usage');
      options[a.slice(2)].push(argv[i + 1]);
      i += 2;
      continue;
    }
    if (a === '--match') {
      if (i + 1 >= argv.length) throw new ScanError('usage');
      options.match = argv[i + 1];
      i += 2;
      continue;
    }
    if (a === '--lines') {
      options.lines = true;
      i++;
      continue;
    }
    if (a === '--no-path-allow') {
      options.noPathAllow = true;
      i++;
      continue;
    }
    break;
  }
  const mode = argv[i];
  const rest = argv.slice(i + 1);
  return { options, mode, rest };
}

function resolveListFiles(flagValues, envValue) {
  if (flagValues.length > 0) return flagValues;
  if (envValue) return [envValue];
  return [];
}

function readListFile(listKind, filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new ScanError('list-unreadable', { list: listKind });
  }
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

function run(argv, { cwd, env, stdout, stderr }) {
  let matcher = null; // built early so the masker is available even on a later error.
  const emit = (stream, line) => {
    const masked = matcher ? maskLine(line, matcher) : line;
    stream.write(masked + '\n');
  };
  function maskLine(line, m) {
    return maskLabel(line, m);
  }

  try {
    const { options, mode, rest } = parseArgv(argv);
    if (options.help) {
      stdout.write(HELP_TEXT + '\n');
      return 0;
    }
    if (mode !== 'tree' && mode !== 'commits' && mode !== 'files') throw new ScanError('usage');
    if (options.match !== 'word' && options.match !== 'substring') throw new ScanError('usage');
    if (options.lines && mode === 'commits') throw new ScanError('usage');

    const termsFiles = resolveListFiles(options.terms, env.SCRIPTORIUM_DENYLIST_TERMS);
    const patternsFiles = resolveListFiles(options.patterns, env.SCRIPTORIUM_DENYLIST_PATTERNS);
    const allowFiles = resolveListFiles(options.allow, env.SCRIPTORIUM_DENYLIST_ALLOW);

    if (termsFiles.length === 0 && patternsFiles.length === 0) throw new ScanError('no-lists');

    const topLevelForGuard = mode === 'files' ? null : resolveTopLevel(cwd, env);

    function guardOutsideRepo(listKind, filePath) {
      if (topLevelForGuard === null) return; // files mode has no work-tree boundary to guard against.
      let resolved;
      try {
        resolved = fs.realpathSync(filePath);
      } catch {
        throw new ScanError('list-unreadable', { list: listKind });
      }
      if (isInside(resolved, topLevelForGuard)) throw new ScanError('list-in-repo', { list: listKind });
    }

    let termEntries = [];
    let termEntryCount = 0;
    for (const f of termsFiles) {
      guardOutsideRepo('terms', f);
      const text = readListFile('terms', f);
      const { entries, errors } = parseTermList(text);
      if (errors.length) throw new ScanError(errors[0].code, { list: 'terms', line: errors[0].line });
      termEntries = termEntries.concat(entries);
      termEntryCount += entries.length;
    }

    let patternEntries = [];
    let patternEntryCount = 0;
    for (const f of patternsFiles) {
      guardOutsideRepo('patterns', f);
      const text = readListFile('patterns', f);
      const { entries, errors } = parsePatternList(text);
      if (errors.length) throw new ScanError(errors[0].code, { list: 'patterns', line: errors[0].line });
      patternEntries = patternEntries.concat(entries);
      patternEntryCount += entries.length;
    }

    let allows = [];
    let allowEntryCount = 0;
    for (const f of allowFiles) {
      guardOutsideRepo('allow', f);
      const text = readListFile('allow', f);
      const { allows: parsed, errors } = parseAllowList(text);
      if (errors.length) throw new ScanError(errors[0].code, { list: 'allow', line: errors[0].line });
      allows = allows.concat(parsed);
      allowEntryCount += parsed.length;
    }

    const allEntries = termEntries.concat(patternEntries);
    if (allEntries.length === 0) throw new ScanError('no-entries');

    matcher = buildMatcher(allEntries, { match: options.match });
    const { termIndex, pathIndex: builtPathIndex } = buildAllowIndex(allows);
    // `--no-path-allow` (the guard's `files` mode): path entries stay loaded, and so are
    // reported UNUSED, but suppress nothing.
    const pathIndex = options.noPathAllow ? new Map() : builtPathIndex;

    let modeLine;
    let targets;
    let commitCount = null;

    if (mode === 'tree') {
      const dashIdx = rest.indexOf('--');
      const rev = dashIdx === -1 ? rest[0] : rest[0] === '--' ? undefined : rest[0];
      let revArg;
      let pathspec;
      if (dashIdx === -1) {
        revArg = rest[0];
        pathspec = [];
      } else {
        revArg = dashIdx === 0 ? undefined : rest[0];
        pathspec = rest.slice(dashIdx + 1);
      }
      if (revArg === undefined) {
        targets = collectTreeWorktree(cwd, env, pathspec);
        modeLine = 'MODE tree WORKTREE';
      } else {
        targets = collectTreeRev(cwd, env, revArg, pathspec);
        modeLine = `MODE tree ${revArg}`;
      }
      if (targets.length === 0) throw new ScanError('no-targets');
    } else if (mode === 'commits') {
      if (rest.length === 0) throw new ScanError('usage');
      const result = collectCommits(cwd, env, rest);
      targets = result.targets;
      commitCount = result.commitCount;
      modeLine = `MODE commits ${rest.length} targets`;
    } else {
      if (rest.length === 0) throw new ScanError('usage');
      targets = collectFiles(rest);
      modeLine = `MODE files ${rest.length} targets`;
      if (targets.length === 0) throw new ScanError('no-targets');
    }

    let hits = 0;
    let allowedTotal = 0;
    let missing = 0;
    let symlinks = 0;
    const rows = []; // { label, kind: 'HIT'|'ALLOWED', count, byCategory }
    const lineRows = []; // { label, line, byCategory }

    for (const target of targets) {
      if (target.missing) missing++;
      if (target.symlink) symlinks++;

      const pathAllowed = target.pathText !== null && pathIndex.has(target.pathText);
      if (pathAllowed && !target.missing) {
        for (const e of pathIndex.get(target.pathText)) e.used = true;
      }

      let effective = { total: 0, byCategory: {} };
      let allowed = { total: 0, byCategory: {} };
      let effectiveByLine = {}; // path-arm hits have no line (SD-5's path haystack isn't "content"); only the content arm contributes here.

      if (target.pathText !== null) {
        const pathHaystack = normaliseEmitted(target.pathText);
        const r = classifyText(pathHaystack, matcher, termIndex);
        effective = mergeCounts(effective, r.effective);
        allowed = mergeCounts(allowed, r.allowed);
      }

      if (target.buf) {
        const isBinary = target.buf.includes(0);
        if (isBinary) {
          const r = classifyBuffer(target.buf, matcher, termIndex);
          effective = mergeCounts(effective, r.effective);
          allowed = mergeCounts(allowed, r.allowed);
        } else {
          const contentHaystack = normaliseEmitted(target.buf.toString('utf8'));
          const r = classifyText(contentHaystack, matcher, termIndex);
          effective = mergeCounts(effective, r.effective);
          effectiveByLine = mergeByLine(effectiveByLine, r.effective.byLine);
          allowed = mergeCounts(allowed, r.allowed);
        }
      }

      const rawTotalForTarget = effective.total + allowed.total;

      if (pathAllowed) {
        if (rawTotalForTarget > 0) {
          rows.push({ label: target.label, kind: 'ALLOWED', count: rawTotalForTarget });
          allowedTotal += rawTotalForTarget;
        }
        continue;
      }

      if (effective.total > 0) {
        rows.push({ label: target.label, kind: 'HIT', count: effective.total, byCategory: effective.byCategory });
        hits += effective.total;
        for (const [lineNo, cats] of Object.entries(effectiveByLine)) {
          lineRows.push({ label: target.label, line: Number(lineNo), byCategory: cats });
        }
      }
      if (allowed.total > 0) {
        rows.push({ label: target.label, kind: 'ALLOWED', count: allowed.total });
        allowedTotal += allowed.total;
      }
    }

    const unusedAllow = allows.filter((a) => !a.used).sort((a, b) => a.line - b.line);

    emit(stdout, modeLine);
    emit(stdout, `ENTRIES terms=${termEntryCount} patterns=${patternEntryCount} allow=${allowEntryCount}`);
    if (commitCount !== null) emit(stdout, `COMMITS ${commitCount}`);

    const sortedRows = rows
      .filter((r) => r.kind === 'HIT')
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    for (const r of sortedRows) {
      const catStr = Object.keys(r.byCategory)
        .sort()
        .map((c) => `${c}=${r.byCategory[c]}`)
        .join(',');
      emit(stdout, `HIT ${r.count} ${r.label} ${catStr}`);
    }

    if (options.lines) {
      const sortedLineRows = lineRows
        .slice()
        .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.line - b.line));
      for (const r of sortedLineRows) {
        const catStr = Object.keys(r.byCategory)
          .sort()
          .map((c) => `${c}=${r.byCategory[c]}`)
          .join(',');
        emit(stdout, `LINE ${Object.values(r.byCategory).reduce((a, b) => a + b, 0)} ${r.label}:${r.line} ${catStr}`);
      }
    }

    const sortedAllowed = rows
      .filter((r) => r.kind === 'ALLOWED')
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    for (const r of sortedAllowed) {
      emit(stdout, `ALLOWED ${r.count} ${r.label}`);
    }

    for (const a of unusedAllow) {
      emit(stdout, `UNUSED allow:${a.line}`);
    }

    emit(
      stdout,
      `TOTAL hits=${hits} targets=${targets.length} scanned=${targets.length - missing} allowed=${allowedTotal} missing=${missing} symlinks=${symlinks} unused-allow=${unusedAllow.length}`,
    );

    return hits > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof ScanError) {
      let line = `ERROR ${err.code}`;
      if (err.list) line += ` list=${err.list}`;
      if (err.line !== undefined && err.line !== null) line += ` line=${err.line}`;
      emit(stderr, line);
      return 2;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

module.exports = {
  CATEGORIES,
  parseTermList,
  parsePatternList,
  parseAllowList,
  buildMatcher,
  countHits,
  countInBuffer,
  maskLabel,
  isInside,
  run,
};
