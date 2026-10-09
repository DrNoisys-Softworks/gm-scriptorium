'use strict';

/*
 * The public-sweep privacy gate's ONE canonical scanner invocation (Amendment S,
 * docs/agent-runs/s4-engineering-brief-2026-09-30.md, "Amendment S (2026-10-01): canonical
 * scanner invocation"). This file is commit 1 of slice S4 (brief section "S.7", the early
 * landing): it fixes the root cause named in S.1 -- `scripts/denylist-scan.js` (frozen,
 * never edited here) takes each list from an explicit flag or an env var, and refuses only
 * when BOTH terms and patterns are missing, so a terms-only caller silently scans without the
 * patterns list and loses the identity residual entirely (`name`/`email` categories exist only
 * in the patterns list). Every caller used to choose its own lists by hand; this module is the
 * one place that choice is made from now on.
 *
 * SD-S1: the policy layer. This file owns which lists are loaded and which residuals are
 * accepted; `denylist-scan.js` stays list-agnostic and untouched (SD-S1's rejected
 * alternatives: defaults baked into the frozen scanner, a `--profile` flag, a second wrapper
 * script, or environment variables as the list source -- that last one is the failing
 * mechanism this file replaces).
 *
 * SD-S2: one list source. `git config --type=path --get scriptorium.privacyLists` names an
 * absolute directory OUTSIDE the repository; the three list files inside it always have the
 * same fixed names (LIST_FILE_NAMES, below). They are read in place -- never copied, printed,
 * moved or committed. Any `SCRIPTORIUM_DENYLIST_*` env vars are stripped from the scanner's own
 * environment before it runs, and counted on a `NOTE ignored-env=<n>` line so a caller who
 * still has one set from the old convention is told, not silently honoured. `--terms`,
 * `--patterns` and `--allow` passed to `scan` are a usage error -- there is no second way in.
 *
 * SD-S3: fail closed, before any scanning starts. Every failure prints `ERROR <code>[
 * kind=terms|patterns|allow]` to stderr and NEVER a path, a list value, or commit-header text
 * (SD-S3's own table of codes is reproduced at GuardError's call sites below; AC-S04 /
 * test/public-guard.test.js's sentinel test T-S11 is the proof this holds).
 *
 * SD-S4: the named residual classes, counted by the tool rather than left for a human to
 * notice. `identity` -- a commit's `<sha12>:message` HIT row is in this class only when its
 * categories are entirely `name`/`email` AND an independent re-scan of just the `author `/
 * `committer ` header lines (same matcher, `countHits`, per isIdentityOnly below) accounts for
 * the WHOLE row -- a name hit anywhere else (e.g. the message body, T-S7) breaks the shape.
 * This residual is only ever ACCEPTED (excluded from UNCLASSED) when the repository's history
 * does not contain PUBLIC_ROOT (`history=private`); in a history that does contain it
 * (`history=public`) the same rows stay in UNCLASSED and block (T-S8). `font-binary` (Amendment
 * F, option (b), the owner's current default) is a second, independent residual class: see
 * NAMED_FONT_RESIDUAL below.
 *
 * SD-S5/SD-S6: `scan`'s own output trailer (LISTS/NOTE/RESIDUAL/UNCLASSED/VERDICT) and the one
 * code path shared by `check-allow`, `pre-push`'s private-list trigger, and `scan` itself.
 * `scan` does NOT run SD-4's root/forbidden-path checks (SD-4's own `pre-push`/`ci`/`release`
 * modes, the hook shim and the public hygiene pass are S4 proper's job, out of this commit's
 * scope per the Engineering Brief); `scan` only uses PUBLIC_ROOT to decide `history`.
 *
 * Deliberately NOT in this commit (S4 proper's job, per the Engineering Brief's scope for
 * "commit 1"): SD-4's full guard (forbidden-path checks, the public-hygiene Run B, the standing
 * allowlist's `path`/`forbiddenPathCount` exports, the hook shim, and `pre-push`'s own
 * commit-range scan once lists ARE configured -- only the "no private lists are set" branch of
 * `pre-push` exists here, because that is the one branch Run A's shared-loader trigger
 * (SD-S6) needs and T-S12 tests). `release`/`ci` modes are not implemented at all yet.
 *
 * Amendment F, option (b) ("a named, counted residual in the guard") is the owner's default
 * while F(a)/F(b) is still an open choice; it is kept deliberately self-contained to a single
 * table constant (NAMED_FONT_RESIDUAL) and a single classifier function (classifyFontBinary),
 * so switching to option (a) later is a two-piece removal, not a rewrite.
 *
 * A second, independent pinned-residual class, `image-binary`, for the repository's own
 * pictures (README and social images, sample art). It reuses classifyFontBinary's exact shape (one
 * table, one classifier: NAMED_IMAGE_RESIDUAL / classifyImageBinary), plus a root-segment gate
 * (IMAGE_RESIDUAL_ROOTS, compared by path segment, never a string prefix) and a PNG/JPEG
 * signature check, since a pinned path+sha alone doesn't prove the blob is actually a picture.
 * The table is exported and holds one row per committed picture.
 *
 * Amendment V, V.1 (slice S4-1, docs/agent-runs/s4-engineering-brief-2026-09-30.md), SD-V1:
 * `classifyFontBinary` and `classifyImageBinary` were two copies of the same exact-path/
 * exact-sha/blob-read gate. That gate now lives once, in the internal helper
 * `classifyPinnedBlobs`, parameterised by a `tableAt(blobRev, rowPath)` lookup and an
 * `accept(bytes)` predicate; both classifiers below call it, unchanged in behaviour (AC-V03).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const denylistScan = require('./denylist-scan');
const { canonicalNfc } = require('../src/generator/pinned');
const { parseSha256Sums } = require('./generator-pin');

const { parseTermList, parsePatternList, parseAllowList, buildMatcher, countHits, isInside } = denylistScan;

// The public repository's root commit (Amendment R.3; confirmed 2026-10-01 against
// `git ls-remote https://github.com/DrNoisys-Softworks/gm-scriptorium.git`, full 40-hex sha).
const PUBLIC_ROOT = '21611413e7d74eef6bff81ced391433ab710a159';

// SD-4's pre-push contract (`.git/hooks/pre-push.sample:1-3`): a zero object id, in either
// stdin position, means a delete (local) or a brand-new ref (remote) -- never a real commit.
const ZERO_OID = '0'.repeat(40);

// SD-S2: fixed file names inside the directory `scriptorium.privacyLists` names. Never
// overridable by a flag or an env var -- the whole point of this file is that there is exactly
// one way to name these three files.
const LIST_FILE_NAMES = Object.freeze({
  terms: 'nfr11-terms.txt',
  patterns: 'nfr11-owner-env.txt',
  allow: 'nfr11-allow.txt',
});

/*
 * Amendment F, option (b). Measured at PARENT (847a82b) with the real private lists, against
 * every file under assets/**\/fonts/ (13 files total), in both word and substring match modes
 * ($G/font-measure.tsv -- paths and counts only). These 10 are exactly the files that produced a
 * HIT in EITHER mode (three never hit in either mode: assets/admin/fonts/AlegreyaSans-Bold.ttf,
 * IMFeENrm28P.ttf and IMFeENsc28P.ttf -- they are not listed here, since they would never reach
 * UNCLASSED in the first place and would just be an unused table row). Every sha256 is
 * independently cross-checked against scripts/vendor/fonts/gloam-FONTS.json and FONTS.json by
 * test/public-guard.test.js's T-F5 (two independent sources must agree).
 */
const NAMED_FONT_RESIDUAL = Object.freeze([
  Object.freeze({ path: 'assets/admin/fonts/AlegreyaSans-Italic.ttf', sha256: 'f49f6f2bdd84df850b25b0f8185d8a051e1d1eb2dd08e2f91b8c7b86d9a9e1a6' }),
  Object.freeze({ path: 'assets/admin/fonts/AlegreyaSans-Medium.ttf', sha256: '4b89fe7804fd1485ec2757795a53ffdb66e1206dd56f844c2d72b3c944815b43' }),
  Object.freeze({ path: 'assets/admin/fonts/AlegreyaSans-Regular.ttf', sha256: '8fab634196007afca839f1e5a6fb300976daff55d8528b590ef032f01b14ea10' }),
  Object.freeze({ path: 'assets/admin/fonts/IBMPlexMono-Regular.woff2', sha256: 'ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350' }),
  Object.freeze({ path: 'assets/admin/fonts/IBMPlexMono-SemiBold.woff2', sha256: '6a825b4824c01cbb401e829e5a066a1818411bcb3538b5a5792c5ca9b82343c3' }),
  Object.freeze({ path: 'assets/themes/gloam/fonts/CormorantGaramond-Italic-wght.woff2', sha256: '115c1ccec1e93f3fc3e8553a0fda713c6c054fad826a7d08da7d7526a82fa72d' }),
  Object.freeze({ path: 'assets/themes/gloam/fonts/CormorantGaramond-wght.woff2', sha256: 'cf41b906ec483c10451416db623a5d32f26dfd781a388241fb5cadc9a8e56419' }),
  Object.freeze({ path: 'assets/themes/gloam/fonts/IMFeENit28P.woff2', sha256: '25595dfb8a14b6486013c02157750c490c2b6e996c39e0b3144f00949889e7ab' }),
  Object.freeze({ path: 'assets/themes/gloam/fonts/IMFeENrm28P.woff2', sha256: 'bc324725e1dead508a492ffd50ef51d8b4a0d4d58016da008bd9ec81ef8458d3' }),
  Object.freeze({ path: 'assets/themes/gloam/fonts/IMFeENsc28P.woff2', sha256: '2e31919e93cb72dc957d9da8a1e4788569490f3cfb7abd52f53ca933792937a3' }),
]);

/*
 * A second pinned-residual class, `image-binary`, for the repository's own pictures. It reuses
 * `classifyFontBinary`'s exact machinery (one table, one classifier). Unlike NAMED_FONT_RESIDUAL
 * this table is exported. It holds the two README and social preview images under docs/images
 * (the Lantern branding art); the sample campaign's painted pictures will add their own rows
 * when they exist.
 */
const NAMED_IMAGE_RESIDUAL = Object.freeze([
  Object.freeze({ path: 'docs/images/banner.png', sha256: '35a1e1acf30bdc0565cce1722bbcb10c1868d2528bdeeaf5b06e09ae75045275' }),
  Object.freeze({ path: 'docs/images/social-preview.png', sha256: 'ba43761f8e5ca0d0f4478f4e80036c60839adef98e3b2a81f02d0140f224c515' }),
]);

// Compared by path SEGMENT, never by string prefix (the sibling-directory bug this guards
// against: "examplesX/" is not under "examples/" even though it shares the string prefix --
// T-I3's examplesX/ case, mutation Ib3).
const IMAGE_RESIDUAL_ROOTS = Object.freeze(['examples', 'docs/images']);

// Amendment V, V.1 (SD-V2): the vendored generator release tarball's directory. Unlike
// NAMED_FONT_RESIDUAL/NAMED_IMAGE_RESIDUAL there is no literal path-to-sha256 table here: the
// table is derived fresh, at the row's own revision, by deriveVendorEntry below. A repin needs
// no edit in this file.
const VENDOR_PIN_DIR = 'vendor/gm-apprentice-publish';
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function hasGzipMagic(buf) {
  return buf.length >= GZIP_MAGIC.length && buf.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

class GuardError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.kind = extra.kind;
    this.counts = extra.counts;
    this.lines = extra.lines;
    this.index = extra.index;
  }
}

function canonFold(value) {
  return canonicalNfc(String(value)).toLowerCase();
}

function git(args, cwd, env) {
  return spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, env, maxBuffer: 1024 * 1024 * 1024 });
}

function gitConfigPath(cwd, env, key) {
  const res = git(['config', '--type=path', '--get', key], cwd, env);
  if (res.status !== 0) return null;
  return res.stdout.toString('utf8').trim();
}

function gitConfigBool(cwd, env, key) {
  const res = git(['config', '--type=bool', '--get', key], cwd, env);
  if (res.status !== 0) return false;
  return res.stdout.toString('utf8').trim() === 'true';
}

function gitTopLevel(cwd, env) {
  const res = git(['rev-parse', '--show-toplevel'], cwd, env);
  if (res.status !== 0) throw new Error('not-a-repo');
  return res.stdout.toString('utf8').trim();
}

function isShallowFalse(cwd, env) {
  const res = git(['rev-parse', '--is-shallow-repository'], cwd, env);
  if (res.status !== 0) return false; // fail closed: an unreadable repo is treated as shallow.
  return res.stdout.toString('utf8').trim() === 'false';
}

function computeHistory(cwd, env, publicRoot) {
  const res = git(['cat-file', '-e', `${publicRoot}^{commit}`], cwd, env);
  return res.status === 0 ? 'public' : 'private';
}

/**
 * SD-4 check (b): `<rev>`'s root set, compared as full 40-hex strings against `{publicRoot}`
 * EXACTLY -- a `Set`, never a joined string (G3's red line: `roots.join(' ').startsWith(...)`
 * would wrongly pass a two-root repo whose first root happens to share `publicRoot`'s prefix, or
 * any extra root appended after it). `rev-list --max-parents=0` lists every parentless commit
 * reachable from `<rev>`, so a history with a second, unrelated root (a bad merge, a grafted
 * history) is refused even though `publicRoot` IS among the roots.
 */
function checkRootSet(cwd, env, rev, publicRoot) {
  const res = git(['rev-list', '--max-parents=0', rev], cwd, env);
  if (res.status !== 0) throw new GuardError('bad-rev');
  const roots = res.stdout.toString('utf8').split('\n').filter(Boolean);
  const rootSet = new Set(roots);
  return rootSet.size === 1 && rootSet.has(publicRoot);
}

/**
 * SD-4 check (c): a path is forbidden when its first two path SEGMENTS are exactly `docs` and
 * `agent-runs` (never a string prefix -- G4's red line: `startsWith('docs/agent-runs')` would
 * wrongly flag a sibling directory like `docs/agent-runsX/a.md`, which shares the string prefix
 * but is a different directory), or when its last segment is exactly `CLAUDE.local.md` (catches
 * the file at any depth, e.g. a worktree-local copy under `x/CLAUDE.local.md`).
 */
function isForbiddenPath(p) {
  const segments = String(p).split('/');
  if (segments[0] === 'docs' && segments[1] === 'agent-runs') return true;
  if (segments[segments.length - 1] === 'CLAUDE.local.md') return true;
  return false;
}

/** SD-4's own exported helper: a pure count over an already-listed path array, so `run()` never
 * has to print (or even hold onto) the forbidden paths themselves -- G10's red line. */
function forbiddenPathCount(paths) {
  return paths.filter(isForbiddenPath).length;
}

function listTreePaths(cwd, env, rev) {
  const res = git(['ls-tree', '-r', '--name-only', rev], cwd, env);
  if (res.status !== 0) throw new GuardError('bad-rev');
  return res.stdout.toString('utf8').split('\n').filter(Boolean);
}

/**
 * The pre-push hook contract (`.git/hooks/pre-push.sample:3-51`): one line per pushed ref,
 * `<local ref> SP <local oid> SP <remote ref> SP <remote oid>`. Exported so a Reviewer or test can
 * exercise it directly against a planted stdin string without going through `run()`.
 *
 * @param {string} text
 * @returns {{localRef:string, localOid:string, remoteRef:string, remoteOid:string}[]}
 */
function parsePushLines(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length !== 4) throw new GuardError('bad-stdin');
      const [localRef, localOid, remoteRef, remoteOid] = parts;
      return { localRef, localOid, remoteRef, remoteOid };
    });
}

function computeFingerprint(filePaths) {
  const digests = filePaths.map((p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
  const combined = crypto.createHash('sha256').update(digests.join('')).digest('hex');
  return combined.slice(0, 12);
}

/**
 * True only for an exact repo-relative FILE path: no empty target, no absolute path or drive
 * letter, no backslash, no glob character, no control character, no empty/`.`/`..` segment, and
 * no trailing slash (a directory). Whether the file exists in what is being scanned is not
 * knowable here; the scanner reports a path entry that matched nothing as UNUSED.
 */
function isExactRepoFilePath(target) {
  if (typeof target !== 'string' || target === '') return false;
  if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) return false;
  if (target.includes('\\') || /[*?[\]{}]/.test(target)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(target)) return false;
  return target.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * SD-S7's own standing-allowlist validation (SD-7 of the original S4 brief, pulled forward here
 * because SD-S3's `bad-allow` code depends on it existing even in this early-landing commit):
 * a `term` entry's literal must equal a literal already present in the terms list or a
 * `literal`-kind entry of the patterns list, compared after NFC + lowercasing (`not-in-list`
 * otherwise). A `path` entry (ADR 0031, closing amendment) must be an exact repo-relative file
 * path (`bad-path` otherwise); the reason is already required by the parser. Re-parses
 * `allowText` itself (syntax errors are the caller's `bad-list` concern, checked separately,
 * before this function is ever reached) so this stays a pure, independently callable function
 * per the S.3 interface.
 */
function validateStandingAllow(allowText, termTexts) {
  const { allows } = parseAllowList(allowText);
  const termSet = new Set(termTexts.map((t) => canonFold(t)));
  const errors = [];
  for (const a of allows) {
    if (a.kind === 'path') {
      if (!isExactRepoFilePath(a.target)) errors.push({ line: a.line, code: 'bad-path' });
      continue;
    }
    if (!termSet.has(canonFold(a.target))) {
      errors.push({ line: a.line, code: 'not-in-list' });
    }
  }
  return errors;
}

/**
 * SD-S2/SD-S3: resolves `scriptorium.privacyLists`, reads the three fixed-name files in place,
 * parses and validates them, and fails closed (GuardError, `.code`/`.kind`) on the first
 * problem found, as sequenced in the SD-S3 table.
 *
 * @returns {{ paths: {terms:string,patterns:string,allow:string}, counts: {terms:number,patterns:number,allow:number}, fingerprint: string, entries: {terms:object[],patterns:object[],allows:object[]} }}
 */
function loadPrivacyLists({ cwd, env }) {
  const baseDir = gitConfigPath(cwd, env, 'scriptorium.privacyLists');
  if (!baseDir || !path.isAbsolute(baseDir)) throw new GuardError('no-lists');

  const filePaths = {};
  for (const kind of Object.keys(LIST_FILE_NAMES)) {
    const candidate = path.join(baseDir, LIST_FILE_NAMES[kind]);
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      throw new GuardError('list-missing', { kind });
    }
    if (!stat.isFile()) throw new GuardError('list-missing', { kind });
    filePaths[kind] = candidate;
  }

  const topLevel = gitTopLevel(cwd, env);
  for (const kind of Object.keys(filePaths)) {
    let resolved;
    try {
      resolved = fs.realpathSync(filePaths[kind]);
    } catch {
      throw new GuardError('list-missing', { kind });
    }
    if (isInside(resolved, topLevel)) throw new GuardError('list-in-repo', { kind });
  }

  const termsText = fs.readFileSync(filePaths.terms, 'utf8');
  const patternsText = fs.readFileSync(filePaths.patterns, 'utf8');
  const allowText = fs.readFileSync(filePaths.allow, 'utf8');

  const termsParsed = parseTermList(termsText);
  if (termsParsed.errors.length) throw new GuardError('bad-list', { kind: 'terms' });
  const patternsParsed = parsePatternList(patternsText);
  if (patternsParsed.errors.length) throw new GuardError('bad-list', { kind: 'patterns' });
  const allowParsed = parseAllowList(allowText);
  if (allowParsed.errors.length) throw new GuardError('bad-list', { kind: 'allow' });

  if (termsParsed.entries.length === 0 || patternsParsed.entries.length === 0) {
    throw new GuardError('list-empty');
  }

  const hasName = patternsParsed.entries.some((e) => e.category === 'name');
  const hasEmail = patternsParsed.entries.some((e) => e.category === 'email');
  if (!hasName || !hasEmail) throw new GuardError('identity-patterns-missing');

  const termTexts = termsParsed.entries
    .map((e) => e.value)
    .concat(patternsParsed.entries.filter((e) => e.kind === 'literal').map((e) => e.value));
  const allowErrors = validateStandingAllow(allowText, termTexts);
  if (allowErrors.length) {
    const badPath = allowErrors.filter((e) => e.code === 'bad-path').length;
    const notInList = allowErrors.filter((e) => e.code === 'not-in-list').length;
    throw new GuardError('bad-allow', { counts: { badPath, notInList }, lines: allowErrors });
  }

  const fingerprint = computeFingerprint([filePaths.terms, filePaths.patterns, filePaths.allow]);

  return {
    paths: { terms: filePaths.terms, patterns: filePaths.patterns, allow: filePaths.allow },
    counts: { terms: termsParsed.entries.length, patterns: patternsParsed.entries.length, allow: allowParsed.allows.length },
    fingerprint,
    entries: { terms: termsParsed.entries, patterns: patternsParsed.entries, allows: allowParsed.allows },
  };
}

function listsLine(lists) {
  return `LISTS terms=${lists.counts.terms} patterns=${lists.counts.patterns} allow=${lists.counts.allow} fp=${lists.fingerprint}`;
}

function countIgnoredEnv(env) {
  return ['SCRIPTORIUM_DENYLIST_TERMS', 'SCRIPTORIUM_DENYLIST_PATTERNS', 'SCRIPTORIUM_DENYLIST_ALLOW'].filter((k) => env[k]).length;
}

function stripDenylistEnv(env) {
  const copy = { ...env };
  delete copy.SCRIPTORIUM_DENYLIST_TERMS;
  delete copy.SCRIPTORIUM_DENYLIST_PATTERNS;
  delete copy.SCRIPTORIUM_DENYLIST_ALLOW;
  return copy;
}

function makeSink() {
  const chunks = [];
  return {
    write(c) {
      chunks.push(c.toString());
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

function parseHitRows(text) {
  const rows = [];
  const re = /^HIT (\d+) (.*) ([a-z]+=\d+(?:,[a-z]+=\d+)*)$/gm;
  let m;
  while ((m = re.exec(text))) {
    const byCategory = {};
    for (const part of m[3].split(',')) {
      const [cat, n] = part.split('=');
      byCategory[cat] = Number(n);
    }
    rows.push({ count: Number(m[1]), label: m[2], byCategory });
  }
  return rows;
}

/**
 * SD-S4's `identity` class, exact and independently re-derived (not trusted from the scanner's
 * own output): a HIT row is identity-only when its categories are a subset of {name, email} AND
 * an independent scan of the commit object's `author `/`committer ` lines, with the SAME
 * matcher, accounts for every one of those hits -- every other line (tree/parent/gpgsig lines,
 * the message body) must contribute zero name/email hits of its own (T-S7: a name mentioned in
 * the message body breaks this shape, even though the row's categories still look like identity
 * at first glance).
 *
 * @param {string} commitText the raw `git cat-file commit <sha>` object text
 * @param {Record<string, number>} rowCounts the HIT row's byCategory counts
 * @param {ReturnType<typeof buildMatcher>} matcher
 * @returns {boolean}
 */
function isIdentityOnly(commitText, rowCounts, matcher) {
  const categories = Object.keys(rowCounts || {});
  if (categories.length === 0) return false;
  if (categories.some((c) => c !== 'name' && c !== 'email')) return false;

  const headerCounts = { name: 0, email: 0 };
  for (const line of String(commitText).split('\n')) {
    const isHeaderIdentityLine = line.startsWith('author ') || line.startsWith('committer ');
    const r = countHits(line, matcher);
    if (isHeaderIdentityLine) {
      for (const [cat, n] of Object.entries(r.byCategory)) {
        if (cat !== 'name' && cat !== 'email') return false; // fail closed: an unexpected category on an identity line.
        headerCounts[cat] += n;
      }
    } else if ((r.byCategory.name || 0) > 0 || (r.byCategory.email || 0) > 0) {
      return false;
    }
  }
  return headerCounts.name === (rowCounts.name || 0) && headerCounts.email === (rowCounts.email || 0);
}

function extractTreeRevArg(rest) {
  const dashIdx = rest.indexOf('--');
  if (dashIdx === -1) return rest[0];
  if (dashIdx === 0) return undefined;
  return rest[0];
}

function readBlobBytes(cwd, env, rev, relPath) {
  if (rev === undefined || rev === null) {
    const topLevel = gitTopLevel(cwd, env);
    try {
      return fs.readFileSync(path.join(topLevel, relPath));
    } catch {
      return null;
    }
  }
  const res = git(['cat-file', 'blob', `${rev}:${relPath}`], cwd, env);
  if (res.status !== 0) return null;
  return res.stdout;
}

/**
 * SD-V1's one internal helper, shared by every pinned-blob residual class (font, image, and
 * S4-1's vendor-binary). A row is classified only when, at the row's OWN revision (the tree rev,
 * or the commit the row belongs to): `tableAt(blobRev, rowPath)` returns a table that has an
 * entry for `rowPath` EXACTLY (a masked label, or a basename-only match, both fail this on
 * purpose -- `table.get` is a full-string key lookup, never a prefix or basename comparison);
 * the blob's own sha256, read straight off the git object the row names, equals that entry; and
 * `accept(bytes)` holds for those same bytes. `tableAt` returning a falsy value (no PIN, wrong
 * source kind, or a row outside a table's own root) leaves the row UNCLASSED with no error --
 * only a malformed-but-present table throws, and only from inside `tableAt` itself.
 */
function classifyPinnedBlobs({ mode, hitRows, classified, cwd, env, rest, shaMap, tableAt, accept }) {
  if (mode !== 'tree' && mode !== 'commits') return { hits: 0, files: 0 };
  const revArg = mode === 'tree' ? extractTreeRevArg(rest) : null;
  let hits = 0;
  let files = 0;

  hitRows.forEach((row, idx) => {
    if (classified.has(idx)) return;
    let rowPath;
    let blobRev;
    if (mode === 'tree') {
      rowPath = row.label;
      blobRev = revArg;
    } else {
      const m = /^([0-9a-f]{12}):(.+)$/.exec(row.label);
      if (!m || m[2] === 'message') return;
      rowPath = m[2];
      blobRev = shaMap ? shaMap.get(m[1]) : undefined;
      if (!blobRev) return;
    }
    const table = tableAt(blobRev, rowPath);
    if (!table) return;
    const expectedSha = table.get(rowPath);
    if (!expectedSha) return;
    const bytes = readBlobBytes(cwd, env, blobRev, rowPath);
    if (bytes === null) return;
    const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualSha !== expectedSha) return;
    if (!accept(bytes)) return;
    hits += row.count;
    files += 1;
    classified.add(idx);
  });

  return { hits, files };
}

/**
 * Amendment F, option (b)'s classifier (paired with the one table constant,
 * NAMED_FONT_RESIDUAL, above -- deliberately the only two pieces this option adds, so switching
 * to option (a) later is a two-piece removal). The table is the same, fixed Map for every row
 * (`tableAt` ignores its arguments); `accept` is unconditional -- font-binary has no byte-shape
 * check beyond the sha256 match that `classifyPinnedBlobs` already does.
 */
function classifyFontBinary({ mode, hitRows, classified, cwd, env, rest, shaMap, fontResidual }) {
  if (!fontResidual || fontResidual.length === 0) return { hits: 0, files: 0 };
  const table = new Map(fontResidual.map((f) => [f.path, f.sha256]));
  return classifyPinnedBlobs({ mode, hitRows, classified, cwd, env, rest, shaMap, tableAt: () => table, accept: () => true });
}

/** Segment comparison, never `startsWith` (Ib3's red line): `relPath`'s own path segments must
 * literally equal a root's segments as a prefix, so "examplesX/pic.png" is never "under"
 * "examples". */
function isUnderImageResidualRoot(relPath) {
  const segments = String(relPath).split('/');
  return IMAGE_RESIDUAL_ROOTS.some((root) => {
    const rootSegments = root.split('/');
    return rootSegments.length < segments.length && rootSegments.every((seg, i) => segments[i] === seg);
  });
}

function hasImageSignature(buf) {
  if (buf.length >= PNG_SIGNATURE.length && buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return true;
  if (buf.length >= JPEG_SIGNATURE.length && buf.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return true;
  return false;
}

/**
 * A.3's load-time validation. Returns the 0-based index of the first invalid entry, or -1 if
 * `table` is entirely valid (an empty table is trivially valid). Never returns or logs the entry itself (SD-S3's "never a path" rule, extended to this
 * table): callers report only the index.
 */
function firstInvalidImageResidualIndex(table) {
  const seenPaths = new Set();
  for (let i = 0; i < table.length; i++) {
    const entry = table[i];
    const p = entry && entry.path;
    const sha = entry && entry.sha256;
    if (typeof p !== 'string' || typeof sha !== 'string') return i;
    if (path.isAbsolute(p) || p.includes('\\') || p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return i;
    if (!/\.(png|jpe?g)$/.test(p)) return i; // case-sensitive: an upper-case extension is invalid.
    if (!isUnderImageResidualRoot(p)) return i;
    if (!/^[0-9a-f]{64}$/.test(sha)) return i;
    if (seenPaths.has(p)) return i;
    seenPaths.add(p);
  }
  return -1;
}

/**
 * A.3's classifier, sharing `classifyPinnedBlobs` with the font class (same table-to-Map, same
 * exact-path/exact-sha gate, same tree/commits-only scope) plus one thing font-binary doesn't
 * need: `accept` is a magic-byte signature check (OF-6 option (ii)'s whole point: a pinned
 * non-image blob at a pinned path/sha still isn't image-binary). The root-segment rule
 * (IMAGE_RESIDUAL_ROOTS) is enforced once, at load (firstInvalidImageResidualIndex), not
 * re-checked here -- a row's path is compared to the table EXACTLY (`table.get`, a full-string
 * key), which already can never match a path outside the roots (every table entry is itself
 * validated into one), so a second root check here would be dead weight, not defense in depth.
 */
function classifyImageBinary({ mode, hitRows, classified, cwd, env, rest, shaMap, imageResidual }) {
  if (!imageResidual || imageResidual.length === 0) return { hits: 0, files: 0 };
  const table = new Map(imageResidual.map((f) => [f.path, f.sha256]));
  return classifyPinnedBlobs({ mode, hitRows, classified, cwd, env, rest, shaMap, tableAt: () => table, accept: hasImageSignature });
}

/**
 * Amendment V, V.1 (SD-V2): the pure derivation at the core of the `vendor-binary` class. Given
 * one revision's own `PIN.json` text (or `null`/`undefined` when it's absent at that revision)
 * and a `readSibling(name)` callback that reads a sibling file in the same directory at the same
 * revision (also `null`/`undefined` when absent), returns a `Map` with exactly one entry --
 * `VENDOR_PIN_DIR + '/' + tarball -> tarballSha256` -- or `null` when there's simply no table to
 * derive (an absent PIN.json, or one whose `source.kind` isn't `release-tarball`: this covers
 * history from before the release-tarball pin, SD-V2 item 1). A PIN.json that IS present but
 * fails validation throws `GuardError('bad-residual', { kind: 'vendor' })` (SD-V2 item 2) -- the
 * same fail-closed shape as A.3's image-table validation, and for the same reason: a malformed
 * pin is a programming/repin error, not a row this scan should silently leave unclassified. Never
 * includes a path or field value in the thrown error (SD-S3's "never a path" rule); callers see
 * only the code.
 *
 * No git call here -- the caller (classifyVendorBinary, below) supplies `pinText`/`readSibling`
 * already resolved at the row's own revision, which is also what makes this function callable
 * directly, read-only, against the real on-disk pin (T-V9).
 */
function deriveVendorEntry(pinText, readSibling) {
  if (pinText === null || pinText === undefined) return null;
  let pin;
  try {
    pin = JSON.parse(pinText);
  } catch {
    throw new GuardError('bad-residual', { kind: 'vendor' });
  }
  if (!pin || typeof pin !== 'object' || !pin.source || pin.source.kind !== 'release-tarball') return null;

  const { tarball, tarballSha256, sums } = pin;
  const isBareName = (v) => typeof v === 'string' && v !== '' && v !== '.' && v !== '..' && !v.includes('/') && !v.includes('\\');
  if (!isBareName(tarball) || !/\.tgz$/.test(tarball)) throw new GuardError('bad-residual', { kind: 'vendor' });
  if (typeof tarballSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tarballSha256)) throw new GuardError('bad-residual', { kind: 'vendor' });
  if (!isBareName(sums)) throw new GuardError('bad-residual', { kind: 'vendor' });

  const sumsText = readSibling(sums);
  if (sumsText === null || sumsText === undefined) throw new GuardError('bad-residual', { kind: 'vendor' });

  const sumsMap = parseSha256Sums(String(sumsText));
  const sumsEntry = sumsMap.get(tarball);
  if (sumsEntry === undefined || sumsEntry !== tarballSha256) throw new GuardError('bad-residual', { kind: 'vendor' });

  return new Map([[`${VENDOR_PIN_DIR}/${tarball}`, tarballSha256]]);
}

/**
 * SD-V2: the vendor table's `tableAt`. Derivation runs ONLY for rows whose first two path
 * segments are `vendor` and `gm-apprentice-publish` (a segment comparison, so a sibling directory
 * like `vendor/gm-apprentice-publishX/` never triggers a read, let alone a validation error for a
 * pin that was never meant to cover it -- T-V4). Results are cached per revision (not per row),
 * since a single commit can touch more than one path under the vendor directory.
 */
function classifyVendorBinary({ mode, hitRows, classified, cwd, env, rest, shaMap }) {
  const cache = new Map();
  const tableAt = (blobRev, rowPath) => {
    const segments = String(rowPath).split('/');
    if (segments[0] !== 'vendor' || segments[1] !== 'gm-apprentice-publish') return null;
    const cacheKey = blobRev === null || blobRev === undefined ? '\u0000worktree' : blobRev;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const pinBytes = readBlobBytes(cwd, env, blobRev, `${VENDOR_PIN_DIR}/PIN.json`);
    const pinText = pinBytes === null ? null : pinBytes.toString('utf8');
    const readSibling = (name) => {
      const bytes = readBlobBytes(cwd, env, blobRev, `${VENDOR_PIN_DIR}/${name}`);
      return bytes === null ? null : bytes.toString('utf8');
    };
    const table = deriveVendorEntry(pinText, readSibling); // may throw GuardError; never caught here (fail closed).
    cache.set(cacheKey, table);
    return table;
  };
  return classifyPinnedBlobs({ mode, hitRows, classified, cwd, env, rest, shaMap, tableAt, accept: hasGzipMagic });
}

function classifyIdentity({ mode, hitRows, classified, cwd, env, matcher, history, shaMap }) {
  if (mode !== 'commits') return { hits: 0, commits: 0 };
  let hits = 0;
  let commits = 0;
  hitRows.forEach((row, idx) => {
    const m = /^([0-9a-f]{12}):message$/.exec(row.label);
    if (!m) return;
    const fullSha = shaMap.get(m[1]);
    if (!fullSha) return;
    const commitRes = git(['cat-file', 'commit', fullSha], cwd, env);
    if (commitRes.status !== 0) return;
    const commitText = commitRes.stdout.toString('utf8');
    if (!isIdentityOnly(commitText, row.byCategory, matcher)) return;
    hits += row.count;
    commits += 1;
    if (history === 'private') classified.add(idx);
  });
  return { hits, commits };
}

function emitError(err, stderr) {
  if (err instanceof GuardError) {
    let line = `ERROR ${err.code}`;
    if (err.kind) line += ` kind=${err.kind}`;
    if (err.index !== undefined) line += ` index=${err.index}`;
    stderr.write(line + '\n');
    if (err.code === 'bad-allow' && err.counts) {
      stderr.write(`bad-path=${err.counts.badPath} not-in-list=${err.counts.notInList}\n`);
      // Line numbers and codes only, never the entry's text.
      for (const e of err.lines || []) stderr.write(`LINE ${e.line} ${e.code}\n`);
    }
    return 2;
  }
  throw err;
}

function runCheckAllow(rest, { cwd, env, stdout }) {
  if (rest.length > 0) throw new GuardError('usage');
  const lists = loadPrivacyLists({ cwd, env });
  stdout.write(listsLine(lists) + '\n');
  return 0;
}

/**
 * SD-4 check (d), Run B: the scanner runs `tree <rev>` against the two TRACKED public files
 * (`scripts/public-hygiene-patterns.txt`, `scripts/public-hygiene-allow.txt`) read at `<rev>`
 * itself (never off disk -- a push/release/CI check is about what's IN the revision, not
 * whatever happens to be in the worktree) -- but SD-7 refuses a list file sitting inside the
 * scanned repository, so those two tracked files are first copied to a `mkdtemp` directory
 * OUTSIDE the repo (the `src/build/run.js` best-effort-cleanup pattern CLAUDE.md names) before
 * being named as `--patterns`/`--allow`. The environment is stripped of every
 * `SCRIPTORIUM_DENYLIST_*` variable first (G6's red line: a caller's stale private-list env var
 * must never reach this list-free run). `fontResidual`/`imageResidual`/the vendor class still
 * apply here exactly as they do in Run A (Amendment V, SD-V1: "Run A and Run B" alike) --
 * public-pattern regexes can hit coincidental bytes inside a pinned binary blob exactly like
 * private terms can.
 */
function runHygiene({ cwd, env, rev, stdout, stderr, scanRun, fontResidual, imageResidual }) {
  const patternsBytes = readBlobBytes(cwd, env, rev, 'scripts/public-hygiene-patterns.txt');
  if (patternsBytes === null) throw new GuardError('hygiene-missing');
  const allowBytes = readBlobBytes(cwd, env, rev, 'scripts/public-hygiene-allow.txt');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-hygiene-'));
  try {
    const patternsPath = path.join(tmpDir, 'patterns.txt');
    const allowPath = path.join(tmpDir, 'allow.txt');
    fs.writeFileSync(patternsPath, patternsBytes);
    fs.writeFileSync(allowPath, allowBytes === null ? '' : allowBytes);

    const strippedEnv = stripDenylistEnv(env);
    const result = runOneScan({
      cwd,
      env,
      strippedEnv,
      mode: 'tree',
      rest: [rev],
      match: 'word',
      lines: false,
      listPaths: { patterns: patternsPath, allow: allowPath },
      matcherEntries: [],
      scanRun,
      fontResidual,
      imageResidual,
    });
    stdout.write(result.scannerStdout.text());
    stderr.write(result.scannerStderr.text());
    if (result.scanExit === 2) return { blocked: true, isError: true };
    stdout.write(`RESIDUAL font-binary=${result.fontResult.hits} files=${result.fontResult.files}\n`);
    stdout.write(`RESIDUAL image-binary=${result.imageResult.hits} files=${result.imageResult.files}\n`);
    stdout.write(`RESIDUAL vendor-binary=${result.vendorResult.hits} files=${result.vendorResult.files}\n`);
    stdout.write(`HYGIENE unclassed=${result.unclassedCount}\n`);
    return { blocked: result.unclassedCount > 0, isError: false };
  } finally {
    // Best-effort, swallowed -- the src/build/run.js pattern CLAUDE.md names: a lingering handle
    // on the temp dir (e.g. an open file in some other process) must never change this run's own
    // exit code.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort only, as above */
    }
  }
}

/**
 * SD-4 checks (a)-(d), run in that exact order, for every mode and against every `<rev>` SD-4
 * names: shallow (throws, exit 2 -- an unreadable-root clone can't be trusted for the checks
 * that follow, G5's red line), root (SD-4 b, G3), forbidden paths (SD-4 c; only ever a COUNT is
 * printed or held onto, G10), then Run B hygiene (SD-4 d, G6). Stops at the first blocking
 * result: a caller only ever needs ONE reason to refuse a push, and this also keeps the mutation
 * boundary between (a)/(b)/(c)/(d) exact -- a test can plant exactly one failure and see exactly
 * one line.
 */
function runStructuralChecks({ cwd, env, rev, publicRoot, stdout, stderr, scanRun, fontResidual, imageResidual }) {
  if (!isShallowFalse(cwd, env)) throw new GuardError('shallow');

  const rootOk = checkRootSet(cwd, env, rev, publicRoot);
  stdout.write(`ROOT ${rootOk ? 'ok' : 'block'}\n`);
  if (!rootOk) return { blocked: true };

  const forbiddenCount = forbiddenPathCount(listTreePaths(cwd, env, rev));
  stdout.write(`FORBIDDEN ${forbiddenCount}\n`);
  if (forbiddenCount > 0) return { blocked: true };

  const hygiene = runHygiene({ cwd, env, rev, stdout, stderr, scanRun, fontResidual, imageResidual });
  if (hygiene.isError) return { blocked: true };
  return { blocked: hygiene.blocked };
}

/**
 * SD-4 check (e), Run A: the private-list commit-range scan, then the private-list tree scan AT
 * the pushed/released revision -- both absolute (never `--baseline`; SD-V3's own red line keeps
 * `--baseline` out of every guard mode). Shared by `pre-push` (one call per non-deleted pushed
 * ref) and `release` (one call, `<from-rev>..<to-rev>` plus `<to-rev>`'s tree).
 */
function runPrivateRange({ cwd, env, lists, scanRun, publicRoot, fontResidual, imageResidual, commitsRest, treeRev, stdout, stderr }) {
  const strippedEnv = stripDenylistEnv(env);
  const scanOpts = { cwd, env, strippedEnv, match: 'word', lines: false, lists, scanRun, publicRoot, fontResidual, imageResidual };

  const commitsResult = runOneScan({ ...scanOpts, mode: 'commits', rest: commitsRest });
  stdout.write(commitsResult.scannerStdout.text());
  stderr.write(commitsResult.scannerStderr.text());
  if (commitsResult.scanExit === 2) return { blocked: true, isError: true };
  stdout.write(
    `RESIDUAL identity=${commitsResult.identityResult.hits} commits=${commitsResult.identityResult.commits} history=${commitsResult.history}\n`,
  );
  stdout.write(`RESIDUAL font-binary=${commitsResult.fontResult.hits} files=${commitsResult.fontResult.files}\n`);
  stdout.write(`RESIDUAL image-binary=${commitsResult.imageResult.hits} files=${commitsResult.imageResult.files}\n`);
  stdout.write(`RESIDUAL vendor-binary=${commitsResult.vendorResult.hits} files=${commitsResult.vendorResult.files}\n`);
  stdout.write(`PRIVATE commits unclassed=${commitsResult.unclassedCount}\n`);
  if (commitsResult.unclassedCount > 0) return { blocked: true };

  const treeResult = runOneScan({ ...scanOpts, mode: 'tree', rest: [treeRev] });
  stdout.write(treeResult.scannerStdout.text());
  stderr.write(treeResult.scannerStderr.text());
  if (treeResult.scanExit === 2) return { blocked: true, isError: true };
  stdout.write(`RESIDUAL font-binary=${treeResult.fontResult.hits} files=${treeResult.fontResult.files}\n`);
  stdout.write(`RESIDUAL image-binary=${treeResult.imageResult.hits} files=${treeResult.imageResult.files}\n`);
  stdout.write(`RESIDUAL vendor-binary=${treeResult.vendorResult.hits} files=${treeResult.vendorResult.files}\n`);
  stdout.write(`PRIVATE tree unclassed=${treeResult.unclassedCount}\n`);
  if (treeResult.unclassedCount > 0) return { blocked: true };

  return { blocked: false };
}

/**
 * Reads the commits a push adds, for the pre-push path ONLY. Returns 'new' (at least one commit
 * the remote lacks), 'empty' (none: a tag on a commit the remote already has, or a branch that is
 * already up to date) or 'unreadable' (git failed: unknown remote sha, missing object, any git
 * error). Only 'empty' lets a ref skip the private-list scan; 'unreadable' must fail closed. The
 * explicit `scan commits <range>` command does not use this: an empty range there stays the hard
 * `empty-range` error, because it usually means a typo.
 */
function prePushRangeState(cwd, env, commitsRest) {
  const res = git(['rev-list', ...commitsRest], cwd, env);
  if (res.error || res.status !== 0) return 'unreadable';
  return res.stdout.toString('utf8').split('\n').some(Boolean) ? 'new' : 'empty';
}

/**
 * SD-4's `pre-push <remote> <url>`. SD-S6: Run A's own trigger is `scriptorium.privacyLists`
 * being set, not the two env vars (T-S12 unchanged: `requireLists=true` still exits 1 `no-lists`
 * before stdin is ever touched; `requireLists` unset still prints the NOTE and, since the CLI
 * entry point only reads real stdin for `pre-push` and every other caller defaults `stdin` to
 * `''`, `parsePushLines('')` is simply an empty ref list -- nothing to check structurally either,
 * so T-S12's no-stdin calls keep exiting 0 unchanged). Checks (a)-(d) (`runStructuralChecks`) run
 * for EVERY non-deleted pushed ref regardless of whether private lists are configured -- they
 * need no private list at all, which is the whole point of Run B; only check (e) (Run A) is
 * gated on lists being configured.
 */
function runPrePush(rest, { cwd, env, stdin, stdout, stderr, publicRoot, scanRun, fontResidual, imageResidual }) {
  const remote = rest[0];
  if (!remote) throw new GuardError('usage');

  let lists = null;
  let skipped = false;
  try {
    lists = loadPrivacyLists({ cwd, env });
  } catch (err) {
    if (!(err instanceof GuardError) || err.code !== 'no-lists') throw err;
    if (gitConfigBool(cwd, env, 'scriptorium.requireLists')) {
      stderr.write('ERROR no-lists\n');
      return 1;
    }
    skipped = true;
  }

  const pushLines = parsePushLines(stdin);
  let blocked = false;
  let nothingNew = false;
  for (const { localOid, remoteOid } of pushLines) {
    if (localOid === ZERO_OID) continue; // a delete: nothing new to scan for this ref.

    const structural = runStructuralChecks({ cwd, env, rev: localOid, publicRoot, stdout, stderr, scanRun, fontResidual, imageResidual });
    if (structural.blocked) {
      blocked = true;
      break;
    }

    if (lists) {
      const commitsRest = remoteOid === ZERO_OID ? [localOid, '--not', `--remotes=${remote}`] : [`${remoteOid}..${localOid}`];
      const rangeState = prePushRangeState(cwd, env, commitsRest);
      if (rangeState === 'unreadable') throw new GuardError('unreadable-range');
      if (rangeState === 'empty') {
        nothingNew = true; // everything this ref points at is already on the remote.
        continue;
      }
      const priv = runPrivateRange({ cwd, env, lists, scanRun, publicRoot, fontResidual, imageResidual, commitsRest, treeRev: localOid, stdout, stderr });
      if (priv.blocked) {
        blocked = true;
        break;
      }
    }
  }

  if (skipped && !blocked) stdout.write('NOTE private list scan skipped\n');
  if (nothingNew && !blocked) stdout.write('NOTE nothing new to scan\n');
  stdout.write(`VERDICT ${blocked ? 'block' : 'pass'}\n`);
  return blocked ? 1 : 0;
}

/**
 * SD-4's `ci [<rev>=HEAD]`. Checks (a)-(d) only -- "ci never uses private lists" (SD-4's own
 * words): `loadPrivacyLists` is never even called here, so no git-config read can change this
 * mode's behaviour either way (the CI runner has no private lists to begin with).
 */
function runCi(rest, { cwd, env, stdout, stderr, publicRoot, scanRun, fontResidual, imageResidual }) {
  if (rest.length > 1) throw new GuardError('usage');
  const rev = rest[0] || 'HEAD';
  const structural = runStructuralChecks({ cwd, env, rev, publicRoot, stdout, stderr, scanRun, fontResidual, imageResidual });
  stdout.write(`VERDICT ${structural.blocked ? 'block' : 'pass'}\n`);
  return structural.blocked ? 1 : 0;
}

/**
 * SD-4's `release <from-rev> [<to-rev>=HEAD]`. Checks (a)-(d) at `<to-rev>`, then Run A (e) over
 * `<from-rev>..<to-rev>` plus `<to-rev>`'s own tree -- `release` REQUIRES private lists
 * unconditionally (never keyed to `requireLists`, unlike `pre-push`) and exits 2 `no-lists`
 * without them (SD-4's own words: "requires them and exits 2 without").
 */
function runRelease(rest, { cwd, env, stdout, stderr, publicRoot, scanRun, fontResidual, imageResidual }) {
  if (rest.length < 1 || rest.length > 2) throw new GuardError('usage');
  const fromRev = rest[0];
  const toRev = rest[1] || 'HEAD';

  const structural = runStructuralChecks({ cwd, env, rev: toRev, publicRoot, stdout, stderr, scanRun, fontResidual, imageResidual });
  if (structural.blocked) {
    stdout.write('VERDICT block\n');
    return 1;
  }

  let lists;
  try {
    lists = loadPrivacyLists({ cwd, env });
  } catch (err) {
    if (err instanceof GuardError && err.code === 'no-lists') {
      stderr.write('ERROR no-lists\n');
      return 2;
    }
    throw err;
  }

  const priv = runPrivateRange({
    cwd,
    env,
    lists,
    scanRun,
    publicRoot,
    fontResidual,
    imageResidual,
    commitsRest: [`${fromRev}..${toRev}`],
    treeRev: toRev,
    stdout,
    stderr,
  });
  stdout.write(`VERDICT ${priv.blocked ? 'block' : 'pass'}\n`);
  return priv.blocked ? 1 : 0;
}

/** `tree [<rev>] [-- <pathspec>...]`'s own rev/pathspec split, independent of
 * `extractTreeRevArg` (which only needs the rev half): used by `--baseline` (SD-V3) to build a
 * second `rest` array for the baseline revision while keeping the candidate's own pathspec. */
function splitTreeRest(rest) {
  const dashIdx = rest.indexOf('--');
  if (dashIdx === -1) return { revArg: rest[0], pathspecArgs: [] };
  if (dashIdx === 0) return { revArg: undefined, pathspecArgs: rest.slice(1) };
  return { revArg: rest[0], pathspecArgs: rest.slice(dashIdx + 1) };
}

function buildTreeRest(revArg, pathspecArgs) {
  const out = [];
  if (revArg !== undefined) out.push(revArg);
  if (pathspecArgs.length > 0) out.push('--', ...pathspecArgs);
  return out;
}

/**
 * One full scan-and-classify pass at whatever `rest` names (the full mechanism `runScanMode`
 * used to run inline, before SD-V3 needed to run it twice -- once per revision -- for
 * `--baseline`). Captures the scanner's own output into sinks rather than writing it to the
 * real stdout/stderr directly; the caller (`runScanMode`) decides whether a given call's output
 * is shown (the candidate revision always is) or stays internal (the baseline revision's own
 * scanner/RESIDUAL/UNCLASSED detail is never printed -- SD-V3: "without printing that scanner
 * output" -- only its `unclassed` count surfaces, on the `BASELINE` line).
 */
function runOneScan({ cwd, env, strippedEnv, mode, rest, match, lines, lists, listPaths, matcherEntries, scanRun, publicRoot, fontResidual, imageResidual }) {
  let shas = null;
  let shaMap = null;
  if (mode === 'commits') {
    const revListRes = git(['rev-list', ...rest], cwd, env);
    if (revListRes.status === 0) {
      shas = revListRes.stdout.toString('utf8').split('\n').filter(Boolean);
      if (shas.length === 0) throw new GuardError('empty-range');
      shaMap = new Map(shas.map((s) => [s.slice(0, 12), s]));
    }
  }

  // `listPaths` overrides `lists.paths` for SD-4's Run B (public hygiene): Run B has no terms
  // file at all, only the tracked patterns/allow pair (Amendment V, SD-V1's own note that the
  // font/image/vendor residual classes apply "in Run A and Run B" alike -- a flag only ever
  // loaded when its path is present, so Run B never passes an empty `--terms`).
  const paths = listPaths || lists.paths;
  const scanArgv = [];
  if (paths.terms) scanArgv.push('--terms', paths.terms);
  if (paths.patterns) scanArgv.push('--patterns', paths.patterns);
  if (paths.allow) scanArgv.push('--allow', paths.allow);
  scanArgv.push('--match', match);
  if (lines) scanArgv.push('--lines');
  // `files` targets carry only a basename (or the named directory's basename plus a relative
  // path), never a repo-relative path, so a `path` entry cannot be tied to one repo file there.
  // Path entries stay loaded (and show up UNUSED) but never apply.
  if (mode === 'files') scanArgv.push('--no-path-allow');
  scanArgv.push(mode, ...rest);

  const scannerStdout = makeSink();
  const scannerStderr = makeSink();
  const scanExit = scanRun(scanArgv, { cwd, env: strippedEnv, stdout: scannerStdout, stderr: scannerStderr });

  if (scanExit === 2) return { scanExit, scannerStdout, scannerStderr };

  if (mode === 'commits' && shas !== null) {
    const commitsMatch = /^COMMITS (\d+)$/m.exec(scannerStdout.text());
    const scannerCount = commitsMatch ? Number(commitsMatch[1]) : null;
    if (scannerCount !== shas.length) throw new GuardError('count-mismatch');
  }

  const hitRows = parseHitRows(scannerStdout.text());
  const classified = new Set();
  // Run B (public hygiene) has no `lists.entries` at all -- it passes `matcherEntries: []`
  // explicitly, which is never used anyway: identity classification only runs in `commits` mode,
  // and Run B only ever scans `tree`.
  const matcher = buildMatcher(matcherEntries || lists.entries.terms.concat(lists.entries.patterns), { match });

  let history = null;
  let identityResult = { hits: 0, commits: 0 };
  if (mode === 'commits') {
    history = computeHistory(cwd, env, publicRoot);
    identityResult = classifyIdentity({ mode, hitRows, classified, cwd, env, matcher, history, shaMap });
  }

  const fontResult = classifyFontBinary({ mode, hitRows, classified, cwd, env, rest, shaMap, fontResidual });
  const imageResult = classifyImageBinary({ mode, hitRows, classified, cwd, env, rest, shaMap, imageResidual });
  const vendorResult = classifyVendorBinary({ mode, hitRows, classified, cwd, env, rest, shaMap });

  const unclassedRows = hitRows.filter((_row, idx) => !classified.has(idx));

  return {
    scanExit,
    scannerStdout,
    scannerStderr,
    history,
    identityResult,
    fontResult,
    imageResult,
    vendorResult,
    unclassedRows,
    unclassedCount: unclassedRows.length,
  };
}

function runScanMode(argvRest, { cwd, env, stdout, stderr, publicRoot, scanRun, fontResidual, imageResidual }) {
  if (argvRest.includes('--terms') || argvRest.includes('--patterns') || argvRest.includes('--allow')) {
    throw new GuardError('usage');
  }

  // A.3: validated unconditionally, before anything else runs, regardless of mode -- a
  // malformed residual table is a programming error, not a scan-time condition.
  if (imageResidual && imageResidual.length > 0) {
    const badIndex = firstInvalidImageResidualIndex(imageResidual);
    if (badIndex !== -1) throw new GuardError('bad-residual', { kind: 'image', index: badIndex });
  }

  let i = 0;
  let match = 'word';
  let lines = false;
  let baseline; // SD-V3: `--baseline <base-rev>`, tree mode only.
  while (i < argvRest.length) {
    const a = argvRest[i];
    if (a === '--match') {
      if (i + 1 >= argvRest.length) throw new GuardError('usage');
      match = argvRest[i + 1];
      i += 2;
      continue;
    }
    if (a === '--lines') {
      lines = true;
      i += 1;
      continue;
    }
    if (a === '--baseline') {
      if (i + 1 >= argvRest.length) throw new GuardError('usage');
      baseline = argvRest[i + 1];
      i += 2;
      continue;
    }
    break;
  }
  if (match !== 'word' && match !== 'substring') throw new GuardError('usage');

  const mode = argvRest[i];
  const rest = argvRest.slice(i + 1);
  if (mode !== 'tree' && mode !== 'commits' && mode !== 'files') throw new GuardError('usage');
  if (baseline !== undefined && mode !== 'tree') throw new GuardError('usage');

  if (mode !== 'files' && !isShallowFalse(cwd, env)) throw new GuardError('shallow');

  const lists = loadPrivacyLists({ cwd, env });
  const ignoredCount = countIgnoredEnv(env);
  const strippedEnv = stripDenylistEnv(env);

  stdout.write(listsLine(lists) + '\n');
  if (ignoredCount > 0) stdout.write(`NOTE ignored-env=${ignoredCount}\n`);

  // SD-V3: "The lists are loaded once. The same lists, match mode and pathspec are used for
  // both revs" -- `scanOpts` is the one options object both `runOneScan` calls below share;
  // only `rest` (which carries the rev) differs between them.
  const scanOpts = { cwd, env, strippedEnv, match, lines, lists, scanRun, publicRoot, fontResidual, imageResidual };

  let baselineResult = null;
  if (baseline !== undefined) {
    const { pathspecArgs } = splitTreeRest(rest);
    const baselineRest = buildTreeRest(baseline, pathspecArgs);
    baselineResult = runOneScan({ ...scanOpts, mode, rest: baselineRest });
    if (baselineResult.scanExit === 2) {
      stderr.write(baselineResult.scannerStderr.text());
      return 2;
    }
  }

  const candidateResult = runOneScan({ ...scanOpts, mode, rest });
  stdout.write(candidateResult.scannerStdout.text());
  stderr.write(candidateResult.scannerStderr.text());

  if (candidateResult.scanExit === 2) return 2;

  const { history, identityResult, fontResult, imageResult, vendorResult, unclassedCount } = candidateResult;

  if (mode === 'commits') {
    stdout.write(`RESIDUAL identity=${identityResult.hits} commits=${identityResult.commits} history=${history}\n`);
  }
  if (mode === 'tree' || mode === 'commits') {
    stdout.write(`RESIDUAL font-binary=${fontResult.hits} files=${fontResult.files}\n`);
    stdout.write(`RESIDUAL image-binary=${imageResult.hits} files=${imageResult.files}\n`);
    stdout.write(`RESIDUAL vendor-binary=${vendorResult.hits} files=${vendorResult.files}\n`);
  }
  stdout.write(`UNCLASSED ${unclassedCount}\n`);

  if (baseline === undefined) {
    const pass = unclassedCount === 0;
    stdout.write(`VERDICT ${pass ? 'pass' : 'block'}\n`);
    return pass ? 0 : 1;
  }

  // SD-V3: NEW rows are computed against the BASELINE's own unclassified rows only (never every
  // scanner HIT row -- T-B8's red line), matched by identical masked label (an exact Map key,
  // never a prefix -- T-B4b's red line). A row is NEW when it has no baseline match at all, or
  // when it exceeds the baseline row's count in any one category (a category that only shrinks,
  // or disappears entirely, never makes a row NEW on its own).
  stdout.write(`BASELINE ${baseline} unclassed=${baselineResult.unclassedCount}\n`);
  const baselineByLabel = new Map(baselineResult.unclassedRows.map((row) => [row.label, row.byCategory]));
  let newCount = 0;
  const newLines = [];
  for (const row of candidateResult.unclassedRows) {
    const baseRow = baselineByLabel.get(row.label);
    const isNew = !baseRow || Object.keys(row.byCategory).some((cat) => (row.byCategory[cat] || 0) > (baseRow[cat] || 0));
    if (!isNew) continue;
    newCount += 1;
    const catStr = Object.keys(row.byCategory)
      .sort()
      .map((c) => `${c}=${row.byCategory[c]}`)
      .join(',');
    newLines.push(`NEW ${row.count} ${row.label} ${catStr}`);
  }
  for (const l of newLines) stdout.write(l + '\n');
  stdout.write(`NEW-UNCLASSED ${newCount}\n`);

  const pass = newCount === 0;
  stdout.write(`VERDICT ${pass ? 'pass' : 'block'} baseline=${baseline}\n`);
  return pass ? 0 : 1;
}

/**
 * @param {string[]} argv
 * @param {{ cwd: string, env: object, stdin?: string, stdout: {write:Function}, stderr: {write:Function}, publicRoot?: string, scanRun?: Function, fontResidual?: object[], imageResidual?: object[] }} opts
 * @returns {number}
 */
function run(
  argv,
  {
    cwd,
    env,
    stdin = '',
    stdout,
    stderr,
    publicRoot = PUBLIC_ROOT,
    scanRun = denylistScan.run,
    fontResidual = NAMED_FONT_RESIDUAL,
    imageResidual = NAMED_IMAGE_RESIDUAL,
  },
) {
  try {
    const mode = argv[0];
    if (mode === 'check-allow') return runCheckAllow(argv.slice(1), { cwd, env, stdout, stderr });
    if (mode === 'pre-push') return runPrePush(argv.slice(1), { cwd, env, stdin, stdout, stderr, publicRoot, scanRun, fontResidual, imageResidual });
    if (mode === 'ci') return runCi(argv.slice(1), { cwd, env, stdout, stderr, publicRoot, scanRun, fontResidual, imageResidual });
    if (mode === 'release') return runRelease(argv.slice(1), { cwd, env, stdout, stderr, publicRoot, scanRun, fontResidual, imageResidual });
    if (mode === 'scan') return runScanMode(argv.slice(1), { cwd, env, stdout, stderr, publicRoot, scanRun, fontResidual, imageResidual });
    throw new GuardError('usage');
  } catch (err) {
    return emitError(err, stderr);
  }
}

if (require.main === module) {
  const cliArgv = process.argv.slice(2);
  // Only `pre-push` reads stdin (the hook contract); every other mode takes its revision(s) as
  // ordinary arguments, and blocking on a stdin read nobody is going to pipe would hang the
  // process for no reason.
  let cliStdin = '';
  if (cliArgv[0] === 'pre-push') {
    try {
      cliStdin = fs.readFileSync(0, 'utf8');
    } catch {
      cliStdin = '';
    }
  }
  process.exitCode = run(cliArgv, {
    cwd: process.cwd(),
    env: process.env,
    stdin: cliStdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

module.exports = {
  PUBLIC_ROOT,
  LIST_FILE_NAMES,
  NAMED_FONT_RESIDUAL,
  NAMED_IMAGE_RESIDUAL,
  IMAGE_RESIDUAL_ROOTS,
  VENDOR_PIN_DIR,
  deriveVendorEntry,
  loadPrivacyLists,
  isIdentityOnly,
  validateStandingAllow,
  parsePushLines,
  forbiddenPathCount,
  run,
};
