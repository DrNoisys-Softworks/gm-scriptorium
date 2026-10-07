# 0008. L4: report every dropped collision, search rendered text with real line numbers

Status: accepted (Track D1/D3, 2026-09-17).

## Summary

The leak check for withheld names had two faults. It went quiet when a withheld name matched a published page's title, and it raised false alarms for names that sit in sections the site never publishes. It now reports every name collision as an error, and it searches the text the site actually renders, with correct line numbers, instead of the raw note. The record ends with a plain list of what the check will and will not catch. The main limit is that it reads source notes, so names that reach the site only through generated views are left to the output scan in ADR 0009.

## The problem

`leak/l4-hidden-name` had two defects pulling in opposite directions.

**D1, fail-open.** A withheld name that happened to equal a published page's own title or alias was
silently filtered out of the search (`l4.js:71-72`, pre-D1) and nothing was reported at all. A leak
check that goes quiet on a name collision is worse than one that shouts.

**D3, fail-noisy.** The body arm searched raw `page.markdown`, so a name correctly hidden under
`## GM Notes` (or a gm-only block, a spoiler block, an HTML comment, an excluded callout, a dataview
block, or a section `publish: stub` never included) still reported as a leak. That is why
`leak/l4-hidden-name` sat at a stable count through every prior commit on the real vault, and why every
`build` of it needed `--force`. `deriveRenderedText` also ran once per (page, withheld entity) rather
than once per page (`l4.js:76-77`, pre-D3), and `page.storyMarkdown`, a PC's paired `_Story.md`,
which renders both at `story/characters/<slug>.html` and inlined into the PC's own page
(`lib/build.js:599-608,639,649`), was never searched at all.

## Decision: one partition, one rendered-text source, an alignment pass for line numbers

**D1.** `collectWithheldNames` (`l4.js`) is the one computation both `runHiddenName` and the new
`runNameCollision` read. For every `withheld: true` entity it partitions every candidate name
(filename stem, frontmatter `title`, distinctive aliases) into `hiddenNames` and `collisions[].name`,
disjoint, union equal to `candidateNames` (asserted by test, AC-D1-04). A collision is now a new
ERROR id, `leak/l4-name-collision`, naming both files, the name, and whether the match was via the
published page's title or an alias, including the case where the withheld entity is itself the
published page (`data.selfPublished`). `buildPublishedNameIndex`'s values became
`{ page, via, matchedOn }` to carry this, additive, since l3.js and l4.js's other call sites only
ever call `.has()`.

**D3.** The body and story arms now read `rendered.bodyText`/`rendered.storyText`
(`textmodel.js`'s `deriveRenderedText`, DEP-b's rendered-text derivation), never raw
`page.markdown`/`page.storyMarkdown`. The loop inverts to `for page { rendered = deriveRenderedText(...);
for entity { for name {...} } }`, so the strip chain runs once per page, not once per (page, entity).
`publishset.js` now computes `bodyLineOffset` (and, when a story is attached, `storyRelPath`,
`storyLineOffset`, `storyOutputPath`) once per file, from gray-matter's own `raw`/`content` split
(`raw.endsWith(content)`, count the `\n` in the prefix; falls back to 0 rather than guessing when that
does not hold).

Arm precedence is body > story > frontmatter (FR-06): at most one finding per (page, name), the first
arm that actually contains it. The story arm's finding names the `_Story.md`'s own path and line, and
`data.renderedAt` lists both output paths the text really renders at.

### Line mapping is an alignment pass, not sentinel instrumentation

**Rejected: injecting a per-line sentinel before running the strip chain.** A sentinel appended to a
line changes the heading text `filterSections` matches on (`lib/processor.js:85-94`), the callout
pattern (`:274`), and fence info strings (`:184-199`), changing what gets stripped. Unacceptable in a
leak check.

**Accepted: `alignStrippedToSource(sourceMarkdown, strippedText)`** (`textmodel.js`), a monotone
two-pointer walk. Sound because every step in the pin's strip chain either deletes whole lines,
collapses a block to one blank line (`lib/processor.js:209`), or shortens a line in place by removing
an inline comment (`:297-345`), none of them introduce new text, so a surviving stripped line's
trimmed text is always exactly, or a substring of, some source line's trimmed text, in the same
relative order. A blank stripped line maps to `null` without advancing the cursor; a non-blank line
advances to the first source line at or after the cursor whose trimmed text equals or contains it,
records, and advances past it; no match before end of source maps to `null` **and restores the
cursor**, so one anomaly cannot desynchronise every line after it. Alignment always runs against the
RAW source body, never the stub-reduced text, because `keepOnlySections` only deletes whole lines
(never rewrites survivors), so a stub-reduced page's surviving lines still appear, in order, in the raw
source.

**A mapping failure never suppresses a finding.** `null` maps to `line: null`; the finding is still
emitted. The alternative, silently dropping a finding because its line could not be mapped, is
exactly the under-reporting this whole track exists to close off. Proven by test (AC-D3-06): with
`alignStrippedToSource` forced to return all-`null` (via module-cache substitution), every body/story
finding on the fixture vault still emits, with `line: null`.

## What L4 will and will not catch after this work

**Will catch:** a withheld name in a published page's rendered body after `publish: stub` reduction and
the whole strip chain; in a published PC's rendered `_Story.md` body (new, before D3 this path was a
total fail-open); inside a fenced code block (fences survive and do render); in `publishedFrontmatter`
text including a visible relationship target or description; a hidden name that is also a published
title or alias (new, an ERROR collision rather than silence).

**Will not catch, deliberately, because the pin does not render it:** a name only under an excluded
section (exact-match, `lib/processor.js:94`; the equals-or-starts-with gap stays L5's job); only inside
gm-only or spoiler blocks, including nested (`:158-242`); only inside any HTML comment (`:297-345`);
only inside an excluded callout (`:261-287`); only inside a dataview block (`:142-144`); only in the
author's leading H1 (`:349-359`); only in a section dropped by `publish: stub`
(`lib/build.js:305-322`); reachable only through a `gm_only` relationship edge or a
`publish_exclude_fields` field (`:640-664`).

**Will still not catch, out of scope here (D2):** names reaching the site only through derived views,
`search-index.json`, relationship-graph SVG labels, backlinks, recency card excerpts, section index
pages aggregating a frontmatter field (e.g. a faction's `leader` field on `factions/index.html`), party
manifest, roster; names appearing only after markdown rendering (entity escaping, typographer
substitution, a `[[Target|Alias]]` wiki-link whose alias text replaces the raw target at build time,
the alias case is a deliberate over-report, not a regression: the raw target string is genuinely
present in source, so a source-side check reports it even though a well-behaved build safely aliases it
away); a name broken across markdown syntax inside the word; attachments, images, filenames,
unpublished pages.

## Evidence

`git archive` of a real campaign vault into scratch (never the live vault, never a write under a
private QC folder, not in this repo): `leak/l4-hidden-name` went from 40 to 35 findings, five real
disappearances, each independently re-derived by reading the source file and its heading structure,
not by trusting the count:

| File | Name | Old (body-relative) line | Real file line | Construct |
|---|---|---|---|---|
| a creature page | NPC A | 35 | 62 | `## GM Notes` (exact-match `filterSections`) |
| a faction page | NPC B | 41 | 85 | `## GM Notes` |
| a location page (1) | NPC B | 37 | 65 | `## GM Notes` |
| a location page (2) | NPC B | 36 | 64 | `## GM Notes` |
| the campaign-overview page | NPC A | 59 | 84 | `## GM Notes` (inside a `> [!info]` callout too) |

Every one of the five has exactly one occurrence of its name in its file, and that occurrence
sits under a `## GM Notes` heading in the vault's `exclude_sections` list. Zero occurrences
outside a stripped construct; this exceeds pass 1's own estimate of "two findings disappear" (it
only named the location-page pair), the fuller, independently re-derived count is five, not two.

A real `build --force` of the same export (168 pages) confirms all five names absent from their
own built page. `scripts/l4-render-audit.js` against that build: 33 of 35 `leak/l4-hidden-name`
findings confirmed present in their cited output (Bucket A); 7 names present in built HTML with
no finding accounting for them there (Bucket B, the fail-open direction), every one is a
relationship-graph SVG `<text>` label, a recency-widget excerpt, or a faction-index "leader"
field, all derived views, all D2's job, itemised, not swallowed; 2 findings (a roster page and a
recap page, both NPC B) unconfirmed in their own cited output (Bucket C), both are alias-form
wiki-links, where the raw markdown genuinely contains the target name but the real build's link
resolution replaces it with a role alias and no href (NPC B is unpublished); a source-side check
correctly reports this, a safe over-report, not a regression.

NPC B does not vanish: 20 `leak/l4-hidden-name` findings remain for it across the frontmatter
and body arms, including one finding reached only through another entity's relationship edge
to NPC B, which is not marked `gm_only` and therefore still fires as expected.
NPC A's genuine hits survive at the correct lines in a player-character page and, for NPC B, in
a location page, both matching pass 1's own AC-03 prediction exactly.
`leak/l4-name-collision` remains 0 on the same export, matching pass 1's AC-02 expectation
exactly.

Timing: `check` in-process, three runs, 49-94 ms (NFR-05 baseline 349 ms). Two `check --json` runs
against the same export gave byte-identical `findings` arrays.

## Risk areas, and how each was closed

- **Wrong-vault evidence.** Every figure above comes from one `git archive` export of `91d8a7b`, built
  and grepped in the same pass; none of it is drawn from the live, concurrently-curated NAS vault.
- **Alignment desync.** Closed by construction (monotone cursor, restore-on-failure) and by direct unit
  tests (`test/textmodel-linemap.test.js`): CRLF, a collapsed block, a start-of-line comment, an
  end-of-line comment, a stub reduction, and a genuinely unmatched line that must not desync what
  follows it.
- **A finding suppressed because its line could not be mapped.** Structurally impossible: the
  `createFinding` call is unconditional on the alignment result; `line` is the only thing that varies.
  Proven by AC-D3-06's forced-all-null test.
- **Fixture ripple.** New pin-vault fixtures were added to `_meta/publish-manifest.md`; the whole suite,
  including `test/publish-equivalence.test.js`'s real-build oracle, stayed green with no oracle edits.

## Consequence

- `README.md:22`'s "L1-L5" wording stays true (L4 is now a two-id family within L1-L5, not a renumbered
  check).
- `docs/KNOWN-VAULT-FINDINGS.md` gained a new section with the post-D3 real counts, retained in the private archive at `b5b48b4`.
- No suppression mechanism, allowlist, exception list, or `--acknowledge` flag exists or was added.
  `--force` remains the only escape hatch.

**Addendum, Track D2 (2026-09-17):** the "Will still not catch, out of scope here (D2)" list above is
closed by `docs/decisions/0009-output-leak-scan.md`, `leak/l4-output-name` and `leak/l4-index-term`
read the generator's actual emitted output (built HTML, copied attachment paths, `search-index.json`)
for exactly the derived-view names this check structurally cannot see. This line is additive only; the
evidence and counts above are untouched.

## Addendum: session bodies the site builder withholds

`docs/decisions/0036-session-wrap-up-support.md`'s "Decision" adds a third case to `deriveRenderedText`'s
body arm: when a session note has paired with a published Wrap-Up, the site builder withholds that
note's body and shows the Wrap-Up's recap instead, so this check now treats that body as empty the
same way it already treats a stub-reduced or section-filtered one: a withheld name that appears
only in that body is correctly not a leak, because it never publishes. Frontmatter is unaffected,
and every other page (including the Wrap-Up itself) is checked exactly as before. See that ADR's
"Will catch" / "Will not catch" for the fail-safe this depends on.
