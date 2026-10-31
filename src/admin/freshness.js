'use strict';

const path = require('path');
const packfiles = require('./packfiles');
const read = require('../vault/read');

/*
 * V1e-3 (SD-17, D-10, ADR 0035 SS4): the "saved since last build" signal. A stamp is taken at
 * build START (inside the build lock), recording the sha256 of the files the panel edits (and of _meta/vault-config.yaml)
 * plus a per-process panel-save counter, and is committed to ctx only on a successful build (exit
 * 0). Comparing the stamp's shas/counter against the CURRENT ones is what "stale" means. Nothing
 * here hashes vault pages (an owner-accepted residual, cost): an edit to a vault page made
 * outside the panel is never detected by this signal, and the copy that reads it says so.
 */

// vault-config.yaml (ADR 0071): a vault whose settings gm-apprentice moved keeps them there, and the
// carry writes it, so a change to it makes a built preview out of date like the other three.
const TRACKED_FILES = Object.freeze(['pack.toml', 'vault.config.json', 'vault-config.md', 'vault-config.yaml']);

/**
 * Never throws. The sha256 of each of TRACKED_FILES right now, or null when a file is absent, or
 * the literal string 'unreadable' when reading it throws for any other reason.
 *
 * @param {object} ctx an admin context
 * @returns {{ 'pack.toml': string|null, 'vault.config.json': string|null, 'vault-config.md': string|null, 'vault-config.yaml': string|null }}
 */
function readTrackedShas(ctx) {
  const shas = {};

  for (const name of ['pack.toml', 'vault.config.json']) {
    try {
      shas[name] = packfiles.readPackFile(ctx, name).sha256;
    } catch {
      shas[name] = 'unreadable';
    }
  }

  for (const name of ['vault-config.md', 'vault-config.yaml']) {
    try {
      const file = path.join(ctx.vaultPath, '_meta', name);
      shas[name] = read.pathExists(file) ? packfiles.sha256Hex(read.readBytes(file)) : null;
    } catch {
      shas[name] = 'unreadable';
    }
  }

  return shas;
}

/**
 * Increments `ctx.panelSaves` iff `value` is a genuine, confirmed, actually-written save: status
 * 200, `body.ok === true`, not a dry run, and not a no-op ("unchanged") save. A dry run never
 * writes, and an "unchanged" confirm (the candidate byte-equals the current file) never writes
 * either -- neither should ever move the freshness signal.
 *
 * @param {object} ctx an admin context
 * @param {{ status: number, body: object }} value the handler's own {status, body} outcome
 */
function noteSaveIfWritten(ctx, value) {
  if (!value || value.status !== 200) return;
  const body = value.body;
  if (!body || body.ok !== true) return;
  if (body.dryRun === true) return;
  if (body.unchanged === true) return;
  ctx.panelSaves = (ctx.panelSaves || 0) + 1;
}

/**
 * The stamp taken at build start, inside the build lock.
 *
 * @param {object} ctx an admin context
 * @param {number} nowMs
 * @returns {{ builtAt: string, shas: object, saves: number }}
 */
function takeStamp(ctx, nowMs) {
  return { builtAt: new Date(nowMs).toISOString(), shas: readTrackedShas(ctx), saves: ctx.panelSaves || 0 };
}

/**
 * @param {{ shas: object, saves: number }} stamp the stamp taken at the start of the last
 *   successful build
 * @param {object} shasNow readTrackedShas(ctx) right now
 * @param {number} savesNow ctx.panelSaves right now
 * @returns {{ stale: boolean, savedSince: string[], panelSavesSince: number }}
 */
function compareStamp(stamp, shasNow, savesNow) {
  const savedSince = TRACKED_FILES.filter((f) => stamp.shas[f] !== shasNow[f]);
  const panelSavesSince = savesNow - stamp.saves;
  return { stale: savedSince.length > 0 || panelSavesSince > 0, savedSince, panelSavesSince };
}

module.exports = { TRACKED_FILES, readTrackedShas, noteSaveIfWritten, takeStamp, compareStamp };
