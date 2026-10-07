'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Downstream shim (ADR 0014, final addendum), pending upstream: pressing Escape with focus INSIDE the
 * open Story dropdown closes it (the pin's js/nav.js does that) and returns focus to the Story toggle,
 * which the pin does not (WCAG 2.4.3, our #95 follow-up). Retire this module when the pin does it.
 *
 * One tiny inline script, linked only on pages whose nav carries the pin's grouped Story button. It
 * listens in the capture phase (so it reads the focused element before anything hides it), acts only
 * when focus is inside the Story group's dropdown, and does nothing when focus is already on the toggle
 * or anywhere else. No generator edit; nothing here changes the pin's own handlers.
 */

const STORYFOCUS_MARKER = 'data-scriptorium-storyfocus';
const STORY_GROUP_RE = /<button class="nav-group-toggle">Story<\/button>\s*<div class="nav-dropdown">/;

const STORYFOCUS_SCRIPT =
  `<script ${STORYFOCUS_MARKER}>\n` +
  `document.addEventListener('keydown', function(e) {\n` +
  `  if (e.key !== 'Escape') return;\n` +
  `  var el = document.activeElement;\n` +
  `  var group = el && el.closest ? el.closest('.nav-group') : null;\n` +
  `  var toggle = group && group.querySelector('.nav-group-toggle');\n` +
  `  if (!toggle || toggle === el || toggle.textContent.trim() !== 'Story') return;\n` +
  `  var dd = group.querySelector('.nav-dropdown');\n` +
  `  if (dd && dd.contains(el)) toggle.focus();\n` +
  `}, true);\n` +
  `</script>`;

/** @returns {string|null} patched html, or null when nothing should change */
function transformStoryFocus(html) {
  if (html.includes(STORYFOCUS_MARKER)) return null;
  if (!STORY_GROUP_RE.test(html)) return null;
  const i = html.lastIndexOf('</body>');
  if (i === -1) return null;
  return html.slice(0, i) + STORYFOCUS_SCRIPT + '\n' + html.slice(i);
}

function applyStoryFocus(siteRoot) {
  let pagesPatched = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      const patched = transformStoryFocus(fs.readFileSync(full, 'utf8'));
      if (patched === null) continue;
      fs.writeFileSync(full, patched);
      pagesPatched++;
    }
  })(siteRoot);
  return { pagesPatched };
}

module.exports = { STORYFOCUS_MARKER, transformStoryFocus, applyStoryFocus };
