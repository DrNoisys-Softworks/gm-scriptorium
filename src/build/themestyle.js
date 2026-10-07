'use strict';

const fs = require('fs');
const path = require('path');
const { findLinkTag, deriveHref, HOUSE_STYLE_FILENAME, MARKER_ATTR: HOUSESTYLE_MARKER_ATTR } = require('./housestyle');

/*
 * ADR 0019, Structural decisions 1-2: one declaration file
 * (css/scriptorium-theme.css), one link per page, inserted immediately
 * after the housestyle tag it anchors on. This module must never call
 * findLinkTag(html, 'theme.css') (the suffix also matches our own
 * filename) and must always run AFTER writeHouseStyle in src/build/run.js,
 * so the marker guard below always has a housestyle tag to anchor on.
 */

const THEME_STYLE_FILENAME = 'scriptorium-theme.css';
const THEME_MARKER_ATTR = 'data-scriptorium-theme';

/**
 * @param {string|null} themeCss
 * @param {{ slot: string, href: string }[]} slotDecls
 * @returns {string|null}
 */
function composeThemeCss(themeCss, slotDecls) {
  const parts = [];
  if (themeCss !== null) parts.push(themeCss.endsWith('\n') ? themeCss : themeCss + '\n');
  if (slotDecls.length) {
    parts.push(`:root {\n${slotDecls.map((d) => `  --sc-img-${d.slot}: url("${d.href}");\n`).join('')}}\n`);
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * Computes the patched HTML for one page, or null if nothing should change
 * (already linked, or the page carries no housestyle-marked tag to anchor
 * on at all). SD-2: the link is inserted immediately after the `>` that
 * closes the housestyle tag.
 *
 * @param {string} html
 * @returns {string|null}
 */
function linkThemeStyle(html) {
  if (html.includes(THEME_MARKER_ATTR)) return null; // idempotent, guarded on the marker

  const anchor = findLinkTag(html, HOUSE_STYLE_FILENAME);
  if (!anchor) return null;

  const tagEnd = html.indexOf('>', anchor.index) + 1;
  const tagText = html.slice(anchor.index, tagEnd);
  if (!tagText.includes(HOUSESTYLE_MARKER_ATTR)) return null;

  const href = deriveHref(anchor.href, THEME_STYLE_FILENAME);
  const insertion = `\n  <link rel="stylesheet" href="${href}" ${THEME_MARKER_ATTR}>`;
  return html.slice(0, tagEnd) + insertion + html.slice(tagEnd);
}

/**
 * Walks every `.html` file under `siteRoot`, sorted recursively, and links
 * the theme stylesheet on each page that does not already carry the
 * marker.
 *
 * @param {string} siteRoot
 * @returns {number} pages linked
 */
function injectThemeStyleLinks(siteRoot) {
  let linked = 0;
  (function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(full, 'utf8');
      const patched = linkThemeStyle(html);
      if (patched === null) continue;
      fs.writeFileSync(full, patched);
      linked++;
    }
  })(siteRoot);
  return linked;
}

/**
 * @param {string} siteRoot the staging output directory
 * @param {string|null} cssText
 * @returns {{ written: boolean, pagesLinked: number }}
 */
function writeThemeStyle(siteRoot, cssText) {
  if (cssText === null) return { written: false, pagesLinked: 0 };
  const cssDir = path.join(siteRoot, 'css');
  fs.mkdirSync(cssDir, { recursive: true });
  fs.writeFileSync(path.join(cssDir, THEME_STYLE_FILENAME), cssText);
  const pagesLinked = injectThemeStyleLinks(siteRoot);
  return { written: true, pagesLinked };
}

module.exports = {
  THEME_STYLE_FILENAME,
  THEME_MARKER_ATTR,
  composeThemeCss,
  linkThemeStyle,
  injectThemeStyleLinks,
  writeThemeStyle,
};
