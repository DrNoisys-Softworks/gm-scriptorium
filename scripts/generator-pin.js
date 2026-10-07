#!/usr/bin/env node
'use strict';

/*
 * The integrity anchor for the vendored gm-apprentice-publish pin
 * (docs/decisions/0005-generator-pin.md). vendor/gm-apprentice-publish/PIN.json
 * records every shipped file's sha256, keyed by package-relative POSIX path,
 * plus a single treeSha256 that is independent of npm and gzip versions (it
 * hashes sorted "<hex>  <path>\n" lines, sorted by path bytes, matching
 * `LC_ALL=C sort`), so a fresh clone of the pin reproduces it exactly
 * (DEP-AC-01).
 *
 * Pin source (FR-16/SD-1, as ruled in
 * docs/agent-runs/repin-v1.11.40-sd1-ruling-2026-09-30.md): the vendored
 * artefact is the upstream *release tarball*, not a source-tree `npm pack`.
 * `derivePinFromTree` derives PIN.json straight from the extracted release,
 * with no omit rules, refusing to write unless two things both hold: the
 * tarball's sha256 matches its SHA256SUMS entry, and the extracted release
 * tree is byte-identical to a reproducible-build cross-check tree (a fresh
 * checkout, `npm ci --ignore-scripts`, then `npm pack`, extracted). A plain
 * checkout's `npm pack` is NOT authoritative for the cross-check: without a
 * hidden `node_modules/.package-lock.json`, npm applies each bundled
 * dependency's own `package.json` `files` allowlist and silently drops
 * anything not listed (e.g. changelogs) -- npm's own packing behaviour, not
 * a difference in the artefact. See the ADR 0005 addendum for the full
 * mechanism and citations.
 *
 * Entry points:
 *   manifestOf(dir) -> hashes every file under dir.
 *   verifyInstalled(...) -> compares the installed node_modules/
 *     gm-apprentice-publish tree, its vendored tarball, package.json's
 *     dependency spec, and package-lock.json's resolved entry against
 *     vendor/.../PIN.json, including the cross-check record.
 *   parseSha256Sums(text) -> parses a SHA256SUMS file (our own parser; never
 *     requires upstream code).
 *   derivePinFromTree(...) -> re-derives a PIN object from an extracted
 *     release tarball, refusing to write on any mismatch.
 *   verifyTarball(...) -> the tarball/SHA256SUMS half of verifyInstalled's
 *     checks, usable standalone.
 *
 * CLI: node scripts/generator-pin.js verify
 *      node scripts/generator-pin.js derive --tree <dir> --cross-check-tree <dir>
 *        --tarball <path> --sums <path> --commit <sha> --tag <tag>
 *        --package-version <version> --cross-check-method <method>
 *        --npm-version <version> [--out <path>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_GENERATOR_DIR = path.join(REPO_ROOT, 'node_modules', 'gm-apprentice-publish');
const DEFAULT_VENDOR_DIR = path.join(REPO_ROOT, 'vendor', 'gm-apprentice-publish');
const DEFAULT_PIN_PATH = path.join(DEFAULT_VENDOR_DIR, 'PIN.json');
const DEFAULT_PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const DEFAULT_LOCK_PATH = path.join(REPO_ROOT, 'package-lock.json');
const REQUIRED_CROSS_CHECK_METHOD = 'npm-ci-pack';

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function sha256String(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/** Every regular file under dir, as posix-relative paths. Symlinks are not followed or recorded. */
function listAllFiles(dir) {
  const out = [];
  (function walk(current, relPrefix) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        out.push(toPosix(rel));
      }
    }
  })(dir, '');
  return out;
}

/**
 * @param {string} dir
 * @param {object} [opts]
 * @param {Array<{match: (posixRel: string) => boolean}>} [opts.omit]
 * @returns {{ files: Object<string, string>, treeSha256: string }}
 */
function manifestOf(dir, { omit = [] } = {}) {
  const files = {};
  for (const rel of listAllFiles(dir)) {
    if (omit.some((o) => o.match(rel))) continue;
    files[rel] = sha256File(path.join(dir, ...rel.split('/')));
  }
  const treeSha256 = treeSha256Of(files);
  return { files, treeSha256 };
}

/** sha256 of sorted "<hex>  <path>\n" lines, sorted by path bytes (matches `LC_ALL=C sort`). */
function treeSha256Of(files) {
  const paths = Object.keys(files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const body = paths.map((p) => `${files[p]}  ${p}\n`).join('');
  return sha256String(body);
}


/**
 * @param {object} [opts]
 * @param {string} [opts.generatorDir]
 * @param {string} [opts.pinPath]
 * @param {string} [opts.packageJsonPath]
 * @param {string} [opts.lockPath]
 * @returns {{ ok: boolean, problems: string[] }}
 */
function verifyInstalled({
  generatorDir = DEFAULT_GENERATOR_DIR,
  pinPath = DEFAULT_PIN_PATH,
  packageJsonPath = DEFAULT_PACKAGE_JSON_PATH,
  lockPath = DEFAULT_LOCK_PATH,
  vendorDir = DEFAULT_VENDOR_DIR,
} = {}) {
  const problems = [];

  let pin;
  try {
    pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  } catch (err) {
    return { ok: false, problems: [`cannot read/parse PIN.json at ${pinPath}: ${err.message}`] };
  }

  if (typeof pin.commit !== 'string' || !/^[0-9a-f]{40}$/.test(pin.commit)) {
    problems.push(`PIN.json commit "${pin.commit}" is not a 40-character hex SHA`);
  }

  // FR-16 (SD-1 ruling): the vendored tarball's sha256, cross-checked against SHA256SUMS.
  if (pin.tarball) {
    const { problems: tarballProblems } = verifyTarball({
      pin,
      tarballPath: path.join(vendorDir, pin.tarball),
      sumsPath: path.join(vendorDir, pin.sums || 'SHA256SUMS'),
    });
    problems.push(...tarballProblems);
  }

  // FR-16 (SD-1 ruling): the reproducible-build cross-check record. verifyInstalled never repeats
  // the cross-check itself (it needs the network and only happens when the pin moves); it only
  // fails closed if PIN.json doesn't carry a passing one.
  if (!pin.crossCheck) {
    problems.push('PIN.json has no crossCheck record (fail closed)');
  } else {
    if (pin.crossCheck.method !== REQUIRED_CROSS_CHECK_METHOD) {
      problems.push(
        `crossCheck.method is "${pin.crossCheck.method}", expected "${REQUIRED_CROSS_CHECK_METHOD}"`,
      );
    }
    if (pin.crossCheck.treeSha256 !== pin.treeSha256) {
      problems.push(
        `crossCheck.treeSha256 ("${pin.crossCheck.treeSha256}") does not match PIN.json's own treeSha256 ("${pin.treeSha256}")`,
      );
    }
  }

  if (!fs.existsSync(generatorDir)) {
    problems.push(`installed generator directory is missing: ${generatorDir}`);
  } else {
    const { files, treeSha256 } = manifestOf(generatorDir);
    const pinFiles = pin.files || {};
    const installedPaths = new Set(Object.keys(files));
    const pinPaths = new Set(Object.keys(pinFiles));

    for (const p of pinPaths) {
      if (!installedPaths.has(p)) {
        problems.push(`missing file: ${p}`);
      } else if (files[p] !== pinFiles[p]) {
        problems.push(`changed file (sha256 mismatch): ${p}`);
      }
    }
    for (const p of installedPaths) {
      if (!pinPaths.has(p)) {
        problems.push(`extra file not recorded in PIN.json: ${p}`);
      }
    }
    if (treeSha256 !== pin.treeSha256) {
      problems.push(`treeSha256 mismatch: installed tree hashes to ${treeSha256}, PIN.json records ${pin.treeSha256}`);
    }
  }

  const expectedTarball = pin.tarball;
  const expectedSpec = expectedTarball ? `file:vendor/gm-apprentice-publish/${expectedTarball}` : null;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const spec = packageJson.dependencies && packageJson.dependencies['gm-apprentice-publish'];
    if (!expectedSpec) {
      problems.push('PIN.json has no tarball field to check package.json against');
    } else if (spec !== expectedSpec) {
      problems.push(
        `package.json dependencies["gm-apprentice-publish"] is "${spec}", expected "${expectedSpec}"`,
      );
    }
  } catch (err) {
    problems.push(`cannot read/parse package.json at ${packageJsonPath}: ${err.message}`);
  }

  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const entry = lock.packages && lock.packages['node_modules/gm-apprentice-publish'];
    if (!entry) {
      problems.push('package-lock.json has no packages["node_modules/gm-apprentice-publish"] entry');
    } else {
      if (!expectedSpec) {
        problems.push('PIN.json has no tarball field to check package-lock.json against');
      } else if (entry.resolved !== expectedSpec) {
        problems.push(
          `package-lock.json entry "resolved" is "${entry.resolved}", expected "${expectedSpec}"`,
        );
      }
      const expectedVersion = pin.labels && pin.labels.packageVersion;
      if (expectedVersion && entry.version !== expectedVersion) {
        problems.push(
          `package-lock.json entry "version" is "${entry.version}", expected "${expectedVersion}"`,
        );
      }
    }
  } catch (err) {
    problems.push(`cannot read/parse package-lock.json at ${lockPath}: ${err.message}`);
  }

  return { ok: problems.length === 0, problems };
}

/*
 * FR-16 (docs/agent-runs/repin-v1.11.40-engineering-brief-2026-09-30.md, SD-1, amended by
 * docs/agent-runs/repin-v1.11.40-sd1-ruling-2026-09-30.md): the release-tarball pin source and its
 * reproducible-build cross-check (see the module-doc note above).
 */

/**
 * Parses a SHA256SUMS file: lines of `<64 hex>  <name>` (text mode) or `<64 hex> *<name>`
 * (binary mode). Blank lines are skipped. Never requires upstream code.
 * @param {string} text
 * @returns {Map<string, string>} filename -> lowercase hex sha256
 */
function parseSha256Sums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([0-9a-fA-F]{64})[ \t](?:[ \t]|\*)(.+)$/.exec(line);
    if (!m) continue;
    map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

/**
 * Derives a PIN.json object from an extracted release tarball tree, refusing to write on any
 * mismatch (SD-1). Never writes to disk itself -- the caller decides whether/where to persist the
 * result.
 * @param {object} opts
 * @param {string} opts.tree the extracted tarball's package/ directory
 * @param {string} opts.crossCheckTree a reproducible-build tree at the same commit, extracted
 *   (SD-1 ruling: `npm ci --ignore-scripts` then `npm pack`, NOT a plain-checkout pack)
 * @param {string} opts.tarballPath the vendored .tgz
 * @param {string} opts.sumsPath the vendored SHA256SUMS
 * @param {string} opts.commit 40-char SHA
 * @param {string} opts.tag label only (publish-v* is immutable per upstream, but still a label)
 * @param {string} opts.packageVersion label only
 * @param {string} opts.crossCheckMethod required; e.g. "npm-ci-pack". Refuses without it.
 * @param {string} [opts.npmVersion] recorded in the pin's crossCheck for provenance
 * @throws {Error} with an `.problems` array, and writes nothing, on any mismatch
 * @returns {object} a PIN.json object (no `omitted` key -- SD-1 drops the omit-rule model entirely)
 */
function derivePinFromTree({
  tree,
  crossCheckTree,
  tarballPath,
  sumsPath,
  commit,
  tag,
  packageVersion,
  crossCheckMethod,
  npmVersion,
}) {
  const problems = [];

  if (!crossCheckMethod) {
    problems.push(
      'no --cross-check-method given: the SD-1 ruling requires a named, reproducible-build cross-check method (npm-ci-pack), never an implicit one',
    );
    const err = new Error(`derivePinFromTree refused: ${problems.join('; ')}`);
    err.problems = problems;
    throw err;
  }

  const tarballName = path.basename(tarballPath);
  const actualTarballSha = sha256File(tarballPath);
  const sums = parseSha256Sums(fs.readFileSync(sumsPath, 'utf8'));
  const sumsEntry = sums.get(tarballName);
  if (!sumsEntry) {
    problems.push(`SHA256SUMS has no entry for ${tarballName}`);
  } else if (sumsEntry !== actualTarballSha) {
    problems.push(
      `tarball sha256 mismatch: ${tarballPath} hashes to ${actualTarballSha}, SHA256SUMS records ${sumsEntry}`,
    );
  }

  const treeManifest = manifestOf(tree);
  const crossManifest = manifestOf(crossCheckTree);
  const treePaths = new Set(Object.keys(treeManifest.files));
  const crossPaths = new Set(Object.keys(crossManifest.files));
  const onlyInTree = [...treePaths].filter((p) => !crossPaths.has(p)).sort();
  const onlyInCross = [...crossPaths].filter((p) => !treePaths.has(p)).sort();
  if (onlyInTree.length || onlyInCross.length) {
    problems.push(
      `cross-check tree mismatch: ${onlyInTree.length} path(s) only in --tree, ` +
        `${onlyInCross.length} path(s) only in --cross-check-tree ` +
        `(e.g. ${[...onlyInTree, ...onlyInCross].slice(0, 5).join(', ')})`,
    );
  } else if (treeManifest.treeSha256 !== crossManifest.treeSha256) {
    problems.push(
      `cross-check tree mismatch: same paths, different content ` +
        `(tree ${treeManifest.treeSha256} vs cross-check ${crossManifest.treeSha256})`,
    );
  }

  if (problems.length > 0) {
    const err = new Error(`derivePinFromTree refused: ${problems.join('; ')}`);
    err.problems = problems;
    throw err;
  }

  return {
    repository: 'https://github.com/AntTheLimey/gm-apprentice',
    path: 'tools/publish',
    commit,
    labels: { tag, packageVersion },
    source: {
      kind: 'release-tarball',
      url: `https://github.com/AntTheLimey/gm-apprentice/releases/download/${tag}/${tarballName}`,
    },
    tarball: tarballName,
    tarballSha256: actualTarballSha,
    sums: path.basename(sumsPath),
    crossCheck: { method: crossCheckMethod, npmVersion, treeSha256: crossManifest.treeSha256 },
    files: treeManifest.files,
    treeSha256: treeManifest.treeSha256,
  };
}

/**
 * Verifies a vendored tarball against a PIN.json that carries `tarballSha256`/`sums` (the new,
 * release-tarball pin shape). Fails closed: a PIN.json missing either field is a problem, not a
 * pass. Independent of `verifyInstalled`'s installed-tree check; not yet called by it (see the
 * module-doc note above this section).
 * @param {object} opts
 * @param {object} opts.pin a parsed PIN.json
 * @param {string} opts.tarballPath the vendored .tgz
 * @param {string} opts.sumsPath the vendored SHA256SUMS
 * @returns {{ ok: boolean, problems: string[] }}
 */
function verifyTarball({ pin, tarballPath, sumsPath }) {
  const problems = [];
  if (!pin.tarballSha256) problems.push('PIN.json has no tarballSha256 (fail closed)');
  if (!pin.sums) problems.push('PIN.json has no sums field (fail closed)');
  if (problems.length > 0) return { ok: false, problems };

  let actualSha;
  try {
    actualSha = sha256File(tarballPath);
  } catch (err) {
    return { ok: false, problems: [`cannot read tarball at ${tarballPath}: ${err.message}`] };
  }
  if (actualSha !== pin.tarballSha256) {
    problems.push(
      `tarball sha256 differs from PIN.json.tarballSha256: ${tarballPath} hashes to ${actualSha}, expected ${pin.tarballSha256}`,
    );
  }

  let sumsText;
  try {
    sumsText = fs.readFileSync(sumsPath, 'utf8');
  } catch (err) {
    problems.push(`cannot read SHA256SUMS at ${sumsPath}: ${err.message}`);
    return { ok: false, problems };
  }
  const tarballName = path.basename(tarballPath);
  const sumsEntry = parseSha256Sums(sumsText).get(tarballName);
  if (!sumsEntry) {
    problems.push(`SHA256SUMS has no entry for ${tarballName}`);
  } else if (sumsEntry !== pin.tarballSha256) {
    problems.push(
      `SHA256SUMS entry for ${tarballName} (${sumsEntry}) differs from PIN.json.tarballSha256 (${pin.tarballSha256})`,
    );
  }

  return { ok: problems.length === 0, problems };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const subcommand = args._[0];

  if (subcommand === 'verify') {
    const { ok, problems } = verifyInstalled();
    if (ok) {
      console.log('generator-pin: OK, installed tree matches PIN.json');
      process.exitCode = 0;
    } else {
      console.error('generator-pin: FAILED');
      for (const p of problems) console.error(`  - ${p}`);
      process.exitCode = 1;
    }
    return;
  }

  // FR-16 (SD-1, ruled): the release-tarball pin source, cross-checked against a reproducible
  // build (npm-ci-pack). This is the only derive path; the old source-tree/--source flow is gone.
  if (subcommand === 'derive') {
    if (
      !args.tree || !args['cross-check-tree'] || !args.tarball || !args.sums || !args.commit ||
      !args.tag || !args['package-version'] || !args['cross-check-method']
    ) {
      console.error('usage: generator-pin.js derive --tree <dir> --cross-check-tree <dir> ' +
        '--tarball <path> --sums <path> --commit <sha> --tag <tag> --package-version <version> ' +
        '--cross-check-method <method> [--npm-version <version>] [--out <path>]');
      process.exitCode = 1;
      return;
    }
    let pin;
    try {
      pin = derivePinFromTree({
        tree: path.resolve(args.tree),
        crossCheckTree: path.resolve(args['cross-check-tree']),
        tarballPath: path.resolve(args.tarball),
        sumsPath: path.resolve(args.sums),
        commit: args.commit,
        tag: args.tag,
        packageVersion: args['package-version'],
        crossCheckMethod: args['cross-check-method'],
        npmVersion: args['npm-version'],
      });
    } catch (err) {
      console.error(`generator-pin: derive refused: ${err.message}`);
      process.exitCode = 1;
      return;
    }

    const text = JSON.stringify(pin, null, 2) + '\n';
    if (args.out) {
      fs.writeFileSync(path.resolve(args.out), text);
      console.log(`wrote ${path.resolve(args.out)}`);
      console.log(`treeSha256: ${pin.treeSha256}`);
    } else {
      process.stdout.write(text);
    }
    return;
  }

  console.error('usage: generator-pin.js <verify|derive> [options]');
  process.exitCode = 1;
}

if (require.main === module) {
  runCli();
}

module.exports = {
  manifestOf,
  verifyInstalled,
  treeSha256Of,
  parseSha256Sums,
  derivePinFromTree,
  verifyTarball,
};
