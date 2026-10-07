'use strict';

const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('./housestyle');

/*
 * Engineering Brief: "Story timeline + Connections lane" (docs/agent-runs/
 * timeline-connections-engineering-brief-2026-09-24.md), "Interfaces and contracts: sitescript.js".
 *
 * The single first-party asset shared by the timeline and Connections runtimes (Structural
 * decision 9): written once as js/scriptorium.js, linked only on pages the two transforms
 * actually patch, following housestyle.js's SD-3 href-derivation pattern (derive from an existing
 * tag's own href, never compute depth).
 */

const SITE_SCRIPT_MARKER = 'data-scriptorium-js';
const SITE_SCRIPT_FILENAME = 'scriptorium.js';
const EMBEDDED_SITE_SCRIPT_PATH = path.join(REPO_ROOT, 'assets', 'site', SITE_SCRIPT_FILENAME);

const NAV_JS_RE = /<script src="([^"]*)nav\.js"><\/script>/;

/**
 * Computes the patched HTML for one page, or null if nothing should change: the marker is
 * already present, there is no `<script src="...nav.js"></script>` tag to derive our href from,
 * or there is no `</body>`.
 *
 * @param {string} html
 * @returns {string | null}
 */
function linkSiteScript(html) {
  if (html.includes(SITE_SCRIPT_MARKER)) return null;
  const navMatch = html.match(NAV_JS_RE);
  if (!navMatch) return null;
  const bodyCloseIdx = html.lastIndexOf('</body>');
  if (bodyCloseIdx === -1) return null;

  const root = navMatch[1]; // e.g. '../' repeated, or './'
  const tag = `<script src="${root}${SITE_SCRIPT_FILENAME}" ${SITE_SCRIPT_MARKER}></script>`;
  return html.slice(0, bodyCloseIdx) + tag + '\n' + html.slice(bodyCloseIdx);
}

/**
 * Copies the embedded runtime asset to `<siteRoot>/js/scriptorium.js`, but only when at least
 * one page links it.
 *
 * @param {string} siteRoot
 * @param {{ linkedPages: number }} opts
 * @returns {{ written: boolean }}
 */
function writeSiteScript(siteRoot, { linkedPages }) {
  if (!linkedPages || linkedPages <= 0) return { written: false };
  const jsDir = path.join(siteRoot, 'js');
  fs.mkdirSync(jsDir, { recursive: true });
  fs.copyFileSync(EMBEDDED_SITE_SCRIPT_PATH, path.join(jsDir, SITE_SCRIPT_FILENAME));
  return { written: true };
}

/**
 * JSON-serialises `v`, escaping only `<` as `<` (so `</script>` inside a value can never
 * close the surrounding `<script type="application/json">` island). Non-ASCII is left as literal
 * UTF-8 so the leak scan can still see withheld names inside the island.
 *
 * @param {*} v
 * @returns {string}
 */
function serializeDataIsland(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

module.exports = {
  SITE_SCRIPT_MARKER,
  SITE_SCRIPT_FILENAME,
  EMBEDDED_SITE_SCRIPT_PATH,
  linkSiteScript,
  writeSiteScript,
  serializeDataIsland,
};
