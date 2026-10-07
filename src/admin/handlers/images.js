'use strict';

const fs = require('fs');
const path = require('path');
const TOML = require('smol-toml');
const respond = require('../respond');
const body = require('../body');
const packimages = require('../packimages');
const packfiles = require('../packfiles');
// V1e-5 (ADR 0038, SD-50): called through the module object, same reason as packwrite below --
// a test can patch one of vaultart's two exports without touching the other.
const vaultart = require('../vaultart');
const read = require('../../vault/read');
const { runExclusive } = require('../context');
const { runSave } = require('./pack');
// Called through the module object, not destructured, for the same reason src/admin/handlers/pack.js
// already does this: a test can patch it to simulate the EEXIST backstop race deterministically.
const packwrite = require('../../vault/packwrite');
const { validateUploadName } = require('../uploadname');
const { parsePackToml } = require('../../build/packtoml');
const { planThemeAssets, MAX_IMAGE_BYTES } = require('../../build/themeassets');
const { SLOT_NAMES } = require('../../build/themes');
const { platformFoldsCase } = require('../../vault/exclusions');
const freshness = require('../freshness');
const { loadPackConfig } = require('../../cli/check');
const { ConfigError, ScriptoriumError } = require('../../util/errors');

/*
 * Phase 8 slice S5 (FR26, FR27). `image` was moved to this slice's file in slice S2 already
 * (FR15). `upload` and `saveSlots` are this slice's own work:
 *
 *  - `upload` (SD-1, SD-2, SD-4, SD-5) is the only place a client can name a file the panel
 *    writes; SD-7 keeps all of that logic here and in src/admin/uploadname.js, so pack.js gains
 *    nothing beyond the one hook and the exports line (SD-7).
 *  - `saveSlots` (SD-3) reuses src/admin/handlers/pack.js's runSave exactly the way saveTheme and
 *    saveSettings do, with one addition: a candidateCheck hook that runs planThemeAssets against
 *    the CANDIDATE pack.toml only, so a slot that is already broken on disk can still be cleared
 *    (the runSave problem, "Architectural context").
 */

function notAvailableYet(req, res) {
  respond.send(res, 501, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify({ error: 'not available yet' }));
}

/** GET /api/image?name=. FR14: `name` must exactly equal a listPackImages() entry. FR15: an image response carries a sandbox CSP, never the admin CSP. */
function image(req, res, ctx, { query }) {
  const name = query.get('name');
  if (!name) {
    respond.send(res, 400, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify({ error: 'missing name' }));
    return;
  }
  const found = packimages.readPackImage(ctx, name);
  if (!found) {
    respond.send(res, 404, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }), 'not found');
    return;
  }
  respond.send(
    res,
    200,
    respond.adminHeaders({ 'Content-Type': found.contentType, 'Content-Security-Policy': packimages.IMAGE_CSP }),
    found.bytes,
  );
}

// --- GET /api/vault-art, GET /api/vault-art/file?name= (V1e-5, ADR 0038, SD-50) ----------------

/** GET /api/vault-art. Read-only; never throws -- unavailability is data, not a 500. */
function vaultArtList(req, res, ctx) {
  respond.send(
    res,
    200,
    respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
    JSON.stringify(vaultart.listVaultArt(ctx)),
  );
}

/** GET /api/vault-art/file?name=. `name` must exactly equal an entry of the LAST listing. */
function vaultArtFile(req, res, ctx, { query }) {
  const name = query.get('name');
  if (!name) {
    respond.send(res, 400, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify({ error: 'missing name' }));
    return;
  }
  const found = vaultart.readVaultArt(ctx, name);
  if (!found) {
    respond.send(res, 404, respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }), 'not found');
    return;
  }
  respond.send(
    res,
    200,
    respond.adminHeaders({ 'Content-Type': found.contentType, 'Content-Security-Policy': packimages.IMAGE_CSP }),
    found.bytes,
  );
}

// --- POST /api/pack/slots (FR26, SD-3) ----------------------------------------------------------

const FORBIDDEN_SLOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} slots
 * @returns {object} a clean, own-property-only copy of `slots`
 * @throws {ConfigError}
 */
function validateSlotEdits(slots) {
  if (typeof slots !== 'object' || slots === null || Array.isArray(slots)) {
    throw new ConfigError('slots must be a table of slot names');
  }

  const out = {};
  for (const key of Object.keys(slots)) {
    if (FORBIDDEN_SLOT_KEYS.has(key)) {
      throw new ConfigError(`the key "${key}" is not allowed`);
    }
    if (!SLOT_NAMES.includes(key)) {
      throw new ConfigError(`unknown slot "${key}"; slots are ${SLOT_NAMES.join(', ')}`);
    }
    const value = slots[key];
    if (value !== null && (typeof value !== 'string' || value.length === 0 || value.length > 1024)) {
      throw new ConfigError(`slot "${key}" must be a non-empty path or null`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Sets or clears the given slots in `raw`'s [images] table. `null` clears a slot; an empty
 * resulting [images] table is removed entirely, never written back empty. Every other key, table
 * and unrecognised on-disk slot key survives untouched.
 *
 * @param {string} raw
 * @param {object} slots slot name -> new value or null (already through validateSlotEdits)
 * @returns {string}
 */
function editPackTomlSlots(raw, slots) {
  const parsed = TOML.parse(raw);
  const images = { ...(typeof parsed.images === 'object' && parsed.images !== null ? parsed.images : {}) };
  for (const [key, value] of Object.entries(slots)) {
    if (value === null) delete images[key];
    else images[key] = value;
  }

  const next = { ...parsed };
  if (Object.keys(images).length === 0) {
    delete next.images;
  } else {
    next.images = images;
  }
  return TOML.stringify(next);
}

/** POST /api/pack/slots (FR26). */
async function saveSlots(req, res, ctx) {
  await runSave(req, res, ctx, {
    name: 'pack.toml',
    allowedKeys: ['slots', 'baseSha256', 'dryRun'],
    baseShaAllowsNull: false,
    requireAtLeastOneOf: ['slots'],
    validateFields: (parsed) => ({ slots: validateSlotEdits(parsed.slots) }),
    buildCandidate: (raw, fields) => editPackTomlSlots(raw, fields.slots),
    productParse: (text, ctx2) => parsePackToml(text, { tomlPath: path.join(ctx2.packDir, 'pack.toml'), campaign: ctx2.campaign }),
    candidateCheck: (text, parseResult, ctx2) =>
      planThemeAssets({
        vaultPath: ctx2.vaultPath,
        jsonConfig: { ...loadPackConfig(ctx2.siteConfigPath, ctx2.campaign), vaultPath: ctx2.vaultPath },
        siteDir: ctx2.packDir,
        packToml: parseResult,
        campaign: ctx2.campaign,
      }),
  });
}

// --- POST /api/images/upload?name= (FR27, SD-1, SD-2, SD-4, SD-5) -------------------------------

/** A specific, already-decided HTTP response, thrown from inside the write-locked section. */
class UploadRefusal extends Error {
  constructor(status, payload) {
    super('admin upload refusal');
    this.status = status;
    this.payload = payload;
  }
}

function sendJson(res, status, payload) {
  respond.send(res, status, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), JSON.stringify(payload));
}

function imagesDirFor(ctx) {
  return path.join(ctx.packDir, 'images');
}

/**
 * SD-4: `images/` must be a real folder. A missing `images/` is fine (it will be created below);
 * otherwise its real path must equal `<real packDir>/images` EXACTLY (folded per
 * platformFoldsCase), never merely "inside" or "starts with" -- that is what catches a symlink to
 * an ancestor, to an outside folder, to a prefix-named sibling ("images-real"), or a Windows
 * junction, while still accepting an ordinary real folder.
 *
 * @throws {UploadRefusal} 400
 */
function assertImagesIsRealFolder(ctx) {
  const dir = imagesDirFor(ctx);
  if (!fs.existsSync(dir)) return;

  let realPackDir;
  let realImages;
  try {
    realPackDir = fs.realpathSync(ctx.packDir);
    realImages = fs.realpathSync(dir);
  } catch (err) {
    throw new UploadRefusal(503, { error: 'io', message: err.message });
  }

  const expected = path.join(realPackDir, 'images');
  const fold = (s) => (platformFoldsCase() ? s.toLowerCase() : s);
  if (fold(realImages) !== fold(expected)) {
    throw new UploadRefusal(400, { error: 'invalid', message: 'images/ in the campaign pack must be a real folder, not a link' });
  }
}

/**
 * SD-5: the top level of `images/`, listed through read.listDir (so a test can exercise the same
 * chokepoint the rest of the vault-facing code uses), compared to `name` for EQUALITY, folded per
 * platformFoldsCase. Never a prefix match: "crest.png.old.webp" must not collide with "crest.png".
 *
 * @throws {UploadRefusal} 409
 */
function assertNoCollision(ctx, name) {
  const dir = imagesDirFor(ctx);
  if (!fs.existsSync(dir)) return;

  let entries;
  try {
    entries = read.listDir(dir);
  } catch {
    return; // an unreadable images/ is not this function's problem; createPackEntries will fail loudly
  }

  const fold = (s) => (platformFoldsCase() ? s.toLowerCase() : s);
  const foldedName = fold(name);
  const collision = entries.some((e) => fold(e.name) === foldedName);
  if (collision) {
    throw new UploadRefusal(409, { error: 'exists', message: `images/${name} already exists; uploads never replace a file` });
  }
}

/** Steps 6-9 of the upload handler order, run inside runExclusive. */
function performUpload(ctx, name, bytes) {
  assertImagesIsRealFolder(ctx); // 7 (SD-4)
  assertNoCollision(ctx, name); // 8 (SD-5)

  // 9. The actual write, through the one write chokepoint (called via the module object so a
  // test can patch it to simulate the EEXIST race deterministically -- the same reasoning as
  // src/admin/handlers/pack.js's own require of this module).
  try {
    packwrite.createPackEntries(
      ctx.vaultPath,
      [
        { rel: 'images', kind: 'dir' },
        { rel: `images/${name}`, kind: 'file', data: bytes },
      ],
      { campaign: ctx.campaign },
    );
  } catch (err) {
    if (err instanceof ConfigError) {
      // SD-5 backstop: covers NTFS 8.3 short-name collisions and the FR22-style same-request
      // race, both of which fail closed as EEXIST at the fs layer rather than at the listing
      // comparison above.
      const nowExists = fs.existsSync(path.join(imagesDirFor(ctx), name));
      if (nowExists) {
        throw new UploadRefusal(409, { error: 'exists', message: `images/${name} already exists; uploads never replace a file` });
      }
      // Risk area 5: createPackEntries's own message may include an absolute path; show it as
      // plain text only, never mapped to a 500.
      throw new UploadRefusal(400, { error: 'invalid', message: err.message });
    }
    throw new UploadRefusal(503, { error: 'io', message: err.message });
  }

  const sha256 = packfiles.sha256Hex(bytes);
  return { status: 200, body: { ok: true, name, rel: `images/${name}`, size: bytes.length, sha256 } };
}

/** POST /api/images/upload?name= (FR27). */
async function upload(req, res, ctx, { query }) {
  // 1. Writable.
  if (!ctx.writable) {
    sendJson(res, 403, { error: 'read-only', message: ctx.readOnlyReason });
    return;
  }

  // 2. Content-Type, checked BEFORE the body is read (Risk area 1).
  const contentType = req.headers['content-type'];
  if (contentType !== 'application/octet-stream') {
    sendJson(res, 400, { error: 'invalid', message: 'uploads must be sent as application/octet-stream' });
    return;
  }

  // 3. Name.
  let name;
  try {
    name = validateUploadName(query.get('name'));
  } catch (err) {
    sendJson(res, 400, { error: 'invalid', message: err.message });
    return;
  }

  // 4. Body (SD-1: the cap is exactly MAX_IMAGE_BYTES, so FR13's upload overhead is 0). Called
  // through the module object like everywhere else on this write path, so a mutation test can
  // patch it to prove the size check is not merely trusting a declared Content-Length.
  const bodyResult = await body.readBody(req, MAX_IMAGE_BYTES);
  if (!bodyResult.ok) {
    respond.send(
      res,
      413,
      respond.adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }),
      'refused: too large',
    );
    return;
  }
  const bytes = bodyResult.body;

  // 5. Empty body.
  if (bytes.length === 0) {
    sendJson(res, 400, { error: 'invalid', message: 'the upload is empty' });
    return;
  }

  // 6. Lock, then steps 7-9.
  let outcome;
  try {
    outcome = await runExclusive(ctx, 'write', () => performUpload(ctx, name, bytes));
  } catch (err) {
    if (err instanceof UploadRefusal) {
      sendJson(res, err.status, err.payload);
      return;
    }
    throw err;
  }

  if (!outcome.ok) {
    sendJson(res, 409, { error: 'busy', busy: outcome.busy });
    return;
  }
  // V1e-3 (SD-17): an upload never touches the three tracked files, so it only ever moves the
  // save counter (panelSavesSince), never savedSince.
  freshness.noteSaveIfWritten(ctx, outcome.value);
  sendJson(res, outcome.value.status, outcome.value.body);
}

module.exports = { image, saveSlots, upload, validateSlotEdits, editPackTomlSlots, vaultArtList, vaultArtFile };
