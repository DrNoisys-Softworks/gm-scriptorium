# 0060. A folder hidden only in vault-config.md is a warning, and the build judges hidden folders on the new site

## Summary

Hiding a folder in the admin panel's Hidden folders field writes it to `publish.exclude_dirs` in `_meta/vault-config.md` only, and `check` used to report that as an ERROR whenever the folder held pages or images, so every later build was refused until the GM edited `vault.config.json` by hand. It is now a WARN in every case, because a fresh build already leaves the folder out. The leak check for hidden folders in the built site, `leak/l2-excluded-dir-in-output`, now runs during `build` on the new site before it is published, instead of on the old site the build is about to replace, so hiding a folder you already published no longer blocks the build that removes it. The main rejected alternative was an ERROR only when the old site still holds the folder's files, which repeats what that leak check already does. The limit a GM will meet is that if a build fails part-way, the old site keeps the stale pages and that build did not say so; the next `check` does.

Status: accepted. Amends [ADR 0009](0009-output-leak-scan.md).

## 1. Hidden folders: a warning, never a refusal

The panel's Hidden folders field writes `publish.exclude_dirs` in `_meta/vault-config.md` and nothing else. `config/exclude-dirs-divergence` compares that list with `excludeDirs` in `vault.config.json`. A folder listed only in `_meta/vault-config.md` is now a WARN whether or not it holds pages or images. When it does, the message says so and `data.appliesInOutput` is `true`. A folder listed only in `vault.config.json` stays an INFO.

The ERROR was wrong for three reasons. The pinned generator scans the vault with both lists joined, so a fresh build already leaves the folder out. A build replaces the whole output folder, so building again is what removes a stale copy of the folder's pages. And the finding fired whenever the folder had content, whether or not any site had ever been built. Files from a hidden folder that really are in a built site are what `leak/l2-excluded-dir-in-output` reports.

## 2. The hidden-folder leak check judges the site about to be published

`build` runs `check` first, and that check used to judge the old site the build was about to replace. For the other output scans it already defers instead (ADR 0009, FR-16). `leak/l2-excluded-dir-in-output` had no deferral, so a GM who published a folder and then hid it got an ERROR for the old pages, and the build that would remove them was refused. The panel offers no override, so its previews were refused too.

Now:

- The pre-build check defers `leak/l2-excluded-dir-in-output` like the other output scans: one INFO that says the scan runs on this build's own staging tree.
- The staging scan (`scanStagingOutput` in `src/build/outputgate.js`) runs the same scan on the staging tree, with the same folder lists and the same always-excluded folders. A hit refuses the build with exit 2 and writes nothing, like a withheld name found there. The command line cannot override it (ADR 0055).
- Everything the staging scan checked before still runs, and the GM link marker and comment gates are unchanged.
- A standalone `check` still reports the scan as an ERROR against the real built site.
- Panel previews and theme preview copies use the same build code, so they behave the same way with no flag.

## 3. Rejected alternatives

- **An ERROR only when the old site still holds the folder's files.** It repeats what `leak/l2-excluded-dir-in-output` already reports, and it would still refuse the build that removes those files.
- **The panel also writes `excludeDirs` in `vault.config.json`.** That is a new write to a file where the panel otherwise writes only the site title, and a change to its write-scope tests, to silence a finding that only asks two lists to agree.
- **Keep the hidden-folder leak check judging the old site.** Hiding a published folder would still refuse every build and every panel preview until the GM deleted the output or used `--force-check`, which the panel does not offer.
- **A separate gate for this scan, outside the staging scan's `force` handling.** The command line already passes `force: false` (ADR 0055), so a separate gate adds no protection for a GM, and the maintainer scripts that deliberately build leaky test vaults rely on that override.

## 4. Limits

- If a build fails part-way, the old site keeps the stale pages, and that build printed no `leak/l2-excluded-dir-in-output` ERROR because the check was deferred. The next `check` shows it.
- A hit this scan reports is now found on the first build, before anything is published, rather than from the second build on.
- If `excludeDirs` or `publish.exclude_dirs` hides the whole attachments folder and the site uses a section banner or a campaign image, the build is refused. The scan reads every file under `images/` as if it came from the attachments folder, but the generator also copies banners and the campaign image there. Before this change the refusal came from the second build on and `--force-check` got past it; now it comes on the first build and no flag gets past it. Hide the attachments subfolders you mean instead of the whole folder.
- Saving Hidden folders in the panel while the published site still holds that folder's pages: the edited-copy check (ADR 0041) runs on the real site, so it reports the hidden-folder leak check as a new ERROR and the panel asks you to confirm the save. The next build clears it.
