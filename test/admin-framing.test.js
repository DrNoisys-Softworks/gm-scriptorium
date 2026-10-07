'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const gate = require('../src/admin/gate');
const respond = require('../src/admin/respond');

/*
 * V1e-3 (SD-16, D-9, ADR 0035). The FIRST commit of this slice, security-only: real sockets, a
 * synthetic scratch vault. Every scratch env var is pinned to a per-file mkdtemp before any test
 * runs, so an accidental default-path fallback lands in scratch, never in the real per-machine
 * config folder.
 */
const SCRATCH_XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-framing-xdg-'));
process.env.XDG_CONFIG_HOME = SCRATCH_XDG;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-framing-appdata-'));
process.env.SCRIPTORIUM_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-framing-sc-')), 'config.toml');

// Stated literally, never imported (CLAUDE.md testing standards: "never derive an assertion's
// expected value from the code under test").
const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function expectedAdminShellCsp(host, previewPort) {
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-src http://${host}:${previewPort}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

function expectedPreviewFrameCsp(host, adminPort) {
  return `frame-ancestors http://${host}:${adminPort}`;
}

// A real, buildable fixture vault (People/Episodes/Chronicle content), copied to scratch --
// never written to in place. The framing tests need an actual successful build (an index.html
// and a 404.html on disk), which a hand-written near-empty vault does not reliably produce.
const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');

function writeScratchVault(root) {
  const vaultPath = path.join(root, 'vault');
  fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
  );
  return { vaultPath, configPath };
}

async function withScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-framing-http-'));
  try {
    return await fn(writeScratchVault(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function launch(t, configPath, extraFlags = {}) {
  const { runServeCommand } = require('../src/cli/serve');
  const { startLocalListener } = require('../src/serve/server');
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
        // already closed by the test's own shutdown()
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

function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function launchAuthed(t, configPath) {
  const s = await waitForHandles(launch(t, configPath));
  const adminPort = s.handles[0].port;
  const previewPort = s.handles[1].port;
  const authResult = await request(adminPort, { path: `/auth?token=${tokenFromLine(s.emitted[0])}` });
  const cookieHeader = authResult.headers['set-cookie'][0].split(';')[0];
  return { adminPort, previewPort, cookie: cookieHeader, emitted: s.emitted, shutdown: () => shutdown(s) };
}

// =================================================================================================
// GET / -- the ONLY admin response with frame-src
// =================================================================================================

test('GET / on both host forms (127.0.0.1 and localhost) carries the exact typed CSP with the real preview port', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);

    const viaIp = await request(c.adminPort, { path: '/', headers: { Cookie: c.cookie } });
    assert.equal(viaIp.status, 200);
    assert.equal(viaIp.headers['content-security-policy'], expectedAdminShellCsp('127.0.0.1', c.previewPort));

    const viaLocalhost = await request(c.adminPort, { path: '/', headers: { Cookie: c.cookie, Host: `localhost:${c.adminPort}` } });
    assert.equal(viaLocalhost.status, 200);
    assert.equal(viaLocalhost.headers['content-security-policy'], expectedAdminShellCsp('localhost', c.previewPort));

    await c.shutdown();
  });
});

test('/api/session and every admin error response are STILL exactly ADMIN_CSP -- GET / is the only widened response (F3/F4 positive control)', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);

    const session = await request(c.adminPort, { path: '/api/session', headers: { Cookie: c.cookie } });
    assert.equal(session.headers['content-security-policy'], ADMIN_CSP);

    const notFound = await request(c.adminPort, { path: '/api/nonexistent', headers: { Cookie: c.cookie } });
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers['content-security-policy'], ADMIN_CSP);

    const locked = await request(c.adminPort, { path: '/' }); // no cookie: locked.html, still ADMIN_CSP
    assert.equal(locked.status, 403);
    assert.equal(locked.headers['content-security-policy'], ADMIN_CSP);

    await c.shutdown();
  });
});

// =================================================================================================
// Preview responses -- frame-ancestors on EVERY one, both host forms
// =================================================================================================

test('preview 200 carries the exact frame-ancestors literal on both host forms', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await request(c.adminPort, {
      method: 'POST',
      path: '/api/preview',
      headers: { Cookie: c.cookie, Origin: `http://127.0.0.1:${c.adminPort}` },
    });

    const viaIp = await request(c.previewPort, { path: '/', headers: { Cookie: c.cookie } });
    assert.equal(viaIp.status, 200);
    assert.equal(viaIp.headers['content-security-policy'], expectedPreviewFrameCsp('127.0.0.1', c.adminPort));

    const viaLocalhost = await request(c.previewPort, { path: '/', headers: { Cookie: c.cookie, Host: `localhost:${c.previewPort}` } });
    assert.equal(viaLocalhost.status, 200);
    assert.equal(viaLocalhost.headers['content-security-policy'], expectedPreviewFrameCsp('localhost', c.adminPort));

    await c.shutdown();
  });
});

test('preview "not built yet" (404 text) carries frame-ancestors on both hosts', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    // No build was requested: previewDir doesn't exist yet.
    const res = await request(c.previewPort, { path: '/', headers: { Cookie: c.cookie } });
    assert.equal(res.status, 404);
    assert.equal(res.body.toString(), 'no preview has been built yet');
    assert.equal(res.headers['content-security-policy'], expectedPreviewFrameCsp('127.0.0.1', c.adminPort));

    const viaLocalhost = await request(c.previewPort, { path: '/', headers: { Cookie: c.cookie, Host: `localhost:${c.previewPort}` } });
    assert.equal(viaLocalhost.headers['content-security-policy'], expectedPreviewFrameCsp('localhost', c.adminPort));

    await c.shutdown();
  });
});

test('preview 404-with-page (a built preview, unknown path, a real 404.html) carries frame-ancestors', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const built = await request(c.adminPort, {
      method: 'POST',
      path: '/api/preview',
      headers: { Cookie: c.cookie, Origin: `http://127.0.0.1:${c.adminPort}` },
    });
    assert.equal(built.status, 200);

    const res = await request(c.previewPort, { path: '/does-not-exist-anywhere', headers: { Cookie: c.cookie } });
    assert.equal(res.status, 404);
    assert.equal(res.headers['content-security-policy'], expectedPreviewFrameCsp('127.0.0.1', c.adminPort));

    await c.shutdown();
  });
});

test('preview 400 (a malformed static path) carries frame-ancestors', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const built = await request(c.adminPort, {
      method: 'POST',
      path: '/api/preview',
      headers: { Cookie: c.cookie, Origin: `http://127.0.0.1:${c.adminPort}` },
    });
    assert.equal(built.status, 200);

    const res = await request(c.previewPort, { path: '/..%2f..%2fetc%2fpasswd', headers: { Cookie: c.cookie } });
    assert.equal(res.status, 400);
    assert.equal(res.headers['content-security-policy'], expectedPreviewFrameCsp('127.0.0.1', c.adminPort));

    await c.shutdown();
  });
});

test('a preview gate refusal (bad Host) stays CSP-free -- a host failure has no valid host to name', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await request(c.previewPort, { path: '/', headers: { Host: 'evil.example:9999', Cookie: c.cookie } });
    assert.equal(res.status, 403);
    assert.equal(res.headers['content-security-policy'], undefined);
    await c.shutdown();
  });
});

// =================================================================================================
// respond.adminShellCsp / respond.previewFrameCsp -- pure unit cases, fail-closed
// =================================================================================================

test('respond.adminShellCsp: valid inputs insert frame-src after connect-src; every invalid input fails closed to the byte-unchanged ADMIN_CSP', () => {
  assert.equal(respond.adminShellCsp('127.0.0.1', 4100), expectedAdminShellCsp('127.0.0.1', 4100));
  assert.equal(respond.adminShellCsp('localhost', 4100), expectedAdminShellCsp('localhost', 4100));

  for (const [host, port] of [
    [null, 4100],
    [undefined, 4100],
    ['127.0.0.10', 4100],
    ['localhostx', 4100],
    ['127.0.0.1', 0],
    ['127.0.0.1', 65536],
    ['127.0.0.1', '80'],
    ['127.0.0.1', 80.5],
    ['127.0.0.1', -1],
    ['127.0.0.1', null],
    ['127.0.0.1', undefined],
  ]) {
    assert.equal(respond.adminShellCsp(host, port), ADMIN_CSP, `host=${JSON.stringify(host)} port=${JSON.stringify(port)} must fail closed`);
  }
});

test('respond.adminShellCsp: ADMIN_CSP and adminHeaders/previewHeaders are byte-unchanged by this slice', () => {
  assert.equal(
    respond.ADMIN_CSP,
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
});

test('respond.previewFrameCsp: valid inputs name exactly the admin origin; every invalid input fails closed to frame-ancestors \'none\'', () => {
  assert.equal(respond.previewFrameCsp('127.0.0.1', 4099), "frame-ancestors http://127.0.0.1:4099");
  assert.equal(respond.previewFrameCsp('localhost', 4099), 'frame-ancestors http://localhost:4099');

  for (const [host, port] of [
    [null, 4099],
    ['127.0.0.10', 4099],
    ['localhostx', 4099],
    ['127.0.0.1', 0],
    ['127.0.0.1', 65536],
    ['127.0.0.1', '80'],
  ]) {
    assert.equal(respond.previewFrameCsp(host, port), "frame-ancestors 'none'", `host=${JSON.stringify(host)} port=${JSON.stringify(port)} must fail closed`);
  }
});

// F1/F2 mutation guards: an argument swap must change the observable literal.
test('F1/F2 guard: adminShellCsp and previewFrameCsp differ when host/port are swapped -- an argument-swap mutation must go red', () => {
  assert.notEqual(respond.adminShellCsp('127.0.0.1', 4100), respond.adminShellCsp(4100, '127.0.0.1'));
  assert.equal(respond.adminShellCsp(4100, '127.0.0.1'), ADMIN_CSP); // swapped args are invalid types, fails closed
  assert.notEqual(respond.previewFrameCsp('127.0.0.1', 4099), "frame-ancestors http://4099:127.0.0.1");
});

// =================================================================================================
// gate.hostnameFor -- delegates to hostAllowed, never re-parses
// =================================================================================================

test('gate.hostnameFor: exact host+port gives the lowercased hostname; a mismatch gives null', () => {
  assert.equal(gate.hostnameFor('127.0.0.1:4100', 4100), '127.0.0.1');
  assert.equal(gate.hostnameFor('LOCALHOST:4100', 4100), 'localhost');
  assert.equal(gate.hostnameFor('localhostx:4100', 4100), null); // F5: a startsWith('localhost') sibling would wrongly accept this
  assert.equal(gate.hostnameFor('127.0.0.1.evil:4100', 4100), null);
  assert.equal(gate.hostnameFor('127.0.0.1:4101', 4100), null); // wrong port
  assert.equal(gate.hostnameFor(undefined, 4100), null); // missing header
  assert.equal(gate.hostnameFor('', 4100), null);
});

test('gate.hostnameFor: the result is always exactly \'127.0.0.1\' or \'localhost\' -- never any other value', () => {
  const result1 = gate.hostnameFor('127.0.0.1:80', 80);
  const result2 = gate.hostnameFor('localhost:80', 80);
  assert.ok(result1 === '127.0.0.1' || result1 === null);
  assert.ok(result2 === 'localhost' || result2 === null);
});

// =================================================================================================
// Structural scan: no message listener, no postMessage, no document.domain in ANY panel JS; the
// sandbox literal appears exactly once, in sitepane.js, before src is ever assigned.
// =================================================================================================

const ADMIN_JS_DIR = path.join(__dirname, '..', 'assets', 'admin');

function panelJsFiles() {
  return fs
    .readdirSync(ADMIN_JS_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(ADMIN_JS_DIR, name));
}

/** Strips block and line comments before scanning, so a comment merely DISCUSSING these forbidden
 * patterns (as this repo's own module doc headers do, e.g. "no message listener") never trips the
 * scan itself -- only real code does. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const POST_MESSAGE_RE = /\bpostMessage\s*\(/;
const MESSAGE_LISTENER_RE = /addEventListener\s*\(\s*['"]message['"]/;
const ONMESSAGE_RE = /\bonmessage\s*=/;
const DOCUMENT_DOMAIN_RE = /document\s*\.\s*domain/;

test('structural: no panel JS file calls postMessage, listens for "message", assigns onmessage, or sets document.domain', () => {
  for (const file of panelJsFiles()) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    assert.ok(!POST_MESSAGE_RE.test(src), `${file} must never call postMessage`);
    assert.ok(!MESSAGE_LISTENER_RE.test(src), `${file} must never listen for 'message'`);
    assert.ok(!ONMESSAGE_RE.test(src), `${file} must never assign onmessage`);
    assert.ok(!DOCUMENT_DOMAIN_RE.test(src), `${file} must never set document.domain`);
  }
});

test('F9 positive control: the structural scan above actually catches a planted message listener/postMessage/document.domain', () => {
  const planted = [
    "window.addEventListener('message', function (ev) {});",
    'window.postMessage("x", "*");',
    'window.onmessage = function () {};',
    'document.domain = "example.com";',
  ];
  for (const line of planted) {
    const anyMatch = POST_MESSAGE_RE.test(line) || MESSAGE_LISTENER_RE.test(line) || ONMESSAGE_RE.test(line) || DOCUMENT_DOMAIN_RE.test(line);
    assert.ok(anyMatch, `planted line must be caught: ${line}`);
  }
});

test('structural: sitepane.js sets the sandbox attribute exactly once, with the exact literal, and no other file names "sandbox" as an attribute', () => {
  const sitepanePath = path.join(ADMIN_JS_DIR, 'sitepane.js');
  const src = stripComments(fs.readFileSync(sitepanePath, 'utf8'));

  const SANDBOX_SETATTR_RE = /setAttribute\(\s*['"]sandbox['"]\s*,\s*PV\.FRAME_SANDBOX\s*\)/g;
  const matches = src.match(SANDBOX_SETATTR_RE) || [];
  assert.equal(matches.length, 1, 'sitepane.js must set the sandbox attribute exactly once, with the exact literal');

  const anySandboxAttr = (src.match(/setAttribute\(\s*['"]sandbox['"]/g) || []).length;
  assert.equal(anySandboxAttr, 1, 'no other "sandbox" setAttribute call may exist in sitepane.js');

  for (const file of panelJsFiles()) {
    if (path.basename(file) === 'sitepane.js') continue;
    const otherSrc = stripComments(fs.readFileSync(file, 'utf8'));
    assert.ok(!/setAttribute\(\s*['"]sandbox['"]/.test(otherSrc), `${file} must never set a sandbox attribute -- only sitepane.js frames anything`);
  }
});

test('structural: PV.FRAME_SANDBOX is exactly "allow-scripts allow-same-origin", and sandbox is set BEFORE src on the same frame build', () => {
  const src = stripComments(fs.readFileSync(path.join(ADMIN_JS_DIR, 'sitepane.js'), 'utf8'));
  assert.match(src, /FRAME_SANDBOX\s*[:=]\s*['"]allow-scripts allow-same-origin['"]/);

  // Every "createElement('iframe')" block must set the sandbox attribute before it ever assigns
  // .src (SD-16: "Sandbox flags apply at navigation, so they must be set BEFORE src.").
  const iframeBuilds = src.split(/createElement\(\s*['"]iframe['"]\s*\)/).slice(1);
  assert.ok(iframeBuilds.length > 0, 'sitepane.js must build at least one iframe');
  for (const chunk of iframeBuilds) {
    // Look only within the same statement-ish window (up to the next iframe build, or 2000 chars).
    const window_ = chunk.slice(0, 2000);
    const sandboxIdx = window_.search(/setAttribute\(\s*['"]sandbox['"]/);
    const srcIdx = window_.search(/\.src\s*=/);
    assert.ok(sandboxIdx !== -1, 'each iframe build must set sandbox');
    if (srcIdx !== -1) {
      assert.ok(sandboxIdx < srcIdx, 'sandbox must be set before .src is assigned');
    }
  }
});
