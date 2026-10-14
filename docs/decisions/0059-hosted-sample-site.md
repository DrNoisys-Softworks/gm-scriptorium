# 0059. The sample campaign is published to GitHub Pages, built only from the sample

## Summary

Anyone can now open the sample campaign, The Long Lease, as a real website before installing anything, on a computer or a phone. A separate workflow builds it from this repository's own code whenever the main branch changes and publishes it with GitHub Pages, together with one extra page, the leak demo, that shows a private GM note, the player page built from it, and the fact that the withheld name is on neither. The decision is that the workflow can only ever build one folder: every path lives as a constant inside one script, and neither the workflow nor the script takes a setting that could point it elsewhere. The main alternative, a general build-and-publish step with a configurable output folder, is rejected below because it would make "what gets published" depend on an input. The limit a reader will meet is that the "Third-party notices" link on the 404 page is a relative link, so it breaks when the missing address is nested below the site root.

Status: accepted. Builds on [ADR 0009](0009-output-leak-scan.md) and [ADR 0055](0055-force-split.md).

## 1. What is published, and the URL

The site is the build of `examples/the-long-lease`, plus `leak-demo.html` at the root. It is served at `https://drnoisys-softworks.github.io/gm-scriptorium/` and the demo is at `https://drnoisys-softworks.github.io/gm-scriptorium/leak-demo.html`. Nothing else in the repository is published, and no real campaign is ever built by this workflow.

## 2. The rails

- **Fixed paths.** `scripts/sample-site.js` holds the vault (`examples/the-long-lease`), the scratch folder (`.sample-site`), the staging folder (`_site`) and the site address as constants. It takes no arguments: one is refused with `SITE FAIL usage`. The workflow runs exactly `node scripts/sample-site.js`.
- **No inputs.** The workflow has no `inputs`, no `env`, no `vars`, no `secrets`, and no expression syntax anywhere. The deploy job's environment names `github-pages` and carries no `url`.
- **Triggers.** A push to `main`, and a manual run. There is no pull request trigger and no path filter, so a forked or draft change cannot publish anything.
- **Permissions.** The workflow-level grant is `contents: read`. Only the deploy job adds `pages: write` and `id-token: write`. The build job's checkout does not keep the token (`persist-credentials: false`), because the job never pushes.
- **Repo guard.** Both jobs run only in the public repository, as the existing CI jobs do.
- **Pinned actions.** Every action is pinned by commit SHA with a version comment. `actions/upload-pages-artifact` is v5.0.0 and `actions/deploy-pages` is v5.0.1. The upload action's input is `path`. The deploy action needs no input and only the two permissions above. The upload action excludes dotfiles by default (`include-hidden-files` is false), so the `.nojekyll` file the generator writes is not uploaded. That is harmless, because a deploy from Actions does not run Jekyll.
- **Concurrency and time.** One run at a time in the group `pages`, never cancelled part-way (`cancel-in-progress: false`), so a deploy is not cut off. The build job is limited to 15 minutes and the deploy job to 10.
- **Pins.** `test/pages-workflow.test.js` pins each of these on the text of the file, and each pin is shown to fail on a loosened copy.

## 3. The gates

The script stops at the first failure, prints `SITE FAIL <step> <reason>`, exits 1, and the upload step never runs. In order:

1. **Generator check.** `npm run verify-generator` runs before the script, as in the existing CI.
2. **Build.** The real command line builds the sample. Its own pre-build check refuses on any error, and its output-leak scan ([ADR 0009](0009-output-leak-scan.md)) runs with no override ([ADR 0055](0055-force-split.md)). The script passes none of the force flags.
3. **Check.** `check --json` runs again over the built output. It fails on a leak finding even if the exit code is 0, then on the exit code, then on any error count. The result is judged on the findings, not on the exit code alone.
4. **Stage.** The checked output is copied to `_site` and the two trees are compared file by file. The note on the `SITE stage` line carries the number of files compared. A copy that differs in one byte, one extra file or one missing file fails with `tree-differs`.
5. **Demo.** The leak demo is written into `_site` only, never into the checked tree, and the write refuses to overwrite.
6. **Final sweep.** Every file in `_site` except the demo is searched for each word of the withheld name, in any case, and for the text of the GM note. The demo must hold the full name. A hit fails with `name-in-site <path>` or `gm-text-in-site <path>`.

## 4. The leak demo

`scripts/leak-demo.js` generates the page from the sample's own files each time, so it cannot go stale. It only reads. The withheld name is not written in either script. It is the one entry under "Excluded" in the vault's publish manifest, confirmed by that page's own `withheld: true` flag. The page shows the GM Notes section of `Locations/Summerhythe.md` word for word, the player page built from the same file with its probe sentence, and a statement that the name and the GM Notes text were on neither that page nor any other player page when the site was built.

The generator refuses to produce a page when any premise fails. The reasons are a closed set: `no-withheld-entry`, `several-withheld-entries`, `withheld-flag-missing`, `section-not-excluded`, `excerpt-not-found`, `excerpt-missing-name`, `probe-not-in-source`, `player-page-missing`, `player-page-mismatch`, `player-page-has-name` and `player-page-has-gm-text`. Page text is compared with tags removed, entities decoded and whitespace collapsed, so wrapped or escaped copies of the note are still found.

What it proves: at build time, one named player page and every other file in the site hold neither the name nor the note's text. What it does not prove: that no alias or paraphrase of the name appears, or that a page was not changed after the build.

## 5. The 404 page under /gm-scriptorium/

GitHub Pages serves a project site below `/gm-scriptorium/`, and the generator builds every link on the 404 page from the site address in the pack's `vault.config.json`. With no address, they point at `/`, and a missing page would show an unstyled page with dead links.

The script therefore copies the tracked pack to `.sample-site/pack` and adds the address to the copy only. The tracked sample is read in place and never written, so the sample's own guard that it has no site address, and the local `serve` 404 page, stay as they are. The script refuses (`pack-has-siteUrl`) if the tracked pack already carries an address. Building the tracked sample plainly and building it with the copied pack gave trees that differ in one file, `404.html`.

- **Custom domain.** If the owner sets one, the constant in `scripts/sample-site.js` changes to the new root in a reviewed commit. There is no setting for it.
- **Colour-mode key.** When a theme has two palettes, the generator names the stored colour-mode choice after the site address, so the hosted site would use a different key from a local build. The sample's theme did not produce that difference in the comparison above. It affects only the hosted copy and does no harm.
- **The notices link.** The footer link to `NOTICE.txt` is relative. On the 404 page it is written for the site root, so it breaks for a missing address that is nested below the root. Fixing it means changing `src/build/notice.js`, which would change every user's 404 page, so it is left out of this change and recorded as a follow-up.

## 6. Rejected alternatives

- **A general or configurable output folder.** One input would be enough to publish the wrong folder. A fixed path cannot be misconfigured.
- **A committed `docs/` folder or a `gh-pages` branch.** The site would be a stored copy of build output, which can drift from the code that makes it.
- **A committed demo page.** It would go stale the first time the sample's text changed.
- **A site address in the tracked sample.** It would break the sample's own tests and the local 404 page.
- **Editing `404.html` after the build.** The published tree would no longer be the checked one.
- **Paths built in the workflow file from the runner's environment.** That puts an environment-derived path back in play. The script anchors its paths to its own location instead.

## 7. Limits

Will catch:

- A build or check failure on the sample, including any output-leak hit, with nothing uploaded and the previous site left up.
- A staged copy that differs from the checked tree.
- The withheld name, in any case and any word of it, or the GM note's text, in any published file other than the demo.
- A change to the workflow's triggers, permissions, pins, guards or run line, through the pinning test.

Will not catch, deliberately:

- A paraphrase or alias of the withheld name. Name matching follows [ADR 0009](0009-output-leak-scan.md), "What D2 will and will not catch", and the demo follows one page only.
- A live deploy problem, a Pages setting, or a custom domain. Those are checked by looking at the live site.
- How the pages look on a phone. That is looked at by hand.
- A nested missing address showing a working notices link (section 5).
