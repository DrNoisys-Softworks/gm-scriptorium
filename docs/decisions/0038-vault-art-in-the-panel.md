# 0038. The panel shows art from your vault's attachments folder

Status: proposed.

## Summary

The admin panel's Images screen can now show the pictures already in your vault's attachments folder,
so you can pick one for a spot without uploading a copy. The panel lists only image files inside that
one folder, never follows a link out of it, and lists nothing else in your vault. It sends back only
a picture it has already listed, and checks again at that moment that the file is really still inside
the folder and not too large. Pictures in folders your configuration excludes are shown greyed out and
can't be chosen, by the same rule a build already applies. Listing the folder as part of the panel's
main state load was rejected, because it would re-read the whole folder after every save. The list
stops at 2000 pictures and says so; a picture elsewhere in the vault can still be typed as a path.

## 1. Decision

Two new routes, both read-only GETs: `GET /api/vault-art` lists the folder, `GET /api/vault-art/file`
sends one picture's bytes. The folder is `vault.config.json`'s own `attachmentsDir`, defaulting to
`_attachments`, the same default the generator's own attachment scan uses. The listing covers image
files only (jpg, jpeg, png, webp, gif, svg, avif); folders and anything else are never named. The byte
route answers with the same sandboxed, framing-refused policy an uploaded image already carries
(`Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'`),
so a picture the panel serves back can never run a script or be framed.

## 2. Staying inside the folder

- The folder's real, resolved location must sit strictly inside the vault's own real location: not
  the vault itself, not its parent, and not a folder whose name merely happens to start the same way
  (a `-evil` sibling, say). A folder that is itself a link is allowed only when that link leads
  somewhere still inside the vault, the build's own asset step treats a link the same way, so this
  agrees with it.
- Every folder the walk descends into is resolved and checked the same way, one real-path check per
  folder. A link to a folder, or a folder whose name starts with a dot, is never descended.
- One real-path check per folder is enough while listing, because the walk only needs to know whether
  to keep going; the byte route re-checks the specific file it is about to send, at the moment it
  sends it, which is the check that actually matters for safety. Checking every file's real path
  during the listing walk too would cost roughly one extra filesystem round trip per file, which adds
  up badly over a network share.

## 3. Excluded folders

A picture under a folder your configuration excludes from publishing is still listed, but marked
unusable, by the exact same rule the build already applies when a pack.toml slot points at the vault:
the excluded-directory list from both `vault.config.json` and `vault-config.md`, checked against both
the path you'd type and the path it really resolves to. Hiding it instead would make the picture
simply vanish with no explanation; showing it, greyed out, lets you see why it can't be chosen. Should
you nonetheless type that path by hand into a slot, the server-side save still refuses it with the
same message a build would give.

## 4. Limits

The listing stops at 2000 pictures, and after looking at 20,000 folder entries in total, whichever
comes first; either way it says the list was cut short. Each picture served back is capped at the same
10 MiB a build already enforces for every image slot.

## 5. What choosing a picture does

Choosing a vault picture for a spot writes an ordinary `vault:` path into pack.toml through the
unchanged slot-save route, exactly as typing that path by hand already could. The build's own checks
extension, size, containment, exclusion, still decide whether that picture actually ships; this
slice only makes the picture easier to find and preview, not easier to smuggle past those checks.

## 6. Rejected alternatives

- **Folding the listing into the panel's main state load.** The main state reloads after every save,
  so the whole folder would be re-walked every time anything at all is saved, which is slow over a
  network share and buys nothing the dedicated route doesn't already give.
- **A byte route that takes any path and checks safety only afterwards.** The house rule here (ADR
  0022 §4) is membership first: a request must name something the panel already listed, not an
  arbitrary path the server then tries to prove safe.
- **A real-path check per file during the listing walk**, rather than per folder. Correct, but far
  costlier over a slow share, for a property the byte route already re-checks at the moment it
  matters.
- **Server-side thumbnails.** Generating them needs an image-decoding library, which is a new runtime
  dependency this slice doesn't take on.
- **Following links and junctions found during the walk.** Rejected outright: a link inside the
  folder could point anywhere, and the folder's own contents are supposed to be exactly what you put
  there yourself.
- **Hiding excluded pictures instead of flagging them.** Silence reads as "nothing is there"; a
  visible, greyed, explained entry is more honest about what the folder actually contains.

## 7. Will catch

- A request naming a file the last listing didn't produce, however it's spelled, `../`, an encoded
  separator, a drive or UNC-style path, or simply a real but never-listed file.
- A listed file swapped out from under the panel for a link pointing outside the folder, at a sibling
  folder, or at an unrelated file inside the vault, between the listing and the request for its bytes.
- The folder itself swapped for a link pointing at the vault root or elsewhere, after it was already
  listed once.
- A link or a dot-prefixed folder anywhere in the walk.
- A picture over the size cap, even if it was already listed.

## 8. Will not catch, deliberately

- The gap between the byte route's own safety check and the moment it actually reads the file,
  the same residual ADR 0022 section 6 already states for the panel's other read paths.
- A hard link standing in for the real file; only symbolic links and junctions are checked for.
- A cloud-sync placeholder file that Windows reports as something other than a plain symbolic link is
  not specifically detected as one.
- A picture a build would refuse for some other reason (wrong extension once you look at where a link
  really leads, say) is not caught by the listing itself; the save-time check still catches it.
- A full-size picture is sent back exactly as large as it is on disk; nothing here resizes it for a
  thumbnail.
- The list is a snapshot from the moment you asked for it, until you ask again ("Look again" in the
  panel).
- An oversized picture still appears in the list; only its thumbnail fails to load.
- The walk reads the folder synchronously, so a very large or slow (e.g. network) folder pauses the
  panel while it's read.

## 9. Evidence

`src/admin/vaultart.js`, `src/admin/handlers/images.js`, `src/admin/router.js`,
`src/build/themeassets.js` (`planThemeAssets`, `isInsideReal`), `src/vault/exclusions.js`
(`excludedDirUnion`, `excludedDirHit`, `excludedSegmentHit`), the generator's own
`node_modules/gm-apprentice-publish/lib/scanner.js:248-250` (`attachmentsDir || '_attachments'`), and
`test/admin-vault-art.test.js`, `test/admin-v1e5-model.test.js`.
