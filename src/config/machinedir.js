'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NAME_RE } = require('../setup/validate');
// Called through the module object (packwrite.isInsideOrEqual), not destructured, so a test can
// patch it deterministically (the same reason src/vault/packreplace.js and
// src/admin/handlers/pack.js call packwrite functions this way).
const packwrite = require('../vault/packwrite');

/*
 * V1e-1 (ADR 0033, SD-2): the per-machine folder vault-config.md's backups (and, later, panel
 * preferences) live beside -- never a fallback default, and never inside the vault. This module
 * never writes anything; src/config/backups.js is the writer, given this module's `dir`.
 *
 * Deliberately does not call src/config/location.js's resolveConfigPath/defaultConfigPath: the
 * caller's own ctx.ctxInfo.configPath (already resolved once, at launch, per src/cli/args.js:50)
 * is the only input. A missing configPath is unavailable, full stop -- never re-derived.
 */

const BACKUPS_DIRNAME = 'backups';

const REASON_NO_CONFIG_PATH =
  "GM-Scriptorium's own folder is unknown in this session, so the panel can't back up vault-config.md. Editing it is off.";

function reasonMissingDir(dir) {
  return `GM-Scriptorium's own folder (${dir}) doesn't exist, so the panel can't back up vault-config.md. Editing it is off.`;
}

function reasonInsideVault(dir) {
  return `GM-Scriptorium's own folder (${dir}) is inside the vault, so the panel won't keep backups or preferences there. Editing vault-config.md is off.`;
}

/**
 * SD-2: `campaign-<name>` when NAME_RE matches, else `campaign_<first 16 hex of
 * sha256(utf8 name)>`. `_` is outside NAME_RE's alphabet, so the hashed and plain forms can never
 * collide; the `campaign-` prefix makes every result non-reserved on Windows (`con` becomes
 * `campaign-con`). Always a single path segment (no `/`).
 *
 * @param {string} campaign
 * @returns {string}
 */
function campaignSegment(campaign) {
  const name = typeof campaign === 'string' ? campaign : '';
  if (NAME_RE.test(name)) return `campaign-${name}`;
  const hex16 = crypto.createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16);
  return `campaign_${hex16}`;
}

/**
 * @param {{ configPath: unknown, vaultPath: string }} args
 * @returns {{ ok: true, dir: string, realDir: string } | { ok: false, reason: string }}
 */
function resolveMachineDir({ configPath, vaultPath }) {
  if (typeof configPath !== 'string' || configPath.length === 0 || !path.isAbsolute(configPath)) {
    return { ok: false, reason: REASON_NO_CONFIG_PATH };
  }

  const dir = path.dirname(configPath);

  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return { ok: false, reason: reasonMissingDir(dir) };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: reasonMissingDir(dir) };
  }

  const realDir = fs.realpathSync(dir);
  const realVault = fs.realpathSync(vaultPath);
  if (packwrite.isInsideOrEqual(realVault, realDir)) {
    return { ok: false, reason: reasonInsideVault(dir) };
  }

  return { ok: true, dir, realDir };
}

module.exports = { BACKUPS_DIRNAME, campaignSegment, resolveMachineDir, REASON_NO_CONFIG_PATH };
