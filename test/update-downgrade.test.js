'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runUpdateCommand } = require('../src/cli/update');
const { EXIT_CODES } = require('../src/util/exitcodes');
const { compareVersions } = require('../src/update/semver');
const pkg = require('../package.json');

/*
 * Defect (the Windows verifier, rc.2 Windows verification channel note): `update` treated whatever
 * /releases/latest returned as newer than the running version with no
 * ordering check, so a prerelease user (rc.2) was silently "updated" down
 * to the last stable release (0.2.3). This file is the reproduction plus
 * the decision-path coverage for the fix: never offer or install a
 * version <= the running one, under both plain `update` and
 * `update --check`, and never call it "updated" when refusing.
 *
 * This repo's own running version is itself a prerelease
 * (`pkg.version`, currently 0.3.0-rc.2), so the exact defect scenario is
 * reproduced directly against package.json's real value rather than a
 * hardcoded literal (CLAUDE.md: "a hardcoded version literal is a
 * release blocker" -- residual: if this repo ever ships a non-prerelease
 * version, this file's "running version is a prerelease" premise no
 * longer holds and these tests would need a scratch package.json-style
 * override; not attempted here since runUpdateCommand reads
 * ../../package.json directly and has no injection point for it).
 */

function makeScratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeExeAndTmp(root, exeName = 'scriptorium') {
  const exeDir = path.join(root, 'exe');
  fs.mkdirSync(exeDir);
  const execPath = path.join(exeDir, exeName);
  fs.writeFileSync(execPath, 'stub-current-binary');
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(tmpRoot);
  return { exeDir, execPath, tmpRoot };
}

const MZ_HEADER = Buffer.from([0x4d, 0x5a, 0x00, 0x00]);

/** A packaged-path dep set (isPkg:true, platform:win32) that would prove an install happened if it ran. */
function installDeps({ execPath, tmpRoot, tagName }) {
  let downloadCalled = false;
  let replaceCalled = false;
  return {
    execPath,
    platform: 'win32',
    tmpRoot,
    isPkg: true,
    requireGh: () => '/usr/bin/gh',
    fetchLatestRelease: () => ({ tag_name: tagName, html_url: `https://example.test/releases/${tagName}` }),
    downloadAsset: (ghPath, tag, pattern, dir) => {
      downloadCalled = true;
      fs.writeFileSync(path.join(dir, pattern), MZ_HEADER);
    },
    verifyDownload: () => {},
    replaceExecutable: () => {
      replaceCalled = true;
      return { oldPath: 'unused' };
    },
    _wasCalled: () => ({ downloadCalled, replaceCalled }),
  };
}

// ---------------------------------------------------------------------------
// Reproduction: rc.2 -> 0.2.3 must be refused, not offered/installed.
// ---------------------------------------------------------------------------

test('DEFECT REPRO: `update --check` on a prerelease never reports a lower stable tag as available', () => {
  const root = makeScratch('scriptorium-downgrade-t1-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = installDeps({ execPath, tmpRoot, tagName: 'v0.2.3' });

    const result = runUpdateCommand({ check: true }, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.doesNotMatch(result.human, /update available/);
    assert.doesNotMatch(result.human, /\bupdated\b/i, 'must never use the word "updated" for a refused downgrade');
    assert.equal(deps._wasCalled().downloadCalled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DEFECT REPRO: `update` (no --check) on a prerelease never installs a lower stable tag', () => {
  const root = makeScratch('scriptorium-downgrade-t2-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = installDeps({ execPath, tmpRoot, tagName: 'v0.2.3' });

    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.doesNotMatch(result.human, /\bupdated\b/i, 'must never use the word "updated" for a refused downgrade');
    assert.equal(deps._wasCalled().downloadCalled, false, 'must never download a downgrade candidate');
    assert.equal(deps._wasCalled().replaceCalled, false, 'must never replace the running binary with a downgrade candidate');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DEFECT REPRO: the refusal message names both versions and points at --pre, independent of the exact wording', () => {
  const root = makeScratch('scriptorium-downgrade-t3-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = installDeps({ execPath, tmpRoot, tagName: 'v0.2.3' });

    const result = runUpdateCommand({}, deps);

    assert.match(result.human, new RegExp(pkg.version.replace(/\./g, '\\.')), 'must name the running version');
    assert.match(result.human, /0\.2\.3/, 'must name the rejected candidate');
    assert.match(result.human, /--pre/);
    assert.match(result.human, /nothing changed/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A real upgrade (higher version) must still work, unaffected by the fix.
// Both of these already passed against today's (pre-fix) code -- the old
// string-equality check never touched the "genuinely higher" path -- so on
// their own they prove nothing about the fix. They are regression coverage,
// not fix evidence; the DEFECT REPRO tests above are the evidence.
// ---------------------------------------------------------------------------

test('regression: a genuinely higher tag is still offered under --check', () => {
  const root = makeScratch('scriptorium-downgrade-t4-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = installDeps({ execPath, tmpRoot, tagName: 'v9.9.9' });

    const result = runUpdateCommand({ check: true }, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.match(result.human, /update available/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regression: a genuinely higher tag is still installed without --check', () => {
  const root = makeScratch('scriptorium-downgrade-t5-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = installDeps({ execPath, tmpRoot, tagName: 'v9.9.9' });

    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.match(result.human, /^updated /);
    assert.equal(deps._wasCalled().downloadCalled, true);
    assert.equal(deps._wasCalled().replaceCalled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Equal versions: unchanged "already at the latest" behaviour, now reached
// via the semver comparator (cmp === 0) instead of a raw string match, so
// a tag with a "v" prefix must still hit this branch. This also already
// passed against today's (pre-fix) code, since the old string-equality
// check matched this exact shape (tag === `v${currentVersion}`); it proves
// only that the rewrite did not regress this case, not that the fix works.
// ---------------------------------------------------------------------------

test('a tag exactly equal (with a leading v) to the running version is "already at the latest"', () => {
  const root = makeScratch('scriptorium-downgrade-t6-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = installDeps({ execPath, tmpRoot, tagName: `v${pkg.version}` });

    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.match(result.human, /already at the latest version/);
    assert.equal(deps._wasCalled().downloadCalled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C46: update --pre, when the running version is already the newest across
// stable and prerelease alike, must refuse the same way (no --pre-specific
// escape hatch to suggest, since --pre is already what was used).
// ---------------------------------------------------------------------------

test('C46: `update --pre` refuses when nothing (stable or prerelease) beats the running version', () => {
  const root = makeScratch('scriptorium-downgrade-t7-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = installDeps({ execPath, tmpRoot, tagName: 'v0.2.3' });

    const result = runUpdateCommand({ pre: true }, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.doesNotMatch(result.human, /\bupdated\b/i);
    assert.equal(deps._wasCalled().downloadCalled, false);
    // Already used --pre, so the message must not tell the user to run it again.
    assert.doesNotMatch(result.human, /run `update --pre`/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail closed on a malformed tag: never offer it, never crash uncaught.
// ---------------------------------------------------------------------------

test('a malformed release tag is refused, not offered, and reported as a Scriptorium error (exit 1)', () => {
  const root = makeScratch('scriptorium-downgrade-t8-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = installDeps({ execPath, tmpRoot, tagName: 'not-a-version' });

    const result = runUpdateCommand({ check: true }, deps);

    assert.equal(result.exitCode, EXIT_CODES.SCRIPTORIUM_ERROR, result.human);
    assert.doesNotMatch(result.human, /update available/);
    assert.equal(deps._wasCalled().downloadCalled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The packaged-binary update path (isPkg:true) must use the SAME comparator
// as the one under direct exhaustive test in update-semver.test.js, not an
// independent reimplementation that happens to agree today. This is a
// unit-level cross-check (isPkg:true is this repo's own established way of
// exercising "the packaged-binary update path" under plain node -- see
// test/update-packaged-guard.test.js P5a-FR07 -- not a real pkg-built exe;
// CLAUDE.md's "verify the artefact" rule is about packaging/Windows-
// specific behaviour such as bytecode or Intl.Segmenter, not about which
// pure-JS comparator function a source module calls, which the packager
// does not rewrite).
// ---------------------------------------------------------------------------

test('packaged path (isPkg:true) agrees with src/update/semver.js\'s own verdict on the same pair', () => {
  const root = makeScratch('scriptorium-downgrade-t9-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = installDeps({ execPath, tmpRoot, tagName: 'v0.2.3' });

    const independentVerdict = compareVersions(pkg.version, 'v0.2.3');
    assert.ok(independentVerdict > 0, 'sanity: the running (prerelease) version must independently compare higher');

    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.doesNotMatch(result.human, /\bupdated\b/i, 'the packaged path must have reached the same refusal the comparator predicts');
    assert.equal(deps._wasCalled().replaceCalled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
