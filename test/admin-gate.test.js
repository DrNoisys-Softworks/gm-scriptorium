'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hostAllowed, checkRequest } = require('../src/admin/gate');
const { tokenMatches, sessionCookieHeader, parseCookies, cookieName } = require('../src/admin/session');

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-s1-engineering-brief-2026-09-28.md, "Test-first order"
 * item 3). Pure, fake req objects only -- no real socket. Synthetic cast only (NFR-10/NFR-11).
 */

function fakeReq({ headers = {}, url = '/', method = 'GET' } = {}) {
  return { headers, url, method };
}

// --- hostAllowed -------------------------------------------------------------

test('hostAllowed: allowed forms', () => {
  assert.equal(hostAllowed('127.0.0.1:8080', 8080), true);
  assert.equal(hostAllowed('localhost:8080', 8080), true);
  assert.equal(hostAllowed('LOCALHOST:8080', 8080), true);
  assert.equal(hostAllowed('LocalHost:8080', 8080), true);
});

test('hostAllowed: refused forms', () => {
  const P = 8080;
  assert.equal(hostAllowed(undefined, P), false);
  assert.equal(hostAllowed('', P), false);
  assert.equal(hostAllowed('127.0.0.1', P), false);
  assert.equal(hostAllowed(`127.0.0.1:${P + 1}`, P), false);
  assert.equal(hostAllowed(`127.0.0.1:0${P}`, P), false);
  assert.equal(hostAllowed(`[::1]:${P}`, P), false);
  assert.equal(hostAllowed(`127.1:${P}`, P), false);
  assert.equal(hostAllowed(`2130706433:${P}`, P), false);
  assert.equal(hostAllowed(`0x7f.0.0.1:${P}`, P), false);
  assert.equal(hostAllowed(`localhost.:${P}`, P), false);
  assert.equal(hostAllowed(`evil.example:${P}`, P), false);
  assert.equal(hostAllowed(`127.0.0.1:${P} `, P), false); // trailing space
});

// --- checkRequest: order -------------------------------------------------

test('checkRequest: order — bad Host plus a malformed URL gives host', () => {
  const req = fakeReq({ headers: { host: 'evil.example:9' }, url: '/%E0%A4%A' });
  const result = checkRequest(req, { listener: 'admin', ownPort: 9, adminPort: 9, isAuthenticated: () => true });
  assert.deepEqual(result, { ok: false, status: 403, reason: 'host' });
});

// --- checkRequest: URL ----------------------------------------------------

test('checkRequest: URL — malformed percent-encoding, absolute-form, and a NUL byte each give 400 url', () => {
  const P = 9;
  const base = { host: `127.0.0.1:${P}` };
  for (const url of ['/%E0%A4%A', 'http://evil/', '/%00']) {
    const req = fakeReq({ headers: base, url });
    const result = checkRequest(req, { listener: 'admin', ownPort: P, adminPort: P, isAuthenticated: () => true });
    assert.deepEqual(result, { ok: false, status: 400, reason: 'url' }, `url=${url}`);
  }
});

// --- checkRequest: method --------------------------------------------------

test('checkRequest: method — PUT, DELETE, OPTIONS on admin give 405; POST on preview gives 405', () => {
  const P = 9;
  for (const method of ['PUT', 'DELETE', 'OPTIONS']) {
    const req = fakeReq({ headers: { host: `127.0.0.1:${P}` }, url: '/api/session', method });
    const result = checkRequest(req, { listener: 'admin', ownPort: P, adminPort: P, isAuthenticated: () => true });
    assert.deepEqual(result, { ok: false, status: 405, reason: 'method' }, method);
  }
  const req = fakeReq({ headers: { host: `127.0.0.1:${P}` }, url: '/', method: 'POST' });
  const result = checkRequest(req, { listener: 'preview', ownPort: P, adminPort: 1, isAuthenticated: () => true });
  assert.deepEqual(result, { ok: false, status: 405, reason: 'method' });
});

// --- checkRequest: Origin ---------------------------------------------------

test('checkRequest: Origin refusals', () => {
  const P = 9;
  const Q = 10;
  const host = `127.0.0.1:${P}`;
  const cases = [
    undefined,
    'null',
    `http://127.0.0.1:${Q}`,
    `http://127.0.0.1:${P + 1}`,
    `https://127.0.0.1:${P}`,
    `http://127.0.0.1:${P}/`,
    `http://localhost:${P}`, // Host names 127.0.0.1
    'http://evil.example',
  ];
  for (const origin of cases) {
    const headers = { host, 'content-type': 'text/plain' };
    if (origin !== undefined) headers.origin = origin;
    const req = fakeReq({ headers, url: '/api/noop', method: 'POST' });
    const result = checkRequest(req, { listener: 'admin', ownPort: P, adminPort: P, isAuthenticated: () => true });
    assert.deepEqual(result, { ok: false, status: 403, reason: 'origin' }, `origin=${origin}`);
  }
});

test('checkRequest: Origin positives — the matching 127.0.0.1 and localhost pairs', () => {
  const P = 9;
  for (const hostName of ['127.0.0.1', 'localhost']) {
    const host = `${hostName}:${P}`;
    const req = fakeReq({ headers: { host, origin: `http://${hostName}:${P}` }, url: '/api/noop', method: 'POST' });
    const result = checkRequest(req, { listener: 'admin', ownPort: P, adminPort: P, isAuthenticated: () => true });
    assert.equal(result.ok, true, hostName);
    assert.equal(result.pathname, '/api/noop');
  }
});

// --- checkRequest: auth skip / require -------------------------------------

test('checkRequest: /auth and /assets/app.js pass unauthenticated; /, /api/session and /api/noop do not', () => {
  const P = 9;
  const host = `127.0.0.1:${P}`;
  const alwaysFalse = () => false;

  for (const url of ['/auth', '/assets/app.js']) {
    const req = fakeReq({ headers: { host }, url });
    const result = checkRequest(req, { listener: 'admin', ownPort: P, adminPort: P, isAuthenticated: alwaysFalse });
    assert.equal(result.ok, true, url);
  }

  for (const url of ['/', '/api/session', '/api/noop']) {
    const method = url === '/api/noop' ? 'POST' : 'GET';
    const headers = { host };
    if (method === 'POST') headers.origin = `http://${host}`;
    const req = fakeReq({ headers, url, method });
    const result = checkRequest(req, { listener: 'admin', ownPort: P, adminPort: P, isAuthenticated: alwaysFalse });
    assert.deepEqual(result, { ok: false, status: 403, reason: 'token' }, url);
  }
});

// --- session.js --------------------------------------------------------------

test('tokenMatches: exact match, a flipped last character, extreme lengths, undefined and empty — never throws', () => {
  const token = 'a'.repeat(43);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token.slice(0, -1) + 'b', token), false);
  assert.equal(tokenMatches('x', token), false);
  assert.equal(tokenMatches('y'.repeat(1000), token), false);
  assert.equal(tokenMatches(undefined, token), false);
  assert.equal(tokenMatches('', token), false);
});

test('cookie parsing: decoys, a same-name decoy before the real cookie, and the wrong-port name', () => {
  const name = cookieName(9);
  const token = 'realtoken';
  const header = `decoy=1; ${name}=notthetoken; other=2; ${name}=${token}`;
  const cookies = parseCookies(header);
  const matches = cookies.filter(([n]) => n === name).map(([, v]) => v);
  assert.deepEqual(matches, ['notthetoken', token]);

  const wrongPortName = cookieName(10);
  assert.notEqual(wrongPortName, name);
});

test('sessionCookieHeader: the exact literal', () => {
  assert.equal(
    sessionCookieHeader(9, 'TOK'),
    'scriptorium_admin_9=TOK; Path=/; HttpOnly; SameSite=Strict',
  );
});

// --- Mutation proofs (broken by hand, red confirmed, then restored) --------
//
// M1  drop `host` from the allowlist check            -> test/admin-cli.test.js A2
// M2  hostAllowed always returns true                  -> hostAllowed refused-forms test above
// M3  port compare becomes startsWith                  -> `:P+1`, `:0P` cases above
// M4  case-sensitive host compare                       -> `LOCALHOST:P` positive above
// M5  remove the Origin check                            -> Origin refusals above + admin-http sweep
// M6  a missing Origin passes                            -> Origin refusals (missing case) above
// M7  Origin compare becomes startsWith('http://127.0.0.1:') -> preview-origin case above
// M8a tokenMatches compares only a prefix                -> last-character-flipped case above
// M8b remove the sha256 hashing (raw timingSafeEqual)     -> wrong-length case above (would throw)
// M12 remove the decode try/catch                        -> malformed-URL test above
