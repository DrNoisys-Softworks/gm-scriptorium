'use strict';

const fs = require('fs');
const path = require('path');
const read = require('../vault/read');
const { loadTheme, THEMES } = require('./themes');
const { writeThemeStyle, composeThemeCss } = require('./themestyle');
const { excludedDirUnion, excludedDirHit, excludedSegmentHit, platformFoldsCase } = require('../vault/exclusions');
const { loadPublishConfig } = require('../vault/publishset');
const { toRelativePosix } = require('../util/paths');
const { ConfigError, ScriptoriumError } = require('../util/errors');

/*
 * ADR 0019: the file-checking half of the asset step (P3a-FR06), run by
 * src/cli/build.js BEFORE runAtomicBuild (Structural decision 4), so a
 * refusal here writes nothing at all -- sweepStaleSiblings never runs and
 * --force never reaches this stage. planThemeAssets is pure with respect
 * to writes: it only ever reads (through src/vault/read.js for vault/pack
 * files, plain fs for theme files -- SD-9) and holds accepted bytes in
 * memory (SD-5), so the slot sha equals the source by construction and
 * there is no time-of-check/time-of-use window on content.
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // D-03
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|svg|avif)$/i; // pin scanner.js:273

/** folded per platformFoldsCase(); true iff target starts with base + path.sep */
function isInsideReal(realBase, realTarget) {
  const fold = platformFoldsCase();
  const b = fold ? realBase.toLowerCase() : realBase;
  const t = fold ? realTarget.toLowerCase() : realTarget;
  return t.startsWith(b + path.sep);
}

function emptyPlan(campaign, packToml) {
  return { campaign, tomlPath: packToml.path, theme: packToml.theme, files: [], css: null, warnings: [] };
}

/**
 * Build-only, before runAtomicBuild.
 *
 * @param {{ vaultPath: string, jsonConfig: object, siteDir: string, packToml: object,
 *   campaign: string, registry?: object }} opts
 * @returns {{ campaign: string, tomlPath: string, theme: string,
 *   files: { outRel: string, bytes: Buffer }[], css: string|null, warnings: string[] }}
 *   files sorted by outRel
 * @throws {ConfigError}
 */
function planThemeAssets({ vaultPath, jsonConfig, siteDir, packToml, campaign, registry = THEMES }) {
  const c = campaign;

  if (!packToml.present) {
    return emptyPlan(c, packToml);
  }

  const T = packToml.path;
  const D = path.dirname(T);
  const warnings = [];
  const files = [];

  const theme = loadTheme(packToml.theme, registry);
  for (const img of theme.images) {
    const st = fs.statSync(img.abs); // SD-9: theme files are product assets, read with plain fs
    if (st.size > MAX_IMAGE_BYTES) {
      throw new ConfigError(`campaign "${c}": ${img.abs} is ${st.size} bytes, over the 10 MiB (10485760-byte) limit`, {
        path: T,
        campaign: c,
      });
    }
    files.push({ outRel: `scriptorium/theme/${img.rel}`, bytes: fs.readFileSync(img.abs) });
  }

  // ADR 0032, Structural decision 5: theme fonts go through the same refusal class as theme
  // images (size limit only here; the loader already refused symlinks and a disallowed
  // extension -- src/build/themes.js).
  for (const font of theme.fonts) {
    const st = fs.statSync(font.abs); // SD-9: theme files are product assets, read with plain fs
    if (st.size > MAX_IMAGE_BYTES) {
      throw new ConfigError(`campaign "${c}": ${font.abs} is ${st.size} bytes, over the 10 MiB (10485760-byte) limit`, {
        path: T,
        campaign: c,
      });
    }
    files.push({ outRel: `scriptorium/theme/fonts/${font.rel}`, bytes: fs.readFileSync(font.abs) });
  }

  const hasVaultSlot = packToml.images.some((s) => s.kind === 'vault');
  const union = hasVaultSlot ? excludedDirUnion(jsonConfig, loadPublishConfig(vaultPath, jsonConfig).publishConfig) : [];
  const foldCase = platformFoldsCase();

  const slotDecls = [];
  for (const slotRef of packToml.images) {
    const { slot, raw, kind, rel } = slotRef;
    const fail = (message) => {
      throw new ConfigError(message, { path: T, campaign: c });
    };

    // 1. requested-path extension
    if (!IMAGE_EXT_RE.test(rel)) {
      fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" is not an allowed image type (jpg, jpeg, png, webp, gif, svg, avif)`);
    }

    // 2. (vault: only) exclusion on the requested path
    if (kind === 'vault') {
      const hit = excludedDirHit(rel, union, { foldCase }) || excludedSegmentHit(rel, union, { foldCase });
      if (hit) {
        fail(
          `campaign "${c}": ${T}: [images] ${slot} = "${raw}" is under excluded directory "${hit}"; images from excluded or hidden folders are never published`,
        );
      }
    }

    const base = kind === 'vault' ? vaultPath : D;
    const abs = path.join(base, ...rel.split('/'));

    // 3. missing
    const st = read.statOrNull(abs);
    if (st === null) {
      fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" does not exist: ${abs}`);
    }

    // 4. not a regular file
    if (!st.isFile()) {
      fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" is not a regular file: ${abs}`);
    }

    // 5. real-path containment
    const real = read.realPath(abs);
    if (!isInsideReal(read.realPath(base), real)) {
      fail(
        `campaign "${c}": ${T}: [images] ${slot} = "${raw}" resolves outside the ${kind === 'vault' ? 'vault' : 'pack'} (${real}); symlinks may not leave ${base}`,
      );
    }

    // 6. (vault: only) exclusion on the real path
    if (kind === 'vault') {
      const relReal = toRelativePosix(read.realPath(base), real);
      const hitReal = excludedDirHit(relReal, union, { foldCase }) || excludedSegmentHit(relReal, union, { foldCase });
      if (hitReal) {
        fail(
          `campaign "${c}": ${T}: [images] ${slot} = "${raw}" resolves to ${relReal}, which is under excluded directory "${hitReal}"; images from excluded or hidden folders are never published`,
        );
      }
    }

    // 7. real-path extension
    if (!IMAGE_EXT_RE.test(real)) {
      fail(
        `campaign "${c}": ${T}: [images] ${slot} = "${raw}" resolves to ${real}, which is not an allowed image type (jpg, jpeg, png, webp, gif, svg, avif)`,
      );
    }

    // 8. size, from the stat already taken
    if (st.size > MAX_IMAGE_BYTES) {
      fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" is ${st.size} bytes, over the 10 MiB (10485760-byte) limit`);
    }

    // 9. the bytes, with the size re-checked against what was actually read
    const bytes = read.readBytes(real);
    if (bytes.length > MAX_IMAGE_BYTES) {
      fail(`campaign "${c}": ${T}: [images] ${slot} = "${raw}" is ${bytes.length} bytes, over the 10 MiB (10485760-byte) limit`);
    }

    const ext = path.extname(real).toLowerCase();
    files.push({ outRel: `scriptorium/slots/${slot}${ext}`, bytes });
    slotDecls.push({ slot, href: `../scriptorium/slots/${slot}${ext}` });
  }

  // 4. pack images: <siteDir>/images (D === siteDir, since T === path.join(siteDir, 'pack.toml')).
  const imagesDirDisk = path.join(D, 'images');
  if (read.pathExists(imagesDirDisk)) {
    const dirSt = read.statOrNull(imagesDirDisk);
    if (!dirSt || !dirSt.isDirectory()) {
      throw new ConfigError(`campaign "${c}": ${D}/images is not a folder`, { path: T, campaign: c });
    }
    const realPackBase = read.realPath(D);
    (function walk(dir, relFromImages) {
      for (const entry of read.listDir(dir)) {
        const abs = path.join(dir, entry.name);
        const rel = relFromImages ? `${relFromImages}/${entry.name}` : entry.name;

        if (entry.isSymbolicLink) {
          throw new ConfigError(`campaign "${c}": symbolic links are not allowed in the pack's images folder: ${abs}`, {
            path: abs,
            campaign: c,
          });
        }
        if (entry.isDirectory) {
          walk(abs, rel);
          continue;
        }
        if (!IMAGE_EXT_RE.test(entry.name)) {
          warnings.push(`${abs}: not an allowed image type; not copied`);
          continue;
        }

        const real = read.realPath(abs);
        if (!isInsideReal(realPackBase, real)) {
          throw new ConfigError(`campaign "${c}": ${abs} resolves outside the pack (${real})`, { path: abs, campaign: c });
        }
        const fileSt = read.statOrNull(abs);
        if (fileSt && fileSt.size > MAX_IMAGE_BYTES) {
          throw new ConfigError(`campaign "${c}": ${abs} is ${fileSt.size} bytes, over the 10 MiB (10485760-byte) limit`, {
            path: abs,
            campaign: c,
          });
        }
        const bytes = read.readBytes(real);
        if (bytes.length > MAX_IMAGE_BYTES) {
          throw new ConfigError(`campaign "${c}": ${abs} is ${bytes.length} bytes, over the 10 MiB (10485760-byte) limit`, {
            path: abs,
            campaign: c,
          });
        }
        files.push({ outRel: `scriptorium/campaign/${rel}`, bytes });
      }
    })(imagesDirDisk, '');
  }

  files.sort((a, b) => (a.outRel < b.outRel ? -1 : a.outRel > b.outRel ? 1 : 0));

  const css = composeThemeCss(theme.css, slotDecls);

  // FR-10: the plan gains a `notice` key ONLY when the theme carries a NOTICE.txt, so plain's
  // and haze's plan shape (no `notice` key at all) is untouched -- theme-assets.test.js:50 stays
  // green unedited.
  const plan = { campaign: c, tomlPath: T, theme: packToml.theme, files, css, warnings };
  if (theme.notice !== null) plan.notice = theme.notice;
  return plan;
}

/**
 * @param {string} stagingOut
 * @param {object|null} plan
 * @returns {{ written: boolean, files: number, pagesLinked: number }}
 * @throws {ConfigError} E-COLLISION, before any write
 * @throws {ScriptoriumError} an outRel escaping scriptorium/ (a programming invariant)
 */
function writeThemeAssets(stagingOut, plan) {
  if (!plan || (plan.files.length === 0 && plan.css === null)) {
    return { written: false, files: 0, pagesLinked: 0 };
  }

  for (const f of plan.files) {
    if (!f.outRel.startsWith('scriptorium/')) {
      throw new ScriptoriumError(`theme asset outRel must start with "scriptorium/", got: ${f.outRel}`);
    }
  }

  // SD-6: the collision refuses only when the plan would actually write
  // under scriptorium/ ("Things you need to know first" #3) -- a plan with
  // no files (theme CSS only, e.g. plain with a slot-less pack.toml) never
  // touches scriptorium/ at all and so never refuses on its account.
  if (plan.files.length > 0 && fs.existsSync(path.join(stagingOut, 'scriptorium'))) {
    throw new ConfigError(
      `campaign "${plan.campaign}": the generated site already has a scriptorium/ folder (a folderMap entry probably maps a vault folder to it); rename that output folder, because image slots and pack images are written to scriptorium/`,
      { path: plan.tomlPath, campaign: plan.campaign },
    );
  }

  for (const f of plan.files) {
    const dest = path.join(stagingOut, ...f.outRel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.bytes);
  }

  const { pagesLinked } = writeThemeStyle(stagingOut, plan.css);

  // ADR 0032, Structural decision 5: append the theme's own font licence notice to the site
  // NOTICE.txt, when the theme carries one. This relies on run.js calling writeSiteNotice
  // (which always writes NOTICE.txt, run.js:103) before writeThemeAssets (run.js:120) -- T13
  // guards that order with a real build.
  if (typeof plan.notice === 'string') {
    fs.appendFileSync(path.join(stagingOut, 'NOTICE.txt'), plan.notice);
  }

  return { written: true, files: plan.files.length, pagesLinked };
}

module.exports = { MAX_IMAGE_BYTES, IMAGE_EXT_RE, isInsideReal, planThemeAssets, writeThemeAssets };
