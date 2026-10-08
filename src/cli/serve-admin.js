'use strict';

const os = require('os');
const { resolveCampaignContext, loadConfig } = require('./args');
const { resolveVaultSite } = require('./check');
const { startLocalListener: startLocalListenerImpl, startPanelListener: startPanelListenerImpl } = require('../serve/server');
const { createToken: createTokenImpl } = require('../admin/session');
const { createAdminContext } = require('../admin/context');
const { createAdminHandler, createPreviewHandler } = require('../admin/router');
const { removeAllPreviewRoots } = require('../admin/preview');
const campaignstate = require('../admin/campaignstate');
const { EXIT_CODES } = require('../util/exitcodes');
const { onStopSignal } = require('../util/stop-signals');
const { ConfigError } = require('../util/errors');
const settingsLib = require('../remote/settings');
const { remotePaths, assertNotInsideAnyVault, findLooseModes } = require('../remote/paths');
const { makePeerPredicate } = require('../remote/addr');
const { readPasswordRecord } = require('../remote/password');
const { createSessionStore } = require('../remote/sessions');
const { createAuditLog } = require('../remote/audit');
const { createLockoutState } = require('../remote/lockout');
const { createTicketStore } = require('../remote/tickets');

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-s1-engineering-brief-2026-09-28.md, "Interfaces and
 * contracts / serve-admin.js"). `runServeCommand` (src/cli/serve.js) branches into this before
 * resolveCampaignContext runs at all, so a rejected admin flag never reads config or applies an
 * --out override (Structural decision 1).
 *
 * V1.5a (docs/decisions/0029-remote-access.md, SD-doc section 14): remote access comes ONLY from
 * the saved, validated [remote] settings, never from a flag. Every readiness problem is one
 * ConfigError raised before any socket opens, and there is never a fallback to a wider bind. The
 * pre-listen warning is emitted before the first listener starts (ADR 0002's ordering). With no
 * [remote] table (or mode = "local") every line and every listener call is exactly what it was.
 */

const ADMIN_ALLOWED_FLAGS = Object.freeze(['admin', 'campaign', 'config', 'vault', 'port', 'preview-port', 'json']);

/** @param {number} port @param {string} token */
function adminUrl(port, token) {
  return `http://127.0.0.1:${port}/auth?token=${token}`;
}

/** @throws {ConfigError} one line, no stack trace */
function checkAllowlist(flags) {
  for (const key of Object.keys(flags)) {
    if (ADMIN_ALLOWED_FLAGS.includes(key)) continue;
    if (key === 'host' || key.startsWith('host=')) {
      throw new ConfigError('serve --admin does not accept --host; remote access comes only from saved settings (see "gm-scriptorium remote")');
    }
    throw new ConfigError(`serve --admin does not accept --${key}`);
  }
}

/** @throws {ConfigError} @returns {number} 0 (OS-assigned) when --port is absent */
function parsePort(flags) {
  if (flags.port === undefined) return 0;
  const raw = flags.port;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ConfigError('serve --admin: --port must be a whole number from 1 to 65535');
  }
  const n = Number(raw);
  if (n < 1 || n > 65535) {
    throw new ConfigError('serve --admin: --port must be a whole number from 1 to 65535');
  }
  return n;
}

/** @throws {ConfigError} @returns {number} 0 (OS-assigned) when --preview-port is absent */
function parsePreviewPort(flags, port) {
  if (flags['preview-port'] === undefined) return 0;
  const raw = flags['preview-port'];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new ConfigError('serve --admin: --preview-port must be a whole number from 1 to 65535');
  }
  const n = Number(raw);
  if (flags.port !== undefined && n === port) {
    throw new ConfigError('serve --admin: --preview-port must differ from --port');
  }
  return n;
}

function defaultIdentity() {
  try {
    return { user: os.userInfo().username, host: os.hostname() };
  } catch {
    return { user: 'USER', host: 'HOST' };
  }
}

const SETUP_LINE = 'setup: no campaign yet, so the panel starts with setup';

/**
 * ADR 0028, section 1: with no campaign argument and no campaigns registered, `serve --admin`
 * starts browser setup instead of exiting 3. Anything else reaches resolveCampaignContext exactly
 * as before, so `serve --admin ghost`, `--campaign ghost`, plain `serve`, `check` and `build` keep
 * their exit codes and messages.
 *
 * @returns {{ configPath: string, config: object } | null} the loaded config when setup applies
 */
function detectSetup(flags, campaignArg) {
  if (campaignArg || flags.campaign) return null;
  const { configPath, config } = loadConfig(flags);
  if (Object.keys(config.campaigns || {}).length > 0) return null;
  if (flags.vault !== undefined) {
    throw new ConfigError('serve --admin does not accept --vault while no campaign is registered; browser setup starts instead');
  }
  return { configPath, config };
}

/** The saved remote mode, read only to say it is deferred; a table that does not parse never stops setup. */
function savedRemoteMode(config) {
  try {
    return settingsLib.parseRemoteTable(config.remote).mode;
  } catch {
    const mode = config.remote && config.remote.mode;
    return typeof mode === 'string' && ['ssh', 'tailscale', 'proxy', 'direct'].includes(mode) ? mode : 'local';
  }
}

/**
 * Everything `serve --admin` does up to and including both listeners (extracted from
 * runAdminServe so launch mode reuses it). In setup mode the panel is loopback only whatever
 * [remote] says: no readiness check, no remote listener, one pre-listen line naming the deferred
 * mode. Returns the running panel, or the same listener-failure result runAdminServe always gave.
 *
 * @param {object} flags
 * @param {string} [campaignArg]
 * @param {{ emit?: Function, startLocalListener?: Function, startPanelListener?: Function, createToken?: () => string, now?: () => number, identity?: { user: string, host: string } }} [opts]
 * @returns {Promise<{ ok: true, ctx: object, token: string, settings: object, plan: object, planned: object, setup: boolean, stop: () => Promise<void> } | { ok: false, exitCode: number, human: string }>}
 */
async function startAdminPanel(
  flags,
  campaignArg,
  {
    emit = console.log,
    startLocalListener = startLocalListenerImpl,
    startPanelListener = startPanelListenerImpl,
    createToken = createTokenImpl,
    now = Date.now,
    identity,
  } = {},
) {
  checkAllowlist(flags);
  const port = parsePort(flags);
  const previewPortFlag = parsePreviewPort(flags, port);

  const setupInfo = detectSetup(flags, campaignArg);
  const setupMode = setupInfo !== null;

  let ctxInfo;
  let vaultPath = null;
  let site = { siteSource: null, siteConfigPath: null, siteDir: null };
  let settings;
  if (setupMode) {
    ctxInfo = { configPath: setupInfo.configPath, config: setupInfo.config, campaign: null };
    settings = { mode: 'local' };
  } else {
    ctxInfo = resolveCampaignContext(flags, campaignArg);
    ({ vaultPath, site } = resolveVaultSite(ctxInfo));
    settings = settingsLib.parseRemoteTable(ctxInfo.config.remote);
    if (settings.mode !== 'local' && (flags.port !== undefined || flags['preview-port'] !== undefined)) {
      throw new ConfigError(
        `serve --admin: remote access (mode ${settings.mode}) uses the ports saved in its settings, so it does not accept --port or --preview-port`,
      );
    }
  }

  const paths = remotePaths(ctxInfo.configPath);
  if (settings.mode !== 'local') assertNotInsideAnyVault(paths.panelDir, ctxInfo.config);

  if (settings.mode !== 'local') {
    const problems = settingsLib.readiness(settings, { password: readPasswordRecord(paths.passwordFile).state, tlsSupported: false });
    if (problems.length > 0) throw new ConfigError(problems[0]);
  }

  const plan = settingsLib.listenPlan(settings, { flagPort: port, flagPreviewPort: previewPortFlag });

  const token = createToken();
  const ctx = createAdminContext({ ctxInfo, vaultPath, site, token });

  // Stores. The audit log is written in every mode, local too; in local mode (which skips the
  // startup folder check above) it still refuses to write if the folder is inside a vault. The
  // closure reads ctx.ctxInfo.config at call time, so it sees the config after a setup handover.
  const insideVault = () => {
    try {
      assertNotInsideAnyVault(paths.panelDir, ctx.ctxInfo.config);
      return false;
    } catch {
      return true;
    }
  };
  const sessions = createSessionStore({ file: paths.sessionsFile, now });
  sessions.load();
  const audit = createAuditLog({ file: paths.auditFile, now, isInsideVault: insideVault });
  audit.prune(now());
  const lockout = createLockoutState();
  const tickets = createTicketStore({ now });

  // Dynamic fields, not part of createAdminContext's literal (test/admin-context.test.js is frozen).
  ctx.access = settingsLib.gateProfile(settings, { tls: plan.tls });
  ctx.remote = { settings, paths };
  ctx.sessions = sessions;
  ctx.audit = audit;
  ctx.lockout = lockout;
  ctx.tickets = tickets;
  ctx.clock = now;
  ctx.signinBusy = false;
  // ADR 0050: switching is off when --vault overrides the launched campaign's folder (outside setup mode).
  ctx.campaigns = campaignstate.createCampaignsState({
    lockedReason: !setupMode && flags.vault !== undefined ? campaignstate.vaultFlagReason(ctx.campaign) : null,
  });
  const deferredMode = setupMode ? savedRemoteMode(ctxInfo.config) : 'local';
  if (setupMode) ctx.setup = { active: true, configPath: ctxInfo.configPath, flags, remoteDeferred: deferredMode === 'local' ? null : deferredMode };

  // Before any listener: the warning that names who can reach the panel (ADR 0002's ordering).
  const planned = { adminPort: plan.admin.port, previewPort: plan.preview.port, token, loopbackScheme: plan.tls ? 'https' : 'http' };
  if (settings.mode === 'ssh') Object.assign(planned, identity || defaultIdentity());
  const text = settingsLib.startupText(settings, plan, planned);
  // With --json (issue #27) stdout stays NDJSON, so a pre-listen warning is a JSON event, still emitted
  // before the first listener opens.
  const emitWarning = (line) => emit(flags.json ? JSON.stringify({ event: 'warning', message: line }) : line);
  for (const line of text.pre) emitWarning(line);
  if (deferredMode !== 'local') {
    emitWarning(`setup mode listens on 127.0.0.1 only; remote access (mode ${deferredMode}) starts the next time GM-Scriptorium starts`);
  }
  if (settings.mode === 'tailscale' || settings.mode === 'proxy' || settings.mode === 'direct') {
    for (const loose of findLooseModes(paths)) emitWarning(`warning: ${loose} can be read by other users on this machine`);
  }

  const allowPeer = plan.allowPeers ? makePeerPredicate(plan.allowPeers) : undefined;
  const listen = (handler, which) =>
    plan.useLocalListener
      ? startLocalListener(handler, { port: plan[which].port })
      : startPanelListener(handler, { port: plan[which].port, hosts: plan[which].hosts, allowPeer });

  let adminHandle;
  try {
    adminHandle = await listen(createAdminHandler(ctx), 'admin');
  } catch (err) {
    return { ok: false, exitCode: EXIT_CODES.SCRIPTORIUM_ERROR, human: `failed to start server: ${err.message}` };
  }
  ctx.adminPort = adminHandle.port;

  let previewHandle;
  try {
    previewHandle = await listen(createPreviewHandler(ctx), 'preview');
  } catch (err) {
    await adminHandle.close();
    return { ok: false, exitCode: EXIT_CODES.SCRIPTORIUM_ERROR, human: `failed to start server: ${err.message}` };
  }
  ctx.previewPort = previewHandle.port;

  const stop = async () => {
    await adminHandle.close();
    await previewHandle.close();
    // Phase 8 slice S2 (NFR07): best-effort, swallowed inside removePreviewRoot itself --
    // a cleanup failure (e.g. a locked file) must never change the exit code Ctrl-C reports.
    removeAllPreviewRoots(ctx);
  };

  return { ok: true, ctx, token, settings, plan, planned, setup: setupMode, stop };
}

/**
 * @param {object} flags
 * @param {string} [campaignArg]
 * @param {{ emit?: (line: string) => void, signals?: NodeJS.EventEmitter, startLocalListener?: typeof startLocalListenerImpl, startPanelListener?: typeof startPanelListenerImpl, createToken?: () => string, now?: () => number, identity?: { user: string, host: string } }} [opts]
 * @returns {Promise<{ exitCode: number, human: string }>}
 */
async function runAdminServe(
  flags,
  campaignArg,
  {
    emit = console.log,
    signals = process,
    startLocalListener = startLocalListenerImpl,
    startPanelListener = startPanelListenerImpl,
    createToken = createTokenImpl,
    now = Date.now,
    identity,
  } = {},
) {
  const started = await startAdminPanel(flags, campaignArg, { emit, startLocalListener, startPanelListener, createToken, now, identity });
  if (!started.ok) return { exitCode: started.exitCode, human: started.human };
  const { ctx, token, settings, plan, planned, setup, stop } = started;

  // Handler first, readiness lines after: a supervisor signalling the moment it reads "ready" must
  // never beat the handler (issue #27). Every stop signal (SIGINT, SIGTERM, SIGBREAK on Windows) goes
  // through the one registration.
  const stopped = new Promise((resolve) => {
    onStopSignal(signals, (signal) => {
      Promise.resolve()
        .then(stop)
        .finally(() =>
          resolve({
            exitCode: EXIT_CODES.OK,
            human: 'stopped.',
            ...(flags.json ? { envelope: { event: 'stopped', signal, exitCode: EXIT_CODES.OK } } : {}),
          }),
        );
    });
  });

  // The ports are only known now in local mode (OS-assigned), so the after-listen lines are built
  // from the handles' real ports.
  const after = settingsLib.startupText(settings, plan, { ...planned, adminPort: ctx.adminPort, previewPort: ctx.previewPort });
  if (flags.json) {
    // Issue #27: one compact JSON readiness line (NDJSON); the admin URL carries the one-time token.
    // Remote modes add the external addresses (never a token).
    const ready = {
      event: 'ready',
      mode: 'admin',
      adminUrl: adminUrl(ctx.adminPort, token),
      adminPort: ctx.adminPort,
      previewUrl: `http://127.0.0.1:${ctx.previewPort}/`,
      previewPort: ctx.previewPort,
    };
    if (settings.mode !== 'local') {
      ready.remoteMode = settings.mode;
      if (ctx.access) {
        ready.remoteAdminUrl = `${ctx.access.admin.origin}/`;
        ready.remotePreviewUrl = `${ctx.access.preview.origin}/`;
      }
    }
    if (setup) ready.setup = true;
    emit(JSON.stringify(ready));
  } else {
    for (const line of after.post) emit(line);
    // After the usual lines: test/admin-http.test.js reads emitted[0] as the token line.
    if (setup) emit(SETUP_LINE);
  }

  return stopped;
}

module.exports = { runAdminServe, startAdminPanel, adminUrl, ADMIN_ALLOWED_FLAGS };
