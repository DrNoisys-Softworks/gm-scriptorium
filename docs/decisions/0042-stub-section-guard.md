# 0042. Stub pages: withheld sections win over include entries (guard on keepOnlySections)

## Summary

A stub page publishes only the sections the GM names. It could also publish a heading that sat
inside a withheld section, if that heading's text matched a named section, along with its search
entry and backlinks. Scriptorium now removes the withheld sections first, so the withheld parent
always wins. The cause is in the upstream generator, so the fix is a guard in Scriptorium's own
layer, and the build refuses to run if the guard is not in place. Whether this holds inside the
packaged Windows executable is not yet confirmed.

Status: accepted (2026-10-03). Issue 100.

## The defect

`publish: stub` pages publish only the sections named in `publish_include_sections`, via the pinned
generator's `keepOnlySections` (`lib/processor.js`, called at `lib/build.js` for the page body and for a PC's
story companion). It matches headings by **text**, wherever they sit in the tree. Given

```markdown
## Appearance          <- included
## GM Notes            <- withheld (exclude_sections)
### Appearance         <- same text as an include entry
```

`### Appearance` under the withheld `## GM Notes` was kept. `keepOnlySections` also drops the
`## GM Notes` heading line itself (it is not an include entry), so by the time `filterSections` runs
on the reduced body there is no withheld parent left to match, and the sub-heading published: in the
page HTML, in `search-index.json`, and as a backlink on any entity it links to (a `[[wiki link]]`
inside it gave the target a "Mentioned In" entry). Reproduced end to end before the fix
(`test/stub-heading-collision.test.js`).

## Where the cause is

Upstream, not Scriptorium's section filter: Scriptorium never filters sections itself, it calls the
pin's functions. The defect is `keepOnlySections`' text-only matching in `lib/processor.js` at
`publish-v1.11.40`. `check` caught one case only because a withheld *name* happened to be in the
text; a heading with no withheld name has no backstop.

## The decision

`src/generator/pinned.js` replaces the processor's `keepOnlySections` export with a guard that runs
`filterSections(markdown, exclude_sections)` **before** the pin's `keepOnlySections`. This is
equivalent to the pin's own order for every case except the leak, because `filterSections` runs on
every published body afterwards anyway: it only moves the exclusion earlier, so the withheld parent
wins.

- **Reach.** Unlike ADR 0013's `filterSections` (which `processor.js` also calls internally),
  `keepOnlySections` has no internal caller; `lib/build.js` destructures it from the processor's
  exports at its own module load. Replacing the export therefore reaches both call sites, provided it
  happens before `lib/build.js` first loads. `pinned.js` does it at module load; `bootstrap.js` loads
  it first.
- **Fail closed.** The guard records whether it beat `lib/build.js` (`live`). `runGeneratorBuild`
  calls `assertStubGuardLive()` before every build and refuses to build when it is not live (or the
  export was replaced), as a build failure (exit 1, the existing taxonomy; no new code).
- **Effective exclude list.** `runGeneratorBuild` reads the staged config and sets the build's
  effective `exclude_sections` (the same union `src/vault/publishset.js` computes: vault-config.md,
  `vault.config.json`, and `PUBLISH_DEFAULTS`). Without a set list the guard uses `PUBLISH_DEFAULTS`.
  A failure to derive it throws into the build's error path.
- **The check model agrees.** `src/checks/leak/textmodel.js` passes the page's `exclude_sections` to
  the guard, so the rendered-text model of a stub page is the guarded build's.
- `node_modules/gm-apprentice-publish/` is untouched; `npm run verify-generator` is unaffected.

## Rejected alternatives

- **Patch the pin's source (ADR 0013's loader mechanism).** Unneeded here: no internal caller, so an
  exports replacement is enough, and it avoids a second source-rewriting patch.
- **Pre-filter the vault files.** The generator reads the vault directly (no staging copy), and
  Scriptorium never edits the vault.
- **Post-build pass over the HTML.** Cannot reach `page.publishedMarkdown`, so search and backlinks
  would still carry the text (ADR 0013, alternative 3).

## Residuals

- Windows / packaged exe: whether the load-order assumption and `require.resolve` of `lib/build.js`
  hold inside the pkg snapshot is unverified. OPEN: `.agents/windows-verification.md` C81.
- Exact-title matching only, as upstream: `## GM Notes (spoilers)` is not excluded by
  `filterSections` (the L5 check reports it).
- A heading nested under a *non-withheld, non-included* parent still matches an include entry, as
  upstream intends (include entries are by title); only withheld parents now win.

## Upstream note (for the owner to raise; NOT filed)

Target `AntTheLimey/gm-apprentice`, `tools/publish/lib/processor.js` `keepOnlySections`: it matches
by heading text with no regard to ancestry, so a sub-heading whose text equals an include entry is
kept even when its parent section is excluded, and the parent heading's removal means the later
`filterSections` cannot withhold it. Suggested fix: apply `filterSections(markdown, excludeSections)`
before `keepOnlySections` in `lib/build.js` at the two stub call sites, or give
`keepOnlySections` an `excludeSections` parameter. Repro: a stub with
`publish_include_sections: [Appearance]` and `## GM Notes` > `### Appearance`. The leak reaches the
page HTML, `search-index.json` and backlinks. The mirror-image `keepLevel` re-anchoring noted in
ADR 0013 is unchanged and still fails closed.
