'use strict';

/*
 * #97: stat-block values rendered in a font that "reads as Comic Sans".
 *
 * Root cause: the pinned generator sets `.stat-block .stat-value` and `.quick-stats .stat-item
 * .stat-value` to var(--font-mono), whose value is the all-system chain
 *   ui-monospace, "Cascadia Mono", "Segoe UI Mono", Menlo, Monaco, Consolas, monospace
 * Neither theme defines --font-mono and no webfont is shipped for it, so the value is whichever
 * monospace the viewer's OS happens to have (on Linux Chromium: DejaVu Sans Mono; on Windows
 * Chrome, `ui-monospace` is unsupported so it falls to Cascadia/Segoe UI Mono/Consolas). It is
 * therefore not a failed webfont load: it is an unshipped system fallback chain that bears no
 * relation to the theme's own typefaces.
 *
 * Fix: the product stylesheet sets these values in the theme body face (--font-body), with
 * lining, tabular figures so stats still align.
 *
 * Expected values below are written out here, not read from the CSS under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OURS = fs.readFileSync(path.join(ROOT, 'assets', 'site', 'scriptorium.css'), 'utf8');
const PIN = fs.readFileSync(path.join(ROOT, 'node_modules', 'gm-apprentice-publish', 'css', 'style.css'), 'utf8');

function decls(css, selector) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((s) => s.trim()).includes(selector)) out.push(m[2]);
  }
  return out.join(';');
}

test('the pinned generator still sets stat values in --font-mono (the cause; if this changes, revisit #97)', () => {
  assert.match(decls(PIN, '.stat-block .stat-value'), /font-family:\s*var\(--font-mono\)/);
  assert.match(decls(PIN, '.quick-stats .stat-item .stat-value'), /font-family:\s*var\(--font-mono\)/);
});

for (const selector of ['.stat-block .stat-value', '.quick-stats .stat-item .stat-value']) {
  test(`#97: ${selector} is set in the theme body face, not a system monospace`, () => {
    const d = decls(OURS, selector);
    assert.match(d, /font-family:\s*var\(--font-body\)/);
    assert.doesNotMatch(d, /mono/i);
    assert.match(d, /font-variant-numeric:\s*lining-nums tabular-nums/);
  });
}

test('#97: no campaign or colour literal slipped into the stat-value rules', () => {
  const d = decls(OURS, '.stat-block .stat-value') + decls(OURS, '.quick-stats .stat-item .stat-value');
  assert.doesNotMatch(d, /#[0-9a-f]{3,8}\b|rgb\(/i);
});
