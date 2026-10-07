'use strict';

const http = require('http');

/*
 * V1.5a test helper (not a test: no .test.js suffix, and nothing under test/ may sit in a
 * subdirectory WITH one). A tiny reverse proxy standing in for Caddy and for tailscale serve.
 *
 * What it does, and deliberately does NOT do, is the point:
 *   - It forwards the method, the path and EVERY request header verbatim. Host and Origin are
 *     NEVER rewritten. (The demo proxy this replaces rewrote both, which hid FR-05 and FR-06 from
 *     every test that used it. test/remote-http.test.js proves the pass-through byte for byte.)
 *   - It connects upstream FROM `localAddress` (default 127.0.0.2, the "trusted proxy on another
 *     address" shape; 127.0.0.1 gives the tailscale shape, where loopback is the proxy). Linux
 *     accepts every 127/8 address, which is why the peer tests are Linux-only.
 *   - It appends X-Forwarded-For (`xff: 'append'`, the real-proxy default, keeping whatever the
 *     client sent in front; or 'replace', nginx's `$remote_addr`), and sets X-Forwarded-Proto.
 *   - Bodies are streamed, in both directions.
 */

/**
 * @param {{ upstreamPort: number, upstreamHost?: string, localAddress?: string, xff?: 'append'|'replace'|'none',
 *           clientAddress?: string, proto?: string|null }} opts
 *   clientAddress: what the proxy claims the client's address was (default: the real socket peer).
 *   proto: the X-Forwarded-Proto value to set (default 'https'); null sets none.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function createTestProxy({ upstreamPort, upstreamHost = '127.0.0.1', localAddress = '127.0.0.2', xff = 'append', clientAddress, proto = 'https' }) {
  const server = http.createServer((req, res) => {
    // Rebuild the header list from rawHeaders so names keep their case and duplicates are kept.
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const lower = name.toLowerCase();
      if (lower === 'connection' || lower === 'keep-alive' || lower === 'proxy-connection') continue;
      if (lower === 'x-forwarded-proto') continue; // the proxy sets this itself
      if (lower === 'x-forwarded-for' && xff !== 'append') continue;
      headers.push([name, req.rawHeaders[i + 1]]);
    }
    const peer = clientAddress || (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (xff === 'append') {
      const idx = headers.findIndex(([n]) => n.toLowerCase() === 'x-forwarded-for');
      if (idx === -1) headers.push(['X-Forwarded-For', peer]);
      else headers[idx] = [headers[idx][0], `${headers[idx][1]}, ${peer}`];
    } else if (xff === 'replace') {
      headers.push(['X-Forwarded-For', peer]);
    }
    if (proto !== null) headers.push(['X-Forwarded-Proto', proto]);
    headers.push(['Connection', 'close']);

    // http.request cannot take an ordered list of raw headers, so create the request with none and
    // append them one by one: names keep their case, duplicates are kept, and Host is sent exactly
    // as the client sent it (setHost: false).
    const upstream = http.request({ host: upstreamHost, port: upstreamPort, localAddress, method: req.method, path: req.url, setHost: false, agent: false });
    for (const [n, v] of headers) upstream.appendHeader(n, v);
    upstream.on('response', (up) => {
      res.writeHead(up.statusCode, up.rawHeaders);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('bad gateway');
    });
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
            server.closeAllConnections();
          }),
      });
    });
  });
}

module.exports = { createTestProxy };
