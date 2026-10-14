'use strict';

const { ConfigError } = require('../util/errors');
const { validatePort } = require('../setup/validate');

/*
 * The `[desktop]` table in config.toml (docs/decisions/0057-windows-desktop-app.md, section 8). It
 * holds the two ports the Windows desktop app gives its panel and its preview, and the per-machine
 * confirmation that remote access may start at sign-in (section 7):
 *
 *   [desktop]
 *   port             = 7400   # the panel
 *   preview_port     = 7401   # the preview
 *   remote_at_signin = false  # true once the GM has said remote access may start at sign-in
 *
 * Every key is optional. An unknown key is refused (a security-adjacent table, like `[remote]`), a
 * port must be a TOML integer from 1 to 65535 (so the string "7400" is refused), and the two ports
 * must differ once the defaults are filled in. src/config/load.js does NOT call this module, so a
 * bad entry never stops `check`, `build` and the rest; only the desktop app and the writers do.
 * It requires only the error class and the port check, so the writer can use it without a cycle.
 */

const DESKTOP_DEFAULTS = Object.freeze({ port: 7400, previewPort: 7401 });
const DESKTOP_KEYS = Object.freeze(['port', 'preview_port', 'remote_at_signin']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A key shown in a one-line message: control characters removed, at most 40 characters. */
function showKey(key) {
  // eslint-disable-next-line no-control-regex
  const clean = String(key).replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
}

function readPort(raw, key) {
  const label = `desktop: ${key}`;
  if (!Number.isInteger(raw)) throw new ConfigError(`${label} must be a whole number from 1 to 65535`);
  return validatePort(raw, label);
}

/**
 * @param {unknown} raw the value of `config.desktop`, or undefined when the table is absent
 * @returns {{ port: number, previewPort: number, remoteAtSignin: boolean, saved: boolean }}
 *   `saved` is true when at least one port is written down (so Setup can tell "no settings yet")
 * @throws {ConfigError} one line: not a table, an unknown key, a bad value, or equal ports
 */
function parseDesktopTable(raw) {
  if (raw === undefined) return { ...DESKTOP_DEFAULTS, remoteAtSignin: false, saved: false };
  if (!isPlainObject(raw)) throw new ConfigError('desktop must be a table');
  for (const key of Object.keys(raw)) {
    if (!DESKTOP_KEYS.includes(key)) throw new ConfigError(`desktop: unrecognised key "${showKey(key)}"`);
  }
  const port = raw.port === undefined ? DESKTOP_DEFAULTS.port : readPort(raw.port, 'port');
  const previewPort = raw.preview_port === undefined ? DESKTOP_DEFAULTS.previewPort : readPort(raw.preview_port, 'preview_port');
  if (raw.remote_at_signin !== undefined && typeof raw.remote_at_signin !== 'boolean') {
    throw new ConfigError('desktop: remote_at_signin must be true or false');
  }
  if (port === previewPort) throw new ConfigError('desktop: the panel and preview ports must differ');
  return {
    port,
    previewPort,
    remoteAtSignin: raw.remote_at_signin === true,
    saved: raw.port !== undefined || raw.preview_port !== undefined,
  };
}

module.exports = { DESKTOP_DEFAULTS, DESKTOP_KEYS, parseDesktopTable };
