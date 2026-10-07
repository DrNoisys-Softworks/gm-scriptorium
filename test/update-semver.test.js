'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseVersion, compareVersions } = require('../src/update/semver');
const { pickHighestRelease } = require('../src/update/release');

/*
 * Exhaustive, independently-stated coverage for the semver 2.0.0 precedence
 * comparator: every expected value below is a literal the spec defines,
 * never read from the implementation under test (CLAUDE.md: "never derive
 * an assertion's expected value from the code under test").
 */

// ---------------------------------------------------------------------------
// parseVersion(): well-formed inputs
// ---------------------------------------------------------------------------

test('parseVersion(): a plain release parses major/minor/patch with prerelease null', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null, raw: '1.2.3' });
});

test('parseVersion(): a leading "v" is accepted and stripped from the parsed fields', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null, raw: 'v1.2.3' });
});

test('parseVersion(): a prerelease splits into dot-separated identifiers', () => {
  assert.deepEqual(parseVersion('0.3.0-rc.2'), { major: 0, minor: 3, patch: 0, prerelease: ['rc', '2'], raw: '0.3.0-rc.2' });
});

test('parseVersion(): build metadata is parsed away and does not appear in the result', () => {
  const parsed = parseVersion('1.2.3+build.5');
  assert.equal(parsed.major, 1);
  assert.equal(parsed.minor, 2);
  assert.equal(parsed.patch, 3);
  assert.equal(parsed.prerelease, null);
});

// ---------------------------------------------------------------------------
// parseVersion(): malformed inputs must fail closed (return null, never throw)
// ---------------------------------------------------------------------------

for (const bad of [
  'not-a-version',
  '',
  'v',
  '1.2',
  '1.2.3.4',
  '1.02.3', // leading zero on a numeric core identifier
  '1.2.3-', // trailing dash with empty prerelease
  '1.2.3-01', // leading zero on a numeric prerelease identifier
  '1.2.3-rc..2', // empty identifier between dots
  'latest',
  null,
  undefined,
  42,
]) {
  test(`parseVersion(): ${JSON.stringify(bad)} is malformed and returns null, not a throw`, () => {
    assert.equal(parseVersion(bad), null);
  });
}

// ---------------------------------------------------------------------------
// parseVersion(): fail-closed against Number() overflow on unbounded core
// identifiers (Reviewer finding on 1953a2e). The regex placed no digit-count
// bound on major/minor/patch, so a huge digit string parses fine as a
// *string* but Number() of it silently rounds to Infinity -- a value that
// then compares equal to any other huge/overflowing value, which is the
// opposite of "fail closed": a garbage tag was being treated as sortable
// (and, via pickHighestRelease, offered) instead of rejected.
// ---------------------------------------------------------------------------

test('parseVersion(): a 50+ digit major is malformed and returns null, not Infinity', () => {
  const hugeMajor = '9'.repeat(60);
  assert.equal(parseVersion(`${hugeMajor}.0.0`), null);
});

test('parseVersion(): a 50+ digit minor or patch is likewise malformed and returns null', () => {
  const huge = '9'.repeat(60);
  assert.equal(parseVersion(`1.${huge}.0`), null);
  assert.equal(parseVersion(`1.0.${huge}`), null);
});

test('compareVersions(): two DIFFERENT huge-major tags must never compare equal (both fail closed, not both -> Infinity)', () => {
  const a = `${'9'.repeat(60)}.0.0`;
  const b = `${'8'.repeat(60)}.0.0`;
  assert.equal(compareVersions(a, b), null, 'a real semver comparator must not treat two unbounded garbage tags as equal');
});

test('parseVersion(): a 50+ digit numeric PRERELEASE identifier is also malformed and returns null (same overflow class)', () => {
  // compareIdentifier() below applies the identical Number(x) === Number(y) equality check to
  // numeric prerelease identifiers, so this is the same defect class as the core-identifier
  // case above, just one level down; closed here for the same reason.
  assert.equal(parseVersion(`1.0.0-${'9'.repeat(60)}`), null);
});

// ---------------------------------------------------------------------------
// compareVersions(): equal versions
// ---------------------------------------------------------------------------

test('compareVersions(): identical releases are equal', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('compareVersions(): identical prereleases are equal', () => {
  assert.equal(compareVersions('0.3.0-rc.2', '0.3.0-rc.2'), 0);
});

// Coverage gap flagged on 1953a2e's review: build metadata (the "+..." suffix, semver 2.0.0
// section 10) must never affect precedence. parseVersion() parses it out of the regex match
// but never carries it into the returned object's shape, so nothing downstream can compare it
// -- this test pins that down explicitly rather than leaving it as an implicit consequence of
// parseVersion's shape that a later change could quietly break inside comparePrecedence()
// (which still has access to each side's raw, unparsed string).
test('compareVersions(): build metadata is ignored for precedence, even when it differs (1.2.3+build.1 == 1.2.3+build.2)', () => {
  assert.equal(compareVersions('1.2.3+build.1', '1.2.3+build.2'), 0);
});

// ---------------------------------------------------------------------------
// compareVersions(): leading "v" on either or both sides must not change the result
// ---------------------------------------------------------------------------

test('compareVersions(): "v" on one side only still compares equal for the same version', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', 'v1.2.3'), 0);
});

test('compareVersions(): "v" on both sides does not affect ordering', () => {
  assert.equal(compareVersions('v1.2.3', 'v1.2.4'), -1);
  assert.equal(compareVersions('v1.2.4', 'v1.2.3'), 1);
});

// ---------------------------------------------------------------------------
// compareVersions(): prerelease vs release (the exact shape of the defect)
// ---------------------------------------------------------------------------

test('compareVersions(): 0.2.3 < 0.3.0-rc.1 (an older stable release is lower than a newer prerelease)', () => {
  assert.equal(compareVersions('0.2.3', '0.3.0-rc.1'), -1);
  assert.equal(compareVersions('0.3.0-rc.1', '0.2.3'), 1);
});

test('compareVersions(): 0.3.0-rc.2 > 0.2.3 (this repo\'s exact rc.2 -> 0.2.3 defect pair)', () => {
  assert.equal(compareVersions('0.3.0-rc.2', '0.2.3'), 1);
});

test('compareVersions(): a release is greater than its own prerelease at the same core version (0.3.0-rc.2 < 0.3.0)', () => {
  assert.equal(compareVersions('0.3.0-rc.2', '0.3.0'), -1);
  assert.equal(compareVersions('0.3.0', '0.3.0-rc.2'), 1);
});

// ---------------------------------------------------------------------------
// compareVersions(): prerelease ordering, including numeric identifiers
// ---------------------------------------------------------------------------

test('compareVersions(): 0.3.0-rc.1 < 0.3.0-rc.2 (prerelease ordinal ordering)', () => {
  assert.equal(compareVersions('0.3.0-rc.1', '0.3.0-rc.2'), -1);
});

test('compareVersions(): numeric prerelease identifiers compare numerically, not lexically: rc.10 > rc.2', () => {
  // A naive string compare would put "rc.10" before "rc.2" ("1" < "2" as characters);
  // semver 2.0.0 rule 11 requires numeric identifiers to compare as numbers.
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
});

test('compareVersions(): a prerelease with more fields outranks a shared-prefix shorter one (1.0.0-alpha < 1.0.0-alpha.1)', () => {
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
});

test('compareVersions(): numeric prerelease identifiers always rank below alphanumeric ones (1.0.0-1 < 1.0.0-alpha)', () => {
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
});

// ---------------------------------------------------------------------------
// compareVersions(): major/minor/patch ordering (unaffected by any of the above)
// ---------------------------------------------------------------------------

test('compareVersions(): major/minor/patch ordering is numeric, not lexical (1.9.0 < 1.10.0)', () => {
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
});

// ---------------------------------------------------------------------------
// compareVersions(): malformed tags fail closed
// ---------------------------------------------------------------------------

test('compareVersions(): a malformed tag on either side returns null, never a number', () => {
  assert.equal(compareVersions('not-a-version', '1.2.3'), null);
  assert.equal(compareVersions('1.2.3', 'not-a-version'), null);
  assert.equal(compareVersions('not-a-version', 'also-not-one'), null);
});

// ---------------------------------------------------------------------------
// pickHighestRelease() (src/update/release.js): the --pre selection logic,
// tested directly with injected literal release lists -- no gh, no network,
// no runUpdateCommand involved. "Not by publish date or list order" is
// tested by scrambling list order and confirming the same winner.
// ---------------------------------------------------------------------------

test('pickHighestRelease(): picks the highest by semver across stable AND prerelease releases', () => {
  const releases = [
    { tag_name: 'v0.2.3', prerelease: false },
    { tag_name: 'v0.3.0-rc.1', prerelease: true },
    { tag_name: 'v0.3.0-rc.2', prerelease: true },
  ];
  assert.equal(pickHighestRelease(releases).tag_name, 'v0.3.0-rc.2');
});

test('pickHighestRelease(): a stable release beats an older prerelease, even if listed after it', () => {
  const releases = [
    { tag_name: 'v0.3.0-rc.1', prerelease: true },
    { tag_name: 'v0.2.5', prerelease: false },
  ];
  // 0.3.0-rc.1 > 0.2.5 by semver even though it's a prerelease: this exercises the
  // cross-category comparison, not just "stable always wins".
  assert.equal(pickHighestRelease(releases).tag_name, 'v0.3.0-rc.1');
});

test('pickHighestRelease(): list order/publish order is irrelevant -- the max wins regardless of position', () => {
  const inOrder = [
    { tag_name: 'v0.3.0-rc.2' },
    { tag_name: 'v0.1.0' },
    { tag_name: 'v0.3.0-rc.10' },
    { tag_name: 'v0.2.9' },
  ];
  const scrambled = [inOrder[3], inOrder[1], inOrder[0], inOrder[2]];

  assert.equal(pickHighestRelease(inOrder).tag_name, 'v0.3.0-rc.10');
  assert.equal(pickHighestRelease(scrambled).tag_name, 'v0.3.0-rc.10');
});

test('pickHighestRelease(): a malformed tag in the list is skipped, never selected', () => {
  const releases = [
    { tag_name: 'not-a-version' },
    { tag_name: 'v0.1.0' },
  ];
  assert.equal(pickHighestRelease(releases).tag_name, 'v0.1.0');
});

test('pickHighestRelease(): a tag whose core identifier overflows Number precision is excluded, never selected', () => {
  // Reviewer finding: before the overflow guard, this huge tag parsed to major: Infinity and
  // was picked over v0.3.0-rc.2-shaped real tags. Fixed at parseVersion(); this is the
  // decision-layer proof that the exclusion actually reaches pickHighestRelease().
  const hugeTag = `v${'9'.repeat(60)}.0.0`;
  const releases = [
    { tag_name: 'v0.1.0' },
    { tag_name: hugeTag },
  ];
  assert.equal(pickHighestRelease(releases).tag_name, 'v0.1.0');
});

test('pickHighestRelease(): a draft release is never selected even if its tag would otherwise win', () => {
  const releases = [
    { tag_name: 'v0.1.0', draft: false },
    { tag_name: 'v9.9.9', draft: true },
  ];
  assert.equal(pickHighestRelease(releases).tag_name, 'v0.1.0');
});

test('pickHighestRelease(): an empty or all-malformed/all-draft list returns null (fail closed, nothing offered)', () => {
  assert.equal(pickHighestRelease([]), null);
  assert.equal(pickHighestRelease([{ tag_name: 'not-a-version' }]), null);
  assert.equal(pickHighestRelease([{ tag_name: 'v1.0.0', draft: true }]), null);
});
