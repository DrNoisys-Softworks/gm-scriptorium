'use strict';

const fs = require('fs');
const path = require('path');
const { appendPrivateLine } = require('../remote/privatefile');

/*
 * The desktop app's log (ADR 0057, section 9): `<panel folder>\logs\desktop.log`. A closed list of
 * events, every value scrubbed before it is written, one line each: `<ISO time> <event> k=v ...`,
 * values JSON-quoted. It is written only through appendPrivateLine (an owner-only file in an
 * owner-only folder, set at creation), rotated to desktop.log.1 at maxBytes, and it never throws to
 * the caller: a log that cannot be written must not stop the panel.
 *
 * It never holds a code, token, password or cookie (ADR 0028, "The launch code and how it reaches the
 * browser"). The caller never passes one; scrub() is the second layer.
 */

const LOG_EVENTS = Object.freeze([
  'host-start', 'panel-starting', 'panel-running', 'panel-stopped', 'panel-error', 'panel-warning',
  'retry', 'op', 'quit', 'exit', 'uncaught', 'signin-setting',
]);

const LOG_NAME = 'desktop.log';
const DEFAULT_MAX_BYTES = 262144;
const MAX_VALUE_CHARS = 500;
const REDACTED = '[redacted]';

// A run of token-like characters (a session token or launch code is 43 base64url characters), and
// anything after token=, code=, password or cookie up to the next whitespace.
const LONG_RUN = /[A-Za-z0-9_-]{43,}/g;
const LABELLED = /(?:token=|code=|password|cookie)(?:\s*[:=]\s*)?\S*/gi;

/** @param {unknown} text @returns {string} */
function scrub(text) {
  return String(text).replace(LABELLED, REDACTED).replace(LONG_RUN, REDACTED);
}

function oneValue(value) {
  // eslint-disable-next-line no-control-regex
  const flat = scrub(value === null || value === undefined ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return JSON.stringify(flat.length > MAX_VALUE_CHARS ? `${flat.slice(0, MAX_VALUE_CHARS)}...` : flat);
}

/**
 * @param {{ dir: string, now?: () => number, maxBytes?: number }} opts
 * @returns {{ event: (name: string, fields?: object) => void, dir: string, file: string }}
 */
function createDesktopLog({ dir, now = Date.now, maxBytes = DEFAULT_MAX_BYTES }) {
  const file = path.join(dir, LOG_NAME);

  function rotateIfFull() {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size >= maxBytes) fs.renameSync(file, `${file}.1`);
  }

  function event(name, fields = {}) {
    try {
      if (!LOG_EVENTS.includes(name)) return;
      const parts = [new Date(now()).toISOString(), name];
      for (const [key, value] of Object.entries(fields || {})) {
        if (!/^[a-z][a-z0-9-]*$/.test(key)) continue;
        parts.push(`${key}=${oneValue(value)}`);
      }
      rotateIfFull();
      appendPrivateLine(file, `${parts.join(' ')}\n`);
    } catch {
      // swallowed deliberately: the log is a courtesy and never stops the panel.
    }
  }

  return { event, dir, file };
}

module.exports = { LOG_EVENTS, LOG_NAME, scrub, createDesktopLog };
