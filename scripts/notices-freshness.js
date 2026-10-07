'use strict';

/*
 * The committed THIRD-PARTY-NOTICES.txt is embedded verbatim into the packaged binary
 * (package.json's pkg.assets copies it byte-for-byte; scripts/pkg-assets.js's
 * assertAssetsEmbedded() only proves it was embedded, never that its content is still
 * accurate). If package-lock.json or the generator pin moves without re-running
 * `npm run notices`, the file on disk silently drifts from what it claims to describe, and
 * that stale text is exactly what would get shipped. This is the gate that catches that,
 * wired into scripts/package.js before the pkg build starts (same shape as
 * scripts/pkg-assets.js's assertAssetsEmbedded() and scripts/content-markers.js's
 * assertNoRulesContent(), both also wired there): a bad build refuses to ship rather than
 * shipping quietly.
 *
 * scripts/generate-notices.js's own header states its output is byte-identical for a given
 * package-lock.json/node_modules/vendor state except for the "Generated:" line's timestamp.
 * That line is stripped from both sides before comparing.
 */

const fs = require('fs');
const path = require('path');
const { buildNoticesText } = require('./generate-notices');

const ROOT = path.join(__dirname, '..');
const NOTICES_PATH = path.join(ROOT, 'THIRD-PARTY-NOTICES.txt');

const GENERATED_LINE_RE = /^Generated: .*$/m;

function withoutGeneratedLine(text) {
  return text.replace(GENERATED_LINE_RE, 'Generated: <ignored-for-comparison>');
}

/**
 * @param {string} [noticesPath]
 * @returns {{ ok: boolean, detail: string|null }}
 */
function assertNoticesFresh(noticesPath = NOTICES_PATH) {
  if (!fs.existsSync(noticesPath)) {
    return { ok: false, detail: `${noticesPath} does not exist. Run "npm run notices" first.` };
  }
  const onDisk = withoutGeneratedLine(fs.readFileSync(noticesPath, 'utf8'));
  const fresh = withoutGeneratedLine(buildNoticesText());
  if (onDisk === fresh) return { ok: true, detail: null };
  return {
    ok: false,
    detail:
      `${noticesPath} does not match what scripts/generate-notices.js produces from the currently ` +
      'installed dependency tree (package-lock.json / vendor pin) or from the current package.json ' +
      "version (Issue #26: the header stamps it, so a version bump alone will trip this). Run " +
      '"npm run notices" and commit the result.',
  };
}

module.exports = { assertNoticesFresh, NOTICES_PATH };
