'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const guard = require('../scripts/public-guard');
const {
  run,
  LIST_FILE_NAMES,
  NAMED_FONT_RESIDUAL,
  NAMED_IMAGE_RESIDUAL,
  deriveVendorEntry,
  VENDOR_PIN_DIR,
  parsePushLines,
  forbiddenPathCount,
  validateStandingAllow,
} = guard;
const {
  buildMatcher: dsBuildMatcher,
  countInBuffer: dsCountInBuffer,
  parseTermList: dsParseTermList,
} = require('../scripts/denylist-scan');

/*
 * Amendment S, S.5 (docs/agent-runs/s4-engineering-brief-2026-09-30.md). Synthetic-only
 * (NFR-11): every term/pattern/allow/identity value below is invented for this test file; none
 * is a real withheld name, path, IP or list file. SD-S7: every test runs in a temp repo with
 * GIT_CONFIG_GLOBAL/NOSYSTEM isolated, `scriptorium.privacyLists` set LOCALLY (never globally)
 * to a temp directory of synthetic lists, and cwd is never inside the real repository. No test
 * reads the real lists; `grep -c` on them (never `cat`) is the only thing this run did outside
 * this file, and only to confirm shape, per SC-2.
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
  const dir = mkTmp(t, 'scriptorium-guard-repo-');
  git(['init', '--quiet', dir], dir);
  return dir;
}

function revParse(dir, rev, env = ISOLATED_ENV_BASE) {
  return execFileSync('git', ['rev-parse', rev], { cwd: dir, env }).toString('utf8').trim();
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

// Synthetic setup, per S.5, verbatim.
const TERM_ZORBLAX = 'Zorblax';
const TERM_LANTERN = 'lantern';
const IDENTITY_NAME = 'Quill Synthetic';
const IDENTITY_EMAIL = 'quill@example.invalid';

function listsText() {
  return {
    terms: [TERM_ZORBLAX, TERM_LANTERN, ''].join('\n'),
    patterns: [`literal name ${IDENTITY_NAME}`, `literal email ${IDENTITY_EMAIL}`, ''].join('\n'),
    allow: [`term ${TERM_LANTERN} -- generic noun: test`, ''].join('\n'),
  };
}

function writeLists(t, overrides = {}) {
  const dir = mkTmp(t, 'scriptorium-guard-lists-');
  const texts = { ...listsText(), ...overrides };
  fs.writeFileSync(path.join(dir, LIST_FILE_NAMES.terms), texts.terms);
  fs.writeFileSync(path.join(dir, LIST_FILE_NAMES.patterns), texts.patterns);
  fs.writeFileSync(path.join(dir, LIST_FILE_NAMES.allow), texts.allow);
  return dir;
}

function configureLists(dir, listsDir, env = ISOLATED_ENV_BASE) {
  execFileSync('git', ['config', 'scriptorium.privacyLists', listsDir], { cwd: dir, env });
}

function baseEnv(overrides = {}) {
  return { ...ISOLATED_ENV_BASE, ...overrides };
}

function runGuard(argv, { cwd, env = baseEnv(), stdin, publicRoot, scanRun, fontResidual, imageResidual } = {}) {
  const stdout = makeSink();
  const stderr = makeSink();
  const opts = { cwd, env, stdout, stderr };
  if (stdin !== undefined) opts.stdin = stdin;
  if (publicRoot !== undefined) opts.publicRoot = publicRoot;
  if (scanRun !== undefined) opts.scanRun = scanRun;
  if (fontResidual !== undefined) opts.fontResidual = fontResidual;
  if (imageResidual !== undefined) opts.imageResidual = imageResidual;
  const code = run(argv, opts);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** Builds one pre-push stdin line per the hook contract: `<local ref> SP <local oid> SP
 * <remote ref> SP <remote oid>`. */
function pushLine(localOid, remoteOid, { localRef = 'refs/heads/main', remoteRef = 'refs/heads/main' } = {}) {
  return `${localRef} ${localOid} ${remoteRef} ${remoteOid}\n`;
}

function commitIdentity(dir, message, env = ISOLATED_ENV_BASE) {
  execFileSync('git', ['add', '-A'], { cwd: dir, env, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', `user.name=${IDENTITY_NAME}`, '-c', `user.email=${IDENTITY_EMAIL}`, '-c', 'commit.gpgsign=false', 'commit', '-m', message, '--quiet', '--allow-empty'],
    { cwd: dir, env, stdio: 'pipe' },
  );
}

/** Commits with the plain `Test <test@example.invalid>` identity (IDENTITY_ARGS, via the `git()`
 * helper) -- NOT the synthetic `Quill Synthetic` identity `commitIdentity` uses, which matches
 * the patterns list's own `literal name`/`literal email` entries. Guard-mode tests (ci/pre-push/
 * release, below) that aren't specifically about the identity residual use this, so a commit
 * message row never also carries an incidental identity hit that would change RESIDUAL/UNCLASSED
 * counts for reasons unrelated to what the test is actually proving. */
function commitPlain(dir, message, env = ISOLATED_ENV_BASE) {
  git(['add', '-A'], dir, env);
  git(['commit', '-m', message, '--quiet', '--allow-empty'], dir, env);
}

// A root commit ("base", excluded from every range below) plus two further commits, both
// authored/committed as the synthetic identity, with no listed content -- the T-S1 fixture.
function setupTwoCleanCommits(t) {
  const dir = initRepo(t);
  const listsDir = writeLists(t);
  configureLists(dir, listsDir);
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  commitIdentity(dir, 'first clean commit');
  commitIdentity(dir, 'second clean commit');
  const head = revParse(dir, 'HEAD');
  return { dir, listsDir, base, head };
}

function fakeScanRunReporting(commitsLine) {
  return (argv, { stdout }) => {
    stdout.write('MODE commits 1 targets\n');
    stdout.write('ENTRIES terms=2 patterns=2 allow=1\n');
    stdout.write(`COMMITS ${commitsLine}\n`);
    stdout.write('TOTAL hits=0 targets=0 scanned=0 allowed=0 missing=0 symlinks=0 unused-allow=0\n');
    return 0;
  };
}

// ---------------------------------------------------------------------------
// S.5 table: T-S1 to T-S14
// ---------------------------------------------------------------------------

test('T-S1: two clean commits give RESIDUAL identity=8 commits=2 history=private, UNCLASSED 0, exit 0', (t) => {
  const { dir, base, head } = setupTwoCleanCommits(t);
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^RESIDUAL identity=8 commits=2 history=private$/m);
  assert.match(result.stdout, /^UNCLASSED 0$/m);
  assert.match(result.stdout, /^VERDICT pass$/m);
});

test('T-S2: a commit adding Zorblax gives UNCLASSED 1 and exit 1', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  commitIdentity(dir, `mentions ${TERM_ZORBLAX} in the message`);
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^UNCLASSED 1$/m);
  assert.match(result.stdout, /^VERDICT block$/m);
});

test('T-S3: a commit adding lantern is ALLOWED, with exit 0', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  commitIdentity(dir, `mentions ${TERM_LANTERN} in the message`);
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^ALLOWED 1 /m);
  assert.match(result.stdout, /^UNCLASSED 0$/m);
});

test('T-S4: the scanner ENTRIES counts equal the LISTS counts (2/2/1)', (t) => {
  const { dir, base, head } = setupTwoCleanCommits(t);
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir });
  assert.match(result.stdout, /^LISTS terms=2 patterns=2 allow=1 fp=[0-9a-f]{12}$/m);
  assert.match(result.stdout, /^ENTRIES terms=2 patterns=2 allow=1$/m);
});

test('T-S5: SCRIPTORIUM_DENYLIST_PATTERNS env is ignored; output equals T-S1 plus NOTE ignored-env=1', (t) => {
  const { dir, base, head } = setupTwoCleanCommits(t);
  const baseline = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir });

  const altDir = mkTmp(t, 'scriptorium-guard-altpatterns-');
  const altPatternsFile = path.join(altDir, 'alt-patterns.txt');
  fs.writeFileSync(altPatternsFile, 'literal other SomethingElseEntirely\n');

  const withEnv = runGuard(['scan', 'commits', `${base}..${head}`], {
    cwd: dir,
    env: baseEnv({ SCRIPTORIUM_DENYLIST_PATTERNS: altPatternsFile }),
  });

  assert.equal(withEnv.code, baseline.code);
  const withoutNote = withEnv.stdout
    .split('\n')
    .filter((l) => !l.startsWith('NOTE '))
    .join('\n');
  assert.equal(withoutNote, baseline.stdout);
  assert.match(withEnv.stdout, /^NOTE ignored-env=1$/m);
});

test('T-S6: a swapped range gives exit 2 empty-range', (t) => {
  const { dir, base, head } = setupTwoCleanCommits(t);
  const result = runGuard(['scan', 'commits', `${head}..${base}`], { cwd: dir });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^ERROR empty-range$/m);
});

test('T-S7: a message body naming the identity breaks the identity-only shape: UNCLASSED 1, exit 1', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  commitIdentity(dir, `mentions ${IDENTITY_NAME} right here in the body`);
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HIT 5 [0-9a-f]{12}:message email=2,name=3$/m);
  assert.match(result.stdout, /^UNCLASSED 1$/m);
});

test('T-S8: history=public when publicRoot is injected as the repo\'s own root; exit 1', (t) => {
  const { dir, base, head } = setupTwoCleanCommits(t);
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir, publicRoot: base });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^RESIDUAL identity=8 commits=2 history=public$/m);
  assert.match(result.stdout, /^VERDICT block$/m);
});

test('T-S9: a depth-1 clone of the T-S8 repo gives exit 2 shallow', (t) => {
  const { dir, base, head } = setupTwoCleanCommits(t);
  const shallowDir = mkTmp(t, 'scriptorium-guard-shallow-');
  execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${dir}`, shallowDir], { env: ISOLATED_ENV_BASE });
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: shallowDir, publicRoot: base });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^ERROR shallow$/m);
});

test('T-S10: changing one byte in a list changes fp; identical files give the same fp', (t) => {
  const dir = initRepo(t);
  commitIdentity(dir, 'base');

  configureLists(dir, writeLists(t));
  const r1 = runGuard(['check-allow'], { cwd: dir });
  const fp1 = /fp=([0-9a-f]{12})/.exec(r1.stdout)[1];

  configureLists(dir, writeLists(t)); // byte-identical copy, different directory
  const r2 = runGuard(['check-allow'], { cwd: dir });
  const fp2 = /fp=([0-9a-f]{12})/.exec(r2.stdout)[1];
  assert.equal(fp1, fp2);

  configureLists(dir, writeLists(t, { terms: listsText().terms + 'ExtraTermXYZ\n' }));
  const r3 = runGuard(['check-allow'], { cwd: dir });
  const fp3 = /fp=([0-9a-f]{12})/.exec(r3.stdout)[1];
  assert.notEqual(fp1, fp3);
});

test('T-S11: a sentinel string embedded in the lists-directory name never leaks into stdout or stderr', (t) => {
  const sentinel = 'ZorblaxSentinelMarker';
  const dir = initRepo(t);
  commitIdentity(dir, 'base');
  const head = revParse(dir, 'HEAD');
  const runs = [];

  function sentinelDir(suffix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `${sentinel}-${suffix}-`));
    t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
  }
  function writeListsInto(d, overrides = {}) {
    const texts = { ...listsText(), ...overrides };
    fs.writeFileSync(path.join(d, LIST_FILE_NAMES.terms), texts.terms);
    fs.writeFileSync(path.join(d, LIST_FILE_NAMES.patterns), texts.patterns);
    fs.writeFileSync(path.join(d, LIST_FILE_NAMES.allow), texts.allow);
  }

  // no-lists
  runs.push(runGuard(['scan', 'tree', head], { cwd: dir }));

  // list-missing
  configureLists(dir, sentinelDir('missing'));
  runs.push(runGuard(['scan', 'tree', head], { cwd: dir }));

  // list-in-repo
  const inRepo = path.join(dir, `${sentinel}-inrepo`);
  fs.mkdirSync(inRepo);
  writeListsInto(inRepo);
  configureLists(dir, inRepo);
  runs.push(runGuard(['scan', 'tree', head], { cwd: dir }));

  // bad-list
  const badList = sentinelDir('badlist');
  writeListsInto(badList, { patterns: 'this is not a valid pattern line\n' });
  configureLists(dir, badList);
  runs.push(runGuard(['scan', 'tree', head], { cwd: dir }));

  // list-empty
  const emptyList = sentinelDir('empty');
  writeListsInto(emptyList, { patterns: '# nothing here\n' });
  configureLists(dir, emptyList);
  runs.push(runGuard(['scan', 'tree', head], { cwd: dir }));

  // identity-patterns-missing
  const noEmail = sentinelDir('noemail');
  writeListsInto(noEmail, { patterns: `literal name ${IDENTITY_NAME}\n` });
  configureLists(dir, noEmail);
  runs.push(runGuard(['scan', 'tree', head], { cwd: dir }));

  // bad-allow
  const badAllow = sentinelDir('badallow');
  writeListsInto(badAllow, { allow: 'path some/file.md -- not permitted\n' });
  configureLists(dir, badAllow);
  runs.push(runGuard(['scan', 'tree', head], { cwd: dir }));

  // usage
  runs.push(runGuard(['scan', '--patterns', path.join(dir, 'x'), 'tree', head], { cwd: dir }));

  const combined = runs.map((r) => `${r.stdout}\n${r.stderr}`).join('\n');
  assert.equal(combined.toLowerCase().includes(sentinel.toLowerCase()), false, 'sentinel leaked into output');
  for (const r of runs) assert.equal(r.code, 2, 'every case here must be a fail-closed error');
});

test('T-S12: pre-push shares the loader; no-lists plus requireLists=true exits 1 (paired control: requireLists unset exits 0)', (t) => {
  const dir = initRepo(t);
  commitIdentity(dir, 'base');
  const listsDir = writeLists(t); // only reachable via env vars, which must never satisfy the loader
  const envWithStaleVars = baseEnv({
    SCRIPTORIUM_DENYLIST_TERMS: path.join(listsDir, LIST_FILE_NAMES.terms),
    SCRIPTORIUM_DENYLIST_PATTERNS: path.join(listsDir, LIST_FILE_NAMES.patterns),
    SCRIPTORIUM_DENYLIST_ALLOW: path.join(listsDir, LIST_FILE_NAMES.allow),
  });

  const skipped = runGuard(['pre-push', 'origin', 'https://example.invalid/repo.git'], { cwd: dir, env: envWithStaleVars });
  assert.equal(skipped.code, 0);
  assert.match(skipped.stdout, /^NOTE private list scan skipped$/m);

  execFileSync('git', ['config', 'scriptorium.requireLists', 'true'], { cwd: dir, env: ISOLATED_ENV_BASE });
  const required = runGuard(['pre-push', 'origin', 'https://example.invalid/repo.git'], { cwd: dir, env: envWithStaleVars });
  assert.equal(required.code, 1);
  assert.match(required.stderr, /^ERROR no-lists$/m);
});

test('T-S13: an injected scanRun reporting a wrong COMMITS count gives exit 2 count-mismatch', (t) => {
  const { dir, base, head } = setupTwoCleanCommits(t);
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir, scanRun: fakeScanRunReporting(3) });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^ERROR count-mismatch$/m);
});

test('T-S14: one case per SD-S3 code', (t) => {
  const dir = initRepo(t);
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  commitIdentity(dir, 'second');
  const head = revParse(dir, 'HEAD');

  {
    const r = runGuard(['scan', '--patterns', '/nonexistent', 'tree', head], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR usage$/m);
  }
  {
    const shallowDir = mkTmp(t, 'scriptorium-guard-shallow2-');
    execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${dir}`, shallowDir], { env: ISOLATED_ENV_BASE });
    const r = runGuard(['scan', 'tree', head], { cwd: shallowDir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR shallow$/m);
  }
  {
    const r = runGuard(['scan', 'tree', head], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR no-lists$/m);
  }
  {
    configureLists(dir, mkTmp(t, 'scriptorium-guard-missing2-'));
    const r = runGuard(['scan', 'tree', head], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR list-missing kind=terms$/m);
  }
  {
    const inRepo = path.join(dir, 'inrepo-lists2');
    fs.mkdirSync(inRepo);
    const texts = listsText();
    fs.writeFileSync(path.join(inRepo, LIST_FILE_NAMES.terms), texts.terms);
    fs.writeFileSync(path.join(inRepo, LIST_FILE_NAMES.patterns), texts.patterns);
    fs.writeFileSync(path.join(inRepo, LIST_FILE_NAMES.allow), texts.allow);
    configureLists(dir, inRepo);
    const r = runGuard(['scan', 'tree', head], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR list-in-repo kind=terms$/m);
  }
  {
    configureLists(dir, writeLists(t, { patterns: 'bogus line here\n' }));
    const r = runGuard(['scan', 'tree', head], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR bad-list kind=patterns$/m);
  }
  {
    configureLists(dir, writeLists(t, { patterns: '# nothing\n' }));
    const r = runGuard(['scan', 'tree', head], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR list-empty$/m);
  }
  {
    configureLists(dir, writeLists(t, { patterns: `literal name ${IDENTITY_NAME}\n` }));
    const r = runGuard(['scan', 'tree', head], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR identity-patterns-missing$/m);
  }
  {
    configureLists(dir, writeLists(t, { allow: 'path some/file.md -- nope\n' }));
    const r = runGuard(['scan', 'tree', head], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR bad-allow$/m);
    assert.match(r.stderr, /^path-entry=1 not-in-list=0$/m);
  }
  {
    configureLists(dir, writeLists(t));
    const r = runGuard(['scan', 'commits', `${head}..${base}`], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR empty-range$/m);
  }
  {
    configureLists(dir, writeLists(t));
    const r = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir, scanRun: fakeScanRunReporting(99) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR count-mismatch$/m);
  }
});

// ---------------------------------------------------------------------------
// Amendment F, option (b): T-F1 to T-F5
// ---------------------------------------------------------------------------

function fontBytesWithTerm(term) {
  // "wOF2"-magic-shaped: a NUL-bearing buffer (SD-5's dual-decode arm) with the synthetic term
  // present once, as UTF-8 bytes.
  return Buffer.concat([Buffer.from([0x77, 0x4f, 0x46, 0x32]), Buffer.alloc(4), Buffer.from(term, 'utf8')]);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function expectedHitCount(bytes, term) {
  const matcher = dsBuildMatcher(dsParseTermList(term).entries, { match: 'word' });
  return dsCountInBuffer(bytes, matcher).total;
}

test('T-F1: matching path and sha give RESIDUAL font-binary and UNCLASSED 0 (tree mode)', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const relPath = 'assets/themes/gloam/fonts/Synthetic.woff2';
  const bytes = fontBytesWithTerm(TERM_ZORBLAX);
  fs.mkdirSync(path.join(dir, path.dirname(relPath)), { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), bytes);
  commitIdentity(dir, 'add font');
  const head = revParse(dir, 'HEAD');
  const table = [{ path: relPath, sha256: sha256Hex(bytes) }];
  const result = runGuard(['scan', 'tree', head], { cwd: dir, fontResidual: table });
  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`^RESIDUAL font-binary=${expectedHitCount(bytes, TERM_ZORBLAX)} files=1$`, 'm'));
  assert.match(result.stdout, /^UNCLASSED 0$/m);
});

test('T-F2: same path, one byte changed in the committed file gives UNCLASSED 1', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const relPath = 'assets/themes/gloam/fonts/Synthetic.woff2';
  const bytes = fontBytesWithTerm(TERM_ZORBLAX);
  fs.mkdirSync(path.join(dir, path.dirname(relPath)), { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), bytes);
  commitIdentity(dir, 'add font');
  const head = revParse(dir, 'HEAD');
  const wrongSha = sha256Hex(Buffer.concat([bytes, Buffer.from([0x00])]));
  const result = runGuard(['scan', 'tree', head], { cwd: dir, fontResidual: [{ path: relPath, sha256: wrongSha }] });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^UNCLASSED 1$/m);
});

test('T-F3: identical bytes at a different path with the same basename give UNCLASSED 1 (no basename match)', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const bytes = fontBytesWithTerm(TERM_ZORBLAX);
  const actualPath = 'other/dir/Synthetic.woff2';
  fs.mkdirSync(path.join(dir, 'other', 'dir'), { recursive: true });
  fs.writeFileSync(path.join(dir, actualPath), bytes);
  commitIdentity(dir, 'add font elsewhere');
  const head = revParse(dir, 'HEAD');
  const table = [{ path: 'assets/themes/gloam/fonts/Synthetic.woff2', sha256: sha256Hex(bytes) }];
  const result = runGuard(['scan', 'tree', head], { cwd: dir, fontResidual: table });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^UNCLASSED 1$/m);
});

test('T-F4: commits mode classifies a commit that adds the matching font file', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  const relPath = 'assets/themes/gloam/fonts/Synthetic.woff2';
  const bytes = fontBytesWithTerm(TERM_ZORBLAX);
  fs.mkdirSync(path.join(dir, path.dirname(relPath)), { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), bytes);
  commitIdentity(dir, 'add font');
  const head = revParse(dir, 'HEAD');
  const table = [{ path: relPath, sha256: sha256Hex(bytes) }];
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir, fontResidual: table });
  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`^RESIDUAL font-binary=${expectedHitCount(bytes, TERM_ZORBLAX)} files=1$`, 'm'));
  assert.match(result.stdout, /^UNCLASSED 0$/m);
});

test('T-F5: the real NAMED_FONT_RESIDUAL sha256 values equal the values in gloam-FONTS.json / FONTS.json', () => {
  const gloamManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'vendor', 'fonts', 'gloam-FONTS.json'), 'utf8'));
  const adminManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'vendor', 'fonts', 'FONTS.json'), 'utf8'));
  assert.ok(NAMED_FONT_RESIDUAL.length > 0, 'the measured font residual table must not be empty');
  for (const entry of NAMED_FONT_RESIDUAL) {
    const basename = path.basename(entry.path);
    const manifestEntry = gloamManifest.files.find((f) => f.file === basename) || adminManifest.files.find((f) => f.file === basename);
    assert.ok(manifestEntry, `${entry.path}: no manifest entry for ${basename}`);
    assert.equal(entry.sha256, manifestEntry.sha256, `${entry.path}: sha256 must equal the manifest value`);
    // independent cross-check: the file on disk must still be the manifest's own bytes.
    const onDiskPath = path.join(__dirname, '..', entry.path);
    const onDiskSha = sha256Hex(fs.readFileSync(onDiskPath));
    assert.equal(onDiskSha, entry.sha256, `${entry.path}: disk bytes must match NAMED_FONT_RESIDUAL's sha256`);
  }
});

// ---------------------------------------------------------------------------
// s5-architect-2026-10-01.md A.3: image-binary, T-I1 to T-I7
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);

function pngBytesWithTerm(term) {
  return Buffer.concat([PNG_SIG, Buffer.alloc(4), Buffer.from(term, 'utf8')]);
}

function textBytesWithTerm(term) {
  // Deliberately NUL-bearing, same binary-decode path as the image fixtures, but with no PNG/
  // JPEG signature at all (T-I4: a pinned path+sha with no signature is never image-binary).
  return Buffer.concat([Buffer.from('not a picture'), Buffer.alloc(2), Buffer.from(term, 'utf8')]);
}

function walkForImages(absDir, relRoot, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relPath = `${relRoot}/${entry.name}`;
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      walkForImages(absPath, relPath, out);
    } else if (/\.(png|jpe?g)$/.test(entry.name)) {
      out.push(relPath);
    }
  }
}

test('T-I1: a matching path, sha and signature under examples/ gives RESIDUAL image-binary and UNCLASSED 0', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const relPath = 'examples/pic.png';
  const bytes = pngBytesWithTerm(TERM_ZORBLAX);
  fs.mkdirSync(path.join(dir, 'examples'), { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), bytes);
  commitIdentity(dir, 'add image');
  const head = revParse(dir, 'HEAD');
  const table = [{ path: relPath, sha256: sha256Hex(bytes) }];
  const result = runGuard(['scan', 'tree', head], { cwd: dir, imageResidual: table });
  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`^RESIDUAL image-binary=${expectedHitCount(bytes, TERM_ZORBLAX)} files=1$`, 'm'));
  assert.match(result.stdout, /^UNCLASSED 0$/m);
});

test('T-I2: same path, one byte changed in the committed file gives UNCLASSED 1', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const relPath = 'examples/pic.png';
  const bytes = pngBytesWithTerm(TERM_ZORBLAX);
  fs.mkdirSync(path.join(dir, 'examples'), { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), bytes);
  commitIdentity(dir, 'add image');
  const head = revParse(dir, 'HEAD');
  const wrongSha = sha256Hex(Buffer.concat([bytes, Buffer.from([0x00])]));
  const result = runGuard(['scan', 'tree', head], { cwd: dir, imageResidual: [{ path: relPath, sha256: wrongSha }] });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^UNCLASSED 1$/m);
});

test('T-I3: a row outside the table path never classifies, by basename collision (other/) or root-segment collision (examplesX/)', (t) => {
  // One VALID table entry throughout ("examples/pic.png" -- a real root, so load-time
  // validation never objects); both sub-cases are about the SCANNED FILE sitting somewhere
  // else entirely, which validation never looks at (it only validates table entries, A.3's
  // "Validation at load"). Each must stay UNCLASSED on an exact-path miss alone.
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const bytes = pngBytesWithTerm(TERM_ZORBLAX);
  const table = [{ path: 'examples/pic.png', sha256: sha256Hex(bytes) }];

  // other/ -- same basename, a root nothing is pinned under at all.
  fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'other', 'pic.png'), bytes);
  // examplesX/ -- shares the STRING prefix "examples" with the real root but is a sibling
  // directory, not a path segment under it (Ib3's red line: a `startsWith('examples')` root
  // check would wrongly treat this as "under examples").
  fs.mkdirSync(path.join(dir, 'examplesX'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'examplesX', 'pic.png'), bytes);
  commitIdentity(dir, 'add both');
  const head = revParse(dir, 'HEAD');

  // Each sub-case is scanned with a pathspec restricting to its own directory (denylist-scan's
  // own `tree <rev> -- <pathspec>` support), so the two fixtures don't both land in the same
  // scan and inflate UNCLASSED for reasons unrelated to what this test is proving.
  const otherResult = runGuard(['scan', 'tree', head, '--', 'other'], { cwd: dir, imageResidual: table });
  assert.equal(otherResult.code, 1);
  assert.match(otherResult.stdout, /^UNCLASSED 1$/m);

  const examplesXResult = runGuard(['scan', 'tree', head, '--', 'examplesX'], { cwd: dir, imageResidual: table });
  assert.equal(examplesXResult.code, 1);
  assert.match(examplesXResult.stdout, /^UNCLASSED 1$/m);
});

test('T-I4: a table entry whose blob has no image signature is never image-binary', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const relPath = 'examples/not-a-picture.png';
  const bytes = textBytesWithTerm(TERM_ZORBLAX);
  fs.mkdirSync(path.join(dir, 'examples'), { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), bytes);
  commitIdentity(dir, 'add fake image');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', 'tree', head], { cwd: dir, imageResidual: [{ path: relPath, sha256: sha256Hex(bytes) }] });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^UNCLASSED 1$/m);
});

test('T-I5: commits mode classifies a commit that adds the matching image file', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  const relPath = 'docs/images/pic.jpg';
  const bytes = pngBytesWithTerm(TERM_ZORBLAX); // signature check only cares about the magic bytes present; JPEG covered by production code, PNG magic reused here for the fixture
  fs.mkdirSync(path.join(dir, 'docs', 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), bytes);
  commitIdentity(dir, 'add image');
  const head = revParse(dir, 'HEAD');
  const table = [{ path: relPath, sha256: sha256Hex(bytes) }];
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir, imageResidual: table });
  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`^RESIDUAL image-binary=${expectedHitCount(bytes, TERM_ZORBLAX)} files=1$`, 'm'));
  assert.match(result.stdout, /^UNCLASSED 0$/m);
});

test('T-I5b: commits mode, an untabled first version then the tabled version: only the second commit classifies', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  const relPath = 'examples/pic.png';
  fs.mkdirSync(path.join(dir, 'examples'), { recursive: true });

  const v1 = pngBytesWithTerm(TERM_ZORBLAX);
  fs.writeFileSync(path.join(dir, relPath), v1);
  commitIdentity(dir, 'add v1');
  const afterV1 = revParse(dir, 'HEAD');

  // A space, not a bare letter/digit, after "Zorblax": appending plain letters would fuse into
  // one longer token ("Zorblaxv2") that word-mode correctly stops matching -- a fixture bug this
  // test found in itself, not a scanner bug.
  const v2 = Buffer.concat([v1, Buffer.from(' v2', 'utf8')]);
  fs.writeFileSync(path.join(dir, relPath), v2);
  commitIdentity(dir, 'replace with v2');
  const head = revParse(dir, 'HEAD');

  const table = [{ path: relPath, sha256: sha256Hex(v2) }]; // only v2 is pinned
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir, imageResidual: table });
  assert.equal(result.code, 1); // v1's row stays UNCLASSED
  const hitRows = result.stdout.split('\n').filter((l) => l.startsWith('HIT') && l.includes(`:${relPath}`));
  assert.equal(hitRows.length, 2, 'expected one HIT row per commit\'s own image-path target');
  assert.match(result.stdout, /^UNCLASSED 1$/m);

  const afterV1Sha12 = afterV1.slice(0, 12);
  const headSha12 = head.slice(0, 12);
  const v1Row = hitRows.find((l) => l.includes(`${afterV1Sha12}:${relPath}`));
  const v2Row = hitRows.find((l) => l.includes(`${headSha12}:${relPath}`));
  assert.ok(v1Row, 'expected a HIT row for the first commit\'s image target');
  assert.ok(v2Row, 'expected a HIT row for the second commit\'s image target');
});

test('T-I6: every validation case gives exit 2 bad-residual, and the path is never printed', (t) => {
  const sentinel = 'ZorblaxImageSentinel';
  const dir = initRepo(t);
  commitIdentity(dir, 'base');
  const head = revParse(dir, 'HEAD');

  const goodSha = sha256Hex(pngBytesWithTerm(TERM_ZORBLAX));
  const cases = [
    [{ path: `${sentinel}/outside-root.png`, sha256: goodSha }], // outside the roots
    [{ path: `examples/../${sentinel}.png`, sha256: goodSha }], // '..'
    [{ path: `examples/${sentinel}.png`, sha256: 'not-a-sha' }], // bad sha
    [
      { path: `examples/${sentinel}-a.png`, sha256: goodSha },
      { path: `examples/${sentinel}-a.png`, sha256: goodSha },
    ], // duplicate path
    [{ path: `examples/${sentinel}.PNG`, sha256: goodSha }], // wrong-case extension
    // outside the roots, but a STRING-prefix sibling of "examples" rather than an unrelated
    // name (Ib3's red line: a `startsWith('examples')` root check would wrongly accept this).
    [{ path: `examplesX${sentinel}/pic.png`, sha256: goodSha }],
  ];

  const runs = [];
  for (const table of cases) {
    runs.push(runGuard(['scan', 'tree', head], { cwd: dir, imageResidual: table }));
  }

  for (const r of runs) {
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR bad-residual kind=image index=\d+$/m);
  }
  const combined = runs.map((r) => `${r.stdout}\n${r.stderr}`).join('\n');
  assert.equal(combined.toLowerCase().includes(sentinel.toLowerCase()), false, 'sentinel leaked into output');
});

// Independent of guard.IMAGE_RESIDUAL_ROOTS (not imported, so this list is never derived from
// the code under test): the two roots A.3 names.
const IMAGE_RESIDUAL_ROOTS_FOR_TEST = ['examples', 'docs/images'];

test('T-I7: the real repository -- table paths equal the on-disk image set, shas match disk and PROVENANCE.md', () => {
  const repoRoot = path.join(__dirname, '..');
  const onDisk = [];
  for (const root of IMAGE_RESIDUAL_ROOTS_FOR_TEST) {
    const abs = path.join(repoRoot, ...root.split('/'));
    if (!fs.existsSync(abs)) continue;
    walkForImages(abs, root, onDisk);
  }
  assert.deepEqual(
    onDisk.slice().sort(),
    NAMED_IMAGE_RESIDUAL.map((r) => r.path).sort(),
    'every committed image under examples/ and docs/images/ is named in NAMED_IMAGE_RESIDUAL, and nothing else is',
  );
  const provenanceText = fs.readFileSync(path.join(repoRoot, 'docs', 'PROVENANCE.md'), 'utf8');
  for (const entry of NAMED_IMAGE_RESIDUAL) {
    const bytes = fs.readFileSync(path.join(repoRoot, entry.path));
    assert.equal(sha256Hex(bytes), entry.sha256);
    assert.ok(provenanceText.includes(entry.sha256), `${entry.path}: sha256 must appear in PROVENANCE.md`);
  }
});

// ---------------------------------------------------------------------------
// Amendment V, V.1 (S4-1): vendor-binary, T-V1 to T-V10
//
// Unlike the font/image tables, the vendor path-to-sha256 table is never a literal: it is
// derived, per revision, from that revision's own PIN.json plus its SHA256SUMS (deriveVendorEntry
// below). Every fixture here commits a synthetic PIN.json/SHA256SUMS pair alongside a synthetic
// "tarball" (gzip-magic bytes, 1f 8b, so classification's accept() check has something real to
// gate on) -- never the real vendored tarball, which test/public-guard.test.js never reads except
// in T-V9's explicit, read-only, fs-only comparison.
// ---------------------------------------------------------------------------

function vendorTgzBytesWithTerm(term) {
  // gzip-magic-shaped (1f 8b) + a NUL-bearing pad (SD-5's dual-decode arm) + the synthetic term.
  return Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(4), Buffer.from(term, 'utf8')]);
}

function sha256sumsText(sha, filename) {
  return `${sha}  ${filename}\n`;
}

function pinJsonText(pin) {
  return (
    JSON.stringify(
      {
        source: { kind: pin.kind !== undefined ? pin.kind : 'release-tarball' },
        tarball: pin.tarball,
        tarballSha256: pin.tarballSha256,
        sums: Object.prototype.hasOwnProperty.call(pin, 'sums') ? pin.sums : 'SHA256SUMS',
      },
      null,
      2,
    ) + '\n'
  );
}

function writeVendorFixture(dir, { version = '9.9.9', bytes } = {}) {
  const tarballName = `gm-apprentice-publish-${version}.tgz`;
  const tgzBytes = bytes || vendorTgzBytesWithTerm(TERM_ZORBLAX);
  const tarballSha = sha256Hex(tgzBytes);
  const vendorDir = path.join(dir, 'vendor', 'gm-apprentice-publish');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, tarballName), tgzBytes);
  fs.writeFileSync(path.join(vendorDir, 'PIN.json'), pinJsonText({ tarball: tarballName, tarballSha256: tarballSha }));
  fs.writeFileSync(path.join(vendorDir, 'SHA256SUMS'), sha256sumsText(tarballSha, tarballName));
  return { tarballName, tgzBytes, tarballSha, vendorDir };
}

test('T-V1: tree mode, all consistent: RESIDUAL vendor-binary and UNCLASSED 0, exit 0', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const { tgzBytes } = writeVendorFixture(dir);
  commitIdentity(dir, 'add vendor tarball');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', 'tree', head], { cwd: dir });
  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`^RESIDUAL vendor-binary=${expectedHitCount(tgzBytes, TERM_ZORBLAX)} files=1$`, 'm'));
  assert.match(result.stdout, /^UNCLASSED 0$/m);
});

test('T-V2: tarball changed by one byte, PIN and SUMS untouched: UNCLASSED 1, exit 1, no ERROR', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const { vendorDir, tarballName } = writeVendorFixture(dir);
  commitIdentity(dir, 'add vendor tarball');
  const original = fs.readFileSync(path.join(vendorDir, tarballName));
  fs.writeFileSync(path.join(vendorDir, tarballName), Buffer.concat([original, Buffer.from([0x00])]));
  commitIdentity(dir, 'tamper with tarball bytes only');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', 'tree', head], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^UNCLASSED 1$/m);
  assert.equal(result.stderr, '');
});

test('T-V3: SHA256SUMS entry differs from PIN tarballSha256 (both well-formed): exit 2 bad-residual kind=vendor', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const { vendorDir, tarballName } = writeVendorFixture(dir);
  const wrongSha = sha256Hex(Buffer.from('not-the-tarball'));
  fs.writeFileSync(path.join(vendorDir, 'SHA256SUMS'), sha256sumsText(wrongSha, tarballName));
  commitIdentity(dir, 'add vendor tarball with an inconsistent SUMS entry');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', 'tree', head], { cwd: dir });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^ERROR bad-residual kind=vendor$/m);
});

test('T-V4: identical bytes at a sibling directory and at a differently-named file in the real one both stay UNCLASSED', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const { vendorDir, tarballName, tgzBytes } = writeVendorFixture(dir);
  const siblingDir = path.join(dir, 'vendor', 'gm-apprentice-publishX');
  fs.mkdirSync(siblingDir, { recursive: true });
  fs.writeFileSync(path.join(siblingDir, tarballName), tgzBytes);
  fs.writeFileSync(path.join(vendorDir, `copy-${tarballName}`), tgzBytes);
  commitIdentity(dir, 'add a sibling-directory copy and a renamed copy');
  const head = revParse(dir, 'HEAD');

  const siblingResult = runGuard(['scan', 'tree', head, '--', 'vendor/gm-apprentice-publishX'], { cwd: dir });
  assert.equal(siblingResult.code, 1);
  assert.match(siblingResult.stdout, /^UNCLASSED 1$/m);

  const copyResult = runGuard(['scan', 'tree', head, '--', `vendor/gm-apprentice-publish/copy-${tarballName}`], { cwd: dir });
  assert.equal(copyResult.code, 1);
  assert.match(copyResult.stdout, /^UNCLASSED 1$/m);
});

test('T-V5: commits mode, one commit adds the tarball, PIN and SUMS together: classified, exit 0', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  const { tgzBytes } = writeVendorFixture(dir);
  commitIdentity(dir, 'add vendor tarball');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir });
  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`^RESIDUAL vendor-binary=${expectedHitCount(tgzBytes, TERM_ZORBLAX)} files=1$`, 'm'));
  assert.match(result.stdout, /^UNCLASSED 0$/m);
});

test("T-V5b: commits mode, tarball added ahead of a matching PIN/SUMS update: that commit's row stays UNCLASSED", (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');

  const vendorDir = path.join(dir, 'vendor', 'gm-apprentice-publish');
  fs.mkdirSync(vendorDir, { recursive: true });
  const oldName = 'gm-apprentice-publish-9.9.8.tgz';
  const oldSha = sha256Hex(Buffer.alloc(16));
  fs.writeFileSync(path.join(vendorDir, 'PIN.json'), pinJsonText({ tarball: oldName, tarballSha256: oldSha }));
  fs.writeFileSync(path.join(vendorDir, 'SHA256SUMS'), sha256sumsText(oldSha, oldName));
  commitIdentity(dir, 'pin 9.9.8 (no tarball bytes in the repo yet)');

  const newName = 'gm-apprentice-publish-9.9.9.tgz';
  const newBytes = vendorTgzBytesWithTerm(TERM_ZORBLAX);
  fs.writeFileSync(path.join(vendorDir, newName), newBytes);
  commitIdentity(dir, 'add the 9.9.9 tarball (pin still describes 9.9.8)');

  const newSha = sha256Hex(newBytes);
  fs.writeFileSync(path.join(vendorDir, 'PIN.json'), pinJsonText({ tarball: newName, tarballSha256: newSha }));
  fs.writeFileSync(path.join(vendorDir, 'SHA256SUMS'), sha256sumsText(newSha, newName));
  commitIdentity(dir, 'update pin and sums to 9.9.9');
  const head = revParse(dir, 'HEAD');

  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^UNCLASSED 1$/m);
  const unclassedHitLine = result.stdout.split('\n').find((l) => l.startsWith('HIT') && l.includes(`:vendor/gm-apprentice-publish/${newName}`));
  assert.ok(unclassedHitLine, "expected the tarball-adding commit's own row among the HIT lines");
});

test('T-V6: non-gzip bytes at the pinned path, with PIN and SUMS consistent: UNCLASSED 1', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const tarballName = 'gm-apprentice-publish-9.9.9.tgz';
  const bytes = Buffer.concat([Buffer.from('not-gzip-at-all'), Buffer.alloc(2), Buffer.from(TERM_ZORBLAX, 'utf8')]);
  const sha = sha256Hex(bytes);
  const vendorDir = path.join(dir, 'vendor', 'gm-apprentice-publish');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, tarballName), bytes);
  fs.writeFileSync(path.join(vendorDir, 'PIN.json'), pinJsonText({ tarball: tarballName, tarballSha256: sha }));
  fs.writeFileSync(path.join(vendorDir, 'SHA256SUMS'), sha256sumsText(sha, tarballName));
  commitIdentity(dir, 'add non-gzip bytes at the pinned path');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', 'tree', head], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^UNCLASSED 1$/m);
});

test('T-V7: PIN.json absent, and separately source.kind not release-tarball, both leave the row UNCLASSED with no ERROR', (t) => {
  {
    const dir = initRepo(t);
    configureLists(dir, writeLists(t));
    const vendorDir = path.join(dir, 'vendor', 'gm-apprentice-publish');
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(vendorDir, 'gm-apprentice-publish-9.9.9.tgz'), vendorTgzBytesWithTerm(TERM_ZORBLAX));
    commitIdentity(dir, 'tarball with no PIN.json at all');
    const head = revParse(dir, 'HEAD');
    const result = runGuard(['scan', 'tree', head], { cwd: dir });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^UNCLASSED 1$/m);
    assert.equal(result.stderr, '');
  }
  {
    const dir = initRepo(t);
    configureLists(dir, writeLists(t));
    const { vendorDir, tarballName } = writeVendorFixture(dir);
    const pin = JSON.parse(fs.readFileSync(path.join(vendorDir, 'PIN.json'), 'utf8'));
    fs.writeFileSync(path.join(vendorDir, 'PIN.json'), pinJsonText({ tarball: pin.tarball, tarballSha256: pin.tarballSha256, kind: 'npm-pack' }));
    commitIdentity(dir, 'tarball with a non-release-tarball pin kind');
    const head = revParse(dir, 'HEAD');
    const result = runGuard(['scan', 'tree', head], { cwd: dir });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^UNCLASSED 1$/m);
    assert.equal(result.stderr, '');
    assert.ok(tarballName);
  }
});

test('T-V8: every PIN.json validation failure gives exit 2 bad-residual kind=vendor, and a sentinel in tarball never leaks', (t) => {
  const sentinel = 'ZorblaxVendorSentinel';
  const tarballSha = sha256Hex(Buffer.alloc(8));
  const tarballName = 'gm-apprentice-publish-9.9.9.tgz';

  const cases = [
    { tarball: `sub/${sentinel}.tgz` }, // '/'
    { tarball: '..' }, // not a bare .tgz name
    { tarball: `${sentinel}\\x.tgz` }, // '\\'
    { tarball: `${sentinel}.TGZ` }, // wrong-case extension
    { tarballSha256: 'not-a-sha-value' }, // bad sha
    { sums: null }, // no sums field
    { skipSumsFile: true }, // SUMS file absent from the tree
    { sumsHasNoEntry: true }, // SUMS present but lacks this tarball's entry
  ];

  const runs = [];
  for (const c of cases) {
    const dir = initRepo(t);
    configureLists(dir, writeLists(t));
    const vendorDir = path.join(dir, 'vendor', 'gm-apprentice-publish');
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(vendorDir, tarballName), vendorTgzBytesWithTerm(TERM_ZORBLAX));
    const pin = {
      tarball: c.tarball !== undefined ? c.tarball : tarballName,
      tarballSha256: c.tarballSha256 !== undefined ? c.tarballSha256 : tarballSha,
      sums: Object.prototype.hasOwnProperty.call(c, 'sums') ? c.sums : 'SHA256SUMS',
    };
    fs.writeFileSync(path.join(vendorDir, 'PIN.json'), pinJsonText(pin));
    if (!c.skipSumsFile) {
      const sumsEntryName = c.sumsHasNoEntry ? `other-${tarballName}` : String(pin.tarball);
      fs.writeFileSync(path.join(vendorDir, 'SHA256SUMS'), sha256sumsText(String(pin.tarballSha256), sumsEntryName));
    }
    commitIdentity(dir, 'invalid pin case');
    const head = revParse(dir, 'HEAD');
    runs.push(runGuard(['scan', 'tree', head], { cwd: dir }));
  }

  for (const r of runs) {
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^ERROR bad-residual kind=vendor$/m);
  }
  const combined = runs.map((r) => `${r.stdout}\n${r.stderr}`).join('\n');
  assert.equal(combined.toLowerCase().includes(sentinel.toLowerCase()), false, 'sentinel leaked into output');
});

test('T-V9: deriveVendorEntry on the real PIN.json matches the real vendor directory (fs only, no git/scan)', () => {
  const repoRoot = path.join(__dirname, '..');
  const pinPath = path.join(repoRoot, 'vendor', 'gm-apprentice-publish', 'PIN.json');
  const pinText = fs.readFileSync(pinPath, 'utf8');
  const pin = JSON.parse(pinText);
  const readSibling = (name) => {
    try {
      return fs.readFileSync(path.join(repoRoot, 'vendor', 'gm-apprentice-publish', name), 'utf8');
    } catch {
      return null;
    }
  };
  const table = deriveVendorEntry(pinText, readSibling);
  assert.ok(table instanceof Map);
  const expectedPath = `${VENDOR_PIN_DIR}/${pin.tarball}`;
  assert.ok(table.has(expectedPath), `expected the table to have an entry for ${expectedPath}`);

  const tarballBytes = fs.readFileSync(path.join(repoRoot, 'vendor', 'gm-apprentice-publish', pin.tarball));
  const diskSha = sha256Hex(tarballBytes);
  assert.equal(table.get(expectedPath), diskSha, "table's sha256 must equal the test's own sha256 of the tarball on disk");

  const sumsText = fs.readFileSync(path.join(repoRoot, 'vendor', 'gm-apprentice-publish', pin.sums), 'utf8');
  const sumsFirstLineSha = sumsText.split(/\r?\n/)[0].trim().split(/\s+/)[0].toLowerCase();
  assert.equal(table.get(expectedPath), sumsFirstLineSha, "table's sha256 must equal the test's own parse of SHA256SUMS:1");
});

test('T-V10: two atomic repins in one range both classify, files=2, with no guard source change needed', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');

  const vendorDir = path.join(dir, 'vendor', 'gm-apprentice-publish');
  fs.mkdirSync(vendorDir, { recursive: true });

  const v1Name = 'gm-apprentice-publish-9.9.8.tgz';
  const v1Bytes = vendorTgzBytesWithTerm(TERM_ZORBLAX);
  const v1Sha = sha256Hex(v1Bytes);
  fs.writeFileSync(path.join(vendorDir, v1Name), v1Bytes);
  fs.writeFileSync(path.join(vendorDir, 'PIN.json'), pinJsonText({ tarball: v1Name, tarballSha256: v1Sha }));
  fs.writeFileSync(path.join(vendorDir, 'SHA256SUMS'), sha256sumsText(v1Sha, v1Name));
  commitIdentity(dir, 'repin to 9.9.8, atomically');

  fs.rmSync(path.join(vendorDir, v1Name));
  const v2Name = 'gm-apprentice-publish-9.9.9.tgz';
  // A space, not bare letters, after "Zorblax" (as T-I5b found): bare letters would fuse into one
  // longer token that word-mode correctly stops matching -- not a scanner bug, a fixture one.
  const v2Bytes = Buffer.concat([v1Bytes, Buffer.from(' v2', 'utf8')]);
  const v2Sha = sha256Hex(v2Bytes);
  fs.writeFileSync(path.join(vendorDir, v2Name), v2Bytes);
  fs.writeFileSync(path.join(vendorDir, 'PIN.json'), pinJsonText({ tarball: v2Name, tarballSha256: v2Sha }));
  fs.writeFileSync(path.join(vendorDir, 'SHA256SUMS'), sha256sumsText(v2Sha, v2Name));
  commitIdentity(dir, 'repin to 9.9.9, atomically');
  const head = revParse(dir, 'HEAD');

  const result = runGuard(['scan', 'commits', `${base}..${head}`], { cwd: dir });
  assert.equal(result.code, 0);
  const expectedTotal = expectedHitCount(v1Bytes, TERM_ZORBLAX) + expectedHitCount(v2Bytes, TERM_ZORBLAX);
  assert.match(result.stdout, new RegExp(`^RESIDUAL vendor-binary=${expectedTotal} files=2$`, 'm'));
  assert.match(result.stdout, /^UNCLASSED 0$/m);
});

// T-V9 alone proves the real pin is internally consistent, not that the classifier works; any
// `RESIDUAL vendor-binary=0` line in a repo with no vendored tarball proves nothing either.

// ---------------------------------------------------------------------------
// Amendment V, V.2 (S4-1): `scan --baseline <rev>`, T-B1 to T-B8
//
// SD-V3: a tree gate counts only NEW unclassified rows relative to a baseline revision -- the
// tool does the counting, not a reader diffing two scans by eye. Comparison is by the baseline's
// own UNCLASSIFIED rows only (never every scanner HIT row, T-B8), matched by identical masked
// label (never a prefix, T-B4b), with a row counting as NEW when it has no baseline match or
// exceeds the baseline row's count in any category (T-B3, T-B6).
// ---------------------------------------------------------------------------

test('T-B1: an unchanged pre-existing unclassified hit is not NEW: NEW-UNCLASSED 0, VERDICT pass, exit 0', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  fs.writeFileSync(path.join(dir, 'a.md'), `mentions ${TERM_ZORBLAX} right here\n`);
  commitIdentity(dir, 'add a.md');
  const base = revParse(dir, 'HEAD');
  commitIdentity(dir, 'an unrelated empty commit; a.md is untouched');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', '--baseline', base, 'tree', head], { cwd: dir });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^UNCLASSED 1$/m);
  assert.match(result.stdout, new RegExp(`^BASELINE ${base} unclassed=1$`, 'm'));
  assert.match(result.stdout, /^NEW-UNCLASSED 0$/m);
  assert.match(result.stdout, new RegExp(`^VERDICT pass baseline=${base}$`, 'm'));
});

test('T-B2: a new unclassified hit at <rev> is NEW, exit 1', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  // A tracked, hit-free file at the base commit: an EMPTY baseline tree is a denylist-scan
  // no-targets condition, a distinct concern from SD-V3's own comparison logic.
  fs.writeFileSync(path.join(dir, 'README.md'), 'nothing to see here\n');
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  fs.writeFileSync(path.join(dir, 'b.md'), `mentions ${TERM_ZORBLAX} right here\n`);
  commitIdentity(dir, 'add b.md');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', '--baseline', base, 'tree', head], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^NEW 1 b\.md term=1$/m);
  assert.match(result.stdout, /^NEW-UNCLASSED 1$/m);
  assert.match(result.stdout, new RegExp(`^VERDICT block baseline=${base}$`, 'm'));
});

test("T-B3: an existing unclassified row whose count increases is NEW, exit 1", (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  fs.writeFileSync(path.join(dir, 'a.md'), `${TERM_ZORBLAX} once\n`);
  commitIdentity(dir, 'add a.md once');
  const base = revParse(dir, 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.md'), `${TERM_ZORBLAX} twice ${TERM_ZORBLAX}\n`);
  commitIdentity(dir, 'a.md mentions it twice now');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', '--baseline', base, 'tree', head], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^NEW 2 a\.md term=2$/m);
  assert.match(result.stdout, /^NEW-UNCLASSED 1$/m);
});

test('T-B4: a renamed file is NEW (no identical-label baseline match)', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  fs.writeFileSync(path.join(dir, 'a.md'), `${TERM_ZORBLAX}\n`);
  commitIdentity(dir, 'add a.md');
  const base = revParse(dir, 'HEAD');
  fs.rmSync(path.join(dir, 'a.md'));
  fs.writeFileSync(path.join(dir, 'c.md'), `${TERM_ZORBLAX}\n`);
  commitIdentity(dir, 'rename a.md to c.md');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', '--baseline', base, 'tree', head], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^NEW 1 c\.md term=1$/m);
});

test('T-B4b: a new a.md.old beside an unchanged a.md is NEW (no prefix matching against a.md)', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  fs.writeFileSync(path.join(dir, 'a.md'), `${TERM_ZORBLAX}\n`);
  commitIdentity(dir, 'add a.md');
  const base = revParse(dir, 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.md.old'), `${TERM_ZORBLAX}\n`);
  commitIdentity(dir, 'add a.md.old beside the unchanged a.md');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', '--baseline', base, 'tree', head], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^NEW 1 a\.md\.old term=1$/m);
  assert.match(result.stdout, /^NEW-UNCLASSED 1$/m); // a.md itself must not also appear as NEW
});

test('T-B5: a hit removed at <rev> leaves nothing new: VERDICT pass', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  fs.writeFileSync(path.join(dir, 'a.md'), `${TERM_ZORBLAX}\n`);
  commitIdentity(dir, 'add a.md');
  const base = revParse(dir, 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.md'), 'nothing to see here\n');
  commitIdentity(dir, 'remove the hit from a.md');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', '--baseline', base, 'tree', head], { cwd: dir });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^NEW-UNCLASSED 0$/m);
  assert.match(result.stdout, new RegExp(`^VERDICT pass baseline=${base}$`, 'm'));
});

test('T-B6: same label and count but a different category is NEW', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  fs.writeFileSync(path.join(dir, 'a.md'), `${TERM_ZORBLAX}\n`);
  commitIdentity(dir, 'add a.md mentioning the term');
  const base = revParse(dir, 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.md'), `${IDENTITY_NAME}\n`);
  commitIdentity(dir, 'a.md now mentions the identity name instead');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['scan', '--baseline', base, 'tree', head], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^NEW 1 a\.md name=1$/m);
});

test('T-B7: --baseline with commits or files exits 2 usage', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  commitIdentity(dir, 'base');
  const base = revParse(dir, 'HEAD');
  commitIdentity(dir, 'second');
  const head = revParse(dir, 'HEAD');

  const commitsResult = runGuard(['scan', '--baseline', base, 'commits', `${base}..${head}`], { cwd: dir });
  assert.equal(commitsResult.code, 2);
  assert.match(commitsResult.stderr, /^ERROR usage$/m);

  const filesDir = mkTmp(t, 'scriptorium-guard-files-');
  fs.writeFileSync(path.join(filesDir, 'x.md'), 'nothing\n');
  const filesResult = runGuard(['scan', '--baseline', base, 'files', filesDir], { cwd: dir });
  assert.equal(filesResult.code, 2);
  assert.match(filesResult.stderr, /^ERROR usage$/m);
});

test('T-B8: a font row classified at the baseline, with one byte changed at <rev>, is NEW', (t) => {
  const dir = initRepo(t);
  configureLists(dir, writeLists(t));
  const relPath = 'assets/themes/gloam/fonts/Synthetic.woff2';
  const bytes = fontBytesWithTerm(TERM_ZORBLAX);
  fs.mkdirSync(path.join(dir, path.dirname(relPath)), { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), bytes);
  commitIdentity(dir, 'add font');
  const base = revParse(dir, 'HEAD');
  const changedBytes = Buffer.concat([bytes, Buffer.from([0x00])]);
  fs.writeFileSync(path.join(dir, relPath), changedBytes);
  commitIdentity(dir, 'change one byte in the font');
  const head = revParse(dir, 'HEAD');
  const table = [{ path: relPath, sha256: sha256Hex(bytes) }]; // only the ORIGINAL bytes are pinned
  const result = runGuard(['scan', '--baseline', base, 'tree', head], { cwd: dir, fontResidual: table });
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`^NEW \\d+ ${relPath.replace(/\./g, '\\.')} term=\\d+$`, 'm'));
  assert.match(result.stdout, /^NEW-UNCLASSED 1$/m);
});

// T-B5 alone, and any `NEW-UNCLASSED 0` from a run where `<rev>` equals `<base-rev>`, prove
// nothing: both are also what a no-op baseline comparison would print.

// ---------------------------------------------------------------------------
// S4 proper: guard modes (pre-push Run A, ci, release), the hook shim's own
// contract (parsePushLines), and the forbidden-path check (forbiddenPathCount).
// Mutation table: G1-G10 (s4-engineering-brief-2026-09-30.md). D-AUD controls:
// docs-audience-requirements-2026-09-30.md section 4 ("test/public-guard.test.js (S4)").
// ---------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);

/** Run B (SD-4 d) reads `scripts/public-hygiene-patterns.txt` from the SCANNED REVISION's own
 * tree, so every synthetic repo used by a `ci`/`pre-push`/`release` test needs one tracked, or
 * `runHygiene` fails closed with `hygiene-missing` before any of this file's own behaviour runs
 * at all. One small, fully synthetic regex is enough; tests that need a real hit plant it
 * themselves (the D-AUD dot-directory control, below). Call this BEFORE the commit that should
 * carry it. */
function seedHygiene(dir, patternsText = 'regex ip \\b10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b\n') {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'public-hygiene-patterns.txt'), patternsText);
}

/** A repo with a root commit, then a commit already "on the remote", then one more commit about
 * to be pushed -- the shared fixture for the pre-push/release Run A tests below. `addLeak`
 * (optional) writes a file containing the synthetic term into the NEW commit only, so a positive
 * hit can only come from the correctly-scoped range. */
function setupPushFixture(t, { addLeak = false } = {}) {
  const dir = initRepo(t);
  const listsDir = writeLists(t);
  configureLists(dir, listsDir);
  seedHygiene(dir);
  commitPlain(dir, 'root');
  const root = revParse(dir, 'HEAD');
  commitPlain(dir, 'already on the remote');
  const remoteOid = revParse(dir, 'HEAD');
  if (addLeak) fs.writeFileSync(path.join(dir, 'leak.txt'), `mentions ${TERM_ZORBLAX} here\n`);
  commitPlain(dir, 'new, about to be pushed');
  const localOid = revParse(dir, 'HEAD');
  return { dir, listsDir, root, remoteOid, localOid };
}

test('T-G1: pre-push Run A scans exactly the pushed range (remote..local) -- the planted private-hit test', (t) => {
  const { dir, root, remoteOid, localOid } = setupPushFixture(t, { addLeak: true });
  const result = runGuard(['pre-push', 'origin', 'https://example.invalid/repo.git'], {
    cwd: dir,
    stdin: pushLine(localOid, remoteOid),
    publicRoot: root,
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^PRIVATE commits unclassed=1$/m);
  assert.match(result.stdout, /^VERDICT block$/m);
});

test('T-G1b: pre-push Run A with no leak in the pushed range gives VERDICT pass (paired control)', (t) => {
  const { dir, root, remoteOid, localOid } = setupPushFixture(t, { addLeak: false });
  const result = runGuard(['pre-push', 'origin', 'https://example.invalid/repo.git'], {
    cwd: dir,
    stdin: pushLine(localOid, remoteOid),
    publicRoot: root,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^VERDICT pass$/m);
});

test('T-G1c: pre-push with a zero local oid (a delete) skips that ref entirely', (t) => {
  const { dir, root, remoteOid } = setupPushFixture(t, { addLeak: true });
  const result = runGuard(['pre-push', 'origin', 'https://example.invalid/repo.git'], {
    cwd: dir,
    stdin: pushLine(ZERO_OID, remoteOid),
    publicRoot: root,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^VERDICT pass$/m);
  assert.doesNotMatch(result.stdout, /^PRIVATE/m);
});

test('T-G1d: pre-push with a zero remote oid (a new ref) scans local --not --remotes=<remote>', (t) => {
  const { dir, root, remoteOid, localOid } = setupPushFixture(t, { addLeak: true });
  // A real "--remotes=origin" only means something with a configured remote-tracking ref; build
  // one that excludes the leak commit, so the --not side of the range actually does something.
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remoteOid], { cwd: dir, env: ISOLATED_ENV_BASE });
  const result = runGuard(['pre-push', 'origin', 'https://example.invalid/repo.git'], {
    cwd: dir,
    stdin: pushLine(localOid, ZERO_OID),
    publicRoot: root,
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^PRIVATE commits unclassed=1$/m);
});

test("T-G2: a leak that is only in commit HISTORY, not in the final tree, still blocks -- Run A's own commits-scan result is load-bearing, not just the tree scan's", (t) => {
  const dir = initRepo(t);
  const listsDir = writeLists(t);
  configureLists(dir, listsDir);
  seedHygiene(dir);
  commitPlain(dir, 'root');
  const root = revParse(dir, 'HEAD');
  const remoteOid = root;
  fs.writeFileSync(path.join(dir, 'leak.txt'), `mentions ${TERM_ZORBLAX} here\n`);
  commitPlain(dir, 'adds a leak');
  fs.rmSync(path.join(dir, 'leak.txt'));
  commitPlain(dir, 'removes the leak again'); // the final tree is clean; only history has it.
  const localOid = revParse(dir, 'HEAD');
  const result = runGuard(['pre-push', 'origin', 'https://example.invalid/repo.git'], {
    cwd: dir,
    stdin: pushLine(localOid, remoteOid),
    publicRoot: root,
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^PRIVATE commits unclassed=1$/m);
  assert.match(result.stdout, /^VERDICT block$/m);
});

test('T-G3: a two-root history is refused by set membership, not a joined-string prefix match', (t) => {
  const dirA = mkTmp(t, 'scriptorium-guard-tworoot-a-');
  const dirB = mkTmp(t, 'scriptorium-guard-tworoot-b-');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', dirA], { env: ISOLATED_ENV_BASE });
  execFileSync('git', ['init', '--quiet', '--initial-branch=other', dirB], { env: ISOLATED_ENV_BASE });
  const dated = (iso) => ({ ...ISOLATED_ENV_BASE, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  commitIdentity(dirA, 'rootA', dated('2020-01-01T00:00:00'));
  const rootA = revParse(dirA, 'HEAD');
  commitIdentity(dirB, 'rootB', dated('2021-01-01T00:00:00')); // later date: rev-list lists it FIRST.
  const rootB = revParse(dirB, 'HEAD');
  execFileSync('git', ['fetch', '--quiet', dirB, 'other:refs/remotes/other/main'], { cwd: dirA, env: ISOLATED_ENV_BASE });
  execFileSync(
    'git',
    ['-c', `user.name=${IDENTITY_NAME}`, '-c', `user.email=${IDENTITY_EMAIL}`, '-c', 'commit.gpgsign=false', 'merge', '--allow-unrelated-histories', '--quiet', '-m', 'merge', 'refs/remotes/other/main'],
    { cwd: dirA, env: ISOLATED_ENV_BASE, stdio: 'pipe' },
  );
  const head = revParse(dirA, 'HEAD');
  const roots = execFileSync('git', ['rev-list', '--max-parents=0', head], { cwd: dirA, env: ISOLATED_ENV_BASE }).toString('utf8').trim().split('\n');
  assert.deepEqual(roots, [rootB, rootA]); // confirms rootB (publicRoot, below) really is listed FIRST.

  // publicRoot = rootB, which IS one of the two roots AND is listed first -- `roots.join('
  // ').startsWith(publicRoot)` would (wrongly) be true here; the real Set-based check correctly
  // refuses because there are two roots, not one.
  const result = runGuard(['ci', head], { cwd: dirA, publicRoot: rootB });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ROOT block$/m);
  assert.match(result.stdout, /^VERDICT block$/m);
});

test('T-G4: forbidden-path check is segment-exact, never a string prefix', () => {
  assert.equal(forbiddenPathCount(['docs/agent-runsX/a.md']), 0, 'a sibling directory sharing the string prefix must not be flagged');
  assert.equal(forbiddenPathCount(['docs/agent-runs/real.md']), 1);
  assert.equal(forbiddenPathCount(['sub/CLAUDE.local.md']), 1, 'CLAUDE.local.md is flagged at any depth');
  assert.equal(forbiddenPathCount(['CLAUDE.local.md']), 1);
  assert.equal(forbiddenPathCount(['CLAUDE.local.md.bak']), 0, 'the FILE NAME must match exactly, not just a prefix of it');
  assert.equal(forbiddenPathCount(['README.md', 'src/index.js']), 0);
});

test('T-G5: a shallow clone gives shallow, not root -- shallow is checked before root, in every guard mode', (t) => {
  const dir = initRepo(t);
  commitIdentity(dir, 'root');
  commitIdentity(dir, 'second');
  const head = revParse(dir, 'HEAD');
  const shallowDir = mkTmp(t, 'scriptorium-guard-ci-shallow-');
  execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${dir}`, shallowDir], { env: ISOLATED_ENV_BASE });
  // The default publicRoot (the real project's) can't match this synthetic repo's root either
  // way -- if shallow were skipped, the NEXT check (root) would still refuse, but with the
  // WRONG rule name (`ROOT block`, exit 1) instead of `shallow` (exit 2).
  const result = runGuard(['ci', head], { cwd: shallowDir });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^ERROR shallow$/m);
});

test('T-G6: Run B strips SCRIPTORIUM_DENYLIST_* from its own environment', (t) => {
  const dir = initRepo(t);
  seedHygiene(dir);
  fs.writeFileSync(path.join(dir, 'notes.md'), `mentions ${TERM_ZORBLAX} here\n`);
  commitIdentity(dir, 'root');
  const root = revParse(dir, 'HEAD');
  const staleTermsFile = path.join(mkTmp(t, 'scriptorium-guard-staleterms-'), 'terms.txt');
  fs.writeFileSync(staleTermsFile, `${TERM_ZORBLAX}\n`);
  const result = runGuard(['ci', root], {
    cwd: dir,
    publicRoot: root,
    env: baseEnv({ SCRIPTORIUM_DENYLIST_TERMS: staleTermsFile }),
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^HYGIENE unclassed=0$/m);
  assert.match(result.stdout, /^VERDICT pass$/m);
});

test('T-G7: pre-push requireLists is unaffected by the full Run A build (T-S12 re-confirmed under S4 proper)', (t) => {
  // T-S12 (S4-0) already proves this at the loader-sharing level; this re-confirms it now that
  // pre-push's "lists configured" branch is the full Run A implementation, not the
  // not-implemented stub T-S12 was originally written against.
  const { dir, root, remoteOid, localOid } = setupPushFixture(t, { addLeak: false });
  execFileSync('git', ['config', '--unset', 'scriptorium.privacyLists'], { cwd: dir, env: ISOLATED_ENV_BASE });
  execFileSync('git', ['config', 'scriptorium.requireLists', 'true'], { cwd: dir, env: ISOLATED_ENV_BASE });
  const result = runGuard(['pre-push', 'origin', 'https://example.invalid/repo.git'], {
    cwd: dir,
    stdin: pushLine(localOid, remoteOid),
    publicRoot: root,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^ERROR no-lists$/m);
});

test('T-G8: validateStandingAllow still refuses a path entry (G8 re-confirmed; T-S14 already covers this at the scan-mode call site)', () => {
  const errors = validateStandingAllow('path some/file.md -- nope\n', ['Zorblax']);
  assert.deepEqual(errors, [{ line: 1, code: 'path-entry' }]);
});

test('T-G9: validateStandingAllow rejects a term that is only a PREFIX of a real list entry -- not-in-list is an exact match, never a prefix match', () => {
  const errors = validateStandingAllow('term Zorb -- not the real term, just its prefix\n', ['Zorblax']);
  assert.deepEqual(errors, [{ line: 1, code: 'not-in-list' }]);
  // Positive control: the real term itself is accepted.
  assert.deepEqual(validateStandingAllow('term Zorblax -- the real term\n', ['Zorblax']), []);
});

test('T-G10: a forbidden path is never printed, only its count', (t) => {
  const dir = initRepo(t);
  commitIdentity(dir, 'root');
  const root = revParse(dir, 'HEAD');
  fs.mkdirSync(path.join(dir, 'docs', 'agent-runs'), { recursive: true });
  const sentinel = 'ZzSentinelDoNotPrintZz';
  fs.writeFileSync(path.join(dir, 'docs', 'agent-runs', `${sentinel}.md`), 'x');
  commitIdentity(dir, 'adds a forbidden path');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['ci', head], { cwd: dir, publicRoot: root });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^FORBIDDEN 1$/m);
  assert.match(result.stdout, /^VERDICT block$/m);
  assert.ok(!result.stdout.includes(sentinel));
  assert.ok(!result.stderr.includes(sentinel));
});

// ---------------------------------------------------------------------------
// ci and release modes: direct coverage beyond the G-mutation tests above.
// ---------------------------------------------------------------------------

test('ci: a clean repo at the right root gives VERDICT pass, exit 0', (t) => {
  const dir = initRepo(t);
  seedHygiene(dir);
  commitIdentity(dir, 'root');
  const root = revParse(dir, 'HEAD');
  const result = runGuard(['ci', root], { cwd: dir, publicRoot: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^ROOT ok$/m);
  assert.match(result.stdout, /^FORBIDDEN 0$/m);
  assert.match(result.stdout, /^HYGIENE unclassed=0$/m);
  assert.match(result.stdout, /^VERDICT pass$/m);
});

test('ci: defaults to HEAD when no rev is given', (t) => {
  const dir = initRepo(t);
  seedHygiene(dir);
  commitIdentity(dir, 'root');
  const root = revParse(dir, 'HEAD');
  const result = runGuard(['ci'], { cwd: dir, publicRoot: root });
  assert.equal(result.code, 0);
});

test('ci: never loads private lists, even when scriptorium.privacyLists is configured', (t) => {
  const dir = initRepo(t);
  seedHygiene(dir);
  configureLists(dir, writeLists(t));
  fs.writeFileSync(path.join(dir, 'leak.txt'), `mentions ${TERM_ZORBLAX} here\n`);
  commitIdentity(dir, 'root'); // the leak is IN the root commit's own tree.
  const root = revParse(dir, 'HEAD');
  const result = runGuard(['ci', root], { cwd: dir, publicRoot: root });
  // A private term in tracked content is invisible to ci: it has no private-list check at all.
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^VERDICT pass$/m);
  assert.doesNotMatch(result.stdout, /^PRIVATE/m);
});

test('release: requires private lists unconditionally and exits 2 without them', (t) => {
  const dir = initRepo(t);
  seedHygiene(dir);
  commitIdentity(dir, 'root');
  const root = revParse(dir, 'HEAD');
  commitIdentity(dir, 'second');
  const head = revParse(dir, 'HEAD');
  const result = runGuard(['release', root, head], { cwd: dir, publicRoot: root });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^ERROR no-lists$/m);
});

test('release: with lists configured, scans from-rev..to-rev and the to-rev tree, exit 0 clean / exit 1 on a leak', (t) => {
  const dir = initRepo(t);
  seedHygiene(dir);
  configureLists(dir, writeLists(t));
  commitPlain(dir, 'root');
  const root = revParse(dir, 'HEAD');
  commitPlain(dir, 'clean release commit');
  const cleanHead = revParse(dir, 'HEAD');
  const clean = runGuard(['release', root, cleanHead], { cwd: dir, publicRoot: root });
  assert.equal(clean.code, 0);
  assert.match(clean.stdout, /^VERDICT pass$/m);

  fs.writeFileSync(path.join(dir, 'leak.txt'), `mentions ${TERM_ZORBLAX} here\n`);
  commitPlain(dir, 'a leak before the release');
  const leakyHead = revParse(dir, 'HEAD');
  const leaky = runGuard(['release', root, leakyHead], { cwd: dir, publicRoot: root });
  assert.equal(leaky.code, 1);
  assert.match(leaky.stdout, /^VERDICT block$/m);
});

test('release: defaults to-rev to HEAD', (t) => {
  const dir = initRepo(t);
  seedHygiene(dir);
  configureLists(dir, writeLists(t));
  commitPlain(dir, 'root');
  const root = revParse(dir, 'HEAD');
  commitPlain(dir, 'second');
  const result = runGuard(['release', root], { cwd: dir, publicRoot: root });
  assert.equal(result.code, 0);
});

test('parsePushLines: parses one line per the hook contract, skipping blank lines', () => {
  const text = `refs/heads/main ${'1'.repeat(40)} refs/heads/main ${'2'.repeat(40)}\n\nrefs/heads/x ${'3'.repeat(40)} refs/heads/x ${ZERO_OID}\n`;
  const lines = parsePushLines(text);
  assert.deepEqual(lines, [
    { localRef: 'refs/heads/main', localOid: '1'.repeat(40), remoteRef: 'refs/heads/main', remoteOid: '2'.repeat(40) },
    { localRef: 'refs/heads/x', localOid: '3'.repeat(40), remoteRef: 'refs/heads/x', remoteOid: ZERO_OID },
  ]);
});

test('parsePushLines: a malformed line throws GuardError bad-stdin, surfaced as exit 2', (t) => {
  const { dir, root } = setupPushFixture(t);
  const result = runGuard(['pre-push', 'origin', 'https://example.invalid/repo.git'], {
    cwd: dir,
    stdin: 'not four fields\n',
    publicRoot: root,
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^ERROR bad-stdin$/m);
});

// ---------------------------------------------------------------------------
// D-AUD controls (docs-audience-requirements-2026-09-30.md section 4,
// "test/public-guard.test.js (S4)"). `.agents/` doesn't exist yet at this slice's PARENT -- these
// prove the GUARD's own rules, independent of whether the folder has been created yet.
// ---------------------------------------------------------------------------

test('D-AUD: .agents/ files and a root AGENTS.md are never forbidden paths', () => {
  assert.equal(forbiddenPathCount(['.agents/runbook.md']), 0);
  assert.equal(forbiddenPathCount(['.agents/windows/handover.md']), 0);
  assert.equal(forbiddenPathCount(['AGENTS.md']), 0);
});

test('D-AUD: Run B scans dot-directories -- a planted hygiene hit under .agents/ is still caught', (t) => {
  const dir = initRepo(t);
  seedHygiene(dir);
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  // Private-range address assembled at runtime so this source file carries no literal that the
  // list-free hygiene patterns would flag.
  const privateIp = ['10', '1', '2', '3'].join('.');
  fs.writeFileSync(path.join(dir, '.agents', 'notes.md'), `reachable at ${privateIp} apparently\n`);
  commitIdentity(dir, 'root');
  const root = revParse(dir, 'HEAD');
  const result = runGuard(['ci', root], { cwd: dir, publicRoot: root });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HYGIENE unclassed=1$/m);
  assert.match(result.stdout, /^VERDICT block$/m);
});

// Tests that pass today and prove nothing on their own (CLAUDE.md's testing standard):
// - "ci: defaults to HEAD when no rev is given" only proves the argument is optional, not that
//   checks actually run against it; T-G5/T-G10/the "ci: a clean repo..." test above are what
//   prove the checks themselves fire.
// - "release: defaults to-rev to HEAD" is the same shape, for the same reason.
