'use strict';

const { ConfigError } = require('../util/errors');
const { THEMES } = require('../build/themes');
const addr = require('../remote/addr');

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

/*
 * V1.5a (docs/decisions/0029-remote-access.md; SD-doc sections 1, 6 and 16): the validators the
 * remote-access settings and the `scriptorium remote` command share, here so V7's browser setup
 * can call the same functions. Pure: no network builtin (src/remote/addr.js does the address
 * handling by hand), and every refusal is a one-line ConfigError.
 */


/** @throws {ConfigError} */
function validatePort(raw, label = 'port') {
  const text = typeof raw === 'number' ? String(raw) : raw;
  if (typeof text !== 'string' || !/^[0-9]{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) {
    throw new ConfigError(`${label} must be a whole number from 1 to 65535`);
  }
  return Number(text);
}

/** @returns {string} the canonical form @throws {ConfigError} */
function validateIpLiteral(raw) {
  const canonical = addr.canonicalize(raw);
  if (canonical === null) {
    throw new ConfigError(`"${typeof raw === 'string' ? raw.slice(0, 64) : raw}" is not an IP address (no names, ports or prefix lengths)`);
  }
  return canonical;
}

function isLoopbackOrUnspecified(hostname) {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  const canonical = addr.canonicalize(bare);
  if (canonical === null) return false;
  if (canonical === '::1' || canonical === '::' || canonical === '0.0.0.0') return true;
  return canonical.startsWith('127.');
}

/**
 * An external address: https only, a bare origin (no path, query, fragment or credentials), never
 * a loopback form (so the two kinds of request can never overlap). Stored as `url.origin`, which
 * lowercases the host and drops a default port.
 *
 * @param {unknown} raw
 * @returns {string} the origin
 * @throws {ConfigError} "remote access needs HTTPS: <value>" for any non-https address
 */
function validateExternalUrl(raw) {
  const shown = typeof raw === 'string' ? raw.slice(0, 200) : String(raw);
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError('the address must be a web address such as https://scriptorium.home.arpa');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`"${shown}" is not a web address such as https://scriptorium.home.arpa`);
  }
  if (url.protocol !== 'https:') throw new ConfigError(`remote access needs HTTPS: ${shown}`);
  if (url.username !== '' || url.password !== '') throw new ConfigError(`the address must not carry a user name or password: ${shown}`);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ConfigError(`the address must be just a host and optional port, with no path, query or fragment: ${shown}`);
  }
  if (url.hostname === '' || url.hostname.endsWith('.')) throw new ConfigError(`the address needs a host name with no trailing dot: ${shown}`);
  if (isLoopbackOrUnspecified(url.hostname)) {
    throw new ConfigError(`the address must not be this machine's own loopback name or address: ${shown}`);
  }
  return url.origin;
}

/**
 * @param {unknown} pw
 * @returns {string} the NFC form
 * @throws {ConfigError}
 */
function validatePanelPassword(pw) {
  if (typeof pw !== 'string') throw new ConfigError('the panel password must be text');
  const n = pw.normalize('NFC');
  const length = Array.from(n).length;
  if (length < 12) throw new ConfigError('the panel password must be at least 12 characters');
  if (length > 1024) throw new ConfigError('the panel password must be at most 1024 characters');
  return n;
}

module.exports = {
  NAME_RE,
  validateName,
  validateTheme,
  validateTitle,
  validateTagline,
  composePackToml,
  validatePort,
  validateIpLiteral,
  validateExternalUrl,
  validatePanelPassword,
};
