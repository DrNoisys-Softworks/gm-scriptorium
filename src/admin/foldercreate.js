'use strict';

const fs = require('fs');
const path = require('path');
const probe = require('../setup/probe');
const folders = require('../setup/folders');
const { isInsideOrEqual } = require('../vault/packwrite');

/*
 * ADR 0049: the picker's one write. createFolder makes ONE folder, directly inside an existing,
 * listed parent: a single create call with no options argument (so never recursive), refused
 * when the name is already taken (never tolerated, deleted, renamed or overwritten), and refused
 * inside the config folder, the panel folder or any registered vault. It is not a vault write: it
 * can never land in a vault, and it is not one of the pack writes src/vault/packwrite.js guards.
 * Its own fence is test/folders-structure.test.js: this is the only module under src/admin or
 * src/setup that makes a folder besides the variants builder, it is imported only by
 * handlers/folders.js, and it names no deletion, rename, copy, link or recursive token.
 *
 * Order, every filesystem call bounded by the shared probe cap (src/setup/probe.js):
 *   1. validate the name and the parent path (before any filesystem call);
 *   2. lstat the parent: a directory, and not a link;
 *   3. realpath the parent; the target is realParent/name, a direct child by construction;
 *   4. refuse inside (or equal to) the config folder, then the panel folder (a separate check,
 *      because `panel` could be a link), then each vault, always by real path AND lexically;
 *   5. create it;
 *   6. realpath the result: it must be where it was meant to be, else answer `moved` (nothing is undone).
 *
 * Will not catch, deliberately: a create whose bound fired but which finished later (the folder may
 * then exist although the answer said not-responding); an ancestor swapped to a link between steps 3
 * and 5 (step 6 reports it as moved and leaves it).
 *
 * @param {{ parent: string, name: string }} input
 * @param {{ configDir: string, panelDir: string, vaults: string[], deps?: object }} ctx deps: { fsp, timeoutMs, platform }
 * @returns {Promise<{ ok: true, path: string } | { ok: false, error: string, path?: string }>}
 * @throws {ConfigError} (with .field 'parent' or 'name') for input that fails validation
 */
async function createFolder(input, ctx) {
  const given = input || {};
  const d = ctx.deps || {};
  const s = {
    fsp: d.fsp || fs.promises,
    timeoutMs: d.timeoutMs || probe.DEFAULT_TIMEOUT_MS,
    platform: d.platform || process.platform,
  };
  const P = s.platform === 'win32' ? path.win32 : path.posix;

  let resolvedParent;
  try {
    resolvedParent = folders.validateFolderPath(given.parent, s.platform);
  } catch (err) {
    err.field = 'parent';
    throw err;
  }
  try {
    folders.validateFolderName(given.name);
  } catch (err) {
    err.field = 'name';
    throw err;
  }
  const lexicalTarget = P.join(resolvedParent, given.name);

  const looked = await ask(s, () => s.fsp.lstat(resolvedParent));
  if (looked.outcome !== 'ok') return refusal(looked, READ_ERRORS);
  if (looked.value.isSymbolicLink()) return { ok: false, error: 'link' };
  if (!looked.value.isDirectory()) return { ok: false, error: 'not-folder' };

  const resolved = await ask(s, () => s.fsp.realpath(resolvedParent));
  if (resolved.outcome !== 'ok') return refusal(resolved, READ_ERRORS);
  if (typeof resolved.value !== 'string' || resolved.value.length === 0) return { ok: false, error: 'not-responding' };
  const target = P.join(resolved.value, given.name);

  const places = [
    ['inside-config', [ctx.configDir]],
    ['inside-panel', [ctx.panelDir]],
    ['inside-vault', Array.isArray(ctx.vaults) ? ctx.vaults : []],
  ];
  for (const [error, dirs] of places) {
    for (const dir of dirs) {
      if (typeof dir !== 'string' || dir.length === 0) continue;
      const lexical = P.resolve(dir);
      const real = await ask(s, () => s.fsp.realpath(lexical));
      // A missing or unanswered realpath falls back to the written path; the lexical check below
      // still applies either way.
      const realBase = real.outcome === 'ok' && typeof real.value === 'string' ? real.value : lexical;
      for (const base of [realBase, lexical]) {
        if (isInsideOrEqual(base, target) || isInsideOrEqual(base, lexicalTarget)) return { ok: false, error };
      }
    }
  }

  const made = await ask(s, () => s.fsp.mkdir(target));
  if (made.outcome !== 'ok') return refusal(made, MAKE_ERRORS);

  const check = await ask(s, () => s.fsp.realpath(target));
  const stayed = check.outcome === 'ok' && typeof check.value === 'string' && isInsideOrEqual(check.value, target) && isInsideOrEqual(target, check.value);
  if (!stayed) return { ok: false, error: 'moved', path: target };
  return { ok: true, path: lexicalTarget };
}

/** One filesystem call under the shared bound. Never throws. */
async function ask(s, call) {
  const r = await probe.bounded(async () => {
    try {
      return { value: await call() };
    } catch (err) {
      return { code: (err && err.code) || 'UNKNOWN' };
    }
  }, s.timeoutMs);
  if (r.state === 'timeout') return { outcome: 'timeout' };
  if (r.state === 'busy') return { outcome: 'busy' };
  if (r.state !== 'ok' || !r.value) return { outcome: 'error', code: 'UNKNOWN' };
  if (r.value.code !== undefined) return { outcome: 'error', code: r.value.code };
  return { outcome: 'ok', value: r.value.value };
}

const READ_ERRORS = Object.freeze({ ENOENT: 'missing', ENOTDIR: 'missing', EACCES: 'permission', EPERM: 'permission' });
const MAKE_ERRORS = Object.freeze({ EEXIST: 'exists', EACCES: 'permission', EPERM: 'permission', EROFS: 'permission', ENOENT: 'missing', ENOTDIR: 'not-folder' });

function refusal(r, codes) {
  if (r.outcome === 'timeout') return { ok: false, error: 'not-responding' };
  if (r.outcome === 'busy') return { ok: false, error: 'checks-busy' };
  return { ok: false, error: Object.prototype.hasOwnProperty.call(codes, r.code) ? codes[r.code] : 'not-responding' };
}

module.exports = { createFolder };
