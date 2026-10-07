'use strict';

const { createFinding } = require('../report/finding');
const { PUBLISH_DEFAULTS } = require('../vault/publishset');
const { hubBodyWithheld } = require('./sessionmodel');

/*
 * L6, the config-surface-divergence class (Engineering Brief section 7),
 * re-ported against the pin (Track DEP-b). Two config surfaces exist:
 * vault.config.json (outside the vault) and _meta/vault-config.md's
 * `publish:` block (inside it). lib/config.js:192-246's pick (unionExcludeList up to publish-v1.11.44)
 * genuinely unions exclude_sections/exclude_fields/exclude_dirs from BOTH
 * surfaces (case-insensitively de-duplicated) — it does NOT let one side
 * win outright — but falls back to PUBLISH_DEFAULTS (lib/config.js:17-18)
 * ONLY when NEITHER surface supplies a list at all. So supplying a list
 * from either surface silently drops every pin default that list doesn't
 * also name, which is what runExcludeSectionsDivergence and
 * runExcludeFieldsDivergence below report.
 *
 * exclude_dirs is different again, and changed at publish-v1.11.40 (Δ, #209 follow-up):
 * lib/build.js:351 now calls lib/config.js's scanConfigFor(config, publishConfig) before
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
 * exclude_sections: when EITHER config surface supplies its own list, a pin
 * default (PUBLISH_DEFAULTS.exclude_sections, lib/config.js:17) that list
 * doesn't re-name is silently dropped from the effective union
 * (lib/config.js:192-246's pick (unionExcludeList up to publish-v1.11.44), with the list() fallback at :396,
 * :414-416, only falls back to the defaults
 * when NEITHER surface supplies a list). ERROR if the heading actually
 * renders in a published page; WARN otherwise. When neither surface
 * supplies a list, the defaults apply in full and nothing is missing, so
 * this reports nothing.
 */
function runExcludeSectionsDivergence(ctx) {
  const { vault, json } = ctx.publishSet.configSources;
  if (!vault.exclude_sections && !json.excludeSections) return [];

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
        message: `"## ${section}" is one of the pin's default excluded sections, but vault.config.json or _meta/vault-config.md supplies its own exclude_sections list, which replaces the defaults instead of extending them (lib/config.js:192-246, :414-416), so it is no longer excluded${
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
 * its own doc comment) stands in for "what a pre-exclusion build could have produced." ERROR if
 * this vault-only exclusion's directory has real page content that a stale build could have
 * shipped; WARN otherwise. JSON-only entries are INFO (they take effect either way).
 */
function runExcludeDirsDivergence(ctx) {
  const jsonList = ctx.jsonConfig.excludeDirs || [];
  const vaultList = ctx.publishSet.configSources.vault.exclude_dirs || [];
  const jsonSet = new Set(jsonList);
  const findings = [];

  function underPrefix(relPath, prefix) {
    return relPath === prefix || relPath.startsWith(prefix + '/');
  }

  for (const dir of vaultList) {
    if (jsonSet.has(dir)) continue; // also gates the real walk; not a divergence
    const contributedPage = ctx.allCandidatePages.some((p) => underPrefix(p.relPath, dir));
    const contributedAttachment = [...ctx.index.claims.values()]
      .flat()
      .some((c) => c.kind === 'image' && underPrefix(c.relPath.replace(/^<attachments>\//, ''), dir));
    const fires = contributedPage || contributedAttachment;
    findings.push(
      createFinding({
        id: 'config/exclude-dirs-divergence',
        severity: fires ? 'error' : 'warn',
        category: 'config',
        campaign: ctx.campaign,
        message: `"${dir}" is excluded in _meta/vault-config.md's publish.exclude_dirs, but the scan (lib/scanner.js:77,264) only ever reads vault.config.json:excludeDirs${
          fires ? ', and this directory did contribute files to what would publish' : ''
        }`,
        data: { dir, appliesInOutput: fires },
      }),
    );
  }

  for (const dir of jsonList) {
    if (vaultList.includes(dir)) continue;
    findings.push(
      createFinding({
        id: 'config/exclude-dirs-divergence',
        severity: 'info',
        category: 'config',
        campaign: ctx.campaign,
        message: `"${dir}" is excluded in vault.config.json only; it takes effect (that is the only list scanVault reads)`,
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
 * exclude_fields: PUBLISH_DEFAULTS.exclude_fields (lib/config.js:18, now
 * secrets/current_plan/plan_progress/gm_notes/prep_notes/reliability) is only used
 * whole when neither surface supplies its own exclude_fields list; a list
 * from EITHER surface replaces the defaults instead of extending them
 * (lib/config.js:192-246's pick (unionExcludeList up to publish-v1.11.44)).
 */
function runExcludeFieldsDivergence(ctx) {
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
        message: `default excluded field "${defaultField}" is no longer filtered; a vault.config.json or _meta/vault-config.md exclude_fields list replaced the default list instead of extending it`,
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
  runExcludeSectionsDivergence,
  runExcludeDirsDivergence,
  runExcludeFieldsDivergence,
  runSiteVaultPathMismatch,
  siteVaultPathMismatchMessage,
  runPackShadowed,
  packShadowedMessage,
};
