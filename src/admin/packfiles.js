'use strict';

const crypto = require('crypto');
const path = require('path');
const read = require('../vault/read');

/*
 * Phase 8 slice S1 (Structural decision 9, the S2/S3 shared seam). The fixed readable set (FR14):
 * pack.toml and the pack's vault.config.json, read through src/vault/read.js's chokepoint
 * (read.pathExists/read.readBytes), never through a request parameter.
 */

const PACK_FILE_NAMES = Object.freeze(['pack.toml', 'vault.config.json']);

/** @param {Buffer} buf @returns {string} lowercase hex */
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function pathForName(ctx, name) {
  if (name === 'vault.config.json') return ctx.siteConfigPath;
  if (name === 'pack.toml') return path.join(ctx.packDir, 'pack.toml');
  throw new Error(`readPackFile: unknown pack file name "${name}"`);
}

/**
 * @param {object} ctx an admin context (context.js)
 * @param {'pack.toml'|'vault.config.json'} name
 * @returns {{ name: string, path: string, exists: boolean, raw: Buffer|null, sha256: string|null }}
 * @throws {Error} an unknown name
 */
function readPackFile(ctx, name) {
  const target = pathForName(ctx, name);
  if (!read.pathExists(target)) {
    return { name, path: target, exists: false, raw: null, sha256: null };
  }
  const raw = read.readBytes(target);
  return { name, path: target, exists: true, raw, sha256: sha256Hex(raw) };
}

module.exports = { PACK_FILE_NAMES, sha256Hex, readPackFile };
