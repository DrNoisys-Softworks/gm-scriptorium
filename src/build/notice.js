'use strict';

const fs = require('fs');
const path = require('path');

/*
 * The fourth licence-provenance fix (docs/PROVENANCE.md section 10/11,
 * finding B4): every site gm-apprentice-publish builds redistributes
 * lunr.js (MIT, copyright notice present, permission notice absent) and
 * its own CSS/JS (MIT, no copyright notice at all). That makes every
 * generated site a non-compliant MIT redistribution, caused by the tool,
 * not the site owner. This module writes a NOTICE.txt into every built
 * site discharging both notices, and links it from each page's footer.
 *
 * The licence texts are inlined as constants (not read from
 * node_modules/*\/LICENSE at build time) so this works identically
 * whether Scriptorium is run from source or as a packaged executable
 * with no node_modules tree beside it.
 *
 * No third entry here for the GURPS reference tables or the Call of
 * Cthulhu skill list (Track DEP-c/R, docs/decisions/0007-rules-content-redaction.md):
 * src/generator/redactions.js neutralises both at runtime and
 * package.json's pkg.patches erases both at packaging time, so after that
 * work landed, no built site redistributes either any more. The only
 * third-party material a built site still redistributes is lunr.js and
 * the pin's own CSS/JS, i.e. exactly the two entries below. Re-open this
 * only if a future change reintroduces either module unredacted.
 */

const MIT_PERMISSION_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

function buildNoticeText({ searchEnabled }) {
  const parts = [];
  parts.push('This site was built with GM-Scriptorium (https://github.com/DrNoisys-Softworks/gm-scriptorium),');
  parts.push('which incorporates third-party software reproduced below, unmodified.');
  parts.push('');

  if (searchEnabled) {
    parts.push('-'.repeat(70));
    parts.push('lunr.js');
    parts.push('-'.repeat(70));
    parts.push('');
    parts.push('Copyright (c) 2013 Oliver Nightingale');
    parts.push('');
    parts.push(MIT_PERMISSION_TEXT);
    parts.push('');
  }

  parts.push('-'.repeat(70));
  parts.push('Site stylesheet and scripts (gm-apprentice-publish)');
  parts.push('-'.repeat(70));
  parts.push('');
  parts.push('Copyright (c) 2026 AntTheLimey');
  parts.push('');
  parts.push(MIT_PERMISSION_TEXT);
  parts.push('');

  return parts.join('\n');
}

/**
 * Every .html file gets a small, consistent footer link to NOTICE.txt, computed relative to that
 * page's own depth. Wrapped in the pin's own `.content` column class (css/style.css:339-343)
 * rather than an inline style: `.content` sits inside `<main>` on every page, so the link can be
 * restyled from overrides.css without needing `!important` to beat an inline style.
 */
function footerSnippet(depth) {
  const prefix = depth > 0 ? '../'.repeat(depth) : '';
  return `<div class="content scriptorium-notice"><p class="scriptorium-notice-link"><a href="${prefix}NOTICE.txt">Third-party notices</a></p></div>\n</body>`;
}

function injectFooterLinks(siteRoot) {
  let updated = 0;
  (function walk(dir, depth) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(full, 'utf8');
      if (html.includes('scriptorium-notice-link')) continue; // already injected (idempotent re-run)
      if (!html.includes('</body>')) continue; // e.g. a bare redirect page with no </body>
      const patched = html.replace('</body>', footerSnippet(depth));
      fs.writeFileSync(full, patched);
      updated++;
    }
  })(siteRoot, 0);
  return updated;
}

/**
 * Writes NOTICE.txt into the built site and links it from every page's
 * footer. Called after a successful generator build, before the atomic
 * swap, so the addition is part of the same all-or-nothing build.
 *
 * @param {string} siteRoot the staging output directory (or finalOut for a direct call)
 * @param {{ searchEnabled: boolean }} opts
 * @returns {{ noticeWritten: boolean, pagesLinked: number }}
 */
function writeSiteNotice(siteRoot, opts) {
  const noticeText = buildNoticeText(opts);
  fs.writeFileSync(path.join(siteRoot, 'NOTICE.txt'), noticeText);
  const pagesLinked = injectFooterLinks(siteRoot);
  return { noticeWritten: true, pagesLinked };
}

module.exports = { writeSiteNotice, buildNoticeText, injectFooterLinks };
