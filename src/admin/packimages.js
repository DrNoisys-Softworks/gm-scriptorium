'use strict';

const path = require('path');
const read = require('../vault/read');
const { IMAGE_EXT_RE, MAX_IMAGE_BYTES, isInsideReal } = require('../build/themeassets');

/*
 * Phase 8 slice S2 (Structural decision 5; FR15 moved into this slice by the orchestrator notes
 * so the image listing exists exactly once). The image listing and image-byte read chokepoint,
 * shared by GET /api/state's `images` field (src/admin/handlers/views.js) and GET /api/image
 * (src/admin/handlers/images.js). `?name=` (FR14) must exactly equal a listing entry -- never a
 * raw path join -- so a traversal or absolute-path request parameter can never name a file this
 * module did not itself already enumerate.
 */

const IMAGE_CONTENT_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
});

/** FR15: sandboxed, no styles-from-network, no framing -- an uploaded SVG must not execute. */
const IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

function imagesDir(ctx) {
  return path.join(ctx.packDir, 'images');
}

/**
 * Recursive walk through read.listDir only (the brief's own constraint): a missing directory, or
 * any listDir failure at any depth, is treated as "nothing here" rather than thrown, so a
 * malformed/unreadable images/ tree can never take down GET /api/state (FR21's sibling rule for
 * the image listing).
 */
function walk(absDir, relFromImages, out) {
  let entries;
  try {
    entries = read.listDir(absDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink) continue; // never follow a symlink into or out of images/
    const abs = path.join(absDir, entry.name);
    const rel = relFromImages ? `${relFromImages}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      walk(abs, rel, out);
      continue;
    }
    if (!entry.isFile) continue;
    if (!IMAGE_EXT_RE.test(entry.name)) continue;
    out.push(rel);
  }
}

/**
 * @param {object} ctx an admin context (context.js)
 * @returns {string[]} sorted POSIX-relative paths of the regular image files under
 *   <ctx.packDir>/images
 */
function listPackImages(ctx) {
  const out = [];
  walk(imagesDir(ctx), '', out);
  out.sort();
  return out;
}

/**
 * @param {object} ctx
 * @param {string} rel must exactly equal one entry of listPackImages(ctx) (FR14)
 * @returns {{ contentType: string, bytes: Buffer } | null}
 */
function readPackImage(ctx, rel) {
  if (typeof rel !== 'string' || !listPackImages(ctx).includes(rel)) return null;

  const dir = imagesDir(ctx);
  const file = path.join(dir, ...rel.split('/'));

  let realDir;
  let realFile;
  try {
    realDir = read.realPath(dir);
    realFile = read.realPath(file);
  } catch {
    return null;
  }
  if (!isInsideReal(realDir, realFile)) return null;

  let bytes;
  try {
    bytes = read.readBytes(file);
  } catch {
    return null;
  }
  if (bytes.length > MAX_IMAGE_BYTES) return null;

  const contentType = IMAGE_CONTENT_TYPES[path.extname(rel).toLowerCase()];
  if (!contentType) return null; // defensive: the listing's IMAGE_EXT_RE match already implies this

  return { contentType, bytes };
}

module.exports = { IMAGE_CONTENT_TYPES, IMAGE_CSP, listPackImages, readPackImage };
