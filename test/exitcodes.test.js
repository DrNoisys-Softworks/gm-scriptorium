'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EXIT_CODES, nameForExitCode } = require('../src/util/exitcodes');

test('exit code table matches the frozen contract', () => {
  assert.deepEqual(EXIT_CODES, {
    OK: 0,
    SCRIPTORIUM_ERROR: 1,
    CHECK_FAILED: 2,
    VAULT_UNREACHABLE: 3,
    UPDATE_PREREQUISITE: 4,
  });
});

test('EXIT_CODES is frozen', () => {
  assert.throws(() => {
    EXIT_CODES.OK = 99;
  }, TypeError);
});

test('nameForExitCode round-trips every known code', () => {
  for (const [name, code] of Object.entries(EXIT_CODES)) {
    assert.equal(nameForExitCode(code), name);
  }
});

test('nameForExitCode labels an unknown code rather than throwing', () => {
  assert.equal(nameForExitCode(42), 'UNKNOWN(42)');
});
