'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { ST } = require(path.join(__dirname, '..', 'assets', 'admin', 'store.js'));

/*
 * Panel v2 V1c, SD-5/interfaces: ST.busyLine, the busy-status line's text for a given
 * store.busy value. Loaded via require() (the VB pattern). Independent literals throughout.
 */

test('ST.busyLine("check") -- the check pause sentence, independent literal', () => {
  assert.equal(ST.busyLine('check'), 'The panel pauses while a check runs.');
});

test('ST.busyLine("build") -- the preview-build pause sentence, independent literal', () => {
  assert.equal(ST.busyLine('build'), 'The panel pauses while the preview build runs.');
});

test('ST.busyLine(null) -- nothing to show', () => {
  assert.equal(ST.busyLine(null), null);
});

// M7: an object-lookup implementation (BUSY_LINES[busy]) resolves 'constructor' to
// Object.prototype.constructor (truthy), so this must be an own-property-only lookup, mirroring
// outcome.js's BUSY_LABEL (the same mutation, M9, in the V1b brief).
test('ST.busyLine("constructor") -- an own-property-only lookup gives null, not Object', () => {
  assert.equal(ST.busyLine('constructor'), null);
});

// The brief's own literal case: an unknown-but-plausible busy value the panel never actually
// sets (busy is only ever 'check', 'build' or null) must still resolve to null, not throw and
// not fall through to some default sentence.
test('ST.busyLine("write") -- an unknown value gives null', () => {
  assert.equal(ST.busyLine('write'), null);
});

test('ST.busyLine(undefined) -- also nothing to show (defensive, not just the exact null the store uses)', () => {
  assert.equal(ST.busyLine(undefined), null);
});
