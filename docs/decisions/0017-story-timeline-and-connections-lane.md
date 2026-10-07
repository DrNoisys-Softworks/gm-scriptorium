# 0017: Story timeline and Connections lane

Status: accepted (2026-09-24).

## Summary

The story timeline on a built site becomes a ruler on a desktop screen and an upright spine on a phone, with tap cards and a "What the party learned" view. A new Connections lane replaces the generator's relationship graph with a ranked list of ties, backlinks and grouped mentions. Both are built by steps after the generator runs. The generator's own timeline was rejected, because it needs dates the campaign deliberately leaves out and uses date formatting that is unsafe inside the packaged executable. Both features read what the GM has already written in the Timeline page's tables.

## What this adds

Two post-build transforms, `src/build/timeline.js` and `src/build/connections.js`, plus shared
helpers (`src/build/htmltext.js`, `src/build/recaps.js`) and a single new first-party JS asset
(`src/build/sitescript.js` writes `assets/site/scriptorium.js` to `js/scriptorium.js`). They run
between `applyAccordionOpen` and `applyPageTurn` in `src/build/run.js`, after the badge/date
transforms (so the text and values they copy between pages are final) and before the leak scan (so
what ships is exactly what gets scanned).

The story timeline turns the authored Timeline page's two data tables (helper columns Title,
Kind, Weight, Place) into a panning ruler on desktop and an upright spine on phones, with tap
cards and a "What the party learned" lens. The Connections lane replaces the pin's own
relationship-graph SVG, in place, on every page that carries one, with a ranked lane of ties,
"named by" backlinks and grouped mentions.

## Why the pin's own timeline stays off (rejected)

`lib/timeline.js` only writes a landing strip and a root `timeline.html` when an event or session
carries `in_game_date`/`date` (`lib/timeline.js:42-89`, `lib/build.js:466-472,917-925`). The vault
deliberately carries neither field (FR-T1's residual, and the fixture vault's own constraint). Even
if it did, `lib/timeline.js:92` calls `toLocaleDateString`, which is a small-icu hazard inside the
packaged exe (the same class of defect CLAUDE.md's "rule that matters more than any other" section
records: `Intl.Segmenter` crashed a shipped release once already). Building our own transform off
the columns the owner actually approved, with build-time-only string formatting, sidesteps both
problems and needs no pin change at all.

## Helper columns, located by name and stripped (FR-T1, T3a/b/c)

Four columns opt a table in: **Title** and **Kind** are required (the opt-in test), **Weight** and
**Place** are optional helpers. All four are matched by header name, case-insensitive, never by
position, T-T2 proves a shuffled header order produces identical points to a canonical copy. Every
one is stripped from the published table (its `<th>`/`<td>` cell, plus the one following newline)
so the no-JS fallback table reads cleanly without them.

The owner's three rulings (Lead Requirements doc, "the owner's rulings", 2026-09-24) close the three data
gaps the mock's own choices didn't answer:

- **FR-T3a (card body):** the What cell, timestamps stripped by rule (below). No new "Card" column.
- **FR-T3b (weight):** a `Weight` helper column, 1-3, defaulting to 2 on a missing/invalid value
  (one warning per invalid row; one warning per table when the column itself is absent).
- **FR-T3c (tiering):** a `Place` helper column, naming the ruler's top-level tier group. Empty
  cells inherit the previous row's Place, in document order, across both tables.

An unknown or empty Kind becomes the empty string (a neutral marker) with a warning, never a build
failure, `src/util/exitcodes.js`'s taxonomy is frozen (CLAUDE.md), so no new code path may change
the exit code a user sees. A missing Title falls back to the when-label with a warning.

## The timestamp rule (FR-T3a)

`stripTimestamps` removes `HH:MM` / `HH:MM:SS` tokens (optionally ranged with `-`/`–`) that are not
part of a longer digit run, then cleans up the separators and parenthesised asides that removal can
leave dangling (an empty `()`, a stray leading/trailing `,`/`;`/`:`). It is a rule over the
published What text, not a rewrite of the vault (the table's own intro line says "Append, don't
rewrite").

**Will catch:** `00:31:33`, `03:41-03:47`, `12:00.` (leaves the full stop). **Will not catch, and
this is deliberate rather than an oversight:** `3pm`, `half past nine`, or any other non-`H:MM`
time phrasing, the rule is a literal-token strip, not a time-phrase parser, and widening it risks
false positives on the case below. **Will wrongly strip:** a `N:NN`-shaped ratio or ID that happens
to fall in the `\d{1,2}:\d{2}` window, e.g. a dice-adjacent "3:10" scale note. This has not shown up
in the real Timeline table (the fixtures and the mock's own `x` text never carry one), and the risk
is bounded: the strip only ever removes a token, never surrounding prose, so the failure mode is a
slightly terser card, not a wrong one.

## The anchor table (FR-T2)

A second table, header `Session | Learned | After`, placed under its own heading on the *same*
Timeline page. It is removed along with its heading in the transform, with JS on or off. Each
recap's `<strong>` lead text is matched to an anchor row's `Learned` cell, and each row's `After`
text names a Title, by `foldKey` (tag-stripped, typography-folded, case-folded, trailing
punctuation stripped), so curly vs. straight quotes and a trailing full stop never cause a miss
(T-T8). An unmatched learned item, or an anchor whose `After` names no row, is placed after the
last row of its session (or the last row overall, if that session has no rows) and reported; every
learned item still appears somewhere (AC-04).

**Rejected: a marker inside the recap files.** That would edit three recap pages and change
published recap text, and the transform's whole guarantee (collect the whole tree, touch only the
Timeline page) would no longer hold for this feature alone.

**Rejected: a column on the timeline rows.** Several learned items can anchor to the same row, and
a column would need one cell per item, keyed by the same lead text the table format uses anyway,
strictly more authoring for the same information.

## The Connections item set: parsed from the SVG, not re-derived (FR-C1)

`connections.js` reads each page's own already-rendered relationship-graph SVG and takes hop-1 as
every `<g opacity="1">` node after the first (the first is always the hop-0 centre, by the pin's own
insertion order, `lib/relationship-graph.js:106,113`). This is *exactly* the pin's own edge set by
construction, for free.

**Rejected: calling `buildRelationshipGraph` through the facade.** That needs the pin's backlink
map (`backlinks[title]`), which is assembled elsewhere in the generator's own build pass and is not
something `src/generator/pinned.js` exposes today. Re-deriving it here would be a second
computation of the same edge set that could silently drift from what the SVG (and thus the reader)
actually shows, worse than reading the one the pin already committed to the page.

**Rejected: keeping the SVG.** A static, unstyleable, untruncated-name-losing radial diagram with
no ranking, tray text or reflow story; every acceptance criterion in FR-C2 through FR-C6 requires
replacing it.

## Names and types from the published set (Structural decision 4)

Every name and type shown in a lane comes from `computePublishedSet(vaultPath, jsonConfig)`,
matched to the page's own `displayTitle` and published `frontmatter.type` by `outputPath`, not from
`search-index.json`. `search-index.json`'s own `documents[outputPath]` is exactly
`{title: displayTitle, type: fm.type, href: outputPath}` (`lib/search-index.js:30-35`), so one
source removes the two-path risk of the two ever disagreeing, and it means the lane still renders
correctly with `searchEnabled: false` (search-index.json is never written in that mode). T-C14
proves the equivalence on a real fixture build: for every `search-index.json` document, `{title,
type}` equals what `computePublishedSet` gives for that same `outputPath`.

## Collect-then-write, and the CSS-hidden-text residual (FR-C8)

`collectConnections` reads every page's HTML into memory and computes every page's full model
*before* `applyConnections` writes a single byte back. A lane's mention snippet, tray line, or "the
other page's tie description" is always read from that first, pre-write snapshot, so a lane can
never quote another page's freshly-injected lane (T-C9's proof: page A's SVG includes B, but A's
prose never links B, so B's own item for A must read "Mentions A by link." with `line: null`, not
some fragment of a lane transform wrote onto A in the meantime).

Every copied snippet comes from a page's *published HTML*, never the vault, the one guarantee that
makes a GM-only or `publish: stub` section on the source page safe to copy from (it was already cut
before this transform ever runs). The one residual this cannot close: text that is present in a
page's built HTML but hidden only by campaign CSS (a client-side-only toggle with no server-side
exclusion) would still be visible if copied onto another page. `findMentionSnippet`'s restriction to
prose blocks (`<li>`/`<p>`/`<td>`, explicitly excluding the graph, sidebar, relationship-list, nav,
breadcrumbs, story-nav and badges, the same list `proseRegion` strips) is the mitigation, not a
full close: it keeps the snippet search inside content the site's own markup calls "prose," on the
working assumption that a campaign's CSS-hidden sections live outside that set.

## One asset, 33 to 34 (SD-6). Rejected: inline JS

Both runtimes live in one new first-party asset, `assets/site/scriptorium.js`, following the
Book leaves precedent (`docs/decisions/0012-product-stylesheet.md`'s SD-6 mirrors this exact
change). `scripts/pkg-assets.js`'s `FIRST_PARTY_SITE_ASSETS` and `test/package-config.test.js:47`'s
literal both move from 33 to 34 deliberately, the change detector that walks `assets/site/` on
disk (`test/package-config.test.js`, "change detector") is what actually proves nothing was added
without updating the list.

**Rejected: inlining the runtime on every page.** About 700 lines of JS repeated across many
pages in a real vault is a real weight cost for no benefit; the asset is linked only on pages the
transforms actually patch (`linkSiteScript`'s own marker-and-nav.js-anchor guard), so most pages pay
nothing at all.

## Data islands carry no `\u` escapes (except `<`)

`serializeDataIsland` is `JSON.stringify(v).replace(/</g, '\\u003c')`, the *only* escape it ever
introduces. Every other character, including non-ASCII names, is written as literal UTF-8. This
matters because the output-leak scan (`src/checks/leak/outputscan.js`) decodes HTML entities and
folds typography, but does **not** decode JSON `\u` escapes, a withheld name serialised as
`A...` would be invisible to the scan that exists specifically to catch it. T-S5 plants a
withheld name inside an island and confirms `scanOutputTree` still reports it.

## LEAF-prefixed component CSS

Every new rule in `assets/site/scriptorium.css`'s two new sections carries the LEAF selector
(`body:has(> .top-nav) > main.content:not(:has(> .landing-hero))`) or is a bare `:root` token
block, following the Book leaves precedent exactly (`docs/decisions/0016-book-leaves-and-page-motion.md`).
The mock's own CSS used a bare `#stl` ID, whose specificity (1,0,0) beats LEAF's (0,3,2); a
class-rooted rule without LEAF would in turn lose to the leaf's own bare `p`/`li`/`h2`/`h3` rules.
LEAF plus a `.sc-*` class either wins outright or ties and wins by source order (later in the
file). Every rule that touches `.sc-tl-src`, `.sc-tl-card`, `.sc-cx-static` or `.sc-cx-live` is
required to declare no `display` of its own, the regression B-3 already found once
(`docs/decisions/0016-book-leaves-and-page-motion.md`), and the one place `display: none` is set on
those four classes is the single shared `LEAF [hidden]:is(...)` rule at the very end.

## Residuals (things this feature knowingly leaves open)

- **`search-index.json`'s body text** is taken from the vault text *before* this transform runs
  (the pin's own indexing pass, first 500 characters), so it can still contain Title/Kind/Weight/
  Place words. They are player-facing text either way, so this is harmless, not a leak.
- **Object-form ties on PC pages classify as mentions.** PC pages have no context sidebar
  (`renderContextSidebar` is never called from `pc.js`), and `processor.js`'s `relationship-list`
  only renders array-form relationships, so an object-form relationship on a PC has no published
  surface to declare it from at all, and the item on the *other* page classifies as a mention by
  construction. Not a bug; there is genuinely nothing published to read a tie from.
- **A nested `<li>` snippet can be a partial block.** `findMentionSnippet`'s block search matches
  the first `<li>`/`<p>`/`<td>` containing a qualifying link; if that list item itself contains a
  nested list, the returned text can include more than the single "sentence" a human would call the
  mention.
- **`textOf` joins adjacent blocks.** Stripping tags and collapsing whitespace can make two
  originally-separate elements read as one continuous sentence. This only affects the FR-C6
  verbatim-substring check (a false positive there, never a false negative on real leaked text),
  because it is more permissive, not less.
- **The CoC PC Journey layout is untested.** `pc.js`'s CoC branch (`buildCocBody`) was not
  exercised by any fixture in this pass; the PC Journey tab test (T-C10) uses the generic PC shell.
- **More than one timeline page: the first (sorted by outputPath) wins,** with a warning. The pin
  itself has no stronger guarantee here either (`lib/build.js:468-469` picks the first match it
  finds).
- **Warnings are human-only.** `src/cli/build.js` prints `warning: timeline: …` / `warning:
  connections: …` lines after "built N file(s)"; the JSON envelope (`--json`) carries none of them
  (Structural decision 11), an intentional residual, not an oversight, since the envelope's own
  determinism contract (`src/cli/build.js`'s own doc comment) is about findings, not free-text
  warnings.
- **Safari is untested.** The Playwright smoke this brief calls for runs Chromium only, matching
  every other Track in this repo's own convention.

## Addendum: readable relation words (2026-10-01)

The Connections lane's relation words, and its tray text, are now readable in every built-in
theme, preset and colour state, with one named exception for a linked tray heading. See the
addendum "Readable relation words and a readable 404 button" at the tail of ADR 0012 for the fix
and what it does and does not cover.

## Addendum: recaps from a paired Wrap-Up

`docs/decisions/0036-session-wrap-up-support.md`'s "Decision" adds a Wrap-Up source for a paired
session's recap. When a session hub pairs with a published Wrap-Up, the timeline's learned items
and recap numeral, and Connections' shared-recap score, come from the Wrap-Up's own built page
instead of the hub's: the hub still supplies the recap's number and date (its badges carry those
regardless), but the title, the "What the Party Learned" list and the prose links all come from
the Wrap-Up. A Wrap-Up page is never itself a Connections lane item, the same way a session page
already wasn't. See that ADR's "Decision" for where the pairing itself comes from, and its
"Residuals" for what this does not change (the sessions index, and the builder's own landing
recap, badges, prev/next and Saga, none of which this repository re-renders).
