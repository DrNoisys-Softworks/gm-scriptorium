'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const probe = require('../src/setup/probe');
const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');
const { startAdminPanel } = require('../src/cli/serve-admin');
const { createTestProxy } = require('./helpers/remote-test-proxy');
const { makeCampaigns, startPanel, get, post, snapshotFields } = require('./helpers/campaigns-panel');

/*
 * ADR 0050 sections 1, 7, 8 and 9: the campaign list and the switch over real sockets. Expected
 * messages are written out by hand. A hung probe is simulated by an injected stat that settles late
 * (an unref'd timer that rejects after the assertions), and every test that does so waits for the
 * shared probe cap to drain, so one test cannot starve the next.
 */

const PER_CAMPAIGN = ['previewRoot', 'previewDir', 'previewStamp', 'previewPages', 'variants', 'panelSaves', 'vaultArt', 'vaultConfigReview'];
const RESOLVED = ['campaign', 'ctxInfo', 'vaultPath', 'siteSource', 'siteConfigPath', 'packDir', 'writable', 'readOnlyReason'];
const CONFIG_CHANGED = 'Your settings changed outside the panel. Reload and try again.';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** An injected fsp whose stat settles with an error after `lateMs`, long after a short probe bound. */
function hungFsp(lateMs = 1500) {
  return {
    calls: [],
    stat(p) {
      this.calls.push(p);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('late'), { code: 'EIO' })), lateMs);
        timer.unref();
      });
    },
  };
}

async function drainProbes() {
  const started = Date.now();
  while (probe.inFlightCount() > 0) {
    if (Date.now() - started > 8000) throw new Error('probe cap did not drain');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function append(fx, text) {
  fs.appendFileSync(fx.configPath, text);
}

function readAuditLines(fx) {
  const file = path.join(fx.panelDir, 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function snapshotAll(ctx) {
  return { campaign: snapshotFields(ctx, RESOLVED), perCampaign: snapshotFields(ctx, PER_CAMPAIGN), slots: [...ctx.campaigns.slots.keys()], switches: ctx.campaigns.switches };
}

// --- the list ---------------------------------------------------------------------------------------------

test('GET /api/campaigns: config order, active, default, read-only and missing flags, the sha of the file, switchable; no stat ever runs', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta'], { defaultName: 'beta' });
  append(fx, '[campaigns.gone]\nvault = "/no/such/vault"\n\n[campaigns.ro]\nvault = "/no/such/other"\npack = "/some/pack"\n');
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const fsp = hungFsp();
  h.ctx.campaigns.probeDeps = { fsp, timeoutMs: 100 };

  const res = await get(h, '/api/campaigns');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, {
    campaigns: [
      { name: 'alpha', active: true, isDefault: false, readOnly: false, missing: false },
      { name: 'beta', active: false, isDefault: true, readOnly: false, missing: false },
      { name: 'gone', active: false, isDefault: false, readOnly: false, missing: false },
      { name: 'ro', active: false, isDefault: false, readOnly: true, missing: false },
    ],
    configSha256: sha256(fs.readFileSync(fx.configPath)),
    switchable: true,
    lockedReason: null,
  });
  assert.deepEqual(fsp.calls, [], 'listing never probes or stats a vault');
});

test('GET /api/campaigns: a campaign the config no longer holds is appended as missing; a bad config answers 409 config-invalid', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const original = fs.readFileSync(fx.configPath, 'utf8');

  fs.writeFileSync(fx.configPath, original.replace(/\[campaigns\."alpha"\][^[]*/, ''));
  const gone = await get(h, '/api/campaigns');
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.json.campaigns.map((c) => [c.name, c.active, c.missing]), [['beta', false, false], ['alpha', true, true]]);

  fs.writeFileSync(fx.configPath, 'config_version = [[[');
  const bad = await get(h, '/api/campaigns');
  assert.equal(bad.status, 409);
  assert.equal(bad.json.error, 'config-invalid');
  assert.match(bad.json.message, /^config is not valid TOML/);
});

// --- the switch -----------------------------------------------------------------------------------------------

test('switch: success moves the context, answers on /api/session, and writes a request line for A and a response line for B', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const res = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { switched: true, campaign: 'beta' });
  assert.equal(h.ctx.campaign, 'beta');
  assert.equal(h.ctx.vaultPath, fx.vaults.beta);
  assert.equal(h.ctx.campaigns.switches, 1);
  assert.equal(h.ctx.busy, null);
  const session = await get(h, '/api/session');
  assert.equal(session.json.campaign, 'beta');
  const state = await get(h, '/api/state');
  assert.equal(state.json.campaign, 'beta');

  const lines = readAuditLines(fx).filter((l) => l.route === '/api/campaigns/switch');
  assert.deepEqual(lines.map((l) => [l.event, l.campaign, l.status]), [['request', 'alpha', undefined], ['response', 'beta', 200]]);
  assert.equal(lines[0].via, 'loopback');
  assert.equal(lines[1].affected, undefined, 'a switch records no affected name');
});

test('switch: switching to the active campaign answers switched false and probes nothing', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const fsp = hungFsp();
  h.ctx.campaigns.probeDeps = { fsp, timeoutMs: 100 };
  const res = await post(h, '/api/campaigns/switch', { name: 'alpha' }, { campaign: 'alpha' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { switched: false, campaign: 'alpha' });
  assert.deepEqual(fsp.calls, []);
  assert.equal(h.ctx.campaigns.switches, 0);
});

test('switch: bodies other than exactly { name } (text, 1 to 200 characters) are 400 invalid', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  for (const body of ['{}', '{"name":5}', '{"name":""}', '{"name":"beta","extra":1}', '[]', 'null', 'not json', JSON.stringify({ name: 'x'.repeat(201) })]) {
    const res = await post(h, '/api/campaigns/switch', body, { campaign: 'alpha' });
    assert.equal(res.status, 400, body);
    assert.equal(res.json.error, 'invalid', body);
  }
  assert.equal(h.ctx.campaign, 'alpha');
});

test('switch: an unknown name and a missing vault answer 422 with the resolver\'s own words, and change nothing', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const gone = path.join(fx.root, 'not-there');
  append(fx, `[campaigns.gone]\nvault = ${JSON.stringify(gone)}\noutput = ${JSON.stringify(path.join(fx.root, 'o'))}\n\n[campaigns.empty]\noutput = "/o"\n`);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const before = snapshotAll(h.ctx);

  const unknown = await post(h, '/api/campaigns/switch', { name: 'ghost' }, { campaign: 'alpha' });
  assert.equal(unknown.status, 422);
  assert.deepEqual(unknown.json, { error: 'cannot-switch', message: 'no campaign named "ghost" in config (known: alpha, beta, gone, empty)' });

  const missing = await post(h, '/api/campaigns/switch', { name: 'gone' }, { campaign: 'alpha' });
  assert.equal(missing.status, 422);
  assert.deepEqual(missing.json, { error: 'cannot-switch', message: `campaign "gone": configured vault path does not exist: ${gone}` });

  const noVault = await post(h, '/api/campaigns/switch', { name: 'empty' }, { campaign: 'alpha' });
  assert.equal(noVault.status, 422);
  assert.equal(noVault.json.message, 'campaign "empty" has no vault configured. Set one with: gm-scriptorium config add empty --vault <vault folder> --out <output folder>');

  assert.deepEqual(snapshotAll(h.ctx), before);
  assert.equal(h.ctx.busy, null);
});

test('switch: a folder with no vault-config.md and a pack that does not exist are refused in the resolver\'s words', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const notVault = path.join(fx.root, 'plain-folder');
  fs.mkdirSync(notVault);
  const badPack = path.join(fx.root, 'no-pack');
  append(fx, `[campaigns.plain]\nvault = ${JSON.stringify(notVault)}\noutput = "/o"\n\n[campaigns.nopack]\nvault = ${JSON.stringify(fx.vaults.beta)}\npack = ${JSON.stringify(badPack)}\noutput = "/o"\n`);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const plain = await post(h, '/api/campaigns/switch', { name: 'plain' }, { campaign: 'alpha' });
  assert.equal(plain.status, 422);
  assert.match(plain.json.message, new RegExp(`^campaign "plain": ${notVault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} exists but has no _meta/vault-config\\.md; it is not a gm-apprentice vault\\.`));
  const nopack = await post(h, '/api/campaigns/switch', { name: 'nopack' }, { campaign: 'alpha' });
  assert.equal(nopack.status, 422);
  assert.equal(nopack.json.message, `campaign "nopack": pack directory does not exist: ${badPack}`);
  assert.equal(h.ctx.campaign, 'alpha');
});

test('switch: a hung share answers within the bound with a plain message while the panel keeps answering, and leaves the cap drained', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const fsp = hungFsp(1200);
  h.ctx.campaigns.probeDeps = { fsp, timeoutMs: 200 };
  const before = snapshotAll(h.ctx);

  const started = Date.now();
  const pending = post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  await new Promise((r) => setTimeout(r, 50));
  const meanwhile = await get(h, '/api/session');
  assert.equal(meanwhile.status, 200, 'the panel answers while a probe is waiting');
  assert.equal(meanwhile.json.campaign, 'alpha');

  const res = await pending;
  assert.ok(Date.now() - started < 2000, `answered in ${Date.now() - started} ms`);
  assert.equal(res.status, 422);
  assert.deepEqual(res.json, {
    error: 'cannot-switch',
    message: `campaign "beta": ${fx.vaults.beta} did not answer within 0.2 seconds, so the panel stayed on "alpha".`,
  });
  assert.deepEqual(fsp.calls, [fx.vaults.beta], 'the vault was the path that stalled; nothing after it was tried');
  assert.deepEqual(snapshotAll(h.ctx), before);
  assert.equal(h.ctx.busy, null);
  await drainProbes();
  assert.equal(probe.inFlightCount(), 0);
});

test('switch: a hung share on a vault that is NOT on disk still says "did not answer" (no synchronous resolve runs before the probe)', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const gone = path.join(fx.root, 'not-there');
  append(fx, `[campaigns.gone]\nvault = ${JSON.stringify(gone)}\noutput = "/o"\n`);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  h.ctx.campaigns.probeDeps = { fsp: hungFsp(1200), timeoutMs: 200 };
  const res = await post(h, '/api/campaigns/switch', { name: 'gone' }, { campaign: 'alpha' });
  assert.equal(res.status, 422);
  assert.equal(res.json.message, `campaign "gone": ${gone} did not answer within 0.2 seconds, so the panel stayed on "alpha".`);
  await drainProbes();
});

test('switch: an error from the probe says the folder could not be read; a full probe cap says the panel is waiting on other folders', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  h.ctx.campaigns.probeDeps = { fsp: { stat: async () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } }, timeoutMs: 200 };
  const failed = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(failed.status, 422);
  assert.equal(failed.json.message, `campaign "beta": ${fx.vaults.beta} could not be read, so the panel stayed on "alpha".`);

  // Two stalled probes fill the shared cap of two.
  const hung = hungFsp(1200);
  const occupied = [probe.probePath('/occupy/one', { fsp: hung, timeoutMs: 50 }), probe.probePath('/occupy/two', { fsp: hung, timeoutMs: 50 })];
  h.ctx.campaigns.probeDeps = { fsp: hungFsp(1200), timeoutMs: 200 };
  const busy = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(busy.status, 422);
  assert.equal(busy.json.message, 'The panel is already waiting on other folders. Try again in a moment.');
  assert.equal(h.ctx.campaign, 'alpha');
  await Promise.all(occupied);
  await drainProbes();
});

test('switch: every failure leaves every classified field, the stash and the preview root identity untouched', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const gone = path.join(fx.root, 'not-there');
  append(fx, `[campaigns.gone]\nvault = ${JSON.stringify(gone)}\noutput = "/o"\n`);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fx.root, 'preview-')));
  Object.assign(h.ctx, { previewRoot: root, previewDir: path.join(root, 'site'), previewStamp: { s: 1 }, previewPages: ['p'], variants: new Map(), panelSaves: 3, vaultArt: { a: 1 }, vaultConfigReview: { r: 1 } });
  const before = snapshotAll(h.ctx);
  const rootBefore = h.ctx.previewRoot;

  const attempts = [
    () => post(h, '/api/campaigns/switch', { name: 'ghost' }, { campaign: 'alpha' }),
    () => post(h, '/api/campaigns/switch', { name: 'gone' }, { campaign: 'alpha' }),
    async () => {
      h.ctx.campaigns.probeDeps = { fsp: hungFsp(900), timeoutMs: 100 };
      const r = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
      await drainProbes();
      h.ctx.campaigns.probeDeps = undefined;
      return r;
    },
    async () => {
      h.ctx.busy = 'preview';
      const r = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
      h.ctx.busy = null;
      return r;
    },
  ];
  for (const attempt of attempts) {
    const res = await attempt();
    assert.ok(res.status === 422 || res.status === 409, res.text);
    assert.deepEqual(snapshotAll(h.ctx), before);
    assert.strictEqual(h.ctx.previewRoot, rootBefore);
  }
  assert.equal(fs.existsSync(root), true);
});

test('switch: a busy context answers 409 busy with the label', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  h.ctx.busy = 'preview';
  const res = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  h.ctx.busy = null;
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'busy', busy: 'preview' });
});

test('switch: a config that changes while the probes wait is refused config-changed', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const other = path.join(fx.root, 'vault-other');
  fs.cpSync(fx.vaults.beta, other, { recursive: true });
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  h.ctx.campaigns.probeDeps = { fsp: { stat: () => gate }, timeoutMs: 5000 };
  const pending = post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  const started = Date.now();
  while (h.ctx.busy !== 'switch') {
    if (Date.now() - started > 3000) throw new Error('the switch never started');
    await new Promise((r) => setTimeout(r, 5));
  }
  fs.writeFileSync(fx.configPath, fs.readFileSync(fx.configPath, 'utf8').split(JSON.stringify(fx.vaults.beta)).join(JSON.stringify(other)));
  release({});
  const res = await pending;
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.json, { error: 'config-changed', message: CONFIG_CHANGED });
  assert.equal(h.ctx.campaign, 'alpha');
  assert.equal(h.ctx.campaigns.switches, 0);
});

// --- started with --vault ---------------------------------------------------------------------------------------

test('--vault: the list says switching is off with the stated reason, and a switch is refused 409 switch-off', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath, vault: fx.vaults.alpha }, 'alpha');
  const reason = 'This panel was started with --vault, which changes the folder for "alpha" only, so switching campaigns is off. Restart without --vault to switch.';
  const list = await get(h, '/api/campaigns');
  assert.equal(list.json.switchable, false);
  assert.equal(list.json.lockedReason, reason);
  const res = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'switch-off', message: reason });
  assert.equal(h.ctx.campaign, 'alpha');
});

// --- remote access ------------------------------------------------------------------------------------------------

const linuxOnly = { skip: process.platform !== 'linux' ? 'Linux accepts every 127/8 address; other platforms do not' : false };
const PASSWORD = 'correct horse battery';
const ADMIN_HOST = 'scriptorium.home.arpa';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
// Fixed ports for the one remote-access panel in this file: 9460 admin, 9461 preview.
const REMOTE_PORTS = [9460, 9461];

/** A two-campaign config in proxy mode, a password, a real panel and a test proxy in front of it. */
async function startRemote(t) {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  append(fx, `\n[remote]\nmode = "proxy"\nport = ${REMOTE_PORTS[0]}\npreview_port = ${REMOTE_PORTS[1]}\nadmin_url = "${ADMIN_ORIGIN}"\npreview_url = "https://preview.scriptorium.home.arpa"\nbind = "127.0.0.1"\ntrusted_proxies = ["127.0.0.2"]\n`);
  pwWrite.writePasswordRecord(path.join(fx.panelDir, 'password.json'), await pw.hashPassword(PASSWORD));
  const started = await startAdminPanel({ admin: true, config: fx.configPath }, 'alpha', { emit() {} });
  assert.equal(started.ok, true, JSON.stringify(started));
  t.after(() => started.stop());
  const ctx = started.ctx;
  const proxy = await createTestProxy({ upstreamPort: ctx.adminPort, localAddress: '127.0.0.2', clientAddress: '198.51.100.77' });
  t.after(() => proxy.close());

  const send = (method, pathname, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port: proxy.port, method, path: pathname, setHost: false, agent: false, headers: { Host: ADMIN_HOST, ...(method === 'POST' ? { Origin: ADMIN_ORIGIN, 'Content-Type': 'application/json' } : {}), ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}), ...headers } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // not JSON
            }
            resolve({ status: res.statusCode, text, json, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  const signin = await send('POST', '/auth/password', { password: PASSWORD });
  assert.equal(signin.status, 200, signin.text);
  const cookie = `__Host-scriptorium_session=${/__Host-scriptorium_session=([A-Za-z0-9_-]+)/.exec([].concat(signin.headers['set-cookie']).join(';'))[1]}`;
  return { fx, ctx, send: (m, p, b, extra) => send(m, p, b, { Cookie: cookie, ...extra }) };
}

test('remote kind: a switch works, the audit log shows via remote with request A and response B', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const res = await env.send('POST', '/api/campaigns/switch', { name: 'beta' }, { 'X-Scriptorium-Campaign': 'alpha' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { switched: true, campaign: 'beta' });
  assert.equal(env.ctx.campaign, 'beta');
  const lines = readAuditLines(env.fx).filter((l) => l.route === '/api/campaigns/switch');
  assert.deepEqual(lines.map((l) => [l.event, l.via, l.from, l.campaign]), [['request', 'remote', '198.51.100.77', 'alpha'], ['response', 'remote', '198.51.100.77', 'beta']]);
});

test('remote kind: with the audit log unwritable a switch is refused 503 and the panel does not switch', linuxOnly, async (t) => {
  const env = await startRemote(t);
  env.ctx.audit.append = () => {
    throw new Error('disk full');
  };
  const res = await env.send('POST', '/api/campaigns/switch', { name: 'beta' }, { 'X-Scriptorium-Campaign': 'alpha' });
  assert.equal(res.status, 503, res.text);
  assert.equal(res.json.error, 'audit');
  assert.equal(env.ctx.campaign, 'alpha');
  assert.equal(env.ctx.campaigns.switches, 0);
});

test('remote kind: set default and remove work, are audited, and the response line carries the affected name', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const listed = await env.send('GET', '/api/campaigns');
  assert.equal(listed.status, 200, listed.text);

  const def = await env.send('POST', '/api/campaigns/default', { name: 'beta', configSha256: listed.json.configSha256 }, { 'X-Scriptorium-Campaign': 'alpha' });
  assert.equal(def.status, 200, def.text);
  assert.match(fs.readFileSync(env.fx.configPath, 'utf8'), /default_campaign = "beta"/);

  const sha = (await env.send('GET', '/api/campaigns')).json.configSha256;
  const removed = await env.send('POST', '/api/campaigns/remove', { name: 'beta', configSha256: sha }, { 'X-Scriptorium-Campaign': 'alpha' });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(fs.readFileSync(env.fx.configPath, 'utf8').includes('[campaigns.beta]'), false);

  const lines = readAuditLines(env.fx).filter((l) => l.route === '/api/campaigns/default' || l.route === '/api/campaigns/remove');
  assert.deepEqual(lines.map((l) => [l.event, l.route, l.via, l.campaign, l.affected]), [
    ['request', '/api/campaigns/default', 'remote', 'alpha', undefined],
    ['response', '/api/campaigns/default', 'remote', 'alpha', 'beta'],
    ['request', '/api/campaigns/remove', 'remote', 'alpha', undefined],
    ['response', '/api/campaigns/remove', 'remote', 'alpha', 'beta'],
  ]);
});
