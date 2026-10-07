# 0006. `sessions/index.html` is written by Scriptorium's own post-build pass, not a vault page

Status: accepted (Site UI Engineering Brief 2026-09-17, SD-3/SD-4, Chunk A).

## Summary

The Sessions page of a built site is written by Scriptorium after the generator finishes, because the generator links to that page from every other page but never writes it. Without this, every Sessions link on a built site would lead to a not-found page. Adding an index note to the vault was rejected, because it would give the vault a second writer and would hide an upstream fix if one ever arrived. If the generator starts writing the page itself, Scriptorium's writer notices and skips its own.

## Decision

`src/build/sessions-index.js`'s `writeSessionsIndex` runs in `runAtomicBuild` (`src/build/run.js`)
after a successful generator build and before `writeSiteNotice`, so the new page gets the same footer
link as every other page from the existing walker. It writes `sessions/index.html` by transforming a
donor page: read the first `sessions/*.html`, splice new content between the pin's own
`<main class="content">` and `</main>`, rewrite `<title>`. It skips (`reason: 'already-generated'`)
the moment `sessions/index.html` already exists.

## The problem

`sessions` is absent from `DIR_LABELS` (`lib/templates/base.js:3-20`), so the pinned generator never
writes `sessions/index.html`. Every page's nav links "Sessions" at that path regardless
(`lib/templates/nav.js:7,53`), so every built site ships 222 references to a 404. Filed upstream as
https://github.com/AntTheLimey/gm-apprentice/issues/214, confirmed unfixed at the pinned commit.

## Why a post-build pass, not a vault page

1. **It self-retires.** If issue 214 is fixed upstream, `sessions` joins `DIR_LABELS` and
   `lib/build.js:874-912` writes the index itself on a future pin bump. This writer's
   `already-generated` skip means that day it simply stops doing anything, silently, with no code
   change required here. A vault `Recaps/index.md` does the opposite: `lib/build.js:902-906` gives an
   authored index precedence over the generated one, which would keep shadowing the upstream fix
   forever.
2. **No vault write.** The vault is single-writer (a curation agent works it directly); Scriptorium
   writing into it would be a second writer.
3. **No hand-maintenance.** An authored index has to be edited every session or it silently omits the
   newest recap, exactly the failure the generated site exists to prevent.
4. **No new `check` findings.** A non-entity file inside `Recaps/` would land in Scriptorium's own
   census and frontmatter checks.

Cost accepted: Scriptorium becomes a second producer of site HTML, for exactly one page, with an
explicit hand-back path to the generator the moment it catches up.

## Why donor-transform, not reimplementing the shell

`baseShell` emits exactly one `<main class="content">` per page (`lib/templates/base.js:69-72`); every
sidebar layout is a `<div class="content-with-sidebar">` inside it. Reimplementing the shell (nav
markup, CSS link depth, footer, script tags) in `sessions-index.js` would be a second copy of
`baseShell` that silently drifts from the pin on every future generator bump. Instead, the writer reads
the first `sessions/*.html`, replaces only the span between the first `<main class="content">` and the
first `</main>`, and rewrites `<title>`. Nav, CSS links, relative depth and the notice footer link all
come from that donor page's own shell and cannot drift from it. `test/build-sessions-index.test.js`
carries a change-detector test asserting the pin's `base.js` still emits both literal strings, in the
idiom of `test/build-site-mirror.test.js:135-153`.

The cost: if the donor page's shell lacks `<main class="content">` or `</main>` (a future pin rewrite),
the writer throws a `ScriptoriumError` rather than emit a malformed page. `runAtomicBuild` leaves
`finalOut` untouched on any throw, so a failed build is strictly better than a broken one reaching
players.

## What this does not do

- Does not rewrite the 222 existing `sessions/index.html` hrefs; they resolve once this page exists.
- Does not redirect to the single current recap. The vault it was tested against had a single session; that is a content
  fact, not a reason to special-case "one session" behaviour that would have to be undone the moment a
  second recap is published.
- Does not author or touch anything under the vault.

## Amended by ADR 0033

Reason 2 ("No vault write") gains a second narrow exception, the admin panel's backed-up edits to
`_meta/vault-config.md`. See ADR 0033.

## Addendum: self-retired at publish-v1.11.40 (2026-09-30)

**Confirmed self-retired, not deleted.** At `78696167`, `lib/templates/base.js`'s `DIR_LABELS` now
includes `'sessions': 'Sessions'` (citing upstream issue #214 directly in its own comment), and
`lib/build.js` iterates `Object.entries(DIR_LABELS)` the same way for every section, including
`sessions`. The pin itself now writes `sessions/index.html` before this module's own
`writeSessionsIndex` call ever runs.

This module's own existence check (a plain `fs.existsSync`, not a source-text match) is exactly
what makes the retirement automatic: a real build of `test/fixtures/wrapup-vault` (which has
session content) now returns `{ written: false, reason: 'already-generated' }` from
`writeSessionsIndex`, proven directly against the real, installed v1.11.40 pin. No code change was
needed for this to happen, the module is kept in place, doing nothing, exactly as this ADR's own
design intended ("the cleaner outcome of the two self-retiring patches in this repo, contrasted
with `sectionfilter.js`", `docs/COLLABORATING.md`).

`test/build-sessions-index.test.js`'s existing synthetic coverage (the `already-generated` escape
hatch, the donor-transform assumption change detector) is unchanged and still passes; it proves the
mechanism generically. This addendum records the one additional fact worth writing down: the
mechanism is no longer merely available, it is now the ordinary path every real build with session
content takes.
