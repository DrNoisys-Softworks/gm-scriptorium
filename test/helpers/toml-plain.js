'use strict';

// smol-toml 1.9.0 returns objects with a null prototype. assert.deepStrictEqual compares
// prototypes, so a parsed table never equals an object literal. plain() copies parsed data into
// ordinary objects (arrays and every other value are kept as they are) so a test can compare
// content against a literal without loosening the comparison itself.
function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === null) {
    const out = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, { value: plain(value[key]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

module.exports = { plain };
