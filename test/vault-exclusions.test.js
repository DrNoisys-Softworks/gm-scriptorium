'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { excludedDirUnion, excludedDirHit, excludedSegmentHit, platformFoldsCase } = require('../src/vault/exclusions');
const { isInsideReal } = require('../src/build/themeassets');

/*
 * process.platform is `configurable: true` but not `writable: true`, so a plain assignment
 * throws under 'use strict'. Copied from test/build-plan-swap.test.js:21-29.
 */
function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('X1: excludedDirUnion of json [A,B] and publish [B,C/D] is [A,B,C/D]', () => {
  const union = excludedDirUnion({ excludeDirs: ['A', 'B'] }, { exclude_dirs: ['B', 'C/D'] });
  assert.deepEqual(union, ['A', 'B', 'C/D']);
});

test('X2: excludedDirHit on the X1 union', () => {
  const union = ['A', 'B', 'C/D'];
  assert.equal(excludedDirHit('C/D/x.webp', union), 'C/D');
  assert.equal(excludedDirHit('C/Dx/y', union), null);
  assert.equal(excludedDirHit('A', union), 'A');
});

test('X3: excludedDirHit falls back to the always-excluded segment, filename popped', () => {
  assert.equal(excludedDirHit('x/personal/y.png', []), 'personal');
  assert.equal(excludedDirHit('x/personal', []), null);
});

test('X4: excludedDirHit folding', () => {
  assert.equal(excludedDirHit('a/x.webp', ['A'], { foldCase: true }), 'A');
  assert.equal(excludedDirHit('a/x.webp', ['A'], { foldCase: false }), null);
});

test('X5: excludedSegmentHit', () => {
  assert.equal(excludedSegmentHit('.hidden/x', []), '.hidden');
  assert.equal(excludedSegmentHit('x/.cache/y', []), '.cache');
  assert.equal(excludedSegmentHit('Q/B/x', ['B']), 'B');
  // C/D never matches a single segment: no segment of "x/C/D/y" equals "C/D".
  assert.equal(excludedSegmentHit('x/C/D/y', ['C/D']), null);
  // folding
  assert.equal(excludedSegmentHit('q/b/x', ['B'], { foldCase: true }), 'b');
  assert.equal(excludedSegmentHit('q/b/x', ['B'], { foldCase: false }), null);
});

test('X6: platformFoldsCase under win32, darwin and linux', () => {
  withPlatform('win32', () => assert.equal(platformFoldsCase(), true));
  withPlatform('darwin', () => assert.equal(platformFoldsCase(), true));
  withPlatform('linux', () => assert.equal(platformFoldsCase(), false));
});

test('X7: isInsideReal', () => {
  withPlatform('linux', () => {
    assert.equal(isInsideReal('/a/vault', '/a/vault/x.webp'), true);
    assert.equal(isInsideReal('/a/vault', '/a/vault2'), false);
    assert.equal(isInsideReal('/a/vault', '/a/vault'), false);
    assert.equal(isInsideReal('/A/Vault', '/a/vault/x.webp'), false);
  });
  withPlatform('win32', () => {
    assert.equal(isInsideReal('/A/Vault', '/a/vault/x.webp'), true);
  });
});
