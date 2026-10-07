'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * SD-8, the busy contract (V1c follow-up rework): every V1b run/save control's `disabled` is
 * its own state OR `store.get().busy !== null`, re-evaluated on store changes, including the
 * slip's Save. This was never implemented in V1b as shipped -- ADR 0022's own §5 recorded it as
 * "a later slice's UI", contradicting the brief that put it in V1b so V1c never has to touch
 * V1b's own files.
 *
 * `node --test` cannot drive the real DOM/store sequence this depends on (opening a screen,
 * setting `busy` on the live store, confirming a control's `.disabled` flips) -- see the
 * Playwright replay in the QA gate record for that. This is the strongest in-repo substitute: a
 * structural scan proving every listed control's disabled computation includes
 * `store.isBusy()` (or the fully-qualified form slip.js uses, since it has no local `store`
 * alias), that each of the four files re-evaluates on a `busy`-specific store change, and that
 * the explicitly-excluded controls (vocab's kind add/remove/reset, pack's Keep) were left alone.
 *
 * **Rework (Reviewer, post-shipped-code-verified-live):** the first version of this file checked
 * each busy-only `store.subscribe` callback's early-return guard (`if (next.busy === prev.busy)
 * return;`) but never the assignment line(s) that follow it, and checked `images.js`'s uploadBtn
 * pattern with a bare `.includes()` rather than an exact count. Both left the whole suite green
 * against a real, live-reproduced defect: dropping the assignment after the guard, or reverting
 * the upload button's `.then()`/`.catch()` resets, kept a control enabled while busy. Every
 * busy-only subscribe callback's assignment(s), and uploadBtn's three occurrences, are now
 * counted exactly -- see the mutation table in GATE.md §8 for both mutations driven red.
 */

const ADMIN_DIR = path.join(__dirname, '..', 'assets', 'admin');

function readSrc(name) {
  return fs.readFileSync(path.join(ADMIN_DIR, name), 'utf8');
}

function countOccurrences(src, needle) {
  return src.split(needle).length - 1;
}

test('pack.js: both reviewBtn (Theme, Title) compute disabled as ownState || store.isBusy(), including after their own in-flight request settles', () => {
  const src = readSrc('pack.js');
  // 2 screens x (1 initial assignment + 2 in-flight-request resets) = 6.
  assert.equal(countOccurrences(src, 'reviewBtn.disabled = disabledReason || store.isBusy();'), 6);
});

test('pack.js: a store.subscribe callback re-evaluates specifically on a busy change (next.busy !== prev.busy, or the equivalent early-return form), and actually assigns both buttons\' disabled -- not just guards on the change', () => {
  const src = readSrc('pack.js');
  assert.ok(/if \(next\.busy === prev\.busy\) return;/.test(src) || /next\.busy !== prev\.busy/.test(src), 'expected a busy-specific store.subscribe check in pack.js');
  // The guard alone (above) is satisfied by a callback that returns early but never assigns
  // anything after it -- a real, live-reproduced defect (Reviewer, SD-8 rework): the button stays
  // enabled while busy because the assignment after the guard was dropped. These must be counted
  // exactly, the same way the click-handler reviewBtn assignments above are.
  assert.equal(countOccurrences(src, 'if (themeReviewBtn) themeReviewBtn.disabled = themeOwnDisabled || store.isBusy();'), 1);
  assert.equal(countOccurrences(src, 'if (titleReviewBtn) titleReviewBtn.disabled = titleOwnDisabled || store.isBusy();'), 1);
});

test('pack.js: the Keep button is left alone (no busy term anywhere near it)', () => {
  const src = readSrc('pack.js');
  const keepBlock = src.slice(src.indexOf("setText(keepBtn, 'Keep');"), src.indexOf("actions.appendChild(keepBtn);"));
  assert.ok(keepBlock.length > 0, 'expected to find the Keep button block');
  assert.ok(!keepBlock.includes('isBusy'), 'the Keep button must not reference store.isBusy()');
});

test('vocab.js: reviewBtn computes disabled as ownState || store.isBusy(), including after its own in-flight request settles', () => {
  const src = readSrc('vocab.js');
  // 1 initial assignment + 2 in-flight-request resets = 3.
  assert.equal(countOccurrences(src, 'reviewBtn.disabled = disabledReason || store.isBusy();'), 3);
});

test('vocab.js: a store.subscribe callback re-evaluates specifically on a busy change, and actually assigns reviewBtn\'s disabled -- not just guards on the change', () => {
  const src = readSrc('vocab.js');
  assert.ok(/if \(next\.busy === prev\.busy\) return;/.test(src) || /next\.busy !== prev\.busy/.test(src), 'expected a busy-specific store.subscribe check in vocab.js');
  assert.equal(countOccurrences(src, 'if (vocabReviewBtn) vocabReviewBtn.disabled = vocabOwnDisabled || store.isBusy();'), 1);
});

test('vocab.js: kind add/remove/reset buttons are left alone (no busy term anywhere near them)', () => {
  const src = readSrc('vocab.js');
  const addBlock = src.slice(src.indexOf("setText(addKindBtn, 'Add kind');"), src.indexOf('kindsPanel.appendChild(addKindBtn);') + 40);
  const resetBlock = src.slice(src.indexOf("setText(resetKindsBtn, 'Reset kinds to defaults');"), src.indexOf('kindsPanel.appendChild(resetKindsBtn);') + 45);
  const removeBlock = src.slice(src.indexOf("setText(removeBtn, 'Remove');"), src.indexOf('row.removeBtn = removeBtn;') + 30);
  assert.ok(addBlock.length > 0 && resetBlock.length > 0 && removeBlock.length > 0, 'expected to find all three kind-editor button blocks');
  assert.ok(!addBlock.includes('isBusy'), 'Add kind must not reference store.isBusy()');
  assert.ok(!resetBlock.includes('isBusy'), 'Reset kinds must not reference store.isBusy()');
  assert.ok(!removeBlock.includes('isBusy'), 'Remove (a kind row) must not reference store.isBusy()');
});

/*
 * V1e-5 (SD-57) rewrite, this section only: the per-slot Set/Clear POST buttons no longer
 * exist; their replacement is one Review button (Choose files keeps its own name, `uploadBtn`,
 * per the mock's own naming -- SD-56). Exact counts plus "the subscription assigns", the same
 * standard the rest of this file already holds every other screen to.
 */
test('images.js: uploadBtn.disabled = store.isBusy(); appears exactly 3 times (build, the batch\'s own .then, and .catch)', () => {
  const src = readSrc('images.js');
  assert.equal(countOccurrences(src, 'uploadBtn.disabled = store.isBusy();'), 3);
});

test('images.js: reviewBtn.disabled = disabledReason || store.isBusy(); appears exactly 3 times (build, .then and .catch)', () => {
  const src = readSrc('images.js');
  assert.equal(countOccurrences(src, 'reviewBtn.disabled = disabledReason || store.isBusy();'), 3);
});

test('images.js: a store.subscribe callback re-evaluates specifically on a busy change, and actually assigns both uploadBtn\'s and reviewBtn\'s disabled -- not just guards on the change', () => {
  const src = readSrc('images.js');
  assert.ok(/if \(next\.busy === prev\.busy\) return;/.test(src) || /next\.busy !== prev\.busy/.test(src), 'expected a busy-specific store.subscribe check in images.js');
  assert.equal(countOccurrences(src, 'if (currentUploadBtn) currentUploadBtn.disabled = store.isBusy();'), 1);
  assert.equal(countOccurrences(src, 'if (imagesReviewBtn) imagesReviewBtn.disabled = imagesOwnDisabled || store.isBusy();'), 1);
});

test('images.js: every local edit control is built through one helper, localEditButton, whose own body never mentions isBusy', () => {
  const src = readSrc('images.js');
  const start = src.indexOf('function localEditButton(');
  assert.ok(start !== -1, 'expected to find function localEditButton(');
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end !== -1, 'expected to find the closing brace of localEditButton');
  const body = src.slice(start, end);
  assert.ok(body.length > 20, 'expected a non-empty localEditButton body (positive control)');
  assert.ok(!body.includes('isBusy'), 'localEditButton must never reference store.isBusy()');
});

test('slip.js: the Save button computes disabled including store.isBusy()', () => {
  const src = readSrc('slip.js');
  assert.ok(src.includes('saveBtn.disabled = window.ScriptoriumAdmin.store.isBusy();'), 'expected saveBtn.disabled = window.ScriptoriumAdmin.store.isBusy();');
});

test('slip.js: a store.subscribe callback re-evaluates the Save button specifically on a busy change, and actually assigns its disabled -- not just guards on the change', () => {
  const src = readSrc('slip.js');
  assert.ok(/if \(next\.busy === prev\.busy\) return;/.test(src) || /next\.busy !== prev\.busy/.test(src), 'expected a busy-specific store.subscribe check in slip.js');
  assert.ok(src.includes('currentSaveBtn'), 'expected the subscription to update the currently-open slip\'s own Save button');
  assert.equal(countOccurrences(src, 'if (currentSaveBtn) currentSaveBtn.disabled = window.ScriptoriumAdmin.store.isBusy();'), 1);
});

test('store.js: ST.isBusy and the browser store.isBusy() helper both exist', () => {
  const src = readSrc('store.js');
  assert.ok(src.includes('function isBusy(busy)'), 'expected the pure ST.isBusy(busy) predicate');
  assert.ok(src.includes('window.ScriptoriumAdmin.store.isBusy = function ()'), 'expected the browser-singleton store.isBusy() helper');
});
