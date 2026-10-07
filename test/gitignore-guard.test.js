'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/*
 * FR-03's .gitignore guard (S0 Engineering Brief, AC-09). The first test in
 * this suite to spawn real git (risk area 6): `git` must be on PATH.
 *
 * Every invocation isolates config explicitly (GIT_CONFIG_GLOBAL=os.devNull,
 * GIT_CONFIG_NOSYSTEM=1, plus an isolated identity) so a signing key or a
 * global excludesfile on the machine running this suite can never leak in
 * (risk area 3) -- except in the one deliberately non-isolated case (see the
 * G4 mutation note below `checkIgnoreUnisolated`).
 *
 * SD-11: the guard uses real `git check-ignore -v`, working purely off the
 * pattern files rather than any tracked/staged state, in a fresh temp repo
 * seeded with THIS repo's real .gitignore (never a hand-typed
 * reimplementation -- parsing .gitignore yourself misses negation rules and
 * global excludes, which is exactly the class of bug this guard exists to
 * catch), and asserts the matching source is `.gitignore` itself, never a
 * global excludesfile or any other mechanism.
 */

const REPO_GITIGNORE = path.join(__dirname, '..', '.gitignore');

const ISOLATED_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
};

const IDENTITY_ARGS = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];

function makeRepo(t, { gitignoreText } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gitignore-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', [...IDENTITY_ARGS, 'init', '--quiet', dir], { env: ISOLATED_ENV, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, '.gitignore'), gitignoreText !== undefined ? gitignoreText : fs.readFileSync(REPO_GITIGNORE, 'utf8'));
  return dir;
}

/** @returns {{ ignored: boolean, source: string|null }} */
function checkIgnore(dir, relPath, { env = ISOLATED_ENV } = {}) {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync('git', ['-c', 'core.quotePath=false', 'check-ignore', '-v', '--no-index', '--', relPath], {
      cwd: dir,
      env,
      stdio: 'pipe',
    }).toString('utf8');
    status = 0;
  } catch (err) {
    stdout = (err.stdout || '').toString('utf8');
    status = err.status;
  }
  if (status !== 0) return { ignored: false, source: null };
  const line = stdout.split('\n').find((l) => l.length > 0) || '';
  const tabIdx = line.indexOf('\t');
  const meta = tabIdx === -1 ? line : line.slice(0, tabIdx);
  // meta is "<source>:<line>:<pattern>"; <pattern> itself may legitimately contain ':',
  // so split off <source> by its first ':' only, which is always the source/line separator
  // for a plain file source (a real .gitignore path never contains ':').
  const firstColon = meta.indexOf(':');
  const source = firstColon === -1 ? meta : meta.slice(0, firstColon);
  return { ignored: true, source };
}

test('docs/agent-runs/<file> is ignored, matched via .gitignore', (t) => {
  const dir = makeRepo(t);
  const result = checkIgnore(dir, 'docs/agent-runs/some-brief.md');
  assert.equal(result.ignored, true);
  assert.equal(path.basename(result.source), '.gitignore');
});

test('docs/agent-runs/<dir>/<file> is ignored, matched via .gitignore', (t) => {
  const dir = makeRepo(t);
  const result = checkIgnore(dir, 'docs/agent-runs/sub/nested.md');
  assert.equal(result.ignored, true);
  assert.equal(path.basename(result.source), '.gitignore');
});

test('CLAUDE.local.md is ignored, matched via .gitignore', (t) => {
  const dir = makeRepo(t);
  const result = checkIgnore(dir, 'CLAUDE.local.md');
  assert.equal(result.ignored, true);
  assert.equal(path.basename(result.source), '.gitignore');
});

// Negative controls (AC-09; also what G3 -- a guard that reads "ignored"
// regardless of git's exit status -- would break).
test('CLAUDE.md stays unignored', (t) => {
  const dir = makeRepo(t);
  const result = checkIgnore(dir, 'CLAUDE.md');
  assert.equal(result.ignored, false);
});

// D-AUD (docs audience split): the agent index and the agent folder must stay tracked.
test('AGENTS.md stays unignored', (t) => {
  const dir = makeRepo(t);
  assert.equal(checkIgnore(dir, 'AGENTS.md').ignored, false);
});

test('.agents/<file> stays unignored', (t) => {
  const dir = makeRepo(t);
  assert.equal(checkIgnore(dir, '.agents/working-rules.md').ignored, false);
  assert.equal(checkIgnore(dir, '.agents/windows-verification.md').ignored, false);
});

test('docs/decisions/0001-packager.md stays unignored', (t) => {
  const dir = makeRepo(t);
  const result = checkIgnore(dir, 'docs/decisions/0001-packager.md');
  assert.equal(result.ignored, false);
});

test('scripts/denylist-scan.js stays unignored', (t) => {
  const dir = makeRepo(t);
  const result = checkIgnore(dir, 'scripts/denylist-scan.js');
  assert.equal(result.ignored, false);
});

// G4: even with a hostile global excludesfile listing CLAUDE.local.md, and
// even with git config isolation deliberately skipped, and even with the
// repo's own .gitignore missing the CLAUDE.local.md line (G2's mutation),
// the guard must still be red -- because it asserts the match SOURCE is
// exactly `.gitignore`, not merely that the path is "ignored" by *something*.
test('G4: a hostile global excludesfile cannot pass off as .gitignore', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gitignore-guard-home-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const excludesFile = path.join(homeDir, 'global-excludes');
  fs.writeFileSync(excludesFile, 'CLAUDE.local.md\n');
  const globalConfig = path.join(homeDir, 'gitconfig');
  fs.writeFileSync(globalConfig, `[core]\n\texcludesfile = ${excludesFile}\n`);

  const gitignoreWithoutLine = fs
    .readFileSync(REPO_GITIGNORE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== 'CLAUDE.local.md')
    .join('\n');
  const dir = makeRepo(t, { gitignoreText: gitignoreWithoutLine });

  // Deliberately NOT isolated the way ISOLATED_ENV is (that's the whole point of G4): reuses the
  // same checkIgnore() helper every other test above uses, just with a hostile env passed in.
  const unisolatedEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const result = checkIgnore(dir, 'CLAUDE.local.md', { env: unisolatedEnv });

  // Whatever `ignored` comes back as, the source must not be able to claim
  // to be .gitignore when it wasn't -- this is the assertion a real guard
  // test needs, independent of whether isolation happened to be in place.
  assert.notEqual(result.source, '.gitignore', 'a hostile global excludesfile must never be reported as .gitignore');
});
