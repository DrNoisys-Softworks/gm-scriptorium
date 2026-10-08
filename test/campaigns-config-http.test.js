'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const welcome = require('../src/admin/welcome');
const { runConfigCommand } = require('../src/cli/config');
const { makeCampaigns, startPanel, get, post } = require('./helpers/campaigns-panel');

/*
 * ADR 0050 section 5: set default and remove over real sockets. The oracle for the config bytes is
 * the CLI (runConfigCommand) run on a twin config, never the panel's own writer. The race tests
 * change the file from "the terminal" (the CLI) after the page loaded.
 */

const CONFIG_CHANGED = { error: 'config-changed', message: 'Your settings changed outside the panel. Reload and try again.' };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function twin(fx) {
  const dir = path.join(fx.root, 'cfg-twin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  fs.copyFileSync(fx.configPath, file);
  return file;
}

async function loadSha(h) {
  const res = await get(h, '/api/campaigns');
  assert.equal(res.status, 200, res.text);
  return res.json.configSha256;
}

function readAuditLines(fx) {
  const file = path.join(fx.panelDir, 'audit.log');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('set default: the HTTP result is byte-equal to `config set-default` on a twin, and the new sha is the file\'s', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta', 'gamma']);
  const cli = twin(fx);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const sha = await loadSha(h);

  const res = await post(h, '/api/campaigns/default', { name: 'gamma', configSha256: sha }, { campaign: 'alpha' });
  assert.equal(res.status, 200, res.text);
  runConfigCommand({ config: cli }, 'set-default', ['gamma']);

  const bytes = fs.readFileSync(fx.configPath);
  assert.deepEqual(bytes, fs.readFileSync(cli));
  assert.deepEqual(res.json, { ok: true, configSha256: sha256(bytes) });
  assert.equal(h.ctx.campaign, 'alpha', 'set default does not switch');
  assert.equal((await loadSha(h)), sha256(bytes));
});

test('remove: the HTTP result is byte-equal to `config remove` on a twin, the vault stays, and welcome.json loses the name', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta', 'gamma']);
  const cli = twin(fx);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  welcome.addPending(fx.panelDir, 'beta');
  welcome.addPending(fx.panelDir, 'gamma');
  const vaultTree = fs.readdirSync(fx.vaults.beta).sort();

  const res = await post(h, '/api/campaigns/remove', { name: 'beta', configSha256: await loadSha(h) }, { campaign: 'alpha' });
  assert.equal(res.status, 200, res.text);
  runConfigCommand({ config: cli }, 'remove', ['beta']);

  assert.deepEqual(fs.readFileSync(fx.configPath), fs.readFileSync(cli));
  assert.deepEqual(res.json, { ok: true, configSha256: sha256(fs.readFileSync(fx.configPath)) });
  assert.deepEqual(fs.readdirSync(fx.vaults.beta).sort(), vaultTree, 'nothing in the vault was touched');
  assert.deepEqual(welcome.readPending(fx.panelDir), ['gamma']);
  const list = await get(h, '/api/campaigns');
  assert.deepEqual(list.json.campaigns.map((c) => c.name), ['alpha', 'gamma']);
});

test('remove the default campaign: default_campaign goes, byte-equal to the CLI', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta'], { defaultName: 'beta' });
  const cli = twin(fx);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const res = await post(h, '/api/campaigns/remove', { name: 'beta', configSha256: await loadSha(h) }, { campaign: 'alpha' });
  assert.equal(res.status, 200, res.text);
  runConfigCommand({ config: cli }, 'remove', ['beta']);
  assert.deepEqual(fs.readFileSync(fx.configPath), fs.readFileSync(cli));
  assert.equal(fs.readFileSync(fx.configPath, 'utf8').includes('default_campaign'), false);
});

test('removing the active campaign is refused 409 active and the file is unchanged', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const before = fs.readFileSync(fx.configPath);
  const res = await post(h, '/api/campaigns/remove', { name: 'alpha', configSha256: await loadSha(h) }, { campaign: 'alpha' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'active', message: 'Switch to another campaign first.' });
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
  assert.equal(h.ctx.campaign, 'alpha');
});

test('the terminal-change race: a `config add` after the page loaded makes set default and remove 409 config-changed, and the terminal\'s change survives', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const stale = await loadSha(h);

  runConfigCommand({ config: fx.configPath, vault: fx.vaults.beta, out: path.join(fx.root, 'out-c') }, 'add', ['terminal-added']);
  const afterTerminal = fs.readFileSync(fx.configPath);

  const def = await post(h, '/api/campaigns/default', { name: 'beta', configSha256: stale }, { campaign: 'alpha' });
  assert.equal(def.status, 409);
  assert.deepEqual(def.json, CONFIG_CHANGED);
  const rem = await post(h, '/api/campaigns/remove', { name: 'beta', configSha256: stale }, { campaign: 'alpha' });
  assert.equal(rem.status, 409);
  assert.deepEqual(rem.json, CONFIG_CHANGED);

  assert.deepEqual(fs.readFileSync(fx.configPath), afterTerminal);
  assert.match(afterTerminal.toString('utf8'), /terminal-added/);
});

test('split body: a config change while the request body is still arriving is caught (the sha is read after the last await)', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const sha = await loadSha(h);
  const bodyText = JSON.stringify({ name: 'beta', configSha256: sha });
  const half = Math.floor(bodyText.length / 2);

  const finished = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: h.port, method: 'POST', path: '/api/campaigns/default', headers: { Cookie: h.cookie, Origin: h.origin, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bodyText)), 'X-Scriptorium-Campaign': 'alpha' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(bodyText.slice(0, half));
    const started = Date.now();
    const poll = () => {
      if (h.ctx.campaigns.inFlight === 1) {
        runConfigCommand({ config: fx.configPath, vault: fx.vaults.beta, out: path.join(fx.root, 'out-c') }, 'add', ['changed-meanwhile']);
        req.end(bodyText.slice(half));
      } else if (Date.now() - started > 5000) {
        reject(new Error('the request never reached the router'));
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
  assert.equal(finished.status, 409, finished.text);
  assert.deepEqual(JSON.parse(finished.text), CONFIG_CHANGED);
  assert.match(fs.readFileSync(fx.configPath, 'utf8'), /changed-meanwhile/);
  assert.equal(fs.readFileSync(fx.configPath, 'utf8').includes('default_campaign = "beta"'), false);
});

test('refusals: unknown campaign, bad sha and bad bodies write nothing', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const before = fs.readFileSync(fx.configPath);
  const sha = await loadSha(h);

  const unknown = await post(h, '/api/campaigns/default', { name: 'ghost', configSha256: sha }, { campaign: 'alpha' });
  assert.equal(unknown.status, 409);
  assert.deepEqual(unknown.json, { error: 'unknown-campaign', message: 'no campaign named "ghost"' });
  const unknownRemove = await post(h, '/api/campaigns/remove', { name: 'ghost', configSha256: sha }, { campaign: 'alpha' });
  assert.deepEqual(unknownRemove.json, { error: 'unknown-campaign', message: 'no campaign named "ghost" to remove' });

  for (const body of [{ name: 'beta' }, { name: 'beta', configSha256: 'ABC' }, { name: 'beta', configSha256: sha.toUpperCase() }, { name: 5, configSha256: sha }, { name: 'beta', configSha256: sha, extra: 1 }, {}]) {
    for (const route of ['default', 'remove']) {
      const res = await post(h, `/api/campaigns/${route}`, body, { campaign: 'alpha' });
      assert.equal(res.status, 400, `${route} ${JSON.stringify(body)}`);
      assert.equal(res.json.error, 'invalid');
    }
  }
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
});

test('a config that was broken outside the panel answers 409 config-invalid and is not written', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const broken = 'config_version = [[[';
  fs.writeFileSync(fx.configPath, broken);
  const res = await post(h, '/api/campaigns/default', { name: 'beta', configSha256: sha256(Buffer.from(broken)) }, { campaign: 'alpha' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'config-invalid');
  assert.equal(fs.readFileSync(fx.configPath, 'utf8'), broken);
});

test('a disk failure while writing answers 503 io and leaves the old file whole', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const before = fs.readFileSync(fx.configPath);
  const sha = await loadSha(h);
  const original = fs.writeSync;
  fs.writeSync = () => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  };
  let res;
  try {
    res = await post(h, '/api/campaigns/default', { name: 'beta', configSha256: sha }, { campaign: 'alpha' });
  } finally {
    fs.writeSync = original;
  }
  assert.equal(res.status, 503, res.text);
  assert.deepEqual(res.json, { error: 'io', message: 'disk full' });
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
  assert.deepEqual(fs.readdirSync(path.dirname(fx.configPath)).filter((n) => n.includes('scriptorium-tmp')), []);
  assert.equal(h.ctx.busy, null);
});

test('set default and remove run under the exclusive lock: a busy context answers 409 busy and writes nothing', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const before = fs.readFileSync(fx.configPath);
  const sha = await loadSha(h);
  h.ctx.busy = 'build';
  const def = await post(h, '/api/campaigns/default', { name: 'beta', configSha256: sha }, { campaign: 'alpha' });
  const rem = await post(h, '/api/campaigns/remove', { name: 'beta', configSha256: sha }, { campaign: 'alpha' });
  h.ctx.busy = null;
  for (const res of [def, rem]) {
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'busy', busy: 'build' });
  }
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
});

test('the audit response line carries the affected campaign name and the request line does not; a plain refusal carries none', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath }, 'alpha');
  const sha = await loadSha(h);
  await post(h, '/api/campaigns/default', { name: 'beta', configSha256: '0'.repeat(64) }, { campaign: 'alpha' });
  const ok = await post(h, '/api/campaigns/default', { name: 'beta', configSha256: sha }, { campaign: 'alpha' });
  assert.equal(ok.status, 200);
  const lines = readAuditLines(fx).filter((l) => l.route === '/api/campaigns/default');
  assert.deepEqual(
    lines.map((l) => [l.event, l.status, l.affected]),
    [['request', undefined, undefined], ['response', 409, undefined], ['request', undefined, undefined], ['response', 200, 'beta']],
  );
});

test('started with --vault, set default and remove stay available', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startPanel(t, { config: fx.configPath, vault: fx.vaults.alpha }, 'alpha');
  const def = await post(h, '/api/campaigns/default', { name: 'beta', configSha256: await loadSha(h) }, { campaign: 'alpha' });
  assert.equal(def.status, 200, def.text);
  const rem = await post(h, '/api/campaigns/remove', { name: 'beta', configSha256: await loadSha(h) }, { campaign: 'alpha' });
  assert.equal(rem.status, 200, rem.text);
});
