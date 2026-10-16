'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');
const { copySample } = require('./helpers/setup-fixtures');
const { createTestProxy } = require('./helpers/remote-test-proxy');
const { testPort } = require('./helpers/ports');
const { installLoopbackGuard } = require('./helpers/net-stubs');

const { startAdminPanel } = require('../src/cli/serve-admin');
const { ADMIN_ROUTES } = require('../src/admin/router');
const { apiRemote } = require('../src/admin/handlers/remote');
const { loadConfig } = require('../src/cli/args');
const { remotePaths } = require('../src/remote/paths');
const configWrite = require('../src/config/write');
const pw = require('../src/remote/password');
const pwWrite = require('../src/remote/passwordwrite');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

/*
 * ADR 0057 section 7 ("Turning it on and off from the tray"): remote access at sign-in is changed only by the
 * tray's `signin on|off` line (through the desktop host) and by `desktop set --remote-at-signin` on this PC,
 * never by anything the panel serves. Structurally: no module the panel loads names the writer, or the two raw
 * keys, except the config modules themselves. Behaviourally: every panel POST, in local, ssh and proxy modes and
 * for both request kinds, leaves both keys byte for byte as they were. Every scan has a positive control.
 * walkGraph and the comment stripper are copied, not required (the precedent of test/setup-structure.test.js).
 */

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const at = (...p) => path.join(SRC, ...p);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractRequireSpecs(source) {
  const specs = [];
  const re = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  const stripped = stripComments(source);
  while ((m = re.exec(stripped))) specs.push(m[2]);
  return specs;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  if (fs.existsSync(`${base}.json`)) return `${base}.json`;
  if (fs.existsSync(base) && fs.statSync(base).isDirectory() && fs.existsSync(path.join(base, 'index.js'))) return path.join(base, 'index.js');
  return base;
}

function walkGraph(entry) {
  const files = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!fs.existsSync(file) || !file.endsWith('.js')) continue;
    for (const spec of extractRequireSpecs(fs.readFileSync(file, 'utf8'))) {
      if (Module.builtinModules.includes(spec.replace(/^node:/, ''))) continue;
      if (spec[0] === '.' || spec[0] === '/') {
        queue.push(resolveRelative(file, spec));
        continue;
      }
      try {
        queue.push(require.resolve(spec, { paths: [path.dirname(file)] }));
      } catch {
        // unresolved bare specifiers are generator-module-graph.test.js's business
      }
    }
  }
  return files;
}

/** The files of the graph from `entry` whose comment-stripped source matches `re`, as paths. */
function namersFrom(entry, re) {
  return [...walkGraph(entry)]
    .filter((f) => f.endsWith('.js') && fs.existsSync(f))
    .filter((f) => re.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .sort();
}

const PANEL_ENTRY = at('cli', 'serve-admin.js');
const FN_NAME = /\bsetRemoteAtSignin\b/;
const RAW_KEYS = /\bremote_at_signin(_pc)?\b/;

/** The body of `function <name>(` in a JS source (braces counted outside quotes), or ''. */
function jsBody(source, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!m) return '';
  const open = source.indexOf('{', source.indexOf(')', m.index));
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return '';
}

function scratchDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-signin-tick-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- F1: structure ----------------------------------------------------------------------------------------

test('F1: from the panel entry, only src/config/write.js names setRemoteAtSignin; the desktop host and the two CLI writers are not in the panel graph', () => {
  assert.deepEqual(namersFrom(PANEL_ENTRY, FN_NAME).map(rel), ['src/config/write.js']);
  const graph = walkGraph(PANEL_ENTRY);
  for (const f of [at('desktop', 'host.js'), at('cli', 'desktop.js'), at('cli', 'remote.js')]) assert.equal(graph.has(f), false, rel(f));
});

test('F1: host.js names setRemoteAtSignin once, inside signinOp, and calls signinOp once, inside handleLine', () => {
  const source = stripComments(fs.readFileSync(at('desktop', 'host.js'), 'utf8'));
  assert.equal((source.match(/\bsetRemoteAtSignin\b/g) || []).length, 1);
  assert.equal(/\bsetRemoteAtSignin\b/.test(jsBody(source, 'signinOp')), true);
  const calls = source.replace(/function\s+signinOp\s*\(/, 'function X(').match(/\bsigninOp\s*\(/g) || [];
  assert.equal(calls.length, 1);
  assert.equal(/\bsigninOp\s*\(/.test(jsBody(source, 'handleLine')), true);
});

// --- A1: the raw key names ---------------------------------------------------------------------------------

test('A1: from the panel entry, only the two config modules name remote_at_signin or remote_at_signin_pc, so no panel file can hand-build the keys', () => {
  assert.deepEqual(namersFrom(PANEL_ENTRY, RAW_KEYS).map(rel), ['src/config/desktopsettings.js', 'src/config/write.js']);
});

// --- F2 / A1: positive controls ----------------------------------------------------------------------------

test('F2: positive controls: the scan finds the host from the host, a planted writer namer and a planted raw-key namer, and ignores a comment', (t) => {
  assert.equal(namersFrom(at('desktop', 'host.js'), FN_NAME).map(rel).includes('src/desktop/host.js'), true);
  const dir = scratchDir(t, 'f2');
  fs.writeFileSync(path.join(dir, 'sneaky.js'), 'const { setRemoteAtSignin } = require(' + JSON.stringify(at('config', 'write.js')) + ');\nsetRemoteAtSignin({}, true, "x");\n');
  fs.writeFileSync(path.join(dir, 'rawkeys.js'), "module.exports = { remote_at_signin: true };\n");
  fs.writeFileSync(path.join(dir, 'quiet.js'), '// setRemoteAtSignin and remote_at_signin in a comment only\nmodule.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'entry.js'), `require(${JSON.stringify(PANEL_ENTRY)});\nrequire('./sneaky');\nrequire('./rawkeys');\nrequire('./quiet');\n`);
  const entry = path.join(dir, 'entry.js');
  assert.deepEqual(namersFrom(entry, FN_NAME).map((f) => path.basename(f)).sort(), ['sneaky.js', 'write.js']);
  assert.deepEqual(namersFrom(entry, RAW_KEYS).map((f) => path.basename(f)).sort(), ['desktopsettings.js', 'rawkeys.js', 'write.js']);
  assert.notDeepEqual(namersFrom(entry, FN_NAME).map(rel), ['src/config/write.js'], 'the F1 assertion would be red');
});

// --- A3: no await between the read and the write in signinOp --------------------------------------------------

/** True when the text from `loadConfig({` to `writeConfig(` in signinOp holds an await. */
function awaitBetweenReadAndWrite(source) {
  const body = jsBody(stripComments(source), 'signinOp');
  const from = body.indexOf('loadConfig({');
  const to = body.indexOf('writeConfig(', from);
  if (from < 0 || to < 0) throw new Error('signinOp does not read then write');
  return /\bawait\b/.test(body.slice(from, to));
}

test('A3: signinOp reads and writes the settings with no await between, so a panel write in the same process cannot interleave', () => {
  assert.equal(awaitBetweenReadAndWrite(fs.readFileSync(at('desktop', 'host.js'), 'utf8')), false);
  // positive control
  const planted = 'async function signinOp(on) {\n  const { config } = loadConfig({ config: p });\n  await Promise.resolve();\n  writeConfig(p, config);\n}\n';
  assert.equal(awaitBetweenReadAndWrite(planted), true);
  const clean = 'async function signinOp(on) {\n  const { config } = loadConfig({ config: p });\n  writeConfig(p, config);\n  await later();\n}\n';
  assert.equal(awaitBetweenReadAndWrite(clean), false);
});

// --- F3 / F4: the behavioural sweep -------------------------------------------------------------------------

const SIGNIN_PHRASE = ['correct', 'horse', 'battery'].join(' ');
const ADMIN_HOST = 'scriptorium.home.arpa';
const PREVIEW_HOST = 'preview.scriptorium.home.arpa';
const PROXY_PORT = testPort(9790);
const PROXY_PREVIEW_PORT = testPort(9791);
const SSH_PORT = testPort(9792);
const SSH_PREVIEW_PORT = testPort(9793);
const linuxOnly = process.platform !== 'linux';

const KEY_LINE = /^remote_at_signin(_pc)? = /;
const STATE_B = '\n[desktop]\nremote_at_signin = true\nremote_at_signin_pc = "PC-ELSEWHERE"\n';
const KEYS_B = ['remote_at_signin = true', 'remote_at_signin_pc = "PC-ELSEWHERE"'];
const HOSTILE = JSON.stringify({ remote_at_signin: true, remote_at_signin_pc: 'PC-SWEEP', remoteAtSignin: true, signin: 'on', atSignin: 'on' });

function remoteToml(mode) {
  if (mode === 'ssh') return `\n[remote]\nmode = "ssh"\nport = ${SSH_PORT}\npreview_port = ${SSH_PREVIEW_PORT}\n`;
  if (mode === 'proxy') {
    return `\n[remote]\nmode = "proxy"\nport = ${PROXY_PORT}\npreview_port = ${PROXY_PREVIEW_PORT}\nadmin_url = "https://${ADMIN_HOST}"\npreview_url = "https://${PREVIEW_HOST}"\nbind = "127.0.0.1"\ntrusted_proxies = ["127.0.0.2"]\n`;
  }
  return '';
}

function request(port, { method = 'GET', pathname = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host !== undefined) h.Host = host;
    if (body !== undefined) h['Content-Length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h, setHost: host === undefined, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Signs in as the account "gm" through the proxy, the way a remote device does. */
function signInAs(proxyPort, origin, password) {
  return request(proxyPort, { method: 'POST', pathname: '/auth/password', host: ADMIN_HOST, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gm', password }) });
}

/** Every POST route with a path, with the two sign-out routes last (they end the session they ride on). */
function postRoutes() {
  const posts = ADMIN_ROUTES.filter((r) => r.method === 'POST' && r.path !== undefined).map((r) => r.path);
  const last = ['/api/remote/signout', '/api/remote/signout-all'];
  return [...posts.filter((p) => !last.includes(p)), ...last];
}

/**
 * Starts a panel in `mode` on a scratch config in start state A (no sign-in keys) or B (the keys, for another PC),
 * sends every POST with `{}` and with the hostile body as each request kind, and returns the key lines left in the
 * file and every status.
 */
async function sweepMode(t, { mode, state, planted = false }) {
  const root = scratchDir(t, `${mode}-${state}`);
  const configPath = path.join(root, 'cfg', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const vault = copySample(root, 'vault', { withPack: true });
  configWrite.writeConfigFile(configPath, { config_version: 1, default_campaign: 'x', campaigns: { x: { vault, output: path.join(root, 'out') } } });
  fs.appendFileSync(configPath, remoteToml(mode) + (state === 'B' ? STATE_B : ''));
  if (mode === 'proxy') pwWrite.writePasswordRecord(path.join(remotePaths(configPath).panelDir, 'password.json'), await pw.hashPassword(SIGNIN_PHRASE));

  const saved = ADMIN_ROUTES.find((r) => r.method === 'POST' && r.path === '/api/remote/signout').handler;
  if (planted) {
    // F4: the signout route is swapped for one that turns the setting on, the way a bad route would.
    ADMIN_ROUTES.find((r) => r.method === 'POST' && r.path === '/api/remote/signout').handler = (req, res, ctx) => {
      const { config } = loadConfig({ config: ctx.ctxInfo.configPath });
      configWrite.writeConfigFile(ctx.ctxInfo.configPath, configWrite.setRemoteAtSignin(config, true, 'PC-PLANTED'));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    };
  }
  let started;
  let proxy;
  try {
    started = await startAdminPanel({ admin: true, config: configPath }, undefined, { emit() {} });
    assert.equal(started.ok, true, JSON.stringify(started));
    const { ctx } = started;
    ctx.desktop = { requestRestart() {}, ports: { panel: ctx.adminPort, preview: ctx.previewPort } };
    const port = ctx.adminPort;
    const statuses = [];
    const bodies = ['{}', HOSTILE];

    // the loopback kind, with the panel's own cookie and origin
    for (const body of bodies) {
      for (const p of postRoutes()) {
        const res = await request(port, {
          method: 'POST',
          pathname: p,
          headers: { Cookie: `scriptorium_admin_${port}=${started.token}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
          body,
        });
        statuses.push([`loopback ${p}`, res.status]);
      }
    }

    // the remote kind, in proxy mode: signed in once, through the test proxy that forwards Host and Origin as sent
    if (mode === 'proxy') {
      proxy = await createTestProxy({ upstreamPort: port, localAddress: '127.0.0.2' });
      const origin = `https://${ADMIN_HOST}`;
      const signin = await signInAs(proxy.port, origin, SIGNIN_PHRASE);
      assert.equal(signin.status, 200, signin.text);
      const raw = [].concat(signin.headers['set-cookie'] || []).find((c) => c.split('=')[0] === '__Host-scriptorium_session');
      assert.ok(raw, 'a session cookie');
      const cookie = raw.split(';')[0];
      for (const body of bodies) {
        for (const p of postRoutes()) {
          const res = await request(proxy.port, { method: 'POST', pathname: p, host: ADMIN_HOST, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body });
          statuses.push([`remote ${p}`, res.status]);
        }
      }
    }
    const lines = fs.readFileSync(configPath, 'utf8').split('\n').filter((l) => KEY_LINE.test(l));
    return { lines, statuses };
  } finally {
    if (proxy) await proxy.close();
    if (started && started.ok) await started.stop();
    ADMIN_ROUTES.find((r) => r.method === 'POST' && r.path === '/api/remote/signout').handler = saved;
  }
}

test('F3: no panel POST, in local, ssh or proxy mode and as either request kind, changes remote access at sign-in', async (t) => {
  const began = Date.now();
  for (const mode of ['local', 'ssh', 'proxy']) {
    if (mode === 'proxy' && linuxOnly) continue; // Linux accepts every 127/8 address, which the trusted-peer shape needs
    for (const state of ['A', 'B']) {
      const r = await sweepMode(t, { mode, state });
      assert.deepEqual(r.lines, state === 'A' ? [] : KEYS_B, `${mode} ${state}`);
      assert.ok(r.statuses.length > 0);
      for (const [what, status] of r.statuses) assert.notEqual(status, 500, `${mode} ${state} ${what}`);
    }
  }
  t.diagnostic(`F3 sweep took ${Date.now() - began} ms`);
});

test('F4: positive control: with a signout handler planted to turn the setting on, the same sweep sees the keys appear', async (t) => {
  const r = await sweepMode(t, { mode: 'local', state: 'A', planted: true });
  assert.deepEqual(r.lines, ['remote_at_signin = true', 'remote_at_signin_pc = "PC-PLANTED"']);
  assert.notDeepEqual(r.lines, []);
});

// --- P1 to P6: GET /api/remote atSignin ---------------------------------------------------------------------

async function panelFor(t, label, extraToml = '') {
  const root = scratchDir(t, label);
  const configPath = path.join(root, 'cfg', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const vault = copySample(root, 'vault', { withPack: true });
  configWrite.writeConfigFile(configPath, { config_version: 1, default_campaign: 'x', campaigns: { x: { vault, output: path.join(root, 'out') } } });
  if (extraToml) fs.appendFileSync(configPath, extraToml);
  const started = await startAdminPanel({ admin: true, config: configPath }, undefined, { emit() {} });
  assert.equal(started.ok, true);
  t.after(() => started.stop());
  return { started, configPath };
}

function getRemote(ctx) {
  const sent = [];
  apiRemote({ method: 'GET', headers: {} }, { writeHead: (status) => sent.push({ status }), end: (b) => sent.push({ body: b }) }, ctx, { kind: 'loopback' });
  return { status: sent.find((s) => s.status !== undefined).status, body: JSON.parse(sent.find((s) => s.body !== undefined).body) };
}

const desktopLink = () => ({ requestRestart() {}, ports: {} });

test('P1: atSignin is null outside the desktop app', async (t) => {
  const { started } = await panelFor(t, 'p1');
  assert.equal(started.ctx.desktop, null);
  assert.equal(getRemote(started.ctx).body.atSignin, null);
});

test('P2: atSignin is "off" with the keys absent', async (t) => {
  const { started } = await panelFor(t, 'p2');
  started.ctx.desktop = desktopLink();
  assert.equal(getRemote(started.ctx).body.atSignin, 'off');
});

test('P3: atSignin is "on" when the file names this computer', async (t) => {
  const { started, configPath } = await panelFor(t, 'p3');
  started.ctx.desktop = desktopLink();
  const { config } = loadConfig({ config: configPath });
  configWrite.writeConfigFile(configPath, configWrite.setRemoteAtSignin(config, true, os.hostname()));
  assert.equal(getRemote(started.ctx).body.atSignin, 'on');
});

test('P4: atSignin follows the file after the panel started: it is read fresh, not taken from the start', async (t) => {
  const { started, configPath } = await panelFor(t, 'p4');
  started.ctx.desktop = desktopLink();
  assert.equal(getRemote(started.ctx).body.atSignin, 'off');
  const { config } = loadConfig({ config: configPath });
  configWrite.writeConfigFile(configPath, configWrite.setRemoteAtSignin(config, true, os.hostname()));
  assert.equal(getRemote(started.ctx).body.atSignin, 'on');
  const again = loadConfig({ config: configPath }).config;
  configWrite.writeConfigFile(configPath, configWrite.setRemoteAtSignin(again, false));
  assert.equal(getRemote(started.ctx).body.atSignin, 'off');
});

test('P5: atSignin is "off" when the file names another computer', async (t) => {
  const { started, configPath } = await panelFor(t, 'p5');
  started.ctx.desktop = desktopLink();
  const { config } = loadConfig({ config: configPath });
  configWrite.writeConfigFile(configPath, configWrite.setRemoteAtSignin(config, true, 'PC-ELSEWHERE'));
  assert.equal(getRemote(started.ctx).body.atSignin, 'off');
});

test('P6: a settings file that no longer parses gives "off" and a 200', async (t) => {
  const { started, configPath } = await panelFor(t, 'p6');
  started.ctx.desktop = desktopLink();
  fs.writeFileSync(configPath, 'config_version = [\n');
  const r = getRemote(started.ctx);
  assert.equal(r.status, 200);
  assert.equal(r.body.atSignin, 'off');
});
