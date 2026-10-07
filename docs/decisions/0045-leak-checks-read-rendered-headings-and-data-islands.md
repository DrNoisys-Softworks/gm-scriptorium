# 0045. The leak checks read headings the way the generator renders them, and read JSON data islands

## Summary

The check that finds an excluded section (such as "GM Notes") still showing on the built site only
caught plain `## ` headings written against the left margin. It missed a bold heading, an indented
one, an underlined one, one inside a quote, one with a leading symbol, and anything in a player
character's `_Story.md`. Now it reads headings the way the generator parses and renders them, in
the page body and the story file, and compares the text a reader would see. The output scan for
comment text also skipped the JSON data in timeline and connections pages. It now searches that
data, and an island it cannot parse is an error instead of being skipped. Existing vaults may see
new errors from `leak/l5-gm-heading-survives`; they are real, because the generator publishes
those sections. The generator's own exact-match rule is not changed here.

Status: accepted.

## 1. The problem

The generator withholds an excluded section only when the raw heading title equals an entry
(`exclusionReason` in its `lib/processor.js`). `## **GM Notes**` and `## GM Notes (spoilers)` are
published. `leak/l5-gm-heading-survives` was meant to catch this and did for the second form, but
it read headings with one margin-only pattern over the page body, compared raw markdown, and never
looked at `_Story.md`.

The output scan for `%%` comments (ADR 0044) deleted every `<script>` block before searching, which
also deleted the JSON data islands that `sc-tl-data` and `sc-cx-data` (and the generator's own
id-keyed islands) use. Comment text that reached an island was invisible to it.

## 2. L5: how headings are read

- The facade `src/generator/pinned.js` now also re-exports `findHeadings`, `renderInline` and
  `resolveWikiLinks`, unmodified, from the generator. Nothing is re-implemented here.
- `readRenderedHeadings` (in `src/checks/leak/textmodel.js`) returns one entry per line. It merges
  the parser's reading (ATX at any indent the parser accepts, closed ATX, setext, headings in a
  blockquote or list) with the old margin pattern. The margin pattern is kept so that no heading
  the check saw before is lost, including margin lines inside code, which the generator also
  treats as the start of a withheld section. `extractHeadings` and `deriveRenderedText` are
  unchanged, so the session checks behave as before.
- If the parser throws, the source reports one error with a fixed message (never the parser's
  message or any page text), and the margin headings are still checked.
- The same reading runs over `storyText`. A story finding carries the `_Story.md` path and, where
  the text can be aligned to the file, its line; otherwise the line is null and the finding is
  kept.

## 3. L5: how headings are compared

Comparison is by key. A key is the text with typographer quotes folded, NFC applied, tags removed,
whitespace collapsed (a non-breaking space counts) and lower-cased.

- A heading has up to three keys: its raw title, its rendered display text (emphasis and link
  markup dropped, entities decoded, `[[Page|Alias]]` shown as `Alias`), and the display text with
  leading symbols removed (so a leading emoji does not hide the title).
- An entry has two keys: itself and its rendered display text. Empty keys are dropped, so an empty
  entry no longer matches every heading. Entries are never stripped of leading symbols.
- A heading matches when one of its keys equals or starts with an entry key. Every match is an
  error, with the same check id as before.
- At most one finding is reported per source line, even when the parser and the margin pattern
  give different titles for it.

## 4. L6: data islands

- HTML output is read once, left to right, following the HTML tokenizer's own states, and nothing is
  removed by pattern. HTML whitespace is only tab, line feed, form feed, carriage return and space.
  A quote opens an attribute value only after a real attribute name and its `=`, and a quoted value
  may hold `>`. `<script<script>` is an unknown element, so the text after it is displayed and
  searched. `<script>` and `<style>` bodies run to their own end tag (which may carry spaces or
  attributes).
- Content a browser shows as text is searched, markup and all: `textarea`, `title`, `xmp`, `iframe`,
  `noembed`, `noframes`, everything after `<plaintext>`, and CDATA sections. The text inside an HTML
  comment is searched too, because it is in the page source.
- A tag, block or quote that never closes is treated as page text, not skipped. A browser drops such
  a tag and everything after it without showing anything; the scan searches the remainder anyway.
  Work on tags that never close is bounded, so a hostile page cannot make the scan slow.
- Every island of type `application/json` or any `application/*+json` (such as `ld+json`) is found,
  whatever the attribute order and whether it is keyed by `class` or `id`. The first `type` attribute counts,
  a `type=` inside another attribute's value does not, and character references in the value (such as
  `application&#47;json`) are decoded first. A type that still holds an unknown reference counts as JSON.
- A parsed island adds its strings as one more place to search for comment text. A `%%` inside an
  island string is reported by the existing marks arm.
- An island that does not parse is reported as `leak/l6-comment-in-output` with
  `arm: 'island-unparsable'`. The message names the file and nothing from the island or the parser.
  The raw island text is still searched for comment text and for `%%`.
- Other `<script>` and `<style>` content that ends properly is still left out of the search. `<pre>`
  and `<code>` text is left out of the `%%` reading only, up to the first end tag of the same name.

## 5. Exit codes

No new exit codes and no new check ids. L5 errors make `check` exit 2, and `build` refuses with 2
unless `--force`. L6 island findings make `check` exit 2, and `build` refuses with 2 through the
output gate, which `--force` cannot override. An unparsable island is a finding, not a thrown
error, because a throw would exit 1 and read as a Scriptorium bug.

## 6. Rejected alternatives

- **Fix the exact-match gap in the generator from here.** The generator is vendored and
  integrity-pinned. The fix belongs upstream, and is written up as a follow-up.
- **Port `looseHeading` and `walkExcludeList`.** They are not exported, and a hand copy drifts.
- **Make the leading-symbol key a warning.** The generator publishes the body in that case, and the
  starts-with rule already accepts the same sort of suffix, so a warning would understate a leak.
- **Skip an island that does not parse.** That turns a broken page into a silent gap.
- **Throw on an unparsable island.** It would exit 1, and it would split the fail-closed path in two.

## 7. Will catch, and will not catch, deliberately

Will catch:
- An excluded section heading written as bold, emphasis, a link, a wikilink alias, an entity, with
  trailing words, with a leading symbol, indented, underlined (setext), closed with hashes, or
  inside a quote or list, in a page body or a `_Story.md`.
- Comment text, or a literal `%%`, inside a timeline, connections or generator JSON data island.
- An island that cannot be parsed.

Will not catch, and these are residuals:
- A heading form that only the generator's `looseHeading` reading sees, which occurs only below an
  unclosed code fence, where the text renders as code and not as a heading.
- Body line numbers are still lines of the stripped text, not the source file (unchanged).
  Story line numbers are aligned to the source where possible.
- A `%%` that sits in a code span and was flattened to plain text in an island. That fails closed
  and refuses the build.
- Content in a `<script>` that is not JSON.
- `.json` output files get no marks arm (unchanged).
- The generator's own exact-match gap. The section is still published by the generator; this
  change only reports it.
