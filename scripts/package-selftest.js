'use strict';

/*
 * The "does the produced pipeline actually start" gate that was missing (Track: Windows
 * startup defect fix, docs/decisions/0010-no-bytecode-packaging.md). scripts/package.js's
 * other gates (scripts/pkg-assets.js, scripts/content-markers.js) inspect the artefact --
 * its --debug log, its bytes -- but neither of them ever ran it. That is exactly how three
 * releases in a row (v0.1.0, v0.1.1, v0.2.0) shipped a Windows exe that threw inside pkg's
 * own bootstrap before a single line of Scriptorium code ran.
 *
 * What is actually achievable from this Linux build host: a win-x64 binary cannot be
 * executed here at all (no wine; docs/decisions/0001-packager.md, "Evidence: Half B"). What
 * CAN be proven is that the exact same invocation (scripts/package.js's buildInvocation(),
 * same pkg flags, same pkg.patches) produces something that starts on THIS host, by running
 * (or, if the shipped target isn't for this host, building a throwaway) a node22-linux-x64
 * exe and running `--version` on it. That proves the build PIPELINE is sound: the flags are
 * accepted, pkg.patches still applies, the packed snapshot is well-formed enough for pkg's
 * own bootstrap to load and hand off into bin/scriptorium.js's CLI dispatch. It proves
 * NOTHING about win-x64 specifically -- a Windows-only failure (wrong base binary, a
 * Windows-only code path, an antivirus quarantine, anything platform-specific) would sail
 * straight through this guard undetected. That gap is real and stays open until an actual
 * Windows build/test host exists (docs/decisions/0001-packager.md's F1 fallback-ladder
 * rejected Windows CI on cost; unchanged here). This module closes the pipeline-level blind
 * spot cheaply; it does not, and cannot, close the platform-level one.
 */

const { execFileSync } = require('child_process');

const HOST_TARGET = process.platform === 'linux' && process.arch === 'x64' ? 'node22-linux-x64' : null;

/**
 * Decides how (or whether) a startup self-test can run, for the target/out about to be
 * shipped, on this host. Pure: no filesystem or process calls, so it is unit-testable
 * without ever invoking pkg.
 *
 * @param {{ target: string, outPath: string, hostTarget?: string|null }} opts
 *   hostTarget defaults to this process's own host (linux-x64 -> 'node22-linux-x64',
 *   anything else -> null); overridable so tests can exercise every branch on any host.
 * @returns {
 *   { mode: 'direct', binPath: string, detail: string } |
 *   { mode: 'proxy-build', buildTarget: string, detail: string } |
 *   { mode: 'unavailable', detail: string }
 * }
 */
function planSelfTest({ target, outPath, hostTarget = HOST_TARGET }) {
  if (!hostTarget) {
    return {
      mode: 'unavailable',
      detail: 'this build host is not linux-x64; no executable this pipeline produces can be run here at all',
    };
  }
  if (target === hostTarget) {
    return {
      mode: 'direct',
      binPath: outPath,
      detail: `the requested target (${target}) matches this build host; running the shipped artefact directly`,
    };
  }
  return {
    mode: 'proxy-build',
    buildTarget: hostTarget,
    detail:
      `${target} cannot be executed on this Linux host; building a throwaway ${hostTarget} exe from the ` +
      'identical invocation to prove the pipeline (flags, pkg.patches) produces a runnable artefact -- ' +
      `this does NOT prove ${target} itself starts`,
  };
}

/**
 * Runs `<binPath> --version` and reports pass/fail. Never throws; a failure to spawn, a
 * non-zero exit, or a timeout all come back as { ok: false, detail }.
 *
 * @param {string} binPath
 * @returns {{ ok: boolean, detail: string }}
 */
function execVersionProbe(binPath) {
  try {
    const out = execFileSync(binPath, ['--version'], { encoding: 'utf8', timeout: 30000 });
    return { ok: true, detail: `--version exited 0: ${out.trim().split('\n')[0]}` };
  } catch (err) {
    const parts = [err.message, err.stdout ? `stdout: ${err.stdout}` : null, err.stderr ? `stderr: ${err.stderr}` : null].filter(
      Boolean,
    );
    return { ok: false, detail: parts.join('\n') };
  }
}

module.exports = { HOST_TARGET, planSelfTest, execVersionProbe };
