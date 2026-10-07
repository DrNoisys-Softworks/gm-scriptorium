'use strict';

/*
 * Loopback-only harness for the outgoing connection module (ADR 0024).
 *
 * This file deliberately does not require anything under src/net, so what the tests expect is
 * written here and not read back from the module under test.
 *
 * What it gives a test file:
 *  - installLoopbackGuard(): wraps the socket connect call and the name lookup. A connect to a
 *    pipe, to an IP literal other than 127.0.0.1, or to port 11434 or 1234 throws before Node is
 *    called, and is counted as blocked. Every name lookup is answered with 127.0.0.1 by a recorder,
 *    so nothing ever reaches a real resolver. assertClean() states the end-of-file rules.
 *  - stubs that bind 127.0.0.1 on port 0: an http server, an https server, a trap that counts
 *    connections, and a TCP server that accepts and never writes.
 *  - TLS material, read by path from test/fixtures/tls, plus a runtime-generated untrusted pair.
 *  - sentinel(): a runtime marker that is never key-shaped.
 */

const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { generateCertificatePair } = require('../../src/cert/generate');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'tls');
const REAL_PORTS = [11434, 1234];

let installed = null;

function targetOf(args) {
  // Node passes one of three shapes: the normalized [options, cb] array (from net.createConnection
  // and the http agent), (options, cb), or (port, host, cb) / (path, cb).
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first !== null && typeof first === 'object') {
    return { path: first.path, host: first.host, port: first.port };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
  return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
}

function installLoopbackGuard() {
  if (installed) return installed;
  const state = { connects: 0, lookups: 0, blocked: 0, addresses: [], ports: [] };

  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const t = targetOf(args);
    const port = t.port === undefined || t.port === null ? NaN : Number(t.port);
    let bad = null;
    if (t.path !== undefined && t.path !== null) bad = 'path';
    else if (typeof t.host === 'string' && net.isIP(t.host) && t.host !== '127.0.0.1') bad = 'address';
    else if (REAL_PORTS.includes(port)) bad = 'port';
    if (bad) {
      state.blocked += 1;
      throw new Error(`loopback guard blocked a connect (${bad})`);
    }
    this.once('connect', () => {
      state.connects += 1;
      state.addresses.push(this.remoteAddress);
      state.ports.push(this.remotePort);
    });
    return origConnect.apply(this, args);
  };

  function answer(options, cb) {
    state.lookups += 1;
    const wantAll = options && typeof options === 'object' && options.all === true;
    process.nextTick(() => {
      if (wantAll) cb(null, [{ address: '127.0.0.1', family: 4 }]);
      else cb(null, '127.0.0.1', 4);
    });
  }
  dns.lookup = function recordedLookup(hostname, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    answer(options, cb);
  };
  dns.promises.lookup = function recordedPromiseLookup(hostname, options) {
    state.lookups += 1;
    const wantAll = options && typeof options === 'object' && options.all === true;
    return Promise.resolve(wantAll ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 });
  };

  installed = {
    snapshot() {
      return { connects: state.connects, lookups: state.lookups, blocked: state.blocked };
    },
    expectBlocked(fn) {
      const before = state.blocked;
      let threw = false;
      let sock = null;
      try {
        sock = fn();
      } catch (_) {
        threw = true;
      }
      if (sock && typeof sock.destroy === 'function') sock.destroy();
      assert.ok(threw, 'the guard should have thrown');
      assert.equal(state.blocked, before + 1, 'the guard should have counted one blocked connect');
      state.blocked = before; // an expected block is not a failure of the file
    },
    assertClean({ minConnects = 1 } = {}) {
      assert.equal(state.blocked, 0, 'no connect was blocked');
      for (const a of state.addresses) assert.equal(a, '127.0.0.1');
      for (const p of state.ports) assert.ok(!REAL_PORTS.includes(p), `connected to a real-service port: ${p}`);
      assert.ok(state.connects >= minConnects, `expected at least ${minConnects} connects, saw ${state.connects}`);
    },
  };
  return installed;
}

function trackSockets(server, sockets) {
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('error', () => {});
    s.once('close', () => sockets.delete(s));
  });
}

function closeLater(t, server, sockets) {
  t.after(
    () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  );
}

function makeHits() {
  return { total: 0, byPath: {}, log: [] };
}

function record(hits, req) {
  hits.total += 1;
  hits.byPath[req.url] = (hits.byPath[req.url] || 0) + 1;
  hits.log.push({ method: req.method, path: req.url });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startHttpStub(t, handler) {
  const hits = makeHits();
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    record(hits, req);
    handler(req, res, hits);
  });
  trackSockets(server, sockets);
  const port = await listen(server);
  closeLater(t, server, sockets);
  return { port, hits };
}

async function startHttpsStub(t, { cert, key }, handler) {
  const hits = makeHits();
  const sockets = new Set();
  const server = https.createServer({ cert, key }, (req, res) => {
    record(hits, req);
    handler(req, res, hits);
  });
  server.on('tlsClientError', () => {});
  trackSockets(server, sockets);
  const port = await listen(server);
  closeLater(t, server, sockets);
  return { port, hits };
}

async function startTrap(t) {
  const sockets = new Set();
  let count = 0;
  const waiters = [];
  const server = net.createServer((s) => {
    count += 1;
    for (const w of waiters.splice(0)) w();
  });
  trackSockets(server, sockets);
  const port = await listen(server);
  closeLater(t, server, sockets);
  return {
    port,
    count: () => count,
    async waitCount(n) {
      while (count < n) await new Promise((r) => waiters.push(r));
    },
  };
}

async function startSilentTcp(t) {
  const sockets = new Set();
  const server = net.createServer(() => {});
  trackSockets(server, sockets);
  const port = await listen(server);
  closeLater(t, server, sockets);
  return { port };
}

function tlsFixture(name) {
  return {
    cert: fs.readFileSync(path.join(FIXTURES, `${name}.pem`)),
    key: fs.readFileSync(path.join(FIXTURES, `${name}.key`)),
  };
}

function fixtureCaPem() {
  return fs.readFileSync(path.join(FIXTURES, 'ca.pem'), 'utf8');
}

function untrustedPair() {
  const pair = generateCertificatePair();
  return { cert: pair.leafPem, key: pair.keyPem, trustPem: pair.trustPem };
}

function sentinel(label) {
  return 'netsentinel-' + label + '-' + crypto.randomBytes(12).toString('hex');
}

/** A port on 127.0.0.1 where nothing is listening (bound, then released). */
async function closedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  return port;
}

module.exports = {
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
};
