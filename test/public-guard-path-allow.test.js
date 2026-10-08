'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { run, LIST_FILE_NAMES, validateStandingAllow } = require('../scripts/public-guard');

/*
 * Standing-allowlist `path` entries (ADR 0031, closing amendment). Synthetic-only: the lists are
 * copied from test/fixtures/guard-path-allow-lists, every term in them is invented, and the
 * private lists are never read. Each test runs in a temp repo with `scriptorium.privacyLists`
 * set locally and git config isolated.
 */

const FIXTURE_LISTS = path.join(__dirname, 'fixtures', 'guard-path-allow-lists');
const ENV = Object.freeze({ ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];
const TERM = 'Zorblax';
const ZERO_OID = '0'.repeat(40);

function git(args, cwd) {
  return execFileSync('git', [...ID, ...args], { cwd, env: ENV, stdio: 'pipe' });
}
function mkTmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function rev(dir, r) {
  return git(['rev-parse', r], dir).toString('utf8').trim();
}
function sink() {
  const c = [];
  return { write: (x) => (c.push(x.toString()), true), text: () => c.join('') };
}
function guard(argv, { cwd, stdin, publicRoot } = {}) {
  const stdout = sink();
  const stderr = sink();
  const opts = { cwd, env: ENV, stdout, stderr };
  if (stdin !== undefined) opts.stdin = stdin;
  if (publicRoot !== undefined) opts.publicRoot = publicRoot;
  const code = run(argv, opts);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** Copies the fixture lists, replacing the allow file text when given. */
function lists(t, allow) {
  const dir = mkTmp(t, 'scriptorium-pathallow-lists-');
  for (const name of Object.values(LIST_FILE_NAMES)) fs.copyFileSync(path.join(FIXTURE_LISTS, name), path.join(dir, name));
  if (allow !== undefined) fs.writeFileSync(path.join(dir, LIST_FILE_NAMES.allow), allow);
  return dir;
}
function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function commit(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-m', message, '--quiet', '--allow-empty'], dir);
}

/** Five files that all contain the term. Only `docs/starter.md` is ever the allowed one. */
const LEAKY_FILES = ['starter.md', 'docs/starter.md', 'docs/starter.md.bak', 'xdocs/starter.md', 'docs/other.md'];

function repo(t, allow, { files = LEAKY_FILES, message = 'plain message' } = {}) {
  const dir = mkTmp(t, 'scriptorium-pathallow-repo-');
  git(['init', '--quiet', dir], dir);
  git(['config', 'scriptorium.privacyLists', lists(t, allow)], dir);
  for (const f of files) write(dir, f, `mentions ${TERM} here\n`);
  commit(dir, message);
  return dir;
}

const BASE_ALLOW = 'term lantern -- generic noun: test\n';
const hitLabels = (out) => [...out.matchAll(/^HIT \d+ (\S+)/gm)].map((m) => m[1]).sort();
const allowedLabels = (out) => [...out.matchAll(/^ALLOWED \d+ (\S+)/gm)].map((m) => m[1]).sort();

test('PA-1: a path entry excuses exactly that file in tree mode and no other file, by exact match only', (t) => {
  const dir = repo(t, `${BASE_ALLOW}path docs/starter.md -- exact file from the upstream starter vault\n`);
  const r = guard(['scan', 'tree', 'HEAD'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.deepEqual(allowedLabels(r.stdout), ['docs/starter.md']);
  // Same basename at the root, a longer name with the entry as a prefix, a longer directory
  // name with the entry as a suffix, and a sibling: all still hit.
  assert.deepEqual(hitLabels(r.stdout), ['docs/other.md', 'docs/starter.md.bak', 'starter.md', 'xdocs/starter.md']);
  assert.doesNotMatch(r.stdout, /^UNUSED allow:2$/m);
});

test('PA-1b: when the excused file is the only one with a hit, the scan passes', (t) => {
  const dir = repo(t, `${BASE_ALLOW}path docs/starter.md -- exact file from the upstream starter vault\n`, { files: ['docs/starter.md'] });
  write(dir, 'docs/clean.md', 'nothing listed here\n');
  commit(dir, 'clean file');
  const r = guard(['scan', 'tree', 'HEAD'], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^VERDICT pass$/m);
});

test('PA-1c: an entry for the root file does not excuse the same name in a subdirectory', (t) => {
  const dir = repo(t, `${BASE_ALLOW}path starter.md -- root file only\n`);
  const r = guard(['scan', 'tree', 'HEAD'], { cwd: dir });
  assert.deepEqual(allowedLabels(r.stdout), ['starter.md']);
  assert.ok(hitLabels(r.stdout).includes('docs/starter.md'));
  assert.ok(hitLabels(r.stdout).includes('xdocs/starter.md'));
});

const BAD_TARGETS = [
  ['glob star', 'docs/*.md'],
  ['glob double star', '**/starter.md'],
  ['glob question', 'docs/starte?.md'],
  ['glob class', 'docs/[s]tarter.md'],
  ['glob brace', 'docs/{starter,other}.md'],
  ['directory with trailing slash', 'docs/'],
  ['dot-dot at start', '../starter.md'],
  ['dot-dot in the middle', 'docs/../starter.md'],
  ['dot segment', './docs/starter.md'],
  ['absolute path', '/etc/starter.md'],
  ['backslash', 'docs\\starter.md'],
  ['empty segment', 'docs//starter.md'],
  ['drive letter', 'C:/docs/starter.md'],
];

test('PA-2: glob, directory, dot-dot, absolute, backslash entries are refused as bad-allow with the line number', (t) => {
  for (const [label, target] of BAD_TARGETS) {
    const dir = repo(t, `# comment\n${BASE_ALLOW}path ${target} -- reason\n`);
    const r = guard(['scan', 'tree', 'HEAD'], { cwd: dir });
    assert.equal(r.code, 2, `${label}: ${target}`);
    assert.match(r.stderr, /^ERROR bad-allow$/m, label);
    assert.match(r.stderr, /^LINE 3 bad-path$/m, label);
    assert.doesNotMatch(r.stderr + r.stdout, /VERDICT/, label);
  }
});

test('PA-2b: validateStandingAllow returns bad-path with the line for each refused target, and nothing for a good one', () => {
  for (const [label, target] of BAD_TARGETS) {
    assert.deepEqual(validateStandingAllow(`\npath ${target} -- reason\n`, [TERM]), [{ line: 2, code: 'bad-path' }], label);
  }
  assert.deepEqual(validateStandingAllow('path docs/starter.md -- reason\n', [TERM]), []);
  assert.deepEqual(validateStandingAllow('path .github/CODEOWNERS -- reason\n', [TERM]), []);
});

test('PA-3: a path entry with no reason is refused (exit 2), with or without the separator', (t) => {
  for (const line of ['path docs/starter.md --', 'path docs/starter.md --   ', 'path docs/starter.md']) {
    const dir = repo(t, `${BASE_ALLOW}${line}\n`);
    const r = guard(['scan', 'tree', 'HEAD'], { cwd: dir });
    assert.equal(r.code, 2, line);
    assert.match(r.stderr, /^ERROR bad-list kind=allow$/m, line);
    assert.doesNotMatch(r.stdout, /VERDICT/, line);
  }
});

test('PA-4: an unused path entry is reported as UNUSED by line number, never silently ignored', (t) => {
  const cases = [
    ['a file that does not exist', 'docs/nope.md'],
    ['a directory name', 'docs'],
  ];
  for (const [label, target] of cases) {
    const dir = repo(t, `${BASE_ALLOW}path ${target} -- reason\n`);
    const r = guard(['scan', 'tree', 'HEAD'], { cwd: dir });
    assert.match(r.stdout, /^UNUSED allow:2$/m, label);
    assert.match(r.stdout, /unused-allow=2$/m, label); // line 1 (the lantern term) is unused in these fixtures
    assert.equal(r.code, 1, `${label}: nothing is excused`);
    assert.equal(hitLabels(r.stdout).length, LEAKY_FILES.length, label);
  }
});

test('PA-4b: an entry outside the pathspec being scanned is UNUSED too', (t) => {
  const dir = repo(t, `${BASE_ALLOW}path docs/starter.md -- reason\n`);
  const r = guard(['scan', 'tree', 'HEAD', '--', 'docs/other.md'], { cwd: dir });
  assert.match(r.stdout, /^UNUSED allow:2$/m);
});

test('PA-5: a path entry never excuses a commit-message hit, and a message-shaped target never matches', (t) => {
  const dir = repo(t, BASE_ALLOW, { files: ['docs/starter.md'], message: `mentions ${TERM} in the message` });
  const sha12 = rev(dir, 'HEAD').slice(0, 12);
  const allow = `${BASE_ALLOW}path docs/starter.md -- starter vault file\npath ${sha12}:message -- try the message label\npath message -- try a bare label\n`;
  fs.writeFileSync(path.join(git(['config', 'scriptorium.privacyLists'], dir).toString('utf8').trim(), LIST_FILE_NAMES.allow), allow);
  const r = guard(['scan', 'commits', 'HEAD'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.deepEqual(hitLabels(r.stdout), [`${sha12}:message`]);
  assert.deepEqual(allowedLabels(r.stdout), [`${sha12}:docs/starter.md`]);
  assert.match(r.stdout, /^UNUSED allow:3$/m);
  assert.match(r.stdout, /^UNUSED allow:4$/m);
  assert.doesNotMatch(r.stdout, /^UNUSED allow:2$/m);
});

test('PA-6: scan commits excuses the named file in each commit of the range and nothing else', (t) => {
  const dir = repo(t, `${BASE_ALLOW}path docs/starter.md -- starter vault file\n`, { files: ['docs/starter.md', 'docs/other.md'] });
  const sha12 = rev(dir, 'HEAD').slice(0, 12);
  const r = guard(['scan', 'commits', 'HEAD'], { cwd: dir });
  assert.deepEqual(allowedLabels(r.stdout), [`${sha12}:docs/starter.md`]);
  assert.deepEqual(hitLabels(r.stdout), [`${sha12}:docs/other.md`]);
});

test('PA-7: scan files never applies a path entry (a bare name cannot prove which repo file it is); the entry is UNUSED', (t) => {
  const dir = repo(t, `${BASE_ALLOW}path starter.md -- root file\npath docs/starter.md -- docs file\n`);
  const r = guard(['scan', 'files', path.join(dir, 'starter.md'), path.join(dir, 'docs')], { cwd: dir });
  assert.equal(r.code, 1);
  assert.deepEqual(allowedLabels(r.stdout), []);
  assert.ok(hitLabels(r.stdout).includes('starter.md'));
  assert.ok(hitLabels(r.stdout).includes('docs/starter.md'));
  assert.match(r.stdout, /^UNUSED allow:2$/m);
  assert.match(r.stdout, /^UNUSED allow:3$/m);
});

test('PA-8: terms behave exactly as before (allowed term passes, unlisted term refused, term hit outside any path entry still blocks)', (t) => {
  const dir = repo(t, `${BASE_ALLOW}`, { files: ['a.md'] });
  write(dir, 'a.md', 'a lantern here\n');
  commit(dir, 'lantern');
  const ok = guard(['scan', 'tree', 'HEAD'], { cwd: dir });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^ALLOWED 1 a\.md$/m);
  assert.deepEqual(validateStandingAllow('term Zorb -- prefix only\n', [TERM]), [{ line: 1, code: 'not-in-list' }]);
  assert.deepEqual(validateStandingAllow('term Zorblax -- real\n', [TERM]), []);
  const dir2 = repo(t, `${BASE_ALLOW}term nothere -- unlisted\n`);
  const bad = guard(['scan', 'tree', 'HEAD'], { cwd: dir2 });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /^ERROR bad-allow$/m);
  assert.match(bad.stderr, /^LINE 2 not-in-list$/m);
});

function seedHygiene(dir) {
  write(dir, 'scripts/public-hygiene-patterns.txt', 'regex ip \\b10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b\n');
}

test('PA-9: pre-push and release apply path entries to files in the pushed range and tree, and still block on any other file', (t) => {
  const allow = `${BASE_ALLOW}path docs/starter.md -- starter vault file\n`;
  const dir = mkTmp(t, 'scriptorium-pathallow-repo-');
  git(['init', '--quiet', dir], dir);
  git(['config', 'scriptorium.privacyLists', lists(t, allow)], dir);
  seedHygiene(dir);
  commit(dir, 'root');
  const root = rev(dir, 'HEAD');
  write(dir, 'docs/starter.md', `mentions ${TERM}\n`);
  commit(dir, 'add the excused file');
  const okHead = rev(dir, 'HEAD');
  const push = (local) => guard(['pre-push', 'origin', 'https://example.invalid/r.git'], { cwd: dir, stdin: `refs/heads/main ${local} refs/heads/main ${root}\n`, publicRoot: root });

  const prePushOk = push(okHead);
  assert.equal(prePushOk.code, 0, prePushOk.stdout + prePushOk.stderr);
  assert.match(prePushOk.stdout, /^VERDICT pass$/m);
  const releaseOk = guard(['release', root, okHead], { cwd: dir, publicRoot: root });
  assert.equal(releaseOk.code, 0, releaseOk.stdout + releaseOk.stderr);

  write(dir, 'docs/other.md', `mentions ${TERM}\n`);
  commit(dir, 'add a file that is not excused');
  const badHead = rev(dir, 'HEAD');
  assert.equal(push(badHead).code, 1);
  assert.equal(guard(['release', root, badHead], { cwd: dir, publicRoot: root }).code, 1);

  // The message hit is not excused by the file entry, even in pre-push.
  const dir2 = mkTmp(t, 'scriptorium-pathallow-repo-');
  git(['init', '--quiet', dir2], dir2);
  git(['config', 'scriptorium.privacyLists', lists(t, allow)], dir2);
  seedHygiene(dir2);
  commit(dir2, 'root');
  const root2 = rev(dir2, 'HEAD');
  write(dir2, 'docs/starter.md', `mentions ${TERM}\n`);
  commit(dir2, `message mentions ${TERM}`);
  const msgHead = rev(dir2, 'HEAD');
  const r = guard(['pre-push', 'origin', 'https://example.invalid/r.git'], { cwd: dir2, stdin: `refs/heads/main ${msgHead} refs/heads/main ${root2}\n`, publicRoot: root2 });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^VERDICT block$/m);
  void ZERO_OID;
});
