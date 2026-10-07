'use strict';

const fs = require('fs');
const path = require('path');
const { ConfigError, ScriptoriumError } = require('../util/errors');
const { platformFoldsCase } = require('./exclusions');

/*
 * ADR 0021: the single write chokepoint for a campaign pack
 * (<vault>/_meta/scriptorium/). This module uses plain `fs`, deliberately:
 * it IS the write chokepoint src/vault/read.js's own header names as ADR
 * 0021's narrow, create-only exception to "never edits the vault", to ADR
 * 0018's "reads a pack and never writes to it", and to ADR 0006 reason 2
 * ("No vault write").
 *
 * Every file write is exclusive-create: O_CREAT|O_EXCL via `{ flag: 'wx' }`
 * (CREATE_NEW on Windows), so the existence check and the write are one
 * atomic filesystem operation and a race between an interactive
 * confirmation and a concurrent writer can never overwrite anything.
 * Directories are created with non-recursive mkdirSync, and EEXIST is
 * tolerated only when the pre-existing entry is genuinely a directory.
 *
 * There is no rollback. On EEXIST or an I/O error this stops and reports
 * exactly what it already created; it never deletes anything, because a
 * rollback would itself be a vault delete the exception above does not
 * cover.
 */

/** By convention, a campaign pack's own directory (docs/decisions/0018-campaign-pack.md). */
function packDirFor(vaultPath) {
  return path.join(vaultPath, '_meta', 'scriptorium');
}

/**
 * @param {string} realBase
 * @param {string} realTarget
 * @returns {boolean} true when realTarget equals realBase, or sits under it, folded per platformFoldsCase().
 */
function isInsideOrEqual(realBase, realTarget) {
  const fold = (s) => (platformFoldsCase() ? s.toLowerCase() : s);
  const base = fold(realBase);
  const target = fold(realTarget);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Issue #80: like isInsideOrEqual but the target must be a strict descendant: a pack directory (or
 * _meta) that resolves to the vault root itself is not "inside" it.
 * @returns {boolean}
 */
function isStrictlyInside(realBase, realTarget) {
  const fold = (s) => (platformFoldsCase() ? s.toLowerCase() : s);
  return fold(realTarget) !== fold(realBase) && isInsideOrEqual(realBase, realTarget);
}

const VAULT_ROOT_REFUSAL = (p, real) =>
  `refusing to write the campaign pack: ${p} resolves to the vault root, not inside it (${real})`;

/** A plain relative POSIX rel: no empty/backslash/leading-slash/drive-letter path, no empty/"."/".." segment. */
function isPlainRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (rel.includes('\\')) return false;
  if (rel.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  const segments = rel.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Absolute paths, in order: the pack directory (if this call created it), then the created entries. */
function absPathsCreated(packDir, createdPackDir, created) {
  const list = [];
  if (createdPackDir) list.push(packDir);
  for (const rel of created) {
    const plain = rel.endsWith('/') ? rel.slice(0, -1) : rel;
    list.push(path.join(packDir, ...plain.split('/')));
  }
  return list;
}

function existsSuffix(packDir, createdPackDir, created) {
  const list = absPathsCreated(packDir, createdPackDir, created);
  return list.length ? `; created before stopping: ${list.join(', ')}` : '';
}

/**
 * @param {string} vaultPath absolute, already through locateVault
 * @param {{ rel: string, kind: 'dir'|'file', data?: string }[]} entries pack-relative POSIX rels, in write order
 * @param {{ campaign?: string|null }} [opts]
 * @returns {{ packDir: string, createdPackDir: boolean, created: string[] }} created = rels in order, dirs suffixed '/'
 * @throws {ConfigError} W-*   @throws {ScriptoriumError} W-IO
 */
function createPackEntries(vaultPath, entries, { campaign = null } = {}) {
  // 1. Validate every rel up front: nothing is written until every entry passes.
  for (const entry of entries) {
    if (!isPlainRel(entry.rel)) {
      throw new ConfigError(`refusing to write "${entry.rel}" into the campaign pack: not a plain relative path`, {
        path: entry.rel,
        campaign,
      });
    }
    if (entry.kind === 'file' && /\.md$/i.test(entry.rel)) {
      throw new ConfigError(
        `refusing to write ${entry.rel} into the campaign pack: check reads every Markdown file under _meta (docs/decisions/0018-campaign-pack.md)`,
        { path: entry.rel, campaign },
      );
    }
  }

  // 2. _meta must exist and resolve inside the vault.
  const metaPath = path.join(vaultPath, '_meta');
  if (!fs.existsSync(metaPath)) {
    throw new ConfigError(`refusing to write the campaign pack: ${metaPath} does not exist`, {
      path: metaPath,
      campaign,
    });
  }
  const realVault = fs.realpathSync(vaultPath);
  const realMeta = fs.realpathSync(metaPath);
  if (!isInsideOrEqual(realVault, realMeta)) {
    throw new ConfigError(
      `refusing to write the campaign pack: ${metaPath} resolves outside the vault (${realMeta})`,
      { path: metaPath, campaign },
    );
  }
  if (!isStrictlyInside(realVault, realMeta)) {
    throw new ConfigError(VAULT_ROOT_REFUSAL(metaPath, realMeta), { path: metaPath, campaign });
  }

  // 3. The pack directory must be a real directory or absent; create it if absent.
  const packDir = packDirFor(vaultPath);
  let createdPackDir = false;

  function validateExistingPackDir() {
    let st;
    try {
      st = fs.statSync(packDir);
    } catch (err) {
      throw new ScriptoriumError(`could not create ${packDir}: ${err.message}`, { path: packDir, campaign, cause: err });
    }
    if (!st.isDirectory()) {
      throw new ConfigError(`refusing to write the campaign pack: ${packDir} exists and is not a folder`, {
        path: packDir,
        campaign,
      });
    }
    const realPackDir = fs.realpathSync(packDir);
    if (!isInsideOrEqual(realVault, realPackDir)) {
      throw new ConfigError(
        `refusing to write the campaign pack: ${packDir} resolves outside the vault (${realPackDir})`,
        { path: packDir, campaign },
      );
    }
    if (!isStrictlyInside(realVault, realPackDir)) {
      throw new ConfigError(VAULT_ROOT_REFUSAL(packDir, realPackDir), { path: packDir, campaign });
    }
  }

  if (fs.existsSync(packDir)) {
    validateExistingPackDir();
  } else {
    try {
      fs.mkdirSync(packDir);
      createdPackDir = true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        validateExistingPackDir();
      } else {
        throw new ScriptoriumError(`could not create ${packDir}: ${err.message}`, { path: packDir, campaign, cause: err });
      }
    }
  }

  const realPackDir = fs.realpathSync(packDir);

  // 4. Write each entry, in the given order.
  const created = [];
  for (const entry of entries) {
    const target = path.join(packDir, ...entry.rel.split('/'));
    const parent = path.dirname(target);
    let realParent;
    try {
      realParent = fs.realpathSync(parent);
    } catch (err) {
      throw new ScriptoriumError(
        `could not create ${target}: ${err.message}${existsSuffix(packDir, createdPackDir, created)}`,
        { path: target, campaign, cause: err },
      );
    }
    if (!isInsideOrEqual(realPackDir, realParent)) {
      throw new ConfigError(
        `refusing to write the campaign pack: ${parent} resolves outside the vault (${realParent})`,
        { path: parent, campaign },
      );
    }

    if (entry.kind === 'dir') {
      try {
        fs.mkdirSync(target);
      } catch (err) {
        if (err.code === 'EEXIST') {
          let st;
          try {
            st = fs.statSync(target);
          } catch (err2) {
            throw new ScriptoriumError(
              `could not create ${target}: ${err2.message}${existsSuffix(packDir, createdPackDir, created)}`,
              { path: target, campaign, cause: err2 },
            );
          }
          if (st.isDirectory()) continue; // tolerated: pre-existing, not newly created
          throw new ConfigError(
            `refusing to overwrite ${target}: it already exists${existsSuffix(packDir, createdPackDir, created)}`,
            { path: target, campaign },
          );
        }
        throw new ScriptoriumError(
          `could not create ${target}: ${err.message}${existsSuffix(packDir, createdPackDir, created)}`,
          { path: target, campaign, cause: err },
        );
      }
      created.push(`${entry.rel}/`);
    } else {
      try {
        fs.writeFileSync(target, entry.data, { flag: 'wx' });
      } catch (err) {
        if (err.code === 'EEXIST') {
          throw new ConfigError(
            `refusing to overwrite ${target}: it already exists${existsSuffix(packDir, createdPackDir, created)}`,
            { path: target, campaign },
          );
        }
        throw new ScriptoriumError(
          `could not create ${target}: ${err.message}${existsSuffix(packDir, createdPackDir, created)}`,
          { path: target, campaign, cause: err },
        );
      }
      created.push(entry.rel);
    }
  }

  return { packDir, createdPackDir, created };
}

module.exports = { packDirFor, isInsideOrEqual, isStrictlyInside, createPackEntries };
