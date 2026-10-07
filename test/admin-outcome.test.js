'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { OC } = require(path.join(__dirname, '..', 'assets', 'admin', 'outcome.js'));

/*
 * V1b SD-4/interfaces (OC). Pure, loaded via require(). Every row of the Engineering Brief's
 * outcome table, plus the two named edge cases (busy:'constructor', 409 with an unknown error).
 * Independent literals throughout.
 */

test('BUSY_LABEL is the exact 3-entry literal', () => {
  assert.deepEqual(OC.BUSY_LABEL, { check: 'a check', build: 'a preview build', write: 'another save' });
});

// -- ready / saved (200 with body.ok, distinguished by phase) ----------------------------------

test('ready: a dry run, 200 with body.ok, role:"status"', () => {
  const outcome = OC.mapOutcome({ ok: true, status: 200, body: { ok: true, dryRun: true } }, 'dry');
  assert.equal(outcome.kind, 'ready');
  assert.equal(outcome.role, 'status');
});

test('saved: a save, 200 with body.ok, message "Saved", role:"status", offers build-preview/overview', () => {
  const outcome = OC.mapOutcome({ ok: true, status: 200, body: { ok: true } }, 'save');
  assert.equal(outcome.kind, 'saved');
  assert.equal(outcome.role, 'status');
  assert.equal(outcome.message, 'Saved');
  assert.deepEqual(outcome.actions, ['build-preview', 'overview']);
});

// -- changed -------------------------------------------------------------------------------------

test('changed: 409 error:"changed" -- message verbatim, detail names discarded edits, keep-editing/reload, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 409, body: { error: 'changed', message: 'pack.toml changed outside the panel. Reload before saving.' } }, 'save');
  assert.equal(outcome.kind, 'changed');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'pack.toml changed outside the panel. Reload before saving.');
  assert.equal(outcome.detail, "Reloading discards this page's edits.");
  assert.deepEqual(outcome.actions, ['keep-editing', 'reload']);
});

// -- busy ----------------------------------------------------------------------------------------

test('busy: 409 error:"busy" -- message names the BUSY_LABEL for the phase, keep-editing only, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 409, body: { error: 'busy', busy: 'build' } }, 'save');
  assert.equal(outcome.kind, 'busy');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'The panel is busy running a preview build.');
  assert.deepEqual(outcome.actions, ['keep-editing']);
});

test('busy: an own-property-only lookup -- "constructor" falls back to "another task", not Function', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 409, body: { error: 'busy', busy: 'constructor' } }, 'save');
  assert.equal(outcome.kind, 'busy');
  assert.equal(outcome.message, 'The panel is busy running another task.');
});

// -- exists ----------------------------------------------------------------------------------------

test('exists: 409 error:"exists" -- message verbatim, no actions, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 409, body: { error: 'exists', message: 'images/crest.png already exists; uploads never replace a file' } }, 'save');
  assert.equal(outcome.kind, 'exists');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'images/crest.png already exists; uploads never replace a file');
  assert.deepEqual(outcome.actions, []);
});

// -- 409 with an unknown error (not changed/busy/exists) ----------------------------------------

test('409 with an unknown error gives "unknown", not a crash or a silent fallthrough to one of the three named kinds', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 409, body: { error: 'something-else', message: 'whatever' } }, 'save');
  assert.equal(outcome.kind, 'unknown');
  assert.equal(outcome.message, 'The save did not go through (HTTP 409).');
});

// -- invalid-on-disk (422) -------------------------------------------------------------------------

test('invalid-on-disk: 422 -- message plus the fixed "fix outside the panel" detail, Reload, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 422, body: { message: 'pack.toml: theme must be a string' } }, 'save');
  assert.equal(outcome.kind, 'invalid-on-disk');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'pack.toml: theme must be a string');
  assert.equal(outcome.detail, 'Fix the file outside the panel, then reload.');
  assert.deepEqual(outcome.actions, ['reload']);
});

// -- invalid (400 with a string message) ----------------------------------------------------------

test('invalid: 400 with a string message -- verbatim, no actions, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 400, body: { error: 'invalid', message: 'labels.chapter must be a string' } }, 'save');
  assert.equal(outcome.kind, 'invalid');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'labels.chapter must be a string');
  assert.deepEqual(outcome.actions, []);
});

// -- read-only (403, error:"read-only") -------------------------------------------------------------

test('read-only: 403 error:"read-only" -- message verbatim, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 403, body: { error: 'read-only', message: 'This campaign is read-only.' } }, 'save');
  assert.equal(outcome.kind, 'read-only');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'This campaign is read-only.');
});

// -- refused (403 without JSON) -----------------------------------------------------------------

test('refused: 403 with no JSON body -- fixed message, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 403, body: null }, 'save');
  assert.equal(outcome.kind, 'refused');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'The panel refused the request. Open the admin link printed in your terminal again.');
});

// -- io (503) -------------------------------------------------------------------------------------

test('io: 503 -- message verbatim, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 503, body: { error: 'io', message: 'EBUSY: resource busy or locked' } }, 'save');
  assert.equal(outcome.kind, 'io');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'EBUSY: resource busy or locked');
});

// -- too-large (413) --------------------------------------------------------------------------------

test('too-large: 413 -- fixed message regardless of body, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 413, body: null }, 'save');
  assert.equal(outcome.kind, 'too-large');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'The request was too large for the panel to accept.');
});

// -- unreachable (status 0) --------------------------------------------------------------------------

test('unreachable: status 0 (api()\'s fetch rejected) -- fixed message, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 0, body: null }, 'save');
  assert.equal(outcome.kind, 'unreachable');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'The panel could not be reached. Check that serve --admin is still running.');
});

// -- unknown (anything else) -----------------------------------------------------------------------

test('unknown: an unmapped status -- HTTP code interpolated, Reload, role alert', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 500, body: null }, 'save');
  assert.equal(outcome.kind, 'unknown');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'The save did not go through (HTTP 500).');
  assert.deepEqual(outcome.actions, ['reload']);
});

// -- every refusal uses role:"alert" (positive control: ready/saved don't) ----------------------

test('positive control: ready and saved use role:"status", not "alert"', () => {
  assert.equal(OC.mapOutcome({ ok: true, status: 200, body: { ok: true } }, 'dry').role, 'status');
  assert.equal(OC.mapOutcome({ ok: true, status: 200, body: { ok: true } }, 'save').role, 'status');
});

// -- V1e-9 (SD-103): needs-ack and refused-by-check, before the generic 422 branch ---------------

test('needs-ack: 422 with error:"needs-ack" -- message verbatim, role alert, keep-editing only', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 422, body: { error: 'needs-ack', message: 'Tick "Save anyway" to save this. Nothing was written.', reasons: ['privacy'] } }, 'save');
  assert.equal(outcome.kind, 'needs-ack');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'Tick "Save anyway" to save this. Nothing was written.');
  assert.equal(outcome.detail, undefined);
  assert.deepEqual(outcome.actions, ['keep-editing']);
});

test('refused-by-check: 422 with error:"refused-by-check" -- message verbatim, role alert, keep-editing only', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 422, body: { error: 'refused-by-check', message: 'The check on the edited copy refuses this file: x.' } }, 'save');
  assert.equal(outcome.kind, 'refused-by-check');
  assert.equal(outcome.role, 'alert');
  assert.equal(outcome.message, 'The check on the edited copy refuses this file: x.');
  assert.deepEqual(outcome.actions, ['keep-editing']);
});

test('positive control: a 422 with error:"unsupported" still falls through to the generic invalid-on-disk branch', () => {
  const outcome = OC.mapOutcome({ ok: false, status: 422, body: { error: 'unsupported', message: 'x' } }, 'save');
  assert.equal(outcome.kind, 'invalid-on-disk');
});
