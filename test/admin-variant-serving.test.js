'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');

/*
 * V1e-7 (ADR 0039, SD-63). Real sockets, both 127.0.0.1 and localhost, against the preview
 * listener's reserved `/:variant/<id>/` prefix. Every scratch env var is pinned to a per-file
 * mkdtemp before any test runs (the admin-framing.test.js precedent).
 */
const SCRATCH_XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vserve-xdg-'));
process.env.XDG_CONFIG_HOME = SCRATCH_XDG;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vserve-appdata-'));
process.env.SCRIPTORIUM_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vserve-sc-')), 'config.toml');

const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');

function expectedPreviewFrameCsp(host, adminPort) {
  return `frame-ancestors http://${host}:${adminPort}`;
}

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vserve-http-'));
  try {
    return await fn(writeScratchVault(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

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
  while (state.handles.length < 2) await waitForMacrotask();
  return state;
}
async function shutdown(state) {
  state.signals.emit('SIGINT');
  await state.resultPromise;
}
function tokenFromLine(line) {
  return line.match(/token=([A-Za-z0-9_-]{43})$/)[1];
}
function request(port, { method = 'GET', path: reqPath = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Raw-socket GET: full control over the request line, no normalization anywhere en route. */
function rawGet(port, requestTarget, extraHeaders = '') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extraHeaders}Connection: close\r\n\r\n`);
    });
    let data = '';
    let settled = false;
    const timer = setTimeout(finish, 3000);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const idx = data.indexOf('\r\n\r\n');
      const head = idx === -1 ? data : data.slice(0, idx);
      const body = idx === -1 ? '' : data.slice(idx + 4);
      const statusLine = head.split('\r\n')[0] || '';
      const status = Number((statusLine.match(/^HTTP\/\d\.\d (\d+)/) || [])[1]);
      const headers = {};
      for (const line of head.split('\r\n').slice(1)) {
        const i = line.indexOf(':');
        if (i !== -1) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status, headers, body });
      socket.destroy();
    }
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
    });
    socket.on('end', finish);
    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
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

function postJson(port, cookie, origin, reqPath, obj) {
  const body = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: reqPath,
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function buildGloam(c) {
  const res = await postJson(c.adminPort, c.cookie, `http://127.0.0.1:${c.adminPort}`, '/api/variants/theme', { theme: 'gloam' });
  assert.equal(res.status, 200, res.body.toString());
  const parsed = JSON.parse(res.body.toString());
  assert.equal(parsed.exitCode, 0, parsed.human);
  return parsed;
}

test('GET /:variant/gloam/index.html gives 200 with the exact frame-ancestors on both hosts', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildGloam(c);

    const viaIp = await request(c.previewPort, { path: '/:variant/gloam/index.html', headers: { Cookie: c.cookie } });
    assert.equal(viaIp.status, 200);
    assert.equal(viaIp.headers['content-security-policy'], expectedPreviewFrameCsp('127.0.0.1', c.adminPort));
    assert.ok(viaIp.body.length > 0);

    const viaLocalhost = await request(c.previewPort, {
      path: '/:variant/gloam/index.html',
      headers: { Cookie: c.cookie, Host: `localhost:${c.previewPort}` },
    });
    assert.equal(viaLocalhost.status, 200);
    assert.equal(viaLocalhost.headers['content-security-policy'], expectedPreviewFrameCsp('localhost', c.adminPort));

    await c.shutdown();
  });
});

test('the gloam copy serves its theme fonts under /:variant/gloam/scriptorium/theme/fonts/', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildGloam(c);
    const res = await request(c.previewPort, {
      path: '/:variant/gloam/scriptorium/theme/fonts/IMFeENrm28P.woff2',
      headers: { Cookie: c.cookie },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
    await c.shutdown();
  });
});

test('HEAD /:variant/gloam/index.html gives 200 with no body', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    await buildGloam(c);
    const res = await request(c.previewPort, { method: 'HEAD', path: '/:variant/gloam/index.html', headers: { Cookie: c.cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
    await c.shutdown();
  });
});

test('typed 404 table: unknown id, unbuilt id, an encoded id, a sibling path with a raw traversal, the bare prefix, and a missing file (served from the copy\'s own 404.html when present)', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const built = await buildGloam(c);
    const haze = await postJson(c.adminPort, c.cookie, `http://127.0.0.1:${c.adminPort}`, '/api/variants/theme', { theme: 'haze' });
    assert.equal(haze.status, 200);

    const cases = ['/:variant/gloamx/index.html', '/:variant/vocab/index.html', '/:variant/index.html'];
    for (const p of cases) {
      const res = await request(c.previewPort, { path: p, headers: { Cookie: c.cookie } });
      assert.equal(res.status, 404, p);
      assert.equal(res.headers['content-security-policy'], expectedPreviewFrameCsp('127.0.0.1', c.adminPort), p);
    }

    // The encoded-id case and the raw-traversal case both need byte-exact control over the
    // request line (http.request may re-encode), so they go over a raw socket.
    const encodedId = await rawGet(c.previewPort, '/:variant/%67loam/index.html', `Cookie: ${c.cookie}\r\n`);
    assert.equal(encodedId.status, 404);
    assert.equal(encodedId.headers['content-security-policy'], expectedPreviewFrameCsp('127.0.0.1', c.adminPort));

    const traversal = await rawGet(c.previewPort, '/:variant/gloam/../../haze/site/index.html', `Cookie: ${c.cookie}\r\n`);
    assert.equal(traversal.status, 404);
    assert.equal(traversal.headers['content-security-policy'], expectedPreviewFrameCsp('127.0.0.1', c.adminPort));

    // A missing file under a built copy: the copy's own 404.html, if it has one, served with
    // that body (typed by contentTypeFor).
    const missing = await request(c.previewPort, { path: '/:variant/gloam/nope.html', headers: { Cookie: c.cookie } });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['content-security-policy'], expectedPreviewFrameCsp('127.0.0.1', c.adminPort));

    await c.shutdown();
  });
});

test('no shadowing: at CAND every main-preview file is served 200 with identical bytes, and /:variantx/a stays 400', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const built = await request(c.adminPort, {
      method: 'POST',
      path: '/api/preview',
      headers: { Cookie: c.cookie, Origin: `http://127.0.0.1:${c.adminPort}` },
    });
    assert.equal(built.status, 200);
    // The main preview build writes into its own per-process temp root (ctx.previewDir), never
    // the configured `output` -- the human line names it: "built N file(s) in ... -> <dir>".
    const builtBody = JSON.parse(built.body.toString());
    const outDir = builtBody.human.match(/-> (\S+)/)[1];

    function listTree(dir) {
      const out = [];
      (function walk(d, rel) {
        for (const name of fs.readdirSync(d).sort()) {
          const abs = path.join(d, name);
          const r = rel ? `${rel}/${name}` : name;
          if (fs.statSync(abs).isDirectory()) walk(abs, r);
          else out.push(r);
        }
      })(dir, '');
      return out;
    }
    for (const rel of listTree(outDir)) {
      const res = await request(c.previewPort, { path: `/${rel}`, headers: { Cookie: c.cookie } });
      assert.equal(res.status, 200, rel);
      assert.deepEqual(res.body, fs.readFileSync(path.join(outDir, rel)), rel);
    }

    const notVariant = await request(c.previewPort, { path: '/:variantx/a', headers: { Cookie: c.cookie } });
    assert.equal(notVariant.status, 400);

    await c.shutdown();
  });
});

// At CAND, a `/:variant/` address with no copy ever built dispatches to serveVariant (the new
// code) and gives 404 (builtDirFor returns null), carrying the CSP. At PARENT -- recorded in the
// Engineer's report, not asserted here, since PARENT has none of this file's imports -- the
// identical request gave 400 instead, from resolveStaticPath's pre-existing colon rule (S3's own
// red-first evidence that the reserved prefix could never have shadowed anything there either).
test('an unbuilt id under the prefix gives 404, carrying the CSP (not 400: the new dispatch runs before static.js ever sees the raw colon)', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await request(c.previewPort, { path: '/:variant/gloam/index.html', headers: { Cookie: c.cookie } });
    assert.equal(res.status, 404);
    assert.equal(res.headers['content-security-policy'], expectedPreviewFrameCsp('127.0.0.1', c.adminPort));
    await c.shutdown();
  });
});
