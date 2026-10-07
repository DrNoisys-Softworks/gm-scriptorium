'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VOCAB_JS_PATH = path.join(__dirname, '..', 'assets', 'admin', 'vocab.js');

/*
 * Reviewer rework item 1 (AC-04/FR-13): a real defect found in the live UI. vocab.js's
 * buildForm() captured `baseSha256` once, at render time (`vocabToml.exists ?
 * vocabToml.sha256 : null`), and the "Review and save" click handler's dry-run body sent that
 * stale closure value. SD-7 deliberately never re-renders a screen with pending edits, so a
 * vocab edit left pending while another screen (Theme, Title, or a slot) saved successfully
 * left vocab.js's captured sha permanently stale -- the very next vocab save got a spurious 409
 * "pack.toml changed outside the panel" instead of the 200 AC-04 requires. This is also exactly
 * the "per-module sha capture" ADR 0022 (`docs/decisions/0022-gm-admin-panel.md`) already lists
 * as a rejected alternative -- vocab.js was accidentally doing the rejected thing.
 *
 * `node --test` cannot drive the real DOM re-render/pending sequence this bug depends on (that
 * needs a live browser -- see the Playwright replay in the QA gate record). This is the
 * strongest in-repo substitute: a structural scan proving the dry-run body construction reads
 * the base sha live, through `store.baseSha('pack.toml')`, at save-click time, the same way
 * pack.js's and images.js's own dry bodies already do (`store.baseSha('pack.toml')`,
 * `store.baseSha('vault.config.json')`) -- never from a pre-captured variable.
 */

function vocabSource() {
  return fs.readFileSync(VOCAB_JS_PATH, 'utf8');
}

test('vocab.js: the dry-run body reads the base sha live via store.baseSha(\'pack.toml\'), not a captured variable', () => {
  const src = vocabSource();
  const dryBodyLine = src.split('\n').find((line) => line.includes('var dryBody = Object.assign({}, payload,'));
  assert.ok(dryBodyLine, 'expected to find the vocab dry-run body construction line in vocab.js');
  assert.ok(
    dryBodyLine.includes("store.baseSha('pack.toml')"),
    `dry-run body line must call store.baseSha('pack.toml') live, got: ${dryBodyLine}`,
  );
});

test('vocab.js: never reintroduces a render-time-captured baseSha256 variable (the rejected-alternative pattern)', () => {
  const src = vocabSource();
  // The exact old, buggy line this regression guards against.
  assert.ok(
    !src.includes('var baseSha256 = vocabToml.exists ? vocabToml.sha256 : null;'),
    'vocab.js must not capture baseSha256 from state at render time (ADR 0022\'s rejected "per-module sha capture")',
  );
  // Broader guard: no bare `baseSha256: baseSha256` (a captured-variable reference) anywhere in
  // the file -- the only sanctioned shape is `baseSha256: store.baseSha(...)`.
  assert.ok(!/baseSha256:\s*baseSha256\b/.test(src), 'vocab.js must never send a captured baseSha256 variable in a request body');
});

test('positive control: pack.js and images.js already read the base sha live (so the pattern above is real, not a fluke of this file alone)', () => {
  const packSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'pack.js'), 'utf8');
  const imagesSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'images.js'), 'utf8');
  assert.ok(packSrc.includes("store.baseSha('pack.toml')"));
  assert.ok(packSrc.includes("store.baseSha('vault.config.json')"));
  assert.ok(imagesSrc.includes("store.baseSha('pack.toml')"));
});
