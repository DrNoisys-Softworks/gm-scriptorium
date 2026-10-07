'use strict';

const fs = require('fs');
const path = require('path');
const read = require('../vault/read');
const { loadPackToml } = require('../build/packtoml');
const { resolveCampaignContext } = require('./args');
const { locateVault } = require('../vault/locate');
const { buildCheckContext } = require('../checks/context');
const { runChecks } = require('../checks/run');
const { CHECKS, defaultEnabledChecks } = require('../checks/registry');
const { buildEnvelope } = require('../report/json');
const { renderHuman } = require('../report/human');
const { EXIT_CODES } = require('../util/exitcodes');
const { ConfigError, VaultUnreachableError } = require('../util/errors');
const pkg = require('../../package.json');

const PACK_CONFIG_FILE = 'vault.config.json';

/** By convention, a campaign pack's own directory (docs/decisions/0018-campaign-pack.md). */
function conventionPackDir(vaultPath) {
  return path.join(vaultPath, '_meta', 'scriptorium');
}

/**
 * Loads a legacy site config (vault.config.json). A legacy site config
 * lives OUTSIDE the vault (Requirements section 8.1: "site/ must be outside
 * vault/"), so reading it is plain fs, not routed through
 * src/vault/read.js's vault chokepoint. A campaign pack's vault.config.json
 * may live INSIDE the vault instead (docs/decisions/0018-campaign-pack.md:
 * inputs may live in the vault, output may not) and is read through
 * src/vault/read.js's readText() by loadPackConfig() below, not by this
 * function.
 *
 * A missing `site_config` is a user configuration mistake, not a
 * Scriptorium bug, so it throws `ConfigError` (same family as the sibling
 * "campaign has no vault configured" check in `resolveVaultContext` below)
 * rather than a bare `Error`. `bin/scriptorium.js` prints `ConfigError`s as
 * a clean one-line message with no stack trace and exits 1
 * (`EXIT_CODES.SCRIPTORIUM_ERROR`) — the same code every other config
 * error in this codebase already uses; the frozen exit table's "not a
 * finding about the vault" clause is what makes 1 the fit here, not 2
 * (there is no finding: the run never got far enough to produce one).
 * `check`, `build`, and `status` all resolve the vault context through
 * this same function, so fixing it here closes the hole for all three.
 */
function loadSiteConfig(siteConfigPath) {
  if (!siteConfigPath) {
    throw new VaultUnreachableError(
      'campaign has no site_config configured. Set site_config on the campaign, or use a pack (gm-scriptorium init).',
      { path: null, campaign: null, reason: 'no-site-config' },
    );
  }
  const raw = fs.readFileSync(siteConfigPath, 'utf8');
  const jsonConfig = JSON.parse(raw);
  if (jsonConfig.vaultPath) {
    jsonConfig.vaultPath = path.resolve(path.dirname(siteConfigPath), jsonConfig.vaultPath);
  }
  return jsonConfig;
}

/**
 * ADR 0018: resolves which of the three site-input sources a campaign uses,
 * in the sequence `site_config` (including `--site-config`) > the `pack` key >
 * the convention directory `<vault>/_meta/scriptorium/`. "Set" means a
 * non-empty string; an empty string counts as unset, the same convention
 * loadSiteConfig's own falsy check above already uses. Runs after
 * `locateVault` (never in src/config/resolve.js, which may not stat
 * anything).
 *
 * @param {object} ctxInfo return value of resolveCampaignContext
 * @param {string} vaultPath absolute, already resolved
 * @returns {{ siteSource: 'site_config'|'pack'|'convention', siteConfigPath: string,
 *   siteDir: string, packShadowed: null | { siteConfigPath: string, packDir: string,
 *   packSource: 'pack'|'convention' } }}
 * @throws {ConfigError}
 */
/** Issue #108: an unusable campaign pack is a campaign-config problem, exit 3 (see asPackProblem). */
function packProblem(message, atPath, campaign) {
  return new VaultUnreachableError(message, { path: atPath, campaign, reason: 'bad-pack' });
}

function resolveSiteSource(ctxInfo, vaultPath) {
  const hasSiteConfig = typeof ctxInfo.site_config === 'string' && ctxInfo.site_config.length > 0;
  const hasPack = typeof ctxInfo.pack === 'string' && ctxInfo.pack.length > 0;

  if (hasSiteConfig) {
    const siteDir = path.dirname(path.resolve(ctxInfo.site_config));
    const candidate = hasPack ? path.resolve(ctxInfo.pack) : conventionPackDir(vaultPath);
    let packShadowed = null;
    if (read.pathExists(path.join(candidate, PACK_CONFIG_FILE))) {
      packShadowed = {
        siteConfigPath: path.resolve(ctxInfo.site_config),
        packDir: candidate,
        packSource: hasPack ? 'pack' : 'convention',
      };
    }
    // siteConfigPath is ctxInfo.site_config AS GIVEN (not resolved): legacy
    // callers (loadSiteConfig, computeVaultMismatch) must see the same
    // argument they always have.
    return { siteSource: 'site_config', siteConfigPath: ctxInfo.site_config, siteDir, packShadowed };
  }

  if (hasPack) {
    const packDir = path.resolve(ctxInfo.pack);
    if (!read.pathExists(packDir)) {
      throw packProblem(`campaign "${ctxInfo.campaign}": pack directory does not exist: ${packDir}`, packDir, ctxInfo.campaign);
    }
    const jsonPath = path.join(packDir, PACK_CONFIG_FILE);
    if (!read.pathExists(jsonPath)) {
      throw packProblem(
        `campaign "${ctxInfo.campaign}": pack directory ${packDir} has no ${PACK_CONFIG_FILE}`,
        packDir,
        ctxInfo.campaign,
      );
    }
    // Never falls through to the convention: an explicit pack that silently
    // doesn't apply is the class of bug FR-17 existed to kill.
    return { siteSource: 'pack', siteConfigPath: jsonPath, siteDir: packDir, packShadowed: null };
  }

  const conventionDir = conventionPackDir(vaultPath);
  const conventionJson = path.join(conventionDir, PACK_CONFIG_FILE);
  if (read.pathExists(conventionJson)) {
    return { siteSource: 'convention', siteConfigPath: conventionJson, siteDir: conventionDir, packShadowed: null };
  }
  if (read.pathExists(conventionDir)) {
    throw packProblem(
      `campaign "${ctxInfo.campaign}": ${conventionDir} exists but has no ${PACK_CONFIG_FILE}`,
      conventionDir,
      ctxInfo.campaign,
    );
  }
  // Issue #108: a campaign with no site inputs at all is a campaign-config problem, exit 3.
  throw new VaultUnreachableError(
    `campaign "${ctxInfo.campaign}" has no site config: site_config is not set, pack is not set, and ${conventionJson} does not exist. ` +
      'Run "gm-scriptorium init" to create one, or set site_config or pack on the campaign.',
    { path: conventionJson, campaign: ctxInfo.campaign, reason: 'no-site-config' },
  );
}

/**
 * Phase 8 slice S3 (FR19, SD-6): the pure parse-and-validate half of `loadPackConfig`, extracted
 * verbatim so the admin panel can run a candidate `vault.config.json` through the exact same
 * rules `check`/`build` apply to the on-disk file, without going through `read.readText` (the
 * panel already has the bytes in hand, from the request body or the on-disk raw it re-read
 * itself). No special handling of `vaultPath` or `outputDir`: both are pack-relative, same as any
 * other site config (D-06). `vaultPath`, if present, is resolved the same way loadSiteConfig()
 * above resolves it.
 *
 * @param {string} raw
 * @param {string} packConfigPath absolute
 * @param {string} campaign
 * @throws {ConfigError} parse error or non-object
 */
function parsePackConfigText(raw, packConfigPath, campaign) {
  let jsonConfig;
  try {
    jsonConfig = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `campaign "${campaign}": ${packConfigPath} is not valid JSON: ${err.message.replace(/\s+/g, ' ')}`,
    );
  }
  if (typeof jsonConfig !== 'object' || jsonConfig === null || Array.isArray(jsonConfig)) {
    throw new ConfigError(`campaign "${campaign}": ${packConfigPath} must contain a JSON object`);
  }
  if (jsonConfig.vaultPath) {
    jsonConfig.vaultPath = path.resolve(path.dirname(packConfigPath), jsonConfig.vaultPath);
  }
  return jsonConfig;
}

/**
 * ADR 0018: loads a campaign pack's vault.config.json through the vault
 * read chokepoint (src/vault/read.js's readText, called through the module
 * object so a test can spy on it), then through parsePackConfigText above.
 *
 * @param {string} packConfigPath absolute
 * @param {string} campaign
 * @throws {ConfigError} parse error or non-object
 * @throws {VaultReadError} filesystem read failure (see src/vault/read.js)
 */
function loadPackConfig(packConfigPath, campaign) {
  return parsePackConfigText(read.readText(packConfigPath), packConfigPath, campaign);
}

/**
 * rc.2 Windows follow-ups, DEFECT 2: the pinned generator's own scan (lib/scanner.js's
 * scanVaultReport, reached from the real `build()` via src/generator/bootstrap.js's
 * runGeneratorBuild) reads `config.excludeDirs` and `config.folderMap` with no defaulting
 * of its own -- `excludeDirs.some(...)` throws "Cannot read properties of undefined
 * (reading 'some')" and `Object.entries(folderMap)` (inside the pin's own mapFolder) throws
 * "Cannot convert undefined or null to object" when either key is simply absent from
 * vault.config.json. Confirmed by reading lib/scanner.js directly: no `|| []` / `|| {}`
 * anywhere in scanVaultReport or mapFolder. Neither lib/config.js's loadVaultConfig nor
 * PUBLISH_DEFAULTS supplies a default for either key anywhere in the pin (PUBLISH_DEFAULTS
 * only defaults the unrelated, snake_case, content-filter `exclude_dirs`), and the pin's own
 * scaffold template (templates-scaffold/vault.config.json.tmpl, read verbatim by
 * src/cli/init.js via pinned.readVaultConfigTemplate) always emits both keys explicitly.
 * So the generator's own contract treats these as required, never optional-with-defaults:
 * refusing early, before either `check` or `build` ever reaches the generator, is the
 * correct behaviour (Engineering brief, DEFECT 2's decision framework), not supplying a
 * Scriptorium-side default that would silently diverge from what the pin itself does.
 *
 * Called from resolveVaultContext, the one function `check`, `build` (src/cli/build.js's
 * runBuildForContext), `serve --admin`'s preview build (src/admin/preview.js's
 * runPreviewBuild -> runBuildForContext), and init's post-scaffold check
 * (src/cli/init.js's runCheck -> runCheckCommand) all resolve the site config through --
 * so this one check reaches every entry point that can reach the generator's scan.
 *
 * `== null` catches both an absent key (undefined) and an explicit `null`, either of which
 * feeds the same raw TypeError above.
 *
 * Reviewer correction (rc.2 same-day re-review, 2026-09-29): presence alone is not enough.
 * `excludeDirs` is consumed with `.some(...)` (lib/scanner.js, mirrored in
 * src/vault/publishset.js's own ported isExcludedDir) -- a string, number or plain object all
 * have no `.some`, so a present-but-wrong-typed `excludeDirs` reaches that call and throws the
 * exact same unrefused class of raw TypeError DEFECT 2 exists to close (live-reproduced:
 * `excludeDirs: "not-an-array"` against `runCheckCommand` throws "TypeError: excludeDirs.some is
 * not a function" out of src/vault/publishset.js, full stack trace, before this function's own
 * fix). `folderMap` is consumed with `Object.entries(...)` then `[vaultDir, outputDir]`
 * destructuring -- JS does not throw there for a non-object argument (`Object.entries` on a
 * string/array/number returns entries, or `[]`, never throws), so a wrong-typed `folderMap` does
 * not crash the way `excludeDirs` does. It is refused anyway, for the same reason a MISSING
 * `folderMap` already is: the pin's own scaffold and every real fixture in this repo carry it as
 * a plain object, `mapFolder`'s destructuring assumes vault-folder-path-string ->
 * output-folder-path-string pairs, and a wrong-typed value here silently maps every folder to
 * garbage (or drops it as unmapped) rather than failing loudly -- arguably worse than a crash,
 * since nothing tells the GM their config is wrong.
 *
 * @param {object} siteConfig the parsed vault.config.json
 * @param {string} siteConfigPath the file it came from (resolveSiteSource's own
 *   siteConfigPath: as-given for a legacy site_config, resolved for a pack/convention one)
 * @param {string} campaign
 * @throws {ConfigError}
 */
function describeConfigValueType(value) {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  const t = typeof value;
  return t === 'object' ? 'an object' : `a ${t}`;
}

function assertScanKeysPresent(siteConfig, siteConfigPath, campaign) {
  const missing = ['excludeDirs', 'folderMap'].filter((key) => siteConfig[key] == null);
  if (missing.length > 0) {
    throw new ConfigError(
      `campaign "${campaign}": ${siteConfigPath} is missing required key${missing.length > 1 ? 's' : ''} ${missing.join(' and ')}`,
    );
  }
  if (!Array.isArray(siteConfig.excludeDirs)) {
    throw new ConfigError(
      `campaign "${campaign}": ${siteConfigPath}: excludeDirs must be an array of directory names, not ${describeConfigValueType(siteConfig.excludeDirs)}`,
    );
  }
  if (typeof siteConfig.folderMap !== 'object' || Array.isArray(siteConfig.folderMap)) {
    throw new ConfigError(
      `campaign "${campaign}": ${siteConfigPath}: folderMap must be an object mapping vault folders to output folders, not ${describeConfigValueType(siteConfig.folderMap)}`,
    );
  }
}

/**
 * Computes the FR-18 mismatch object: null unless the site config carries
 * its own `vaultPath` and it resolves to a different absolute path than
 * the one Scriptorium actually resolved (`--vault` > matched profile >
 * campaign block). String comparison only: no case folding, no realpath
 * (SC-01's non-goal).
 *
 * @param {object} jsonConfig the loaded site config; `.vaultPath`, if
 *   present, is already resolved absolute by loadSiteConfig
 * @param {string} vaultPath absolute, the resolved vault
 * @param {string} siteConfigPath the site config's own path (may be relative)
 * @returns {null | { siteConfigPath: string, siteConfigVaultPath: string, resolvedVaultPath: string, used: 'resolved' }}
 */
function computeVaultMismatch(jsonConfig, vaultPath, siteConfigPath) {
  const siteVaultPath = jsonConfig.vaultPath;
  if (!siteVaultPath) return null;
  if (siteVaultPath === vaultPath) return null;
  return {
    siteConfigPath: path.resolve(siteConfigPath),
    siteConfigVaultPath: siteVaultPath,
    resolvedVaultPath: vaultPath,
    used: 'resolved',
  };
}

/**
 * Resolves the vault every command must read (`--vault` > matched profile >
 * campaign block, already decided by resolveCampaignContext), independent
 * of whatever the site config's own `vaultPath` says. The site config's
 * `vaultPath` is overwritten on the returned `jsonConfig` so no downstream
 * consumer can prefer it by accident (closes the FR-17 defect); a
 * divergence is reported via `vaultMismatch`, never used and never fatal.
 *
 * ADR 0018: which site inputs are used is decided by resolveSiteSource
 * (site_config > pack > convention) right after locateVault, above.
 *
 * @param {object} ctxInfo return value of resolveCampaignContext (args.js:69-76)
 * @returns {{ vaultPath: string, jsonConfig: object, vaultMismatch: null | object,
 *   siteDir: string, siteSource: 'site_config'|'pack'|'convention',
 *   packShadowed: null | object, packToml: object }}
 * @throws {ConfigError} ctxInfo.vault is not a non-empty string, or a pack/convention failure,
 *   or ADR 0019's pack.toml syntax/type/theme validation
 * @throws {VaultUnreachableError} from locateVault
 */
/**
 * Phase 8 slice S1 (docs/agent-runs/admin-s1-engineering-brief-2026-09-28.md, Structural
 * decision 10): a pure extraction of resolveVaultContext's own first lines, moved verbatim so
 * `serve --admin` can resolve the vault and site source once, at launch, WITHOUT ever going on
 * to parse the pack files (that stays deferred to FR21 in slice S2). resolveVaultContext below
 * calls this immediately, so its own behaviour and message text are unchanged.
 *
 * @param {object} ctxInfo return value of resolveCampaignContext (args.js:69-76)
 * @returns {{ vaultPath: string, site: ReturnType<typeof resolveSiteSource> }}
 * @throws {ConfigError} ctxInfo.vault is not a non-empty string, or a pack/convention failure
 * @throws {VaultUnreachableError} from locateVault
 */
function resolveVaultSite(ctxInfo) {
  if (typeof ctxInfo.vault !== 'string' || ctxInfo.vault.length === 0) {
    throw new VaultUnreachableError(
      `campaign "${ctxInfo.campaign}" has no vault configured. Set one with: gm-scriptorium config add ${ctxInfo.campaign} ` +
        '--vault <vault folder> --out <output folder>',
      { path: null, campaign: ctxInfo.campaign, reason: 'no-vault' },
    );
  }
  const vaultPath = path.resolve(ctxInfo.vault);
  locateVault(vaultPath, ctxInfo.campaign);

  const site = resolveSiteSource(ctxInfo, vaultPath);
  return { vaultPath, site };
}

/**
 * Issue #108: the campaign pack lives in the vault's _meta, so a pack that cannot be used (missing
 * folder, bad pack.toml or pack config, an asset over the limit) is a campaign-config problem and
 * exits 3. Only a ConfigError is converted; anything else (a genuinely unexpected exception) passes
 * through unchanged and still exits 1 with its stack.
 *
 * @template T
 * @param {() => T} fn
 * @param {string} campaign
 * @returns {T}
 * @throws {VaultUnreachableError} reason 'bad-pack'
 */
function asPackProblem(fn, campaign) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new VaultUnreachableError(err.message, { path: err.path || null, campaign: err.campaign || campaign || null, reason: 'bad-pack', cause: err });
    }
    throw err;
  }
}

function resolveVaultContext(ctxInfo) {
  const { vaultPath, site } = resolveVaultSite(ctxInfo);
  const siteConfig =
    site.siteSource === 'site_config'
      ? loadSiteConfig(site.siteConfigPath)
      : asPackProblem(() => loadPackConfig(site.siteConfigPath, ctxInfo.campaign), ctxInfo.campaign);
  assertScanKeysPresent(siteConfig, site.siteConfigPath, ctxInfo.campaign);
  const vaultMismatch = computeVaultMismatch(siteConfig, vaultPath, site.siteConfigPath);

  // ADR 0019 (P3a-FR01, Structural decision 4): pack.toml's SYNTAX validation runs here, in
  // resolveVaultContext, so check/build/status all refuse a malformed pack.toml alike. The
  // FILE-CHECK half (P3a-FR06) is planThemeAssets, called separately by src/cli/build.js
  // before runAtomicBuild.
  const packToml = asPackProblem(() => loadPackToml(site.siteDir, { campaign: ctxInfo.campaign }), ctxInfo.campaign);

  return {
    vaultPath,
    jsonConfig: { ...siteConfig, vaultPath },
    vaultMismatch,
    siteDir: site.siteDir,
    siteSource: site.siteSource,
    packShadowed: site.packShadowed,
    packToml,
  };
}

/**
 * Phase 8 slice S2 (Structural decision 2): taking an already-resolved `ctxInfo` instead of
 * resolving it itself. `serve --admin` (src/admin/handlers/views.js, src/admin/preview.js) calls
 * this directly with the launch-bound `ctxInfo`, so `/api/check` and a preview build's pre-check
 * both re-resolve the vault and site source ZERO times after launch (FR03: "resolved once, at
 * launch, and stay fixed for the life of the process"). Every other caller keeps going through
 * runCheckCommand below, which resolves ctxInfo itself and is otherwise byte-identical to before
 * this extraction.
 *
 * V1e-9 (SD-91): the body of runCheckForContext, extracted verbatim so src/admin/candidatecheck.js
 * can run a real check (under the read overlay) and keep the checkCtx it produced, specifically
 * for checkCtx.publishSet -- ADR 0041. runCheckForContext below delegates here and stays
 * behaviour-identical: same arguments, same three returned keys, no other line changed.
 *
 * @param {object} ctxInfo return value of resolveCampaignContext (args.js:69-76)
 * @param {object} flags parsed CLI flags for `check`
 * @param {object} [opts]
 * @param {boolean} [opts.deferOutputScan] see runCheckForContext
 * @returns {{ envelope: object, exitCode: number, human: string, checkCtx: object }}
 */
function runCheckForContextWithContext(ctxInfo, flags, opts = {}) {
  const { vaultPath, jsonConfig, vaultMismatch, packShadowed, packToml } = resolveVaultContext(ctxInfo);

  const graph = Boolean(flags.graph);
  const checkCtx = buildCheckContext({
    campaign: ctxInfo.campaign,
    vaultPath,
    jsonConfig,
    outputPath: ctxInfo.output ? path.resolve(ctxInfo.output) : null,
    graph,
    vaultMismatch,
    packShadowed,
    packToml,
    deferOutputScan: Boolean(opts.deferOutputScan),
  });

  const findings = runChecks(checkCtx);
  const envelope = buildEnvelope({
    tool: { name: 'scriptorium', version: pkg.version },
    campaign: ctxInfo.campaign,
    vaultPath,
    outputPath: checkCtx.outputPath,
    findings,
  });

  const hasError = envelope.counts.error > 0;
  const exitCode = hasError ? EXIT_CODES.CHECK_FAILED : EXIT_CODES.OK;

  const checkedIds = defaultEnabledChecks({ graph }).map((c) => c.id);
  // ADR 0019, Structural decision 11: pack.toml warnings are human-only, never in the JSON
  // envelope. With no warnings this join is byte-identical to the un-prefixed renderHuman output.
  const human = [...packToml.warnings.map((w) => `warning: ${w}`), renderHuman(envelope, { checkedIds, graphOn: graph })].join(
    '\n',
  );

  return { envelope, exitCode, human, checkCtx };
}

/**
 * @param {object} ctxInfo return value of resolveCampaignContext (args.js:69-76)
 * @param {object} flags parsed CLI flags for `check`
 * @param {object} [opts]
 * @param {boolean} [opts.deferOutputScan] Track D2, FR-16: threaded onto
 *   buildCheckContext untouched. **Only** src/cli/build.js:126 ever passes
 *   `true`; every other existing caller of runCheckForContext omits `opts`
 *   entirely, so `deferOutputScan` defaults to `false` and behaviour is
 *   unchanged for them.
 * @returns {{ envelope: object, exitCode: number, human: string }}
 */
function runCheckForContext(ctxInfo, flags, opts = {}) {
  const { envelope, exitCode, human } = runCheckForContextWithContext(ctxInfo, flags, opts);
  return { envelope, exitCode, human };
}

/**
 * @param {object} flags parsed CLI flags for `check`
 * @param {string} [campaignArg]
 * @param {object} [opts]
 * @param {boolean} [opts.deferOutputScan] see runCheckForContext
 * @returns {{ envelope: object, exitCode: number, human: string }}
 */
function runCheckCommand(flags, campaignArg, opts = {}) {
  const ctxInfo = resolveCampaignContext(flags, campaignArg);
  return runCheckForContext(ctxInfo, flags, opts);
}

module.exports = {
  runCheckCommand,
  runCheckForContext,
  runCheckForContextWithContext,
  loadSiteConfig,
  resolveVaultContext,
  asPackProblem,
  resolveVaultSite,
  loadPackConfig,
  parsePackConfigText,
  assertScanKeysPresent,
};
