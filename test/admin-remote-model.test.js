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

test('lockoutLine (ADR 0054): open, with failures, paused names, a global pause (with the UTC time and the refused count)', () => {
  const open = { active: false, until: null, recentFailures: 0, refused: 0, pausedAccounts: [], pausedOther: 0 };
  assert.equal(RA.lockoutLine(open), 'Remote sign-in is open. Five wrong tries for one username in ten minutes would pause that username for fifteen.');
  assert.equal(
    RA.lockoutLine({ ...open, recentFailures: 1 }),
    'Remote sign-in is open. Five wrong tries for one username in ten minutes would pause that username for fifteen. 1 wrong try in the last ten minutes.',
  );
  assert.equal(
    RA.lockoutLine({ ...open, recentFailures: 3 }),
    'Remote sign-in is open. Five wrong tries for one username in ten minutes would pause that username for fifteen. 3 wrong tries in the last ten minutes.',
  );
  assert.equal(
    RA.lockoutLine({ ...open, pausedAccounts: ['rook', 'saffron'], pausedOther: 2 }),
    'Remote sign-in is open. Five wrong tries for one username in ten minutes would pause that username for fifteen. Paused now: rook, saffron, and 2 other usernames.',
  );
  assert.match(RA.lockoutLine({ ...open, pausedOther: 1 }), /Paused now: 1 other username\.$/);
  const until = Date.UTC(2026, 9, 3, 13, 45, 0);
  assert.equal(
    RA.lockoutLine({ ...open, active: true, until, refused: 3 }),
    'Remote sign-in is paused for everyone until 2026-10-03 13:45 UTC, after too many wrong tries across all usernames. 3 attempts have been turned away. The one-time link on this machine still works.',
  );
  assert.match(RA.lockoutLine({ ...open, active: true, until, refused: 1 }), /1 attempt has been turned away/);
  assert.equal(RA.lockoutLine({ active: false }), 'Remote sign-in is open. Five wrong tries for one username in ten minutes would pause that username for fifteen.', 'an older or partial answer still reads');
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

test('cliCommands: turn on or change, turn off, sign out every device, in that order, with neutral names (accounts are managed by the hint under the accounts list)', () => {
  for (const mode of ['local', 'ssh', 'tailscale', 'proxy', 'direct']) {
    const cmds = RA.cliCommands(mode);
    assert.deepEqual(cmds.map((c) => c.label), ['Turn on or change', 'Turn off', 'Sign out every device']);
    assert.match(cmds[0].command, /^gm-scriptorium remote set --mode /);
    assert.equal(cmds[1].command, 'gm-scriptorium remote off');
    assert.equal(cmds[2].command, 'gm-scriptorium remote signout-all');
  }
  assert.equal(RA.cliCommands('ssh')[0].command, 'gm-scriptorium remote set --mode ssh --port 7400 --preview-port 7401');
  assert.match(RA.cliCommands('tailscale')[0].command, /ts\.net/);
  assert.match(RA.cliCommands('proxy')[0].command, /--trusted-proxy 198\.51\.100\.20/);
  assert.doesNotMatch(JSON.stringify(RA.cliCommands('proxy')), /192\.168\./);
});

test('configNote: names the config path, and is empty without one', () => {
  assert.match(RA.configNote({ configPath: '/srv/gm/.config/scriptorium/config.toml' }), /\/srv\/gm\/\.config\/scriptorium\/config\.toml.*--config <path>/);
  assert.equal(RA.configNote({}), '');
  assert.equal(RA.configNote(null), '');
});

test('httpsShort has no "HTTPS" prefix (the pill carries the label), and httpsLine is the full sentence', () => {
  assert.equal(RA.httpsShort({ https: { by: 'proxy', hop: 'plain' } }), 'by your proxy, plain hop');
  assert.equal(RA.httpsShort({ https: { by: 'proxy', hop: 'tls' } }), 'by your proxy, encrypted hop');
  assert.equal(RA.httpsShort({ https: { by: 'tailscale', hop: null } }), 'by tailscale serve');
  assert.equal(RA.httpsShort({ https: { by: 'ssh', hop: null } }), 'not needed, SSH encrypts');
  assert.equal(RA.httpsShort({ https: { by: 'panel', hop: null } }), 'by GM-Scriptorium itself');
  assert.equal(RA.httpsShort({ https: { by: 'none', hop: null } }), 'not needed on this computer');
  assert.equal(RA.httpsShort(null), 'not needed on this computer');
});

test('healthItems: HTTPS, Accounts, Listening, Audit log, File permissions, each with a state; no label is repeated inside its own text (the "HTTPS: HTTPS:" stutter)', () => {
  const view = {
    mode: 'proxy',
    https: { by: 'proxy', hop: 'plain' },
    accounts: { state: 'set', list: [{ name: 'gm' }, { name: 'rook' }, { name: 'saffron' }] },
    listening: { hosts: ['192.0.2.42', '127.0.0.1'], adminPort: 7400, previewPort: 7401 },
    audit: { ok: true, file: '/x/panel/audit.log', lastError: null },
    files: { looseModes: [] },
  };
  const items = RA.healthItems(view);
  assert.deepEqual(items.map((i) => [i.label, i.text, i.state]), [
    ['HTTPS', 'by your proxy, plain hop', 'ok'],
    ['Accounts', '3 set', 'ok'],
    ['Listening', '7400, 7401 on 192.0.2.42 and 127.0.0.1', 'ok'],
    ['Audit log', 'writing', 'ok'],
    ['File permissions', 'private to your user', 'ok'],
  ]);
  for (const i of items) assert.ok(!i.text.toLowerCase().startsWith(i.label.toLowerCase()), i.label);
  assert.equal(RA.healthItems({ ...view, accounts: { state: 'set', list: [{ name: 'gm' }] } })[1].text, '1 set');
  const broken = RA.healthItems({ ...view, accounts: { state: 'unset', list: [] }, audit: { ok: false, file: '/x', lastError: { message: 'EISDIR' } }, files: { looseModes: ['/x/panel'] } });
  assert.deepEqual(broken.map((i) => i.state), ['ok', 'bad', 'ok', 'bad', 'warn']);
  assert.equal(broken[1].text, 'none set');
  assert.equal(broken[3].text, 'cannot write (EISDIR), remote changes paused');
  assert.equal(broken[4].text, 'other users can read: /x/panel');
  assert.equal(RA.healthItems({ ...view, accounts: { state: 'invalid', list: [] } })[1].text, 'the saved accounts cannot be read');
  assert.equal(RA.healthItems({ mode: 'local', accounts: { state: 'unset', list: [] } })[1].text, 'not needed in this mode');
  assert.equal(RA.healthItems({ mode: 'local', listening: { hosts: ['127.0.0.1'], adminPort: 1, previewPort: 2 } })[2].text, '127.0.0.1 only');
});

test('summaryRows (the "How you get in" card): per mode, the mock\'s rows', () => {
  const proxy = RA.summaryRows({
    mode: 'proxy',
    addresses: { admin: 'https://scriptorium.home.arpa', preview: 'https://preview.scriptorium.home.arpa', adminLoopback: 'http://127.0.0.1:7400' },
    listening: { hosts: ['192.0.2.42', '127.0.0.1'], adminPort: 7400, previewPort: 7401, answers: ['198.51.100.20', '127.0.0.1', '::1'] },
  });
  assert.deepEqual(proxy, [
    { label: 'Address', value: 'https://scriptorium.home.arpa', code: true },
    { label: 'Preview', value: 'https://preview.scriptorium.home.arpa', code: true },
    { label: 'Sign in', value: 'Your username and password. The one-time link still works on this machine.', code: false },
    { label: 'Listens on', value: 'Ports 7400, 7401 on 192.0.2.42 and 127.0.0.1, answering 198.51.100.20, 127.0.0.1, ::1', code: false },
  ]);
  const local = RA.summaryRows({ mode: 'local', addresses: { adminLoopback: 'http://127.0.0.1:51111' } });
  assert.deepEqual(local.map((r) => r.label), ['Address', 'Sign in', 'Listens on']);
  assert.equal(local[0].value, 'http://127.0.0.1:51111');
  const ssh = RA.summaryRows({ mode: 'ssh', addresses: { adminLoopback: 'http://127.0.0.1:7400', previewLoopback: 'http://127.0.0.1:7401' } });
  assert.deepEqual(ssh.map((r) => r.label), ['Address', 'Preview', 'Sign in', 'Listens on']);
  const ts = RA.summaryRows({ mode: 'tailscale', addresses: { admin: 'https://panel-host.example-tailnet.ts.net', preview: 'https://panel-host.example-tailnet.ts.net:8443' }, listening: { answers: [] } });
  assert.doesNotMatch(JSON.stringify(ts), /only your devices/i);
  assert.match(ts[3].value, /tailnet rules decide who can reach the address/);
});

test('accountRows (ADR 0054): name, the mark for the earlier password, when the password was set and the last sign-in, in UTC, relative to the clock given', () => {
  const now = Date.UTC(2026, 9, 12, 20, 0, 0);
  const rows = RA.accountRows(
    {
      accounts: {
        state: 'set',
        list: [
          { name: 'gm', setAt: '2026-09-12T21:40:00.000Z', fromEarlierPassword: true, lastSignin: '2026-10-12T18:05:00.000Z' },
          { name: 'rook', setAt: '2026-10-03T09:12:00.000Z', fromEarlierPassword: false, lastSignin: '2026-10-11T22:31:00.000Z' },
          { name: 'saffron', setAt: '2026-10-03T09:15:00.000Z', fromEarlierPassword: false, lastSignin: null },
          { name: 'old', setAt: '2026-01-05T00:00:00.000Z', fromEarlierPassword: false, lastSignin: '2026-10-01T07:08:00.000Z' },
        ],
      },
    },
    now,
  );
  assert.deepEqual(rows, [
    { name: 'gm', fromEarlier: true, setAt: '12 Sep 2026, 21:40 UTC', lastSignin: 'Today, 18:05 UTC' },
    { name: 'rook', fromEarlier: false, setAt: '03 Oct 2026, 09:12 UTC', lastSignin: 'Yesterday, 22:31 UTC' },
    { name: 'saffron', fromEarlier: false, setAt: '03 Oct 2026, 09:15 UTC', lastSignin: 'Never' },
    { name: 'old', fromEarlier: false, setAt: '05 Jan 2026, 00:00 UTC', lastSignin: '01 Oct 2026, 07:08 UTC' },
  ]);
  assert.deepEqual(RA.accountRows({ accounts: { state: 'unset', list: [] } }, now), []);
  assert.deepEqual(RA.accountRows({}, now), []);
  assert.deepEqual(RA.accountRows(null, now), []);
  assert.equal(RA.accountRows({ accounts: { list: [{ name: 'x', setAt: 'junk', lastSignin: 'junk' }] } }, now)[0].setAt, 'unknown');
});

test('accountsNote: what the screen says when there are none, and when the saved file is broken', () => {
  assert.equal(RA.accountsNote({ accounts: { state: 'set', list: [{ name: 'a' }] } }), 'These people can sign in to the console. Every account has the same rights. This list is read-only.');
  assert.equal(RA.accountsNote({ accounts: { state: 'unset', list: [] } }), 'No account can sign in remotely yet. Add one with the command below.');
  assert.equal(RA.accountsNote({ accounts: { state: 'cleared', list: [] } }), 'No account can sign in remotely yet. Add one with the command below.');
  assert.equal(RA.accountsNote({ accounts: { state: 'invalid', list: [] } }), 'The saved accounts cannot be read, so nobody can sign in remotely. Run "gm-scriptorium remote off" and add the accounts again.');
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
