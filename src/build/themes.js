'use strict';

const fs = require('fs');
const path = require('path');
const { ScriptoriumError } = require('../util/errors');

/*
 * ADR 0019, Structural decision 8: the theme registry. Extended by ADR 0023 (P3b): `haze` is
 * now the one file-backed theme, in assets/themes/haze/ (THEMES_ROOT below). Extended again by
 * ADR 0032 (base theme slice): `gloam`, composed at load time from haze plus its own additions
 * ("extends" below), and the fonts/owns/notice fields that composition needs.
 *
 * THEMES is a frozen literal, looked up own-property only (never `in`, which
 * would also match inherited Object.prototype members such as "toString" --
 * K3/MA14). Every function here takes `registry = THEMES` so tests can inject
 * a fixture theme without the product registry ever holding more than
 * `plain`/`haze`/`gloam`.
 */

const DEFAULT_THEME = 'plain';
// ADR 0032, Structural decision 6: the defaults split. DEFAULT_THEME (above) is the RESOLUTION
// default (packtoml.js:98,165, for an absent pack or absent theme key) and stays 'plain', so
// every pack-less, plain or haze site is byte-identical (ADR 0019). INIT_DEFAULT_THEME is a
// separate constant that only src/cli/init.js's own default (its --yes value, its prompt default
// and Enter) uses; a guard test asserts it names an own key of THEMES.
const INIT_DEFAULT_THEME = 'gloam';
const SLOT_NAMES = Object.freeze(['hero', 'ground', 'paper', 'crest-frame', 'portrait', '404']);
// Not exported; a file-backed theme's `dir` is otherwise supplied by the registry entry itself,
// which a test fixture also does (its own scratch directory), so no test needs this constant.
const THEMES_ROOT = path.join(__dirname, '..', '..', 'assets', 'themes');
const THEMES = Object.freeze({
  plain: Object.freeze({ name: 'plain', dir: null }),
  haze: Object.freeze({ name: 'haze', dir: path.join(THEMES_ROOT, 'haze') }),
  gloam: Object.freeze({ name: 'gloam', dir: path.join(THEMES_ROOT, 'gloam') }),
});

// Mirrors the pin's own image allowlist (gm-apprentice-publish/lib/scanner.js:288), and
// src/build/themeassets.js's exported IMAGE_EXT_RE of the same value. Kept as a separate,
// private literal here (rather than importing from themeassets.js) to avoid a require cycle:
// themeassets.js requires this module's loadTheme.
const THEME_IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|svg|avif)$/i;

// ADR 0032, Structural decision 4/5: a theme's self-hosted fonts. TTF/OTF/WOFF/WOFF2 only --
// unmodified upstream bytes, never a subsetter or converter output this loader would refuse.
const THEME_FONT_EXT_RE = /\.(woff2|woff|ttf|otf)$/i;

// ADR 0032, Structural decision 2: the members a theme's theme.json `owns` array may name.
const OWNABLE = Object.freeze(['fonts', 'palette']);

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function toPosixRel(relFromDir, name) {
  const rel = relFromDir ? `${relFromDir}/${name}` : name;
  return rel.split(path.sep).join('/');
}

/** Strips /* ... *\/ comments only (no string-literal awareness needed: theme CSS never puts a
 * comment-close sequence inside a string in a way that would matter for an @import scan). */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/*
 * ADR 0032, Structural decision 1: the composition prelude parser. Scans from the start of a
 * parent theme's CSS for a "leading run" of whitespace, /* *\/ comments and `@import ...;`
 * statements (in any interleaving), and returns the index just past the END of the LAST
 * `@import` statement found in that run -- not past any comment that happens to follow it, so a
 * header-style "==== Tokens ====" comment immediately after the last import stays in the parent
 * body. Quote- and paren-aware: haze's own first import has a literal `;` inside `ital@0;1`,
 * itself inside a quoted url(), which must not be mistaken for the statement terminator.
 * Returns -1 when the leading run contains no @import at all (SD-1: "If the parent has no
 * leading @import, parentBody is the whole file").
 */
function findLeadingImportEnd(css) {
  const n = css.length;
  let i = 0;
  let lastEnd = -1;
  for (;;) {
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;
    if (css[i] === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close === -1) {
        i = n;
        break;
      }
      i = close + 2;
      continue;
    }
    // Issue #84: a self-hosting parent (haze) opens with @font-face blocks where it used to open
    // with @imports. They are part of the prelude a child replaces with its own (a child that owns
    // its fonts declares its own), so they are skipped here exactly as imports are.
    if (css.startsWith('@font-face', i)) {
      const open = css.indexOf('{', i);
      const close = open === -1 ? -1 : css.indexOf('}', open);
      if (close === -1) break;
      lastEnd = close + 1;
      i = lastEnd;
      continue;
    }
    if (css.startsWith('@import', i)) {
      let j = i + '@import'.length;
      let depth = 0;
      let quote = null;
      for (; j < n; j++) {
        const ch = css[j];
        if (quote) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === '(') {
          depth++;
          continue;
        }
        if (ch === ')') {
          depth--;
          continue;
        }
        if (ch === ';' && depth === 0) {
          j++;
          break;
        }
      }
      lastEnd = j;
      i = j;
      continue;
    }
    break;
  }
  return lastEnd;
}

/** @param {string} css a parent theme's raw theme.css @returns {string} SD-1's `parentBody` */
function parentBody(css) {
  const lastEnd = findLeadingImportEnd(css);
  if (lastEnd === -1) return css;
  const cut = css[lastEnd] === '\n' ? lastEnd + 1 : lastEnd;
  return css.slice(cut);
}

/** @param {string} css @returns {string} css with exactly one trailing LF (SD-1's ensureTrailingLf) */
function ensureTrailingLf(css) {
  return css.endsWith('\n') ? css : `${css}\n`;
}

/**
 * @param {string} name
 * @param {object} [registry]
 * @returns {{ name: string, dir: string|null, scheme: null|'dark'|'light', slots: string[],
 *   css: string|null, images: { rel: string, abs: string }[], fonts: { rel: string, abs: string }[],
 *   owns: string[], notice: string|null }} images and fonts each sorted by rel, code-unit order
 * @throws {ScriptoriumError} `theme "<name>" is broken: <problem>` for a file-backed theme
 *   that fails validation, or `unknown theme "<name>"` (a programming error: packtoml.js
 *   validates the theme name first, so this should never be reached from product code with
 *   an unknown name)
 */
function loadTheme(name, registry = THEMES) {
  if (!hasOwn(registry, name)) {
    throw new ScriptoriumError(`unknown theme "${name}"`);
  }
  const entry = registry[name];

  if (entry.dir === null) {
    return { name: entry.name, dir: null, scheme: null, slots: [], css: null, images: [], fonts: [], owns: [], notice: null };
  }

  const dir = entry.dir;
  const fail = (problem) => {
    throw new ScriptoriumError(`theme "${name}" is broken: ${problem}`);
  };

  const jsonPath = path.join(dir, 'theme.json');
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch (err) {
    return fail(`could not read ${jsonPath}: ${err.message}`);
  }
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch (err) {
    return fail(`${jsonPath} is not valid JSON: ${err.message}`);
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return fail(`${jsonPath} must contain a JSON object`);
  }
  if (meta.name !== name) {
    return fail(`theme.json name "${meta.name}" does not match registry key "${name}"`);
  }
  if (meta.scheme !== 'dark' && meta.scheme !== 'light') {
    return fail(`theme.json scheme must be "dark" or "light", got ${JSON.stringify(meta.scheme)}`);
  }
  const distinctKnownSlots =
    Array.isArray(meta.slots) && meta.slots.every((s) => SLOT_NAMES.includes(s)) && new Set(meta.slots).size === meta.slots.length;
  if (!distinctKnownSlots) {
    return fail(`theme.json slots must be an array of distinct slot names (${SLOT_NAMES.join(', ')})`);
  }

  // ADR 0032, Structural decision 2: the ownership declaration. Optional; absent means [].
  let owns = [];
  if (meta.owns !== undefined) {
    const distinctKnownOwns =
      Array.isArray(meta.owns) && meta.owns.every((o) => OWNABLE.includes(o)) && new Set(meta.owns).size === meta.owns.length;
    if (!distinctKnownOwns) {
      return fail(`theme.json owns must be an array of distinct members of ${OWNABLE.join(', ')}, got ${JSON.stringify(meta.owns)}`);
    }
    owns = meta.owns;
  }

  const cssPath = path.join(dir, 'theme.css');
  let ownCss;
  try {
    ownCss = fs.readFileSync(cssPath, 'utf8');
  } catch (err) {
    return fail(`could not read ${cssPath}: ${err.message}`);
  }

  // ADR 0032, Structural decision 1: composition. Optional `extends`; absent means the theme's
  // own file is the whole of its CSS, exactly as before this decision existed.
  let css = ownCss;
  if (meta.extends !== undefined) {
    if (typeof meta.extends !== 'string') {
      return fail(`theme.json extends must be a string, got ${JSON.stringify(meta.extends)}`);
    }
    const parentName = meta.extends;
    if (!hasOwn(registry, parentName)) {
      return fail(`extends names unknown theme "${parentName}"`);
    }
    if (parentName === name) {
      return fail(`extends must not name itself`);
    }
    const parentEntry = registry[parentName];
    if (parentEntry.dir === null) {
      return fail(`extends "${parentName}", which has no theme files`);
    }
    const parentDir = parentEntry.dir;

    let parentMeta;
    try {
      parentMeta = JSON.parse(fs.readFileSync(path.join(parentDir, 'theme.json'), 'utf8'));
    } catch (err) {
      return fail(`could not read parent theme.json for "${parentName}": ${err.message}`);
    }
    if (parentMeta && typeof parentMeta === 'object' && !Array.isArray(parentMeta) && parentMeta.extends !== undefined) {
      return fail(`extends "${parentName}", which itself has extends (only one level of extends is allowed)`);
    }

    // A parent's fonts/ and NOTICE.txt are never inherited; they are tolerated only when the child
    // supplies its own (a child that owns its fonts, as gloam does). haze itself has none: it shares
    // gloam's through fontsFrom (below). A parent's images/ stays refused outright.
    if (fs.existsSync(path.join(parentDir, 'images'))) {
      return fail(`extends "${parentName}", which has its own images/ (not inherited by a child theme)`);
    }
    if (fs.existsSync(path.join(parentDir, 'fonts')) && !fs.existsSync(path.join(dir, 'fonts'))) {
      return fail(`extends "${parentName}", which has its own fonts/ (not inherited by a child theme)`);
    }
    if (fs.existsSync(path.join(parentDir, 'NOTICE.txt')) && !fs.existsSync(path.join(dir, 'NOTICE.txt'))) {
      return fail(`extends "${parentName}", which has its own NOTICE.txt (not inherited by a child theme)`);
    }

    let parentCss;
    try {
      parentCss = fs.readFileSync(path.join(parentDir, 'theme.css'), 'utf8');
    } catch (err) {
      return fail(`could not read parent theme.css for "${parentName}": ${err.message}`);
    }

    if (/@import\b/.test(stripCssComments(ownCss))) {
      return fail(`theme.css has an @import; a theme with extends may not add its own imports`);
    }
    const body = parentBody(parentCss);
    if (/@import\b/.test(stripCssComments(body))) {
      return fail(`extends "${parentName}", whose theme.css has an @import outside its leading import run`);
    }

    css = `${ensureTrailingLf(body)}\n${ownCss}`;
  }

  const images = [];
  const imagesDir = path.join(dir, 'images');
  if (fs.existsSync(imagesDir)) {
    (function walk(d, relFromImages) {
      const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of entries) {
        const full = path.join(d, dirent.name);
        const rel = toPosixRel(relFromImages, dirent.name);
        if (dirent.isSymbolicLink()) {
          fail(`symlinks are not allowed in a theme's images/ folder: ${full}`);
        } else if (dirent.isDirectory()) {
          walk(full, rel);
        } else if (!THEME_IMAGE_EXT_RE.test(dirent.name)) {
          fail(`${full} is not an allowed image type (jpg, jpeg, png, webp, gif, svg, avif)`);
        } else {
          images.push({ rel, abs: full });
        }
      }
    })(imagesDir, '');
  }
  images.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // ADR 0032, Structural decision 5: a theme's self-hosted fonts, walked exactly as images/ is.
  // Issue #84 follow-up: optional `fontsFrom` names another registry theme whose fonts/ folder and
  // NOTICE.txt this theme uses instead of carrying byte-identical copies (haze shares gloam's).
  // The shared files still emit under scriptorium/theme/fonts/ and the notice still lands in
  // NOTICE.txt exactly as if the theme owned them, so a haze-only site is unchanged.
  let assetsDir = dir;
  if (meta.fontsFrom !== undefined) {
    if (typeof meta.fontsFrom !== 'string' || !hasOwn(registry, meta.fontsFrom)) {
      return fail(`theme.json fontsFrom must name a known theme, got ${JSON.stringify(meta.fontsFrom)}`);
    }
    if (meta.fontsFrom === name) return fail('fontsFrom must not name itself');
    const srcEntry = registry[meta.fontsFrom];
    if (srcEntry.dir === null) return fail(`fontsFrom "${meta.fontsFrom}", which has no theme files`);
    if (fs.existsSync(path.join(dir, 'fonts')) || fs.existsSync(path.join(dir, 'NOTICE.txt'))) {
      return fail('theme.json fontsFrom is set, so the theme must not also carry its own fonts/ or NOTICE.txt');
    }
    let srcMeta;
    try {
      srcMeta = JSON.parse(fs.readFileSync(path.join(srcEntry.dir, 'theme.json'), 'utf8'));
    } catch (err) {
      return fail(`could not read theme.json for fontsFrom "${meta.fontsFrom}": ${err.message}`);
    }
    if (srcMeta && typeof srcMeta === 'object' && srcMeta.fontsFrom !== undefined) {
      return fail(`fontsFrom "${meta.fontsFrom}", which itself has fontsFrom (only one level is allowed)`);
    }
    assetsDir = srcEntry.dir;
  }
  const fonts = [];
  const fontsDir = path.join(assetsDir, 'fonts');
  if (fs.existsSync(fontsDir)) {
    (function walk(d, relFromFonts) {
      const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of entries) {
        const full = path.join(d, dirent.name);
        const rel = toPosixRel(relFromFonts, dirent.name);
        if (dirent.isSymbolicLink()) {
          fail(`symlinks are not allowed in a theme's fonts/ folder: ${full}`);
        } else if (dirent.isDirectory()) {
          walk(full, rel);
        } else if (!THEME_FONT_EXT_RE.test(dirent.name)) {
          fail(`${full} is not an allowed font type (woff2, woff, ttf, otf)`);
        } else {
          fonts.push({ rel, abs: full });
        }
      }
    })(fontsDir, '');
  }
  fonts.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  let notice = null;
  const noticePath = path.join(assetsDir, 'NOTICE.txt');
  if (fs.existsSync(noticePath)) {
    notice = fs.readFileSync(noticePath, 'utf8');
  }

  return { name: meta.name, dir, scheme: meta.scheme, slots: meta.slots, css, images, fonts, owns, notice };
}

module.exports = { DEFAULT_THEME, INIT_DEFAULT_THEME, SLOT_NAMES, THEMES, loadTheme };
