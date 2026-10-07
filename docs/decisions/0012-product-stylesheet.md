# 0012. A product stylesheet, separate from the campaign's overrides.css

Status: accepted (2026-09-20).

## Summary

Scriptorium now ships its own stylesheet for fixes every built site needs, kept separate from the campaign's `overrides.css`, which holds one campaign's look. The product stylesheet loads after the generator's styles and before the campaign's, so the campaign still has the last word. A rule belongs in the product layer only if it would hold for any vault, with no colours, fonts or file names taken from one campaign. Injecting the product styles after the campaign's and lowering their strength was rejected, because it would reverse who wins and hide that from anyone reading the page.

## The problem this closes

Chunk C's UI-track work landed a 477-line `docs/handoff/campaign-ui/css/overrides.css`, reviewed and
signed off, but never deployed: it lived only in the repo's own handoff directory, copied into a
real campaign's site config as a one-off, single-vault artefact. Every rule in it, whether it
fixed a genuine defect in the pin's own generic templates (a missing `:focus-visible` ring, a grid item
that would not shrink, an SVG presentation attribute the CSS cascade can beat) or expressed something
specific to this one vault's authored content (its Google Fonts choice, its dark palette, the mask fade
tuned for one hero image), sat in the same file, at the same layer, owned by the same single-writer NAS
path. Nothing separated "every Scriptorium user should get this fix" from "this one campaign wants this
look." A second vault would either not get the pin-defect fixes at all, or would have to hand-copy and
re-diff a file that was never written to be portable.

## Decision

**Two layers, two files, two owners.** Scriptorium ships its own product stylesheet
(`assets/site/scriptorium.css`), embedded in the exe and written into every site it builds as
`css/scriptorium.css`, linked on every page **after** the pin's own stylesheets and **before** the
campaign's `overrides.css` (`src/build/housestyle.js`; `src/build/run.js` calls it between the notice
pass and the output-leak scan). The campaign's `overrides.css` keeps final say in the cascade, as it
always has, for anything vault-specific.

**SD-7's test for which layer a rule belongs in: does the rule depend on this vault?** If it would hold
for any gm-apprentice vault built through this pin, it is product. If it references a hex value derived
from one vault's chosen palette, a font family the vault owner picked, or an asset filename that vault
happens to ship, it is campaign. Applied to the handoff file's ten sections:

| Section | Layer | Why |
|---|---|---|
| 0 Fonts | campaign | vault-chosen families |
| 1 Tokens | campaign | palette-derived hex |
| 2 Typography, `.pull-quote` brass | campaign | palette-derived hex |
| 3 Focus and motion | **product** | pin defects, token-consuming only |
| 4 Layout and overflow | **product** | pin grid/table defects, no colour |
| 5 Badges and pills | campaign | hex/rgba; hiding Draft/Stub is editorial |
| 6 Hero and imagery | campaign | keyed to a campaign-specific hero image filename |
| 7 Relationship graph | **product** | pin SVG presentation-attribute defect |
| 8 Tap targets | **product** | pin sizing defects |
| 9 Inline-style overrides | **product** | beats `landing.js:92`, `js/search.js:114` |

Five of the ten sections cleared that bar and moved, verbatim (comments included), into
`assets/site/scriptorium.css`. The handoff file keeps all ten section headers, in the same order, each
migrated one now carrying a one-line pointer back to this file, so `test/handoff-campaign-ui.test.js`'s
structural guarantee (ten headers, once each, in order, `@import` first) stays honest without needing to
be told about the split.

## How the injector avoids depth arithmetic (SD-3)

The naive approach, compute the page's depth from its output path, count `../` segments, know whether
the page uses `four-oh-four.js`'s absolute `basePath` hrefs or `base.js`'s relative ones, duplicates
logic the templates already got right, and would need to be re-derived correctly for every future
template shape. Instead: **anchor on the `overrides.css` `<link>` tag itself, and derive our own href by
replacing that tag's own trailing filename.** `lib/templates/base.js:62-63` and
`lib/templates/four-oh-four.js:35-36` already computed the correct relative-or-absolute href for
`overrides.css` on that exact page; reusing it means our href inherits that correctness for free, with
no knowledge of `basePath` and no per-template branch. The one rule lands correctly at every depth on
`base.js` pages and produces the correct absolute href on `404.html`, despite the two templates emitting
the cascade in a different order and `404.html` carrying a page-local `<style>` block neither of the
other rules needs to reason about.

Most sites, though, never scaffold `css/overrides.css` at all, `copyOverridesCSS`
(`node_modules/gm-apprentice-publish/lib/build.js`) only emits the link when the file exists on disk, so
the common case has no `overrides.css` link to anchor on. The fallback anchors on `theme.css` instead
(emitted unconditionally by both templates) with the same trailing-filename-replacement technique, and
inserts before the first `<style` occurring after `<head`, else before `</head>`, the `<style`-first
rule exists because `four-oh-four.js:19-20` states the intended cascade position as after the generated
theme and before the page-local `<style>`, which this pass must not outrank.

**Rejected: injecting after `overrides.css` and lowering specificity with `:where()`.** This would
invert the contract that per-site rules win over the product defaults, and the lowered-specificity trick
is invisible to anyone reading the page's own `<head>`, a maintainer scanning the cascade order would
see the stylesheet linked last and reasonably assume it wins, when `:where()` quietly says otherwise.

## `expectedAssets()` gains a second derivation, not a bigger literal (SD-6)

The pin's 30 embedded files are expanded over disk from `vendor/gm-apprentice-publish/PIN.json`'s own
manifest, a legitimate derivation, because the pin's manifest is a separate, independently-maintained
source of truth from the `pkg.assets` glob that embeds it. Scriptorium's own first-party site assets have
no such manifest. **Walking `assets/site/` on disk inside `expectedAssets()` to build the expectation
would derive the expectation from the same tree the `pkg.assets` glob expands**, a silently deleted file
would be absent from both sides at once, and the gate would pass vacuously. This is the exact tautology
`CLAUDE.md` names as a repeated failure mode in this project. Instead, `FIRST_PARTY_SITE_ASSETS` is a
hand-maintained literal (currently one entry: `assets/site/scriptorium.css`), **the literal list is the
manifest**. `test/package-config.test.js` carries a separate change-detector test that IS allowed to walk
`assets/site/` on disk, precisely because that test's job is to be a human-facing alarm when the literal
drifts from disk, not to be the packaging gate itself. Nothing in `scripts/pkg-assets.js` hardcodes the
resulting count (33); it falls out of `expectedAssets()`'s own concatenation.

## Colour ownership (SD-8) and the known deviation this does not fix

**The product stylesheet owns no colour value.** Permitted colour syntax, exactly: `var(--…)`,
`color-mix()` over a var, `currentColor`, `transparent`, and `#000`/`#fff` only inside a mask or gradient
alpha ramp where the value is an alpha channel, never a literal foreground/background/border colour.
Where colour is genuinely needed, the file consumes the tokens `lib/theme.js` emits into `theme.css`
(`--bg`, `--bg-card`, `--bg-header`, `--bg-hero`, `--text`, `--text-muted`, `--accent`, `--accent-dim`,
`--border`). Any own design tokens this file grows are namespaced `--sc-*` so they cannot collide with
what `lib/theme.js` regenerates every build. This is a Reviewer red line, and it is greppable: no bare
hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, or named colour keyword should appear in
`assets/site/scriptorium.css` outside the mask/gradient-alpha exception.

This decision does **not** fix the underlying reason colour still has to live in the campaign layer at
all: `theme.palette`, `theme.fonts`, `theme.genre` and `four_oh_four.style` are all vault-config
concepts with no first-class representation Scriptorium's own product layer can hook into without a
schema change in the pin itself, a design change to `gm-apprentice-publish` upstream, not something
`assets/site/scriptorium.css` can absorb by itself. That is a known, named deviation, tracked at
archive #31. Migrating it is upstream schema work, explicitly out of scope for this change, and
nothing about the product stylesheet's own rules changes when it happens,
the split described above (does the rule depend on this vault?) is exactly the same split a future schema
migration would need to draw, so this work does not need to be redone, only extended.

## Consequence

- `assets/site/scriptorium.css`: new file, five sections moved verbatim from
  `docs/handoff/campaign-ui/css/overrides.css`.
- `docs/handoff/campaign-ui/css/overrides.css`: the five migrated sections' bodies replaced with a
  one-line pointer each; all ten section headers stay, in order, untouched.
- `src/build/housestyle.js`: new module, `writeHouseStyle`/`injectHouseStyleLinks`.
- `src/build/run.js`: calls `writeHouseStyle` between the notice pass and the output-leak scan; return
  value gains `houseStyle`.
- `src/build/outputgate.js`: docstring updated to mention the house-style pass in its pipeline summary.
- `package.json`: `pkg.assets` gains `"assets/site/**/*"`.
- `scripts/pkg-assets.js`: `expectedAssets()` now also includes the new `FIRST_PARTY_SITE_ASSETS` export
  (33 total, up from 32); header comment corrected.
- `test/package-config.test.js`: asset-count assertion updated to 33; new change-detector test comparing
  `FIRST_PARTY_SITE_ASSETS` against a disk walk of `assets/site/`.
- `CLAUDE.md`: gate table's asset count corrected to 33.
- `docs/PROVENANCE.md` section 10: one new bullet, first-party, no new third-party notice obligation.
- `.agents/windows-verification.md`: new criterion C27 for Windows-side verification of the built link.

## Addendum: one search button on phones, and a plain Sessions index (2026-09-30)

**What changed for readers.** A newer version of the underlying page generator now draws a
second search button in the page header (a small magnifier icon), on top of this stylesheet's
own text "Search" button. On a phone, both used to show at once. This stylesheet's rule is now
conditional: it only shows its own text button when the generator's icon button is missing. A
reader on a phone gets exactly one search control either way. The same newer generator version
also started drawing a full set of list controls, a breadcrumb trail, an item count, a sort menu,
type buttons and a name filter, on the Sessions page specifically, even though a session log is
read front to back rather than searched. This stylesheet now hides those five controls on that
one page and leaves its heading in place.

**The decision.** Rather than delete the phone search rule or add a second rule fighting the
first over the same property, the existing rule gained one extra requirement: show the text button
only when no icon button is present in the header. If a future generator version drops the icon
button again, phone search keeps working with no further change needed here. The Sessions page is
recognised by what is actually on it, a card listing where the cards are typed exactly "session",
not by its web address or its position in the site's navigation. That means the fix keeps working
even if a campaign renames its Sessions folder, and does not depend on knowing the page's URL in
advance. Every hidden control uses a plain `display: none`. Nothing here uses a visually-hidden or
clipped-box trick, and nothing needs the word "important" to win.

**Rejected alternatives.**
- Deleting the phone search rule outright: a phone would lose search again the moment a future
  generator version drops its icon button.
- Adding a second rule to re-hide the text button once the icon button is present: two rules
  would then fight over the same property, and whichever comes last in the file always wins by
  accident rather than by design.
- Matching the icon button by its position relative to the text button (a "next sibling" match):
  on a campaign that also has the optional colour-mode button, that button sits between the two
  search buttons, so a sibling match cannot always reach the icon button from the text button.
- Writing a marker into the built page after the fact to flag it as "the Sessions page": that
  would mean this fix is no longer CSS only, and it adds a second, more fragile way to identify
  the same page.
- Bringing back this project's own Sessions page builder: that would undo the generator's own fix
  for a page it previously failed to build at all.
- Recognising the Sessions page by its breadcrumb text or its link in the site's navigation menu:
  on a campaign with no sessions logged yet, that would hide the same controls on every other
  listing page instead of none of them.

**Will catch:**
- A Sessions listing page, on any campaign, whose cards are typed exactly "session".

**Will not catch, deliberately:**
- A Sessions folder with no notes in it yet keeps its controls, since there is nothing on the page
  for the rule to recognise.
- A note sharing the Sessions folder but typed something other than "session" (for example, a
  session write-up typed separately from the session itself) keeps its own page's controls, if
  that page is otherwise a different kind of listing.
- Any other listing page that happens to be made entirely of session-typed cards would also lose
  its controls; nothing else in the generator's output currently produces that shape.
- A browser old enough to lack support for the CSS features this rule depends on simply keeps
  showing every control it always has. On a phone that still means two search buttons; everywhere
  else it is no change from before this fix.

**A separate, smaller thing noticed along the way, not fixed here.** The Sessions page's sort menu
opens already reading "Sort: Name," but the list underneath is not actually sorted by name; it is
in whatever order the generator's own build produced. This looks like a small bug in the page
generator itself (the menu's starting label does not match the list's real order), not something
this project's own stylesheet can fix. It has been written up separately for the generator's
author.

### Evidence

- Source-level tests: `test/housestyle-search-and-sessions-index.test.js`.
- Rendering proof: an out-of-repo Chromium check, across every width the fix targets, on multiple
  built campaign sites including a real campaign export, with every control's break attempted and
  confirmed to show up as expected.
- Published output: every built site's HTML, JavaScript, JSON and images are unchanged; only the
  shipped stylesheet differs.

## Addendum: readable relation words and a readable 404 button (2026-10-01)

**What changed for readers.** In the Connections lane (the row of linked names under a
character, location or faction page), the word describing how each connection relates to the
page it is on, for example "ally" or "mentors", used to read a colour straight from the built-in
theme or the dark/light preset, the same way a link does. On several presets, and on the built-in
dark theme, that word could land within a point or two of its own background, in the harder of
the two colour states. This fix routes those words, the tray's name and its quoted line, through
the lane's own colours instead, which always match the leaf's own readable text. Separately, the
404 page's "Return to Safety" button, and the story page's "Begin reading" button, used to render
white text on the page's accent colour. On several presets, in the harder colour state, that was
close to unreadable; it is confirmed as low as 1.1:1 in places. Both buttons now read the page's
own body-text colours, swapped: the text colour becomes the button's background, and the
background colour becomes the button's text. That pairing already has to be readable for the
page's own paragraphs, so the button inherits that guarantee for free, on every preset and every
colour state.

**The decision.** Two small token-only changes, plus two one-rule additions. The Connections lane
gained two of its own colour names, one for a declared tie and one for a named-by word, both
defaulting to the leaf's own ink (which is the one colour proven to read on every preset in both
colour states); the built-in dark theme restates its own brass and lavender for those two names,
so nothing changes under that theme. The lane's own container also gained the leaf's ink as its
text colour, so the tray heading and its quoted line, which set no colour of their own, stop
inheriting whatever colour the page happens to be using. For the two buttons, a single new rule
was added for each, naming the exact markup the page generator produces, so it wins the
specificity contest against the generator's own built-in button style without touching that
style directly.

**Rejected alternatives.**
- Pinning the lane's accent colour inside the built-in dark theme: that would recolour every
  ordinary link on every page that theme touches, not just the lane.
- A single shared rule covering both the relation word and the lane's own name links: the name
  links already have a separate colour source (see "Will not catch" below), and merging the two
  would either break that or leave the word unfixed.
- Declaring the two button hook variables the generator's own style already half-reads, instead
  of writing a rule for each button: that would also recolour the other of the two buttons by
  accident, and the hook names do not belong to this project's own naming convention.
- Keeping the accent colour as the button's background and only changing its text colour: on
  several presets, nothing readable sits on top of that particular accent in the harder colour
  state.
- A ghost (outline) button instead: a weaker visual affordance, with no stronger contrast
  guarantee than the pairing actually used.
- The built-in dark theme's own 404 button keeps its familiar colour instead of following the
  other themes: a separate, later rule in that theme's own file restores it, with dark text, at
  roughly 7:1. The story page's button was not given the same treatment; it follows every other
  theme there.

**Will catch:**
- Every relation word, and the tray's quoted line, in the Connections lane, on every built-in
  theme, every preset, and both colour states.
- The tray's own heading, when the selected item has no page of its own to link to.
- The 404 button's text, and the story page's "Begin reading" button's text, normal and hovered,
  on every built-in theme and every preset.

**Will not catch, deliberately:**
- The lane's own name links (the linked name next to each relation word) are not covered by this
  fix. A name that links to its own page reads the site's ordinary link colour, which this fix
  does not touch; an unlinked name already reads the leaf's own ink. This matches the existing,
  already-known gap in link colours generally, not a new one.
- The tray's own heading has the same gap, for the same reason, whenever the selected item links
  to its own page: the link reads the site's ordinary link colour instead of the lane's ink.
  Measured as low as 2.6:1 in some preset and colour-state combinations. An unlinked tray heading
  already reads the lane's own ink and is unaffected.
- The 404 page's own message text, above the button, is unchanged.
- The built-in dark theme's own body text, in the lighter of its two colour states with no custom
  palette set, is unchanged; that gap was already known and recorded separately.
- A campaign that sets its own colours directly (rather than through a built-in theme or preset)
  keeps whichever colours it chose; this fix only changes what the built-in defaults resolve to.

### Evidence

- Source-level tests: a new test file covering the lane's own colour rules, the built-in dark
  theme's two restated colours, and both button rules; two existing tests updated to match (their
  prior, red output recorded first).
- Rendering proof: a glyph-level Chromium contrast check, sampling only the pixels a letter
  actually occupies rather than a surrounding box, across every built-in theme, every preset, and
  both colour states, with a self-check against the arithmetic result built into every run.
- Mutation proof: every rule in this addendum was broken on purpose and confirmed to fail the
  rendering check for the reason expected, then restored.
- Published output: every built site's HTML, JavaScript, JSON and images are unchanged; only the
  shipped stylesheet, and the built-in dark theme's own stylesheet, differ.
