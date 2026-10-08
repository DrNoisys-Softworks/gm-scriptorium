'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Phase 8 slice S1. Embedded UI asset lookup: a fixed map, same asset-path-under-__dirname
 * precedent as src/build/themes.js:22 (read with plain fs, not through src/vault/read.js --
 * these are Scriptorium's own first-party files, not vault content).
 */

const ADMIN_ASSETS_DIR = path.join(__dirname, '..', '..', 'assets', 'admin');

/**
 * Frozen: the 34 files served at /assets/<name> (ADR 0049: 33 -> 34, adding picker.js, the folder picker) (Lantern branding: 30 -> 31, adding favicon-32.png) (ADR 0028: 31 -> 33, adding launch.js, the sign-in
 * interstitial's navigation, and alive.js, the "stopped" tab) (ADR 0028: 28 -> 30, adding setup.js, browser setup's
 * script, and welcome.js, the Overview welcome) (V1.5a ADR 0029: 26 -> 28, adding signin.js, the sign-in
 * page's script, and remote.js, the read-only Remote access screen) (panel v2 V1b: 20 -> 23, adding diff.js,
 * outcome.js and slip.js -- the pure client-side modules SD-4 introduces; V1e-3 SD-26: 23 -> 24,
 * adding sitepane.js, the Overview live-preview module; V1e-9 SD-100: 24 -> 25, adding
 * vaultcfg.js, the vault-config.md editor; V1e-7 SD-69: 25 -> 26, adding variants.js, the Theme
 * screen's live-frame cards -- re-measured at the V1e-7 rebase onto main). index.html,
 * locked.html, setup.html, launch.html and launch-locked.html are NOT in here. Keys may contain a single '/'; lookup stays exact own-property membership
 * (src/admin/handlers/core.js), and readAdminAsset's path.join below handles the subpath. core.js
 * is not edited.
 */
const ADMIN_ASSET_ROUTES = Object.freeze({
  'admin.css': 'text/css; charset=utf-8',
  'tokens.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'store.js': 'text/javascript; charset=utf-8',
  'icons.js': 'text/javascript; charset=utf-8',
  'nav.js': 'text/javascript; charset=utf-8',
  'frame.js': 'text/javascript; charset=utf-8',
  'diff.js': 'text/javascript; charset=utf-8',
  'outcome.js': 'text/javascript; charset=utf-8',
  'slip.js': 'text/javascript; charset=utf-8',
  'views.js': 'text/javascript; charset=utf-8',
  'pack.js': 'text/javascript; charset=utf-8',
  'picker.js': 'text/javascript; charset=utf-8',
  'sitepane.js': 'text/javascript; charset=utf-8',
  'variants.js': 'text/javascript; charset=utf-8',
  'signin.js': 'text/javascript; charset=utf-8',
  'remote.js': 'text/javascript; charset=utf-8',
  'setup.js': 'text/javascript; charset=utf-8',
  'welcome.js': 'text/javascript; charset=utf-8',
  'launch.js': 'text/javascript; charset=utf-8',
  'alive.js': 'text/javascript; charset=utf-8',
  'vaultcfg.js': 'text/javascript; charset=utf-8',
  'vocab.js': 'text/javascript; charset=utf-8',
  'images.js': 'text/javascript; charset=utf-8',
  'favicon.svg': 'image/svg+xml',
  'favicon-32.png': 'image/png',
  'fonts/IMFeENrm28P.ttf': 'font/ttf',
  'fonts/IMFeENsc28P.ttf': 'font/ttf',
  'fonts/AlegreyaSans-Regular.ttf': 'font/ttf',
  'fonts/AlegreyaSans-Medium.ttf': 'font/ttf',
  'fonts/AlegreyaSans-Bold.ttf': 'font/ttf',
  'fonts/AlegreyaSans-Italic.ttf': 'font/ttf',
  'fonts/IBMPlexMono-Regular.woff2': 'font/woff2',
  'fonts/IBMPlexMono-SemiBold.woff2': 'font/woff2',
});

/** @param {string} file a bare filename under assets/admin/ (index.html, locked.html, or a route above) */
function readAdminAsset(file) {
  return fs.readFileSync(path.join(ADMIN_ASSETS_DIR, file));
}

module.exports = { ADMIN_ASSETS_DIR, ADMIN_ASSET_ROUTES, readAdminAsset };
