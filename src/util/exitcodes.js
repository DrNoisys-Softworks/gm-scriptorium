'use strict';

/*
 * The exit-code table. Frozen in phase 1 because every command built in
 * phase 2 and 3 reports through this, and a code changing meaning later
 * would silently break anything (a script, Claude, a CI job) consuming
 * Scriptorium's exit status.
 *
 * 0  clean, or warnings only
 * 1  Scriptorium itself failed (a bug, an unexpected exception), not a
 *    finding about the vault. Also a plain user mistake that is not about the
 *    config, campaign or vault (unknown command or flag, bad --port, port in
 *    use, init aborted), always with a plain message and no stack trace
 * 2  one or more ERROR-severity findings; check refused, or build refused
 *    and wrote nothing
 * 3  vault unreachable, or reachable but not a vault (the exit-3 taxonomy
 *    lives in src/vault/locate.js, phase 2; this module only names the code).
 *    Issue #108: also the code for a problem with the config or the campaign
 *    (none registered, unknown name, missing or malformed config file, output
 *    folder missing or inside the vault), thrown as a VaultUnreachableError.
 *    The user-mistake table is in docs/DEVELOPING.md, "Exit codes".
 * 4  update prerequisites not met (gh absent or unauthenticated, or a
 *    404 from the release lookup that is indistinguishable from "no such release")
 */

const EXIT_CODES = Object.freeze({
  OK: 0,
  SCRIPTORIUM_ERROR: 1,
  CHECK_FAILED: 2,
  VAULT_UNREACHABLE: 3,
  UPDATE_PREREQUISITE: 4,
});

const EXIT_CODE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(EXIT_CODES).map(([name, code]) => [code, name])),
);

function nameForExitCode(code) {
  return EXIT_CODE_NAMES[code] || `UNKNOWN(${code})`;
}

module.exports = { EXIT_CODES, nameForExitCode };
