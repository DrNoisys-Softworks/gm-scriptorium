'use strict';

/*
 * The launch-code exchange over real loopback sockets (port 0): the launcher file the code under test
 * writes, POST /auth/launch with Origin: null, the 200 interstitial with the session cookie, and the
 * containment of the code. runLaunch is driven end to end with an injected opener (the stub reads the
 * launcher file it is handed; it never opens a browser: openFile: below is a recorder).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { scratchRoot, copySample, configPathIn } = require('./helpers/setup-fixtures');

const { runLaunch } = require('../src/cli/launch');
const { startAdminPanel } = require('../src/cli/serve-admin');
const { writeConfigFile } = require('../src/config/write');

const ASSETS = path.join(__dirname, '..', 'assets', 'admin');
const LAUNCH_HTML = fs.readFileSync(path.join(ASSETS, 'launch.html'));
const LOCKED_LAUNCH_HTML = fs.readFileSync(path.join(ASSETS, 'launch-locked.html'));
const LOCKED_HTML = fs.readFileSync(path.join(ASSETS, 'locked.html'));
const FORM = 'application/x-www-form-urlencoded';

async function until(fn, what, ms = 8000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function request(port, { method = 'GET', pathname = '/', headers = {}, body, record } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined && h['Content-Length'] === undefined) h['Content-Length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const out = { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) };
        if (record) record.push(out);
        resolve(out);
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function codeOf(html) {
  return /name="code" value="([A-Za-z0-9_-]+)"/.exec(html)[1];
}

/** Runs launch mode in process with injected streams, signals and opener. */
async function launchPanel(t, { ttlMs, clock, withCampaign = false } = {}) {
  const root = scratchRoot(t);
  const configPath = configPathIn(root);
  if (withCampaign) {
    const vault = copySample(root, 'vault', { withPack: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeConfigFile(configPath, { config_version: 1, default_campaign: 'lease', campaigns: { lease: { vault, output: path.join(root, 'site') } } });
  }
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = (on) => {
    input.raw = on;
    return input;
  };
  const output = new PassThrough();
  output.isTTY = true;
  let text = '';
  output.on('data', (c) => {
    text += c;
  });
  const signals = new EventEmitter();
  const opened = [];
  const errors = [];
  let panel = null;
  const outCapture = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = function spyOut(chunk, ...rest) {
    outCapture.push(String(chunk));
    return realOut.call(this, chunk, ...rest);
  };
  process.stderr.write = function spyErr(chunk, ...rest) {
    outCapture.push(String(chunk));
    return realErr.call(this, chunk, ...rest);
  };
  const deps = {
    input,
    output,
    signals,
    platform: 'linux',
    env: { PATH: '/nonexistent' },
    openFile: async (opts) => {
      opened.push({ opts: JSON.parse(JSON.stringify(opts)), html: fs.existsSync(opts.target) ? fs.readFileSync(opts.target, 'utf8') : null, file: opts.target });
      return { outcome: 'exited', exitCode: 0, signal: null };
    },
    killAll: async () => {},
    startPanel: async (...args) => {
      panel = await startAdminPanel(...args);
      return panel;
    },
    version: '0.0.0-test',
    reportError: (err) => (errors.push(err), 1),
  };
  if (ttlMs !== undefined) deps.ttlMs = ttlMs;
  if (clock) deps.now = clock.now;
  const run = runLaunch({ config: configPath }, deps);
  let stopped = false;
  const stop = async () => {
    if (stopped) return run;
    stopped = true;
    signals.emit('SIGINT');
    return run;
  };
  t.after(async () => {
    await stop();
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  });
  await until(() => opened.length >= 1, 'the first open');
  const port = panel.ctx.adminPort;
  const panelDir = path.join(root, 'cfg', 'panel');
  return {
    root,
    configPath,
    panelDir,
    port,
    panel,
    input,
    output: () => text,
    opened,
    errors,
    signals,
    run,
    stop,
    outCapture,
    origin: `http://127.0.0.1:${port}`,
    launcherFile: () => opened[0].file,
    post: (code, { headers = {}, record, body } = {}) =>
      request(port, {
        method: 'POST',
        pathname: '/auth/launch',
        headers: { Origin: 'null', 'Content-Type': FORM, ...headers },
        body: body === undefined ? `code=${encodeURIComponent(code)}` : body,
        record,
      }),
    readAudit: () => {
      const f = path.join(panelDir, 'audit.log');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
}

test('success: 200 with the interstitial and the same session cookie /auth?token= sets; GET / with it is the panel', async (t) => {
  const h = await launchPanel(t);
  const code = codeOf(h.opened[0].html);
  const res = await h.post(code);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, LAUNCH_HTML);
  assert.match(res.headers['content-type'], /^text\/html/);
  const cookie = [].concat(res.headers['set-cookie'])[0];
  assert.match(cookie, new RegExp(`^scriptorium_admin_${h.port}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict$`));
  assert.equal(res.headers.location, undefined, 'a 200, never a redirect');

  const token = /=([A-Za-z0-9_-]{43});/.exec(cookie)[1];
  assert.equal(token, h.panel.token);
  const viaToken = await request(h.port, { pathname: `/auth?token=${h.panel.token}` });
  assert.equal(viaToken.status, 303, '/auth?token= is unchanged');
  assert.equal(viaToken.headers.location, '/');
  assert.equal([].concat(viaToken.headers['set-cookie'])[0], cookie, 'the same cookie');

  const root = await request(h.port, { pathname: '/', headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(root.status, 200);
  const sess = await request(h.port, { pathname: '/api/session', headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(JSON.parse(sess.body).launch, true);
});

test('a refusal is 403 with the locked page and no Set-Cookie: spent, unknown, malformed, wrong content type, oversized', async (t) => {
  const h = await launchPanel(t);
  const code = codeOf(h.opened[0].html);
  assert.equal((await h.post(code)).status, 200);
  const refused = [
    await h.post(code), // spent
    await h.post('A'.repeat(43)), // unknown
    await h.post(''), // empty
    await h.post('x'.repeat(300)), // oversized value
    await h.post(code, { body: 'other=1' }), // missing field
    await h.post(code, { body: `code=${code}`, headers: { 'Content-Type': 'application/json' } }), // wrong type, spent anyway
    await h.post(code, { body: `code=${code}`, headers: { 'Content-Type': 'text/plain' } }),
    await h.post(code, { body: `code=${code}`, headers: { 'Content-Type': 'multipart/form-data; boundary=x' } }),
    await h.post(code, { body: `code=${code}&pad=${'p'.repeat(3000)}` }), // over the 1024 byte cap
  ];
  for (const [i, res] of refused.entries()) {
    assert.equal(res.status, 403, `attempt ${i}`);
    assert.deepEqual(res.body, LOCKED_LAUNCH_HTML, `attempt ${i}`);
    assert.equal(res.headers['set-cookie'], undefined, `attempt ${i}: never a cookie`);
  }
});

test('a wrong content type does not spend a good code; a charset parameter on the right type is fine', async (t) => {
  const h = await launchPanel(t);
  const code = codeOf(h.opened[0].html);
  const wrong = await h.post(code, { body: `code=${code}`, headers: { 'Content-Type': 'application/json' } });
  assert.equal(wrong.status, 403);
  const right = await h.post(code, { headers: { 'Content-Type': `${FORM}; charset=UTF-8` } });
  assert.equal(right.status, 200);
});

test('an expired code is refused: usable at +59999 ms, dead at +60000 ms (injected clock)', async (t) => {
  const base = Date.now();
  const clock = { t: base, now: () => clock.t };
  const h = await launchPanel(t, { clock });
  const first = codeOf(h.opened[0].html);
  h.input.write('o'); // a second code, minted at the same instant
  await until(() => h.opened.length >= 2, 'the second open');
  const second = codeOf(h.opened[1].html);
  clock.t = base + 59999;
  assert.equal((await h.post(first)).status, 200, 'usable at +59999');
  clock.t = base + 60000;
  const dead = await h.post(second);
  assert.equal(dead.status, 403, 'dead at +60000');
  assert.equal(dead.headers['set-cookie'], undefined);
});

test('every attempt that reaches the handler is audited once, as a code sign-in, and the code is in no audit line', async (t) => {
  const h = await launchPanel(t);
  const code = codeOf(h.opened[0].html);
  const before = h.readAudit().length;
  await h.post(code);
  await h.post(code);
  await h.post('B'.repeat(43));
  const lines = h.readAudit().slice(before);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => [l.event, l.method, l.result, l.via]), [
    ['signin', 'code', 'ok', 'loopback'],
    ['signin', 'code', 'refused', 'loopback'],
    ['signin', 'code', 'refused', 'loopback'],
  ]);
  for (const l of lines) assert.equal(l.from, '127.0.0.1');
  assert.ok(!fs.readFileSync(path.join(h.panelDir, 'audit.log'), 'utf8').includes(code));
});

test('a foreign or missing Origin is refused at the gate even with a valid code, and the code is not spent', async (t) => {
  const h = await launchPanel(t);
  const code = codeOf(h.opened[0].html);
  for (const headers of [{ Origin: 'http://evil.example' }, { Origin: '' }]) {
    const res = await h.post(code, { headers });
    assert.equal(res.status, 403);
    assert.equal(res.body.toString(), 'refused: origin');
  }
  const noOrigin = await request(h.port, { method: 'POST', pathname: '/auth/launch', headers: { 'Content-Type': FORM }, body: `code=${code}` });
  assert.equal(noOrigin.body.toString(), 'refused: origin');
  assert.equal((await h.post(code)).status, 200, 'still unspent');
});

test('a GET to / or /setup without a session is the launch locked page in launch mode, and the plain locked page otherwise', async (t) => {
  const h = await launchPanel(t);
  for (const p of ['/', '/setup']) {
    const res = await request(h.port, { pathname: p });
    assert.equal(res.status, 403, p);
    assert.deepEqual(res.body, LOCKED_LAUNCH_HTML, p);
  }
  const bad = await request(h.port, { pathname: '/auth?token=nope' });
  assert.equal(bad.status, 403);
  assert.deepEqual(bad.body, LOCKED_HTML, '/auth keeps its own locked page');

  const plain = await startAdminPanel({ admin: true, config: configPathIn(scratchRoot(t)) }, undefined, { emit() {} });
  assert.equal(plain.ok, true);
  t.after(() => plain.stop());
  const res = await request(plain.ctx.adminPort, { pathname: '/' });
  assert.deepEqual(res.body, LOCKED_HTML);
});

test('a serve --admin process (no code store) has no Origin exception and no launch flag', async (t) => {
  const root = scratchRoot(t);
  const plain = await startAdminPanel({ admin: true, config: configPathIn(root) }, undefined, { emit() {} });
  assert.equal(plain.ok, true);
  t.after(() => plain.stop());
  const port = plain.ctx.adminPort;
  const res = await request(port, { method: 'POST', pathname: '/auth/launch', headers: { Origin: 'null', 'Content-Type': FORM }, body: `code=${'A'.repeat(43)}` });
  assert.equal(res.status, 403);
  assert.equal(res.body.toString(), 'refused: origin');
  // The right Origin reaches the handler, which has no store: the locked page, never a cookie.
  const exact = await request(port, { method: 'POST', pathname: '/auth/launch', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': FORM }, body: `code=${'A'.repeat(43)}` });
  assert.equal(exact.status, 409, 'in setup mode, without a store, the setup fence answers');
  const cookie = `scriptorium_admin_${port}=${plain.token}`;
  const sess = await request(port, { pathname: '/api/session', headers: { Cookie: cookie } });
  assert.equal(JSON.parse(sess.body).launch, false);
});

test('with a registered campaign the exchange lands on the normal panel', async (t) => {
  const h = await launchPanel(t, { withCampaign: true });
  const res = await h.post(codeOf(h.opened[0].html));
  assert.equal(res.status, 200);
  const cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
  const state = await request(h.port, { pathname: '/api/state', headers: { Cookie: cookie } });
  assert.equal(state.status, 200);
  const sess = JSON.parse((await request(h.port, { pathname: '/api/session', headers: { Cookie: cookie } })).body);
  assert.equal(sess.campaign, 'lease');
  assert.match(h.output(), /Campaign lease/);
});

// --- the launcher file's life -----------------------------------------------------------------------------------

test('the launcher file is 0600 in the panel folder, named by pid, and gone after the exchange', async (t) => {
  const h = await launchPanel(t);
  const file = h.launcherFile();
  assert.equal(path.dirname(file), h.panelDir);
  assert.equal(path.basename(file), `launch-${process.pid}.html`);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(h.panelDir).mode & 0o777, 0o700);
  }
  assert.equal(fs.existsSync(file), true);
  const res = await h.post(codeOf(h.opened[0].html));
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(file), false, 'removed on consumption');
});

test('the launcher file is gone once its code has expired (an injected short ttlMs), not before', async (t) => {
  const h = await launchPanel(t, { ttlMs: 150 });
  const file = h.launcherFile();
  assert.equal(fs.existsSync(file), true);
  await until(() => !fs.existsSync(file), 'the launcher to expire');
});

test('the launcher file is gone after stop, and a failed exchange does not remove it', async (t) => {
  const h = await launchPanel(t);
  const file = h.launcherFile();
  await h.post('C'.repeat(43));
  assert.equal(fs.existsSync(file), true, 'a refused attempt leaves the file');
  assert.equal(h.opened.length, 1);
  assert.equal(await h.stop(), 0);
  assert.equal(fs.existsSync(file), false, 'removed at stop');
});

test('O ten times: at most 4 codes outstanding, the newest file replaces the older, and each code works once', async (t) => {
  const h = await launchPanel(t);
  const codes = [codeOf(h.opened[0].html)];
  for (let i = 0; i < 10; i++) {
    h.input.write('O');
    await until(() => h.opened.length >= i + 2, `open ${i + 2}`);
    codes.push(codeOf(h.opened[i + 1].html));
  }
  assert.equal(new Set(codes).size, 11, 'every press mints a new code');
  assert.equal(new Set(h.opened.map((o) => o.file)).size, 1, 'one launcher file, replaced each time');
  const results = [];
  for (const c of codes) results.push((await h.post(c)).status);
  assert.deepEqual(results, [403, 403, 403, 403, 403, 403, 403, 200, 200, 200, 200], 'only the newest 4 survive');
  assert.deepEqual(
    (await Promise.all(codes.slice(-4).map((c) => h.post(c)))).map((r) => r.status),
    [403, 403, 403, 403],
    'and each worked once',
  );
});

// --- AC-05: containment -----------------------------------------------------------------------------------------

test('the code appears in the launcher file and nowhere else: opener argv, console, stdout, stderr, audit log, every response body and header', async (t) => {
  const h = await launchPanel(t);
  h.input.write('o');
  await until(() => h.opened.length >= 2, 'the second open');
  const codes = [codeOf(h.opened[0].html), codeOf(h.opened[1].html)];
  const seen = [];
  // The first code's file was replaced by the second: the file on disk holds the newest code once.
  const onDisk = fs.readFileSync(h.launcherFile(), 'utf8');
  assert.equal(onDisk.split(codes[1]).length - 1, 1, 'control: the grep finds the code where it belongs');
  // Exercise every kind of response.
  await h.post(codes[0], { record: seen });
  await h.post(codes[0], { record: seen });
  await h.post(codes[1], { record: seen });
  await h.post('Z'.repeat(43), { record: seen });
  const cookie = [].concat(seen[0].headers['set-cookie'])[0].split(';')[0];
  await request(h.port, { pathname: '/', headers: { Cookie: cookie }, record: seen });
  await request(h.port, { pathname: '/', record: seen });
  await request(h.port, { pathname: '/api/session', headers: { Cookie: cookie }, record: seen });
  await request(h.port, { pathname: '/assets/launch.js', record: seen });
  await request(h.port, { pathname: `/auth?token=${h.panel.token}`, record: seen });
  assert.ok(seen.length >= 9);

  const channels = {
    'opener argv': JSON.stringify(h.opened.map((o) => o.opts)),
    console: h.output(),
    'process stdout and stderr': h.outCapture.join(''),
    'audit.log': fs.readFileSync(path.join(h.panelDir, 'audit.log'), 'utf8'),
    'response bodies': seen.map((r) => r.body.toString('latin1')).join('\n'),
    'response headers': seen.map((r) => JSON.stringify(r.headers)).join('\n'),
    'Location headers': seen.map((r) => String(r.headers.location || '')).join('\n'),
    'reported errors': h.errors.map((e) => String(e && e.stack)).join('\n'),
  };
  for (const [name, text] of Object.entries(channels)) {
    for (const code of codes) assert.equal(text.split(code).length - 1, 0, `${name} holds a launch code`);
  }
  // The opener gets only the file path.
  for (const o of h.opened) assert.deepEqual(Object.keys(o.opts).sort(), ['env', 'target']);
  // Nor is the long-lived token printed in launch mode (apart from the failure fallback).
  assert.equal(h.output().includes(h.panel.token), false);
  assert.equal(h.output().includes('/auth?token='), false);
});

test('no file other than the launcher holds a code: the panel folder holds the launcher, the audit log and nothing with a code', async (t) => {
  const h = await launchPanel(t);
  const code = codeOf(h.opened[0].html);
  const holders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (fs.readFileSync(f, 'latin1').includes(code)) holders.push(path.relative(h.root, f));
    }
  })(h.root);
  assert.deepEqual(holders, [path.relative(h.root, h.launcherFile())]);
});
