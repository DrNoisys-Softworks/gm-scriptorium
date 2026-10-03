'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { RA } = require('../assets/admin/remote');
const { PV } = require('../assets/admin/sitepane');

/*
 * V1.5a (SD-a12, SD-a17). RA, the pure half of the Setup > Remote access screen, and PV.previewSrc,
 * the pure half of the frame/tab URL rule. Expected strings are typed independently.
 */

test('MODE_LABEL: the five labels, as an own-property lookup that never returns an inherited member', () => {
  assert.deepEqual(RA.MODE_LABEL, {
    local: 'This computer only',
    ssh: 'SSH tunnel',
    tailscale: 'Over Tailscale',
    proxy: 'Behind your reverse proxy',
    direct: 'Direct, own certificate',
  });
  assert.equal(RA.modeLabel('proxy'), 'Behind your reverse proxy');
  for (const bad of ['', 'banana', '__proto__', 'constructor', 'toString', 'hasOwnProperty', undefined, null, 5, {}]) {
    assert.equal(RA.modeLabel(bad), 'Unknown mode', String(bad));
  }
});

test('httpsLine: per mode, "not needed on this computer" in local, and tailscale never says "only your devices"', () => {
  assert.equal(RA.httpsLine({ mode: 'local', https: { by: 'none', hop: null } }), 'HTTPS: not needed on this computer.');
  assert.equal(RA.httpsLine({ mode: 'ssh', https: { by: 'ssh', hop: null } }), 'HTTPS: not needed, the SSH tunnel encrypts the traffic.');
  const ts = RA.httpsLine({ mode: 'tailscale', https: { by: 'tailscale', hop: null } });
  assert.equal(ts, "HTTPS: by tailscale serve. Your tailnet's access rules decide which devices can reach the sign-in page.");
  assert.doesNotMatch(ts, /only your devices/i);
  assert.equal(
    RA.httpsLine({ mode: 'proxy', https: { by: 'proxy', hop: 'plain' } }),
    'HTTPS: by your proxy. The hop from the proxy to GM-Scriptorium is plain HTTP, so keep the two on a network you trust.',
  );
  assert.equal(RA.httpsLine({ mode: 'proxy', https: { by: 'proxy', hop: 'tls' } }), 'HTTPS: by your proxy, and the hop from the proxy to GM-Scriptorium is encrypted too.');
  assert.equal(RA.httpsLine({ mode: 'direct', https: { by: 'panel', hop: null } }), 'HTTPS: by GM-Scriptorium itself.');
  assert.equal(RA.httpsLine(null), 'HTTPS: not needed on this computer.');
});

test('listeningLine', () => {
  assert.equal(RA.listeningLine({ mode: 'local', listening: { hosts: ['127.0.0.1'], adminPort: 5, previewPort: 6 } }), 'Listening on 127.0.0.1 only, so only this computer can reach it.');
  assert.equal(
    RA.listeningLine({ mode: 'proxy', listening: { hosts: ['192.0.2.42', '127.0.0.1'], adminPort: 7400, previewPort: 7401 } }),
    'Listening on 192.0.2.42 and 127.0.0.1, ports 7400 (panel) and 7401 (preview).',
  );
});

test('lockoutLine: open, with failures, and paused (with the UTC time and the refused count)', () => {
  assert.equal(RA.lockoutLine({ active: false, until: null, recentFailures: 0, refused: 0 }), 'Remote sign-in is open. Five wrong passwords in ten minutes would pause it for fifteen.');
  assert.equal(RA.lockoutLine({ active: false, until: null, recentFailures: 1, refused: 0 }), 'Remote sign-in is open. 1 wrong password in the last ten minutes; five would pause it for fifteen.');
  assert.equal(RA.lockoutLine({ active: false, until: null, recentFailures: 3, refused: 0 }), 'Remote sign-in is open. 3 wrong passwords in the last ten minutes; five would pause it for fifteen.');
  const until = Date.UTC(2026, 9, 3, 13, 45, 0);
  assert.equal(
    RA.lockoutLine({ active: true, until, recentFailures: 0, refused: 3 }),
    'Remote sign-in is paused until 2026-10-03 13:45 UTC after five wrong passwords. 3 attempts have been turned away. The one-time link on this machine still works.',
  );
  assert.match(RA.lockoutLine({ active: true, until, recentFailures: 0, refused: 1 }), /1 attempt has been turned away/);
});

test('signinRows: only sign-in events, "How" and "From" worded for the person, and there is NO "Who"', () => {
  const rows = RA.signinRows([
    { t: '2026-10-03T07:42:10.000Z', event: 'signin', method: 'password', result: 'ok', via: 'remote', from: '198.51.100.77' },
    { t: '2026-10-03T06:05:00.000Z', event: 'signin', method: 'token', result: 'ok', via: 'loopback', from: '127.0.0.1' },
    { t: '2026-10-02T23:11:00.000Z', event: 'signin', method: 'password', result: 'refused', via: 'remote', from: '203.0.113.9' },
    { t: '2026-10-02T23:12:00.000Z', event: 'signin', method: 'password', result: 'error', via: 'remote' },
    { t: '2026-10-02T23:13:00.000Z', event: 'lockout-start', until: 5 },
    { t: '2026-10-02T23:14:00.000Z', event: 'request', route: '/api/check' },
    null,
  ]);
  assert.deepEqual(rows, [
    { how: 'Panel password', from: '198.51.100.77', when: '2026-10-03 07:42 UTC', result: 'signed in' },
    { how: 'One-time link', from: 'This machine (or an SSH tunnel)', when: '2026-10-03 06:05 UTC', result: 'signed in' },
    { how: 'Panel password', from: '203.0.113.9', when: '2026-10-02 23:11 UTC', result: 'refused' },
    { how: 'Panel password', from: 'unknown address', when: '2026-10-02 23:12 UTC', result: 'error' },
  ]);
  for (const r of rows) assert.ok(!('who' in r));
  assert.deepEqual(RA.signinRows(undefined), []);
});

test('refusedOnly keeps only refused rows', () => {
  const rows = [{ result: 'signed in' }, { result: 'refused' }, { result: 'error' }, { result: 'refused' }];
  assert.deepEqual(RA.refusedOnly(rows), [{ result: 'refused' }, { result: 'refused' }]);
  assert.deepEqual(RA.refusedOnly(undefined), []);
});

test('cliCommands: turn on or change, turn off, password, sign out every device, in that order, with neutral names', () => {
  for (const mode of ['local', 'ssh', 'tailscale', 'proxy', 'direct']) {
    const cmds = RA.cliCommands(mode);
    assert.deepEqual(cmds.map((c) => c.label), ['Turn on or change', 'Turn off', 'Set or change the password', 'Sign out every device']);
    assert.match(cmds[0].command, /^scriptorium remote set --mode /);
    assert.equal(cmds[1].command, 'scriptorium remote off');
    assert.equal(cmds[2].command, 'scriptorium remote password');
    assert.equal(cmds[3].command, 'scriptorium remote signout-all');
  }
  assert.equal(RA.cliCommands('ssh')[0].command, 'scriptorium remote set --mode ssh --port 7400 --preview-port 7401');
  assert.match(RA.cliCommands('tailscale')[0].command, /ts\.net/);
  assert.match(RA.cliCommands('proxy')[0].command, /--trusted-proxy 198\.51\.100\.20/);
  assert.doesNotMatch(JSON.stringify(RA.cliCommands('proxy')), /192\.168\./);
});

test('configNote: names the config path, and is empty without one', () => {
  assert.match(RA.configNote({ configPath: '/home/gm/.config/scriptorium/config.toml' }), /\/home\/gm\/\.config\/scriptorium\/config\.toml.*--config <path>/);
  assert.equal(RA.configNote({}), '');
  assert.equal(RA.configNote(null), '');
});

test('healthItems: HTTPS, password, listening, audit log, file permissions; a problem is flagged bad', () => {
  const view = {
    mode: 'proxy',
    https: { by: 'proxy', hop: 'plain' },
    password: { set: true, setAt: '2026-10-01T12:00:00.000Z' },
    listening: { hosts: ['127.0.0.1'], adminPort: 7400, previewPort: 7401 },
    audit: { ok: true, file: '/x/panel/audit.log', lastError: null },
    files: { looseModes: [] },
  };
  const items = RA.healthItems(view);
  assert.deepEqual(items.map((i) => i.label), ['HTTPS', 'Password', 'Listening', 'Audit log', 'File permissions']);
  assert.equal(items[1].text, 'Set 2026-10-01');
  assert.equal(items[3].text, 'Writing to /x/panel/audit.log.');
  assert.equal(items[4].text, 'Private to your user.');
  assert.ok(items.every((i) => i.bad === false));
  const broken = RA.healthItems({ ...view, password: { set: false, setAt: null }, audit: { ok: false, file: '/x', lastError: { message: 'EISDIR' } }, files: { looseModes: ['/x/panel'] } });
  assert.equal(broken[1].bad, true);
  assert.equal(broken[1].text, 'Not set');
  assert.equal(broken[3].bad, true);
  assert.match(broken[3].text, /Cannot write \(EISDIR\)\. Changes from other devices are paused/);
  assert.equal(broken[4].bad, true);
  assert.match(broken[4].text, /Other users on this machine can read: \/x\/panel/);
  assert.equal(RA.healthItems({ mode: 'local', password: { set: false } })[1].text, 'Not needed in this mode');
});

test('addressRows: the external addresses (when there are any) then the loopback address', () => {
  assert.deepEqual(RA.addressRows({ addresses: { admin: 'https://scriptorium.home.arpa', preview: 'https://preview.scriptorium.home.arpa', adminLoopback: 'http://127.0.0.1:7400', previewLoopback: 'http://127.0.0.1:7401' } }), [
    { label: 'Admin panel', value: 'https://scriptorium.home.arpa' },
    { label: 'Preview', value: 'https://preview.scriptorium.home.arpa' },
    { label: 'On this machine', value: 'http://127.0.0.1:7400 (use the one-time link printed when it starts)' },
  ]);
  assert.deepEqual(RA.addressRows({ addresses: { admin: null, preview: null, adminLoopback: 'http://127.0.0.1:1' } }).map((r) => r.label), ['On this machine']);
});

// --- PV.previewSrc (A1) ------------------------------------------------------------------

const REMOTE = { via: 'remote', loopbackScheme: 'http', previewUrl: 'https://preview.scriptorium.home.arpa' };

test('PV.previewSrc, loopback local: exactly frameSrc / variantSrc, unchanged (FR-01)', () => {
  for (const access of [null, undefined, { via: 'loopback', loopbackScheme: 'http' }, { mode: 'local', via: 'loopback', loopbackScheme: 'http', previewUrl: null }]) {
    assert.equal(PV.previewSrc(access, '127.0.0.1', 51111, 'characters/example-person.html'), 'http://127.0.0.1:51111/characters/example-person.html');
    assert.equal(PV.previewSrc(access, 'localhost', 51111, 'a b/c.html', 'gloam'), 'http://localhost:51111/:variant/gloam/a%20b/c.html');
    assert.equal(PV.previewSrc(access, 'evil.example', 51111, 'a.html'), null, 'the loopback rule still refuses a non-loopback hostname');
  }
});

test('Mf8: PV.previewSrc, remote: an admin-relative /open-preview?to= URL that uses NEITHER the hostname NOR the port', () => {
  const src = PV.previewSrc(REMOTE, 'evil-hostname.example', 9999, 'characters/example-person.html');
  assert.equal(src, '/open-preview?to=characters%2Fexample-person.html');
  assert.ok(!src.includes('evil-hostname') && !src.includes('9999') && !src.includes('http'));
  assert.equal(PV.previewSrc(REMOTE, 'x', 1, 'a b/c.html', 'gloam'), '/open-preview?to=%3Avariant%2Fgloam%2Fa%20b%2Fc.html');
});

test('PV.previewSrc, remote: a loopback listener that serves TLS also goes through the hand-off (inert until V1.5b)', () => {
  assert.equal(PV.previewSrc({ via: 'loopback', loopbackScheme: 'https' }, '127.0.0.1', 5, 'a.html'), '/open-preview?to=a.html');
});

test('PV.previewSrc, remote: the rel rules are the same as frameSrc\'s (no leading /, no backslash, colon, query, fragment, no empty/dot segments, variant id shape)', () => {
  const bad = ['', undefined, null, 5, '/abs', 'a\\b', 'a:b', 'a?b', 'a#b', 'a//b', 'a/../b', './a', 'a/./b', '..', 'a/'];
  for (const rel of bad) assert.equal(PV.previewSrc(REMOTE, 'h', 1, rel), null, JSON.stringify(rel));
  for (const id of ['Bad', '1x', 'a b', 'a/b', 'a'.repeat(64), 5]) {
    assert.equal(PV.previewSrc(REMOTE, 'h', 1, 'a.html', id), null, JSON.stringify(id));
  }
  assert.equal(PV.previewSrc(REMOTE, 'h', 1, 'a.html', 'a'.repeat(63)), '/open-preview?to=' + encodeURIComponent(`:variant/${'a'.repeat(63)}/a.html`));
});

test('PV.openHref and PV.previewAddress: loopback keeps host:port, remote uses the hand-off and the configured preview host', () => {
  assert.equal(PV.openHref(null, '127.0.0.1', 51111, ''), 'http://127.0.0.1:51111/');
  assert.equal(PV.openHref(null, '127.0.0.1', 51111, 'a/b.html'), 'http://127.0.0.1:51111/a/b.html');
  assert.equal(PV.openHref(REMOTE, 'h', 1, ''), '/open-preview');
  assert.equal(PV.openHref(REMOTE, 'h', 1, 'a/b.html'), '/open-preview?to=a%2Fb.html');
  assert.equal(PV.previewAddress(null, '127.0.0.1', 51111, ''), '127.0.0.1:51111/');
  assert.equal(PV.previewAddress(null, 'localhost', 51111, 'a.html'), 'localhost:51111/a.html');
  assert.equal(PV.previewAddress(REMOTE, 'h', 1, ''), 'preview.scriptorium.home.arpa/');
  assert.equal(PV.previewAddress(REMOTE, 'h', 1, 'a.html'), 'preview.scriptorium.home.arpa/a.html');
  assert.equal(PV.previewAddress({ via: 'remote', previewUrl: 'https://panel-host.example-tailnet.ts.net:8443' }, 'h', 1, ''), 'panel-host.example-tailnet.ts.net:8443/');
});

// --- source rules the browser half must keep ------------------------------------------------

test('remote.js: no innerHTML or storage, every button typed, and only the three /api/ literals', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'remote.js'), 'utf8');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'localStorage', 'sessionStorage', 'eval(', 'fetch(', '.style']) assert.ok(!src.includes(bad), bad);
  assert.deepEqual([...new Set(src.match(/'\/api\/[a-z/-]*'/g))].sort(), ["'/api/remote'", "'/api/remote/signout'", "'/api/remote/signout-all'"]);
  assert.ok(src.includes("b.type = 'button'"));
});
