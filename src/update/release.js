'use strict';

const { runGh } = require('./gh');
const { UpdatePrerequisiteError, ScriptoriumError } = require('../util/errors');
const { parseVersion, compareVersions } = require('./semver');

const REPO = 'DrNoisys-Softworks/gm-scriptorium';

/**
 * One wording for "nothing published yet", shared by the /releases/latest 404 path and the
 * --pre empty-list path, so the two can never drift (both exit 4, the update-prerequisite code).
 */
function noReleaseYetError() {
  return new UpdatePrerequisiteError(
    `gh could not find a release for ${REPO} (404): no release has been published there yet, ` +
      `or the requested tag does not exist. See https://github.com/${REPO}/releases.`,
  );
}

/**
 * Never uses --jq (the flag surface varies across gh versions); parses
 * JSON in Scriptorium instead (Engineering Brief section 6).
 */
function fetchLatestRelease(ghPath, { pre = false, version = null } = {}) {
  let args;
  if (version) {
    args = ['api', `repos/${REPO}/releases/tags/${version}`];
  } else if (pre) {
    args = ['api', `repos/${REPO}/releases?per_page=30`];
  } else {
    args = ['api', `repos/${REPO}/releases/latest`];
  }

  const result = runGh(ghPath, args);
  if (result.status !== 0) {
    // A 404 from the release lookup is indistinguishable from "no such release" without
    // further information: never attempt an unauthenticated fallback that would produce a
    // confidently wrong message either way.
    if (/404/.test(result.stderr || '')) {
      throw noReleaseYetError();
    }
    throw new ScriptoriumError(`gh api failed: ${(result.stderr || result.stdout || '').trim()}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new ScriptoriumError(`gh returned malformed JSON: ${err.message}`);
  }

  if (pre && !version) {
    // Defect fix: this used to filter to r.prerelease and return the first (list-order,
    // not semver) entry, which both excluded stable releases from --pre entirely and
    // ignored ordering. --pre must consider stable AND prerelease releases and pick the
    // true semver max (required behaviour 2).
    // An empty list is the expected "nothing published yet" state (exit 4), not a Scriptorium
    // bug. A non-empty list with nothing usable (drafts / malformed tags) stays a plain error.
    if (Array.isArray(parsed) && parsed.length === 0) {
      throw noReleaseYetError();
    }
    const best = pickHighestRelease(parsed);
    if (!best) {
      throw new ScriptoriumError(`no usable release found for ${REPO}`);
    }
    return best;
  }
  return parsed;
}

/**
 * Picks the highest-precedence release by real semver ordering (src/update/semver.js),
 * across stable and prerelease releases alike -- never by publish date or list order.
 * Drafts and releases with a malformed tag are skipped (fail closed: never offered).
 *
 * @param {Array<{ tag_name: string, draft?: boolean }>} releases
 * @returns {object|null} the winning release object, or null if nothing usable was found
 */
function pickHighestRelease(releases) {
  const candidates = releases.filter((r) => r && !r.draft && parseVersion(r.tag_name));
  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (compareVersions(candidate.tag_name, best.tag_name) > 0) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Downloads `pattern` and SHA256SUMS from `tag` into `dir` via
 * `gh release download`, which handles the authenticated request itself:
 * Scriptorium never sees a raw asset URL or token.
 */
function downloadAsset(ghPath, tag, pattern, dir) {
  const result = runGh(ghPath, [
    'release',
    'download',
    tag,
    '--repo',
    REPO,
    '--pattern',
    pattern,
    '--dir',
    dir,
    '--clobber',
  ]);
  if (result.status !== 0) {
    throw new ScriptoriumError(`gh release download failed: ${(result.stderr || '').trim()}`);
  }
  const sums = runGh(ghPath, [
    'release',
    'download',
    tag,
    '--repo',
    REPO,
    '--pattern',
    'SHA256SUMS',
    '--dir',
    dir,
    '--clobber',
  ]);
  if (sums.status !== 0) {
    throw new ScriptoriumError(`gh release download of SHA256SUMS failed: ${(sums.stderr || '').trim()}`);
  }
}

module.exports = { REPO, fetchLatestRelease, downloadAsset, pickHighestRelease };
