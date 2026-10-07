'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');
const { createAdminHandler, ADMIN_ROUTES } = require('../src/admin/router');
const { createAdminContext } = require('../src/admin/context');

// Stated literally, never imported (CLAUDE.md testing standards: "never derive an assertion's
// expected value from the code under test").
const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-s1-engineering-brief-2026-09-28.md, "Test-first order"
 * item 5). Real sockets, a synthetic scratch vault. Synthetic cast only (NFR-10/NFR-11); scratch
 * dirs only, never test/fixtures.
 */

function writeScratchVault(root) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# x\n');
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify({ siteTitle: 'Alpha Test' }, null, 2) + '\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');

  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
  );
  return { vaultPath, configPath };
}

async function withScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-http-'));
  try {
    return await fn(writeScratchVault(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Starts the real admin server via runServeCommand({admin:true}), records real handles.
 *
 * Test-hygiene fix (Reviewer finding, 2026-09-28): a failing assertion between `launch()` and the
 * test's own `shutdown(state)` call used to leave both real listeners open. That's a live TCP
 * listener with pending connections, which keeps node --test's event loop alive indefinitely --
 * under a mutation that broke auth, the whole file hung past a 90s wall-clock timeout instead of
 * failing fast. `t` (the test's own TestContext) is required now, and `t.after()` guarantees a
 * force-close runs after the test regardless of pass/fail. Closing an already-closed handle
 * (the common case, when the test's own `shutdown(state)` already ran cleanly) is swallowed.
 */
function launch(t, configPath, extraFlags = {}) {
  const handles = [];
  const wrappedListener = async (handler, opts) => {
    const handle = await startLocalListener(handler, opts);
    handles.push(handle);
    return handle;
  };
  const emitted = [];
  const signals = new EventEmitter();
  const resultPromise = runServeCommand({ config: configPath, admin: true, ...extraFlags }, 'alpha', {
    emit: (l) => emitted.push(l),
    startLocalListener: wrappedListener,
    signals,
  });
  t.after(async () => {
    for (const h of handles) {
      try {
        await h.close();
      } catch {
        // already closed by the test's own shutdown(state) -- fine
      }
    }
  });
  return { resultPromise, handles, emitted, signals };
}

function waitForMacrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForHandles(state) {
  while (state.handles.length < 2) {
    await waitForMacrotask();
  }
  return state;
}

async function shutdown(state) {
  state.signals.emit('SIGINT');
  await state.resultPromise;
}

function tokenFromLine(line) {
  return line.match(/token=([A-Za-z0-9_-]{43})$/)[1];
}

/** Plain http.request-based helper. Sends a real Host header unless overridden. */
function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Raw socket helper: full control over the request line and headers, no auto Host. Node's
 * default admin/preview server responses are keep-alive (HTTP/1.1) unless the response itself
 * sends `Connection: close`, so this resolves as soon as the status line plus headers have
 * arrived (a 2-second fallback timer covers the keep-alive case) rather than waiting for the
 * socket to end.
 */
function rawRequest(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(requestText);
    });
    let data = '';
    let settled = false;
    let flushTimer = null;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(flushTimer);
      const [head] = data.split('\r\n\r\n');
      const statusLine = (head || '').split('\r\n')[0] || '';
      const status = Number((statusLine.match(/^HTTP\/\d\.\d (\d+)/) || [])[1]);
      resolve({ status, raw: data });
      socket.destroy();
    }

    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
      if (data.includes('\r\n\r\n')) {
        clearTimeout(flushTimer);
        // Headers have arrived; give any trailing body a brief moment to land in the same
        // read, without waiting out the full keep-alive fallback timer.
        flushTimer = setTimeout(finish, 50);
      }
    });
    socket.on('end', finish);
    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(flushTimer);
      reject(err);
    });
    const timer = setTimeout(finish, 2000);
  });
}

function assertAdminHeaders(headers, { contentType } = {}) {
  assert.equal(headers['content-security-policy'], ADMIN_CSP);
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['cache-control'], 'no-store');
  if (contentType) assert.equal(headers['content-type'], contentType);
}

function assertNoCors(headers) {
  for (const key of Object.keys(headers)) {
    assert.ok(!key.toLowerCase().startsWith('access-control-'), `unexpected CORS header: ${key}`);
  }
}

// --- Binding -----------------------------------------------------------

test('both listeners bind 127.0.0.1', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    for (const h of state.handles) {
      assert.equal(h.server.address().address, '127.0.0.1');
    }
    await shutdown(state);
  });
});

// --- Host refusals paired with positives, incl. a raw HTTP/1.0 socket ------

test('Host refusals are paired with positives; a missing Host over raw HTTP/1.0 gets refused: host', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);

    // positive: HTTP/1.0 WITH Host
    const withHost = await rawRequest(adminPort, `GET /auth?token=${token} HTTP/1.0\r\nHost: 127.0.0.1:${adminPort}\r\n\r\n`);
    assert.equal(withHost.status, 303);

    // negative: HTTP/1.0 with NO Host at all
    const noHost = await rawRequest(adminPort, `GET /auth?token=${token} HTTP/1.0\r\n\r\n`);
    assert.equal(noHost.status, 403);
    assert.ok(noHost.raw.includes('refused: host'));

    // wrong host
    const wrongHost = await request(adminPort, { path: '/api/session', headers: { Host: 'evil.example:9999', Cookie: 'x=y' } });
    assert.equal(wrongHost.status, 403);
    assert.equal(wrongHost.body.toString(), 'refused: host');

    await shutdown(state);
  });
});

// --- /auth success and failure variants -------------------------------

test('/auth success sets the exact cookie and redirects; failures never set a cookie', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);

    const ok = await request(adminPort, { path: `/auth?token=${token}` });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, '/');
    assert.equal(ok.headers['set-cookie'][0], `scriptorium_admin_${adminPort}=${token}; Path=/; HttpOnly; SameSite=Strict`);

    const wrong = await request(adminPort, { path: `/auth?token=${token.slice(0, -1)}x` });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers['set-cookie'], undefined);

    const missing = await request(adminPort, { path: '/auth' });
    assert.equal(missing.status, 403);
    assert.equal(missing.headers['set-cookie'], undefined);

    await shutdown(state);
  });
});

// --- / with and without cookie, byte-equal to disk --------------------

test('/ without a cookie gets locked.html (403); with a cookie gets index.html (200), byte-equal to disk', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookie = `scriptorium_admin_${adminPort}=${token}`;

    const locked = await request(adminPort, { path: '/' });
    assert.equal(locked.status, 403);
    assert.deepEqual(locked.body, fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'locked.html')));

    const shell = await request(adminPort, { path: '/', headers: { Cookie: cookie } });
    assert.equal(shell.status, 200);
    assert.deepEqual(shell.body, fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'index.html')));

    await shutdown(state);
  });
});

// --- Real-pipeline auth: a present-but-wrong cookie, through the real
// session.isAuthenticated (Reviewer finding on cca163d: every gate test injects a fake
// isAuthenticated, and no HTTP test ever sent a present-but-wrong cookie, so a mutation to
// isAuthenticated that accepted "any cookie present" -- `cookies.length > 0` -- left all 63
// admin tests green). Each case is a real HTTP request through the real listener, the real
// router, and the real session.isAuthenticated; each is paired with a positive control that
// differs only in the one attribute under test. --------------------------------------------

test('real-pipeline auth: a right-named cookie with the wrong token is refused; the same name with the right token is not', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookieName = `scriptorium_admin_${adminPort}`;

    const wrongToken = await request(adminPort, { path: '/api/session', headers: { Cookie: `${cookieName}=${token.slice(0, -1)}x` } });
    assert.equal(wrongToken.status, 403);
    assert.equal(wrongToken.body.toString(), 'refused: token');

    // Positive control: same cookie name, the correct token.
    const rightToken = await request(adminPort, { path: '/api/session', headers: { Cookie: `${cookieName}=${token}` } });
    assert.equal(rightToken.status, 200);

    await shutdown(state);
  });
});

test('real-pipeline auth: the right token under a wrong cookie name is refused; the right name with the same token is not', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookieName = `scriptorium_admin_${adminPort}`;

    const wrongName = await request(adminPort, { path: '/api/session', headers: { Cookie: `scriptorium_admin_wrong=${token}` } });
    assert.equal(wrongName.status, 403);
    assert.equal(wrongName.body.toString(), 'refused: token');

    // Positive control: the same token, under the right cookie name.
    const rightName = await request(adminPort, { path: '/api/session', headers: { Cookie: `${cookieName}=${token}` } });
    assert.equal(rightName.status, 200);

    await shutdown(state);
  });
});

test('real-pipeline auth: a decoy cookie alongside a wrong one is refused; the same decoy alongside the right one is not', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookieName = `scriptorium_admin_${adminPort}`;

    // A decoy of an unrelated name, plus a right-named cookie carrying the wrong token. Present
    // cookie COUNT is 2 here, deliberately: `cookies.length > 0` alone would wrongly accept
    // this, which is exactly the mutation this test exists to catch.
    const decoyPlusWrong = await request(adminPort, {
      path: '/api/session',
      headers: { Cookie: `unrelated_cookie=someval; ${cookieName}=${token.slice(0, -1)}x` },
    });
    assert.equal(decoyPlusWrong.status, 403);
    assert.equal(decoyPlusWrong.body.toString(), 'refused: token');

    // Positive control: the same decoy, alongside the right-named cookie carrying the right token.
    const decoyPlusRight = await request(adminPort, {
      path: '/api/session',
      headers: { Cookie: `unrelated_cookie=someval; ${cookieName}=${token}` },
    });
    assert.equal(decoyPlusRight.status, 200);

    await shutdown(state);
  });
});

test('real-pipeline auth: a wrong-length token is refused, without a crash; the real-length token is not', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookieName = `scriptorium_admin_${adminPort}`;

    const shortToken = await request(adminPort, { path: '/api/session', headers: { Cookie: `${cookieName}=x` } });
    assert.equal(shortToken.status, 403);
    assert.equal(shortToken.body.toString(), 'refused: token');

    const longToken = await request(adminPort, { path: '/api/session', headers: { Cookie: `${cookieName}=${'y'.repeat(1000)}` } });
    assert.equal(longToken.status, 403);
    assert.equal(longToken.body.toString(), 'refused: token');

    // Positive control: the same cookie name, the real (correct-length) token.
    const realLength = await request(adminPort, { path: '/api/session', headers: { Cookie: `${cookieName}=${token}` } });
    assert.equal(realLength.status, 200);

    // Process is still alive after both malformed-length attempts.
    const alive = await request(adminPort, { path: '/api/session', headers: { Cookie: `${cookieName}=${token}` } });
    assert.equal(alive.status, 200);

    await shutdown(state);
  });
});

// --- Real-pipeline auth: a same-name decoy cookie (M24, Reviewer finding on 6718c91). The
// mutation this guards: `isAuthenticated` checking only the FIRST cookie with the matching name
// (e.g. `cookies.find(([n]) => n === name)`), rather than accepting ANY matching cookie of that
// name (session.js:47-49's documented anti-DoS property: "a same-name decoy before the real
// cookie must not shadow it"). Two cookies sharing the identical name, sent through a real
// request, so this exercises Cookie-header parsing plus the real session.isAuthenticated
// together, not a hand-built cookie array. --------------------------------------------------

test('real-pipeline auth: a same-name decoy (wrong token first, right token second) is not shadowed', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookieName = `scriptorium_admin_${adminPort}`;

    const wrongThenRight = await request(adminPort, {
      path: '/api/session',
      headers: { Cookie: `${cookieName}=${token.slice(0, -1)}x; ${cookieName}=${token}` },
    });
    assert.equal(wrongThenRight.status, 200);

    await shutdown(state);
  });
});

test('real-pipeline auth: a same-name decoy (right token first, wrong token second) is not shadowed', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookieName = `scriptorium_admin_${adminPort}`;

    const rightThenWrong = await request(adminPort, {
      path: '/api/session',
      headers: { Cookie: `${cookieName}=${token}; ${cookieName}=${token.slice(0, -1)}x` },
    });
    assert.equal(rightThenWrong.status, 200);

    await shutdown(state);
  });
});

test('real-pipeline auth: two same-named cookies that are BOTH wrong is the negative control -- refused', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookieName = `scriptorium_admin_${adminPort}`;

    const bothWrong = await request(adminPort, {
      path: '/api/session',
      headers: { Cookie: `${cookieName}=${token.slice(0, -1)}a; ${cookieName}=${token.slice(0, -1)}b` },
    });
    assert.equal(bothWrong.status, 403);
    assert.equal(bothWrong.body.toString(), 'refused: token');

    await shutdown(state);
  });
});

// --- Route sweep --------------------------------------------------------

test('route sweep: the table equals a literal list of 26 METHOD path entries plus the asset prefix', () => {
  const nonAsset = ADMIN_ROUTES.filter((r) => r.path !== undefined).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(nonAsset, [
    'GET /auth',
    'GET /',
    'GET /api/session',
    'POST /api/noop',
    'GET /api/state',
    'POST /api/check',
    'POST /api/preview',
    'GET /api/image',
    'POST /api/pack/theme',
    'POST /api/pack/settings',
    'POST /api/pack/vocab',
    'POST /api/pack/slots',
    'POST /api/images/upload',
    // V1e-1 (SD-6, SD-8): the vault-config.md tagline write chokepoint's only route.
    'POST /api/vault-config/tagline',
    // V1e-2 (SD-10, SD-8): per-machine panel preferences.
    'GET /api/prefs',
    'POST /api/prefs',
    // V1e-5 (ADR 0038, SD-50): the vault attachments listing and byte routes.
    'GET /api/vault-art',
    'GET /api/vault-art/file',
    // V1e-9 (ADR 0033 addendum, SD-99): the guarded vault-config.md editor's own routes.
    'GET /api/vault-config/backups',
    'POST /api/vault-config/effects',
    'POST /api/vault-config/text',
    'POST /api/vault-config/restore',
    // V1e-10 (ADR 0033 second addendum, SD-110/SD-112): the field layout's two routes.
    'GET /api/vault-config/fields',
    'POST /api/vault-config/fields',
    // V1e-7 (ADR 0039, SD-62): builds a private preview copy in a registry theme.
    'POST /api/variants/theme',
    // V1e-8 (ADR 0039 addendum, SD-70): builds a private preview copy from the saved pack.toml
    // plus the Vocabulary screen's own unsaved edits.
    'POST /api/variants/vocab',
  ]);
  const assetRoutes = ADMIN_ROUTES.filter((r) => r.prefix !== undefined);
  assert.deepEqual(assetRoutes.map((r) => `${r.method} ${r.prefix}`), ['GET /assets/']);

  // Data-integrity check (M9): every route except /auth and the asset prefix declares auth:true.
  for (const route of ADMIN_ROUTES) {
    const isPublic = route.path === '/auth' || route.prefix === '/assets/';
    assert.equal(route.auth, !isPublic, `${route.method} ${route.path || route.prefix}`);
  }
});

test('route sweep: every auth route without a cookie is refused (locked page for /); with the cookie and admin Origin, the body is not a refusal', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookie = `scriptorium_admin_${adminPort}=${token}`;
    const origin = `http://127.0.0.1:${adminPort}`;

    const authRoutes = ADMIN_ROUTES.filter((r) => r.path && r.path !== '/auth');
    for (const route of authRoutes) {
      // No cookie, but WITH a valid Origin on POST routes: the gate checks Origin before Auth
      // (checkRequest's fixed order), so this isolates the auth (token) refusal specifically.
      const noCookieHeaders = route.method === 'POST' ? { Origin: origin } : {};
      const noCookie = await request(adminPort, { method: route.method, path: route.path, headers: noCookieHeaders });
      if (route.path === '/') {
        assert.equal(noCookie.status, 403);
        assert.deepEqual(noCookie.body, fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'locked.html')));
      } else {
        assert.equal(noCookie.status, 403, route.path);
        assert.equal(noCookie.body.toString(), 'refused: token', route.path);
      }

      const headers = { Cookie: cookie };
      if (route.method === 'POST') headers.Origin = origin;
      const withCookie = await request(adminPort, { method: route.method, path: route.path, headers });
      assert.notEqual(withCookie.body.toString(), `refused: token`, route.path);
      assert.notEqual(withCookie.status, 403, route.path);

      // Every POST route with the cookie and a foreign Origin gets refused: origin.
      if (route.method === 'POST') {
        const foreign = await request(adminPort, {
          method: 'POST',
          path: route.path,
          headers: { Cookie: cookie, Origin: 'http://evil.example' },
        });
        assert.equal(foreign.status, 403, route.path);
        assert.equal(foreign.body.toString(), 'refused: origin', route.path);
      }
    }

    await shutdown(state);
  });
});

// --- Simple-request CSRF -----------------------------------------------

test('simple-request CSRF: cross-origin POST /api/noop is refused for 3 content-types; admin Origin is accepted', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookie = `scriptorium_admin_${adminPort}=${token}`;
    const adminOrigin = `http://127.0.0.1:${adminPort}`;

    for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) {
      const cross = await request(adminPort, {
        method: 'POST',
        path: '/api/noop',
        headers: { Cookie: cookie, Origin: 'http://evil.example', 'Content-Type': contentType },
        body: 'x=1',
      });
      assert.equal(cross.status, 403, contentType);
      assert.equal(cross.body.toString(), 'refused: origin', contentType);

      const same = await request(adminPort, {
        method: 'POST',
        path: '/api/noop',
        headers: { Cookie: cookie, Origin: adminOrigin, 'Content-Type': contentType },
        body: 'x=1',
      });
      assert.equal(same.status, 200, contentType);
    }

    await shutdown(state);
  });
});

// --- OPTIONS / header set on every status ------------------------------

test('OPTIONS on both listeners carries no access-control-allow-*; the exact admin header set is present on 200/400/403/404/405/413', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const previewPort = state.handles[1].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookie = `scriptorium_admin_${adminPort}=${token}`;
    const origin = `http://127.0.0.1:${adminPort}`;

    const optAdmin = await request(adminPort, { method: 'OPTIONS', path: '/api/noop', headers: { Cookie: cookie, Origin: origin } });
    assert.equal(optAdmin.status, 405);
    assertNoCors(optAdmin.headers);
    assertAdminHeaders(optAdmin.headers);

    const optPreview = await request(previewPort, { method: 'OPTIONS', path: '/' });
    assert.equal(optPreview.status, 405);
    assertNoCors(optPreview.headers);

    // 200
    const ok = await request(adminPort, { path: '/api/session', headers: { Cookie: cookie } });
    assert.equal(ok.status, 200);
    assertAdminHeaders(ok.headers, { contentType: 'application/json; charset=utf-8' });

    // 400
    const bad = await request(adminPort, { path: '/%E0%A4%A', headers: { Cookie: cookie } });
    assert.equal(bad.status, 400);
    assertAdminHeaders(bad.headers);

    // 403
    const forbidden = await request(adminPort, { path: '/api/session' });
    assert.equal(forbidden.status, 403);
    assertAdminHeaders(forbidden.headers);

    // 404
    const notFound = await request(adminPort, { path: '/nope', headers: { Cookie: cookie } });
    assert.equal(notFound.status, 404);
    assertAdminHeaders(notFound.headers);

    // 405
    const methodNotAllowed = await request(adminPort, { method: 'PUT', path: '/api/session', headers: { Cookie: cookie } });
    assert.equal(methodNotAllowed.status, 405);
    assertAdminHeaders(methodNotAllowed.headers);

    // 413
    const tooBig = await request(adminPort, {
      method: 'POST',
      path: '/api/noop',
      headers: { Cookie: cookie, Origin: origin, 'Content-Length': String(70000) },
      body: 'x'.repeat(70000),
    });
    assert.equal(tooBig.status, 413);
    assertAdminHeaders(tooBig.headers);

    await shutdown(state);
  });
});

// --- Malformed URL, then a positive control -----------------------------

test('a malformed URL gets 400 on both listeners; a positive control still gets 200 afterwards', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const previewPort = state.handles[1].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookie = `scriptorium_admin_${adminPort}=${token}`;

    const badAdmin = await request(adminPort, { path: '/%E0%A4%A', headers: { Cookie: cookie } });
    assert.equal(badAdmin.status, 400);
    const badPreview = await request(previewPort, { path: '/%E0%A4%A', headers: { Cookie: cookie } });
    assert.equal(badPreview.status, 400);

    const positive = await request(adminPort, { path: '/api/session', headers: { Cookie: cookie } });
    assert.equal(positive.status, 200);

    await shutdown(state);
  });
});

// --- Limits ---------------------------------------------------------------

test('body limits: 65536 bytes ok, 65537 refused, chunked 65537 refused, malformed/valid JSON, process stays alive', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookie = `scriptorium_admin_${adminPort}=${token}`;
    const origin = `http://127.0.0.1:${adminPort}`;

    const at = await request(adminPort, {
      method: 'POST',
      path: '/api/noop',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'text/plain' },
      body: 'a'.repeat(65536),
    });
    assert.equal(at.status, 200);
    assert.deepEqual(JSON.parse(at.body.toString()), { ok: true, bytes: 65536 });

    const over = await request(adminPort, {
      method: 'POST',
      path: '/api/noop',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'text/plain' },
      body: 'a'.repeat(65537),
    });
    assert.equal(over.status, 413);

    // Chunked transfer, no Content-Length: force via a raw socket.
    const chunkBody = 'a'.repeat(65537);
    const chunkedReq =
      `POST /api/noop HTTP/1.1\r\nHost: 127.0.0.1:${adminPort}\r\nCookie: ${cookie}\r\nOrigin: ${origin}\r\n` +
      `Content-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
      `${chunkBody.length.toString(16)}\r\n${chunkBody}\r\n0\r\n\r\n`;
    const chunked = await rawRequest(adminPort, chunkedReq);
    assert.equal(chunked.status, 413);

    const malformedJson = await request(adminPort, {
      method: 'POST',
      path: '/api/noop',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(malformedJson.status, 400);
    assert.deepEqual(JSON.parse(malformedJson.body.toString()), { error: 'malformed JSON' });

    const validJson = await request(adminPort, {
      method: 'POST',
      path: '/api/noop',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    assert.equal(validJson.status, 200);

    // process still alive: a further request succeeds
    const alive = await request(adminPort, { path: '/api/session', headers: { Cookie: cookie } });
    assert.equal(alive.status, 200);

    await shutdown(state);
  });
});

// --- Preview listener -------------------------------------------------

test('preview listener: Host checks, POST 405, no cookie refused: token, cookie gives 404, /api/session also 404', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const previewPort = state.handles[1].port;
    const token = tokenFromLine(state.emitted[0]);
    const previewCookie = `scriptorium_admin_${adminPort}=${token}`;

    const wrongHost = await request(previewPort, { path: '/', headers: { Host: 'evil.example:9', Cookie: previewCookie } });
    assert.equal(wrongHost.status, 403);

    const postRefused = await request(previewPort, { method: 'POST', path: '/', headers: { Cookie: previewCookie } });
    assert.equal(postRefused.status, 405);

    const noCookie = await request(previewPort, { path: '/' });
    assert.equal(noCookie.status, 403);
    assert.equal(noCookie.body.toString(), 'refused: token');

    const withCookie = await request(previewPort, { path: '/', headers: { Cookie: previewCookie } });
    assert.equal(withCookie.status, 404);
    assert.equal(withCookie.body.toString(), 'no preview has been built yet');

    const sessionOnPreview = await request(previewPort, { path: '/api/session', headers: { Cookie: previewCookie } });
    assert.equal(sessionOnPreview.status, 404);

    await shutdown(state);
  });
});

// --- 500 handling -----------------------------------------------------

test('a throwing route and a headers-then-throw route both give a clean 500, no crash, no stack in the body', async () => {
  const ctx = createAdminContext({
    ctxInfo: { campaign: 'x' },
    vaultPath: '/v',
    site: { siteSource: 'convention', siteConfigPath: '/v/_meta/scriptorium/vault.config.json', siteDir: '/v/_meta/scriptorium' },
    token: 'TESTTOKEN',
  });
  ctx.adminPort = 0; // set below once listening

  // Paths under /assets/ so the gate's hardcoded public-path skip applies (gate.js does not
  // consult a route's own `auth` field -- see the route-sweep test above), so this test can
  // reach the handlers without a cookie.
  const routes = [
    { method: 'GET', path: '/assets/throws', auth: false, handler: () => { throw new Error('boom'); } },
    {
      method: 'GET',
      path: '/assets/writes-then-throws',
      auth: false,
      handler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('partial');
        throw new Error('boom2');
      },
    },
  ];

  const handler = createAdminHandler(ctx, { routes });
  const handle = await startLocalListener(handler, { port: 0 });
  ctx.adminPort = handle.port;

  try {
    const r1 = await request(handle.port, { path: '/assets/throws' });
    assert.equal(r1.status, 500);
    assert.equal(r1.body.toString(), 'internal error');
    assert.ok(!r1.body.toString().includes('boom'));

    // headers-then-throw: headers already sent, so the router destroys the socket rather than
    // writing a second response (M22's `res.headersSent` guard). Whether the already-written
    // "partial" bytes beat the RST onto the wire is a TCP-timing race this test does not
    // depend on; the assertion that matters is the one below -- the SERVER PROCESS survives
    // the throw and keeps answering requests.
    try {
      await rawRequest(handle.port, `GET /assets/writes-then-throws HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`);
    } catch {
      // a connection reset here is an acceptable outcome of the headers-already-sent guard
    }

    // process still alive
    const alive = await request(handle.port, { path: '/assets/throws' });
    assert.equal(alive.status, 500);
  } finally {
    await handle.close();
  }
});

// --- Console silence -----------------------------------------------------

test('console and process.stderr.write stay silent during a battery of requests; emit stays at 3', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const previewPort = state.handles[1].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookie = `scriptorium_admin_${adminPort}=${token}`;
    const origin = `http://127.0.0.1:${adminPort}`;

    const calls = [];
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalStderrWrite = process.stderr.write;
    console.log = (...a) => calls.push(['log', a]);
    console.info = (...a) => calls.push(['info', a]);
    console.warn = (...a) => calls.push(['warn', a]);
    console.error = (...a) => calls.push(['error', a]);
    process.stderr.write = (...a) => {
      calls.push(['stderr', a]);
      return true;
    };

    try {
      await request(adminPort, { path: '/api/session', headers: { Cookie: cookie } });
      await request(adminPort, { path: '/nope', headers: { Cookie: cookie } });
      await request(adminPort, { path: '/%E0%A4%A', headers: { Cookie: cookie } });
      await request(adminPort, { method: 'POST', path: '/api/noop', headers: { Cookie: cookie, Origin: 'http://evil.example' } });
      await request(previewPort, { path: '/' });
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      console.error = originalError;
      process.stderr.write = originalStderrWrite;
    }

    assert.deepEqual(calls, []);
    assert.equal(state.emitted.length, 3);

    await shutdown(state);
  });
});

// --- After SIGINT ----------------------------------------------------------

test('after SIGINT both ports refuse connections, a relaunch on the old admin port binds, no token on disk, vault manifest unchanged', async (t) => {
  await withScratch(async ({ configPath, vaultPath }) => {
    const packToml = path.join(vaultPath, '_meta', 'scriptorium', 'pack.toml');
    const before = crypto.createHash('sha256').update(fs.readFileSync(packToml)).digest('hex');

    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const previewPort = state.handles[1].port;
    const token = tokenFromLine(state.emitted[0]);
    await shutdown(state);

    await assert.rejects(() => request(adminPort, { path: '/' }));
    await assert.rejects(() => request(previewPort, { path: '/' }));

    // no file under the scratch root contains the token
    const root = path.dirname(configPath);
    let found = false;
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full, 'utf8').includes(token)) found = true;
      }
    })(root);
    assert.equal(found, false);

    const after = crypto.createHash('sha256').update(fs.readFileSync(packToml)).digest('hex');
    assert.equal(after, before);

    // relaunch on the old admin port binds
    const relaunch = await waitForHandles(launch(t, configPath, { port: String(adminPort) }));
    assert.equal(relaunch.handles[0].port, adminPort);
    await shutdown(relaunch);
  });
});

// --- FR03 binding: config change after launch doesn't affect the bound context --

test('FR03: rewriting config.toml after launch does not change /api/session', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const token = tokenFromLine(state.emitted[0]);
    const cookie = `scriptorium_admin_${adminPort}=${token}`;

    const before = await request(adminPort, { path: '/api/session', headers: { Cookie: cookie } });

    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', "vault = '/nonexistent/missing-vault'", "output = '/nonexistent/out'", ''].join('\n'),
    );

    const after = await request(adminPort, { path: '/api/session', headers: { Cookie: cookie } });
    assert.equal(after.status, 200);
    assert.deepEqual(JSON.parse(after.body.toString()), JSON.parse(before.body.toString()));

    await shutdown(state);
  });
});

// --- No leaked SIGINT listener ----------------------------------------------

test('no test above registered a SIGINT listener on the real process', () => {
  assert.equal(process.listenerCount('SIGINT'), 0);
});
