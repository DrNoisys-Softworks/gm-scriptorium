'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { ADMIN_ROUTES } = require('../src/admin/router');
const campaignstate = require('../src/admin/campaignstate');
const { makeCampaigns, startPanel, post, get } = require('./helpers/campaigns-panel');

/*
 * ADR 0050 section 4: a change carries the campaign its page was loaded for, and the router refuses
 * a page that is out of date before any handler runs. The route table is swept: every campaign-bound
 * route gets a spy handler, so "refused" means the spy was never called. The expected list is
 * written out by hand.
 */

const BOUND = [
  '/api/check',
  '/api/preview',
  '/api/pack/theme',
  '/api/pack/settings',
  '/api/pack/vocab',
  '/api/pack/slots',
  '/api/images/upload',
  '/api/vault-config/tagline',
  '/api/prefs',
  '/api/vault-config/effects',
  '/api/vault-config/text',
  '/api/vault-config/restore',
  '/api/vault-config/fields',
  '/api/variants/theme',
  '/api/variants/vocab',
  '/api/welcome/dismiss',
  '/api/campaigns/switch',
  '/api/campaigns/default',
  '/api/campaigns/remove',
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Replaces every route handler with a spy for one test; restores them afterwards. */
function spyOnRoutes(t) {
  const calls = [];
  const saved = ADMIN_ROUTES.map((r) => r.handler);
  for (const r of ADMIN_ROUTES) {
    const label = `${r.method} ${r.path || r.prefix}`;
    r.handler = (req, res) => {
      calls.push(label);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"spy":true}');
    };
  }
  t.after(() => {
    ADMIN_ROUTES.forEach((r, i) => {
      r.handler = saved[i];
    });
  });
  return calls;
}

test('the campaign-bound routes are exactly the audited POSTs minus the setup commit (a hand-written list of 19)', () => {
  const derived = ADMIN_ROUTES.filter((r) => campaignstate.isCampaignBound(r)).map((r) => r.path);
  assert.deepEqual(derived, BOUND);
  const audited = ADMIN_ROUTES.filter((r) => r.method === 'POST' && r.audit === true).map((r) => r.path);
  assert.equal(audited.length, BOUND.length + 1);
  assert.deepEqual(audited.filter((p) => !BOUND.includes(p)), ['/api/setup/commit']);
});

test('a mismatched or undecodable header is refused 409 on every bound route and no handler runs; a missing one is refused after the first switch', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const calls = spyOnRoutes(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const refusal = '{"error":"campaign-changed","campaign":"alpha","message":"This tab is out of date. Reload to continue."}';

  for (const route of BOUND) {
    const mismatched = await post(h, route, {}, { campaign: 'beta' });
    assert.equal(mismatched.status, 409, route);
    assert.equal(mismatched.text, refusal, route);
    const undecodable = await post(h, route, {}, { headers: { 'X-Scriptorium-Campaign': '%E0%A4%A' } });
    assert.equal(undecodable.status, 409, `${route} (undecodable)`);
    assert.equal(undecodable.json.error, 'campaign-changed');
  }
  assert.deepEqual(calls, []);

  // Before any switch, a missing header passes (every tab was loaded for the only campaign served).
  for (const route of BOUND) {
    const res = await post(h, route, {});
    assert.equal(res.status, 200, `${route} (no header, no switch yet)`);
  }
  assert.equal(calls.length, BOUND.length);

  // After a switch, a missing header is refused.
  calls.length = 0;
  h.ctx.campaigns.switches = 1;
  for (const route of BOUND) {
    const res = await post(h, route, {});
    assert.equal(res.status, 409, `${route} (no header, after a switch)`);
  }
  assert.deepEqual(calls, []);
});

test('a correct header reaches the handler, including for a name with a non-ASCII character', async (t) => {
  const fx = makeCampaigns(t, ['élan', 'beta'], { defaultName: 'élan' });
  const calls = spyOnRoutes(t);
  const h = await startPanel(t, { config: fx.configPath }, 'élan');
  h.ctx.campaigns.switches = 1;
  for (const route of BOUND) {
    const res = await post(h, route, {}, { campaign: 'élan' });
    assert.equal(res.status, 200, route);
  }
  assert.equal(calls.length, BOUND.length);
});

test('every route that is not bound ignores a mismatched header', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  spyOnRoutes(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  h.ctx.campaigns.switches = 1;
  const unbound = ADMIN_ROUTES.filter((r) => r.path !== undefined && !campaignstate.isCampaignBound(r) && !['/auth', '/auth/password', '/auth/launch', '/'].includes(r.path));
  assert.ok(unbound.length >= 15);
  for (const r of unbound) {
    const res = await (r.method === 'POST' ? post(h, r.path, {}, { campaign: 'beta' }) : get(h, r.path, { campaign: 'beta' }));
    assert.notEqual(res.json && res.json.error, 'campaign-changed', `${r.method} ${r.path}`);
    assert.equal(res.status, 200, `${r.method} ${r.path}`);
  }
});

test('the setup commit is exempt: a mismatched header gets the commit handler\'s own answer', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  h.ctx.campaigns.switches = 1;
  const res = await post(h, '/api/setup/commit', {}, { campaign: 'beta' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'setup-done' });
});

test('the pure helpers: pageMatches, enter and leave tolerate a context with no campaigns state', () => {
  const bare = { campaign: 'a' };
  assert.equal(campaignstate.pageMatches(bare, undefined), true);
  assert.equal(campaignstate.pageMatches(bare, 'a'), true);
  assert.equal(campaignstate.pageMatches(bare, 'b'), false);
  assert.equal(campaignstate.pageMatches(bare, 5), false);
  assert.equal(campaignstate.pageMatches({ campaign: 'a', campaigns: { switches: 1 } }, undefined), false);
  assert.doesNotThrow(() => {
    campaignstate.enter(bare);
    campaignstate.leave(bare);
  });
});

// --- behavioural: the two-tab case and the slow body --------------------------------------------------------

function packTomlOf(vault) {
  return path.join(vault, '_meta', 'scriptorium', 'pack.toml');
}

test('two tabs: after tab B switches the panel to beta, tab A\'s save is refused and both packs keep their bytes', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const before = { alpha: sha256(fs.readFileSync(packTomlOf(fx.vaults.alpha))), beta: sha256(fs.readFileSync(packTomlOf(fx.vaults.beta))) };

  const sw = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(sw.status, 200, sw.text);

  const stale = await post(h, '/api/pack/theme', { theme: 'haze', baseSha256: before.alpha }, { campaign: 'alpha' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'campaign-changed');
  assert.equal(stale.json.campaign, 'beta');

  assert.equal(sha256(fs.readFileSync(packTomlOf(fx.vaults.alpha))), before.alpha);
  assert.equal(sha256(fs.readFileSync(packTomlOf(fx.vaults.beta))), before.beta);
  assert.equal(h.ctx.campaigns.inFlight, 0);
});

/** Opens a POST, sends the headers and the first half of the body, and returns a function that finishes it. */
function startSlowPost(h, pathname, bodyText, campaign) {
  const half = Math.floor(bodyText.length / 2);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: h.port,
        method: 'POST',
        path: pathname,
        headers: {
          Cookie: h.cookie,
          Origin: h.origin,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(bodyText)),
          'X-Scriptorium-Campaign': encodeURIComponent(campaign),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finished({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    let finished;
    const done = new Promise((r) => {
      finished = r;
    });
    req.on('error', reject);
    req.write(bodyText.slice(0, half));
    resolve({ finish: () => { req.end(bodyText.slice(half)); return done; } });
  });
}

async function waitFor(fn, what, ms = 5000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('slow body: a switch is refused busy while a passing POST still waits for its body; finishing it writes to the OLD campaign', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const baseSha256 = sha256(fs.readFileSync(packTomlOf(fx.vaults.alpha)));
  const betaBefore = sha256(fs.readFileSync(packTomlOf(fx.vaults.beta)));

  const slow = await startSlowPost(h, '/api/pack/theme', JSON.stringify({ theme: 'haze', baseSha256 }), 'alpha');
  await waitFor(() => h.ctx.campaigns.inFlight === 1, 'the slow POST to pass the check');

  const sw = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(sw.status, 409, sw.text);
  assert.equal(sw.json.error, 'busy');
  assert.equal(h.ctx.campaign, 'alpha');

  const done = await slow.finish();
  assert.equal(done.status, 200, done.text);
  assert.match(fs.readFileSync(packTomlOf(fx.vaults.alpha), 'utf8'), /theme = "haze"/);
  assert.equal(sha256(fs.readFileSync(packTomlOf(fx.vaults.beta))), betaBefore);
  assert.equal(h.ctx.campaign, 'alpha');
  await waitFor(() => h.ctx.campaigns.inFlight === 0, 'inFlight to return to 0');
});

test('inFlight returns to 0 when a handler throws (leave runs in finally)', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const saved = ADMIN_ROUTES.map((r) => r.handler);
  const route = ADMIN_ROUTES.find((r) => r.path === '/api/pack/theme');
  route.handler = async () => {
    throw new Error('handler blew up');
  };
  t.after(() => {
    ADMIN_ROUTES.forEach((r, i) => {
      r.handler = saved[i];
    });
  });
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  // Without an audit log the router dispatches the handler directly, so its throw reaches the router's own finally.
  delete h.ctx.audit;
  const res = await post(h, '/api/pack/theme', {}, { campaign: 'alpha' });
  assert.equal(res.status, 500);
  assert.equal(h.ctx.campaigns.inFlight, 0);
});
