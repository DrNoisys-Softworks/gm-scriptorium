'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { contentTypeFor, resolveStaticPath } = require('./static');

/*
 * `serve` binds 127.0.0.1 by default, deliberately against the standing
 * "dev servers bind 0.0.0.0" rule (Engineering Brief section 10 / decision
 * recorded for docs/decisions/0002-serve-binds-localhost.md): the content
 * is player-facing-but-not-yet-safe, and the LAN is exactly where that
 * damage happens. --host opts in explicitly and the caller is responsible
 * for printing the warning naming the risk before calling this.
 *
 * No file watching (LK-8/SC-8, not built). Opens and closes one file per
 * request; nothing here holds a handle open between requests, so a build
 * swap while `serve` is running cannot be blocked by it.
 *
 * Phase 8 slice S2, D11 (issue #78): createServer used to decode the URL with a bare
 * decodeURIComponent() and a string-prefix containment check (`startsWith`), which crashed the
 * whole process on a malformed escape such as `/%E0%A4%A` and let a request like
 * `/..%2fout.scriptorium-old-1/...` through to a sibling directory whose name merely started
 * with the output directory's name. It now delegates to src/serve/static.js's
 * resolveStaticPath, the same pure resolver the preview listener uses, so both paths get the
 * same 400/404 rules and neither can decode twice.
 */

/** QA F06: plain-English text for a listen failure; any other error keeps Node's own text. */
function describeListenError(err, port, host) {
  if (err.code === 'EADDRINUSE') return new Error(`port ${port} is already in use on ${host}`);
  if (err.code === 'EACCES') {
    return new Error(`port ${port} needs administrator rights on this computer; try a port above 1024, for example 8081`);
  }
  return err;
}

// Every plain-serve response says "do not guess the type", so a downloaded or mistyped file is never
// sniffed into something executable.
const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' };

function respond404(rootDir, res) {
  const notFoundPath = path.join(rootDir, '404.html');
  fs.readFile(notFoundPath, (err2, notFoundData) => {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...NOSNIFF });
    res.end(err2 ? 'Not found' : notFoundData);
  });
}

function createServer(rootDir) {
  return http.createServer((req, res) => {
    const result = resolveStaticPath(rootDir, req.url);
    if (!result.ok) {
      if (result.status === 400) {
        res.writeHead(400, NOSNIFF);
        res.end('bad request');
        return;
      }
      respond404(rootDir, res);
      return;
    }
    fs.readFile(result.filePath, (err, data) => {
      if (err) {
        // A benign race (the file was removed between resolveStaticPath and this read); the
        // original handler treated any readFile failure as a 404, so this keeps that behaviour.
        respond404(rootDir, res);
        return;
      }
      res.writeHead(200, { 'Content-Type': contentTypeFor(result.filePath), ...NOSNIFF });
      res.end(data);
    });
  });
}

/**
 * @param {string} rootDir the built output directory to serve
 * @param {{ host?: string, port: number }} opts
 * @returns {Promise<{ server: import('http').Server, host: string, port: number }>}
 */
function startServer(rootDir, { host = '127.0.0.1', port }) {
  return new Promise((resolve, reject) => {
    const server = createServer(rootDir);
    server.on('error', (err) => {
      reject(describeListenError(err, port, host));
    });
    // Report the bound port (issue #79), not the requested one: --port 0 is OS-assigned.
    server.listen(port, host, () => resolve({ server, host, port: server.address().port }));
  });
}

/**
 * Phase 8 slice S1: the admin panel's listener primitive. Deliberately has NO `host` parameter
 * (Structural decision 3) -- it always binds 127.0.0.1, so a caller cannot accidentally widen
 * the admin/preview listeners the way plain `serve --host` can. `close()` calls
 * closeAllConnections() before/alongside server.close() (Risk #3) so Ctrl-C never waits on a
 * keep-alive socket.
 *
 * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void} handler
 * @param {{ port: number }} opts port 0 means OS-assigned
 * @returns {Promise<{ server: import('http').Server, port: number, close: () => Promise<void> }>}
 */
function startLocalListener(handler, { port }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', (err) => {
      reject(describeListenError(err, port, '127.0.0.1'));
    });
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => {
              if (err) rej(err);
              else res();
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}

module.exports = { describeListenError, startServer, createServer, startLocalListener };
