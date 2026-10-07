'use strict';

/*
 * Shared scratch fixtures for the browser-setup tests. Every path lives under a fresh scratch
 * folder: a copy of the public sample vault (with or without its campaign pack), a scratch config
 * path, and an environment whose config homes point into the scratch folder, so nothing can reach
 * a real config or a real vault (pattern: test/helpers/b4-cli.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SAMPLE = path.join(__dirname, '..', '..', 'examples', 'the-long-lease');

/** Makes a scratch root and registers its removal on the test context. */
function scratchRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A copy of the sample vault; `withPack: false` removes _meta/scriptorium (what a new GM's vault looks like). */
function copySample(root, name = 'vault', { withPack = false } = {}) {
  const dest = path.join(root, name);
  fs.cpSync(SAMPLE, dest, { recursive: true });
  if (!withPack) fs.rmSync(path.join(dest, '_meta', 'scriptorium'), { recursive: true, force: true });
  return dest;
}

function configPathIn(root) {
  return path.join(root, 'cfg', 'config.toml');
}

/** An environment whose config homes all point into the scratch root. */
function isolatedEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg');
  return env;
}

/** Lists every file and folder under dir, as sorted relative paths with sizes (a cheap tree snapshot). */
function treeSnapshot(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        out.push(`${r}/`);
        walk(full, r);
      } else {
        out.push(`${r}:${fs.statSync(full).size}`);
      }
    }
  })(dir, '');
  return out.sort();
}

module.exports = { SAMPLE, scratchRoot, copySample, configPathIn, isolatedEnv, treeSnapshot };
