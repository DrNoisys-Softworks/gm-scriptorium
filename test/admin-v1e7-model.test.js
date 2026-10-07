'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PV } = require('../assets/admin/sitepane');
const { VR } = require('../assets/admin/variants');

/*
 * V1e-7 (ADR 0039, SD-66, SD-67). Pure PV.variantSrc and VR table tests (no DOM), plus
 * structural source scans over the admin JS assets.
 */

const ADMIN_JS_DIR = path.join(__dirname, '..', 'assets', 'admin');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function panelJsFiles() {
  return fs
    .readdirSync(ADMIN_JS_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(ADMIN_JS_DIR, name));
}

// --- PV.variantSrc table -------------------------------------------------------------------------

test('PV.variantSrc: hosts', () => {
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'gloam', 'index.html'), 'http://127.0.0.1:5001/:variant/gloam/index.html');
  assert.equal(PV.variantSrc('localhost', 5001, 'gloam', 'index.html'), 'http://localhost:5001/:variant/gloam/index.html');
  assert.equal(PV.variantSrc('127.0.0.10', 5001, 'gloam', 'index.html'), null);
  assert.equal(PV.variantSrc('localhostx', 5001, 'gloam', 'index.html'), null);
  assert.equal(PV.variantSrc(null, 5001, 'gloam', 'index.html'), null);
});

test('PV.variantSrc: ports', () => {
  assert.equal(PV.variantSrc('127.0.0.1', 0, 'gloam', 'index.html'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 65536, 'gloam', 'index.html'), null);
  assert.equal(PV.variantSrc('127.0.0.1', '80', 'gloam', 'index.html'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 65535, 'gloam', 'index.html'), 'http://127.0.0.1:65535/:variant/gloam/index.html');
});

test('PV.variantSrc: ids', () => {
  assert.equal(PV.variantSrc('127.0.0.1', 5001, '', 'index.html'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'Gloam', 'index.html'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'a/b', 'index.html'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'a%2Fb', 'index.html'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'a:b', 'index.html'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, '..', 'index.html'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'plain', 'index.html'), 'http://127.0.0.1:5001/:variant/plain/index.html');
});

test('PV.variantSrc: rels, delegated entirely to frameSrc (the one host/port/rel validation)', () => {
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'gloam', '..'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'gloam', '/x'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'gloam', 'a\\b'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'gloam', 'a:b'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'gloam', '?'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'gloam', '#'), null);
  assert.equal(PV.variantSrc('127.0.0.1', 5001, 'gloam', 'a//b'), null);
  assert.equal(
    PV.variantSrc('127.0.0.1', 5001, 'gloam', 'people/a b.html'),
    'http://127.0.0.1:5001/:variant/gloam/people/a%20b.html',
  );
});

test('PV.variantSrc positive control: the exact literal example from the brief', () => {
  assert.equal(
    PV.variantSrc('127.0.0.1', 5001, 'gloam', 'people/a b.html'),
    'http://127.0.0.1:5001/:variant/gloam/people/a%20b.html',
  );
});

// --- VR tables -------------------------------------------------------------------------------

test('VR.stripState: all five states, exact copy literals (including the oldest-time rule and the counter-only words)', () => {
  const timeOf = (iso) => `T(${iso})`;

  // no-pack (Amendment A / DV-E76): takes priority, no matter what else is true.
  assert.deepEqual(VR.stripState(null, { active: false }, timeOf, false), {
    state: 'no-pack',
    text: 'Save a theme first; that creates pack.toml. Theme previews need it.',
  });

  // building.
  const round = { active: true, index: 2, total: 3, current: 'haze' };
  assert.deepEqual(VR.stripState(null, round, timeOf, true), {
    state: 'building',
    text: 'Building haze (2 of 3). The panel pauses while each one builds.',
  });

  // none: nothing built yet.
  const infoNone = { items: [{ id: 'plain', theme: 'plain', built: false }, { id: 'vocab', theme: null, built: false }] };
  assert.deepEqual(VR.stripState(infoNone, { active: false }, timeOf, true), {
    state: 'none',
    text: "Your own site, built once in each theme, shows on these cards. That's one build per theme, and the panel pauses while each one runs.",
  });

  // partial: some built, none stale, some missing.
  const infoPartial = {
    items: [
      { id: 'plain', theme: 'plain', built: true, builtAt: 'A', stale: false, savedSince: [] },
      { id: 'haze', theme: 'haze', built: false },
    ],
  };
  assert.deepEqual(VR.stripState(infoPartial, { active: false }, timeOf, true), {
    state: 'partial',
    text: "Some themes aren't built yet.",
  });

  // stale: the OLDEST built item's builtAt, and the union of savedSince.
  const infoStale = {
    items: [
      { id: 'plain', theme: 'plain', built: true, builtAt: '2026-01-01T00:00:00.000Z', stale: true, savedSince: ['pack.toml'] },
      {
        id: 'haze',
        theme: 'haze',
        built: true,
        builtAt: '2026-01-02T00:00:00.000Z',
        stale: true,
        savedSince: ['vault.config.json'],
      },
    ],
  };
  assert.deepEqual(VR.stripState(infoStale, { active: false }, timeOf, true), {
    state: 'stale',
    text: `Built ${timeOf('2026-01-01T00:00:00.000Z')}. Saved since: theme, images or words, the site title.`,
  });

  // stale with an empty savedSince union: COUNTER_ONLY_WORDS.
  const infoStaleCounterOnly = {
    items: [{ id: 'plain', theme: 'plain', built: true, builtAt: 'A', stale: true, savedSince: [] }],
  };
  assert.deepEqual(VR.stripState(infoStaleCounterOnly, { active: false }, timeOf, true), {
    state: 'stale',
    text: `Built ${timeOf('A')}. Saved since: ${VR.COUNTER_ONLY_WORDS}.`,
  });

  // ready: everything built, none stale, the NEWEST builtAt.
  const infoReady = {
    items: [
      { id: 'plain', theme: 'plain', built: true, builtAt: '2026-01-01T00:00:00.000Z', stale: false, savedSince: [] },
      { id: 'haze', theme: 'haze', built: true, builtAt: '2026-01-02T00:00:00.000Z', stale: false, savedSince: [] },
      { id: 'vocab', theme: null, built: false },
    ],
  };
  assert.deepEqual(VR.stripState(infoReady, { active: false }, timeOf, true), {
    state: 'ready',
    text: `Built ${timeOf('2026-01-02T00:00:00.000Z')} from everything saved, privately on this computer.`,
  });
});

test('VR.cardState', () => {
  const round = { active: true, current: 'haze' };
  assert.equal(VR.cardState({ built: false }, round, 'haze'), 'building');
  assert.equal(VR.cardState({ built: true, stale: false }, round, 'haze'), 'building', 'the round overrides built state for the currently-building card');
  assert.equal(VR.cardState(null, { active: false }, 'haze'), 'none');
  assert.equal(VR.cardState({ built: false }, { active: false }, 'haze'), 'none');
  assert.equal(VR.cardState({ built: true, stale: true }, { active: false }, 'haze'), 'stale');
  assert.equal(VR.cardState({ built: true, stale: false }, { active: false }, 'haze'), 'fresh');
});

test('VR.pageRel: an exact find, safe against constructor/__proto__ roles', () => {
  const item = { pages: [{ role: 'landing', rel: 'index.html' }, { role: 'character', rel: 'people/a.html' }] };
  assert.equal(VR.pageRel(item, 'landing'), 'index.html');
  assert.equal(VR.pageRel(item, 'timeline'), null);
  assert.equal(VR.pageRel(item, 'constructor'), null);
  assert.equal(VR.pageRel(item, '__proto__'), null);
  assert.equal(VR.pageRel(null, 'landing'), null);
  assert.equal(VR.pageRel({ pages: undefined }, 'landing'), null);
});

test('VR.roundErrorText', () => {
  assert.match(VR.roundErrorText({ kind: 'refused-check' }), /Check found errors in your vault/);
  assert.match(VR.roundErrorText({ kind: 'refused-scan' }), /leak check stopped a preview build/);
  assert.equal(VR.roundErrorText({ kind: 'busy', message: 'The panel is busy running another task.' }), 'The panel is busy running another task.');
  assert.equal(VR.roundErrorText(null), '');
});

test('VR.themeItems: items whose theme !== null', () => {
  const info = { items: [{ id: 'plain', theme: 'plain' }, { id: 'vocab', theme: null }] };
  assert.deepEqual(VR.themeItems(info).map((i) => i.id), ['plain']);
  assert.deepEqual(VR.themeItems(null), []);
  assert.deepEqual(VR.themeItems(undefined), []);
});

// --- SAVED_WORDS drift test against PV.freshnessLine's stale text, on the same inputs ----------

test('SAVED_WORDS drift: VR and PV map the same TRACKED_FILES name to the same words, independently', () => {
  const timeOf = () => 'T';
  for (const file of ['pack.toml', 'vault.config.json', 'vault-config.md']) {
    const pvInfo = { built: true, builtAt: 'A', stale: true, savedSince: [file], panelSavesSince: 0 };
    const pvText = PV.freshnessLine(pvInfo, [], timeOf).text;
    const pvWords = pvText.match(/Saved since: (.*)\.$/)[1];

    const vrInfo = { items: [{ id: 'plain', theme: 'plain', built: true, builtAt: 'A', stale: true, savedSince: [file] }] };
    const vrText = VR.stripState(vrInfo, { active: false }, timeOf, true).text;
    const vrWords = vrText.match(/Saved since: (.*)\.$/)[1];

    assert.equal(vrWords, pvWords, file);
  }
});

test('no em dash in any VR string literal', () => {
  const EM_DASH = '—';
  function walk(value, trail) {
    if (typeof value === 'string') {
      assert.ok(!value.includes(EM_DASH), `${trail}: contains an em dash`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${trail}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) walk(value[k], `${trail}.${k}`);
    }
  }
  walk(VR, 'VR');
  // Function-valued entries aren't walked above; run every function's observable string outputs
  // through the same check via the table tests already covering their literals.
});

// --- Structural -------------------------------------------------------------------------------

test('structural: createElement(\'iframe\') appears, on stripped source, exactly once across every admin JS asset, in sitepane.js only (positive control proves the scan works)', () => {
  const RE = /createElement\(\s*(['"])iframe\1\s*\)/g;
  let total = 0;
  const byFile = {};
  for (const f of panelJsFiles()) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const n = (src.match(RE) || []).length;
    if (n > 0) byFile[path.basename(f)] = n;
    total += n;
  }
  assert.deepEqual(byFile, { 'sitepane.js': 1 });
  assert.equal(total, 1);

  // Positive control.
  assert.match("document.createElement('iframe');", RE);
});

test('structural: variants.js has exactly one .disabled = store.isBusy() and one querySelectorAll(\'[data-role="variant-build"]\')', () => {
  const src = fs.readFileSync(path.join(ADMIN_JS_DIR, 'variants.js'), 'utf8');
  const disabledCount = (src.match(/\.disabled\s*=\s*store\.isBusy\(\)/g) || []).length;
  assert.equal(disabledCount, 1);
  const queryCount = (src.match(/querySelectorAll\(\s*'\[data-role="variant-build"\]'\s*\)/g) || []).length;
  assert.equal(queryCount, 1);
});

test('structural: variantBtn( occurs a measured number of times (its own definition plus every call site)', () => {
  const src = fs.readFileSync(path.join(ADMIN_JS_DIR, 'variants.js'), 'utf8');
  const count = (src.match(/\bvariantBtn\(/g) || []).length;
  // Measured, not derived from reading the function's own behaviour: the definition
  // (`function variantBtn(opts) {`) plus the strip's Build button, plus two more call sites
  // V1e-8 (ADR 0039 addendum, SD-72) adds in the same file (vocabExample's "Build preview" and
  // "Update example" buttons) -- 4 in all. V1e-7's own brief anticipated this file gaining a
  // second slice's worth of call sites here (SD-67: "No /api/ literal other than
  // /api/variants/theme (and /api/variants/vocab in V1e-8)"), so this re-measurement is expected,
  // not a regression of the V1e-7 freeze.
  assert.equal(count, 4);
});

test('structural: no /api/ literal other than /api/variants/theme or /api/variants/vocab anywhere in variants.js', () => {
  const src = fs.readFileSync(path.join(ADMIN_JS_DIR, 'variants.js'), 'utf8');
  const literals = [...src.matchAll(/\/api\/[a-zA-Z0-9/_-]*/g)].map((m) => m[0]);
  assert.ok(literals.length > 0, 'expected to find /api/variants/theme at least once');
  // V1e-8 (ADR 0039 addendum, SD-72) adds /api/variants/vocab to this same file -- the V1e-7
  // brief's own SD-67 text named this exact pair as expected ("No /api/ literal other than
  // /api/variants/theme (and /api/variants/vocab in V1e-8)"), so widening the allowlist here is
  // not a regression of the V1e-7 freeze.
  const ALLOWED = ['/api/variants/theme', '/api/variants/vocab'];
  for (const literal of literals) {
    assert.ok(ALLOWED.includes(literal), literal);
  }
});

test('structural: no fetch( in variants.js', () => {
  const src = fs.readFileSync(path.join(ADMIN_JS_DIR, 'variants.js'), 'utf8');
  assert.ok(!src.includes('fetch('));
});
