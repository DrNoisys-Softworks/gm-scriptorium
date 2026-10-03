'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-s1-engineering-brief-2026-09-28.md, "Test-first order"
 * item 7). Skipped on win32 (spawns node bin/scriptorium.js directly; Windows verification is a
 * separate track, docs/HANDOVER-WINDOWS.md). Synthetic cast only (NFR-10/NFR-11).
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const skip = process.platform === 'win32';

function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-scriptorium-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg-config-home');
  return env;
}

function writeScratchVault(root) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# x\n');
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), '{"siteTitle":"Alpha Test"}\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');

  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
  );
  return { vaultPath, configPath };
}

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-e2e-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function httpGet(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('e2e: spawn serve --admin, read the 3 lines, GET /api/session with the cookie, SIGINT, exit 0', { skip }, async (t) => {
  await withScratchDir(async (root) => {
    const { configPath } = writeScratchVault(root);
    const child = spawn(process.execPath, [BIN, 'serve', '--admin', 'alpha', '--config', configPath], {
      env: scratchEnv(root),
    });

    // Test-hygiene fix (Reviewer finding, 2026-09-28): this child never exits on its own (it
    // only stops on SIGINT). A failing assertion below the spawn used to leave it running
    // forever, with its stdio pipes keeping node --test's event loop alive. t.after() guarantees
    // a kill runs regardless of pass/fail; killing an already-exited child is a silent no-op.
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));

    const lines = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for 3 startup lines; stdout so far: ${stdout}; stderr so far: ${stderr}`)), 60000);
      const onData = () => {
        const got = stdout.split('\n').filter(Boolean);
        if (got.length >= 3) {
          clearTimeout(timer);
          child.stdout.removeListener('data', onData);
          resolve(got);
        }
      };
      child.stdout.on('data', onData);
      onData();
    });

    assert.match(lines[0], /^admin panel: http:\/\/127\.0\.0\.1:\d+\/auth\?token=[A-Za-z0-9_-]{43}$/);
    assert.match(lines[1], /^preview: http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(lines[2], 'open the admin panel link in your browser. Press Ctrl-C to stop.');

    const adminPort = Number(lines[0].match(/127\.0\.0\.1:(\d+)/)[1]);
    const token = lines[0].match(/token=([A-Za-z0-9_-]{43})$/)[1];

    const authResult = await httpGet(adminPort, `/auth?token=${token}`);
    assert.equal(authResult.status, 303);

    const cookie = `scriptorium_admin_${adminPort}=${token}`;
    const sessionResult = await httpGet(adminPort, '/api/session', { Cookie: cookie });
    assert.equal(sessionResult.status, 200);

    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.kill('SIGINT');
    });

    assert.equal(exitCode, 0);
    assert.equal(stdout.trim().split('\n').filter(Boolean).pop(), 'stopped.');
    assert.equal(stderr, '');
  });
});

test('e2e: --host with --admin exits 1, one stderr line, empty stdout', { skip }, async (t) => {
  await withScratchDir(async (root) => {
    const { configPath } = writeScratchVault(root);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, 'serve', '--admin', 'alpha', '--host', '127.0.0.1', '--config', configPath], {
        env: scratchEnv(root),
      });
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c.toString()));
      child.stderr.on('data', (c) => (stderr += c.toString()));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    const stderrLines = result.stderr.split('\n').filter(Boolean);
    assert.equal(stderrLines.length, 1);
    assert.equal(stderrLines[0], 'serve --admin does not accept --host; remote access comes only from saved settings (see "scriptorium remote")');
  });
});

test('e2e: --help stdout contains the exact new serve line', { skip }, async (t) => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, '--help'], { env: process.env });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout }));
  });
  assert.equal(result.code, 0);
  assert.ok(
    result.stdout.includes('  serve    [campaign] [--build] [--port N] [--host ADDR] | [campaign] --admin [--port N] [--preview-port N]'),
  );
});
