'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
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
} = require('../scripts/denylist-scan');
const { findWholeWordOccurrences } = require('../src/checks/leak/l4');

/*
 * S0 Engineering Brief. Synthetic-only (NFR-11): every term/pattern/allow
 * value below is invented for this test file; none is a real withheld
 * name, path, IP or list file, and no test reads anything under ~/drop.
 *
 * The suite spawns real git (risk area 6: `git` must be on PATH). Every
 * git call isolates config (GIT_CONFIG_GLOBAL=os.devNull,
 * GIT_CONFIG_NOSYSTEM=1, an isolated identity) so the machine's own global
 * config/hooks/signing can never leak in (risk area 3), and `run()` is
 * always given an explicit `env` object -- never `process.env` (risk area 4).
 *
 * Tests named below that would "pass today and prove nothing" on their own
 * are paired with a positive control in the same or an adjacent test, per
 * CLAUDE.md's testing standard.
 */

const ISOLATED_ENV_BASE = Object.freeze({
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
});
const IDENTITY_ARGS = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];

function git(args, cwd, env = ISOLATED_ENV_BASE) {
  return execFileSync('git', [...IDENTITY_ARGS, ...args], { cwd, env, stdio: 'pipe' });
}

function mkTmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(t) {
  const dir = mkTmp(t, 'scriptorium-denylist-repo-');
  git(['init', '--quiet', dir], dir);
  return dir;
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-m', message, '--quiet'], dir);
}

function commitAllWithAuthor(dir, message, authorName) {
  git(['add', '-A'], dir);
  execFileSync(
    'git',
    ['-c', `user.name=${authorName}`, '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message, '--quiet'],
    { cwd: dir, env: ISOLATED_ENV_BASE, stdio: 'pipe' },
  );
}

function revParse(dir, rev) {
  return execFileSync('git', ['rev-parse', rev], { cwd: dir, env: ISOLATED_ENV_BASE }).toString('utf8').trim();
}

function scratchFile(t, name, content) {
  const dir = mkTmp(t, 'scriptorium-denylist-lists-');
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
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

function baseEnv(overrides = {}) {
  return { ...ISOLATED_ENV_BASE, ...overrides };
}

function runScan(argv, { cwd, env = baseEnv() } = {}) {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = run(argv, { cwd, env, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

// Synthetic content shared across tests -- invented words/paths/patterns,
// none real (NFR-11).
const TERMS_TEXT = ['# a synthetic terms list, for tests only', 'Zorbleflenn', 'Quixnabber', '', 'Halvorix', ''].join('\n');

const PATTERNS_TEXT = [
  '# synthetic owner-environment-SHAPED patterns, for tests only',
  'literal path /synthetic/OwnerHome123',
  'regex   ip     \\b203\\.0\\.113\\.\\d{1,3}\\b',
  'literal domain exampletestsynth.invalid',
  'literal email  synthlead@example.invalid',
  'literal agent  Synth-Bridge-Agent',
  'literal host   synthhost-abcxyz',
  'literal name   Halvern',
  'literal place  Greywick',
  'literal other  Wrenmoor',
  '',
].join('\n');

function termsFile(t) {
  return scratchFile(t, 'terms.txt', TERMS_TEXT);
}
function patternsFile(t) {
  return scratchFile(t, 'patterns.txt', PATTERNS_TEXT);
}

// ---------------------------------------------------------------------------
// AC-06 (lists): parser format compliance
// ---------------------------------------------------------------------------

test('parseTermList: blank lines and #-comments ignored; each remaining line trimmed to one literal', () => {
  const { entries, errors } = parseTermList('  Foo  \n\n# comment\nBar\n#Baz\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(
    entries.map((e) => ({ kind: e.kind, category: e.category, value: e.value })),
    [
      { kind: 'literal', category: 'term', value: 'Foo' },
      { kind: 'literal', category: 'term', value: 'Bar' },
    ],
  );
});

test('parsePatternList: literal/regex kind, fixed category set, value trimmed; bad-entry carries line, never the text', () => {
  const { entries, errors } = parsePatternList(['literal path /a/b', 'regex ip \\d+', 'bogus name x', 'literal notacategory y', ''].join('\n'));
  assert.deepEqual(
    entries.map((e) => ({ kind: e.kind, category: e.category, value: e.value })),
    [
      { kind: 'literal', category: 'path', value: '/a/b' },
      { kind: 'regex', category: 'ip', value: '\\d+' },
    ],
  );
  assert.deepEqual(errors, [
    { line: 3, code: 'bad-entry' },
    { line: 4, code: 'bad-entry' },
  ]);
});

test('parsePatternList: an unsyntactic regex is bad-entry, never surfaces the source (SD-6)', () => {
  const { entries, errors } = parsePatternList('regex ip (unterminated[');
  assert.deepEqual(entries, []);
  assert.deepEqual(errors, [{ line: 1, code: 'bad-entry' }]);
});

test('parseAllowList: term/path kinds, reason required; a missing reason is bad-allow', () => {
  const { allows, errors } = parseAllowList(['term Zorbleflenn -- test fixture, not a real name', 'path some/label.md -- test fixture', 'term NoReason --   ', 'garbage line'].join('\n'));
  assert.deepEqual(
    allows.map((a) => ({ kind: a.kind, target: a.target, reason: a.reason })),
    [
      { kind: 'term', target: 'Zorbleflenn', reason: 'test fixture, not a real name' },
      { kind: 'path', target: 'some/label.md', reason: 'test fixture' },
    ],
  );
  assert.deepEqual(errors, [
    { line: 3, code: 'bad-allow' },
    { line: 4, code: 'bad-allow' },
  ]);
});

test('CATEGORIES includes term plus the nine fixed pattern categories', () => {
  assert.deepEqual([...CATEGORIES].sort(), ['agent', 'domain', 'email', 'host', 'ip', 'name', 'other', 'path', 'place', 'term'].sort());
});

// ---------------------------------------------------------------------------
// AC-02 (matching)
// ---------------------------------------------------------------------------

test('buildMatcher/countHits: case-insensitive, whole word only in word mode', () => {
  const { entries } = parseTermList('Zorbleflenn');
  const matcher = buildMatcher(entries, { match: 'word' });
  assert.equal(countHits('a ZORBLEFLENN here', matcher).total, 1, 'case-insensitive');
  assert.equal(countHits('a Zorbleflenntons here', matcher).total, 0, 'word mode: embedded in a longer word must not match (M9 control)');
});

test('buildMatcher/countHits: --match substring finds a term embedded in an identifier that word mode misses', () => {
  const { entries } = parseTermList('Zorbleflenn');
  const wordMatcher = buildMatcher(entries, { match: 'word' });
  const subMatcher = buildMatcher(entries, { match: 'substring' });
  const text = 'xZorbleflenntonsx';
  assert.equal(countHits(text, wordMatcher).total, 0);
  assert.equal(countHits(text, subMatcher).total, 1);
});

test('parity: the compiled matcher agrees with findWholeWordOccurrences on a synthetic corpus (SD-4/AC-02)', () => {
  const needles = ['Zorbleflenn', "O'Halvern", 'Green-Wick', 'Wrenmoor'];
  const cases = [
    ['plain hit', 'the Zorbleflenn stood there', 'Zorbleflenn'],
    ['case variant', 'the ZORBLEFLENN stood there', 'Zorbleflenn'],
    ['embedded, no boundary', 'ZorbleflennTown was quiet', 'Zorbleflenn'],
    ['apostrophe-named needle, exact', "O'Halvern arrived", "O'Halvern"],
    ['apostrophe-named needle, punctuation before', "the sword of O'Halvern", "O'Halvern"],
    ['hyphenated needle, exact', 'Green-Wick was foggy', 'Green-Wick'],
    ['hyphenated needle inside a bigger token', 'preGreen-Wickpost', 'Green-Wick'],
    ['sentence start', 'Wrenmoor is a village', 'Wrenmoor'],
    ['sentence end with punctuation', 'they came from Wrenmoor.', 'Wrenmoor'],
    ['no match at all', 'nothing here matches', 'Zorbleflenn'],
    ['needle at very start of string', 'Zorbleflenn began the tale', 'Zorbleflenn'],
    ['needle at very end of string', 'the tale of Zorbleflenn', 'Zorbleflenn'],
    ['digits adjacent, no boundary', 'Zorbleflenn2 was renamed', 'Zorbleflenn'],
    ['digits before, no boundary', '2Zorbleflenn was renamed', 'Zorbleflenn'],
    ['double occurrence', 'Zorbleflenn met Zorbleflenn', 'Zorbleflenn'],
    ['surrounded by quotes', '"Zorbleflenn" said the sign', 'Zorbleflenn'],
    ['surrounded by parens', '(Zorbleflenn)', 'Zorbleflenn'],
    ['newline-adjacent', 'line one\nZorbleflenn\nline three', 'Zorbleflenn'],
    ['tab-adjacent', 'a\tZorbleflenn\tb', 'Zorbleflenn'],
    ['unrelated apostrophe word nearby', "Zorbleflenn's home", 'Zorbleflenn'],
  ];
  for (const [label, text, needle] of cases) {
    const { entries } = parseTermList(needle);
    const matcher = buildMatcher(entries, { match: 'word' });
    const compiledCount = countHits(text, matcher).total;
    const referenceCount = findWholeWordOccurrences(text, needle).length;
    assert.equal(compiledCount, referenceCount, `parity mismatch for [${label}]: compiled=${compiledCount} reference=${referenceCount}`);
  }
  void needles; // documents the needle set used above; kept for readability
});

test('normaliseEmitted path: an HTML-entity-encoded occurrence and a typographer apostrophe both match (M2 control)', () => {
  const { entries } = parseTermList("O'Halvern");
  const matcher = buildMatcher(entries, { match: 'word' });
  const { normaliseEmitted } = require('../src/checks/leak/outputscan');
  assert.equal(countHits(normaliseEmitted('the sword of O&#39;Halvern'), matcher).total, 1, 'entity-decoded apostrophe');
  assert.equal(countHits(normaliseEmitted('the sword of O’Halvern'), matcher).total, 1, 'typographer right-single-quote folded to a plain apostrophe');
});

test('an NFD haystack matches an NFC needle', () => {
  const nfcNeedle = 'Halvern'; // ASCII, but exercise the general canonicalNfc path with a combining-mark word
  const combining = 'Hálvern'; // "Ha" + combining acute + "lvern" -- an NFD-style decomposition
  const { entries } = parseTermList('Hálvern'); // NFC precomposed a-acute
  const matcher = buildMatcher(entries, { match: 'word' });
  const { normaliseEmitted } = require('../src/checks/leak/outputscan');
  assert.equal(countHits(normaliseEmitted(combining), matcher).total, 1);
  void nfcNeedle;
});

test('M2 (production path, via run()): an entity-encoded occurrence in a real scanned file is still found', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'notes.md'), "the sword of O&#39;Halvern hangs here\n");
  commitAll(dir, 'one');
  const patternsWithApostropheName = scratchFile(t, 'patterns.txt', "literal name O'Halvern\n");
  const result = runScan(['--patterns', patternsWithApostropheName, 'tree', 'HEAD'], { cwd: dir });
  // If normaliseEmitted() were called but its result discarded (M2), the raw
  // "O&#39;Halvern" text would never match the needle "O'Halvern" and this
  // would wrongly report 0 -- this is an integration-level control that the
  // pure-function test above (which normalises in the TEST, not through
  // run()) cannot exercise.
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HIT 1 notes\.md name=1$/m);
});

// ---------------------------------------------------------------------------
// AC-03 (binary, dual UTF-8 / UTF-16LE)
// ---------------------------------------------------------------------------

function binaryFixtureBuffer() {
  // "portrait.png"-shaped: a NUL-bearing buffer with the term once as UTF-8
  // bytes and once as UTF-16LE bytes.
  const term = 'Zorbleflenn';
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]), Buffer.from(term, 'utf8'), Buffer.from([0x00, 0x00]), Buffer.from(term, 'utf16le'), Buffer.from([0x00, 0x00])]);
}

test('countInBuffer: a NUL-bearing buffer is scanned as UTF-8 AND UTF-16LE, both counted (AC-03, M8 control)', () => {
  const { entries } = parseTermList('Zorbleflenn');
  const matcher = buildMatcher(entries, { match: 'word' });
  const buf = binaryFixtureBuffer();
  assert.equal(countInBuffer(buf, matcher).total, 2);
});

test('AC-03 in tree <rev>: portrait.png counts 2', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'portrait.png'), binaryFixtureBuffer());
  commitAll(dir, 'add portrait');
  const result = runScan(['--terms', termsFile(t), 'tree', 'HEAD'], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HIT 2 portrait\.png /m);
});

test('AC-03 in files: portrait.png counts 2', (t) => {
  const dir = mkTmp(t, 'scriptorium-denylist-files-');
  fs.writeFileSync(path.join(dir, 'portrait.png'), binaryFixtureBuffer());
  const result = runScan(['--terms', termsFile(t), 'files', path.join(dir, 'portrait.png')]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HIT 2 portrait\.png /m);
});

test('AC-03 in commits: a binary blob added in a commit counts 2 (M12 control)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'seed.md'), 'unrelated file\n');
  commitAll(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'portrait.png'), binaryFixtureBuffer());
  commitAll(dir, 'add binary portrait');
  const head = revParse(dir, 'HEAD');
  const parent = revParse(dir, 'HEAD~1');
  const result = runScan(['--terms', termsFile(t), 'commits', `${parent}..${head}`], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`^HIT 2 ${head.slice(0, 12)}:portrait\\.png `, 'm'));
});

// --- Odd-byte-offset UTF-16LE occurrences (Reviewer finding on S0's first
// pass): a single-phase UTF-16LE decode of a buffer only recovers text
// whose 2-byte code units happen to start on an even byte offset WITHIN
// THAT BUFFER. binaryFixtureBuffer() above (a 7-byte header, then an
// 11-char term) puts its own UTF-16LE occurrence at byte offset 18 --
// even, by coincidence -- so none of the AC-03 tests above ever exercised
// the miss. These use a deliberately-chosen header/term length pair to
// land on the UNLUCKY (odd) byte offset, and its lucky-parity sibling
// (one padding byte later) as a paired control.

const MISALIGN_TERM = 'QuixnabberGlimwood'; // 18 chars, synthetic (NFR-11); matches the Reviewer's repro shape

function misalignedBinaryFixture(term, { headerLen, padding = 0 } = {}) {
  const filler = 0x89; // non-NUL, PNG-magic-style filler; the buffer's NULs come from the UTF-16LE term itself
  // A 2-byte NUL separator between the two encoded copies (matching binaryFixtureBuffer()'s own
  // pattern above) is required so the UTF-8 term's trailing word-boundary check doesn't fail
  // against the very next byte of the UTF-16LE copy immediately following it -- an all-letters
  // run with no boundary between them would make BOTH copies invisible to word-mode matching for
  // a reason that has nothing to do with byte alignment. Two NUL bytes (an even count) preserve
  // whatever odd/even offset `headerLen`+`padding`+the UTF-8 term's length already produced.
  return Buffer.concat([Buffer.alloc(headerLen, filler), Buffer.alloc(padding, filler), Buffer.from(term, 'utf8'), Buffer.from([0x00, 0x00]), Buffer.from(term, 'utf16le')]);
}

test('countInBuffer: an odd-byte-offset UTF-16LE occurrence is found (unlucky parity, 7-byte header + 18-char term)', () => {
  const { entries } = parseTermList(MISALIGN_TERM);
  const matcher = buildMatcher(entries, { match: 'word' });
  const buf = misalignedBinaryFixture(MISALIGN_TERM, { headerLen: 7, padding: 0 });
  // header(7) + utf8 term(18) + 2-byte separator = byte 27: the UTF-16LE term starts at an ODD offset.
  assert.equal(countInBuffer(buf, matcher).total, 2, 'both the UTF-8 and the UTF-16LE occurrence must be found regardless of byte alignment');
});

test('countInBuffer: same term with one padding byte (lucky/even parity) still finds both (paired control)', () => {
  const { entries } = parseTermList(MISALIGN_TERM);
  const matcher = buildMatcher(entries, { match: 'word' });
  const buf = misalignedBinaryFixture(MISALIGN_TERM, { headerLen: 7, padding: 1 });
  // header(7) + padding(1) + utf8 term(18) + 2-byte separator = byte 28: EVEN offset -- the parity this bug's single-phase decode already handled.
  assert.equal(countInBuffer(buf, matcher).total, 2);
});

test('classifyBuffer (via countInBuffer path parity check): odd offset is not simply half of what even offset finds', () => {
  const { entries } = parseTermList(MISALIGN_TERM);
  const matcher = buildMatcher(entries, { match: 'word' });
  const odd = countInBuffer(misalignedBinaryFixture(MISALIGN_TERM, { headerLen: 7, padding: 0 }), matcher).total;
  const even = countInBuffer(misalignedBinaryFixture(MISALIGN_TERM, { headerLen: 7, padding: 1 }), matcher).total;
  assert.equal(odd, even, 'the byte alignment of the UTF-16LE occurrence must never change the count');
});

test('tree <rev>: an odd-byte-offset UTF-16LE occurrence is still found through the real scan path', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'asset.bin'), misalignedBinaryFixture(MISALIGN_TERM, { headerLen: 7, padding: 0 }));
  commitAll(dir, 'add misaligned binary asset');
  const termsPath = scratchFile(t, 'terms.txt', MISALIGN_TERM + '\n');
  const result = runScan(['--terms', termsPath, 'tree', 'HEAD'], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HIT 2 asset\.bin term=2$/m);
});

// ---------------------------------------------------------------------------
// AC-01 (modes) -- tree
// ---------------------------------------------------------------------------

test('tree (worktree): an untracked-but-unignored file is scanned; an ignored file is not (M14 control)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored-file.md\n');
  commitAll(dir, 'add gitignore');
  fs.writeFileSync(path.join(dir, 'untracked.md'), 'mentions Quixnabber here\n');
  fs.writeFileSync(path.join(dir, 'ignored-file.md'), 'also mentions Quixnabber here\n');
  const result = runScan(['--terms', termsFile(t), 'tree'], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HIT 1 untracked\.md /m);
  assert.doesNotMatch(result.stdout, /ignored-file\.md/);
});

test('tree <rev> with a pathspec restricts both the worktree form and the rev form', (t) => {
  const dir = initRepo(t);
  fs.mkdirSync(path.join(dir, 'in'));
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'in', 'a.md'), 'Zorbleflenn lives here\n');
  fs.writeFileSync(path.join(dir, 'out', 'b.md'), 'Zorbleflenn lives here too\n');
  commitAll(dir, 'add both');
  const rev = runScan(['--terms', termsFile(t), 'tree', 'HEAD', '--', 'in'], { cwd: dir });
  assert.match(rev.stdout, /^HIT 1 in\/a\.md /m);
  assert.doesNotMatch(rev.stdout, /out\/b\.md/);

  const worktree = runScan(['--terms', termsFile(t), 'tree', '--', 'in'], { cwd: dir });
  assert.match(worktree.stdout, /^HIT 1 in\/a\.md /m);
  assert.doesNotMatch(worktree.stdout, /out\/b\.md/);
});

test('tree <rev>: an in-filename hit with clean content is still caught by the path arm (M10 control)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'Zorbleflenn-notes.md'), 'nothing sensitive in here\n');
  commitAll(dir, 'add file named after the term');
  const result = runScan(['--terms', termsFile(t), 'tree', 'HEAD'], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HIT 1 \[term\]-notes\.md /m);
});

// ---------------------------------------------------------------------------
// AC-01 (modes) -- commits
// ---------------------------------------------------------------------------

test('commits: message control, author control, added-lines-only control (M11/M13)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'Halvorix was here first\n');
  commitAll(dir, 'seed with a pre-existing term');
  const seedHead = revParse(dir, 'HEAD');

  fs.appendFileSync(path.join(dir, 'notes.md'), 'Zorbleflenn arrived later\n');
  commitAllWithAuthor(dir, 'a message mentioning Quixnabber', 'Halvern Author');
  const head = revParse(dir, 'HEAD');

  const result = runScan(['--terms', termsFile(t), '--patterns', patternsFile(t), 'commits', `${seedHead}..${head}`], { cwd: dir });
  assert.equal(result.code, 1);

  // Message + author identity, both from the SAME cat-file-commit target (M11).
  // name=2 because the raw commit object carries the author line AND the
  // committer line, and commitAllWithAuthor sets user.name for both.
  const messageLine = result.stdout.split('\n').find((l) => l.startsWith('HIT') && l.includes(':message'));
  assert.ok(messageLine, 'expected a HIT line for the commit message target');
  assert.match(messageLine, /term=1/, 'the message text itself must be scanned');
  assert.match(messageLine, /name=2/, 'both the author and committer lines must be scanned');

  // Added-lines-only: the new commit's notes.md target must show exactly the
  // NEW term (Zorbleflenn), not the pre-existing one (Halvorix) re-counted (M13).
  const notesLine = result.stdout.split('\n').find((l) => l.startsWith(`HIT`) && l.includes(':notes.md'));
  assert.ok(notesLine, 'expected a HIT line for the changed notes.md path');
  assert.match(notesLine, /term=1/);
  assert.equal((notesLine.match(/term=(\d+)/) || [])[1], '1', 'must not double-count the pre-existing Halvorix line');
});

test('commits: COMMITS equals git rev-list --count, and a swapped range gives COMMITS 0 (risk area 2)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'nothing here\n');
  commitAll(dir, 'one');
  const first = revParse(dir, 'HEAD');
  fs.writeFileSync(path.join(dir, 'b.md'), 'nothing here either\n');
  commitAll(dir, 'two');
  const second = revParse(dir, 'HEAD');

  const forward = runScan(['--terms', termsFile(t), 'commits', `${first}..${second}`], { cwd: dir });
  assert.match(forward.stdout, /^COMMITS 1$/m);

  const swapped = runScan(['--terms', termsFile(t), 'commits', `${second}..${first}`], { cwd: dir });
  assert.match(swapped.stdout, /^COMMITS 0$/m);
  assert.equal(swapped.code, 0);
});

test('commits: a root commit diffs against the empty tree', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'root.md'), 'Zorbleflenn from the very first commit\n');
  commitAll(dir, 'root commit');
  const head = revParse(dir, 'HEAD');
  const result = runScan(['--terms', termsFile(t), 'commits', head], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`^HIT 1 ${head.slice(0, 12)}:root\\.md `, 'm'));
});

// ---------------------------------------------------------------------------
// AC-01 (modes) -- files
// ---------------------------------------------------------------------------

test('files: a file argument labels by basename; a directory argument walks sorted, labelled <dir>/<rel>', (t) => {
  const dir = mkTmp(t, 'scriptorium-denylist-files-');
  const notesDir = path.join(dir, 'notes');
  fs.mkdirSync(path.join(notesDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'standalone.md'), 'Quixnabber here\n');
  fs.writeFileSync(path.join(notesDir, 'a.md'), 'nothing\n');
  fs.writeFileSync(path.join(notesDir, 'sub', 'b.md'), 'Zorbleflenn here\n');

  const result = runScan(['--terms', termsFile(t), 'files', path.join(dir, 'standalone.md'), notesDir]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HIT 1 standalone\.md /m);
  assert.match(result.stdout, /^HIT 1 notes\/sub\/b\.md /m);
  assert.doesNotMatch(result.stdout, /^HIT \d+ notes\/a\.md /m);
});

test('files: a missing top-level path is a fatal missing-path error', (t) => {
  const dir = mkTmp(t, 'scriptorium-denylist-files-');
  const result = runScan(['--terms', termsFile(t), 'files', path.join(dir, 'does-not-exist.md')]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^ERROR missing-path$/m);
});

test('M21: a symlink is never followed; its link text is the haystack (files mode)', (t) => {
  const dir = mkTmp(t, 'scriptorium-denylist-files-');
  const outsideDir = mkTmp(t, 'scriptorium-denylist-outside-');
  // The target's CONTENT deliberately contains no listed term at all, and its
  // NAME does -- so "followed" (0 hits, from clean content) and "not
  // followed" (1 hit, from the link's own text) give different, distinct
  // results; a same-count coincidence here would let M21 stay green wrongly.
  const outsideTarget = path.join(outsideDir, 'Zorbleflenn-target.md');
  fs.writeFileSync(outsideTarget, 'nothing sensitive in this content\n');
  const linkPath = path.join(dir, 'link.md');
  fs.symlinkSync(outsideTarget, linkPath);

  const result = runScan(['--terms', termsFile(t), 'files', linkPath]);
  assert.equal(result.code, 1, 'the link text itself ("...Zorbleflenn-target.md") must be scanned, even though the pointed-to content has 0 hits');
  assert.match(result.stdout, /^HIT 1 link\.md /m);
});

// ---------------------------------------------------------------------------
// AC-04 (never prints)
// ---------------------------------------------------------------------------

test('AC-04: no synthetic term, pattern value or list path ever appears in stdout or stderr', (t) => {
  const dir = initRepo(t);
  fs.mkdirSync(path.join(dir, 'Zorbleflenn-dir-name'));
  fs.writeFileSync(path.join(dir, 'Zorbleflenn-dir-name', 'has-a-hit.md'), 'contains Quixnabber and synthlead@example.invalid and Synth-Bridge-Agent\n');
  commitAll(dir, 'a commit with Quixnabber in the message too, and author Halvern');
  fs.appendFileSync(path.join(dir, 'Zorbleflenn-dir-name', 'has-a-hit.md'), 'plus 203.0.113.42 and /synthetic/OwnerHome123\n');
  commitAll(dir, 'second commit');

  const termsInWeirdDir = scratchFile(t, 'terms.txt', TERMS_TEXT); // scratchFile already puts it in its own tmp dir
  const patternsPath = patternsFile(t);
  const allowPath = scratchFile(t, 'allow.txt', 'term Quixnabber -- allowed for this no-print audit\n');
  const badRegexPatterns = scratchFile(t, 'bad-patterns.txt', 'regex ip (unterminated[\n');
  const badCategoryPatterns = scratchFile(t, 'bad-category.txt', 'literal notacategory Zorbleflenn\n');

  const synthetic = ['Zorbleflenn', 'Quixnabber', 'Halvorix', 'Halvern', 'Greywick', 'Wrenmoor', 'synthlead@example.invalid', 'Synth-Bridge-Agent', 'synthhost-abcxyz', '203.0.113', '/synthetic/OwnerHome123', 'exampletestsynth.invalid', 'unterminated'];

  const runs = [
    runScan(['--terms', termsInWeirdDir, '--patterns', patternsPath, 'tree', 'HEAD'], { cwd: dir }),
    runScan(['--terms', termsInWeirdDir, '--patterns', patternsPath, '--allow', allowPath, 'tree', 'HEAD'], { cwd: dir }),
    runScan(['--terms', termsInWeirdDir, 'commits', 'HEAD'], { cwd: dir }),
    runScan(['--terms', badRegexPatterns.replace('bad-patterns.txt', 'terms.txt') && termsInWeirdDir, '--patterns', badRegexPatterns, 'tree', 'HEAD'], { cwd: dir }),
    runScan(['--terms', termsInWeirdDir, '--patterns', badCategoryPatterns, 'tree', 'HEAD'], { cwd: dir }),
    runScan(['tree', 'HEAD'], { cwd: dir }), // no-lists error
    runScan(['--terms', path.join(dir, 'no-such-list.txt'), 'tree', 'HEAD'], { cwd: dir }), // list-unreadable
    runScan(['--terms', path.join(dir, 'Zorbleflenn-dir-name', 'has-a-hit.md'), 'tree', 'HEAD'], { cwd: dir }), // list-in-repo, path itself contains the term
    runScan(['bogus-mode'], { cwd: dir }), // usage
  ];

  const combined = runs.map((r) => r.stdout + '\n' + r.stderr).join('\n');
  for (const s of synthetic) {
    assert.equal(combined.toLowerCase().includes(s.toLowerCase()), false, `synthetic value leaked into output: ${s}`);
  }
});

test('AC-04: a list file placed in a temp dir whose NAME contains a term never leaks that dir name', (t) => {
  const weirdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Zorbleflenn-named-dir-'));
  t.after(() => fs.rmSync(weirdDir, { recursive: true, force: true }));
  const listPath = path.join(weirdDir, 'terms.txt');
  fs.writeFileSync(listPath, TERMS_TEXT);
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'Quixnabber here\n');
  commitAll(dir, 'one');
  const result = runScan(['--terms', listPath, 'tree', 'HEAD'], { cwd: dir });
  assert.equal(result.stdout.includes('Zorbleflenn'), false);
  assert.equal(result.stderr.includes('Zorbleflenn'), false);
});

// ---------------------------------------------------------------------------
// AC-05 (exit codes)
// ---------------------------------------------------------------------------

test('exit 0 with no hits outside the allowlist, exit 1 with a hit (paired control)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'clean.md'), 'nothing to see here\n');
  commitAll(dir, 'clean');
  const clean = runScan(['--terms', termsFile(t), 'tree', 'HEAD'], { cwd: dir });
  assert.equal(clean.code, 0);

  fs.writeFileSync(path.join(dir, 'dirty.md'), 'Zorbleflenn is here\n');
  commitAll(dir, 'dirty');
  const dirty = runScan(['--terms', termsFile(t), 'tree', 'HEAD'], { cwd: dir });
  assert.equal(dirty.code, 1);
});

test('exit 2 for every listed error code (no-lists, no-entries, list-unreadable, list-in-repo, bad-entry, bad-allow, not-a-repo, bad-rev, no-targets, missing-path, usage)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'x\n');
  commitAll(dir, 'one');

  assert.equal(runScan(['tree', 'HEAD'], { cwd: dir }).code, 2); // no-lists
  assert.equal(runScan(['--terms', scratchFile(t, 't.txt', '# only comments\n'), 'tree', 'HEAD'], { cwd: dir }).code, 2); // no-entries
  assert.equal(runScan(['--terms', path.join(dir, 'missing.txt'), 'tree', 'HEAD'], { cwd: dir }).code, 2); // list-unreadable
  {
    const inRepoList = path.join(dir, 'inrepo-terms.txt');
    fs.writeFileSync(inRepoList, TERMS_TEXT);
    assert.equal(runScan(['--terms', inRepoList, 'tree', 'HEAD'], { cwd: dir }).code, 2); // list-in-repo
  }
  assert.equal(runScan(['--patterns', scratchFile(t, 'p.txt', 'bogus line\n'), 'tree', 'HEAD'], { cwd: dir }).code, 2); // bad-entry
  assert.equal(runScan(['--terms', termsFile(t), '--allow', scratchFile(t, 'a.txt', 'term X --   \n'), 'tree', 'HEAD'], { cwd: dir }).code, 2); // bad-allow
  {
    const notARepo = mkTmp(t, 'scriptorium-denylist-not-a-repo-');
    assert.equal(runScan(['--terms', termsFile(t), 'tree', 'HEAD'], { cwd: notARepo }).code, 2); // not-a-repo
  }
  assert.equal(runScan(['--terms', termsFile(t), 'tree', 'not-a-real-rev'], { cwd: dir }).code, 2); // bad-rev
  {
    const emptyDir = mkTmp(t, 'scriptorium-denylist-empty-');
    assert.equal(runScan(['--terms', termsFile(t), 'files', emptyDir], { cwd: dir }).code, 2); // no-targets
  }
  {
    const filesDir = mkTmp(t, 'scriptorium-denylist-files-');
    assert.equal(runScan(['--terms', termsFile(t), 'files', path.join(filesDir, 'nope.md')], { cwd: dir }).code, 2); // missing-path
  }
  assert.equal(runScan(['not-a-mode'], { cwd: dir }).code, 2); // usage
  assert.equal(runScan(['--lines', 'commits', 'HEAD'], { cwd: dir }).code, 2); // usage: --lines with commits
});

test('exit 1 through the real require.main subprocess (M5 subprocess control)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'dirty.md'), 'Zorbleflenn is here\n');
  commitAll(dir, 'dirty');
  const bin = path.join(__dirname, '..', 'scripts', 'denylist-scan.js');
  let status = 0;
  try {
    execFileSync(process.execPath, [bin, '--terms', termsFile(t), 'tree', 'HEAD'], { cwd: dir, stdio: 'pipe' });
  } catch (err) {
    status = err.status;
  }
  assert.equal(status, 1);
});

test('exit 0 through the real require.main subprocess on a clean tree (paired control)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'clean.md'), 'nothing here\n');
  commitAll(dir, 'clean');
  const bin = path.join(__dirname, '..', 'scripts', 'denylist-scan.js');
  const status = 0;
  execFileSync(process.execPath, [bin, '--terms', termsFile(t), 'tree', 'HEAD'], { cwd: dir, stdio: 'pipe' });
  assert.equal(status, 0);
});

// ---------------------------------------------------------------------------
// AC-06 (allowlist behaviour), SD-8
// ---------------------------------------------------------------------------

test('allow term: suppresses that literal everywhere, appears as ALLOWED, and is marked used', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'Zorbleflenn and Quixnabber both appear\n');
  commitAll(dir, 'one');
  const allowPath = scratchFile(t, 'allow.txt', 'term Zorbleflenn -- test fixture, acknowledged false positive\n');
  const result = runScan(['--terms', termsFile(t), '--allow', allowPath, 'tree', 'HEAD'], { cwd: dir });
  assert.equal(result.code, 1); // Quixnabber still an unsuppressed hit
  assert.match(result.stdout, /^HIT 1 a\.md term=1$/m);
  assert.match(result.stdout, /^ALLOWED 1 a\.md$/m);
  assert.match(result.stdout, /allowed=1/);
  assert.doesNotMatch(result.stdout, /unused-allow=1/); // it WAS used
});

test('allow path: suppresses every hit in that exact target; unused entries are counted and reported by line', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'Zorbleflenn and Quixnabber both appear\n');
  fs.writeFileSync(path.join(dir, 'clean.md'), 'nothing here\n');
  commitAll(dir, 'one');
  const allowPath = scratchFile(t, 'allow.txt', ['path a.md -- test fixture, whole file acknowledged', 'term NeverSeenAnywhere -- unused entry for this test'].join('\n'));
  const result = runScan(['--terms', termsFile(t), '--allow', allowPath, 'tree', 'HEAD'], { cwd: dir });
  assert.equal(result.code, 0); // the only hits are wholly allowed
  assert.doesNotMatch(result.stdout, /^HIT /m);
  assert.match(result.stdout, /^ALLOWED 2 a\.md$/m);
  assert.match(result.stdout, /^UNUSED allow:2$/m);
  assert.match(result.stdout, /unused-allow=1/);
});

test('a missing reason exits 2, never accepted (M17 control)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'Zorbleflenn appears\n');
  commitAll(dir, 'one');
  const allowPath = scratchFile(t, 'allow.txt', 'term Zorbleflenn --\n');
  const result = runScan(['--terms', termsFile(t), '--allow', allowPath, 'tree', 'HEAD'], { cwd: dir });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^ERROR bad-allow list=allow line=1$/m);
});

// ---------------------------------------------------------------------------
// SD-7 (lists must live outside the scanned tree) -- M1, M3
// ---------------------------------------------------------------------------

test('SD-7: a list inside the repo is refused; the same list outside is accepted (paired control)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'Zorbleflenn appears\n');
  commitAll(dir, 'one');

  const inRepoList = path.join(dir, 'terms.txt');
  fs.writeFileSync(inRepoList, TERMS_TEXT);
  const insideResult = runScan(['--terms', inRepoList, 'tree', 'HEAD'], { cwd: dir });
  assert.equal(insideResult.code, 2);
  assert.match(insideResult.stderr, /^ERROR list-in-repo list=terms$/m);

  const outsideResult = runScan(['--terms', termsFile(t), 'tree', 'HEAD'], { cwd: dir });
  assert.equal(outsideResult.code, 1);
});

test('M3 (string-prefix sibling): a list in the sibling dir <repo>-lists/ is accepted, not refused', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'Zorbleflenn appears\n');
  commitAll(dir, 'one');
  const siblingDir = `${dir}-lists`;
  fs.mkdirSync(siblingDir);
  t.after(() => fs.rmSync(siblingDir, { recursive: true, force: true }));
  const siblingList = path.join(siblingDir, 'terms.txt');
  fs.writeFileSync(siblingList, TERMS_TEXT);
  const result = runScan(['--terms', siblingList, 'tree', 'HEAD'], { cwd: dir });
  assert.equal(result.code, 1, 'a naive startsWith(repoRoot) guard would wrongly refuse this sibling-prefixed path');
});

test('M3 (string-prefix sibling, allow side): an allow for a.md must not suppress a.md.orig', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'Zorbleflenn appears\n');
  fs.writeFileSync(path.join(dir, 'a.md.orig'), 'Quixnabber appears\n');
  commitAll(dir, 'one');
  const allowPath = scratchFile(t, 'allow.txt', 'path a.md -- test fixture\n');
  const result = runScan(['--terms', termsFile(t), '--allow', allowPath, 'tree', 'HEAD'], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HIT 1 a\.md\.orig term=1$/m);
  assert.match(result.stdout, /^ALLOWED 1 a\.md$/m);
});

// ---------------------------------------------------------------------------
// AC-07 (env vars)
// ---------------------------------------------------------------------------

test('env vars are used when the flag is absent; a flag replaces (does not merge with) its env var (M20 control)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'Zorbleflenn appears\n');
  commitAll(dir, 'one');

  const envOnlyTerms = scratchFile(t, 'env-terms.txt', 'Zorbleflenn\n');
  const flagTerms = scratchFile(t, 'flag-terms.txt', 'SomethingElseEntirely\n');

  const viaEnv = runScan(['tree', 'HEAD'], { cwd: dir, env: baseEnv({ SCRIPTORIUM_DENYLIST_TERMS: envOnlyTerms }) });
  assert.equal(viaEnv.code, 1, 'env var must be used when --terms is absent');

  const flagReplacesEnv = runScan(['--terms', flagTerms, 'tree', 'HEAD'], {
    cwd: dir,
    env: baseEnv({ SCRIPTORIUM_DENYLIST_TERMS: envOnlyTerms }),
  });
  assert.equal(flagReplacesEnv.code, 0, 'the flag must REPLACE the env var, not merge with it -- SomethingElseEntirely never appears, so Zorbleflenn must not be checked via env too');
});

// ---------------------------------------------------------------------------
// AC-08 (output determinism)
// ---------------------------------------------------------------------------

test('HIT and TOTAL lines are sorted by label and deterministic across repeated runs', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'zzz.md'), 'Zorbleflenn\n');
  fs.writeFileSync(path.join(dir, 'aaa.md'), 'Quixnabber\n');
  commitAll(dir, 'one');
  const first = runScan(['--terms', termsFile(t), 'tree', 'HEAD'], { cwd: dir });
  const second = runScan(['--terms', termsFile(t), 'tree', 'HEAD'], { cwd: dir });
  assert.equal(first.stdout, second.stdout);
  const hitLines = first.stdout.split('\n').filter((l) => l.startsWith('HIT'));
  assert.deepEqual(
    hitLines.map((l) => l.split(' ')[2]),
    ['aaa.md', 'zzz.md'],
  );
});

test('--lines gives the correct line numbers (M9-adjacent correctness check)', (t) => {
  const dir = initRepo(t);
  fs.writeFileSync(path.join(dir, 'notes.md'), ['line one, nothing here', 'line two has Zorbleflenn in it', 'line three, also nothing', 'line four has Zorbleflenn again'].join('\n') + '\n');
  commitAll(dir, 'one');
  const result = runScan(['--terms', termsFile(t), '--lines', 'tree', 'HEAD'], { cwd: dir });
  assert.match(result.stdout, /^LINE 1 notes\.md:2 term=1$/m);
  assert.match(result.stdout, /^LINE 1 notes\.md:4 term=1$/m);
});

// ---------------------------------------------------------------------------
// maskLabel / isInside direct unit coverage
// ---------------------------------------------------------------------------

test('maskLabel replaces a matched span with [<category>], leaving the rest untouched', () => {
  const { entries } = parseTermList('Zorbleflenn');
  const matcher = buildMatcher(entries, { match: 'word' });
  assert.equal(maskLabel('the-Zorbleflenn-file.md', matcher), 'the-[term]-file.md');
  assert.equal(maskLabel('nothing-sensitive.md', matcher), 'nothing-sensitive.md');
});

test('isInside: exact realpath containment, not a string prefix', (t) => {
  const parent = mkTmp(t, 'scriptorium-denylist-isinside-parent-');
  const childDir = path.join(parent, 'child');
  fs.mkdirSync(childDir);
  const childFile = path.join(childDir, 'f.txt');
  fs.writeFileSync(childFile, 'x');
  assert.equal(isInside(childFile, parent), true);

  const siblingParent = `${parent}-lists`;
  fs.mkdirSync(siblingParent);
  t.after(() => fs.rmSync(siblingParent, { recursive: true, force: true }));
  const siblingFile = path.join(siblingParent, 'f.txt');
  fs.writeFileSync(siblingFile, 'x');
  assert.equal(isInside(siblingFile, parent), false, 'a naive startsWith(parent) would wrongly say true here');
});

// ---------------------------------------------------------------------------
// -h/--help
// ---------------------------------------------------------------------------

test('-h/--help prints usage and exits 0, without needing any list', () => {
  const result = runScan(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /usage: denylist-scan\.js/);
});
