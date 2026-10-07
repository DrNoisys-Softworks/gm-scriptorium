'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const serverModule = require('../src/serve/server');

/*
 * Issue #78 closeout. The two defects were fixed on 2026-09-29 (b5e5c4b, D11: src/serve/static.js
 * resolver) and are covered by test/serve-static.test.js. This adds raw-socket probes (the request
 * line is sent byte-for-byte, so nothing normalises the URL before the server sees it) for the
 * wider escape set: encoded and double-encoded dots, backslash, prefix sibling, symlinks, case,
 * trailing slashes, NUL, drive letters. A body containing a SECRET marker is a leak. Synthetic
 * names only. Port 8201 (range 8200-8219).
 *
 * Tests that pass against the pre-D11 code and therefore prove nothing as evidence for the fix:
 * the plain-200 controls ("/", "/sub/") and the 404 for a missing file.
 */

const PORT = 8201;

function rawGet(requestTarget) {
  return new Promise((resolve, reject) => {
    const c = net.connect(PORT, '127.0.0.1');
    let data = '';
    c.on('data', (d) => (data += d));
    c.on('error', reject);
    c.on('close', () => resolve({ status: Number(data.split(' ')[1]), data }));
    c.write(`GET ${requestTarget} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
}

async function withServer(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-escape-'));
  const out = path.join(base, 'out');
  fs.mkdirSync(path.join(out, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), 'ROOT-INDEX');
  fs.writeFileSync(path.join(out, 'sub', 'index.html'), 'SUB-INDEX');
  fs.mkdirSync(`${out}-evil`);
  fs.writeFileSync(path.join(`${out}-evil`, 'secret.txt'), 'SECRET-SIBLING');
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 's.txt'), 'SECRET-OUTSIDE');
  let symlinked = true;
  try {
    fs.symlinkSync('../outside', path.join(out, 'link'), 'dir');
  } catch {
    symlinked = false;
  }
  const server = serverModule.createServer(out);
  await new Promise((r, j) => server.once('error', j).listen(PORT, '127.0.0.1', r));
  try {
    return await fn({ symlinked });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('#78 probes: no escape form returns a secret, and the server survives all of them', async () => {
  await withServer(async ({ symlinked }) => {
    const bad = [
      '/%E0%A4%A',
      '/%',
      '/%zz',
      '/..%2fout-evil/secret.txt',
      '/../out-evil/secret.txt',
      '/%2e%2e/out-evil/secret.txt',
      '/%252e%252e/out-evil/secret.txt',
      '/..%5cout-evil/secret.txt',
      '/sub/../../out-evil/secret.txt',
      '/sub/%2e%2e/%2e%2e/out-evil/secret.txt',
      '/sub/..%2f..%2fout-evil/secret.txt',
      '/%00',
      '/index.html%00.png',
      '/C:/windows',
      'http://x/',
    ];
    if (symlinked) bad.push('/link/s.txt');
    for (const target of bad) {
      const { status, data } = await rawGet(target);
      assert.ok([400, 404].includes(status), `${target} -> ${status}`);
      assert.ok(!data.includes('SECRET'), `${target} leaked`);
    }
    // Encoded-slash and backslash and malformed forms are 400, not merely 404.
    for (const target of ['/%E0%A4%A', '/..%2fout-evil/secret.txt', '/..%5cout-evil/secret.txt', '/../out-evil/secret.txt']) {
      assert.equal((await rawGet(target)).status, 400, target);
    }
    // Survival, and positive controls (trailing slash and double slash still resolve).
    assert.equal((await rawGet('/')).status, 200);
    assert.ok((await rawGet('/sub/')).data.includes('SUB-INDEX'));
    assert.ok((await rawGet('/sub')).data.includes('SUB-INDEX'));
  });
});

test('#78: the dead safeJoin helper (string-prefix check, bare decodeURIComponent) is gone from server.js', () => {
  assert.equal(serverModule.safeJoin, undefined);
});
