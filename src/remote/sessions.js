'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { writePrivateFileAtomic } = require('./privatefile');

/*
 * V1.5a (docs/decisions/0029-remote-access.md, section 6; SD-doc section 7). The server-side
 * session store for remote sign-in.
 *
 * Only a credential's SHA-256 DIGEST is ever stored, never the credential, so a stolen
 * sessions.json yields no usable cookie. A credential is 32 random bytes (base64url, 43 chars) and
 * is separate from the launch token. Admin sessions last exactly SESSION_TTL_MS from sign-in, with
 * no sliding renewal; a preview session ends when its admin session does.
 *
 * The file is the shared state between the running panel and `gm-scriptorium remote` (sign out every
 * device, a password change, `remote off`), so every check first notices whether the file changed
 * since this process last read or wrote it (mtime, size and inode) and reloads it if so, and every
 * write re-reads first. The residual (a sign-in landing in the same instant as a CLI sign-out) is
 * written down in ADR 0029.
 */

const SESSION_TTL_MS = 86400000;
const ADMIN_COOKIE = '__Host-scriptorium_session';
const PREVIEW_COOKIE = '__Host-scriptorium_preview';
const MAX_CREDENTIAL_LENGTH = 256;

function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * @param {{ file: string, now?: () => number, randomBytes?: (size: number) => Buffer }} opts
 */
function createSessionStore({ file, now = Date.now, randomBytes = crypto.randomBytes }) {
  /** @type {Map<string, { id: string, kind: string, parent?: string, created: number, expires: number }>} */
  let records = new Map();
  let lastStat = null;
  let healthError = null;

  function statTriple() {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return null;
    }
  }

  function load() {
    const next = new Map();
    let text = null;
    healthError = null;
    lastStat = statTriple();
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') healthError = { message: `could not read the sessions file (${err.code || 'error'})` };
    }
    if (text !== null) {
      try {
        const parsed = JSON.parse(text);
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error('shape');
        const t = now();
        for (const rec of parsed.sessions) {
          if (
            rec &&
            typeof rec.id === 'string' &&
            /^[0-9a-f]{64}$/.test(rec.id) &&
            (rec.kind === 'admin' || rec.kind === 'preview') &&
            Number.isFinite(rec.created) &&
            Number.isFinite(rec.expires) &&
            rec.expires > t &&
            (rec.kind === 'admin' || (typeof rec.parent === 'string' && /^[0-9a-f]{64}$/.test(rec.parent)))
          ) {
            const clean = { id: rec.id, kind: rec.kind, created: rec.created, expires: rec.expires };
            if (rec.kind === 'preview') clean.parent = rec.parent;
            next.set(rec.id, clean);
          }
        }
      } catch {
        // Fail closed: an unreadable sessions file means everyone is signed out.
        next.clear();
        healthError = { message: 'the sessions file is not valid, so every device is signed out' };
      }
    }
    records = next;
  }

  function refreshIfChanged() {
    if (statTriple() !== lastStat) load();
  }

  function persist() {
    const body = { version: 1, sessions: [...records.values()] };
    writePrivateFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
    lastStat = statTriple();
  }

  function dropExpired() {
    const t = now();
    for (const [id, rec] of records) if (rec.expires <= t) records.delete(id);
  }

  function lookup(kind, credential) {
    if (typeof credential !== 'string' || credential.length === 0 || credential.length > MAX_CREDENTIAL_LENGTH) return null;
    const rec = records.get(sha256hex(credential));
    if (!rec || rec.kind !== kind) return null;
    if (!(rec.expires > now())) return null;
    if (kind === 'preview') {
      const parent = records.get(rec.parent);
      if (!parent || parent.kind !== 'admin' || !(parent.expires > now())) return null;
    }
    return rec;
  }

  return {
    load,

    /**
     * @param {'admin'|'preview'} kind
     * @param {{ parentId?: string }} [opts]
     * @returns {{ credential: string, id: string, expires: number }}
     */
    create(kind, { parentId } = {}) {
      refreshIfChanged();
      dropExpired();
      const created = now();
      let expires;
      if (kind === 'admin') {
        expires = created + SESSION_TTL_MS;
      } else if (kind === 'preview') {
        const parent = records.get(parentId);
        if (!parent || parent.kind !== 'admin' || !(parent.expires > created)) throw new Error('no valid admin session to attach a preview session to');
        expires = parent.expires;
      } else {
        throw new Error(`unknown session kind: ${kind}`);
      }
      const credential = randomBytes(32).toString('base64url');
      const id = sha256hex(credential);
      const rec = { id, kind, created, expires };
      if (kind === 'preview') rec.parent = parentId;
      records.set(id, rec);
      try {
        persist();
      } catch (err) {
        records.delete(id);
        throw err;
      }
      return { credential, id, expires };
    },

    /** @returns {object|null} the record, or null */
    verify(kind, credential) {
      refreshIfChanged();
      const rec = lookup(kind, credential);
      return rec ? { ...rec } : null;
    },

    /** Removes the record and its preview children, then persists. */
    revoke(id) {
      refreshIfChanged();
      if (!records.has(id)) return;
      for (const [rid, rec] of records) if (rid === id || rec.parent === id) records.delete(rid);
      persist();
    },

    /** @returns {{ count: number }} how many admin sessions were signed out */
    revokeAll() {
      refreshIfChanged();
      dropExpired();
      const count = [...records.values()].filter((r) => r.kind === 'admin').length;
      if (records.size === 0 && count === 0) return { count: 0 };
      records = new Map();
      persist();
      return { count };
    },

    activeCount() {
      refreshIfChanged();
      dropExpired();
      return [...records.values()].filter((r) => r.kind === 'admin').length;
    },

    health() {
      return { ok: healthError === null, error: healthError === null ? null : healthError.message };
    },
  };
}

module.exports = { SESSION_TTL_MS, ADMIN_COOKIE, PREVIEW_COOKIE, createSessionStore };
