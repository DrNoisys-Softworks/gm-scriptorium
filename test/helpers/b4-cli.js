'use strict';

/*
 * Shared harness for the bug-batch-B4 tests: runs the real bin against scratch paths only. Every
 * run is isolated three ways (--config, SCRIPTORIUM_CONFIG, and the platform config homes all
 * point into the scratch root), so nothing can reach a real config or a real vault.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', '..', 'bin', 'scriptorium.js');
const SAMPLE = path.join(__dirname, '..', '..', 'examples', 'the-long-lease');

function withScratch(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-b4-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg');
  return env;
}

/** Runs the CLI (or an override binary via SCRIPTORIUM_TEST_BIN) with --config in the scratch root. */
function run(root, args, { input, withConfig = true, env: extraEnv = {} } = {}) {
  const env = { ...scratchEnv(root), ...extraEnv };
  const bin = process.env.SCRIPTORIUM_TEST_BIN;
  const argv = [...args, ...(withConfig ? ['--config', path.join(root, 'config.toml')] : [])];
  const res = bin
    ? spawnSync(bin, argv, { timeout: 60000, killSignal: 'SIGKILL', input, env, encoding: 'utf8' })
    : spawnSync(process.execPath, [BIN, ...argv], { timeout: 60000, killSignal: 'SIGKILL', input, env, encoding: 'utf8' });
  if (res.error) throw res.error;
  return { code: res.status, out: res.stdout, err: res.stderr, all: `${res.stdout}${res.stderr}` };
}

/** A copy of the sample vault with its campaign pack removed, i.e. what a new GM's vault looks like. */
function copySampleWithoutPack(root, name = 'vault') {
  const dest = path.join(root, name);
  fs.cpSync(SAMPLE, dest, { recursive: true });
  fs.rmSync(path.join(dest, '_meta', 'scriptorium'), { recursive: true, force: true });
  return dest;
}

module.exports = { BIN, SAMPLE, withScratch, scratchEnv, run, copySampleWithoutPack };
