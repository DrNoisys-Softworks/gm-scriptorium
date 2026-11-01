'use strict';

const { isDeepStrictEqual } = require('util');
const pinned = require('../generator/pinned');
const { computeEffects } = require('./vaultconfigeffects');

/*
 * "What this changes" for an edit to _meta/vault-config.yaml, in the same words the review uses
 * for vault-config.md. The review's rules are written against the old file's names, so the yaml's
 * settings are put back under the old name the generator's registry keeps for each one, the rules
 * run unchanged, and every path they name is translated back to the yaml's own name. A setting with
 * no old name, and any key the registry does not list, is compared on its own and listed among the
 * other settings that change. Pure: nothing here reads or writes a file.
 */

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function getAt(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (!isPlainObject(cur) || !hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setAt(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/** Every leaf path of `obj` with its value: a scalar, a list or an empty map ends a path. */
function leafEntries(obj, prefix, out) {
  if (!isPlainObject(obj) || (Object.keys(obj).length === 0 && prefix !== '')) {
    if (prefix !== '') out.push([prefix, obj]);
    return out;
  }
  for (const key of Object.keys(obj)) leafEntries(obj[key], prefix ? `${prefix}.${key}` : key, out);
  return out;
}

/**
 * Splits the yaml's settings into the old file's shape and what has no old name.
 *
 * @param {object} data the yaml's own tree (parseSettingsText's `data`)
 * @returns {{ old: object, rest: Record<string, *> }} `old` holds each registry setting with an old
 *   name at that name; `rest` holds every other leaf (a registry setting with no old name, `version`,
 *   a key the registry does not list) under its own dotted path. Nothing is dropped.
 */
function toOldShape(data) {
  const { leaves, oldNameOf } = pinned.settingsNameMap();
  const old = {};
  const rest = {};
  const src = isPlainObject(data) ? data : {};
  const leafSet = new Set(leaves);
  for (const name of leaves) {
    const value = getAt(src, name);
    if (value === undefined) continue;
    if (hasOwn(oldNameOf, name)) setAt(old, oldNameOf[name], value);
    else rest[name] = value;
  }
  for (const [p, value] of leafEntries(src, '', [])) {
    // A path at or under a registry setting was placed above.
    const segs = p.split('.');
    let underSetting = false;
    for (let i = 1; i <= segs.length; i++) {
      if (leafSet.has(segs.slice(0, i).join('.'))) {
        underSetting = true;
        break;
      }
    }
    if (!underSetting) rest[p] = value;
  }
  return { old, rest };
}

let nameTable = null;

/** Old path > yaml name: the registry's old names turned round, plus the parents the rules name. */
function table() {
  if (!nameTable) {
    const { oldNameOf } = pinned.settingsNameMap();
    const t = new Map();
    for (const [name, oldName] of Object.entries(oldNameOf)) t.set(oldName, name);
    // The rules name these parent paths, which no registry entry names on its own.
    t.set('publish.overrides', 'player_site.hide.field_exceptions');
    t.set('publish.theme.palette', 'player_site.theme.palette');
    t.set('publish.theme.fonts', 'player_site.theme.fonts');
    nameTable = t;
  }
  return nameTable;
}

/**
 * The yaml's name for an old path: the longest old name that is the path or one of its parents,
 * with the rest of the path kept after its yaml name.
 *
 * @param {string} oldPath
 * @returns {string} the yaml name, or `oldPath` itself when no old name covers it
 */
function nameOf(oldPath) {
  let best = null;
  for (const key of table().keys()) {
    if ((oldPath === key || oldPath.startsWith(key + '.')) && (best === null || key.length > best.length)) best = key;
  }
  if (best === null) return oldPath;
  return table().get(best) + oldPath.slice(best.length);
}

/**
 * computeEffects over the yaml: both sides in the old shape, every path named the yaml's way, and
 * the settings with no old name compared on their own.
 *
 * @param {object} opts
 * @param {object|null} opts.cur the current yaml's tree, or null when it cannot be read
 * @param {object} opts.cand the candidate's tree
 * @param {object} opts.curPublish loadPublishConfig's result for the current file
 * @param {object} opts.candPublish loadPublishConfig's result for the candidate
 * @param {object|null} opts.jsonConfig
 * @param {object|null} [opts.publishSet] the candidate's publish set, or null
 * @param {object|null} [opts.publishDiff] runReview's publish comparison, or null
 * @param {Set<string>} opts.fixable OLD names (publish.exclude_fields and so on) of the hide lists a
 *   fix can put an entry back in; the list rules test it before any name is translated
 * @returns {Array<{id, group, level, path, title, detail, fix}>}
 */
function effectsForYaml({ cur, cand, curPublish, candPublish, jsonConfig, publishSet = null, publishDiff = null, fixable }) {
  const curShape = cur === null ? { old: null, rest: {} } : toOldShape(cur);
  const candShape = toOldShape(cand);
  const keys = new Set([...Object.keys(curShape.rest), ...Object.keys(candShape.rest)]);
  const extraChanged = [...keys].sort().filter((k) => !isDeepStrictEqual(curShape.rest[k], candShape.rest[k]));
  return computeEffects({
    cur: curShape.old,
    cand: candShape.old,
    curPublish,
    candPublish,
    jsonConfig,
    publishSet,
    fixable,
    publishDiff,
    nameOf,
    extraChanged,
    sortOther: true,
  });
}

/**
 * The build-command settings an edit changes. With no readable current file there is nothing to
 * compare against, so every command setting the candidate holds counts as changed.
 *
 * @param {object|null} curData the current yaml's tree, or null when it cannot be read
 * @param {object} candData the candidate's tree
 * @returns {string[]}
 */
function commandSettingsChanged(curData, candData) {
  return pinned.commandSettingNames().filter((name) => {
    const b = getAt(candData, name);
    if (curData === null) return b !== undefined;
    return !isDeepStrictEqual(getAt(curData, name), b);
  });
}

/** Why the panel refuses an edit to a build-command setting. */
function COMMAND_REFUSAL(names) {
  return (
    'The panel never changes ' +
    names.join(' or ') +
    '. They run commands on your computer when gm-apprentice publishes. Change them in _meta/vault-config.yaml yourself.'
  );
}

module.exports = { toOldShape, nameOf, effectsForYaml, commandSettingsChanged, COMMAND_REFUSAL };
