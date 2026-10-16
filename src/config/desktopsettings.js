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
const DESKTOP_KEYS = Object.freeze(['port', 'preview_port', 'remote_at_signin', 'remote_at_signin_pc']);
const MAX_COMPUTER_NAME = 255;

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

function readComputerName(raw) {
  // eslint-disable-next-line no-control-regex
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > MAX_COMPUTER_NAME || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ConfigError('desktop: remote_at_signin_pc must be the name of a computer');
  }
  return raw;
}

/** One computer name, compared the way the platform compares them (Windows names ignore case). */
function sameComputer(a, b, platform = process.platform) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = a.trim();
  const y = b.trim();
  if (x === '' || y === '') return false;
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Whether the sign-in confirmation (section 7) was given on THIS computer. It counts only when
 * `remote_at_signin` is true and `remote_at_signin_pc` names this computer: a settings folder copied to
 * another PC carries the answer but not the computer, and a true with no name (written before the name
 * was kept) counts as no. A table that cannot be read counts as no.
 *
 * @param {unknown} raw the value of `config.desktop`
 * @param {string} computer this computer's name
 */
function confirmedHere(raw, computer, platform = process.platform) {
  if (!isPlainObject(raw) || raw.remote_at_signin !== true) return false;
  return sameComputer(raw.remote_at_signin_pc, computer, platform);
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
  if (raw.remote_at_signin_pc !== undefined) readComputerName(raw.remote_at_signin_pc);
  if (port === previewPort) throw new ConfigError('desktop: the panel and preview ports must differ');
  return {
    port,
    previewPort,
    remoteAtSignin: raw.remote_at_signin === true,
    saved: raw.port !== undefined || raw.preview_port !== undefined,
  };
}

module.exports = { DESKTOP_DEFAULTS, DESKTOP_KEYS, parseDesktopTable, confirmedHere, sameComputer };
