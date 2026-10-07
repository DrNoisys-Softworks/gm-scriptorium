'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');

const { startPanelListener, startLocalListener } = require('../src/serve/server');
const { ScriptoriumError } = require('../src/util/errors');
const addr = require('../src/remote/addr');

/*
 * V1.5a (SD-a3). startPanelListener on REAL sockets. Fixed ports 7920-7921, disjoint from every
 * other test file (node --test runs files in parallel). The peer tests use source addresses in
 * 127.0.0.0/8, which Linux accepts as local addresses on the loopback interface; other platforms
 * do not, so they are Linux-only (Windows and macOS are covered by C71's OPEN criterion and by
 * the unit tests of the gate, not by these sockets).
 */

const PORT = 7920;
const PORT2 = 7921;
const linuxOnly = { skip: process.platform !== 'linux' ? 'Linux accepts every 127/8 address; other platforms do not' : false };

const okHandler = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hello');
};

/** Resolves { gotBytes, closed } for a raw TCP connection that sends a request. */
function rawProbe({ host = '127.0.0.1', port = PORT, localAddress }) {
  return new Promise((resolve) => {
    const chunks = [];
    const sock = net.connect({ host, port, localAddress });
    let settled = false;
    const done = (extra) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ bytes: Buffer.concat(chunks).toString('latin1'), ...extra });
    };
    sock.on('connect', () => sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => done({ closed: true }));
    sock.on('error', (err) => done({ closed: true, error: err.code }));
    setTimeout(() => done({ closed: false }), 2000).unref();
  });
}

function get({ host = '127.0.0.1', port = PORT, localAddress }) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, localAddress, path: '/', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

function canBind(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

// --- preconditions (programming errors, thrown synchronously) ---------------------

/** Asserts the call throws synchronously; if a mutation lets it through, close what it opened so the run cannot hang. */
async function mustThrow(fn, ErrorClass) {
  let result;
  try {
    result = fn();
  } catch (err) {
    assert.ok(err instanceof ErrorClass, `expected ${ErrorClass.name}, got ${err && err.message}`);
    return err;
  }
  const handle = await Promise.resolve(result).catch(() => null);
  if (handle && handle.close) await handle.close();
  assert.fail('expected startPanelListener to throw');
  return null;
}

test('preconditions: hosts must be a non-empty array of IP literals with no duplicates, port an integer 1-65535', async () => {
  const h = okHandler;
  const bad = [
    { port: PORT, hosts: [] },
    { port: PORT, hosts: 'localhost' },
    { port: PORT, hosts: ['localhost'] },
    { port: PORT, hosts: ['127.0.0.1', 'example.test'] },
    { port: PORT, hosts: ['127.0.0.1', '127.0.0.1'] },
    { port: PORT, hosts: ['192.0.2.42/24'] },
    { port: PORT, hosts: [''] },
    { port: 0, hosts: ['127.0.0.1'] },
    { port: 65536, hosts: ['127.0.0.1'] },
    { port: 7400.5, hosts: ['127.0.0.1'] },
    { port: '7400', hosts: ['127.0.0.1'] },
    { port: undefined, hosts: ['127.0.0.1'] },
  ];
  for (const opts of bad) {
    await mustThrow(() => startPanelListener(h, opts), ScriptoriumError);
  }
});

test('a present tls option throws in V1.5a, before anything binds', async () => {
  const err = await mustThrow(() => startPanelListener(okHandler, { port: PORT, hosts: ['127.0.0.1'], tls: { key: 'k', cert: 'c' } }), ScriptoriumError);
  assert.match(err.message, /TLS listeners arrive with certificate support/);
  assert.equal(await canBind('127.0.0.1', PORT), true, 'nothing was left listening');
});

// --- listening ------------------------------------------------------------------

test('listens on 127.0.0.1 and answers; the result names servers, port, hosts', linuxOnly, async (t) => {
  const handle = await startPanelListener(okHandler, { port: PORT, hosts: ['127.0.0.1'] });
  t.after(() => handle.close().catch(() => {}));
  assert.equal(handle.port, PORT);
  assert.deepEqual(handle.hosts, ['127.0.0.1']);
  assert.equal(handle.servers.length, 1);
  assert.equal(handle.servers[0].address().address, '127.0.0.1');
  const res = await get({});
  assert.deepEqual(res, { status: 200, body: 'hello' });
});

test('two hosts (127.0.0.4 and 127.0.0.1) both listen on the same port', linuxOnly, async (t) => {
  const handle = await startPanelListener(okHandler, { port: PORT, hosts: ['127.0.0.4', '127.0.0.1'] });
  t.after(() => handle.close().catch(() => {}));
  assert.equal(handle.servers.length, 2);
  assert.deepEqual(await get({ host: '127.0.0.4' }), { status: 200, body: 'hello' });
  assert.deepEqual(await get({ host: '127.0.0.1' }), { status: 200, body: 'hello' });
  // and it does NOT listen on a third address of the block (127.0.0.5 is not in the plan)
  const probe = await rawProbe({ host: '127.0.0.5' });
  assert.ok(probe.error === 'ECONNREFUSED' || probe.bytes === '', `got ${JSON.stringify(probe)}`);
});

// --- the peer filter -------------------------------------------------------------

// the real predicate serve-admin builds, so a prefix-match mutation of it fails HERE, on a real socket
const allowSet = (...list) => addr.makePeerPredicate(list);

test('allowPeer admits 127.0.0.2; 127.0.0.3 and 127.0.0.20 receive NO HTTP bytes (Ma12, Ma17)', linuxOnly, async (t) => {
  let handled = 0;
  const handle = await startPanelListener(
    (req, res) => {
      handled++;
      okHandler(req, res);
    },
    { port: PORT, hosts: ['127.0.0.1'], allowPeer: allowSet('127.0.0.1', '127.0.0.2') },
  );
  t.after(() => handle.close().catch(() => {}));
  assert.deepEqual(await get({ localAddress: '127.0.0.2' }), { status: 200, body: 'hello' });
  assert.deepEqual(await get({ localAddress: '127.0.0.1' }), { status: 200, body: 'hello' });
  assert.equal(handled, 2);
  for (const localAddress of ['127.0.0.3', '127.0.0.20', '127.0.0.200']) {
    const probe = await rawProbe({ localAddress });
    assert.equal(probe.bytes, '', `${localAddress} must receive no bytes, got ${JSON.stringify(probe.bytes)}`);
    assert.equal(probe.closed, true, `${localAddress} must be disconnected`);
  }
  assert.equal(handled, 2, 'the handler never ran for a dropped peer');
});

test('with no allowPeer every peer is admitted (direct mode shape)', linuxOnly, async (t) => {
  const handle = await startPanelListener(okHandler, { port: PORT, hosts: ['127.0.0.1'] });
  t.after(() => handle.close().catch(() => {}));
  assert.deepEqual(await get({ localAddress: '127.0.0.3' }), { status: 200, body: 'hello' });
});

test('the peer filter runs on the connection, before any HTTP parsing: a peer that sends garbage gets nothing back either', linuxOnly, async (t) => {
  const handle = await startPanelListener(okHandler, { port: PORT, hosts: ['127.0.0.1'], allowPeer: allowSet('127.0.0.1') });
  t.after(() => handle.close().catch(() => {}));
  const out = await new Promise((resolve) => {
    const chunks = [];
    const sock = net.connect({ host: '127.0.0.1', port: PORT, localAddress: '127.0.0.3' }, () => sock.write('NOT HTTP AT ALL\r\n\r\n'));
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => resolve(Buffer.concat(chunks).toString()));
    sock.on('error', () => resolve(Buffer.concat(chunks).toString()));
  });
  assert.equal(out, '', 'no "400 Bad Request" bytes: the socket was destroyed before the parser saw it');
});

// --- failure and teardown ---------------------------------------------------------

test('EADDRINUSE on the second host rejects with the named message and closes the first', linuxOnly, async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(PORT2, '127.0.0.4', resolve));
  t.after(() => blocker.close());
  await assert.rejects(startPanelListener(okHandler, { port: PORT2, hosts: ['127.0.0.1', '127.0.0.4'] }), (err) => {
    assert.equal(err.message, `port ${PORT2} is already in use on 127.0.0.4`);
    return true;
  });
  assert.equal(await canBind('127.0.0.1', PORT2), true, 'the first host was closed again');
});

test('EADDRINUSE on the FIRST host rejects with its own host in the message', linuxOnly, async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(PORT2, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  await assert.rejects(startPanelListener(okHandler, { port: PORT2, hosts: ['127.0.0.1', '127.0.0.4'] }), {
    message: `port ${PORT2} is already in use on 127.0.0.1`,
  });
  assert.equal(await canBind('127.0.0.4', PORT2), true);
});

test('a bind failure other than EADDRINUSE rejects with that error (an address this machine does not own)', async () => {
  await assert.rejects(startPanelListener(okHandler, { port: PORT2, hosts: ['192.0.2.77'] }), (err) => {
    assert.ok(err.code === 'EADDRNOTAVAIL' || err.code === 'EACCES' || /listen/.test(err.message), err.message);
    assert.ok(!/already in use/.test(err.message));
    return true;
  });
});

test('close() stops every server and does not wait for a keep-alive connection', linuxOnly, async () => {
  const handle = await startPanelListener(okHandler, { port: PORT, hosts: ['127.0.0.4', '127.0.0.1'] });
  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/', agent }, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
  await handle.close();
  agent.destroy();
  assert.equal(await canBind('127.0.0.1', PORT), true);
  assert.equal(await canBind('127.0.0.4', PORT), true);
});

test('startLocalListener is still host-free and 127.0.0.1-only (untouched)', async (t) => {
  assert.equal(startLocalListener.length, 2);
  const h = await startLocalListener(okHandler, { port: 0 });
  t.after(() => h.close());
  assert.equal(h.server.address().address, '127.0.0.1');
});

test('close() does not wait for an in-flight request that will never finish (closeAllConnections)', linuxOnly, async () => {
  const handle = await startPanelListener(() => {}, { port: PORT, hosts: ['127.0.0.1'] }); // never answers
  const pending = new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', agent: false });
    req.on('error', () => resolve('aborted'));
    req.on('response', () => resolve('response'));
  });
  await new Promise((r) => setTimeout(r, 100));
  const closed = await Promise.race([handle.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
  assert.equal(closed, 'closed');
  assert.equal(await pending, 'aborted');
});
