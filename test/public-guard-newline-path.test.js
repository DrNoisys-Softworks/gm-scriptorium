'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { run, LIST_FILE_NAMES } = require('../scripts/public-guard');

/*
 * Issue 60: a committed file whose NAME holds a newline (or another control character) must
 * never slip past the guard. Synthetic-only: the lists are the invented fixture lists, the
 * private lists are never read. Every mode is driven through a temp repo.
 */

const FIXTURE_LISTS = path.join(__dirname, 'fixtures', 'guard-path-allow-lists');
const ENV = Object.freeze({ ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];
const TERM = 'Zorblax';
const PUSH_URL = 'https://example.invalid/r.git';

function git(args, cwd) {
  return execFileSync('git', [...ID, ...args], { cwd, env: ENV, stdio: 'pipe' });
}
function mkTmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sink() {
  const c = [];
  return { write: (x) => (c.push(x.toString()), true), text: () => c.join('') };
}
function guard(argv, { cwd, stdin, publicRoot, scanRun } = {}) {
  const stdout = sink();
  const stderr = sink();
  const opts = { cwd, env: ENV, stdout, stderr };
  if (stdin !== undefined) opts.stdin = stdin;
  if (publicRoot !== undefined) opts.publicRoot = publicRoot;
  if (scanRun !== undefined) opts.scanRun = scanRun;
  const code = run(argv, opts);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}
function lists(t) {
  const dir = mkTmp(t, 'scriptorium-nlpath-lists-');
  for (const name of Object.values(LIST_FILE_NAMES)) fs.copyFileSync(path.join(FIXTURE_LISTS, name), path.join(dir, name));
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
const head = (dir) => git(['rev-parse', 'HEAD'], dir).toString('utf8').trim();

/** A repo with a clean root commit; returns { dir, root }. */
function baseRepo(t) {
  const dir = mkTmp(t, 'scriptorium-nlpath-repo-');
  git(['init', '--quiet', dir], dir);
  git(['config', 'scriptorium.privacyLists', lists(t)], dir);
  write(dir, 'scripts/public-hygiene-patterns.txt', 'regex ip \\b10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b\n');
  commit(dir, 'root');
  return { dir, root: head(dir) };
}

// Expected escaped spellings are written out by hand, not produced by the code under test.
const NAMES = [
  ['newline', 'docs/new\nline.md', 'docs/new\\x0aline.md'],
  ['carriage return', 'docs/car\rret.md', 'docs/car\\x0dret.md'],
  ['escape character', 'docs/esc\x1bchar.md', 'docs/esc\\x1bchar.md'],
  ['unicode line separator', 'docs/ls\u2028sep.md', 'docs/ls\\u2028sep.md'],
];

function assertBlockedAndOneLine(r, escaped, label) {
  assert.equal(r.code, 1, `${label}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^VERDICT block$/m, label);
  assert.ok(r.stdout.includes(`HIT 1 ${escaped} word=1\n`) || r.stdout.includes(`HIT 1 ${escaped} literal=1\n`) || new RegExp(`^HIT \\d+ ${escaped.replace(/[\\.]/g, '\\$&')} \\S+$`, 'm').test(r.stdout), `${label}: one-line HIT row for ${escaped}\n${r.stdout}`);
  // No raw control character other than the row-terminating newline survives in the output.
  assert.doesNotMatch(r.stdout, /[\r\x1b\u2028\u2029]/, label);
  for (const line of r.stdout.split('\n')) {
    assert.ok(line === '' || /^[A-Z]+( |$)/.test(line), `${label}: stray fragment line ${JSON.stringify(line)}`);
  }
}

for (const [label, name, escaped] of NAMES) {
  test(`NL-1 (${label}): scan tree blocks a file with that name and a listed term in its content`, (t) => {
    const { dir } = baseRepo(t);
    write(dir, name, `mentions ${TERM}\n`);
    commit(dir, 'plain');
    assertBlockedAndOneLine(guard(['scan', 'tree', 'HEAD'], { cwd: dir }), escaped, label);
  });

  test(`NL-2 (${label}): scan tree blocks a file whose NAME holds the listed term, content clean`, (t) => {
    const { dir } = baseRepo(t);
    const n = name.replace('docs/', `docs/${TERM}-`);
    write(dir, n, 'nothing listed\n');
    commit(dir, 'plain');
    const r = guard(['scan', 'tree', 'HEAD'], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^VERDICT block$/m);
    assert.doesNotMatch(r.stdout, /[\r\x1b\u2028\u2029]/);
  });

  test(`NL-3 (${label}): scan commits blocks it`, (t) => {
    const { dir, root } = baseRepo(t);
    write(dir, name, `mentions ${TERM}\n`);
    commit(dir, 'plain');
    const r = guard(['scan', 'commits', `${root}..HEAD`], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^VERDICT block$/m);
    assert.doesNotMatch(r.stdout, /[\r\x1b\u2028\u2029]/);
    assert.match(r.stdout, /^PRIVATE|^UNCLASSED 1$/m);
  });

  test(`NL-4 (${label}): scan files blocks it`, (t) => {
    const { dir } = baseRepo(t);
    const scratch = mkTmp(t, 'scriptorium-nlpath-files-');
    write(scratch, name, `mentions ${TERM}\n`);
    const r = guard(['scan', 'files', path.join(scratch, 'docs')], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^VERDICT block$/m);
    assert.doesNotMatch(r.stdout, /[\r\x1b\u2028\u2029]/);
  });

  test(`NL-5 (${label}): release and pre-push block it`, (t) => {
    const { dir, root } = baseRepo(t);
    write(dir, name, `mentions ${TERM}\n`);
    commit(dir, 'plain');
    const h = head(dir);
    const rel = guard(['release', root, h], { cwd: dir, publicRoot: root });
    assert.equal(rel.code, 1, rel.stdout + rel.stderr);
    assert.match(rel.stdout, /^VERDICT block$/m);
    const push = guard(['pre-push', 'origin', PUSH_URL], { cwd: dir, stdin: `refs/heads/main ${h} refs/heads/main ${root}\n`, publicRoot: root });
    assert.equal(push.code, 1, push.stdout + push.stderr);
    assert.match(push.stdout, /^VERDICT block$/m);
  });
}

test('NL-6: a forbidden docs/agent-runs path whose name holds a newline is still counted as forbidden', (t) => {
  const { dir, root } = baseRepo(t);
  write(dir, 'docs/agent-runs/run\none.md', 'clean\n');
  commit(dir, 'plain');
  const r = guard(['release', root, head(dir)], { cwd: dir, publicRoot: root });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FORBIDDEN 1$/m);
});

test('NL-7: a CLAUDE.local.md whose directory name holds a newline is still counted as forbidden', (t) => {
  const { dir, root } = baseRepo(t);
  write(dir, 'x\ny/CLAUDE.local.md', 'clean\n');
  commit(dir, 'plain');
  const r = guard(['release', root, head(dir)], { cwd: dir, publicRoot: root });
  assert.match(r.stdout, /^FORBIDDEN 1$/m);
  assert.equal(r.code, 1);
});

test('NL-8: ci blocks a hygiene hit in a newline-named file', (t) => {
  const { dir, root } = baseRepo(t);
  write(dir, 'docs/a\nb.md', `host ${['10', '1', '2', '3'].join('.')} here\n`);
  commit(dir, 'plain');
  const r = guard(['ci'], { cwd: dir, publicRoot: root });
  assert.equal(r.code, 1, r.stdout + r.stderr);
});

test('NL-9: fail closed on the guard side: a scanner row the parser cannot read blocks', (t) => {
  const { dir } = baseRepo(t);
  // A stand-in scanner that reports one hit but splits the row over two lines (the pre-fix shape).
  const splitScanner = (_argv, { stdout }) => {
    stdout.write('MODE tree\nENTRIES terms=1 patterns=0 allow=0\nHIT 1 docs/new\nline.md word=1\n');
    stdout.write('TOTAL hits=1 targets=1 scanned=1 allowed=0 missing=0 symlinks=0 unused-allow=0\n');
    return 1;
  };
  const r = guard(['scan', 'tree', 'HEAD'], { cwd: dir, scanRun: splitScanner });
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /^UNCLASSED 1$/m);
  assert.match(r.stdout, /^VERDICT block$/m);
});

test('NL-10: fail closed on the guard side: a TOTAL that exceeds the rows it listed blocks', (t) => {
  const { dir } = baseRepo(t);
  const lyingScanner = (_argv, { stdout }) => {
    stdout.write('MODE tree\nENTRIES terms=1 patterns=0 allow=0\n');
    stdout.write('TOTAL hits=3 targets=1 scanned=1 allowed=0 missing=0 symlinks=0 unused-allow=0\n');
    return 1;
  };
  const r = guard(['scan', 'tree', 'HEAD'], { cwd: dir, scanRun: lyingScanner });
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /^VERDICT block$/m);
});

test('NL-11: a clean tree with a newline-named clean file still passes (no false block)', (t) => {
  const { dir } = baseRepo(t);
  write(dir, 'docs/new\nline.md', 'nothing listed\n');
  commit(dir, 'plain');
  const r = guard(['scan', 'tree', 'HEAD'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^VERDICT pass$/m);
});

for (const [label, name, escaped] of NAMES) {
  test(`NL-12 (${label}): scan tree of the working copy (no revision) blocks it, committed or not`, (t) => {
    const { dir } = baseRepo(t);
    write(dir, name, `mentions ${TERM}\n`);
    const untracked = guard(['scan', 'tree'], { cwd: dir });
    assertBlockedAndOneLine(untracked, escaped, `${label} untracked`);
    commit(dir, 'plain');
    assertBlockedAndOneLine(guard(['scan', 'tree'], { cwd: dir }), escaped, `${label} committed`);
  });
}
