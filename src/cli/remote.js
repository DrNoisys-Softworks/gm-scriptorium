'use strict';

const { loadConfig } = require('./args');
const { writeConfigFile } = require('./config');
const { createSecretReader } = require('./secretprompt');
const { ConfigError } = require('../util/errors');
const { EXIT_CODES } = require('../util/exitcodes');
const { validatePanelPassword } = require('../setup/validate');
const settingsLib = require('../remote/settings');
const { remotePaths, assertNotInsideAnyVault } = require('../remote/paths');
const { hashPassword, verifyPassword, readPasswordRecord } = require('../remote/password');
const { writePasswordRecord, clearPasswordRecord } = require('../remote/passwordwrite');
const { createSessionStore } = require('../remote/sessions');
const { createAuditLog } = require('../remote/audit');

/*
 * V1.5a (docs/decisions/0029-remote-access.md section 9; SD-doc section 13): `scriptorium remote
 * show | set | password | signout-all | off`. Every remote-access change is made here, and it all
 * works over SSH on a machine with no screen. This is the ONLY module that writes the password and
 * the remote settings; the panel's own module graph never reaches it (test/remote-structure.test.js).
 *
 * Secrets: the password is read only from a hidden terminal prompt or from stdin, never from argv
 * or the environment. `show` prints no secret, ever.
 */

const SUBCOMMANDS = ['show', 'set', 'password', 'signout-all', 'off'];
const SET_FLAGS = ['mode', 'admin-url', 'preview-url', 'bind', 'trusted-proxy', 'port', 'preview-port'];
const ALLOWED_FLAGS = { show: ['config'], set: ['config', ...SET_FLAGS], password: ['config'], 'signout-all': ['config'], off: ['config'] };

const MODE_LABEL = {
  local: 'This computer only',
  ssh: 'SSH tunnel',
  tailscale: 'Over Tailscale',
  proxy: 'Behind your reverse proxy',
  direct: 'Direct, own certificate',
};

function checkFlags(sub, flags, args) {
  for (const key of Object.keys(flags)) {
    if (!ALLOWED_FLAGS[sub].includes(key)) throw new ConfigError(`remote ${sub} does not accept --${key}`);
  }
  if (args.length > 0) throw new ConfigError(`remote ${sub} takes no arguments`);
}

function loadSettings(flags) {
  const loaded = loadConfig(flags);
  const settings = settingsLib.parseRemoteTable(loaded.config.remote);
  return { ...loaded, settings, paths: remotePaths(loaded.configPath) };
}

function sessionsOf(paths, now) {
  const store = createSessionStore({ file: paths.sessionsFile, now });
  store.load();
  return store;
}

/** Best-effort audit entry; returns a warning line when the log could not be written. */
function auditCli(paths, now, entry) {
  try {
    createAuditLog({ file: paths.auditFile, now }).append({ by: 'cli', ...entry });
    return '';
  } catch {
    return `\nwarning: could not write the audit log at ${paths.auditFile}`;
  }
}

function httpsLine(settings) {
  switch (settings.mode) {
    case 'ssh':
      return 'https: by SSH (the tunnel encrypts the traffic)';
    case 'tailscale':
      return 'https: by tailscale serve';
    case 'proxy':
      return `https: by your proxy (the hop to GM-Scriptorium is ${(settings.tls || 'off') === 'off' ? 'plain HTTP' : 'encrypted'})`;
    case 'direct':
      return 'https: by GM-Scriptorium itself';
    default:
      return 'https: not needed on this computer';
  }
}

function summary(settings, paths, now) {
  const lines = [`mode: ${settings.mode} (${MODE_LABEL[settings.mode]})`];
  const remoteMode = ['tailscale', 'proxy', 'direct'].includes(settings.mode);
  if (remoteMode) {
    lines.push(`admin address: ${settings.admin_url || 'not set'}`);
    lines.push(`preview address: ${settings.preview_url || 'not set'}`);
  }
  if (settings.mode !== 'local') {
    const plan = settingsLib.listenPlan(settings);
    const hosts = settings.port !== undefined && settings.preview_port !== undefined ? plan.admin.hosts : null;
    lines.push(
      hosts
        ? `listening: ${hosts.join(' and ')}, ports ${settings.port} (panel) and ${settings.preview_port} (preview)`
        : 'listening: not set (needs fixed ports)',
    );
  }
  if (settings.mode === 'proxy') lines.push(`trusted proxy: ${(settings.trusted_proxies || []).join(', ') || 'not set'}`);
  lines.push(httpsLine(settings));
  const pwd = readPasswordRecord(paths.passwordFile);
  lines.push(`password: ${pwd.state === 'set' ? `set ${pwd.record.setAt}` : 'not set'}`);
  lines.push(`remote sessions: ${sessionsOf(paths, now).activeCount()} signed in`);
  const problems = settingsLib.readiness(settings, { password: pwd.state, tlsSupported: false });
  lines.push(problems.length === 0 ? 'ready: yes' : `not ready: ${problems[0]}`);
  lines.push(`files: ${paths.panelDir}`);
  return lines.join('\n');
}

async function readNewPassword(reader, paths, config, now) {
  const state = readPasswordRecord(paths.passwordFile);
  if (state.state === 'invalid') {
    throw new ConfigError(`the panel password file cannot be used (${state.message}); run "scriptorium remote off" and set a new password`);
  }
  if (state.state === 'set') {
    const current = await reader.read('Current panel password: ');
    if (current === null) throw new ConfigError('cancelled; nothing changed');
    if (!(await verifyPassword(current, state.record))) {
      throw new ConfigError('that is not the current panel password; nothing changed');
    }
  }
  const first = await reader.read('New panel password: ');
  if (first === null) throw new ConfigError('cancelled; nothing changed');
  if (reader.isTTY) {
    const again = await reader.read('Type it again: ');
    if (again === null) throw new ConfigError('cancelled; nothing changed');
    if (again !== first) throw new ConfigError('the two passwords do not match; nothing changed');
  }
  const validated = validatePanelPassword(first);
  return { validated, wasSet: state.state === 'set' };
}

/**
 * @param {object} flags parsed argv flags
 * @param {string|undefined} subcommand
 * @param {string[]} args positional arguments after the subcommand
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, now?: () => number }} [deps]
 * @returns {Promise<{ exitCode: number, human: string }>}
 */
async function runRemoteCommand(flags, subcommand, args = [], { stdin = process.stdin, stdout = process.stdout, now = Date.now } = {}) {
  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new ConfigError(`usage: scriptorium remote ${SUBCOMMANDS.join(' | ')}`);
  }
  checkFlags(subcommand, flags, args);
  const { configPath, config, settings, paths } = loadSettings(flags);

  switch (subcommand) {
    case 'show':
      return { exitCode: EXIT_CODES.OK, human: summary(settings, paths, now) };

    case 'set': {
      if (!SET_FLAGS.some((f) => flags[f] !== undefined)) {
        throw new ConfigError(`remote set: nothing to change; pass at least one of ${SET_FLAGS.map((f) => `--${f}`).join(', ')}`);
      }
      const { next, changed } = settingsLib.applyRemoteChange(config.remote, flags);
      const parsed = settingsLib.parseRemoteTable(next);
      writeConfigFile(configPath, { ...config, remote: next });
      const warning = changed.length > 0 ? auditCli(paths, now, { event: 'settings-change', changed, mode: parsed.mode }) : '';
      return {
        exitCode: EXIT_CODES.OK,
        human: `${summary(parsed, paths, now)}\nchanges take effect the next time serve --admin starts${warning}`,
      };
    }

    case 'password': {
      assertNotInsideAnyVault(paths.panelDir, config);
      const reader = createSecretReader({ input: stdin, output: stdout });
      let chosen;
      try {
        chosen = await readNewPassword(reader, paths, config, now);
      } finally {
        reader.close();
      }
      const record = await hashPassword(chosen.validated, { now });
      writePasswordRecord(paths.passwordFile, record);
      sessionsOf(paths, now).revokeAll();
      const warning = auditCli(paths, now, { event: chosen.wasSet ? 'password-change' : 'password-set' });
      return { exitCode: EXIT_CODES.OK, human: `panel password set. Every remote device is signed out.${warning}` };
    }

    case 'signout-all': {
      assertNotInsideAnyVault(paths.panelDir, config);
      const { count } = sessionsOf(paths, now).revokeAll();
      const warning = auditCli(paths, now, { event: 'signout-all', count });
      return { exitCode: EXIT_CODES.OK, human: `signed out ${count} remote session(s)${warning}` };
    }

    case 'off': {
      assertNotInsideAnyVault(paths.panelDir, config);
      if (config.remote !== undefined) writeConfigFile(configPath, { ...config, remote: { ...config.remote, mode: 'local' } });
      sessionsOf(paths, now).revokeAll();
      if (readPasswordRecord(paths.passwordFile).state !== 'unset') clearPasswordRecord(paths.passwordFile, { now });
      const warning = auditCli(paths, now, { event: 'remote-off' });
      return {
        exitCode: EXIT_CODES.OK,
        human: `remote access is off. A running serve --admin refuses remote sign-in now and stops listening remotely when restarted.${warning}`,
      };
    }

    default:
      throw new ConfigError(`unknown remote subcommand: ${subcommand}`);
  }
}

module.exports = { runRemoteCommand, MODE_LABEL };
