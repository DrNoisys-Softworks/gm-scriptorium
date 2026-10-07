'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const { startServer } = require('../src/serve/server');
const { runServeCommand } = require('../src/cli/serve');

/*
 * Issue #79: startServer resolved the port it was ASKED for, so `--port 0` reported 0. Synthetic
 * names only. Port 0 (OS-assigned) is the point of the first test, so it is the one place these
 * tests do not use a fixed port.
 */

test('#79: startServer on port 0 reports the port it actually bound, and it answers there', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-serve-port-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>hello</html>');
  const { server, port } = await startServer(root, { port: 0 });
  try {
    assert.equal(port, server.address().port);
    assert.notEqual(port, 0);
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      }).on('error', reject);
    });
    assert.equal(body, '<html>hello</html>');
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#79: the CLI prints the bound port, not the requested one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-serve-port-cli-'));
  try {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n');
    const outputPath = path.join(root, 'out');
    fs.mkdirSync(outputPath);
    fs.writeFileSync(path.join(outputPath, 'index.html'), '<html></html>');
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "servetest"', '', '[campaigns.servetest]', `vault = '${vaultPath}'`, `output = '${outputPath}'`, ''].join('\n'),
    );
    const emitted = [];
    // The fake binds "somewhere else" than requested: 8217 is the stated bound port.
    const startFake = async () => ({ server: { close: (cb) => cb && cb() }, port: 8217 });
    const signals = new EventEmitter();
    const p = runServeCommand({ config: configPath, port: '0' }, 'servetest', {
      emit: (l) => emitted.push(l),
      startServer: startFake,
      signals,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const line = emitted.find((l) => l.startsWith('serving '));
    assert.ok(line, 'serving line emitted');
    assert.ok(line.includes('http://127.0.0.1:8217 '), line);
    assert.ok(!line.includes(':0 '), line);
    signals.emit('SIGINT');
    await p;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
