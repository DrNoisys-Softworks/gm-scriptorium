'use strict';

/*
 * Shared scratch harness for the several-campaigns tests (ADR 0050): a config with N sample-vault
 * campaigns, an in-process admin panel on a loopback port 0 (never a real config, never a real
 * vault), and a small HTTP client. Not a *.test.js file, so `node --test` does not run it.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const assert = require('node:assert/strict');
const { scratchRoot, copySample, configPathIn } = require('./setup-fixtures');
const { startAdminPanel } = require('../../src/cli/serve-admin');
const { startLocalListener } = require('../../src/serve/server');
const configWrite = require('../../src/config/write');

/** Hand-written config text for campaigns that each have their own copy of the sample vault. */
function makeCampaigns(t, names = ['alpha', 'beta'], { defaultName = names[0] } = {}) {
  const root = scratchRoot(t);
  const vaults = {};
  const lines = ['config_version = 1', `default_campaign = ${JSON.stringify(defaultName)}`, ''];
  for (const name of names) {
    vaults[name] = copySample(root, `vault-${name}`, { withPack: true });
    lines.push(`[campaigns.${JSON.stringify(name)}]`, `vault = ${JSON.stringify(vaults[name])}`, `output = ${JSON.stringify(path.join(root, `out-${name}`))}`, '');
  }
  const configPath = configPathIn(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, lines.join('\n'));
  return { root, vaults, configPath, panelDir: path.join(path.dirname(configPath), 'panel') };
}

/** startAdminPanel with real loopback listeners; `stop` is also registered on the test context. */
async function startPanel(t, flags, campaignArg) {
  const result = await startAdminPanel({ admin: true, ...flags }, campaignArg, {
    emit() {},
    startLocalListener,
    startPanelListener: async () => {
      throw new Error('no remote listener expected');
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await result.stop();
  };
  t.after(stop);
  const port = result.ctx.adminPort;
  return {
    ctx: result.ctx,
    port,
    previewPort: result.ctx.previewPort,
    stop,
    cookie: `scriptorium_admin_${port}=${result.token}`,
    previewCookie: `scriptorium_admin_${port}=${result.token}`, // the preview listener reads the admin cookie (loopback)
    origin: `http://127.0.0.1:${port}`,
  };
}

/** One HTTP request to the loopback admin port. A JSON object body is stringified. */
function call(h, method, pathname, { body, headers = {}, campaign } = {}) {
  return new Promise((resolve, reject) => {
    const h2 = { Cookie: h.cookie, ...headers };
    if (method === 'POST') Object.assign(h2, { Origin: h.origin, 'Content-Type': 'application/json' });
    if (campaign !== undefined) h2['X-Scriptorium-Campaign'] = encodeURIComponent(campaign);
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: h.port, method, path: pathname, headers: h2 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, text, json, body: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const get = (h, p, opts) => call(h, 'GET', p, opts);
const post = (h, p, body, opts) => call(h, 'POST', p, { body, ...opts });

/** One GET to the loopback preview port. */
function previewGet(h, pathname = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.previewPort, method: 'GET', path: pathname, headers: { Cookie: h.previewCookie } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Snapshot of the classified per-campaign fields, for "a failure changes nothing" checks. */
function snapshotFields(ctx, fields) {
  const out = {};
  for (const f of fields) out[f] = f in ctx ? ctx[f] : '<absent>';
  return out;
}

module.exports = { makeCampaigns, startPanel, call, get, post, previewGet, snapshotFields, configWrite, copySample, scratchRoot, configPathIn };
