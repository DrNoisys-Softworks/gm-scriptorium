'use strict';

/*
 * The panel's planner for _meta/vault-config.yaml. It turns field, title, tagline and put-back
 * edits into new file text with the pinned generator's own writer (through the facade), which keeps
 * the GM's comments. It writes nothing: the caller checks limits first and saves the bytes.
 *
 * The setting names are the generator's registry names. The panel's field list keeps its old
 * names as row keys, and each is mapped to the registry name through the registry's own record of
 * what a setting used to be called, never through a hand-written list.
 */

const pinned = require('../generator/pinned');
const { FIELD_SCHEMA, DISPLAY_PATHS } = require('./vaultconfigfields');

const { SettingsPlanError } = pinned;

/**
 * The registry name of the setting a pre-move name stood for. A leaf has its own record; a parent
 * (the palette, the fonts) is found from a child's record by taking the same tail off both names.
 *
 * @param {string} oldPath
 * @returns {string}
 */
function newNameOf(oldPath) {
  const { oldNameOf } = pinned.settingsNameMap();
  for (const [name, was] of Object.entries(oldNameOf)) {
    if (was === oldPath) return name;
  }
  for (const [name, was] of Object.entries(oldNameOf)) {
    if (!was.startsWith(`${oldPath}.`)) continue;
    const tail = was.slice(oldPath.length);
    if (name.endsWith(tail)) return name.slice(0, name.length - tail.length);
  }
  throw new Error(`the pinned generator has no setting that was called ${oldPath}`);
}

/** The panel's seven editable settings, under their registry names. `key` is the old name rows are keyed by. */
const YAML_FIELD_SCHEMA = Object.freeze(
  FIELD_SCHEMA.map((f) => Object.freeze({ ...f, path: newNameOf(f.path), key: f.path })),
);

const YAML_FIELD_BY_PATH = new Map(YAML_FIELD_SCHEMA.map((f) => [f.path, f]));

/** The read-only rows, under their registry names. */
const YAML_DISPLAY_PATHS = Object.freeze(
  DISPLAY_PATHS.map((d) => {
    const entry = { ...d, path: newNameOf(d.path) };
    if (d.path === 'publish.mode') entry.showIfSet = true;
    return Object.freeze(entry);
  }),
);

const REORDER_REFUSAL = (label) => `${label}: this list has comments inside it, and a new order would drop them. Use "Edit as text instead".`;

/**
 * The generator's changes that turn `current` into `wanted`. Removing and adding entries keeps the
 * list's comments; a new order does not, so a reorder of a list with comments in it is refused.
 *
 * @param {string} name a registry name
 * @param {string[]|undefined} current the list the file holds now, or undefined when it holds none
 * @param {string[]} wanted
 * @param {string} yamlText the file's text
 * @param {string} label the field's label, for the refusal
 * @returns {object[]}
 * @throws {SettingsPlanError} kind 'refused' for a reorder of a list with comments inside
 */
function listChanges(name, current, wanted, yamlText, label) {
  if (current === undefined) return [{ op: 'set', name, value: wanted }];
  // A duplicate is one entry: keep the first copy, in both lists, before comparing.
  const once = (list) => list.filter((v, i) => list.indexOf(v) === i);
  current = once(current);
  wanted = once(wanted);
  const removed = current.filter((v) => !wanted.includes(v));
  const added = wanted.filter((v) => !current.includes(v));
  const kept = current.filter((v) => !removed.includes(v));
  const result = kept.concat(added);
  const sameOrder = result.length === wanted.length && result.every((v, i) => v === wanted[i]);
  if (sameOrder) {
    const changes = [];
    if (removed.length) changes.push({ op: 'remove', name, entries: removed });
    if (added.length) changes.push({ op: 'add', name, entries: added });
    return changes;
  }
  if (pinned.settingsCommentsInside(yamlText, name)) {
    throw new SettingsPlanError('refused', REORDER_REFUSAL(label));
  }
  return [{ op: 'set', name, value: wanted }];
}

function getAt(data, name) {
  let cur = data;
  for (const seg of name.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function utf8(bytes) {
  return bytes.toString('utf8');
}

/**
 * @param {string} vaultPath
 * @param {Buffer} curBytes the file as the panel read it
 * @param {Object<string,*>} edits registry name > new value (a list for list fields)
 * @returns {{bytes: Buffer, changed: string[]}}
 * @throws {SettingsPlanError}
 */
function planFieldEdits(vaultPath, curBytes, edits) {
  const parsed = pinned.parseSettingsText(vaultPath, curBytes);
  if (!parsed.ok) throw new SettingsPlanError('unreadable', parsed.message, { line: parsed.line });
  const text = utf8(curBytes);
  for (const key of Object.keys(edits)) {
    if (!YAML_FIELD_BY_PATH.has(key)) throw new Error(`planFieldEdits: ${key} is not an editable setting name`);
  }
  const changes = [];
  for (const entry of YAML_FIELD_SCHEMA) {
    if (!Object.prototype.hasOwnProperty.call(edits, entry.path)) continue;
    const value = edits[entry.path];
    if (entry.kind === 'list') {
      const now = getAt(parsed.data, entry.path);
      changes.push(...listChanges(entry.path, Array.isArray(now) ? now : undefined, value, text, entry.label));
    } else {
      changes.push({ op: 'set', name: entry.path, value });
    }
  }
  const plan = pinned.planSettingsText(vaultPath, curBytes, changes);
  return { bytes: plan.after, changed: plan.changed };
}

/**
 * @param {string} vaultPath
 * @param {Buffer} curBytes
 * @param {{title?: string, tagline?: string}} values an empty tagline removes the line
 * @returns {{bytes: Buffer, changed: string[]}}
 * @throws {SettingsPlanError}
 */
function planTitleTagline(vaultPath, curBytes, { title, tagline } = {}) {
  const changes = [];
  if (title === '') throw new SettingsPlanError('refused', "The site title can't be empty.");
  if (title !== undefined) changes.push({ op: 'set', name: 'player_site.title', value: title });
  if (tagline !== undefined) {
    changes.push(tagline === ''
      ? { op: 'unset', name: 'player_site.theme.tagline' }
      : { op: 'set', name: 'player_site.theme.tagline', value: tagline });
  }
  const plan = pinned.planSettingsText(vaultPath, curBytes, changes);
  return { bytes: plan.after, changed: plan.changed };
}

/**
 * Put one entry back into a hide list.
 *
 * @param {string} vaultPath
 * @param {Buffer} candBytes the candidate file
 * @param {{path: string, entry: string}} item a registry name and the entry to add
 * @returns {{bytes: Buffer}}
 * @throws {SettingsPlanError}
 */
function planPutBack(vaultPath, candBytes, { path: name, entry }) {
  const plan = pinned.planSettingsText(vaultPath, candBytes, [{ op: 'add', name, entries: [entry] }]);
  return { bytes: plan.after };
}

module.exports = {
  YAML_FIELD_SCHEMA,
  YAML_FIELD_BY_PATH,
  YAML_DISPLAY_PATHS,
  listChanges,
  planFieldEdits,
  planTitleTagline,
  planPutBack,
};
