'use strict';

/*
 * Semver 2.0.0 precedence, self-contained (no new runtime dependency: CLAUDE.md
 * "No new runtime dependency without saying so explicitly"). Used by both
 * src/update/release.js (picking the highest release across stable and
 * prerelease under --pre) and src/cli/update.js (refusing to offer or
 * install a version <= the running one). Pure and I/O-free, so it cannot
 * trip test/update-module-graph.test.js's network-call regex or its
 * vault/build reachability check.
 *
 * A tag may carry a leading "v" (GitHub convention here); that is stripped
 * before parsing, so "v0.2.3" and "0.2.3" compare and parse identically.
 */

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * @param {string} raw a version string, optionally "v"-prefixed
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[]|null, raw: string }|null}
 *   null for anything that is not a well-formed semver 2.0.0 version (fail closed: a caller
 *   must treat null as "cannot be offered", never as "assume it's fine").
 */
function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const m = SEMVER_RE.exec(trimmed);
  if (!m) return null;

  const [, major, minor, patch, prereleaseGroup] = m;

  // Reviewer finding on 1953a2e: the regex placed no digit-count bound on major/minor/patch,
  // so an arbitrarily long digit string matched fine as a *string* but Number() of it rounds
  // to Infinity once it exceeds Number.MAX_VALUE -- and Infinity === Infinity, so two
  // different huge/garbage tags compared equal instead of failing closed. Reject any core
  // identifier that isn't a safe integer, rather than trusting the regex's own digit shape.
  const majorNum = Number(major);
  const minorNum = Number(minor);
  const patchNum = Number(patch);
  if (!Number.isSafeInteger(majorNum) || !Number.isSafeInteger(minorNum) || !Number.isSafeInteger(patchNum)) {
    return null;
  }

  let prerelease = null;
  if (prereleaseGroup !== undefined) {
    prerelease = prereleaseGroup.split('.');
    for (const id of prerelease) {
      if (id === '') return null; // "..", leading/trailing dot: malformed
      const isNumeric = /^[0-9]+$/.test(id);
      if (isNumeric) {
        if (id.length > 1 && id[0] === '0') return null; // leading-zero numeric identifier
        // Same overflow class as major/minor/patch above: compareIdentifier() below applies
        // Number(x) === Number(y) to numeric prerelease identifiers too.
        if (!Number.isSafeInteger(Number(id))) return null;
      }
    }
  }

  return {
    major: majorNum,
    minor: minorNum,
    patch: patchNum,
    prerelease,
    raw: trimmed,
  };
}

/** Compares two already-parsed identifiers per semver 2.0.0 rule 11. */
function compareIdentifier(x, y) {
  const xNumeric = /^[0-9]+$/.test(x);
  const yNumeric = /^[0-9]+$/.test(y);
  if (xNumeric && yNumeric) {
    const xn = Number(x);
    const yn = Number(y);
    if (xn === yn) return 0;
    return xn < yn ? -1 : 1;
  }
  if (xNumeric && !yNumeric) return -1; // numeric identifiers always have lower precedence
  if (!xNumeric && yNumeric) return 1;
  if (x === y) return 0;
  return x < y ? -1 : 1; // ASCII sort order, per spec
}

/**
 * @param {{major,minor,patch,prerelease}} a already-parsed (never null)
 * @param {{major,minor,patch,prerelease}} b already-parsed (never null)
 * @returns {-1|0|1}
 */
function comparePrecedence(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1; // a has no prerelease: a > b (a release beats any of its own prereleases)
  if (!bPre) return -1;

  const len = Math.min(aPre.length, bPre.length);
  for (let i = 0; i < len; i += 1) {
    const cmp = compareIdentifier(aPre[i], bPre[i]);
    if (cmp !== 0) return cmp;
  }
  if (aPre.length !== bPre.length) return aPre.length < bPre.length ? -1 : 1;
  return 0;
}

/**
 * @param {string} rawA
 * @param {string} rawB
 * @returns {-1|0|1|null} null means "at least one side does not parse as a version" -- the
 *   fail-closed case. Callers must treat null as "cannot compare, do not offer", never as
 *   equal or as any particular ordering.
 */
function compareVersions(rawA, rawB) {
  const a = parseVersion(rawA);
  const b = parseVersion(rawB);
  if (!a || !b) return null;
  return comparePrecedence(a, b);
}

module.exports = { parseVersion, compareVersions };
