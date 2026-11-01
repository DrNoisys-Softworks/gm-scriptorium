'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { createFinding } = require('../report/finding');
const { readSettingsFiles } = require('../vault/publishset');
const pinned = require('../generator/pinned');
const { platformFoldsCase } = require('../vault/exclusions');
const { resolveMachineDir, BACKUPS_DIRNAME, campaignSegment } = require('../config/machinedir');

/*
 * What `check` says about the pack's leftover settings on a vault whose settings moved to
 * _meta/vault-config.yaml (ADR 0071). From the move on, the generator reads those settings from the
 * yaml only; a value still in the pack's vault.config.json is not read. A GM runs
 * "gm-scriptorium carry" to fold the pack's values into the yaml. Until then:
 *
 *   - a hide-list entry the pack holds and the vault's list lacks would be lost, so it is an ERROR
 *     (config/pack-hiding-not-carried): the page or section it hid would publish;
 *   - a vault folder map that is missing or cannot be read, with none in the pack for the carry to bring
 *     (config/folder-map-missing, ERROR), or one the pin cannot read whatever the pack holds: the carry
 *     keeps a value the vault's settings hold, so the GM sets or fixes it in the yaml;
 *   - a folder map the pack holds and the vault does not set is an ERROR (config/folder-map-not-carried):
 *     the build would map no folder and publish a near-empty site over the players' one;
 *   - any other setting the pack holds and the vault does not set is a WARN
 *     (config/pack-setting-not-carried);
 *   - a setting the pack and the vault both set, to different values, is a WARN
 *     (config/pack-setting-differs); the vault's value is the one used.
 *
 * It also reports a _meta/vault-config.md that the move left beside the yaml
 * (config/leftover-settings-file, WARN), from the pin's own "dropped" fault.
 *
 * The findings come from the pin's own fault list (kind 'old-name', source 'site'), so the keys
 * and settings are the pin's, not a list kept here. A setting the pin reports but no longer reads
 * (landingTagline, `read: false` in its registry entry) is never reported: there is nothing to
 * carry. Nothing here writes to the vault.
 */

/** The real path of a file, or its resolved path when it cannot be resolved. */
function realOrResolved(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Is `packConfigPath` the pack in this vault (`<vault>/_meta/scriptorium/vault.config.json`)? The carry
 * rewrites only that file, so only for it can `check` and `build` name the carry command. A campaign
 * on `site_config`, or on a `pack` outside the vault, moves its settings by hand.
 *
 * @param {string} vaultPath
 * @param {string|null|undefined} packConfigPath
 * @returns {boolean}
 */
function isVaultPack(vaultPath, packConfigPath) {
  if (!packConfigPath) return false;
  const fold = (s) => (platformFoldsCase() ? s.toLowerCase() : s);
  const expected = path.join(realOrResolved(path.join(realOrResolved(vaultPath), '_meta', 'scriptorium')), 'vault.config.json');
  return fold(realOrResolved(packConfigPath)) === fold(expected);
}

/** The carry can reach this site config: it is the pack in the vault, or the context does not say which file it is. */
const carryReaches = (vaultPath, packConfigPath) => !packConfigPath || isVaultPack(vaultPath, packConfigPath);

/** What to do about one pack setting the vault's settings lack: the carry, or a hand edit when the carry cannot reach the file. */
function carryHint(campaign, vaultPath, packConfigPath) {
  if (!carryReaches(vaultPath, packConfigPath)) {
    return 'Move it into _meta/vault-config.yaml by hand: the carry only rewrites the pack in the vault.';
  }
  return `Run "gm-scriptorium carry ${campaign}" to move it into the vault's settings.`;
}

const FOLDER_MAP = 'player_site.folder_map';

/**
 * Where a GM can get a folder map back from: a copy that really holds one, among the backups a carry or
 * init kept in the per-machine folder. The carry's copy of the yaml is taken before the carry writes the
 * folder map, so it usually holds none; the pack's copy then holds it as `folderMap`. Reads only.
 *
 * Order: the newest yaml copy whose player_site.folder_map the pin reads (`yaml`), else the newest pack
 * copy with a non-empty folderMap object (`pack`), else null.
 *
 * @param {string|null} configPath Scriptorium's own config file
 * @param {string} vaultPath
 * @param {string} campaign
 * @returns {{ kind: 'yaml'|'pack', file: string }|null}
 */
function folderMapCopy(configPath, vaultPath, campaign) {
  let dir;
  let names;
  try {
    const machine = resolveMachineDir({ configPath, vaultPath });
    if (!machine.ok) return null;
    dir = path.join(machine.dir, BACKUPS_DIRNAME, campaignSegment(campaign));
    names = fs.readdirSync(dir).sort().reverse(); // the stamp in each name sorts oldest first
  } catch {
    return null;
  }
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return null;
    }
  };
  for (const name of names.filter((n) => /^vault-config-.*\.yaml\.bak$/.test(n))) {
    const text = read(name);
    if (text === null) continue;
    try {
      if (pinned.readSettingValues(vaultPath, {}, { md: null, yaml: text }).origins[FOLDER_MAP] === 'file') return { kind: 'yaml', file: path.join(dir, name) };
    } catch {
      // a copy the pin cannot read holds nothing to restore
    }
  }
  for (const name of names.filter((n) => /^vault\.config-.*\.json\.bak$/.test(n))) {
    const text = read(name);
    if (text === null) continue;
    try {
      const map = JSON.parse(text).folderMap;
      if (map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length > 0) return { kind: 'pack', file: path.join(dir, name) };
    } catch {
      // not JSON: nothing to restore from it
    }
  }
  return null;
}

/**
 * N1: on a moved vault, the vault's own folder map is not set or cannot be read, and the pack holds no
 * folder map that the carry checks already name. The build would map no folder and publish almost
 * nothing, so it is an error in check and the build refuses it. What to do, naming a backup only when
 * it really holds a folder map (folderMapCopy); null when the map is fine.
 *
 * @param {{ origin: string, shown: * }} folderMap from unheldPackSettings
 * @param {{ configPath?: string|null, vaultPath: string, campaign: string }} where
 * @returns {string|null}
 */
function yamlFolderMapProblem(folderMap, { configPath, vaultPath, campaign }) {
  if (!folderMap || folderMap.origin === 'file') return null;
  const copy = folderMapCopy(configPath, vaultPath, campaign);
  const inline = copy && copy.kind === 'yaml' ? `, or restore it from the copy of that file kept at ${copy.file}` : '';
  const after = copy && copy.kind === 'pack' ? ` The pack's folderMap as it was before the carry is kept at ${copy.file}.` : '';
  const lead = folderMap.origin === 'fault'
    ? `${FOLDER_MAP} in _meta/vault-config.yaml is ${show(folderMap.shown)}, which cannot be read, so the build would publish none of the vault's folders. Fix`
    : `_meta/vault-config.yaml sets no ${FOLDER_MAP}, so the build would publish none of the vault's folders. Set`;
  return `${lead} ${FOLDER_MAP} in _meta/vault-config.yaml${inline}.${after}`;
}

/** The vault's settings file sets this setting: readably ('file'), or with a value the pin cannot read ('fault'). The carry never overwrites either. */
const vaultSets = (origin) => origin === 'file' || origin === 'fault';

/** The value at a dotted name in a nested object, or undefined. */
function valueAt(obj, dotted) {
  let at = obj;
  for (const seg of dotted.split('.')) {
    if (!at || typeof at !== 'object') return undefined;
    at = at[seg];
  }
  return at;
}

/**
 * How the scanner would spell a hide-list folder, lower-cased as it matches them; an entry the pin
 * cannot spell is kept as written.
 */
function folderKey(entry, vaultPath) {
  const spelled = typeof entry === 'string' ? pinned.normalizeExcludeDir(entry, vaultPath, false) : null;
  return String(spelled || entry).toLowerCase();
}

/** The pack entries of a list that the vault's list lacks. Folders are compared as the scanner spells them. */
function missingEntries(packKey, packList, vaultList, vaultPath) {
  // A section name is read by the build through its single headingKey, so two names with equal keys hide
  // the same headings. A title's other readings (titleNamedIn) must not be used here: they would call
  // "[[Real Name|Display]]" held by "Real Name" while the pack strips "Display" and the vault does not.
  if (packKey === 'excludeSections') {
    const held = new Set(vaultList.map((v) => pinned.headingKey(String(v))));
    return packList.filter((e) => !held.has(pinned.headingKey(String(e))));
  }
  const key = packKey === 'excludeDirs' ? (e) => folderKey(e, vaultPath) : (e) => e;
  const held = new Set(vaultList.map(key));
  return packList.filter((e) => !held.has(key(e)));
}

/**
 * Does the vault's setting already hold what the pack holds, so that carrying would change nothing?
 * An array is held when every pack entry is in the vault's array (folders as the scanner spells
 * them). excludeCallouts is held when the stricter of the two values is the vault's own. An object
 * is held when every pack key is in the vault's object with an equal value. Anything else is held
 * when the two are equal.
 *
 * @param {string} packKey the pack's key (`excludeDirs`, `siteTitle`, a dotted `backend.statusBar`)
 * @param {*} packValue
 * @param {*} vaultValue the vault's value for the setting, its default when the file does not set it
 * @param {string} [vaultPath] resolves a folder entry written as an absolute path
 * @returns {boolean}
 */
function isHeldByVault(packKey, packValue, vaultValue, vaultPath) {
  if (packKey === 'excludeCallouts') return isDeepStrictEqual(pinned.stricterCallouts(vaultValue, packValue), vaultValue);
  if (Array.isArray(packValue)) {
    return Array.isArray(vaultValue) && missingEntries(packKey, packValue, vaultValue, vaultPath).length === 0;
  }
  if (packValue && typeof packValue === 'object') {
    if (!vaultValue || typeof vaultValue !== 'object' || Array.isArray(vaultValue)) return false;
    return Object.keys(packValue).every((k) => Object.prototype.hasOwnProperty.call(vaultValue, k) && isDeepStrictEqual(packValue[k], vaultValue[k]));
  }
  return isDeepStrictEqual(packValue, vaultValue);
}

/** True when the pin no longer reads this site-file name (`read: false` on the registry entry's old name). */
function pinIgnores(fault) {
  const entry = pinned.settingEntry(fault.setting);
  const was = entry && (entry.was || []).find((w) => w.in === 'site' && w.name === fault.name);
  return Boolean(was && was.read === false);
}

function show(value) {
  return JSON.stringify(value);
}

/**
 * The three carry checks share one read of the pin's faults and the vault's settings, so they are
 * produced together and split by id. Quiet on a legacy vault, where the pack is still read.
 */
const cache = new WeakMap();
function carryFindings(ctx) {
  if (!cache.has(ctx)) cache.set(ctx, computeCarryFindings(ctx));
  return cache.get(ctx);
}

/**
 * The pin's faults for a pack, and the ones the vault's settings do not already hold: the pack's
 * `old-name` faults (kind 'old-name', source 'site') for settings the pin still reads, minus those
 * whose value the vault holds (isHeldByVault). Each entry carries the pin's fault and the vault's
 * value for the setting. The carry (src/vault/settingscarry.js) asks the same question, before and
 * after it runs, so what `check` reports and what the carry moves cannot drift apart.
 *
 * @param {string} vaultPath
 * @param {object} packConfig the pack as read (vault.config.json content)
 * @param {{ md: string|null, yaml: string|null }} files the vault's settings files
 * @returns {{ faults: object[], unheld: { fault: object, vaultValue: *, origin: string, vaultShown?: * }[], origins: object,
 *   folderMap: { origin: string, shown: * }, shownOf: function }} `vaultShown`, only for origin 'fault': the value as the vault's settings file
 *   wrote it, which the pin cannot read. `origins`: where the pin found each setting. `folderMap`: the vault's own
 *   player_site.folder_map, its origin and (when it cannot be read) the value as written. `shownOf(setting)`: that
 *   raw value for any setting the pin cannot read
 * @throws a settings file the pin cannot parse
 */
function unheldPackSettings(vaultPath, packConfig, files) {
  const faults = pinned.settingFaults(vaultPath, packConfig, files);
  const settings = pinned.readSettingValues(vaultPath, packConfig, files);
  const unheld = [];
  for (const fault of faults) {
    if (fault.kind !== 'old-name' || fault.source !== 'site' || !fault.setting) continue;
    if (pinIgnores(fault)) continue;
    const vaultValue = valueAt(settings.values, fault.setting);
    if (isHeldByVault(fault.name, fault.value, vaultValue, vaultPath)) continue;
    const origin = settings.origins[fault.setting];
    const entry = { fault, vaultValue, origin };
    if (origin === 'fault') {
      const unreadable = faults.find((f) => f.kind === 'not-allowed' && f.setting === fault.setting && f.source !== 'site');
      entry.vaultShown = unreadable ? unreadable.value : undefined;
    }
    unheld.push(entry);
  }
  const shownOf = (setting) => {
    const unreadable = faults.find((f) => f.kind === 'not-allowed' && f.setting === setting && f.source !== 'site');
    return unreadable ? unreadable.value : undefined;
  };
  const folderMap = { origin: settings.origins[FOLDER_MAP], shown: settings.origins[FOLDER_MAP] === 'fault' ? shownOf(FOLDER_MAP) : undefined };
  return { faults, unheld, origins: settings.origins, values: settings.values, folderMap, shownOf };
}

/**
 * The pack settings a moved vault must not be built without (ADR 0071, section 12): a hide-list entry
 * the vault's settings lack (the pin's own stop level), and a folder map the vault's settings do not
 * set. Built without them, the site would publish what the pack hid, or map no folder at all. `build`
 * refuses on these whatever its flags, because `check` does not run under --no-check and is
 * overridden by --force-check.
 *
 * @param {{ fault: object, origin: string }[]} unheld from unheldPackSettings
 * @returns {{ fault: object, vaultValue: *, origin: string }[]}
 */
function buildBlockers(unheld) {
  // A folder map the vault's settings hold but the pin cannot read maps no folder either.
  return unheld.filter((u) => u.fault.level === 'stop' || (u.fault.name === 'folderMap' && u.origin !== 'file'));
}

/** A folder map whose vault value the pin cannot read: the carry keeps it, so only a fix in the yaml helps. */
const unreadableMap = (u) => u.fault.name === 'folderMap' && u.fault.level !== 'stop' && u.origin === 'fault';
const fixYaml = (setting) => `Fix ${setting} in _meta/vault-config.yaml; the carry leaves it as it is.`;

/**
 * The one line `build` refuses with: the pack's path, each entry the vault's settings lack, and what
 * to do (the carry, or a hand edit when the site config is not the pack in the vault).
 *
 * @param {{ campaign: string, vaultPath: string, packConfigPath: string, blockers: object[] }} args
 * @returns {string}
 */
function packNotCarriedMessage({ campaign, vaultPath, packConfigPath, blockers }) {
  const named = blockers.map((u) => {
    const { fault, vaultValue } = u;
    if (unreadableMap(u)) return `${fault.name} (${fault.setting} in _meta/vault-config.yaml is ${show(u.vaultShown)}, which cannot be read)`;
    if (fault.name === 'folderMap' && fault.level !== 'stop') return fault.name;
    if (Array.isArray(fault.value)) {
      const lacks = missingEntries(fault.name, fault.value, Array.isArray(vaultValue) ? vaultValue : [], vaultPath).map(String);
      if (lacks.length) return `${fault.name} (${lacks.map((e) => `"${e}"`).join(', ')})`;
    }
    return `${fault.name} (${show(fault.value)})`;
  });
  const todo = [];
  if (blockers.some((u) => !unreadableMap(u))) {
    todo.push(isVaultPack(vaultPath, packConfigPath)
      ? `Run "gm-scriptorium carry ${campaign}" to move them into _meta/vault-config.yaml.`
      : 'Move them into _meta/vault-config.yaml by hand: the carry only rewrites the pack in the vault.');
  }
  const unreadable = blockers.find(unreadableMap);
  if (unreadable) todo.push(fixYaml(unreadable.fault.setting));
  return (
    `campaign "${campaign}": ${packConfigPath} still holds settings that _meta/vault-config.yaml does not, ` +
    `and the build no longer reads them there: ${named.join(', ')}. ${todo.join(' ')} Nothing was written.`
  );
}

function computeCarryFindings(ctx) {
  if (ctx.settingsLayout !== 'new' || !ctx.rawSiteConfig) return [];
  const files = readSettingsFiles(ctx.vaultPath);
  let faults;
  let unheld;
  let origins;
  let values;
  let folderMap;
  let shownOf;
  try {
    ({ faults, unheld, origins, values, folderMap, shownOf } = unheldPackSettings(ctx.vaultPath, ctx.rawSiteConfig, files));
  } catch {
    // A settings file the pin cannot parse is reported where it is read (the build stops on the
    // pin's own error); there are no resolved values here to compare the pack with.
    return [];
  }
  // A campaign on site_config, or on a pack outside the vault, holds its settings in a file the carry
  // does not rewrite: name that file for what it is, and say to move the setting by hand.
  const reached = carryReaches(ctx.vaultPath, ctx.packConfigPath);
  const file = reached ? 'the pack' : 'the site config';
  const hint = carryHint(ctx.campaign, ctx.vaultPath, ctx.packConfigPath);
  const findings = [];
  for (const fault of faults) {
    // The pin's own "dropped" fault for the old settings page (setting null; a dropped folder entry has one).
    if (fault.kind === 'dropped' && fault.setting === null && fault.name === '_meta/vault-config.md') {
      findings.push(createFinding({
        id: 'config/leftover-settings-file',
        severity: 'warn',
        category: 'config',
        campaign: ctx.campaign,
        path: '_meta/vault-config.md',
        message: "_meta/vault-config.md is left over from before gm-apprentice's update and is not read. This vault's settings are in _meta/vault-config.yaml.",
        data: {},
      }));
    }
  }
  for (const { fault, vaultValue, origin, vaultShown } of unheld) {
    const base = { category: 'config', campaign: ctx.campaign, path: null };
    const data = { packKey: fault.name, setting: fault.setting };
    if (fault.level === 'stop') {
      const entries = Array.isArray(fault.value) && Array.isArray(vaultValue)
        ? missingEntries(fault.name, fault.value, vaultValue, ctx.vaultPath).map(String)
        : (Array.isArray(fault.value) ? fault.value.map(String) : []);
      const what = entries.length
        ? `${entries.map((e) => `"${e}"`).join(', ')} would be published`
        : 'what it hides would be published';
      findings.push(createFinding({
        ...base,
        id: 'config/pack-hiding-not-carried',
        severity: 'error',
        message: `${fault.name} in ${file} hides more than the vault's settings do (${fault.setting}), and the build no longer reads ${file}, so ${what}. ${hint}`,
        data: { ...data, entries },
      }));
    } else if (fault.name === 'folderMap' && origin === 'fault') {
      // The vault's settings hold a folder map the pin cannot read: the build maps no folder, and the carry
      // keeps the vault's value, so only a fix in the yaml helps: config/folder-map-missing,
      // not the carry's own id.
      findings.push(createFinding({
        ...base,
        id: 'config/folder-map-missing',
        severity: 'error',
        message: `${fault.setting} in _meta/vault-config.yaml is ${show(vaultShown)}, which cannot be read, so the build would publish none of the mapped folders. The folder map in ${file} is not read either. ${fixYaml(fault.setting)}`,
        data,
      }));
    } else if (origin === 'fault') {
      findings.push(createFinding({
        ...base,
        id: 'config/pack-setting-differs',
        severity: 'warn',
        message: `${fault.name} in ${file} is ${show(fault.value)}, but the vault's settings set ${fault.setting} to ${show(vaultShown)}, which cannot be read. The carry leaves it as it is: fix ${fault.setting} in _meta/vault-config.yaml.`,
        data,
      }));
    } else if (origin === 'file') {
      findings.push(createFinding({
        ...base,
        id: 'config/pack-setting-differs',
        severity: 'warn',
        message: `${fault.name} in ${file} is ${show(fault.value)}, but the vault's settings set ${fault.setting} to ${show(vaultValue)}; the vault's value is used. ${hint}`,
        data,
      }));
    } else if (fault.name === 'folderMap') {
      // The build reads no folder map from the pack, and with none in the vault's settings it maps no
      // folder at all: it would publish a near-empty site over the players' one, with exit 0.
      findings.push(createFinding({
        ...base,
        id: 'config/folder-map-not-carried',
        severity: 'error',
        message: `The folder map is still only in ${file} (${ctx.packConfigPath || 'its vault.config.json'}), so the build would publish none of the mapped folders. ${
          reached ? `Run "gm-scriptorium carry ${ctx.campaign}" to move it into _meta/vault-config.yaml.` : hint
        }`,
        data,
      }));
    } else {
      findings.push(createFinding({
        ...base,
        id: 'config/pack-setting-not-carried',
        severity: 'warn',
        message: `${fault.name} in ${file} is ${show(fault.value)}, but the vault's settings do not set ${fault.setting}, so ${file === 'the pack' ? "the pack's" : "the site config's"} value is not used. ${hint}`,
        data,
      }));
    }
  }
  // N1: the vault's own folder map is unset or unreadable, and the pack holds none the checks above named.
  if (!unheld.some((u) => u.fault.name === 'folderMap')) {
    const problem = yamlFolderMapProblem(folderMap, ctx);
    if (problem) {
      findings.push(createFinding({
        id: 'config/folder-map-missing',
        severity: 'error',
        category: 'config',
        campaign: ctx.campaign,
        path: null,
        message: problem,
        data: { packKey: null, setting: FOLDER_MAP },
      }));
    }
  }
  // The site-folder keys (siteUrl and its siblings): the pin raises no old-name fault for them, because it
  // still reads them from the site file while the vault's settings do not set them. The build keeps them
  // (src/build/stage.js), so nothing is lost today, but they belong in the yaml. outputDir is Scriptorium's own
  // business (the build hands the output folder over directly); a value equal to the built-in one says nothing.
  for (const { key, name, default: builtIn } of pinned.siteFolderKeys()) {
    if (key === 'outputDir') continue;
    // Both files set it, differently, as the pin's own comparison judges (its 'dropped' fault with
    // siteDiffers): the vault's value is used, as for every other setting both files set.
    const differs = faults.find((f) => f.kind === 'dropped' && f.source === 'site' && f.siteDiffers && f.name === key);
    if (differs && origins[name] === 'fault') {
      // The pin compares the vault's raw value, which it cannot read: the carry keeps it, so only a fix in the yaml helps.
      findings.push(createFinding({
        id: 'config/pack-setting-differs',
        severity: 'warn',
        category: 'config',
        campaign: ctx.campaign,
        path: null,
        message: `${key} in ${file} is ${show(differs.value)}, but the vault's settings set ${name} to ${show(shownOf(name))}, which cannot be read. The carry leaves it as it is: fix ${name} in _meta/vault-config.yaml.`,
        data: { packKey: key, setting: name },
      }));
      continue;
    }
    if (differs) {
      findings.push(createFinding({
        id: 'config/pack-setting-differs',
        severity: 'warn',
        category: 'config',
        campaign: ctx.campaign,
        path: null,
        message: `${key} in ${file} is ${show(differs.value)}, but the vault's settings set ${name} to ${show(valueAt(values, name))}; the vault's value is used. ${hint}`,
        data: { packKey: key, setting: name },
      }));
      continue;
    }
    const value = ctx.rawSiteConfig[key];
    if (value === undefined || value === null || isDeepStrictEqual(value, builtIn) || vaultSets(origins[name])) continue;
    findings.push(createFinding({
      id: 'config/pack-setting-not-carried',
      severity: 'warn',
      category: 'config',
      campaign: ctx.campaign,
      path: null,
      message: `${key} in ${file} is ${show(value)}. The generator still reads it from ${file} for now, but it belongs in ${name} in _meta/vault-config.yaml. ${
        reached ? `Run "gm-scriptorium carry ${ctx.campaign}" to move it there.` : hint
      }`,
      data: { packKey: key, setting: name },
    }));
  }
  return findings;
}

const only = (id) => (ctx) => carryFindings(ctx).filter((f) => f.id === id);

module.exports = {
  isHeldByVault,
  unheldPackSettings,
  buildBlockers,
  packNotCarriedMessage,
  isVaultPack,
  vaultSets,
  yamlFolderMapProblem,
  carryHint,
  runPackHidingNotCarried: only('config/pack-hiding-not-carried'),
  runPackSettingNotCarried: only('config/pack-setting-not-carried'),
  runFolderMapNotCarried: only('config/folder-map-not-carried'),
  runFolderMapMissing: only('config/folder-map-missing'),
  runPackSettingDiffers: only('config/pack-setting-differs'),
  runLeftoverSettingsFile: only('config/leftover-settings-file'),
  missingEntries,
};
