'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const { runServeCommand } = require('../src/cli/serve');
const { runRemoteCommand } = require('../src/cli/remote');
const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');
const { createSessionStore } = require('../src/remote/sessions');
const { createTestProxy } = require('./helpers/remote-test-proxy');
const { testPort } = require('./helpers/ports');
const remoteHandlers = require('../src/admin/handlers/remote');

/*
 * ADR 0054 sections 3 and 4: sign-in by username, over real sockets. The panel runs through
 * runServeCommand with the real listeners, stores and handlers, behind the repo's test proxy
 * (copied in shape from test/remote-http.test.js, not required). The two ports are fixed, 7938 and
 * 7939 through testPort, below the range the operating system hands out for ephemeral ports. So
 * nothing else on the machine can be given one between one test's panel stopping and the next one
 * starting. SCRIPTORIUM_TEST_PORT_BASE moves them for a second copy of the suite. Remote mode needs
 * fixed ports in its settings and refuses port 0. Time is an injected clock.
 * Passwords and names here are test fixtures only.
 */

const linuxOnly = { skip: process.platform !== 'linux' ? 'Linux accepts every 127/8 address; other platforms do not' : false };
const ROOK_PW = 'rook passphrase here';
const SAFFRON_PW = 'saffron passphrase here';
const GM_PW = 'the earlier passphrase';
const ADMIN_HOST = 'panel-host.example-tailnet.ts.net';
const PREVIEW_HOST = 'panel-host.example-tailnet.ts.net:8443';
const GENERIC = '{"error":"signin","message":"That didn\'t work. Check your username and password."}';
const ADMIN_PORT = testPort(7938);
const PREVIEW_PORT = testPort(7939);

// --- harness -------------------------------------------------------------------------------------

function makeFixture(t, ports) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-sa-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n');
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Alpha Test' })}\n`);
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'pack.toml'), 'theme = "plain"\n');
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    [
      'config_version = 1',
      'default_campaign = "alpha"',
      '',
      '[campaigns.alpha]',
      `vault = '${vault}'`,
      `output = '${path.join(root, 'out')}'`,
      '',
      '[remote]',
      'mode = "tailscale"',
      `port = ${ports[0]}`,
      `preview_port = ${ports[1]}`,
      `admin_url = "https://${ADMIN_HOST}"`,
      `preview_url = "https://${PREVIEW_HOST}"`,
      '',
    ].join('\n'),
  );
  return { root, vault, configPath, panelDir: path.join(root, 'panel') };
}

/** accounts: [[name, password], ...] written to accounts.json; legacy: a password for the earlier password.json. */
async function seed(fx, { accounts = [], legacy = null } = {}) {
  if (accounts.length > 0) {
    const list = [];
    for (const [name, password] of accounts) list.push({ name, record: await pw.hashPassword(password), fromEarlierPassword: false });
    pwWrite.writeAccounts(path.join(fx.panelDir, 'accounts.json'), list);
  }
  if (legacy !== null) pwWrite.writePasswordRecord(path.join(fx.panelDir, 'password.json'), await pw.hashPassword(legacy));
}

async function startPanel(t, { accounts = [['rook', ROOK_PW], ['saffron', SAFFRON_PW]], legacy = null } = {}) {
  const ports = [ADMIN_PORT, PREVIEW_PORT];
  const fx = makeFixture(t, ports);
  await seed(fx, { accounts, legacy });
  const clk = { t: Date.UTC(2026, 9, 12, 0, 0, 0), now: () => clk.t };
  const emitted = [];
  const signals = new EventEmitter();
  const done = runServeCommand({ config: fx.configPath, admin: true }, 'alpha', { emit: (l) => emitted.push(l), signals, now: clk.now });
  let result = null;
  done.then((r) => {
    result = r;
  });
  const started = Date.now();
  while (!emitted.some((l) => /Press Ctrl-C to stop|open the admin panel link/.test(l))) {
    if (result) throw new Error(`panel exited early: ${JSON.stringify(result)}`);
    if (Date.now() - started > 10000) throw new Error(`panel did not start: ${emitted.join(' | ')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  const tokenLine = emitted.find((l) => /token=/.test(l));
  const adminPort = Number(/127\.0\.0\.1:(\d+)\/auth/.exec(tokenLine)[1]);
  const token = /token=(\S+)/.exec(tokenLine)[1];
  const env = { fx, clock: clk, emitted, adminPort, previewPort: ports[1], token, proxies: [], stopped: false };
  env.adminProxy = await createTestProxy({ upstreamPort: adminPort, localAddress: '127.0.0.1' });
  env.previewProxy = await createTestProxy({ upstreamPort: env.previewPort, localAddress: '127.0.0.1' });
  env.proxies.push(env.adminProxy, env.previewProxy);
  // The refusal delay is observed, not slept, so the suite stays fast.
  const realSleep = remoteHandlers.timing.sleep;
  remoteHandlers.timing.sleep = async () => {};
  t.after(() => {
    remoteHandlers.timing.sleep = realSleep;
  });
  env.stop = async () => {
    if (env.stopped) return result;
    env.stopped = true;
    signals.emit('SIGINT');
    const r = await done;
    for (const p of env.proxies) await p.close();
    return r;
  };
  t.after(() => env.stop());
  return env;
}

function request(port, { method = 'GET', pathname = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host !== undefined) h.Host = host;
    if (body !== undefined && h['Content-Length'] === undefined) h['Content-Length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h, setHost: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const adminReq = (env, opts) => request(env.adminProxy.port, { host: ADMIN_HOST, ...opts });
const previewReq = (env, opts) => request(env.previewProxy.port, { host: PREVIEW_HOST, ...opts });
const loopbackReq = (env, opts) => request(env.adminPort, { host: `127.0.0.1:${env.adminPort}`, ...opts });

function adminPost(env, pathname, bodyObj) {
  const body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return adminReq(env, { method: 'POST', pathname, body, headers: { 'Content-Type': 'application/json', Origin: `https://${ADMIN_HOST}` } });
}

const signin = (env, username, password) => adminPost(env, '/auth/password', { username, password });

function cookieOf(res) {
  const raw = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('__Host-scriptorium_session='));
  return raw ? raw.split(';')[0].split('=').slice(1).join('=') : null;
}

const asCookie = (value) => ({ Cookie: `__Host-scriptorium_session=${value}` });

async function signedIn(env, username, password) {
  const res = await signin(env, username, password);
  assert.equal(res.status, 200, res.text);
  return cookieOf(res);
}

function readAudit(env) {
  const file = path.join(env.fx.panelDir, 'audit.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** Wraps password.verifyPassword (the handler calls it through the module object) to count calls and keep their arguments. */
function watchVerify(t, { fake = null } = {}) {
  const real = pw.verifyPassword;
  const watch = { calls: [] };
  pw.verifyPassword = async (...args) => {
    watch.calls.push({ password: args[0], record: args[1] });
    return fake ? fake(...args) : real(...args);
  };
  t.after(() => {
    pw.verifyPassword = real;
  });
  return watch;
}

function pipes(lines) {
  const input = new PassThrough();
  const output = new Writable({ write: (c, _e, cb) => cb() });
  input.end(lines.map((l) => `${l}\n`).join(''));
  return { input, output };
}

async function cli(env, sub, args, lines = [], flags = {}) {
  const p = pipes(lines);
  return runRemoteCommand({ config: env.fx.configPath, ...flags }, sub, args, { stdin: p.input, stdout: p.output, now: env.clock.now });
}

// --- sign-in by username --------------------------------------------------------------------------

test('sign in by username: right, in any case, bound to its own password; every failure is the SAME answer, unknown names included', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const ok = await signin(env, 'rook', ROOK_PW);
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '{"ok":true}');
  assert.match(cookieOf(ok), /^[A-Za-z0-9_-]{43}$/);
  const upper = await signin(env, 'ROOK', ROOK_PW);
  assert.equal(upper.status, 200, 'names are case-insensitive');
  const mixed = await signin(env, 'SaFfRoN', SAFFRON_PW);
  assert.equal(mixed.status, 200);

  const wrongPassword = await signin(env, 'rook', 'not the right passphrase');
  const otherAccountsPassword = await signin(env, 'rook', SAFFRON_PW);
  const unknown = await signin(env, 'nobody', ROOK_PW);
  const malformed = await signin(env, 'not a valid name!', ROOK_PW);
  for (const [label, res] of [['wrong password', wrongPassword], ["another account's password", otherAccountsPassword], ['unknown name', unknown], ['malformed name', malformed]]) {
    assert.equal(res.status, 403, label);
    assert.equal(res.text, GENERIC, label);
    assert.equal(res.headers['set-cookie'], undefined, label);
    assert.equal(res.headers['content-type'], wrongPassword.headers['content-type'], label);
    assert.deepEqual(Object.keys(res.headers).sort(), Object.keys(wrongPassword.headers).sort(), `${label}: same header names`);
    assert.equal(res.headers['content-length'], wrongPassword.headers['content-length'], label);
  }
});

test('exactly ONE hash per attempt, with the same scrypt parameters, on the known path, the unknown path and the malformed-name path', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const watch = watchVerify(t);
  const attempts = [
    ['rook', ROOK_PW, 200],
    ['rook', 'wrong passphrase here', 403],
    ['nobody', ROOK_PW, 403],
    ['not a valid name!', ROOK_PW, 403],
    ['x'.repeat(64), ROOK_PW, 403],
  ];
  for (const [username, password, status] of attempts) {
    const before = watch.calls.length;
    const res = await signin(env, username, password);
    assert.equal(res.status, status, username);
    assert.equal(watch.calls.length - before, 1, `exactly one verifyPassword for ${JSON.stringify(username)}`);
    const { record } = watch.calls[watch.calls.length - 1];
    assert.deepEqual([record.N, record.r, record.p, record.keylen, record.algorithm], [32768, 8, 3, 64, 'scrypt'], `parameters for ${JSON.stringify(username)}`);
    assert.equal(Buffer.from(record.salt, 'base64').length, 16);
    assert.equal(Buffer.from(record.hash, 'base64').length, 64);
  }
  // the unknown path verifies against a record that is not any account's
  const accountsFile = JSON.parse(fs.readFileSync(path.join(env.fx.panelDir, 'accounts.json'), 'utf8'));
  const unknownRecord = watch.calls[2].record;
  for (const a of accountsFile.accounts) {
    assert.notEqual(unknownRecord.salt, a.salt);
    assert.notEqual(unknownRecord.hash, a.hash);
  }
  assert.equal(watch.calls[2].record, watch.calls[3].record, 'one shared dummy record, made once');
});

test('a body with the wrong shape is a 400 with the generic body, never hashed, never counted toward any lockout; 413 over the cap', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const watch = watchVerify(t);
  const bads = [
    'not json',
    '',
    '[]',
    '{}',
    'null',
    '{"password":"x"}',
    '{"username":"rook"}',
    '{"username":"rook","password":"x","extra":1}',
    '{"username":"","password":"x"}',
    '{"username":"rook","password":""}',
    '{"username":5,"password":"x"}',
    '{"username":"rook","password":5}',
    `{"username":"${'a'.repeat(65)}","password":"x"}`,
  ];
  for (const body of bads) {
    const res = await adminPost(env, '/auth/password', body);
    assert.ok([400, 413].includes(res.status), `${body.slice(0, 40)} gave ${res.status}`);
    if (res.status === 400) assert.equal(res.text, GENERIC, body.slice(0, 40));
  }
  assert.equal(watch.calls.length, 0, 'a shape error is never hashed');
  const big = await adminPost(env, '/auth/password', JSON.stringify({ username: 'rook', password: 'a'.repeat(1100) }));
  assert.equal(big.status, 413);
  // fifteen shape errors paused nothing: the right credentials still work
  assert.equal((await signin(env, 'rook', ROOK_PW)).status, 200);
});

// --- the lockout over real sockets ---------------------------------------------------------------------

test('five wrong tries for ONE name pause that name only: the sixth (even the right one) is refused with no hash; another name still signs in', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const watch = watchVerify(t, { fake: async (password) => password === 'right' });
  for (let i = 0; i < 5; i++) assert.equal((await signin(env, 'rook', `wrong ${i}`)).status, 403);
  assert.equal(watch.calls.length, 5);
  const paused = await signin(env, 'rook', 'right');
  assert.equal(paused.status, 403);
  assert.equal(paused.text, GENERIC, 'a pause looks exactly like a wrong password');
  assert.equal(watch.calls.length, 5, 'a paused name never hashes');
  const other = await signin(env, 'saffron', 'right');
  assert.equal(other.status, 200);
  assert.equal(watch.calls.length, 6);
  // the pause ends on the injected clock: still refused at +899999, signed in at +900000
  env.clock.t += 899999 - 0;
  assert.equal((await signin(env, 'rook', 'right')).status, 403);
  env.clock.t += 1;
  assert.equal((await signin(env, 'rook', 'right')).status, 200);
});

test('an UNKNOWN name is counted like a known one (five tries pause it, with no hash after), and every malformed name shares one bucket', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const watch = watchVerify(t, { fake: async (password) => password === 'right' });
  for (let i = 0; i < 5; i++) await signin(env, 'ghost', `wrong ${i}`);
  const before = watch.calls.length;
  assert.equal((await signin(env, 'ghost', 'right')).status, 403);
  assert.equal(watch.calls.length, before, 'a paused unknown name is not hashed');

  for (const bad of ['a b', 'c d', 'e f', 'g h', 'i j']) await signin(env, bad, 'wrong');
  const mark = watch.calls.length;
  assert.equal((await signin(env, 'k l', 'right')).status, 403, 'the sixth malformed name is refused');
  assert.equal(watch.calls.length, mark, 'and not hashed');
  assert.equal((await signin(env, 'rook', 'right')).status, 200, 'a real name is not affected by either');
});

test('the GLOBAL ceiling: 4 wrong tries each across 13 names pause everyone with no hash, the loopback token still works, and it ends at +900000', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const watch = watchVerify(t, { fake: async (password) => password === 'right' });
  const names = Array.from({ length: 13 }, (_, i) => `try${String(i + 1).padStart(2, '0')}`);
  let attempts = 0;
  for (const name of names) {
    for (let k = 0; k < 4; k++) {
      attempts++;
      if (attempts <= 50) assert.equal((await signin(env, name, `wrong ${k}`)).status, 403);
    }
  }
  assert.equal(watch.calls.length, 50, 'the 50th failure started the pause; nothing after it was hashed');
  for (const name of ['saffron', 'rook', 'brand-new']) {
    const res = await signin(env, name, 'right');
    assert.equal(res.status, 403, name);
    assert.equal(res.text, GENERIC, name);
  }
  assert.equal(watch.calls.length, 50);
  const exchange = await loopbackReq(env, { pathname: `/auth?token=${env.token}` });
  assert.equal(exchange.status, 303, 'the loopback token is never paused');
  const lines = readAudit(env).filter((e) => e.event === 'lockout-start');
  assert.ok(lines.some((e) => e.scope === 'all'));
  env.clock.t += 900000;
  assert.equal((await signin(env, 'saffron', 'right')).status, 200);
  assert.ok(readAudit(env).some((e) => e.event === 'lockout-end' && e.scope === 'all'));
});

test('a success clears that name only: it does not reset the global count (49 failures, a sign-in, one more failure still pauses everyone)', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const watch = watchVerify(t, { fake: async (password) => password === 'right' });
  for (let i = 0; i < 49; i++) await signin(env, `spread${i % 13}`, 'wrong');
  assert.equal((await signin(env, 'rook', 'right')).status, 200);
  await signin(env, 'one-more', 'wrong');
  const mark = watch.calls.length;
  assert.equal((await signin(env, 'saffron', 'right')).status, 403, 'the 50th failure paused everyone');
  assert.equal(watch.calls.length, mark);
});

// --- what is written ----------------------------------------------------------------------------------------

test('the typed username is never written: not to the audit log, not to a response; the audit carries the account name only when it exists, else "unknown"', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const typed = ['Ghost.Typed-9', 'not valid ☃ text'];
  const bodies = [];
  for (const name of typed) bodies.push((await signin(env, name, 'wrong passphrase here')).text);
  for (let i = 0; i < 4; i++) await signin(env, typed[0], 'wrong passphrase here');
  bodies.push((await signin(env, 'rook', 'wrong passphrase here')).text);
  await signin(env, 'ROOK', ROOK_PW);

  const text = fs.readFileSync(path.join(env.fx.panelDir, 'audit.log'), 'utf8');
  for (const name of typed) {
    for (const form of [name, name.toLowerCase(), JSON.stringify(name).slice(1, -1)]) assert.ok(!text.includes(form), `the audit log held the typed text ${form}`);
  }
  for (const body of bodies) assert.ok(!/ghost|typed|valid/i.test(body.replace('Check your username and password', '')), 'a response echoed the typed text');
  const entries = readAudit(env);
  const ghostRefusals = entries.filter((e) => e.event === 'signin' && e.result === 'refused');
  assert.ok(ghostRefusals.length >= 5);
  assert.equal(ghostRefusals.filter((e) => e.account === 'unknown').length, ghostRefusals.length - 1, 'every unknown name is "unknown"');
  const rookRefusal = ghostRefusals.find((e) => e.account === 'rook');
  assert.ok(rookRefusal, 'a wrong password for a real account names it');
  const okEntry = entries.find((e) => e.event === 'signin' && e.result === 'ok');
  assert.equal(okEntry.account, 'rook', 'the canonical name, whatever case was typed');
  const start = entries.find((e) => e.event === 'lockout-start' && e.scope === 'name');
  assert.equal(start.account, 'unknown');
});

test('the audit of a pause on a REAL account names it; a second account is untouched; nothing else about the typed text appears', linuxOnly, async (t) => {
  const env = await startPanel(t);
  watchVerify(t, { fake: async () => false });
  for (let i = 0; i < 5; i++) await signin(env, 'Rook', `wrong ${i}`);
  const start = readAudit(env).find((e) => e.event === 'lockout-start');
  assert.deepEqual([start.scope, start.account], ['name', 'rook']);
});

// --- sessions, headers, the page ----------------------------------------------------------------------------------

test('/api/session carries the account: the name for a remote session, gm for one made before accounts existed, null on loopback', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const rook = await signedIn(env, 'rook', ROOK_PW);
  const saffron = await signedIn(env, 'saffron', SAFFRON_PW);
  const get = async (cookie) => JSON.parse((await adminReq(env, { pathname: '/api/session', headers: asCookie(cookie) })).text);
  assert.equal((await get(rook)).account, 'rook');
  assert.equal((await get(saffron)).account, 'saffron');

  const store = createSessionStore({ file: path.join(env.fx.panelDir, 'sessions.json'), now: env.clock.now });
  store.load();
  const legacy = store.create('admin');
  assert.equal((await get(legacy.credential)).account, 'gm', 'a session with no account counts as gm');

  const loop = await loopbackReq(env, { pathname: '/api/session', headers: { Cookie: `scriptorium_admin_${env.adminPort}=${env.token}` } });
  assert.equal(loop.status, 200);
  assert.equal(JSON.parse(loop.text).account, null);
});

test('X-Robots-Tag: noindex is on the sign-in page, a refusal, a JSON answer, the loopback page and a signed-in response; the preview side is unchanged', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const page = await adminReq(env, {});
  assert.equal(page.status, 403);
  assert.equal(page.headers['x-robots-tag'], 'noindex');
  const refusal = await adminReq(env, { pathname: '/api/state' });
  assert.equal(refusal.text, 'refused: session');
  assert.equal(refusal.headers['x-robots-tag'], 'noindex');
  const json = await signin(env, 'rook', 'wrong passphrase here');
  assert.equal(json.headers['x-robots-tag'], 'noindex');
  const locked = await loopbackReq(env, {});
  assert.equal(locked.headers['x-robots-tag'], 'noindex');
  const cookie = await signedIn(env, 'rook', ROOK_PW);
  const api = await adminReq(env, { pathname: '/api/session', headers: asCookie(cookie) });
  assert.equal(api.headers['x-robots-tag'], 'noindex');
  const notFound = await adminReq(env, { pathname: '/nope', headers: asCookie(cookie) });
  assert.equal(notFound.headers['x-robots-tag'], 'noindex');
  const preview = await previewReq(env, {});
  assert.equal(preview.headers['x-robots-tag'], undefined, 'previewHeaders is unchanged');
});

test('the root predicate: / alone, or with exactly one campaign=<name> hint, is the sign-in page; any other query is a plain refusal; nothing is reflected', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const signinPage = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'signin.html'));
  for (const url of ['/', '/?campaign=alpha', '/?campaign=a', `/?campaign=${'a'.repeat(63)}`, '/?campaign=my-campaign-2', '/?']) {
    const res = await adminReq(env, { pathname: url });
    assert.equal(res.status, 403, url);
    assert.deepEqual(res.body, signinPage, `${url} is the sign-in page, byte for byte (the hint is never put in the page)`);
    assert.ok(!JSON.stringify(res.headers).includes('alpha'), `${url}: the hint is never put in a header`);
    assert.equal(res.headers.location, undefined, url);
  }
  for (const url of ['/?campaign=Alpha', '/?campaign=a&x=1', '/?x=1', '/?campaign=../a', '/?campaign=', '/?campaign=a%20b', '/?campaign=alpha&campaign=beta', '/?campaign=-a', `/?campaign=${'a'.repeat(64)}`, '/?x=1&campaign=alpha', '/?CAMPAIGN=alpha', '//?campaign=alpha']) {
    const res = await adminReq(env, { pathname: url });
    assert.equal(res.status, 403, url);
    assert.equal(res.text, 'refused: session', url);
  }
  // the loopback locked page follows the same predicate
  const locked = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'locked.html'));
  assert.deepEqual((await loopbackReq(env, { pathname: '/?campaign=alpha' })).body, locked);
  assert.equal((await loopbackReq(env, { pathname: '/?x=1' })).text, 'refused: token');
});

// --- /api/remote ----------------------------------------------------------------------------------------------------------

test('/api/remote lists accounts (name, set date, earlier-password mark, last sign-in) and the lockout by account, with no secret and no typed text', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const cookie = await signedIn(env, 'rook', ROOK_PW);
  env.clock.t += 60000;
  await signedIn(env, 'ROOK', ROOK_PW);
  const lastRook = new Date(env.clock.t).toISOString();
  await signin(env, 'Typed-Unknown', 'wrong passphrase here');
  const res = await adminReq(env, { pathname: '/api/remote', headers: asCookie(cookie) });
  const body = JSON.parse(res.text);
  assert.equal(body.password, undefined, 'the single password field is gone');
  assert.equal(body.accounts.state, 'set');
  assert.deepEqual(body.accounts.list.map((a) => a.name), ['rook', 'saffron']);
  const rook = body.accounts.list[0];
  assert.deepEqual(Object.keys(rook).sort(), ['fromEarlierPassword', 'lastSignin', 'name', 'setAt']);
  assert.equal(rook.fromEarlierPassword, false);
  assert.equal(typeof rook.setAt, 'string');
  assert.equal(rook.lastSignin, lastRook);
  assert.equal(body.accounts.list[1].lastSignin, null, 'saffron has never signed in');
  assert.deepEqual(body.lockout, { active: false, until: null, recentFailures: 1, refused: 0, pausedAccounts: [], pausedOther: 0 });
  const accountsFile = JSON.parse(fs.readFileSync(path.join(env.fx.panelDir, 'accounts.json'), 'utf8')).accounts;
  for (const secret of [ROOK_PW, SAFFRON_PW, 'wrong passphrase here', 'Typed-Unknown', 'typed-unknown', env.token, cookie, ...accountsFile.flatMap((a) => [a.hash, a.salt])]) {
    assert.ok(!res.text.includes(secret), `the response leaked ${secret.slice(0, 6)}...`);
  }
});

test('/api/remote: a paused real account is listed by name, a paused unknown one only as a count; looseModes names accounts.json', { skip: process.platform !== 'linux' }, async (t) => {
  const env = await startPanel(t);
  const cookie = await signedIn(env, 'saffron', SAFFRON_PW);
  watchVerify(t, { fake: async () => false });
  for (let i = 0; i < 5; i++) await signin(env, 'rook', `w${i}`);
  for (let i = 0; i < 5; i++) await signin(env, 'ghost', `w${i}`);
  fs.chmodSync(path.join(env.fx.panelDir, 'accounts.json'), 0o644);
  const body = JSON.parse((await adminReq(env, { pathname: '/api/remote', headers: asCookie(cookie) })).text);
  assert.deepEqual(body.lockout.pausedAccounts, ['rook']);
  assert.equal(body.lockout.pausedOther, 1);
  assert.deepEqual(body.files.looseModes, [path.join(env.fx.panelDir, 'accounts.json')]);
  assert.ok(!JSON.stringify(body).includes('ghost'));
});

// --- migration and the CLI, against a running panel ----------------------------------------------------------------------

test('an earlier password.json signs in as gm (any case), the panel writes nothing, and the first CLI write materialises it without a restart', linuxOnly, async (t) => {
  const env = await startPanel(t, { accounts: [], legacy: GM_PW });
  const accountsFile = path.join(env.fx.panelDir, 'accounts.json');
  assert.equal((await signin(env, 'gm', GM_PW)).status, 200);
  assert.equal((await signin(env, 'GM', GM_PW)).status, 200);
  assert.equal((await signin(env, 'rook', GM_PW)).status, 403);
  assert.equal(fs.existsSync(accountsFile), false, 'the panel never writes accounts.json');
  const cookie = await signedIn(env, 'gm', GM_PW);
  const view = JSON.parse((await adminReq(env, { pathname: '/api/remote', headers: asCookie(cookie) })).text);
  assert.deepEqual(view.accounts.list.map((a) => [a.name, a.fromEarlierPassword]), [['gm', true]]);

  await cli(env, 'account', ['add', 'rook'], [ROOK_PW]);
  assert.equal(fs.existsSync(accountsFile), true);
  assert.equal((await signin(env, 'rook', ROOK_PW)).status, 200, 'a running panel sees the new account at once');
  assert.equal((await signin(env, 'gm', GM_PW)).status, 200, 'and gm still signs in with the earlier password');
});

test('a CLI reset signs out exactly one account in a running panel; so does remove; signout-all --account; remote off ends sign-in for everyone', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const alive = async (cookie) => (await adminReq(env, { pathname: '/api/session', headers: asCookie(cookie) })).status === 200;
  const rook = await signedIn(env, 'rook', ROOK_PW);
  const saffron = await signedIn(env, 'saffron', SAFFRON_PW);

  await cli(env, 'account', ['reset', 'rook'], ['a brand new passphrase']);
  assert.equal(await alive(rook), false, 'rook is signed out');
  assert.equal(await alive(saffron), true, 'saffron keeps working');
  const refused = await adminReq(env, { pathname: '/api/session', headers: asCookie(rook) });
  assert.equal(refused.text, 'refused: session');
  assert.equal((await signin(env, 'rook', ROOK_PW)).status, 403, 'the old password no longer works');
  const again = await signedIn(env, 'rook', 'a brand new passphrase');

  await cli(env, 'signout-all', [], [], { account: 'saffron' });
  assert.equal(await alive(saffron), false);
  assert.equal(await alive(again), true, 'only saffron went');

  await cli(env, 'account', ['remove', 'rook']);
  assert.equal(await alive(again), false);
  assert.equal((await signin(env, 'rook', 'a brand new passphrase')).status, 403, 'a removed account cannot sign in');

  await cli(env, 'off');
  assert.equal((await signin(env, 'saffron', SAFFRON_PW)).status, 403, 'remote off clears every account');
  assert.equal((await cli(env, 'account', ['list'])).human, 'no accounts');
});

test('when the accounts are cleared or broken under a running panel (read afresh on every attempt) every sign-in is the same generic refusal, with no hash', linuxOnly, async (t) => {
  const env = await startPanel(t);
  const watch = watchVerify(t);
  const file = path.join(env.fx.panelDir, 'accounts.json');
  pwWrite.clearAccounts(file);
  for (const username of ['rook', 'nobody']) {
    const res = await signin(env, username, ROOK_PW);
    assert.equal(res.status, 403);
    assert.equal(res.text, GENERIC);
  }
  fs.writeFileSync(file, '{ broken');
  const broken = await signin(env, 'rook', ROOK_PW);
  assert.equal(broken.status, 403);
  assert.equal(broken.text, GENERIC);
  assert.equal(watch.calls.length, 0, 'nothing to check against, so nothing is hashed');
  assert.ok(readAudit(env).some((e) => e.event === 'signin' && e.result === 'error' && e.account === 'unknown'));
});
