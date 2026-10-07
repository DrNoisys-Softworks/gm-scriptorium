# 0011. Stamp the notices header with the version; `update` deletes the stale copy on success

Status: accepted (2026-09-18).

## Summary

The notices file that sits beside the executable now names the Scriptorium version it belongs to. When `update` replaces the executable, it deletes the old notices file, and the new program writes a fresh one the next time it runs. Having `update` write the new notices itself was rejected, because the program doing the update is still the old one and cannot vouch for the new release's contents. Having `check` write the file was rejected too, because `check` is read-only by design. After an update, the notices file briefly goes missing until the program next runs.

## The defect (Issue #26)

`deliverNotices()` (`src/util/notices.js`) writes `THIRD-PARTY-NOTICES.txt` next to the executable
whenever `--version` runs on a packaged binary, and `update` (`src/cli/update.js`) replaces the
executable itself on a successful run. Neither one told the other anything: after an `update`, the
notices file beside the exe kept describing the OLD version's dependency tree until the user happened
to run `--version` again. Nothing detected or reported the gap. The file itself carried no version
information at all, so there was no way to look at it and know whether it was current.

## The decisive fact

**The running old binary cannot produce the new binary's notices text.** At the moment `update`
replaces the executable, the process still executing is the OLD one. It only has its own embedded copy
of `THIRD-PARTY-NOTICES.txt` (via `pkg.assets`), which describes its own dependency tree, licence
texts, and generation timestamp, not the new release's. Any design where `update` writes fresh
notices content itself would therefore be writing something it cannot actually vouch for: at best a
stale copy relabelled, at worst silently wrong the day the dependency tree changes between releases.

## Decision

1. **Stamp the version.** `scripts/generate-notices.js`'s section-0 header gains a
   `Scriptorium version: <package.json version>` line, read fresh via `fs.readFileSync` +
   `JSON.parse` (consistent with how `LOCK_PATH` is already read, and for the same reason: avoiding
   the require cache). This makes a notices file beside a binary self-describing: its own version can
   be read directly, without needing the executable that shipped it.
2. **`update` deletes the stale copy on success.** After `replaceExecutable` returns
   (`src/cli/update.js`), before the success return, `discardNoticesBesideExecutable(exeDir)`
   (`src/update/replace.js`) best-effort deletes `THIRD-PARTY-NOTICES.txt` beside the exe, scoped to a
   file that actually looks like a Scriptorium-generated notices file (the section-0 title and the new
   version stamp), a same-named file without that content is left untouched, because a filename match
   alone is not sufficient authority to delete a file in the user's own program folder. The next
   `--version` on the new binary calls `deliverNotices()`, which already rewrites the file
   unconditionally when packaged; no code change was needed there.
3. **Deletion is confined to the success path.** On every failure path (prerequisite check,
   checksum mismatch, MZ-header check, `replaceExecutable` itself throwing), the OLD binary is still
   the one on disk, and its notices file, if present, is still an accurate description of it. Deleting
   it there would destroy correct information for no reason, the file would go from "accurate" to
   "absent" on a run that changed nothing about which binary is actually running.
4. **The success message says what happened.** So a user is never silently left wondering where the
   file went, `update`'s success message on the packaged path now names it: the old notices file was
   cleared, and `--version` (writes it) or `--notices` (prints it, no write) both recover it.

## Rejected

- **`update` writes the notices content itself.** Rejected outright by the decisive fact above: the
  process running `update` is the old binary, which does not have the new release's dependency-tree
  data. Anything it wrote would be a guess dressed as a fact.
- **Any command refreshes it, not just `--version`.** Considered making `check` or `build` also
  refresh the beside-exe notices file, on the theory that any command run after an update would repair
  the gap sooner. Rejected: `check` writes nothing to disk today (`docs/PROVENANCE.md`'s determinism
  requirements treat `check --json` as read-only, consumed by tooling), and a read-only working
  directory (a locked-down deployment, a read-only mount) is an explicitly supported state for it.
  Making `check` start writing a file as a side effect would break that guarantee for a notices-freshness
  concern that `--version`/`--notices` already solve without it.

## The release-procedure consequence

`scripts/notices-freshness.js:27` strips only the `Generated:` line before comparing the committed
file against what `scripts/generate-notices.js` would produce right now (`GENERATED_LINE_RE =
/^Generated: .*$/m`). That line is **unchanged by this decision**, the version line is a different
line and is deliberately part of the comparison, not stripped.

Because the version line is derived from `package.json`, the freshness gate stays green for the same
`package.json` version, exactly as before. But **the next version bump will fail `npm run package`
until `npm run notices` is re-run and the regenerated file is committed.** This is a feature, not
friction: it forces per-release regeneration, which is precisely the staleness class Issue #26 exists
to close. It is also a trap for whoever cuts the next release if it is not written down, so it is
recorded in three places: this ADR, `scripts/generate-notices.js`'s own file header, and
`README.md`'s "Third-party notices" section.

`scripts/notices-freshness.js`'s drift message (`:46-49`) was widened to mention a version bump as a
possible cause, alongside the dependency-tree explanation it already gave, without that, the message
would mislead the next release-cutter into re-checking `package-lock.json` for a drift that was
actually just the version stamp doing exactly what it was built to do.

## Consequence

- `scripts/generate-notices.js`: new `Scriptorium version: <version>` line in the section-0 header,
  read via `fs.readFileSync`/`JSON.parse` against `package.json`; file-header comment records the
  rationale and the release-procedure consequence.
- `THIRD-PARTY-NOTICES.txt` regenerated; differs from the previous commit only by the new version line
  and the `Generated:` timestamp.
- `scripts/notices-freshness.js`: drift message widened; `:27`'s `Generated:`-only strip is unchanged.
- `src/update/replace.js`: new `discardNoticesBesideExecutable(exeDir)`, never throws, scoped to a
  recognisably-Scriptorium file.
- `src/cli/update.js`: calls it on the success path only; success message extended.
- `README.md`'s "Third-party notices" section and this ADR both record the release-procedure trap.
