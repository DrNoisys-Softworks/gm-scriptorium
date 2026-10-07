'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFinding,
  sortFindings,
  compareFindings,
  FindingValidationError,
} = require('../src/report/finding');

test('createFinding fills unset optional fields with null', () => {
  const f = createFinding({
    id: 'link/unresolved',
    severity: 'error',
    category: 'link',
    campaign: 'example',
    message: 'broken link',
  });
  assert.equal(f.path, null);
  assert.equal(f.line, null);
  assert.equal(f.outputPath, null);
  assert.equal(f.detail, null);
  assert.deepEqual(f.data, {});
});

test('createFinding rejects missing required fields', () => {
  assert.throws(
    () => createFinding({ severity: 'error', category: 'link', campaign: 'x', message: 'm' }),
    FindingValidationError,
  );
});

test('createFinding rejects an invalid severity', () => {
  assert.throws(
    () =>
      createFinding({
        id: 'x',
        severity: 'critical',
        category: 'link',
        campaign: 'x',
        message: 'm',
      }),
    FindingValidationError,
  );
});

test('createFinding rejects an invalid category', () => {
  assert.throws(
    () =>
      createFinding({
        id: 'x',
        severity: 'error',
        category: 'nonsense',
        campaign: 'x',
        message: 'm',
      }),
    FindingValidationError,
  );
});

test('createFinding rejects a non-positive line', () => {
  assert.throws(
    () =>
      createFinding({
        id: 'x',
        severity: 'error',
        category: 'link',
        campaign: 'x',
        message: 'm',
        line: 0,
      }),
    FindingValidationError,
  );
});

test('sortFindings orders by severity rank first', () => {
  const info = createFinding({
    id: 'census/type',
    severity: 'info',
    category: 'census',
    campaign: 'c',
    message: 'm',
  });
  const warn = createFinding({
    id: 'relationship/missing-required',
    severity: 'warn',
    category: 'frontmatter',
    campaign: 'c',
    message: 'm',
  });
  const error = createFinding({
    id: 'link/unresolved',
    severity: 'error',
    category: 'link',
    campaign: 'c',
    message: 'm',
  });
  const sorted = sortFindings([info, warn, error]);
  assert.deepEqual(
    sorted.map((f) => f.severity),
    ['error', 'warn', 'info'],
  );
});

test('sortFindings breaks severity ties by id, then path, then line, then message', () => {
  const base = { severity: 'error', category: 'link', campaign: 'c' };
  const a = createFinding({ ...base, id: 'link/unresolved', path: 'b.md', line: 5, message: 'z' });
  const b = createFinding({ ...base, id: 'link/unresolved', path: 'a.md', line: 5, message: 'z' });
  const c = createFinding({ ...base, id: 'link/unresolved', path: 'a.md', line: 1, message: 'z' });
  const sorted = sortFindings([a, b, c]);
  assert.deepEqual(sorted, [c, b, a]);
});

test('sortFindings does not mutate its input array', () => {
  const a = createFinding({
    id: 'b',
    severity: 'warn',
    category: 'config',
    campaign: 'c',
    message: 'm',
  });
  const b = createFinding({
    id: 'a',
    severity: 'warn',
    category: 'config',
    campaign: 'c',
    message: 'm',
  });
  const input = [a, b];
  const sorted = sortFindings(input);
  assert.deepEqual(input, [a, b]);
  assert.deepEqual(sorted, [b, a]);
});

test('compareFindings is stable-sort friendly: equal findings compare to 0', () => {
  const f = createFinding({
    id: 'x',
    severity: 'error',
    category: 'link',
    campaign: 'c',
    message: 'm',
  });
  assert.equal(compareFindings(f, { ...f }), 0);
});
