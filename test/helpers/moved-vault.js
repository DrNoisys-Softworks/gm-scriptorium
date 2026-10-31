'use strict';

/*
 * Test-only helper: a copy of a vault that gm-apprentice's own move has already run on, so a test
 * can read a vault whose settings live in _meta/vault-config.yaml.
 *
 * It requires the pin's lib/settings/move directly, which src/ never does (product code reaches the
 * pin only through src/generator/pinned.js). This is test-only tooling, the same exception
 * scripts/equivalence-check.js documents. The move is the pin's own planMove/applyMove, so the
 * copy is what the real tool makes, not a hand-built imitation.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
// Loaded first, for its side effect: the facade seeds the generator's redactions before the pin's
// template tree loads, and loading the pin's move below would otherwise load that tree too early.
require('../../src/generator/pinned');
const { contextFromSite } = require('../../src/cli/check');
const { planMove, applyMove } = require('gm-apprentice-publish/lib/settings/move');

/**
 * Copy `srcVault` into `root`, optionally with a site config beside it, and run the pin's move on
 * the copy (folding the site file's settings in when one is given).
 *
 * @param {string} srcVault the vault folder to copy
 * @param {string} root an existing scratch folder to copy into
 * @param {{ siteConfig?: object, inVaultPack?: boolean }} [opts] a site config (vault.config.json content)
 *   to fold in; or `inVaultPack: true` to fold in (and strip) the pack the copy already holds at
 *   _meta/scriptorium/vault.config.json
 * @returns {{ vaultPath: string, siteConfig: object|undefined }} the moved copy, and the site
 *   config as the move left it (its settings taken out), with `vaultPath` removed; undefined when
 *   none was given
 * @throws {Error} when the pin's plan is not ok
 */
function moveVaultCopy(srcVault, root, { siteConfig, inVaultPack = false } = {}) {
  const copy = path.join(root, 'vault');
  fs.cpSync(srcVault, copy, { recursive: true });
  const vaultPath = fs.realpathSync.native(copy);
  let siteConfigPath;
  if (siteConfig) {
    const siteDir = path.join(root, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    siteConfigPath = path.join(siteDir, 'vault.config.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify({ ...siteConfig, vaultPath }, null, 2));
  }
  if (inVaultPack) {
    // The pack that lives in the vault's own _meta/scriptorium: fold its settings in and strip it there.
    // The pin wants the pack to name its vault, which a pack in the vault does not; it is added for
    // the move and taken off again afterwards, so the pack is left as a pack in a vault is.
    siteConfigPath = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
    const pack = JSON.parse(fs.readFileSync(siteConfigPath, 'utf8'));
    fs.writeFileSync(siteConfigPath, JSON.stringify({ ...pack, vaultPath }, null, 2));
  }
  const plan = planMove({ vaultPath, siteConfigPath, foldSiteFile: true });
  if (!plan.ok) throw new Error(`the move was not ok: ${(plan.blockers || []).join('; ')}`);
  applyMove(plan);
  if (inVaultPack) {
    const left = JSON.parse(fs.readFileSync(siteConfigPath, 'utf8'));
    delete left.vaultPath;
    fs.writeFileSync(siteConfigPath, JSON.stringify(left, null, 2));
  }
  let left;
  if (siteConfigPath && !inVaultPack) {
    left = JSON.parse(fs.readFileSync(siteConfigPath, 'utf8'));
    delete left.vaultPath;
  }
  return { vaultPath, siteConfig: left };
}

/**
 * Prove a vault really is on the moved layout: the yaml is there and the old markdown file is not.
 * A case that runs on "the moved layout" calls this, so a helper that silently failed to move
 * cannot leave the case vacuous.
 *
 * @param {string} vaultPath the vault folder
 * @returns {void}
 * @throws {assert.AssertionError} when the vault is not on the moved layout
 */
function assertMovedLayout(vaultPath) {
  assert.ok(fs.existsSync(path.join(vaultPath, '_meta', 'vault-config.yaml')), 'moved vault: _meta/vault-config.yaml must exist');
  assert.ok(!fs.existsSync(path.join(vaultPath, '_meta', 'vault-config.md')), 'moved vault: _meta/vault-config.md must be gone');
}

/**
 * One vault on one settings layout, for the leak tests that run each case on both.
 *
 * 'legacy' gives the source vault with the site config as it always was: `jsonConfig` is the site
 * config plus the vault path, and there is no `rawSiteConfig`.
 *
 * 'new' copies the vault into `root`, runs the pin's move (folding the site config's settings into
 * the yaml), checks the result with assertMovedLayout, and then resolves the context the way
 * `check` and `build` do (contextFromSite): `jsonConfig` is the pack resolved against the yaml,
 * `rawSiteConfig` the pack as the move left it. The source vault must start on the old layout.
 *
 * @param {'legacy'|'new'} layout which settings layout to give the case
 * @param {string} srcVault the vault folder
 * @param {object} siteConfig the site config (vault.config.json content) for the vault
 * @param {string} root an existing scratch folder (used only for 'new')
 * @returns {{ vaultPath: string, jsonConfig: object, rawSiteConfig: (object|undefined), settingsLayout: string }}
 *   the vault to use and the pieces to hand buildCheckContext (spread it) or, as `jsonConfig`, runAtomicBuild
 */
function onLayout(layout, srcVault, siteConfig, root) {
  if (layout === 'legacy') {
    assert.ok(fs.existsSync(path.join(srcVault, '_meta', 'vault-config.md')), 'the legacy vault must be on the old layout');
    assert.ok(!fs.existsSync(path.join(srcVault, '_meta', 'vault-config.yaml')), 'the legacy vault must not hold a vault-config.yaml');
    return { vaultPath: srcVault, jsonConfig: { ...siteConfig, vaultPath: srcVault }, rawSiteConfig: undefined, settingsLayout: 'legacy' };
  }
  assert.equal(layout, 'new');
  assert.ok(fs.existsSync(path.join(srcVault, '_meta', 'vault-config.md')), 'the source vault must start on the old layout');
  const { vaultPath } = moveVaultCopy(srcVault, root, { siteConfig });
  assertMovedLayout(vaultPath);
  const siteConfigPath = path.join(root, 'site', 'vault.config.json');
  const site = { siteSource: 'site_config', siteConfigPath, siteDir: path.dirname(siteConfigPath), packShadowed: null };
  const info = contextFromSite({ campaign: 'x', vault: vaultPath, site_config: siteConfigPath }, vaultPath, site);
  assert.equal(info.settingsLayout, 'new');
  return { vaultPath, jsonConfig: info.jsonConfig, rawSiteConfig: info.rawSiteConfig, settingsLayout: info.settingsLayout };
}

/**
 * String.replace that must match: a settings edit that silently matched nothing would leave a case
 * proving less than it says.
 *
 * @param {string} text the file's text
 * @param {string} from the exact text to replace
 * @param {string} to what to put there
 * @returns {string} the edited text
 * @throws {assert.AssertionError} when `from` is not in `text`
 */
function replaceChecked(text, from, to) {
  assert.ok(text.includes(from), `the settings edit did not match: ${JSON.stringify(from)}`);
  return text.replace(from, () => to);
}

/**
 * Replaces the `player_site.folder_map` block of a moved vault's yaml (the key line and every line
 * indented under it) with `line`, or removes it when `line` is null. Throws when there is no block,
 * so a case cannot silently test the vault it started with.
 *
 * @param {string} vaultPath a moved vault
 * @param {string|null} line the replacement, such as '  folder_map: "Sessions"'
 * @returns {void}
 */
function replaceYamlFolderMap(vaultPath, line) {
  const file = path.join(vaultPath, '_meta', 'vault-config.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const block = /^ {2}folder_map:\n(?: {4}.*\n)+/m;
  assert.ok(block.test(text), 'the yaml holds a player_site.folder_map block');
  fs.writeFileSync(file, text.replace(block, () => (line === null ? '' : `${line}\n`)));
}

module.exports = { moveVaultCopy, assertMovedLayout, onLayout, replaceChecked, replaceYamlFolderMap };
