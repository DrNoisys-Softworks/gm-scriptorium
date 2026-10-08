'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../src/remote/audit');

/*
 * V1.5a (SD-a8). The audit log: a fixed key list, sanitising, the browser family, read-back with
 * the whitelist re-applied, the 90-day prune that never throws, and health.
 */

const DAY = 86400000;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'panel', 'audit.log');
  const clock = { t: Date.UTC(2026, 9, 3, 12, 0, 0), now: () => clock.t };
  const log = A.createAuditLog({ file, now: clock.now });
  return { dir, file, clock, log };
}

test('AUDIT_KEYS is exactly the stated list', () => {
  assert.deepEqual(
    [...A.AUDIT_KEYS],
    ['t', 'event', 'method', 'result', 'via', 'from', 'browser', 'campaign', 'route', 'status', 'until', 'count', 'refused', 'by', 'changed', 'mode', 'fingerprint', 'trust', 'source', 'affected'],
  );
});

test('append stamps t from the clock and writes one JSON line', (t) => {
  const { log, file } = setup(t);
  log.append({ event: 'signin', method: 'password', result: 'ok', via: 'remote', from: '198.51.100.20', browser: 'Firefox', campaign: 'alpha' });
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '');
  assert.deepEqual(JSON.parse(lines[0]), {
    t: '2026-10-03T12:00:00.000Z',
    event: 'signin',
    method: 'password',
    result: 'ok',
    via: 'remote',
    from: '198.51.100.20',
    browser: 'Firefox',
    campaign: 'alpha',
  });
});

test('append can stamp an explicit time (the lockout-end `at`), overriding any t the caller supplied', (t) => {
  const { log, file } = setup(t);
  log.append({ event: 'lockout-end', refused: 3, t: 'forged' }, { at: Date.UTC(2026, 0, 1) });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).t, '2026-01-01T00:00:00.000Z');
});

test('SD-a8: a key outside the whitelist is dropped (password, token, cookie, body, nested objects)', (t) => {
  const { log, file } = setup(t);
  log.append({
    event: 'signin',
    password: 'hunter2hunter2',
    token: 'TOK',
    cookie: '__Host-scriptorium_session=abc',
    body: '{"password":"x"}',
    credential: 'c',
    nested: { password: 'p' },
    result: 'refused',
  });
  const text = fs.readFileSync(file, 'utf8');
  for (const secret of ['hunter2hunter2', 'TOK', '__Host-', 'password', 'credential', 'nested']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['event', 'result', 't']);
});

test('sanitising: control characters stripped, strings capped at 256, objects and non-finite numbers dropped, only `changed` may be an array of strings', () => {
  const dirty = A.sanitize({
    event: 'sign\u0000in\r\n\u001b[31m\u007f\u0085\u2028\u2029x',
    from: 'a'.repeat(300),
    status: 200,
    count: Infinity,
    until: NaN,
    refused: 0,
    mode: null,
    trust: true,
    route: { a: 1 },
    changed: ['mode', 5, 'po\u0000rt', { x: 1 }],
    via: ['array'],
  });
  assert.equal(dirty.event, 'signin[31mx');
  assert.equal(dirty.from.length, 256);
  assert.equal(dirty.status, 200);
  assert.equal(dirty.refused, 0);
  assert.equal(dirty.mode, null);
  assert.equal(dirty.trust, true);
  assert.ok(!('count' in dirty));
  assert.ok(!('until' in dirty));
  assert.ok(!('route' in dirty));
  assert.ok(!('via' in dirty));
  assert.deepEqual(dirty.changed, ['mode', 'port']);
});

test('sanitize of a non-object is an empty object, and never mutates its input', () => {
  assert.deepEqual(A.sanitize(null), {});
  assert.deepEqual(A.sanitize('x'), {});
  const input = { event: 'a\u0000b', password: 'x' };
  const copy = { ...input };
  A.sanitize(input);
  assert.deepEqual(input, copy);
});

test('browserFamily: the sequence Edge, Firefox, Chrome, Safari, curl, other, and never the raw string', () => {
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
  const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  assert.equal(A.browserFamily(edge), 'Edge');
  assert.equal(A.browserFamily('Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 EdgA/130'), 'Edge');
  assert.equal(A.browserFamily(chrome), 'Chrome');
  assert.equal(A.browserFamily(firefox), 'Firefox');
  assert.equal(A.browserFamily('Mozilla/5.0 (iPhone) AppleWebKit/605 FxiOS/131 Safari/605'), 'Firefox');
  assert.equal(A.browserFamily('Mozilla/5.0 (iPhone) AppleWebKit/605 CriOS/130 Safari/604'), 'Chrome');
  assert.equal(A.browserFamily(safari), 'Safari');
  assert.equal(A.browserFamily('curl/8.5.0'), 'curl');
  assert.equal(A.browserFamily('Wget/1.21'), 'other');
  assert.equal(A.browserFamily(''), 'other');
  assert.equal(A.browserFamily(undefined), 'other');
  assert.equal(A.browserFamily(['curl/1']), 'other');
  assert.equal(A.browserFamily('not curl/8'), 'other');
});

test('read returns newest first, since a cutoff, with a limit and a truncated flag', (t) => {
  const { log, clock } = setup(t);
  for (let i = 0; i < 5; i++) {
    clock.t = Date.UTC(2026, 9, 3, 0, i, 0);
    log.append({ event: 'signin', result: 'ok', count: i });
  }
  const all = log.read();
  assert.deepEqual(all.entries.map((e) => e.count), [4, 3, 2, 1, 0]);
  assert.equal(all.truncated, false);
  const some = log.read({ limit: 2 });
  assert.deepEqual(some.entries.map((e) => e.count), [4, 3]);
  assert.equal(some.truncated, true);
  const since = log.read({ sinceMs: Date.UTC(2026, 9, 3, 0, 3, 0) });
  assert.deepEqual(since.entries.map((e) => e.count), [4, 3]);
});

test('read skips and counts malformed lines, reapplies the whitelist, and tolerates a missing file', (t) => {
  const { log, file, dir } = setup(t);
  assert.deepEqual(log.read(), { entries: [], truncated: false, malformed: 0 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ t: '2026-10-03T00:00:00.000Z', event: 'signin', password: 'hunter2hunter2', from: '198.51.100.20\u0000' }),
      'not json',
      '[1,2]',
      '"a string"',
      '',
      JSON.stringify({ t: '2026-10-03T00:01:00.000Z', event: 'signout' }),
    ].join('\n'),
  );
  const out = log.read();
  assert.equal(out.malformed, 3);
  assert.equal(out.entries.length, 2);
  assert.equal(JSON.stringify(out.entries).includes('hunter2'), false);
  assert.equal(out.entries[1].from, '198.51.100.20');
  assert.ok(dir);
});

test('prune drops entries older than 90 days, keeps unparseable lines, and rewrites at 0600', { skip: process.platform === 'win32' }, (t) => {
  const { log, file } = setup(t);
  const now = Date.UTC(2026, 9, 3);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = new Date(now - 90 * DAY - 1).toISOString();
  const edge = new Date(now - 90 * DAY).toISOString();
  const fresh = new Date(now - DAY).toISOString();
  fs.writeFileSync(file, [JSON.stringify({ t: old, event: 'old' }), JSON.stringify({ t: edge, event: 'edge' }), JSON.stringify({ t: fresh, event: 'fresh' }), 'garbage line', JSON.stringify({ event: 'no-time' })].join('\n') + '\n');
  log.prune(now);
  const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(kept.map((l) => (l.startsWith('{') ? JSON.parse(l).event : l)), ['edge', 'fresh', 'garbage line', 'no-time']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('prune never throws: a missing file, and an injected rename failure (the build/run.js pattern)', (t) => {
  const { log, file } = setup(t);
  assert.doesNotThrow(() => log.prune(Date.now()));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = Date.UTC(2026, 9, 3);
  fs.writeFileSync(file, JSON.stringify({ t: new Date(now - 100 * DAY).toISOString(), event: 'old' }) + '\n');
  const original = fs.renameSync;
  t.after(() => {
    fs.renameSync = original;
  });
  fs.renameSync = () => {
    const err = new Error('EBUSY: locked');
    err.code = 'EBUSY';
    throw err;
  };
  assert.doesNotThrow(() => log.prune(now));
  fs.renameSync = original;
  assert.ok(fs.readFileSync(file, 'utf8').includes('old'), 'the file is unchanged when the rewrite fails');
});

test('prune leaves a file with nothing to drop untouched (no rewrite)', (t) => {
  const { log, file } = setup(t);
  const now = Date.UTC(2026, 9, 3);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ t: new Date(now).toISOString(), event: 'fresh' }) + '\n');
  const before = fs.statSync(file).ino;
  log.prune(now);
  assert.equal(fs.statSync(file).ino, before);
});

test('health: ok until an append fails, then ok:false with a message; the next success clears it', (t) => {
  const { log, file, clock } = setup(t);
  assert.deepEqual(log.health(), { ok: true, lastError: null });
  fs.mkdirSync(file, { recursive: true }); // the log path is a directory: append must fail
  assert.throws(() => log.append({ event: 'signin' }), (err) => err.code === 'EISDIR');
  const h = log.health();
  assert.equal(h.ok, false);
  assert.equal(h.lastError.message, 'EISDIR');
  assert.equal(h.lastError.at, new Date(clock.t).toISOString());
  fs.rmSync(file, { recursive: true });
  log.append({ event: 'signin' });
  assert.deepEqual(log.health(), { ok: true, lastError: null });
});

test('writable: true for a normal log (creating it at 0600), false when the path is a directory, with no line written', { skip: process.platform === 'win32' }, (t) => {
  const { log, file } = setup(t);
  assert.equal(log.writable(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(log.writable(), false);
  assert.equal(log.health().ok, false);
});

test('isInsideVault refuses to write: append throws and writable is false, and nothing is created', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'panel', 'audit.log');
  const log = A.createAuditLog({ file, isInsideVault: () => true });
  assert.throws(() => log.append({ event: 'signin' }), (err) => err.code === 'EVAULT');
  assert.equal(log.writable(), false);
  assert.equal(fs.existsSync(path.join(dir, 'panel')), false);
});
