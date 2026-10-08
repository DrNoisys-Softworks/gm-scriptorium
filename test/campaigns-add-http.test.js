'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');
const { startAdminPanel } = require('../src/cli/serve-admin');
const { runConfigCommand } = require('../src/cli/config');
const { createTestProxy } = require('./helpers/remote-test-proxy');
const { FIXTURE_DIR } = require('./helpers/vault-template-fixture');
const { makeCampaigns, startPanel, call, get, post, scratchRoot, copySample, configPathIn } = require('./helpers/campaigns-panel');
const { treeSnapshot } = require('./helpers/setup-fixtures');

/*
 * ADR 0052 sections 1, 2 and 6: the add page, its state, its live checks and its commit over real
 * sockets, on loopback and through a test proxy as a remote session. Expected strings are written
 * out by hand. The audit lines are read back from the audit log on disk.
 */

const ROOT = path.join(__dirname, '..');
const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CONFIG_CHANGED = 'Your settings changed outside the panel. Reload and try again.';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function readAuditLines(fx) {
  const file = path.join(fx.panelDir, 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A fixture with alpha and beta registered, plus a pack-less vault ready to add. */
function fixture(t, names = ['alpha', 'beta']) {
  const fx = makeCampaigns(t, names);
  fx.vaultNew = copySample(fx.root, 'vault-new');
  fx.outNew = path.join(fx.root, 'out-new');
  return fx;
}

const checkUrl = (field, params = {}) => `/api/campaigns/add/check?${new URLSearchParams({ field, ...params })}`;

async function stateOf(h) {
  const res = await get(h, '/api/campaigns/add/state');
  assert.equal(res.status, 200, res.text);
  return res.json;
}

// --- the page ------------------------------------------------------------------------------------------------

test('GET /campaigns/add serves setup.html byte for byte with the admin CSP, and HEAD answers with the same headers and no body', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const bytes = fs.readFileSync(path.join(ROOT, 'assets', 'admin', 'setup.html'));
  const res = await get(h, '/campaigns/add');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, bytes);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['content-security-policy'], ADMIN_CSP);
  assert.equal(res.headers['cache-control'], 'no-store');
  const head = await call(h, 'HEAD', '/campaigns/add');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-security-policy'], ADMIN_CSP);
});

test('GET /campaigns/add without the session cookie is refused, and setup mode fences the page and every add route with 409', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const anon = await call(h, 'GET', '/campaigns/add', { headers: { Cookie: '' } });
  assert.notEqual(anon.status, 200);

  const root = scratchRoot(t);
  const setupMode = await startPanel(t, { config: configPathIn(root) });
  assert.equal(setupMode.ctx.setup.active, true);
  for (const p of ['/campaigns/add', '/api/campaigns/add/state', checkUrl('name', { value: 'a' })]) {
    const res = await get(setupMode, p);
    assert.equal(res.status, 409, p);
    assert.deepEqual(res.json, { error: 'setup', message: 'There is no campaign yet. Finish setup first.' }, p);
  }
  const posted = await post(setupMode, '/api/campaigns/add', {});
  assert.equal(posted.status, 409);
  assert.equal(posted.json.error, 'setup');
});

// --- the state --------------------------------------------------------------------------------------------------

test('GET /api/campaigns/add/state: the hand-written key list, the names in config order, the default, the sha, switchable and via', async (t) => {
  const fx = fixture(t, ['alpha', 'beta', 'gamma']);
  const h = await startPanel(t, { config: fx.configPath }, 'beta');
  h.ctx.campaigns.probeDeps = { templateDir: FIXTURE_DIR };
  const res = await get(h, '/api/campaigns/add/state');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.json).sort(), [
    'campaign',
    'campaigns',
    'configPath',
    'configSha256',
    'defaultCampaign',
    'defaultTheme',
    'lockedReason',
    'newVault',
    'sep',
    'switchable',
    'themes',
    'via',
  ]);
  assert.equal(res.json.campaign, 'beta');
  assert.equal(res.json.configPath, fx.configPath);
  assert.equal(res.json.configSha256, sha256(fs.readFileSync(fx.configPath)));
  assert.deepEqual(res.json.campaigns, ['alpha', 'beta', 'gamma']);
  assert.equal(res.json.defaultCampaign, 'alpha');
  assert.equal(res.json.switchable, true);
  assert.equal(res.json.lockedReason, null);
  assert.equal(res.json.via, 'loopback');
  assert.equal(res.json.sep, path.sep);
  assert.equal(res.json.defaultTheme, 'gloam');
  assert.equal(res.json.newVault.available, true);
});

test('state: a config that no longer parses is a 409 config-invalid with the loader message, and one that is gone says there is nothing to add to', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  fs.writeFileSync(fx.configPath, 'not = = toml');
  const bad = await get(h, '/api/campaigns/add/state');
  assert.equal(bad.status, 409);
  assert.equal(bad.json.error, 'config-invalid');
  assert.equal(typeof bad.json.message, 'string');
  fs.rmSync(fx.configPath);
  const gone = await get(h, '/api/campaigns/add/state');
  assert.equal(gone.status, 409);
  assert.equal(gone.json.error, 'config-invalid');
  assert.equal(gone.json.message, `There is no settings file at ${fx.configPath}, so there is nothing to add a campaign to.`);
});

test('state under --vault: switchable is false with the stated reason, and an add still works', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath, vault: fx.vaults.alpha }, 'alpha');
  const state = await stateOf(h);
  assert.equal(state.switchable, false);
  assert.equal(
    state.lockedReason,
    'This panel was started with --vault, which changes the folder for "alpha" only, so switching campaigns is off. Restart without --vault to switch.',
  );
  const res = await post(h, '/api/campaigns/add', { name: 'y', vault: fx.vaultNew, output: fx.outNew, configSha256: state.configSha256 }, { campaign: 'alpha' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.switchable, false);
  assert.equal(res.json.lockedReason, state.lockedReason);
});

// --- the checks ----------------------------------------------------------------------------------------------------

test('check parity: a setup-mode panel and a normal panel answer deep-equal bodies for non-clashing inputs on all eight fields', async (t) => {
  const fx = fixture(t);
  const normal = await startPanel(t, { config: fx.configPath }, 'alpha');
  normal.ctx.campaigns.probeDeps = { templateDir: FIXTURE_DIR };
  const other = scratchRoot(t);
  const setup = await startPanel(t, { config: configPathIn(other) });
  setup.ctx.setup.probeDeps = { templateDir: FIXTURE_DIR };
  const newTarget = path.join(fx.root, 'New Campaign');
  const table = [
    ['name', { value: 'fresh' }],
    ['name', { value: 'Not Valid' }],
    ['vault', { value: fx.vaultNew, name: 'fresh' }],
    ['vault', { value: path.join(fx.root, 'no-such-folder'), name: 'fresh' }],
    ['output', { value: fx.outNew, vault: fx.vaultNew, name: 'fresh' }],
    ['output', { value: '', vault: fx.vaultNew, name: 'fresh' }],
    ['title', { value: 'The Y Chronicles', vault: fx.vaultNew, name: 'fresh' }],
    ['theme', { value: 'haze', vault: fx.vaultNew, name: 'fresh' }],
    ['newVault', { value: newTarget, name: 'fresh' }],
    ['newVault', { value: newTarget, name: 'fresh', commit: '1' }],
    ['system', { value: 'none' }],
    ['system', { value: 'nonesuch' }],
    ['starterTitle', { value: 'The Brass Lantern', name: 'fresh' }],
  ];
  for (const [field, params] of table) {
    const q = new URLSearchParams({ field, ...params });
    const a = await get(setup, `/api/setup/check?${q}`);
    const b = await get(normal, `/api/campaigns/add/check?${q}`);
    assert.equal(b.status, 200, `${field} ${JSON.stringify(params)}`);
    assert.deepEqual(b.json, a.json, `${field} ${JSON.stringify(params)}`);
  }
  assert.equal((await get(normal, checkUrl('nope'))).status, 400);
  assert.deepEqual((await get(normal, checkUrl('nope'))).json, { error: 'invalid', message: 'field must be one of name, vault, output, title, theme, newVault, system, starterTitle' });
  assert.deepEqual((await get(setup, '/api/setup/check?field=nope')).json, (await get(normal, checkUrl('nope'))).json);
});

test('the clash overlay: a registered name, vault and output answer bad with the exact rule and the clash fact; a free one is untouched', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');

  const name = await get(h, checkUrl('name', { value: 'beta' }));
  assert.equal(name.json.state, 'bad');
  assert.equal(name.json.rule, 'campaign "beta" is already registered; choose another name');
  assert.deepEqual(name.json.facts.clash, { kind: 'name', campaign: 'beta' });

  const vault = await get(h, checkUrl('vault', { value: fx.vaults.beta, name: 'fresh' }));
  assert.equal(vault.json.state, 'bad');
  assert.equal(vault.json.rule, `${fx.vaults.beta} is already registered as campaign "beta"`);
  assert.deepEqual(vault.json.facts.clash, { kind: 'vault-equal', campaign: 'beta' });
  assert.equal(vault.json.facts.isVault, true, 'the underlying facts are kept');

  const theirs = path.join(fx.root, 'out-beta');
  const output = await get(h, checkUrl('output', { value: theirs, vault: fx.vaultNew, name: 'fresh' }));
  assert.equal(output.json.state, 'bad');
  assert.equal(output.json.rule, `${theirs} overlaps the output folder of campaign "beta" (${theirs}); each campaign needs its own output folder`);
  assert.deepEqual(output.json.facts.clash, { kind: 'output-overlap-output', campaign: 'beta' });

  const inside = path.join(fx.vaults.beta, 'site');
  const outVault = await get(h, checkUrl('output', { value: inside, vault: fx.vaultNew, name: 'fresh' }));
  assert.equal(outVault.json.state, 'bad');
  assert.equal(outVault.json.facts.clash.kind, 'output-in-vault');

  const free = await get(h, checkUrl('name', { value: 'fresh' }));
  assert.equal(free.json.state, 'ok');
  assert.equal('clash' in free.json.facts, false);

  fs.mkdirSync(path.join(fx.root, 'out-beta', 'nested-vault-target'), { recursive: true });
  const nv = await get(h, checkUrl('newVault', { value: path.join(theirs, 'nested-vault-target'), name: 'fresh' }));
  assert.equal(nv.json.state, 'bad');
  assert.equal(nv.json.facts.clash.kind, 'vault-in-output');
});

// --- the commit, on loopback -----------------------------------------------------------------------------------------

test('POST /api/campaigns/add on loopback: 200, audit lines request, campaign-add (with the typed path), response (affected y), the list shows y and a switch to y works', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const state = await stateOf(h);
  const res = await post(h, '/api/campaigns/add', { name: ' y ', vault: ` ${fx.vaultNew} `, output: fx.outNew, configSha256: state.configSha256 }, { campaign: 'alpha' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.created, ['css/', 'images/', 'pack.toml', 'vault.config.json']);
  assert.equal(res.json.isDefault, false);
  assert.equal(res.json.switchable, true);
  assert.equal(res.json.lockedReason, null);

  const lines = readAuditLines(fx).filter((l) => l.route === '/api/campaigns/add');
  assert.deepEqual(
    lines.map((l) => [l.event, l.via, l.campaign, l.path, l.affected]),
    [
      ['request', 'loopback', 'alpha', undefined, undefined],
      ['campaign-add', 'loopback', 'alpha', fx.vaultNew, undefined],
      ['response', 'loopback', 'alpha', undefined, 'y'],
    ],
  );
  assert.equal(h.ctx.campaign, 'alpha', 'adding never switches');

  const list = await get(h, '/api/campaigns');
  assert.deepEqual(list.json.campaigns.map((c) => c.name), ['alpha', 'beta', 'y']);
  assert.equal(list.json.campaigns.find((c) => c.name === 'alpha').isDefault, true);
  const sw = await post(h, '/api/campaigns/switch', { name: 'y' }, { campaign: 'alpha' });
  assert.equal(sw.status, 200, sw.text);
  assert.equal(h.ctx.campaign, 'y');
});

test('commit refusals: a clash is a 400 with the field and the rule and nothing is written; a bad body is a 400 before any campaign-add line', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const state = await stateOf(h);
  const before = treeSnapshot(fx.root);
  const clash = await post(h, '/api/campaigns/add', { name: 'beta', vault: fx.vaultNew, output: fx.outNew, configSha256: state.configSha256 }, { campaign: 'alpha' });
  assert.equal(clash.status, 400);
  assert.deepEqual(clash.json, { error: 'invalid', field: 'name', rule: 'campaign "beta" is already registered; choose another name' });
  const audit = readAuditLines(fx).filter((l) => l.route === '/api/campaigns/add');
  const afterClash = treeSnapshot(fx.root).filter((x) => !x.startsWith('cfg/panel'));
  assert.deepEqual(afterClash, before.filter((x) => !x.startsWith('cfg/panel')), 'a refusal writes nothing outside the audit log');
  assert.deepEqual(audit.map((l) => l.event), ['request', 'campaign-add', 'response']);

  const sha = state.configSha256;
  const bodies = [
    [{}, 'name must be text'],
    [{ name: 'y', vault: fx.vaultNew, output: fx.outNew }, 'configSha256 must be 64 lowercase hex characters'],
    [{ name: 'y', vault: fx.vaultNew, output: fx.outNew, configSha256: 'ABC' }, 'configSha256 must be 64 lowercase hex characters'],
    [{ name: 'y', vault: fx.vaultNew, output: fx.outNew, configSha256: sha, extra: 1 }, 'unknown field: extra'],
    [{ name: 'y', vault: fx.vaultNew, output: fx.outNew, configSha256: sha, newVault: 'yes' }, 'newVault must be true or false'],
  ];
  for (const [body, message] of bodies) {
    const res = await post(h, '/api/campaigns/add', body, { campaign: 'alpha' });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.json, { error: 'invalid', message }, JSON.stringify(body));
  }
  const notJson = await post(h, '/api/campaigns/add', 'not json', { campaign: 'alpha' });
  assert.equal(notJson.status, 400);
  assert.deepEqual(notJson.json, { error: 'invalid', message: 'the request body is not valid JSON' });
  const arr = await post(h, '/api/campaigns/add', '[]', { campaign: 'alpha' });
  assert.deepEqual(arr.json, { error: 'invalid', message: 'the request body must be a JSON object' });
  const lines = readAuditLines(fx).filter((l) => l.route === '/api/campaigns/add' && l.event === 'campaign-add');
  assert.equal(lines.length, 1, 'only the well-formed body above wrote a campaign-add line');
});

test('a `{}` body gives 400 with exactly two audit lines, the request and the response', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const res = await post(h, '/api/campaigns/add', {}, { campaign: 'alpha' });
  assert.equal(res.status, 400);
  const lines = readAuditLines(fx).filter((l) => l.route === '/api/campaigns/add');
  assert.deepEqual(lines.map((l) => [l.event, l.status]), [['request', undefined], ['response', 400]]);
});

test('busy: while the panel is busy with something else an add is a 409 busy and writes nothing', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const state = await stateOf(h);
  const before = fs.readFileSync(fx.configPath, 'utf8');
  h.ctx.busy = 'preview';
  const res = await post(h, '/api/campaigns/add', { name: 'y', vault: fx.vaultNew, output: fx.outNew, configSha256: state.configSha256 }, { campaign: 'alpha' });
  h.ctx.busy = null;
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'busy', busy: 'preview' });
  assert.equal(fs.readFileSync(fx.configPath, 'utf8'), before);
});

test('a stale tab: after a switch, an add carrying the old campaign header is a 409 campaign-changed and nothing is written', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const state = await stateOf(h);
  const sw = await post(h, '/api/campaigns/switch', { name: 'beta' }, { campaign: 'alpha' });
  assert.equal(sw.status, 200, sw.text);
  const before = fs.readFileSync(fx.configPath, 'utf8');
  const res = await post(h, '/api/campaigns/add', { name: 'y', vault: fx.vaultNew, output: fx.outNew, configSha256: state.configSha256 }, { campaign: 'alpha' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'campaign-changed');
  assert.equal(res.json.campaign, 'beta');
  assert.equal(res.json.message, 'This tab is out of date. Reload to continue.');
  assert.equal(fs.readFileSync(fx.configPath, 'utf8'), before);
  const ok = await post(h, '/api/campaigns/add', { name: 'y', vault: fx.vaultNew, output: fx.outNew, configSha256: state.configSha256 }, { campaign: 'beta' });
  assert.equal(ok.status, 200, ok.text);
});

test('a terminal `config add` between the state and the commit gives a 409 config-changed, and the terminal entry survives', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const state = await stateOf(h);
  const other = copySample(fx.root, 'vault-c', { withPack: true });
  const added = runConfigCommand({ config: fx.configPath, vault: other, out: path.join(fx.root, 'out-c') }, 'add', ['c']);
  assert.equal(added.exitCode, 0);
  const res = await post(h, '/api/campaigns/add', { name: 'y', vault: fx.vaultNew, output: fx.outNew, configSha256: state.configSha256 }, { campaign: 'alpha' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'config-changed', message: CONFIG_CHANGED });
  const text = fs.readFileSync(fx.configPath, 'utf8');
  assert.match(text, /^\[campaigns\.c\]$/m);
  assert.doesNotMatch(text, /campaigns\.y/);
  assert.equal(fs.existsSync(path.join(fx.vaultNew, '_meta', 'scriptorium')), false);
});

test('a new vault is added over the same route, and the new campaign is listed', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  h.ctx.campaigns.probeDeps = { templateDir: FIXTURE_DIR };
  const state = await stateOf(h);
  const target = path.join(fx.root, 'New Campaign');
  const res = await post(h, '/api/campaigns/add', { name: 'fresh', newVault: true, vault: target, output: fx.outNew, title: 'The Brass Lantern', system: 'none', configSha256: state.configSha256 }, { campaign: 'alpha' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.vaultRoot, target);
  assert.ok(fs.existsSync(path.join(target, '_meta', 'vault-config.md')));
  assert.deepEqual((await get(h, '/api/campaigns')).json.campaigns.map((c) => c.name), ['alpha', 'beta', 'fresh']);
});

// --- remote access -----------------------------------------------------------------------------------------------------

const linuxOnly = { skip: process.platform !== 'linux' ? 'Linux accepts every 127/8 address; other platforms do not' : false };
const PASSWORD = 'correct horse battery';
const ADMIN_HOST = 'scriptorium.home.arpa';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
// Fixed ports for the one remote-access panel per test in this file: 9466 admin, 9467 preview.
const REMOTE_PORTS = [9466, 9467];

async function startRemote(t, { probe } = {}) {
  const fx = fixture(t);
  fs.appendFileSync(fx.configPath, `\n[remote]\nmode = "proxy"\nport = ${REMOTE_PORTS[0]}\npreview_port = ${REMOTE_PORTS[1]}\nadmin_url = "${ADMIN_ORIGIN}"\npreview_url = "https://preview.scriptorium.home.arpa"\nbind = "127.0.0.1"\ntrusted_proxies = ["127.0.0.2"]\n`);
  pwWrite.writePasswordRecord(path.join(fx.panelDir, 'password.json'), await pw.hashPassword(PASSWORD));
  const started = await startAdminPanel({ admin: true, config: fx.configPath }, 'alpha', { emit() {} });
  assert.equal(started.ok, true, JSON.stringify(started));
  t.after(() => started.stop());
  const ctx = started.ctx;
  if (probe) ctx.campaigns.probeDeps = probe;
  const proxy = await createTestProxy({ upstreamPort: ctx.adminPort, localAddress: '127.0.0.2', clientAddress: '198.51.100.77' });
  t.after(() => proxy.close());

  const send = (method, pathname, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method,
          path: pathname,
          setHost: false,
          agent: false,
          headers: { Host: ADMIN_HOST, ...(method === 'POST' ? { Origin: ADMIN_ORIGIN, 'Content-Type': 'application/json' } : {}), ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}), ...headers },
        },
        (res) => {
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

/** A probe seam that records every stat and tells the test how many audit lines of one event existed at that moment. */
function recordingProbe(fx, event) {
  const calls = [];
  const real = fs.promises;
  return {
    calls,
    fsp: {
      stat: (p) => {
        calls.push({ path: p, lines: readAuditLines(fx).filter((l) => l.event === event).length });
        return real.stat(p);
      },
      readdir: real.readdir,
    },
  };
}

test('remote: the add page is served through the proxy, and the state says via remote', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const page = await env.send('GET', '/campaigns/add');
  assert.equal(page.status, 200);
  assert.deepEqual(page.body, fs.readFileSync(path.join(ROOT, 'assets', 'admin', 'setup.html')));
  assert.equal(page.headers['content-security-policy'], ADMIN_CSP);
  const state = await env.send('GET', '/api/campaigns/add/state');
  assert.equal(state.status, 200, state.text);
  assert.equal(state.json.via, 'remote');
});

test('remote: a typed path is deferred while typing (no stat, no audit line), and with commit=1 exactly one campaign-check line is written before the stat', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const rec = recordingProbe(env.fx, 'campaign-check');
  env.ctx.campaigns.probeDeps = { fsp: rec.fsp };

  for (const [field, extra] of [['vault', {}], ['newVault', {}], ['output', { vault: env.fx.vaultNew }]]) {
    const res = await env.send('GET', checkUrl(field, { value: env.fx.vaultNew, name: 'fresh', ...extra }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.state, 'deferred', field);
  }
  assert.deepEqual(rec.calls, [], 'no stat while typing');
  assert.deepEqual(readAuditLines(env.fx).filter((l) => l.event === 'campaign-check'), [], 'no audit line while typing');

  const committed = await env.send('GET', checkUrl('vault', { value: env.fx.vaultNew, name: 'fresh', commit: '1' }));
  assert.equal(committed.status, 200, committed.text);
  assert.equal(committed.json.state, 'ok');
  const checkLines = readAuditLines(env.fx).filter((l) => l.event === 'campaign-check');
  assert.equal(checkLines.length, 1);
  assert.deepEqual(
    [checkLines[0].method, checkLines[0].route, checkLines[0].via, checkLines[0].from, checkLines[0].campaign, checkLines[0].path],
    ['GET', '/api/campaigns/add/check', 'remote', '198.51.100.77', 'alpha', env.fx.vaultNew],
  );
  assert.ok(rec.calls.length > 0, 'the committed check did probe');
  for (const c of rec.calls) assert.equal(c.lines, 1, 'the campaign-check line existed before every stat');
});

test('remote: a name check and the clash overlay need no audit line and are never deferred', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const res = await env.send('GET', checkUrl('name', { value: 'beta' }));
  assert.equal(res.json.state, 'bad');
  assert.equal(res.json.rule, 'campaign "beta" is already registered; choose another name');
  assert.deepEqual(readAuditLines(env.fx).filter((l) => l.event === 'campaign-check'), []);
  const theme = await env.send('GET', checkUrl('theme', { value: 'haze', vault: env.fx.vaultNew, name: 'fresh' }));
  assert.equal(theme.json.state, 'ok');
});

test('remote: when the campaign-check line cannot be written the answer is 503 and nothing is probed', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const rec = recordingProbe(env.fx, 'campaign-check');
  env.ctx.campaigns.probeDeps = { fsp: rec.fsp };
  const real = env.ctx.audit.append;
  env.ctx.audit.append = (entry) => {
    if (entry.event === 'campaign-check') throw new Error('disk full');
    return real(entry);
  };
  const res = await env.send('GET', checkUrl('vault', { value: env.fx.vaultNew, name: 'fresh', commit: '1' }));
  assert.equal(res.status, 503, res.text);
  assert.equal(res.json.error, 'audit');
  assert.deepEqual(rec.calls, []);
});

test('loopback: a committed path check writes no audit line and probes at once', async (t) => {
  const fx = fixture(t);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const rec = recordingProbe(fx, 'campaign-check');
  h.ctx.campaigns.probeDeps = { fsp: rec.fsp };
  const res = await get(h, checkUrl('vault', { value: fx.vaultNew, name: 'fresh' }));
  assert.equal(res.json.state, 'ok');
  assert.ok(rec.calls.length > 0, 'probed without waiting for a commit');
  const res2 = await get(h, checkUrl('vault', { value: fx.vaultNew, name: 'fresh', commit: '1' }));
  assert.equal(res2.json.state, 'ok');
  assert.deepEqual(readAuditLines(fx).filter((l) => l.event === 'campaign-check'), []);
});

test('remote commit: audit lines request, campaign-add (with the typed vault path), response (affected y, campaign unchanged); the list shows y and a switch to y works', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const state = (await env.send('GET', '/api/campaigns/add/state')).json;
  const res = await env.send('POST', '/api/campaigns/add', { name: 'y', vault: env.fx.vaultNew, output: env.fx.outNew, configSha256: state.configSha256 }, { 'X-Scriptorium-Campaign': 'alpha' });
  assert.equal(res.status, 200, res.text);
  const lines = readAuditLines(env.fx).filter((l) => l.route === '/api/campaigns/add');
  assert.deepEqual(
    lines.map((l) => [l.event, l.via, l.from, l.campaign, l.path, l.affected]),
    [
      ['request', 'remote', '198.51.100.77', 'alpha', undefined, undefined],
      ['campaign-add', 'remote', '198.51.100.77', 'alpha', env.fx.vaultNew, undefined],
      ['response', 'remote', '198.51.100.77', 'alpha', undefined, 'y'],
    ],
  );
  const list = await env.send('GET', '/api/campaigns');
  assert.deepEqual(list.json.campaigns.map((c) => c.name), ['alpha', 'beta', 'y']);
  const sw = await env.send('POST', '/api/campaigns/switch', { name: 'y' }, { 'X-Scriptorium-Campaign': 'alpha' });
  assert.equal(sw.status, 200, sw.text);
});

test('remote commit: when only the campaign-add line cannot be written the answer is 503 and the config and the tree are unchanged', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const state = (await env.send('GET', '/api/campaigns/add/state')).json;
  const real = env.ctx.audit.append;
  env.ctx.audit.append = (entry) => {
    if (entry.event === 'campaign-add') throw new Error('disk full');
    return real(entry);
  };
  const cfgBefore = fs.readFileSync(env.fx.configPath, 'utf8');
  const treeBefore = treeSnapshot(env.fx.root).filter((x) => !x.startsWith('cfg/panel'));
  const res = await env.send('POST', '/api/campaigns/add', { name: 'y', vault: env.fx.vaultNew, output: env.fx.outNew, configSha256: state.configSha256 }, { 'X-Scriptorium-Campaign': 'alpha' });
  assert.equal(res.status, 503, res.text);
  assert.equal(res.json.error, 'audit');
  assert.equal(fs.readFileSync(env.fx.configPath, 'utf8'), cfgBefore);
  assert.deepEqual(treeSnapshot(env.fx.root).filter((x) => !x.startsWith('cfg/panel')), treeBefore);
});

test('remote commit: a `{}` body is a 400 with exactly two audit lines, and a terminal change is a 409 config-changed', linuxOnly, async (t) => {
  const env = await startRemote(t);
  const empty = await env.send('POST', '/api/campaigns/add', {}, { 'X-Scriptorium-Campaign': 'alpha' });
  assert.equal(empty.status, 400);
  const lines = readAuditLines(env.fx).filter((l) => l.route === '/api/campaigns/add');
  assert.deepEqual(lines.map((l) => l.event), ['request', 'response']);
  const state = (await env.send('GET', '/api/campaigns/add/state')).json;
  const other = copySample(env.fx.root, 'vault-c', { withPack: true });
  runConfigCommand({ config: env.fx.configPath, vault: other, out: path.join(env.fx.root, 'out-c') }, 'add', ['c']);
  const res = await env.send('POST', '/api/campaigns/add', { name: 'y', vault: env.fx.vaultNew, output: env.fx.outNew, configSha256: state.configSha256 }, { 'X-Scriptorium-Campaign': 'alpha' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'config-changed');
});
