'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkRequest } = require('../src/admin/gate');
const { gateProfile } = require('../src/remote/settings');

/*
 * V1.5a (SD-a4). The gate with a remote access profile, on FAKE requests that carry rawHeaders and
 * a socket. A fake request proves the classification and the sequence; the peer rule itself is proved
 * on real sockets (test/remote-listener.test.js, test/remote-http.test.js), not here.
 */

const ADMIN_PORT = 7400;
const PREVIEW_PORT = 7401;

const PROXY = gateProfile({
  mode: 'proxy',
  port: ADMIN_PORT,
  preview_port: PREVIEW_PORT,
  admin_url: 'https://scriptorium.home.arpa',
  preview_url: 'https://preview.scriptorium.home.arpa',
  bind: '192.0.2.42',
  trusted_proxies: ['198.51.100.20'],
});
const TAILSCALE = gateProfile({
  mode: 'tailscale',
  port: ADMIN_PORT,
  preview_port: PREVIEW_PORT,
  admin_url: 'https://panel-host.example-tailnet.ts.net',
  preview_url: 'https://panel-host.example-tailnet.ts.net:8443',
});
// An inert-in-V1.5a shape, tested now so V1.5b never reworks the gate.
const DIRECT = gateProfile(
  { mode: 'direct', port: ADMIN_PORT, preview_port: PREVIEW_PORT, admin_url: 'https://192.0.2.42:7400', preview_url: 'https://192.0.2.42:7401', bind: '192.0.2.42' },
  { tls: true },
);

function req({ host = 'scriptorium.home.arpa', headers = {}, url = '/', method = 'GET', peer = '198.51.100.20', encrypted, rawHosts, extraRaw = [] } = {}) {
  const h = { ...(host === null ? {} : { host }), ...headers };
  const raw = [];
  const hosts = rawHosts !== undefined ? rawHosts : host === null ? [] : [host];
  for (const v of hosts) raw.push('Host', v);
  for (const [k, v] of Object.entries(headers)) raw.push(k, v);
  raw.push(...extraRaw);
  const socket = { remoteAddress: peer };
  if (encrypted !== undefined) socket.encrypted = encrypted;
  return { headers: h, rawHeaders: raw, url, method, socket };
}

function gate(r, { listener = 'admin', access = PROXY, authed = true } = {}) {
  const calls = [];
  const result = checkRequest(r, {
    listener,
    ownPort: listener === 'admin' ? ADMIN_PORT : PREVIEW_PORT,
    adminPort: ADMIN_PORT,
    access,
    isAuthenticated: (rq, kind) => {
      calls.push(kind);
      return authed;
    },
  });
  return { result, calls };
}

const FWD = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' };

// --- success shape and classification ------------------------------------------

test('a remote request from the trusted proxy: ok, kind remote, clientAddress is the proxy-appended entry', () => {
  const { result, calls } = gate(req({ headers: { ...FWD, 'x-forwarded-for': '203.0.113.9, 198.51.100.77' }, url: '/api/session' }));
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'remote');
  assert.equal(result.clientAddress, '198.51.100.77');
  assert.equal(result.pathname, '/api/session');
  assert.deepEqual(calls, ['remote']);
});

test('a loopback request from a loopback peer: ok, kind loopback, clientAddress is the peer, and XFF is ignored (Ma1)', () => {
  const { result, calls } = gate(
    req({ host: `127.0.0.1:${ADMIN_PORT}`, peer: '::ffff:127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }, url: '/api/session' }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'loopback');
  assert.equal(result.clientAddress, '127.0.0.1');
  assert.deepEqual(calls, ['loopback']);
});

test('with no profile (local and ssh), the success result gains kind loopback and the normalised peer, nothing else changes', () => {
  const r = { headers: { host: `127.0.0.1:${ADMIN_PORT}` }, url: '/x?a=1', method: 'GET', socket: { remoteAddress: '::ffff:127.0.0.1' } };
  const { result } = gate(r, { access: null });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'loopback');
  assert.equal(result.clientAddress, '127.0.0.1');
  assert.equal(result.query.get('a'), '1');
  const bare = { headers: { host: `127.0.0.1:${ADMIN_PORT}` }, url: '/', method: 'GET' };
  assert.equal(gate(bare, { access: null }).result.clientAddress, null);
  const omitted = checkRequest(bare, { listener: 'admin', ownPort: ADMIN_PORT, isAuthenticated: () => true });
  assert.equal(omitted.clientAddress, null);
});

test('with no profile, an external Host is just a host refusal (today\'s behaviour)', () => {
  const { result } = gate(req({ host: 'scriptorium.home.arpa' }), { access: null });
  assert.deepEqual(result, { ok: false, status: 403, reason: 'host' });
});

// --- Host matrix (remote profile) ------------------------------------------------

const HOST_REFUSALS = [
  ['the raw LAN address', '192.0.2.42'],
  ['the raw LAN address with the panel port', `192.0.2.42:${ADMIN_PORT}`],
  ['a trailing dot', 'scriptorium.home.arpa.'],
  ['a wrong port', 'scriptorium.home.arpa:7400'],
  ['a name with a prefix', 'evil.scriptorium.home.arpa'],
  ['a name with a suffix (Ma13)', 'scriptorium.home.arpa.evil.example'],
  ['the preview name on the admin listener', 'preview.scriptorium.home.arpa'],
  ['an empty Host', ''],
  ['loopback on the wrong port', `127.0.0.1:${PREVIEW_PORT}`],
  ['an IPv6 loopback', `[::1]:${ADMIN_PORT}`],
  ['localhost with a trailing dot', `localhost.:${ADMIN_PORT}`],
  ['a space', 'scriptorium.home.arpa '],
];

for (const [label, host] of HOST_REFUSALS) {
  test(`Host matrix: ${label} gives 403 host, before the peer, proto or auth checks run`, () => {
    const { result, calls } = gate(req({ host, headers: FWD, peer: '203.0.113.200' }));
    assert.deepEqual(result, { ok: false, status: 403, reason: 'host' });
    assert.deepEqual(calls, []);
  });
}

test('Host matrix: a missing Host gives 403 host', () => {
  assert.deepEqual(gate(req({ host: null, headers: FWD })).result, { ok: false, status: 403, reason: 'host' });
});

test('Host matrix: the external host matches case-insensitively', () => {
  const { result } = gate(req({ host: 'ScriptoRium.HOME.arpa', headers: FWD }));
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'remote');
});

test('Host matrix: the tailscale preview host keeps its port, compared exactly', () => {
  const ok = gate(req({ host: 'panel-host.example-tailnet.ts.net:8443', headers: FWD, peer: '127.0.0.1' }), { listener: 'preview', access: TAILSCALE, authed: true });
  assert.equal(ok.result.ok, true);
  const wrong = gate(req({ host: 'panel-host.example-tailnet.ts.net:8444', headers: FWD, peer: '127.0.0.1' }), { listener: 'preview', access: TAILSCALE });
  assert.deepEqual(wrong.result, { ok: false, status: 403, reason: 'host' });
  const bare = gate(req({ host: 'panel-host.example-tailnet.ts.net', headers: FWD, peer: '127.0.0.1' }), { listener: 'preview', access: TAILSCALE });
  assert.deepEqual(bare.result, { ok: false, status: 403, reason: 'host' });
});

test('the admin host is refused on the preview listener, and the preview host on the admin listener', () => {
  assert.equal(gate(req({ host: 'scriptorium.home.arpa', headers: FWD }), { listener: 'preview' }).result.reason, 'host');
  assert.equal(gate(req({ host: 'preview.scriptorium.home.arpa', headers: FWD })).result.reason, 'host');
  assert.equal(gate(req({ host: 'preview.scriptorium.home.arpa', headers: FWD }), { listener: 'preview' }).result.ok, true);
});

// --- Ma22: duplicate Host -----------------------------------------------------------

test('Ma22: duplicate Host headers in rawHeaders give 403 host even when req.headers holds a good one', () => {
  const r = req({ headers: FWD, rawHosts: ['scriptorium.home.arpa', 'scriptorium.home.arpa'] });
  assert.deepEqual(gate(r).result, { ok: false, status: 403, reason: 'host' });
  const mixed = req({ headers: FWD, rawHosts: ['scriptorium.home.arpa', `127.0.0.1:${ADMIN_PORT}`] });
  assert.deepEqual(gate(mixed).result, { ok: false, status: 403, reason: 'host' });
});

test('duplicate Host detection is case-insensitive on the header NAME, and counts exactly one as fine', () => {
  const r = req({ headers: FWD });
  r.rawHeaders.push('HOST', 'scriptorium.home.arpa');
  assert.equal(gate(r).result.reason, 'host');
  assert.equal(gate(req({ headers: FWD })).result.ok, true);
  const lower = req({ headers: FWD });
  lower.rawHeaders = ['host', 'scriptorium.home.arpa', 'x-forwarded-proto', 'https'];
  assert.equal(gate(lower).result.ok, true);
});

test('with no rawHeaders array (a fake request), the duplicate rule is simply not applied', () => {
  const r = req({ headers: FWD });
  delete r.rawHeaders;
  assert.equal(gate(r).result.ok, true);
});

// --- peer and proto -------------------------------------------------------------------

test('Ma12: a loopback-Host request needs a loopback peer: 127.0.0.2 and 127.0.0.20 are refused as peer', () => {
  for (const peer of ['127.0.0.2', '127.0.0.20', '127.0.0.10', '127.0.0.100', '::1:5', '198.51.100.20', '::ffff:127.0.0.2']) {
    const { result } = gate(req({ host: `127.0.0.1:${ADMIN_PORT}`, peer }));
    assert.deepEqual(result, { ok: false, status: 403, reason: 'peer' }, peer);
  }
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(gate(req({ host: `127.0.0.1:${ADMIN_PORT}`, peer })).result.ok, true, peer);
  }
});

test('Ma12: a remote request needs the TRUSTED peer exactly: a string-prefix sibling is refused', () => {
  for (const peer of ['198.51.100.200', '198.51.100.2', '198.51.100.21', '198.51.100.2000', '203.0.113.9', '127.0.0.1']) {
    const { result } = gate(req({ headers: FWD, peer }));
    assert.deepEqual(result, { ok: false, status: 403, reason: 'peer' }, peer);
  }
  assert.equal(gate(req({ headers: FWD, peer: '::ffff:198.51.100.20' })).result.ok, true, 'a mapped spelling of the trusted peer is the trusted peer');
});

test('a missing socket gives no peer: both kinds are refused as peer when a profile is active', () => {
  const noSocket = req({ headers: FWD });
  delete noSocket.socket;
  assert.equal(gate(noSocket).result.reason, 'peer');
  const loop = req({ host: `127.0.0.1:${ADMIN_PORT}` });
  delete loop.socket;
  assert.equal(gate(loop).result.reason, 'peer');
});

test('proto: X-Forwarded-Proto must be exactly "https" from the trusted peer', () => {
  for (const proto of [undefined, 'http', 'HTTPS', 'https, https', 'https,http', ' https', 'wss']) {
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    if (proto !== undefined) headers['x-forwarded-proto'] = proto;
    assert.deepEqual(gate(req({ headers })).result, { ok: false, status: 403, reason: 'proto' }, String(proto));
  }
});

test('the peer check precedes the proto check: an untrusted peer with a good proto is a peer refusal, a trusted peer with a bad one is proto', () => {
  assert.equal(gate(req({ headers: FWD, peer: '203.0.113.9' })).result.reason, 'peer');
  assert.equal(gate(req({ headers: { 'x-forwarded-proto': 'http' }, peer: '198.51.100.20' })).result.reason, 'proto');
});

test('Ma2: the client address is the RIGHTMOST X-Forwarded-For entry, never the leftmost', () => {
  const { result } = gate(req({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.9.9.9, 203.0.113.9, 198.51.100.77' } }));
  assert.equal(result.clientAddress, '198.51.100.77');
});

test('clientAddress is "unknown" when the trusted peer sent no usable X-Forwarded-For', () => {
  assert.equal(gate(req({ headers: { 'x-forwarded-proto': 'https' } })).result.clientAddress, 'unknown');
  assert.equal(gate(req({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': 'garbage' } })).result.clientAddress, 'unknown');
});

test('X-Forwarded-Host is never read: a hostile value changes nothing, and it cannot make a bad Host good', () => {
  const ok = gate(req({ headers: { ...FWD, 'x-forwarded-host': 'evil.example' } }));
  assert.equal(ok.result.ok, true);
  const bad = gate(req({ host: 'evil.example', headers: { ...FWD, 'x-forwarded-host': 'scriptorium.home.arpa' } }));
  assert.deepEqual(bad.result, { ok: false, status: 403, reason: 'host' });
});

test('tailscale: loopback is the trusted proxy, so a remote request needs a loopback peer and https', () => {
  const host = 'panel-host.example-tailnet.ts.net';
  assert.equal(gate(req({ host, headers: FWD, peer: '127.0.0.1' }), { access: TAILSCALE }).result.ok, true);
  assert.equal(gate(req({ host, headers: FWD, peer: '::1' }), { access: TAILSCALE }).result.ok, true);
  assert.equal(gate(req({ host, headers: FWD, peer: '198.51.100.20' }), { access: TAILSCALE }).result.reason, 'peer');
  assert.equal(gate(req({ host, headers: { 'x-forwarded-proto': 'http' }, peer: '127.0.0.1' }), { access: TAILSCALE }).result.reason, 'proto');
});

test('direct (inert in V1.5a): requireTls means socket.encrypted === true, forwarded headers are ignored, and the peer is the client address', () => {
  const host = '192.0.2.42:7400';
  const plain = gate(req({ host, peer: '203.0.113.9' }), { access: DIRECT });
  assert.deepEqual(plain.result, { ok: false, status: 403, reason: 'proto' });
  const spoof = gate(req({ host, peer: '203.0.113.9', headers: FWD }), { access: DIRECT });
  assert.equal(spoof.result.reason, 'proto', 'X-Forwarded-Proto does not stand in for TLS');
  const tls = gate(req({ host, peer: '203.0.113.9', encrypted: true, headers: { 'x-forwarded-for': '10.0.0.1' } }), { access: DIRECT });
  assert.equal(tls.result.ok, true);
  assert.equal(tls.result.clientAddress, '203.0.113.9');
  assert.equal(gate(req({ host, peer: '203.0.113.9', encrypted: 'true' }), { access: DIRECT }).result.reason, 'proto');
});

test('direct: the loopback form must still come from a loopback peer', () => {
  assert.equal(gate(req({ host: `127.0.0.1:${ADMIN_PORT}`, peer: '203.0.113.9' }), { access: DIRECT }).result.reason, 'peer');
  assert.equal(gate(req({ host: `127.0.0.1:${ADMIN_PORT}`, peer: '127.0.0.1' }), { access: DIRECT }).result.ok, true);
});

// --- Origin per kind -----------------------------------------------------------------

function post(extra) {
  return req({ method: 'POST', url: '/api/noop', headers: { ...FWD, ...extra } });
}

test('Origin (remote): exactly https://<external host>, nothing else', () => {
  assert.equal(gate(post({ origin: 'https://scriptorium.home.arpa' })).result.ok, true);
  const refused = [
    ['Ma7: the wrong scheme', 'http://scriptorium.home.arpa'],
    ['the literal null', 'null'],
    ['a port added', 'https://scriptorium.home.arpa:443'],
    ['a trailing slash', 'https://scriptorium.home.arpa/'],
    ['a case change', 'https://Scriptorium.Home.Arpa'],
    ['the preview origin (Ma8)', 'https://preview.scriptorium.home.arpa'],
    ['a suffix', 'https://scriptorium.home.arpa.evil.example'],
    ['the loopback origin', `http://127.0.0.1:${ADMIN_PORT}`],
    ['an empty Origin', ''],
  ];
  for (const [label, origin] of refused) assert.deepEqual(gate(post({ origin })).result, { ok: false, status: 403, reason: 'origin' }, label);
  assert.deepEqual(gate(post({})).result, { ok: false, status: 403, reason: 'origin' }, 'a missing Origin');
});

test('Origin (loopback): the request\'s own loopback Host in the listener\'s scheme, unchanged', () => {
  const lp = (origin, access = PROXY) => gate(req({ host: `127.0.0.1:${ADMIN_PORT}`, peer: '127.0.0.1', method: 'POST', url: '/api/noop', headers: origin ? { origin } : {} }), { access });
  assert.equal(lp(`http://127.0.0.1:${ADMIN_PORT}`).result.ok, true);
  assert.equal(lp(`https://127.0.0.1:${ADMIN_PORT}`).result.reason, 'origin');
  assert.equal(lp('https://scriptorium.home.arpa').result.reason, 'origin');
  assert.equal(lp(undefined).result.reason, 'origin');
  // a TLS-serving loopback listener (inert until V1.5b) expects https
  assert.equal(lp(`https://127.0.0.1:${ADMIN_PORT}`, DIRECT).result.ok, true);
  assert.equal(lp(`http://127.0.0.1:${ADMIN_PORT}`, DIRECT).result.reason, 'origin');
});

test('Origin is checked on admin POSTs only: a preview GET carries none, and a preview POST is a 405 first', () => {
  assert.equal(gate(req({ host: 'preview.scriptorium.home.arpa', headers: FWD }), { listener: 'preview' }).result.ok, true);
  assert.deepEqual(gate(req({ host: 'preview.scriptorium.home.arpa', method: 'POST', headers: FWD }), { listener: 'preview' }).result, { ok: false, status: 405, reason: 'method' });
});

// --- order -----------------------------------------------------------------------------

test('order: URL (400) comes after host/peer/proto, and method (405) before Origin (403)', () => {
  assert.equal(gate(req({ headers: FWD, url: '/%E0%A4%A', peer: '203.0.113.9' })).result.reason, 'peer');
  assert.equal(gate(req({ headers: FWD, url: '/%E0%A4%A' })).result.reason, 'url');
  assert.equal(gate(req({ headers: FWD, method: 'PUT' })).result.reason, 'method');
  assert.equal(gate(req({ headers: { ...FWD, origin: 'https://evil.example' }, method: 'POST', url: '/api/noop' }), { authed: false }).result.reason, 'origin');
});

// --- kind-restricted paths and auth ----------------------------------------------------

test('Ma5: /auth on the external Host is refused as kind (the token never signs a remote request in), before auth', () => {
  const { result, calls } = gate(req({ headers: FWD, url: '/auth?token=anything' }), { authed: false });
  assert.deepEqual(result, { ok: false, status: 403, reason: 'kind' });
  assert.deepEqual(calls, []);
});

test('Ma23: /auth/password on a loopback Host is refused as kind; on the external Host it skips auth', () => {
  const lp = gate(req({ host: `127.0.0.1:${ADMIN_PORT}`, peer: '127.0.0.1', method: 'POST', url: '/auth/password', headers: { origin: `http://127.0.0.1:${ADMIN_PORT}` } }));
  assert.deepEqual(lp.result, { ok: false, status: 403, reason: 'kind' });
  const ok = gate(req({ method: 'POST', url: '/auth/password', headers: { ...FWD, origin: 'https://scriptorium.home.arpa' } }), { authed: false });
  assert.equal(ok.result.ok, true);
  assert.deepEqual(ok.calls, []);
});

test('/auth/password refuses a wrong Origin like any admin POST (login CSRF)', () => {
  const r = gate(req({ method: 'POST', url: '/auth/password', headers: { ...FWD, origin: 'https://preview.scriptorium.home.arpa' } }), { authed: false });
  assert.deepEqual(r.result, { ok: false, status: 403, reason: 'origin' });
});

test('the preview /:enter skips auth for a remote request and is refused as kind for a loopback one', () => {
  const remote = gate(req({ host: 'preview.scriptorium.home.arpa', headers: FWD, url: '/:enter?ticket=abc' }), { listener: 'preview', authed: false });
  assert.equal(remote.result.ok, true);
  assert.equal(remote.result.pathname, '/:enter');
  assert.equal(remote.result.query.get('ticket'), 'abc');
  const loop = gate(req({ host: `127.0.0.1:${PREVIEW_PORT}`, peer: '127.0.0.1', url: '/:enter?ticket=abc' }), { listener: 'preview', authed: false });
  assert.deepEqual(loop.result, { ok: false, status: 403, reason: 'kind' });
});

test('auth refusal reasons: a remote request is "session", a loopback request is "token"', () => {
  assert.deepEqual(gate(req({ headers: FWD, url: '/api/session' }), { authed: false }).result, { ok: false, status: 403, reason: 'session' });
  assert.deepEqual(gate(req({ host: `127.0.0.1:${ADMIN_PORT}`, peer: '127.0.0.1', url: '/api/session' }), { authed: false }).result, { ok: false, status: 403, reason: 'token' });
  assert.deepEqual(gate(req({ host: 'preview.scriptorium.home.arpa', headers: FWD, url: '/' }), { listener: 'preview', authed: false }).result, { ok: false, status: 403, reason: 'session' });
});

test('/assets/ is public on both kinds, and nothing else on the admin listener is', () => {
  assert.equal(gate(req({ headers: FWD, url: '/assets/app.js' }), { authed: false }).result.ok, true);
  assert.equal(gate(req({ host: `127.0.0.1:${ADMIN_PORT}`, peer: '127.0.0.1', url: '/assets/app.js' }), { authed: false }).result.ok, true);
  for (const url of ['/', '/open-preview', '/api/remote', '/assets']) {
    assert.equal(gate(req({ headers: FWD, url }), { authed: false }).result.reason, 'session', url);
  }
});

test('the failure shape is exactly { ok, status, reason }, with no extra keys', () => {
  const { result } = gate(req({ host: 'evil.example' }));
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason', 'status']);
});
