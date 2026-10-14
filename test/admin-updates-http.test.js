'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const { makeCampaigns, get, post } = require('./helpers/campaigns-panel');
const { scratchRoot, configPathIn } = require('./helpers/setup-fixtures');
const { startAdminPanel } = require('../src/cli/serve-admin');
const { startLocalListener } = require('../src/serve/server');
const { readState } = require('../src/admin/updatenotice');

/*
 * The panel's update notice over real sockets and in process (docs/decisions/0028-installer-and-first-run.md,
 * addendum "The update notice"): the three routes, the timing of the first check, and the
 * packaged/setup/off/unreadable gates. The check is always an injected stand-in, so nothing here
 * reaches a network. Expected values are written here, not read back from the code under test.
 */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const TAG_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v1.0.1';
const AVAILABLE = { state: 'available', tag: 'v1.0.1', prerelease: false, notesUrl: TAG_URL };
const CONFIG_CHANGED = { error: 'config-changed', message: 'Your settings changed outside the panel. Reload and try again.' };

/** Lets the panel's setImmediate start, and the check promise chain behind it, run to the end. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A check stand-in that records its calls. `reply` is a value, an Error, a function, or 'never'. */
function stub(reply) {
  const calls = [];
  const check = (args) => {
    calls.push({ ...args });
    if (reply === 'never') return new Promise(() => {});
    if (typeof reply === 'function') return reply(args);
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply);
  };
  check.calls = calls;
  return check;
}

/** Set when a panel failed to come up within its bound, so every later test fails at once instead of waiting again. */
let panelHung = false;
const START_BOUND_MS = 5000;

async function startWith(t, flags, updateDeps, emit = () => {}) {
  assert.equal(panelHung, false, 'an earlier panel never came up (something awaits the update check), so this test did not start one');
  const handles = [];
  const started = startAdminPanel({ admin: true, ...flags }, undefined, {
    emit,
    startLocalListener: async (...a) => {
      const h = await startLocalListener(...a);
      handles.push(h);
      return h;
    },
    startPanelListener: async () => {
      throw new Error('no remote listener expected');
    },
    updateDeps,
  });
  let bound;
  const result = await Promise.race([
    started,
    new Promise((resolve) => {
      bound = setTimeout(() => resolve(null), START_BOUND_MS);
    }),
  ]).finally(() => clearTimeout(bound));
  if (result === null) {
    panelHung = true;
    await Promise.all(handles.map((h) => h.close()));
    assert.fail(`startAdminPanel did not resolve within ${START_BOUND_MS} ms: something awaits the update check`);
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await result.stop();
  };
  t.after(stop);
  const port = result.ctx.adminPort;
  return { ctx: result.ctx, port, stop, cookie: `scriptorium_admin_${port}=${result.token}`, origin: `http://127.0.0.1:${port}` };
}

/** A config with `[update]` text appended to the campaigns the helper writes. */
function withUpdateTable(fx, text) {
  if (text.startsWith('update =')) {
    // A top-level key has to come before the first table.
    const bytes = fs.readFileSync(fx.configPath, 'utf8');
    fs.writeFileSync(fx.configPath, bytes.replace('[campaigns', `${text}\n\n[campaigns`));
    return;
  }
  fs.appendFileSync(fx.configPath, `\n${text}\n`);
}

test('startAdminPanel resolves while the check never settles, and the check is first called only after it resolved', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const check = stub('never');
  let resolvedAt = null;
  let firstCallAt = null;
  let tick = 0;
  const wrapped = (args) => {
    firstCallAt = firstCallAt === null ? ++tick : firstCallAt;
    return check(args);
  };
  // If the panel never resolves, its listeners are closed before the assertion fails, so the run ends and the message is reported.
  const handles = [];
  const started = startAdminPanel({ admin: true, config: fx.configPath }, undefined, {
    emit() {},
    startLocalListener: async (...a) => {
      const h = await startLocalListener(...a);
      handles.push(h);
      return h;
    },
    startPanelListener: async () => {
      throw new Error('none');
    },
    updateDeps: { isPkg: true, check: wrapped, currentVersion: '1.0.0' },
  });
  let bound;
  const result = await Promise.race([
    started,
    new Promise((resolve) => {
      bound = setTimeout(() => resolve('timeout'), 5000);
    }),
  ]).finally(() => clearTimeout(bound));
  if (result === 'timeout') {
    panelHung = true;
    await Promise.all(handles.map((h) => h.close()));
  }
  assert.notEqual(result, 'timeout', 'startAdminPanel did not resolve within 5 s while the check never settles: something awaits the check');
  resolvedAt = ++tick;
  t.after(() => result.stop());
  assert.equal(result.ok, true);
  assert.equal(check.calls.length, 0, 'not called by the time startAdminPanel returned');
  await settle();
  assert.equal(check.calls.length, 1);
  assert.ok(firstCallAt > resolvedAt, 'the first call came after startAdminPanel resolved');
});


// ---- the three routes ---------------------------------------------------------------------------

test('GET /api/update: the snapshot shape, plus the config path and the file\'s sha256', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const check = stub(AVAILABLE);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check, currentVersion: '1.0.0' });
  await settle();
  const res = await get(h, '/api/update');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, {
    setting: 'on',
    channel: 'stable',
    channelSaved: false,
    defaultChannel: 'stable',
    prereleaseBuild: false,
    state: 'available',
    current: '1.0.0',
    latest: '1.0.1',
    latestTag: 'v1.0.1',
    beta: false,
    notesUrl: TAG_URL,
    dismissed: false,
    lastSuccessMs: res.json.lastSuccessMs,
    configPath: fx.configPath,
    configSha256: sha256(fs.readFileSync(fx.configPath)),
  });
  assert.equal(Number.isSafeInteger(res.json.lastSuccessMs), true);
});

test('GET /api/update needs a signed-in session', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: false });
  const res = await get({ ...h, cookie: 'scriptorium_admin_1=nope' }, '/api/update');
  assert.notEqual(res.status, 200);
});

test('dismiss: the wrong version is 400, the right one is 200 and survives in update-check.json', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check: stub(AVAILABLE), currentVersion: '1.0.0' });
  await settle();
  for (const bad of [{ version: 'v9.9.9' }, { version: 5 }, {}, { version: 'v1.0.1', extra: 1 }, []]) {
    const res = await post(h, '/api/update/dismiss', bad, { campaign: 'alpha' });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.json.error, 'invalid');
  }
  assert.equal(readState(fx.panelDir).dismissed, null);
  const ok = await post(h, '/api/update/dismiss', { version: 'v1.0.1' }, { campaign: 'alpha' });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { ok: true });
  assert.equal(readState(fx.panelDir).dismissed, 'v1.0.1');
  assert.equal((await get(h, '/api/update')).json.dismissed, true);
});

test('dismiss with nothing being shown is 400', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: false });
  const res = await post(h, '/api/update/dismiss', { version: 'v1.0.1' }, { campaign: 'alpha' });
  assert.equal(res.status, 400);
});

test('dismiss: a body that is not JSON is 400 and one over the cap is 413', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: false });
  assert.equal((await post(h, '/api/update/dismiss', 'nope', { campaign: 'alpha' })).status, 400);
  assert.equal((await post(h, '/api/update/dismiss', JSON.stringify({ version: 'x'.repeat(200000) }), { campaign: 'alpha' })).status, 413);
});

test('setting: a changed sha is 409 config-changed and the file is untouched', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: false });
  const before = fs.readFileSync(fx.configPath);
  const res = await post(h, '/api/update/setting', { check: false, configSha256: '0'.repeat(64) }, { campaign: 'alpha' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, CONFIG_CHANGED);
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
});

test('setting: a bad body is 400 (extra key, both keys, wrong type, bad sha, bad channel)', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: false });
  const sha = sha256(fs.readFileSync(fx.configPath));
  const bad = [
    {},
    { check: false },
    { configSha256: sha },
    { check: false, configSha256: sha, extra: 1 },
    { check: false, channel: 'beta', configSha256: sha },
    { check: 'false', configSha256: sha },
    { check: 1, configSha256: sha },
    { channel: 'Beta', configSha256: sha },
    { channel: 'nightly', configSha256: sha },
    { check: false, configSha256: sha.toUpperCase() },
    { check: false, configSha256: 'abc' },
    [],
  ];
  const before = fs.readFileSync(fx.configPath);
  for (const b of bad) {
    const res = await post(h, '/api/update/setting', b, { campaign: 'alpha' });
    assert.equal(res.status, 400, JSON.stringify(b));
    assert.equal(res.json.error, 'invalid');
  }
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
});

test('setting {check:false}: writes [update] check = false, keeps the campaigns, and stops a check in flight', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  let signal;
  const check = stub((args) => {
    signal = args.signal;
    return new Promise(() => {});
  });
  const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check, currentVersion: '1.0.0' });
  await settle();
  assert.equal(check.calls.length, 1);
  assert.equal(signal.aborted, false);
  assert.equal((await get(h, '/api/update')).json.state, 'checking');

  const sha = sha256(fs.readFileSync(fx.configPath));
  const res = await post(h, '/api/update/setting', { check: false, configSha256: sha }, { campaign: 'alpha' });
  assert.equal(res.status, 200, res.text);
  const bytes = fs.readFileSync(fx.configPath);
  assert.match(bytes.toString('utf8'), /^\[update\]\ncheck = false$/m);
  assert.match(bytes.toString('utf8'), /\[campaigns\.alpha\]/);
  assert.match(bytes.toString('utf8'), /\[campaigns\.beta\]/);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.configSha256, sha256(bytes));
  assert.equal(res.json.update.setting, 'off');
  assert.equal(res.json.update.state, 'off');
  assert.equal(signal.aborted, true, 'the check in flight was aborted');
  assert.equal((await get(h, '/api/update')).json.configSha256, sha256(bytes), 'the page can save again with the new sha');
});

test('setting {channel:"beta"}: writes channel = "beta" and asks for beta straight away', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const check = stub({ state: 'current' });
  const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check, currentVersion: '1.0.0' });
  await settle();
  assert.equal(check.calls.length, 1);
  assert.equal(check.calls[0].channel, 'stable');

  const sha = sha256(fs.readFileSync(fx.configPath));
  const res = await post(h, '/api/update/setting', { channel: 'beta', configSha256: sha }, { campaign: 'alpha' });
  assert.equal(res.status, 200, res.text);
  assert.match(fs.readFileSync(fx.configPath, 'utf8'), /^channel = "beta"$/m);
  assert.equal(res.json.update.channel, 'beta');
  assert.equal(res.json.update.channelSaved, true);
  await settle();
  assert.equal(check.calls.length, 2, 'one check for the change');
  assert.equal(check.calls[1].channel, 'beta');
});

test('setting: an [update] check that cannot be read is refused 409 config-invalid and the file is untouched', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  withUpdateTable(fx, '[update]\ncheck = "yes"');
  const check = stub(AVAILABLE);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check, currentVersion: '1.0.0' });
  await settle();
  assert.equal(check.calls.length, 0);
  const snap = (await get(h, '/api/update')).json;
  assert.equal(snap.setting, 'unreadable');
  assert.equal(snap.channel, null);
  const before = fs.readFileSync(fx.configPath);
  const res = await post(h, '/api/update/setting', { check: true, configSha256: snap.configSha256 }, { campaign: 'alpha' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'config-invalid');
  assert.match(res.json.message, /\[update\]/);
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
  assert.equal(check.calls.length, 0);
});

test('setting: the terminal changing the file after the page loaded is 409 and the terminal\'s change survives', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: false });
  const stale = (await get(h, '/api/update')).json.configSha256;
  withUpdateTable(fx, '# a hand edit');
  const after = fs.readFileSync(fx.configPath);
  const res = await post(h, '/api/update/setting', { check: false, configSha256: stale }, { campaign: 'alpha' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, CONFIG_CHANGED);
  assert.deepEqual(fs.readFileSync(fx.configPath), after);
});

test('setting: a stale campaign header is refused 409 campaign-changed and nothing is written', async (t) => {
  const fx = makeCampaigns(t, ['alpha', 'beta']);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: false });
  const sha = (await get(h, '/api/update')).json.configSha256;
  const before = fs.readFileSync(fx.configPath);
  const res = await post(h, '/api/update/setting', { check: false, configSha256: sha }, { campaign: 'not-this-one' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'campaign-changed');
  assert.deepEqual(fs.readFileSync(fx.configPath), before);
  const dismiss = await post(h, '/api/update/dismiss', { version: 'v1.0.1' }, { campaign: 'not-this-one' });
  assert.equal(dismiss.status, 409);
  assert.equal(dismiss.json.error, 'campaign-changed');
});

test('setting: while another write holds the panel it is 409 busy', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: false });
  const sha = (await get(h, '/api/update')).json.configSha256;
  h.ctx.busy = 'write';
  const res = await post(h, '/api/update/setting', { check: false, configSha256: sha }, { campaign: 'alpha' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'busy');
});

test('routes answer 409 while browser setup is active, and the notice never checks', async (t) => {
  const root = scratchRoot(t);
  const configPath = configPathIn(root);
  const check = stub(AVAILABLE);
  const h = await startWith(t, { config: configPath }, { isPkg: true, check, currentVersion: '1.0.0' });
  await settle();
  assert.equal((await get(h, '/api/update')).status, 409);
  assert.equal((await post(h, '/api/update/dismiss', { version: 'v1.0.1' })).status, 409);
  assert.equal((await post(h, '/api/update/setting', { check: false, configSha256: '0'.repeat(64) })).status, 409);
  assert.equal(check.calls.length, 0);
  assert.equal(fs.existsSync(configPath), false);
});

// ---- when a check may run ----------------------------------------------------------------------

test('not packaged: the check is never called', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const check = stub(AVAILABLE);
  await startWith(t, { config: fx.configPath }, { isPkg: false, check, currentVersion: '1.0.0' });
  await settle();
  assert.equal(check.calls.length, 0);
});

test('the default for isPkg is the real one: a source run under node never calls the check', async (t) => {
  assert.equal(typeof process.pkg, 'undefined');
  const fx = makeCampaigns(t, ['alpha']);
  const check = stub(AVAILABLE);
  await startWith(t, { config: fx.configPath }, { check, currentVersion: '1.0.0' });
  await settle();
  assert.equal(check.calls.length, 0);
});

test('[update] check = false: the check is never called', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  withUpdateTable(fx, '[update]\ncheck = false');
  const check = stub(AVAILABLE);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check, currentVersion: '1.0.0' });
  await settle();
  assert.equal(check.calls.length, 0);
  assert.equal((await get(h, '/api/update')).json.setting, 'off');
});

test('an [update] table that cannot be read: the check is never called', async (t) => {
  for (const text of ['[update]\ncheck = "yes"', '[update]\nchannel = "Beta"', 'update = 5']) {
    const fx = makeCampaigns(t, ['alpha']);
    withUpdateTable(fx, text);
    const check = stub(AVAILABLE);
    const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check, currentVersion: '1.0.0' });
    await settle();
    assert.equal(check.calls.length, 0, text);
    assert.equal((await get(h, '/api/update')).json.setting, 'unreadable', text);
    await h.stop();
  }
});

test('a saved channel is used: [update] channel = "beta" asks for beta, even on a stable build', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  withUpdateTable(fx, '[update]\nchannel = "beta"');
  const check = stub({ state: 'current' });
  await startWith(t, { config: fx.configPath }, { isPkg: true, check, currentVersion: '1.0.0' });
  await settle();
  assert.equal(check.calls.length, 1);
  assert.equal(check.calls[0].channel, 'beta');
});

test('a prerelease build with nothing saved asks for beta', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const check = stub({ state: 'current' });
  await startWith(t, { config: fx.configPath }, { isPkg: true, check, currentVersion: '1.0.0-rc.2' });
  await settle();
  assert.equal(check.calls[0].channel, 'beta');
});

test('a fresh result in update-check.json is shown and not asked for again', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const first = stub(AVAILABLE);
  const a = await startWith(t, { config: fx.configPath }, { isPkg: true, check: first, currentVersion: '1.0.0' });
  await settle();
  assert.equal(first.calls.length, 1);
  await a.stop();
  const second = stub(AVAILABLE);
  const b = await startWith(t, { config: fx.configPath }, { isPkg: true, check: second, currentVersion: '1.0.0' });
  await settle();
  assert.equal(second.calls.length, 0);
  assert.equal((await get(b, '/api/update')).json.state, 'available');
});

// ---- timing and silence ------------------------------------------------------------------------

test('stop() aborts the signal passed to a check in flight', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const check = stub('never');
  const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check, currentVersion: '1.0.0' });
  await settle();
  assert.equal(check.calls[0].signal.aborted, false);
  await h.stop();
  assert.equal(check.calls[0].signal.aborted, true);
});

test('stop() before the first turn of the event loop means the check is never called', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const check = stub(AVAILABLE);
  const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check, currentVersion: '1.0.0' });
  await h.stop();
  await settle();
  assert.equal(check.calls.length, 0);
});

test('the emitted lines are identical whether the check finds an update, rejects, never settles, or is off', async (t) => {
  const run = async (reply, extra) => {
    const fx = makeCampaigns(t, ['alpha']);
    if (extra) withUpdateTable(fx, extra);
    const lines = [];
    const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check: stub(reply), currentVersion: '1.0.0' }, (l) => lines.push(l));
    await settle();
    await h.stop();
    return lines.map((l) => String(l).replace(/\/auth\?\S+/, '/auth').replace(/:\d+/g, ':P'));
  };
  const available = await run(AVAILABLE);
  assert.deepEqual(await run(new Error('down')), available);
  assert.deepEqual(await run('never'), available);
  assert.deepEqual(await run(AVAILABLE, '[update]\ncheck = false'), available);
});

test('nothing reaches console.log, console.warn or console.error while a check fails', async (t) => {
  const fx = makeCampaigns(t, ['alpha']);
  const written = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const realError = console.error;
  const h = await startWith(t, { config: fx.configPath }, { isPkg: true, check: stub(new Error('down')), currentVersion: '1.0.0' });
  console.log = console.warn = console.error = (...a) => written.push(a.join(' '));
  try {
    await settle();
    await h.stop();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    console.error = realError;
  }
  assert.deepEqual(written, []);
});
