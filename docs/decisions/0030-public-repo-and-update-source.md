# 0030. The public repository becomes the update source

## Summary

GM-Scriptorium's `update` command now looks for releases at the public repository instead of the
old private one, and the two files it downloads are named `gm-scriptorium-win-x64.exe` and
`gm-scriptorium-linux-x64`. Anyone already running an install still updates cleanly: a bridge
release, published under the old names at the old repository, carries every existing install
across before it ever needs to know the new repository exists. `update` still shells out to `gh`,
and still requires it installed and signed in, because making the repository public changes who
is allowed to read it, not how this tool talks to GitHub. We rejected transferring the old
repository in place of a fresh one, mirroring releases across two repositories, letting an
environment variable redirect the update source, and renaming the notices file's own header; each
would have made an existing install's update path harder to reason about, or broken a safety
check this tool already relied on.

Status: accepted.

## Decision

**The update source.** `src/update/release.js`'s `REPO` constant now names the public repository.
Every `gh` call that names a repository, the metadata lookup and the asset downloads alike,
already read this one constant, so nothing else needed to change for the update source to move.

**The release assets.** The two binaries `npm run package` writes are now named
`gm-scriptorium-win-x64.exe` and `gm-scriptorium-linux-x64`. The combined `SHA256SUMS` file looks
assets up by filename, so its entries use the same new names, and `update`'s download side asks
`gh` for an asset by the same name it will later look up in that file.

**User-facing text.** The CLI's `--help` banner, and the handful of places it tells a user what to
run next, now say "gm-scriptorium" rather than "scriptorium". A site a user builds now credits
"GM-Scriptorium" in its footer notice, linking the public repository; that is the only line a
built site's own output changes.

**What stays exactly as it was.** Environment variables, config directories, CSS class names and
the data attributes a built site's own JavaScript reads, the admin panel's cookie name, and the
package name used to install this tool (`bin`) all keep their existing internal names. An old
binary, a user's existing config file, and a site someone has already published all still depend
on these unchanged, and none of them is something a user ever reads as the product's name.

**The notices-file header stays frozen.** The file a binary writes beside itself,
`THIRD-PARTY-NOTICES.txt`, still opens with the literal header "Scriptorium: Third-Party Notices"
and a "Scriptorium version: " line. `update` deletes a stale copy of this file left behind by the
version it is replacing, and it recognises that file only by this header. Renaming the header
alongside everything else would have broken that recognition for every binary already in the
wild: a newer binary could no longer tell a genuine (but old-worded) notices file from some
unrelated file that happens to share a name, so it would have to stop clearing it at all. The
header is a cross-version contract, not a cosmetic choice, and a test proves it stays one: a
notices file generated fresh today is still recognised and discarded beside a scratch executable.

**Why `gh` authentication is still required.** ADR 0004 covers why `update` shells out to `gh` at
all rather than making its own HTTP requests. None of that reasoning depended on the repository
being private, so none of it changes here: `update` still needs to resolve a release tag and
download an asset, and `gh` is still how this tool reaches GitHub. Someone running `update`
without `gh` installed and signed in sees the same prerequisite error it always has.

**The bridge for existing installs.** Nothing currently installed points at the new repository,
and nothing currently installed asks for the new asset names. Before the public repository has
its own first release, the owner publishes the same release bytes under the OLD asset names, as
the current release, at the OLD repository, with a `SHA256SUMS` naming those old files. Every
existing install (whether it checks for the latest stable release or opts into prereleases)
updates once through that ordinary release, and comes out the other side running code whose own
`REPO` constant already points at the new, public repository. The bridge is not a separate code
path: it is one release, published somewhere an old install can still find it, built from the same
commit as the public repository's own first release.

## Rejected alternatives

**Transfer the existing repository and rely on GitHub's redirect.** GitHub redirects a
repository's web, git and API URLs after a transfer, but only for as long as nothing else claims
the old name afterwards, and an existing install's `update` would then depend on `gh` itself
following that redirect, which is not something to build a safety-relevant update path on without
ever having tested it. A fresh repository, cut from a single clean commit, means nothing about an
existing install's update path depends on a redirect holding forever.

**Mirror releases across both repositories.** Keeping two release histories in step forever means
the first time someone publishes a fix to only one of them, a gap opens between what a public
install and a private install are running. A one-time bridge release gets the same outcome without
an ongoing maintenance burden.

**Let the update source be overridden by an environment variable or a config value.** This would
give a config file, or anything able to set an environment variable, a new way to redirect what
code an install downloads and runs next, the same class of risk the existing gh-only design was
built to avoid. The update source stays a constant in source, not a setting.

**Rename the notices-file header to match the new product name.** This reads better cosmetically,
but it breaks the cross-version contract described above: a binary built after the rename could
never again recognise, and safely clear, a notices file an earlier binary had written. The header
stays exactly as it already was.

## Evidence

- `REPO`: `src/update/release.js`.
- Asset names: `src/cli/update.js`'s `assetPatternForPlatform`, `scripts/package.js`'s `TARGETS`
  and `defaultOutPathFor`'s fallback.
- The frozen notices header: `src/update/replace.js`'s `looksLikeScriptoriumNotices`,
  `scripts/generate-notices.js`'s `buildNoticesText`; the cross-version contract is proven by a
  test in `test/build-notice.test.js`.
- The frozen `tool.name` JSON field: `src/cli/check.js`, `src/cli/status.js`, `src/cli/build.js`.
- The `gh` authentication requirement: `src/update/gh.js`'s `requireGh` and `assertAuthenticated`.
- User-facing text: `bin/scriptorium.js`'s `HELP`, and the hints in `src/cli/status.js`,
  `src/config/resolve.js`, `src/cli/config.js` and `src/cli/serve.js`; the site credit in
  `src/build/notice.js`'s `buildNoticeText`.
- The argument-vector and 404-wording proof: `test/public-rename.test.js`.
- The Windows verification criterion for all of the above: `.agents/windows-verification.md`, C65.
