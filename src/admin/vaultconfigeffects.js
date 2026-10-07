'use strict';

const { isDeepStrictEqual } = require('util');

/*
 * V1e-9 (ADR 0033 addendum, SD-96): pure. Computes "what this edit changes" from the OLD and NEW
 * parsed frontmatter data plus their loadPublishConfig results, for FR-43 (the review's own
 * effects list, and vc2's live "What this changes" panel, V1e-10). Rejected: a client-side YAML
 * or effects port (no YAML parser in the browser, NFR-03; two copies would drift); raw-list-only
 * comparison (it misses "your list replaces the defaults", which is config/exclude-*-divergence's
 * own rule).
 */

const PRIVACY_LIST_PATHS = Object.freeze(['publish.exclude_fields', 'publish.exclude_sections', 'publish.exclude_dirs']);

const LIST_WHAT = Object.freeze({ exclude_fields: 'field', exclude_sections: 'heading', exclude_dirs: 'folder' });

function getAt(obj, dotPath) {
  const segments = dotPath.split('.');
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function renderValue(v) {
  if (v === undefined || v === null) return 'not set';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function lowerSet(list) {
  const out = new Set();
  for (const item of list || []) out.add(String(item).toLowerCase());
  return out;
}

function containsCI(list, item) {
  return lowerSet(list).has(String(item).toLowerCase());
}

/** Case-insensitive, first-seen-casing order: items in `a` not in `b`. */
function minusCI(a, b) {
  const bLower = lowerSet(b);
  return (a || []).filter((x) => !bLower.has(String(x).toLowerCase()));
}

function pathsGroup(dotPath) {
  if (
    dotPath === 'publish.mode' ||
    PRIVACY_LIST_PATHS.includes(dotPath) ||
    dotPath === 'publish.exclude_drafts' ||
    dotPath === 'publish.exclude_callouts' ||
    dotPath === 'publish.overrides'
  ) {
    return 'privacy';
  }
  if (
    dotPath === 'publish.theme.palette' ||
    dotPath === 'publish.theme.fonts' ||
    dotPath === 'publish.theme.genre' ||
    dotPath === 'publish.theme.campaign_image' ||
    dotPath === 'publish.banners'
  ) {
    return 'look';
  }
  if (dotPath.startsWith('publish.landing') || dotPath.startsWith('publish.four_oh_four') || dotPath === 'publish.theme.tagline') {
    return 'safe';
  }
  return 'other';
}

/** PATH_GROUPS, as a function over a dot path rather than a static table (every rule below names
 * its own `path`, so a single `pathsGroup` keeps the "which group is this path in" answer in one
 * place, used by both computeEffects' own findings and summarizeChange). */
const PATH_GROUPS = Object.freeze({ group: pathsGroup });

function titlesFor(pages) {
  return pages.map((p) => p.displayTitle).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Published pages (from `publishSet`, or null if none was supplied) carrying `field` as an own key. */
function pagesWithField(publishSet, field) {
  if (!publishSet) return null;
  return publishSet.publishedPages
    .filter((p) => Object.prototype.hasOwnProperty.call(p.frontmatter, field))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

function listRemovedDetail(listKey, x, publishSet) {
  if (listKey === 'exclude_fields') {
    const pages = pagesWithField(publishSet, x);
    if (pages === null) return 'Anything in it would be published to players.';
    if (pages.length === 0) return `No published page has a ${x} field today, so nothing on the site changes yet.`;
    const titles = titlesFor(pages);
    const shown = titles.slice(0, 5);
    const restCount = titles.length - shown.length;
    const extra = restCount > 0 ? `, and ${restCount} other${restCount === 1 ? '' : 's'}` : '';
    return `${pages.length} published page(s) carry a ${x} field: ${shown.join(', ')}${extra}. It would be published to players.`;
  }
  if (listKey === 'exclude_sections') {
    return `Any "${x}" section on a published page would be published to players.`;
  }
  return `Anything in the ${x} folder could be published to players.`;
}

function listAddedDetail(listKey, x, publishSet) {
  if (listKey === 'exclude_fields' && publishSet) {
    const pages = pagesWithField(publishSet, x);
    if (pages && pages.length === 0) return 'No published page has one yet, so nothing on the site changes today.';
  }
  return '';
}

function listRules(listKey, curData, candData, curEff, candEff, curRawVault, candRawVault, publishSet, fixable) {
  const out = [];
  const path = `publish.${listKey}`;
  const what = LIST_WHAT[listKey];
  const curList = curEff[listKey] || [];
  const candList = candEff[listKey] || [];
  const curRaw = curRawVault[listKey];
  const candRaw = candRawVault[listKey];

  // list-removed: in the effective cur list, not in the effective cand list.
  for (const x of minusCI(curList, candList)) {
    const hadRaw = containsCI(curRaw, x);
    out.push({
      id: 'list-removed',
      group: 'privacy',
      level: 'bad',
      path,
      title: hadRaw
        ? `The "${x}" ${what} is no longer hidden`
        : `The "${x}" ${what} is no longer hidden: your list replaces the built-in defaults`,
      detail: listRemovedDetail(listKey, x, publishSet),
      fix: fixable.has(path) ? { path, entry: x } : null,
    });
  }

  // list-unioned: in the raw cur vault list, not in the raw cand vault list, still effective.
  for (const x of minusCI(curRaw, candRaw)) {
    if (!containsCI(candList, x)) continue;
    out.push({
      id: 'list-unioned',
      group: 'privacy',
      level: 'info',
      path,
      title: `"${x}" stays hidden`,
      detail: 'You removed it here, but vault.config.json still hides it. Both lists count.',
      fix: null,
    });
  }

  // list-added: effective cand only.
  for (const x of minusCI(candList, curList)) {
    out.push({
      id: 'list-added',
      group: 'privacy',
      level: 'ok',
      path,
      title: `The "${x}" ${what} is now hidden too`,
      detail: listAddedDetail(listKey, x, publishSet),
      fix: null,
    });
  }

  return out;
}

function draftsRule(curEff, candEff) {
  if (curEff.exclude_drafts === candEff.exclude_drafts) return null;
  if (curEff.exclude_drafts === true && candEff.exclude_drafts === false) {
    return {
      id: 'drafts',
      group: 'privacy',
      level: 'bad',
      path: 'publish.exclude_drafts',
      title: 'Draft pages can now be published',
      detail: 'exclude_drafts is off, so pages marked as drafts are no longer left out.',
      fix: null,
    };
  }
  return {
    id: 'drafts',
    group: 'privacy',
    level: 'ok',
    path: 'publish.exclude_drafts',
    title: 'Draft pages are now left out',
    detail: 'exclude_drafts is on, so pages marked as drafts are left out.',
    fix: null,
  };
}

function calloutsSet(v) {
  if (v === true) return true;
  if (!v || !Array.isArray(v)) return [];
  return v;
}

function calloutsListText(v) {
  const set = calloutsSet(v);
  if (set === true) return 'all callouts';
  if (set.length === 0) return 'none';
  return set.join(', ');
}

function calloutsRule(curEff, candEff) {
  const cur = calloutsSet(curEff.exclude_callouts);
  const cand = calloutsSet(candEff.exclude_callouts);
  if (isDeepStrictEqual(cur, cand)) return null;

  let narrowing;
  if (cur === true && cand !== true) {
    narrowing = true;
  } else if (cur !== true && cand === true) {
    narrowing = false;
  } else {
    const lost = cur.filter((x) => !cand.includes(x));
    const gained = cand.filter((x) => !cur.includes(x));
    if (lost.length > 0) narrowing = true;
    else if (gained.length > 0) narrowing = false;
    else return null;
  }

  return {
    id: 'callouts',
    group: 'privacy',
    level: narrowing ? 'bad' : 'ok',
    path: 'publish.exclude_callouts',
    title: narrowing ? 'Fewer callouts are stripped' : 'More callouts are stripped',
    detail: `Only these are stripped now: ${calloutsListText(candEff.exclude_callouts)}.`,
    fix: null,
  };
}

function overridesRule(curData, candData) {
  const curOverrides = getAt(curData, 'publish.overrides');
  const candOverrides = getAt(candData, 'publish.overrides');
  if (isDeepStrictEqual(curOverrides, candOverrides)) return null;
  return {
    id: 'overrides',
    group: 'privacy',
    level: 'bad',
    path: 'publish.overrides',
    title: 'The per-page field overrides change',
    detail: 'publish.overrides can show a hidden field on one page. Check the line-by-line change.',
    fix: null,
  };
}

const LOOK_TITLES = Object.freeze({
  palette: 'The colours change',
  fonts: 'The fonts change',
  genre: 'The genre preset changes',
  campaign_image: 'The cover art changes',
  banners: 'The section banners change',
});

function objectDetail(curVal, candVal) {
  const curObj = curVal && typeof curVal === 'object' && !Array.isArray(curVal) ? curVal : {};
  const candObj = candVal && typeof candVal === 'object' && !Array.isArray(candVal) ? candVal : {};
  const keys = new Set([...Object.keys(curObj), ...Object.keys(candObj)]);
  const parts = [];
  for (const key of [...keys].sort()) {
    const a = Object.prototype.hasOwnProperty.call(curObj, key) ? curObj[key] : undefined;
    const b = Object.prototype.hasOwnProperty.call(candObj, key) ? candObj[key] : undefined;
    if (isDeepStrictEqual(a, b)) continue;
    parts.push(`${key}: ${renderValue(a)} becomes ${renderValue(b)}`);
  }
  return parts.join('; ');
}

function lookRule(key, curData, candData) {
  const dotPath = key === 'banners' ? 'publish.banners' : `publish.theme.${key}`;
  const curVal = getAt(curData, dotPath);
  const candVal = getAt(candData, dotPath);
  if (isDeepStrictEqual(curVal, candVal)) return null;

  const isScalarKey = key === 'genre' || key === 'campaign_image';
  const detail = isScalarKey ? `${renderValue(curVal)} becomes ${renderValue(candVal)}` : objectDetail(curVal, candVal);
  if (detail === '') return null;

  return {
    id: `look-${key}`,
    group: 'look',
    level: 'look',
    path: dotPath,
    title: LOOK_TITLES[key],
    detail,
    fix: null,
  };
}

function featuredRules(curData, candData) {
  const out = [];
  const cur = getAt(curData, 'publish.landing.featured_npcs');
  const cand = getAt(candData, 'publish.landing.featured_npcs');
  const curList = Array.isArray(cur) ? cur : [];
  const candList = Array.isArray(cand) ? cand : [];
  for (const x of candList.filter((v) => !curList.includes(v))) {
    out.push({
      id: 'featured-added',
      group: 'safe',
      level: 'ok',
      path: 'publish.landing.featured_npcs',
      title: `${x} joins the featured characters`,
      detail: "Shown first in the landing page's characters row.",
      fix: null,
    });
  }
  for (const x of curList.filter((v) => !candList.includes(v))) {
    out.push({
      id: 'featured-removed',
      group: 'safe',
      level: 'ok',
      path: 'publish.landing.featured_npcs',
      title: `${x} is no longer featured`,
      detail: 'They can still appear on the landing page by recency.',
      fix: null,
    });
  }
  return out;
}

function landingRules(curData, candData) {
  const out = [];
  const curLanding = getAt(curData, 'publish.landing') || {};
  const candLanding = getAt(candData, 'publish.landing') || {};
  const keys = new Set([...Object.keys(curLanding), ...Object.keys(candLanding)]);
  for (const key of [...keys].sort()) {
    if (key === 'featured_npcs') continue;
    const a = Object.prototype.hasOwnProperty.call(curLanding, key) ? curLanding[key] : undefined;
    const b = Object.prototype.hasOwnProperty.call(candLanding, key) ? candLanding[key] : undefined;
    if (isDeepStrictEqual(a, b)) continue;
    out.push({
      id: 'landing-' + key,
      group: 'safe',
      level: 'ok',
      path: `publish.landing.${key}`,
      title: `The landing page's ${key} setting changes`,
      detail: `${renderValue(a)} becomes ${renderValue(b)}`,
      fix: null,
    });
  }
  return out;
}

function notFoundRules(curData, candData) {
  const out = [];
  const curNf = getAt(curData, 'publish.four_oh_four') || {};
  const candNf = getAt(candData, 'publish.four_oh_four') || {};
  const keys = new Set([...Object.keys(curNf), ...Object.keys(candNf)]);
  for (const key of [...keys].sort()) {
    const a = Object.prototype.hasOwnProperty.call(curNf, key) ? curNf[key] : undefined;
    const b = Object.prototype.hasOwnProperty.call(candNf, key) ? candNf[key] : undefined;
    if (isDeepStrictEqual(a, b)) continue;
    if (key === 'message') {
      out.push({
        id: 'not-found',
        group: 'safe',
        level: 'ok',
        path: 'publish.four_oh_four.message',
        title: 'The not-found message changes',
        detail: 'Players see it when a link goes nowhere.',
        fix: null,
      });
    } else {
      out.push({
        id: 'not-found',
        group: 'safe',
        level: 'ok',
        path: `publish.four_oh_four.${key}`,
        title: `The not-found page's ${key} setting changes`,
        detail: `${renderValue(a)} becomes ${renderValue(b)}`,
        fix: null,
      });
    }
  }
  return out;
}

function taglineRule(curData, candData) {
  const a = getAt(curData, 'publish.theme.tagline');
  const b = getAt(candData, 'publish.theme.tagline');
  if (isDeepStrictEqual(a, b)) return null;
  return {
    id: 'tagline',
    group: 'safe',
    level: 'ok',
    path: 'publish.theme.tagline',
    title: 'The landing tagline changes',
    detail: 'This is the tagline the landing page actually shows.',
    fix: null,
  };
}

/** Every dot path the rules above already cover (for the catch-all "other" rule). */
const COVERED_PREFIXES = Object.freeze([
  'publish.mode',
  'publish.exclude_fields',
  'publish.exclude_sections',
  'publish.exclude_dirs',
  'publish.exclude_drafts',
  'publish.exclude_callouts',
  'publish.overrides',
  'publish.theme.palette',
  'publish.theme.fonts',
  'publish.theme.genre',
  'publish.theme.campaign_image',
  'publish.banners',
  'publish.landing',
  'publish.four_oh_four',
  'publish.theme.tagline',
]);

function isCovered(dotPath) {
  // A bare ancestor of a covered prefix (e.g. "publish" itself, surfaced only when it collapsed
  // to an empty object) is covered too -- it was never a setting the panel reads in its own
  // right, only ever a container for settings that are.
  return COVERED_PREFIXES.some((p) => dotPath === p || dotPath.startsWith(p + '.') || p.startsWith(dotPath + '.'));
}

/** Every dot path present (as an own leaf) in `obj`, deeply. A scalar (string/number/boolean/
 * null) or an empty container is itself a leaf at `prefix`; the top-level call (`prefix === ''`)
 * never registers the root itself. */
function leafPaths(obj, prefix) {
  const out = [];
  if (obj === null || typeof obj !== 'object') {
    if (prefix !== '') out.push(prefix);
    return out;
  }
  if (Array.isArray(obj)) {
    out.push(prefix);
    return out;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    out.push(prefix);
    return out;
  }
  for (const key of keys) {
    const next = prefix ? `${prefix}.${key}` : key;
    out.push(...leafPaths(obj[key], next));
  }
  return out;
}

function otherRule(curData, candData) {
  const paths = new Set([...leafPaths(curData, ''), ...leafPaths(candData, '')]);
  const changed = [];
  for (const p of [...paths].sort()) {
    if (isCovered(p)) continue;
    const a = getAt(curData, p);
    const b = getAt(candData, p);
    if (!isDeepStrictEqual(a, b)) changed.push(p);
  }
  if (changed.length === 0) return null;
  const shown = changed.slice(0, 10);
  const more = changed.length > shown.length ? `, and ${changed.length - shown.length} more` : '';
  return {
    id: 'other',
    group: 'other',
    level: 'info',
    path: null,
    title: 'Other settings change',
    detail: `${shown.join(', ')}${more}. The panel doesn't read these; the line-by-line change shows them.`,
    fix: null,
  };
}

/**
 * @param {object} opts
 * @param {object|null} opts.cur Scriptorium-parsed `data` for the CURRENT file (null if unreadable)
 * @param {object} opts.cand Scriptorium-parsed `data` for the CANDIDATE
 * @param {object} opts.curPublish loadPublishConfig's result for the current file
 * @param {object} opts.candPublish loadPublishConfig's result for the candidate
 * @param {object|null} opts.jsonConfig
 * @param {object|null} opts.publishSet the candidate's checkCtx.publishSet, or null (vc2's live
 *   effects route, withCheck:false)
 * @param {Set<string>} opts.fixable the PRIVACY_LIST_PATHS present as a flow/block list in the candidate
 * @returns {Array<{id, group, level, path, title, detail, fix}>}
 */
function computeEffects({ cur, cand, curPublish, candPublish, jsonConfig, publishSet, fixable }) {
  const out = [];
  const curUnreadable = cur === null;
  const curData = curUnreadable ? {} : cur || {};
  const candData = cand || {};

  if (curUnreadable) {
    out.push({
      id: 'current-unreadable',
      group: 'other',
      level: 'info',
      path: null,
      title: "The file as it is now doesn't read",
      detail: 'So every setting in your edited copy is listed as a change.',
      fix: null,
    });
  }

  const curEff = curPublish.publishConfig;
  const candEff = candPublish.publishConfig;
  const curRawVault = curPublish.configSources.vault;
  const candRawVault = candPublish.configSources.vault;

  const curRawMode = getAt(curData, 'publish.mode');
  const candRawMode = getAt(candData, 'publish.mode');
  if (curEff.mode !== candEff.mode) {
    const bad = candEff.mode !== 'player';
    out.push({
      id: 'mode',
      group: 'privacy',
      level: bad ? 'bad' : 'info',
      path: 'publish.mode',
      title: `The publish mode changes from "${curEff.mode}" to "${candEff.mode}"`,
      detail: bad
        ? 'player mode is what keeps GM-only pages off the site. Anything else can publish them.'
        : 'GM-only pages stay off the site.',
      fix: null,
    });
  } else if (curRawMode !== candRawMode) {
    out.push({
      id: 'mode-setting',
      group: 'privacy',
      level: 'info',
      path: 'publish.mode',
      title: `The publish mode setting changes, but the mode stays "${candEff.mode}"`,
      detail: '',
      fix: null,
    });
  }

  for (const listKey of ['exclude_fields', 'exclude_sections', 'exclude_dirs']) {
    out.push(...listRules(listKey, curData, candData, curEff, candEff, curRawVault, candRawVault, publishSet, fixable));
  }

  const drafts = draftsRule(curEff, candEff);
  if (drafts) out.push(drafts);

  const callouts = calloutsRule(curEff, candEff);
  if (callouts) out.push(callouts);

  const overrides = overridesRule(curData, candData);
  if (overrides) out.push(overrides);

  for (const key of ['palette', 'fonts', 'genre', 'campaign_image', 'banners']) {
    const rule = lookRule(key, curData, candData);
    if (rule) out.push(rule);
  }

  out.push(...featuredRules(curData, candData));
  out.push(...landingRules(curData, candData));
  out.push(...notFoundRules(curData, candData));

  const tagline = taglineRule(curData, candData);
  if (tagline) out.push(tagline);

  const other = otherRule(curData, candData);
  if (other) out.push(other);

  return out;
}

const GROUP_NAMES = Object.freeze({ privacy: 'publishing and privacy', look: 'the look', safe: 'landing page words', other: 'other settings' });
const GROUP_ORDER = Object.freeze(['privacy', 'look', 'safe', 'other']);

/**
 * @param {object|null} prevData Scriptorium-parsed `data` for the OLDER of two versions
 * @param {object|null} nextData Scriptorium-parsed `data` for the NEWER of two versions
 * @returns {string} "before a change to X[, Y[ and Z]]", or "before a save"
 */
function summarizeChange(prevData, nextData) {
  if (prevData === null || nextData === null) return 'before a save';
  const groups = [];
  for (const group of GROUP_ORDER) {
    const prevKeys = leafPaths(prevData, '').filter((p) => pathsGroup(p) === group);
    const nextKeys = leafPaths(nextData, '').filter((p) => pathsGroup(p) === group);
    const paths = new Set([...prevKeys, ...nextKeys]);
    let differs = false;
    for (const p of paths) {
      if (!isDeepStrictEqual(getAt(prevData, p), getAt(nextData, p))) {
        differs = true;
        break;
      }
    }
    if (differs) groups.push(GROUP_NAMES[group]);
  }
  if (groups.length === 0) return 'before a save';
  if (groups.length === 1) return `before a change to ${groups[0]}`;
  if (groups.length === 2) return `before a change to ${groups[0]} and ${groups[1]}`;
  return `before a change to ${groups.slice(0, -1).join(', ')} and ${groups[groups.length - 1]}`;
}

module.exports = {
  PRIVACY_LIST_PATHS,
  PATH_GROUPS,
  computeEffects,
  summarizeChange,
};
