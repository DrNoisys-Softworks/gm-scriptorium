'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startServer } = require('../src/serve/server');

/* QA F11: NOTICE.txt (linked from every page footer) was served as application/octet-stream, so
 * browsers downloaded it instead of showing it. */

test('F11: a .txt file is served as text/plain and an unknown type stays octet-stream', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-mime-'));
  fs.writeFileSync(path.join(root, 'NOTICE.txt'), 'notice');
  fs.writeFileSync(path.join(root, 'blob.zzz'), 'x');
  const { server, port } = await startServer(root, { port: 0 });
  const get = (p) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers['content-type']));
      }).on('error', reject);
    });
  try {
    assert.equal(await get('/NOTICE.txt'), 'text/plain; charset=utf-8');
    assert.equal(await get('/blob.zzz'), 'application/octet-stream');
  } finally {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
