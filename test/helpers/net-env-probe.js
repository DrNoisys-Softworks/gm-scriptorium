'use strict';

/*
 * Child process for the proxy and TLS environment test in test/net-egress.test.js.
 *
 * The parent starts the stubs and a trap, builds this process's environment from scratch (proxy
 * variables aimed at the trap, certificate checks switched off), and waits for it to exit on its
 * own. This file runs the egress module through its test seam, then a control request through
 * Node's global agent, and prints one JSON line: results, the loopback guard's counters and the
 * Node version. It prints no environment values.
 */

const http = require('http');
const { installLoopbackGuard, fixtureCaPem } = require('./net-stubs');
const { createEgressForTests } = require('../../src/net/egress');

const guard = installLoopbackGuard();
const ports = JSON.parse(process.argv[2]);

const entry = (id, scheme, port) => ({ id, scheme, host: '127.0.0.1', port });

async function attempt(client, destination, url) {
  try {
    const r = await client.request({ destination, url });
    return { status: r.status };
  } catch (e) {
    return { code: e.code, tlsCode: e.tlsCode };
  }
}

function control() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: ports.http, path: '/control', timeout: 2000 }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'timeout' });
    });
    req.on('error', () => resolve({ status: 'error' }));
  });
}

(async () => {
  const client = createEgressForTests({
    destinations: [entry('h', 'http', ports.http), entry('s', 'https', ports.https), entry('u', 'https', ports.untrusted)],
    testCaPem: fixtureCaPem(),
  });
  const out = { node: process.versions.node, results: {}, control: null, guard: null };
  out.results.http = await attempt(client, 'h', `http://127.0.0.1:${ports.http}/egress`);
  out.results.https = await attempt(client, 's', `https://127.0.0.1:${ports.https}/egress`);
  out.results.untrusted = await attempt(client, 'u', `https://127.0.0.1:${ports.untrusted}/egress`);
  out.control = await control();
  let clean = true;
  try {
    guard.assertClean();
  } catch (_) {
    clean = false;
  }
  out.guard = { ...guard.snapshot(), clean };
  process.stdout.write(JSON.stringify(out) + '\n');
})();
