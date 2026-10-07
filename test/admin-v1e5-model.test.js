'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { IM, SLOT_NAMES } = require(path.join(__dirname, '..', 'assets', 'admin', 'images.js'));
const { SL } = require(path.join(__dirname, '..', 'assets', 'admin', 'slip.js'));
const { ADMIN_ASSETS_DIR } = require('../src/admin/assets');

/*
 * V1e-5 (SD-54, SD-58; test-first order item 2). `IM`'s own additions, loaded via require() (the
 * VB pattern already used by test/admin-slot-purpose.test.js and test/admin-views-model.test.js).
 * Independent literals throughout -- never derived from the code under test.
 */

// === FR-25: friendly names =======================================================================

const EXPECTED_FRIENDLY_NAMES = {
  hero: 'Landing banner',
  ground: 'Page backdrop',
  paper: 'Paper texture',
  'crest-frame': 'Emblem frame',
  portrait: 'Character portrait',
  '404': 'Not-found page',
};

test('IM.FRIENDLY_NAMES: the literal list', () => {
  assert.deepEqual(IM.FRIENDLY_NAMES, EXPECTED_FRIENDLY_NAMES);
  SLOT_NAMES.forEach((slot) => {
    assert.equal(IM.friendlyName(slot), EXPECTED_FRIENDLY_NAMES[slot]);
  });
});

for (const bad of ['heroic', 'constructor', '__proto__', '']) {
  test(`IM.friendlyName/tipFor/ratioClassFor: "${bad}" gives null (no string-prefix or prototype match)`, () => {
    assert.equal(IM.friendlyName(bad), null);
    assert.equal(IM.tipFor(bad), null);
    assert.equal(IM.ratioClassFor(bad), null);
  });
}

// === SD-54: tips and ratio classes ===============================================================

test('IM.SLOT_TIPS: the literal list', () => {
  assert.deepEqual(IM.SLOT_TIPS, {
    hero: 'Keep the subject in the middle band; the edges get cropped.',
    ground: 'Keep it quiet; text never sits on it directly.',
    paper: 'It repeats, so the edges must meet seamlessly.',
    'crest-frame': 'Needs a see-through middle: PNG or WebP, not JPEG.',
    portrait: 'Prepare it as a 3:4 upright picture.',
    '404': 'Cropped to fill a wide band.',
  });
});

test('IM.RATIO_CLASS: the literal list', () => {
  assert.deepEqual(IM.RATIO_CLASS, { hero: 'r-16x9', ground: 'r-16x9', paper: 'r-1x1', 'crest-frame': 'r-1x1', portrait: 'r-3x4', '404': 'r-16x9' });
});

// === FR-26: drawLine, derived from disk ==========================================================

const THEMES_DIR = path.join(__dirname, '..', 'assets', 'themes');

function registryThemeSlots() {
  const out = { plain: [] }; // plain has no on-disk theme.json (dir: null in src/build/themes.js)
  for (const name of fs.readdirSync(THEMES_DIR)) {
    const jsonPath = path.join(THEMES_DIR, name, 'theme.json');
    if (!fs.existsSync(jsonPath)) continue;
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    out[meta.name] = meta.slots;
  }
  return out;
}

const DRAWN_NOTE = 'Your theme, gloam, uses it only on the not-found page, when Not-found page is empty.';

test('IM.drawLine: the table for every registry theme x slot, derived from disk, matches the five typed literals', () => {
  const slotsByTheme = registryThemeSlots();
  const themeNames = Object.keys(slotsByTheme);

  for (const theme of themeNames) {
    for (const slot of SLOT_NAMES) {
      const drawn = slotsByTheme[theme].includes(slot);
      let expected;
      if (drawn && theme === 'gloam' && slot === 'hero') {
        expected = DRAWN_NOTE;
      } else if (drawn) {
        expected = `Your theme, ${theme}, draws it.`;
      } else {
        // Whether ANY built-in theme draws this slot at all (independent of the active theme):
        // only the static BUILT_IN_SLOT_DRAWERS membership (gloam draws hero/ground/paper/404).
        const anyBuiltInDraws = themeNames.some((t) => slotsByTheme[t].includes(slot));
        expected = anyBuiltInDraws ? `Your theme, ${theme}, doesn't draw it. Your overrides.css can.` : 'No built-in theme draws it; your overrides.css can.';
      }
      assert.equal(IM.drawLine(slot, theme, themeNames), expected, `${theme}/${slot}`);
    }
  }

  // A theme not in themeNames (e.g. a broken pack.toml giving theme: null) always falls through
  // to the first branch, regardless of slot.
  assert.equal(IM.drawLine('hero', null, themeNames), 'Your overrides.css can draw it.');
  assert.equal(IM.drawLine('hero', 'unknown-theme', themeNames), 'Your overrides.css can draw it.');
});

test('IM.DRAW_NOTES: every [theme][slot] names a pair whose own theme.json actually lists that slot', () => {
  const slotsByTheme = registryThemeSlots();
  for (const theme of Object.keys(IM.DRAW_NOTES)) {
    for (const slot of Object.keys(IM.DRAW_NOTES[theme])) {
      assert.ok(slotsByTheme[theme] && slotsByTheme[theme].includes(slot), `${theme}/${slot} must be in that theme's own theme.json slots`);
    }
  }
});

// === FR-26: themeNote =============================================================================

test('IM.themeNote: a known theme drawing n>=1 of the six spots', () => {
  const [p1, p2] = IM.themeNote('gloam', ['plain', 'haze', 'gloam']);
  assert.equal(
    p1,
    'Your theme, gloam, draws 4 of these spots: Landing banner, Page backdrop, Paper texture, Not-found page. Your overrides.css can draw any of them.',
  );
  assert.equal(p2, 'Everything in images/ is published with the site, used or not. Art from your vault that a spot uses is copied into the site too.');
});

test('IM.themeNote: a known theme drawing none of the six spots', () => {
  const [p1] = IM.themeNote('haze', ['plain', 'haze', 'gloam']);
  assert.equal(p1, "Your theme, haze, doesn't draw any of these spots. Your overrides.css can draw any of them.");
});

test('IM.themeNote: an unknown theme', () => {
  const [p1] = IM.themeNote('mystery', ['plain', 'haze', 'gloam']);
  assert.equal(p1, 'Your overrides.css can draw any of these spots.');
});

// === FR-28: vaultArtRel, thumbFor =================================================================

test('IM.vaultArtRel: exact "vault:" membership only', () => {
  const rels = ['_attachments/a.png'];
  assert.equal(IM.vaultArtRel('vault:_attachments/a.png', rels), '_attachments/a.png');
  assert.equal(IM.vaultArtRel('vaultx:_attachments/a.png', rels), null);
  assert.equal(IM.vaultArtRel('vault:_attachments/../pack.toml', rels), null);
  assert.equal(IM.vaultArtRel('vault:', rels), null);
  assert.equal(IM.vaultArtRel('images/a.png', rels), null);
});

test('IM.vaultArtRel: a string-prefix sibling ("vault" without the colon) that, sliced at 6 chars, would ACCIDENTALLY match a real rel still gives null (IC2)', () => {
  // 'vaultyx:a.png'.indexOf('vault') === 0, and slicing exactly 6 chars off it gives 'x:a.png',
  // which IS a member of rels below -- a mutant that checks indexOf('vault') instead of
  // indexOf('vault:') would wrongly accept this. The real code must still refuse it.
  const rels = ['x:a.png'];
  assert.equal(IM.vaultArtRel('vaultyx:a.png', rels), null);
});

test('IM.thumbFor: every kind, including an outside-the-folder vault: value keeping the path card', () => {
  const images = ['a.png'];
  const vaultRels = ['_attachments/a.png'];
  assert.deepEqual(IM.thumbFor('', images, vaultRels), { kind: 'empty' });
  assert.deepEqual(IM.thumbFor(null, images, vaultRels), { kind: 'empty' });
  assert.deepEqual(IM.thumbFor('images/a.png', images, vaultRels), { kind: 'img', src: '/api/image?name=a.png', from: 'up' });
  assert.deepEqual(IM.thumbFor('vault:_attachments/a.png', images, vaultRels), {
    kind: 'img',
    src: '/api/vault-art/file?name=_attachments%2Fa.png',
    from: 'vault',
  });
  // Outside the listed folder (FR-28's residual): keeps the path card.
  assert.deepEqual(IM.thumbFor('vault:notes/map.png', images, vaultRels), { kind: 'path' });
  assert.deepEqual(IM.thumbFor('something/else.png', images, vaultRels), { kind: 'path' });
});

test('IM.displayName / IM.fromLabel', () => {
  assert.equal(IM.displayName('images/a/b.png'), 'b.png');
  assert.equal(IM.displayName('vault:_attachments/campaign/c.svg'), 'c.svg');
  assert.equal(IM.fromLabel('vault:_attachments/a.png'), 'from your vault');
  assert.equal(IM.fromLabel('images/a.png'), 'uploaded');
  assert.equal(IM.fromLabel(''), '');
  assert.equal(IM.fromLabel(null), '');
});

// === SD-54: the pending model =====================================================================

test('IM.withPend: setting a slot, then setting it back to the saved value, removes the pending key', () => {
  const saved = { hero: 'images/a.png' };
  const withSet = IM.withPend({}, saved, 'hero', 'images/b.png');
  assert.deepEqual(withSet, { hero: 'images/b.png' });
  const backToSaved = IM.withPend(withSet, saved, 'hero', 'images/a.png');
  assert.deepEqual(backToSaved, {});
});

test('IM.withPend: clearing a saved value (set to null) is a real pending change', () => {
  const saved = { hero: 'images/a.png' };
  const cleared = IM.withPend({}, saved, 'hero', null);
  assert.deepEqual(cleared, { hero: null });
});

test('IM.withPend: clearing an already-empty slot is a no-op (never a pending key)', () => {
  const cleared = IM.withPend({}, {}, 'hero', null);
  assert.deepEqual(cleared, {});
});

test('IM.pendKeys: SLOT_NAMES order, regardless of insertion order', () => {
  const pend = { '404': 'images/z.png', hero: 'images/a.png' };
  assert.deepEqual(IM.pendKeys(pend, {}), ['hero', '404']);
});

test('IM.slotsPayload: keyed in pendKeys (SLOT_NAMES) order, for non-numeric-looking slot keys', () => {
  const pend = { portrait: 'images/z.png', hero: 'images/a.png' };
  assert.deepEqual(Object.keys(IM.slotsPayload(pend, {})), ['hero', 'portrait']);
});

/*
 * Residual, independent of this slice's code: ECMA-262's own OwnPropertyKeys order places every
 * integer-index-LOOKING string key (here, the literal key "404") before any other string key,
 * regardless of insertion order -- this is true of Object.keys, JSON.stringify and for..in alike,
 * and it is true of the SERVER's own JSON.parse of the posted body too, so client and server
 * always agree on this ordering. slotsPayload still inserts in SLOT_NAMES order (pendKeys), but
 * when "404" is among the pending slots it is spec-mandated to serialize first regardless.
 */
test('IM.slotsPayload: the "404" slot key always serializes first (ECMA-262 integer-index key order), not a bug', () => {
  const pend = { portrait: 'images/z.png', '404': 'images/a.png' };
  assert.deepEqual(Object.keys(IM.slotsPayload(pend, {})), ['404', 'portrait']);
  assert.deepEqual(Object.keys({ portrait: 1, '404': 2 }), ['404', 'portrait']); // the same JS rule, on a plain literal
});

test('IM.usedBy: slots in SLOT_NAMES order', () => {
  const saved = { hero: 'images/a.png', ground: 'images/a.png' };
  assert.deepEqual(IM.usedBy('images/a.png', {}, saved), ['hero', 'ground']);
});

test('IM.statusFor: unsaved, set, empty', () => {
  const saved = { hero: 'images/a.png' };
  assert.equal(IM.statusFor({ hero: 'images/b.png' }, saved, 'hero'), 'unsaved');
  assert.equal(IM.statusFor({}, saved, 'hero'), 'set');
  assert.equal(IM.statusFor({}, saved, 'ground'), 'empty');
});

// === Parity: the dry body's key order survives JSON.stringify unedited ==========================

test('parity: slotsPayload set, stringified with the dry body, equals the typed literal', () => {
  const body = JSON.stringify({ slots: IM.slotsPayload({ hero: 'images/a.png' }, {}), baseSha256: 'x', dryRun: true });
  assert.equal(body, '{"slots":{"hero":"images/a.png"},"baseSha256":"x","dryRun":true}');
});

test('parity: slotsPayload clear, stringified with the dry body, equals the typed literal', () => {
  const body = JSON.stringify({ slots: IM.slotsPayload({ hero: null }, { hero: 'images/a.png' }), baseSha256: 'x', dryRun: true });
  assert.equal(body, '{"slots":{"hero":null},"baseSha256":"x","dryRun":true}');
});

// === SD-54: fit ====================================================================================

test('IM.fitScore: null dims gives 1', () => {
  assert.equal(IM.fitScore(IM.guideFor('hero'), null, 'a.png'), 1);
});

test('IM.fitScore: a hand-computed literal for a square image against the 16:9 hero guide', () => {
  // guide: 2400x1350 (g = 1.77778); dims: 1000x1000 (r = 1). sc = 3 - |ln(1/1.77778)|*4
  // = 3 - |-0.575364| * 4 = 3 - 2.301455 = 0.698545. Below WARN.minScale (0.75) on neither axis
  // (1000 >= 2400*0.75=1800? no -- 1000 < 1800, so -1 applies): sc = 0.698545 - 1 = -0.301455.
  const guide = IM.guideFor('hero');
  const score = IM.fitScore(guide, { w: 1000, h: 1000 }, 'a.png');
  assert.ok(Math.abs(score - -0.301455) < 1e-4, score);
});

test('IM.fitScore: a JPEG against the alpha-requiring crest-frame guide loses 3', () => {
  const guide = IM.guideFor('crest-frame'); // 512x512, alpha:true
  const withoutAlpha = IM.fitScore(guide, { w: 512, h: 512 }, 'a.png');
  const asJpeg = IM.fitScore(guide, { w: 512, h: 512 }, 'a.jpg');
  assert.ok(Math.abs(withoutAlpha - asJpeg - 3) < 1e-9);
});

test('IM.bestSlotsFor: a square image fits paper and crest-frame best (both 1:1), ties broken by SLOT_NAMES order', () => {
  assert.deepEqual(IM.bestSlotsFor({ w: 1000, h: 1000 }, 'a.png'), ['paper', 'crest-frame']);
});

test('IM.followRoleFor', () => {
  assert.equal(IM.followRoleFor('404'), 'notfound');
  SLOT_NAMES.filter((s) => s !== '404').forEach((s) => assert.equal(IM.followRoleFor(s), 'landing'));
});

// === SL.buildSlip: slots rows and title (SD-58) ==================================================

test('SL.buildSlip: slots title is "Save image choices"', () => {
  const slip = SL.buildSlip({
    kind: 'slots',
    payload: { slots: {} },
    state: {},
    dry: { ok: true, dryRun: true, file: 'pack.toml', before: null, after: '', commentsLost: false, warnings: [] },
  });
  assert.equal(slip.title, 'Save image choices');
});

test('SL.buildSlip: slots rows use the friendly name as "where", falling back to "Images" for an unknown slot', () => {
  const slip = SL.buildSlip({
    kind: 'slots',
    payload: { slots: { hero: 'images/a.png', 'not-a-real-slot': 'images/b.png' } },
    state: { packToml: { images: {} } },
    dry: { ok: true, dryRun: true, file: 'pack.toml', before: null, after: '', commentsLost: false, warnings: [] },
  });
  assert.deepEqual(
    slip.rows.map((r) => r.where),
    ['Landing banner', 'Images'],
  );
});

// === Copy scan (truthfulness) =====================================================================

const FORBIDDEN_COPY = ['—', ' -- ', 'FR-', 'SD-', 'AC-', 'Default portrait', 'Stands in', 'only when a slot uses it', 'nothing is saved until'];

function allImStrings() {
  const out = [];
  (function walk(value) {
    if (typeof value === 'string') {
      out.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  })(IM);
  return out;
}

/** Strips comments only, so a comment's own FR-/SD- citation (the house convention everywhere
 * else in this repo) never trips the scan -- only real code and string literals remain. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('copy scan: no forbidden substring in any IM string, or in images.js source (comments excepted)', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'images.js'), 'utf8'));
  for (const token of FORBIDDEN_COPY) {
    assert.ok(!src.includes(token), `images.js source (comments stripped) contains forbidden token "${token}"`);
    for (const s of allImStrings()) {
      assert.ok(!s.includes(token), `an IM string contains forbidden token "${token}": "${s}"`);
    }
  }
});

test('positive control: the copy scan actually flags a planted fixture for every forbidden token', () => {
  for (const token of FORBIDDEN_COPY) {
    assert.ok(`a sentence with ${token} inside it`.includes(token));
  }
});

// === V1e-5: every persistent <dialog> selector that sets `display` is scoped to [open] ===========
//      (found live, 2026-10-01: dialog.im-picker set `display: flex` unconditionally, which beats
//      the UA stylesheet's `dialog:not([open]) { display: none }` on specificity+order, so a
//      CLOSED picker stayed visually on screen and kept intercepting clicks underneath it --
//      exactly the class of defect dialog.a1-slip's own CSS comment already named by number.
//      This is a structural guard against the same mistake recurring on a future persistent
//      dialog, not merely a record of the one fix. Relocated from test/admin-style.test.js --
//      the Architect's brief scoped that file to the SD-53 API_ROUTE_PATHS edit only, and this
//      section landed there by mistake in an earlier pass. This file has no such restriction.)

const ADMIN_CSS_PATH = path.join(ADMIN_ASSETS_DIR, 'admin.css');

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every top-level `selector { ... }` block in the stripped CSS text, as `{selector, body}`. */
function cssRuleBlocks(cssText) {
  const stripped = stripCssComments(cssText);
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripped))) {
    blocks.push({ selector: m[1].trim(), body: m[2] });
  }
  return blocks;
}

test('every dialog.* selector in admin.css that sets display: is scoped with [open]', () => {
  const css = fs.readFileSync(ADMIN_CSS_PATH, 'utf8');
  const blocks = cssRuleBlocks(css);
  let checked = 0;
  for (const { selector, body } of blocks) {
    if (!/\bdialog\.[a-zA-Z-]/.test(selector)) continue;
    if (!/\bdisplay\s*:/.test(body)) continue;
    checked++;
    assert.ok(
      /\[open\]/.test(selector),
      `"${selector}" sets display: without [open] -- a closed <dialog> would stay visually on screen (the same class of defect dialog.a1-slip's own CSS comment names)`,
    );
  }
  // Positive control: the scan actually found at least the two persistent dialogs this repo has
  // (dialog.a1-slip, dialog.im-picker), not vacuously true.
  assert.ok(checked >= 2, `expected to check at least 2 dialog display: rules, checked ${checked}`);
});

test('positive control: an unscoped dialog display: rule is flagged by the same scan', () => {
  const planted = 'dialog.planted-fixture { display: flex; }';
  const blocks = cssRuleBlocks(planted);
  const bad = blocks.filter((b) => /\bdialog\.[a-zA-Z-]/.test(b.selector) && /\bdisplay\s*:/.test(b.body) && !/\[open\]/.test(b.selector));
  assert.equal(bad.length, 1);
});
