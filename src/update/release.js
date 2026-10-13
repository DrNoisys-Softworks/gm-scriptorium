'use strict';

const fs = require('fs');
const path = require('path');
const egress = require('../net/egress');
const { UpdatePrerequisiteError, ScriptoriumError } = require('../util/errors');
const { parseVersion, compareVersions } = require('./semver');
const pkg = require('../../package.json');

/*
 * Release lookup and download for `update` and `update --check`. Every request goes through
 * src/net/egress.js (ADR 0024): fixed destinations, no account, no token, no proxy. URLs are built
 * only from the constants below, a validated tag and a fixed asset name. A URL that comes back in a
 * reply is never followed or shown (the notes link is built here from the tag).
 */

const REPO = 'DrNoisys-Softworks/gm-scriptorium';
const API = `https://api.github.com/repos/${REPO}`;
const DL = `https://github.com/${REPO}/releases/download`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;

const USER_AGENT = 'GM-Scriptorium/' + pkg.version;
const CAPS = Object.freeze({ releaseJson: 2097152, sums: 65536, asset: 268435456 });
const ASSET_TOTAL_TIMEOUT_MS = 1800000;
const ASSET_REDIRECT_TO = Object.freeze(['github-release-assets']);

const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A tag that is a well-formed version with nothing around it, so it is safe to put in a URL. */
function isSafeTag(tag) {
  return typeof tag === 'string' && tag === tag.trim() && tag.length <= 64 && parseVersion(tag) !== null;
}

function releaseNotesUrl(tag) {
  return `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`;
}

/*
 * The update-prerequisite errors (exit 4). Each carries an own `reason` that the panel reads, and
 * one plain line that names the releases page where a manual download is the way out. None of them
 * holds a URL, a header or any text from a reply.
 */
function prerequisite(reason, message) {
  const err = new UpdatePrerequisiteError(message);
  err.reason = reason;
  return err;
}

/**
 * One wording for "nothing published yet", shared by the /releases/latest 404 path and the
 * --pre empty-list path, so the two can never drift (both exit 4, the update-prerequisite code).
 */
function noReleaseYetError() {
  return prerequisite(
    'no-release',
    `No release found for ${REPO} (404): no release has been published there yet, ` +
      `or the requested tag does not exist. See ${RELEASES_URL}.`,
  );
}
function rateLimitError() {
  return prerequisite(
    'rate-limit',
    `GitHub's limit on requests without an account has been reached. Try again later, or download a release from ${RELEASES_URL}.`,
  );
}
function unreachableError() {
  return prerequisite(
    'unreachable',
    `Could not reach GitHub. Check your internet connection and try again, or download a release from ${RELEASES_URL}.`,
  );
}
function tlsError() {
  return prerequisite(
    'tls',
    `The secure connection to GitHub could not be verified, so nothing was downloaded. Check the computer's clock, or download a release from ${RELEASES_URL}.`,
  );
}
function redirectError() {
  return prerequisite(
    'redirect',
    `GitHub answered in a way this version does not follow, so nothing was downloaded. Download a release from ${RELEASES_URL}.`,
  );
}

const UNREACHABLE_CODES = new Set(['E_NET_CONNECT', 'E_NET_TIMEOUT', 'E_NET_INCOMPLETE']);

/** Maps whatever a request threw to the error `update` reports (exit 4 for the network, 1 for the rest). */
function mapFailure(err) {
  if (err instanceof ScriptoriumError && !(typeof err.code === 'string' && err.code.startsWith('E_NET_'))) return err;
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (UNREACHABLE_CODES.has(code)) return unreachableError();
  if (code === 'E_NET_TLS') return tlsError();
  if (code === 'E_NET_REDIRECT') return redirectError();
  if (code === 'E_NET_RESPONSE_CAP') return new ScriptoriumError('GitHub sent a reply that was larger than expected, so it was not used.');
  return new ScriptoriumError('the request to GitHub could not be completed');
}

function statusFailure(status, headers) {
  if (status === 429 || (status === 403 && headers && headers['x-ratelimit-remaining'] === '0')) return rateLimitError();
  if (status === 404) return noReleaseYetError();
  return unreachableError();
}

function apiHeaders() {
  return { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' };
}

async function getApi(request, url, { signal, totalTimeoutMs }) {
  const opts = {
    destination: 'github-api',
    url,
    method: 'GET',
    headers: apiHeaders(),
    maxResponseBytes: CAPS.releaseJson,
    totalTimeoutMs,
  };
  if (signal !== undefined) opts.signal = signal;
  try {
    return await request(opts);
  } catch (err) {
    throw mapFailure(err);
  }
}

function parseJson(reply) {
  try {
    return JSON.parse(reply.body.toString('utf8'));
  } catch {
    throw new ScriptoriumError('GitHub sent a reply that could not be read');
  }
}

/**
 * GitHub's /releases/latest skips prereleases, so while a project has only prereleases it answers
 * 404, which reads as "nothing published". Look at the list once to tell the two apart. Any
 * failure here returns null, so the caller keeps the plain "nothing published" wording and the
 * lookup can never turn exit 4 into anything else (issue #51).
 *
 * @returns {object|null} the newest non-draft prerelease, or null
 */
async function newestPrerelease(request, opts) {
  try {
    const reply = await getApi(request, `${API}/releases?per_page=30`, opts);
    if (reply.status !== 200) return null;
    const parsed = JSON.parse(reply.body.toString('utf8'));
    if (!Array.isArray(parsed)) return null;
    const best = pickHighestRelease(parsed.filter((r) => r && r.prerelease === true));
    return best && isSafeTag(best.tag_name) ? best : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ pre?: boolean, version?: string|null, signal?: AbortSignal, totalTimeoutMs?: number }} [flags]
 * @param {{ request?: Function }} [deps]
 * @returns {Promise<object>} the release object; the caller uses its tag_name and nothing else
 */
async function lookupRelease(
  { pre = false, version = null, signal, totalTimeoutMs = 60000 } = {},
  { request = egress.request } = {},
) {
  const opts = { signal, totalTimeoutMs };
  let url;
  if (version) {
    if (!isSafeTag(version)) throw new ScriptoriumError('--version needs a release tag like v0.4.0');
    url = `${API}/releases/tags/${encodeURIComponent(version)}`;
  } else if (pre) {
    url = `${API}/releases?per_page=30`;
  } else {
    url = `${API}/releases/latest`;
  }

  const reply = await getApi(request, url, opts);

  if (reply.status === 404 && !pre && !version) {
    const prerelease = await newestPrerelease(request, opts);
    if (prerelease) {
      throw prerequisite(
        'no-release',
        `No stable release yet. The newest prerelease is ${prerelease.tag_name}; ` +
          'run `gm-scriptorium update --pre` to get prereleases.',
      );
    }
  }
  if (reply.status !== 200) throw statusFailure(reply.status, reply.headers);

  const parsed = parseJson(reply);

  if (pre && !version) {
    // --pre considers stable AND prerelease releases and picks the true semver max, never list
    // order. An empty list is the expected "nothing published yet" state (exit 4), not a
    // Scriptorium bug. A non-empty list with nothing usable (drafts / malformed tags) stays a
    // plain error.
    if (!Array.isArray(parsed)) throw new ScriptoriumError('GitHub sent a reply that could not be read');
    if (parsed.length === 0) throw noReleaseYetError();
    const best = pickHighestRelease(parsed);
    if (!best) throw new ScriptoriumError(`no usable release found for ${REPO}`);
    return best;
  }
  if (parsed === null || typeof parsed !== 'object') throw new ScriptoriumError('GitHub sent a reply that could not be read');
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

async function getDownload(request, url, extra, signal) {
  const opts = {
    destination: 'github',
    url,
    method: 'GET',
    headers: { 'user-agent': USER_AGENT },
    redirectTo: ASSET_REDIRECT_TO,
    ...extra,
  };
  if (signal !== undefined) opts.signal = signal;
  try {
    return await request(opts);
  } catch (err) {
    throw mapFailure(err);
  }
}

/**
 * Downloads `assetName` and SHA256SUMS from `tag` into `dir`. The asset is streamed to a file that
 * is created new (never over an existing one). Nothing is written unless the reply is a 200.
 */
async function downloadAsset(tag, assetName, dir, { request = egress.request, signal } = {}) {
  if (!isSafeTag(tag)) throw new ScriptoriumError('refusing to download a release whose tag is not a plain version');
  if (typeof assetName !== 'string' || !ASSET_NAME_RE.test(assetName)) {
    throw new ScriptoriumError('refusing to download an asset with an unexpected name');
  }
  const base = `${DL}/${encodeURIComponent(tag)}`;

  let fd = null;
  let status = 0;
  let writeError = null;
  const target = path.join(dir, assetName);
  try {
    const reply = await getDownload(
      request,
      `${base}/${assetName}`,
      {
        maxResponseBytes: CAPS.asset,
        totalTimeoutMs: ASSET_TOTAL_TIMEOUT_MS,
        onResponse: ({ status: s }) => {
          status = s;
          if (s !== 200) return;
          try {
            fd = fs.openSync(target, 'wx');
          } catch (err) {
            writeError = err;
            throw err;
          }
        },
        onChunk: (chunk) => {
          if (status !== 200 || fd === null) return;
          try {
            fs.writeSync(fd, chunk);
          } catch (err) {
            writeError = err;
            throw err;
          }
        },
      },
      signal,
    ).catch((err) => {
      if (writeError) throw new ScriptoriumError(`could not write the download (${writeError.code || 'error'})`);
      throw err;
    });
    if (reply.status !== 200) throw statusFailure(reply.status, reply.headers);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }

  const sums = await getDownload(request, `${base}/SHA256SUMS`, { maxResponseBytes: CAPS.sums }, signal);
  if (sums.status !== 200) throw statusFailure(sums.status, sums.headers);
  try {
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums.body, { flag: 'wx' });
  } catch (err) {
    throw new ScriptoriumError(`could not write the download (${err.code || 'error'})`);
  }
}

module.exports = {
  REPO,
  USER_AGENT,
  CAPS,
  ASSET_TOTAL_TIMEOUT_MS,
  ASSET_REDIRECT_TO,
  isSafeTag,
  releaseNotesUrl,
  lookupRelease,
  downloadAsset,
  pickHighestRelease,
};
