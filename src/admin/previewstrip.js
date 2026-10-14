'use strict';

const fs = require('fs');
const path = require('path');
const { ScriptoriumError } = require('../util/errors');
const { gmLinkHrefFor } = require('./gmlink');

/*
 * The "not your live site" strip (docs/decisions/0035-preview-in-a-frame.md, addendum "The not-live
 * strip"; mock frame B06). One notice, added straight after the opening <body> tag of every preview
 * page, saying the page is a preview that only the GM can see, with a way back to the panel and a
 * pointer to how publishing works.
 *
 * Same containment as the GM link (src/admin/gmlink.js): this module is called ONLY from
 * src/admin/preview.js's buildPreviewWithGmLink, after a successful build, and is never reachable
 * from src/cli/build.js's module graph (test/gm-link-structure.test.js). The marker below lives in
 * this file alone, so a published build can never carry the strip.
 *
 * No script, ever: the strip is markup plus one scoped <style> (the preview's CSP is
 * frame-ancestors only, src/admin/handlers/views.js servePreview). Both links are plain anchors.
 * The publishing-guide address is a fixed constant, never read from config or from the request.
 */

const PREVIEW_STRIP_MARKER = 'data-scriptorium-preview-strip';

/** Until the publishing guide exists, "How to publish" opens the documentation index. */
const PUBLISH_HELP_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/blob/main/docs/README.md';

// The opening <body> tag, attribute values included (a ">" inside a quoted value does not end it).
const BODY_OPEN_RE = /<body(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?>/i;

const STRIP_CSS = [
  '.scriptorium-preview-strip{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;box-sizing:border-box;margin:0;padding:9px 16px;',
  'background:repeating-linear-gradient(135deg,#f2c94c 0 18px,#efc040 18px 36px);color:#1f1a0e;',
  'font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;border-bottom:2px solid #9a6b00;text-align:left}',
  '.scriptorium-preview-strip svg{width:18px;height:18px;flex:none}',
  '.scriptorium-preview-strip strong{font-weight:700}',
  '.scriptorium-preview-strip .scriptorium-preview-strip-links{margin-left:auto;display:flex;flex-wrap:wrap;gap:4px 16px}',
  '.scriptorium-preview-strip a{color:#1f1a0e;font-weight:600;text-decoration:underline}',
  // The Haze theme lays its top bar over the landing hero (position:absolute, top:0); without this the
  // bar would sit on top of the strip. top:auto drops it to its place in the flow, just under the strip.
  'body:has(> .scriptorium-preview-strip):has(> main.content > .landing-hero) > .top-nav{top:auto}',
  '@media (max-width:699px){.scriptorium-preview-strip .scriptorium-preview-strip-links{margin-left:0}}',
].join('');

const EYE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>';

/** @param {string} s */
function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {string} panelHref where "Back to the panel" goes (the admin origin root; never a token) */
function previewStripSnippet(panelHref) {
  return (
    `<aside class="scriptorium-preview-strip" aria-label="Preview notice" ${PREVIEW_STRIP_MARKER}>` +
    `<style>${STRIP_CSS}</style>` +
    EYE +
    '<strong>Preview only, not your live site.</strong>' +
    '<span>Only you can see this page. Players see what you publish.</span>' +
    '<div class="scriptorium-preview-strip-links">' +
    `<a href="${escapeAttr(panelHref)}">Back to the panel</a>` +
    `<a href="${PUBLISH_HELP_URL}" target="_blank" rel="noopener noreferrer">How to publish</a>` +
    '</div></aside>\n'
  );
}

/** Same two fail-closed preconditions as src/admin/gmlink.js (a programming error, never a user refusal). */
function assertPreconditions(ctx) {
  if (path.dirname(ctx.previewDir) !== ctx.previewRoot) {
    throw new ScriptoriumError(
      `injectPreviewStrips: ctx.previewDir (${ctx.previewDir}) must be the direct "site" child of ctx.previewRoot (${ctx.previewRoot})`,
    );
  }
  if (!Number.isInteger(ctx.adminPort) || ctx.adminPort < 1 || ctx.adminPort > 65535) {
    throw new ScriptoriumError(`injectPreviewStrips: ctx.adminPort must be an integer from 1 to 65535, got: ${ctx.adminPort}`);
  }
}

/**
 * Walks ctx.previewDir the way gmlink.js does (directories and regular files only; a symlink is
 * never followed and never written) and adds the strip to every .html file that has a <body> and
 * does not already carry the marker.
 *
 * @param {object} ctx an admin context with previewDir/previewRoot set and adminPort bound
 * @returns {{ pagesMarked: number }}
 */
function injectPreviewStrips(ctx) {
  assertPreconditions(ctx);
  const snippet = previewStripSnippet(gmLinkHrefFor(ctx));
  let pagesMarked = 0;

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
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(abs, 'utf8');
      if (html.includes(PREVIEW_STRIP_MARKER)) continue; // idempotent re-run
      const m = BODY_OPEN_RE.exec(html);
      if (!m) continue; // e.g. a bare redirect page with no <body>
      const at = m.index + m[0].length;
      fs.writeFileSync(abs, html.slice(0, at) + snippet + html.slice(at));
      pagesMarked++;
    }
  })(ctx.previewDir);

  return { pagesMarked };
}

module.exports = { PREVIEW_STRIP_MARKER, PUBLISH_HELP_URL, previewStripSnippet, injectPreviewStrips };
