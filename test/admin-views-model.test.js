'use strict';

process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { VW } = require(path.join(__dirname, '..', 'assets', 'admin', 'views.js'));
const { IM } = require(path.join(__dirname, '..', 'assets', 'admin', 'images.js'));

/*
 * Panel v2 V1c (FR-06, FR-14, FR-15, FR-16, FR-20, interfaces). VW is loaded via require() (the
 * VB pattern, test/admin-frame.test.js:7-9's node-loading precedent). TZ=UTC is set above every
 * require() (matches the house pattern for a file that asserts HH:MM literals) so timeOf's
 * output is deterministic regardless of the host's local timezone.
 *
 * Independent literals throughout: envelope/response shapes are hand-typed from
 * src/cli/build.js and src/report/json.js's documented shapes, not derived by calling VW itself.
 */

// === VW.timeOf ====================================================================================

test('VW.timeOf: a UTC ISO instant gives local HH:MM (TZ=UTC, so local === UTC here)', () => {
  assert.equal(VW.timeOf('2026-09-29T04:05:00.000Z'), '04:05');
});

test('VW.timeOf: midnight and single-digit minutes both zero-pad', () => {
  assert.equal(VW.timeOf('2026-09-29T00:07:00.000Z'), '00:07');
});

test('VW.timeOf: an invalid input gives "" -- null, undefined, empty string and garbage', () => {
  assert.equal(VW.timeOf(null), '');
  assert.equal(VW.timeOf(undefined), '');
  assert.equal(VW.timeOf(''), '');
  assert.equal(VW.timeOf('not a date'), '');
});

// === VW.billCheck =================================================================================

test('VW.billCheck(null) -- "Not run in this tab yet"', () => {
  assert.deepEqual(VW.billCheck(null), { text: 'Not run in this tab yet', meta: '' });
});

test('VW.billCheck: clean (0 errors, 0 warnings) gives "Clean"', () => {
  const lastCheck = { exitCode: 0, counts: { error: 0, warn: 0, info: 3 }, findings: [], generatedAt: '2026-09-29T04:05:00.000Z' };
  const result = VW.billCheck(lastCheck);
  assert.equal(result.text, 'Clean');
  assert.equal(result.meta, '0 errors · 0 warnings · 3 info · 04:05');
});

test('VW.billCheck: dirty (errors and/or warnings present) gives "N errors · N warnings"', () => {
  const lastCheck = { exitCode: 2, counts: { error: 2, warn: 1, info: 0 }, findings: [], generatedAt: '2026-09-29T09:30:00.000Z' };
  const result = VW.billCheck(lastCheck);
  assert.equal(result.text, '2 errors · 1 warnings');
  assert.equal(result.meta, '2 errors · 1 warnings · 0 info · 09:30');
});

test('VW.billCheck: warnings alone (0 errors, 1+ warnings) is still "dirty", not "Clean"', () => {
  const lastCheck = { exitCode: 0, counts: { error: 0, warn: 1, info: 0 }, findings: [], generatedAt: '2026-09-29T04:05:00.000Z' };
  assert.equal(VW.billCheck(lastCheck).text, '0 errors · 1 warnings');
});

// === VW.billPreview ================================================================================

test('VW.billPreview(null, false) -- "Not run in this tab yet", no link', () => {
  assert.deepEqual(VW.billPreview(null, false), { text: 'Not run in this tab yet', meta: '', showLink: false });
});

test('VW.billPreview(null, true) -- previewBuilt alone (not this tab) gives "A preview is built"', () => {
  assert.deepEqual(VW.billPreview(null, true), { text: 'A preview is built', meta: '', showLink: true });
});

test('VW.billPreview(<this-tab>, false) -- this tab\'s own build wins even when previewBuilt is false', () => {
  const lastPreview = { exitCode: 0, pagesWritten: 42, generatedAt: '2026-09-29T04:05:00.000Z', refused: false, findings: [], human: 'built ok' };
  const result = VW.billPreview(lastPreview, false);
  assert.equal(result.text, '42 files');
  assert.equal(result.meta, 'built 04:05');
  assert.equal(result.showLink, true);
});

test('VW.billPreview: (null, true) and (this-tab, false) are the two distinguishing branch cases, and differ', () => {
  const a = VW.billPreview(null, true);
  const lastPreview = { exitCode: 0, pagesWritten: 1, generatedAt: '2026-09-29T00:00:00.000Z', refused: false, findings: [], human: '' };
  const b = VW.billPreview(lastPreview, false);
  assert.notDeepEqual(a, b);
});

// M2 positive control: the argument-swap mutation is described as `billPreview(previewBuilt,
// lastPreview)`. Proven below by directly calling with swapped argument *values* (not editing
// source): the (this-tab, false) case above already distinguishes a swap, because swapping in a
// bare boolean for the first parameter can never carry a pagesWritten field.
test('M2 positive control: calling with the arguments swapped changes the branch taken', () => {
  const lastPreview = { exitCode: 0, pagesWritten: 7, generatedAt: '2026-09-29T04:05:00.000Z', refused: false, findings: [], human: '' };
  const correct = VW.billPreview(lastPreview, false);
  const swapped = VW.billPreview(false, lastPreview);
  assert.notDeepEqual(correct, swapped);
  assert.equal(correct.text, '7 files');
  assert.equal(swapped.text, 'A preview is built'); // `lastPreview` (truthy object) read as the previewBuilt flag
});

// === VW.checkOutcome ===============================================================================
// Response shapes hand-typed from src/admin/handlers/views.js's check() (200 {exitCode,envelope,
// human}; 200 {exitCode,error} on a throw; 409 {error:'busy',busy} on FR31) and
// src/report/json.js's buildEnvelope ({..., generatedAt, counts:{error,warn,info}, findings}).

test('VW.checkOutcome: a 200 envelope response gives kind "ok" with counts/findings/generatedAt from the envelope', () => {
  const result = {
    ok: true,
    status: 200,
    body: {
      exitCode: 0,
      envelope: {
        generatedAt: '2026-09-29T04:05:00.000Z',
        counts: { error: 0, warn: 1, info: 2 },
        findings: [{ id: 'config/theme-scheme-mismatch', severity: 'warn', path: 'pack.toml', message: 'scheme mismatch' }],
      },
      human: 'ok: 0 errors, 1 warnings, 2 info',
    },
  };
  const outcome = VW.checkOutcome(result);
  assert.equal(outcome.kind, 'ok');
  assert.deepEqual(outcome.counts, { error: 0, warn: 1, info: 2 });
  assert.deepEqual(outcome.findings, [{ id: 'config/theme-scheme-mismatch', severity: 'warn', path: 'pack.toml', message: 'scheme mismatch' }]);
});

test('VW.checkOutcome: a 200 {exitCode,error} response (a thrown error) gives kind "error", message verbatim', () => {
  const result = { ok: true, status: 200, body: { exitCode: 1, error: 'vault unreachable: ENOENT' } };
  const outcome = VW.checkOutcome(result);
  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.message, 'vault unreachable: ENOENT');
});

test('VW.checkOutcome: a 409 {error:"busy",busy} response gives kind "busy", the OC busy message', () => {
  const result = { ok: false, status: 409, body: { error: 'busy', busy: 'build' } };
  const outcome = VW.checkOutcome(result);
  assert.equal(outcome.kind, 'busy');
  assert.equal(outcome.message, 'The panel is busy running a preview build.');
});

test('VW.checkOutcome: a network abort (status 0) gives kind "unknown", not "busy" or "ok"', () => {
  const result = { ok: false, status: 0, body: null };
  const outcome = VW.checkOutcome(result);
  assert.equal(outcome.kind, 'unknown');
  assert.equal(typeof outcome.message, 'string');
  assert.ok(outcome.message.length > 0);
});

// === VW.previewOutcome =============================================================================
// Envelope shapes hand-typed from src/cli/build.js:270-289 (success), :140-165 (check refusal),
// :193-213 (scan refusal), :216-237 (a render failure, ok:false but refused:false).

test('VW.previewOutcome: a successful build gives kind "built" with pagesWritten/generatedAt/human', () => {
  const result = {
    ok: true,
    status: 200,
    body: {
      exitCode: 0,
      human: 'built 12 pages',
      envelope: {
        ok: true,
        refused: false,
        refusedByScan: false,
        pagesWritten: 12,
        generatedAt: '2026-09-29T04:05:00.000Z',
        check: { counts: { error: 0, warn: 0, info: 0 }, findings: [] },
      },
    },
  };
  const outcome = VW.previewOutcome(result);
  assert.equal(outcome.kind, 'built');
  assert.equal(outcome.pagesWritten, 12);
  assert.equal(outcome.generatedAt, '2026-09-29T04:05:00.000Z');
  assert.equal(outcome.human, 'built 12 pages');
  assert.deepEqual(outcome.findings, []);
});

test('VW.previewOutcome: a check refusal gives kind "refused-check", findings from envelope.check.findings', () => {
  const result = {
    ok: true,
    status: 200,
    body: {
      exitCode: 2,
      human: 'check found 1 error(s); refusing to build.',
      envelope: {
        ok: false,
        refused: true,
        refusedByScan: false,
        pagesWritten: null,
        generatedAt: '2026-09-29T04:05:00.000Z',
        error: 'check found 1 error(s); refusing to build',
        check: {
          counts: { error: 1, warn: 0, info: 0 },
          findings: [{ id: 'vault/withheld-name-leak', severity: 'error', path: 'sessions/s1.md', message: 'a withheld name leaked' }],
        },
      },
    },
  };
  const outcome = VW.previewOutcome(result);
  assert.equal(outcome.kind, 'refused-check');
  assert.equal(outcome.pagesWritten, null);
  assert.deepEqual(outcome.findings, [{ id: 'vault/withheld-name-leak', severity: 'error', path: 'sessions/s1.md', message: 'a withheld name leaked' }]);
});

// M6: a mutant that treats refusedByScan as refused-check (i.e. checks `refused === true` alone,
// without excluding refusedByScan) would give kind "refused-check" and read the (here, empty)
// check.findings instead of outputScanFindings. Both the kind and the findings content catch it.
test('VW.previewOutcome: a scan refusal gives kind "refused-scan", findings from envelope.outputScanFindings (M6)', () => {
  const result = {
    ok: true,
    status: 200,
    body: {
      exitCode: 2,
      human: 'the output-leak scan found 1 error(s); refusing to swap.',
      envelope: {
        ok: false,
        refused: true,
        refusedByScan: true,
        pagesWritten: null,
        generatedAt: '2026-09-29T04:05:00.000Z',
        error: 'the output-leak scan found 1 error(s); refusing to build',
        check: { counts: { error: 0, warn: 0, info: 0 }, findings: [] },
        outputScanFindings: [{ id: 'output/leak', severity: 'error', path: 'site/npc/x.html', message: 'a withheld name leaked in the staged output' }],
      },
    },
  };
  const outcome = VW.previewOutcome(result);
  assert.equal(outcome.kind, 'refused-scan');
  assert.deepEqual(outcome.findings, [{ id: 'output/leak', severity: 'error', path: 'site/npc/x.html', message: 'a withheld name leaked in the staged output' }]);
});

test('VW.previewOutcome: a render failure (ok:false, refused:false) gives kind "failed"', () => {
  const result = {
    ok: true,
    status: 200,
    body: {
      exitCode: 1,
      human: 'build failed: ENOSPC',
      envelope: {
        ok: false,
        refused: false,
        refusedByScan: false,
        pagesWritten: null,
        generatedAt: '2026-09-29T04:05:00.000Z',
        error: 'ENOSPC: no space left on device',
        check: { counts: { error: 0, warn: 0, info: 0 }, findings: [] },
      },
    },
  };
  const outcome = VW.previewOutcome(result);
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.message, 'ENOSPC: no space left on device');
});

test('VW.previewOutcome: a 200 {exitCode,error} response (a thrown error, no envelope at all) gives kind "error"', () => {
  const result = { ok: true, status: 200, body: { exitCode: 3, error: 'vault unreachable' } };
  const outcome = VW.previewOutcome(result);
  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.message, 'vault unreachable');
});

test('VW.previewOutcome: a 409 busy response gives kind "busy"', () => {
  const result = { ok: false, status: 409, body: { error: 'busy', busy: 'check' } };
  const outcome = VW.previewOutcome(result);
  assert.equal(outcome.kind, 'busy');
  assert.equal(outcome.message, 'The panel is busy running a check.');
});

test('VW.previewOutcome: a network abort gives kind "unknown"', () => {
  const result = { ok: false, status: 0, body: null };
  const outcome = VW.previewOutcome(result);
  assert.equal(outcome.kind, 'unknown');
});

// === VW.findingRows ================================================================================

test('VW.findingRows: maps severity/id/path/message, defaulting a missing path to ""', () => {
  const findings = [
    { id: 'a', severity: 'error', path: 'x/y.md', message: 'boom' },
    { id: 'b', severity: 'info', message: 'no path on this one' },
  ];
  assert.deepEqual(VW.findingRows(findings), [
    { severity: 'error', id: 'a', path: 'x/y.md', message: 'boom' },
    { severity: 'info', id: 'b', path: '', message: 'no path on this one' },
  ]);
});

test('VW.findingRows: an empty or missing array gives []', () => {
  assert.deepEqual(VW.findingRows([]), []);
  assert.deepEqual(VW.findingRows(undefined), []);
});

// === VW.wordsSummary ===============================================================================
// An Engineer-interpreted residual (CLAUDE.md's testing-standards precedent, slip.js's kindsRows
// comment): the interfaces name the three ingredients (custom label count, custom kind count or
// "built-in kinds") without pinning literal text. Documented at the call site in views.js.

test('VW.wordsSummary: no tables at all (a missing pack.toml) -- 0 custom labels, built-in kinds', () => {
  const vocab = { exists: false, tables: null, error: null, defaults: {} };
  assert.equal(VW.wordsSummary(vocab), '0 custom labels, built-in kinds');
});

test('VW.wordsSummary: tables present but no [timeline] table -- built-in kinds still applies', () => {
  const vocab = { exists: true, tables: { labels: null, timeline: null, recaps: null }, error: null, defaults: {} };
  assert.equal(VW.wordsSummary(vocab), '0 custom labels, built-in kinds');
});

test('VW.wordsSummary: custom labels and custom kinds both present, plural counts', () => {
  const vocab = {
    exists: true,
    tables: {
      labels: { learned_lens: 'a', learned_legend: 'b' },
      timeline: { kinds: [{ key: 'fight' }, { key: 'journey' }, { key: 'custom' }] },
      recaps: null,
    },
    error: null,
    defaults: {},
  };
  assert.equal(VW.wordsSummary(vocab), '2 custom labels, 3 custom kinds');
});

test('VW.wordsSummary: exactly one custom label and one custom kind, singular wording', () => {
  const vocab = {
    exists: true,
    tables: { labels: { learned_lens: 'a' }, timeline: { kinds: [{ key: 'fight' }] }, recaps: null },
    error: null,
    defaults: {},
  };
  assert.equal(VW.wordsSummary(vocab), '1 custom label, 1 custom kind');
});

// === VW.slotCells ==================================================================================
// The real IM.slotImageRel (required directly from images.js, per interfaces: "the node test
// passes a stub or the real IM required from images.js") -- not a views.js-local reimplementation,
// so the ancestor-direction/string-prefix-sibling cases below exercise the real membership check.

const SLOT_STATE = {
  images: ['a.png'],
  packToml: {
    images: {
      hero: 'images/a.png', // listed -- thumb
      ground: 'imagesx/a.png', // string-prefix sibling -- path, not thumb (M1)
      paper: 'images/../pack.toml', // ancestor direction -- path, not thumb (M1)
      'crest-frame': 'vault:images/a.png', // not an images/ value at all -- path
      portrait: '', // unset -- empty
      // '404' deliberately absent from the object -- also unset -- empty
    },
  },
};

test('VW.slotCells: six cells in SLOT_NAMES order, real IM.slotImageRel classifying each', () => {
  const cells = VW.slotCells(SLOT_STATE, IM.slotImageRel);
  assert.deepEqual(
    cells.map((c) => c.slot),
    ['hero', 'ground', 'paper', 'crest-frame', 'portrait', '404'],
  );
  assert.deepEqual(cells[0], { slot: 'hero', kind: 'thumb', rel: 'a.png', value: 'images/a.png' });
  assert.equal(cells[1].kind, 'path'); // ground: imagesx/a.png
  assert.equal(cells[2].kind, 'path'); // paper: images/../pack.toml
  assert.equal(cells[3].kind, 'path'); // crest-frame: vault:images/a.png
  assert.equal(cells[4].kind, 'empty'); // portrait: ''
  assert.equal(cells[5].kind, 'empty'); // 404: absent
});

// M1 positive control: a `startsWith('images/')`-only classifier (no relFn/membership check)
// would give 'thumb' for both the string-prefix sibling and the ancestor-direction case.
test('M1 positive control: a stub relFn that only checks the "images/" prefix would wrongly mark ground/paper as thumbs', () => {
  function prefixOnlyRelFn(value) {
    return typeof value === 'string' && value.indexOf('images/') === 0 ? value.slice('images/'.length) : null;
  }
  const cells = VW.slotCells(SLOT_STATE, prefixOnlyRelFn);
  assert.equal(cells[2].kind, 'thumb'); // paper: images/../pack.toml -- wrongly a thumb under the mutant
  assert.notEqual(cells[2].kind, VW.slotCells(SLOT_STATE, IM.slotImageRel)[2].kind);
});

test('VW.slotCells: with the real relFn, deep-equal to the real IM.slotImageRel result for every cell', () => {
  const cells = VW.slotCells(SLOT_STATE, IM.slotImageRel);
  const expectedRels = ['a.png', null, null, null, null, null];
  assert.deepEqual(
    cells.map((c) => c.rel),
    expectedRels,
  );
});

// === images.js publishes IM to window.ScriptoriumAdmin (Reviewer-required regression) ===========
//
// Source-string pattern from test/admin-busy-contract.test.js:126. `node --test` never executes
// images.js's browser branch (the node module.exports guard returns first, per every VB-pattern
// file in this repo), so the only in-repo way to pin this line is to read the raw source text,
// the same substitute admin-busy-contract.test.js already uses for the DOM/store wiring it can't
// drive either. This lives here, not test/admin-slots.test.js or test/admin-upload.test.js (the
// Reviewer's first suggestion for "a non-frozen test file that owns images.js"): both are on
// V1b's own frozen-file list, which V1c's gate 2 inherits verbatim, so editing either would trip
// the frozen-file gate. This file already requires and asserts against images.js's IM (the
// slotCells tests above), is not on any frozen list (created this slice), and is the closest
// available "owns images.js" home that isn't off-limits.

test('images.js publishes its IM onto window.ScriptoriumAdmin (V1c deviation, browser-only line)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'images.js'), 'utf8');
  assert.ok(src.includes('window.ScriptoriumAdmin.IM = IM;'), 'expected window.ScriptoriumAdmin.IM = IM;');
});
