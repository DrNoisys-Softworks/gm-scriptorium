# 0020. Labels and vocabulary

Status: accepted (2026-09-25).

## Summary

A campaign can now rename the words its built site shows players, such as timeline column headings, the kinds of event, the weight words and the heading recaps read learned items from. It does this through three optional tables in `pack.toml`: `[labels]`, `[timeline]` and `[recaps]`. Writing the labels into the site's JavaScript at build time was rejected, because it would make every site's script different and open an injection risk. A list you supply replaces the default list instead of adding to it. Command-line messages for a GM at a terminal are not configurable, and a campaign with no `pack.toml` builds the same site as before.

## 1. Status and the problem

Every English noun a Scriptorium-built site shows a player was, before this phase, a literal baked
into two source files: the timeline's kind names, weight words, column headers and session/segment
regexes lived in `src/build/timeline.js` and `assets/site/scriptorium.js`; the Connections group
titles lived in `src/build/connections.js` and, again, `scriptorium.js`; the recap heading `recaps.js`
reads learned items from was a single hard-coded string. A GM running a campaign whose table columns
are titled "In-world" rather than "In-game", or whose "kinds" are narrative categories rather than
D&D-flavoured ones ("fight", "meeting", "discovery", "journey", "backstory"), could not use either
feature without editing the product's own source.

This phase adds three optional `pack.toml` tables, `[labels]`, `[timeline]`, `[recaps]`, that let a
campaign rename the emitted nouns, replace the timeline's kind set, its weight words and its column
headers, replace the session-token and segment-unit regular expressions, and change the recap heading
learned items are read from. Every default build stays byte-identical (AM-1, §9).

## 2. Three kinds of string (plan §C)

Every English string the build touches classifies into three kinds (the full string-by-string
inventory is §10, below, P4-FR11):

1. **A matcher against the pin's own output**, text the transform reads to find its own markup
   (`connections.js`'s `GRAPH_BLOCK_RE`, the "Connections" heading the pin itself emits). Fixed: it
   names a contract with `gm-apprentice-publish`, not the campaign's vocabulary.
2. **A matcher against vault content**, text the transform reads to recognise the campaign's own
   authored input (a column header, a Kind cell's value, the recap heading). Configurable: this is
   the campaign's own naming choice, and the whole point of this phase.
3. **An emitted label**, text written into the built site, verbatim or via a template. Configurable
   when it names something about the campaign (a kind's label, a group's title); fixed when it is
   English interface chrome or grammar (§SD-8, below).

Crucially, **"emitted" means bytes written into the built site.** CLI warning, error and help text
is never covered by this ADR (NFR-14), `[timeline] weights must be an array of exactly 3 strings`
is a message a GM reads in a terminal, not a string a player's browser renders, and is not
configurable.

This ADR also amends **ADR 0019's** list of known `pack.toml` top-level keys (`theme`, `images`) to
add `labels`, `timeline` and `recaps`.

## 3. The `pack.toml` tables

All three tables are optional, and so is every key inside one. `[labels]` holds 17 label strings
(table below). `[timeline]` holds `kinds` (an array of tables, 1–32 entries, **replacing** the
default kind set wholesale rather than merging with it), `weights` (exactly 3 strings), the
`session_token`/`segment_units` regular expressions, and a `[timeline.columns]` sub-table (11 keys,
each an array of 1–16 alternative header names, each **replacing** that column's own default).
`[recaps]` holds `learned_heading`.

A worked example (the fixture at `test/fixtures/vocab-vault/`):

```toml
[labels]
learned_lens = "What the crew found out"
group_npc = "Folk"

[timeline]
session_token = '\bEp(\d+)\b'

[[timeline.kinds]]
key = "clash"
glyph = "fight"
aliases = ["battle"]

[timeline.columns]
title = ["heading"]
session = ["episode"]

[recaps]
learned_heading = "Lessons Gathered"
```

**Errors versus warnings.** A shape problem, wrong type, a value that fails validation, a name
collision, is a `ConfigError` naming the file, the table and the exact field, following the format
every other `pack.toml` error in this codebase already uses (ADR 0019 §"errors"):
`campaign "<c>": <T>: <where> <problem>`. An **unrecognised key**, inside `[labels]`, `[timeline]`,
`[timeline.columns]`, `[recaps]`, or inside one `[[timeline.kinds]]` entry, is a human-only
`warning:` line, never an error and never reflected in `--json` (ADR 0019's own precedent, extended
to three more tables). `check`, `build` and `status` all validate through the same
`parsePackToml` → `parseVocab` call inside `resolveVaultContext`, so the three commands refuse (or
warn) identically.

## 4. Kinds

Each `[[timeline.kinds]]` entry has a required `key` (a lower-case slug, `^[a-z][a-z0-9-]{0,31}$`,
unique across every kind's key **and** every kind's aliases, normalised the same way a column name
is: whitespace-collapsed, trimmed, lower-cased), an optional `label` (defaulting to the key itself),
an optional `glyph` (§5), an optional `aliases` array (0–16 names a Kind cell may also match), and an
optional `before` boolean.

`learned` and `none` are reserved keys: `learned` is the client's synthetic "what the party learned"
point kind (`scriptorium.js`'s `p.k === 'learned'` branch), and `sc-tl-k-none` is the CSS class an
unrecognised kind falls back to. Neither can be a campaign-defined key.

**This amends ADR 0017's hard-coded `backstory` special case.** Before this phase, exactly one kind
(`backstory`) rendered as a star marker on the "before" segment, with `tlCap(...)` applied to a
hard-coded literal 'Backstory'. The `before` flag generalises that: *any* kind can now be a
"before"-kind, and the star/label/glyph all key off the resolved kind object rather off a string
literal `'backstory'`. The five defaults reproduce today's exact behaviour: `fight`, `meeting`,
`discovery`, `journey` (all `before: false`) and `backstory` (`before: true`), each with
`label = key` and `glyph = key`.

**Colour rules stay keyed on the kind's key** (`scriptorium.css:2355-2360`'s `.sc-tl-k-fight` etc.):
a campaign-defined kind with a key outside that fixed set of five gets no bespoke product colour,
just the neutral treatment. That is a residual (§12), not a defect, a flat CSS rule cannot invent a
colour for an arbitrary campaign-chosen key.

## 5. Glyphs

A glyph is either one of six built-in names (`backstory`, `discovery`, `fight`, `journey`, `learned`,
`meeting`, the keys of the client's `TL_GLYPH` map) or SVG path data matched by a strict charset:
`^[Mm][0-9MmZzLlHhVvCcSsQqTtAa.,+\-eE ]{0,1023}$`. That charset contains no `"`, `<`, `>`, `&` or `'`
**a glyph can never be markup**, by construction, not by escaping. The server validates this once,
at parse time; the **client re-validates independently** (`TL.glyph`, `assets/site/scriptorium.js`)
before ever concatenating a glyph string into an `<svg>`'s inner HTML, because a glyph is the one
config-supplied value this phase writes into HTML without ever running it through `esc()`, the
charset is the safety property, not an escape.

## 6. Regular expressions

`session_token` and `segment_units` are TOML strings, compiled once, at `pack.toml` parse time, with
**fixed flags the campaign can never set**: `session_token` compiles with `''`, `segment_units` with
`'i'`, `g` and `y` can never reach `new RegExp` (SD-7). Each is capped at 512 characters. Group
counts are checked with the same idiom the rest of this codebase already uses for group counting
(`new RegExp('(?:' + src + ')|', flags).exec('').length - 1`): `session_token` needs at least 1
group (the session number), `segment_units` at least 2 (the unit word, the number). At match time,
`extractPoints` requires the session group to be all-digits (`/^\d+$/`) before accepting it as a
session number, a custom pattern that captures non-numeric text is treated the same as no match at
all, with the existing warning.

**ReDoS is out of scope and documented, not mitigated** (§13): there is no execution timeout on
either regex. A campaign author who writes a catastrophic pattern into their own `pack.toml` degrades
their own build.

## 7. Where labels travel

**Server-side strings are substituted at build time and never touch the island**: `recap_learned_link`
and `connections_heading` are baked directly into whatever the server already writes, a link's text
inside a data island's own JSON value, a static `<h2>`, never shipped as a separate delta key for
client JS to resolve. `learned_heading`, the column names and the two regexes are **matchers**, never
emitted at all (§2).

**Client-side strings travel as a `voc` delta** (SD-2/SD-3/SD-4), appended as the **last** key of the
timeline and Connections data islands, and **only when at least one value differs from the default,
compared by value**:

- `tlVoc.labels` holds only the four client label keys (`learned_lens`, `learned_legend`,
  `story_lens`, `chapter`) whose resolved value differs from `DEFAULT_LABELS`, in that fixed order.
- `tlVoc.kinds` is the full kind list projected to `{key, label, glyph, before}`, **aliases never
  ship to the client**, since they are a server-side matching concern only, present only when that
  projection differs from the default projection.
- `tlVoc.weights` is present only when it differs from `['aside', 'scene', 'turning point']`.
- `tlVoc` itself is `null` (an absent key, never a literal `null` or `{}`) when all three are absent.
- `cxVoc` is `{labels}` over the 11 Connections client keys, or `null`, by the same by-value rule.

**This is the exact mechanism that makes AM-1 possible.** A `pack.toml` that merely *restates* every
default, the D-block and M-block fixtures in `test/build-vocab-e2e.test.js`'s E1, resolves to
labels/kinds/weights that are *value-equal* to the defaults, so every delta computation returns
`null`, no `voc` key is ever written, and the HTML byte stream is identical to a build with no
`pack.toml` at all. A delta keyed on **presence** (was a key written in `pack.toml`?) rather than
**value** was rejected for exactly this reason: it would make every `pack.toml`-bearing build differ
from a `pack.toml`-less one even when every value restates the default, breaking FR10 and AM-1's
"restated defaults are byte-identical" half.

## 8. Escaping and the leak scan

The new escape points, all newly exercised by this phase:

- **Server:** the group title at `connections.js`'s `renderGroupList` (already escaped, unchanged
  contract, now escaping a config-supplied string instead of a literal); the `<h2>` heading
  (`connections_heading`), new; the recap label in the hub's session-numeral `title` attribute
  (`recap`), new.
- **Client:** `story_lens` and `learned_lens` in `TL.lensBar`, `chapter` and `recap` in
  `TL.cardBody`/`CX.hubSess`/`CX.traySame`, and `same_recap`, all get `esc()` for the first time. The
  kind key itself, used in a `class="…sc-tl-k-<key>"` attribute, also gets `esc()` (identity for a
  valid slug, defence-in-depth for anything else).
- **Islands are JSON, not HTML.** A label inside `tlVoc`/`cxVoc` is never escaped, `JSON.stringify`
  already produces a safe JSON string literal, and `serializeDataIsland` additionally escapes only
  `<` (as `<`, so `</script>` can never close the surrounding island tag). **Non-ASCII text is
  never `\u`-escaped** (ADR 0017's own invariant, reused rather than re-derived): a withheld name
  used as a label therefore reaches the built page as literal UTF-8, exactly where the output-leak
  scan (`src/checks/leak/outputscan.js`) can see it.

**The no-`\u` rule is also P4-FR09's control-character refusal.** Every label string is validated
against `[\u0000-\u001F\u007F-\u009F]` and `String.prototype.isWellFormed()` (refusing an unpaired
surrogate) *before* it can ever reach `JSON.stringify`, so a label can never itself contain a
character that would force `JSON.stringify` to emit a `\u` escape it didn't ask for, and the leak
scan's plain-text needle search is never defeated by an escape sequence hiding a withheld name's
characters.

**The withheld-label refusal** (`test/build-vocab-e2e.test.js`'s E3) is the end-to-end proof: a
`[labels]` value, or a kind's `label`, set to a withheld entity's own name makes the build refuse
(exit 2, `refusedByScan: true`), with a finding naming the timeline page, the hidden name, and the
`text` arm, the same output-leak gate every other emitted string in this codebase already goes
through (Track D2, ADR 0009), now exercising a genuinely new source of emitted text.

## 9. The permitted diff (AM-1) and the DOM A/B

**AM-1** is this phase's amended byte-identity gate, agreed with the orchestrator because of one
unavoidable fact: `assets/site/scriptorium.js` is a single first-party asset, copied verbatim into
every built site as `js/scriptorium.js` (`src/build/sitescript.js`), and this phase must edit that
file (FR03/FR04/FR07/FR08 all name client-side constants inside it). There is no way to add
client-side configurability to the runtime without the runtime's own bytes changing once, as a
one-time asset bump, the alternative, generating per-campaign JS by substituting labels into the
asset, was rejected (it makes every site's JS campaign-specific, which is an injection surface, and
breaks the packaging gate's own asset-hash check).

So AM-1 defines the permitted diff precisely: **every HTML page and every other file stays
byte-identical; `js/scriptorium.js` may differ, but only because it now equals the candidate
commit's own `assets/site/scriptorium.js`, byte for byte.** Gate steps G4 (`cmp` the built
`js/scriptorium.js` against the candidate's own source asset) and G6 (see below) are what prove that
precisely.

**The DOM A/B covers what the byte gate cannot see.** Nothing in a static byte comparison proves the
*rendered, script-enhanced* DOM is unchanged for a default (no-`pack.toml`) site, the whole point of
this phase's client changes is that they must be behaviourally invisible by default. G6 serves a
parent-tree build and a candidate-tree build side by side, boots both in a real browser via
Playwright, and diffs the live `outerHTML` of `.sc-tl`, every `.sc-cx-live` and `.sc-cx-tray`, before
and after the same sequence of interactions (a lens click, a stud click, a "show more" click, an
arrow-key move), at two widths. A self-diff (the parent tree served twice) must be exactly zero
first, as a control that the harness itself introduces no noise.

## 10. The inventory (P4-FR11)

The full string-by-string inventory, reproduced directly here so this ADR is self-contained (every
line reference below was re-verified against the committed diff during this build; some describe the
file's shape immediately before this phase, to explain what moved). Kind 1 = a matcher against the
pin's own output (fixed, it names a contract with `gm-apprentice-publish`, not the campaign's
vocabulary); kind 2 = a matcher against vault content (configurable); kind 3 = an emitted label
(configurable when it names something about the campaign, fixed when it is chrome or grammar, §11).

- `timeline.js`:
  - `:22` kinds (kind 2, configurable via `[timeline.kinds]`)
  - `:108` week/day matching (kind 2, `segment_units`)
  - `:112` the "Week 2" segment-label format (kind 3, fixed: it echoes the vault's own word back)
  - `:171-172`, `:185-192`, `:294-296` column headers (kind 2, `[timeline.columns]`)
  - `:229` the S-token (kind 2, `session_token`)
  - `:256`, `:351` "Recap" / "What the Party Learned" (kind 3, `recap` / `recap_learned_link`)
  - `:299` the anchor Session cell's `/\d+/` match (numeric, not an English-vocabulary concern)
  - `:24-25` timestamp stripping (not English)
- `recaps.js`:
  - `:15-17` (kind 1)
  - `:81` the learned-heading match (kind 2, `learned_heading`)
- `connections.js`:
  - `:24-27` (kind 1, out of scope)
  - `:29`, `:34-39` type identifiers (fixed: the type registry, built in an earlier phase)
  - `:32-40` group titles (kind 3, `group_*`)
  - `:104`, `:201` (kind 1)
  - `:398` the recap label in the hub's title attribute (kind 3, `recap`)
  - `:481` the Connections heading (kind 3, `connections_heading`)
- `storynav.js` (deleted at publish-v1.14.0, see the addendum to ADR 0014): it held one out-of-scope line and
  two fixed kind 3 strings, "Story" and "Open Story menu". No Scriptorium-owned Story-menu text remains.
- `sessions-index.js:59,60,124` "Sessions", "N session(s)" and the page title (kind 3, fixed: mirrors
  the pin's own "Sessions" nav label per that file's own header comment, and is English plural)
- `notice.js:50-72,85` (kind 3, fixed: the legal notice text and its link)
- `dates.js`:
  - `:22-25` (kind 1)
  - `:28-31` month names (kind 3, out of scope, locale/Intl, §14)
- `sessionbadges.js`, `accordions.js`, `pageturn.js`, `recap-emphasis.js` and the rest of
  `src/build/*`: no emitted English prose (re-checked with
  `grep -n 'aria-label\|>[A-Z][a-z]' src/build/*.js`).
- `scriptorium.js` (before this phase's restructuring; see §7/§9 for where each now lives):
  - `:20` kinds (kind 3, configurable)
  - `:21` weights (kind 3, configurable)
  - `:24`, `:27`, `:40` the article, capitalisation and comma logic (fixed: grammar, `tlArticle`/`tlCap`)
  - `:35`, `:310` `learned_lens` (kind 3, configurable)
  - `:36`, `:269` the kind label (kind 3, configurable)
  - `:270` `learned_legend` (kind 3, configurable)
  - `:284` `chapter` (kind 3, configurable)
  - `:309` `story_lens` (kind 3, configurable)
  - `:569`, `:621` `recap` (kind 3, configurable)
  - `:574` `same_recap` (kind 3, configurable)
  - `:586` the group titles (kind 3, configurable, `group_*`)
  - `:245-253` the built-in glyph library (kind 3, `TL_GLYPH`, names configurable via a kind's
    `glyph`, §5; the markup itself is never configurable, only ever a name or path data)
  - Fixed as chrome (kind 3): `:271` "Key", `:290` "Read on:", `:308` "Show", `:364` "Jump to",
    `:373` "Earlier", `:375` "Later", `:376`/`:400` "Close", `:541-543` the tray sentences,
    `:560` "Mentions … by link.", `:662-663` "Show N more" / "Show fewer", `:666` "Declared here" /
    "Mentioned elsewhere", `:667` the lane's `aria-label`
  - `:161`, `:525` CSS class / DOM identifiers, not prose

Everything above marked kind 2 or 3 "configurable" is exactly what `[labels]`, `[timeline]` and
`[recaps]` cover (§3-§8). Everything marked "fixed" or "out of scope" is a residual, with its reason
recorded either inline above or in §11's scope boundary and §14's out-of-scope list below.

## 11. Scope boundary (SD-8)

**Vocabulary is configurable: nouns and noun phrases that name the campaign's own things or its
sessions.** Interface chrome and English grammar stay fixed: articles (`tlArticle`'s a/an choice),
capitalisation (`tlCap`), possessives, plurals, sentence templates ("Read on:", "Mentions … by
link.", "Show N more"), aria text, and navigation words. The reason is structural, not an oversight:
**a flat label map cannot produce correct grammar in another language.** `tlArticle` picks "a" or
"an" by an English vowel-sound heuristic; a French or German vocabulary would need different
articles, different agreement, and possibly a different sentence order entirely. Solving that needs a
message catalogue with per-locale sentence templates, a strictly bigger feature (localisation) this
phase does not attempt. It is recorded here as a residual (§12), not solved partially: partially
localising the nouns while leaving the grammar hard-coded English would produce sentences that read
worse than the current all-English baseline for a genuinely non-English campaign, which is worse than
shipping nothing.

## 12. Rejected alternatives

- **Per-campaign JS generation** (substituting labels directly into `assets/site/scriptorium.js` at
  build time). Rejected: makes every built site's JS campaign-specific (an injection surface, the
  runtime itself would need escaping a config value into *JavaScript* source, a much harder problem
  than escaping into HTML or JSON), and breaks the packaging pipeline's own check that a built site's
  `js/scriptorium.js` hash equals the shipped asset's hash.
- **Always emitting the full vocab in every island.** Rejected: breaks AM-1 and FR10 outright, a
  default build would never be byte-identical to one with no `pack.toml`.
- **Column aliases that extend, rather than replace, the defaults.** Rejected: a campaign whose
  vault genuinely uses "Sort" instead of "Kind" would otherwise still need "Kind" to also work,
  which is not what "I renamed my column" means; replace-not-merge matches how `kinds` already needs
  to work (a campaign inventing its own five kinds should not also inherit "fight").
- **User-supplied regex flags.** Rejected: `g` (global) or `y` (sticky) on a pattern reused across
  many `.match()` calls silently corrupts results via `lastIndex` state leaking between calls, a
  correctness trap, not a feature, and the two flags that matter (case sensitivity via `i`) are
  already fixed per-field by design (SD-7).
- **`{name}`-style placeholder templates for chrome sentences.** Rejected as a partial localisation
  half-measure (see §11): swapping one noun into an English sentence template does not generalise to
  a language with different word order, and pretending it does would be worse than not trying.
- **A full message catalogue.** Rejected as out of scope for this phase (§14), a real localisation
  feature needs its own brief, its own review, and almost certainly its own Intl-aware date/number
  formatting, none of which this phase's FRs asked for.

## 13. Will catch / will not catch, deliberately

**Will catch:**

- A withheld entity's name used anywhere in `[labels]` or a kind's `label`, once it reaches a page
  the output-leak scan reads (E3).
- A malformed `pack.toml` table, an invalid kind slug or reserved key, a name collision between two
  kinds' keys/aliases or two columns' names, an invalid glyph, an invalid or under-grouped regular
  expression, a control character or unpaired surrogate in any label, all refused at parse time,
  before any build work happens.
- A default-vocab build silently drifting from byte-identical, whether server-side (the sha256
  manifest comparison) or client-side (the DOM A/B).

**Will not catch, deliberately:**

- **ReDoS.** Neither `session_token` nor `segment_units` runs under a timeout; a catastrophic custom
  pattern degrades only the campaign that wrote it (§6).
- **English articles and `tlCap` on a non-English label.** A `label` of `"forgeron"` still gets an
  English "a"/"an" and English-style capitalisation rules applied to it (§11).
- **Chrome staying English** regardless of any vocabulary configured (§11), not a leak-scan concern,
  a documented scope boundary.
- **Custom kinds getting no bespoke product colour**, the CSS rules are keyed on five fixed kind
  keys (§4); an invented key renders in the neutral treatment.
- **An alias, column name, regex source, or `learned_heading` value is never emitted**, so a withheld
  name used *there* is not a leak and the output-leak scan has nothing to find (§2's "matcher, not
  emitted" distinction), this is by design, not a gap the scan happens to miss.
- **A label that is never emitted is never scanned.** If a campaign's `pack.toml` sets a label that
  the current page set never actually renders (e.g. `group_faction` on a vault with no factions), the
  leak scan never sees it and cannot judge it either way.
- **The anchor Session cell is still read by its first digit run** (`/\d+/` at `timeline.js:299`,
  unchanged), numeric, not an English-vocabulary concern.
- **A path-data glyph can be ugly but not unsafe.** The charset (§5) guarantees a glyph can never be
  markup; it does not guarantee the resulting SVG looks good.
- **Older Scriptorium versions warn and ignore these three tables**, the same forward-compatibility
  story ADR 0019 already established for `[images]`: an unrecognised top-level key is a human-only
  warning, never a hard error, so a `pack.toml` written for this version still loads (with reduced
  behaviour) on an older binary.

## 14. Not decided here

Locale-aware string comparison or formatting (`Intl`, `toLocale*`), month names, CSS `content:`
values, the sessions-index/storynav/notice modules' own fixed English text, relationship and
registry changes, and examples/ are all out of scope for this phase and are not addressed by
anything above, see §11 for the scope boundary's own reasoning.
