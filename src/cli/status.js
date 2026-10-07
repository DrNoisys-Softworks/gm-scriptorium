'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig, resolveCampaignContext } = require('./args');
const { listCampaigns, resolveCampaign } = require('../config/resolve');
const { locateVault } = require('../vault/locate');
const { VaultUnreachableError } = require('../util/errors');
const { buildResolutionIndex } = require('../vault/index');
const { lastSession, nextSession, countsFor } = require('../checks/statusinfo');
const { runCheckCommand, resolveVaultContext } = require('./check');
const { siteVaultPathMismatchMessage, packShadowedMessage } = require('../checks/configdiv');
const { EXIT_CODES } = require('../util/exitcodes');
const { SCHEMA_VERSION } = require('../report/json');
const pkg = require('../../package.json');

/** gray-matter/js-yaml parses a bare YAML date scalar (play_date: 2026-09-18) into a JS Date; render it back as a plain date string. */
function formatDateLike(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function outputBuildInfo(outputPath) {
  if (!outputPath || !fs.existsSync(outputPath)) return { exists: false, mtime: null };
  const stat = fs.statSync(outputPath);
  return { exists: true, mtime: stat.mtime.toISOString() };
}

/** Object.entries().sort() sorts by the STRINGIFIED [key, value] pair, which is fine for display but not a documented contract; sort explicitly by key for the JSON envelope so determinism does not depend on that incidentally working. */
function sortedEntitiesByType(entitiesByType) {
  return Object.fromEntries(Object.entries(entitiesByType).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function reachabilityFor(config, name) {
  let resolved;
  try {
    resolved = resolveCampaign(config, name);
  } catch (err) {
    return { campaign: name, reachable: false, reason: 'error', error: err.message, vaultPath: null, profile: null };
  }
  try {
    locateVault(path.resolve(resolved.vault), name);
    return { campaign: name, reachable: true, reason: null, vaultPath: resolved.vault, profile: resolved.profile };
  } catch (err) {
    if (err instanceof VaultUnreachableError) {
      return { campaign: name, reachable: false, reason: err.reason, vaultPath: resolved.vault, profile: resolved.profile };
    }
    return { campaign: name, reachable: false, reason: 'error', error: err.message, vaultPath: resolved.vault, profile: resolved.profile };
  }
}

/** One-liner used for the no-campaign-argument, list-every-campaign form. */
function oneLineReachability(r) {
  if (r.reachable) return `${r.campaign}: reachable (${r.vaultPath})`;
  if (r.reason === 'error') return `${r.campaign}: error: ${r.error}`;
  return `${r.campaign}: unreachable (${r.reason}): ${r.vaultPath || ''}`;
}

function runStatusCommand(flags, campaignArg) {
  const { config } = loadConfig(flags);
  const generatedAt = new Date().toISOString();

  if (!campaignArg && !flags.campaign) {
    const names = listCampaigns(config);
    if (names.length === 0) {
      const envelope = { schemaVersion: SCHEMA_VERSION, tool: { name: 'scriptorium', version: pkg.version }, generatedAt, campaigns: [] };
      return { exitCode: EXIT_CODES.OK, human: 'no campaigns registered; run "gm-scriptorium config add" first', envelope };
    }
    const results = names.map((name) => reachabilityFor(config, name));
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      tool: { name: 'scriptorium', version: pkg.version },
      generatedAt,
      campaigns: results,
    };
    return { exitCode: EXIT_CODES.OK, human: results.map(oneLineReachability).join('\n'), envelope };
  }

  const ctxInfo = resolveCampaignContext(flags, campaignArg);

  let vaultPath;
  let jsonConfig;
  let vaultMismatch;
  let packShadowed;
  let packToml;
  try {
    ({ vaultPath, jsonConfig, vaultMismatch, packShadowed, packToml } = resolveVaultContext(ctxInfo));
  } catch (err) {
    if (err instanceof VaultUnreachableError) {
      const envelope = {
        schemaVersion: SCHEMA_VERSION,
        tool: { name: 'scriptorium', version: pkg.version },
        campaign: ctxInfo.campaign,
        generatedAt,
        reachable: false,
        reason: err.reason,
      };
      return {
        exitCode: EXIT_CODES.VAULT_UNREACHABLE,
        human: `${ctxInfo.campaign}: unreachable (${err.reason}): ${err.message}`,
        envelope,
      };
    }
    throw err;
  }

  const index = buildResolutionIndex(vaultPath, jsonConfig);
  const counts = countsFor(index);
  const last = lastSession(index);
  const next = nextSession(index);
  const outputPath = ctxInfo.output ? path.resolve(ctxInfo.output) : null;
  const build = outputBuildInfo(outputPath);

  let checkVerdict = null;
  let verdictLine;
  try {
    const checkResult = runCheckCommand(flags, campaignArg);
    checkVerdict = checkResult.envelope.counts;
    verdictLine = `${checkVerdict.error} error(s), ${checkVerdict.warn} warning(s)`;
  } catch (err) {
    verdictLine = `check could not run: ${err.message}`;
  }

  const lastSessionJson = last
    ? { title: last.title, sessionNumber: last.sessionNumber, playDate: formatDateLike(last.playDate) }
    : null;
  const nextSessionJson = next ? { title: next.title, date: formatDateLike(next.date) } : null;

  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'scriptorium', version: pkg.version },
    campaign: ctxInfo.campaign,
    profile: ctxInfo.profile || null,
    vaultPath,
    vaultMismatch,
    generatedAt,
    reachable: true,
    outputPath,
    build,
    lastSession: lastSessionJson,
    nextSession: nextSessionJson,
    counts: {
      files: counts.files,
      wikiLinks: counts.wikiLinks,
      unresolvedLinks: counts.unresolvedLinks,
      portraitsWired: counts.portraitsWired,
      entitiesByType: sortedEntitiesByType(counts.entitiesByType),
    },
    checkVerdict,
  };

  const lines = [
    `campaign: ${ctxInfo.campaign}${ctxInfo.profile ? ` (profile: ${ctxInfo.profile})` : ''}`,
    `vault: ${vaultPath} (reachable)`,
    ...(vaultMismatch ? [`note: ${siteVaultPathMismatchMessage(vaultMismatch)}`] : []),
    ...(packShadowed ? [`note: ${packShadowedMessage(packShadowed)}`] : []),
    ...packToml.warnings.map((w) => `warning: ${w}`),
    `output: ${ctxInfo.output || '(not configured)'} ${build.exists ? `(built ${build.mtime})` : '(no build yet)'}`,
    `last session: ${last ? `${last.title}${last.playDate ? ` (${formatDateLike(last.playDate)})` : ''}` : 'none recorded'}`,
    `next session: ${next ? `${next.title}${next.date ? ` (${formatDateLike(next.date)})` : ' (date not recorded)'}` : 'not recorded'}`,
    `files: ${counts.files}, wiki-links: ${counts.wikiLinks} (${counts.unresolvedLinks} unresolved), portraits wired: ${counts.portraitsWired}`,
    `entities by type: ${Object.entries(envelope.counts.entitiesByType)
      .map(([t, n]) => `${t}=${n}`)
      .join(', ')}`,
    `check: ${verdictLine}`,
  ];

  return { exitCode: EXIT_CODES.OK, human: lines.join('\n'), envelope };
}

module.exports = { runStatusCommand };
