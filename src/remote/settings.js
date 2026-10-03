'use strict';

const path = require('path');
const { ConfigError } = require('../util/errors');
const validate = require('../setup/validate');
const addr = require('./addr');

/*
 * V1.5a (docs/decisions/0029-remote-access.md, sections 1, 2, 4 and 6; SD-doc sections 1, 4, 5,
 * 11 and 14). The remote-access settings model and everything derived from it, in one pure module
 * with no UI of its own, so V7's browser setup can offer the same choices by calling it.
 *
 *  - parseRemoteTable: the `[remote]` table in config.toml, shape-checked as a WHOLE. An unknown key
 *    is a hard error, because a typo in a security setting must not silently become a default.
 *  - readiness: whether the settings are complete enough to start. serve --admin refuses, with one
 *    line, before any socket opens; it never falls back to a wider bind.
 *  - listenPlan: the ONLY source of the hosts a listener may bind (src/serve/server.js).
 *  - gateProfile: the request gate's view of the settings (src/admin/gate.js).
 *  - reachLine and startupText: the words the footer and the console use.
 *
 * direct mode and the `tls` choices exist in the schema from day one, so V1.5b never changes its
 * shape; V1.5a's readiness refuses them with a clear message.
 */

const REMOTE_MODES = Object.freeze(['local', 'ssh', 'tailscale', 'proxy', 'direct']);
/** What `scriptorium remote set --mode` accepts now. V1.5b adds 'direct'. */
const SETTABLE_MODES = Object.freeze(['local', 'ssh', 'tailscale', 'proxy']);
const TLS_CHOICES = Object.freeze(['off', 'generated', 'byo']);
const REMOTE_KEYS = Object.freeze(['mode', 'port', 'preview_port', 'admin_url', 'preview_url', 'bind', 'trusted_proxies', 'tls', 'tls_cert', 'tls_key']);

const WILDCARD_BINDS = Object.freeze(['0.0.0.0', '::']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function showKey(k) {
  return String(k).slice(0, 64);
}

function validateTrustedProxies(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) {
    throw new ConfigError('remote: trusted_proxies must list 1 to 16 IP addresses');
  }
  const out = [];
  for (const entry of raw) {
    const canonical = validate.validateIpLiteral(entry);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

function validateAbsolutePath(raw, key) {
  if (typeof raw !== 'string' || raw === '' || !(path.isAbsolute(raw) || path.win32.isAbsolute(raw))) {
    throw new ConfigError(`remote: ${key} must be an absolute path`);
  }
  return raw;
}

/**
 * @param {unknown} raw config.remote (undefined when the table is absent)
 * @returns {{ mode: string, port?: number, preview_port?: number, admin_url?: string, preview_url?: string, bind?: string, trusted_proxies?: string[], tls?: string, tls_cert?: string, tls_key?: string }}
 * @throws {ConfigError}
 */
function parseRemoteTable(raw) {
  if (raw === undefined || raw === null) return { mode: 'local' };
  if (!isPlainObject(raw)) throw new ConfigError('remote must be a table');
  for (const key of Object.keys(raw)) {
    if (!REMOTE_KEYS.includes(key)) throw new ConfigError(`remote: unrecognised key "${showKey(key)}"`);
  }
  const out = {};
  const mode = raw.mode === undefined ? 'local' : raw.mode;
  if (typeof mode !== 'string' || !REMOTE_MODES.includes(mode)) {
    throw new ConfigError(`remote: mode must be one of ${REMOTE_MODES.join(', ')}`);
  }
  out.mode = mode;
  if (raw.port !== undefined) out.port = validate.validatePort(raw.port, 'remote: port');
  if (raw.preview_port !== undefined) out.preview_port = validate.validatePort(raw.preview_port, 'remote: preview_port');
  if (raw.admin_url !== undefined) out.admin_url = validate.validateExternalUrl(raw.admin_url);
  if (raw.preview_url !== undefined) out.preview_url = validate.validateExternalUrl(raw.preview_url);
  if (raw.bind !== undefined) out.bind = validate.validateIpLiteral(raw.bind);
  if (raw.trusted_proxies !== undefined) out.trusted_proxies = validateTrustedProxies(raw.trusted_proxies);
  if (raw.tls !== undefined) {
    if (typeof raw.tls !== 'string' || !TLS_CHOICES.includes(raw.tls)) {
      throw new ConfigError(`remote: tls must be one of ${TLS_CHOICES.join(', ')}`);
    }
    out.tls = raw.tls;
  }
  if (raw.tls_cert !== undefined) out.tls_cert = validateAbsolutePath(raw.tls_cert, 'tls_cert');
  if (raw.tls_key !== undefined) out.tls_key = validateAbsolutePath(raw.tls_key, 'tls_key');
  return out;
}

/** The keys that mean something in the current mode (the others are kept in the file, ignored). */
function applicableKeys(settings) {
  const mode = settings.mode;
  const keys = ['mode'];
  if (mode === 'local') return keys;
  keys.push('port', 'preview_port');
  if (mode === 'ssh') return keys;
  keys.push('admin_url', 'preview_url');
  if (mode === 'tailscale') return keys;
  keys.push('bind');
  if (mode === 'proxy') keys.push('trusted_proxies');
  keys.push('tls');
  if (settings.tls === 'byo') keys.push('tls_cert', 'tls_key');
  return keys;
}

function proxyOrDirect(mode) {
  return mode === 'proxy' || mode === 'direct';
}

function effectiveTls(settings) {
  return proxyOrDirect(settings.mode) ? settings.tls || 'off' : 'off';
}

/**
 * @param {ReturnType<typeof parseRemoteTable>} settings
 * @param {{ password: 'set'|'unset'|'cleared'|'invalid', tlsSupported?: boolean }} ctx
 * @returns {string[]} the problems, in the sequence startup reports them (empty when ready)
 */
function readiness(settings, { password, tlsSupported = false }) {
  const m = settings.mode;
  if (m === 'local') return [];
  const problems = [];
  const label = `remote access (mode ${m})`;
  const needsAddresses = m !== 'ssh';
  if (settings.port === undefined || settings.preview_port === undefined) {
    problems.push(`${label} needs fixed ports: run "scriptorium remote set --port N --preview-port N"`);
  } else if (settings.port === settings.preview_port) {
    problems.push(`${label}: the panel and preview ports must differ`);
  }
  if (needsAddresses) {
    if (settings.admin_url === undefined) problems.push(`${label} needs an admin address: run "scriptorium remote set --admin-url https://..."`);
    if (settings.preview_url === undefined) problems.push(`${label} needs a preview address: run "scriptorium remote set --preview-url https://..."`);
    if (settings.admin_url !== undefined && settings.preview_url !== undefined && settings.admin_url === settings.preview_url) {
      problems.push(`${label}: the preview address must differ from the admin address`);
    }
  }
  if (proxyOrDirect(m) && settings.bind === undefined) problems.push(`${label} needs a bind address: run "scriptorium remote set --bind ADDR"`);
  if (m === 'proxy' && (settings.trusted_proxies === undefined || settings.trusted_proxies.length === 0)) {
    problems.push('remote access (mode proxy) needs a trusted proxy address: run "scriptorium remote set --trusted-proxy ADDR"');
  }
  if (m === 'direct') {
    if (settings.admin_url !== undefined && settings.port !== undefined && new URL(settings.admin_url).port !== String(settings.port)) {
      problems.push(`remote access (mode direct): the admin address must use port ${settings.port}, the port the panel listens on`);
    }
    if (settings.preview_url !== undefined && settings.preview_port !== undefined && new URL(settings.preview_url).port !== String(settings.preview_port)) {
      problems.push(`remote access (mode direct): the preview address must use port ${settings.preview_port}, the port the preview listens on`);
    }
  }
  if (m !== 'ssh' && password !== 'set') problems.push(`${label} needs a password: run "scriptorium remote password"`);
  if (!tlsSupported && (m === 'direct' || (m === 'proxy' && effectiveTls(settings) !== 'off'))) {
    problems.push(`${label} needs certificate support, which this version of GM-Scriptorium does not have`);
  }
  return problems;
}

/**
 * @param {ReturnType<typeof parseRemoteTable>} settings
 * @param {{ flagPort?: number, flagPreviewPort?: number }} [flags]
 * @returns {{ useLocalListener: boolean, admin: { hosts: string[], port: number }, preview: { hosts: string[], port: number }, allowPeers: string[]|null, tls: boolean }}
 */
function listenPlan(settings, { flagPort = 0, flagPreviewPort = 0 } = {}) {
  const m = settings.mode;
  if (m === 'local') {
    return { useLocalListener: true, admin: { hosts: ['127.0.0.1'], port: flagPort }, preview: { hosts: ['127.0.0.1'], port: flagPreviewPort }, allowPeers: null, tls: false };
  }
  const ports = { admin: settings.port, preview: settings.preview_port };
  if (m === 'ssh') {
    return { useLocalListener: true, admin: { hosts: ['127.0.0.1'], port: ports.admin }, preview: { hosts: ['127.0.0.1'], port: ports.preview }, allowPeers: null, tls: false };
  }
  let hosts;
  let allowPeers;
  if (m === 'tailscale') {
    hosts = ['127.0.0.1'];
    allowPeers = [...addr.LOOPBACK_PEERS];
  } else {
    const bind = settings.bind;
    hosts = WILDCARD_BINDS.includes(bind) || bind === '127.0.0.1' ? [bind] : [bind, '127.0.0.1'];
    allowPeers = m === 'proxy' ? [...new Set([...(settings.trusted_proxies || []), ...addr.LOOPBACK_PEERS])] : null;
  }
  return { useLocalListener: false, admin: { hosts: [...hosts], port: ports.admin }, preview: { hosts: [...hosts], port: ports.preview }, allowPeers, tls: false };
}

/**
 * The request gate's view of the settings: null for local and ssh (the gate then behaves exactly
 * as it always has), otherwise a frozen profile.
 *
 * @param {ReturnType<typeof parseRemoteTable>} settings
 * @param {{ adminPort?: number, previewPort?: number, tls?: boolean }} [opts]
 */
function gateProfile(settings, { tls = false } = {}) {
  const m = settings.mode;
  if (m === 'local' || m === 'ssh') return null;
  const admin = new URL(settings.admin_url);
  const preview = new URL(settings.preview_url);
  return Object.freeze({
    mode: m,
    remote: true,
    loopbackScheme: tls ? 'https' : 'http',
    checkLoopbackPeer: true,
    forwarded: m === 'proxy' || m === 'tailscale',
    requireTls: m === 'direct',
    trustedPeers: Object.freeze(m === 'proxy' ? [...(settings.trusted_proxies || [])] : m === 'tailscale' ? [...addr.LOOPBACK_PEERS] : []),
    admin: Object.freeze({ host: admin.host, origin: admin.origin }),
    preview: Object.freeze({ host: preview.host, origin: preview.origin }),
  });
}

/** The footer's reach line (shown in the panel's frame). Local is today's wording, unchanged. */
function reachLine(settings) {
  switch (settings.mode) {
    case 'ssh':
      return 'Bound to 127.0.0.1 only, for an SSH tunnel';
    case 'tailscale':
      return `Reachable at ${settings.admin_url} through tailscale serve, and on this machine`;
    case 'proxy':
      return `Reachable at ${settings.admin_url} through your proxy, and on this machine`;
    case 'direct':
      return `Reachable at ${settings.admin_url} on your network, and on this machine`;
    default:
      return 'Bound to 127.0.0.1 only';
  }
}

function warningSentence(settings, plan) {
  const ports = `${plan.admin.port} and ${plan.preview.port}`;
  if (settings.mode === 'tailscale') return "Any device your tailnet's access rules allow can reach its sign-in page through tailscale serve.";
  if (settings.mode === 'proxy') return `It answers ${settings.trusted_proxies.join(', ')} (your proxy) and this machine, on ${settings.bind} ports ${ports}.`;
  const where = WILDCARD_BINDS.includes(settings.bind) ? 'every address of this machine' : settings.bind;
  return `Anything that can reach ${where} on ports ${ports} can reach its sign-in page.`;
}

/**
 * The console lines for a mode: `pre` BEFORE any listener opens (ADR 0002's ordering), `post`
 * after both are listening. Local mode's `post` is exactly the three lines that have always been
 * printed.
 *
 * @param {ReturnType<typeof parseRemoteTable>} settings
 * @param {ReturnType<typeof listenPlan>} plan
 * @param {{ adminPort: number, previewPort: number, token: string, loopbackScheme?: string, user?: string, host?: string }} info
 * @returns {{ pre: string[], post: string[] }}
 */
function startupText(settings, plan, { adminPort, previewPort, token, loopbackScheme = 'http', user = 'USER', host = 'HOST' }) {
  const m = settings.mode;
  const tokenUrl = (scheme) => `${scheme}://127.0.0.1:${adminPort}/auth?token=${token}`;
  if (m === 'local') {
    return {
      pre: [],
      post: [`admin panel: ${tokenUrl('http')}`, `preview: http://127.0.0.1:${previewPort}/`, 'open the admin panel link in your browser. Press Ctrl-C to stop.'],
    };
  }
  if (m === 'ssh') {
    return {
      pre: ['remote access: ssh tunnel (the panel listens on 127.0.0.1 only)'],
      post: [
        `admin panel: ${tokenUrl('http')}`,
        `preview: http://127.0.0.1:${previewPort}/`,
        `tunnel from your desktop: ssh -L ${adminPort}:127.0.0.1:${adminPort} -L ${previewPort}:127.0.0.1:${previewPort} ${user}@${host}`,
        'open the admin panel link in your browser. Press Ctrl-C to stop.',
      ],
    };
  }
  return {
    pre: [`WARNING: remote access is on (mode ${m}). ${warningSentence(settings, { admin: { port: adminPort }, preview: { port: previewPort } })}`],
    post: [
      `remote admin panel: ${settings.admin_url}/ (sign in with the panel password)`,
      `remote preview: ${settings.preview_url}/`,
      `listening on ${plan.admin.hosts.join(' and ')} port ${adminPort} (panel) and ${previewPort} (preview)`,
      `on this machine: ${tokenUrl(loopbackScheme)}`,
      'Press Ctrl-C to stop.',
    ],
  };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function needValue(flags, name) {
  const v = flags[name];
  if (typeof v !== 'string' || v === '') throw new ConfigError(`--${name} needs a value`);
  return v;
}

/**
 * Applies `scriptorium remote set` flags to the raw `[remote]` table, validating each value as it
 * is given. Pure: nothing is written. The caller then runs parseRemoteTable on `next` (a shape
 * error there means nothing is written either).
 *
 * @param {unknown} raw the existing config.remote (may be undefined)
 * @param {object} flags parsed argv flags
 * @returns {{ next: object, changed: string[] }}
 */
function applyRemoteChange(raw, flags) {
  const base = isPlainObject(raw) ? JSON.parse(JSON.stringify(raw)) : {};
  const next = { ...base };
  if (flags.mode !== undefined) {
    const v = needValue(flags, 'mode');
    if (!SETTABLE_MODES.includes(v)) throw new ConfigError(`--mode must be one of ${SETTABLE_MODES.join(', ')}`);
    next.mode = v;
  }
  if (flags.port !== undefined) next.port = validate.validatePort(needValue(flags, 'port'), '--port');
  if (flags['preview-port'] !== undefined) next.preview_port = validate.validatePort(needValue(flags, 'preview-port'), '--preview-port');
  if (flags['admin-url'] !== undefined) next.admin_url = validate.validateExternalUrl(needValue(flags, 'admin-url'));
  if (flags['preview-url'] !== undefined) next.preview_url = validate.validateExternalUrl(needValue(flags, 'preview-url'));
  if (flags.bind !== undefined) next.bind = validate.validateIpLiteral(needValue(flags, 'bind'));
  if (flags['trusted-proxy'] !== undefined) {
    next.trusted_proxies = validateTrustedProxies(needValue(flags, 'trusted-proxy').split(',').map((s) => s.trim()));
  }
  const changed = REMOTE_KEYS.filter((k) => !sameJson(base[k], next[k]));
  return { next, changed };
}

module.exports = {
  REMOTE_MODES,
  SETTABLE_MODES,
  TLS_CHOICES,
  REMOTE_KEYS,
  parseRemoteTable,
  applicableKeys,
  readiness,
  listenPlan,
  gateProfile,
  reachLine,
  startupText,
  applyRemoteChange,
};
