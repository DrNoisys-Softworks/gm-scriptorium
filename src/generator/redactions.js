'use strict';

const { ScriptoriumError } = require('../util/errors');

/*
 * Track DEP-c/R, docs/decisions/0007-rules-content-redaction.md. Runtime
 * half of the two-layer redaction (Structural decision D1); the
 * packaging half is package.json's `pkg.patches`.
 *
 * Two upstream files reproduce third-party rules content into every
 * character page of their system, unconditionally, with no config gate:
 *
 *   - lib/templates/gurps/blocks/reference.js reproduces two literal GURPS
 *     combat-reference data tables with page citations (see the upstream
 *     file's own header comment for the exact source and page numbers),
 *     under the SJG Online Policy licence, whose permission is "for free
 *     distribution, and not for resale". Scriptorium is intended to be sold.
 *   - lib/templates/coc/skills-data.js hardcodes the named Call of Cthulhu
 *     7th Edition (and Regency variant) skill list with starting
 *     percentages. Ships per the orchestrator's decision recorded in
 *     docs/decisions/0007-rules-content-redaction.md: reversible by
 *     deleting this entry, its pkg.patches key, and its notices paragraph.
 *
 * applyRedactions() seeds require.cache with a Scriptorium-authored stub
 * for each, called immediately before bootstrap.js's
 * require('gm-apprentice-publish'). Because the require graph is fully
 * eager (lib/index.js -> lib/templates/index.js -> ... ->
 * gurps/layout.js:19, which destructures renderReference AT MODULE LOAD),
 * a seed that lands after that chain has already run does nothing at
 * all, silently — this module never requires a generator module itself
 * (require.resolve only, checked by test/generator-module-graph.test.js),
 * and throws rather than warns if the seed would be too late.
 *
 * This file carries no marker string (Structural decision D4): only
 * module paths and expected sha256 hashes, so a leak into the packaged
 * exe cannot happen through this file. scripts/content-markers.js is the
 * build-time-only home for the literal strings, and
 * test/redactions.test.js binds the two lists so they cannot drift apart.
 */

/**
 * @typedef {{
 *   id: string,
 *   pinPath: string,
 *   specifier: string,
 *   expectedSha256: string,
 *   reason: string,
 *   noticeClaim: string,
 *   stub: () => object,
 * }} Redaction
 */

/** @type {Redaction[]} */
const REDACTIONS = [
  {
    id: 'gurps-reference',
    pinPath: 'lib/templates/gurps/blocks/reference.js',
    specifier: 'gm-apprentice-publish/lib/templates/gurps/blocks/reference.js',
    expectedSha256: 'fd2a3e5a7e79769acecf4b13139d7cd20258a8d84b63fe5a0587dea48cfc0694',
    reason:
      'reproduces two literal GURPS combat-reference data tables with page citations ' +
      '(lib/templates/gurps/blocks/reference.js:6-20,23-40), rendered unconditionally into ' +
      'every GURPS page (lib/templates/gurps/layout.js:62), under a licence permission that is ' +
      'not for resale. See docs/decisions/0007-rules-content-redaction.md.',
    // Bound to scripts/generate-notices.js's Section 4 GURPS paragraph by
    // test/redactions.test.js, so deleting this entry without deleting its notices claim fails
    // the build (AC-R11). No marker string (scripts/content-markers.js) appears here.
    noticeClaim: 'Scriptorium removes that module when it packages the executable and never executes it',
    // renderReference() is destructured at gurps/layout.js:19 and called as
    // ${renderReference()} at gurps/layout.js:62; buildCombat still emits its wrapper for any
    // other part present (layout.js:45-62), so an empty string here degrades the appendix
    // without breaking the rest of the combat tab.
    stub: () => ({ renderReference: () => '' }),
  },
  {
    id: 'coc-skills-data',
    pinPath: 'lib/templates/coc/skills-data.js',
    specifier: 'gm-apprentice-publish/lib/templates/coc/skills-data.js',
    expectedSha256: 'e1a4d7f46fb48984999da692247dc19280555b0a997c6c59df6e084c4f8f6877',
    reason:
      'hardcodes the named Call of Cthulhu 7th Edition skill list and starting percentages ' +
      '(lib/templates/coc/skills-data.js:3-56), merged unconditionally into every CoC page ' +
      '(lib/templates/coc/skills.js:36). Ships per the orchestrator decision recorded in ' +
      'docs/decisions/0007-rules-content-redaction.md; skill rows on a CoC page now come only ' +
      "from the user's own sheet.",
    // Bound to scripts/generate-notices.js's Section 4 CoC paragraph by
    // test/redactions.test.js, so deleting this entry without deleting its notices claim fails
    // the build (AC-R11). No marker string (scripts/content-markers.js) appears here.
    noticeClaim: "Skill rows on a Call of Cthulhu character page come only from the user's own character sheet.",
    // REGENCY_SKILLS / BASE_SKILLS are the `canonical` seed mergeSkills() reads at
    // coc/skills.js:36; an empty array leaves mergeSkills building its row set purely from the
    // sheet's own pcSkills, taking `base` from the sheet's own column (coc/skills.js:46).
    stub: () => ({ REGENCY_SKILLS: [], BASE_SKILLS: [] }),
  },
];

/**
 * Wraps a stub's own exports so every PER-PAGE use is counted, without
 * changing the export's key set. Two shapes, because the two redacted
 * modules' consumers use their exports two different ways:
 *
 *   - A function value (reference.js's renderReference) is wrapped to
 *     count each CALL: gurps/layout.js:62 calls it fresh, once, every time
 *     a GURPS page's combat tab renders.
 *   - An array value (skills-data.js's REGENCY_SKILLS/BASE_SKILLS) is
 *     wrapped in a Proxy that counts each time it is ITERATED
 *     (Symbol.iterator accessed), not each time the export is merely read.
 *     coc/skills.js:2 destructures both arrays into module-level bindings
 *     exactly ONCE, at module load, regardless of how many CoC pages
 *     exist; counting that read would count 2, always, even for a build
 *     with zero CoC pages (AC-R9 requires a D&D-only build to print
 *     nothing extra). The real per-page signal is coc/skills.js:38's
 *     `for (const c of canonical)` inside mergeSkills(), which iterates
 *     the same captured array reference fresh on every call — once per
 *     CoC page actually rendered, which is what Structural decision D3's
 *     degradation count is supposed to mean.
 *
 * @param {object} rawExports
 * @param {() => void} onAccess
 * @returns {object}
 */
function instrumentStub(rawExports, onAccess) {
  const exportsObj = {};
  for (const key of Object.keys(rawExports)) {
    const value = rawExports[key];
    if (typeof value === 'function') {
      exportsObj[key] = function instrumentedRedactionStub(...args) {
        onAccess();
        return value.apply(this, args);
      };
    } else if (Array.isArray(value)) {
      exportsObj[key] = new Proxy(value, {
        get(target, prop, receiver) {
          if (prop === Symbol.iterator) onAccess();
          return Reflect.get(target, prop, receiver);
        },
      });
    } else {
      exportsObj[key] = value;
    }
  }
  return exportsObj;
}

const callCounts = new Map();

/**
 * Seeds require.cache with a stub for each REDACTIONS entry, so that when
 * the pin's eager require graph reaches
 * `require('gm-apprentice-publish/lib/templates/.../<file>.js')`, Node
 * returns the stub instead of loading the real file. Must run before
 * `require('gm-apprentice-publish')` (bootstrap.js).
 *
 * Never a silent no-op: throws ScriptoriumError if a specifier does not
 * resolve, or if it is ALREADY in require.cache with something other than
 * this function's own earlier seed (meaning real generator code loaded the
 * template tree before this ran — the seed would be too late, because
 * gurps/layout.js:19 destructures renderReference at module load and never
 * re-reads the cache afterward). Calling this more than once in the same
 * process (src/cli/build.js may run more than one build per process) is
 * fine: re-seeding over this function's own earlier stub just resets that
 * entry's call count.
 *
 * @returns {{ id: string, applied: true }[]}
 * @throws {ScriptoriumError}
 */
function applyRedactions() {
  callCounts.clear();
  const applied = [];
  for (const entry of REDACTIONS) {
    callCounts.set(entry.id, 0);

    let resolvedId;
    try {
      resolvedId = require.resolve(entry.specifier);
    } catch (err) {
      throw new ScriptoriumError(
        `redaction "${entry.id}" could not resolve ${entry.specifier}: ${err.message}`,
        { path: entry.specifier, cause: err },
      );
    }

    // A cache entry this same function seeded on an earlier call in the same process
    // (src/cli/build.js may run more than one build per process, see test/cli-json.test.js)
    // is not "too late": it is our own stub, still doing its job, and re-seeding it here is a
    // harmless reset of its call count. Only a cache entry WITHOUT this marker means real
    // generator code got there first.
    const existing = require.cache[resolvedId];
    if (existing && existing.scriptoriumRedactionId !== entry.id) {
      throw new ScriptoriumError(
        `redaction "${entry.id}" ran too late: ${resolvedId} is already in require.cache. ` +
          'Something loaded the generator template tree before applyRedactions() ran, so ' +
          'seeding the cache now would have no effect (gurps/layout.js:19 destructures ' +
          'renderReference at module load and never re-reads the cache).',
        { path: resolvedId },
      );
    }

    const rawExports = entry.stub();
    const exportsObj = instrumentStub(rawExports, () => {
      callCounts.set(entry.id, callCounts.get(entry.id) + 1);
    });

    require.cache[resolvedId] = {
      id: resolvedId,
      filename: resolvedId,
      loaded: true,
      exports: exportsObj,
      children: [],
      paths: [],
      scriptoriumRedactionId: entry.id,
    };

    applied.push({ id: entry.id, applied: true });
  }
  return applied;
}

/**
 * The degradation report for the build that just ran: how many times each
 * redacted export was actually read or called, in REDACTIONS order.
 *
 * @returns {{ id: string, calls: number }[]}
 */
function redactionReport() {
  return REDACTIONS.map((entry) => ({ id: entry.id, calls: callCounts.get(entry.id) || 0 }));
}

module.exports = { REDACTIONS, applyRedactions, redactionReport };
