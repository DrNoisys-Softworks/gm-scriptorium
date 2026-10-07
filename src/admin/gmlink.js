'use strict';

const fs = require('fs');
const path = require('path');
const { GM_LINK_MARKER } = require('../build/gmmarker');
const { ScriptoriumError } = require('../util/errors');

/*
 * Phase 8 slice S6 (docs/agent-runs/admin-s6-engineering-brief-2026-09-28.md, SD-4). The GM-link
 * writer: adds one discreet footer link to every preview page, pointing at the admin origin
 * root, carrying no token. Modelled directly on src/build/notice.js's footerSnippet/
 * injectFooterLinks pattern (html.replace('</body>', ...), guarded by a marker, skipped when
 * there is no </body>), so the injected link lands after the notice footer that pass already
 * added (notice.js:101).
 *
 * This is called ONLY from src/admin/preview.js's buildPreviewWithGmLink, after a successful
 * build (SD-5) -- never from runPreviewBuild itself (test/admin-preview.test.js's own NFR02/FR29
 * tests call runPreviewBuild directly and must see an unpatched tree), and never from anything
 * src/cli/build.js's module graph can reach (FR34(a), test/gm-link-structure.test.js).
 */

/** @param {number} port */
function gmLinkHref(port) {
  return `http://127.0.0.1:${port}/`;
}

/**
 * V1.5a (docs/decisions/0029-remote-access.md section 7): the link target for the active mode. In
 * tailscale, proxy and direct modes it is the admin's external address (never a token); in local
 * and ssh modes it is exactly what gmLinkHref has always produced.
 *
 * @param {{ access?: { remote?: boolean, admin?: { origin: string } }|null, adminPort: number }} ctx
 */
function gmLinkHrefFor(ctx) {
  return ctx.access && ctx.access.remote ? `${ctx.access.admin.origin}/` : gmLinkHref(ctx.adminPort);
}

/** @param {string} href */
function gmLinkSnippet(href) {
  return `<div class="content scriptorium-gm-link" ${GM_LINK_MARKER}><p><a href="${href}" rel="noreferrer">GM</a></p></div>\n`;
}

/**
 * Preconditions (both fail-closed, thrown as a ScriptoriumError -- a programming error, never a
 * user-facing refusal): `ctx.previewDir` must be exactly `path.join(ctx.previewRoot, ...)`'s
 * immediate `site` child (`path.dirname(ctx.previewDir) === ctx.previewRoot`, matching
 * ensurePreviewRoot's own `ctx.previewDir = path.join(root, 'site')`), and `ctx.adminPort` must
 * be a real, already-bound port. A string-prefix or "inside or equal" check would each accept a
 * shape ensurePreviewRoot never produces (a prefix-named sibling directory, or the root passed
 * as its own child); see the mutation table in the engineering brief for exactly which shapes
 * each alternative wrongly accepts.
 */
function assertPreconditions(ctx) {
  if (path.dirname(ctx.previewDir) !== ctx.previewRoot) {
    throw new ScriptoriumError(
      `injectGmLinks: ctx.previewDir (${ctx.previewDir}) must be the direct "site" child of ctx.previewRoot (${ctx.previewRoot})`,
    );
  }
  if (!Number.isInteger(ctx.adminPort) || ctx.adminPort < 1 || ctx.adminPort > 65535) {
    throw new ScriptoriumError(`injectGmLinks: ctx.adminPort must be an integer from 1 to 65535, got: ${ctx.adminPort}`);
  }
}

/**
 * Walks `ctx.previewDir` the same way src/build/gmmarker.js's detector does: `readdirSync` with
 * `withFileTypes`, recursing only into `isDirectory()` entries and reading only `isFile()`
 * entries, so a symlink -- in either direction, a symlinked directory that might lead back out of
 * the preview tree, or a symlinked file that might point outside it -- is never followed and
 * never written to.
 *
 * @param {object} ctx an admin context, with ctx.previewDir/ctx.previewRoot already set by
 *   ensurePreviewRoot and ctx.adminPort already bound
 * @returns {{ pagesLinked: number }}
 * @throws {ScriptoriumError} if the preconditions above do not hold
 */
function injectGmLinks(ctx) {
  assertPreconditions(ctx);

  const href = gmLinkHrefFor(ctx);
  const snippet = gmLinkSnippet(href);
  let pagesLinked = 0;

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
      if (html.includes(GM_LINK_MARKER)) continue; // idempotent re-run
      if (!html.includes('</body>')) continue; // e.g. a bare redirect page with no </body>
      const patched = html.replace('</body>', `${snippet}</body>`);
      fs.writeFileSync(abs, patched);
      pagesLinked++;
    }
  })(ctx.previewDir);

  return { pagesLinked };
}

module.exports = { gmLinkHref, gmLinkHrefFor, gmLinkSnippet, injectGmLinks };
