'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { SL } = require(path.join(__dirname, '..', 'assets', 'admin', 'slip.js'));

/*
 * V1b SD-4/SD-5/SD-6/interfaces (SL, the pure half of the save review slip). Loaded via
 * require(). Independent literals throughout. Rows are documented as an Engineer-interpreted
 * residual where the Engineering Brief names a behaviour ("added, removed, or changed with the
 * changed field names") without pinning its exact display text -- see the comment on kindsRows
 * in slip.js.
 */

const THEMES = [
  { name: 'plain', scheme: 'dark' },
  { name: 'haze', scheme: 'light' },
];

// === schemeMismatch ==============================================================================

test('schemeMismatch: haze (light-scheme theme) with a dark palette -- non-null, exact fields', () => {
  const result = SL.schemeMismatch('haze', THEMES, { scheme: 'dark', background: '#1a1a1a', error: null });
  assert.deepEqual(result, { theme: 'haze', themeScheme: 'light', paletteScheme: 'dark', background: '#1a1a1a' });
});

test('schemeMismatch: mismatched schemes are non-null', () => {
  const result = SL.schemeMismatch('plain', THEMES, { scheme: 'light', background: '#f5f0e6', error: null });
  assert.deepEqual(result, { theme: 'plain', themeScheme: 'dark', paletteScheme: 'light', background: '#f5f0e6' });
});

test('schemeMismatch: matching schemes -- null', () => {
  assert.equal(SL.schemeMismatch('haze', THEMES, { scheme: 'light', background: '#f5f0e6', error: null }), null);
});

test('schemeMismatch: a palette error -- null even if schemes would otherwise differ', () => {
  assert.equal(SL.schemeMismatch('plain', THEMES, { scheme: 'light', background: null, error: 'boom' }), null);
});

test('schemeMismatch: a null palette scheme (genre preset) -- null', () => {
  assert.equal(SL.schemeMismatch('haze', THEMES, { scheme: null, background: null, error: null }), null);
});

test('schemeMismatch: an unknown theme name -- null (array-find, not a string-prefix match)', () => {
  assert.equal(SL.schemeMismatch('hazee', THEMES, { scheme: 'light', background: '#f5f0e6', error: null }), null);
});

test('schemeMismatch: positive control -- the exact-name theme really is found', () => {
  assert.notEqual(SL.schemeMismatch('plain', THEMES, { scheme: 'light', background: '#fff', error: null }), null);
});

// === ADR 0032, Structural decision 2: PALETTE_OWNING_THEMES ======================================

test('SL.PALETTE_OWNING_THEMES is exactly ["gloam"]', () => {
  assert.deepEqual(SL.PALETTE_OWNING_THEMES, ['gloam']);
});

const THEMES_WITH_GLOAM = [
  { name: 'plain', scheme: 'dark' },
  { name: 'haze', scheme: 'light' },
  { name: 'gloam', scheme: 'dark' },
];

test('schemeMismatch: gloam is null even on a mismatched palette (the theme owns the palette)', () => {
  assert.equal(SL.schemeMismatch('gloam', THEMES_WITH_GLOAM, { scheme: 'light', background: '#f5f0e6', error: null }), null);
});

test('schemeMismatch: GM23 control -- a non-owning theme with the identical mismatch is still non-null', () => {
  assert.notEqual(SL.schemeMismatch('haze', THEMES_WITH_GLOAM, { scheme: 'dark', background: '#1a1a1a', error: null }), null);
});

// === confirmBody ==================================================================================

test('confirmBody: deletes dryRun, keeps key order', () => {
  const dryBody = { theme: 'haze', baseSha256: 'x', dryRun: true };
  const confirmed = SL.confirmBody(dryBody);
  assert.deepEqual(confirmed, { theme: 'haze', baseSha256: 'x' });
  assert.deepEqual(Object.keys(confirmed), ['theme', 'baseSha256']);
});

test('confirmBody: M12 guard -- never leaves dryRun:false in place of removing the key', () => {
  const confirmed = SL.confirmBody({ theme: 'haze', baseSha256: 'x', dryRun: true });
  assert.ok(!Object.prototype.hasOwnProperty.call(confirmed, 'dryRun'));
});

test('confirmBody: a body with no dryRun key at all is copied unchanged', () => {
  const dryBody = { slots: { hero: 'images/a.png' }, baseSha256: 'x' };
  assert.deepEqual(SL.confirmBody(dryBody), dryBody);
});

test('confirmBody: does not mutate its input', () => {
  const dryBody = { theme: 'haze', baseSha256: 'x', dryRun: true };
  SL.confirmBody(dryBody);
  assert.equal(dryBody.dryRun, true);
});

// === buildSlip: shape, title, filePath, saveLabel, foot =========================================

function themeArgs(overrides) {
  return Object.assign(
    {
      kind: 'theme',
      payload: { theme: 'haze' },
      state: { packToml: { theme: 'plain', exists: true }, themes: THEMES, palette: { scheme: 'dark', background: '#111', error: null } },
      dry: { ok: true, dryRun: true, file: 'pack.toml', before: 'theme = "plain"\n', after: 'theme = "haze"\n', commentsLost: false, warnings: [] },
    },
    overrides,
  );
}

test('buildSlip: eyebrow, title, filePath, saveLabel -- theme kind', () => {
  const slip = SL.buildSlip(themeArgs());
  assert.equal(slip.eyebrow, 'Review before saving');
  assert.equal(slip.title, 'Save theme');
  assert.equal(slip.filePath, '_meta/scriptorium/pack.toml');
  assert.equal(slip.saveLabel, 'Save pack.toml');
});

test('buildSlip: titles for the other three kinds', () => {
  assert.equal(SL.buildSlip(Object.assign(themeArgs(), { kind: 'settings', dry: { ok: true, dryRun: true, file: 'vault.config.json', before: '{}', after: '{}', commentsLost: false, warnings: [] } })).title, 'Save title and tagline');
  assert.equal(SL.buildSlip(Object.assign(themeArgs(), { kind: 'vocab' })).title, 'Save vocabulary');
  assert.equal(SL.buildSlip(Object.assign(themeArgs(), { kind: 'slots' })).title, 'Save image choices');
});

test('buildSlip: filePath/saveLabel for vault.config.json (chosen by exact equality on dry.file)', () => {
  const slip = SL.buildSlip(
    Object.assign(themeArgs(), {
      kind: 'settings',
      dry: { ok: true, dryRun: true, file: 'vault.config.json', before: '{}', after: '{}', commentsLost: false, warnings: [] },
    }),
  );
  assert.equal(slip.filePath, '_meta/scriptorium/vault.config.json');
  assert.equal(slip.saveLabel, 'Save vault.config.json');
});

test('buildSlip: the foot is the fixed sentence', () => {
  const slip = SL.buildSlip(themeArgs());
  assert.equal(slip.foot, 'Saving writes this one file and never publishes. The panel never commits.');
});

test('buildSlip: diff is DF over dry.before and dry.after', () => {
  const slip = SL.buildSlip(themeArgs());
  assert.equal(slip.diff.tooLarge, false);
  assert.deepEqual(slip.diff.ops, [
    { t: '-', o: 1, s: 'theme = "plain"' },
    { t: '+', n: 1, s: 'theme = "haze"' },
  ]);
});

// === Effects (a)-(g), if-and-only-if ============================================================

test('(c) creates: iff dry.before === null', () => {
  const withNull = SL.buildSlip(Object.assign(themeArgs(), { dry: Object.assign({}, themeArgs().dry, { before: null }) }));
  assert.ok(withNull.effects.some((e) => e.id === 'creates' && e.text === "pack.toml doesn't exist yet; saving creates it."));
  const withoutNull = SL.buildSlip(themeArgs());
  assert.ok(!withoutNull.effects.some((e) => e.id === 'creates'));
});

test('(f) no-change: iff before === after', () => {
  const same = SL.buildSlip(Object.assign(themeArgs(), { dry: Object.assign({}, themeArgs().dry, { after: themeArgs().dry.before }) }));
  assert.ok(same.effects.some((e) => e.id === 'no-change' && e.text === 'Nothing in the file changes.'));
  const different = SL.buildSlip(themeArgs());
  assert.ok(!different.effects.some((e) => e.id === 'no-change'));
});

test('(g) format-only: iff no rows, before !== null and before !== after', () => {
  // Theme kind always produces exactly one row, so format-only never fires for it. Use a
  // settings save where the sent values equal the on-disk ones (no rows) but the raw bytes
  // differ (a pure reformat).
  const args = {
    kind: 'settings',
    payload: { siteTitle: 'Alpha' },
    state: { vaultConfigJson: { siteTitle: 'Alpha' } },
    dry: { ok: true, dryRun: true, file: 'vault.config.json', before: '{"siteTitle":"Alpha"}', after: '{\n  "siteTitle": "Alpha"\n}', commentsLost: false, warnings: [] },
  };
  const reformatted = SL.buildSlip(args);
  assert.deepEqual(reformatted.rows, []);
  assert.ok(reformatted.effects.some((e) => e.id === 'format-only' && e.text === 'No setting changes; saving only reformats the file.'));

  // Negative: before === null (creates) must not also claim format-only.
  const created = SL.buildSlip(Object.assign({}, args, { dry: Object.assign({}, args.dry, { before: null }) }));
  assert.ok(!created.effects.some((e) => e.id === 'format-only'));

  // Negative: before === after must not also claim format-only.
  const unchanged = SL.buildSlip(Object.assign({}, args, { dry: Object.assign({}, args.dry, { after: args.dry.before }) }));
  assert.ok(!unchanged.effects.some((e) => e.id === 'format-only'));

  // Negative: real rows present (a genuine settings change) must not claim format-only.
  const changed = SL.buildSlip(Object.assign({}, args, { payload: { siteTitle: 'Beta' } }));
  assert.ok(!changed.effects.some((e) => e.id === 'format-only'));
});

test('(d) warning: one per entry in dry.warnings, verbatim', () => {
  const args = Object.assign(themeArgs(), { dry: Object.assign({}, themeArgs().dry, { warnings: ['weights: 3 values expected, got 2'] }) });
  const slip = SL.buildSlip(args);
  const warnings = slip.effects.filter((e) => e.id === 'warning');
  assert.deepEqual(warnings.map((e) => e.text), ['weights: 3 values expected, got 2']);

  const none = SL.buildSlip(themeArgs());
  assert.deepEqual(none.effects.filter((e) => e.id === 'warning'), []);
});

test('comments-lost: iff dry.commentsLost === true (M7 guard: undefined must not trigger it)', () => {
  const lost = SL.buildSlip(Object.assign(themeArgs(), { dry: Object.assign({}, themeArgs().dry, { commentsLost: true }) }));
  assert.ok(lost.effects.some((e) => e.id === 'comments-lost' && e.text === 'Saving will remove the comments in the current file.'));

  const notLost = SL.buildSlip(themeArgs());
  assert.ok(!notLost.effects.some((e) => e.id === 'comments-lost'));

  const undefinedCase = SL.buildSlip(Object.assign(themeArgs(), { dry: Object.assign({}, themeArgs().dry, { commentsLost: undefined }) }));
  assert.ok(!undefinedCase.effects.some((e) => e.id === 'comments-lost'));
});

test('comments-lost also fires on a slots save', () => {
  const args = {
    kind: 'slots',
    payload: { slots: { hero: null } },
    state: { packToml: { images: { hero: 'images/a.png' } } },
    dry: { ok: true, dryRun: true, file: 'pack.toml', before: '[images]\nhero = "images/a.png"\n', after: '', commentsLost: true, warnings: [] },
  };
  const slip = SL.buildSlip(args);
  assert.ok(slip.effects.some((e) => e.id === 'comments-lost'));
});

// -- (b) kinds effects, plus "no kinds in the payload gives none" ------------------------------

function vocabArgsWithKinds(timelinePayload, onDiskKinds) {
  return {
    kind: 'vocab',
    payload: { timeline: timelinePayload },
    state: {
      vocab: {
        exists: true,
        tables: { labels: {}, timeline: { kinds: onDiskKinds }, recaps: {} },
        error: null,
        defaults: { labels: {}, timeline: { kinds: [], weights: [], columns: {} }, recaps: {} },
      },
    },
    dry: { ok: true, dryRun: true, file: 'pack.toml', before: 'x', after: 'y', commentsLost: false, warnings: [] },
  };
}

test('kinds-written: iff payload kinds is an array and there were no kinds on disk', () => {
  const slip = SL.buildSlip(vocabArgsWithKinds({ kinds: [{ key: 'omen' }, { key: 'fight' }] }, null));
  assert.ok(slip.effects.some((e) => e.id === 'kinds-written' && e.text === 'All 2 kinds are written into pack.toml, including unchanged ones.'));
});

test('kinds-removed: iff payload kinds is null', () => {
  const slip = SL.buildSlip(vocabArgsWithKinds({ kinds: null }, [{ key: 'fight' }]));
  assert.ok(slip.effects.some((e) => e.id === 'kinds-removed' && e.text === 'Kinds removed; the built-in set applies.'));
});

test('kinds-replaced: iff payload kinds is an array and kinds were on disk', () => {
  const slip = SL.buildSlip(vocabArgsWithKinds({ kinds: [{ key: 'fight' }] }, [{ key: 'fight' }]));
  assert.ok(slip.effects.some((e) => e.id === 'kinds-replaced' && e.text === 'The kinds list is replaced as a whole.'));
});

test('no kinds in the payload gives none of the three kinds effects', () => {
  const slip = SL.buildSlip(vocabArgsWithKinds({ weights: ['1', '2', '3'] }, [{ key: 'fight' }]));
  assert.ok(!slip.effects.some((e) => ['kinds-written', 'kinds-removed', 'kinds-replaced'].includes(e.id)));
});

// -- (e) scheme-mismatch --------------------------------------------------------------------------

test('scheme-mismatch: iff a theme save and schemeMismatch is non-null', () => {
  const args = themeArgs({
    state: { packToml: { theme: 'plain', exists: true }, themes: THEMES, palette: { scheme: 'dark', background: '#111111', error: null } },
  });
  const slip = SL.buildSlip(args);
  assert.ok(
    slip.effects.some(
      (e) =>
        e.id === 'scheme-mismatch' &&
        e.text === 'Check will report config/theme-scheme-mismatch (info): your palette background #111111 is dark and haze is light.',
    ),
  );
});

test('scheme-mismatch: absent when schemes match', () => {
  const slip = SL.buildSlip(
    themeArgs({ state: { packToml: { theme: 'plain', exists: true }, themes: THEMES, palette: { scheme: 'light', background: '#f5f0e6', error: null } } }),
  );
  assert.ok(!slip.effects.some((e) => e.id === 'scheme-mismatch'));
});

test('scheme-mismatch: never fires for a non-theme kind', () => {
  const args = Object.assign(vocabArgsWithKinds({ weights: ['1'] }, null), {
    state: Object.assign(vocabArgsWithKinds({}, null).state, { themes: THEMES, palette: { scheme: 'light', background: '#fff', error: null }, packToml: { theme: 'plain' } }),
  });
  const slip = SL.buildSlip(args);
  assert.ok(!slip.effects.some((e) => e.id === 'scheme-mismatch'));
});

// -- (a) true/false/undefined for the boolean-flavoured effects, including a slots save --------

test('(a) creates/no-change/format-only/comments-lost each behave correctly on a slots save', () => {
  const clearing = {
    kind: 'slots',
    payload: { slots: { hero: null } },
    state: { packToml: { images: { hero: 'images/a.png' } } },
    dry: { ok: true, dryRun: true, file: 'pack.toml', before: null, after: '[images]\n', commentsLost: false, warnings: [] },
  };
  const slip = SL.buildSlip(clearing);
  assert.ok(slip.effects.some((e) => e.id === 'creates'));
  assert.ok(!slip.effects.some((e) => e.id === 'no-change'));
});

// -- slot-size effects (D-10 (c)) ----------------------------------------------------------------

test('slot-size: effects come from advice[], in order, verbatim', () => {
  const args = {
    kind: 'slots',
    payload: { slots: { hero: 'images/a.png' } },
    state: { packToml: { images: {} } },
    dry: { ok: true, dryRun: true, file: 'pack.toml', before: null, after: '[images]\n', commentsLost: false, warnings: [] },
    advice: [
      { level: 'info', text: 'Measured 1200 x 800 px; recommended convention 2400 x 1350 px (16:9).' },
      { level: 'warn', text: 'Smaller than the recommended size; it may look soft when enlarged.' },
    ],
  };
  const slip = SL.buildSlip(args);
  const slotSize = slip.effects.filter((e) => e.id === 'slot-size');
  assert.deepEqual(slotSize.map((e) => ({ level: e.level, text: e.text })), args.advice);
});

// === Rows =========================================================================================

test('rows: theme -- one row, nowNote/afterNote are the scheme or "no scheme"', () => {
  const slip = SL.buildSlip(themeArgs());
  assert.deepEqual(slip.rows, [{ where: 'Theme', key: 'theme', now: 'plain', nowNote: 'dark', after: 'haze', afterNote: 'light' }]);
});

test('rows: theme -- an unknown theme name notes "no scheme"', () => {
  const args = themeArgs({ payload: { theme: 'unknown-theme' } });
  const slip = SL.buildSlip(args);
  assert.equal(slip.rows[0].afterNote, 'no scheme');
});

test('rows: settings -- a row per sent key that differs from state; null counts as \'\'', () => {
  const args = {
    kind: 'settings',
    payload: { siteTitle: 'New title' },
    state: { vaultConfigJson: { siteTitle: 'Old title' } },
    dry: { ok: true, dryRun: true, file: 'vault.config.json', before: '{}', after: '{}', commentsLost: false, warnings: [] },
  };
  const slip = SL.buildSlip(args);
  assert.deepEqual(slip.rows, [{ where: 'Settings', key: 'siteTitle', now: 'Old title', nowNote: undefined, after: 'New title', afterNote: undefined }]);
});

test('rows: settings -- an unchanged key never gets a row', () => {
  const args = {
    kind: 'settings',
    payload: { siteTitle: 'Same' },
    state: { vaultConfigJson: { siteTitle: 'Same' } },
    dry: { ok: true, dryRun: true, file: 'vault.config.json', before: '{}', after: '{}', commentsLost: false, warnings: [] },
  };
  assert.deepEqual(SL.buildSlip(args).rows, []);
});

test('rows: slots -- "now" is the current value or "not set"; "after" is the value or "cleared"', () => {
  const setting = {
    kind: 'slots',
    payload: { slots: { hero: 'images/a.png' } },
    state: { packToml: { images: {} } },
    dry: { ok: true, dryRun: true, file: 'pack.toml', before: null, after: '[images]\n', commentsLost: false, warnings: [] },
  };
  assert.deepEqual(SL.buildSlip(setting).rows, [{ where: 'Landing banner', key: 'hero', now: 'not set', nowNote: undefined, after: 'images/a.png', afterNote: undefined }]);

  const clearing = {
    kind: 'slots',
    payload: { slots: { hero: null } },
    state: { packToml: { images: { hero: 'images/a.png' } } },
    dry: { ok: true, dryRun: true, file: 'pack.toml', before: '[images]\nhero = "images/a.png"\n', after: '', commentsLost: false, warnings: [] },
  };
  assert.deepEqual(SL.buildSlip(clearing).rows, [{ where: 'Landing banner', key: 'hero', now: 'images/a.png', nowNote: undefined, after: 'cleared', afterNote: undefined }]);
});

test('rows: vocab labels -- on-disk vs default, cleared vs default, arrays joined with ", "', () => {
  const args = {
    kind: 'vocab',
    payload: { labels: { chapter: 'Chapter', story_lens: null } },
    state: {
      vocab: {
        exists: true,
        tables: { labels: { chapter: 'Old chapter' }, timeline: {}, recaps: {} },
        error: null,
        defaults: { labels: { chapter: 'Chapter (default)', story_lens: 'Story lens (default)' }, timeline: { columns: {} }, recaps: {} },
      },
    },
    dry: { ok: true, dryRun: true, file: 'pack.toml', before: 'x', after: 'y', commentsLost: false, warnings: [] },
  };
  const rows = SL.buildSlip(args).rows;
  assert.deepEqual(rows.find((r) => r.key === 'chapter'), { where: 'Labels', key: 'chapter', now: 'Old chapter', nowNote: undefined, after: 'Chapter', afterNote: undefined });
  assert.deepEqual(rows.find((r) => r.key === 'story_lens'), {
    where: 'Labels',
    key: 'story_lens',
    now: 'Story lens (default)',
    nowNote: 'default',
    after: 'Story lens (default)',
    afterNote: 'default',
  });
});

test('rows: vocab columns -- a row per changed column key, arrays joined with ", "', () => {
  const args = {
    kind: 'vocab',
    payload: { timeline: { columns: { title: ['Title'] } } },
    state: {
      vocab: {
        exists: true,
        tables: { labels: {}, timeline: { columns: { title: ['Old title', 'Alt'] } }, recaps: {} },
        error: null,
        defaults: { labels: {}, timeline: { columns: { title: ['Default title'] } } , recaps: {} },
      },
    },
    dry: { ok: true, dryRun: true, file: 'pack.toml', before: 'x', after: 'y', commentsLost: false, warnings: [] },
  };
  const rows = SL.buildSlip(args).rows;
  assert.deepEqual(rows, [{ where: 'Timeline columns', key: 'title', now: 'Old title, Alt', nowNote: undefined, after: 'Title', afterNote: undefined }]);
});
