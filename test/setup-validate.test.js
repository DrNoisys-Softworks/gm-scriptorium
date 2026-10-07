'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TOML = require('smol-toml');

const validate = require('../src/setup/validate');
const init = require('../src/cli/init');
const { ConfigError } = require('../src/util/errors');

/*
 * Phase 8 slice S3 (FR36, test-first order item 1). src/setup/validate.js holds the validation
 * `init` and the admin panel share; init.js requires it and re-exports the same names. Every
 * assertion here that checks a message states the literal independently of both modules.
 */

// --- FR36: identity, not just equal shape --------------------------------

test('init.js re-exports the exact same function objects as src/setup/validate.js', () => {
  assert.equal(init.NAME_RE, validate.NAME_RE);
  assert.equal(init.validateName, validate.validateName);
  assert.equal(init.validateTheme, validate.validateTheme);
  assert.equal(init.validateTitle, validate.validateTitle);
  assert.equal(init.composePackToml, validate.composePackToml);
});

// --- validateTagline -------------------------------------------------------

test('validateTagline: an all-whitespace or empty string is accepted as ""', () => {
  assert.equal(validate.validateTagline(''), '');
  assert.equal(validate.validateTagline('   '), '');
});

test('validateTagline: a plain one-line string is trimmed and returned', () => {
  assert.equal(validate.validateTagline('One line'), 'One line');
});

test('validateTagline: a newline is refused with the exact message', () => {
  assert.throws(
    () => validate.validateTagline('a\nb'),
    (err) => err instanceof ConfigError && err.message === 'landing tagline must be one line',
  );
});

test('validateTagline: a control character is refused with the exact message', () => {
  assert.throws(
    () => validate.validateTagline('\u0007'),
    (err) => err instanceof ConfigError && err.message === 'landing tagline must be one line',
  );
});

// --- composePackToml / smol-toml parity ------------------------------------

test('composePackToml("haze") equals the literal theme = "haze"\\n', () => {
  assert.equal(validate.composePackToml('haze'), 'theme = "haze"\n');
});

test('smol-toml stringify({theme:"haze"}) equals the same literal composePackToml produces', () => {
  assert.equal(TOML.stringify({ theme: 'haze' }), 'theme = "haze"\n');
});
