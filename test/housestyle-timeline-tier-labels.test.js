'use strict';

// Issue #50: the story-chronology ruler's tier-group header labels (assets/site/scriptorium.js's
// renderRuler(), `.sc-tl-t1` -- "consecutive segments sharing the same tier, drawn as one wider
// band", per that function's own comment) could visually run into the NEXT group's label when
// several short segments sit in a row.
//
// Two independent facts combine to explain and fix this:
//
// 1. (proved below via TL.layout, the exported pure function the ruler's own x/width math comes
//    from) consecutive segments' boxes are contiguous and non-overlapping -- segX[next] is always
//    exactly segX[cur] + segW[cur]. A tier group spans exactly the segments that share a tier, so
//    a group's own box (segX[group.start] .. segX[group.end] + segW[group.end]) is *also*
//    guaranteed non-overlapping with its neighbours. In the worst case the issue describes --
//    several short segments in a row -- alternating tiers make every segment its own group, i.e.
//    the smallest possible group box, exercised directly below.
//
// 2. (the actual bug, and the only part fact 1 does NOT cover) `.sc-tl-t2` (the per-segment label
//    below the ruler) already relies on fact 1 for its own clipping, and already declares
//    `overflow: hidden; text-overflow: ellipsis` alongside its inline max-width so its own text
//    can never render past its box. `.sc-tl-t1` (the group label above it) had NEITHER an
//    `overflow` on its own div NOR on the inner `<span>` that actually carries the nowrap text --
//    so even though the div's own box (set inline by renderRuler) never overlapped a neighbour
//    (fact 1), the unclipped span's rendered text could still spill out past that box's edge and
//    into the next group's space. Fact 1 alone was never the missing piece; the missing clip was.
//
// No headless browser or DOM implementation is available here (no playwright/puppeteer/jsdom
// devDependency; checked via require.resolve first), and renderRuler() itself is not exported (it
// touches `window`/`document`/`root.innerHTML` and only runs in a real browser) -- this is a
// source-level check for both the geometry (a real, exported, already-partly-tested pure function)
// and the CSS declarations, not a rendered check. The rendered proof lives in the Engineer report's
// before/after screenshots against a scratch build with several short, alternating-tier segments.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { TL } = require(path.join(__dirname, '..', 'assets', 'site', 'scriptorium.js'));

const CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function ruleBody(css, selector) {
  const stripped = stripComments(css);
  const needle = `${selector} {`;
  const start = stripped.indexOf(needle);
  assert.notEqual(start, -1, `expected to find "${needle}" in scriptorium.css`);
  const bodyStart = start + needle.length;
  let depth = 1;
  let j = bodyStart;
  while (depth > 0 && j < stripped.length) {
    if (stripped[j] === '{') depth++;
    else if (stripped[j] === '}') depth--;
    j++;
  }
  return stripped.slice(bodyStart, j - 1);
}

const LEAF = 'body:has(> .top-nav) > main.content:not(:has(> .landing-hero))';

test('TL.layout (fact 1): several short, alternating-tier segments in a row produce contiguous, non-overlapping boxes', () => {
  // Worst case for issue #50: every segment gets its own tier, so every segment is its own
  // "tier group" -- the smallest possible group box the ruler can produce.
  const segs = [
    { id: 's1', tier: 'Tier A', label: 'Week 1', before: false },
    { id: 's2', tier: 'Tier B', label: 'Week 2', before: false },
    { id: 's3', tier: 'Tier C', label: 'Week 3', before: false },
    { id: 's4', tier: 'Tier D', label: 'Week 4', before: false },
  ];
  const points = segs.map((s, i) => ({ id: `p${i}`, seg: s.id, ghost: false }));

  const L = TL.layout(points, segs);

  const order = ['s1', 's2', 's3', 's4'];
  for (let i = 0; i < order.length - 1; i++) {
    const cur = order[i];
    const next = order[i + 1];
    assert.equal(
      L.segX[next],
      L.segX[cur] + L.segW[cur],
      `${cur}'s box should end exactly where ${next}'s box starts (contiguous, no overlap)`,
    );
  }
  // Every segment here has exactly one point, so this is also the SHORTEST box TL.layout
  // produces for a non-"before" segment -- stated independently as the unit(80) + pad(34) shape,
  // not read off TL.layout's own constants.
  for (const s of order) {
    assert.equal(L.segW[s], 80 + 34, `${s} (one point, non-ghost) should be exactly unit+pad wide`);
  }
});

test('.sc-tl-t1 (the group label box) clips its own overflow', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const body = ruleBody(css, `${LEAF} .sc-tl-t1`);
  assert.match(body, /overflow:\s*hidden/, '.sc-tl-t1 should clip content to its own (non-overlapping) box');
});

test('.sc-tl-t1 span:not(.sc-tl-fleuron) (the actual nowrap text) truncates with an ellipsis instead of spilling past its box', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const body = ruleBody(css, `${LEAF} .sc-tl-t1 span:not(.sc-tl-fleuron)`);
  assert.match(body, /white-space:\s*nowrap/, 'sanity: still single-line (pre-existing)');
  assert.match(body, /overflow:\s*hidden/, 'the span itself must clip -- its parent div is not enough for text-overflow to apply');
  assert.match(body, /text-overflow:\s*ellipsis/, 'truncate visibly rather than clip mid-glyph with no indicator');
});

test('.sc-tl-t2 (the per-segment label) already has this treatment -- parity check, not a new requirement', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const body = ruleBody(css, `${LEAF} .sc-tl-t2`);
  assert.match(body, /white-space:\s*nowrap/);
  assert.match(body, /overflow:\s*hidden/);
  assert.match(body, /text-overflow:\s*ellipsis/);
});
