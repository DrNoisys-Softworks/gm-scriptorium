'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { VC } = require(path.join(__dirname, '..', 'assets', 'admin', 'vaultcfg.js'));
const { NV } = require(path.join(__dirname, '..', 'assets', 'admin', 'nav.js'));
const { OC } = require(path.join(__dirname, '..', 'assets', 'admin', 'outcome.js'));

/*
 * V1e-9 (SD-100's own test 7). VC/NV/OC are pure (the VB pattern), loaded via require() the same
 * way test/admin-frame.test.js loads NV/ST/IC. The browser half (DOM, debounced status, the
 * review slip) is browser-only and was exercised live via Playwright against a real server
 * during development (see the Engineer report); it is not re-driven here. Independent literals
 * throughout.
 */

// -- VC.tokens -----------------------------------------------------------------------------------

test('VC.tokens: the fence line', () => {
  assert.deepEqual(VC.tokens('---', true), [{ t: 'fence', s: '---' }]);
});

test('VC.tokens: a plain key/value line splits into key, colon-and-space, and value tokens', () => {
  assert.deepEqual(VC.tokens('mode: full', true), [
    { t: 'key', s: 'mode' },
    { t: 'plain', s: ':' },
    { t: 'plain', s: ' full' },
  ]);
});

test('VC.tokens: an indented key keeps its own leading-whitespace token', () => {
  assert.deepEqual(VC.tokens('  mode: full', true), [
    { t: 'plain', s: '  ' },
    { t: 'key', s: 'mode' },
    { t: 'plain', s: ':' },
    { t: 'plain', s: ' full' },
  ]);
});

test('VC.tokens: a quoted string value is its own token', () => {
  assert.deepEqual(VC.tokens('exclude_fields: ["secrets"]', true), [
    { t: 'key', s: 'exclude_fields' },
    { t: 'plain', s: ':' },
    { t: 'plain', s: ' [' },
    { t: 'str', s: '"secrets"' },
    { t: 'plain', s: ']' },
  ]);
});

test('VC.tokens: a line that is not key: value falls back to one plain token', () => {
  assert.deepEqual(VC.tokens('  - "a list item"', true), [{ t: 'plain', s: '  - "a list item"' }]);
});

// -- VC.fileMap (invented keys; DV-E9: derived from the file's own top-level keys) ----------------

test('VC.fileMap: a representative frontmatter names Campaign, Publishing and privacy, Look, Banners, Landing page, Not-found page, another publish child, and ends with Notes', () => {
  const text = [
    'system: Invented System',
    'publish:',
    '  mode: player',
    '  exclude_fields: ["secrets"]',
    '  theme:',
    '    tagline: Hello',
    '  banners:',
    '    region: x.jpg',
    '  landing:',
    '    featured_npcs: ["Orpiment"]',
    '  four_oh_four:',
    '    message: Not found',
    '  extra_setting: true',
  ].join('\n');
  assert.deepEqual(VC.fileMap(text), [
    { label: 'Campaign', hint: 'what it is, the system, the year', line: 2 },
    { label: 'Publishing and privacy', hint: 'player mode and the hidden lists', line: 4 },
    { label: 'Look', hint: 'tagline, colours, fonts, cover art', line: 6 },
    { label: 'Banners', hint: 'the section banners', line: 8 },
    { label: 'Landing page', hint: 'featured characters, quick links, blurbs', line: 10 },
    { label: 'Not-found page', hint: 'the 404 message', line: 12 },
    { label: 'extra_setting', hint: 'other publish settings', line: 14 },
    { label: 'Notes', hint: 'your prose, below the frontmatter. The panel never shows or changes it.', line: null },
  ]);
});

test('VC.fileMap: only present keys appear (a minimal file with no top-level non-publish key gives Publishing and privacy plus Notes only)', () => {
  const text = ['publish:', '  mode: player'].join('\n');
  assert.deepEqual(VC.fileMap(text), [
    { label: 'Publishing and privacy', hint: 'player mode and the hidden lists', line: 3 },
    { label: 'Notes', hint: 'your prose, below the frontmatter. The panel never shows or changes it.', line: null },
  ]);
});

test('VC.fileMap: Notes is always last, even on a frontmatter with no publish key at all', () => {
  const text = ['system: Invented System', 'year: 2026'].join('\n');
  assert.deepEqual(VC.fileMap(text), [
    { label: 'Campaign', hint: 'what it is, the system, the year', line: 2 },
    { label: 'Notes', hint: 'your prose, below the frontmatter. The panel never shows or changes it.', line: null },
  ]);
});

// -- VC.changedLines -------------------------------------------------------------------------------

test('VC.changedLines: file line numbers (frontmatter 1-based line n -> file line n + 1)', () => {
  const orig = 'type: meta\npublish:\n  mode: player';
  const next = 'type: meta\npublish:\n  mode: full';
  assert.deepEqual(VC.changedLines(orig, next), [4]);
});

test('VC.changedLines: an added line reports its own new file line', () => {
  const orig = 'type: meta';
  const next = 'type: meta\nyear: 2026';
  assert.deepEqual(VC.changedLines(orig, next), [3]);
});

test('VC.changedLines: no difference gives an empty array', () => {
  assert.deepEqual(VC.changedLines('type: meta', 'type: meta'), []);
});

// -- VC.reviewEnabled -------------------------------------------------------------------------------

test('VC.reviewEnabled: true only when every one of dirty/parseOk/parseFresh/canEdit holds and busy is false', () => {
  const base = { dirty: true, parseOk: true, parseFresh: true, canEdit: true, busy: false };
  assert.equal(VC.reviewEnabled(base), true);
  assert.equal(VC.reviewEnabled({ ...base, dirty: false }), false);
  assert.equal(VC.reviewEnabled({ ...base, parseOk: false }), false);
  assert.equal(VC.reviewEnabled({ ...base, parseFresh: false }), false);
  assert.equal(VC.reviewEnabled({ ...base, canEdit: false }), false);
  assert.equal(VC.reviewEnabled({ ...base, busy: true }), false);
});

// -- VC.effectsSorted -------------------------------------------------------------------------------

test('VC.effectsSorted: bad, look, ok, info, stable within each level', () => {
  const effects = [
    { id: 'a', level: 'info' },
    { id: 'b', level: 'ok' },
    { id: 'c', level: 'bad' },
    { id: 'd', level: 'look' },
    { id: 'e', level: 'bad' },
    { id: 'f', level: 'ok' },
  ];
  assert.deepEqual(
    VC.effectsSorted(effects).map((e) => e.id),
    ['c', 'e', 'd', 'b', 'f', 'a'],
  );
});

// -- VC.checkBlock ----------------------------------------------------------------------------------

test('VC.checkBlock: not ran -- bad', () => {
  assert.deepEqual(VC.checkBlock({ ran: false }), { level: 'bad', strong: "Check couldn't run on your edited copy.", items: [] });
});

test('VC.checkBlock: zero errors and zero warnings -- clean, ok', () => {
  const check = { ran: true, counts: { error: 0, warn: 0 }, newCount: 0, newErrorCount: 0, newFindings: [] };
  assert.deepEqual(VC.checkBlock(check), { level: 'ok', strong: 'Check on your edited copy: clean.', items: [' 0 errors, 0 warnings.'] });
});

test('VC.checkBlock: newCount 0 but existing findings remain -- nothing new, ok', () => {
  const check = { ran: true, counts: { error: 1, warn: 2 }, newCount: 0, newErrorCount: 0, newFindings: [] };
  assert.deepEqual(VC.checkBlock(check), {
    level: 'ok',
    strong: 'Check on your edited copy: nothing new.',
    items: ['1 errors and 2 warnings, the same as the file now.'],
  });
});

test('VC.checkBlock: new findings, an error among them -- bad, with up to 5 items plus an overflow line', () => {
  const findings = Array.from({ length: 7 }, (_, i) => ({ id: 'id-' + i, message: 'message ' + i }));
  const check = { ran: true, counts: { error: 1, warn: 6 }, newCount: 7, newErrorCount: 1, newFindings: findings };
  const block = VC.checkBlock(check);
  assert.equal(block.level, 'bad');
  assert.equal(block.strong, 'Check on your edited copy: 7 new finding(s).');
  assert.deepEqual(block.items, ['id-0: message 0', 'id-1: message 1', 'id-2: message 2', 'id-3: message 3', 'id-4: message 4', 'and 2 more']);
});

test('VC.checkBlock: new findings, no errors among them -- ok', () => {
  const check = { ran: true, counts: { error: 0, warn: 1 }, newCount: 1, newErrorCount: 0, newFindings: [{ id: 'config/x', message: 'y' }] };
  assert.equal(VC.checkBlock(check).level, 'ok');
});

// -- VC.ackLabel ------------------------------------------------------------------------------------

test('VC.ackLabel: the privacy-specific wording when reasons includes "privacy"', () => {
  assert.equal(VC.ackLabel(['privacy', 'new-errors']), "Save anyway. I want what's listed in red published to players.");
});

test('VC.ackLabel: the generic wording otherwise', () => {
  assert.equal(VC.ackLabel(['new-errors']), "Save anyway. I've read the check results above.");
  assert.equal(VC.ackLabel([]), "Save anyway. I've read the check results above.");
});

// -- VC.backupWhen ----------------------------------------------------------------------------------

test('VC.backupWhen: the same local day gives "Today HH:MM"', () => {
  const now = new Date(2026, 0, 2, 18, 0, 0);
  const taken = new Date(2026, 0, 2, 14, 30, 5);
  assert.equal(VC.backupWhen(taken.toISOString(), now.toISOString()), 'Today 14:30');
});

test('VC.backupWhen: a different local day gives "<Mon> <D>, HH:MM"', () => {
  const now = new Date(2026, 0, 3, 9, 0, 0);
  const taken = new Date(2026, 0, 2, 14, 30, 5);
  assert.equal(VC.backupWhen(taken.toISOString(), now.toISOString()), 'Jan 2, 14:30');
});

// -- VC.sizeLabel -----------------------------------------------------------------------------------

test('VC.sizeLabel: under 1024 gives "<n> bytes"', () => {
  assert.equal(VC.sizeLabel(0), '0 bytes');
  assert.equal(VC.sizeLabel(1023), '1023 bytes');
});

test('VC.sizeLabel: 1024 and above gives a one-decimal KB figure', () => {
  assert.equal(VC.sizeLabel(1024), '1.0 KB');
  assert.equal(VC.sizeLabel(1536), '1.5 KB');
  assert.equal(VC.sizeLabel(2048), '2.0 KB');
});

// -- VC.acceptResponse --------------------------------------------------------------------------------

test('VC.acceptResponse: true only when seq equals the latest sequence number', () => {
  assert.equal(VC.acceptResponse(3, 3), true);
  assert.equal(VC.acceptResponse(3, 2), false);
  assert.equal(VC.acceptResponse(3, 4), false);
});

// -- NV.guardMarker -----------------------------------------------------------------------------------

test('NV.guardMarker: writable:false always gives read-only, regardless of editing', () => {
  assert.deepEqual(NV.guardMarker(false, false), { cls: 'a1-ro', text: 'read-only' });
  assert.deepEqual(NV.guardMarker(false, true), { cls: 'a1-ro', text: 'read-only' });
});

test('NV.guardMarker: writable:true, editing:true gives "editing"', () => {
  assert.deepEqual(NV.guardMarker(true, true), { cls: 'a1-warnpill', text: 'editing' });
});

test('NV.guardMarker: writable:true, editing:false gives "guarded"', () => {
  assert.deepEqual(NV.guardMarker(true, false), { cls: 'a1-warnpill', text: 'guarded' });
});

// -- OC additions (needs-ack, refused-by-check) -- also covered directly in test/admin-outcome.test.js

test('OC.mapOutcome: needs-ack and refused-by-check both map before the generic 422 branch', () => {
  const needsAck = OC.mapOutcome({ ok: false, status: 422, body: { error: 'needs-ack', message: 'x' } }, 'save');
  assert.equal(needsAck.kind, 'needs-ack');
  const refused = OC.mapOutcome({ ok: false, status: 422, body: { error: 'refused-by-check', message: 'y' } }, 'save');
  assert.equal(refused.kind, 'refused-by-check');
});

// -- Structural: busy counts in vaultcfg.js, and slip.js's track-only currentSaveBtn assignment ----

function readAsset(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', name), 'utf8');
}

test('vaultcfg.js: reviewBtn.disabled = reviewOwnDisabled || store.isBusy(); appears exactly 3 times (initial, .then, .catch)', () => {
  const src = readAsset('vaultcfg.js');
  const count = (src.match(/reviewBtn\.disabled = reviewOwnDisabled \|\| store\.isBusy\(\);/g) || []).length;
  assert.equal(count, 3);
});

test('vaultcfg.js: restoreBtn.disabled = restoreOwnDisabled || store.isBusy(); appears exactly 1 time, at build', () => {
  const src = readAsset('vaultcfg.js');
  const count = (src.match(/restoreBtn\.disabled = restoreOwnDisabled \|\| store\.isBusy\(\);/g) || []).length;
  assert.equal(count, 1);
});

test("vaultcfg.js: baseSha256: session.base appears exactly 3 times (dry-run status, confirm save, the review's own dry body) -- K30: while a session is open, every save/review request must bind to the sha captured at unlock time, never the store's own live value, or a concurrent outside edit (e.g. the Title screen's own tagline save) goes undetected and the stale save silently overwrites it instead of getting refused", () => {
  const src = readAsset('vaultcfg.js');
  const count = (src.match(/baseSha256: session\.base/g) || []).length;
  assert.equal(count, 3);
});

test('vaultcfg.js: baseSha256: ed.sha256 (the live value) is used only for the read-view Restore dry run/confirm, never while a session is open', () => {
  const src = readAsset('vaultcfg.js');
  const count = (src.match(/baseSha256: ed\.sha256/g) || []).length;
  assert.equal(count, 2);
});

test('vaultcfg.js: one busy-only subscription -- if (next.busy === prev.busy) return; is absent, but the busy branch re-evaluates both tracked button sets', () => {
  const src = readAsset('vaultcfg.js');
  assert.ok(/if \(next\.busy !== prev\.busy\)/.test(src), 'expected a busy-specific branch in the store.subscribe callback');
  assert.ok(src.includes('reviewBtnRefs.forEach'));
  assert.ok(src.includes('restoreBtnRefs.forEach'));
});

test("slip.js: currentSaveBtn is assigned only through track() inside openCustom (never a bare currentSaveBtn = ... outside review()/reviewMany()/the busy subscription)", () => {
  const src = readAsset('slip.js');
  // Exclude the one `var currentSaveBtn = null;` declaration (not an assignment SITE in the
  // sense this test cares about -- it is the module's own initial state).
  const assignments = [...src.matchAll(/(?<!var )currentSaveBtn\s*=/g)];
  // The known, pre-existing assignment sites: review()'s own `currentSaveBtn = saveBtn;`,
  // reviewMany()'s own `currentSaveBtn = saveBtn;`, and openCustom's own `track` closure
  // (`currentSaveBtn = btn || null;`). No fourth site should ever appear.
  assert.equal(assignments.length, 3, `expected exactly 3 currentSaveBtn assignment sites, found ${assignments.length}`);
  assert.ok(src.includes('currentSaveBtn = btn || null;'), 'expected openCustom\'s own track() closure to assign currentSaveBtn');
});

test('slip.js: the frozen busy subscription line (re-evaluating currentSaveBtn) appears exactly once', () => {
  const src = readAsset('slip.js');
  const count = (src.match(/if \(currentSaveBtn\) currentSaveBtn\.disabled = window\.ScriptoriumAdmin\.store\.isBusy\(\);/g) || []).length;
  assert.equal(count, 1);
});

test('slip.js: openCustom is exported alongside review/reviewMany/close', () => {
  const src = readAsset('slip.js');
  assert.match(src, /window\.ScriptoriumAdmin\.slip = \{ review: review, reviewMany: reviewMany, openCustom: openCustom, close: closeDialog \};/);
});

// -- Structural: no fetch( outside app.js, even in the new asset ----------------------------------

test('positive control: vaultcfg.js never calls fetch( directly (it goes through api(), the one fetch() in the admin panel)', () => {
  const src = readAsset('vaultcfg.js');
  assert.doesNotMatch(src, /\bfetch\(/);
});

// -- G7 accessibility fixes (found live, Chromium axe-core, review dialog) ----------------------

test('admin.css: .vc-eff li p uses the slip\'s own --slip-muted, not the dark-chrome --text-muted (axe color-contrast, found live during G7: 1.51:1 against the slip\'s light background)', () => {
  const src = readAsset('admin.css');
  const rule = /\.vc-eff li p \{[^}]*\}/.exec(src);
  assert.ok(rule, 'expected a .vc-eff li p rule in admin.css');
  assert.match(rule[0], /color: var\(--slip-muted\);/);
  assert.doesNotMatch(rule[0], /var\(--text-muted\)/);
});

test('admin.css: .vc-eff li.bad .ico/b use the slip\'s own --slip-del-ink, not the dark-chrome --error (axe color-contrast, found live during G7: 1.62:1 against the slip\'s light background)', () => {
  const src = readAsset('admin.css');
  const rule = /\.vc-eff li\.bad \.ico,\s*\n\.vc-eff li\.bad b \{[^}]*\}/.exec(src);
  assert.ok(rule, 'expected a .vc-eff li.bad .ico, .vc-eff li.bad b rule in admin.css');
  assert.match(rule[0], /color: var\(--slip-del-ink\);/);
  assert.doesNotMatch(rule[0], /var\(--error\)/);
});

test('vaultcfg.js: the review dialog\'s notes are built as <p class="info">, never <li> (axe listitem, found live during G7: df is a <div>, not a <ul>/<ol>)', () => {
  const src = readAsset('vaultcfg.js');
  assert.match(src, /dry\.notes\.forEach\(function \(note\) \{\s*\n(?:[^\n]*\n){0,4}?\s*var p = el\('p'\);\s*\n\s*p\.className = 'info';/);
});

// -- Reviewer 2 finding 1: the editor must frame the textarea with fixed --- rows, matching the
// mock and buildCode (vaultcfg.js:290,294), never folding the fences into the editable value. --

test('vaultcfg.js: buildEditor renders a fixed, non-editable "---" row before and after the textarea (a fenceRow helper, called at build and kept current on every render)', () => {
  const src = readAsset('vaultcfg.js');
  // A fenceRow-shaped helper exists and is used for both the opening and the closing row: two
  // calls, not one, so a lone top-only or bottom-only fix would still fail this.
  const defs = (src.match(/function fenceRow\(/g) || []).length;
  assert.equal(defs, 1, 'expected exactly one fenceRow(lineNo) helper');
  const calls = (src.match(/fenceRow\(/g) || []).length;
  assert.ok(calls >= 3, `expected fenceRow( to be called at least twice beyond its own definition (top row, bottom row); found ${calls - 1} call site(s)`);
  // The bottom row's own line number must track the live line count (file-relative: the opening
  // fence is line 1, so the closing fence is lines.length + 2), not a number fixed at build time.
  assert.match(src, /String\(lines\.length \+ 2\)/, 'expected the closing fence row\'s line number to be recomputed from the live line count');
});

test('vaultcfg.js: the textarea\'s own value is never widened with a fence line -- ta.value is assigned exactly session.current/session.orig, nothing concatenated, so the saved payload (frontmatterText: ta.value) stays byte-identical to the settings block text', () => {
  const src = readAsset('vaultcfg.js');
  assert.match(src, /ta\.value = session\.current;/);
  assert.match(src, /ta\.value = session\.orig;/);
  // No string concatenation or template literal anywhere assigns to ta.value (which would be
  // the shape of a bug that folds a fence marker into the editable/submitted text).
  assert.doesNotMatch(src, /ta\.value = [^;]*(\+|`)[^;]*;/);
});

test('vaultcfg.js: the editor\'s own gutter numbers content lines file-relative (the opening fence is line 1, so the first content line is "2"), matching buildCode\'s own numbering and the parse-error line the status text reports', () => {
  const src = readAsset('vaultcfg.js');
  assert.match(src, /setText\(span, String\(i \+ 2\)\);/, 'expected the content gutter to print i + 2 (file-relative), not i + 1 (content-relative)');
});

// -- Reviewer 2 finding 2: the disabled "danger" button inside the slip must genuinely outrank
// .a1-slip .a1-btn.danger, not just tie with it and happen to lose on source order. ---------------

/** A CSS specificity count good enough for the plain class/pseudo-class selectors this file uses
 * (no ids, no element selectors, no attribute selectors in play here): every `.class` and every
 * `:pseudo-class` (but not `::pseudo-element`) counts as one. */
function specificity(selector) {
  const classes = (selector.match(/\.[a-zA-Z0-9_-]+/g) || []).length;
  const pseudoClasses = (selector.match(/(?<!:):[a-zA-Z-]+/g) || []).length;
  return classes + pseudoClasses;
}

function cssRule(src, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped.replace(/\s+/g, '\\s+') + '\\s*\\{([^}]*)\\}');
  const m = re.exec(src);
  return m ? m[1] : null;
}

test('admin.css: .a1-slip .a1-btn.danger:disabled genuinely outranks .a1-slip .a1-btn.danger (higher CSS specificity, not just source order) -- found live during the G7 follow-up: a disabled "Back up and save" read as a solid active red button because the two tied at (0,3,0) and the slip rule came later', () => {
  const src = readAsset('admin.css');
  const base = '.a1-slip .a1-btn.danger';
  const disabled = '.a1-slip .a1-btn.danger:disabled';
  const baseRule = cssRule(src, base);
  const disabledRule = cssRule(src, disabled);
  assert.ok(baseRule, 'expected a .a1-slip .a1-btn.danger rule in admin.css');
  assert.ok(disabledRule, 'expected a .a1-slip .a1-btn.danger:disabled rule in admin.css');
  assert.ok(
    specificity(disabled) > specificity(base),
    `expected .a1-slip .a1-btn.danger:disabled (specificity ${specificity(disabled)}) to outrank .a1-slip .a1-btn.danger (specificity ${specificity(base)}), not merely tie with it`,
  );
  // The disabled-in-slip rule must actually produce the muted look, not just exist.
  assert.match(disabledRule, /background:\s*transparent;/);
  assert.match(disabledRule, /color:\s*var\(--text-muted\);/);
});

// -- Reviewer 2 finding 3: the shared dialog must wire its own focus trap once, at build time,
// so every caller (review/reviewMany/openCustom) is covered without opting in separately. The
// live Chromium/Firefox Tab-cycle evidence (0 escapes fixed, 2 escapes mutated, both engines
// re-run against the mutation) lives at
// ~/drop/scriptorium-qc/panel-v1e9-gate/rework2/focus-trap-*.log; this is the structural guard
// that the wiring itself isn't quietly dropped later. ------------------------------------------

test('slip.js: trapFocus(dialog, ev) is defined once and wired into the dialog\'s own keydown listener inside buildDialog, so every caller of the shared dialog is covered', () => {
  const src = readAsset('slip.js');
  assert.equal((src.match(/function trapFocus\(dialog, ev\)/g) || []).length, 1);
  const buildDialogBody = /function buildDialog\(\) \{[\s\S]*?\n  \}/.exec(src);
  assert.ok(buildDialogBody, 'expected a buildDialog() function');
  assert.match(buildDialogBody[0], /dialog\.addEventListener\('keydown', function \(ev\) \{\s*\n\s*trapFocus\(dialog, ev\);\s*\n\s*\}\);/);
});
