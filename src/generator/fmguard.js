'use strict';

const { ScriptoriumError } = require('../util/errors');

/*
 * ADR 0034 / FR-FM-03, SD-4. The primary control: for the life of the process, the generator's
 * OWN bundled gray-matter copy (pinned.generatorGrayMatter, the literal
 * require('gm-apprentice-publish/node_modules/gray-matter')) can never dispatch to its javascript
 * or json engine, through any of its seven current call sites, any future one a pin bump adds, or
 * the TOCTOU window between a scan and the generator's own read -- because every uncached parse
 * rebuilds its engine table from the SAME module-level object this guard freezes
 * (gray-matter's defaults.js:16: `Object.assign({}, engines, opts.parsers, opts.engines)`, and
 * `matter.engines` IS that object, index.js:137).
 *
 * Installed in the netguard shape (src/generator/netguard.js): idempotent per handle, process-
 * lifetime (no restore), installed at facade load (src/generator/pinned.js) and again,
 * independently, in bootstrap.js (which calls the pin's build() directly, not through the
 * facade). A second, DIFFERENT handle passed to installFrontmatterEngineGuard is a bug -- it
 * would mean two resolved copies of the generator's gray-matter exist in this process, which
 * FR-FM-03's single-literal contract forbids -- and throws rather than silently doing nothing.
 */

let installedHandle = null;

/**
 * Deletes every own key of `matter.engines` except `yaml`, then freezes the object, so a later
 * `matter.engines.javascript = ...` (or any other re-add) throws in strict mode / silently fails
 * in sloppy mode rather than reopening the hole. An allowlist (keep yaml), not a denylist (delete
 * javascript and json by name): a future pin adding a THIRD dangerous engine is removed too,
 * without this guard needing to know its name in advance.
 *
 * @param {object} matter pinned.generatorGrayMatter -- the module object itself, whose
 *   `.engines` property is the same object lib/defaults.js rebuilds `opts.engines` from
 * @returns {{ installed: boolean }} false when this exact handle was already installed
 * @throws {ScriptoriumError} if called with a second, different handle, or if the post-freeze
 *   assertion fails
 */
function installFrontmatterEngineGuard(matter) {
  if (installedHandle === matter) return { installed: false };
  if (installedHandle !== null) {
    throw new ScriptoriumError(
      'installFrontmatterEngineGuard: a different gray-matter handle is already installed; ' +
        'Scriptorium must resolve exactly one bundled generator gray-matter copy (ADR 0034, FR-FM-03).',
    );
  }

  const engines = matter.engines;
  for (const key of Reflect.ownKeys(engines)) {
    if (key === 'yaml') continue;
    delete engines[key];
  }
  Object.freeze(engines);

  const remaining = Reflect.ownKeys(engines);
  if (remaining.length !== 1 || remaining[0] !== 'yaml') {
    throw new ScriptoriumError(
      `installFrontmatterEngineGuard: post-freeze assertion failed, matter.engines keys are ${JSON.stringify(remaining)}, expected ["yaml"]; this is a Scriptorium bug (docs/decisions/0034-executable-frontmatter-guard.md)`,
    );
  }

  installedHandle = matter;
  return { installed: true };
}

/**
 * The behavioural self-check (FR-FM-03): runs THROUGH the generator's own `parseManifest`, not
 * through the handle directly, so a pass proves the neutering reached the exact copy the
 * generator itself resolves -- in source, and in the packaged exe (AC-FM-10) -- not merely the
 * object this module happened to freeze.
 *
 * @param {(raw: string) => { ok: boolean, meta?: object }} parseManifest pinned.parseManifest
 * @param {object} matter pinned.generatorGrayMatter, used only to clean up the probe cache entry
 * @throws {ScriptoriumError} on any probe failure, fail-closed (exit 1 via the redactions.js
 *   pattern: a throw at facade load, or inside runGeneratorBuild's try, both map to exit 1)
 */
function verifyFrontmatterEngineGuard(parseManifest, matter) {
  const nonce = `${process.pid}-${++verifyFrontmatterEngineGuard._n}`;
  try {
    const positive = parseManifest(`---\nscriptorium_probe: "${nonce}"\n---\n`);
    if (!positive || !positive.meta || positive.meta.scriptorium_probe !== nonce) {
      throw new ScriptoriumError(
        `frontmatter engine guard self-check failed: yaml positive control did not round-trip its nonce; this is a Scriptorium bug (docs/decisions/0034-executable-frontmatter-guard.md)`,
      );
    }

    for (const tag of ['js', 'javascript', 'json']) {
      const body = tag === 'json' ? `{"scriptorium_probe":"${nonce}"}` : `({ scriptorium_probe: "${nonce}" })`;
      let threw = null;
      try {
        parseManifest(`---${tag}\n${body}\n---\n`);
      } catch (err) {
        threw = err;
      }
      if (!threw || !/engine "(js|javascript|json)" is not registered/.test(threw.message)) {
        throw new ScriptoriumError(
          `frontmatter engine guard self-check failed: probe for tag "${tag}" did not throw the expected "not registered" error; this is a Scriptorium bug (docs/decisions/0034-executable-frontmatter-guard.md)`,
        );
      }
    }
  } finally {
    // Best-effort: gray-matter caches by content string (index.js:37-48). A bare-options-less
    // parseManifest() call above would be cacheable if it succeeded, so drop any probe keys that
    // might have landed there.
    try {
      if (matter && matter.cache) {
        for (const key of Object.keys(matter.cache)) {
          if (key.includes(nonce)) delete matter.cache[key];
        }
      }
    } catch {
      /* best-effort only */
    }
  }
}
verifyFrontmatterEngineGuard._n = 0;

/*
 * SD-4: hash binding to PIN.json (redactions.js's own pattern). A pin move that changes any of
 * these four files forces a human re-read (the pin-binding test, AC-FM-08, goes red on a hash
 * mismatch) rather than silently trusting that the freeze still covers the same engine-selection
 * code path. Values are PIN.json's own sha256 for these paths at commit 78696167.
 */
const BOUND_PIN_FILES = Object.freeze([
  Object.freeze({ pinPath: 'node_modules/gray-matter/index.js', expectedSha256: '0e35aa201de0273eb77d255362199d85f479ea361df539eb3aa483e900478da4' }),
  Object.freeze({ pinPath: 'node_modules/gray-matter/lib/defaults.js', expectedSha256: 'c5191d3221777039f1decfdf19c7cb0e8b8de9a9107436e0c1c4db23b9d1397d' }),
  Object.freeze({ pinPath: 'node_modules/gray-matter/lib/engine.js', expectedSha256: '1d6060bbe7953bd2d117477786a0e2a0b523d446b79390a763228b1d4c75d428' }),
  Object.freeze({ pinPath: 'node_modules/gray-matter/lib/engines.js', expectedSha256: 'cf0504448a3122b9173bbd732c6fe165abca96317926b866c1e9983dd4606993' }),
]);

module.exports = {
  installFrontmatterEngineGuard,
  verifyFrontmatterEngineGuard,
  BOUND_PIN_FILES,
};
