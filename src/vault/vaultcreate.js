'use strict';

const fs = require('fs');
const path = require('path');
const { VaultUnreachableError } = require('../util/errors');
const { platformFoldsCase } = require('./exclusions');

/*
 * docs/decisions/0048-new-campaign-vault.md, section 2: the one place Scriptorium creates a
 * vault. It is a create-only writer in the family of src/vault/packwrite.js (ADR 0021), and it
 * deliberately imports nothing from it: a chokepoint never imports another (ADR 0033).
 *
 * What it does, in order, and nothing else:
 *   1. checks the whole starter (every path) before anything exists;
 *   2. inspects the target: absent, or empty apart from OS litter and an .obsidian folder;
 *   3. creates any missing parent folders, one level at a time, then the target, then the
 *      starter's folders parent first, then its files.
 *
 * Every file is written with { flag: 'wx' } (O_CREAT|O_EXCL; CREATE_NEW on Windows), so a file
 * that appears between the check and the write is never replaced. Every folder is made by a
 * non-recursive mkdirSync, and EEXIST is a refusal, never tolerated: this module never adopts
 * a folder it did not make, except the target itself when it was already empty. Every folder it
 * makes, at any level, is checked by realpath to be a real new folder inside its parent.
 *
 * Nothing is ever removed. On any failure it stops and says exactly what it had created. A
 * rollback would be the first deleting vault write in the program, and the rules that fence the
 * pack writer exist to forbid exactly that. The litter it finds is never read, changed or removed.
 */

const LITTER_FILES = Object.freeze(['desktop.ini', 'Thumbs.db', '.DS_Store']);
const LITTER_DIRS = Object.freeze(['.obsidian', '.git']);

const RESERVED_RE = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const BAD_CHARS_RE = /[<>:"|?*\u0000-\u001f]/;
const LITTER_FOLDED = new Set([...LITTER_FILES, ...LITTER_DIRS].map((n) => n.toLowerCase()));

function fold(s) {
  return platformFoldsCase() ? s.toLowerCase() : s;
}

/** Equal, or inside, after folding where the platform folds case. */
function isInsideOrEqual(base, target) {
  const b = fold(base);
  const t = fold(target);
  return t === b || t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * A plain relative POSIX path that is legal on Windows too: no empty, "." or ".." segment, no
 * absolute, drive or backslash form, no reserved device name (with or without an extension), no
 * trailing dot or space, none of < > : " | ? * or a control character, and no litter name (those
 * belong to the folder, never to the starter).
 *
 * @param {unknown} rel
 * @returns {boolean}
 */
function validateStarterRel(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
    if (BAD_CHARS_RE.test(segment) || /[. ]$/.test(segment)) return false;
    if (RESERVED_RE.test(segment.split('.')[0].replace(/ +$/, ''))) return false;
    if (LITTER_FOLDED.has(segment.toLowerCase())) return false;
  }
  return true;
}

/** extra: { kind, ... } for a screen to draw from (kind names the sort of refusal); the message is unchanged. */
function refusal(abs, why, campaign, extra) {
  const err = new VaultUnreachableError(`refusing to create a vault in ${abs}: ${why}`, {
    path: abs,
    campaign: campaign === undefined ? null : campaign,
    reason: 'new-vault',
  });
  if (extra) Object.assign(err, extra);
  return err;
}

/** realpath of the deepest existing ancestor, with the not-yet-existing tail appended unchanged. */
function realpathLoose(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isMissingCode(err) {
  return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

/**
 * Read-only. What the target is, and which parent folders would have to be made.
 *
 * @param {string} targetAbs
 * @param {{ configPath?: string, panelDir?: string, campaign?: string|null }} [opts]
 * @returns {{ state: 'missing'|'empty', litter: string[], missingAncestors: string[] }}
 * @throws {VaultUnreachableError} reason "new-vault"
 */
function inspectTarget(targetAbs, { configPath, panelDir, campaign } = {}) {
  if (typeof targetAbs !== 'string' || !path.isAbsolute(targetAbs)) {
    throw refusal(String(targetAbs), 'it is not a full path', campaign, { kind: 'relative' });
  }
  const abs = path.resolve(targetAbs);
  if (path.parse(abs).root === abs) throw refusal(abs, 'it is a filesystem root', campaign, { kind: 'root' });

  let st = null;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (!isMissingCode(err)) throw refusal(abs, `it cannot be read (${err.code || err.message})`, campaign, { kind: 'unreadable' });
  }
  if (st && st.isSymbolicLink()) throw refusal(abs, 'it is a link or junction', campaign, { kind: 'link' });
  if (st && !st.isDirectory()) throw refusal(abs, 'it is a file', campaign, { kind: 'file' });

  // The deepest folder that exists, and the levels missing below it (top first).
  const missingAncestors = [];
  let existing = abs;
  if (st === null) {
    let cur = path.dirname(abs);
    for (;;) {
      let s;
      try {
        s = fs.statSync(cur);
      } catch (err) {
        if (!isMissingCode(err)) throw refusal(abs, `${cur} cannot be read (${err.code || err.message})`, campaign, { kind: 'unreadable' });
        missingAncestors.push(cur);
        const up = path.dirname(cur);
        if (up === cur) throw refusal(abs, `no part of that path exists (${cur})`, campaign, { kind: 'no-path' });
        cur = up;
        continue;
      }
      if (!s.isDirectory()) throw refusal(abs, `${cur} is a file, not a folder`, campaign, { kind: 'ancestor-file' });
      existing = cur;
      break;
    }
    missingAncestors.reverse();
  }

  // Inside an existing vault: any real ancestor holding _meta/vault-config.md. The nearest existing
  // folder counts when the target is missing; for an existing target only its parents do (a target
  // that is itself a vault is simply not empty).
  const realExisting = fs.realpathSync(existing);
  for (let dir = st === null ? realExisting : path.dirname(realExisting); ; ) {
    if (fs.existsSync(path.join(dir, '_meta', 'vault-config.md'))) throw refusal(abs, `it is inside the vault at ${dir}`, campaign, { kind: 'inside-vault', ancestor: dir });
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  // GM-Scriptorium's own folders: inside the settings or panel folder, or holding the config
  // file or the panel folder.
  const realTarget = realpathLoose(abs);
  const own = [];
  if (typeof configPath === 'string' && configPath !== '') own.push({ dir: path.dirname(configPath), file: configPath });
  if (typeof panelDir === 'string' && panelDir !== '') own.push({ dir: panelDir, file: panelDir });
  for (const { dir, file } of own) {
    const realDir = realpathLoose(dir);
    if (isInsideOrEqual(realDir, realTarget)) {
      throw refusal(abs, `it is inside GM-Scriptorium's own settings folder (${dir})`, campaign, { kind: 'settings' });
    }
    if (isInsideOrEqual(realTarget, realpathLoose(file))) {
      throw refusal(abs, `it would hold GM-Scriptorium's own settings folder (${dir})`, campaign, { kind: 'holds-settings' });
    }
  }

  if (st === null) return { state: 'missing', litter: [], missingAncestors };

  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    throw refusal(abs, `it cannot be read (${err.code || err.message})`, campaign, { kind: 'unreadable' });
  }
  const litter = [];
  const others = [];
  const litterFiles = new Set(LITTER_FILES.map(fold));
  const litterDirs = new Set(LITTER_DIRS.map(fold));
  for (const entry of entries) {
    const key = fold(entry.name);
    if (entry.isDirectory() && litterDirs.has(key)) litter.push(`${entry.name}/`);
    else if (!entry.isDirectory() && litterFiles.has(key)) litter.push(entry.name);
    else others.push(entry.name);
  }
  if (others.length > 0) {
    others.sort();
    const shown = others.slice(0, 3).join(', ');
    const more = others.length > 3 ? ` and ${others.length - 3} more` : '';
    throw refusal(abs, `it is not empty (it holds ${shown}${more})`, campaign, { kind: 'not-empty', holds: others });
  }
  return { state: 'empty', litter: litter.sort(), missingAncestors: [] };
}

/** Every path checked, before anything exists. */
function assertStarterSafe(abs, starter, campaign) {
  const bad = (rel) => refusal(abs, `its starter holds a path that is not safe to create (${JSON.stringify(rel)})`, campaign);
  if (!starter || !Array.isArray(starter.dirs) || !Array.isArray(starter.files)) throw bad('(no starter)');
  const seen = new Set();
  const dirs = new Set();
  const note = (rel) => {
    const key = rel.toLowerCase();
    if (seen.has(key)) throw bad(rel);
    seen.add(key);
  };
  const parentListed = (rel) => {
    const at = rel.lastIndexOf('/');
    return at < 0 || dirs.has(rel.slice(0, at));
  };
  for (const rel of starter.dirs) {
    if (!validateStarterRel(rel)) throw bad(rel);
    note(rel);
    if (!parentListed(rel)) throw bad(rel);
    dirs.add(rel);
  }
  for (const file of starter.files) {
    if (!file || !validateStarterRel(file.rel) || !Buffer.isBuffer(file.data)) throw bad(file && file.rel);
    note(file.rel);
    if (!parentListed(file.rel)) throw bad(file.rel);
  }
}

/**
 * Creates the vault. Nothing is removed on failure; the error lists what was created.
 *
 * @param {string} targetAbs
 * @param {{ dirs: string[], files: { rel: string, data: Buffer }[] }} starter dirs parent first
 * @param {{ configPath?: string, panelDir?: string, campaign?: string|null }} [opts]
 * @returns {{ root: string, createdRoot: boolean, createdAncestors: string[], created: string[] }}
 *   created = starter rels in order, folders suffixed "/"
 * @throws {VaultUnreachableError} reason "new-vault", for every refusal and every failure
 */
function createVault(targetAbs, starter, opts = {}) {
  const campaign = opts.campaign === undefined ? null : opts.campaign;
  const abs = path.resolve(targetAbs);
  assertStarterSafe(abs, starter, campaign);
  const info = inspectTarget(abs, opts);

  const made = []; // absolute paths, in order, ancestors and root included
  const createdAncestors = [];
  const created = [];
  let createdRoot = false;

  function stop(why) {
    const list = made.length > 0 ? made.join(', ') : 'nothing';
    return new VaultUnreachableError(
      `stopped creating the vault in ${abs}: ${why}; created before stopping: ${list}. Nothing was removed. Delete that folder, or choose a new one, and try again.`,
      { path: abs, campaign, reason: 'new-vault' },
    );
  }

  function makeFolder(p) {
    try {
      fs.mkdirSync(p);
    } catch (err) {
      throw new Error(err && err.code === 'EEXIST' ? `${p} already exists` : err.message);
    }
    made.push(p);
  }

  function assertNewFolderIn(p, realParent) {
    const real = fs.realpathSync(p);
    if (fold(real) !== fold(path.join(realParent, path.basename(p)))) {
      throw new Error(`${p} resolves to ${real}, which is not a new folder inside ${realParent}`);
    }
    return real;
  }

  try {
    let realParent = null;
    for (const level of info.missingAncestors) {
      if (realParent === null) realParent = fs.realpathSync(path.dirname(level));
      makeFolder(level);
      createdAncestors.push(level);
      realParent = assertNewFolderIn(level, realParent);
    }
    let realRoot;
    if (info.state === 'missing') {
      if (realParent === null) realParent = fs.realpathSync(path.dirname(abs));
      makeFolder(abs);
      createdRoot = true;
      realRoot = assertNewFolderIn(abs, realParent);
    } else {
      realRoot = fs.realpathSync(abs);
    }

    const inRoot = (rel) => path.join(abs, ...rel.split('/'));
    const assertParentInRoot = (target) => {
      const parent = path.dirname(target);
      const realParentDir = fs.realpathSync(parent);
      if (!isInsideOrEqual(realRoot, realParentDir)) throw new Error(`${parent} resolves outside the new vault (${realParentDir})`);
    };

    for (const rel of starter.dirs) {
      const target = inRoot(rel);
      assertParentInRoot(target);
      makeFolder(target);
      created.push(`${rel}/`);
    }
    for (const file of starter.files) {
      const target = inRoot(file.rel);
      assertParentInRoot(target);
      try {
        fs.writeFileSync(target, file.data, { flag: 'wx' });
      } catch (err) {
        throw new Error(err && err.code === 'EEXIST' ? `${target} already exists` : err.message);
      }
      made.push(target);
      created.push(file.rel);
      // A parent swapped for a link after the check above would let the file land elsewhere: say so.
      const landed = fs.realpathSync(target);
      if (!isInsideOrEqual(realRoot, landed)) throw new Error(`${target} landed outside the new vault (${landed}); it was not removed`);
    }
  } catch (err) {
    throw stop(err && err.message ? err.message : String(err));
  }
  return { root: abs, createdRoot, createdAncestors, created };
}

module.exports = { LITTER_FILES, LITTER_DIRS, validateStarterRel, inspectTarget, createVault };
