# 0043. A table cell link with an escaped pipe is read the same way by check and by the build

## Summary

In a markdown table, a link with a label is written `[[Target\|Label]]`, because a bare pipe would
end the table cell. Scriptorium's `check` and the pinned site generator both split a link on a bare
pipe only, so they read the target as `Target\`, found nothing, and the build printed the label as
plain text. Now both read it the way you meant. `check` rewrites the escaped pipe in its own scan.
For the build, Scriptorium swaps in a reader for the length of one build that does the same rewrite
on the vault's notes as the generator reads them. Nothing in your vault is changed, and the
generator's own files are not edited.

Status: accepted.

## 1. The decision

One function, `rewriteEscapedPipeLinksOutsideCode` in `src/vault/links.js`, turns `[[T\|L]]` into
`[[T|L]]`. It acts only on a line whose first non-space character is `|` (a table row), never inside
a fenced code block, and never inside an inline code span on that line. `check` calls it before its
code masking, so its answers match what the build sees.

The build calls the same function from a read shim in `src/generator/bootstrap.js`.
`installEscapedPipeReadShim(vaultRoot)` replaces `fs.readFileSync` and returns a restore function.

## 2. Why a read shim and not a pre-parse transform

The generator reads each note's text in several independent places: the page body, backlinks, the
recency list and the search index each parse links on their own. Rewriting at the one point where
the text is read fixes all of them together, so the page, the backlinks and the search index cannot
disagree. A transform at only one of those places (for example around the generator's page renderer)
would fix the page and leave backlinks and search wrong. Editing the pinned generator is not allowed
(ADR 0005). Copying the whole vault to a rewritten staging copy would add a large write and a new
place where vault content lives; the build deliberately reads the vault in place.

## 3. Lifecycle

`runGeneratorBuild` installs the shim next to the existing copy-file shim and restores it in its
`finally` block, so it is removed whether the build succeeds or throws. The vault root is read from
the staged config the build itself wrote (`vaultPath`). If that cannot be read, the shim is
installed with no root and rewrites nothing. A test proves `fs.readFileSync` is the original again
after both a successful and a failed build.

## 4. Scope

The shim rewrites a read only when all of these hold: the read asked for text (an encoding was
given), the path is a string ending `.md`, and the file's real path (symlinks resolved) is inside the
vault's real root. Buffer reads, other extensions and any path outside the vault, including a link
inside the vault that points outside it, pass through untouched. Nothing is written back.

## Will catch / Will not catch

Will catch:
- `[[Target\|Label]]` and `[[Target#Heading\|Label]]` in table rows, in check, the page, backlinks
  and the search index.
- `![[image.png\|300]]` in a table row (same rule).

Will not catch, and these are residuals:
- A link with an escaped pipe outside a table is left alone, since the escape means nothing there.
- A link inside code is left alone on purpose (it is not a link to a reader). A code span that runs
  across a line break is not recognised as code, the same gap `check` already documents.
- `fs.readFileSync` is a process-wide function. For the length of a build every read of a vault note
  in this process goes through the shim. A build is synchronous, so nothing else interleaves with it
  today; if a build ever becomes asynchronous in the same process as the admin panel, this needs
  revisiting.
- A different reader added by a future generator version (one that reads notes some other way, for
  example with a stream or a native module) would not be rewritten; the end-to-end test would show it.

## Addendum: the build half is retired at publish-v1.14.0 (2026-10-06)

Status of the build half: **superseded by upstream.** The escaped-pipe rewrite in the build's read shim
(`installEscapedPipeReadShim`, and its entry in `READ_TRANSFORMS_FOR_BUILD`) is deleted. The `check` half
stays: `rewriteEscapedPipeLinksOutsideCode` in `src/vault/links.js`, and the line rule in
`src/util/tablepipes.js` that it uses, are `check`'s own reader and are untouched.

Why: since `publish-v1.12.3` the pin has one wikilink reader (`lib/wikilink.js`) that resolves a
table-cell `[[Target\|Label]]` itself, for the page, backlinks, recency, the story spine and the search
index. The shim then rewrote the link to the bare-pipe form the pin also resolves, so it did the same
job twice. Harmless, and its tests stayed green, which is why it was left in at the 1.12.3 pin and
retired here.

What stays of the shim: the mechanism (`installVaultReadShim`: vault scope with realpath checks,
text-only, `.md`-only, nothing written, the restore on success and on a throw) and the comment strip from ADR 0044, which is now the only transform
(`READ_TRANSFORMS_FOR_BUILD = [stripObsidianComments]`).

Proof, with the pin's fix alone:
- `test/escaped-pipe-wikilink.test.js`, the CLI test, on a real build of a copy of
  `examples/the-long-lease` with a table cell `[[Emlyn Crewe\|Label Zqx]]`: `check` reports no
  unresolved link; the built page has `<td><a href="emlyn-crewe.html">Label Zqx</a></td>`; no raw `[[`
  and no stray backslash; the search index holds the label term and no backslash term; the linked page
  lists the mention as a backlink.
- An A/B of that build with the old rewrite pushed back into `READ_TRANSFORMS_FOR_BUILD` against
  the build without it: the two output trees are byte-identical (`diff -r` clean), so the retired
  half contributed nothing at this pin.
- `test/escaped-pipe-wikilink.test.js` now also asserts the shim returns a table-cell escaped pipe
  byte for byte, and `test/obsidian-comments.test.js` asserts the build installs exactly one transform
  and that `installEscapedPipeReadShim` no longer exists.

Not retired, on purpose: `tablepipes.js`, which the brief listed, because `check` depends on it through
`src/vault/links.js`; removing it would break `check`'s agreement with the build. The "Will not catch"
residual about a different reader added by a future generator version now points the other way: a future
pin that stops reading table-cell escaped pipes shows up in the CLI test above, by name.
