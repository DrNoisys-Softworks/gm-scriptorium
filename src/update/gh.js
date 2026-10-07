'use strict';

const { spawnSync } = require('child_process');
const { UpdatePrerequisiteError } = require('../util/errors');

/*
 * `update` is the only command that touches the network, and it does so
 * exclusively by shelling out to the `gh` CLI (Engineering Brief section
 * 6): Scriptorium itself makes zero network calls, which makes
 * "no HTTP client in the codebase" a code-inspection fact rather than a
 * claim (criterion 26). This module never imports anything from
 * src/vault or src/build (see test/update-module-graph.test.js).
 */

const WINDOWS_GH_CANDIDATES = [
  '%ProgramFiles%\\GitHub CLI\\gh.exe',
  '%LOCALAPPDATA%\\Programs\\GitHub CLI\\gh.exe',
];

function expandWindowsEnvVars(p, env) {
  return p.replace(/%([^%]+)%/g, (_, name) => env[name] || '');
}

/**
 * @param {{ env?: object, platform?: string, exists?: (p: string) => boolean }} [deps] injectable for tests
 * @returns {string|null} the gh executable to invoke, or null if not found
 */
function discoverGh(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const exists = deps.exists || require('fs').existsSync;

  // PATH lookup: rely on the shell to resolve "gh" when spawning; probe
  // with --version to confirm it actually exists.
  const probe = (cmd) => {
    const result = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    return result.status === 0 ? cmd : null;
  };

  const onPath = probe('gh');
  if (onPath) return onPath;

  if (platform === 'win32') {
    for (const candidate of WINDOWS_GH_CANDIDATES) {
      const expanded = expandWindowsEnvVars(candidate, env);
      if (exists(expanded) && probe(expanded)) return expanded;
    }
  }
  return null;
}

/**
 * Runs `gh <args>`, with SCRIPTORIUM_GITHUB_TOKEN (if set) forwarded as
 * GH_TOKEN in the child's environment ONLY, taking precedence over ambient
 * `gh auth` so behaviour is deterministic. Never logged, never written to
 * config, never in an error message.
 */
function runGh(ghPath, args, { input } = {}) {
  const env = { ...process.env };
  if (process.env.SCRIPTORIUM_GITHUB_TOKEN) {
    env.GH_TOKEN = process.env.SCRIPTORIUM_GITHUB_TOKEN;
  }
  return spawnSync(ghPath, args, { encoding: 'utf8', env, input });
}

function assertAuthenticated(ghPath) {
  const result = runGh(ghPath, ['auth', 'status', '--hostname', 'github.com']);
  if (result.status !== 0) {
    throw new UpdatePrerequisiteError(
      'gh is installed but not authenticated for github.com. Run "gh auth login", or set ' +
        'SCRIPTORIUM_GITHUB_TOKEN to a fine-grained PAT with Contents: Read on the repo.',
    );
  }
}

function requireGh() {
  const ghPath = discoverGh();
  if (!ghPath) {
    throw new UpdatePrerequisiteError(
      'gh (the GitHub CLI) was not found on PATH. Install it from https://cli.github.com, then ' +
        'run "gh auth login", or set SCRIPTORIUM_GITHUB_TOKEN to a fine-grained PAT with Contents: Read.',
    );
  }
  assertAuthenticated(ghPath);
  return ghPath;
}

module.exports = { discoverGh, runGh, assertAuthenticated, requireGh };
