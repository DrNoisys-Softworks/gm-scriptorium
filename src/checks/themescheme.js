'use strict';

const path = require('path');
const read = require('../vault/read');
const { readSettingsFiles } = require('../vault/publishset');
const pinned = require('../generator/pinned');
const { loadTheme, THEMES } = require('../build/themes');
const { createFinding } = require('../report/finding');

/*
 * ADR 0023, Structural decision 6: config/theme-scheme-mismatch.
 *
 * Reproduces the pin's palette merge (lib/config.js:130-156; a genre written with no palette leaves it unset) and its light/dark rule
 * (lib/theme.js:179-184, applied after that merge) purely from _meta/vault-config.md's `publish`
 * block, through src/vault/read.js's own read-only, abort-on-EIO chokepoint (the same one
 * src/vault/publishset.js's loadPublishConfig uses, at :128-129) -- never the pin's own
 * loadPublishConfig() (bypasses that chokepoint) and never generateThemeCSS() itself (parsing
 * its emitted CSS back out to recover the scheme would be fragile; rejected in the Engineering
 * Brief alongside a hardcoded '#1a1f25' default, which would leave this check silent for a
 * vault with no palette at all -- the most likely mismatch).
 *
 * parseHex/luminance below are a verbatim port of gm-apprentice-publish/lib/theme.js:107-122
 * (cited there; neither is exported by the pin's own module.exports). Kept honest by
 * test/theme-scheme.test.js's parity matrix, which deep-requires the pin's real lib/config.js
 * and lib/theme.js and compares this module's output against generateThemeCSS()'s own.
 */

function parseHex(hex) {
  const raw = String(hex || '').trim().replace('#', '');
  const h = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw;
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

function luminance(hex) {
  const { r, g, b } = parseHex(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * The same reading on a moved vault, from the theme the pin resolved out of _meta/vault-config.yaml
 * (its palette already merged over the defaults). A genre with no palette written leaves the palette
 * to the preset, as it does in the old file.
 */
function movedPaletteScheme(vaultPath) {
  const { md, yaml } = readSettingsFiles(vaultPath);
  const { publishConfig } = pinned.resolveSiteConfig(vaultPath, {}, { md, yaml });
  const theme = publishConfig.theme || {};
  const writesPalette = Object.keys(publishConfig.origins || {}).some((k) => k.startsWith('player_site.theme.palette.') && publishConfig.origins[k] === 'file');
  if (!writesPalette && theme.genre && pinned.resolveGenrePreset(theme.genre)) return { scheme: null, background: null };
  const background = (theme.palette || {}).background || '#1a1f25';
  return { scheme: luminance(background) > 0.5 ? 'light' : 'dark', background };
}

/**
 * @param {string} vaultPath
 * @returns {{ scheme: 'light'|'dark'|null, background: string|null }} null/null when a genre
 *   preset owns the palette (the preset's own CSS colours are not reproduced here -- SD-6).
 */
function paletteScheme(vaultPath) {
  if (pinned.settingsLayoutOf(vaultPath) === 'new') return movedPaletteScheme(vaultPath);
  const configFile = path.join(vaultPath, '_meta', 'vault-config.md');
  let publish = {};
  if (read.pathExists(configFile)) {
    const result = read.readFrontmatter(configFile);
    if (result.ok && result.data.publish) {
      publish = result.data.publish;
    }
  }

  const t = publish.theme;
  let palette;
  if (t && t.palette) {
    palette = { ...pinned.PUBLISH_DEFAULTS.theme.palette, ...t.palette };
  } else if (t && t.genre) {
    palette = null;
  } else {
    palette = { ...pinned.PUBLISH_DEFAULTS.theme.palette };
  }

  if (palette === null && pinned.resolveGenrePreset(t.genre)) {
    return { scheme: null, background: null };
  }

  const background = (palette || {}).background || '#1a1f25';
  const scheme = luminance(background) > 0.5 ? 'light' : 'dark';
  return { scheme, background };
}

/**
 * @param {object} ctx src/checks/context.js's shared context, extended with `packToml`
 *   (src/cli/check.js's runCheckCommand -> buildCheckContext)
 * @param {{ registry?: object }} [opts]
 * @returns {object[]} zero or one Finding
 */
function runThemeSchemeMismatch(ctx, { registry = THEMES } = {}) {
  if (!ctx.packToml) return [];
  if (!ctx.packToml.present) return [];

  const theme = ctx.packToml.theme;
  const loaded = loadTheme(theme, registry);
  const themeScheme = loaded.scheme;
  if (themeScheme === null) return [];
  // ADR 0032, Structural decision 2: a theme that declares ownership of the palette (gloam) is
  // never judged against the vault's own palette -- the vault's colours never reach the page
  // under it, so a mismatch finding would be noise (F2).
  if (loaded.owns.includes('palette')) return [];

  const { scheme: paletteSchemeValue, background } = paletteScheme(ctx.vaultPath);
  if (paletteSchemeValue === null) return [];
  if (paletteSchemeValue === themeScheme) return [];

  const moved = pinned.settingsLayoutOf(ctx.vaultPath) === 'new';
  const settingsFile = moved ? '_meta/vault-config.yaml' : '_meta/vault-config.md';
  const configFile = path.join(ctx.vaultPath, settingsFile);

  return [
    createFinding({
      id: 'config/theme-scheme-mismatch',
      severity: 'info',
      category: 'config',
      campaign: ctx.campaign,
      path: read.pathExists(configFile) ? settingsFile : null,
      message:
        `theme "${theme}" expects a ${themeScheme} palette, but the palette background ${background} is ${paletteSchemeValue}; ` +
        `set publish.theme.palette.background in ${settingsFile}, or choose another theme in pack.toml`,
      data: { theme, scheme: themeScheme, paletteScheme: paletteSchemeValue, background },
    }),
  ];
}

module.exports = { paletteScheme, runThemeSchemeMismatch };
