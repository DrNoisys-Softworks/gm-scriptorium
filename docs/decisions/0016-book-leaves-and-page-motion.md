# 0016. Book leaves and page motion: the LEAF scope, the token split, gated names, the badge join, the date transform, and the b2 fold

Status: accepted (2026-09-24).

## Summary

Inner pages of a campaign site now read as leaves of a book, and moving between pages feels like turning a page. Every such rule is scoped so it never touches the cover page or the not-found page, and the product layer supplies only neutral structure, leaving colours to the campaign. Matching session badges by position in the CSS was rejected, because it breaks when a field is missing, so a build step works out each badge from the page's own data. Page-turn motion relies on browser features that not every browser has, and falls back to a plain page change where they are missing.

## The problem this closes

Every inner page of a real campaign's player site needed to read as a page in a book rather than a
generic wiki entry, and moving between pages needed to read as turning through that book, while
every other vault Scriptorium might ever build had to keep its own plain default look and motion
exactly as it is today. That is the same product/campaign tension Track A (0015) closed for the
landing page, applied now to every page Track A's cover excludes, plus a second, harder problem:
Cross-document View Transitions have no vault-content awareness at all, so the scaffold, the gated
names, and the reduced-motion fallback all have to be colour-free, generic pin classes, the
campaign only ever supplies literals for tokens the product layer already declared.

Four other, smaller problems travel with the leaf treatment because they were discovered while
building it: the pin's session badges are positional, so hiding the GM's "reviewed" status and
captioning the session number both break the moment a field is missing; the recap dates print in
whatever timezone the build machine happens to be in; the PC page's Background/Notes accordions
need to arrive open without breaking their own toggle; and the leaf-to-leaf turn itself needed
filling once the owner ruled it in scope this run (AMENDMENT 1, E-2).

## The LEAF scope: one selector, excluding the cover and 404 by construction

Every leaf rule in `assets/site/scriptorium.css`'s "Book leaves (Track B)" section carries the
exact prefix

```
body:has(> .top-nav) > main.content:not(:has(> .landing-hero))
```

(0,3,2), never depending on stylesheet order. `:has(> .top-nav)` excludes 404.html (its own
`.site-header` shell, no `.top-nav`); `:not(:has(> .landing-hero))` excludes the landing page (Track
A's cover). Both exclusions are structural, no body class, no JS, nothing that could drift out of
sync with the page shape the way a hand-maintained class list could. **Rejected**: a body class set
by a transform, which would widen the HTML diff (AC-19 caps it at the head script, date text,
accordion attributes and badge attributes) and make layout depend on JS running before first paint.

## The token split: product declares neutral defaults, campaign supplies the vellum

`assets/site/scriptorium.css`'s `:root` block declares every `--sc-leaf-*` token (plus AMENDMENT
E-4's five fold tokens) with a **theme-token default**, `var(--bg-card)`, `var(--accent)`, and so
on, so a vault that never opts into a campaign leaf theme still gets a coherent, colour-consistent
leaf using its own existing palette. `docs/handoff/campaign-ui/css/overrides.css`'s new "Visual
treatment: Book leaves and motion (Track B)" section re-declares the same token names with this
campaign's literal vellum/brass/haze values. Every leaf rule consumes only these tokens; SD-8's
colour ban (no hex outside `color-mix(in srgb, #000|#fff N%, transparent)`, no `rgb()`/`rgba()`/
`hsl()`/named colours) holds for the whole product-layer section, verified structurally by
`test/housestyle-bookleaves.test.js`.

The owner's ruling, confirmed 2026-09-24 ("every Scriptorium site is a book"), matches this split as
written with no change: leaf structure/geometry/motion in the product layer with neutral defaults,
the campaign's vellum/brass/haze values only as token re-declarations.

## Gated names, with the ungated fallback the Reviewer decides

Every `view-transition-name` declaration sits under `:root:active-view-transition`, so no page
carries a name at rest, landing and 404 stay pixel-identical to B0 by construction, not by a
rendering check. The sanctioned fallback (Structural decision 8) if a Chromium check shows no
`::view-transition-old(<name>)` on arrival, the gate not matching on the outgoing document, is to
drop the gate and let the Reviewer's at-rest pixel diff decide; this run never needed it; recorded
here so the next reader knows the escape hatch exists and where its trigger condition is defined.

## The badge join: rejected positional CSS, rejected value heuristics, rejected a pin patch

`src/build/sessionbadges.js` re-derives the exact badge block `pinned.metadataBadgesFor` would
produce for a page's **published** frontmatter (via `pinned.publishedFrontmatter`, never the raw
frontmatter, the `exclude_fields` case is exactly why: a field excluded from publishing must not
still carry a `data-field` badge), and only rewrites that block when it finds the derived string
verbatim, exactly once, in the built page. A mismatch is reported in `unmatched` and the page is
left byte-untouched, "reviewed" stays visible rather than the badge attribute silently drifting
out of sync with a template change nobody noticed.

**Rejected: positional CSS** (`:first-child`/`:last-child`), the mock's own approach, wrong the
moment a field is missing (no `status`, no `session_number`) or `stage` is present without
`status`, both of which the real vault's own recap pages exercise.
**Rejected: value-shape heuristics**, cannot distinguish `status` from `stage` (both are short
free-text strings; nothing about the string itself says which field it came from).
**Rejected: a load-time pin patch of `metadataBadgesFor`** (the ADR-0013-class fix for the nested
section-exclusion defect), that forks pin logic for a Scriptorium-only presentational need, not a
pin defect; annotating post-build keeps the pin itself untouched and unforked.

## The date transform: rejected `Intl`, rejected `toLocale*`

`src/build/dates.js` recovers the UTC instant from a printed `Date.prototype.toString()` and its
printed offset, `Date.UTC(...)` on the parsed local fields, minus the offset in milliseconds, and
prints that UTC calendar date with a literal English month-name array. **Rejected: `Intl`/
`toLocaleDateString`**, the packaged exe's small-icu build does not fully support either
(CLAUDE.md's own "rule that matters more than any other": a defect only the packaged artefact can
show, twice, on 2026-09-17). A date-only YAML value parses (gray-matter, both vault and pin sides)
as UTC midnight, so this recovers the authored calendar date regardless of the build machine's
timezone, sign, or non-integer offset (America/St_Johns, −02:30, is the TZ-matrix case that catches
dropping the offset's minutes).

## The B slot: AMENDMENT 1 fills it with b2 Folded verso

The base contract (FR-11b) left the slot empty until round 3 picked a leaf-to-leaf turn; the owner's
ruling authorised filling it this run with b2 (`scratchpad/round3-build/turns.js`, the `TURNS` entry
`id:'fold'`). The contract itself is barely stretched: one more named element (`leaf-fx`), one
inserted `<div class="vt-fx" aria-hidden="true"></div>`, one `@property --sc-turn-fold`, and a
`scrolled` direction type, every other constraint (≤400ms, `sc-turn-*` keyframe names, no
`:only-child` inside the slot itself, specificity no higher than (0,2,1) on the slot's own rules, no
new assets, D always wins) holds exactly as written.

### `.vt-fx`: a real element, not `::after`

`src/build/pageturn.js` inserts the div in the same all-or-nothing pass as the head script, guarded
by the script's own marker (checked first), no second marker for one line of markup. It goes
immediately before the first `</main>` after the first `<main class="content">`, the same anchoring
`src/build/sessions-index.js`'s `MAIN_OPEN`/`MAIN_CLOSE` already uses, and shares that module's own
residual: a literal `</main>` string inside authored raw HTML in the leaf body would misplace it.
Inserted only on leaf pages (has `.top-nav`, has no `class="landing-hero"`), the same test the CSS
scope applies, so it never lands on the landing page or 404.html, and does land on the
Scriptorium-written sessions index. **Rejected: naming `main.content::after`**, round3.html
confirmed this works in Chromium but is unknown in Safari, and a real element is unambiguous in
both.

### `--sc-vt-over` and the move to 84rem

Round 3's exploration used 56px of fore-edge overhang and an 82.5rem/1320px thumb-tab breakpoint,
sized before the fold's own flap (`.vt-fx`, `inset: 0 calc(-1 * var(--sc-vt-over)) 0 0`) existed.
Once the flap needs 56px of its own gutter on top of the tabs' 44px, 82.5rem no longer has enough
room: a 17px classic scrollbar leaves a 51.5px gutter at 1320, short of 56. At 84rem (1344px) the
gutter is 63.5px, enough for both. `--sc-vt-over` itself is 0px everywhere and only becomes 56px
inside `@media (min-width: 84rem)`, declared beside the thumb-tab block it shares its figure with,
not inside the motion section, so a reader sees why the number is what it is in one place.

### The scrolled threshold: `scrollY > innerHeight / 2`

With `::view-transition-group(leaf){animation:none}`, the browser's own snapshot is taken from the
leaf's current scroll position but the OLD and NEW images are simply composited at their captured
positions with no scroll-following animation, a reader scrolled deep into a long PC sheet would see
the fold play over content far from what they were reading. Below half a viewport of scroll, the old
leaf's top still mostly overlaps what was on screen, so the ordinary fold reads fine; above it, the
scrolled guard drops to a flat 150ms crossfade with no clip and no flap instead of animating a fold
whose crease line has nothing to do with what's visible.

**Reviewer rework (B-1, 2026-09-24).** The paragraph originally here claimed the live `pagereveal`
scrollY check alone covered a history traversal. It does not, and the Reviewer's own Chromium 140
Playwright run proved it: scroll restoration has not run yet when `pagereveal` fires on a Back
navigation, so `window.scrollY` reads `0` regardless of how far down the page the reader actually
was, and the guard silently never fires on Back. Fixed with a second, URL-keyed mechanism instead of
trusting live scrollY at all for a traverse: `pageswap` records the *outgoing* page's own scrollY
under a key naming that page's own URL (`sc-vt-scroll:<url>`, an index of at most 20 URLs, oldest
evicted first, so the store cannot grow unbounded across a long session). On arrival, `pagereveal`
first determines whether this is a traverse (`navigation.activation.navigationType === 'traverse'`,
or the `performance` `back_forward` fallback where `navigation` does not exist) and, only then, looks
up the *current* URL (the page just landed on) in that store, recovering the depth the reader was
at the last time they left this exact page, independent of whatever scrollY reads at reveal time.
The live scrollY check stays as the primary signal for an ordinary forward navigation, where it
is reliable (no restoration delay applies, there is nothing to restore).

Proof: `test/build-pageturn.test.js`'s vm suite simulates the full four-step real sequence (leave A
scrolled, arrive B, leave B, traverse back to A) rather than jumping straight from "leave A" to
"arrive at A", an earlier draft of the test skipped the middle two steps and so still passed
against a wrong-storage-key mutation, because the *unrelated* single-flag `sc-vt-scrolled` value
happened to still be sitting in the shared session from the first step. Recorded as a mutation-proof
finding in the test file itself, not just fixed silently. A real Playwright run against a scratch
build of the actual vault (reproducing the Reviewer's own scenario: scroll to 1500, forward-navigate,
`page.goBack()`) confirms `scrolled` is present on the return trip with the fix, and reproduces the
Reviewer's exact failure (`['back']`, no `scrolled`) when run against the pre-fix code.

### The `@property` fallback: an instant cut, not a broken page

Without `@property --sc-turn-fold { syntax: '<number>'; ... }`, a custom property cannot
interpolate through an animation, the browser would either not animate it at all or jump straight
to the end value, producing an instant cut rather than a fold. Every browser that implements
cross-document View Transitions at all (Chromium 126+, Safari 18.2+) also implements `@property`,
so this is a theoretical fallback, not an observed one; Firefox has no cross-document View
Transitions and simply navigates as it does today, `@property` or not.

### Cover isolation: why the fold needs a dedicated `:only-child` rule

When a leaf goes home to the landing page, the old page's `leaf-fx` element is the only named
element with that name in the outgoing snapshot set (the landing page has no `.vt-fx` of its own),
which makes it `:only-child` of its snapshot group. Left alone, the forward fold rules (`z-index:1`,
`FOLD_FLAP`'s background, the `sc-turn-fold` animation) would still apply and paint a flap over the
closing cover transition, which is Track A's territory, not this one's. The dedicated rule,
`::view-transition-old(leaf-fx):only-child, ::view-transition-new(leaf-fx):only-child { animation:
none; background: none; clip-path: none; }`, is placed with A's own `:only-child` cover rules, not
inside the slot (which never uses `:only-child` by contract), at (0,3,1).

## Reviewer rework (B-3): the remaining grey app-chrome

The first round left six pin components rendering as `style.css`'s flat `--bg-card` pills and cards
inside the vellum leaf, visually a wiki page wearing a book skin rather than a page of the book
itself: `.section-nav` (the PC page's Background/Notes chip row), `.metadata-badge` (the session
number/date/status pills), `.story-nav a` (the boxed "← [location]" prev/next buttons),
`.rel-card`/`.relationship-cards` and `.npc-location-card` (the NPC "Connections" grid and "Where to
find them" card), and `.cdd-param`/`.cdd-genre` (`campaign/index.html`'s System/Setting
Year/… cards and its genre pill row). Restyled all six as book furniture, product layer, LEAF-scoped,
consuming only this file's own `--sc-leaf-*` tokens, no colour literal, no vault content:

- **Chip rows** (`.section-nav`, `.metadata-badge`, `.cdd-param`, `.cdd-genre`): the pill background,
  border and radius are dropped; items read as small-caps or italic text, separated by a `❦`
  (`\2766`, the same fleuron character `.meta > span + span::before` already uses) or, for the
  genre row, a plain middot. The separator is a `::before` on `X + X`, never on the row's own
  padding/margin, so a single item never shows an orphaned mark and a hidden item (the campaign's
  own `.metadata-badge[data-field="status"]{display:none}`) never leaves a stray fleuron either side
  of it, `+` combinator matching walks DOM adjacency, not rendered/visible adjacency, so the
  element after a hidden one still gets its separator against the one before *that*.
- **`.story-nav a`**: the card border/background/min-height are dropped; the link becomes italic
  text in the muted ink colour, brass on hover. The `&larr;`/`&rarr;` arrows are already literal text
  the pin emits, so nothing else changes.
- **Cards** (`.rel-card`/`.relationship-cards`, `.npc-location-card`): the same columned, run-in
  footnote idiom the c3 pick already uses for `.context-sidebar`, `columns: 2 16rem`, no
  background/border/radius, the card's own two-part label (`.rel-type`/`.rel-name`,
  `.loc-label`/the name) forced `display: inline` so it reads as "Located at: [a location's
  name]" rather than a stacked mini-card.

**Regression caught by screenshot, not by a test that existed at the time.** A first draft of the
`.metadata-badge` de-pilling rule declared `display: inline-block`. Because that rule is
LEAF-scoped, specificity (0,3,2) plus the class, it silently outranked the campaign layer's
`.metadata-badge[data-field="status"] { display: none; }` (specificity (0,1,0)) on the `display`
property specifically, un-hiding the GM's "reviewed" status badge on every session page. Caught by
eye on a scratch-build screenshot of `sessions/recap-03-example.html`, fixed by simply never
declaring `display` on the product rule (a `<span>`'s default is already what was wanted), and now
guarded by a dedicated structural test (`test/housestyle-bookleaves.test.js`) asserting the product
`.metadata-badge` rule carries no `display` declaration at all, the general lesson being that any
future LEAF-scoped rule touching a class the campaign layer also keys off needs the same check
before it ships, not after a screenshot catches it.

**Polish: the leaf h2 treatment extended to section-nested h2s.** Structural decision 5's literal
selector (`LEAF :is(.main, .tab-panel) h2, LEAF > h2`) missed every h2 that is neither inside
`.main`/`.tab-panel` nor `main.content`'s own direct child: `index-page.js`'s dashboard sections
(`.cdd-section-title`, "Premise"/"Setting" on `campaign/index.html`), `story-landing.js`'s
`<section class="story-branch"><h2>Character Stories</h2>` on `story.html`, and `story.js`'s
`<aside class="story-refs"><h2>In this session</h2>` on a session/chapter narrative page. Widened the
selector to name all three explicitly rather than leaving them on the old Vellum hairline; `.main`
and `.tab-panel` stay in the selector unchanged for everywhere the original scope already worked.

## Residuals

- **No "up" direction on pages without breadcrumbs.** `story.html`, `story/characters/*` and the
  Scriptorium-written sessions index carry no breadcrumbs, so the head script's `up` detection (a
  breadcrumb link matching the destination) can never fire there; those pages fall back to
  `forward`/`back` only.
- **Safari 18.2-26.1.** `performance.getEntriesByType('navigation')[0].type === 'back_forward'` is
  the only signal available where `window.navigation` does not exist; it cannot distinguish forward
  history-traverse from back (both report `back_forward`), so it is treated as `back`, and `up` is
  never detected at all in that range because `pageswap`'s `activation` is unavailable to read a
  breadcrumb match against.
- **A YAML timestamp with a time renders its UTC date.** `dates.js` recovers the UTC calendar date
  of the printed instant; a date-authored-with-a-time value near a UTC day boundary in a very
  negative-offset zone could print a date one day off from what a GM watching a local clock expects
 , not observed in this vault (every date field here is date-only, which round-trips to UTC
  midnight), recorded because it is a real edge the transform does not special-case.
- **`search-index.json` dates stay raw.** Deliberately out of scope (`dates.js`'s own header
  comment): the index is machine-read by `js/search.js`'s lunr client, not displayed as prose.
- **CoC and GURPS leaves are untested.** The real campaign vault used for verification runs neither
  system (`campaign/index.html`'s own "System" field), so neither system-specific sheet renderer's layout
  inside a leaf has ever been loaded in a browser against these rules.
- **`.hero-cinematic-no-img` is unverified.** This vault has no PC without art; the rule exists (it
  shares the same `:is()` list as every other title target) but nobody has loaded that markup
  against it.
- **The transition's default crossfade dims slightly mid-way**, the ordinary UA behaviour of two
  overlapping `mix-blend-mode: normal` images at partial opacity; unrelated to any rule this brief
  added, present wherever an animation's `old`/`new` images both have non-zero opacity mid-flight.
- **Resolved (Polish, B-3 round):** the `campaign/index.html`/`story.html`/story-narrative
  section-nested h2 gap this residual used to describe is fixed, see "Reviewer rework (B-3)" above.
  `.cdd-section-title` keeps the pin's own uppercase/muted-grey treatment on top of the leaf's
  centring and brass rule (colour and `text-transform` are untouched, deliberately: they are not
  part of decision 5's rule, only position/weight/family are), so it reads as a smaller secondary
  heading rather than pixel-identical to a full leaf h2, a deliberate, not accidental, difference.
- **The exact 50% mid-fold frame is hard to freeze from outside a real browser session.** Verified
  the fold fires (a live cross-document navigation captured via CDP mid-flight shows the clipped
  fore-edge and the flap's brass rule), but CDP round-trip latency made landing on precisely 190ms
  of a 380ms animation unreliable from a scripted capture; the Reviewer's own Playwright run, closer
  to the render loop, is the more trustworthy source for this specific frame.
