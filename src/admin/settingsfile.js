'use strict';

const { refreshSettingsLayout } = require('./context');

/*
 * Which settings file a request to the settings editor was built against. The browser names the
 * file it loaded in every request (`file`). A request that names none is an older page, built
 * against vault-config.md. When the vault's settings are no longer in that file, the request is
 * refused as changed, so a page loaded before gm-apprentice moved the settings (or moved them
 * back) never saves into the wrong file.
 */

const FILE_MD = 'vault-config.md';
const FILE_YAML = 'vault-config.yaml';

const MOVED_SINCE_LOADED =
  "This vault's settings moved to _meta/vault-config.yaml after the page loaded. Nothing was saved. Reload to edit them there.";
const BACK_SINCE_LOADED =
  "This vault's settings are in _meta/vault-config.md again since the page loaded. Nothing was saved. Reload to edit them there.";

/**
 * @param {string|null} layout settingsLayoutOf's answer
 * @returns {string|null} the file the editor edits on that layout, or null when there is none
 */
function fileForLayout(layout) {
  if (layout === 'new') return FILE_YAML;
  if (layout === 'legacy') return FILE_MD;
  return null;
}

/**
 * @param {object} body the parsed request body
 * @returns {string} the file the request names, vault-config.md when it names none
 */
function requestedFile(body) {
  return Object.prototype.hasOwnProperty.call(body, 'file') ? body.file : FILE_MD;
}

/**
 * @param {object} body the parsed request body
 * @returns {string|null} why the `file` key is not acceptable, or null
 */
function fileKeyProblem(body) {
  const file = requestedFile(body);
  if (file === FILE_MD || file === FILE_YAML) return null;
  return `file must be "${FILE_MD}" or "${FILE_YAML}"`;
}

/**
 * Reads the layout from the disk now and compares it with the file the request names.
 *
 * vault-config.md is refused only when the settings moved: on a vault with neither file, the
 * vault-config.md editor gives its own answer, as it always has.
 *
 * @param {object} ctx an admin context
 * @param {string} requested requestedFile's answer
 * @returns {null | { status: 409, payload: { error: 'changed', message: string } }}
 */
function fileMismatch(ctx, requested) {
  const layout = refreshSettingsLayout(ctx);
  const ok = requested === FILE_YAML ? layout === 'new' : layout !== 'new';
  if (ok) return null;
  let message;
  if (requested === FILE_MD && layout === 'new') message = MOVED_SINCE_LOADED;
  else if (requested === FILE_YAML && layout === 'legacy') message = BACK_SINCE_LOADED;
  else message = `${requested} changed outside the panel. Reload before saving.`;
  return { status: 409, payload: { error: 'changed', message } };
}

module.exports = { FILE_MD, FILE_YAML, MOVED_SINCE_LOADED, BACK_SINCE_LOADED, fileForLayout, requestedFile, fileKeyProblem, fileMismatch };
