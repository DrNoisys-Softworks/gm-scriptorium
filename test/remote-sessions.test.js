'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../src/remote/sessions');

/*
 * V1.5a (SD-a6). The server-side session store on an injected clock. Persistence tests build a
 * SECOND store over the same file (a persistence test that reuses one store object proves
 * nothing). The digest is recomputed in the test with crypto, independently.
 */

const DAY = 86400000;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-sess-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'panel', 'sessions.json');
  const clock = { t: Date.UTC(2026, 9, 3, 0, 0, 0), now: () => clock.t };
  const make = () => {
    const store = S.createSessionStore({ file, now: clock.now });
    store.load();
    return store;
  };
  return { dir, file, clock, make };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('constants are the stated literals', () => {
  assert.equal(S.SESSION_TTL_MS, 86400000);
  assert.equal(S.ADMIN_COOKIE, '__Host-scriptorium_session');
  assert.equal(S.PREVIEW_COOKIE, '__Host-scriptorium_preview');
});

test('create admin: a 43-character credential, its sha256 as the id, expiry exactly 24 hours out', (t) => {
  const { make, clock } = setup(t);
  const store = make();
  const out = store.create('admin');
  assert.match(out.credential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(out.id, sha(out.credential));
  assert.equal(out.expires, clock.t + DAY);
});

test('verify: right credential with the right kind passes; a wrong kind, a mutated credential and junk do not', (t) => {
  const { make } = setup(t);
  const store = make();
  const { credential, id } = store.create('admin');
  const rec = store.verify('admin', credential);
  assert.equal(rec.id, id);
  assert.equal(rec.kind, 'admin');
  assert.equal(store.verify('preview', credential), null);
  assert.equal(store.verify('admin', credential.slice(0, -1) + (credential.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(store.verify('admin', id), null, 'the stored digest is not a credential');
  for (const bad of ['', undefined, null, 5, {}, 'x'.repeat(300)]) assert.equal(store.verify('admin', bad), null);
});

test('Ma4: expiry is strict: valid at +86399999, refused at +86400000', (t) => {
  const { make, clock } = setup(t);
  const store = make();
  const { credential } = store.create('admin');
  const start = clock.t;
  clock.t = start + 86399999;
  assert.ok(store.verify('admin', credential));
  clock.t = start + 86400000;
  assert.equal(store.verify('admin', credential), null);
});

test('only digests are on disk: the file holds the id, never the credential, and no extra secrets', (t) => {
  const { make, file } = setup(t);
  const store = make();
  const { credential, id } = store.create('admin');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(id));
  assert.ok(!text.includes(credential));
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.sessions[0]).sort(), ['created', 'expires', 'id', 'kind']);
});

test('persistence: a SECOND store over the same file still verifies the credential, until it expires', (t) => {
  const { make, clock } = setup(t);
  const first = make();
  const { credential } = first.create('admin');
  const second = make();
  assert.ok(second.verify('admin', credential));
  clock.t += DAY;
  assert.equal(make().verify('admin', credential), null);
});

test('Ma4 variant: expired records are dropped at load', (t) => {
  const { make, clock, file } = setup(t);
  make().create('admin');
  clock.t += DAY + 1;
  const store = make();
  assert.equal(store.activeCount(), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.length, 1, 'load does not rewrite, create/revoke do');
});

test('the stored id works as a cookie? No: only the credential does', (t) => {
  const { make, file } = setup(t);
  const store = make();
  store.create('admin');
  const id = JSON.parse(fs.readFileSync(file, 'utf8')).sessions[0].id;
  assert.equal(make().verify('admin', id), null);
});

test('a corrupt file fails closed: everyone signed out, health reports it, and a new session still works', (t) => {
  const { make, file } = setup(t);
  const first = make();
  const { credential } = first.create('admin');
  fs.writeFileSync(file, '{ not json');
  const store = make();
  assert.equal(store.verify('admin', credential), null);
  assert.equal(store.health().ok, false);
  assert.match(store.health().error, /not valid/);
  const fresh = store.create('admin');
  assert.ok(store.verify('admin', fresh.credential));
});

test('a wrong-shape file (bad ids, bad kinds) loads as empty without throwing', (t) => {
  const { make, file } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [{ id: 'short', kind: 'admin', created: 1, expires: 9e15 }, { id: 'a'.repeat(64), kind: 'root', created: 1, expires: 9e15 }, null, 7] }));
  const store = make();
  assert.equal(store.activeCount(), 0);
  assert.equal(store.health().ok, true);
  fs.writeFileSync(file, JSON.stringify({ version: 2, sessions: [] }));
  assert.equal(make().health().ok, false);
});

test('a missing file is empty and healthy', (t) => {
  const { make } = setup(t);
  const store = make();
  assert.equal(store.activeCount(), 0);
  assert.deepEqual(store.health(), { ok: true, error: null });
});

test('rotation: each create is a new credential, and revoking one leaves the others', (t) => {
  const { make } = setup(t);
  const store = make();
  const a = store.create('admin');
  const b = store.create('admin');
  assert.notEqual(a.credential, b.credential);
  store.revoke(a.id);
  assert.equal(store.verify('admin', a.credential), null);
  assert.ok(store.verify('admin', b.credential));
  assert.equal(store.activeCount(), 1);
});

test('revoke persists: a second store sees it', (t) => {
  const { make } = setup(t);
  const store = make();
  const a = store.create('admin');
  store.revoke(a.id);
  assert.equal(make().verify('admin', a.credential), null);
});

test('preview sessions: bound to a valid admin parent, expiring with it, and revoked with it', (t) => {
  const { make, clock } = setup(t);
  const store = make();
  const admin = store.create('admin');
  clock.t += 3600000;
  const preview = store.create('preview', { parentId: admin.id });
  assert.equal(preview.expires, admin.expires, 'ends when its admin session does');
  assert.ok(store.verify('preview', preview.credential));
  assert.equal(store.verify('admin', preview.credential), null, 'a preview credential is no admin credential');
  assert.equal(store.verify('preview', admin.credential), null, 'an admin credential is no preview credential');
  store.revoke(admin.id);
  assert.equal(store.verify('preview', preview.credential), null);
});

test('a preview session needs a valid parent: unknown, expired and non-admin parents are refused', (t) => {
  const { make, clock } = setup(t);
  const store = make();
  assert.throws(() => store.create('preview', { parentId: 'f'.repeat(64) }));
  assert.throws(() => store.create('preview'));
  const admin = store.create('admin');
  const preview = store.create('preview', { parentId: admin.id });
  assert.throws(() => store.create('preview', { parentId: preview.id }), 'a preview is not a parent');
  clock.t += DAY;
  assert.throws(() => store.create('preview', { parentId: admin.id }));
});

test('verify of a preview session needs its parent to verify too', (t) => {
  const { make, file } = setup(t);
  const store = make();
  const admin = store.create('admin');
  const preview = store.create('preview', { parentId: admin.id });
  // remove only the parent from the file (a hand edit / partial write): the child must not stand alone
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  parsed.sessions = parsed.sessions.filter((r) => r.kind === 'preview');
  fs.writeFileSync(file, JSON.stringify(parsed));
  assert.equal(make().verify('preview', preview.credential), null);
});

test('revokeAll signs out every device, returns the count of admin sessions, and persists', (t) => {
  const { make } = setup(t);
  const store = make();
  const a = store.create('admin');
  const b = store.create('admin');
  const p = store.create('preview', { parentId: a.id });
  assert.deepEqual(store.revokeAll(), { count: 2 });
  for (const s of [a, b]) assert.equal(store.verify('admin', s.credential), null);
  assert.equal(store.verify('preview', p.credential), null);
  const second = make();
  assert.equal(second.verify('admin', a.credential), null);
  assert.equal(second.activeCount(), 0);
});

test('revokeAll with nothing active returns 0 and writes nothing (local mode never creates the panel folder)', (t) => {
  const { make, dir } = setup(t);
  assert.deepEqual(make().revokeAll(), { count: 0 });
  assert.equal(fs.existsSync(path.join(dir, 'panel')), false);
});

test('Ma11 shape: another process (the CLI) revoking all is noticed by the RUNNING store before its next check', (t) => {
  const { make, clock, file } = setup(t);
  const panel = make();
  const { credential } = panel.create('admin');
  assert.ok(panel.verify('admin', credential));
  // a separate store object over the same file stands in for the CLI process
  clock.t += 5;
  const cli = make();
  assert.deepEqual(cli.revokeAll(), { count: 1 });
  assert.equal(panel.verify('admin', credential), null, 'the running panel reloaded the changed file');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.length, 0);
});

test('the running store re-reads before it writes: a session created by another process survives its create', (t) => {
  const { make } = setup(t);
  const panel = make();
  const other = make();
  const theirs = other.create('admin');
  const mine = panel.create('admin');
  const third = make();
  assert.ok(third.verify('admin', theirs.credential));
  assert.ok(third.verify('admin', mine.credential));
});

test('a deleted sessions file signs everyone out at the next check', (t) => {
  const { make, file } = setup(t);
  const store = make();
  const { credential } = store.create('admin');
  fs.unlinkSync(file);
  assert.equal(store.verify('admin', credential), null);
});

test('create failure (the write throws) leaves no session behind and rethrows', { skip: process.platform === 'win32' }, (t) => {
  const { make, dir } = setup(t);
  const store = make();
  fs.mkdirSync(path.join(dir, 'panel'));
  fs.chmodSync(path.join(dir, 'panel'), 0o500);
  t.after(() => {
    try {
      fs.chmodSync(path.join(dir, "panel"), 0o700);
    } catch {
      // the scratch folder may already be gone
    }
  });
  if (process.getuid && process.getuid() === 0) return; // root ignores the mode; nothing to prove
  assert.throws(() => store.create('admin'));
  assert.equal(store.activeCount(), 0);
});

test('the sessions file is created at 0600 inside a 0700 folder', { skip: process.platform === 'win32' }, (t) => {
  const { make, file } = setup(t);
  make().create('admin');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('a randomBytes injection fixes the credential (the digest oracle)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-sess-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = S.createSessionStore({ file: path.join(dir, 'p', 's.json'), randomBytes: () => Buffer.alloc(32, 0xab) });
  store.load();
  const out = store.create('admin');
  assert.equal(out.credential, Buffer.alloc(32, 0xab).toString('base64url'));
  assert.equal(out.id, sha(out.credential));
});
