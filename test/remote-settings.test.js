'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const s = require('../src/remote/settings');
const { ConfigError } = require('../src/util/errors');

/*
 * V1.5a (SD-a1, SD-a2, SD-a3, SD-a10, SD-a13, SD-a14). The settings model: parse, readiness, the
 * listen plan, the gate profile, the reach line, the startup text, and `remote set`'s validation.
 * Expected strings are typed independently from SD-doc sections 1, 4, 11 and 14.
 */

const PROXY = {
  mode: 'proxy',
  port: 7400,
  preview_port: 7401,
  admin_url: 'https://scriptorium.home.arpa',
  preview_url: 'https://preview.scriptorium.home.arpa',
  bind: '192.0.2.42',
  trusted_proxies: ['198.51.100.20'],
};
const TAILSCALE = {
  mode: 'tailscale',
  port: 7400,
  preview_port: 7401,
  admin_url: 'https://panel-host.example-tailnet.ts.net',
  preview_url: 'https://panel-host.example-tailnet.ts.net:8443',
};
const SSH = { mode: 'ssh', port: 7400, preview_port: 7401 };

function refuses(fn, text) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
    assert.equal(err.message, text);
    return true;
  });
}

test('constants: the five modes, the three tls choices, the ten keys', () => {
  assert.deepEqual([...s.REMOTE_MODES], ['local', 'ssh', 'tailscale', 'proxy', 'direct']);
  assert.deepEqual([...s.TLS_CHOICES], ['off', 'generated', 'byo']);
  assert.deepEqual([...s.REMOTE_KEYS], ['mode', 'port', 'preview_port', 'admin_url', 'preview_url', 'bind', 'trusted_proxies', 'tls', 'tls_cert', 'tls_key']);
  assert.deepEqual([...s.SETTABLE_MODES], ['local', 'ssh', 'tailscale', 'proxy']);
});

// --- parseRemoteTable --------------------------------------------------------

test('an absent table is exactly { mode: "local" }', () => {
  assert.deepEqual(s.parseRemoteTable(undefined), { mode: 'local' });
  assert.deepEqual(s.parseRemoteTable(null), { mode: 'local' });
  assert.deepEqual(s.parseRemoteTable({}), { mode: 'local' });
});

test('a full proxy table parses to canonical values', () => {
  const out = s.parseRemoteTable({
    mode: 'proxy',
    port: 7400,
    preview_port: '7401',
    admin_url: 'https://Scriptorium.Home.Arpa/',
    preview_url: 'https://preview.scriptorium.home.arpa:443',
    bind: '2001:DB8:0:0:0:0:0:2a',
    trusted_proxies: ['198.51.100.20', '::ffff:198.51.100.20', '2001:DB8::1'],
    tls: 'off',
  });
  assert.deepEqual(out, {
    mode: 'proxy',
    port: 7400,
    preview_port: 7401,
    admin_url: 'https://scriptorium.home.arpa',
    preview_url: 'https://preview.scriptorium.home.arpa',
    bind: '2001:db8::2a',
    trusted_proxies: ['198.51.100.20', '2001:db8::1'],
    tls: 'off',
  });
});

test('an unrecognised key is a hard error naming the key', () => {
  refuses(() => s.parseRemoteTable({ mode: 'proxy', trusted_proxy: ['198.51.100.20'] }), 'remote: unrecognised key "trusted_proxy"');
  refuses(() => s.parseRemoteTable({ pasword: 'x' }), 'remote: unrecognised key "pasword"');
});

test('shape errors: table, mode, ports, urls, bind, proxies, tls and paths', () => {
  refuses(() => s.parseRemoteTable('proxy'), 'remote must be a table');
  refuses(() => s.parseRemoteTable([]), 'remote must be a table');
  refuses(() => s.parseRemoteTable({ mode: 'open' }), 'remote: mode must be one of local, ssh, tailscale, proxy, direct');
  refuses(() => s.parseRemoteTable({ mode: 5 }), 'remote: mode must be one of local, ssh, tailscale, proxy, direct');
  refuses(() => s.parseRemoteTable({ port: 0 }), 'remote: port must be a whole number from 1 to 65535');
  refuses(() => s.parseRemoteTable({ preview_port: 70000 }), 'remote: preview_port must be a whole number from 1 to 65535');
  refuses(() => s.parseRemoteTable({ admin_url: 'http://scriptorium.home.arpa' }), 'remote access needs HTTPS: http://scriptorium.home.arpa');
  assert.throws(() => s.parseRemoteTable({ bind: 'example.test' }), ConfigError);
  refuses(() => s.parseRemoteTable({ trusted_proxies: [] }), 'remote: trusted_proxies must list 1 to 16 IP addresses');
  refuses(() => s.parseRemoteTable({ trusted_proxies: 'x' }), 'remote: trusted_proxies must list 1 to 16 IP addresses');
  refuses(
    () => s.parseRemoteTable({ trusted_proxies: Array.from({ length: 17 }, (_, i) => `198.51.100.${i + 1}`) }),
    'remote: trusted_proxies must list 1 to 16 IP addresses',
  );
  assert.throws(() => s.parseRemoteTable({ trusted_proxies: ['198.51.100.0/24'] }), ConfigError);
  assert.throws(() => s.parseRemoteTable({ trusted_proxies: ['*'] }), ConfigError);
  refuses(() => s.parseRemoteTable({ tls: 'yes' }), 'remote: tls must be one of off, generated, byo');
  refuses(() => s.parseRemoteTable({ tls_cert: 'relative/cert.pem' }), 'remote: tls_cert must be an absolute path');
  assert.equal(s.parseRemoteTable({ tls_key: '/etc/scriptorium/key.pem' }).tls_key, '/etc/scriptorium/key.pem');
});

test('keys that do not apply to the mode are kept, not dropped', () => {
  const out = s.parseRemoteTable({ mode: 'local', port: 7400, bind: '192.0.2.42' });
  assert.equal(out.port, 7400);
  assert.equal(out.bind, '192.0.2.42');
});

test('applicableKeys lists only what matters per mode', () => {
  assert.deepEqual(s.applicableKeys({ mode: 'local' }), ['mode']);
  assert.deepEqual(s.applicableKeys({ mode: 'ssh' }), ['mode', 'port', 'preview_port']);
  assert.deepEqual(s.applicableKeys({ mode: 'tailscale' }), ['mode', 'port', 'preview_port', 'admin_url', 'preview_url']);
  assert.deepEqual(s.applicableKeys({ mode: 'proxy' }), ['mode', 'port', 'preview_port', 'admin_url', 'preview_url', 'bind', 'trusted_proxies', 'tls']);
  assert.deepEqual(s.applicableKeys({ mode: 'direct', tls: 'byo' }), ['mode', 'port', 'preview_port', 'admin_url', 'preview_url', 'bind', 'tls', 'tls_cert', 'tls_key']);
});

// --- readiness ----------------------------------------------------------------

test('local and a complete ssh need nothing; a complete tailscale and proxy need only the password', () => {
  assert.deepEqual(s.readiness({ mode: 'local' }, { password: 'unset' }), []);
  assert.deepEqual(s.readiness(SSH, { password: 'unset' }), []);
  assert.deepEqual(s.readiness(TAILSCALE, { password: 'set' }), []);
  assert.deepEqual(s.readiness(PROXY, { password: 'set', tlsSupported: false }), []);
});

test('readiness messages, in the exact order of SD-doc section 14 step 6', () => {
  const ports = 'remote access (mode proxy) needs fixed ports: run "scriptorium remote set --port N --preview-port N"';
  const admin = 'remote access (mode proxy) needs an admin address: run "scriptorium remote set --admin-url https://..."';
  const preview = 'remote access (mode proxy) needs a preview address: run "scriptorium remote set --preview-url https://..."';
  const bind = 'remote access (mode proxy) needs a bind address: run "scriptorium remote set --bind ADDR"';
  const proxy = 'remote access (mode proxy) needs a trusted proxy address: run "scriptorium remote set --trusted-proxy ADDR"';
  const pw = 'remote access (mode proxy) needs a password: run "scriptorium remote password"';
  assert.deepEqual(s.readiness({ mode: 'proxy' }, { password: 'unset' }), [ports, admin, preview, bind, proxy, pw]);
  assert.deepEqual(s.readiness({ ...PROXY, port: undefined }, { password: 'set' }), [ports]);
  assert.deepEqual(s.readiness({ ...PROXY, preview_port: undefined }, { password: 'set' }), [ports]);
  assert.deepEqual(s.readiness({ ...PROXY, preview_port: 7400 }, { password: 'set' }), ['remote access (mode proxy): the panel and preview ports must differ']);
  assert.deepEqual(s.readiness({ ...PROXY, preview_url: PROXY.admin_url }, { password: 'set' }), ['remote access (mode proxy): the preview address must differ from the admin address']);
  assert.deepEqual(s.readiness({ ...PROXY, trusted_proxies: undefined }, { password: 'set' }), [proxy]);
  for (const state of ['unset', 'cleared', 'invalid']) assert.deepEqual(s.readiness(PROXY, { password: state }), [pw]);
});

test('ssh readiness: ports only, never an address or password', () => {
  assert.deepEqual(s.readiness({ mode: 'ssh' }, { password: 'unset' }), ['remote access (mode ssh) needs fixed ports: run "scriptorium remote set --port N --preview-port N"']);
  assert.deepEqual(s.readiness({ mode: 'ssh', port: 7400, preview_port: 7400 }, { password: 'unset' }), ['remote access (mode ssh): the panel and preview ports must differ']);
});

test('tailscale needs addresses and a password but no bind and no proxy', () => {
  const problems = s.readiness({ mode: 'tailscale', port: 7400, preview_port: 7401 }, { password: 'unset' });
  assert.deepEqual(problems, [
    'remote access (mode tailscale) needs an admin address: run "scriptorium remote set --admin-url https://..."',
    'remote access (mode tailscale) needs a preview address: run "scriptorium remote set --preview-url https://..."',
    'remote access (mode tailscale) needs a password: run "scriptorium remote password"',
  ]);
});

test('V1.5a refuses direct mode, and proxy with tls, as lacking certificate support (message 10, after the password)', () => {
  const direct = { ...PROXY, mode: 'direct', admin_url: 'https://192.0.2.42:7400', preview_url: 'https://192.0.2.42:7401' };
  delete direct.trusted_proxies;
  assert.deepEqual(s.readiness(direct, { password: 'set', tlsSupported: false }), ['remote access (mode direct) needs certificate support, which this version of GM-Scriptorium does not have']);
  assert.deepEqual(s.readiness({ ...PROXY, tls: 'generated' }, { password: 'unset', tlsSupported: false }), [
    'remote access (mode proxy) needs a password: run "scriptorium remote password"',
    'remote access (mode proxy) needs certificate support, which this version of GM-Scriptorium does not have',
  ]);
  assert.deepEqual(s.readiness({ ...PROXY, tls: 'generated' }, { password: 'set', tlsSupported: true }), []);
});

test('direct mode: the URL ports must match the listening ports', () => {
  const direct = { mode: 'direct', port: 7400, preview_port: 7401, admin_url: 'https://192.0.2.42:7500', preview_url: 'https://192.0.2.42', bind: '192.0.2.42' };
  assert.deepEqual(s.readiness(direct, { password: 'set', tlsSupported: true }), [
    'remote access (mode direct): the admin address must use port 7400, the port the panel listens on',
    'remote access (mode direct): the preview address must use port 7401, the port the preview listens on',
  ]);
});

// --- listenPlan ---------------------------------------------------------------

test('listenPlan: local uses the local listener and the flags (or 0)', () => {
  assert.deepEqual(s.listenPlan({ mode: 'local' }), { useLocalListener: true, admin: { hosts: ['127.0.0.1'], port: 0 }, preview: { hosts: ['127.0.0.1'], port: 0 }, allowPeers: null, tls: false });
  const plan = s.listenPlan({ mode: 'local' }, { flagPort: 9000, flagPreviewPort: 9001 });
  assert.equal(plan.admin.port, 9000);
  assert.equal(plan.preview.port, 9001);
});

test('listenPlan: ssh is the local listener on the settings ports', () => {
  assert.deepEqual(s.listenPlan(SSH), { useLocalListener: true, admin: { hosts: ['127.0.0.1'], port: 7400 }, preview: { hosts: ['127.0.0.1'], port: 7401 }, allowPeers: null, tls: false });
});

test('listenPlan: tailscale binds loopback only and admits only loopback peers', () => {
  assert.deepEqual(s.listenPlan(TAILSCALE), {
    useLocalListener: false,
    admin: { hosts: ['127.0.0.1'], port: 7400 },
    preview: { hosts: ['127.0.0.1'], port: 7401 },
    allowPeers: ['127.0.0.1', '::1'],
    tls: false,
  });
});

test('listenPlan: proxy binds [bind, 127.0.0.1] for a LAN address, and just [bind] for a wildcard or loopback', () => {
  const lan = s.listenPlan(PROXY);
  assert.deepEqual(lan.admin.hosts, ['192.0.2.42', '127.0.0.1']);
  assert.deepEqual(lan.preview.hosts, ['192.0.2.42', '127.0.0.1']);
  assert.deepEqual(lan.allowPeers, ['198.51.100.20', '127.0.0.1', '::1']);
  assert.equal(lan.useLocalListener, false);
  assert.deepEqual(s.listenPlan({ ...PROXY, bind: '0.0.0.0' }).admin.hosts, ['0.0.0.0']);
  assert.deepEqual(s.listenPlan({ ...PROXY, bind: '::' }).admin.hosts, ['::']);
  assert.deepEqual(s.listenPlan({ ...PROXY, bind: '127.0.0.1' }).admin.hosts, ['127.0.0.1']);
});

test('listenPlan: the trusted peers are deduplicated against the loopback set', () => {
  const plan = s.listenPlan({ ...PROXY, trusted_proxies: ['127.0.0.2', '127.0.0.1'] });
  assert.deepEqual(plan.allowPeers, ['127.0.0.2', '127.0.0.1', '::1']);
});

test('listenPlan: direct admits any peer (allowPeers null) on the same hosts as proxy', () => {
  const plan = s.listenPlan({ ...PROXY, mode: 'direct' });
  assert.equal(plan.allowPeers, null);
  assert.deepEqual(plan.admin.hosts, ['192.0.2.42', '127.0.0.1']);
});

test('listenPlan.tls is false in V1.5a for every mode', () => {
  for (const settings of [{ mode: 'local' }, SSH, TAILSCALE, PROXY, { ...PROXY, tls: 'generated' }, { ...PROXY, mode: 'direct' }]) {
    assert.equal(s.listenPlan(settings).tls, false, settings.mode);
  }
});

// --- gateProfile --------------------------------------------------------------

test('gateProfile is null for local and ssh', () => {
  assert.equal(s.gateProfile({ mode: 'local' }), null);
  assert.equal(s.gateProfile(SSH), null);
});

test('gateProfile for proxy: forwarded, trusted proxies, hosts and origins, frozen', () => {
  const p = s.gateProfile(PROXY);
  assert.deepEqual(p, {
    mode: 'proxy',
    remote: true,
    loopbackScheme: 'http',
    checkLoopbackPeer: true,
    forwarded: true,
    requireTls: false,
    trustedPeers: ['198.51.100.20'],
    admin: { host: 'scriptorium.home.arpa', origin: 'https://scriptorium.home.arpa' },
    preview: { host: 'preview.scriptorium.home.arpa', origin: 'https://preview.scriptorium.home.arpa' },
  });
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.admin));
  assert.ok(Object.isFrozen(p.trustedPeers));
});

test('gateProfile for tailscale: forwarded, loopback is the trusted proxy, the host keeps a non-default port', () => {
  const p = s.gateProfile(TAILSCALE);
  assert.equal(p.forwarded, true);
  assert.deepEqual(p.trustedPeers, ['127.0.0.1', '::1']);
  assert.deepEqual(p.preview, { host: 'panel-host.example-tailnet.ts.net:8443', origin: 'https://panel-host.example-tailnet.ts.net:8443' });
  assert.equal(p.admin.host, 'panel-host.example-tailnet.ts.net');
});

test('gateProfile for direct: requireTls, not forwarded, no trusted peers; loopbackScheme follows the tls argument', () => {
  const direct = { ...PROXY, mode: 'direct', admin_url: 'https://192.0.2.42:7400', preview_url: 'https://192.0.2.42:7401' };
  const p = s.gateProfile(direct, { tls: true });
  assert.equal(p.requireTls, true);
  assert.equal(p.forwarded, false);
  assert.deepEqual(p.trustedPeers, []);
  assert.equal(p.loopbackScheme, 'https');
  assert.equal(s.gateProfile(direct, { tls: false }).loopbackScheme, 'http');
});

// --- reachLine ----------------------------------------------------------------

test('reachLine per mode (local is today\'s wording, unchanged)', () => {
  assert.equal(s.reachLine({ mode: 'local' }), 'Bound to 127.0.0.1 only');
  assert.equal(s.reachLine(SSH), 'Bound to 127.0.0.1 only, for an SSH tunnel');
  assert.equal(s.reachLine(TAILSCALE), 'Reachable at https://panel-host.example-tailnet.ts.net through tailscale serve, and on this machine');
  assert.equal(s.reachLine(PROXY), 'Reachable at https://scriptorium.home.arpa through your proxy, and on this machine');
  assert.equal(s.reachLine({ ...PROXY, mode: 'direct' }), 'Reachable at https://scriptorium.home.arpa on your network, and on this machine');
});

// --- startupText --------------------------------------------------------------

test('startupText local: no pre lines, exactly today\'s three post lines', () => {
  const t = s.startupText({ mode: 'local' }, s.listenPlan({ mode: 'local' }), { adminPort: 51111, previewPort: 51112, token: 'TOK' });
  assert.deepEqual(t, {
    pre: [],
    post: [
      'admin panel: http://127.0.0.1:51111/auth?token=TOK',
      'preview: http://127.0.0.1:51112/',
      'open the admin panel link in your browser. Press Ctrl-C to stop.',
    ],
  });
});

test('startupText ssh: the pre line, and the exact tunnel command with matching local ports', () => {
  const t = s.startupText(SSH, s.listenPlan(SSH), { adminPort: 7400, previewPort: 7401, token: 'TOK', user: 'gm', host: 'panel-host' });
  assert.deepEqual(t.pre, ['remote access: ssh tunnel (the panel listens on 127.0.0.1 only)']);
  assert.deepEqual(t.post, [
    'admin panel: http://127.0.0.1:7400/auth?token=TOK',
    'preview: http://127.0.0.1:7401/',
    'tunnel from your desktop: ssh -L 7400:127.0.0.1:7400 -L 7401:127.0.0.1:7401 gm@panel-host',
    'open the admin panel link in your browser. Press Ctrl-C to stop.',
  ]);
});

test('startupText proxy: the WARNING names the proxy and the bind, then the five post lines', () => {
  const t = s.startupText(PROXY, s.listenPlan(PROXY), { adminPort: 7400, previewPort: 7401, token: 'TOK' });
  assert.deepEqual(t.pre, ['WARNING: remote access is on (mode proxy). It answers 198.51.100.20 (your proxy) and this machine, on 192.0.2.42 ports 7400 and 7401.']);
  assert.deepEqual(t.post, [
    'remote admin panel: https://scriptorium.home.arpa/ (sign in with the panel password)',
    'remote preview: https://preview.scriptorium.home.arpa/',
    'listening on 192.0.2.42 and 127.0.0.1 port 7400 (panel) and 7401 (preview)',
    'on this machine: http://127.0.0.1:7400/auth?token=TOK',
    'Press Ctrl-C to stop.',
  ]);
});

test('startupText tailscale: the tailnet access-rules sentence, never "only your devices"', () => {
  const t = s.startupText(TAILSCALE, s.listenPlan(TAILSCALE), { adminPort: 7400, previewPort: 7401, token: 'TOK' });
  assert.deepEqual(t.pre, ["WARNING: remote access is on (mode tailscale). Any device your tailnet's access rules allow can reach its sign-in page through tailscale serve."]);
  assert.doesNotMatch(t.pre.join(' '), /only your devices/i);
  assert.equal(t.post[2], 'listening on 127.0.0.1 port 7400 (panel) and 7401 (preview)');
});

test('startupText direct: the wildcard reads "every address of this machine"', () => {
  const direct = { ...PROXY, mode: 'direct', bind: '0.0.0.0' };
  const t = s.startupText(direct, s.listenPlan(direct), { adminPort: 7400, previewPort: 7401, token: 'TOK', loopbackScheme: 'https' });
  assert.deepEqual(t.pre, ['WARNING: remote access is on (mode direct). Anything that can reach every address of this machine on ports 7400 and 7401 can reach its sign-in page.']);
  assert.equal(t.post[3], 'on this machine: https://127.0.0.1:7400/auth?token=TOK');
});

// --- applyRemoteChange --------------------------------------------------------

test('applyRemoteChange validates each value, applies it, and reports the changed keys', () => {
  const { next, changed } = s.applyRemoteChange(undefined, {
    mode: 'proxy',
    port: '7400',
    'preview-port': '7401',
    'admin-url': 'https://Scriptorium.Home.Arpa',
    'preview-url': 'https://preview.scriptorium.home.arpa',
    bind: '192.0.2.42',
    'trusted-proxy': '198.51.100.20, 2001:DB8::1',
  });
  assert.deepEqual(next, {
    mode: 'proxy',
    port: 7400,
    preview_port: 7401,
    admin_url: 'https://scriptorium.home.arpa',
    preview_url: 'https://preview.scriptorium.home.arpa',
    bind: '192.0.2.42',
    trusted_proxies: ['198.51.100.20', '2001:db8::1'],
  });
  assert.deepEqual(changed, ['mode', 'port', 'preview_port', 'admin_url', 'preview_url', 'bind', 'trusted_proxies']);
});

test('applyRemoteChange keeps untouched keys, and reports only real changes', () => {
  const { next, changed } = s.applyRemoteChange({ ...PROXY, tls: 'off' }, { port: '7400', bind: '192.0.2.43' });
  assert.equal(next.tls, 'off');
  assert.equal(next.admin_url, PROXY.admin_url);
  assert.equal(next.bind, '192.0.2.43');
  assert.deepEqual(changed, ['bind']);
});

test('applyRemoteChange does not mutate its input', () => {
  const input = { ...PROXY, trusted_proxies: [...PROXY.trusted_proxies] };
  const copy = JSON.parse(JSON.stringify(input));
  s.applyRemoteChange(input, { mode: 'local', 'trusted-proxy': '198.51.100.21' });
  assert.deepEqual(input, copy);
});

test('applyRemoteChange refuses bad values with the validators\' own messages, and direct (V1.5b)', () => {
  refuses(() => s.applyRemoteChange({}, { mode: 'direct' }), '--mode must be one of local, ssh, tailscale, proxy');
  refuses(() => s.applyRemoteChange({}, { mode: 'banana' }), '--mode must be one of local, ssh, tailscale, proxy');
  refuses(() => s.applyRemoteChange({}, { port: '0' }), '--port must be a whole number from 1 to 65535');
  refuses(() => s.applyRemoteChange({}, { 'preview-port': '99999' }), '--preview-port must be a whole number from 1 to 65535');
  refuses(() => s.applyRemoteChange({}, { 'admin-url': 'http://scriptorium.home.arpa' }), 'remote access needs HTTPS: http://scriptorium.home.arpa');
  refuses(() => s.applyRemoteChange({}, { mode: true }), '--mode needs a value');
  assert.throws(() => s.applyRemoteChange({}, { 'trusted-proxy': '198.51.100.20,nope' }), ConfigError);
  assert.throws(() => s.applyRemoteChange({}, { bind: 'example.test' }), ConfigError);
});
