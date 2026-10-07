'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Structural decisions 1-4 (Engineering Brief, "Scriptorium house stylesheet + desktop
 * redesign", 2026-09-20): Scriptorium ships its own product stylesheet, embedded in the exe
 * (package.json's pkg.assets, assets/site/**\/*), and writes+links it into every site it
 * builds as css/scriptorium.css, after the pin's own stylesheets and before the campaign's
 * overrides.css.
 *
 * SD-3, the whole point of this module: the injector anchors on the overrides.css `<link>`
 * tag and derives our href from THAT tag's own href by replacing its trailing filename. It
 * never computes depth and never knows about a site's basePath. One rule then produces the
 * correct relative href at every depth on base.js's pages (lib/templates/base.js:60-62,
 * cascade style.css -> [genre] -> theme.css -> [overrides]) and the correct ABSOLUTE href on
 * 404.html (lib/templates/four-oh-four.js:37-39, a different cascade order, basePath-prefixed
 * hrefs, and a page-local <style> block) -- because our href is derived from a href the
 * template already got right for that page.
 *
 * SD-3's fallback: most sites never scaffold css/overrides.css (the pin's own copyOverridesCSS,
 * lib/build.js's copyOverridesCSS, only emits the link when the file actually exists), so most
 * pages carry no overrides.css link to anchor on at all. For those pages, derive the href the
 * same way from the theme.css (or, failing that, style.css) link instead -- both are emitted
 * unconditionally by both templates -- and insert before the first `<style` occurring after
 * `<head`, else before `</head>`. The `<style`-first rule exists because four-oh-four.js:21-22
 * states the intended position as after the generated theme and before the page-local <style>,
 * which this pass must not outrank.
 *
 * SD-4: the marker is a data attribute on our own <link> tag, `data-scriptorium-housestyle`.
 * Idempotency guards on that marker, not on the href -- a campaign could legitimately mention
 * the filename in a comment or elsewhere in the page.
 */

const REPO_ROOT = path.join(__dirname, '..', '..');
const EMBEDDED_HOUSE_STYLE_PATH = path.join(REPO_ROOT, 'assets', 'site', 'scriptorium.css');
const HOUSE_STYLE_FILENAME = 'scriptorium.css';
const MARKER_ATTR = 'data-scriptorium-housestyle';

/**
 * Finds the first `<link ... href="...<filename>">` tag in `html`.
 *
 * @param {string} html
 * @param {string} filename e.g. 'overrides.css', 'theme.css'
 * @returns {{ index: number, href: string } | null}
 */
function findLinkTag(html, filename) {
  const escaped = filename.replace(/\./g, '\\.');
  const re = new RegExp(`<link\\s[^>]*href="([^"]*${escaped})"[^>]*>`);
  const match = html.match(re);
  if (!match) return null;
  return { index: match.index, href: match[1] };
}

/**
 * Replaces the trailing filename of a stylesheet href with our own, keeping whatever
 * relative/absolute prefix the source href already carried. No depth arithmetic, no
 * knowledge of basePath (SD-3): 'overrides.css' -> 'scriptorium.css',
 * 'css/overrides.css' -> 'css/scriptorium.css', '../../css/theme.css' -> '../../css/scriptorium.css'.
 *
 * ADR 0019, "the P3a-FR08 decision": `filename` is an optional second parameter so
 * src/build/themestyle.js can derive 'scriptorium-theme.css' hrefs from the same rule,
 * without duplicating this regex. The one-argument call keeps its original,
 * byte-identical behaviour.
 *
 * @param {string} href
 * @param {string} [filename]
 * @returns {string}
 */
function deriveHref(href, filename = HOUSE_STYLE_FILENAME) {
  return href.replace(/[^/]*$/, filename);
}

function buildTag(href) {
  return `<link rel="stylesheet" href="${href}" ${MARKER_ATTR}>`;
}

function spliceBefore(html, index, tag) {
  return `${html.slice(0, index)}${tag}\n  ${html.slice(index)}`;
}

/**
 * Computes the patched HTML for one page, or null if nothing should change (already linked,
 * or the page carries none of the stylesheet links this pass can anchor on at all).
 *
 * @param {string} html
 * @returns {string | null}
 */
function injectIntoHtml(html) {
  if (html.includes(MARKER_ATTR)) return null; // SD-4: idempotent, guarded on the marker

  const overrides = findLinkTag(html, 'overrides.css');
  if (overrides) {
    return spliceBefore(html, overrides.index, buildTag(deriveHref(overrides.href)));
  }

  // SD-3 fallback: no overrides.css link on this page (the shipping case for most users).
  // Derive the href from theme.css (emitted unconditionally by both templates), falling back
  // to style.css defensively, then insert before the first <style after <head, else </head>.
  const anchor = findLinkTag(html, 'theme.css') || findLinkTag(html, 'style.css');
  if (!anchor) return null; // not a page shaped like either template; leave untouched

  const headIdx = html.indexOf('<head');
  if (headIdx === -1) return null;
  const styleIdx = html.indexOf('<style', headIdx);
  const insertAt = styleIdx !== -1 ? styleIdx : html.indexOf('</head>', headIdx);
  if (insertAt === -1) return null;

  return spliceBefore(html, insertAt, buildTag(deriveHref(anchor.href)));
}

/**
 * Walks every `.html` file under `siteRoot` and links the house stylesheet on each page that
 * does not already carry the marker. Idempotent: a second call on an unchanged tree links 0
 * pages (AC-18).
 *
 * @param {string} siteRoot
 * @returns {number} pages linked
 */
function injectHouseStyleLinks(siteRoot) {
  let linked = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(full, 'utf8');
      const patched = injectIntoHtml(html);
      if (patched === null) continue;
      fs.writeFileSync(full, patched);
      linked++;
    }
  })(siteRoot);
  return linked;
}

/**
 * Writes the embedded product stylesheet into the built site as css/scriptorium.css and links
 * it on every page. Called from src/build/run.js after the notice pass, before the output-leak
 * scan, so the addition is part of the same atomic build that swaps into place.
 *
 * @param {string} siteRoot the staging output directory (stagingOut in src/build/run.js)
 * @returns {{ written: boolean, pagesLinked: number }}
 */
function writeHouseStyle(siteRoot) {
  const cssDir = path.join(siteRoot, 'css');
  fs.mkdirSync(cssDir, { recursive: true });
  fs.copyFileSync(EMBEDDED_HOUSE_STYLE_PATH, path.join(cssDir, HOUSE_STYLE_FILENAME));
  const pagesLinked = injectHouseStyleLinks(siteRoot);
  return { written: true, pagesLinked };
}

module.exports = {
  REPO_ROOT,
  EMBEDDED_HOUSE_STYLE_PATH,
  HOUSE_STYLE_FILENAME,
  MARKER_ATTR,
  writeHouseStyle,
  injectHouseStyleLinks,
  findLinkTag,
  deriveHref,
};
