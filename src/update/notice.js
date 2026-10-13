'use strict';

const release = require('./release');
const { parseVersion, compareVersions } = require('./semver');
const { ScriptoriumError } = require('../util/errors');

/*
 * The check core of the panel's update notice (docs/decisions/0028-installer-and-first-run.md,
 * addendum "The update notice"). Pure: no file system, no timers, no console. It asks the release
 * lookup (which goes through src/net/egress.js, ADR 0024) for the newest release on a channel and
 * says whether it is newer than the running version. The notes link is built here from the tag by
 * release.releaseNotesUrl, never taken from the reply. A later tray can call this same function.
 */

const DAY_MS = 86400000;
const CHECK_TIMEOUT_MS = 30000;

/** The channel a build follows when the GM has not chosen: beta on a prerelease build, else stable. */
function defaultChannel(currentVersion) {
  const parsed = parseVersion(currentVersion);
  return parsed !== null && parsed.prerelease !== null ? 'beta' : 'stable';
}

/** @param {'stable'|'beta'|null} saved */
function effectiveChannel(saved, currentVersion) {
  return saved === 'stable' || saved === 'beta' ? saved : defaultChannel(currentVersion);
}

/**
 * A check is due when nothing was stored, the stored time is in the future, or it is more than a
 * day old. Exactly a day is not due.
 */
function isDue(lastSuccessMs, nowMs) {
  if (!Number.isSafeInteger(lastSuccessMs)) return true;
  if (lastSuccessMs > nowMs) return true;
  return nowMs - lastSuccessMs > DAY_MS;
}

/**
 * @param {{ channel: 'stable'|'beta', currentVersion: string, signal?: AbortSignal }} args
 * @param {{ lookupRelease?: Function }} [deps]
 * @returns {Promise<{ state: 'available', tag: string, prerelease: boolean, notesUrl: string } | { state: 'current' }>}
 * @throws whatever the lookup throws, except "no release yet", which reads as current
 */
async function checkForUpdate({ channel, currentVersion, signal }, { lookupRelease = release.lookupRelease } = {}) {
  const flags = { totalTimeoutMs: CHECK_TIMEOUT_MS };
  if (signal !== undefined) flags.signal = signal;
  if (channel === 'beta') flags.pre = true;
  let found;
  try {
    found = await lookupRelease(flags);
  } catch (err) {
    if (err && err.reason === 'no-release') return { state: 'current' };
    throw err;
  }
  const tag = found && found.tag_name;
  if (!release.isSafeTag(tag)) throw new ScriptoriumError('GitHub named a release this version cannot read');
  const order = compareVersions(currentVersion, tag);
  if (order === null) throw new ScriptoriumError('the running version or the release version could not be compared');
  if (order !== -1) return { state: 'current' };
  return { state: 'available', tag, prerelease: found.prerelease === true, notesUrl: release.releaseNotesUrl(tag) };
}

module.exports = {
  DAY_MS,
  CHECK_TIMEOUT_MS,
  defaultChannel,
  effectiveChannel,
  isDue,
  checkForUpdate,
  isSafeTag: release.isSafeTag,
  notesUrl: release.releaseNotesUrl,
};
