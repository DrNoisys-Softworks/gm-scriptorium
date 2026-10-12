'use strict';

const fs = require('fs');
const path = require('path');
const { ScriptoriumError } = require('../util/errors');
const { NAME_RE, validateExternalUrl } = require('../setup/validate');

/*
 * ADR 0054 (the GM link on the published site): the writer for the one opt-in GM link a published
 * build may carry. It is NOT the preview GM link (src/admin/gmlink.js and its marker in
 * src/build/gmmarker.js), which a published build never carries and which src/build/outputgate.js
 * refuses unconditionally. This link has its own marker, defined once here, and neither marker
 * contains the other.
 *
 * It is a plain anchor: no script, no target, no src, no status check, no address except its own
 * href. The href is the console's https origin plus an optional campaign hint, and never carries a
 * token, ticket, session, loopback address or preview address.
 *
 * It is injected by src/build/run.js after the last page transform and BEFORE the three output
 * gates, so the gates scan the tree that is actually published. When gmLink is null nothing is
 * read or written, which keeps a build with the link off byte-identical to a build before this
 * module existed. No CSS is written by a build for this link: any styling lives in the injected
 * markup only, because that is what keeps an off build identical.
 */

const GM_ACCESS_MARKER = 'data-scriptorium-gm-access';

/*
 * The anchors in the notice footer (src/build/notice.js footerSnippet): the link goes inside that
 * paragraph, straight after the "Third-party notices" anchor (the insertion point is just before
 * the paragraph's closing </p>, never inside the anchor). test/gm-access.test.js pins both
 * literals against notice.footerSnippet(0) so the two files cannot drift apart.
 */
const NOTICE_PARAGRAPH_OPEN = '<p class="scriptorium-notice-link">';
const NOTICE_ANCHOR_CLOSE = '</a></p>';

/* Characters that must never reach an attribute value, whatever the validator allowed. */
const UNSAFE_IN_ATTRIBUTE = /["'<>&`\\\s]/;

/**
 * @param {unknown} origin an https origin, as validateExternalUrl returns it
 * @param {unknown} campaign the campaign's config name; the hint is added only if it fits NAME_RE
 * @returns {string} the origin root, plus `?campaign=<name>` when the name is a plain campaign name
 * @throws {ScriptoriumError} if the origin is not one validateExternalUrl accepts unchanged (a programming error)
 */
function gmAccessHref(origin, campaign) {
  let checked;
  try {
    checked = validateExternalUrl(origin);
  } catch (err) {
    throw new ScriptoriumError(`gmAccessHref: not an acceptable console address: ${err.message}`);
  }
  if (checked !== origin || UNSAFE_IN_ATTRIBUTE.test(checked)) {
    throw new ScriptoriumError('gmAccessHref: the console address must be a bare https origin that is safe to put in a link');
  }
  const hint = typeof campaign === 'string' && NAME_RE.test(campaign) ? `?campaign=${campaign}` : '';
  return `${checked}/${hint}`;
}

/*
 * The visible markup follows the approved mock (frame G1): a text link reading "Game master", no icon,
 * after a separator, inline in the notice paragraph. The text itself names the link, so there is no
 * aria-label. No CSS is written by a build for this link, because that is what keeps an off build identical.
 */
/** @param {string} href */
function gmAccessSnippet(href) {
  return (
    '<span aria-hidden="true"> &middot; </span>' +
    `<a class="scriptorium-gm-access" ${GM_ACCESS_MARKER} href="${href}" rel="noopener noreferrer nofollow">Game master</a>`
  );
}

/**
 * Adds the link to every page that carries the notice footer, inline after "Third-party notices".
 * Walks the tree the way src/admin/gmlink.js does: recurse into directories only, read and write
 * regular files only, so a symlink in either direction is never followed or written.
 *
 * @param {string} siteRoot the staged site tree
 * @param {{ url: string }|null|undefined} gmLink null or undefined means off: nothing is touched
 * @param {string} campaign the campaign's config name, for the hint
 * @returns {{ pagesLinked: number }|{ pagesLinked: number, pagesSkipped: number }}
 */
function injectGmAccessLink(siteRoot, gmLink, campaign) {
  if (gmLink === null || gmLink === undefined) return { pagesLinked: 0 };

  const snippet = gmAccessSnippet(gmAccessHref(gmLink.url, campaign));
  let pagesLinked = 0;
  let pagesSkipped = 0;

  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks: never followed, never written
      if (!entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(abs, 'utf8');
      if (html.includes(GM_ACCESS_MARKER)) continue; // idempotent re-run
      const open = html.indexOf(NOTICE_PARAGRAPH_OPEN);
      const close = open === -1 ? -1 : html.indexOf(NOTICE_ANCHOR_CLOSE, open + NOTICE_PARAGRAPH_OPEN.length);
      if (close === -1 || !html.includes('</body>')) {
        pagesSkipped++; // no notice footer to sit beside, or a bare redirect page
        continue;
      }
      const at = close + '</a>'.length; // straight after the anchor, still inside the paragraph
      fs.writeFileSync(abs, html.slice(0, at) + snippet + html.slice(at));
      pagesLinked++;
    }
  })(siteRoot);

  return { pagesLinked, pagesSkipped };
}

module.exports = {
  GM_ACCESS_MARKER,
  NOTICE_PARAGRAPH_OPEN,
  NOTICE_ANCHOR_CLOSE,
  gmAccessHref,
  gmAccessSnippet,
  injectGmAccessLink,
};
