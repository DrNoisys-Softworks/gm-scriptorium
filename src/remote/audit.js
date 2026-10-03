'use strict';

const fs = require('fs');
const path = require('path');
const { appendPrivateLine, writePrivateFileAtomic, ensurePrivateDir } = require('./privatefile');

/*
 * V1.5a (docs/decisions/0029-remote-access.md, section 8; SD-doc section 9). The audit log: one
 * JSON object per line in panel/audit.log, written in every mode including local.
 *
 * "Never a password, token, cookie, session credential, private key or request body" is
 * guaranteed STRUCTURALLY: an entry is rebuilt from the fixed AUDIT_KEYS list, so any other key a
 * caller supplies is dropped, every string is stripped of control characters and capped at 256,
 * and the only array allowed is `changed`, of strings. The same whitelist is applied again when
 * the log is read, so a hand-edited line cannot smuggle anything onto the screen.
 */

const AUDIT_KEYS = Object.freeze([
  't',
  'event',
  'method',
  'result',
  'via',
  'from',
  'browser',
  'campaign',
  'route',
  'status',
  'until',
  'count',
  'refused',
  'by',
  'changed',
  'mode',
  'fingerprint',
  'trust',
  'source',
]);

const MAX_STRING = 256;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_READ_LIMIT = 2000;
// C0 and C1 controls, DEL, and the two Unicode line separators.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function cleanString(s) {
  return s.replace(CONTROL_RE, '').slice(0, MAX_STRING);
}

/**
 * @param {object} entry
 * @returns {object} a new object holding only whitelisted, sanitised values
 */
function sanitize(entry) {
  const out = {};
  if (!entry || typeof entry !== 'object') return out;
  for (const key of AUDIT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
    const v = entry[key];
    if (typeof v === 'string') out[key] = cleanString(v);
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[key] = v;
    } else if (typeof v === 'boolean' || v === null) out[key] = v;
    else if (key === 'changed' && Array.isArray(v)) out[key] = v.filter((x) => typeof x === 'string').map(cleanString);
  }
  return out;
}

/**
 * A fixed family from the User-Agent, never the raw string. Checked in this order, because Edge
 * and Chrome both say "Chrome" and Chrome and Safari both say "Safari".
 *
 * @param {unknown} ua
 * @returns {'Edge'|'Firefox'|'Chrome'|'Safari'|'curl'|'other'}
 */
function browserFamily(ua) {
  if (typeof ua !== 'string') return 'other';
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/\b(Firefox|FxiOS)\//.test(ua)) return 'Firefox';
  if (/\b(Chrome|Chromium|CriOS)\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua)) return 'Safari';
  if (/^curl\//.test(ua)) return 'curl';
  return 'other';
}

/**
 * @param {{ file: string, now?: () => number, isInsideVault?: () => boolean }} opts
 *   isInsideVault: a belt-and-braces refusal to write when the folder is inside a vault (local
 *   mode never runs the startup check that remote modes do)
 */
function createAuditLog({ file, now = Date.now, isInsideVault } = {}) {
  let lastError = null;

  function fail(err) {
    lastError = { at: new Date(now()).toISOString(), message: cleanString(String((err && err.code) || (err && err.message) || 'error')) };
  }

  function guard() {
    if (typeof isInsideVault === 'function' && isInsideVault()) {
      const err = new Error('the audit log folder is inside a vault');
      err.code = 'EVAULT';
      throw err;
    }
  }

  return {
    file,

    /**
     * @param {object} entry
     * @param {{ at?: number }} [opts] stamp the entry with this time instead of now (lockout-end)
     * @throws on any failure to write, after recording it for health()
     */
    append(entry, { at } = {}) {
      try {
        guard();
        const clean = sanitize({ ...entry, t: new Date(at !== undefined ? at : now()).toISOString() });
        appendPrivateLine(file, `${JSON.stringify(clean)}\n`);
        lastError = null;
      } catch (err) {
        fail(err);
        throw err;
      }
    },

    /**
     * A write-free check that an entry could be written (the file can be opened for append). Used
     * before a remote password check so a sign-in is never accepted that could not be recorded.
     *
     * @returns {boolean}
     */
    writable() {
      try {
        guard();
        ensurePrivateDir(path.dirname(file));
        const fd = fs.openSync(file, 'a', 0o600);
        fs.closeSync(fd);
        lastError = null;
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },

    /**
     * @param {{ sinceMs?: number, limit?: number }} [opts]
     * @returns {{ entries: object[], truncated: boolean, malformed: number }} newest first
     */
    read({ sinceMs, limit = DEFAULT_READ_LIMIT } = {}) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return { entries: [], truncated: false, malformed: 0 };
      }
      const entries = [];
      let malformed = 0;
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          malformed++;
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          malformed++;
          continue;
        }
        const clean = sanitize(parsed);
        if (sinceMs !== undefined) {
          const ts = Date.parse(clean.t);
          if (!(ts >= sinceMs)) continue;
        }
        entries.push(clean);
      }
      entries.reverse();
      const truncated = entries.length > limit;
      return { entries: truncated ? entries.slice(0, limit) : entries, truncated, malformed };
    },

    /**
     * Drops entries more than 90 days old (keeping any line whose time cannot be parsed). Never
     * throws and never blocks: a failure here (a locked file, a full disk) must not stop startup
     * or change an exit code, so it is swallowed, as src/build/run.js does for its own cleanup.
     */
    prune(nowMs) {
      try {
        guard();
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n').filter((l) => l.trim() !== '');
        const kept = lines.filter((line) => {
          try {
            const ts = Date.parse(JSON.parse(line).t);
            return Number.isNaN(ts) || nowMs - ts <= RETENTION_MS;
          } catch {
            return true;
          }
        });
        if (kept.length === lines.length) return;
        writePrivateFileAtomic(file, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
      } catch {
        // swallowed deliberately: pruning is best-effort housekeeping.
      }
    },

    health() {
      return { ok: lastError === null, lastError };
    },
  };
}

module.exports = { AUDIT_KEYS, sanitize, browserFamily, createAuditLog };
