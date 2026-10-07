'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assertNoticesFresh, NOTICES_PATH } = require('../scripts/notices-freshness');
const { buildNoticesText } = require('../scripts/generate-notices');
const pkg = require('../package.json');

// -- assertNoticesFresh(): the committed file, as it actually sits in the repo right now --

test('assertNoticesFresh() passes against the real, committed THIRD-PARTY-NOTICES.txt', () => {
  const { ok, detail } = assertNoticesFresh();
  assert.equal(ok, true, detail);
  assert.equal(detail, null);
  assert.equal(NOTICES_PATH, path.join(__dirname, '..', 'THIRD-PARTY-NOTICES.txt'));
});

// -- assertNoticesFresh(): every failure branch, against scratch copies --

test('assertNoticesFresh() fails when the file does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notices-fresh-'));
  const missingPath = path.join(dir, 'THIRD-PARTY-NOTICES.txt');
  const { ok, detail } = assertNoticesFresh(missingPath);
  assert.equal(ok, false);
  assert.match(detail, /does not exist/);
  assert.match(detail, /npm run notices/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assertNoticesFresh() fails when the committed file has drifted from what would be generated now', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notices-fresh-'));
  const stalePath = path.join(dir, 'THIRD-PARTY-NOTICES.txt');
  fs.writeFileSync(stalePath, 'Generated: 2020-01-01T00:00:00.000Z\nthis is not the real content at all\n');
  const { ok, detail } = assertNoticesFresh(stalePath);
  assert.equal(ok, false);
  assert.match(detail, /does not match what scripts\/generate-notices\.js produces/);
  assert.match(detail, /npm run notices/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assertNoticesFresh() passes for a freshly generated copy even with a different "Generated:" timestamp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notices-fresh-'));
  const freshPath = path.join(dir, 'THIRD-PARTY-NOTICES.txt');
  const text = buildNoticesText().replace(/^Generated: .*$/m, 'Generated: 1999-12-31T23:59:59.999Z');
  fs.writeFileSync(freshPath, text);
  const { ok, detail } = assertNoticesFresh(freshPath);
  assert.equal(ok, true, detail);
  fs.rmSync(dir, { recursive: true, force: true });
});

// -- AC-26-01/AC-26-02: the version stamp (Issue #26) --

// SemVer 2.0 grammar (https://semver.org/#spec-item-9): MAJOR.MINOR.PATCH, optionally
// followed by a hyphen and a dot-separated run of alphanumeric/hyphen identifiers (the
// prerelease). A release like the current 0.3.0-rc.1 is a valid stamp; a bare
// `/^\d+\.\d+\.\d+$/` is not wrong today but rejects every prerelease build by construction,
// which is exactly the class of "hardcoded shape blocks the next legitimate release" bug this
// file already warns about for the version literal below. Widened here, not removed: the
// shape check is still real, it just needs to admit the grammar semver itself allows.
const SEMVER_WITH_OPTIONAL_PRERELEASE_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;

test('AC-26-01: the semver-with-optional-prerelease shape check accepts real shapes and rejects garbage', () => {
  // Explicit, hardcoded cases -- not derived from pkg.version or buildNoticesText() -- so this
  // is a genuine check of the regex's behaviour rather than a restatement of it.
  for (const good of ['0.3.0', '0.3.0-rc.1']) {
    assert.match(good, SEMVER_WITH_OPTIONAL_PRERELEASE_RE, `expected "${good}" to look like a semver version`);
  }
  for (const bad of ['v0.3.0', '0.3', '0.3.0-']) {
    assert.doesNotMatch(bad, SEMVER_WITH_OPTIONAL_PRERELEASE_RE, `expected "${bad}" NOT to look like a semver version`);
  }
});

test('AC-26-01: buildNoticesText() stamps the current package.json version in the header', () => {
  const text = buildNoticesText();

  // This used to also assert `pkg.version === '0.2.2'` and match the header
  // against a hardcoded `/^Scriptorium version: 0\.2\.2$/m` literal. That
  // literal was deliberate -- a Reviewer checked and approved it specifically
  // so this test could not derive its expectation from the code under test,
  // i.e. so it could not become tautological. That property was sound. Its
  // consequence was not: a hardcoded version literal fails on EVERY version
  // bump (this one included -- 0.2.2 -> 0.2.3 broke it), which makes the test
  // a release blocker by construction rather than a regression detector. The
  // literal is removed here for that reason, not because the anti-tautology
  // concern was wrong -- do not read this as reopening it or put the literal
  // back on the next bump.
  //
  // The replacement keeps the "don't derive the expectation from the code
  // under test" property without hardcoding a version: `pkg` (required at the
  // top of this file, off the same package.json on disk, via a completely
  // different code path -- `require()`'s cache -- to buildNoticesText()'s own
  // fresh `fs.readFileSync` of it) supplies an independently-obtained
  // expected value that still moves with every bump.
  //
  // Residual, stated honestly per this project's convention (see
  // src/build/plan.js:41-56): comparing the stamp to `pkg.version` proves the
  // two AGREE. It cannot prove buildNoticesText() got its value BY reading
  // package.json, as opposed to some other source that happens to carry the
  // same string right now -- e.g. a hardcoded literal that has not yet drifted.
  // That gap is real and this test does not close it.
  const match = text.match(/^Scriptorium version: (.+)$/m);
  assert.ok(match, 'expected a "Scriptorium version: <version>" line in the generated header');
  assert.match(
    match[1],
    SEMVER_WITH_OPTIONAL_PRERELEASE_RE,
    `stamped version "${match[1]}" does not look like a semver version`,
  );
  assert.equal(match[1], pkg.version);
});

test('AC-26-02: assertNoticesFresh() fails when only the version line has drifted, and names package.json as a possible cause', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notices-fresh-'));
  try {
    const drifted = buildNoticesText().replace(/^Scriptorium version: .*$/m, 'Scriptorium version: 9.9.9');
    const driftedPath = path.join(dir, 'THIRD-PARTY-NOTICES.txt');
    fs.writeFileSync(driftedPath, drifted);

    const { ok, detail } = assertNoticesFresh(driftedPath);
    assert.equal(ok, false);
    assert.match(detail, /package\.json/);
    assert.match(detail, /npm run notices/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
