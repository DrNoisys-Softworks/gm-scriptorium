'use strict';

const { resolveCampaignContext } = require('./args');
const { resolveVaultSite } = require('./check');
const { startLocalListener: startLocalListenerImpl } = require('../serve/server');
const { createToken: createTokenImpl } = require('../admin/session');
const { createAdminContext } = require('../admin/context');
const { createAdminHandler, createPreviewHandler } = require('../admin/router');
const { removePreviewRoot } = require('../admin/preview');
const { EXIT_CODES } = require('../util/exitcodes');
const { onStopSignal } = require('../util/stop-signals');
const { ConfigError } = require('../util/errors');

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-s1-engineering-brief-2026-09-28.md, "Interfaces and
 * contracts / serve-admin.js"). `runServeCommand` (src/cli/serve.js) branches into this before
 * resolveCampaignContext runs at all, so a rejected admin flag never reads config or applies an
 * --out override (Structural decision 1).
 */

const ADMIN_ALLOWED_FLAGS = Object.freeze(['admin', 'campaign', 'config', 'vault', 'port', 'json']);

/** @param {number} port @param {string} token */
function adminUrl(port, token) {
  return `http://127.0.0.1:${port}/auth?token=${token}`;
}

/** @throws {ConfigError} one line, no stack trace */
function checkAllowlist(flags) {
  for (const key of Object.keys(flags)) {
    if (ADMIN_ALLOWED_FLAGS.includes(key)) continue;
    if (key === 'host' || key.startsWith('host=')) {
      throw new ConfigError('serve --admin only ever listens on 127.0.0.1, so it does not accept --host');
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

/**
 * @param {object} flags
 * @param {string} [campaignArg]
 * @param {{ emit?: (line: string) => void, signals?: NodeJS.EventEmitter, startLocalListener?: typeof startLocalListenerImpl, createToken?: () => string }} [opts]
 * @returns {Promise<{ exitCode: number, human: string }>}
 */
async function runAdminServe(
  flags,
  campaignArg,
  { emit = console.log, signals = process, startLocalListener = startLocalListenerImpl, createToken = createTokenImpl } = {},
) {
  checkAllowlist(flags);
  const port = parsePort(flags);

  const ctxInfo = resolveCampaignContext(flags, campaignArg);
  const { vaultPath, site } = resolveVaultSite(ctxInfo);

  const token = createToken();
  const ctx = createAdminContext({ ctxInfo, vaultPath, site, token });

  let adminHandle;
  try {
    adminHandle = await startLocalListener(createAdminHandler(ctx), { port });
  } catch (err) {
    return { exitCode: EXIT_CODES.SCRIPTORIUM_ERROR, human: `failed to start server: ${err.message}` };
  }
  ctx.adminPort = adminHandle.port;

  let previewHandle;
  try {
    previewHandle = await startLocalListener(createPreviewHandler(ctx), { port: 0 });
  } catch (err) {
    await adminHandle.close();
    return { exitCode: EXIT_CODES.SCRIPTORIUM_ERROR, human: `failed to start server: ${err.message}` };
  }
  ctx.previewPort = previewHandle.port;

  // Handler first, readiness line after: a supervisor signalling the moment it reads "ready"
  // must never beat the handler (issue #27).
  const stopped = new Promise((resolve) => {
    onStopSignal(signals, (signal) => {
      Promise.resolve()
        .then(async () => {
          await adminHandle.close();
          await previewHandle.close();
          // Phase 8 slice S2 (NFR07): best-effort, swallowed inside removePreviewRoot itself --
          // a cleanup failure (e.g. a locked file) must never change the exit code Ctrl-C reports.
          removePreviewRoot(ctx);
        })
        .finally(() =>
          resolve({
            exitCode: EXIT_CODES.OK,
            human: 'stopped.',
            ...(flags.json ? { envelope: { event: 'stopped', signal, exitCode: EXIT_CODES.OK } } : {}),
          }),
        );
    });
  });
  if (flags.json) {
    // Issue #27: one compact JSON readiness line (NDJSON); the admin URL carries the session token.
    emit(
      JSON.stringify({
        event: 'ready',
        mode: 'admin',
        adminUrl: adminUrl(ctx.adminPort, token),
        adminPort: ctx.adminPort,
        previewUrl: `http://127.0.0.1:${ctx.previewPort}/`,
        previewPort: ctx.previewPort,
      }),
    );
  } else {
    emit(`admin panel: ${adminUrl(ctx.adminPort, token)}`);
    emit(`preview: http://127.0.0.1:${ctx.previewPort}/`);
    emit('open the admin panel link in your browser. Press Ctrl-C to stop.');
  }

  return stopped;
}

module.exports = { runAdminServe, adminUrl, ADMIN_ALLOWED_FLAGS };
