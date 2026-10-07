# 0014. Story nav split toggle: a post-build HTML transform, not a vendored edit

Status: accepted (2026-09-23); superseded by upstream at publish-v1.12.4, retired 2026-10-06 (see the final addendum).

## Summary

On a built site, the Story entry in the top bar acted as both a link and a drop-down toggle, and the click only opened the drop-down, so players could not reach the Story page from it. A step after the build now splits it into a plain Story link and a separate caret button that opens the menu. Editing the vendored generator was forbidden, so the change is made to the built pages instead. Adding a separate script file was rejected as too heavy for a few lines, so a small inline script keeps the caret's state in step.

## The problem this closes

The pinned generator's grouped desktop Story toggle (`node_modules/gm-apprentice-publish/lib/templates/nav.js:75-77`) does two jobs with one element. When a vault has a Story section (chapters and/or a
populated Sessions/Events group), the toggle is rendered as a link:

```html
<a class="nav-group-toggle" href="story.html">Story</a>
```

`lib/templates/base.js:86-93` binds a click handler to every `.nav-group-toggle` at page load. The
handler calls `preventDefault`-free `addEventListener('click', ...)` on the element itself, which
does not stop the anchor's own default navigation, but it does mean a single click either navigates
to `story.html` (if the browser gets there first) or toggles `.nav-group.open` (if the handler runs
first), in practice, on every browser tested, the click handler wins and the dropdown opens; the
link never actually navigates by clicking the visible "Story" text at all. A user who wants to read
the Story landing page has no way to reach it from the toggle itself; they have to know the
dropdown holds a link to it, or navigate via `story.html` directly (bookmark, breadcrumb, search).
Every other top-bar group (Characters, World, Reference) is a `<button>`, not a link, because those
groups have no landing page of their own, Story is the only one with this ambiguity, and it is the
group most players click into.

## Decision

A post-build transform, `src/build/storynav.js`, splits the rendered toggle into two elements after
the generator has already run:

```html
<a class="nav-group-link" href="story.html">Story</a>
        <button type="button" class="nav-group-toggle nav-caret" aria-label="Open Story menu" aria-expanded="false" data-scriptorium-storynav><span aria-hidden="true">&#9662;</span></button>
```

The link carries only navigation. The caret carries only the dropdown, and, because it still
carries `.nav-group-toggle`, `base.js`'s existing click/outside-click handlers and `js/nav.js`'s
Escape handler drive it exactly as they drove the original single element, all keyed off
`btn.parentElement` (the shared `.nav-group`). No behavioural JS needed writing at all for open,
close, outside-click or Escape, only for the one thing nothing already tracked:
`aria-expanded`, synced by a small inline `<script>` per patched page via a `MutationObserver` on
the group's `class` attribute (covers every path that can add or remove `.open`, present or
future, without the transform having to enumerate them).

Matching and replacement are scoped to the `<nav class="nav-groups">…</nav>` region, and only fire
on a Story anchor immediately followed (after whitespace) by `<div class="nav-dropdown">`, the
shape that makes it a *group* toggle rather than the standalone Story link
(`lib/templates/nav.js:87-89`, rendered when a vault has Story content but no populated
Sessions/Events sub-groups) or the mobile overlay's own `<h3><a>` heading (outside the `<nav>`
region entirely, and a different tag shape besides).

Wired into `src/build/run.js` between `writeHouseStyle` and `scanStagingOutput` (Structural
decision 8): after the house style pass, so the cloned `sessions/index.html` gets patched like any
other page; before the leak scan, so the scanned tree is exactly the tree that swaps.

## Rejected alternatives

**Edit `node_modules/gm-apprentice-publish/lib/templates/nav.js` directly.** Forbidden outright,
CLAUDE.md's "Never touch" list, and the vendored tree is integrity-pinned per-file against
`vendor/gm-apprentice-publish/PIN.json`; any edit there fails `npm run verify-generator`.

**A load-time source-swap patch, the technique `docs/decisions/0013-nested-section-exclusion-patch.md` used for the sibling-heading defect.** That technique reads the pin's own source at load
time, patches it in memory, and reseeds `require.cache`, appropriate for a defect that must be
fixed *before* the generator runs (0013's bug corrupts which content gets published at all, and no
post-hoc HTML transform could recover text the generator never wrote). This is a pure presentation
change to already-correct output: the generator writes the right links, in the right places, with
the right `href`s, nothing about *what* is published is wrong, only how one element is chosen to
represent two jobs. A post-build transform is strictly simpler here, needs no source patch, no
`require.cache` seeding, and does not carry 0013's own open risk (`.agents/windows-verification.md` C28:
"Neither was tested... the packaged behaviour of this patch is OPEN") into a second feature. Issue
#32, open on the source-swap technique inside `pkg`'s packaged snapshot filesystem, is a second,
independent reason not to add a second consumer of it before #32 resolves the first.

**A new `assets/site/*.js` file for the `aria-expanded` sync script**, rather than an inline
`<script>` per patched page. Rejected: it would change the asset gate from 33 to 34 assets,
`scripts/pkg-assets.js`'s `FIRST_PARTY_SITE_ASSETS`, `test/package-config.test.js`'s change
detector, the site's own file set, and the Windows embedding list, a five-place ripple for about
six lines of JS that has no reason to be cached or shared as a separate file. An inline `<script>`,
marked with the same `data-scriptorium-storynav` attribute the caret button carries, keeps the
asset surface unchanged and keeps the whole feature's footprint inside one new module plus one
`run.js` call site.

## Marker placement, and a residual gap it closed mid-build

The marker (`data-scriptorium-storynav`) sits on both the caret `<button>` and the `<script>` tag,
so a patched page carries it exactly twice, and idempotency guards on `html.includes(MARKER)`
first, before any other condition, the same technique `src/build/housestyle.js`'s `MARKER_ATTR`
uses (SD-4 there, SD-6 here).

Mutation-proving that guard (delete the `if (html.includes(STORYNAV_MARKER)) return null;` line
entirely) left the whole suite green. The reason: `transformStoryNav`'s own matching regex requires
`class="nav-group-toggle"` on the Story anchor, and the rewrite itself renames that anchor's class
to `nav-group-link`. A second pass over an already-patched page therefore fails to match for a
completely different reason (the anchor no longer looks like an unpatched one) than the marker
guard was written to provide. `applyStoryNav`'s idempotency test passed under the mutation for that
structural reason alone, not because the guard fired, so it proved nothing about the guard
specifically, even though it read as a green idempotency test. A second, narrower test was added
(`test/build-storynav.test.js`, "the marker guard fires even when the grouped Story toggle is still
matchable") using a forged fixture: a stray HTML comment carrying the marker text, sitting above an
otherwise still-unpatched, fully matchable grouped Story toggle. Only the marker guard, not the
anchor-class rewrite, can make that fixture return `null`, and it does; the same mutation now goes
red against it. Recorded here per CLAUDE.md's testing standards ("Any mutation that leaves the
suite green is a finding in its own right").

## Limits: will catch / will not catch

**Will catch:**
- A grouped Story toggle rendered anywhere inside `<nav class="nav-groups">…</nav>`, at any link
  depth (`story.html`, `../story.html`, `../../story.html`, …), with the `href` re-emitted
  byte-for-byte.
- A second build pass over an already-patched site (idempotent: 0 pages patched, marker count
  stays at exactly 2 per page).
- The standalone Story link, the mobile overlay's own Story heading, the all-buttons layout (no
  Story group at all), a page with no `<nav class="nav-groups">` region, and a page with no
  `</body>`, all left byte-identical, by construction (each fails one of `transformStoryNav`'s own
  preconditions, not by an exclusion list keyed to a template name).

**Will not catch, deliberately:**
- **An upstream markup change to `nav.js`'s toggle shape makes the transform match nothing, with no
  error.** `STORY_TOGGLE_RE` is an exact string match on
  `<a class="nav-group-toggle" href="...">Story</a>` followed by whitespace and
  `<div class="nav-dropdown">`. If the pin ever changes attribute order, quoting, whitespace inside
  the tag, or the dropdown's own class name, this transform silently stops firing, no crash, no
  refused build, just every page falling through to the "no grouped Story anchor" branch.
  `result.storyNav.pagesPatched` is the only signal a caller has that this happened; nothing here
  currently asserts a *nonzero* count on any real vault (test 10 against `test/fixtures/pin-vault`
  deliberately asserts `pagesPatched === 0`, because that fixture has no Story section at all, see
  below). A future engineer wiring a grouped-Story fixture into CI, or watching
  a real campaign vault's own scratch build's `pagesPatched` count, is the mitigation; none
  exists today.
- **This vault's own build fixture, `test/fixtures/pin-vault`, never exercises the grouped shape at
  all.** Its `folderMap` has no `chapters`, `sessions`, or `events` entries, so
  `buildStorySpine(pages).length` is `0`, `hasStory` is `false`, and `nav.js` never emits a Story
  link of either shape for it. `test/build-storynav.test.js`'s real-build test (test 10) confirms
  `pagesPatched === 0` against this fixture and states explicitly that it does not exercise the
  grouped shape; every other grouped/standalone/depth assertion in that file runs against
  hand-built literal-string fixtures, not a real generator build. A real campaign vault
  does exercise the grouped shape, confirmed by the brief's own live citation
  (`story.html:15-58`) and the Engineer's own scratch build against a snapshot clone of it.
- **The packaged artefact.** Per CLAUDE.md's first rule, everything above is Linux-source-verified
  only. `.agents/windows-verification.md` C29 tracks the win-x64 exe's own behaviour separately and stays
  **OPEN** until confirmed there.

## Amendment (2026-10-03, issue 95): the label opens the dropdown too

The "Decision" section above says the click handler wins and the original anchor never navigated.
That was wrong, and it is the root cause of the owner's "closes immediately" note. `base.js`'s
handler opens the group but never calls `preventDefault`, so an anchor click still navigates; the
reloaded page is closed. That is upstream generator JS, present on any page the transform does not
touch. The split fixed the caret, but left the "Story" label a plain navigating link, which
reproduced the same symptom for anyone who clicked the word rather than the caret.

Now the transform's inline script also binds the label: it calls `preventDefault` and toggles the
same `.open` class as `base.js` does (one menu at a time). To keep the Story landing page
reachable, the dropdown gains a first entry, `Story overview` (`a.nav-story-overview`), with the
label's own href. Without JS the label is still a plain link. Tests:
`test/storynav-click-behaviour.test.js` runs the pinned `base.js` block and the emitted script in a
small DOM shim. The caret path already passed before this change, so those tests are regression
guards only. Not reproduced: a caret click closing the menu, in Chromium or Firefox, on the sample
or the live site; confirm on the owner's browser.

Follow-up (same day): Escape closed the menu but left focus on a now-hidden dropdown link. The
inline script returns focus to the caret when Escape is pressed with focus inside the Story dropdown.
Tested in `test/storynav-click-behaviour.test.js` against the real pinned `js/nav.js`.

## Addendum: retired at publish-v1.12.4, verified at publish-v1.14.0 (2026-10-06)

**Status of this ADR: superseded by upstream. `src/build/storynav.js`, its two unit-test files and
the `.nav-group-link` / `.nav-caret` block in `assets/site/scriptorium.css` are deleted.**

Upstream fixed the same defect at `publish-v1.12.4` (their #296 and #304). `lib/templates/nav.js` now
renders the grouped Story toggle as `<button class="nav-group-toggle">Story</button>`, which only opens
the menu (`base.js`'s click binding drives it, with nothing to navigate), and puts the Story landing in
as the menu's first entry, labelled `Story so far`. The chapter index entry reads `Chapters` (1.12.5).

Why it had to go, not just be left alone: `STORY_TOGGLE_RE` needs `<a class="nav-group-toggle"
href=...>Story</a>` ahead of the dropdown. At the new pin that string is never emitted, so the
transform patched nothing, which is this ADR's own "will not catch" case. No double-apply and no crash,
and every test stayed green, because every one of them ran on a literal fixture that still held the old
anchor. That passing was false comfort. Measured: a real build at 1.14.0 reports
`storyNav: { pagesPatched: 0 }`.

What replaces the proof: `test/story-nav-pin.test.js`, which builds a vault through Scriptorium's own
pipeline and asserts on the real output. One test (no browser) checks that every page's grouped Story
toggle is the button, followed by a first entry `Story so far` pointing at the landing from that page's
depth, and that no retired marker is present. The other (Chromium, 1440 wide) checks that a click on the
label opens the menu, does not navigate, and the menu is still open half a second later; that the
overview entry is first, visible and reaches `story.html`; that Escape closes the menu with focus kept
on the toggle; and that Enter reopens it.

User-visible: the first entry now reads `Story so far`, not `Story overview`. Nothing in our CSS or
text referred to the old label.

**Downstream focus shim, pending upstream.** The follow-up above made Escape, pressed with focus inside the
open Story dropdown, return focus to the toggle. The pin's `js/nav.js` still only removes the `open` class on
Escape (checked at 1.14.0), so focus would stay on a dropdown link that has just been hidden (WCAG 2.4.3). The
owner decided to keep the behaviour, so `src/build/storyfocus.js` adds one small inline script (marker
`data-scriptorium-storyfocus`, linked once on every page that has the pin's grouped Story button, wired in
`src/build/run.js` before the leak scan). It listens for Escape in the capture phase and returns focus to the
Story toggle only when focus is inside that group's dropdown; if focus is already on the toggle, or anywhere
else, it does nothing, so it is inert once the pin handles focus itself. It edits no generator file.
**Retire it when upstream adds the focus return** (delete the module, its call in `run.js` and the shim test in
`test/story-nav-pin.test.js`). The real-browser test in `test/story-nav-pin.test.js` was red without the shim and
is green with it.
