'use strict';

const { ensurePrivateDir } = require('./privatefile');
const procRun = require('../proc/run');

/*
 * ADR 0056 (an owner-only access list on the panel folder on Windows). On Windows the panel folder
 * used to take whatever list its parent handed down, so outside the user profile it could be
 * readable by every signed-in user. This module makes sure the folder exists and then, through the
 * one spawner (src/proc/run.js, ADR 0046), runs %SystemRoot%\System32\icacls.exe once to remove the
 * inherited entries and grant exactly three: the account running the program, SYSTEM and
 * Administrators, each passed down to everything inside.
 *
 * It is called from exactly two places: the panel start (src/cli/serve-admin.js) and the writing
 * `remote` commands (src/cli/remote.js). It is a no-op off Windows, and a no-op for a folder inside
 * a vault (the existing audit refusal stands). It never rejects: a failure comes back as a result,
 * and the caller decides (refuse, or warn).
 *
 * This file never reads the process environment itself (test/remote-structure.test.js, constraint
 * (e)); the caller passes `env` in. V1.5b's tls folder must reuse applyPanelAccess.
 *
 * What it does not do (the list is in ADR 0056, "Will not catch"): it removes inherited entries
 * and grants the three, but it does not remove an explicit entry already on the folder or on a file
 * in it, and it does not read icacls' output.
 */

const ICACLS_TIMEOUT_MS = 30000;

const PART_RE = /^[^\\/:*?"<>|[\];=,+\x00-\x1f]{1,256}$/;

/**
 * DOMAIN\user from the environment the caller passed in, or null when either part is missing or
 * holds a character that could change what icacls reads.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function ownerPrincipal(env) {
  if (env === null || typeof env !== 'object') return null;
  const domain = env.USERDOMAIN;
  const user = env.USERNAME;
  if (typeof domain !== 'string' || typeof user !== 'string') return null;
  if (!PART_RE.test(domain) || !PART_RE.test(user)) return null;
  return `${domain}\\${user}`;
}

/**
 * @param {string} panelDir
 * @param {string} owner  DOMAIN\user
 * @returns {string[]}
 */
function icaclsArgs(panelDir, owner) {
  return [panelDir, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q'];
}

/**
 * @param {{ panelDir: string }} paths
 * @param {{ insideVault: boolean, platform: string, env: object }} ctx
 * @param {{ run?: Function }} [deps]  tests only
 * @returns {Promise<{ state: 'posix'|'inside-vault'|'applied'|'failed', reason: string|null }>}
 */
async function applyPanelAccess(paths, { insideVault, platform, env }, deps = {}) {
  try {
    if (platform !== 'win32') return { state: 'posix', reason: null };
    if (insideVault) return { state: 'inside-vault', reason: null };

    const owner = ownerPrincipal(env);
    if (owner === null) return { state: 'failed', reason: 'the account name could not be read' };

    try {
      ensurePrivateDir(paths.panelDir);
    } catch (err) {
      const code = err && typeof err.code === 'string' ? err.code : 'not a real folder';
      return { state: 'failed', reason: `the folder could not be prepared (${code})` };
    }

    const runFn = deps.run || procRun.run;
    let result;
    try {
      result = await runFn({ command: 'icacls', args: icaclsArgs(paths.panelDir, owner), env: { ...env }, timeoutMs: ICACLS_TIMEOUT_MS });
    } catch (err) {
      const code = err && typeof err.code === 'string' ? err.code : 'unknown';
      return { state: 'failed', reason: `icacls could not be run (${code})` };
    }
    if (result && result.timedOut) return { state: 'failed', reason: 'icacls timed out' };
    if (!result || result.exitCode !== 0) return { state: 'failed', reason: `icacls exited ${result ? result.exitCode : 'null'}` };
    return { state: 'applied', reason: null };
  } catch {
    // Never reject: anything unforeseen is a failed result, so the caller's refuse-or-warn rule holds.
    return { state: 'failed', reason: 'icacls could not be run (unknown)' };
  }
}

/** The one warning line (local mode console, and the CLI). */
function accessWarning(panelDir, reason) {
  return `warning: ${panelDir} could not be limited to your account, SYSTEM and Administrators (${reason}); remote access will refuse to start until it can`;
}

/** The refusal for a non-local mode. */
function accessRefusal(mode, panelDir, reason) {
  return `remote access (mode ${mode}) needs ${panelDir} limited to your account, SYSTEM and Administrators, and that could not be done (${reason}); nothing was started`;
}

/** The refusal for a CLI command that would save a password or its hash. */
function accessSecretRefusal(panelDir, reason) {
  return `remote access needs ${panelDir} limited to your account, SYSTEM and Administrators before a password is saved there, and that could not be done (${reason}); no password was saved`;
}

module.exports = { ICACLS_TIMEOUT_MS, ownerPrincipal, icaclsArgs, applyPanelAccess, accessWarning, accessRefusal, accessSecretRefusal };
