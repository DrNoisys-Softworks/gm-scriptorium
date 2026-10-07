# 0037. Relationship words are checked against the vault's own list

## Summary

`check` now warns when a relationship in a note uses a word that isn't on the vault's own
relationship list, `_meta/relationship-types.md`. The site still shows every relationship, whatever
word it uses, but a few features only recognise exact listed words, such as a faction's member list
and the roles shown for characters on the home page. Where the slip is only capitals, spaces or
hyphens, the warning names the listed word; otherwise it asks you to pick the closest listed word
and store each relationship once, from one end. The vault's own list is the only source: we decided
against bundling upstream's full list and its reverse-word and synonym tables, which carry a
share-alike licence and can drift from what the vault says. A vault with no list, or a list in a
layout Scriptorium doesn't recognise, gets one note saying nothing was checked.

Status: accepted.

## 1. What changed

A new finding, `relationship/unknown-predicate`, warns once for each relationship whose word isn't
on the vault's own list. It never blocks a build: exit codes, the `--json` shape and the admin panel
are all unchanged. It sits with the frontmatter checks rather than a graph check, because the check
groups are fixed and only the graph group can be switched off; this finding is meant to be on by
default for every GM.

## 2. What the check reads

The check reads exactly one file, `_meta/relationship-types.md`, and exactly two things in it:

- every word in the "Types" column of any table that has one. A word ending in `*` is a symmetric
  word (used the same way from either end), and the `*` is stripped;
- the bold line that starts "**Symmetric**", whose words also count as symmetric and as vocabulary.

Nothing else in the file contributes: prose, headings, other lists, other bold-label lines, a
backticked word outside that column, and a table with no "Types" column are all ignored. A file
saved with Windows line endings (CRLF) is read the same as one saved with Unix line endings (LF).

When there's nothing usable to read, one note explains why, instead of checking every relationship
silently:

- the file doesn't exist;
- the file's frontmatter fails to parse;
- the file has no table with a "Types" column;
- the "Types" column lists no words at all.

## 3. What an off-list word actually does on the site

The generator we build on keeps and renders a relationship whatever word it uses. It appears in the
relationship graph, the relationship list on a note's own page, the sidebar badge, character cards,
and faction index cards, and it also appears in Scriptorium's own Connections lane. An off-list word
is not hidden, dropped or removed from any of these.

Only two places match on the exact word rather than just showing it:

- a faction's member list only counts a relationship of type `member_of` or `assigned_to`;
- the home page's character roles only read `employs`, `leads` or `commands`.

A relationship using any other word, including a perfectly sensible synonym or the reverse
direction of a listed word, simply won't be picked up by those two features. That's the actual cost
of an off-list word today, and it's what this check is for.

Upstream's own documentation for this generator says an off-list word drops out of the relationship
graph entirely. At the version this repository builds on, it doesn't: the evidence is in the trailing
section below. Upstream's own tooling reportedly rejects an off-list word outright; that isn't
verified here, only read from the same documentation.

## 4. Suggestions

The check compares words exactly, because that's how the generator's own two word-matched features
compare them: a case, space or hyphen difference is invisible to the generator too. So when a word
is off-list only because of a case, space or hyphen slip, and it's the ONLY listed word that slip
could resolve to, the warning names that word directly.

When there's no single word it could be, or the word describes the relationship from the other
direction, the warning gives a general reminder instead: pick the closest listed word, and store the
relationship once, from one end. A symmetric word is valid used from either end, so it never gets a
reverse-direction reminder.

## 5. Overlap with other checks

The existing graph hygiene check that warns about vague relationship words (`related_to` and the
like) stays quiet on a relationship this new check already reports, so a GM doesn't see the same
relationship called out twice. A word that's vague but still on the vault's own list, such as
`knows`, is untouched by this change and still gets the hygiene warning on its own. When the vault
has no usable list at all, the hygiene check behaves exactly as it always has.

The existing check for a type's required relationships can still fire on the very same relationship.
That's deliberate: a relationship can be both the wrong required type and an unrecognised word at
once, and both statements are useful to a GM fixing it.

A relationship stored on both ends instead of once, as a symmetric word, remains the separate graph
check's job and isn't touched here.

## 6. Rejected alternatives

- **Our own table of reverse words and synonyms.** This would be our own writing, keyed to
  upstream's word choices, and could quietly go stale the moment upstream's own list changes.
- **Vendoring a copy of upstream's own word list and its normalisation map.** That list carries a
  share-alike licence and would need its own notices entry and a licence re-audit, plus either a
  network fetch at some point or someone handing the file over. It was ruled out for this cut.
  See `docs/PROVENANCE.md` section 4.
- **A rule based on the `bidirectional` flag some GMs use for a symmetric word.** The generator this
  repository builds on never reads that flag, so a rule keyed on it would judge vaults against a
  flag with no effect on the built site.
- **Matching case-insensitively.** The generator's own word-matched features compare exactly, so a
  case-insensitive check here would pass words the site itself won't recognise.
- **A built-in fallback list for a vault with none.** Rejected along with the vendored list above,
  for the same reason.
- **Making this an error rather than a warning.** An off-list word is never a defect that stops a
  build; a warning is calibrated to what's actually at risk.
- **Putting this behind the `--graph` flag.** It's meant to be seen by every GM by default, the same
  as the vault's other frontmatter checks.

## Will catch

- any relationship in a note with a recognised type, however it's targeted or gated, whose word
  isn't exactly on the vault's own list, including a case, space, hyphen or prefix slip;
- a word from a wider, genre-spanning word list that the vault's own, trimmed-down list leaves out;
- a relationship list file that's missing, fails to parse, or is laid out in a way this check
  doesn't recognise, naming which of those it is.

## Will not catch, deliberately

- a listed word used from the wrong end of the relationship;
- any use of a `bidirectional` flag;
- a relationship pair stored independently on both ends;
- a relationship with no word at all;
- a note this check never looks at in the first place, such as a template, or one whose frontmatter
  doesn't parse or carries no recognised type;
- a typo that's actually inside the vault's own list file, since that makes the typo itself valid;
- a relationship list laid out as anything other than a table with a "Types" column plus a bold
  Symmetric line;
- a word written with a bracketed note or markdown emphasis inside its table cell, since that's
  taken as part of the literal word;
- a table sitting inside a code block, which this check still reads;
- tone and strength values, which aren't relationship words at all.

## Residuals

- `assigned_to` counts towards a faction's member list on the generator side, but this check still
  flags it if it isn't on the vault's own word list. A GM who uses it can simply add it to their
  list.
- The reminder for a reverse-direction slip is general advice, not a named fix, because this cut has
  no reverse-word table to draw one from (see Rejected alternatives).
- A build re-reads this same file once more, separately, for its own output scan; that's one small,
  known extra read, not a new kind of failure.
- Nothing about this check is specific to Windows, so it isn't verified there separately.

## Evidence

Re-verified against this repository's pinned copy of the generator at `publish-v1.11.40`:

- `lib/relationship-graph.js:54-72` (the relationship graph keeps any `type` string)
- `lib/processor.js:400-422`, the valid-relationship filter at `:403` (any non-empty `type` and
  `target` renders, verbatim)
- `lib/templates/context-sidebar.js:3-25,39-47` (the sidebar badge shows any `type` string)
- `lib/templates/npc.js:76-97` (character connection cards show any `type` string)
- `lib/templates/index-page.js:616-621` (faction index intel cards show any `type` string)
- `lib/templates/faction.js:59-66` (the only exact-word match: `member_of`, `assigned_to`)
- `lib/templates/landing-data.js:151,155` (the only other exact-word match: `employs`, `leads`,
  `commands`)
- `src/build/connections.js:59-129` (Scriptorium's own Connections lane carries any `type` string
  through unchanged)
- `bidirectional` gets zero hits anywhere in the pinned generator tree, and the pinned tree ships no
  relationship-word list of its own
- the exit-code line this change leaves untouched: `src/cli/check.js:382-383`
- the precedent for a new finding id sharing the existing Finding shape: ADR 0023, section
  "`config/theme-scheme-mismatch`"
