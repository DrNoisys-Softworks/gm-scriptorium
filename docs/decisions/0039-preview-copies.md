# 0039. Preview copies of your site, built privately on this computer

Status: proposed.

## Summary

The Theme screen now shows your own campaign site in each built-in theme, as a small live frame
on each theme card, instead of a sketch. To do that, the panel builds extra private copies of your
site, one per theme, using exactly the same build and the same checks as Build preview, from the
same change a save would make; it never writes to your vault and never touches your published
output. Copies are built only when you ask, one at a time, and the panel pauses while each one
builds. They live in the preview's own temporary folder, are capped at 1 GiB in total with the
oldest removed first, and are deleted when the panel stops. A screenshot tool bundled with the
program was rejected: you asked for live frames, and it would be a large new dependency.

## 1. Decision

One copy per theme, built through the existing build pipeline from an in-memory pack file; served
from the preview address under a reserved prefix; framed exactly as the preview-in-a-frame decision
frames the preview.

## 2. How a copy is built

The pack file text comes from the save's own preview of the change, so a copy shows exactly what
saving would produce. The mechanism is the read chokepoint's one-file overlay, the same one
`docs/decisions/0041-check-an-edited-copy.md` section 2 ("Why at the reading module") introduces:
for the length of one build and its own pre-check, the one file the build would read from disk
instead comes from that in-memory text, keyed on the exact path the build reads. The build, the
check and the output safety checks are the same, with no way to force or skip any of them. The
command line can't reach this at all.

## 3. Where copies live and how they're served

- One folder per copy, under the preview's own temporary folder.
- The reserved prefix contains a character no ordinary page address on the preview can contain, so
  it can never hide a page of the real preview.
- The copy's name is checked against a fixed list.
- Framing, the sandbox and the cookie are unchanged from the preview-in-a-frame decision.

## 4. Limits

At most one copy per theme plus the Vocabulary example; 1 GiB in total; oldest removed first; a
copy too big on its own is refused; everything is deleted on stop; the panel pauses for each build.

## 5. How fresh a copy is

The same stamp the preview-in-a-frame decision uses for "how fresh the preview is", taken per copy.

## 6. Threat notes

- Copy folders are checked to sit strictly inside the preview folder, by real path, never by
  string comparison, and are never symlinks.
- Removal never follows a link.
- No new listener, port or framing allowance.
- No separate process.
- Copies carry no GM link.
- The vault is never written: the change is only ever previewed, and a test compares every file in
  the vault before and after.

## 7. Rejected alternatives

- A bundled headless browser or stock screenshots.
- A scratch copy of the vault or pack folder.
- Writing then restoring the pack file.
- A port per copy.
- An ordinary-looking path prefix.
- Choosing the copy by query string.
- One request building every theme.
- A background process.
- Building when the screen opens.
- Copying the save logic instead of reusing its preview.
- A second, separate way of handing a changed pack file to the check and the build. Two mechanisms
  to keep in step, and any reader added later would silently read disk.

## 8. Will catch

- A copy name not on the list.
- A path climbing out of a copy or into another.
- A copy folder replaced by a link.
- A vault that fails check (no copy, previous copy kept).
- A copy aimed into the vault (the build's own refusal).
- The save path accidentally running for real (the vault comparison).

## 9. Will not catch, deliberately

- Notes edited outside the panel.
- Saving a theme marks every theme preview out of date even though only the "in use" badge changed.
- A copy's not-found page follows the site address's path, so its links lead to the main preview.
- Links to other sites inside a frame show the browser's refusal.
- A copy built from another browser tab between this tab's builds.
- Large sites keep fewer copies.
- Copies add about 20 characters to Windows paths.
- The panel pauses during builds.
- The module cache grows per build.
- A locked file left behind on removal uses disk until the panel stops.
- A campaign without a pack file can't build theme previews; the panel asks you to save a theme
  first.

## 10. Evidence

- `src/vault/read.js`: `withCandidateFile`.
- `src/admin/variants.js`.
- `src/admin/handlers/variants.js`.
- `src/admin/handlers/views.js`: `servePreview`.
- `src/serve/static.js`: `resolveStaticPath`.
- `assets/admin/sitepane.js`: `PV.variantSrc`.
- `assets/admin/variants.js`.
- `test/admin-variants.test.js`, `test/admin-variant-serving.test.js`, `test/admin-v1e7-model.test.js`.

## Addendum: the Vocabulary live example

The example is one more copy, built from your saved pack file plus the Vocabulary screen's
unsaved edits, sent in exactly the form a save sends. It is refused if the file changed outside
the panel, and it is never written. It is built when you ask, not as you type. "Now" is the
current preview.

Rejected: an example drawn by the panel as you type (you chose a real build); a build per
keystroke; a highlight inside the frame, which would need a message channel ADR 0035 rules out.

Will not catch: the frame shows the page, not the exact word; an example built in another tab
isn't recognised as matching this tab's edits.
