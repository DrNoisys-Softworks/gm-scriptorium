# 0007. Rules-content redaction: two-layer erasure of GURPS reference tables and CoC skill data

Status: accepted (Track DEP-c/R, 2026-09-17).

## Summary

Two files in the generator copy published game-rules content into every character page of those game systems: tables from the GURPS rulebook and a Call of Cthulhu skill list. Scriptorium now erases that content in two independent ways, once at run time and once when the executable is packaged, so the shipped program never carries it. A build still succeeds without the content, and each build reports that it was left out. Refusing to build at all was rejected as too harsh. If a later generator version adds more content of this kind, two safeguards are designed to notice.

## The finding

A read-only re-assessment of the generator pin,
`5779522640ebc655f64aaeac4ea66b9e1214e2ba`, found that the pin ships two files absent from the
version `docs/PROVENANCE.md`'s original audit covered, both reproducing third-party game-rules content
into every character page of their system, unconditionally, with no config gate:

- **`lib/templates/gurps/blocks/reference.js`** (76 lines). `HIT_LOCATION_ROWS` (13 rows) and
  `SIZE_SPEED_RANGE_ROWS` (16 rows) reproduce two literal tables from *GURPS Basic Set 4th Edition*
  (Humanoid Hit Location, p. B552; Size & Speed/Range, p. B550), each with a `Source: GURPS Basic Set
  4e, p. B5xx` citation. `gurps/index.js:12` always computes `buildCombat`; `gurps/layout.js:19`
  destructures `renderReference` at module load and `:62` interpolates it unconditionally into
  `<div class="gurps-combat">`. Upstream's own `ATTRIBUTION.md` licenses this exact file under the SJG
  Online Policy, whose permission is "for free distribution, and **not for resale**." That term is
  incompatible with Scriptorium's own MIT licence. This is a content-licensing blocker, not the trademark-nominative-use
  question `docs/PROVENANCE.md` section 7 analysed for the pre-pin version, which never shipped this
  file.
- **`lib/templates/coc/skills-data.js`** (60 lines). `REGENCY_SKILLS` (51 entries) and `BASE_SKILLS`
  (44) hardcode the named Call of Cthulhu 7th Edition (and Regency variant) skill list with starting
  percentages, consumed as the `canonical` seed of `mergeSkills` at `coc/skills.js:36` and merged into
  every CoC character page unconditionally. Lower-confidence than the GURPS finding (upstream's
  generic ORC grant for BRP mechanics may or may not extend to CoC-specific skill naming), but new
  and worth recording.

Orchestrator decision on the one question the Architect pass escalated (that pass had no shell): the
CoC `skills-data.js` entry **ships**, redacted, rather than being dropped outright, keeping the
option to restore it later. The owner runs a system that is neither GURPS nor Call of Cthulhu, so
this choice does not affect the owner's own use directly; the GURPS finding is the one that actually carries
a redistribution constraint, since only it has an explicit "not for resale" condition. Reversible later by deleting `src/generator/redactions.js`'s `coc-skills-data` entry, the
matching `package.json` `pkg.patches` key, and the CoC paragraph in
`scripts/generate-notices.js`'s Section 4.

## Decision: two layers, one registry

`src/generator/redactions.js`'s `REDACTIONS` array is the single source of truth for which two
upstream files are redacted, their pin sha256 (so a pin move that touches either file fails a test),
and their notices claim. Two independent mechanisms consume it:

1. **Runtime: a require-cache seed.** `applyRedactions()` seeds `require.cache` with a
   Scriptorium-authored stub for each entry's resolved module path, called inside
   `bootstrap.js:runGeneratorBuild()`'s `try`, immediately before
   `require('gm-apprentice-publish')`. Because the pin's require graph is fully eager
   (`lib/index.js` → `lib/templates/index.js` → `pc-registry.js` → `gurps/index.js` →
   `gurps/layout.js:19`, all top-level requires, load before any page renders), the seed has to land
   before that chain runs even once, `gurps/layout.js:19` destructures `renderReference` at module
   load and never re-reads the cache afterward. A seed that lands after is not a partial fix, it is a
   complete no-op, silently: this is the ordering trap the risk section below covers.
2. **Packaging: `package.json`'s `pkg.patches`.** A sibling of the existing `pkg.assets` key, `erase`s
   both files' bodies and replaces them with an equivalent-shape stub, so the packaged executable
   never embeds the real content regardless of the runtime layer. `@yao-pkg/pkg`'s `stepPatch`
   (`lib-es5/walker.js:578-605`) runs before bytecode compilation (`:787-798`), ahead of pkg's static
   require-graph walk that would otherwise embed the file even for a D&D-only user.

In the packaged exe, both layers agree; the patched on-disk body is inert regardless, because the
runtime cache seed wins if somehow reached first. In `node` run from source (no pkg, no patches), the
runtime layer alone carries the whole guarantee.

### Rejected alternatives

- **Runtime-only (cache seed, no `pkg.patches`).** pkg's static require-graph walk still finds and
  embeds the real file on disk; the exe still carries the tables regardless of what the cache seed
  does at runtime inside `node`. Fails the actual requirement, which is about the shipped bytes, not
  about `node`'s runtime behaviour.
- **`pkg.ignore`ing the two files.** Omits them from the snapshot entirely, so
  `gurps/layout.js:19`'s `require('./blocks/reference')` throws `MODULE_NOT_FOUND` at load of
  `lib/index.js`, and because the require graph is eager, that is load of `lib/index.js` for
  **every** build, D&D included. This is not a redaction, it is a break.
- **`pkg.patches`-only, no runtime layer.** `npm test` could never prove the claim: the only proof
  would be inspecting a manually built exe by hand, which is exactly the "trust the build-time flag"
  failure mode Structural decision D5 below exists to avoid. The runtime layer is what makes
  `test/redaction-gurps-build.test.js` and `test/redaction-coc-build.test.js` possible at all.
- **An env var or config flag to disable redaction.** An escape hatch defeats the point (a build with
  the flag off would still be a Scriptorium binary shipping the content) and invites exactly the
  next drift this work exists to close off. Rejected outright, no exception list either
  (`scripts/generator-pin.js` gained none).

## Degrade, don't refuse

A GURPS or CoC vault still builds. `renderReference()`'s stub returns `''`; `buildCombat` still emits
its `<div class="gurps-combat">` wrapper for any other part present (`layout.js:45-62`), so a GURPS
page still renders identity, attributes, defences, melee, ranged and combat chains from the user's own
sheet, only the upstream reference appendix is gone. `REGENCY_SKILLS`/`BASE_SKILLS`'s stub returns
`[]`; `mergeSkills` (`coc/skills.js:35-64`) then builds its row set purely from the sheet's own
`pcSkills`, taking `base` from the sheet's own column when the canonical lookup comes back empty
(`:46`), a CoC page shows exactly the skills the user wrote, nothing manufactured.

Refusing the build instead was considered and rejected: refusing removes no bytes from the exe (the
GURPS/CoC vaults that never triggered a refusal still needed the packaging-layer fix regardless), so
it buys no compliance over degrading-plus-patching, and it drops a working feature for every GURPS and
CoC user for no benefit.

## The degradation is reported, per build

Stubs count real per-page use, not merely being loaded: `applyRedactions()`'s `instrumentStub()` wraps
a function export (`renderReference`) to count each **call**, and wraps an array export
(`REGENCY_SKILLS`/`BASE_SKILLS`) in a `Proxy` that counts each time it is **iterated**
(`Symbol.iterator` accessed), not each time the export is merely read off the module. This distinction
is load-bearing: `coc/skills.js:2` destructures both arrays into module-level bindings exactly once,
at module load, regardless of how many CoC pages exist in the vault, because the pin's require graph
loads `coc/skills.js` unconditionally (`pc-registry.js` requires every system renderer up front). A
naive "count every read of the export" instrumentation reports 2 calls for `coc-skills-data` on every
single build, including a pure D&D vault with zero CoC pages, caught by
`test/redactions.test.js`'s D&D-only-build test during this work. Counting iteration instead tracks
`mergeSkills`'s `for (const c of canonical)` loop, which runs fresh, once, on every actual call, i.e.
once per CoC page genuinely rendered.

`redactionReport()` returns the count per entry, in `REDACTIONS` order. `bootstrap.js`'s
`runGeneratorBuild` includes it in its return; `src/build/run.js`'s `runAtomicBuild` passes it through
under `redactions`; `src/cli/build.js` adds it to the `--json` envelope and prints at most one extra
human line, only when some entry's `calls > 0`, naming what was omitted and pointing at
`THIRD-PARTY-NOTICES.txt`. A D&D-only build prints nothing extra and reports zero calls for both
entries.

## Marker strings live in build-time-only code, never in `src/`

`scripts/content-markers.js` holds the literal rules-content strings (`Source: GURPS Basic Set 4e, p.
B552`/`B550`, `Humanoid Hit Location`, `Cthulhu Mythos`, `Spot Hidden`) that only exist because the two
redacted files exist. If any of these strings entered `src/` or `bin/`, they would be embedded
verbatim in every packaged executable, and the AC-R8 ship gate below would fail on every future build
forever, a gate that can never pass is worse than no gate, because it manufactures a false "we
checked" signal. `src/generator/redactions.js`'s registry carries only module paths and expected
sha256 hashes; `test/redactions.test.js` binds the two lists (`MARKERS`/`REDACTIONS` name the same two
`pinPath`s, in the same order) and separately asserts that no `REDACTIONS` field (`reason`,
`noticeClaim`, `pinPath`, `specifier`, `id`) contains a marker string, so the two cannot drift apart
without a test catching it. Neither `pkg.patches`' replacement bodies nor the corrected notices
paragraphs contain a marker string either, checked the same way.

## The ship gate is an artefact scan, not a flag

`scripts/package.js` scans the produced binary with `scripts/content-markers.js`'s
`assertNoRulesContent()` after `assertAssetsEmbedded()` and before the sha256/`SHA256SUMS` write,
mirroring `assertAssetsEmbedded`'s own shape exactly: print every hit, remove the output, exit 1,
write no `SHA256SUMS`.

**The positive control (AC-R6), run before this gate was written, exactly as the brief required:** a
Linux exe built from this repo **without** `pkg.patches` (i.e. against the pre-existing `package.json`,
before this track's `pkg.patches` key was added) was scanned with `scanBuffer()` and **all five marker
strings were found** (`Source: GURPS Basic Set 4e, p. B552`, `...p. B550`, `Humanoid Hit Location`,
`Cthulhu Mythos`, `Spot Hidden`), confirmed independently with `grep -ac` against the raw binary bytes
(2/3/3/3 occurrences respectively). This is the evidence that the gate is not a gate that can never
fail, the markers are genuinely findable in an unpatched build, so a gate that finds nothing in a
patched build is telling you something real. Had this control come back clean, the correct response
would have been to stop and report a broken proof strategy, not to write the gate anyway; the brief
was explicit about this and it did not arise.

**AC-R7**, the same build **with** `pkg.patches` restored: `scanBuffer()` found **zero** markers.
Binary size dropped by roughly the erased bodies (control 80,580,846 bytes; patched 80,564,938 bytes,
Linux node22-x64 target). Both binaries were built via the shipped invocation
(`scripts/package.js`, package.json as pkg's input, see `docs/decisions/0005-generator-pin.md`'s
DEP-a2 finding), just with the target/out overridden, never a raw `pkg` invocation.

**AC-R8**, the gate itself firing: in a scratch copy of the whole repo, one `pkg.patches` entry
(`coc-skills-data`) was deleted from `package.json` and the same build re-run. It printed the two CoC
marker hits, exited 1, and left the output directory **empty**, no binary, no `SHA256SUMS`.

**Escalation avoided.** The Architect's one unproven claim, that `pkg.patches` fires for a
`node_modules`-relative path in this project's exact invocation, is now proven: both the erasure
(AC-R7) and the gate-firing-on-its-absence (AC-R8) checks above depend on it firing, and both behaved
as the brief's mechanism description predicted. The documented fallback (pkg's `transform` hook,
requiring `scripts/package.js` to move off `execFileSync` onto pkg's Node API) was not needed.

## Future upstream bumps are caught two ways

1. **Sha256 pins.** `REDACTIONS`' two `expectedSha256` values are checked against
   `PIN.json.files[pinPath]` by `test/redactions.test.js`; a pin move that touches either redacted
   file's bytes fails that test immediately, naming the file to re-read.
2. **A heuristic scanner over the whole pin tree.** `scripts/content-markers.js`'s `scanPinTree()`
   sweeps every file in the installed pin for `PIN_SCAN_PATTERN` (an explicit `Source: <book>, p.
   <page>` citation shape, or a known trademark name written as a whole word, `\bGURPS\b`,
   `\bCthulhu\b`, `\bChaosium\b`, `\bSteve Jackson\b`, chosen so `GURPS_CONSUMED_TITLES` or
   `renderGURPSSheet` do not false-positive, since no word boundary sits between the name and an
   adjoining identifier character). The committed `PIN_SCAN_BASELINE` (39 hits across 18 files, at
   this pin) is every current hit with a one-line judgement: the two redacted files' own lines are
   noted "redacted by this work"; every other hit was read by hand and is a comment, identifier or
   user-facing warning string naming which system a code path serves, with no reproduced rules data
   (numbers, tables, percentages), the same nominative-use / 17 U.S.C. 102(b) reasoning
   `docs/PROVENANCE.md` already used for `gurps-calc.js`'s pure formulas and `pc.js`'s display labels.
   `test/redactions.test.js` asserts `scanPinTree()` reproduces this baseline exactly; a future pin
   that adds a third rules-content file anywhere in the tree, in a new file, fails that test instead
   of shipping silently. **This baseline was independently re-derived for this pin, not copied from
   the Architect's unproven manual estimate** ("9 hits in 5 files"), that pass had no shell and
   warned explicitly not to trust its own count blind.

`docs/decisions/0005-generator-pin.md`'s pin-move procedure gained a step: re-run the three redaction
test files, re-derive `PIN_SCAN_BASELINE`, and read every new or changed baseline entry by hand before
the pin ships.

## Risk areas, and how each was closed

1. **Ordering.** `applyRedactions()` throws `ScriptoriumError`, never warns, if a target specifier
   is already in `require.cache` under something other than this function's own earlier seed (a
   marker property, `scriptoriumRedactionId`, distinguishes "our own stub, re-seeded on a second
   build in the same process" from "real generator code got there first"). Verified: commenting out
   the `applyRedactions()` call, or moving it to after `require('gm-apprentice-publish')`, makes both
   `test/redaction-gurps-build.test.js` and `test/redaction-coc-build.test.js` fail (the AC-R3
   requirement); each build test file also runs a raw, unprotected control build in a **child
   process** (never in-process, to avoid the very `require.cache` collision this risk is about) and
   confirms it *does* leak the markers, proving the protected assertions have teeth rather than
   passing vacuously.
2. **Markers leaking into the exe.** Covered above ("Marker strings live in build-time-only code").
3. **`pkg.patches` path matching.** `walker.js:533`'s `path.join(base, key)` against the normalised
   real path was the one unproven mechanism; AC-R6/AC-R7/AC-R8 above are the backstop that would have
   caught a silent match failure regardless of the internal reason.
4. **A scan that cannot fail.** AC-R6's positive control, above, is the whole point; it was run before
   the gate was written and is not asserted by `npm test` (a real `pkg` build takes seconds, not
   milliseconds, so it is not repeated on every test run) but is reproducible by re-running
   `node scripts/package.js --target node22-<platform>-x64 --out <scratch>` against a copy of
   `package.json` with the `pkg.patches` key removed.
5. **CoC output change.** Redacting `skills-data.js` removes the baseline skill rows from every CoC
   sheet; a page shows only what the user wrote. Intentional, approved by the orchestrator (see "The
   finding" above), reversible by deleting one registry entry, one `pkg.patches` key and one notices
   paragraph.

## Consequence

- `THIRD-PARTY-NOTICES.txt` Section 4's "Scriptorium contains no GURPS rules content" sentence, false
  for this pin, is replaced with the accurate claim that the upstream generator carries the appendix
  and Scriptorium removes it at packaging time and never executes it, bound to
  `src/generator/redactions.js`'s `noticeClaim` fields by `test/redactions.test.js`, so deleting a
  redaction without deleting its notices paragraph fails the build.
- `docs/PROVENANCE.md` gained a short addendum (section 15) recording NEW-1 and NEW-2 as resolved.
- `README.md`'s "Third-party notices" section states what Scriptorium does not contain.
- `src/build/notice.js` gains no third `NOTICE.txt` entry: after this work, no built site
  redistributes either module any more, so the site-level notice obligation this file exists to
  discharge (lunr.js, the pin's own CSS/JS) is unchanged.
