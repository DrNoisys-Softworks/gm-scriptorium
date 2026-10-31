'use strict';

const { createFinding } = require('../report/finding');
const { PUBLISH_DEFAULTS } = require('../vault/publishset');
const pinned = require('../generator/pinned');
const { hubBodyWithheld } = require('./sessionmodel');

/*
 * L6, the config-surface-divergence class (Engineering Brief section 7),
 * re-ported against the pin (Track DEP-b).
 *
 * From publish-v1.26.0 (upstream #371, lib/settings/legacy.js pick) a list in vault.config.json
 * with none in _meta/vault-config.md ADDS to the built-in list; only a list in the vault file
 * replaces it. The checks below read the effective list from the pin's own loader, so a
 * site-file-only list drops no default and they report nothing for it; their messages name the
 * vault file, the one list that can drop a default (lib/settings/legacy.js:86-139, pick). The
 * history below is kept for the record. Two config surfaces exist:
 * vault.config.json (outside the vault) and _meta/vault-config.md's
 * `publish:` block (inside it). Up to publish-v1.21.0 the pin's pick (unionExcludeList up to
 * publish-v1.11.44) unioned exclude_sections/exclude_fields/exclude_dirs from BOTH
 * surfaces (case-insensitively de-duplicated) — it does NOT let one side
 * win outright — but fell back to PUBLISH_DEFAULTS
 * ONLY when NEITHER surface supplied a list at all. So supplying a list
 * from either surface silently drops every pin default that list doesn't
 * also name, which is what runExcludeSectionsDivergence and
 * runExcludeFieldsDivergence below report.
 *
 * exclude_dirs is different again, and changed at publish-v1.11.40 (Δ, #209 follow-up):
 * lib/build.js:585 (from publish-v1.26.0) calls lib/config.js's scanConfigFor(config, publishConfig) before
 * scanVault, so the walk sees the merged, unioned exclude_dirs, not the raw vault.config.json
 * object. A vault-only publish.exclude_dirs entry now genuinely gates a fresh build's walk too.
 * See runExcludeDirsDivergence's own doc comment for what this check still catches.
 */

function normaliseSection(title) {
  return title.trim().toLowerCase();
}

/**
 * Does any published page's rendered body still contain this heading (equals or "starts with",
 * mirroring L5's own arm)? ADR 0036: skips a page whose body a real build withholds (a paired
 * session hub) -- that page's `page.markdown` is the GM's own prep text, never what publishes.
 */
function headingSurvives(ctx, sectionName) {
  const wanted = normaliseSection(sectionName);
  for (const page of ctx.publishSet.publishedPages) {
    if (hubBodyWithheld(ctx, page)) continue;
    const headingRe = /^(#{1,6})\s+(.+)$/gm;
    let m;
    while ((m = headingRe.exec(page.markdown))) {
      const title = normaliseSection(m[2]);
      if (title === wanted || title.startsWith(wanted)) return true;
    }
  }
  return false;
}

/**
 * The file the vault keeps its settings in, as the messages below name it. A list there replaces the
 * pin defaults on either layout: the yaml's player_site.hide lists settle with origin 'file' and
 * replace the default in the pin's reader, as publish.exclude_* in the md always did. These
 * dropped-default checks therefore run on both layouts. The pack-against-vault comparisons (exclude
 * dirs below) do not run on the moved layout: the carry checks own them.
 */
function vaultSettingsFile(ctx) {
  return ctx.settingsLayout === 'new' ? '_meta/vault-config.yaml' : '_meta/vault-config.md';
}

/**
 * exclude_sections: when _meta/vault-config.md supplies its own list, a pin
 * default (PUBLISH_DEFAULTS.exclude_sections, the registry's player_site.hide.sections) that list
 * doesn't re-name is silently dropped from the effective list (lib/settings/legacy.js:86-139's
 * pick; a list only in vault.config.json is added to the defaults, :117-120). Up to
 * publish-v1.21.0 a list in either file dropped them. ERROR if the heading actually
 * renders in a published page; WARN otherwise. When neither surface
 * supplies a list, the defaults apply in full and nothing is missing, so
 * this reports nothing.
 */
function runExcludeSectionsDivergence(ctx) {
  const file = vaultSettingsFile(ctx);
  const { vault, json } = ctx.publishSet.configSources;
  // On the moved layout only the vault's own (file-origin) list can drop a default; the pack is no list source.
  const supplied = ctx.settingsLayout === 'new' ? vault.exclude_sections : vault.exclude_sections || json.excludeSections;
  if (!supplied) return [];

  const effective = ctx.publishSet.publishConfig.exclude_sections || [];
  const effectiveLower = new Set(effective.map(normaliseSection));
  const findings = [];

  for (const section of PUBLISH_DEFAULTS.exclude_sections) {
    if (effectiveLower.has(normaliseSection(section))) continue;
    const fires = headingSurvives(ctx, section);
    findings.push(
      createFinding({
        id: 'config/exclude-sections-divergence',
        severity: fires ? 'error' : 'warn',
        category: 'config',
        campaign: ctx.campaign,
        message: `"## ${section}" is one of the default excluded sections, but ${file} supplies its own exclude_sections list, which replaces the defaults instead of extending them, so it is no longer excluded${
          fires ? ' and the heading renders in published output' : ''
        }`,
        data: { section, appliesInOutput: fires },
      }),
    );
  }
  return findings;
}

/**
 * exclude_dirs: at 78696167 (Δ, #209 follow-up), lib/build.js's own scan is no longer handed the
 * raw vault.config.json object -- it now calls lib/config.js's scanConfigFor(config,
 * publishConfig) first, so a FRESH build genuinely does honour a vault-only publish.exclude_dirs
 * entry (src/vault/publishset.js's computePublishedSet does the same, via the facade's
 * scanConfigFor, and matches). This check's remaining value is defense-in-depth against a STALE
 * build made before the vault-side exclusion was added, or against any other code path that
 * still reads jsonConfig.excludeDirs raw: ctx.allCandidatePages (unfiltered by exclude_dirs, see
 * its own doc comment) stands in for "what a pre-exclusion build could have produced." Every
 * vault-only entry is a WARN (ADR 0060): fires only picks the message's extra sentence and sets
 * data.appliesInOutput, because a fresh build already leaves the folder out and leak/l2 reads the
 * real output (and, inside build, the staging tree) for anything a stale build left behind.
 * JSON-only entries are INFO (they take effect either way).
 */
function runExcludeDirsDivergence(ctx) {
  if (ctx.settingsLayout === 'new') return []; // the pack is no longer a second source; see runPackHidingNotCarried
  const jsonList = ctx.jsonConfig.excludeDirs || [];
  const vaultList = ctx.publishSet.configSources.vault.exclude_dirs || [];
  // Two entries name the same folder when the pin spells them the same (normalizeExcludeDir: no
  // trailing slash, no leading ./, forward slashes, relative to the vault) and match case-insensitively,
  // as the scanner matches them. A finding still quotes the entry as the GM wrote it.
  const spelled = (dir) => pinned.normalizeExcludeDir(dir, ctx.vaultPath, false);
  const keyOf = (dir) => (spelled(dir) || '').toLowerCase();
  const jsonSet = new Set(jsonList.map(keyOf));
  const vaultSet = new Set(vaultList.map(keyOf));
  const findings = [];

  function underPrefix(relPath, prefix) {
    return relPath === prefix || relPath.startsWith(prefix + '/');
  }

  for (const dir of vaultList) {
    if (jsonSet.has(keyOf(dir))) continue; // also gates the real walk; not a divergence
    const folder = spelled(dir);
    const contributedPage = !!folder && ctx.allCandidatePages.some((p) => underPrefix(p.relPath, folder));
    const contributedAttachment = !!folder && [...ctx.index.claims.values()]
      .flat()
      .some((c) => c.kind === 'image' && underPrefix(c.relPath.replace(/^<attachments>\//, ''), folder));
    const fires = contributedPage || contributedAttachment;
    findings.push(
      createFinding({
        id: 'config/exclude-dirs-divergence',
        severity: 'warn',
        category: 'config',
        campaign: ctx.campaign,
        message: `"${dir}" is excluded in _meta/vault-config.md (publish.exclude_dirs) but not in vault.config.json (excludeDirs).${
          fires
            ? ' This folder holds pages or images. A fresh build leaves it out, but a site built before the exclusion may still hold its files until you build again.'
            : ' A fresh build leaves it out.'
        } Add it to excludeDirs in vault.config.json as well to clear this warning.`,
        data: { dir, appliesInOutput: fires },
      }),
    );
  }

  for (const dir of jsonList) {
    if (vaultSet.has(keyOf(dir))) continue;
    findings.push(
      createFinding({
        id: 'config/exclude-dirs-divergence',
        severity: 'info',
        category: 'config',
        campaign: ctx.campaign,
        message: `"${dir}" is excluded in vault.config.json (excludeDirs) but not in _meta/vault-config.md; builds still leave it out.`,
        data: { dir, jsonOnly: true },
      }),
    );
  }

  return findings;
}

function toCamelCase(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * exclude_fields: PUBLISH_DEFAULTS.exclude_fields (the registry's player_site.hide.fields:
 * secrets/current_plan/plan_progress/gm_notes/prep_notes/reliability) is used whole unless
 * _meta/vault-config.md supplies its own exclude_fields list, which replaces the defaults instead
 * of extending them (lib/settings/legacy.js:86-139's pick). A list only in vault.config.json is
 * added to them from publish-v1.26.0 (:117-120); before, a list from either file replaced them.
 */
function runExcludeFieldsDivergence(ctx) {
  const file = vaultSettingsFile(ctx);
  const effective = new Set(ctx.publishSet.publishConfig.exclude_fields || []);
  const findings = [];

  for (const defaultField of PUBLISH_DEFAULTS.exclude_fields) {
    if (effective.has(defaultField)) continue;
    const camel = toCamelCase(defaultField);
    let exactCount = 0;
    let camelCount = 0;
    for (const f of ctx.index.files) {
      if (!f.ok) continue;
      if (Object.prototype.hasOwnProperty.call(f.data, defaultField)) exactCount++;
      if (camel !== defaultField && Object.prototype.hasOwnProperty.call(f.data, camel)) camelCount++;
    }
    findings.push(
      createFinding({
        id: 'config/exclude-fields-divergence',
        severity: 'warn',
        category: 'config',
        campaign: ctx.campaign,
        message: `default excluded field "${defaultField}" is no longer filtered; the ${file} exclude_fields list replaced the default list instead of extending it`,
        data: { field: defaultField, occurrences: { [defaultField]: exactCount, [camel]: camelCount } },
      }),
    );
  }
  return findings;
}

/**
 * FR-18: names both paths and says the resolved one was used. Shared by
 * the finding's message and build/status's human `note:` line, so the two
 * surfaces never drift apart. Lives here, not in src/cli/check.js, because
 * cli/check.js already requires this module (via src/checks/run.js's
 * dispatch) and the reverse direction would be a require cycle.
 */
function siteVaultPathMismatchMessage(m) {
  return `${m.siteConfigPath} sets vaultPath to "${m.siteConfigVaultPath}", but the resolved vault "${m.resolvedVaultPath}" was used instead`;
}

/**
 * config/settings-fault: one ERROR per fault the pinned build stops on (lib/config.js
 * assertNoStops), in the pin's own words, read by src/vault/publishset.js's loadPublishConfig through
 * the pin's own settings loader. The path is the vault's settings file, except for a fault in a key
 * of the site's vault.config.json, which the pin names by that key.
 */
function runSettingsFault(ctx) {
  // On the moved layout a hide list the pack holds is reported once, by config/pack-hiding-not-carried
  // (src/checks/carry.js): drop exactly the faults that check owns, the old-name stops from the site file.
  const owned = (f) => ctx.settingsLayout === 'new' && f.kind === 'old-name' && f.source === 'site';
  const stops = (ctx.publishSet.stops || []).filter((f) => !owned(f));
  const site = ctx.jsonConfig || {};
  const siteFile = ctx.rawSiteConfig || site;
  return stops.map((fault) => {
    const inSiteFile = !String(fault.name).includes('.') && Object.prototype.hasOwnProperty.call(siteFile, fault.name);
    return createFinding({
      id: 'config/settings-fault',
      severity: 'error',
      category: 'config',
      campaign: ctx.campaign,
      path: inSiteFile ? null : (ctx.settingsLayout === 'new' ? '_meta/vault-config.yaml' : '_meta/vault-config.md'),
      message: `${fault.message} The build will not run until this is fixed.`,
      data: { name: fault.name, setting: fault.setting || null, kind: fault.kind },
    });
  });
}

/**
 * config/switch-word-now-off: `no`, `off` or "false" for publish.exclude_drafts or
 * publish.exclude_callouts hid the drafts or callouts up to GM-Scriptorium 0.5.0 (the pin then
 * counted any text as on). Since publish-v1.26.0 they are switch words that mean off, so those pages
 * and callouts are now published. One WARN per setting, naming the value as the file writes it.
 */
const SWITCH_WORD_WHAT = { 'publish.exclude_drafts': ['draft pages', 'draft pages are published'], 'publish.exclude_callouts': ['callouts', 'callouts are published'] };
function runSwitchWordNowOff(ctx) {
  return (ctx.publishSet.switchWords || []).map(({ setting, raw }) => {
    const [hid, published] = SWITCH_WORD_WHAT[setting];
    return createFinding({
      id: 'config/switch-word-now-off',
      severity: 'warn',
      category: 'config',
      campaign: ctx.campaign,
      path: '_meta/vault-config.md',
      message: `${setting} is ${JSON.stringify(raw)}. Up to GM-Scriptorium 0.5.0 this hid ${hid}; it now means off, so ${published}. Set it to true to hide them, or false to keep publishing them and silence this warning.`,
      data: { setting, value: raw },
    });
  });
}

/** config/site-vault-path-mismatch (FR-18): 0 findings when ctx.vaultMismatch is null, else one WARN naming both paths. */
function runSiteVaultPathMismatch(ctx) {
  if (!ctx.vaultMismatch) return [];
  const m = ctx.vaultMismatch;
  return [
    createFinding({
      id: 'config/site-vault-path-mismatch',
      severity: 'warn',
      category: 'config',
      campaign: ctx.campaign,
      path: null,
      message: siteVaultPathMismatchMessage(m),
      data: m,
    }),
  ];
}

/**
 * ADR 0018: names both paths and says which one wins. Shared by the
 * finding's message and build/status's human `note:` line, the same
 * pattern siteVaultPathMismatchMessage above already uses. Lives here, not
 * in src/cli/check.js, for the same require-cycle reason.
 */
function packShadowedMessage(p) {
  return `site_config ${p.siteConfigPath} is in use, so the campaign pack at ${p.packDir} is ignored; remove site_config to use the pack`;
}

/** config/pack-shadowed (ADR 0018): 0 findings when ctx.packShadowed is null, else one WARN naming both paths. */
function runPackShadowed(ctx) {
  if (!ctx.packShadowed) return [];
  return [
    createFinding({
      id: 'config/pack-shadowed',
      severity: 'warn',
      category: 'config',
      campaign: ctx.campaign,
      path: null,
      message: packShadowedMessage(ctx.packShadowed),
      data: ctx.packShadowed,
    }),
  ];
}

module.exports = {
  runSettingsFault,
  runSwitchWordNowOff,
  runExcludeSectionsDivergence,
  runExcludeDirsDivergence,
  runExcludeFieldsDivergence,
  runSiteVaultPathMismatch,
  siteVaultPathMismatchMessage,
  runPackShadowed,
  packShadowedMessage,
};
