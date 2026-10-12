'use strict';

/*
 * A stand-in for src/net/egress.js `request`, for the update tests. It follows the same contract
 * the real client gives a caller (onResponse sees the status and headers, onChunk gets the body in
 * pieces and then the result body is null, otherwise the result body is a Buffer), and it records
 * every options object it was given. It reaches no network. It deliberately does not require
 * anything under src/net, so the expected shapes in a test are written in the test, not read from
 * the module under test.
 *
 * A route is a reply object ({ status, headers, body }, where body is a string, a Buffer or an
 * array of those for several chunks) or an Error to throw. `byUrl` picks a route by exact URL and
 * throws on a URL no route names, so a request the test did not expect fails loudly.
 */

function toBuffers(body) {
  const parts = Array.isArray(body) ? body : [body === undefined ? '' : body];
  return parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8')));
}

function fakeRequest(pick) {
  const calls = [];
  async function request(opts) {
    calls.push(opts);
    const route = await pick(opts, calls.length);
    if (route instanceof Error) throw route;
    const status = route.status === undefined ? 200 : route.status;
    const headers = route.headers || {};
    const chunks = toBuffers(route.body);
    if (opts.onResponse) opts.onResponse({ status, headers: { ...headers } });
    const bytes = chunks.reduce((n, c) => n + c.length, 0);
    if (opts.onChunk) {
      for (const c of chunks) opts.onChunk(c);
      return { status, headers: { ...headers }, body: null, bytes, durationMs: 1 };
    }
    return { status, headers: { ...headers }, body: Buffer.concat(chunks), bytes, durationMs: 1 };
  }
  return { request, calls };
}

function byUrl(routes) {
  return fakeRequest((opts) => {
    if (!Object.prototype.hasOwnProperty.call(routes, opts.url)) throw new Error(`unexpected request: ${opts.url}`);
    const route = routes[opts.url];
    return typeof route === 'function' ? route(opts) : route;
  });
}

const API = 'https://api.github.com/repos/DrNoisys-Softworks/gm-scriptorium';
const URLS = Object.freeze({
  latest: `${API}/releases/latest`,
  list: `${API}/releases?per_page=30`,
  tag: (tag) => `${API}/releases/tags/${encodeURIComponent(tag)}`,
  download: (tag, name) => `https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/${encodeURIComponent(tag)}/${name}`,
});

const json = (value, extra = {}) => ({ status: 200, body: JSON.stringify(value), ...extra });

module.exports = { fakeRequest, byUrl, URLS, json };
