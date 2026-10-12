'use strict';

/*
 * Test helper for issue 21 (the retired site_config key). The old plumbing tests pointed a campaign at
 * a legacy site config file (test/fixtures/*-site-config.json) that lives outside the vault. This turns
 * such a file into a campaign pack folder, so the same tests can use `pack = '<destDir>'` instead.
 *
 * The legacy read resolved a relative vaultPath against the site config's own folder. The pack read
 * does the same against the pack folder, so a relative path would move. This helper therefore writes
 * the absolute path the legacy read would have produced, which keeps behaviour identical (proved in
 * the step-0 equivalence run for issue 21).
 */

const fs = require('fs');
const path = require('path');
const { SITE_RELATIVE_INPUTS } = require('../../src/build/stage');

/**
 * @param {string} siteConfigPath absolute path of a legacy-style site config JSON file
 * @param {string} destDir folder to create as the pack (created if missing)
 * @returns {string} destDir
 */
function packFromSiteConfig(siteConfigPath, destDir) {
  const srcDir = path.dirname(siteConfigPath);
  const config = JSON.parse(fs.readFileSync(siteConfigPath, 'utf8').replace(/^﻿/, ''));
  for (const key of ['vaultPath', 'outputDir']) {
    if (typeof config[key] === 'string' && config[key].length > 0) {
      config[key] = path.resolve(srcDir, config[key]);
    }
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'vault.config.json'), JSON.stringify(config, null, 2), { flag: 'wx' });
  for (const rel of SITE_RELATIVE_INPUTS) {
    const from = path.join(srcDir, ...rel.split('/'));
    if (!fs.existsSync(from)) continue;
    const to = path.join(destDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return destDir;
}

module.exports = { packFromSiteConfig };
