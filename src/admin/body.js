'use strict';

/*
 * Phase 8 slice S1. JSON body reading with a fixed cap (FR13). Refuses early on a Content-Length
 * that already exceeds the cap, and on the running total for a chunked body -- never buffers
 * past the cap.
 */

const JSON_BODY_CAP = 65536;

/**
 * @param {import('http').IncomingMessage} req
 * @param {number} cap inclusive
 * @returns {Promise<{ ok: true, body: Buffer } | { ok: false, status: 413 }>}
 */
function readBody(req, cap) {
  return new Promise((resolve) => {
    const contentLength = req.headers && req.headers['content-length'];
    if (contentLength !== undefined) {
      const len = Number(contentLength);
      if (Number.isFinite(len) && len > cap) {
        // Drain and discard whatever the client still sends, rather than destroying the
        // socket: the caller still needs to write a real 413 response on this same
        // connection, and destroying `req` here tears down the shared HTTP/1.1 socket before
        // that response can be flushed (observed as a client-side ECONNRESET).
        req.resume();
        resolve({ ok: false, status: 413 });
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function onData(chunk) {
      total += chunk.length;
      if (total > cap) {
        finish({ ok: false, status: 413 });
        // Same reasoning as above: keep draining rather than destroying the socket.
        req.resume();
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      finish({ ok: true, body: Buffer.concat(chunks) });
    }

    function onError() {
      finish({ ok: false, status: 413 });
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** @param {Buffer} buf @throws {SyntaxError} on malformed JSON */
function parseJson(buf) {
  return JSON.parse(buf.toString('utf8'));
}

module.exports = { JSON_BODY_CAP, readBody, parseJson };
