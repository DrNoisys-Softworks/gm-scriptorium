'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkRequest } = require('../src/admin/gate');
const { gateProfile } = require('../src/remote/settings');

/*
 * ADR 0028, section 7. The Origin exception for the launch-code exchange, on fake requests. The
 * launcher file is a file: page, so its POST carries `Origin: null`. The gate accepts that for
 * exactly one request: POST /auth/launch, from a loopback-kind caller, on a process that has a code
 * store (launchExchange). Everything else keeps the exact-Origin rule.
 */

const PORT = 7400;
const LOOPBACK_ORIGIN = `http://127.0.0.1:${PORT}`;

const PROXY = gateProfile({
  mode: 'proxy',
  port: PORT,
  preview_port: 7401,
  admin_url: 'https://scriptorium.home.arpa',
  preview_url: 'https://preview.scriptorium.home.arpa',
  bind: '192.0.2.42',
  trusted_proxies: ['198.51.100.20'],
});
const FWD = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' };

function req({ host = `127.0.0.1:${PORT}`, headers = {}, url = '/', method = 'POST', peer = '127.0.0.1' } = {}) {
  const raw = ['Host', host];
  for (const [k, v] of Object.entries(headers)) raw.push(k, v);
  return { headers: { host, ...headers }, rawHeaders: raw, url, method, socket: { remoteAddress: peer } };
}

function gate(r, { launchExchange, authed = false, access = null, listener = 'admin' } = {}) {
  const calls = [];
  const opts = { listener, ownPort: listener === 'admin' ? PORT : 7401, adminPort: PORT, access, isAuthenticated: (rq, kind) => (calls.push(kind), authed) };
  if (launchExchange !== undefined) opts.launchExchange = launchExchange;
  return { result: checkRequest(r, opts), calls };
}

const NULL_ORIGIN = { origin: 'null' };

test('Origin: null is accepted for POST /auth/launch from loopback when the process has a code store, and auth is skipped', () => {
  const { result, calls } = gate(req({ url: '/auth/launch', headers: NULL_ORIGIN }), { launchExchange: true });
  assert.equal(result.ok, true);
  assert.equal(result.pathname, '/auth/launch');
  assert.equal(result.kind, 'loopback');
  assert.deepEqual(calls, [], 'no cookie is needed to exchange a code');
});

test('the exact loopback Origin is still accepted for /auth/launch', () => {
  const { result } = gate(req({ url: '/auth/launch', headers: { origin: LOOPBACK_ORIGIN } }), { launchExchange: true });
  assert.equal(result.ok, true);
});

test('Origin: null is refused (origin) when launchExchange is false or absent: a serve --admin process has no exception', () => {
  for (const flag of [false, undefined]) {
    const { result } = gate(req({ url: '/auth/launch', headers: NULL_ORIGIN }), { launchExchange: flag });
    assert.equal(result.ok, false, String(flag));
    assert.equal(result.status, 403);
    assert.equal(result.reason, 'origin');
  }
});

test('Origin: null is refused (origin) on every other POST path, even with a code store and a session', () => {
  for (const url of ['/api/noop', '/auth', '/api/setup/commit', '/auth/password', '/api/preview', '/auth/launch/x', '/auth/launcher', '/api/welcome/dismiss']) {
    const { result } = gate(req({ url, headers: NULL_ORIGIN }), { launchExchange: true, authed: true });
    assert.equal(result.ok, false, url);
    assert.equal(result.reason, 'origin', url);
  }
});

test('Origin: null is refused on the preview listener, which accepts no POST at all', () => {
  const { result } = gate(req({ url: '/auth/launch', headers: NULL_ORIGIN, host: '127.0.0.1:7401' }), { launchExchange: true, listener: 'preview' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'method');
});

test('other Origins are refused for /auth/launch: wrong, empty, missing, a lookalike of null', () => {
  for (const headers of [{ origin: 'http://evil.example' }, { origin: '' }, {}, { origin: 'NULL' }, { origin: ' null' }, { origin: 'null ' }, { origin: 'file://' }]) {
    const { result } = gate(req({ url: '/auth/launch', headers }), { launchExchange: true });
    assert.equal(result.ok, false, JSON.stringify(headers));
    assert.equal(result.reason, 'origin', JSON.stringify(headers));
  }
});

test('a remote-kind request for /auth/launch is refused with kind (correct remote Origin) or origin (null), whatever launchExchange says', () => {
  const remote = (headers) =>
    req({ host: 'scriptorium.home.arpa', peer: '198.51.100.20', url: '/auth/launch', headers: { ...FWD, ...headers } });
  for (const launchExchange of [true, false]) {
    const exact = gate(remote({ origin: 'https://scriptorium.home.arpa' }), { launchExchange, access: PROXY });
    assert.equal(exact.result.ok, false);
    assert.equal(exact.result.reason, 'kind');
    assert.deepEqual(exact.calls, [], 'refused before auth');
    const nul = gate(remote(NULL_ORIGIN), { launchExchange, access: PROXY });
    assert.equal(nul.result.ok, false);
    assert.equal(nul.result.reason, 'origin');
  }
});

test('with a remote profile, a loopback-kind caller still gets the exception (the launcher always targets 127.0.0.1)', () => {
  const { result } = gate(req({ url: '/auth/launch', headers: NULL_ORIGIN }), { launchExchange: true, access: PROXY });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'loopback');
});

test('auth is skipped only for /auth/launch among the new paths: a sibling path still needs a session', () => {
  const ok = gate(req({ url: '/auth/launch', headers: { origin: LOOPBACK_ORIGIN } }), { launchExchange: true, authed: false });
  assert.equal(ok.result.ok, true);
  for (const url of ['/auth/launcher', '/auth/launch/x', '/api/launch']) {
    const r = gate(req({ url, headers: { origin: LOOPBACK_ORIGIN } }), { launchExchange: true, authed: false });
    assert.equal(r.result.ok, false, url);
    assert.equal(r.result.reason, 'token', url);
  }
});

test('a GET to /auth/launch is not an exchange: the gate has no Origin rule for a GET, and the router has no GET route for it', () => {
  const { result } = gate(req({ url: '/auth/launch', method: 'GET' }), { launchExchange: true, authed: false });
  assert.equal(result.ok, true);
  assert.equal(result.pathname, '/auth/launch');
});

test('a bad Host is refused before the Origin exception is considered', () => {
  const { result } = gate(req({ url: '/auth/launch', headers: NULL_ORIGIN, host: 'evil.example:7400' }), { launchExchange: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'host');
});
