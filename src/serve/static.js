'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Phase 8 slice S2 (docs/agent-runs/admin-s2-engineering-brief-2026-09-28.md, Structural
 * decision 4 and "static.js"). A pure static path resolver, with no network builtin capability
 * at all (the module-graph test reads raw source, so this file must not even spell out the
 * forbidden require call in a comment). Used by the preview listener
 * (src/admin/preview.js's servePreview) and, after D11, by plain `serve`'s createServer
 * (src/serve/server.js). Decoding happens exactly once (Risk area 3: decoding twice turns
 * %252e into a traversal); containment is path.relative + realpath, never startsWith (Risk
 * area/M4).
 */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** @param {string} filePath @returns {string} a MIME_TYPES value, or application/octet-stream */
function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * @param {string} rootDir absolute
 * @param {string} rawUrl req.url (or an equivalent test literal)
 * @returns {{ ok: true, filePath: string } | { ok: false, status: 400 | 404 }}
 */
function resolveStaticPath(rootDir, rawUrl) {
  // Rule 1: a URL that does not start with '/' gets 400 (also refuses an absolute-form URL
  // such as "http://x/").
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) {
    return { ok: false, status: 400 };
  }

  // Rule 2: the path part before '?'; decodeURIComponent runs exactly once.
  const withoutQuery = rawUrl.split('?')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return { ok: false, status: 400 };
  }

  // Rule 3: NUL, backslash or ':' -- the colon rule also covers drive letters and ":stream"
  // ADS suffixes.
  if (decoded.includes('\u0000') || decoded.includes('\\') || decoded.includes(':')) {
    return { ok: false, status: 400 };
  }

  const rootAbs = path.resolve(rootDir);
  const joined = path.join(rootAbs, decoded);

  // Rule 4: lexical containment, path.relative rather than startsWith (never a string-prefix
  // check -- that is exactly what let `/..%2fout.scriptorium-old-1/...` through before D11).
  const rel = path.relative(rootAbs, joined);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, status: 400 };
  }

  // Rule 5: a directory, or a path ending in '/', resolves to index.html.
  let filePath = joined;
  const stat = fs.existsSync(joined) ? fs.statSync(joined) : null;
  if (decoded.endsWith('/') || (stat && stat.isDirectory())) {
    filePath = path.join(joined, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    // Rule 7: a missing file gets 404.
    return { ok: false, status: 404 };
  }

  // Rule 6: an existing file whose real path is outside realpath(rootDir) gets 404 (a symlink
  // escape -- M9).
  let realRoot;
  try {
    realRoot = fs.realpathSync(rootAbs);
  } catch {
    realRoot = rootAbs;
  }
  let realFile;
  try {
    realFile = fs.realpathSync(filePath);
  } catch {
    return { ok: false, status: 404 };
  }
  const relReal = path.relative(realRoot, realFile);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    return { ok: false, status: 404 };
  }

  return { ok: true, filePath };
}

module.exports = { MIME_TYPES, contentTypeFor, resolveStaticPath };
