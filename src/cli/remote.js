'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./args');
const { writeConfigFile } = require('./config');
const { setRemoteAtSignin } = require('../config/write');
const { parseDesktopTable } = require('../config/desktopsettings');
const { createSecretReader } = require('./secretprompt');
const { ConfigError, VaultUnreachableError } = require('../util/errors');
const { EXIT_CODES } = require('../util/exitcodes');
const { validatePanelPassword } = require('../setup/validate');
const settingsLib = require('../remote/settings');
const { remotePaths, assertNotInsideAnyVault } = require('../remote/paths');
const { hashPassword, verifyPassword, readPasswordRecord } = require('../remote/password');
const { MAX_ACCOUNTS, canonicalUsername, readAccounts } = require('../remote/accounts');
// Called through the module object so a test can fail one write to prove the two-step migration is safe.
const passwordwrite = require('../remote/passwordwrite');
const { createSessionStore } = require('../remote/sessions');
const { createAuditLog } = require('../remote/audit');
const { applyPanelAccess, accessWarning, accessSecretRefusal } = require('../remote/panelaccess');
const { commandHelp } = require('./help');

const TRAY_NAME = 'gm-scriptorium-tray.exe';
const TRAY_POINTER = '\nRemote access does not start when you sign in to Windows. To change that on this PC, tick "Remote access at sign-in" in the menu of the GM-Scriptorium icon in the system tray, or run "gm-scriptorium desktop set --remote-at-signin on".';

/*
 * V1.5a (docs/decisions/0029-remote-access.md section 9; SD-doc section 13): `gm-scriptorium remote
 * show | set | password | signout-all | off`. Every remote-access change is made here, and it all
 * works over SSH on a machine with no screen. This is the ONLY module that writes the passwords and
 * the remote settings; the panel's own module graph never reaches it (test/remote-structure.test.js).
 *
 * ADR 0054: named accounts. `remote account add | change | reset | remove | rename | list` manages
 * panel/accounts.json, and the older `remote password` stays as an alias for the account "gm".
 * Migration writes nothing on read. The first write here materialises an earlier password.json as
 * the account "gm" in accounts.json and then clears password.json; accounts.json always wins, so a
 * failure between the two steps is harmless.
 *
 * Secrets: a password is read only from a hidden terminal prompt or from stdin, never from argv
 * or the environment. `show` and `account list` print no secret, ever.
 */

const SUBCOMMANDS = ['show', 'set', 'account', 'password', 'signout-all', 'off'];
const ACCOUNT_VERBS = ['add', 'change', 'reset', 'remove', 'rename', 'list'];
const NAME_RULE = 'account names are 1 to 32 letters, digits, dots, hyphens or underscores, starting with a letter or digit';
const NEVER_AS_ARGUMENT = 'passwords are asked for, never given as arguments';
const SET_FLAGS = ['mode', 'admin-url', 'preview-url', 'bind', 'trusted-proxy', 'port', 'preview-port'];
const ALLOWED_FLAGS = { show: ['config'], set: ['config', ...SET_FLAGS], account: ['config'], password: ['config'], 'signout-all': ['config', 'account'], off: ['config'] };

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
  if (sub !== 'account' && args.length > 0) throw new ConfigError(`remote ${sub} takes no arguments`);
}

function loadSettings(flags) {
  const loaded = loadConfig(flags);
  const settings = settingsLib.parseRemoteTable(loaded.config.remote);
  return { ...loaded, settings, paths: remotePaths(loaded.configPath) };
}

/**
 * A config folder inside a vault is a config problem, so it exits 3 like the other config and vault
 * refusals (docs/DEVELOPING.md, "Exit codes for user errors"). Same message, different class.
 */
function assertPanelOutsideVaults(panelDir, config) {
  try {
    assertNotInsideAnyVault(panelDir, config);
  } catch (err) {
    if (err instanceof ConfigError) throw new VaultUnreachableError(err.message, { path: panelDir, campaign: null, reason: 'bad-config' });
    throw err;
  }
}

function sessionsOf(paths, now) {
  const store = createSessionStore({ file: paths.sessionsFile, now });
  store.load();
  return store;
}

/**
 * ADR 0056: before the first write into the panel folder, set its access list (Windows only; a
 * no-op elsewhere and inside a vault). Called after prompts and hashing, so a cancelled prompt
 * creates nothing. A command that is about to save a password or its hash refuses when the list
 * cannot be set (nothing is written); every other writing command warns and carries on, so
 * `remote off` stays a way out.
 *
 * @param {{ refuse?: boolean }} [opts]
 * @returns {Promise<string>} a warning line (with its newline) to append to the output, or ''
 */
async function securePanel(paths, config, panelAccess, { refuse = false } = {}) {
  let insideVault = false;
  try {
    assertNotInsideAnyVault(paths.panelDir, config);
  } catch {
    insideVault = true;
  }
  const access = await applyPanelAccess(
    paths,
    { insideVault, platform: panelAccess.platform || process.platform, env: panelAccess.env || {} },
    { run: panelAccess.run },
  );
  if (access.state !== 'failed') return '';
  if (refuse) throw new ConfigError(accessSecretRefusal(paths.panelDir, access.reason));
  return '\n' + accessWarning(paths.panelDir, access.reason);
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

/** 2026-10-01T12:00:00.000Z -> "2026-10-01 12:00 UTC" (minutes are plenty for "when was it set"). */
function humanDate(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : String(iso);
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
  const accts = readAccounts(paths);
  if (accts.state === 'set') lines.push(`accounts: ${accts.accounts.length} (${accts.accounts.map((a) => a.name).join(', ')})`);
  else if (accts.state === 'invalid') lines.push(`accounts: not usable (${accts.message})`);
  else lines.push('accounts: none');
  lines.push(`remote sessions: ${sessionsOf(paths, now).activeCount()} signed in`);
  const problems = settingsLib.readiness(settings, { accounts: accts.state, tlsSupported: false });
  lines.push(problems.length === 0 ? 'ready: yes' : `not ready: ${problems[0]}`);
  lines.push(`files: ${paths.panelDir}`);
  return lines.join('\n');
}

function cancelled() {
  return new ConfigError('cancelled; nothing changed');
}

/** One new password, asked for twice on a terminal. @returns {Promise<string>} the validated (NFC) password */
async function askNewPassword(reader, prompt) {
  const first = await reader.read(prompt);
  if (first === null) throw cancelled();
  if (reader.isTTY) {
    const again = await reader.read('Type it again: ');
    if (again === null) throw cancelled();
    if (again !== first) throw new ConfigError('the two passwords do not match; nothing changed');
  }
  return validatePanelPassword(first);
}

/** The current password of `entry`, asked for and checked. */
async function confirmCurrent(reader, prompt, entry, refusal) {
  const current = await reader.read(prompt);
  if (current === null) throw cancelled();
  if (!(await verifyPassword(current, entry.record))) throw new ConfigError(refusal);
}

/**
 * The accounts to change: an empty list when none are set (or after `remote off`), the list when
 * there are some (an earlier password.json reads as the one account "gm"), and a refusal with a
 * way out when the saved file cannot be used.
 *
 * @returns {{ list: { name: string, record: object, fromEarlierPassword: boolean }[] }}
 */
function loadAccountsForWrite(paths) {
  const state = readAccounts(paths);
  if (state.state === 'invalid') {
    // A broken accounts.json is reported as accounts; a broken password.json (no accounts.json yet) keeps its older wording.
    if (!fs.existsSync(paths.accountsFile)) {
      throw new ConfigError(`the panel password file cannot be used (${state.message}); run "gm-scriptorium remote off" and set a new password`);
    }
    throw new ConfigError(`the saved accounts cannot be used (${state.message}); run "gm-scriptorium remote off" and add the accounts again`);
  }
  return { list: state.state === 'set' ? state.accounts.map((a) => ({ ...a })) : [] };
}

/**
 * Writes accounts.json, then (migration) clears an earlier password.json that still holds a hash.
 * The second step is best effort: accounts.json already wins, so a failure there leaves a stale but
 * inert file, and the change itself has still happened.
 *
 * @returns {string} a warning line (with its newline), or ''
 */
function saveAccounts(paths, list, now) {
  passwordwrite.writeAccounts(paths.accountsFile, list);
  try {
    if (readPasswordRecord(paths.passwordFile).state === 'set') passwordwrite.clearPasswordRecord(paths.passwordFile, { now });
  } catch {
    return `\nwarning: could not clear the earlier password file at ${paths.passwordFile}`;
  }
  return '';
}

function requireName(raw) {
  const name = canonicalUsername(raw);
  if (name === null) throw new ConfigError(NAME_RULE);
  return name;
}

function requireExisting(list, name) {
  const found = list.find((a) => a.name === name);
  if (!found) throw new ConfigError(`no account named "${name}"`);
  return found;
}

function accountArity(verb, args) {
  const rest = args.slice(1);
  if (verb === 'list') {
    if (rest.length > 0) throw new ConfigError('remote account list takes no arguments');
  } else if (verb === 'rename') {
    if (rest.length < 2) throw new ConfigError('remote account rename needs the old name and the new name');
    if (rest.length > 2) throw new ConfigError(`remote account rename takes just two names; ${NEVER_AS_ARGUMENT}`);
  } else {
    if (rest.length < 1) throw new ConfigError(`remote account ${verb} needs an account name`);
    if (rest.length > 1) throw new ConfigError(`remote account ${verb} takes just an account name; ${NEVER_AS_ARGUMENT}`);
  }
  return rest;
}

async function runAccount(args, paths, config, { stdin, stdout, now, panelAccess }) {
  const [verb] = args;
  if (!ACCOUNT_VERBS.includes(verb)) {
    throw new ConfigError('usage: gm-scriptorium remote account add <name> | change <name> | reset <name> | remove <name> | rename <old> <new> | list');
  }
  const rest = accountArity(verb, args);

  if (verb === 'list') {
    const state = readAccounts(paths);
    if (state.state === 'invalid') {
      throw new ConfigError(`the saved accounts cannot be used (${state.message}); run "gm-scriptorium remote off" and add the accounts again`);
    }
    if (state.state !== 'set') return { exitCode: EXIT_CODES.OK, human: 'no accounts' };
    const lines = state.accounts.map((a) => `${a.name}  set ${humanDate(a.record.setAt)}${a.fromEarlierPassword ? '  (from your earlier password)' : ''}`);
    return { exitCode: EXIT_CODES.OK, human: lines.join('\n') };
  }

  assertPanelOutsideVaults(paths.panelDir, config);
  const name = requireName(rest[0]);
  const { list } = loadAccountsForWrite(paths);
  const sessions = () => sessionsOf(paths, now);

  if (verb === 'add') {
    if (list.some((a) => a.name === name)) throw new ConfigError(`an account named "${name}" already exists`);
    if (list.length >= MAX_ACCOUNTS) throw new ConfigError(`there can be at most ${MAX_ACCOUNTS} accounts`);
    const reader = createSecretReader({ input: stdin, output: stdout });
    let chosen;
    try {
      chosen = await askNewPassword(reader, `New password for ${name}: `);
    } finally {
      reader.close();
    }
    const record = await hashPassword(chosen, { now });
    await securePanel(paths, config, panelAccess, { refuse: true });
    const warning = saveAccounts(paths, [...list, { name, record, fromEarlierPassword: false }], now);
    const audit = auditCli(paths, now, { event: 'account-add', account: name });
    return { exitCode: EXIT_CODES.OK, human: `account "${name}" added.${warning}${audit}` };
  }

  if (verb === 'change' || verb === 'reset') {
    const entry = requireExisting(list, name);
    const reader = createSecretReader({ input: stdin, output: stdout });
    let chosen;
    try {
      if (verb === 'change') await confirmCurrent(reader, `Current password for ${name}: `, entry, `that is not the current password for "${name}"; nothing changed`);
      chosen = await askNewPassword(reader, `New password for ${name}: `);
    } finally {
      reader.close();
    }
    const record = await hashPassword(chosen, { now });
    await securePanel(paths, config, panelAccess, { refuse: true });
    const warning = saveAccounts(paths, list.map((a) => (a.name === name ? { name, record, fromEarlierPassword: false } : a)), now);
    sessions().revokeAccount(name);
    const audit = auditCli(paths, now, { event: `account-${verb}`, account: name });
    return { exitCode: EXIT_CODES.OK, human: `password for "${name}" ${verb === 'change' ? 'changed' : 'reset'}. Its remote devices are signed out.${warning}${audit}` };
  }

  if (verb === 'remove') {
    requireExisting(list, name);
    const loose = await securePanel(paths, config, panelAccess);
    const warning = saveAccounts(paths, list.filter((a) => a.name !== name), now);
    sessions().revokeAccount(name);
    const audit = auditCli(paths, now, { event: 'account-remove', account: name });
    return { exitCode: EXIT_CODES.OK, human: `account "${name}" removed. Its remote devices are signed out.${warning}${audit}${loose}` };
  }

  // rename
  requireExisting(list, name);
  const next = requireName(rest[1]);
  if (list.some((a) => a.name === next)) throw new ConfigError(`an account named "${next}" already exists`);
  const loose = await securePanel(paths, config, panelAccess);
  const warning = saveAccounts(paths, list.map((a) => (a.name === name ? { ...a, name: next } : a)), now);
  sessions().revokeAccount(name);
  const audit = auditCli(paths, now, { event: 'account-rename', account: next, affected: name });
  return { exitCode: EXIT_CODES.OK, human: `account "${name}" renamed to "${next}". Its remote devices are signed out.${warning}${audit}${loose}` };
}

/**
 * Whether the tray helper sits beside this program: a Windows copy with the tray app installed. The Run value
 * itself lives in the registry, which the program cannot read without adding a program to the spawner's list
 * (ADR 0046).
 */
function defaultRunValuePresent({ platform = process.platform, execPath = process.execPath } = {}) {
  return platform === 'win32' && fs.existsSync(path.win32.join(path.win32.dirname(execPath), TRAY_NAME));
}

/**
 * ADR 0057, section 7 ("Turning it on and off from the tray"). `remote set` never asks. A change to a different
 * remote mode clears remote access at sign-in (both keys, through the one writer) and, when the tray helper sits
 * beside the program, says where the tray item is. Any other change leaves the setting alone.
 *
 * @returns {{ config: object, note: string }}
 */
function applySigninChoice({ config, previous, parsed, runValuePresent }) {
  if (parsed.mode === 'local' || parsed.mode === previous.mode) return { config, note: '' };
  const note = runValuePresent() ? TRAY_POINTER : '';
  try {
    const saved = parseDesktopTable(config.desktop);
    const hadAnswer = saved.remoteAtSignin || (config.desktop !== undefined && config.desktop.remote_at_signin_pc !== undefined);
    if (!hadAnswer) return { config, note };
    return { config: setRemoteAtSignin(config, false), note };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { config, note: `${note}\nwarning: the [desktop] settings could not be read, so remote access at sign-in was left as it was` };
  }
}

/**
 * @param {object} flags parsed argv flags
 * @param {string|undefined} subcommand
 * @param {string[]} args positional arguments after the subcommand
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, now?: () => number, panelAccess?: { platform?: string, env?: object, run?: Function }, runValuePresent?: () => boolean }} [deps]
 * @returns {Promise<{ exitCode: number, human: string }>}
 */
async function runRemoteCommand(
  flags,
  subcommand,
  args = [],
  { stdin = process.stdin, stdout = process.stdout, now = Date.now, panelAccess = {}, runValuePresent = defaultRunValuePresent } = {},
) {
  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new ConfigError(`usage: gm-scriptorium remote ${SUBCOMMANDS.join(' | ')}`);
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
      const signin = applySigninChoice({ config: { ...config, remote: next }, previous: settings, parsed, runValuePresent });
      writeConfigFile(configPath, signin.config);
      const loose = changed.length > 0 ? await securePanel(paths, config, panelAccess) : '';
      const warning = changed.length > 0 ? auditCli(paths, now, { event: 'settings-change', changed, mode: parsed.mode }) : '';
      return {
        exitCode: EXIT_CODES.OK,
        human: `${summary(parsed, paths, now)}\nchanges take effect the next time serve --admin starts${signin.note}${warning}${loose}`,
      };
    }

    case 'account':
      return runAccount(args, paths, config, { stdin, stdout, now, panelAccess });

    case 'password': {
      // The compatibility alias: it sets the password of the account "gm" (adding it when it is not
      // there), with the prompts and the message it always had, and it signs EVERY device out.
      assertPanelOutsideVaults(paths.panelDir, config);
      const { list } = loadAccountsForWrite(paths);
      const gm = list.find((a) => a.name === 'gm');
      if (!gm && list.length >= MAX_ACCOUNTS) throw new ConfigError(`there can be at most ${MAX_ACCOUNTS} accounts`);
      const reader = createSecretReader({ input: stdin, output: stdout });
      let chosen;
      try {
        if (gm) await confirmCurrent(reader, 'Current panel password: ', gm, 'that is not the current panel password; nothing changed');
        chosen = await askNewPassword(reader, 'New panel password: ');
      } finally {
        reader.close();
      }
      const record = await hashPassword(chosen, { now });
      await securePanel(paths, config, panelAccess, { refuse: true });
      const entry = { name: 'gm', record, fromEarlierPassword: false };
      const saved = saveAccounts(paths, gm ? list.map((a) => (a.name === 'gm' ? entry : a)) : [...list, entry], now);
      sessionsOf(paths, now).revokeAll();
      const warning = auditCli(paths, now, { event: gm ? 'password-change' : 'password-set', account: 'gm' });
      return { exitCode: EXIT_CODES.OK, human: `panel password set. Every remote device is signed out.${saved}${warning}` };
    }

    case 'signout-all': {
      assertPanelOutsideVaults(paths.panelDir, config);
      if (flags.account !== undefined) {
        const name = requireName(flags.account);
        const state = readAccounts(paths);
        requireExisting(state.state === 'set' ? state.accounts : [], name);
        const loose = await securePanel(paths, config, panelAccess);
        const { count } = sessionsOf(paths, now).revokeAccount(name);
        const warning = auditCli(paths, now, { event: 'signout-all', count, account: name });
        return { exitCode: EXIT_CODES.OK, human: `signed out ${count} remote session(s) for "${name}"${warning}${loose}` };
      }
      const loose = await securePanel(paths, config, panelAccess);
      const { count } = sessionsOf(paths, now).revokeAll();
      const warning = auditCli(paths, now, { event: 'signout-all', count });
      return { exitCode: EXIT_CODES.OK, human: `signed out ${count} remote session(s)${warning}${loose}` };
    }

    case 'off': {
      assertPanelOutsideVaults(paths.panelDir, config);
      // ADR 0057, section 7: turning remote access off also clears the sign-in confirmation. A [desktop] table
      // that cannot be read is left alone, so this stays a way out.
      let offConfig = config.remote !== undefined ? { ...config, remote: { ...config.remote, mode: 'local' } } : config;
      try {
        const saved = parseDesktopTable(config.desktop);
        if (saved.remoteAtSignin || (config.desktop && config.desktop.remote_at_signin_pc !== undefined)) offConfig = setRemoteAtSignin(offConfig, false);
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
      }
      if (offConfig !== config) writeConfigFile(configPath, offConfig);
      const loose = await securePanel(paths, config, panelAccess);
      sessionsOf(paths, now).revokeAll();
      if (fs.existsSync(paths.accountsFile)) passwordwrite.clearAccounts(paths.accountsFile, { now });
      if (readPasswordRecord(paths.passwordFile).state !== 'unset') passwordwrite.clearPasswordRecord(paths.passwordFile, { now });
      const warning = auditCli(paths, now, { event: 'remote-off' });
      return {
        exitCode: EXIT_CODES.OK,
        human: `remote access is off. A running serve --admin refuses remote sign-in now and stops listening remotely when restarted.${warning}${loose}`,
      };
    }

    default:
      throw new ConfigError(`unknown remote subcommand: ${subcommand}`);
  }
}

/** @param {string} [sub] @returns {string} the help for one subcommand, or for all of them */
function remoteHelp(sub) {
  return commandHelp('remote', sub).replace(/\n$/, '');
}

module.exports = { runRemoteCommand, remoteHelp, MODE_LABEL, SUBCOMMANDS, ACCOUNT_VERBS, ALLOWED_FLAGS };
