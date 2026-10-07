'use strict';

const fs = require('fs');
const path = require('path');
const { stripObsidianComments } = require('../vault/comments');
const { installSegmenterShim } = require('./intl-shim');
const { applyRedactions, redactionReport } = require('./redactions');
// FR-19/SD-19: install at module load too, alongside src/generator/pinned.js's own install --
// this module calls the pin's build() directly (below), not through the facade, and that call
// site needs the guard live before `require('gm-apprentice-publish')` pulls in any of its lib/
// files that touch `fetch`. installNetworkGuard() is idempotent, so whichever of the two modules
// loads first performs the real install.
const { installNetworkGuard } = require('./netguard');
installNetworkGuard();

// ADR 0034 / FR-FM-03, SD-4: this module calls the pin's build() directly (runGeneratorBuild
// below), not through the facade, so it needs the frontmatter engine guard live independently of
// whether anything has required src/generator/pinned.js yet -- the same reasoning as the
// installNetworkGuard() call just above. Requiring pinned.js here already runs its own install
// and self-check at module load (facade load order); this explicit, idempotent second call
// follows the netguard double-install pattern so a child process that requires ONLY
// bootstrap.js (never pinned.js directly) still ends up guarded, proven, and self-checked.
const pinned = require('./pinned');
const fmguard = require('./fmguard');
fmguard.installFrontmatterEngineGuard(pinned.generatorGrayMatter);

/*
 * The pkg copyFileSync shim, the Intl.Segmenter shim, and the console
 * capture around gm-apprentice-publish's build(). This is Scriptorium's
 * own bootstrap code: it wraps the Node fs API, Intl.Segmenter and
 * console, and it requires the pinned dependency; it does not fork, patch,
 * or vendor-modify gm-apprentice-publish itself (Engineering Brief section
 * 14).
 *
 * See docs/decisions/0001-packager.md: @yao-pkg/pkg 6.22.0 already patches
 * fs.copyFileSync to be snapshot-aware, so this shim is defense in depth
 * rather than a fix for an observed failure, kept per the brief's explicit
 * instruction to close the risk in Scriptorium's own bootstrap.
 *
 * See docs/decisions/0005-generator-pin.md ("Packaging findings resolved,
 * DEP-a2") and node_modules/@yao-pkg/pkg/prelude/bootstrap-shared.js:380-433
 * for why the Intl.Segmenter shim exists: pkg's small-icu base binaries
 * ship no break-iterator data, and the pinned generator's grapheme
 * counting (lib/unicode.js:75) would otherwise risk pkg's own uncatchable
 * SIGSEGV. installSegmenterShim() only patches anything when that risk is
 * actually present (src/generator/intl-shim.js's segmenterDataMissing()
 * gate); in plain node it is a no-op.
 *
 * This install is scoped to runGeneratorBuild's own direct
 * gm-apprentice-publish `build()` call (installed/restored around it,
 * same as the copyFileSync shim above). It does NOT cover
 * src/checks/leak/outputscan.js's separate call into `truncateGraphemes`
 * via src/generator/pinned.js — that path never runs `build()` and, on
 * `build`, runs AFTER this function's `finally` has already restored
 * native Intl.Segmenter. src/generator/pinned.js installs the same shim
 * independently, unconditionally, at its own module load, so that path
 * (and every other consumer of the facade) is covered without depending on
 * this function ever having run first. See docs/decisions/0005-generator-pin.md's
 * D2 coverage addendum.
 */

const SNAPSHOT_PREFIX_POSIX = '/snapshot/';
const SNAPSHOT_PREFIX_WIN_RE = /^[A-Za-z]:\\snapshot\\/;

function isInsideSnapshot(resolvedPath) {
  if (typeof process.pkg === 'undefined') return false;
  return resolvedPath.startsWith(SNAPSHOT_PREFIX_POSIX) || SNAPSHOT_PREFIX_WIN_RE.test(resolvedPath);
}

function installCopyFileShim() {
  const original = fs.copyFileSync;
  fs.copyFileSync = function patchedCopyFileSync(src, dest, mode) {
    const resolvedSrc = path.resolve(String(src));
    if (isInsideSnapshot(resolvedSrc)) {
      fs.writeFileSync(dest, fs.readFileSync(src));
      return undefined;
    }
    return original.call(fs, src, dest, mode);
  };
  return function restore() {
    fs.copyFileSync = original;
  };
}

/**
 * ADR 0044 builds on ADR 0043's shim. The read shim is one generic mechanism with an ordered list of
 * text transforms; each transform is independent. The build installs READ_TRANSFORMS_FOR_BUILD,
 * which is now only the Obsidian comment strip (a leak guard).
 *
 * The escaped-pipe rewrite (ADR 0043, issue #48) that used to ride along is retired at publish-v1.14.0:
 * the pin has read a table-cell `[[T\|L]]` itself since publish-v1.12.3 (`lib/wikilink.js`), so the
 * rewrite only double-applied. `check`'s own reader keeps its rewrite (src/vault/links.js).
 */

/**
 * The vault read shim: vault-scoped, text-only, `.md`-only, nothing-written
 * rules, applying each function in `transforms` in order to what the build reads.
 *
 * @param {string|null} vaultRoot
 * @param {Array<(text: string) => string>} transforms
 * @returns {() => void} restore
 */
function installVaultReadShim(vaultRoot, transforms) {
  const original = fs.readFileSync;
  let realRoot = null;
  let lexRoot = null;
  if (typeof vaultRoot === 'string' && vaultRoot.length > 0) {
    lexRoot = path.resolve(vaultRoot);
    try {
      realRoot = fs.realpathSync(lexRoot);
    } catch (_) {
      realRoot = null;
    }
  }
  const under = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const inVault = (file) => {
    if (realRoot === null) return false;
    try {
      const lex = path.resolve(file);
      if (!under(lexRoot, lex) && !under(realRoot, lex)) return false;
      return under(realRoot, fs.realpathSync(lex));
    } catch (_) {
      return false;
    }
  };
  fs.readFileSync = function patchedReadFileSync(file, options) {
    const result = original.apply(fs, arguments);
    const enc = typeof options === 'string' ? options : options && options.encoding;
    if (typeof result === 'string' && enc && typeof file === 'string' && file.endsWith('.md') && inVault(file)) {
      return transforms.reduce((text, fn) => fn(text), result);
    }
    return result;
  };
  return function restore() {
    fs.readFileSync = original;
  };
}

/** (Not frozen on purpose: test/obsidian-comments.test.js empties it in a child process to prove the output gate refuses a leak.) Order matters: comments go first so nothing inside a comment is ever rewritten or parsed. */
const READ_TRANSFORMS_FOR_BUILD = [stripObsidianComments];

/** The vault root the staged config points at (src/build/stage.js writes it absolute), or null. */
function stagedVaultRoot(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return typeof cfg.vaultPath === 'string' ? path.resolve(path.dirname(configPath), cfg.vaultPath) : null;
  } catch (_) {
    return null;
  }
}

function captureConsole() {
  const captured = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const push = (level) => (...args) => captured.push({ level, text: args.map(String).join(' ') });
  console.log = push('log');
  console.warn = push('warn');
  console.error = push('error');
  return {
    captured,
    restore() {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

/*
 * FR-DEP-11: the pinned generator emits three render-error shapes
 * (lib/build.js:1035,1045,1066). "roster" is checked before the generic
 * "page" pattern, because "ERROR rendering roster <path>:" also matches
 * "ERROR rendering (\S+):" (it would otherwise classify as a page whose
 * outputPath is literally "roster").
 */
const ROSTER_RE = /^\s*ERROR rendering roster (\S+):\s*(.*)$/;
const PARTY_MANIFEST_RE = /^\s*ERROR building party manifest:\s*(.*)$/;
const PAGE_RE = /^\s*ERROR rendering (\S+):\s*(.*)$/;

/** "ERROR rendering <page>: <msg>" (+ roster/party-manifest variants) -> per-page render errors; the rest is --verbose detail. */
function classifyGeneratorLog(captured) {
  const renderErrors = [];
  const detail = [];
  for (const line of captured) {
    let m = line.text.match(ROSTER_RE);
    if (m) {
      renderErrors.push({ kind: 'roster', outputPath: m[1], message: m[2] });
      continue;
    }
    m = line.text.match(PARTY_MANIFEST_RE);
    if (m) {
      renderErrors.push({ kind: 'party-manifest', outputPath: null, message: m[1] });
      continue;
    }
    m = line.text.match(PAGE_RE);
    if (m) {
      renderErrors.push({ kind: 'page', outputPath: m[1], message: m[2] });
      continue;
    }
    detail.push(line);
  }
  return { renderErrors, detail };
}

/**
 * Calls gm-apprentice-publish's build({configPath}) with the copyFileSync
 * shim and a scoped console capture installed only for the duration of
 * this call, restored in a finally either way.
 *
 * build() is synchronous and throws on failure (never calls process.exit).
 * Up to publish-v1.11.44 it loaded the config with `require(resolvedConfigPath)`, which Node
 * caches; the resolved config path is keyed on a per-build staging directory
 * (docs/decisions/0022-gm-admin-panel.md, "Preview builds"), so each call's require.cache entry
 * was unique. From publish-v1.12.0 it reads the file from disk on every call (lib/build.js:70,
 * loadVaultConfig), so there is no cache entry at all. Either way this MAY be called more than
 * once per process. Phase 8 slice S2's NFR02 test (test/admin-preview.test.js) is the evidence: a
 * third in-process preview build, with a theme change and a label change made between builds,
 * matches a fresh-process `build` byte-for-byte. This corrects the stale comment this replaced,
 * which claimed the opposite; src/generator/redactions.js:159-162,183-187 already documented
 * that its own module-level state supports several builds per process.
 *
 * applyRedactions() (src/generator/redactions.js) runs first, inside this
 * same try, so a throw there (an unresolvable target, or one already in
 * require.cache — meaning the seed would be too late) is caught below and
 * surfaces as an ordinary build failure: fail closed rather than ship the
 * generator with its redaction seed silently skipped (Track DEP-c/R).
 *
 * The nested-exclusion patch (formerly src/generator/sectionfilter.js,
 * docs/decisions/0013-nested-section-exclusion-patch.md) is retired at this
 * pin: upstream's own lib/processor.js now guards the exclude-level
 * assignment with `if (!excluding && ...)`, read and confirmed by hand
 * (not by trusting the old classifySource() heuristic alone) against
 * 78696167 -- a nested excluded heading no longer re-anchors excludeLevel to
 * the inner level, closing #228/#236 upstream. See docs/COLLABORATING.md
 * and the ADR 0013 addendum.
 */
function runGeneratorBuild(configPath) {
  const restoreShim = installCopyFileShim();
  const restoreReadShim = installVaultReadShim(stagedVaultRoot(configPath), READ_TRANSFORMS_FOR_BUILD);
  const restoreSegmenterShim = installSegmenterShim();
  const consoleCapture = captureConsole();
  let error = null;
  try {
    applyRedactions();
    // ADR 0034 / SD-4: re-verify the frontmatter engine guard immediately before every build,
    // through the module object (not a destructured local) so a test can inject a throw here.
    // This is the same self-check pinned.js already ran once at facade load; running it again
    // per build costs nothing (a few parseManifest() probe calls) and catches a hole opened
    // between facade load and this exact build by any in-process code, not just at start-up.
    fmguard.verifyFrontmatterEngineGuard(pinned.parseManifest, pinned.generatorGrayMatter);
    // Issue #100: refuse to build unless the stub-page section guard is live, and tell it the
    // effective exclude_sections of THIS build (the same union the generator computes). A failure
    // to derive them throws into the catch below: fail closed.
    pinned.assertStubGuardLive();
    const stagedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // eslint-disable-next-line global-require
    const { loadPublishConfig } = require('../vault/publishset');
    pinned.setStubExcludeSections(loadPublishConfig(stagedConfig.vaultPath, stagedConfig).publishConfig.exclude_sections);
    // eslint-disable-next-line global-require
    const { build } = require('gm-apprentice-publish');
    build({ configPath });
  } catch (err) {
    error = err;
  } finally {
    pinned.setStubExcludeSections(null);
    consoleCapture.restore();
    restoreReadShim();
    restoreShim();
    restoreSegmenterShim();
  }
  const { renderErrors, detail } = classifyGeneratorLog(consoleCapture.captured);
  return { error, renderErrors, detail, raw: consoleCapture.captured, redactions: redactionReport() };
}

module.exports = { installVaultReadShim, READ_TRANSFORMS_FOR_BUILD, installCopyFileShim, isInsideSnapshot, runGeneratorBuild, classifyGeneratorLog };
