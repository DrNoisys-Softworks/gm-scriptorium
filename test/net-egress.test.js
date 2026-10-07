'use strict';

/*
 * The one outgoing connection module (ADR 0024): src/net/egress.js.
 *
 * Every socket here is on this computer. All listeners bind 127.0.0.1 on port 0 (never 11434 or
 * 1234). The production client is only ever called with URLs it must refuse. A loopback guard
 * (test/helpers/net-stubs.js) throws before Node is called for any connect to a pipe, a foreign
 * IP literal or a real-service port, and a recorder answers every name lookup with 127.0.0.1.
 *
 * Tests that pass today and prove nothing (so a Reviewer can refuse them as evidence):
 *  - the DESTINATIONS and DEFAULTS literal pins (they prove the list, not that it is enforced);
 *  - matcher rows with .invalid hosts (they prove the pure function, not the socket path; the
 *    socket tests below are the evidence for "refused before any lookup");
 *  - the proxy test on a Node whose global agent already ignores proxy variables (the control
 *    result is recorded with t.diagnostic).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const {
  DESTINATIONS,
  DEFAULTS,
  validateDestinations,
  matchDestination,
  request,
  createEgressForTests,
} = require('../src/net/egress');
const { NetError } = require('../src/net/errors');
const { createSseParser } = require('../src/net/sse');
const {
  installLoopbackGuard,
  startHttpStub,
  startHttpsStub,
  startTrap,
  startSilentTcp,
  tlsFixture,
  fixtureCaPem,
  untrustedPair,
  sentinel,
  closedPort,
} = require('./helpers/net-stubs');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean());

const entry = (id, port, scheme = 'http') => ({ id, scheme, host: '127.0.0.1', port });
const seam = (entries, testCaPem) => createEgressForTests({ destinations: entries, testCaPem });
const bytes = (s) => Buffer.from(s, 'utf8');

async function rejection(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  assert.fail('expected a rejection');
}

function assertNet(err, code, fields = {}) {
  assert.ok(err instanceof NetError, `expected a NetError, got ${err && err.name}: ${err && err.message}`);
  assert.equal(err.code, code, err.message);
  for (const [k, v] of Object.entries(fields)) assert.equal(err[k], v, `field ${k}`);
  assert.equal(err.cause, undefined);
}

function flood(res, chunk) {
  res.writeHead(200);
  const pump = () => {
    if (res.destroyed || res.writableEnded) return;
    if (res.write(chunk)) setImmediate(pump);
    else res.once('drain', pump);
  };
  pump();
}

// --- literal pins ---------------------------------------------------------------------------------

test('DESTINATIONS is the two local model servers, deep frozen, and cannot be extended', () => {
  assert.deepEqual(DESTINATIONS, [
    { id: 'ollama', scheme: 'http', host: '127.0.0.1', port: 11434 },
    { id: 'lmstudio', scheme: 'http', host: '127.0.0.1', port: 1234 },
  ]);
  assert.ok(Object.isFrozen(DESTINATIONS));
  for (const d of DESTINATIONS) assert.ok(Object.isFrozen(d));
  assert.throws(() => DESTINATIONS.push({ id: 'x', scheme: 'http', host: '127.0.0.1', port: 5 }), TypeError);
  assert.throws(() => {
    DESTINATIONS[0].host = 'example.invalid';
  }, TypeError);
});

test('DEFAULTS is pinned as a literal', () => {
  assert.deepEqual(
    { ...DEFAULTS },
    { connectTimeoutMs: 10000, idleTimeoutMs: 120000, totalTimeoutMs: 600000, maxResponseBytes: 16777216 },
  );
  assert.ok(Object.isFrozen(DEFAULTS));
});

// --- the matcher ----------------------------------------------------------------------------------

const REMOTE = { id: 'remote', scheme: 'https', host: 'api.example.invalid', port: 443 };
const LOCAL = { id: 'local', scheme: 'http', host: '127.0.0.1', port: 8 };
const LIST = [REMOTE, LOCAL];

test('matchDestination accepts exact scheme, host and port, with a case-insensitive host', () => {
  for (const [id, url] of [
    ['remote', 'https://api.example.invalid/v1'],
    ['remote', 'https://API.EXAMPLE.INVALID/v1'],
    ['remote', 'https://api.example.invalid:443/'],
    ['local', 'http://127.0.0.1:8/x'],
  ]) {
    const m = matchDestination(url, LIST, id);
    assert.equal(m.entry.id, id, url);
    assert.ok(m.url instanceof URL);
  }
});

test('matchDestination refuses every near miss, with the reason', () => {
  const rows = [
    ['remote', 'https://evil-api.example.invalid/', 'host'],
    ['remote', 'https://x.api.example.invalid/', 'host'],
    ['remote', 'https://api.example.invalid.evil.invalid/', 'host'],
    ['remote', 'https://xapi.example.invalid/', 'host'],
    ['remote', 'https://api.example.invalid./', 'host'],
    ['remote', 'https://user:pw@api.example.invalid/', 'userinfo'],
    ['remote', 'https://user@api.example.invalid/', 'userinfo'],
    ['remote', 'https://api.example.invalid:444/', 'port'],
    ['remote', 'http://api.example.invalid/', 'scheme'],
    ['remote', 'ftp://api.example.invalid/', 'scheme'],
    ['local', 'http://127.0.0.1:9/', 'port'],
    ['local', 'http://127.0.0.2:8/', 'host'],
    ['nope', 'https://api.example.invalid/', 'unknown-destination'],
  ];
  for (const [id, url, reason] of rows) {
    assert.throws(
      () => matchDestination(url, LIST, id),
      (e) => e instanceof NetError && e.code === 'E_NET_REFUSED' && e.reason === reason,
      `${id} ${url} should be refused for ${reason}`,
    );
  }
  assert.throws(() => matchDestination('not a url', LIST, 'remote'), (e) => e.code === 'E_NET_BAD_URL');
  assert.throws(() => matchDestination(42, LIST, 'remote'), (e) => e.code === 'E_NET_BAD_URL');
});

test('matchDestination re-checks plain http against a raw, unvalidated list', () => {
  const raw = [{ id: 'h', scheme: 'http', host: 'api.example.invalid', port: 80 }];
  assert.throws(
    () => matchDestination('http://api.example.invalid/', raw, 'h'),
    (e) => e.code === 'E_NET_REFUSED' && e.reason === 'plain-http',
  );
});

test('validateDestinations refuses bad lists and accepts good ones', () => {
  const ok = (e) => validateDestinations([e]);
  const bad = (list) => assert.throws(() => validateDestinations(list), (e) => e.code === 'E_NET_BAD_OPTIONS' && e.reason === 'destinations');
  const base = { id: 'a', scheme: 'https', host: 'api.example.invalid', port: 443 };
  bad([{ ...base, scheme: 'http' }]);
  bad([{ ...base, scheme: 'http', host: '192.0.2.10' }]);
  bad([{ ...base, scheme: 'http', host: 'localhost' }]);
  bad([{ ...base, scheme: 'http', host: '127.0.0.256' }]);
  bad([{ ...base, host: 'API.example.invalid' }]);
  bad([{ ...base, host: 'api.example.invalid.' }]);
  bad([base, base]);
  bad([{ ...base, extra: 1 }]);
  bad([{ ...base, port: 0 }]);
  bad([{ ...base, port: 65536 }]);
  bad([{ ...base, port: 1.5 }]);
  bad([{ ...base, scheme: 'ftp' }]);
  bad([{ ...base, id: 'UP' }]);
  bad('nope');
  const v = ok({ id: 'l', scheme: 'http', host: '127.0.0.2', port: 1 });
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v[0]));
  assert.equal(ok(base)[0].host, 'api.example.invalid');
});

test('the test seam reaches only 127.0.0.1 and never the two real-service ports', () => {
  const refuse = (e) => assert.throws(() => seam([e]), (x) => x.code === 'E_NET_BAD_OPTIONS' && x.reason === 'test-destination');
  refuse({ id: 'a', scheme: 'http', host: '127.0.0.2', port: 5 });
  refuse({ id: 'a', scheme: 'https', host: 'api.example.invalid', port: 443 });
  refuse({ id: 'a', scheme: 'http', host: '127.0.0.1', port: 11434 });
  refuse({ id: 'a', scheme: 'http', host: '127.0.0.1', port: 1234 });
  assert.throws(() => seam([{ id: 'a', scheme: 'http', host: '192.0.2.1', port: 5 }]), (x) => x.code === 'E_NET_BAD_OPTIONS');
  assert.ok(Object.isFrozen(seam([entry('a', 5)])));
});

test('request options are a closed allowlist and headers are checked', async () => {
  const url = 'http://refused.invalid:9/';
  const base = { destination: 'ollama', url };
  const unknown = [
    'rejectUnauthorized', 'ca', 'agent', 'lookup', 'socketPath', 'servername', 'checkServerIdentity',
    'insecureHTTPParser', 'proxy', 'createConnection',
  ];
  for (const key of unknown) {
    const e = await rejection(request({ ...base, [key]: key === 'rejectUnauthorized' ? false : 'x' }));
    assertNet(e, 'E_NET_BAD_OPTIONS', { reason: 'unknown-option' });
  }
  const badHeaders = [
    { host: 'x' }, { Host: 'x' }, { connection: 'close' }, { 'content-length': '1' }, { 'Transfer-Encoding': 'chunked' },
    { upgrade: 'h2c' }, { expect: '100-continue' }, { 'keep-alive': 'x' }, { te: 'trailers' }, { trailer: 'x' },
    { 'proxy-authorization': 'x' }, { 'Proxy-Anything': 'x' }, { 'bad name': 'x' }, { '': 'x' },
    { 'x-a': 'one\r\ntwo' }, { 'x-a': 'one\ntwo' }, { 'x-a': 'one\u0000two' }, { 'x-a': 5 },
  ];
  for (const headers of badHeaders) {
    const e = await rejection(request({ ...base, headers }));
    assertNet(e, 'E_NET_BAD_OPTIONS', { reason: 'header' });
  }
  assertNet(await rejection(request({ ...base, body: 'x' })), 'E_NET_BAD_OPTIONS', { reason: 'body' });
  assertNet(await rejection(request({ ...base, method: 'PUT' })), 'E_NET_BAD_OPTIONS', { reason: 'method' });
  assertNet(await rejection(request({ ...base, method: 'POST', body: 5 })), 'E_NET_BAD_OPTIONS', { reason: 'body' });
  assertNet(await rejection(request({ ...base, connectTimeoutMs: 0 })), 'E_NET_BAD_OPTIONS', { reason: 'limit' });
  assertNet(await rejection(request({ ...base, maxResponseBytes: 1.5 })), 'E_NET_BAD_OPTIONS', { reason: 'limit' });
  assertNet(await rejection(request({ ...base, onChunk: 'x' })), 'E_NET_BAD_OPTIONS', { reason: 'callback' });
  assertNet(await rejection(request({ ...base, signal: {} })), 'E_NET_BAD_OPTIONS', { reason: 'signal' });
  assertNet(await rejection(request(null)), 'E_NET_BAD_OPTIONS', { reason: 'options' });
  assertNet(await rejection(request({ destination: 5, url })), 'E_NET_BAD_OPTIONS', { reason: 'destination' });
  assertNet(await rejection(request({ destination: 'ollama', url: 5 })), 'E_NET_BAD_URL');
  assertNet(await rejection(request({ destination: 'ollama', url: 'not a url' })), 'E_NET_BAD_URL');
});

// --- controls for the recorder and the guard --------------------------------------------------------

test('control: the lookup recorder and connect counter see an ordinary Node request to a name', async (t) => {
  const trap = await startTrap(t);
  const before = guard.snapshot();
  const req = http.get({ host: 'ctl.invalid', port: trap.port, agent: false });
  req.on('error', () => {});
  const connected = new Promise((resolve) => req.on('socket', (s) => s.once('connect', resolve)));
  await trap.waitCount(1);
  await connected;
  const after = guard.snapshot();
  req.destroy();
  assert.equal(after.lookups - before.lookups, 1, 'Node looked the name up through the recorder');
  assert.equal(after.connects - before.connects, 1);
  assert.equal(trap.count(), 1);
});

test('control: the guard blocks pipes, foreign addresses and real-service ports before Node is called', () => {
  guard.expectBlocked(() => net.connect({ host: '192.0.2.1', port: 9 }));
  guard.expectBlocked(() => net.connect(9, '192.0.2.1'));
  guard.expectBlocked(() => net.connect({ host: '127.0.0.1', port: 11434 }));
  guard.expectBlocked(() => net.connect({ host: '127.0.0.1', port: 1234 }));
  guard.expectBlocked(() => net.connect(11434));
  guard.expectBlocked(() => new net.Socket().connect({ path: path.join(require('os').tmpdir(), 'scriptorium-guard-ctl.sock') }));
  assert.equal(guard.snapshot().blocked, 0);
});

// --- refusals happen before any lookup or socket ---------------------------------------------------

test('refused URLs on the production client cause no lookup, no socket and no trap hit', async (t) => {
  const trap = await startTrap(t);
  const cases = [
    { destination: 'ollama', url: `http://refused.invalid:${trap.port}/`, reason: 'host' },
    { destination: 'ollama', url: `http://127.0.0.1:${trap.port}/`, reason: 'port' },
    { destination: 'lmstudio', url: 'https://127.0.0.1:1234/', reason: 'scheme' },
    { destination: 'elsewhere', url: `http://127.0.0.1:${trap.port}/`, reason: 'unknown-destination' },
  ];
  for (const c of cases) {
    const before = guard.snapshot();
    const e = await rejection(request({ destination: c.destination, url: c.url }));
    const after = guard.snapshot();
    assertNet(e, 'E_NET_REFUSED', { reason: c.reason });
    assert.equal(after.lookups - before.lookups, 0, c.url);
    assert.equal(after.connects - before.connects, 0, c.url);
  }
  assert.equal(trap.count(), 0);
});

test('refused URLs on the seam client cause no lookup, no socket and no trap hit', async (t) => {
  const trap = await startTrap(t);
  const stub = await startHttpStub(t, (req, res) => res.end('ok'));
  const client = seam([entry('stub', stub.port)]);
  for (const url of [`https://refused.invalid:${trap.port}/`, `http://127.0.0.1:${trap.port}/`, `http://refused.invalid:${stub.port}/`]) {
    const before = guard.snapshot();
    const e = await rejection(client.request({ destination: 'stub', url }));
    const after = guard.snapshot();
    assertNet(e, 'E_NET_REFUSED');
    assert.equal(after.lookups - before.lookups, 0, url);
    assert.equal(after.connects - before.connects, 0, url);
  }
  assert.equal(trap.count(), 0);
  assert.equal(stub.hits.total, 0);
});

test('an already-aborted signal rejects before any socket, after matching', async (t) => {
  const stub = await startHttpStub(t, (req, res) => res.end('ok'));
  const client = seam([entry('stub', stub.port)]);
  const ac = new AbortController();
  ac.abort();
  const before = guard.snapshot();
  const e = await rejection(client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/`, signal: ac.signal }));
  assertNet(e, 'E_NET_ABORTED');
  assert.equal(guard.snapshot().connects - before.connects, 0);
  assert.equal(stub.hits.total, 0);
  // Refusal comes first: a refused URL with an aborted signal is a refusal.
  const r = await rejection(client.request({ destination: 'stub', url: 'http://refused.invalid:9/', signal: ac.signal }));
  assertNet(r, 'E_NET_REFUSED');
});

// --- a normal exchange -----------------------------------------------------------------------------

test('a request reaches the stub with method, path, query, headers and body, and the result has the documented shape', async (t) => {
  const tokenSentinel = sentinel('hdr');
  let seen = null;
  const stub = await startHttpStub(t, (req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, token: req.headers['x-test-token'], length: req.headers['content-length'], body: Buffer.concat(parts).toString() };
      res.writeHead(404, { 'x-reply': 'yes' });
      res.end('nothing here');
    });
  });
  const client = seam([entry('stub', stub.port)]);
  const events = [];
  const r = await client.request({
    destination: 'stub',
    url: `http://127.0.0.1:${stub.port}/a/b?q=1`,
    method: 'POST',
    headers: { 'x-test-token': tokenSentinel },
    body: 'héllo',
    onResponse: ({ status, headers }) => events.push(['response', status, headers['x-reply']]),
  });
  assert.deepEqual(seen, { method: 'POST', url: '/a/b?q=1', token: tokenSentinel, length: '6', body: 'héllo' });
  assert.equal(r.status, 404);
  assert.equal(r.headers['x-reply'], 'yes');
  assert.equal(r.body.toString(), 'nothing here');
  assert.equal(r.bytes, 12);
  assert.equal(typeof r.durationMs, 'number');
  assert.deepEqual(events, [['response', 404, 'yes']]);
});

test('with onChunk the body is null and chunks arrive after onResponse', async (t) => {
  const stub = await startHttpStub(t, (req, res) => res.end('streamed'));
  const client = seam([entry('stub', stub.port)]);
  const order = [];
  const parts = [];
  const r = await client.request({
    destination: 'stub',
    url: `http://127.0.0.1:${stub.port}/`,
    onResponse: () => order.push('response'),
    onChunk: (b) => {
      order.push('chunk');
      parts.push(b);
    },
  });
  assert.equal(r.body, null);
  assert.equal(Buffer.concat(parts).toString(), 'streamed');
  assert.equal(order[0], 'response');
  assert.ok(order.length >= 2);
});

// --- TLS --------------------------------------------------------------------------------------------

test('TLS: trusted fixture leaves pass, with a chain served in full', async (t) => {
  for (const name of ['ec-leaf', 'chain-leaf']) {
    const stub = await startHttpsStub(t, tlsFixture(name), (req, res) => res.end('secure'));
    const client = seam([entry('tls', stub.port, 'https')], fixtureCaPem());
    const r = await client.request({ destination: 'tls', url: `https://127.0.0.1:${stub.port}/` });
    assert.equal(r.status, 200, name);
    assert.equal(r.body.toString(), 'secure');
    assert.equal(stub.hits.total, 1);
  }
});

test('TLS: untrusted, wrong-name and expired certificates are refused and the handler is never reached', async (t) => {
  const pair = untrustedPair();
  const cases = [
    ['untrusted', pair, /UNABLE_TO_VERIFY|SELF_SIGNED/],
    ['wrong-san', tlsFixture('wrong-san-leaf'), /^ERR_TLS_CERT_ALTNAME_INVALID$/],
    ['expired', tlsFixture('expired-leaf'), /^CERT_HAS_EXPIRED$/],
  ];
  for (const [label, material, re] of cases) {
    const stub = await startHttpsStub(t, { cert: material.cert, key: material.key }, (req, res) => res.end('should not be reached'));
    const client = seam([entry('tls', stub.port, 'https')], fixtureCaPem());
    const e = await rejection(client.request({ destination: 'tls', url: `https://127.0.0.1:${stub.port}/` }));
    assertNet(e, 'E_NET_TLS');
    assert.match(e.tlsCode, re, label);
    assert.equal(stub.hits.total, 0, label);
  }
  // Control: the same untrusted pair is accepted when the client trusts its own certificate.
  const stub = await startHttpsStub(t, { cert: pair.cert, key: pair.key }, (req, res) => res.end('ok'));
  const trusting = seam([entry('tls', stub.port, 'https')], pair.trustPem);
  const r = await trusting.request({ destination: 'tls', url: `https://127.0.0.1:${stub.port}/` });
  assert.equal(r.status, 200);
  assert.equal(stub.hits.total, 1);
});

test('TLS: the seam also accepts an array of trust anchors', async (t) => {
  const stub = await startHttpsStub(t, tlsFixture('ec-leaf'), (req, res) => res.end('ok'));
  const client = seam([entry('tls', stub.port, 'https')], [untrustedPair().trustPem, fixtureCaPem()]);
  assert.equal((await client.request({ destination: 'tls', url: `https://127.0.0.1:${stub.port}/` })).status, 200);
  assert.throws(() => seam([entry('tls', 5, 'https')], 42), (e) => e.code === 'E_NET_BAD_OPTIONS' && e.reason === 'test-ca');
});

// --- detours ----------------------------------------------------------------------------------------

test('every 3xx is an error and no redirect is followed', async (t) => {
  const trap = await startTrap(t);
  let target = `http://127.0.0.1:${trap.port}/`;
  const stub = await startHttpStub(t, (req, res) => {
    const m = /^\/s(\d+)$/.exec(req.url);
    if (m) {
      res.writeHead(Number(m[1]), { location: target });
      res.end();
    } else {
      res.end('elsewhere');
    }
  });
  const client = seam([entry('stub', stub.port)]);
  for (const status of [300, 301, 302, 303, 307, 308]) {
    const e = await rejection(client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/s${status}` }));
    assertNet(e, 'E_NET_REDIRECT', { status });
  }
  assert.equal(trap.count(), 0);
  // A redirect to another path on the same stub is not followed either.
  target = '/elsewhere';
  const e = await rejection(client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/s302` }));
  assertNet(e, 'E_NET_REDIRECT', { status: 302 });
  assert.equal(stub.hits.byPath['/elsewhere'], undefined);
});

test('proxy variables and a switched-off certificate check change nothing (child process)', async (t) => {
  const httpStub = await startHttpStub(t, (req, res) => res.end('ok'));
  const httpsStub = await startHttpsStub(t, tlsFixture('ec-leaf'), (req, res) => res.end('ok'));
  const pair = untrustedPair();
  const untrusted = await startHttpsStub(t, { cert: pair.cert, key: pair.key }, (req, res) => res.end('no'));
  const trap = await startTrap(t);
  const proxy = `http://127.0.0.1:${trap.port}`;
  const env = {
    PATH: process.env.PATH,
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy,
    NO_PROXY: '', no_proxy: '',
    NODE_USE_ENV_PROXY: '1',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  };
  const ports = { http: httpStub.port, https: httpsStub.port, untrusted: untrusted.port };
  const child = spawn(process.execPath, [path.join(__dirname, 'helpers', 'net-env-probe.js'), JSON.stringify(ports)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', () => {});
  const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
  killer.unref();
  const { code, signal } = await new Promise((resolve) => child.once('exit', (c, s) => resolve({ code: c, signal: s })));
  clearTimeout(killer);
  assert.equal(signal, null, 'the probe exits on its own within 20 s');
  assert.equal(code, 0);
  const out = JSON.parse(stdout.trim().split('\n').pop());
  assert.deepEqual(out.results.http, { status: 200 });
  assert.deepEqual(out.results.https, { status: 200 });
  assert.equal(out.results.untrusted.code, 'E_NET_TLS', 'the refusal holds with certificate checks switched off in the environment');
  assert.match(out.results.untrusted.tlsCode, /UNABLE_TO_VERIFY|SELF_SIGNED/);
  assert.equal(httpStub.hits.byPath['/egress'], 1);
  assert.equal(httpsStub.hits.byPath['/egress'], 1);
  assert.equal(untrusted.hits.total, 0);
  const controlReachedStub = httpStub.hits.byPath['/control'] === 1;
  assert.ok(trap.count() <= (controlReachedStub ? 0 : 1), 'egress traffic never reached the proxy trap');
  assert.equal(out.guard.clean, true);
  assert.equal(out.guard.blocked, 0);
  t.diagnostic(`node ${out.node}; control through the global agent: ${controlReachedStub ? 'reached the stub directly' : 'did not reach the stub (went to the proxy trap: ' + trap.count() + ' hit)'}; control status ${out.control.status}`);
});

// --- limits -----------------------------------------------------------------------------------------

test('connect timeout is reported with its phase (TLS never completes)', async (t) => {
  const silent = await startSilentTcp(t);
  const client = seam([entry('tls', silent.port, 'https')], fixtureCaPem());
  const e = await rejection(client.request({ destination: 'tls', url: `https://127.0.0.1:${silent.port}/`, connectTimeoutMs: 300 }));
  assertNet(e, 'E_NET_TIMEOUT', { phase: 'connect' });
});

test('idle timeout is reported with its phase (headers then a stall)', async (t) => {
  const stub = await startHttpStub(t, (req, res) => {
    res.writeHead(200, { 'content-length': '100' });
    res.write('x');
  });
  const client = seam([entry('stub', stub.port)]);
  const e = await rejection(client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/`, idleTimeoutMs: 300 }));
  assertNet(e, 'E_NET_TIMEOUT', { phase: 'idle' });
});

test('idle timeout also covers a server that accepts and never answers', async (t) => {
  const stub = await startHttpStub(t, () => {});
  const client = seam([entry('stub', stub.port)]);
  const e = await rejection(client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/`, idleTimeoutMs: 300 }));
  assertNet(e, 'E_NET_TIMEOUT', { phase: 'idle' });
});

test('total timeout is reported with its phase even while bytes keep arriving', async (t) => {
  const stub = await startHttpStub(t, (req, res) => {
    res.writeHead(200);
    const tick = setInterval(() => res.write('x'), 50);
    res.once('close', () => clearInterval(tick));
  });
  const client = seam([entry('stub', stub.port)]);
  const started = Date.now();
  const e = await rejection(
    client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/`, idleTimeoutMs: 2000, totalTimeoutMs: 600, onChunk: () => {} }),
  );
  assertNet(e, 'E_NET_TIMEOUT', { phase: 'total' });
  assert.ok(Date.now() - started < 5000);
});

test('abort in flight rejects, and the stub sees the socket close', async (t) => {
  let closed;
  const stubClosed = new Promise((r) => (closed = r));
  const stub = await startHttpStub(t, (req, res) => {
    res.writeHead(200);
    res.write('first');
    res.once('close', closed);
  });
  const client = seam([entry('stub', stub.port)]);
  const ac = new AbortController();
  const e = await rejection(
    client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/`, signal: ac.signal, onChunk: () => ac.abort() }),
  );
  assertNet(e, 'E_NET_ABORTED');
  await stubClosed;
});

test('the byte cap delivers exactly the limit, then rejects (streaming and buffered)', async (t) => {
  const stub = await startHttpStub(t, (req, res) => flood(res, Buffer.alloc(16384, 0x41)));
  const client = seam([entry('stub', stub.port)]);
  let delivered = 0;
  const e = await rejection(
    client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/`, maxResponseBytes: 65536, onChunk: (b) => (delivered += b.length) }),
  );
  assertNet(e, 'E_NET_RESPONSE_CAP', { limit: 65536 });
  assert.equal(delivered, 65536);
  const e2 = await rejection(client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/`, maxResponseBytes: 65536 }));
  assertNet(e2, 'E_NET_RESPONSE_CAP', { limit: 65536 });
  // An odd cap crosses inside a chunk.
  let odd = 0;
  const e3 = await rejection(
    client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/`, maxResponseBytes: 20000, onChunk: (b) => (odd += b.length) }),
  );
  assertNet(e3, 'E_NET_RESPONSE_CAP', { limit: 20000 });
  assert.equal(odd, 20000);
});

test('a body of exactly the cap is accepted; one byte more is not', async (t) => {
  const stub = await startHttpStub(t, (req, res) => res.end(Buffer.alloc(req.url === '/exact' ? 5000 : 5001, 0x42)));
  const client = seam([entry('stub', stub.port)]);
  const ok = await client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/exact`, maxResponseBytes: 5000 });
  assert.equal(ok.bytes, 5000);
  assert.equal(ok.body.length, 5000);
  const e = await rejection(client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/over`, maxResponseBytes: 5000 }));
  assertNet(e, 'E_NET_RESPONSE_CAP', { limit: 5000 });
});

test('a connection that ends after the headers, before the end, is incomplete', async (t) => {
  const stub = await startHttpStub(t, (req, res) => {
    res.writeHead(200, { 'content-length': '100' });
    res.write('partial');
    setImmediate(() => res.socket.destroy());
  });
  const client = seam([entry('stub', stub.port)]);
  const e = await rejection(client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/` }));
  assertNet(e, 'E_NET_INCOMPLETE');
});

test('a refused connection is a connect error with the system code', async () => {
  const port = await closedPort();
  const client = seam([entry('gone', port)]);
  const e = await rejection(client.request({ destination: 'gone', url: `http://127.0.0.1:${port}/` }));
  assertNet(e, 'E_NET_CONNECT', { syscallCode: 'ECONNREFUSED' });
});

test('a callback that throws is a callback error and the request is destroyed', async (t) => {
  let closed;
  const stubClosed = new Promise((r) => (closed = r));
  const stub = await startHttpStub(t, (req, res) => {
    res.writeHead(200);
    res.write('first');
    res.once('close', closed);
  });
  const client = seam([entry('stub', stub.port)]);
  const e = await rejection(
    client.request({
      destination: 'stub',
      url: `http://127.0.0.1:${stub.port}/`,
      onChunk: () => {
        throw new Error('callback detail');
      },
    }),
  );
  assertNet(e, 'E_NET_CALLBACK');
  assert.ok(!e.message.includes('callback detail'));
  await stubClosed;
  const e2 = await rejection(
    client.request({
      destination: 'stub',
      url: `http://127.0.0.1:${stub.port}/`,
      onResponse: () => {
        throw new Error('callback detail');
      },
    }),
  );
  assertNet(e2, 'E_NET_CALLBACK');
});

test('integration: an event stream in three chunks goes through onChunk into the parser', async (t) => {
  const parts = [
    'data: {"delta":"he"}\n\n',
    'data: {"delta":"llo"}\r\n\r\nevent: done\n',
    'data: [DONE]\n\n',
  ];
  const stub = await startHttpStub(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const p of parts) {
      await new Promise((r) => res.write(p, r));
      await new Promise((r) => setTimeout(r, 20));
    }
    res.end();
  });
  const client = seam([entry('stub', stub.port)]);
  const parser = createSseParser();
  const events = [];
  await client.request({ destination: 'stub', url: `http://127.0.0.1:${stub.port}/`, onChunk: (b) => events.push(...parser.push(b)) });
  events.push(...parser.end());
  assert.deepEqual(events, [
    { event: 'message', data: '{"delta":"he"}', id: '' },
    { event: 'message', data: '{"delta":"llo"}', id: '' },
    { event: 'done', data: '[DONE]', id: '' },
  ]);
});

// --- clean errors -----------------------------------------------------------------------------------

test('no error from any reachable path carries request or response content', async (t) => {
  const s = {
    header: sentinel('header'), body: sentinel('body'), path: sentinel('path'), query: sentinel('query'),
    response: sentinel('response'), location: sentinel('location'), flood: sentinel('flood'), host: sentinel('host'),
  };
  const all = Object.values(s);
  const check = (err, code) => {
    assertNet(err, code);
    const renderings = [err.message, err.stack, String(err), util.inspect(err, { depth: 5 }), JSON.stringify(err)];
    for (const text of renderings) for (const marker of all) assert.ok(!text.includes(marker), `${code}: ${marker} leaked`);
    assert.ok(!Object.prototype.hasOwnProperty.call(err, 'cause'));
  };
  const trap = await startTrap(t);
  const stub = await startHttpStub(t, (req, res) => {
    if (req.url.startsWith(`/${s.path}/redirect`)) {
      res.writeHead(302, { location: `http://${s.location}.invalid/` });
      res.end();
    } else if (req.url.startsWith(`/${s.path}/flood`)) {
      flood(res, Buffer.from(s.flood.repeat(400)));
    } else if (req.url.startsWith(`/${s.path}/stall`)) {
      res.writeHead(200, { 'content-length': '999999' });
      res.write(s.response);
    } else if (req.url.startsWith(`/${s.path}/cut`)) {
      res.writeHead(200, { 'content-length': '999999' });
      res.write(s.response);
      setImmediate(() => res.socket.destroy());
    } else {
      res.end(s.response);
    }
  });
  const pair = untrustedPair();
  const tlsStub = await startHttpsStub(t, { cert: pair.cert, key: pair.key }, (req, res) => res.end(s.response));
  const client = seam([entry('stub', stub.port), entry('tls', tlsStub.port, 'https')], fixtureCaPem());
  const base = `http://127.0.0.1:${stub.port}/${s.path}`;
  const send = {
    destination: 'stub',
    method: 'POST',
    headers: { 'x-test-token': s.header },
    body: s.body,
  };
  const url = (p) => `${base}${p}?key=${s.query}`;

  check(await rejection(request({ destination: 'ollama', url: `http://${s.host}.invalid:${trap.port}/${s.path}?key=${s.query}`, headers: { 'x-test-token': s.header } })), 'E_NET_REFUSED');
  check(await rejection(request({ destination: 'ollama', url: `https://${s.host}.invalid/`, headers: { 'x-test-token': `${s.header}\r\n` } })), 'E_NET_BAD_OPTIONS');
  check(await rejection(request({ destination: 'ollama', url: `not a url ${s.path}` })), 'E_NET_BAD_URL');
  check(await rejection(client.request({ ...send, url: url('/redirect') })), 'E_NET_REDIRECT');
  check(await rejection(client.request({ ...send, url: url('/flood'), maxResponseBytes: 4096 })), 'E_NET_RESPONSE_CAP');
  check(await rejection(client.request({ ...send, url: url('/stall'), idleTimeoutMs: 300 })), 'E_NET_TIMEOUT');
  check(await rejection(client.request({ ...send, url: url('/cut') })), 'E_NET_INCOMPLETE');
  check(
    await rejection(client.request({ ...send, url: url('/ok'), onChunk: () => { throw new Error(s.response); } })),
    'E_NET_CALLBACK',
  );
  const ac = new AbortController();
  ac.abort();
  check(await rejection(client.request({ ...send, url: url('/ok'), signal: ac.signal })), 'E_NET_ABORTED');
  check(await rejection(client.request({ ...send, destination: 'tls', url: `https://127.0.0.1:${tlsStub.port}/${s.path}?key=${s.query}` })), 'E_NET_TLS');
  const gone = await closedPort();
  const goneClient = seam([entry('gone', gone)]);
  check(await rejection(goneClient.request({ ...send, destination: 'gone', url: `http://127.0.0.1:${gone}/${s.path}?key=${s.query}` })), 'E_NET_CONNECT');
});

test('a NetError with an unknown code or hostile fields is safe', () => {
  assert.throws(() => new NetError('E_NOT_A_CODE', {}));
  const e = new NetError('E_NET_REFUSED', { destination: 'a b', reason: 'x'.repeat(100), status: 1.5, extra: 'y' });
  assert.equal(e.destination, undefined);
  assert.equal(e.reason, undefined);
  assert.equal(e.status, undefined);
  assert.equal(e.extra, undefined);
  assert.equal(e.cause, undefined);
});
