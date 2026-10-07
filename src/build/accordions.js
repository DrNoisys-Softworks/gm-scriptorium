'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Engineering Brief: "Book leaves + motion" (docs/agent-runs/bookleaves-engineering-brief-2026-09-24.md),
 * FR-12 (the owner, 2026-09-24, gap 1 option (c)): the PC page's Background and Notes accordions
 * (pc.js:326-332) arrive open and stay foldable. CSS alone (forcing .accordion-body open) would
 * leave the button reading `aria-expanded="false"` to a screen reader while the section is
 * visibly open, and the pin's own onclick toggle would still start from a `false` baseline it no
 * longer matches. This post-build transform flips both the markup class and the button's
 * aria-expanded/state to match the CSS's open-on-arrival, leaving the existing onclick toggle
 * (`this.parentElement.classList.toggle('open')`) untouched so folding still works correctly in
 * both directions.
 */

const ACCORDION_MARKER = 'data-scriptorium-accordion';

// Matches pc.js:327-328's exact shape (verified against a PC page:104-105).
const ACCORDION_RE =
  /<div class="accordion" id="([^"]*)">(\s*)<button class="accordion-header" aria-expanded="false" onclick="const o=this\.parentElement\.classList\.toggle\('open'\);this\.setAttribute\('aria-expanded',o\)">/g;

/**
 * Computes the patched HTML for one page, or null if nothing changes: the marker is already
 * present (idempotency, checked first) or there are zero matches.
 *
 * @param {string} html
 * @returns {string | null}
 */
function transformAccordionOpen(html) {
  if (html.includes(ACCORDION_MARKER)) return null; // idempotent, checked first

  let matched = false;
  const out = html.replace(ACCORDION_RE, (_match, id, ws) => {
    matched = true;
    return `<div class="accordion open" id="${id}">${ws}<button class="accordion-header" aria-expanded="true" ${ACCORDION_MARKER} onclick="const o=this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',o)">`;
  });

  return matched ? out : null;
}

/**
 * Walks every `.html` file under `siteRoot` and applies transformAccordionOpen to each, writing
 * back only the pages that actually changed.
 *
 * @param {string} siteRoot
 * @returns {{ pagesPatched: number, accordionsOpened: number }}
 */
function applyAccordionOpen(siteRoot) {
  let pagesPatched = 0;
  let accordionsOpened = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(full, 'utf8');
      const matches = html.match(ACCORDION_RE);
      const patched = transformAccordionOpen(html);
      if (patched === null) continue;
      fs.writeFileSync(full, patched);
      pagesPatched++;
      accordionsOpened += matches ? matches.length : 0;
    }
  })(siteRoot);
  return { pagesPatched, accordionsOpened };
}

module.exports = {
  ACCORDION_MARKER,
  ACCORDION_RE,
  transformAccordionOpen,
  applyAccordionOpen,
};
