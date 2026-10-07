'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ScriptoriumError, VaultUnreachableError } = require('../util/errors');

/*
 * Section 3 of the Engineering Brief: build() resolves outputDir from the
 * user's own vault.config.json and takes no override, so the only way to
 * control where it writes is a synthesised config file. That synthesised
 * config's outputDir is a STAGING directory; the real output only becomes
 * `finalOut` on a successful swap (src/build/swap.js).
 */

/*
 * Shared directory-identity comparison for assertSafeOutputDir (below) and
 * siteConfigOutputDirCollision (further down). A bare `path.resolve(a) ===
 * path.resolve(b)` (both guards' original form) misses two real ways two
 * lexically-different path strings are the SAME physical directory, found
 * by the Reviewer testing the edges directly rather than reasoning about
 * them: a symlink, and a pure case difference on a case-insensitive
 * filesystem. This matters more than a normal edge case here specifically
 * because assertSafeOutputDir's vault-containment refusal and
 * siteConfigOutputDirCollision's baseline-overwrite refusal both exist to
 * protect a real deployment whose frozen acceptance baseline lives on a
 * Windows share — and Windows (and default-configured macOS) filesystems
 * are case-insensitive by default.
 *
 * - Symlinks: `fs.realpathSync` collapses a symlink to its physical target
 *   before comparing. It throws when the path does not exist yet, which is
 *   a completely normal state for an output directory that has not been
 *   built into — that case falls back to the lexical `path.resolve()` form
 *   instead of the real path, deliberately, not by omission.
 * - Case: filesystem case-sensitivity is a property of the *volume*, not
 *   the platform, so `process.platform` is only a proxy for it. It is
 *   evaluated fresh on every call (not cached at module load) specifically
 *   so it can be forced in tests. The fold is applied only to the
 *   comparison, never to a path used in an error message, so refusal text
 *   always echoes what the user actually typed/resolved to.
 *
 * What this still cannot see (residual limits, written down rather than
 * left for the next person to rediscover by testing):
 *
 * - A case-sensitive volume mounted on win32/darwin (an ext4 image, a
 *   case-sensitive APFS volume, etc.): folded anyway, because this only has
 *   `process.platform` to go on, not the actual volume's mount options.
 *   Two directories that differ only by case on such a volume would be
 *   wrongly reported as colliding — a false positive, but the safer
 *   direction to be wrong in for a guard whose job is refusing a write.
 * - A case-insensitive mount on linux (vfat/exfat/ntfs-3g, a
 *   case-insensitive overlay, etc.): NOT folded, because `process.platform`
 *   reads `'linux'`. Two directories that differ only by case on such a
 *   mount are not detected as the same directory. This is the honest
 *   residual version of the original fail-open gap, narrowed from "every
 *   platform" to "a case-insensitive mount on a platform whose default is
 *   case-sensitive" — not eliminated.
 * - Hardlinks, bind mounts, and any other same-target-different-path
 *   construction that is not a plain symlink: `fs.realpathSync` only
 *   resolves symlink components.
 * - A directory created (or turned into a symlink) after this check runs
 *   but before the build actually writes to it: this is a point-in-time
 *   check, not a lock.
 */
function realOrLexicalPath(resolved) {
  try {
    // Exists on disk (possibly via a symlink): the physical target.
    return fs.realpathSync(resolved);
  } catch {
    // Not on disk yet, or unreadable: no symlink information to resolve,
    // so the best available signal is the lexical form itself.
    return resolved;
  }
}

function caseFoldedForComparison(resolvedOrRealPath) {
  const foldCase = process.platform === 'win32' || process.platform === 'darwin';
  return foldCase ? resolvedOrRealPath.toLowerCase() : resolvedOrRealPath;
}

/** @returns {boolean} true when `a` and `b` refer to the same directory (see limits above). */
function sameDirectory(a, b) {
  const realA = realOrLexicalPath(path.resolve(a));
  const realB = realOrLexicalPath(path.resolve(b));
  return caseFoldedForComparison(realA) === caseFoldedForComparison(realB);
}

/*
 * Issue #23: the containment (prefix) half of the same fail-open gap
 * 5d8dfb5 closed for the equality half above. sameDirectory() cannot be
 * reused as-is: it realpaths a WHOLE path in one shot, which only works
 * because both its callers compare two complete paths. A containment
 * check's target (`finalOut`) routinely does not exist on disk yet — that
 * is the normal, expected state for an output directory nobody has built
 * into — so there is nothing at the full path for a single realpathSync to
 * resolve. The fix has to walk up to the longest ancestor that DOES exist,
 * collapse symlinks only up to there, and rejoin the not-yet-created
 * remainder onto the result before comparing prefixes.
 */

/**
 * Longest-existing-ancestor real path, plus the not-yet-created remainder
 * rejoined onto it. Uses the identical throw-and-fall-back primitive as
 * realOrLexicalPath above, at every level of the walk instead of just once:
 * fs.realpathSync throws the same way on "does not exist at all" and on a
 * dangling symlink (a path segment that exists as a link but whose target
 * does not), so an ancestor that is a dangling symlink is treated as
 * not-yet-resolvable here and the walk continues past it to ITS parent —
 * the same honest fallback sameDirectory already relies on for a whole
 * path, not a new gap introduced by this function. The walk always
 * terminates: a filesystem root always exists.
 *
 * @param {string} resolved an already-path.resolve()d path
 * @returns {string}
 */
function containmentPath(resolved) {
  let candidate = resolved;
  const remainder = [];
  for (;;) {
    try {
      const real = fs.realpathSync(candidate);
      return remainder.length === 0 ? real : path.join(real, ...remainder);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        // Not even the root resolved (should not happen in practice) —
        // fail to the fully lexical form rather than looping forever.
        return remainder.length === 0 ? candidate : path.join(candidate, ...remainder);
      }
      remainder.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * @param {string} vaultPath absolute
 * @param {string} finalOut absolute, from Scriptorium's own config
 * @throws {ScriptoriumError} if finalOut is unsafe
 */
function assertSafeOutputDir(vaultPath, finalOut) {
  const resolvedOut = path.resolve(finalOut);
  const resolvedVault = path.resolve(vaultPath);
  const root = path.parse(resolvedOut).root;

  if (resolvedOut === root) {
    throw new VaultUnreachableError(`refusing to build into a filesystem root: ${resolvedOut}`, { path: resolvedOut, campaign: null, reason: 'bad-output' });
  }

  // Symlink- and case-aware prefix comparison (issue #23), reusing the same
  // caseFoldedForComparison() platform-proxy fold sameDirectory() uses
  // above, rather than a second, possibly-diverging implementation of it.
  // Residual limits: identical to sameDirectory's own (see its comment
  // block above) — a case-sensitive volume mounted on a fold-on platform,
  // a case-insensitive mount on a fold-off platform, hardlinks/bind
  // mounts, a directory that changes shape after this check runs, and (new
  // here) a dangling symlink ancestor's would-be target, which is never
  // resolved (containmentPath's own comment). Written down rather than
  // left for the next person to rediscover by testing.
  const outContainment = caseFoldedForComparison(containmentPath(resolvedOut));
  const vaultContainment = caseFoldedForComparison(containmentPath(resolvedVault));

  if (sameDirectory(resolvedOut, resolvedVault) || vaultContainment.startsWith(outContainment + path.sep)) {
    throw new VaultUnreachableError(`refusing to build into an output dir that contains the vault: ${resolvedOut}`, {
      path: resolvedOut,
      campaign: null,
      reason: 'bad-output',
    });
  }
  if (outContainment.startsWith(vaultContainment + path.sep)) {
    throw new VaultUnreachableError(`refusing to build inside the vault: ${resolvedOut}`, { path: resolvedOut, campaign: null, reason: 'bad-output' });
  }
}

/**
 * The staging directory is a SIBLING of finalOut, never %TEMP%/os.tmpdir():
 * a temp dir is routinely on a different volume than a network-mapped
 * output drive, and a cross-volume rename fails EXDEV, which would break
 * the atomic swap entirely.
 */
function stagingDirFor(finalOut) {
  const resolvedOut = path.resolve(finalOut);
  const parent = path.dirname(resolvedOut);
  const stamp = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const stagingRoot = path.join(parent, `.scriptorium-build-${stamp}`);
  return { stagingRoot, stagingOut: path.join(stagingRoot, 'out') };
}

function assertSameVolume(a, b) {
  if (path.parse(a).root !== path.parse(b).root) {
    throw new ScriptoriumError(`staging directory is not on the same volume as the output dir: ${a} vs ${b}`);
  }
}

/**
 * @returns {{ finalOut: string, stagingRoot: string, stagingOut: string }}
 */
function planBuild(vaultPath, finalOutInput) {
  const finalOut = path.resolve(finalOutInput);
  assertSafeOutputDir(vaultPath, finalOut);
  const { stagingRoot, stagingOut } = stagingDirFor(finalOut);
  assertSameVolume(finalOut, stagingRoot);
  return { finalOut, stagingRoot, stagingOut };
}

/*
 * Issue #21, defect 1: the site config a user hand-writes (vault.config.json,
 * loaded by src/cli/check.js's loadSiteConfig) carries its own `outputDir`,
 * which is the directory the underlying generator would write to if it ran
 * standalone against that config. Scriptorium's own build NEVER reads that
 * field to pick `finalOut` (see the module comment above: finalOut always
 * comes from Scriptorium's own resolved `output`, via src/cli/args.js), so
 * the site config's `outputDir` is purely documentary as far as Scriptorium
 * is concerned. But it is frequently ALSO where a real user genuinely wants
 * the generator's output to end up (it is the site's own declared publish
 * location), so a campaign whose Scriptorium `output` happens to equal it
 * is a perfectly legitimate setup, not a mistake by construction.
 *
 * The dangerous case is the one where the two happen to coincide without
 * the user having deliberately chosen that outcome for THIS run — e.g. a
 * shared or copy-pasted config where `output` was never set to a scratch
 * location. Landing there overwrites whatever already occupies it, which
 * for at least one real deployment is a frozen acceptance-test baseline
 * that other processes hash and compare byte-for-byte.
 *
 * This is not made an absolute refusal (unlike assertSafeOutputDir's
 * vault-containment checks above, which are never legitimate and so are
 * never overridable): src/cli/build.js treats a match as a refusal
 * overridable by --force, the same lever it already uses for check-error
 * and output-leak-scan refusals. That keeps the "I genuinely want to
 * publish here" path open (rerun with --force) while a plain `build`
 * still needs the user to say so deliberately, every time.
 */

/**
 * @param {string} finalOut absolute, Scriptorium's own resolved output for this build
 * @param {string} siteConfigDir absolute, the directory the site config file lives in
 * @param {string} [siteOutputDir] the site config's own `outputDir` field, verbatim
 *   (relative to siteConfigDir, or absent)
 * @returns {string|null} the resolved site-config output dir, only when it refers to
 *   the same directory as finalOut (see sameDirectory above for what "same" catches
 *   and what it still cannot); null when there is nothing to compare (no siteOutputDir)
 *   or no match
 */
function siteConfigOutputDirCollision(finalOut, siteConfigDir, siteOutputDir) {
  if (!siteOutputDir) return null;
  const resolvedSiteOut = path.resolve(siteConfigDir, siteOutputDir);
  return sameDirectory(resolvedSiteOut, finalOut) ? resolvedSiteOut : null;
}

module.exports = { assertSafeOutputDir, stagingDirFor, assertSameVolume, planBuild, siteConfigOutputDirCollision };
