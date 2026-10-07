'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startServer } = require('../src/serve/server');
const respond = require('../src/admin/respond');

/* Hardening: every plain-serve response carries X-Content-Type-Options: nosniff; the admin and
 * preview header sets already did, and this pins that. */

test('plain serve sends nosniff on 200, 404 and 400 responses', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-nosniff-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  const { server, port } = await startServer(root, { port: 0 });
  const get = (p) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, header: res.headers['x-content-type-options'] }));
      }).on('error', reject);
    });
  try {
    const cases = [['/', 200], ['/missing.html', 404], ['/%E0%A4%A', 400]];
    for (const [p, status] of cases) {
      const r = await get(p);
      assert.equal(r.status, status, p);
      assert.equal(r.header, 'nosniff', `${p} (${status})`);
    }
  } finally {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('admin and preview header sets already carry nosniff', () => {
  assert.equal(respond.adminHeaders()['X-Content-Type-Options'], 'nosniff');
  assert.equal(respond.previewHeaders()['X-Content-Type-Options'], 'nosniff');
});
