# 0015. Into the Haze home: product/campaign split, hero stacking, the recap transform, and the slip slot

Status: accepted (2026-09-24).

## Summary

One campaign's landing page needed an art-directed restyle, while every other page, and every other campaign, had to stay as it was. The look for that one campaign lives in the campaign's own stylesheet, and the product layer keeps only what holds for any vault. The record also settles how the full-width hero image is layered, how emphasis marks in a recap become italics, and how the recap panel's torn-paper treatment can be swapped later. Moving the campaign's roster and portrait styling into the product layer was rejected, because it would force them on every campaign. The generator now does the emphasis step itself, so Scriptorium's version has been retired.

## The problem this closes

A real campaign's landing page needed a bespoke, art-directed restyle (the owner's round-2 picks a1
h1 b1 g1 c1 e1 f1, plus a round-3 slip pick chosen after a start gate), while every other page on the
site, and every other vault Scriptorium might ever build, had to stay exactly as it is today.
Three separate engineering problems sit inside that one restyle: where the campaign-specific CSS
is allowed to live without leaking onto shared templates (SD-2), how to layer a full-bleed hero
image without repeating two already-documented negative-z-index failures on this exact element
(SD-6), how `*…*` markdown in a recap becomes `<em>…</em>` without a vendored-generator edit
(SD-7), and how a hand-picked "slip" treatment (a torn/folded/scorched recap panel) can be swapped
for a different one later without touching anything else in the file (SD-8).

## SD-2: product carries only what holds for any vault; campaign carries the Haze look

`assets/site/scriptorium.css` is the product layer, shipped inside the packaged exe for every
vault Scriptorium ever builds. `scriptorium.css:9-16` already limits it to fixes for pin defects
that hold regardless of campaign content, no hex colour, no vault-specific asset, nothing tuned to
one story. The Haze look (Haze grade violet colour-mix, IM Fell/Cormorant fonts, the roster
sized for this vault's party, the register treatments, the hero art direction, the transparent nav
overlay, and the slip) is entirely a choice for *this* vault. It goes in
`docs/handoff/campaign-ui/css/overrides.css`, appended as one new section ("Visual treatment:
Into the Haze home") after the existing Atlas ground section, following that section's own
precedent for appending rather than editing.

The product layer keeps exactly two things: the `#38` recap-emphasis transform (pure string work,
no CSS at all) and the "landing shell release below 1024", `main.content:has(> .landing-hero)`
losing its `max-width`/`padding-inline`/`padding-top` below the breakpoint the product's own
existing "Full-bleed hero" section already releases it at (`>=1024px`, `scriptorium.css:520-527`).
That release is colour-free structure that holds for any vault choosing a full-bleed landing hero,
campaign-owned look or not, which is why it is product, not campaign.

**Rejected: moving the registers and portraits into the product layer.** They carry no colour
literal, so SD-8's product-layer colour ban would not technically forbid it. Rejected anyway: doing
so would force this vault's roster and quiet-register card treatment onto every vault that
ever opts into a full-bleed landing hero, overriding the product's own Vellum-sheet card treatment
site-wide rather than for this campaign alone. The boundary is "holds for any vault", not merely
"has no colour".

Every campaign selector added is anchored to `.landing-hero`, `.dashboard-section`, or one of two
`:has()` forms (`body:has(> main.content > .landing-hero)` for the nav,
`main.content:has(> .landing-hero)` for `main.content` and `.dashboard-section` themselves),
enforced by `test/handoff-campaign-ui.test.js`'s SD-3-anchoring test. This is what stops the
section from reaching `.entity-card` (shared with Latest Events' `.card-grid`, and with
`location.js`/`index-page.js`/`pc.js`/`pc-dnd.js`/`pc-pf2e.js`), `.pc-portrait` (shared with
`pc.js`/`npc.js`), `.npc-grid`/`.npc-card` (shared with `location.js`), and `.recap-link` (shared
with the timeline zone's own CTA), every one of those classes is reused by templates this feature
must never touch.

## SD-6: hero stacking with no negative z-index

`scriptorium.css:553-622` already records two separate negative-z-index failures on this exact
element: a `.landing-hero-img` that vanished entirely at `z-index:-1` (it escaped `.landing-hero`'s
non-stacking-context ancestor and painted behind the hero's own background, not merely behind its
text), and the same failure again once `.landing-hero` became `display:flex` (flex items paint in a
different tier that sits *before* a stacking-context root's own negative-z-index descendants, so
the image vanished a second time under a *different* mechanism the first fix didn't anticipate).
The round-2 mock's own hero layering used exactly the scheme that caused both: `-3`/`-2`/`-1` for
image/haze-drift/grade-scrim, `auto` (static) for the text.

This feature uses the product's already-proven fix instead: `.landing-hero` gets
`isolation: isolate; z-index: 0` (both needed, `position:relative` with `z-index:auto` alone does
not establish a stacking context), `.landing-hero-img` gets `z-index: 0`, the haze-drift `::before`
gets `z-index: 1`, the grade-scrim `::after` gets `z-index: 2`, and `h1`/`.hero-tagline`/
`.hero-dates` get `position: relative; z-index: 3`. Every layer paints in the intended order with
no negative value anywhere on the hero.

**Rejected: the mock's own −3/−2/−1 scheme**, for the reason above, it is the exact shape of both
documented failures, not a new risk being weighed on its own merits.

## SD-7: the recap `<em>` swap is a post-build transform, not a pin edit

`landing.js:97` runs the recap through `escapeHtml`, which only escapes `& < > "`, a raw
`*Recorded Thursday…*` markdown wrapper reaches the page as a literal asterisk pair, never
markdown-rendered. Fixing this inside the vendored generator is forbidden outright (CLAUDE.md's
"Never touch" list; the tree is integrity-pinned per-file against `PIN.json`). `src/build/recap-emphasis.js`
follows `src/build/storynav.js`'s already-established pattern instead: a pure
`transform(html) -> string | null` plus an `apply(siteRoot) -> { pagesPatched }` walker, wired into
`src/build/run.js` between `applyStoryNav` and `scanStagingOutput`.

Unlike `storynav.js`, this transform needs no idempotency marker. Its own output can never
re-match its own input pattern: `WHOLE_EM_RE` requires an unescaped `*` immediately inside
`<div class="recap">…<br>`, and once the transform has run, that same span reads
`<div class="recap"><em>…</em>…<br>`, `escapeHtml` never emits a literal `*`, and the module never
introduces one, so a second pass simply finds no match and returns `null`. Storynav's own test 1b
already demonstrated this exact shape of proof (a guard that is structurally redundant once the
output itself changes) is legitimate but must still be proven, not assumed, here it is proven by
`applyRecapEmphasis` test 3 (patches 1, then 0, byte-identical after the second run) rather than by
a forged marker fixture, because there is no marker to isolate.

`applyRecapEmphasis` reads and rewrites `path.join(siteRoot, 'index.html')` only, it never walks
the tree, unlike `applyStoryNav`. The recap only ever appears on the landing page
(`landing.js:83-99`), so walking every `.html` file the way `storynav.js` does would be strictly
more code for zero additional coverage, and would widen the contract past "the landing page's own
recap" into "any div matching this shape anywhere on the site", a much easier thing to get wrong
later. **Rejected: reusing `storynav.js`'s tree walker.** Test 4
(`test/build-recap-emphasis.test.js`) proves this choice: a nested `sessions/index.html` and a root
`other.html`, both carrying the identical recap markup, are asserted byte-identical after a run
against the containing directory.

### Will catch / will not catch, deliberately

**Will catch:** the live shape, `*text*` with no inner `*`, no leading/trailing whitespace inside
the pair, on the landing page's own recap, replaced with `<em>text</em>` byte-for-byte on the
inner text, every other byte of the page untouched. A second build pass over an already-patched
page (idempotent, 0 pages patched). A missing `index.html` (0 pages patched, not an error).

**Will not catch, deliberately** (left alone, and exercised as a `null`-returning case in
`test/build-recap-emphasis.test.js`):
- `**bold**` wrappers, the inner text starts and ends with `*`, which `WHOLE_EM_RE`'s flanking
  group (`[^\s*]`) forbids at both edges.
- `_underscore_` emphasis, no `*` at all, so `RECAP_RE`'s capture never contains a `*` to anchor
  on.
- A truncated recap ending `*abc…` with no closing `*` (the extractor's own 500-char truncation,
  `landing-data.js:25-62`), `WHOLE_EM_RE` requires a closing `*`, so the trailing `…` and the
  still-visible opening `*` are left exactly as extracted.
- `*a* and *b*`, two separate pairs. The `[^*]` inside `WHOLE_EM_RE`'s middle group forbids a
  second `*` from appearing inside a single match, so the whole capture fails to satisfy the
  "exactly one pair" rule rather than matching the first pair alone.
- `plain *a* text`, leading/trailing text outside the pair fails the `^…$` anchors.
- Space-flanked `* x *`, the character immediately inside each `*` must be non-whitespace.
- Asterisks anywhere except the landing recap, `RECAP_RE` is scoped to
  `<div class="recap">…<br>`, and the module never reads any file but `index.html`.
- **An upstream markup change to `landing.js`'s recap shape** (the exact string
  `<div class="recap">`, or the literal `<br>` immediately after the recap text) would make
  `RECAP_RE` stop matching, with no error and no refused build, `result.recapEmphasis.pagesPatched`
  staying `0` is the only signal. No test here currently asserts a *nonzero* count against a fixture
  that actually carries a `*…*` recap through a real generator build (`test/fixtures/pin-vault` has
  no Sessions folder and never emits a recap at all, confirmed by inspection and asserted in test 5)
 , the real vault's live snapshot, quoted verbatim in the Engineering Brief and reproduced as this
  suite's fixture, is the closest proof available without checking withheld campaign content into
  a fixture file.
- **The packaged artefact.** Per this repo's first rule, everything above is Linux-source-verified
  only. `.agents/windows-verification.md` C30 tracks the win-x64 exe's own behaviour separately and stays
  **OPEN** until confirmed there.

## SD-8: the slip slot

The recap panel's own treatment, "the slip", is the one place in this feature explicitly
designed to be replaced independently of everything else: `.dashboard-section > .recap` is
positioned, masked, and the only selector in this file allowed to carry its own `::before`/
`::after` pseudo-elements (the product and the pin never set one on `.recap`). All of its rules
live in a single sub-block between the literal comment lines `/* -- slip slot: begin -- */` and
`/* -- slip slot: end -- */`, so a future swap touches only that block plus the `--haze-paper*`/
`--haze-slip-*` tokens, nothing else in the campaign section.

The slip actually shipped is round-3 pick **s3, "Salvaged from the Haze"** (scorched-corner mask,
pin/tape marks layer, one lifting corner), chosen after a start gate that blocked this whole
brief until the owner picked a round-3 variant. Its source is
`landing-mockups/round3.html` (the `--h-mask`/`--h-marks` inline-SVG data URIs, the shared
`.site[data-s]` rules, the `.site[data-s="scorched"]` rules, and the `<=600` container-query
block), translated the same way as every other campaign rule:
`.site[data-s="scorched"] .dashboard-section>.recap` collapses to `.dashboard-section > .recap`
(the data attribute has nothing left to select once only one slip is baked in);
`@container page (max-width:600px)` becomes `@media (max-width:600px)`; the shared block's
`font-size:clamp(21px,2cqi,26px)` becomes `2vw` (font-size, per SD-3); the scorched block's own
`cqi` use is in a horizontal (right) padding value, so it becomes a plain percentage
(`clamp(28px,4%,52px)`) rather than `vw`, consistent with SD-3's "horizontal geometry uses a
percentage, not a viewport unit" rule; and `--slip-*`/`--h-*` become `--haze-slip-*`/`--haze-h-*`
so neither collides with `lib/theme.js` or `--sc-*`.

Kept beyond the literal port, required by the brief's own slip-slot contract ("the reset of the
product Vellum sheet on `.recap`"): `border-radius: 0`, `background-blend-mode: normal`, and
`box-shadow: none`. The round-3 mock never needed any of the three, its own `.site` scaffold has
no Vellum sheet to defeat. `scriptorium.css`'s card-sheet rule (`:802-820`) sets all three on
`.recap` (via the shared `.entity-card, .pc-card, …, .recap` selector), and `background: none` /
`border: 0` alone do not clear them: `background-blend-mode` is not part of the `background`
shorthand, and neither shorthand touches `border-radius` or `box-shadow`. Without the three
explicit resets, the product's inset lip and floor shadow would still show through the round-3
filter's own `drop-shadow`, and the sheet's rounded corners would fight the scorched paper's own
mask shape.

Contract kept: `<em>` (produced upstream by the `#38` transform, not by this CSS), `br { display:
none }` (the general, non-slip `.dashboard-section > .recap br` rule immediately above the slot),
`.recap-link` at least 44px tall (`min-height: 44px` inside the slot, on top of the product's own
44px tap-target rule), raster-free (gradients plus one inline-SVG mask and one inline-SVG marks
layer, no `url()` to a bitmap anywhere in the slot).

**Contrast rework (Reviewer finding on 791ba63).** The figures the round-3 pick first shipped with
(`#36271b` ink at 6.9:1, `#3e2a74` link at 5.0:1) were a naive measurement: contrast between the
token colour and the slip's literal gradient *stops*, not against real rendered pixels. The
Reviewer measured differently, screenshot at `deviceScaleFactor: 3`, classify every pixel in each
element's own bounding box as ink (relative luminance `< 0.08`) or clearly-paper (`> 0.3`), then
pair the ink *median* against the single **darkest** paper-classified pixel found anywhere in that
box, and that worst-case pairing came out at 4.72:1 for the em and **3.92:1 for the link**,
because the `--haze-h-marks` stain layer puts genuinely dark blotches under some letters (e.g. the
"d" in "Read", the "h" in "3h", the "g" in "goblin"), and because two adjacent glyph strokes set
close together (e.g. "3h") anti-alias into each other, capping the luminance of the pixel *between*
them at roughly 0.30 regardless of how light the true paper is at that point, no amount of
brightening the background moves that specific pixel much, since it is mostly ink, not paper.

First attempt (round 1, since reverted): a `--haze-slip-wash` layer, a flat near-white tint,
clipped to `.recap::before`'s content-box so it only faded the marks in the text band. It barely
moved the worst-case number (the anti-aliasing artefact dominates, not the paper's true colour
underneath), and it looked wrong regardless, a visibly hard-edged cream rectangle sitting over
paper that read as scorched dark brown everywhere else, not the stained scrap the owner picked
(Reviewer crops `slip-old.png` vs `slip-rework.png`). **Removed entirely, round 2.** The
load-bearing fix, kept: darkening `--haze-slip-ink` from `#36271b` to `#2e2013` and
`--haze-slip-link` from `#3e2a74` to `#2a1c52`, a darker ink lowers its own relative luminance,
which *raises* the contrast ratio obtainable against the same worst-case background pixel, and
unlike lightening the background, it isn't capped by the two-stroke anti-aliasing artefact. The
paper-coloured halo `text-shadow` added alongside it (`--haze-slip-halo`) stayed, as a small,
genuinely subtle assist. Re-measured with the Reviewer's own script (`contrast2.js`, unmodified),
with the wash gone: **em 5.13:1, link 5.05:1 at 1440; em 4.87:1, link 5.05:1 at 390**, both clear
4.5:1 at both widths, and the slip crop at 1440 is visually indistinguishable from `slip-old.png`
apart from the intentionally darker text.

**Hero seam fix (Reviewer finding on 791ba63, reworked again on 58f3706).** The pre-existing Atlas
ground (`html::before`/`::after`, `position: fixed`, darkens toward the *viewport* bottom on every
page) was fully hidden while under the tall opaque hero, then revealed at its already-progressed
value the instant the hero's box ended. Round 1 tried fading the hero's own background and its
`::after` scrim to transparent over a percentage of the hero's own box, which cannot work, and the
Reviewer proved it by switching layers off: the ground is `position: fixed` (viewport-relative)
while the fade was a percentage of the hero (page-flow-relative, and the hero's own height is a
function of viewport *width*, not height), so the two curves cross at a different, wrong value at
every breakpoint, the hero's bottom edge sits at roughly 93% of viewport height at 1440, 66% at
1024, 81% at 390, with no single hero-relative fade able to match all three against the ground's
one fixed curve. Round 2 fixes it at the source instead: `html:has(.landing-hero)::before,
html:has(.landing-hero)::after { content: none; }` suppresses the Atlas ground entirely on the
landing page (a third SD-3-style anchor, needed because the ground lives on `<html>` itself, above
`<body>`/`<main>`). With nothing independently dark behind the hero, the hero's own background and
its `::after` scrim's bottom stop both revert to their original, simple form (flat `var(--bg)`,
`var(--bg) 0%` respectively), flat meeting flat is seamless by construction, at any viewport size,
with nothing to tune. Rejected: making the ground `position`-scroll with the page instead (fixes
the coordinate mismatch too, but its darkest point would then land on whatever content happens to
sit at the bottom of this particular page's particular length, an equally arbitrary coordinate,
just page-relative instead of viewport-relative); re-tuning the ground's own gradient stops to stay
light across the 66%-93% viewport-height band every breakpoint's hero edge falls into (solvable in
principle, fragile the same way round 1 was, it would need re-tuning again the next time a
breakpoint or hero-height formula changes, for a page that already has its own bespoke atmosphere
via the hero's own haze-drift and grade scrim). Verified with a pixel-column sample at three
x-positions per width and three widths (max single-pixel luminance-delta step 0.0008-0.0016, down
from up to 0.72 unfixed), and by eye: plain-viewport crops of y700-950 at 1440/1024/390 at scroll
0, crops centred on each width's actual hero-bottom edge, and 1440 scrolled so the hero bottom sits
mid-screen, no visible line at any of them.

**Rejected: keeping the d2 placeholder's journal-top/journal-bottom mask tokens
(`--haze-slip-top`/`--haze-slip-bottom`) alongside the round-3 tokens.** The placeholder's own
structural decision (SD-4, drafted before the round-3 pick was known) anticipated copying those two
data URIs from the d2 mock verbatim. Once round-3 fully replaced the slip slot's content, those two
tokens had no rule left to read them, SD-8 explicitly permits changing the `--haze-slip-*` tokens
as part of a round-3 swap, so they were dropped rather than carried as dead weight.

## Files changed

- `src/build/recap-emphasis.js` (new), `test/build-recap-emphasis.test.js` (new).
- `src/build/run.js`: `applyRecapEmphasis` required and called between `applyStoryNav` and the
  leak scan; `recapEmphasis` added to `runAtomicBuild`'s return object.
- `assets/site/scriptorium.css`: one new section, "Landing shell: full-bleed below 1024", appended
  after the Character-headers section. `test/housestyle-landing-shell.test.js` (new) guards it,
  following `test/housestyle-character-header.test.js`'s pattern.
- `docs/handoff/campaign-ui/css/overrides.css`: one new section, "Visual treatment: Into the
  Haze home", appended after the Atlas section. `test/handoff-campaign-ui.test.js` gains five
  new cases guarding it; the existing cases are untouched.
- `.agents/windows-verification.md`: C30, the win-x64 verification criterion for the recap transform.
- `CLAUDE.md`: the `npm test` count.

## Addendum: recap emphasis retired at publish-v1.11.40 (2026-09-30)

`src/build/recap-emphasis.js` and its transform above are **deleted**, not disabled. Upstream's own
#269 fix, landed by the pin bump to `publish-v1.11.40` (`78696167`), makes `lib/templates/landing.js`
call `extractRecapHtml` instead of the plain-text `extractRecap`, which renders the recap paragraph's
markdown emphasis (`*word*`) as real `<em>word</em>` HTML at the source. The RECAP_RE transform this
module implemented was written to convert the OLD plain-text `*word*` output into `<em>word</em>`
after the fact; it already self-skipped once the recap held `<em>` (its own marker check), so at this
pin it was already a permanent no-op, not merely redundant.

**What changed:**
- `src/build/recap-emphasis.js` and `test/build-recap-emphasis.test.js` deleted.
- `src/build/run.js`: the `require`, the `applyRecapEmphasis(stagingOut)` call, and the
  `recapEmphasis` field on `runAtomicBuild`'s return object are gone. The comment at the call site
  is rewritten to explain the retirement (it previously described the transform's own purpose).
- New real-build proof, `test/build-landing-recap.test.js`: a build of the new
  `test/fixtures/wrapup-vault` fixture (a session hub paired with a published Wrap-Up whose recap
  paragraph contains `*narrowly*`) asserts the landing `<div class="recap">` contains exactly one
  `<em>` and no literal `*`. Mutation-proven: reverting `landing.js` to call the plain-text
  `extractRecap` (simulating a hypothetical future regression) makes the new test fail (M31).

**Residual:** none beyond what R1's own residuals list already covers, fuzzy/prefix client search,
the two frontmatter-parser copies, etc. Nothing about the recap transform itself remains open.
