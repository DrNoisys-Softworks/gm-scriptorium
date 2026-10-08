'use strict';

const { ConfigError } = require('../util/errors');
const { IMAGE_EXT_RE } = require('../build/themeassets');

/*
 * Phase 8 slice S5 (FR27, Structural decision 2). `POST /api/images/upload?name=` never lets a
 * client name anything but a flat file inside the pack's images/ folder: this is the one place
 * that name is validated, in the documented order (the first failure wins). The 128-character cap
 * and the full Windows-illegal-character set go beyond the Lead's own list, both fail-closed.
 */

// Separators, the NTFS ADS ":" suffix, Windows-illegal characters and control characters
// (including DEL). Covers "/", "\\" (separators and stream-suffix escapes alike).
const ILLEGAL_CHARS_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

// "(\\.|$)" is the load-bearing anchor: "com10.svg" must NOT match (it is com[1-9] followed by
// "0", not a dot or the end of the name), while "com1.svg" and bare "AUX" both must.
const RESERVED_DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * @param {unknown} name
 * @returns {string} `name`, unchanged
 * @throws {ConfigError} the first applicable rule, in order
 */
function validateUploadName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConfigError('upload name is required');
  }
  if (name.length > 128) {
    throw new ConfigError('upload name is longer than 128 characters');
  }
  if (ILLEGAL_CHARS_RE.test(name)) {
    throw new ConfigError(`upload name "${name}" contains a character that is not allowed in a file name`);
  }
  if (name.startsWith('.')) {
    throw new ConfigError('upload name must not start with a dot');
  }
  if (name.includes('..')) {
    throw new ConfigError('upload name must not contain ".."');
  }
  if (name.endsWith('.') || name.endsWith(' ')) {
    throw new ConfigError('upload name must not end with a dot or a space');
  }
  if (RESERVED_DEVICE_NAME_RE.test(name)) {
    throw new ConfigError(`upload name "${name}" is a reserved Windows device name`);
  }
  if (/\.md$/i.test(name)) {
    throw new ConfigError('.md files are never written into the campaign pack');
  }
  if (!IMAGE_EXT_RE.test(name)) {
    throw new ConfigError('upload name must end in .jpg, .jpeg, .png, .webp, .gif, .svg or .avif');
  }
  return name;
}

module.exports = { validateUploadName, ILLEGAL_CHARS_RE, RESERVED_DEVICE_NAME_RE };
