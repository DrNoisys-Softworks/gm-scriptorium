'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { MIME_TYPES, contentTypeFor, resolveStaticPath } = require('../src/serve/static');
const { createServer } = require('../src/serve/server');

/*
 * Phase 8 slice S2 (docs/agent-runs/admin-s2-engineering-brief-2026-09-28.md, "static.js" /
 * "Test-first order" item 1). A pure resolver (no network builtin), plus D11's real-socket
 * regression tests against the fixed plain-serve createServer. Synthetic cast only (NFR-10/11).
 */

async function withScratchRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-serve-static-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixtureRoot(root) {
  fs.writeFileSync(path.join(root, 'index.html'), '<html>root index</html>');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'index.html'), '<html>sub index</html>');
  fs.writeFileSync(path.join(root, 'crest.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]));
  fs.writeFileSync(path.join(root, '404.html'), '<html>not found</html>');
}

// --- Resolver, in-process ------------------------------------------------

test('resolveStaticPath: a normal file resolves ok', async () => {
  await withScratchRoot((root) => {
    writeFixtureRoot(root);
    const result = resolveStaticPath(root, '/crest.png');
    assert.equal(result.ok, true);
    assert.equal(result.filePath, path.join(root, 'crest.png'));
  });
});

test('resolveStaticPath: a directory resolves to index.html', async () => {
  await withScratchRoot((root) => {
    writeFixtureRoot(root);
    const result = resolveStaticPath(root, '/sub');
    assert.equal(result.ok, true);
    assert.equal(result.filePath, path.join(root, 'sub', 'index.html'));
  });
});

test('resolveStaticPath: a path ending in / resolves to index.html', async () => {
  await withScratchRoot((root) => {
    writeFixtureRoot(root);
    const result = resolveStaticPath(root, '/sub/');
    assert.equal(result.ok, true);
    assert.equal(result.filePath, path.join(root, 'sub', 'index.html'));
  });
});

test('resolveStaticPath: root / resolves to the root index.html', async () => {
  await withScratchRoot((root) => {
    writeFixtureRoot(root);
    const result = resolveStaticPath(root, '/');
    assert.equal(result.ok, true);
    assert.equal(result.filePath, path.join(root, 'index.html'));
  });
});

const traversal400Cases = ['/..%2fsibling/x', '/%2e%2e/x', '/a/../../x'];
for (const rawUrl of traversal400Cases) {
  test(`resolveStaticPath: traversal form ${rawUrl} gets 400`, async () => {
    await withScratchRoot((root) => {
      writeFixtureRoot(root);
      const result = resolveStaticPath(root, rawUrl);
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    });
  });
}

const malformed400Cases = ['/%E0%A4%A', '/%00', '/%5c', '/C:/x', '/x.png:hidden'];
for (const rawUrl of malformed400Cases) {
  test(`resolveStaticPath: malformed/reserved form ${rawUrl} gets 400`, async () => {
    await withScratchRoot((root) => {
      writeFixtureRoot(root);
      const result = resolveStaticPath(root, rawUrl);
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    });
  });
}

test('resolveStaticPath: an absolute-form URL gets 400', async () => {
  await withScratchRoot((root) => {
    writeFixtureRoot(root);
    const result = resolveStaticPath(root, 'http://x/');
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });
});

test('resolveStaticPath: a missing file gets 404', async () => {
  await withScratchRoot((root) => {
    writeFixtureRoot(root);
    const result = resolveStaticPath(root, '/nope.html');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });
});

test('resolveStaticPath: a symlink inside the root pointing outside it gets 404', async () => {
  await withScratchRoot((root) => {
    writeFixtureRoot(root);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-serve-static-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'sentinel-outside-bytes');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));
      const result = resolveStaticPath(root, '/linked.txt');
      assert.equal(result.ok, false);
      assert.equal(result.status, 404);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// Positive control for the symlink case: a symlink INSIDE the root, pointing at another file
// still inside the root, must still resolve.
test('resolveStaticPath: a symlink inside the root pointing inside it still resolves (positive control)', async () => {
  await withScratchRoot((root) => {
    writeFixtureRoot(root);
    fs.symlinkSync(path.join(root, 'crest.png'), path.join(root, 'linked-in.png'));
    const result = resolveStaticPath(root, '/linked-in.png');
    assert.equal(result.ok, true);
  });
});

test('contentTypeFor: known extensions map, unknown falls back to octet-stream', () => {
  assert.equal(contentTypeFor('/x/y.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('/x/y.png'), 'image/png');
  assert.equal(contentTypeFor('/x/y.unknownext'), 'application/octet-stream');
  assert.ok(MIME_TYPES['.css']);
});

test('contentTypeFor: .ttf is font/ttf (ADR 0032: gloam theme fonts, F6)', () => {
  assert.equal(contentTypeFor('/x/y.ttf'), 'font/ttf');
  assert.equal(MIME_TYPES['.ttf'], 'font/ttf');
});

// --- Real-socket D11 regression tests, against createServer --------------

function request(port, reqPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: reqPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function withServer(t, rootDir) {
  const server = createServer(rootDir);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      t.after(() => new Promise((res) => server.close(() => res())));
      resolve(port);
    });
  });
}

test('D11: createServer serves a 200 whose body is byte-equal to the file', async (t) => {
  await withScratchRoot(async (root) => {
    writeFixtureRoot(root);
    const port = await withServer(t, root);
    const res = await request(port, '/crest.png');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, fs.readFileSync(path.join(root, 'crest.png')));
  });
});

test('D11: a malformed escape gets 400 and does not crash the server (next request still 200)', async (t) => {
  await withScratchRoot(async (root) => {
    writeFixtureRoot(root);
    const port = await withServer(t, root);
    const bad = await request(port, '/%E0%A4%A');
    assert.equal(bad.status, 400);
    const good = await request(port, '/crest.png');
    assert.equal(good.status, 200);
    assert.deepEqual(good.body, fs.readFileSync(path.join(root, 'crest.png')));
  });
});

test('D11: a sibling-directory traversal gets 400 and the sentinel bytes never appear', async (t) => {
  await withScratchRoot(async (root) => {
    writeFixtureRoot(root);
    const outRoot = path.join(root, 'out.scriptorium-old-1');
    fs.mkdirSync(outRoot);
    fs.writeFileSync(path.join(outRoot, 'sentinel.txt'), 'do-not-leak-this-sentinel');
    const served = path.join(root, 'out');
    fs.mkdirSync(served);
    fs.writeFileSync(path.join(served, 'index.html'), '<html>served root</html>');
    const port = await withServer(t, served);
    const res = await request(port, '/..%2fout.scriptorium-old-1/sentinel.txt');
    assert.equal(res.status, 400);
    assert.ok(!res.body.toString('utf8').includes('do-not-leak-this-sentinel'));
  });
});

// Positive control for the traversal test above: the same server, a well-formed request for a
// real file inside the served root, still returns 200.
test('D11: positive control — a well-formed request under the served root still returns 200', async (t) => {
  await withScratchRoot(async (root) => {
    const served = path.join(root, 'out');
    fs.mkdirSync(served);
    fs.writeFileSync(path.join(served, 'index.html'), '<html>served root</html>');
    const port = await withServer(t, served);
    const res = await request(port, '/index.html');
    assert.equal(res.status, 200);
    assert.equal(res.body.toString('utf8'), '<html>served root</html>');
  });
});

test('D11: a 404 still falls back to 404.html', async (t) => {
  await withScratchRoot(async (root) => {
    writeFixtureRoot(root);
    const port = await withServer(t, root);
    const res = await request(port, '/nope-at-all.html');
    assert.equal(res.status, 404);
    assert.equal(res.body.toString('utf8'), '<html>not found</html>');
  });
});
