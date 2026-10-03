'use strict';

const { ConfigError } = require('../util/errors');
const { THEMES } = require('../build/themes');

/*
 * Phase 8 slice S3 (FR36): the validation `init` and the admin panel share. Moved verbatim out of
 * src/cli/init.js, which used to hold NAME_RE, validateName, validateTheme, validateTitle and
 * composePackToml directly (at the line numbers the S3 brief cites). `init.js` now requires these
 * from here and re-exports the same names, so its own `module.exports` block, `test/init-*`, and
 * PW15 (init.js stays write-free) are all unaffected: the re-exported functions are the identical
 * function objects this module defines, which `test/setup-validate.test.js` checks by identity.
 *
 * The panel (src/admin/handlers/pack.js) requires this module directly, never `init.js`: `init.js`
 * reaches `src/config/write.js`, which FR35 forbids on the panel's write path.
 */

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** @throws {ConfigError} I-NAME */
function validateName(raw) {
  if (typeof raw !== 'string' || !NAME_RE.test(raw)) {
    throw new ConfigError(
      `invalid campaign name "${raw}": use 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit`,
    );
  }
  return raw;
}

/** @throws {ConfigError} I-THEME */
function validateTheme(raw, registry = THEMES) {
  if (!Object.prototype.hasOwnProperty.call(registry, raw)) {
    throw new ConfigError(`unknown theme "${raw}"; valid themes: ${Object.keys(registry).sort().join(', ')}`);
  }
  return raw;
}

/** @throws {ConfigError} I-TITLE (empty after trim, or a control character) */
function validateTitle(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ConfigError('site title must be one non-empty line');
  }
  return trimmed;
}

/**
 * The panel's landing tagline (P8-D03). Unlike the title, an empty tagline is a valid choice (a
 * campaign may simply have none): trimmed to the empty string and returned as `''`, no throw. A
 * non-empty tagline follows the exact same one-line, no-control-character rule as the title,
 * under its own message.
 *
 * @throws {ConfigError} landing tagline must be one line
 */
function validateTagline(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0) return '';
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ConfigError('landing tagline must be one line');
  }
  return trimmed;
}

function composePackToml(theme) {
  return `theme = "${theme}"\n`;
}

module.exports = { NAME_RE, validateName, validateTheme, validateTitle, validateTagline, composePackToml };

// C2 stubs for the V1.5a remote-access validators (implemented in C3).
const stubWrong = () => null;
module.exports.validatePort = stubWrong;
module.exports.validateIpLiteral = stubWrong;
module.exports.validateExternalUrl = stubWrong;
module.exports.validatePanelPassword = stubWrong;
