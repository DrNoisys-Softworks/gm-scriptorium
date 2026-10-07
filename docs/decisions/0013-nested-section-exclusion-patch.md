# 0013. Nested section exclusion: a load-time source patch of the pinned `filterSections`

Status: accepted (2026-09-21).

## Summary

A page that lists an excluded section inside another excluded section could publish the text under the inner heading's next sibling, so GM-only prep could appear on the site. Scriptorium fixed this with a small patch applied to the generator's code when it loads, instead of editing the vendored copy. The alternatives of editing the installed copy or rewriting its checksum list were rejected, because both fail on a clean clone. The generator fixed the fault itself at the `publish-v1.11.40` pin, so the patch has been retired; this record keeps the reasoning.

## The defect

`filterSections` (`lib/processor.js:77-108`) is the pinned generator's single implementation of
`exclude_sections`. It walks a page's markdown line by line, tracking one open exclusion region with
two variables: `excluding` (are we inside an excluded region) and `excludeLevel` (the heading level
that opened it). A heading closes the open region when its own level is at or above that level:

```js
if (excluding && level <= excludeLevel) {   // lib/processor.js:90-92
  excluding = false;
}

if (excludeSections.some(s => title.toLowerCase() === s.toLowerCase())) {
  excluding = true;
  excludeLevel = level;                     // lib/processor.js:94-98 — unconditional
  continue;
}
```

`excludeLevel = level` is unconditional. When a heading that is itself in `exclude_sections` appears
*inside* a region that is already excluded, the assignment drags `excludeLevel` down to the inner
heading's level. The next sibling at that inner level then satisfies `level <= excludeLevel`, clears
`excluding`, and is **published**:

```
# Page
Intro text.

## GM Notes            -> excluding = true,  excludeLevel = 2
Prep one.

### Needs              -> matched; excludeLevel dragged 2 -> 3
A prep question.

### Rumours In Play    -> 3 <= 3, excluding = false, PUBLISHED
LEAK-SENTINEL-ALPHA

## Public Bio
Visible body.
```

The trace is `3 <= 3`. The author's intent, unambiguously, was that everything under `## GM Notes`
down to the next `##` is prep; the generator publishes the tail of it because a nested excluded
heading moved the goalposts.

**This is live in production today.** `GM Notes` and `Needs` are both in the live campaign's
effective `exclude_sections`, `GM Notes` from `PUBLISH_DEFAULTS` (`lib/config.js:16`) and both from
the campaign's own config, unioned at `lib/config.js:234-237`. Any page that files a `### Needs`
block under `## GM Notes` and then writes another `###` sibling has been publishing that sibling.

Observed at pin `5779522640ebc655f64aaeac4ea66b9e1214e2ba` (1.11.30). Not fixed upstream; an issue
draft is at the end of this ADR, unfiled (filing is the owner's call).

## The load-bearing finding: three call sites, only one of them reachable

`filterSections` is called three times:

| Call site | Feeds |
|---|---|
| `lib/processor.js:565` (`processContent`) | the page HTML a player reads |
| `lib/processor.js:534` (`playerSafeMarkdown`) | the player-safe chain, incl. `sheet show --player-safe` |
| `lib/build.js:345` | `page.publishedMarkdown` |

The first two are **module-internal closure bindings**. Inside `lib/processor.js`, `filterSections`
is referenced by its own function declaration, not through `module.exports`. Reassigning
`module.exports.filterSections` from outside changes what *other modules* see and nothing else:
`processContent` and `playerSafeMarkdown` keep calling the original.

That matters more than it sounds. `lib/build.js:345` is the one reachable through the exports, and it
computes `page.publishedMarkdown`, which `publishedSource` (`lib/processor.js:498-501`) hands to
`lib/search-index.js`, `lib/backlinks.js`, `lib/recency.js`, `lib/story-spine.js` and
`lib/templates/npc.js`. So an exports-level monkeypatch would clean the search index, the backlinks
and the recency widgets, and leave the page HTML leaking. The two surfaces would then **disagree**,
with the leak surviving on the one surface players actually read. That is worse than the status quo,
because a `check` or a grep over `search-index.json` would come back clean while the HTML still
carried the section.

So the fix has to reach the closure bindings, which means it has to change the module's *source*
before the module is compiled.

## The decision

`src/generator/sectionfilter.js` exports `applySectionFilterPatch()`. At the first call in a process
it:

1. Resolves `gm-apprentice-publish/lib/processor.js` with `require.resolve` **only**, never a static
   `require` of a generator module, the same discipline `src/generator/redactions.js` follows, which
   is what keeps `test/generator-module-graph.test.js`'s static walk honest.
2. Reads the file with `fs.readFileSync` and classifies it (`classifySource`, a pure exported
   function):
   - the anchor present **exactly once** > patchable;
   - the anchor absent and the corrected form present > `upstream-fixed`, no patch, no seed, no
     throw;
   - anything else (zero matches with no corrected form, or more than one match) > throw a
     `ScriptoriumError` naming `lib/processor.js` and the pin commit. It never guesses at which
     occurrence.
3. If a patch is needed and `lib/processor.js` is already in `require.cache` **without** this
   module's marker, throws: real generator code got there first, the seed would be too late, and a
   too-late seed must never be a silent no-op. Same wording and same reasoning as
   `redactions.js`'s own too-late guard.
4. Compiles the patched source through **Node's own loader**: capture `Module._extensions['.js']`,
   install a wrapper that for this one resolved filename calls `mod._compile(patchedSource,
   filename)` and delegates for everything else, `require(resolved)`, restore the original in a
   `finally`, then set the marker on the `require.cache` entry.

The swap is two lines:

```js
// anchor (lib/processor.js:95-96)
        excluding = true;
        excludeLevel = level;

// replacement
        if (!excluding) excludeLevel = level;
        excluding = true;
```

`excluding` is true at that point only when the current heading did **not** close the open region
(`lib/processor.js:90-92` has already cleared it otherwise), so `!excluding` is exactly "this heading
starts a new exclusion region", the only case in which `excludeLevel` should move. A heading that
closes a region and immediately opens a new one at the same level still re-anchors correctly, because
`:90-92` set `excluding = false` first. That sibling case is the one an over-eager fix breaks, and it
has its own test.

Using Node's loader rather than a hand-built `Module` is deliberate: inside a packaged exe,
`@yao-pkg/pkg` patches exactly that machinery, so going through it is what makes the compiled
module's `filename`, `paths` and its own `require('./markdown')` / `require('./unicode')` resolve
against the snapshot the way the unpatched file's would have.

### Installed from both entry points

- `src/generator/pinned.js`, at module load, **before** its literal
  `require('gm-apprentice-publish/lib/processor')`, next to the existing `installSegmenterShim()`
  call and for the same reason: this facade is the one Scriptorium module allowed to deep-require the
  pin's internals, so installing here covers every consumer by construction.
- `src/generator/bootstrap.js`, inside `runGeneratorBuild`'s `try`, beside `applyRedactions()` and
  before `require('gm-apprentice-publish')`, so a throw fails the build closed rather than shipping
  a build whose patch was silently skipped.

Both are needed. `check` loads `pinned.js` long before, and usually without, `runGeneratorBuild`
ever running. Whichever runs first patches and marks; the second reports `already-patched` and does
nothing. A second call deliberately does not recompile: that would hand later consumers a different
module object from the one earlier consumers already destructured.

### Nothing on disk changes

`node_modules/gm-apprentice-publish/` is not touched, not one byte, and neither is `PIN.json` or the
`.tgz`. The installed tree stays byte-identical to upstream, so `npm run verify-generator` keeps
meaning "this is upstream `5779522`" and the local delta lives visibly in Scriptorium's own source
where a reviewer can find it.

There is deliberately **no `pkg.patches` entry** either. See rejected alternative 5.

## Rejected alternatives

**1. Patch `node_modules` and re-derive `PIN.json`.** Fails on a clean clone. `package.json:40`
installs the generator from `file:vendor/gm-apprentice-publish/gm-apprentice-publish-1.11.30.tgz`, so
`npm ci` re-extracts pristine upstream bytes and the hand-edit is gone; re-deriving `PIN.json` to
match the edited tree then makes `verify-generator` fail on every fresh install, because the pin
manifest would describe a tree that install never produces. Making it work at all means repacking a
modified `.tgz`, which is forking the dependency, a maintenance burden ADR 0005 exists to avoid, and
an integrity story that no longer says "this is upstream at commit X".

**2. Monkeypatch the exported `filterSections`.** Reaches `lib/build.js:345` only, and only if it
wins the load-order race, and it cannot reach the two internal closure call sites at all. See "the
load-bearing finding" above: this produces a build whose search index is clean and whose page HTML
still leaks, which is a worse failure than the current one because it looks fixed.

**3. A post-build pass over the built HTML, the pattern ADR 0006 established for
`sessions/index.html`.** ADR 0006's precedent does not carry here. `publishedMarkdown` is computed in
memory at `lib/build.js:345` and never written to disk, and it is the sole input to the search index,
backlinks, recency, the story spine and `lib/templates/npc.js`. No pass over output files can reach
it; the most such a pass could do is strip the leaked region from the HTML while every derived widget
kept indexing it. ADR 0006 worked because its target *was* an output file.

**4. Re-implement `processContent` / `playerSafeMarkdown` in Scriptorium.** `separateBoldLabelLines`
and the configured `md` renderer instance are module-private to `lib/processor.js`, so a Scriptorium
copy would have to reproduce both, and then drift on every pin move, the exact failure mode ADR 0006
rejected for reimplementing `baseShell`. It also makes Scriptorium a second producer of page HTML for
every page, rather than for one index page.

**5. `pkg.patches` only.** `pkg.patches` rewrites source at packaging time, so it changes the
packaged exe and not node-from-source. The test suite, `check`, and every developer run would keep
the defect while the shipped binary did not. That is precisely the artefact/source divergence
CLAUDE.md's first rule exists to prevent, arrived at deliberately instead of by accident. (ADR 0007's
`pkg.patches` entries are the opposite case: they exist as a *second* layer behind a runtime
redaction that already works in both, specifically so the two agree.)

## What happens when upstream fixes it

`classifySource`'s `upstream-fixed` branch makes this module a **reported no-op** the moment
`lib/processor.js` arrives with the corrected form and no anchor: no patch is built, `require.cache`
is not seeded, and nothing is thrown. That matters because seeding a recompiled copy of an
already-correct file would silently shadow upstream's own fix, and any later divergence in that file
would be invisible.

Separately, `SECTION_FILTER_PATCH.expectedSha256` is hardcoded and **bound to `PIN.json` by test**
(`test/section-filter-patch.test.js`), exactly as `test/redactions.test.js:32-47` binds the two
redaction hashes. The day a pin move touches `lib/processor.js` at all, that test fails and a human
has to re-read `filterSections` before the pin can ship. The `upstream-fixed` branch is the safety
net; the hash binding is the alarm.

**When upstream has fixed it, the module is deleted**, `src/generator/sectionfilter.js`, its two
install calls, and its two test files, not left in place reporting `upstream-fixed` forever. ADR
0005's pin-move procedure says so as a step.

## Residuals: what this does and does not close, deliberately

**Closes:** the nested-exclusion leak on every surface a build produces, page HTML
(`lib/processor.js:565`), the player-safe chain (`:534`), and everything derived from
`page.publishedMarkdown` (`lib/build.js:345`): `search-index.json`, backlinks, recency, the story
spine, and NPC templates. Covered end to end by `test/section-filter-build.test.js` against a real
`runBuildCommand`, with positive controls so the negatives cannot pass vacuously, and proven to have
teeth by mutation (identity swap: HTML, `search-index.json` and the backlink sidebar all go red).

**Does not close, deliberately:**

- **`keepOnlySections` (`lib/processor.js:131-135`) carries the symmetric defect and is not
  patched.** Its `keepLevel = level` is unconditional in the same way, so a nested *included* heading
  drags `keepLevel` down and the next sibling at that level stops being kept. That direction fails
  **closed**: it drops content early. It publishes nothing that should not be published, which is the
  only property this change is buying. Patching it would widen the surface of a source-rewriting
  patch for a cosmetic gain on `publish: stub` pages. It is reported in the upstream draft below, so
  upstream can fix both together.
- **The packaged-exe behaviour of this patch is UNVERIFIED. Open.** The mechanism depends on
  `fs.readFileSync` of a `/snapshot/...` path returning the module source that ADR 0010 says pkg
  embeds verbatim (bytecode compilation is off, so the source is what is in the snapshot), and on
  `Module._extensions['.js']` still being the hook pkg's own loader dispatches through. Both are
  believed true and neither was tested: **no exe was built in this work**, and `npm run package` was
  explicitly out of scope. Per CLAUDE.md's first rule, a green Linux-from-source suite says nothing
  about the artefact. `.agents/windows-verification.md` C28 is the criterion that closes this, on Windows,
  against the real `scriptorium-win-x64.exe`. Until that comes back green, treat the packaged path as
  unproven.
- **`src/checks/leak/textmodel.js`'s model becomes correctly narrower, and that is not a
  regression.** `deriveRenderedText` runs the same `filterSections` via `src/generator/pinned.js`, so
  a withheld name living only under a nested excluded heading now produces **no** leak finding,
  because it genuinely stops being published. The finding disappearing is the fix working. It is
  recorded here so nobody later reads a shrinking finding count as lost coverage and "fixes" it.
- `filterSections`' other limits are untouched and stay untouched: exact-title matching only (so
  `## GM Notes (spoilers)` still survives, which is what `src/checks/leak/l5.js` exists to report),
  case-insensitive comparison, CRLF normalisation, line-based scanning with no awareness of fenced
  code blocks.
- One non-literal `require()` is added on the Scriptorium side (`require(resolved)` in
  `applySectionFilterPatch`). ADR 0005's FR-DEP-08 finding, that `lib/build.js:25` is the only
  non-literal `require()` in the pin's own `lib/` tree, is unaffected, but a future re-run of that
  audit over `src/` will see this one. It is intentional and is the point of the mechanism.

## Upstream issue draft (NOT FILED, filing is the owner's call)

Target: `AntTheLimey/gm-apprentice`, matching the house style of issues 209-211 and 214 filed from
this project.

---

**Title:** `filterSections` publishes the sibling of a nested excluded heading

`tools/publish/lib/processor.js:77-108`. Observed at `5779522640ebc655f64aaeac4ea66b9e1214e2ba`
(1.11.30).

`excludeLevel = level` at `lib/processor.js:96` is unconditional, so an excluded heading nested
inside an already-excluded region re-anchors the open region at the inner level. The next sibling at
that inner level then satisfies `level <= excludeLevel` (`:90-92`), clears `excluding`, and is
published.

Repro, with `excludeSections: ['GM Notes','Needs']`:

```markdown
# Page
Intro text.

## GM Notes
Prep one.

### Needs
A prep question.

### Rumours In Play
LEAK-SENTINEL-ALPHA

## Public Bio
Visible body.
```

Expected:

```markdown
# Page
Intro text.

## Public Bio
Visible body.
```

Actual, `### Rumours In Play` and its body are published:

```markdown
# Page
Intro text.

### Rumours In Play
LEAK-SENTINEL-ALPHA

## Public Bio
Visible body.
```

Trace: `## GM Notes` sets `excludeLevel = 2`; `### Needs` is also excluded and overwrites it with
`3`; `### Rumours In Play` is level 3, `3 <= 3` holds, so the region closes early.

This is not only a rendering problem. `filterSections` is called three times:
`lib/processor.js:565` (`processContent`, the page HTML), `lib/processor.js:534`
(`playerSafeMarkdown`), and `lib/build.js:345`, which computes `page.publishedMarkdown`. Via
`publishedSource` (`lib/processor.js:498-501`) that value feeds `lib/search-index.js`,
`lib/backlinks.js`, `lib/recency.js`, `lib/story-spine.js` and `lib/templates/npc.js`, so the leaked
text also reaches `search-index.json`, and a `[[wiki link]]` inside the leaked region creates a real
"Mentioned In" backlink on the target's page.

Suggested fix, at `lib/processor.js:95-96`:

```js
        if (!excluding) excludeLevel = level;
        excluding = true;
```

`excluding` is true there only when the current heading did not already close the open region
(`:90-92` clears it otherwise), so `!excluding` is exactly "this heading opens a new region". A
heading that closes one region and opens another at the same level still re-anchors correctly.

`keepOnlySections` (`lib/processor.js:131-135`) has the mirror image of this bug, `keepLevel =
level` is unconditional the same way, so a nested kept heading makes the next sibling stop being
kept. That one fails closed (content is dropped, not published), but it is the same two-line shape if
you want to fix both together.

## Retired at publish-v1.11.40 (2026-09-30)

**Upstream fixed it, and the fix is genuine, confirmed by hand, not by trusting
`classifySource()`'s own verdict alone**, per this ADR's and `docs/COLLABORATING.md`'s own warning
that a structural rewrite of the same bug does not necessarily trip that heuristic. At `78696167`,
`lib/processor.js:93-119` now reads:

```js
      if (excluding && level <= excludeLevel) {
        excluding = false;
      }

      // Never re-anchor an exclusion that is already running: a nested
      // excluded heading (`## GM Notes` / `### Player Notes`) used to reset
      // excludeLevel to 3, so the next `### Secrets` ended the exclusion and
      // published the rest of GM Notes (#228).
      if (!excluding && excludeSections.some(s => title.toLowerCase() === s.toLowerCase())) {
        excluding = true;
        excludeLevel = level;
        continue;
      }
```

This is the structural fix, not the naive reorder this module's own `REPLACEMENT` string expects:
the whole assignment block is now gated on `!excluding`, so when a nested excluded heading is
reached while an outer exclusion is already open, the block is skipped entirely and `excludeLevel`
is never overwritten to the inner level. Traced by hand through the nested case: `## GM Notes`
(level 2) sets `excluding = true, excludeLevel = 2`; the nested `### Player Notes` (level 3, also
listed) hits `excluding && level <= excludeLevel` so `3 <= 2` is false, stays excluding, then
`!excluding` is false so the block is skipped, `excludeLevel` stays `2`; a sibling `### Rumours In
Play` (level 3, not listed) still satisfies `excluding && 3 <= 2`, which is false, so exclusion continues
correctly until a heading at level ≤ 2 closes it. Exactly the outcome #228 asked for, and the
upstream comment cites #228 directly.

**Confirmed via `classifySource()` too, for the record, but not relied on alone**: this exact
two-line anchor (`excluding = true;` then `excludeLevel = level;`, 8-space indent) still occurs
once in the new code, now nested one level inside the `if (!excluding && ...)` guard rather than
reordered, the same ambiguity `docs/COLLABORATING.md`'s "Verified while writing this guide" note
predicted for a hypothetical structural fix, and exactly why the by-hand read above is the real
evidence, not the classifier's own verdict.

**Retired, not left patching a no-op forever:**
- `src/generator/sectionfilter.js` deleted, along with its two install call sites
  (`src/generator/pinned.js`'s facade module load, `src/generator/bootstrap.js`'s
  `runGeneratorBuild`) and its unit test file, `test/section-filter-patch.test.js`.
- `test/section-filter-build.test.js` (the real-build regression proof) is **kept**, header comment
  rewritten: it now proves the *pin itself*, unpatched, gets the nested-exclusion case right,
  rather than proving the patch's effect on a real build.
- No code in `src/` or `test/` still references `sectionfilter`/`applySectionFilterPatch` outside
  historical prose comments explaining the retirement.

**Residual, unchanged by this repin:** `keepOnlySections` (`lib/processor.js`, the mirror-image bug
noted above) is still unfixed upstream at `78696167` and still fails closed (content dropped, not
published), this ADR's own scope was always the `filterSections` leak risk, not `keepOnlySections`,
and that stays true.

---
