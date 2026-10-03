'use strict';

const path = require('path');
const fs = require('fs');
const { resolveCampaignContext } = require('./args');
const { locateVault } = require('../vault/locate');
const { loadSiteConfig } = require('./check');
const { runBuildCommand, requireOutputFolder } = require('./build');
const { startServer: startServerImpl, startLocalListener: startLocalListenerImpl, startPanelListener: startPanelListenerImpl } = require('../serve/server');
const { runAdminServe } = require('./serve-admin');
const { EXIT_CODES } = require('../util/exitcodes');
const { onStopSignal } = require('../util/stop-signals');

/** @returns {{ value?: number, error?: string }} a whole number 0-65535, or a plain-English error */
function parsePortFlag(raw) {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) > 65535) {
    const got = typeof raw === 'string' ? ` (you gave "${raw}")` : ' (it needs a value, for example --port 8081)';
    return { error: `--port must be a whole number from 0 to 65535${got}` };
  }
  return { value: Number(raw) };
}

/*
 * Issue #25: every line used to accumulate in a local `warnings` array and
 * only printed from inside the SIGINT handler, so nothing reached stdout
 * between process start and Ctrl-C -- including the --host risk warning
 * ADR 0002 (docs/decisions/0002-serve-binds-localhost.md, section "Decision") requires
 * "before starting". Each line is now pushed through `emit` at the moment
 * it is known, and `human` carries only what has not already been emitted,
 * so nothing is ever printed twice.
 *
 * `emit`/`startServer`/`runBuild`/`signals` are options-object DI with
 * defaults bound to the already-imported symbols (precedent: discoverGh()
 * at src/update/gh.js, deliverNotices() at src/util/notices.js), so a test
 * can assert ordering on a shared log without a real socket or a listener
 * on the real `process` (which node --test shares across every test file).
 */
async function runServeCommand(
  flags,
  campaignArg,
  {
    emit = console.log,
    startServer = startServerImpl,
    runBuild = runBuildCommand,
    signals = process,
    startLocalListener = startLocalListenerImpl,
    startPanelListener = startPanelListenerImpl,
    now = Date.now,
    createToken,
    identity,
  } = {},
) {
  // Phase 8 slice S1: the very first statement, before resolveCampaignContext, so a rejected
  // --admin flag or port never reads config or applies an --out override, and plain serve below
  // is completely untouched when flags.admin is unset (Structural decision 1).
  if (flags.admin) {
    const adminOpts = { emit, signals, startLocalListener, startPanelListener, now };
    if (createToken !== undefined) adminOpts.createToken = createToken;
    if (identity !== undefined) adminOpts.identity = identity;
    return runAdminServe(flags, campaignArg, adminOpts);
  }

  // Issue #27: with --json every emitted line is one compact JSON object (NDJSON), and the final
  // result carries `envelope` so bin/scriptorium.js prints JSON, never the human text.
  const json = Boolean(flags.json);
  const say = json ? (line) => emit(JSON.stringify({ event: 'message', message: line })) : emit;

  const ctxInfo = resolveCampaignContext(flags, campaignArg);
  locateVault(ctxInfo.vault, ctxInfo.campaign);

  // QA F06 (message only; a user mistake, so the exit code stays 1, issue #108): a bad --port used to reach Node and print its
  // raw "options.port should be >= 0 and < 65536" text.
  const requestedPort = parsePortFlag(flags.port);
  if (requestedPort.error) return { exitCode: EXIT_CODES.SCRIPTORIUM_ERROR, human: requestedPort.error };

  if (flags['build']) {
    const buildResult = runBuild(flags, campaignArg);
    if (buildResult.exitCode !== EXIT_CODES.OK) {
      return buildResult;
    }
    say(buildResult.human);
  }

  const outputPath = path.resolve(requireOutputFolder(ctxInfo, 'serve'));
  if (!fs.existsSync(outputPath)) {
    return {
      // Issue #108: the campaign's output is missing, a campaign problem, so exit 3.
      exitCode: EXIT_CODES.VAULT_UNREACHABLE,
      human: `no build exists at ${outputPath}; run "gm-scriptorium build" first or pass --build`,
    };
  }

  const host = flags.host || '127.0.0.1';
  if (flags.host) {
    say(
      `WARNING: --host ${flags.host} exposes this content beyond localhost. The site may not be ` +
        'safe to share yet (see "gm-scriptorium check"). This deliberately contradicts the usual dev-server default.',
    );
  }
  const port = flags.port !== undefined ? requestedPort.value : ctxInfo.serve_port || 8080;

  try {
    const { server, port: boundPort } = await startServer(outputPath, { host, port });
    // The bound port (issue #79): differs from the requested one for --port 0. Test fakes that
    // return no port fall back to the requested one.
    const shownPort = Number.isInteger(boundPort) ? boundPort : port;
    const url = `http://${host}:${shownPort}`;

    // The stop handler is registered BEFORE the readiness line is printed: a supervisor that
    // signals the moment it reads "ready" must never beat the handler (issue #27).
    const stopped = new Promise((resolve) => {
      onStopSignal(signals, (signal) => {
        const done = () =>
          resolve({
            exitCode: EXIT_CODES.OK,
            human: 'stopped.',
            ...(json ? { envelope: { event: 'stopped', signal, exitCode: EXIT_CODES.OK } } : {}),
          });
        server.close(done);
        // Keep-alive connections would otherwise hold close() open past the stop signal.
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    });
    if (json) {
      emit(JSON.stringify({ event: 'ready', mode: 'serve', url, host, port: shownPort, output: outputPath }));
    } else {
      emit(`serving ${outputPath} at ${url} (Ctrl-C to stop)`);
    }
    return stopped;
  } catch (err) {
    return { exitCode: EXIT_CODES.SCRIPTORIUM_ERROR, human: `failed to start server: ${err.message}` };
  }
}

module.exports = { runServeCommand };
