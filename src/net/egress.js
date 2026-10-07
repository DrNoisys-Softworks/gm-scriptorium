'use strict';

const http = require('http');
const https = require('https');
const { NetError } = require('./errors');

/*
 * The one module that makes outgoing connections (ADR 0024). Nothing in the command-line tool
 * reaches it yet.
 *
 * What it does:
 *  - Reaches only the entries of DESTINATIONS, a list written in this file. Nothing in a config
 *    file, the environment, a flag or a request can add to it. A URL that does not match an entry
 *    exactly (scheme, host, port) is refused before any name lookup, agent or socket exists.
 *  - Allows plain http only to a 127.0.0.0/8 address, checked when the list is built and again
 *    when a URL is matched.
 *  - Verifies TLS on every https request and gives a request no way to change that. The shipped
 *    client sets no trust list of its own.
 *  - Treats every redirect as an error and never reads where it pointed.
 *  - Never reads proxy settings: each client owns a private agent.
 *  - Limits connect time, idle time and total time, honours an abort signal, and cuts a reply at a
 *    byte cap.
 *  - Builds every error fresh, from a fixed table, with no URL, header, body or reply text.
 *
 * What it will not catch, deliberately (the full list is in the decision record):
 *  - a listed destination that is itself compromised or forwards what it is sent;
 *  - how the machine's resolver answers for a listed remote name (the local entries are IP
 *    literals, and https verification limits the damage for a remote name);
 *  - trust the machine owner adds at launch for Node as a whole, and a wrong system clock;
 *  - any program listening on the two local ports;
 *  - what a reply says (its size is capped, its meaning is not judged);
 *  - a hard kill in the middle of a request;
 *  - Windows socket behaviour, which only a run of the real executable can show.
 */

const DEFAULTS = deepFreeze({
  connectTimeoutMs: 10000,
  idleTimeoutMs: 120000,
  totalTimeoutMs: 600000,
  maxResponseBytes: 16777216,
});

const REAL_LOCAL_PORTS = Object.freeze([11434, 1234]);
const OPTION_KEYS = new Set([
  'destination', 'url', 'method', 'headers', 'body', 'signal',
  'connectTimeoutMs', 'idleTimeoutMs', 'totalTimeoutMs', 'maxResponseBytes',
  'onResponse', 'onChunk',
]);
const LIMIT_KEYS = ['connectTimeoutMs', 'idleTimeoutMs', 'totalTimeoutMs', 'maxResponseBytes'];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REFUSED_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'expect', 'keep-alive', 'te', 'trailer',
]);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function badOptions(reason) {
  return new NetError('E_NET_BAD_OPTIONS', { reason });
}

function isLoopbackIpv4(host) {
  if (typeof host !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1);
  for (const o of octets) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(o) || Number(o) > 255) return false;
  }
  return Number(octets[0]) === 127;
}

function validateDestinations(list) {
  const fail = () => badOptions('destinations');
  if (!Array.isArray(list)) throw fail();
  const seen = new Set();
  const copy = [];
  for (const e of list) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw fail();
    const keys = Object.keys(e).sort();
    if (keys.join(',') !== 'host,id,port,scheme') throw fail();
    const { id, scheme, host, port } = e;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id) || seen.has(id)) throw fail();
    if (scheme !== 'http' && scheme !== 'https') throw fail();
    if (typeof host !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(host) || host.endsWith('.')) throw fail();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail();
    if (scheme === 'http' && !isLoopbackIpv4(host)) throw fail();
    seen.add(id);
    copy.push({ id, scheme, host, port });
  }
  return deepFreeze(copy);
}

const DESTINATIONS = validateDestinations([
  { id: 'ollama', scheme: 'http', host: '127.0.0.1', port: 11434 },
  { id: 'lmstudio', scheme: 'http', host: '127.0.0.1', port: 1234 },
]);

function matchDestination(urlString, destinations, id) {
  if (typeof urlString !== 'string') throw new NetError('E_NET_BAD_URL');
  let url;
  try {
    url = new URL(urlString);
  } catch (_) {
    throw new NetError('E_NET_BAD_URL');
  }
  const refuse = (reason) => new NetError('E_NET_REFUSED', { destination: id, reason });
  const entry = Array.isArray(destinations) && typeof id === 'string' ? destinations.find((d) => d.id === id) : undefined;
  if (!entry) throw refuse('unknown-destination');
  if (url.username !== '' || url.password !== '') throw refuse('userinfo');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse('scheme');
  if (url.protocol !== entry.scheme + ':') throw refuse('scheme');
  if (url.hostname !== entry.host) throw refuse('host');
  const effective = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (effective !== entry.port) throw refuse('port');
  if (url.protocol === 'http:' && !isLoopbackIpv4(url.hostname)) throw refuse('plain-http');
  return { entry, url };
}

function checkHeaders(headers) {
  if (headers === undefined) return {};
  const proto = headers === null || typeof headers !== 'object' ? undefined : Object.getPrototypeOf(headers);
  if (proto !== Object.prototype && proto !== null) throw badOptions('header');
  const out = {};
  for (const name of Object.keys(headers)) {
    const value = headers[name];
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || REFUSED_HEADERS.has(lower) || lower.startsWith('proxy-')) throw badOptions('header');
    if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) throw badOptions('header');
    out[name] = value;
  }
  return out;
}

function checkOptions(opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw badOptions('options');
  for (const key of Object.keys(opts)) if (!OPTION_KEYS.has(key)) throw badOptions('unknown-option');
  if (typeof opts.destination !== 'string') throw badOptions('destination');
  const method = opts.method === undefined ? 'GET' : opts.method;
  if (method !== 'GET' && method !== 'POST') throw badOptions('method');
  const headers = checkHeaders(opts.headers);
  let body;
  if (opts.body !== undefined) {
    if (method !== 'POST') throw badOptions('body');
    if (typeof opts.body === 'string') body = Buffer.from(opts.body, 'utf8');
    else if (Buffer.isBuffer(opts.body)) body = opts.body;
    else throw badOptions('body');
  }
  if (opts.signal !== undefined && !(opts.signal instanceof AbortSignal)) throw badOptions('signal');
  const limits = {};
  for (const key of LIMIT_KEYS) {
    const v = opts[key] === undefined ? DEFAULTS[key] : opts[key];
    if (!Number.isSafeInteger(v) || v < 1) throw badOptions('limit');
    limits[key] = v;
  }
  for (const key of ['onResponse', 'onChunk']) {
    if (opts[key] !== undefined && typeof opts[key] !== 'function') throw badOptions('callback');
  }
  return { method, headers, body, limits };
}

function codeOf(err) {
  return err && typeof err.code === 'string' && SAFE_CODE.test(err.code) ? err.code : undefined;
}

function createClient(destinations, testCa) {
  const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 4 });
  const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 4 });

  async function request(opts) {
    const { method, headers, body, limits } = checkOptions(opts);
    const { entry, url } = matchDestination(opts.url, destinations, opts.destination);
    if (opts.signal && opts.signal.aborted) throw new NetError('E_NET_ABORTED');
    const secure = entry.scheme === 'https';
    const nodeOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: entry.port,
      path: url.pathname + url.search,
      method,
      headers: body || method === 'POST' ? { ...headers, 'content-length': String(body ? body.length : 0) } : headers,
      agent: secure ? httpsAgent : httpAgent,
      rejectUnauthorized: true,
      insecureHTTPParser: false,
    };
    if (testCa !== undefined) nodeOptions.ca = testCa;

    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timers = { connect: null, idle: null, total: null };
      const chunks = [];
      let settled = false;
      let req = null;
      let res = null;
      let tcpConnected = false;
      let secured = false;
      let bytes = 0;

      function arm(phase, ms) {
        const timer = setTimeout(() => settle(new NetError('E_NET_TIMEOUT', { phase })), ms);
        timer.unref();
        timers[phase] = timer;
      }
      function disarm(phase) {
        if (timers[phase]) clearTimeout(timers[phase]);
        timers[phase] = null;
      }
      function onAbort() {
        settle(new NetError('E_NET_ABORTED'));
      }
      function settle(err, value) {
        if (settled) return;
        settled = true;
        disarm('connect');
        disarm('idle');
        disarm('total');
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        if (err) {
          if (req) req.destroy();
          if (res) res.destroy();
          reject(err);
        } else {
          resolve(value);
        }
      }
      function connected() {
        disarm('connect');
        arm('idle', limits.idleTimeoutMs);
      }

      arm('connect', limits.connectTimeoutMs);
      arm('total', limits.totalTimeoutMs);
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

      try {
        req = (secure ? https : http).request(nodeOptions);
      } catch (_) {
        settle(badOptions('request'));
        return;
      }

      req.on('socket', (socket) => {
        socket.once('connect', () => {
          tcpConnected = true;
          if (!secure) connected();
        });
        if (secure) {
          socket.once('secureConnect', () => {
            secured = true;
            connected();
          });
        }
      });

      req.on('error', (err) => {
        if (res) settle(new NetError('E_NET_INCOMPLETE', { syscallCode: codeOf(err) }));
        else if (secure && tcpConnected && !secured) settle(new NetError('E_NET_TLS', { tlsCode: codeOf(err) }));
        else settle(new NetError('E_NET_CONNECT', { syscallCode: codeOf(err) }));
      });

      req.on('response', (r) => {
        res = r;
        const status = r.statusCode;
        if (status >= 300 && status <= 399) {
          settle(new NetError('E_NET_REDIRECT', { status }));
          return;
        }
        r.on('error', (err) => settle(new NetError('E_NET_INCOMPLETE', { syscallCode: codeOf(err) })));
        try {
          if (opts.onResponse) opts.onResponse({ status, headers: { ...r.headers } });
        } catch (_) {
          settle(new NetError('E_NET_CALLBACK'));
          return;
        }
        r.on('data', (chunk) => {
          if (settled) return;
          let take = chunk;
          const over = bytes + chunk.length > limits.maxResponseBytes;
          if (over) take = chunk.subarray(0, limits.maxResponseBytes - bytes);
          bytes += take.length;
          if (take.length > 0) {
            if (opts.onChunk) {
              try {
                opts.onChunk(take);
              } catch (_) {
                settle(new NetError('E_NET_CALLBACK'));
                return;
              }
            } else {
              chunks.push(take);
            }
          }
          if (over) {
            settle(new NetError('E_NET_RESPONSE_CAP', { limit: limits.maxResponseBytes }));
            return;
          }
          disarm('idle');
          arm('idle', limits.idleTimeoutMs);
        });
        r.on('end', () => {
          settle(null, {
            status,
            headers: { ...r.headers },
            body: opts.onChunk ? null : Buffer.concat(chunks),
            bytes,
            durationMs: Date.now() - started,
          });
        });
        r.on('close', () => {
          if (!r.complete) settle(new NetError('E_NET_INCOMPLETE'));
        });
      });

      req.end(body);
    });
  }

  return { request };
}

function createEgressForTests({ destinations, testCaPem } = {}) {
  const list = validateDestinations(destinations);
  for (const e of list) {
    if (e.host !== '127.0.0.1' || REAL_LOCAL_PORTS.includes(e.port)) throw badOptions('test-destination');
  }
  let ca;
  if (testCaPem !== undefined) {
    const pems = Array.isArray(testCaPem) ? testCaPem : [testCaPem];
    if (pems.length === 0 || !pems.every((p) => typeof p === 'string' && p.length > 0)) throw badOptions('test-ca');
    ca = pems;
  }
  return Object.freeze({ request: createClient(list, ca).request });
}

const { request } = createClient(DESTINATIONS, undefined);

module.exports = {
  DESTINATIONS,
  DEFAULTS,
  validateDestinations,
  matchDestination,
  request,
  createEgressForTests,
};
