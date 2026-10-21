# 0044. Obsidian %% comments are removed before the site is built, and the build refuses to publish one

## Summary

In Obsidian, text between two `%%` marks is a comment: hidden in reading view and used for private
notes. The site generator does not know this and would publish the text as written (upstream issue
305). Now the build removes every `%%` comment, inline or over several lines, before the generator
reads a note. `check` lists the files that have comments so you know text is being withheld, and it
warns about a comment that is never closed. If comment text still reaches the built site, the build
refuses and `--force` does not override that. `%%` inside a code block or a code span is code, and
is left alone. A `type: document` handout's Keeper headings (Context, Clues, Prop Notes, Delivery)
are also checked by `leak/l5-gm-heading-survives`, as a safety net behind the generator's own rule.

Status: accepted.

## 1. The decision

- `scanObsidianComments` in `src/vault/comments.js` is the one reader of the syntax. It returns the
  markdown with comments removed (newlines kept, so line numbers match your note) and the list of
  comments it found.
- The build's read shim (ADR 0043) now takes an ordered list of text transforms. The build installs
  `READ_TRANSFORMS_FOR_BUILD`: comment removal, and (until publish-v1.14.0) the escaped-pipe rewrite.
  Each transform is independent. The escaped-pipe entry and `installEscapedPipeReadShim` are retired
  (ADR 0043's addendum); comment removal is the only transform left and needed no change.
  `rewriteEscapedPipeLinksOutsideCode` stays, as `check`'s own reader.
- `check`'s source-side view of a page (`renderChain` in `src/checks/leak/textmodel.js`) removes
  comments first too, so a leak check never reports text the build withholds, and never misses text
  the build keeps.
- `src/checks/leak/commentscan.js` adds three checks (all on by default):
  - `leak/l6-comment-withheld` (INFO): one per published page or story file with comments, with line
    ranges. It never prints the comment text.
  - `leak/l6-comment-unterminated` (WARN): a `%%` with no closing `%%`.
  - `leak/l6-comment-in-output` (ERROR): built output carries the text of a comment (page, search
    index or anything else the generator wrote), or a literal `%%` in page text outside `<code>`,
    `<pre>`, `<script>` and `<style>`.
- During `build` the same scan runs on the staging tree, as its own step beside the GM link marker
  scan (`src/build/outputgate.js`, `scanCommentSurvivors`). A hit refuses the build, writes nothing,
  and `--force` is never consulted. You wrote `%%` to hide the text, so the intent is explicit.

## 2. Unterminated `%%`: strip to the end of the file

Two fail-closed options: withhold from the stray `%%` to the end of the file, or refuse the build.
This takes the first. Refusing would stop a whole site build for a typo, and `check` already shows
the exact line as a WARN. Withholding is the safe direction: the worst case is a page that ends
early, which you will see; it can never publish a private note. Residual: a page that ends early goes unnoticed if nobody reads the WARN.

## 3. Where the removal lives

At the read shim, for the reason ADR 0043 gives: the generator reads each note in several places
(page, backlinks, recency, excerpts, search index) and one read point fixes all of them together.
The pinned generator is not edited (ADR 0005). The Connections and Timeline passes read the built
HTML, not the notes, so they inherit the removal.

## 4. What is and is not a comment

- Code is recognised with the same masking the link scan uses (`src/vault/links.js`): fenced blocks
  (backtick or tilde) and single-line inline code spans.
- Inside an open comment everything is comment text up to the next `%%`, even a line that looks like
  a code fence.
- A leading YAML frontmatter block is left alone. Obsidian does not treat `%%` there as a comment and
  removing it could break the YAML. If `%%` text in a field is published, the output gate refuses
  the build (a literal `%%` in page text).
- `%%%` is read as an opener followed by a stray `%`, so it fails closed.

## Will catch / Will not catch

Will catch:
- Inline `%%note%%`, several on one line, and a block that spans lines, in published pages and in a
  PC's paired `_Story.md`.
- A comment link such as `%%see [[Someone]]%%`: no backlink, connection or search entry results
  (the proof test builds the same vault with the comments deleted by hand and compares every file).
- An unterminated `%%`: withheld to the end of the file, and a WARN naming the line.
- Comment text surfacing in the built output by any route (a future generator change, a second
  reader that skips the shim): the output gate refuses the build and `--force` cannot override it.
- A `type: document` (or `handout`) page still rendering a level-2 `Context`, `Clues...` (first word Clues),
  `Prop Notes` or `Delivery` heading: `leak/l5-gm-heading-survives` reports it. The pinned generator
  (1.12.3) withholds these itself, so this is a safety net that reports nothing today and cannot
  double-report. `### Delivery` inside the handout text, "Innkeeper Notes" and "Contextual Detail"
  are not matched.
- Adjacent `%%%%text%%%%` parses as an empty comment, then `text`, then an empty comment: the text
  stays visible, exactly as in Obsidian.

Will not catch, and these are residuals:
- A `%%` inside a frontmatter value is not removed (see section 4). If that text is published, the
  output gate sees a literal `%%` and refuses the build (fails closed).
- A code span that wraps across a line break is not recognised as code (the link scan's documented
  gap), so a `%%` in one is treated as a comment opener. That fails closed.
- An indented (four-space) code block is not recognised as code; a `%%` in one is treated as a
  comment. Also fail closed.
- The output scan searches for comment text of 8 or more characters (whole comment, and each line).
  A shorter comment such as `%%todo%%` is not searched for, because it would also match ordinary
  published words. A literal `%%` left in page text is caught whatever the comment said.
- Comment text transformed by the generator into something no longer matching (for example wrapped
  in markdown emphasis) and with its `%%` marks also gone. No such route is known.
- Comments in notes that are not published are not listed by `check` (they are still removed if the
  build reads them).
- `fs.readFileSync` is patched process-wide for the length of one build, as in ADR 0043.

## Addendum: JSON data islands (ADR 0045)

The output scan first ignored every `<script>` block, which hid the JSON data islands that
timeline and connections pages carry. Those islands are now searched, and an island that cannot be
parsed is an error. This replaces the "outside `<script>`" scope for JSON islands only; other
`<script>` and `<style>` content is still left out. See
[ADR 0045](0045-leak-checks-read-rendered-headings-and-data-islands.md).

## Addendum: dataview blocks (issue 202)

Status: accepted.

What changed for a GM. A Dataview query in a published page was already hidden on the page. But
the words in it were still written into `search-index.json`, which anyone can download from a
player site, and a `[[link]]` inside a query added a "Mentioned in" entry. A query in a session
recap could also show up as a code block on the landing page. The build now removes dataview blocks
(`dataview` and `dataviewjs`) before the generator reads a note, so none of that happens, and no
page changes.

The decision. At the pinned generator (publish-v1.14.0) the text it uses for search, "Mentioned in",
recency and the recaps keeps dataview blocks, while the page render strips them. The build's read
shim (section 3) gets a second transform, `stripDataviewBlocks` in `src/vault/dataview.js`, after
the comment strip. `check` already strips in this same sequence. The new transform calls the pin's own `stripDataview`,
so there is no pattern of our own to drift. Two rules keep it narrow:

- A note's frontmatter is returned byte for byte. It is found with the same rule the comment strip
  uses (section 4) and split by character offset, so line endings come back exact.
- `_meta/publish-manifest.md` is left alone. The generator reads the manifest line by line, so
  removing a fence that holds an `## Excluded` heading would move the entries below it into
  Publishing for the build but not for `check`. To tell the manifest apart, the shim now hands each
  transform the file path as a second argument. The comment strip ignores it.

Rejected alternatives:

- Wait for the repin. From publish-v1.16.0 the generator strips dataview first in that text. The
  real-build test (`test/dataview-withheld.test.js`) is what will say whether the shim entry can go.
- A `check` notice only. It would tell the GM but still publish the words.
- Post-processing `search-index.json`. It would leave "Mentioned in" and the recaps as they are.
- A hand-copied pattern. It would drift from the pin.
- An output-gate scan for query text. It cannot tell which query words are secret, and the
  real-build test catches a regression at a repin.
- Stripping the manifest too. The build's published set would differ from `check`'s, which is a
  leak path we would cause ourselves.

Residuals:

- The strip does not keep line counts, so a generator warning's line number after a block can shift.
- A frontmatter block closed by `...` is accepted by the frontmatter rule used here, and gray-matter
  may not accept it.
- A nested `_meta/publish-manifest.md` is also skipped.
- A `%%` in the manifest is still removed by the comment strip, as before.
- Nothing here is proven on win-x64.
