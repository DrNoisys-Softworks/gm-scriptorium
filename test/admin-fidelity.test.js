'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * Panel v2 V1d-1 (SD-11). A CSS-literal fidelity gate: every triple below is hand-typed straight
 * from docs/agent-runs/panel-v2-mockups/shell.src.html (M:), after the SD-2 token map, never read
 * back from admin.css itself (CLAUDE.md's "never derive an assertion's expected value from the
 * code under test"). Comparison normalises whitespace only (SD-11); it never rewrites tokens or
 * values.
 *
 * The parser below is a brace-depth walker, not a per-selector regex: it tracks a stack of open
 * braces, decides "container" (has nested rules -- only @media matters here; @keyframes/
 * @font-face never get queried by the triples below) vs "leaf" (plain declarations) by whether
 * anything was pushed while it was on top of the stack, and records each leaf's declarations
 * against the nearest ancestor @media condition (or null at the top level).
 */

const ADMIN_CSS_PATH = path.join(__dirname, '..', 'assets', 'admin', 'admin.css');
const TOKENS_CSS_PATH = path.join(__dirname, '..', 'assets', 'admin', 'tokens.css');

function stripComments(cssText) {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseDecls(rawBody) {
  const decls = {};
  rawBody.split(';').forEach((chunk) => {
    const t = chunk.trim();
    if (!t) return;
    const idx = t.indexOf(':');
    if (idx === -1) return;
    const prop = t.slice(0, idx).trim();
    const value = t.slice(idx + 1).trim();
    decls[prop] = value;
  });
  return decls;
}

/** @returns {{selector: string, media: string|null, decls: Record<string,string>}[]} */
function parseCss(cssText) {
  const text = stripComments(cssText);
  const n = text.length;
  const stack = [];
  const rules = [];
  let markStart = 0;

  function currentMedia() {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (/^@media/.test(stack[k].header)) return stack[k].header.replace(/\s+/g, ' ').trim();
    }
    return null;
  }

  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '{') {
      const header = text.slice(markStart, i).trim();
      if (stack.length) stack[stack.length - 1].hadChild = true;
      stack.push({ header, bodyStart: i + 1, hadChild: false });
      i++;
      markStart = i;
    } else if (ch === '}') {
      const frame = stack.pop();
      if (!frame) {
        i++;
        markStart = i;
        continue;
      }
      const rawBody = text.slice(frame.bodyStart, i);
      if (!frame.hadChild) {
        rules.push({ selector: frame.header, media: currentMedia(), decls: parseDecls(rawBody) });
      }
      i++;
      markStart = i;
    } else {
      i++;
    }
  }
  return rules;
}

/** All whitespace removed -- the SD-11 "whitespace normalised" comparison. Applied symmetrically
 * to both the parsed CSS value and the hand-typed literal, so `repeat(3,minmax(0,1fr))` and
 * `repeat(3, minmax(0, 1fr))` compare equal without either side needing to guess the other's
 * formatting. */
function norm(s) {
  return String(s).replace(/\s+/g, '');
}

function selectorKey(selector) {
  return norm(selector);
}

function findDecls(rules, selector, media) {
  const wantSel = selectorKey(selector);
  const wantMedia = media ? norm(media) : null;
  const found = rules.find((r) => selectorKey(r.selector) === wantSel && (wantMedia === null ? r.media === null : r.media !== null && norm(r.media) === wantMedia));
  return found ? found.decls : null;
}

function propValue(decls, prop) {
  if (!decls) return undefined;
  // Property lookup is exact (not normalised): CSS property names never carry meaningful
  // whitespace, and normalising them risks colliding distinct properties.
  return decls[prop];
}

// === Parser self-test (a fixture, not admin.css) ====================================================

const PARSER_FIXTURE = `
/* a comment with a { brace */
.plain { color: red; padding:  4px   8px ; }
@media (max-width: 699px) {
  .nested { min-height: 44px; }
}
@keyframes spin { to { transform: rotate(360deg); } }
`;

test('parser self-test: a plain rule, a rule inside @media, and a @keyframes stop all parse correctly', () => {
  const rules = parseCss(PARSER_FIXTURE);
  const plain = findDecls(rules, '.plain', null);
  assert.equal(propValue(plain, 'color'), 'red');
  assert.equal(norm(propValue(plain, 'padding')), norm('4px 8px'));

  const nested = findDecls(rules, '.nested', '@media (max-width: 699px)');
  assert.equal(propValue(nested, 'min-height'), '44px');

  // The @keyframes stop is a leaf too (no media ancestor), recorded as selector "to".
  const stop = findDecls(rules, 'to', null);
  assert.equal(propValue(stop, 'transform'), 'rotate(360deg)');
});

test('parser self-test positive control: a planted wrong value is caught by an exact-equality assertion', () => {
  const rules = parseCss('.x { color: blue; }');
  const decls = findDecls(rules, '.x', null);
  assert.notEqual(propValue(decls, 'color'), 'red');
});

// === V1d-1 fidelity triples, hand-typed from M: after the SD-2 token map ============================

const css = fs.readFileSync(ADMIN_CSS_PATH, 'utf8');
const RULES = parseCss(css);

test('fidelity: .a1-crest -- transform rotate(45deg), width 30px (M:216)', () => {
  const decls = findDecls(RULES, '.a1-crest', null);
  assert.ok(decls, '.a1-crest not found');
  assert.equal(norm(propValue(decls, 'transform')), norm('rotate(45deg)'));
  assert.equal(norm(propValue(decls, 'width')), norm('30px'));
});

test('fidelity: .a1-crest span -- transform rotate(-45deg) (M:217)', () => {
  const decls = findDecls(RULES, '.a1-crest span', null);
  assert.ok(decls, '.a1-crest span not found');
  assert.equal(norm(propValue(decls, 'transform')), norm('rotate(-45deg)'));
});

test('fidelity: .a1-ni -- padding 6px 8px, and no min-height (M:221)', () => {
  const decls = findDecls(RULES, '.a1-ni', null);
  assert.ok(decls, '.a1-ni not found');
  assert.equal(norm(propValue(decls, 'padding')), norm('6px 8px'));
  assert.equal(propValue(decls, 'min-height'), undefined, '.a1-ni must not carry min-height (that is what made V1 nav look spaced out)');
});

test('fidelity: .a1-ni[aria-current="page"] -- color var(--accent-strong) (M:224, bk-gilt -> accent-strong)', () => {
  const decls = findDecls(RULES, '.a1-ni[aria-current="page"]', null);
  assert.ok(decls, '.a1-ni[aria-current="page"] not found');
  assert.equal(norm(propValue(decls, 'color')), norm('var(--accent-strong)'));
});

test('fidelity: .a1-ni[aria-current="page"] .end::after -- transform rotate(45deg) (M:226)', () => {
  const decls = findDecls(RULES, '.a1-ni[aria-current="page"] .end::after', null);
  assert.ok(decls, '.a1-ni[aria-current="page"] .end::after not found');
  assert.equal(norm(propValue(decls, 'transform')), norm('rotate(45deg)'));
});

test('fidelity: .a1-eyebrow -- color var(--accent) (M:236, bk-brass -> accent)', () => {
  const decls = findDecls(RULES, '.a1-eyebrow', null);
  assert.ok(decls, '.a1-eyebrow not found');
  assert.equal(norm(propValue(decls, 'color')), norm('var(--accent)'));
});

test('fidelity: .a1-h1 -- color var(--accent-strong) (M:238, bk-gilt -> accent-strong)', () => {
  const decls = findDecls(RULES, '.a1-h1', null);
  assert.ok(decls, '.a1-h1 not found');
  assert.equal(norm(propValue(decls, 'color')), norm('var(--accent-strong)'));
});

test('fidelity: .a1-tagline -- font contains italic (M:240)', () => {
  const decls = findDecls(RULES, '.a1-tagline', null);
  assert.ok(decls, '.a1-tagline not found');
  assert.ok(norm(propValue(decls, 'font')).includes(norm('italic')), 'expected .a1-tagline font to contain "italic"');
});

test('fidelity: .a1-bill -- grid-template-columns repeat(3, minmax(0, 1fr)) (M:243)', () => {
  const decls = findDecls(RULES, '.a1-bill', null);
  assert.ok(decls, '.a1-bill not found');
  assert.equal(norm(propValue(decls, 'grid-template-columns')), norm('repeat(3, minmax(0, 1fr))'));
});

test('fidelity: .a1-bill>div+div -- border-left 1px solid var(--line-edge) (M:245, bk-edge -> line-edge)', () => {
  const decls = findDecls(RULES, '.a1-bill>div+div', null);
  assert.ok(decls, '.a1-bill>div+div not found');
  assert.equal(norm(propValue(decls, 'border-left')), norm('1px solid var(--line-edge)'));
});

test('fidelity: .a1-btn.primary -- background var(--accent), color var(--on-accent) (M:257-258)', () => {
  const decls = findDecls(RULES, '.a1-btn.primary', null);
  assert.ok(decls, '.a1-btn.primary not found');
  assert.equal(norm(propValue(decls, 'background')), norm('var(--accent)'));
  assert.equal(norm(propValue(decls, 'color')), norm('var(--on-accent)'));
});

test('fidelity: .a1-rule::before -- background var(--accent) (M:266, bk-brass -> accent)', () => {
  const decls = findDecls(RULES, '.a1-rule::before', null);
  assert.ok(decls, '.a1-rule::before not found');
  assert.equal(norm(propValue(decls, 'background')), norm('var(--accent)'));
});

test('fidelity: .a1-rule::after -- background contains linear-gradient (M:267)', () => {
  const decls = findDecls(RULES, '.a1-rule::after', null);
  assert.ok(decls, '.a1-rule::after not found');
  assert.ok(norm(propValue(decls, 'background')).includes('linear-gradient'), 'expected .a1-rule::after background to use a linear-gradient');
});

test('fidelity: .a1-cols -- grid-template-columns minmax(0, 1fr) minmax(0, 1.15fr) (M:263)', () => {
  const decls = findDecls(RULES, '.a1-cols', null);
  assert.ok(decls, '.a1-cols not found');
  assert.equal(norm(propValue(decls, 'grid-template-columns')), norm('minmax(0, 1fr) minmax(0, 1.15fr)'));
});

test('fidelity: .a1-slots -- grid-template-columns repeat(3, minmax(0, 1fr)) (M:271)', () => {
  const decls = findDecls(RULES, '.a1-slots', null);
  assert.ok(decls, '.a1-slots not found');
  assert.equal(norm(propValue(decls, 'grid-template-columns')), norm('repeat(3, minmax(0, 1fr))'));
});

test('fidelity: .a1-slot.empty .th -- border-style dashed (M:272)', () => {
  const decls = findDecls(RULES, '.a1-slot.empty .th', null);
  assert.ok(decls, '.a1-slot.empty .th not found');
  assert.equal(norm(propValue(decls, 'border-style')), norm('dashed'));
});

test('fidelity: .a1-pill.seal -- color var(--focus) (M:253, bk-glow -> focus)', () => {
  const decls = findDecls(RULES, '.a1-pill.seal', null);
  assert.ok(decls, '.a1-pill.seal not found');
  assert.equal(norm(propValue(decls, 'color')), norm('var(--focus)'));
});

test('fidelity: h1[tabindex="-1"]:focus -- outline none (SD-6, new rule, not from M:)', () => {
  const decls = findDecls(RULES, 'h1[tabindex="-1"]:focus', null);
  assert.ok(decls, 'h1[tabindex="-1"]:focus not found');
  assert.equal(norm(propValue(decls, 'outline')), norm('none'));
});

test('fidelity: [data-role="app"] -- font 15px/1.55 (M:208-209)', () => {
  const decls = findDecls(RULES, '[data-role="app"]', null);
  assert.ok(decls, '[data-role="app"] not found');
  assert.ok(norm(propValue(decls, 'font')).includes(norm('15px/1.55')), 'expected [data-role="app"] font to contain 15px/1.55');
});

test('fidelity: .mbi inside (max-width: 699px) -- min-height at least 44px (NFR-04 tap target)', () => {
  const decls = findDecls(RULES, '.mbi', '@media (max-width: 699px)');
  assert.ok(decls, '.mbi inside the 699px media block not found');
  const minHeight = propValue(decls, 'min-height');
  assert.ok(minHeight, '.mbi must declare min-height inside the 699px block');
  let px;
  if (/^var\(--tap-min\)$/.test(norm(minHeight))) {
    const tokens = fs.readFileSync(TOKENS_CSS_PATH, 'utf8');
    const m = /--tap-min:\s*([\d.]+)px/.exec(tokens);
    assert.ok(m, 'tokens.css must define --tap-min in px so .mbi min-height can be checked');
    px = parseFloat(m[1]);
  } else {
    const m = /^([\d.]+)px$/.exec(norm(minHeight));
    assert.ok(m, `.mbi min-height "${minHeight}" is neither var(--tap-min) nor a literal px value`);
    px = parseFloat(m[1]);
  }
  assert.ok(px >= 44, `.mbi min-height resolves to ${px}px, expected at least 44px`);
});

// === V1d-2 fidelity triples, hand-typed from M: after the SD-2 token map ============================

test('fidelity: .a1-subtab[aria-selected="true"] -- color var(--accent-strong), border-bottom-color var(--accent) (M:299, bk-gilt -> accent-strong, bk-brass -> accent)', () => {
  const decls = findDecls(RULES, '.a1-subtab[aria-selected="true"]', null);
  assert.ok(decls, '.a1-subtab[aria-selected="true"] not found');
  assert.equal(norm(propValue(decls, 'color')), norm('var(--accent-strong)'));
  assert.equal(norm(propValue(decls, 'border-bottom-color')), norm('var(--accent)'));
});

test('fidelity: .a1-lrow -- grid-template-columns minmax(150px, 200px) minmax(0, 1fr) minmax(120px, 190px) (M:301)', () => {
  const decls = findDecls(RULES, '.a1-lrow', null);
  assert.ok(decls, '.a1-lrow not found');
  assert.equal(norm(propValue(decls, 'grid-template-columns')), norm('minmax(150px, 200px) minmax(0, 1fr) minmax(120px, 190px)'));
});

test('fidelity: .a1-kind -- grid-template-columns 44px minmax(0, 1fr) (M:310)', () => {
  const decls = findDecls(RULES, '.a1-kind', null);
  assert.ok(decls, '.a1-kind not found');
  assert.equal(norm(propValue(decls, 'grid-template-columns')), norm('44px minmax(0, 1fr)'));
});

test('fidelity: .a1-pending -- position sticky (M:333)', () => {
  const decls = findDecls(RULES, '.a1-pending', null);
  assert.ok(decls, '.a1-pending not found');
  assert.equal(norm(propValue(decls, 'position')), norm('sticky'));
});

test('fidelity: dialog.a1-slip[open] -- background var(--slip) (M:339, bk-slip -> slip)', () => {
  const decls = findDecls(RULES, 'dialog.a1-slip[open]', null);
  assert.ok(decls, 'dialog.a1-slip[open] not found');
  assert.equal(norm(propValue(decls, 'background')), norm('var(--slip)'));
});

test('fidelity: .a1-seal -- border-radius 50% (M:344)', () => {
  const decls = findDecls(RULES, '.a1-seal', null);
  assert.ok(decls, '.a1-seal not found');
  assert.equal(norm(propValue(decls, 'border-radius')), norm('50%'));
});

test('fidelity: .df-was -- text-decoration line-through (M:190)', () => {
  const decls = findDecls(RULES, '.df-was', null);
  assert.ok(decls, '.df-was not found');
  assert.equal(norm(propValue(decls, 'text-decoration')), norm('line-through'));
});

test('fidelity: .df-fields -- display grid (M:184)', () => {
  const decls = findDecls(RULES, '.df-fields', null);
  assert.ok(decls, '.df-fields not found');
  assert.equal(norm(propValue(decls, 'display')), norm('grid'));
});

test('fidelity: .a1-refused -- border 1px solid var(--slip-refused-line) (M:357, a3452f -> slip-refused-line)', () => {
  const decls = findDecls(RULES, '.a1-refused', null);
  assert.ok(decls, '.a1-refused not found');
  assert.equal(norm(propValue(decls, 'border')), norm('1px solid var(--slip-refused-line)'));
});

test('fidelity: .a1-slip .cf-btns -- display flex, justify-content flex-end (M:351)', () => {
  const decls = findDecls(RULES, '.a1-slip .cf-btns', null);
  assert.ok(decls, '.a1-slip .cf-btns not found');
  assert.equal(norm(propValue(decls, 'display')), norm('flex'));
  assert.equal(norm(propValue(decls, 'justify-content')), norm('flex-end'));
});
