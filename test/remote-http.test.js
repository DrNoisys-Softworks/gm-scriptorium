'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');
const { createSessionStore } = require('../src/remote/sessions');
const { ADMIN_ROUTES } = require('../src/admin/router');
const { createTestProxy } = require('./helpers/remote-test-proxy');
const remoteHandlers = require('../src/admin/handlers/remote');

/*
 * V1.5a (SD-a6 to SD-a11, SD-a17). The real pipeline over real sockets: runServeCommand with the
 * real listeners, the real stores and handlers, fronted by the repo's test proxy (which forwards
 * Host and Origin byte for byte, appends X-Forwarded-For and sets X-Forwarded-Proto). Fixed ports
 * 7924-7927 (proxy shape 7924/7925, tailscale shape 7926/7927); the peer tests use 127.0.0.2 as the
 * trusted proxy and are Linux-only (Linux accepts every 127/8 address). Time is an injected clock.
 * Passwords here are test fixtures only.
 */

const linuxOnly = { skip: process.platform !== 'linux' ? 'Linux accepts every 127/8 address; other platforms do not' : false };
const PASSWORD = 'correct horse battery';
const ADMIN_HOST = 'scriptorium.home.arpa';
const PREVIEW_HOST = 'preview.scriptorium.home.arpa';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
const PREVIEW_ORIGIN = `https://${PREVIEW_HOST}`;
const TS_ADMIN_HOST = 'panel-host.example-tailnet.ts.net';
const TS_PREVIEW_HOST = 'panel-host.example-tailnet.ts.net:8443';
const GENERIC = '{"error":"signin","message":"Sign-in failed. Check the password and try again."}';
const AUDIT_503 = '{"error":"audit","message":"The panel could not write its audit log, so changes from other devices are paused. Use the panel on this machine, or fix the disk and try again."}';

const SHAPES = {
  proxy: {
    ports: [7924, 7925],
    trustedPeer: '127.0.0.2',
    remote: { mode: 'proxy', port: 7924, preview_port: 7925, admin_url: ADMIN_ORIGIN, preview_url: PREVIEW_ORIGIN, bind: '127.0.0.1', trusted_proxies: ['127.0.0.2'] },
    adminHost: ADMIN_HOST,
    previewHost: PREVIEW_HOST,
  },
  tailscale: {
    ports: [7926, 7927],
    trustedPeer: '127.0.0.1',
    remote: { mode: 'tailscale', port: 7926, preview_port: 7927, admin_url: `https://${TS_ADMIN_HOST}`, preview_url: `https://${TS_PREVIEW_HOST}` },
    adminHost: TS_ADMIN_HOST,
    previewHost: TS_PREVIEW_HOST,
  },
};

// --- harness -------------------------------------------------------------------------

function toml(remote) {
  const lines = ['', '[remote]'];
  for (const [k, v] of Object.entries(remote)) lines.push(`${k} = ${JSON.stringify(v)}`);
  return `${lines.join('\n')}\n`;
}

function makeFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-rh-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n');
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Alpha Test' })}\n`);
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'pack.toml'), 'theme = "plain"\n');
  return { root, vault, panelDir: path.join(root, 'panel'), configPath: path.join(root, 'config.toml') };
}

function writeConfig(fx, remote) {
  fs.writeFileSync(
    fx.configPath,
    `${['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${fx.vault}'`, `output = '${path.join(fx.root, 'out')}'`, ''].join('\n')}${remote ? toml(remote) : ''}`,
  );
}

/** Starts a panel (real listeners) and the two proxies in front of it. */
async function startPanel(t, { shape = 'proxy', fixture, clock, password = true, local = false, proxyOpts = {} } = {}) {
  const spec = SHAPES[shape];
  const fx = fixture || makeFixture(t);
  const clk = clock || { t: Date.UTC(2026, 9, 3, 0, 0, 0), now: () => clk.t };
  if (!fixture) writeConfig(fx, local ? undefined : spec.remote);
  if (password && !local && !fs.existsSync(path.join(fx.panelDir, 'password.json'))) {
    pwWrite.writePasswordRecord(path.join(fx.panelDir, 'password.json'), await pw.hashPassword(PASSWORD));
  }
  const emitted = [];
  const signals = new EventEmitter();
  const done = runServeCommand({ config: fx.configPath, admin: true }, 'alpha', { emit: (l) => emitted.push(l), signals, now: clk.now });
  let result = null;
  done.then((r) => {
    result = r;
  });
  const started = Date.now();
  while (!emitted.some((l) => /Press Ctrl-C to stop|open the admin panel link/.test(l))) {
    if (result) throw new Error(`panel exited early: ${JSON.stringify(result)}`);
    if (Date.now() - started > 10000) throw new Error(`panel did not start: ${emitted.join(' | ')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  const tokenLine = emitted.find((l) => /token=/.test(l));
  const adminPort = Number(/127\.0\.0\.1:(\d+)\/auth/.exec(tokenLine)[1]);
  const token = /token=(\S+)/.exec(tokenLine)[1];
  const previewPort = local ? Number(/127\.0\.0\.1:(\d+)\/$/.exec(emitted.find((l) => /^preview: /.test(l)))[1]) : spec.ports[1];
  const env = { fx, clock: clk, emitted, signals, adminPort, previewPort, token, spec, shape, proxies: [], stopped: false };
  if (!local) {
    const localAddress = spec.trustedPeer;
    env.adminProxy = await createTestProxy({ upstreamPort: adminPort, localAddress, ...proxyOpts });
    env.previewProxy = await createTestProxy({ upstreamPort: previewPort, localAddress, ...proxyOpts });
    env.proxies.push(env.adminProxy, env.previewProxy);
  }
  // The refusal delay (U5) is observed, not slept, so the suite stays fast; one test below checks what it asked for.
  env.sleeps = [];
  const realSleep = remoteHandlers.timing.sleep;
  remoteHandlers.timing.sleep = async (ms) => {
    env.sleeps.push(ms);
  };
  t.after(() => {
    remoteHandlers.timing.sleep = realSleep;
  });
  env.stop = async () => {
    if (env.stopped) return result;
    env.stopped = true;
    signals.emit('SIGINT');
    const r = await done;
    for (const p of env.proxies) await p.close();
    return r;
  };
  t.after(() => env.stop());
  return env;
}

function assertNoCors(headers) {
  for (const name of Object.keys(headers)) {
    assert.ok(!name.toLowerCase().startsWith('access-control-'), `unexpected CORS header ${name}`);
  }
}

/** One raw HTTP request. Host is set exactly as given (never defaulted); every response is checked for CORS headers. */
function request(port, { method = 'GET', pathname = '/', headers = {}, body, host, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host !== undefined) h.Host = host;
    if (body !== undefined && h['Content-Length'] === undefined) h['Content-Length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h, setHost: false, agent: false, localAddress }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        assertNoCors(res.headers);
        resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const adminReq = (env, opts) => request(env.adminProxy.port, { host: env.spec.adminHost, ...opts });
const previewReq = (env, opts) => request(env.previewProxy.port, { host: env.spec.previewHost, ...opts });
const loopbackReq = (env, opts) => request(env.adminPort, { host: `127.0.0.1:${env.adminPort}`, ...opts });
const loopbackPreviewReq = (env, opts) => request(env.previewPort, { host: `127.0.0.1:${env.previewPort}`, ...opts });

function adminPost(env, pathname, bodyObj, { headers = {}, origin } = {}) {
  const body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return adminReq(env, { method: 'POST', pathname, body, headers: { 'Content-Type': 'application/json', Origin: origin === undefined ? `https://${env.spec.adminHost}` : origin, ...headers } });
}

const signin = (env, password = PASSWORD, extra = {}) => adminPost(env, '/auth/password', { password }, extra);

/** name=value pairs and the attribute list of one Set-Cookie header value. */
function parseSetCookie(value) {
  const parts = value.split('; ');
  const [name, ...rest] = parts[0].split('=');
  return { name, value: rest.join('='), attrs: parts.slice(1) };
}

function cookieFrom(res, name) {
  const raw = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return raw === undefined ? null : { raw, ...parseSetCookie(raw) };
}

async function signedIn(env) {
  const res = await signin(env);
  assert.equal(res.status, 200, res.text);
  return cookieFrom(res, '__Host-scriptorium_session').value;
}

const sessionCookie = (value) => ({ Cookie: `__Host-scriptorium_session=${value}` });

function readAudit(env) {
  const file = path.join(env.fx.panelDir, 'audit.log');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function countVerifies(t) {
  const real = pw.verifyPassword;
  const counter = { calls: 0, gate: null };
  pw.verifyPassword = async (...args) => {
    counter.calls++;
    if (counter.gate) await counter.gate;
    return real(...args);
  };
  t.after(() => {
    pw.verifyPassword = real;
  });
  return counter;
}

/** Raw-socket request, for the Host cases a client library will not send. */
function rawRequest(port, text, { localAddress } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const sock = net.connect({ host: '127.0.0.1', port, localAddress }, () => sock.write(text));
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    sock.on('error', () => resolve(Buffer.concat(chunks).toString('latin1')));
    setTimeout(() => sock.destroy(), 3000).unref();
  });
}

// =========================================================================================
// the helper itself: Host and Origin are NEVER rewritten
// =========================================================================================

test('test proxy self-test: Host, Origin and custom headers reach the upstream byte for byte; XFF is appended; XFP is set', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ rawHeaders: req.rawHeaders, remote: req.socket.remoteAddress, url: req.url, method: req.method });
    res.end('ok');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const proxy = await createTestProxy({ upstreamPort: upstream.address().port, localAddress: '127.0.0.1', clientAddress: '198.51.100.77' });
  t.after(() => proxy.close());
  const res = await request(proxy.port, {
    method: 'POST',
    pathname: '/a/b?c=d',
    host: 'ScRiPtOrIuM.home.arpa:8443',
    headers: { Origin: 'https://Mixed.Case.example', 'X-Forwarded-For': '203.0.113.9', 'X-Custom': 'v', 'X-Forwarded-Proto': 'http' },
    body: 'hello',
  });
  assert.equal(res.text, 'ok');
  const got = seen[0];
  const raw = Object.fromEntries(got.rawHeaders.reduce((acc, v, i, a) => (i % 2 === 0 ? acc.concat([[v, a[i + 1]]]) : acc), []));
  assert.equal(raw.Host, 'ScRiPtOrIuM.home.arpa:8443');
  assert.equal(raw.Origin, 'https://Mixed.Case.example');
  assert.equal(raw['X-Custom'], 'v');
  assert.equal(raw['X-Forwarded-For'], '203.0.113.9, 198.51.100.77', 'appended after what the client sent');
  assert.equal(raw['X-Forwarded-Proto'], 'https', 'the proxy sets its own, replacing a client-supplied value');
  assert.equal(got.method, 'POST');
  assert.equal(got.url, '/a/b?c=d');
});

test('test proxy self-test: xff "replace" drops client entries, proto null sets none, localAddress selects the upstream peer', linuxOnly, async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ headers: req.headers, remote: req.socket.remoteAddress });
    res.end('ok');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const proxy = await createTestProxy({ upstreamPort: upstream.address().port, localAddress: '127.0.0.5', xff: 'replace', proto: null, clientAddress: '198.51.100.9' });
  t.after(() => proxy.close());
  await request(proxy.port, { host: 'x.example', headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(seen[0].headers['x-forwarded-for'], '198.51.100.9');
  assert.equal(seen[0].headers['x-forwarded-proto'], undefined);
  assert.equal(seen[0].remote, '127.0.0.5');
});

// =========================================================================================
// refusal pages and sign-in
// =========================================================================================

test('an unauthenticated GET / on the external Host gets signin.html (403), with the admin headers and CSP', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const res = await adminReq(env, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'signin.html')));
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(res.headers['content-security-policy'], /form-action 'none'/);
  assert.equal(res.headers['set-cookie'], undefined);
  const head = await adminReq(env, { method: 'HEAD' });
  assert.equal(head.status, 403);
  assert.equal(head.body.length, 0);
});

test('any other unauthenticated admin path on the external Host is a plain "refused: session"; the loopback page stays locked.html', linuxOnly, async (t) => {
  const env = await startPanel(t);
  for (const pathname of ['/api/session', '/api/state', '/open-preview', '/api/remote', '/index.html?x=1']) {
    const res = await adminReq(env, { pathname });
    assert.equal(res.status, 403, pathname);
    assert.equal(res.text, 'refused: session', pathname);
  }
  const locked = await loopbackReq(env, {});
  assert.equal(locked.status, 403);
  assert.deepEqual(locked.body, fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'locked.html')));
});

test('sign-in: 200 {"ok":true} and the exact cookie, parsed attribute by attribute (Ma3)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const res = await signin(env);
  assert.equal(res.status, 200);
  assert.equal(res.text, '{"ok":true}');
  assert.match(res.headers['content-type'], /^application\/json/);
  const cookies = [].concat(res.headers['set-cookie']);
  assert.equal(cookies.length, 1);
  const c = parseSetCookie(cookies[0]);
  assert.equal(c.name, '__Host-scriptorium_session');
  assert.match(c.value, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(c.attrs, ['Path=/', 'Max-Age=86400', 'Secure', 'HttpOnly', 'SameSite=Strict']);
  assert.ok(!c.attrs.some((a) => /^Domain=/i.test(a)));
});

test('the sign-in cookie says Max-Age=86400 exactly even when the clock moves between creating the session and answering (a real clock does)', linuxOnly, async (t) => {
  const clk = { t: Date.UTC(2026, 9, 3), now: () => (clk.t += 3) };
  const env = await startPanel(t, { clock: clk });
  const res = await signin(env);
  assert.equal(res.status, 200);
  assert.deepEqual(cookieFrom(res, '__Host-scriptorium_session').attrs, ['Path=/', 'Max-Age=86400', 'Secure', 'HttpOnly', 'SameSite=Strict']);
});

test('a signed-in remote browser: GET / is the panel (200) with frame-src for the PREVIEW origin, and /api/session carries the access object', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const cookie = sessionCookie(await signedIn(env));
  const shell = await adminReq(env, { headers: cookie });
  assert.equal(shell.status, 200);
  assert.deepEqual(shell.body, fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'index.html')));
  const sessionRes = await adminReq(env, { pathname: '/api/session', headers: cookie });
  assert.equal(sessionRes.status, 200);
  const body = JSON.parse(sessionRes.text);
  assert.deepEqual(body.access, {
    mode: 'proxy',
    via: 'remote',
    reach: `Reachable at ${ADMIN_ORIGIN} through your proxy, and on this machine`,
    previewUrl: PREVIEW_ORIGIN,
    loopbackScheme: 'http',
  });
  assert.equal(body.previewPort, env.previewPort);
});

test('Mf1/Mf2: the remote shell CSP names the PREVIEW origin (not the admin origin, not loopback) as frame-src, as one exact string', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const cookie = sessionCookie(await signedIn(env));
  const shell = await adminReq(env, { headers: cookie });
  const expected =
    `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-src 'self' ${PREVIEW_ORIGIN}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  assert.equal(shell.headers['content-security-policy'], expected);
  assert.ok(!shell.headers['content-security-policy'].includes(`frame-src 'self' ${ADMIN_ORIGIN};`));
  assert.ok(!shell.headers['content-security-policy'].includes('127.0.0.1'));
  // the SAME panel opened on the loopback form still gets the loopback frame-src, unchanged
  const loop = await loopbackReq(env, { headers: { Cookie: `scriptorium_admin_${env.adminPort}=${env.token}` } });
  assert.equal(loop.status, 200);
  assert.match(loop.headers['content-security-policy'], new RegExp(`connect-src 'self'; frame-src http://127\\.0\\.0\\.1:${env.previewPort}; base-uri`));
});

test('sign-in failure: one generic body (403), no cookie, whatever was wrong', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const wrong = await signin(env, 'not the password');
  assert.equal(wrong.status, 403);
  assert.equal(wrong.text, GENERIC);
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.match(wrong.headers['content-type'], /^application\/json/);
});

test('sign-in input rules: only {password: string 1-1024 chars}; anything else is a 400 with the generic body, and is NOT counted toward the lockout', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const counter = countVerifies(t);
  const bads = ['not json', '', '[]', '{}', '{"password":5}', '{"password":""}', '{"password":"x","extra":1}', '{"pass":"x"}', 'null', '"x"'];
  for (const body of bads) {
    const res = await adminPost(env, '/auth/password', body);
    assert.equal(res.status, 400, body);
    assert.equal(res.text, GENERIC, body);
  }
  assert.equal(counter.calls, 0, 'no hash for a malformed request');
  // ten malformed requests did not pause anything: the right password still works
  assert.equal((await signin(env)).status, 200);
});

test('the sign-in body is capped at 1024 bytes: 1025 gives 413, 1024 is read', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const counter = countVerifies(t);
  const pad = (n) => `{"password":"${'a'.repeat(n - 15)}"}`;
  assert.equal(Buffer.byteLength(pad(1025)), 1025);
  const over = await adminPost(env, '/auth/password', pad(1025));
  assert.equal(over.status, 413);
  assert.equal(counter.calls, 0);
  const atCap = await adminPost(env, '/auth/password', pad(1024));
  assert.equal(atCap.status, 403, 'read in full, hashed, and wrong');
  assert.equal(atCap.text, GENERIC);
  assert.equal(counter.calls, 1);
});

test('Ma6/Ma16: five wrong passwords, then the sixth (even the RIGHT one) is refused with ZERO hashes; the sixth wrong one is not hashed either', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const counter = countVerifies(t);
  for (let i = 0; i < 5; i++) assert.equal((await signin(env, `wrong password ${i}`)).status, 403);
  assert.equal(counter.calls, 5);
  const right = await signin(env);
  assert.equal(right.status, 403);
  assert.equal(right.text, GENERIC);
  assert.equal(right.headers['set-cookie'], undefined);
  assert.equal((await signin(env, 'another wrong one')).status, 403);
  assert.equal(counter.calls, 5, 'a paused attempt never reaches the hash');
});

test('lockout releases on the injected clock: still paused at +899999, signed in at +900000', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const counter = countVerifies(t);
  for (let i = 0; i < 5; i++) await signin(env, `wrong ${i}`);
  const lockedAt = env.clock.t;
  env.clock.t = lockedAt + 899999;
  assert.equal((await signin(env)).status, 403);
  env.clock.t = lockedAt + 900000;
  const res = await signin(env);
  assert.equal(res.status, 200);
  assert.equal(counter.calls, 6);
});

test('the loopback token still signs in while remote password sign-in is paused', linuxOnly, async (t) => {
  const env = await startPanel(t);
  for (let i = 0; i < 5; i++) await signin(env, `wrong ${i}`);
  assert.equal((await signin(env)).status, 403);
  const exchange = await loopbackReq(env, { pathname: `/auth?token=${env.token}` });
  assert.equal(exchange.status, 303);
  assert.equal(exchange.headers.location, '/');
  const c = cookieFrom(exchange, `scriptorium_admin_${env.adminPort}`);
  assert.equal(c.raw, `scriptorium_admin_${env.adminPort}=${env.token}; Path=/; HttpOnly; SameSite=Strict`);
  const sess = await loopbackReq(env, { pathname: '/api/session', headers: { Cookie: `scriptorium_admin_${env.adminPort}=${env.token}` } });
  assert.equal(sess.status, 200);
  assert.equal(JSON.parse(sess.text).access.via, 'loopback');
});

test('single flight: while one password check is running, every concurrent attempt is refused WITHOUT a hash', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const counter = countVerifies(t);
  let release;
  counter.gate = new Promise((r) => {
    release = r;
  });
  const first = signin(env, 'wrong one');
  const waitStart = Date.now();
  while (counter.calls < 1) {
    if (Date.now() - waitStart > 3000) {
      release();
      assert.fail('the first password check never started hashing');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  // bounded: if single flight were broken these would all queue behind the gated hash and never answer
  const burstAll = Promise.all(Array.from({ length: 9 }, (_, i) => signin(env, `concurrent ${i}`)));
  const burst = await Promise.race([burstAll, new Promise((r) => setTimeout(() => r(null), 4000))]);
  if (burst === null) {
    release();
    await burstAll.catch(() => {});
    assert.fail('concurrent attempts were not refused while a check was running (single flight is broken)');
  }
  for (const r of burst) {
    assert.equal(r.status, 403);
    assert.equal(r.text, GENERIC);
  }
  assert.equal(counter.calls, 1, 'nine concurrent attempts caused no further hash');
  release();
  assert.equal((await first).status, 403);
  counter.gate = null;
  assert.equal((await signin(env)).status, 200, 'the busy flag is cleared afterwards');
});

test('ten wrong attempts sent one after another hash exactly five times, then the pause refuses the rest (Ma16)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const counter = countVerifies(t);
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await signin(env, `wrong ${i}`)).status);
  assert.deepEqual(statuses, Array(10).fill(403));
  assert.equal(counter.calls, 5);
});

// --- sessions: expiry, persistence, the stored id, rotation --------------------------------

test('Ma4: a session is valid at +86399999 and refused at +86400000', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const start = env.clock.t;
  env.clock.t = start + 86399999;
  assert.equal((await adminReq(env, { pathname: '/api/session', headers: sessionCookie(value) })).status, 200);
  env.clock.t = start + 86400000;
  const res = await adminReq(env, { pathname: '/api/session', headers: sessionCookie(value) });
  assert.equal(res.status, 403);
  assert.equal(res.text, 'refused: session');
});

test('persistence: sign in, SIGINT, relaunch (new stores, same config folder), and the cookie is still valid', linuxOnly, async (t) => {
  const first = await startPanel(t);
  const value = await signedIn(first);
  const clockT = first.clock.t;
  await first.stop();
  const clock2 = { t: clockT, now: () => clock2.t };
  const second = await startPanel(t, { fixture: first.fx, clock: clock2 });
  clock2.t = clockT + 3600000;
  const res = await adminReq(second, { pathname: '/api/session', headers: sessionCookie(value) });
  assert.equal(res.status, 200);
});

test('only digests are stored, and the stored id does not work as a cookie', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const file = path.join(env.fx.panelDir, 'sessions.json');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(value), 'the credential is not on disk');
  const id = JSON.parse(text).sessions[0].id;
  assert.equal(id, crypto.createHash('sha256').update(value).digest('hex'));
  assert.equal((await adminReq(env, { pathname: '/api/session', headers: sessionCookie(id) })).status, 403);
});

test('rotation: signing in again while presenting the old session revokes the old credential', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const old = await signedIn(env);
  const res = await signin(env, PASSWORD, { headers: sessionCookie(old) });
  assert.equal(res.status, 200);
  const fresh = cookieFrom(res, '__Host-scriptorium_session').value;
  assert.notEqual(fresh, old);
  assert.equal((await adminReq(env, { pathname: '/api/session', headers: sessionCookie(old) })).status, 403);
  assert.equal((await adminReq(env, { pathname: '/api/session', headers: sessionCookie(fresh) })).status, 200);
});

test('Ma14: a valid credential under a cookie NAME that merely starts with the real one is not accepted; a same-name decoy before the real cookie does not shadow it', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const sibling = await adminReq(env, { pathname: '/api/session', headers: { Cookie: `__Host-scriptorium_sessionX=${value}` } });
  assert.equal(sibling.status, 403);
  const suffixed = await adminReq(env, { pathname: '/api/session', headers: { Cookie: `x__Host-scriptorium_session=${value}` } });
  assert.equal(suffixed.status, 403);
  const decoy = await adminReq(env, { pathname: '/api/session', headers: { Cookie: `__Host-scriptorium_session=junk; __Host-scriptorium_session=${value}` } });
  assert.equal(decoy.status, 200);
});

test('credentials are per kind: the preview cookie does not open the admin listener, and an admin cookie does not open the preview', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const asPreview = await adminReq(env, { pathname: '/api/session', headers: { Cookie: `__Host-scriptorium_preview=${value}` } });
  assert.equal(asPreview.status, 403);
  const onPreview = await previewReq(env, { headers: { Cookie: `__Host-scriptorium_session=${value}` } });
  assert.equal(onPreview.status, 403);
  assert.equal(onPreview.text, 'refused: session');
});

test('/auth?token= with the external Host is refused (403, signin page, NO Set-Cookie): the token never signs a remote request in (Ma5)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const res = await adminReq(env, { pathname: `/auth?token=${env.token}` });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'signin.html')));
  assert.equal(res.headers['set-cookie'], undefined);
});

test('no cross-kind credentials: the loopback cookie on the external Host is "session"; a remote cookie on the loopback Host is "token"', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const loopCookie = `scriptorium_admin_${env.adminPort}=${env.token}`;
  const a = await adminReq(env, { pathname: '/api/session', headers: { Cookie: loopCookie } });
  assert.equal(a.status, 403);
  assert.equal(a.text, 'refused: session');
  const remote = await signedIn(env);
  const b = await loopbackReq(env, { pathname: '/api/session', headers: sessionCookie(remote) });
  assert.equal(b.status, 403);
  assert.equal(b.text, 'refused: token');
});

test('/auth/password on the loopback Host is refused as kind (Ma23); the password never signs a loopback request in', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const res = await request(env.adminPort, {
    method: 'POST',
    pathname: '/auth/password',
    host: `127.0.0.1:${env.adminPort}`,
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${env.adminPort}` },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 403);
  assert.equal(res.text, 'refused: kind');
  assert.equal(res.headers['set-cookie'], undefined);
});

// =========================================================================================
// peers, forwarded headers, Host and Origin over real sockets
// =========================================================================================

test('Ma1/Ma2: a forged leftmost X-Forwarded-For is ignored: the audit `from` is the address the proxy appended', linuxOnly, async (t) => {
  const env = await startPanel(t, { proxyOpts: { clientAddress: '198.51.100.77' } });
  await signin(env, 'wrong', { headers: { 'X-Forwarded-For': '203.0.113.9, 192.0.2.99' } });
  await signin(env, PASSWORD, { headers: { 'X-Forwarded-For': '203.0.113.200' } });
  const signins = readAudit(env).filter((e) => e.event === 'signin');
  assert.equal(signins.length, 2);
  for (const e of signins) assert.equal(e.from, '198.51.100.77');
  assert.deepEqual(signins.map((e) => e.result), ['refused', 'ok']);
});

test('Ma1: X-Forwarded-For on a LOOPBACK-Host request is never read: the audit `from` is the socket peer', linuxOnly, async (t) => {
  const env = await startPanel(t);
  await loopbackReq(env, { pathname: `/auth?token=${env.token}`, headers: { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https' } });
  const entry = readAudit(env).find((e) => e.event === 'signin' && e.method === 'token');
  assert.equal(entry.from, '127.0.0.1');
  assert.equal(entry.via, 'loopback');
  assert.equal(entry.result, 'ok');
});

test('X-Forwarded-Proto: http through the proxy is refused as proto', linuxOnly, async (t) => {
  const env = await startPanel(t, { proxyOpts: { proto: 'http' } });
  const res = await adminReq(env, { pathname: '/api/session' });
  assert.equal(res.status, 403);
  assert.equal(res.text, 'refused: proto');
});

test('Ma7: an Origin with the wrong scheme (http://scriptorium.home.arpa) on the sign-in POST is refused as origin, with no hash and no cookie', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const counter = countVerifies(t);
  const res = await signin(env, PASSWORD, { origin: `http://${ADMIN_HOST}` });
  assert.equal(res.status, 403);
  assert.equal(res.text, 'refused: origin');
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(counter.calls, 0);
});

test('Ma8: the PREVIEW origin POSTing to the admin listener is refused as origin (login CSRF from preview content)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  for (const origin of [PREVIEW_ORIGIN, 'null', `${ADMIN_ORIGIN}:443`, `${ADMIN_ORIGIN}/`, `http://127.0.0.1:${env.adminPort}`, undefined]) {
    const headers = { ...sessionCookie(value) };
    const res = await adminReq(env, { method: 'POST', pathname: '/api/noop', body: '{}', headers: { ...headers, 'Content-Type': 'application/json', ...(origin === undefined ? {} : { Origin: origin }) } });
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.text, 'refused: origin', String(origin));
  }
  const ok = await adminPost(env, '/api/noop', {}, { headers: sessionCookie(value) });
  assert.equal(ok.status, 200);
});

const HOST_CASES = [
  ['a trailing dot', `${ADMIN_HOST}.`],
  ['a prefix', `evil.${ADMIN_HOST}`],
  ['Ma13: a suffix', `${ADMIN_HOST}.evil.example`],
  ['a wrong port', `${ADMIN_HOST}:7924`],
  ['the raw LAN address', '192.0.2.42:7924'],
  ['the raw LAN address without a port', '192.0.2.42'],
  ['localhost on the wrong port', 'localhost:1'],
  ['the preview name on the admin listener', PREVIEW_HOST],
];

for (const [label, host] of HOST_CASES) {
  test(`FR-05 over a real socket, before auth: ${label} gives 403 host`, linuxOnly, async (t) => {
    const env = await startPanel(t);
    const res = await request(env.adminProxy.port, { host, pathname: '/api/session', headers: { Cookie: `__Host-scriptorium_session=${'a'.repeat(43)}` } });
    assert.equal(res.status, 403);
    assert.equal(res.text, 'refused: host');
  });
}

test('FR-05: the external host matches case-insensitively, and the default-port form has no port', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const res = await request(env.adminProxy.port, { host: 'ScRiPtOrIuM.HOME.arpa', pathname: '/api/session' });
  assert.equal(res.status, 403);
  assert.equal(res.text, 'refused: session', 'the Host passed; it is the missing session that refused it');
});

test('FR-05 raw sockets: a missing Host and duplicate Host headers (what Node itself does is recorded, and the panel refuses what reaches it)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const cookie = `Cookie: __Host-scriptorium_session=${'a'.repeat(43)}\r\n`;
  const common = `X-Forwarded-Proto: https\r\nX-Forwarded-For: 198.51.100.77\r\n${cookie}Connection: close\r\n\r\n`;
  const missing = await rawRequest(env.adminPort, `GET /api/session HTTP/1.1\r\n${common}`, { localAddress: '127.0.0.2' });
  assert.match(missing.split('\r\n')[0], /^HTTP\/1\.1 (400|403)/, `missing Host: ${missing.split('\r\n')[0]}`);
  // Recorded on Node 22: the HTTP parser does NOT reject a duplicate Host (the handler runs, with
  // req.headers.host holding the first value), so the gate's rawHeaders rule is what refuses it. A
  // missing Host, by contrast, is answered 400 by Node itself.
  const dupe = await rawRequest(env.adminPort, `GET /api/session HTTP/1.1\r\nHost: ${ADMIN_HOST}\r\nHost: ${ADMIN_HOST}\r\n${common}`, { localAddress: '127.0.0.2' });
  assert.match(dupe.split('\r\n')[0], /^HTTP\/1\.1 403/, `duplicate Host: ${dupe.split('\r\n')[0]}`);
  assert.ok(dupe.includes('refused: host'), 'refused by the gate (a chunked text body), not by the parser: ' + JSON.stringify(dupe));
  // a duplicate Host with a GOOD loopback form first is also refused (the gate's rule, on a fake socket-free path, is in remote-gate.test.js)
  const mixed = await rawRequest(env.adminPort, `GET /api/session HTTP/1.1\r\nHost: 127.0.0.1:${env.adminPort}\r\nHost: ${ADMIN_HOST}\r\n${common}`, { localAddress: '127.0.0.2' });
  assert.match(mixed.split('\r\n')[0], /^HTTP\/1\.1 (400|403)/);
});

test('Ma12/Ma17: connections from 127.0.0.3 and 127.0.0.20 (the trusted proxy is 127.0.0.2) receive NO bytes; 127.0.0.2 and loopback are answered', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const good = `GET /api/session HTTP/1.1\r\nHost: ${ADMIN_HOST}\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`;
  for (const localAddress of ['127.0.0.3', '127.0.0.20', '127.0.0.200']) {
    assert.equal(await rawRequest(env.adminPort, good, { localAddress }), '', `${localAddress} must get nothing`);
    assert.equal(await rawRequest(env.previewPort, good.replace(ADMIN_HOST, PREVIEW_HOST), { localAddress }), '', `${localAddress} must get nothing on the preview listener either`);
  }
  assert.match(await rawRequest(env.adminPort, good, { localAddress: '127.0.0.2' }), /^HTTP\/1\.1 403/);
  assert.match(await rawRequest(env.adminPort, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${env.adminPort}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 403/);
});

test('a loopback-Host request from a trusted-proxy address that is not loopback is refused as peer', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const res = await request(env.adminPort, { host: `127.0.0.1:${env.adminPort}`, pathname: '/', localAddress: '127.0.0.2' });
  assert.equal(res.status, 403);
  assert.equal(res.text, 'refused: peer');
});

// =========================================================================================
// the audit hook
// =========================================================================================

const AUDITED_POSTS = ADMIN_ROUTES.filter((r) => r.method === 'POST' && r.audit === true).map((r) => r.path);

test('A2: the POST routes WITHOUT the audit flag are exactly /api/noop and the four that write their own events (pinned structurally)', () => {
  const unflagged = ADMIN_ROUTES.filter((r) => r.method === 'POST' && r.audit !== true).map((r) => r.path).sort();
  assert.deepEqual(unflagged, ['/api/noop', '/api/remote/signout', '/api/remote/signout-all', '/auth/launch', '/auth/password']);
  assert.equal(AUDITED_POSTS.length, 21);
  for (const r of ADMIN_ROUTES.filter((x) => x.method !== 'POST')) assert.notEqual(r.audit, true, `${r.path}: audit is for POSTs`);
});

test('the audit hook writes a request line then a response line for EVERY audited route (remote and loopback), with route, via, from, campaign and status', linuxOnly, async (t) => {
  const env = await startPanel(t, { proxyOpts: { clientAddress: '198.51.100.77' } });
  const value = await signedIn(env);
  const loopCookie = `scriptorium_admin_${env.adminPort}=${env.token}`;
  for (const route of AUDITED_POSTS) {
    const before = readAudit(env).length;
    const res = await adminPost(env, route, '{}', { headers: sessionCookie(value) });
    const lines = readAudit(env).slice(before);
    assert.equal(lines.length, 2, `${route}: two lines`);
    assert.deepEqual(lines.map((l) => l.event), ['request', 'response'], route);
    for (const l of lines) {
      assert.equal(l.route, route);
      assert.equal(l.via, 'remote');
      assert.equal(l.from, '198.51.100.77');
      assert.equal(l.campaign, 'alpha');
    }
    assert.equal(lines[0].method, 'POST');
    assert.equal(lines[1].status, res.status, route);
    assert.equal(lines[0].status, undefined);

    const beforeLoop = readAudit(env).length;
    const loopRes = await request(env.adminPort, { method: 'POST', pathname: route, host: `127.0.0.1:${env.adminPort}`, body: '{}', headers: { Cookie: loopCookie, Origin: `http://127.0.0.1:${env.adminPort}`, 'Content-Type': 'application/json' } });
    const loopLines = readAudit(env).slice(beforeLoop);
    assert.deepEqual(loopLines.map((l) => l.event), ['request', 'response'], `${route} (loopback)`);
    assert.equal(loopLines[0].via, 'loopback');
    assert.equal(loopLines[0].from, '127.0.0.1');
    assert.equal(loopLines[1].status, loopRes.status);
  }
});

test('a non-audited POST (/api/noop) and GETs write no request/response lines', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const before = readAudit(env).length;
  await adminPost(env, '/api/noop', {}, { headers: sessionCookie(value) });
  await adminReq(env, { pathname: '/api/session', headers: sessionCookie(value) });
  assert.equal(readAudit(env).length, before);
});

test('Ma20/Mf6: audit failing: a REMOTE save gets 503 {error:audit} and the handler never runs (vault-config.md unchanged, no backup); a LOOPBACK save proceeds and the screen shows ok:false', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const vaultConfig = path.join(env.fx.vault, '_meta', 'vault-config.md');
  const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(vaultConfig)).digest('hex');
  // break the log AFTER signing in: the file becomes a directory, so every append now fails
  const log = path.join(env.fx.panelDir, 'audit.log');
  fs.rmSync(log);
  fs.mkdirSync(log);
  const body = JSON.stringify({ text: '---\ntype: meta\npublish:\n  mode: player\n---\n\n# changed by a remote session\n', expectedSha256: shaBefore });
  const remote = await adminPost(env, '/api/vault-config/text', body, { headers: sessionCookie(value) });
  assert.equal(remote.status, 503);
  assert.equal(remote.text, AUDIT_503);
  assert.match(remote.headers['content-type'], /^application\/json/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(vaultConfig)).digest('hex'), shaBefore, 'the vault file is untouched');
  assert.equal(fs.existsSync(path.join(env.fx.root, 'backups')), false, 'no backup was written');
  // other audited routes refuse the same way
  for (const route of ['/api/check', '/api/pack/theme', '/api/prefs']) {
    const r = await adminPost(env, route, '{}', { headers: sessionCookie(value) });
    assert.equal(r.status, 503, route);
    assert.equal(r.text, AUDIT_503, route);
  }
  // loopback proceeds: the handler ran (any answer but the audit refusal), and the screen shows the failure
  const loopCookie = `scriptorium_admin_${env.adminPort}=${env.token}`;
  const loop = await request(env.adminPort, { method: 'POST', pathname: '/api/check', host: `127.0.0.1:${env.adminPort}`, body: '{}', headers: { Cookie: loopCookie, Origin: `http://127.0.0.1:${env.adminPort}`, 'Content-Type': 'application/json' } });
  assert.notEqual(loop.status, 503);
  assert.notEqual(loop.text, AUDIT_503);
  const screen = await request(env.adminPort, { pathname: '/api/remote', host: `127.0.0.1:${env.adminPort}`, headers: { Cookie: loopCookie } });
  assert.equal(JSON.parse(screen.text).audit.ok, false);
});

test('a remote password sign-in is refused (403 generic, no cookie, no hash) while the audit log cannot be written', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const counter = countVerifies(t);
  fs.mkdirSync(path.join(env.fx.panelDir, 'audit.log'));
  const res = await signin(env);
  assert.equal(res.status, 403);
  assert.equal(res.text, GENERIC);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(counter.calls, 0);
});

test('sign-in audit entries carry method, result, via, from, browser family and campaign, and never the password or a cookie value', linuxOnly, async (t) => {
  const env = await startPanel(t, { proxyOpts: { clientAddress: '198.51.100.77' } });
  await signin(env, 'a wrong password that must not be logged', { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' } });
  const value = await signedIn(env);
  const entries = readAudit(env);
  const refused = entries.find((e) => e.event === 'signin' && e.result === 'refused');
  assert.deepEqual(Object.keys(refused).sort(), ['browser', 'campaign', 'event', 'from', 'method', 'result', 't', 'via']);
  assert.equal(refused.browser, 'Firefox');
  assert.equal(refused.method, 'password');
  assert.equal(refused.via, 'remote');
  const text = fs.readFileSync(path.join(env.fx.panelDir, 'audit.log'), 'utf8');
  for (const secret of ['a wrong password that must not be logged', PASSWORD, value, env.token]) assert.ok(!text.includes(secret), 'a secret reached the audit log');
});

test('Ma10: lockout-start is audited when the fifth failure arrives, and lockout-end (stamped when the pause ended, with the refused count) when it is first observed', linuxOnly, async (t) => {
  const env = await startPanel(t);
  for (let i = 0; i < 5; i++) await signin(env, `wrong ${i}`);
  const startedAt = env.clock.t;
  for (let i = 0; i < 3; i++) await signin(env);
  env.clock.t = startedAt + 900000 + 5 * 60000;
  assert.equal((await signin(env)).status, 200);
  const entries = readAudit(env);
  const start = entries.find((e) => e.event === 'lockout-start');
  assert.equal(start.until, startedAt + 900000);
  const end = entries.find((e) => e.event === 'lockout-end');
  assert.equal(end.refused, 3);
  assert.equal(end.t, new Date(startedAt + 900000).toISOString(), 'stamped with when the pause actually ended');
  assert.ok(entries.indexOf(start) < entries.indexOf(end));
});

test('coalescing: the FIRST refusal of a pause is audited, the rest are only counted (the log cannot be filled one line per attempt)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  for (let i = 0; i < 5; i++) await signin(env, `wrong ${i}`);
  const before = readAudit(env).filter((e) => e.event === 'signin').length;
  for (let i = 0; i < 20; i++) await signin(env);
  const after = readAudit(env).filter((e) => e.event === 'signin').length;
  assert.equal(after - before, 1, 'twenty paused attempts wrote one signin line');
});

test('the audit log is created at 0600 inside a 0700 panel folder, and the sign-in password file likewise', { skip: process.platform !== 'linux' }, async (t) => {
  const env = await startPanel(t);
  await signedIn(env);
  assert.equal(fs.statSync(env.fx.panelDir).mode & 0o777, 0o700);
  for (const f of ['audit.log', 'sessions.json', 'password.json']) assert.equal(fs.statSync(path.join(env.fx.panelDir, f)).mode & 0o777, 0o600, f);
});

// =========================================================================================
// Open preview: the ticket hand-off (SD-a9, SD-a17)
// =========================================================================================

function ticketOf(location) {
  const url = new URL(location);
  return { origin: url.origin, pathname: url.pathname, ticket: url.searchParams.get('ticket'), to: url.searchParams.get('to'), search: url.search };
}

test('Open preview end to end: 303 to the PREVIEW origin /:enter with a ticket; entering sets the exact preview cookie and lands on / with no ticket in the URL', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const open = await adminReq(env, { pathname: '/open-preview', headers: sessionCookie(value) });
  assert.equal(open.status, 303);
  assert.match(open.headers['content-security-policy'], /frame-ancestors 'self'/, 'the one deliberate exception');
  const hop = ticketOf(open.headers.location);
  assert.equal(hop.origin, PREVIEW_ORIGIN);
  assert.equal(hop.pathname, '/:enter');
  assert.match(hop.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hop.to, null);

  const enter = await previewReq(env, { pathname: `${hop.pathname}${hop.search}` });
  assert.equal(enter.status, 303);
  assert.equal(enter.headers.location, '/');
  assert.match(enter.headers['content-security-policy'] || '', /^frame-ancestors https:\/\/scriptorium\.home\.arpa$/);
  const c = cookieFrom(enter, '__Host-scriptorium_preview');
  assert.match(c.value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(c.attrs.length, 5);
  assert.match(c.attrs[1], /^Max-Age=\d+$/);
  const maxAge = Number(c.attrs[1].slice('Max-Age='.length));
  assert.ok(maxAge > 86390 && maxAge <= 86400, `Max-Age ${maxAge} is the remaining life of the admin session`);
  assert.deepEqual([c.attrs[0], ...c.attrs.slice(2)], ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']);

  const page = await previewReq(env, { headers: { Cookie: `__Host-scriptorium_preview=${c.value}` } });
  assert.notEqual(page.status, 403);
  assert.ok(!(page.headers.location || '').includes('ticket='));
  assert.equal(page.headers['content-security-policy'], `frame-ancestors ${ADMIN_ORIGIN}`, 'preview responses name the admin origin as their only frame-ancestors');
  const without = await previewReq(env, {});
  assert.equal(without.status, 403);
});

test('Ma18: a ticket is single use: the second /:enter is "refused: session"', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const hop = ticketOf((await adminReq(env, { pathname: '/open-preview', headers: sessionCookie(value) })).headers.location);
  assert.equal((await previewReq(env, { pathname: `/:enter${hop.search}` })).status, 303);
  const again = await previewReq(env, { pathname: `/:enter${hop.search}` });
  assert.equal(again.status, 403);
  assert.equal(again.text, 'refused: session');
  assert.equal(again.headers['set-cookie'], undefined);
});

test('Ma19: a ticket is good at +59999 ms and refused at +60000 ms', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const fresh = ticketOf((await adminReq(env, { pathname: '/open-preview', headers: sessionCookie(value) })).headers.location);
  const stale = ticketOf((await adminReq(env, { pathname: '/open-preview', headers: sessionCookie(value) })).headers.location);
  env.clock.t += 59999;
  assert.equal((await previewReq(env, { pathname: `/:enter${fresh.search}` })).status, 303);
  env.clock.t += 1;
  assert.equal((await previewReq(env, { pathname: `/:enter${stale.search}` })).status, 403);
});

test('/:enter is for remote requests only and never for HEAD: loopback gets "refused: kind", HEAD gets "refused: kind" and mints nothing', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const loop = await loopbackPreviewReq(env, { pathname: '/:enter?ticket=abc' });
  assert.equal(loop.status, 403);
  assert.equal(loop.text, 'refused: kind');
  const head = await previewReq(env, { method: 'HEAD', pathname: '/:enter?ticket=abc' });
  assert.equal(head.status, 403);
  const garbage = await previewReq(env, { pathname: '/:enter?ticket=notaticket' });
  assert.equal(garbage.status, 403);
  assert.equal(garbage.text, 'refused: session');
  const none = await previewReq(env, { pathname: '/:enter' });
  assert.equal(none.status, 403);
});

test('HEAD /open-preview is 204, has no Location, and mints nothing (the 33rd GET would have evicted the first ticket if HEAD had minted one)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const headers = sessionCookie(value);
  const first = ticketOf((await adminReq(env, { pathname: '/open-preview', headers })).headers.location);
  const head = await adminReq(env, { method: 'HEAD', pathname: '/open-preview', headers });
  assert.equal(head.status, 204);
  assert.equal(head.headers.location, undefined);
  for (let i = 0; i < 30; i++) await adminReq(env, { pathname: '/open-preview', headers });
  // 1 + 30 minted so far; max is 32. One more mint is fine; a HEAD that had minted would have made it 33 minted before this line
  await adminReq(env, { pathname: '/open-preview', headers });
  assert.equal((await previewReq(env, { pathname: `/:enter${first.search}` })).status, 303, 'the first ticket survived: HEAD minted nothing');
});

test('Mf3: `to` is re-validated on the server: //evil.example, .., a backslash, a colon, a query, a fragment, an absolute URL are all refused with no Location', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const bad = ['//evil.example', '..', 'a/../b', 'a\\b', 'http://evil.example/', 'a:b', 'a?b=1', 'a#b', '/abs', 'a//b', './a', '', ':variant/x', ':variant/Bad Id/a.html', ':variant/ok/', ':variant/ok/../x'];
  for (const to of bad.filter((x) => x !== '')) {
    const res = await adminReq(env, { pathname: `/open-preview?to=${encodeURIComponent(to)}`, headers: sessionCookie(value) });
    assert.equal(res.status, 400, JSON.stringify(to));
    assert.equal(res.headers.location, undefined, JSON.stringify(to));
    assert.equal(res.text, 'refused: url');
  }
  // a percent-encoded protocol-relative target (decoded once by the query parser) is refused too
  const encoded = await adminReq(env, { pathname: '/open-preview?to=%2F%2Fevil.example', headers: sessionCookie(value) });
  assert.equal(encoded.status, 400);
  assert.equal(encoded.headers.location, undefined);
  // and /:enter refuses the same targets even with a good ticket (the redirect can never leave the preview origin)
  for (const to of ['//evil.example', '..', 'a\\b']) {
    const hop = ticketOf((await adminReq(env, { pathname: '/open-preview', headers: sessionCookie(value) })).headers.location);
    const res = await previewReq(env, { pathname: `/:enter?ticket=${hop.ticket}&to=${encodeURIComponent(to)}` });
    assert.equal(res.status, 400, to);
    assert.equal(res.headers.location, undefined, to);
  }
});

test('a valid `to` rides through the hand-off: the Location on the preview origin, then the page path on the redirect (encoded per segment)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  for (const [to, finalPath] of [['characters/example-person.html', '/characters/example-person.html'], ['a b/c d.html', '/a%20b/c%20d.html'], [':variant/gloam/index.html', '/:variant/gloam/index.html']]) {
    const open = await adminReq(env, { pathname: `/open-preview?to=${encodeURIComponent(to)}`, headers: sessionCookie(value) });
    assert.equal(open.status, 303, to);
    const hop = ticketOf(open.headers.location);
    assert.equal(hop.origin, PREVIEW_ORIGIN, 'the Location stays on the preview origin');
    assert.equal(hop.to, to);
    const enter = await previewReq(env, { pathname: `/:enter${hop.search}` });
    assert.equal(enter.status, 303, to);
    assert.equal(enter.headers.location, finalPath);
  }
});

test('Mf4: three frame loads give exactly ONE preview session record (the second and third /:enter reuse the preview session the browser already holds)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  let previewCookie = null;
  for (let i = 0; i < 3; i++) {
    const hop = ticketOf((await adminReq(env, { pathname: '/open-preview?to=index.html', headers: sessionCookie(value) })).headers.location);
    const enter = await previewReq(env, { pathname: `/:enter${hop.search}`, headers: previewCookie ? { Cookie: `__Host-scriptorium_preview=${previewCookie}` } : {} });
    assert.equal(enter.status, 303);
    const c = cookieFrom(enter, '__Host-scriptorium_preview');
    if (previewCookie === null) {
      assert.ok(c, 'the first entry sets the cookie');
      previewCookie = c.value;
    } else {
      assert.equal(c, null, `entry ${i + 1} reuses the session, no new cookie`);
    }
  }
  const records = JSON.parse(fs.readFileSync(path.join(env.fx.panelDir, 'sessions.json'), 'utf8')).sessions;
  assert.equal(records.filter((r) => r.kind === 'preview').length, 1);
  assert.equal(records.filter((r) => r.kind === 'admin').length, 1);
});

test('a browser with NO preview cookie entering with a ticket gets a new preview session even when another exists; a preview session ends with its admin session', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  const mk = async () => ticketOf((await adminReq(env, { pathname: '/open-preview', headers: sessionCookie(value) })).headers.location);
  const a = cookieFrom(await previewReq(env, { pathname: `/:enter${(await mk()).search}` }), '__Host-scriptorium_preview').value;
  const b = cookieFrom(await previewReq(env, { pathname: `/:enter${(await mk()).search}` }), '__Host-scriptorium_preview').value;
  assert.notEqual(a, b);
  assert.notEqual((await previewReq(env, { headers: { Cookie: `__Host-scriptorium_preview=${b}` } })).status, 403);
  env.clock.t += 86400000;
  assert.equal((await previewReq(env, { headers: { Cookie: `__Host-scriptorium_preview=${b}` } })).status, 403);
});

test('FR-14/Ma8: the preview Host needs a preview session; the admin cookie is not one; no CORS headers anywhere (checked on every response of this file)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const res = await previewReq(env, { pathname: '/index.html' });
  assert.equal(res.status, 403);
  assert.equal(res.text, 'refused: session');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('loopback Open preview: 303 to the loopback preview URL in the request\'s own host form, carrying frame-ancestors \'self\'', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const cookie = { Cookie: `scriptorium_admin_${env.adminPort}=${env.token}` };
  const open = await loopbackReq(env, { pathname: '/open-preview', headers: cookie });
  assert.equal(open.status, 303);
  assert.equal(open.headers.location, `http://127.0.0.1:${env.previewPort}/`);
  const named = await request(env.adminPort, { host: `localhost:${env.adminPort}`, pathname: '/open-preview?to=a/b.html', headers: cookie });
  assert.equal(named.headers.location, `http://localhost:${env.previewPort}/a/b.html`);
  assert.match(named.headers['content-security-policy'], /frame-ancestors 'self'/);
});

test('the loopback preview in remote mode still frames with the loopback frame-ancestors, and still accepts the loopback cookie', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const res = await loopbackPreviewReq(env, { pathname: '/', headers: { Cookie: `scriptorium_admin_${env.adminPort}=${env.token}` } });
  assert.notEqual(res.status, 403);
  assert.equal(res.headers['content-security-policy'], `frame-ancestors http://127.0.0.1:${env.adminPort}`);
});

// =========================================================================================
// /api/remote, sign-outs
// =========================================================================================

test('GET /api/remote: the full shape for a remote request, and NOTHING secret (no token, hash, salt, session ids, credentials, password)', linuxOnly, async (t) => {
  const env = await startPanel(t, { proxyOpts: { clientAddress: '198.51.100.77' } });
  const value = await signedIn(env);
  await signin(env, 'wrong');
  const res = await adminReq(env, { pathname: '/api/remote', headers: sessionCookie(value) });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.requestKind, 'remote');
  assert.equal(body.mode, 'proxy');
  assert.equal(body.configPath, env.fx.configPath);
  assert.deepEqual(body.addresses, { admin: ADMIN_ORIGIN, preview: PREVIEW_ORIGIN, adminLoopback: `http://127.0.0.1:${env.adminPort}`, previewLoopback: `http://127.0.0.1:${env.previewPort}` });
  assert.deepEqual(body.listening.hosts, ['127.0.0.1']);
  assert.equal(body.listening.adminPort, 7924);
  assert.equal(body.listening.previewPort, 7925);
  assert.deepEqual(body.listening.answers, ['127.0.0.2', '127.0.0.1', '::1']);
  assert.deepEqual(body.https, { by: 'proxy', hop: 'plain' });
  assert.equal(body.password.set, true);
  assert.equal(typeof body.password.setAt, 'string');
  assert.deepEqual(body.lockout, { active: false, until: null, recentFailures: 1, refused: 0 });
  assert.deepEqual(body.sessions, { active: 1 });
  assert.equal(body.audit.ok, true);
  assert.equal(body.audit.file, path.join(env.fx.panelDir, 'audit.log'));
  assert.deepEqual(body.files, { looseModes: [] });
  assert.equal(body.tls, null);
  assert.ok(Array.isArray(body.recentSignins) && body.recentSignins.length >= 2);
  assert.ok(Array.isArray(body.log));
  assert.equal(body.truncated, false);
  const record = JSON.parse(fs.readFileSync(path.join(env.fx.panelDir, 'password.json'), 'utf8'));
  const sessionId = JSON.parse(fs.readFileSync(path.join(env.fx.panelDir, 'sessions.json'), 'utf8')).sessions[0].id;
  for (const secret of [env.token, record.hash, record.salt, sessionId, value, PASSWORD, 'wrong']) {
    assert.ok(!res.text.includes(secret), `the response leaked a secret (${secret.slice(0, 6)}...)`);
  }
});

test('GET /api/remote reflects the lockout: active with until, and the refused count', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  for (let i = 0; i < 5; i++) await signin(env, `wrong ${i}`);
  await signin(env);
  await signin(env);
  const at = env.clock.t;
  const body = JSON.parse((await adminReq(env, { pathname: '/api/remote', headers: sessionCookie(value) })).text);
  assert.deepEqual(body.lockout, { active: true, until: at + 900000, recentFailures: 0, refused: 2 });
});

test('GET /api/remote for a local-mode panel: kind loopback, mode local, no external addresses, https by none', linuxOnly, async (t) => {
  const env = await startPanel(t, { local: true });
  const res = await loopbackReq(env, { pathname: '/api/remote', headers: { Cookie: `scriptorium_admin_${env.adminPort}=${env.token}` } });
  const body = JSON.parse(res.text);
  assert.equal(body.requestKind, 'loopback');
  assert.equal(body.mode, 'local');
  assert.equal(body.addresses.admin, null);
  assert.equal(body.addresses.preview, null);
  assert.deepEqual(body.https, { by: 'none', hop: null });
  assert.deepEqual(body.listening.answers, ['this machine']);
  assert.equal(body.password.set, false);
});

test('local mode, the deliberate differences only: /api/session gains access, /open-preview exists, /auth/password is refused as kind', linuxOnly, async (t) => {
  const env = await startPanel(t, { local: true });
  const cookie = { Cookie: `scriptorium_admin_${env.adminPort}=${env.token}` };
  const sess = JSON.parse((await loopbackReq(env, { pathname: '/api/session', headers: cookie })).text);
  assert.deepEqual(sess.access, { mode: 'local', via: 'loopback', reach: 'Bound to 127.0.0.1 only', previewUrl: null, loopbackScheme: 'http' });
  assert.deepEqual(Object.keys(sess).sort(), ['access', 'campaign', 'launch', 'previewPort', 'readOnlyReason', 'siteSource', 'writable']);
  assert.equal((await loopbackReq(env, { pathname: '/open-preview', headers: cookie })).status, 303);
  const pwRes = await request(env.adminPort, { method: 'POST', pathname: '/auth/password', host: `127.0.0.1:${env.adminPort}`, body: '{}', headers: { Origin: `http://127.0.0.1:${env.adminPort}`, 'Content-Type': 'application/json' } });
  assert.equal(pwRes.status, 403);
  assert.equal(pwRes.text, 'refused: kind');
  // local mode never creates sessions or a password file; the audit log appears on first use
  assert.equal(fs.existsSync(path.join(env.fx.panelDir, 'sessions.json')), false);
  assert.equal(fs.existsSync(path.join(env.fx.panelDir, 'password.json')), false);
});

test('POST /api/remote/signout: a remote request revokes only its own session and clears its cookie; the other device stays signed in', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const a = await signedIn(env);
  const b = await signedIn(env);
  const res = await adminPost(env, '/api/remote/signout', {}, { headers: sessionCookie(a) });
  assert.equal(res.status, 200);
  assert.equal(res.text, '{"ok":true}');
  assert.equal([].concat(res.headers['set-cookie'])[0], '__Host-scriptorium_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict');
  assert.equal((await adminReq(env, { pathname: '/api/session', headers: sessionCookie(a) })).status, 403);
  assert.equal((await adminReq(env, { pathname: '/api/session', headers: sessionCookie(b) })).status, 200);
  const ev = readAudit(env).filter((e) => e.event === 'signout');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].via, 'remote');
});

test('POST /api/remote/signout from the loopback: clears the loopback cookie, 200', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const res = await request(env.adminPort, { method: 'POST', pathname: '/api/remote/signout', host: `127.0.0.1:${env.adminPort}`, body: '{}', headers: { Cookie: `scriptorium_admin_${env.adminPort}=${env.token}`, Origin: `http://127.0.0.1:${env.adminPort}`, 'Content-Type': 'application/json' } });
  assert.equal(res.status, 200);
  assert.equal([].concat(res.headers['set-cookie'])[0], `scriptorium_admin_${env.adminPort}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
});

test('POST /api/remote/signout-all: every remote device is signed out at once, the caller\'s cookie is cleared, the count is reported and audited', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const a = await signedIn(env);
  const b = await signedIn(env);
  const res = await adminPost(env, '/api/remote/signout-all', {}, { headers: sessionCookie(a) });
  assert.equal(res.status, 200);
  assert.equal(res.text, '{"ok":true,"signedOut":2}');
  assert.equal([].concat(res.headers['set-cookie'])[0], '__Host-scriptorium_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict');
  for (const v of [a, b]) assert.equal((await adminReq(env, { pathname: '/api/session', headers: sessionCookie(v) })).status, 403);
  const ev = readAudit(env).find((e) => e.event === 'signout-all');
  assert.equal(ev.by, 'panel');
  assert.equal(ev.count, 2);
});

test('signing out is allowed even while the audit log cannot be written', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const a = await signedIn(env);
  const log = path.join(env.fx.panelDir, 'audit.log');
  fs.rmSync(log);
  fs.mkdirSync(log);
  assert.equal((await adminPost(env, '/api/remote/signout', {}, { headers: sessionCookie(a) })).status, 200);
});

test('Ma11 shape: a sign-out-all from ANOTHER process (the CLI: a second store over the same file) takes effect on the running panel at once', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const value = await signedIn(env);
  assert.equal((await adminReq(env, { pathname: '/api/session', headers: sessionCookie(value) })).status, 200);
  const cli = createSessionStore({ file: path.join(env.fx.panelDir, 'sessions.json'), now: env.clock.now });
  cli.load();
  assert.deepEqual(cli.revokeAll(), { count: 1 });
  const res = await adminReq(env, { pathname: '/api/session', headers: sessionCookie(value) });
  assert.equal(res.status, 403);
  assert.equal(res.text, 'refused: session');
  const shell = await adminReq(env, {});
  assert.equal(shell.status, 403, 'the next page load lands on the sign-in page');
  assert.deepEqual(shell.body, fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'signin.html')));
});

test('a changed password file applies at once: the panel re-reads it on every attempt (cleared means sign-in is refused)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  assert.equal((await signin(env)).status, 200);
  pwWrite.clearPasswordRecord(path.join(env.fx.panelDir, 'password.json'));
  const res = await signin(env);
  assert.equal(res.status, 403);
  assert.equal(res.text, GENERIC);
  assert.ok(readAudit(env).some((e) => e.event === 'signin' && e.result === 'error'));
  pwWrite.writePasswordRecord(path.join(env.fx.panelDir, 'password.json'), await pw.hashPassword('a brand new password'));
  assert.equal((await signin(env, 'a brand new password')).status, 200);
  assert.equal((await signin(env)).status, 403);
});

test('the GM link in a preview page points at the external admin address in remote modes, with no token', linuxOnly, async (t) => {
  const { gmLinkHrefFor } = require('../src/admin/gmlink');
  assert.equal(gmLinkHrefFor({ access: { remote: true, admin: { origin: ADMIN_ORIGIN } }, adminPort: 7924 }), `${ADMIN_ORIGIN}/`);
  assert.equal(gmLinkHrefFor({ access: null, adminPort: 7924 }), 'http://127.0.0.1:7924/');
  assert.equal(gmLinkHrefFor({ adminPort: 7924 }), 'http://127.0.0.1:7924/');
  void t;
});

// =========================================================================================
// the tailscale shape: loopback is the trusted proxy
// =========================================================================================

test('tailscale shape: sign-in, session, preview hand-off on the :8443 host, all through a proxy connecting from 127.0.0.1', linuxOnly, async (t) => {
  const env = await startPanel(t, { shape: 'tailscale', proxyOpts: { clientAddress: '198.51.100.9' } });
  const res = await signin(env);
  assert.equal(res.status, 200);
  const c = cookieFrom(res, '__Host-scriptorium_session');
  assert.deepEqual(c.attrs, ['Path=/', 'Max-Age=86400', 'Secure', 'HttpOnly', 'SameSite=Strict']);
  const sess = JSON.parse((await adminReq(env, { pathname: '/api/session', headers: sessionCookie(c.value) })).text);
  assert.equal(sess.access.mode, 'tailscale');
  assert.equal(sess.access.previewUrl, `https://${TS_PREVIEW_HOST}`);
  assert.match(sess.access.reach, /^Reachable at https:\/\/panel-host\.example-tailnet\.ts\.net through tailscale serve, and on this machine$/);
  const open = await adminReq(env, { pathname: '/open-preview', headers: sessionCookie(c.value) });
  const hop = ticketOf(open.headers.location);
  assert.equal(hop.origin, `https://${TS_PREVIEW_HOST}`);
  const enter = await previewReq(env, { pathname: `/:enter${hop.search}` });
  assert.equal(enter.status, 303);
  assert.ok(cookieFrom(enter, '__Host-scriptorium_preview'));
  assert.equal(readAudit(env).find((e) => e.event === 'signin' && e.result === 'ok').from, '198.51.100.9');
  // a bare "tailnet" Host without the :8443 is not the preview host
  const wrong = await request(env.previewProxy.port, { host: TS_ADMIN_HOST, pathname: '/' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.text, 'refused: host');
});

test('tailscale shape: a peer other than loopback cannot reach the panel (127.0.0.2 gets no bytes)', linuxOnly, async (t) => {
  const env = await startPanel(t, { shape: 'tailscale' });
  const probe = await rawRequest(env.adminPort, `GET /api/session HTTP/1.1\r\nHost: ${TS_ADMIN_HOST}\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`, { localAddress: '127.0.0.2' });
  assert.equal(probe, '');
});

// =========================================================================================
// FR-20: no per-request console output
// =========================================================================================

test('FR-20: a storm of mixed requests (refused, signed-in, wrong passwords, preview hand-offs) prints nothing: not one console line, and the panel emits no line after startup', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const startupLines = env.emitted.length;
  const calls = [];
  const names = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(names.map((n) => [n, console[n]]));
  for (const n of names) console[n] = (...args) => calls.push(`${n}:${args.join(' ').slice(0, 80)}`);
  t.after(() => {
    for (const n of names) console[n] = originals[n];
  });
  const value = await signedIn(env);
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    jobs.push(adminReq(env, { pathname: '/api/session' })); // 403 session
    jobs.push(adminReq(env, { pathname: '/api/session', headers: sessionCookie(value) }));
    jobs.push(request(env.adminProxy.port, { host: 'evil.example', pathname: '/' })); // 403 host
    jobs.push(adminReq(env, { pathname: '/open-preview', headers: sessionCookie(value) }));
    jobs.push(previewReq(env, { pathname: '/:enter?ticket=junk' }));
    jobs.push(adminPost(env, '/api/noop', {}, { origin: 'https://evil.example', headers: sessionCookie(value) })); // 403 origin
    jobs.push(adminReq(env, { pathname: '/%E0%A4%A' })); // 400 url
  }
  for (let i = 0; i < 6; i++) jobs.push(signin(env, `wrong ${i}`));
  const results = await Promise.all(jobs);
  assert.ok(results.length >= 140);
  for (const n of names) console[n] = originals[n];
  assert.deepEqual(calls, [], 'nothing was printed through console.*');
  assert.equal(env.emitted.length, startupLines, 'the panel emitted nothing after its startup lines');
});

test('Ma5 over a real socket: the token URL on the external Host never signs a remote request in, even with a wrong-case Host', linuxOnly, async (t) => {
  const env = await startPanel(t);
  for (const host of [ADMIN_HOST, 'SCRIPTORIUM.HOME.ARPA']) {
    const res = await request(env.adminProxy.port, { host, pathname: `/auth?token=${env.token}` });
    assert.equal(res.status, 403);
    assert.equal(res.headers['set-cookie'], undefined);
  }
  const follow = await adminReq(env, { pathname: '/api/session' });
  assert.equal(follow.status, 403);
});

test('S1 over a real socket: /%3Aenter, /%3aenter and /%3Avariant/... on the preview Host with no cookie are 400 refused: url; the double-encoded form is just an unauthenticated 403', linuxOnly, async (t) => {
  const env = await startPanel(t);
  for (const pathname of ['/%3Aenter?ticket=x', '/%3aenter?ticket=x', '/%3Avariant/gloam/index.html']) {
    const res = await previewReq(env, { pathname });
    assert.equal(res.status, 400, pathname);
    assert.equal(res.text, 'refused: url', pathname);
  }
  const dbl = await previewReq(env, { pathname: '/%253Aenter?ticket=x' });
  assert.equal(dbl.status, 403);
  assert.equal(dbl.text, 'refused: session');
});

test('S2: /:enter reuses a preview session only for the SAME admin session: a browser holding admin A\'s preview session entering with admin B\'s ticket gets a NEW session', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const a = await signedIn(env);
  const b = await signedIn(env);
  const hopA = ticketOf((await adminReq(env, { pathname: '/open-preview', headers: sessionCookie(a) })).headers.location);
  const enterA = await previewReq(env, { pathname: `/:enter${hopA.search}` });
  const previewA = cookieFrom(enterA, '__Host-scriptorium_preview').value;
  const hopB = ticketOf((await adminReq(env, { pathname: '/open-preview', headers: sessionCookie(b) })).headers.location);
  const enterB = await previewReq(env, { pathname: `/:enter${hopB.search}`, headers: { Cookie: `__Host-scriptorium_preview=${previewA}` } });
  assert.equal(enterB.status, 303);
  const fresh = cookieFrom(enterB, '__Host-scriptorium_preview');
  assert.ok(fresh, 'a new preview session was issued for admin B');
  assert.notEqual(fresh.value, previewA);
  const records = JSON.parse(fs.readFileSync(path.join(env.fx.panelDir, 'sessions.json'), 'utf8')).sessions;
  assert.equal(records.filter((r) => r.kind === 'preview').length, 2);
});

test('U5: a refusal that did not hash (paused, or busy) waits about as long as a real check took, but does not hash: zero extra hashes', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const counter = countVerifies(t);
  for (let i = 0; i < 5; i++) await signin(env, `wrong ${i}`);
  assert.deepEqual(env.sleeps, [], 'a real check does not wait');
  assert.equal(counter.calls, 5);
  assert.equal((await signin(env)).status, 403);
  assert.equal(counter.calls, 5, 'still no hash while paused');
  assert.equal(env.sleeps.length, 1);
  assert.ok(env.sleeps[0] >= 1 && env.sleeps[0] <= 2000, `asked to wait ${env.sleeps[0]} ms`);
});

test('U5: with no real check yet to copy, the wait is the 300 ms default', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const counter = countVerifies(t);
  let release;
  counter.gate = new Promise((r) => {
    release = r;
  });
  const first = signin(env, 'wrong one');
  const started = Date.now();
  while (counter.calls < 1 && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 5));
  await signin(env, 'concurrent');
  release();
  await first;
  assert.deepEqual(env.sleeps, [300]);
});
