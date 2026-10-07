'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Engineering Brief: "Book leaves + motion" (docs/agent-runs/bookleaves-engineering-brief-2026-09-24.md),
 * FR-11 / Structural decision 8, plus AMENDMENT 1 E-3 and E-6.
 *
 * A single post-build transform, storynav.js-shaped (one marker on the <script> tag, checked
 * first, all-or-nothing), that does two insertions in one pass:
 *
 *  1. The direction/scrolled head script, on every .html page (including 404 and the sessions
 *     index), immediately before the first </head>.
 *  2. AMENDMENT E-3: on leaf pages only (has <header class="top-nav">, has no
 *     class="landing-hero" -- the same pages the leaf CSS scope targets), a single
 *     <div class="vt-fx" aria-hidden="true"></div>, immediately before the first </main> after the
 *     first <main class="content"> (the same anchoring sessions-index.js's MAIN_OPEN/MAIN_CLOSE
 *     uses, and it shares that module's residual: a literal "</main>" string inside authored raw
 *     HTML in the leaf would misplace the div).
 *
 * Both insertions are guarded by the ONE marker on the script (idempotency), because they are one
 * pass: a page either gets both changes it qualifies for, or neither.
 *
 * rc.2 Windows follow-ups (docs/HANDOVER-WINDOWS.md C31): `events/index.html` is the one section
 * index in a real build with no .vt-fx, and that is correct, not a bug. The pin's own
 * lib/build.js writes events/index.html as a bare redirect stub straight to the campaign
 * timeline whenever one exists (`<meta http-equiv="refresh">` + `<link rel="canonical">`, no nav,
 * no `<main>`), because the timeline IS the events index once dated events exist. AMENDMENT E-3's
 * leaf-page test above requires `<header class="top-nav">`, which a redirect stub never has, so
 * it correctly falls through to "gets the script, no .vt-fx" -- the same bucket a 404 page is in.
 * See the redirect-stub test in test/build-pageturn.test.js.
 */

const PAGETURN_MARKER = 'data-scriptorium-pageturn';

// The direction/scrolled head script. AMENDMENT E-6 additions: the pageswap write of
// sc-vt-scrolled (immediately after the #mobile-nav close, before `if (!to) return;`), and the
// pagereveal read plus the live scrollY check, which together add the 'scrolled' type alongside
// the direction type.
//
// Reviewer rework (B-1, 2026-09-24): Chromium 140 reads window.scrollY as 0 at pagereveal on a
// history traverse (scroll restoration has not been applied yet when the event fires), so the
// live check above never catches a deep-scrolled page reached via Back/Forward. Fixed by also
// recording, in pageswap, the OUTGOING page's own scrollY under a key that names its own URL
// (sc-vt-scroll:<url>) -- so a later traverse back to that same URL can look its own remembered
// depth up by the URL it lands on, in pagereveal, rather than trusting scrollY at all. The index
// (sc-vt-scroll-idx) is a plain array of URLs in insertion order, capped at 20 entries, evicting
// the oldest key first -- unbounded per-URL keys would leak across a long session.
const PAGETURN_SCRIPT = `<script ${PAGETURN_MARKER}>
(function () {
  try {
    addEventListener('pageswap', function (e) {
      try {
        if (!e.viewTransition) return;
        var m = document.getElementById('mobile-nav');
        if (m) m.classList.remove('open');
        try { sessionStorage.setItem('sc-vt-scrolled', window.scrollY > window.innerHeight / 2 ? '1' : '0'); } catch (_) {}
        try {
          var url = location.href;
          var idx = [];
          try { idx = JSON.parse(sessionStorage.getItem('sc-vt-scroll-idx') || '[]'); } catch (_) { idx = []; }
          idx = idx.filter(function (u) { return u !== url; });
          idx.push(url);
          while (idx.length > 20) {
            var oldest = idx.shift();
            try { sessionStorage.removeItem('sc-vt-scroll:' + oldest); } catch (_) {}
          }
          sessionStorage.setItem('sc-vt-scroll-idx', JSON.stringify(idx));
          sessionStorage.setItem('sc-vt-scroll:' + url, String(window.scrollY));
        } catch (_) {}
        var to = e.activation && e.activation.entry && e.activation.entry.url;
        if (!to) return;
        var hit = function (sel) {
          return Array.prototype.some.call(document.querySelectorAll(sel), function (a) { return a.href === to; });
        };
        var dir = 'forward';
        if (hit('.breadcrumbs a')) dir = 'up';
        else if (hit('.story-nav a:first-child')) dir = 'back';
        sessionStorage.setItem('sc-vt-dir', dir);
      } catch (_) {}
    });
    addEventListener('pagereveal', function (e) {
      try {
        if (!e.viewTransition) return;
        document.documentElement.setAttribute('data-sc-vt-arrived', '');
        var dir = 'forward';
        try { dir = sessionStorage.getItem('sc-vt-dir') || dir; sessionStorage.removeItem('sc-vt-dir'); } catch (_) {}
        var a = window.navigation && navigation.activation;
        var isTraverse = false;
        if (a && a.navigationType === 'traverse' && a.from && a.entry) { dir = a.entry.index < a.from.index ? 'back' : 'forward'; isTraverse = true; }
        else if (!a) { var n = performance.getEntriesByType('navigation')[0]; if (n && n.type === 'back_forward') { dir = 'back'; isTraverse = true; } }
        var scrolled = false;
        try { scrolled = sessionStorage.getItem('sc-vt-scrolled') === '1'; sessionStorage.removeItem('sc-vt-scrolled'); } catch (_) {}
        if (window.scrollY > window.innerHeight / 2) scrolled = true;
        if (isTraverse) {
          try {
            var stored = sessionStorage.getItem('sc-vt-scroll:' + location.href);
            if (stored !== null && Number(stored) > window.innerHeight / 2) scrolled = true;
          } catch (_) {}
        }
        if (e.viewTransition.types) { e.viewTransition.types.add(dir); if (scrolled) e.viewTransition.types.add('scrolled'); }
      } catch (_) {}
    });
  } catch (_) {}
})();
</script>`;

// Deliberately does not match "<header" -- FR-11's own risk area.
const HEAD_OPEN_RE = /<head(\s[^>]*)?>/;

const TOP_NAV_MARKER = '<header class="top-nav">';
const LANDING_HERO_MARKER = 'class="landing-hero"';
const MAIN_OPEN = '<main class="content">';
const MAIN_CLOSE = '</main>';
const VT_FX_DIV = '<div class="vt-fx" aria-hidden="true"></div>';

/**
 * Computes the patched HTML for one page, or null if nothing should change: the marker is
 * already present (idempotency, checked first), there is no <head ...>, or there is no </head>
 * after it.
 *
 * @param {string} html
 * @returns {string | null}
 */
function transformPageTurn(html) {
  if (html.includes(PAGETURN_MARKER)) return null; // idempotent, checked first

  const headMatch = html.match(HEAD_OPEN_RE);
  if (!headMatch) return null;
  const headEnd = headMatch.index + headMatch[0].length;
  const headCloseAt = html.indexOf('</head>', headEnd);
  if (headCloseAt === -1) return null;

  let out = html.slice(0, headCloseAt) + PAGETURN_SCRIPT + '\n' + html.slice(headCloseAt);

  // AMENDMENT E-3: the .vt-fx div, only on leaf pages (top-nav present, landing-hero absent).
  if (out.includes(TOP_NAV_MARKER) && !out.includes(LANDING_HERO_MARKER)) {
    const mainOpenAt = out.indexOf(MAIN_OPEN);
    if (mainOpenAt !== -1) {
      const mainCloseAt = out.indexOf(MAIN_CLOSE, mainOpenAt + MAIN_OPEN.length);
      if (mainCloseAt !== -1) {
        out = out.slice(0, mainCloseAt) + VT_FX_DIV + '\n' + out.slice(mainCloseAt);
      }
    }
  }

  return out;
}

/**
 * Walks every `.html` file under `siteRoot` and applies transformPageTurn to each, writing back
 * only the pages that actually changed.
 *
 * @param {string} siteRoot
 * @returns {{ pagesPatched: number, fxInserted: number }}
 */
function applyPageTurn(siteRoot) {
  let pagesPatched = 0;
  let fxInserted = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(full, 'utf8');
      const patched = transformPageTurn(html);
      if (patched === null) continue;
      fs.writeFileSync(full, patched);
      pagesPatched++;
      if (patched.includes(VT_FX_DIV)) fxInserted++;
    }
  })(siteRoot);
  return { pagesPatched, fxInserted };
}

module.exports = {
  PAGETURN_MARKER,
  PAGETURN_SCRIPT,
  HEAD_OPEN_RE,
  transformPageTurn,
  applyPageTurn,
};
