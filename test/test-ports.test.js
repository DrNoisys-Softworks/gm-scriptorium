'use strict';

/*
 * Unit pin for test/helpers/ports.js (issue #91). Every expected value is a hand-typed literal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ENV_NAME, portBase, testPort } = require('./helpers/ports');

const VAR = 'SCRIPTORIUM_TEST_PORT_BASE';

test('ports: the variable is named SCRIPTORIUM_TEST_PORT_BASE', () => {
  assert.equal(ENV_NAME, 'SCRIPTORIUM_TEST_PORT_BASE');
});

test('ports: portBase defaults to 7000 when unset or empty', () => {
  assert.equal(portBase({}), 7000);
  assert.equal(portBase({ [VAR]: '' }), 7000);
});

test('ports: portBase reads a whole number from 1024 to 29768', () => {
  assert.equal(portBase({ [VAR]: '20000' }), 20000);
  assert.equal(portBase({ [VAR]: '1024' }), 1024);
  assert.equal(portBase({ [VAR]: '29768' }), 29768);
});

test('ports: testPort is the identity at the default base', () => {
  assert.equal(testPort(7920, {}), 7920);
  assert.equal(testPort(7000, {}), 7000);
  assert.equal(testPort(9999, {}), 9999);
});

test('ports: testPort shifts by the base', () => {
  assert.equal(testPort(7920, { [VAR]: '20000' }), 20920);
  assert.equal(testPort(9999, { [VAR]: '29768' }), 32767);
});

test('ports: a bad base throws one line naming the variable', () => {
  for (const bad of ['abc', ' 8000', '1023', '29769', '7000.5', '-1']) {
    assert.throws(
      () => portBase({ [VAR]: bad }),
      (err) => err.message.includes(VAR) && !err.message.includes('\n'),
      `base ${JSON.stringify(bad)}`,
    );
    assert.throws(() => testPort(7920, { [VAR]: bad }), new RegExp(VAR));
  }
});

test('ports: a default port outside 7000 to 9999, or not an integer, throws', () => {
  assert.throws(() => testPort(6999, {}), /7000/);
  assert.throws(() => testPort(10000, {}), /9999/);
  assert.throws(() => testPort('7920', {}), /integer/);
  assert.throws(() => testPort(7920.5, {}), /integer/);
});
