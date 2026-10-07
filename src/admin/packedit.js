'use strict';

const TOML = require('smol-toml');

/*
 * Phase 8 slice S3 (SD-5, SD-7): the pure edit step between "read the raw bytes" and "validate
 * the candidate with the product's own parser". Every save starts from the file's own raw bytes,
 * re-read at save time (FR18) -- never from parsePackToml's or loadPackConfig's resolved result,
 * both of which fill in defaults or absolutise vaultPath (H10).
 */

/**
 * Sets `theme`, keeping its existing position in the table when the key was already present
 * (object-spread preserves insertion order for a key that already exists; a brand new key lands
 * at the end). Every other key, table and comment-adjacent formatting choice smol-toml makes is
 * D06's accepted residual.
 *
 * @param {string} raw
 * @param {string} theme
 * @returns {string}
 */
function editPackTomlTheme(raw, theme) {
  const parsed = TOML.parse(raw);
  return TOML.stringify({ ...parsed, theme });
}

/**
 * Sets only the keys the caller actually provided; every other key in the parsed object
 * (including ones the panel never shows) survives untouched (FR20). V1e-1 (ADR 0033, D-20):
 * `landingTagline` is no longer a writable key here -- an existing on-disk value is left alone
 * (D-20's "never written again"), never cleared and never touched by this function.
 *
 * @param {string} raw
 * @param {{ siteTitle?: string }} edits
 * @returns {string}
 */
function editVaultConfigJson(raw, edits = {}) {
  const parsed = JSON.parse(raw);
  if (Object.prototype.hasOwnProperty.call(edits, 'siteTitle')) parsed.siteTitle = edits.siteTitle;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** D06: true when `raw` has any line that is (after leading whitespace) a TOML comment. */
function tomlHasComment(raw) {
  return /^\s*#/m.test(raw);
}

module.exports = { editPackTomlTheme, editVaultConfigJson, tomlHasComment };
