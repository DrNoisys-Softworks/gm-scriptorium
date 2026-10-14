'use strict';

/*
 * Windows branding for the win-x64 executable: the Lantern icon and the version strings.
 *
 * Why this edits the pkg BASE binary and not the finished exe: @yao-pkg/pkg appends its payload
 * after the base binary and writes absolute offsets for it into placeholders it finds by string
 * search in the base. Rewriting the PE resources of the finished exe would move sections and
 * break those offsets. Editing the bare base first is safe, because pkg then measures the edited
 * buffer and computes its offsets from the new length. See docs/decisions/0001-packager.md.
 *
 * Why it checks the base itself: pkg-fetch skips its own sha256 check when PKG_NODE_PATH is set,
 * and package.js points PKG_NODE_PATH at the branded copy. So the base is verified here, against
 * the hash pkg-fetch ships for it, before a single byte is edited. A mismatch fails closed.
 *
 * resedit and pe-library are devDependencies, used only in this file. scripts/package.js never
 * requires them: it runs this file as a child process. resedit is ESM-only, so it is loaded with
 * a dynamic import.
 *
 * CLI:
 *   node scripts/winres.js brand <outPath>   writes a branded copy of the verified base
 *   node scripts/winres.js check <exe>       checks the branding of a finished exe
 *   node scripts/winres.js check-tray <exe>  the same for the tray helper (scripts/tray.js), whose
 *                                            version strings name gm-scriptorium-tray
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseVersion } = require('../src/update/semver');

const ROOT = path.join(__dirname, '..');
const ICO_PATH = path.join(ROOT, 'packaging', 'windows', 'gm-scriptorium.ico');
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');

// Resource type numbers (winuser.h).
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

const LANG_EN_US = 1033;
const CODEPAGE_UNICODE = 1200;
const NODE_RANGE = 'node22';

class WinresError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

/**
 * The eight string values, and nothing else. This replaces the whole table: no Node.js value
 * from the base binary survives.
 *
 * Kind 'tray' is the tray helper (ADR 0057, section 2): the same strings except its own internal
 * and original file names. scripts/tray.js writes them into the helper's version resource.
 * @param {string} version a semver string, e.g. "0.4.0-rc.3"
 * @param {'exe'|'tray'} [kind]
 * @returns {Record<string,string>}
 */
function versionStrings(version, kind = 'exe') {
  if (parseVersion(version) === null) throw new WinresError('bad-version', String(version));
  if (kind !== 'exe' && kind !== 'tray') throw new WinresError('bad-kind', String(kind));
  return {
    CompanyName: 'DrNoisys Softworks',
    FileDescription: 'GM-Scriptorium',
    FileVersion: version,
    InternalName: kind === 'tray' ? 'gm-scriptorium-tray' : 'gm-scriptorium',
    LegalCopyright: 'DrNoisys Softworks. MIT licence.',
    OriginalFilename: kind === 'tray' ? 'gm-scriptorium-tray-win-x64.exe' : 'gm-scriptorium-win-x64.exe',
    ProductName: 'GM-Scriptorium',
    ProductVersion: version,
  };
}

/**
 * The numeric version: major.minor.patch.0, always. A prerelease is not mapped into the fourth
 * field, because that would order a stable build below its own release candidates.
 * @param {string} version
 * @returns {[number, number, number, number]}
 */
function fixedVersion(version) {
  const v = parseVersion(version);
  if (v === null) throw new WinresError('bad-version', String(version));
  return [v.major, v.minor, v.patch, 0];
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The icon sizes in an .ico directory, read here by hand so the check does not trust resedit. */
function icoSizes(icoBytes) {
  const buf = Buffer.from(icoBytes);
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new WinresError('edit-failed', 'not an .ico file');
  }
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const w = buf[6 + i * 16];
    sizes.push(w === 0 ? 256 : w);
  }
  return sizes.sort((a, b) => a - b);
}

async function loadResedit() {
  return import('resedit');
}

/**
 * Finds the win-x64 base binary through pkg-fetch (PKG_NODE_PATH removed, so it is the stock
 * cached or downloaded base) and requires its sha256 to equal pkg-fetch's expected hash.
 * @returns {Promise<{ path: string, sha256: string }>}
 */
async function verifiedBase() {
  const saved = process.env.PKG_NODE_PATH;
  delete process.env.PKG_NODE_PATH;
  try {
    const fetch = require('@yao-pkg/pkg-fetch');
    const { EXPECTED_HASHES } = require('@yao-pkg/pkg-fetch/lib-es5/expected');
    const basePath = await fetch.need({ nodeRange: NODE_RANGE, platform: 'win', arch: 'x64' });
    const expected = EXPECTED_HASHES[`node-${fetch.getNodeVersion(NODE_RANGE)}-win-x64`];
    return { path: basePath, sha256: checkBaseHash(basePath, expected) };
  } finally {
    if (saved !== undefined) process.env.PKG_NODE_PATH = saved;
  }
}

/**
 * Throws base-hash unless the file's sha256 equals `expected`. Exported for its own test.
 * @returns {string} the sha256
 */
function checkBaseHash(file, expected) {
  const actual = sha256File(file);
  if (typeof expected !== 'string' || actual !== expected) {
    throw new WinresError('base-hash', `${file} is ${actual}, expected ${expected}`);
  }
  return actual;
}

/**
 * Writes a branded copy of `src` to `out`. Replaces every icon group, icon and version
 * resource; leaves the manifest alone. Never overwrites: `out` is opened with flag wx.
 * @param {{ src: string, out: string, icoPath?: string, version: string }} opts
 */
async function brandBase({ src, out, icoPath = ICO_PATH, version }) {
  const strings = versionStrings(version);
  const [major, minor, patch, rev] = fixedVersion(version);
  if (fs.existsSync(out)) throw new WinresError('out-exists', out);
  try {
    const ResEdit = await loadResedit();
    const exe = ResEdit.NtExecutable.from(fs.readFileSync(src), { ignoreCert: true });
    const res = ResEdit.NtExecutableResource.from(exe);
    res.entries = res.entries.filter((e) => e.type !== RT_ICON && e.type !== RT_GROUP_ICON && e.type !== RT_VERSION);

    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      LANG_EN_US,
      iconFile.icons.map((i) => i.data),
    );

    const ms = ((major << 16) | minor) >>> 0;
    const ls = ((patch << 16) | rev) >>> 0;
    const info = ResEdit.Resource.VersionInfo.create(LANG_EN_US, {
      fileVersionMS: ms,
      fileVersionLS: ls,
      productVersionMS: ms,
      productVersionLS: ls,
      fileFlagsMask: 0x3f,
      fileFlags: 0,
      fileOS: 0x40004, // VOS_NT_WINDOWS32
      fileType: 1, // VFT_APP
      fileSubtype: 0,
    }, [{ lang: LANG_EN_US, codepage: CODEPAGE_UNICODE, values: strings }]);
    info.outputToResourceEntries(res.entries);

    res.outputResource(exe);
    fs.writeFileSync(out, Buffer.from(exe.generate()), { flag: 'wx' });
  } catch (err) {
    if (err instanceof WinresError) throw err;
    throw new WinresError('edit-failed', err.message);
  }
}

/**
 * Reads the branding back out of an exe.
 * @param {string} exePath
 * @returns {Promise<{ strings: Record<string,string>[], fixed: number[][], iconGroups: number, iconSizes: number[], iconCount: number }>}
 *   `strings` and `fixed` have one entry per version resource found.
 */
async function readBranding(exePath) {
  const ResEdit = await loadResedit();
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const infos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const strings = [];
  const fixed = [];
  for (const info of infos) {
    const merged = {};
    for (const lang of info.getAllLanguagesForStringValues()) Object.assign(merged, info.getStringValues(lang));
    strings.push(merged);
    const f = info.fixedInfo;
    fixed.push([f.fileVersionMS >>> 16, f.fileVersionMS & 0xffff, f.fileVersionLS >>> 16, f.fileVersionLS & 0xffff]);
  }
  const iconSizes = [];
  for (const g of groups) for (const i of g.icons) iconSizes.push(i.width === 0 ? 256 : i.width);
  return {
    strings,
    fixed,
    iconGroups: groups.length,
    iconSizes: iconSizes.sort((a, b) => a - b),
    iconCount: res.entries.filter((e) => e.type === RT_ICON).length,
  };
}

/**
 * Judges a branding read against what package.json's version should have produced.
 * @param {'exe'|'tray'} [kind] which set of version strings to expect (see versionStrings)
 * @returns {string|null} a failure reason, or null when it passes
 */
function judge(branding, version, expectedSizes, kind = 'exe') {
  if (branding.iconGroups !== 1) return `icon-groups=${branding.iconGroups}`;
  if (JSON.stringify(branding.iconSizes) !== JSON.stringify(expectedSizes)) {
    return `icon-sizes=${branding.iconSizes.join(',')}`;
  }
  if (branding.iconCount !== expectedSizes.length) return `icon-count=${branding.iconCount}`;
  if (branding.strings.length !== 1) return `version-resources=${branding.strings.length}`;
  const want = versionStrings(version, kind);
  const got = branding.strings[0];
  if (JSON.stringify(Object.keys(got).sort()) !== JSON.stringify(Object.keys(want).sort())) {
    return `version-keys=${Object.keys(got).sort().join(',')}`;
  }
  for (const k of Object.keys(want)) {
    if (got[k] !== want[k]) return `version-value-${k}`;
  }
  for (const v of Object.values(got)) {
    if (v.includes('Node.js')) return 'node-js-string';
  }
  if (JSON.stringify(branding.fixed[0]) !== JSON.stringify(fixedVersion(version))) return 'fixed-version';
  return null;
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version;
}

async function main(argv) {
  const [cmd, target] = argv;
  if (cmd === 'brand' && target) {
    try {
      const base = await verifiedBase();
      await brandBase({ src: base.path, out: path.resolve(target), version: packageVersion() });
      console.log(`WINRES base=${base.path} base_sha256=${base.sha256} out=${path.resolve(target)}`);
      return 0;
    } catch (err) {
      console.log(`FAIL ${err.reason || 'edit-failed'} ${err.message}`);
      return 1;
    }
  }
  if ((cmd === 'check' || cmd === 'check-tray') && target) {
    try {
      const branding = await readBranding(target);
      const kind = cmd === 'check-tray' ? 'tray' : 'exe';
      const reason = judge(branding, packageVersion(), icoSizes(fs.readFileSync(ICO_PATH)), kind);
      if (reason) {
        console.log(`WINRES-CHECK fail reason=${reason}`);
        return 1;
      }
      console.log(`WINRES-CHECK ok icons=${branding.iconSizes.length} strings=${Object.keys(branding.strings[0]).length}`);
      return 0;
    } catch (err) {
      console.log(`WINRES-CHECK fail reason=unreadable (${err.message})`);
      return 1;
    }
  }
  console.error('usage: node scripts/winres.js brand <outPath> | check <exe> | check-tray <exe>');
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = {
  versionStrings,
  fixedVersion,
  checkBaseHash,
  brandBase,
  readBranding,
  judge,
  icoSizes,
  verifiedBase,
  ICO_PATH,
  WinresError,
};
