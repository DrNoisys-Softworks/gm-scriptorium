'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { ST } = require(path.join(__dirname, '..', 'assets', 'admin', 'store.js'));

/*
 * V1b SD-3/interfaces (ST additions). Pure, loaded via require(). Independent literals
 * throughout.
 */

const VALID_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

// -- fileShas --------------------------------------------------------------------------------

test('fileShas: both files exist, both shas present', () => {
  const body = { packToml: { exists: true, sha256: VALID_SHA }, vaultConfigJson: { exists: true, sha256: OTHER_SHA } };
  assert.deepEqual(ST.fileShas(body), { 'pack.toml': VALID_SHA, 'vault.config.json': OTHER_SHA });
});

test('fileShas: a missing file gives null for that key', () => {
  const body = { packToml: { exists: false, sha256: null }, vaultConfigJson: { exists: true, sha256: OTHER_SHA } };
  assert.deepEqual(ST.fileShas(body), { 'pack.toml': null, 'vault.config.json': OTHER_SHA });
});

test('fileShas: tolerates missing fields entirely (no packToml/vaultConfigJson keys at all)', () => {
  assert.deepEqual(ST.fileShas({}), { 'pack.toml': null, 'vault.config.json': null });
});

// -- isFullState -----------------------------------------------------------------------------

test('isFullState: true when the body has both an own vocab and an own palette key', () => {
  assert.equal(ST.isFullState({ vocab: {}, palette: {} }), true);
});

test('isFullState: false when vocab is missing', () => {
  assert.equal(ST.isFullState({ palette: {} }), false);
});

test('isFullState: false when palette is missing', () => {
  assert.equal(ST.isFullState({ vocab: {} }), false);
});

test('isFullState: false for null/undefined', () => {
  assert.equal(ST.isFullState(null), false);
  assert.equal(ST.isFullState(undefined), false);
});

test('isFullState: false when vocab/palette are present only on the prototype, not as own properties', () => {
  const proto = { vocab: {}, palette: {} };
  const body = Object.create(proto);
  assert.equal(ST.isFullState(body), false);
});

// -- statePatch --------------------------------------------------------------------------------

test('statePatch: a full body gives {state, files}', () => {
  const body = { vocab: {}, palette: {}, packToml: { exists: true, sha256: VALID_SHA }, vaultConfigJson: { exists: false, sha256: null } };
  assert.deepEqual(ST.statePatch(body), { state: body, files: { 'pack.toml': VALID_SHA, 'vault.config.json': null } });
});

test('statePatch: a partial body (legacy views.js reload, no vocab/palette) gives null', () => {
  assert.equal(ST.statePatch({ packToml: {}, vaultConfigJson: {} }), null);
});

// -- applySaveResult -------------------------------------------------------------------------

test('applySaveResult: ok:true, file "pack.toml", a valid sha -- sets that key, new object', () => {
  const files = { 'pack.toml': OTHER_SHA, 'vault.config.json': null };
  const next = ST.applySaveResult(files, { ok: true, file: 'pack.toml', sha256: VALID_SHA });
  assert.deepEqual(next, { 'pack.toml': VALID_SHA, 'vault.config.json': null });
  assert.notEqual(next, files);
  assert.equal(files['pack.toml'], OTHER_SHA, 'the input object must not be mutated');
});

test('applySaveResult: ok:true, file "vault.config.json", a valid sha -- sets that key', () => {
  const files = { 'pack.toml': null, 'vault.config.json': null };
  const next = ST.applySaveResult(files, { ok: true, file: 'vault.config.json', sha256: VALID_SHA });
  assert.deepEqual(next, { 'pack.toml': null, 'vault.config.json': VALID_SHA });
});

test('applySaveResult: ok:false -- unchanged copy', () => {
  const files = { 'pack.toml': OTHER_SHA, 'vault.config.json': null };
  const next = ST.applySaveResult(files, { ok: false, file: 'pack.toml', sha256: VALID_SHA });
  assert.deepEqual(next, files);
  assert.notEqual(next, files);
});

test('applySaveResult: a non-exact file name ("../pack.toml", an ancestor-direction shape) -- unchanged copy', () => {
  const files = { 'pack.toml': OTHER_SHA, 'vault.config.json': null };
  const next = ST.applySaveResult(files, { ok: true, file: '../pack.toml', sha256: VALID_SHA });
  assert.deepEqual(next, files);
});

test('applySaveResult: a file name that is a string-prefix sibling ("pack.tomlx") -- unchanged copy', () => {
  const files = { 'pack.toml': OTHER_SHA, 'vault.config.json': null };
  const next = ST.applySaveResult(files, { ok: true, file: 'pack.tomlx', sha256: VALID_SHA });
  assert.deepEqual(next, files);
});

test('applySaveResult: a sha of the wrong length -- unchanged copy', () => {
  const files = { 'pack.toml': OTHER_SHA, 'vault.config.json': null };
  const next = ST.applySaveResult(files, { ok: true, file: 'pack.toml', sha256: 'a'.repeat(63) });
  assert.deepEqual(next, files);
});

test('applySaveResult: a sha with an uppercase or non-hex character -- unchanged copy', () => {
  const files = { 'pack.toml': OTHER_SHA, 'vault.config.json': null };
  const next = ST.applySaveResult(files, { ok: true, file: 'pack.toml', sha256: 'A'.repeat(64) });
  assert.deepEqual(next, files);
  const next2 = ST.applySaveResult(files, { ok: true, file: 'pack.toml', sha256: 'g'.repeat(64) });
  assert.deepEqual(next2, files);
});

test('applySaveResult: positive control -- a well-formed result really does change the copy', () => {
  const files = { 'pack.toml': null, 'vault.config.json': null };
  const next = ST.applySaveResult(files, { ok: true, file: 'pack.toml', sha256: VALID_SHA });
  assert.notDeepEqual(next, files);
});

// -- withPending -----------------------------------------------------------------------------

test('withPending: n > 0 sets the key, new object', () => {
  const pending = { theme: 1 };
  const next = ST.withPending(pending, 'vocab', 3);
  assert.deepEqual(next, { theme: 1, vocab: 3 });
  assert.notEqual(next, pending);
});

test('withPending: n <= 0 deletes the key', () => {
  const pending = { theme: 1, vocab: 3 };
  assert.deepEqual(ST.withPending(pending, 'vocab', 0), { theme: 1 });
  assert.deepEqual(ST.withPending(pending, 'vocab', -1), { theme: 1 });
});

test('withPending: deleting an absent key is a no-op copy', () => {
  const pending = { theme: 1 };
  assert.deepEqual(ST.withPending(pending, 'vocab', 0), { theme: 1 });
});

// -- pendingTotal ----------------------------------------------------------------------------

test('pendingTotal: sums every value', () => {
  assert.equal(ST.pendingTotal({ theme: 1, vocab: 3, images: 2 }), 6);
});

test('pendingTotal: empty object gives 0', () => {
  assert.equal(ST.pendingTotal({}), 0);
});

// -- isBusy (SD-8, the busy contract) ---------------------------------------------------------

test('isBusy: null (nothing running) gives false', () => {
  assert.equal(ST.isBusy(null), false);
});

test('isBusy: any non-null label gives true', () => {
  assert.equal(ST.isBusy('check'), true);
  assert.equal(ST.isBusy('build'), true);
  assert.equal(ST.isBusy('write'), true);
});

test('isBusy: positive control -- undefined is not null, so it is treated as busy too (only null means idle)', () => {
  assert.equal(ST.isBusy(undefined), true);
});
