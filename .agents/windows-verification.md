# Windows-only verification runbook

This is an agent runbook, public like everything in `.agents/`. It is for the assistant that
verifies a release on a Windows machine, through whatever channel the owner provides. Everything
below cannot be signed off from a Linux box.

Read `docs/decisions/0001-packager.md` and `docs/PROVENANCE.md` before starting; this document
assumes you have them. Criterion numbers (C1, C2 and so on) are stable: other documents cite them.
Where a criterion says `scriptorium-win-x64.exe` or `scriptorium-linux-x64`, it means the released
`gm-scriptorium-win-x64.exe` or `gm-scriptorium-linux-x64` asset (the criteria predate the rename).

**Do not read a real leak finding as a broken tool.** `check` on a real, uncurated campaign vault is
expected to report leak ERRORs, and `build` is expected to correctly refuse to build as a result. That


is the tool working, not a defect. If `check`/`build` come back clean on a real, uncurated vault,
something changed underneath you and that is the surprising result, not the reverse.

## How to build the exe from this box

```
cd ~/dev/scriptorium
npm install
npm run package
```

`npm run package` (`scripts/package.js`) writes `dist/v<version>/gm-scriptorium-win-x64.exe` AND
`dist/v<version>/gm-scriptorium-linux-x64`, plus one combined `dist/v<version>/SHA256SUMS` covering
both binaries and the notices file, in the format `src/update/verify.js` expects. **Use
`npm run package`, not a raw `pkg` invocation.** The script's input is `package.json` itself, not
`bin/scriptorium.js`: that is what makes pkg actually read `package.json`'s own `pkg.assets` field
(`docs/decisions/0005-generator-pin.md`'s "Packaging findings resolved" section). The v0.1.0 and
v0.1.1 releases used the raw `bin/scriptorium.js` invocation and shipped exes that silently dropped
every theme CSS file, every non-`require()`'d client JS file, and the whole `templates-scaffold/`
tree. The script also gates the build: it captures pkg's `--debug` output, and unless every expected
asset is confirmed embedded it removes the output and exits 1 rather than shipping a broken exe.

The expected set is the generator's CSS, JavaScript and scaffold templates, `lunr.js`, the repo's
own first-party site and admin assets, and the repo's root-level `THIRD-PARTY-NOTICES.txt`.
`scripts/pkg-assets.js`'s `expectedAssets()` lists it in full; `.agents/bookkeeping.md` records
the current count. The generator-tree list was first parsed from a real `--debug` build
(`spike/manifests/pin-5779522/win-x64-assets.txt`, retained in the private archive at b5b48b4).
The same asset set is embedded in both targets, with no network access beyond the initial
`npm install`.

The embedded Node.js version for this target is `v22.23.2` (confirmed via
`@yao-pkg/pkg-fetch`'s `satisfyingNodeVersion('22')`, and matches the phase 0 spike binary's own
`process.version` at runtime). `docs/PROVENANCE.md` and `THIRD-PARTY-NOTICES.txt` are generated against
that version; if a fresh build reports a different one, re-run `npm run notices` after updating
`scripts/generate-notices.js`'s `EMBEDDED_NODE_VERSION` constant and re-vendoring
`scripts/vendor/node-v<version>-LICENSE.txt` from `https://raw.githubusercontent.com/nodejs/node/v<version>/LICENSE`.

## Checkout line endings (CRLF) — read before any hash-against-checkout step

`git config core.autocrlf` is `true` by default on Windows, so a plain `git clone` gives a CRLF
working tree while every embedded asset in the exe was packaged from an LF source tree. Any step
below that compares a served or built file's bytes against the same file in a checkout — C32
step 2, C37 step 4, C40 step 1 — fails on raw bytes for this reason alone and is not a defect.
Found by the Windows verifier on rc.2, 2026-09-29: `assets/site/scriptorium.js` served/built at
`0EF4A60172BD7F4A028FE3EDE6C4924D913961BE22DB9FB3C34368A0A08A712C` against the repo's own
`8AA40DD760C5BC0C07FE79BBA73259DC13F0ED66863B2FB93CFFC56882DAB105` — different raw, identical once
line endings are normalised.

Either clone with line endings disabled up front:

```
git -c core.autocrlf=false clone <repo-url>
```

or, on an existing CRLF checkout, normalise before hashing (PowerShell):

```
(Get-Content -Raw <path>) -replace "`r`n", "`n" | Set-Content -NoNewline -Encoding utf8 <path>.lf
certutil -hashfile <path>.lf SHA256
```

Each of the three affected steps below says to compare "normalised."

## Exit-code table (frozen, `src/util/exitcodes.js`)

| Code | Name | Meaning |
|---|---|---|
| 0 | OK | Clean, or warnings only |
| 1 | SCRIPTORIUM_ERROR | Scriptorium itself failed (a bug), not a finding about the vault |
| 2 | CHECK_FAILED | One or more ERROR-severity findings; check refused, or build refused and wrote nothing |
| 3 | VAULT_UNREACHABLE | Vault path missing, or reachable but not a vault |
| 4 | UPDATE_PREREQUISITE | `gh` absent/unauthenticated, or a 404 from the release lookup indistinguishable from "no release" |

## Criteria to verify

### C1: the .exe runs on a machine with no Node installed

**Read `docs/decisions/0005-generator-pin.md`'s "Packaging findings resolved (DEP-a2)" section before
starting this one.** Two real, reproducible problems were found and are now believed fixed (Linux-side
proof only; this is exactly what C1 confirms on Windows):

1. **The published `v0.1.0` and `v0.1.1` releases are broken for `build`/`serve --build`.** Both were
   packaged with the OLD invocation (`pkg ... bin/scriptorium.js`, no `-c`), which silently never reads
   `package.json`'s `pkg.assets` field at all — confirmed by running the exact release commit's
   packaging command and the released exes themselves
   (`spike/manifests/pin-5779522/release-v0.1.x-verification.txt`, retained in the private archive at b5b48b4). **If you are testing an installed
   `v0.1.0`/`v0.1.1` exe (e.g. via C22-C25's `update` flow), `build` and `serve --build` are EXPECTED to
   fail** with a missing-asset error naming `css/themes/<genre>.css` or a client JS file — that is the
   known, already-diagnosed defect, not a new bug. `check`, `status`, `config` and `update` don't read
   generator assets and stay valid to test on those releases.
2. **A fresh build off `main` (`npm run package`) fixes both findings**: `scripts/package.js` now uses
   `package.json` itself as pkg's input (so `pkg.assets` is actually read) and always installs a
   small-icu-safe `Intl.Segmenter` shim (`src/generator/intl-shim.js`) before calling the generator, so
   `Intl.Segmenter`-dependent code (grapheme counting, graph-label truncation) no longer risks pkg's own
   `RangeError`/SIGSEGV path on `small-icu` base binaries. Both are proven only on Linux so far
   (`spike/manifests/pin-5779522/manifest-pkg-linux.txt` and `selftest-pkg-linux.json`, both retained in the private archive at b5b48b4); this is the
   Windows confirmation.

- Copy `dist/v<version>/scriptorium-win-x64.exe` (built via `npm run package`, **not** a `v0.1.x`
  release exe) to a Windows machine with **no Node.js installed** (or one where `node` is deliberately
  removed from PATH for the test).
- Run `scriptorium-win-x64.exe --version` and `--help`.
- Run `check`, `build`, `status`, `config list`, `serve --build` (with a real or fixture vault) and
  confirm each produces the same shape of output as running `node bin/scriptorium.js <command>` does on
  this Linux box against the same vault.
- If any command fails with an error naming a missing CSS/JS/template file, or crashes citing
  `Intl.Segmenter`, that means one of DEP-a2's two fixes did not hold on Windows — report the exact
  error/stack, since Linux's own proof predicted (not just hoped) both are closed.
- **Grapheme/Unicode check, with the committed manifest as ground truth.** Build
  `test/fixtures/grapheme-vault` with the exe:

  ```
  scriptorium-win-x64.exe config add grapheme-check --vault <path to a copy of test\fixtures\grapheme-vault> --site-config <path to a copy of test\fixtures\grapheme-vault-site-config.json> --out <out-dir> --config <config>.toml
  scriptorium-win-x64.exe build grapheme-check --force --config <config>.toml
  ```

  then hash every file (PowerShell: `Get-ChildItem -Recurse -File <out-dir> | Get-FileHash -Algorithm
  SHA256 | Sort-Object Path`) and diff against the C1 manifest for this pin, delivered over
  the Windows verification channel: `c1-manifest-node.txt` (the Linux plain-node reference). **Stale as of the `publish-v1.11.44` repin (2026-10-01), again at `publish-v1.12.0` (2026-10-02), at `publish-v1.12.3` (2026-10-03) and again at `publish-v1.14.0` (2026-10-06), not yet regenerated (OPEN):** the pin's own `css/style.css` changed at the first two and is copied into every built site, at `publish-v1.12.3` the pin's page templates and link reading changed, and at `publish-v1.14.0` the pin's grouped Story toggle, the D&D sheet templates and `css/style.css` changed, so the manifest below no longer matches a build at the current pin. Regenerate it on the Linux build host before using this criterion. **Regenerated at `publish-v1.11.40`
  (R1 repin, 2026-09-30)** — node and pkg-linux agree exactly (42/42 files, identical hash sets; this count predates the later repins, and the current manifest has 44 files),
  proven with:

  ```
  node -e "require('./src/build/run').runAtomicBuild({ vaultPath, userJsonConfig, finalOut, siteDir, campaign, force: true })"
  # against test/fixtures/grapheme-vault + its site-config, for the node-side manifest;
  ./dist/v<version>/scriptorium-linux-x64 build <campaign> --force --config <config>.toml
  # against the same vault/site-config, for the pkg-linux-side manifest; then
  find <out-dir> -type f | sort | xargs sha256sum   # both sides, compare hash sets
  ```

  This is still only the Linux-side leg — the still-open half of C1 is confirming the SAME manifest
  against the real win-x64 exe. **Verified on Windows (2026-10-07, rc.4, Windows 11 test VM): the manifest for the build under test has 44
  files, and all 44 file hashes from the win-x64 exe match it. The ICU rendering check passed on the
  three NPC titles, and the filename-slugify check built `González.md` to `gonzalez.html`.** A match confirms
  the shim's grapheme splitting and the fixture's decomposed-accent, emoji-ZWJ and Hangul titles all
  round-trip identically on Windows; a mismatch, or any file present on Linux but missing on Windows,
  is a STOP-worthy Windows-specific divergence — report it with the exact diff.
- **ICU check (0005, `lib/unicode.js:75` constructs `Intl.Segmenter` at module load).** The grapheme
  fixture's filenames are deliberately plain ASCII (only the frontmatter `title` carries the decomposed
  accent, the emoji ZWJ sequence and the Hangul text — `git checkout` never has to round-trip exotic
  bytes through a Windows filesystem), so this is a rendering check, not a slug/filename check: open
  `characters/npcs/decomposed-accent-npc.html`, `emoji-zwj-npc.html` and `hangul-npc.html` in the built
  output and confirm each renders its full title correctly (`José María Álvarez Delgado`, the detective
  emoji sequence, the Hangul text) AND its Connections lane (`section[data-scriptorium-connections]`)
  names the other NPCs in full, with no `…`. The Connections lane replaced the pin's relationship-graph
  SVG on every page (`docs/decisions/0017-story-timeline-and-connections-lane.md`), so no SVG graph label exists to truncate.
  The `Intl.Segmenter` truncation itself is covered only by the C1 manifest parity above.
  `spike/manifests/pin-5779522/selftest-node.json`, retained in the private archive at b5b48b4, is the Linux-side reference for the underlying
  ICU/NFD/Intl.Segmenter probes; there is no pkg-linux-vs-pkg-win selftest comparison here, since the
  pkg-win binary cannot run on this Linux box.
- **Filename-slugify check, restored (DEP correction, 2026-09-16).** The grapheme-vault check above
  only exercises frontmatter `title` through the rendering path (its own
  filenames are deliberately plain ASCII, precisely because it is `git checkout`'d). That is a
  different code path from `slugify(baseName)` (`gm-apprentice-publish/lib/scanner.js:7-22,135`),
  which derives a page's output filename from the vault file's own FILENAME, not its title. That path
  needs its own check, with a real non-ASCII filename:
  - Do not commit this fixture; create it directly on the Windows box, so no non-ASCII byte has to
    round-trip through a Windows `git checkout` of this repo. On the Windows machine, make a
    throwaway one-page vault directory containing a file literally named `González.md` (any minimal
    NPC-shaped frontmatter/body) plus a matching minimal site config.
  - Build it (`scriptorium-win-x64.exe config add ... --vault <throwaway dir> ...` then `build`) and
    confirm the output path is `gonzalez.html` (under whatever folder the vault's folder-map sends
    NPCs to), not an error, and not a path that still contains the accent.
  - `spike/manifests/pin-5779522/selftest-node.json`, retained in the private archive at b5b48b4, has the Linux-side `slugify('González')`
    reference (`'gonzalez'`). There is no pkg-linux-vs-pkg-win comparison here either, since pkg-win
    cannot run on this Linux box.

### C16: `serve` binds `127.0.0.1` only

Mechanism already verified on Linux (`docs/decisions/0002-serve-binds-localhost.md`): the server binds
literally to `127.0.0.1`/IPv4, confirmed via `server.address()`, and a request to that address succeeds
while the process is running. What Linux cannot confirm is Windows Firewall behaviour.

- Start `scriptorium serve <campaign>` on the Windows box.
- From a **second machine on the same LAN**, attempt to connect to the Windows box's LAN IP on the
  configured port (default 8080). This must fail (connection refused or timeout).
- From the Windows box itself, `http://127.0.0.1:8080/` must succeed.
- Note whether Windows Firewall prompts on first run, and whether a prior "allow" decision for an older
  Scriptorium version persists across an `update`.
- Repeat with `--host 0.0.0.0` and confirm the warning is **readable while the server is still running,
  before the first successful LAN connection** — not just that it "appears" somewhere in the console by
  the time the session ends. Reading it only after Ctrl-C passes vacuously and does not test the fix
  (issue #25: the warning used to be buffered until shutdown on every platform, not a Windows-specific or
  TTY-specific defect). Verify it two ways, since an interactive console can hide ordering an operator
  actually depends on:
  - With stdout redirected to a file (`scriptorium serve <campaign> --host 0.0.0.0 > out.log`), confirm
    the warning and the `serving ... (Ctrl-C to stop)` line are both already in `out.log` before
    attempting the LAN connection from the second machine, not only after Ctrl-C.
  - Under a supervisor (e.g. NSSM or a scheduled task capturing stdout to a file), confirm the same:
    both lines land in the captured log before the first successful LAN connection, without needing to
    stop the service first.
  - Then confirm the LAN connection succeeds (proving the default's protection is real, not incidental).

### C20: exit 3 taxonomy on Windows-specific paths

The two-message taxonomy (`src/vault/locate.js`: "not-found" vs "not-a-vault") is already verified with
contrived paths on Linux. What only Windows can add:

- Point a campaign's `vault` at an unmapped drive letter (e.g. `Z:\Scriptorium\campaign\vault` where
  `Z:` is not mapped in the current session). Confirm the message names the drive-letter possibility
  (`src/vault/locate.js`'s `isMappedDriveLetter` hint) rather than a generic "not found."
- Map the drive, then unmap it mid-session (or use a drive mapped in a different user session/service
  context, which is the actual production failure mode: "a mapped drive exists in an interactive
  session and not for a service or scheduled task," Requirements section 4.3) and confirm the same
  exit code and message.

### C22-C25: `update`, full path

These need a real GitHub release to exist. The repo is currently private, under the owner's own
GitHub account. Releases `v0.1.0` and `v0.1.1` exist (published by the
orchestrator) specifically for this test flow: install the `v0.1.0` exe from its release, then run
`update --check` and `update` against it to confirm it offers and applies the upgrade to `v0.1.1`.

- **C22**: `update --check` against a newer release reports the upgrade (old version, new tag, release
  notes URL) and changes nothing (confirm no file under the exe's directory changed, hash before/after).
- **C23**: `update` (no `--check`) actually upgrades. Confirm `--version` afterwards reports the new
  version, and confirm the rename-then-swap left a `scriptorium.exe.old-<oldversion>` file
  (`src/update/replace.js`), and that the **next** `update` invocation swept it away
  (`sweepOldExecutables`, called at the top of `runUpdateCommand` on every invocation).
- **C24**: deliberately corrupt a downloaded asset (truncate it, or swap in a different file with the
  same name before the checksum check runs) and confirm `update` fails cleanly, exit code 1, with the
  original binary intact and still runnable. Never confirm success without checking the OLD binary
  still executes correctly, not just that a new file did not appear.
  - **Issue #24 orphan check, class 1 and 2 (`src/update/replace.js`'s `sweepStaleUpdateDirs` /
    `sweepStaleStagedExecutables`, called from `runUpdateCommand` alongside `sweepOldExecutables`):**
    after the corrupted-asset failure above, confirm **no** directory matching
    `%TEMP%\scriptorium-update-*` and **no** file matching `scriptorium.exe-update-*.tmp` beside the
    exe remains. Verified on Linux via `test/update-cleanup.test.js`'s AC-24-01/AC-24-02 (a scratch
    `tmpRoot`/`execPath`, not the real filesystem locations); unverified whether a real Windows
    `EBUSY`/antivirus-lock during cleanup behaves the same as the simulated one AC-24-08 exercises.
  - **AC-24-11 `[WINDOWS-ONLY, OPEN]`, not attempted:** a real kill (Task Manager "End Task", or
    closing the terminal) of `update` mid-download should leave at most one orphaned temp dir and one
    orphaned staged `.tmp` file, and the **next** `update` run should remove both (owner-pid dead ->
    swept; see the header comment in `src/update/replace.js` for the pid-reuse and
    `os.tmpdir()`-differs-between-sessions residual limits this cannot close). Confirm nothing was
    swept while a second `update` is genuinely still running concurrently (start one, kill a second
    started moments later before it downloads, and confirm the first's temp dir survives) -- this is
    the concurrency guarantee (AC-24-04) and the one case a real repro could disprove that a simulated
    live-pid marker cannot.
- **Verified on Windows (2026-10-07, rc.4, Windows 11 test VM):** C22, C23, C24 and C25 passed against the rc.3 exe updating to
  rc.4. C23: the swept `.old-<version>` file is removed by the next `update` invocation, not by
  `--version`, which does not sweep. C24 was run by corrupting the download in flight, which is not a
  kill mid-download; AC-24-11 and AC-26-08 stay OPEN.
- **C25**: hash every file in the vault and in `out/` before and after an `update` run
  (`update` must never touch either). Exact command, run before and after, diff the two files:

  ```
  Get-ChildItem -Recurse -File <vault-path> | Get-FileHash -Algorithm SHA256 | Sort-Object Path | Out-File before-vault.txt
  Get-ChildItem -Recurse -File <out-path>   | Get-FileHash -Algorithm SHA256 | Sort-Object Path | Out-File before-out.txt
  # run update
  Get-ChildItem -Recurse -File <vault-path> | Get-FileHash -Algorithm SHA256 | Sort-Object Path | Out-File after-vault.txt
  Get-ChildItem -Recurse -File <out-path>   | Get-FileHash -Algorithm SHA256 | Sort-Object Path | Out-File after-out.txt
  Compare-Object (Get-Content before-vault.txt) (Get-Content after-vault.txt)
  Compare-Object (Get-Content before-out.txt) (Get-Content after-out.txt)
  ```

  Both `Compare-Object` calls must report no differences.
  - **Issue #26 notices check.** Before the C23 upgrade, confirm `THIRD-PARTY-NOTICES.txt` sits beside
    the v0.1.0 exe (run `scriptorium --version` once first if it does not) and note its
    `Scriptorium version:` line. After `update` succeeds, confirm that file is **gone**, and confirm the
    success message names `--version`/`--notices` as the way to get it back. Then run
    `scriptorium --version` once and confirm the file reappears with the NEW version's stamp. On the C24
    corrupted-asset failure, confirm the opposite: the pre-existing notices file (old version) is **still
    present and byte-unchanged** -- the old binary is still the one on disk and its notices file is still
    accurate for it (`docs/decisions/0011-notices-beside-the-executable.md`). Verified on Linux via
    `test/update-cleanup.test.js`'s AC-26-04/AC-26-05/AC-26-06 (scratch `exeDir`, not the real install
    location); unverified whether Windows Explorer or antivirus holding a handle on the notices file
    behaves the same as the simulated `EBUSY` AC-26-06 exercises.
  - **AC-26-08 `[WINDOWS-ONLY, OPEN]`, not attempted:** the same sequence above (old stamp -> gone after
    `update` -> new stamp after the next `--version`) run end-to-end on the real install, not a scratch
    directory, as the final confirmation that the mechanism holds outside the test harness.

### C26: confirmed on the wire, not only by inspection

`test/update-module-graph.test.js` already proves by static analysis that `src/update/` never imports
`src/vault/` or `src/build/`, and greps for a direct HTTP client (none found). What only a live capture
can add: run `update --check` under a network trace (Windows: `netsh trace start` or Wireshark/Fiddler
if available) and confirm every contacted host resolves to GitHub (`api.github.com`,
`github.com`, `objects.githubusercontent.com` for release asset downloads, `codeload.github.com` if
`gh` uses it internally). No other host should appear.

### C27: the product stylesheet is linked and the right shape, in the real win-x64 exe's output

`docs/decisions/0012-product-stylesheet.md`: every site built with the packaged exe should carry
`css/scriptorium.css` and a `<link rel="stylesheet" href="…scriptorium.css" data-scriptorium-housestyle>`
on every page, positioned after the pin's own stylesheets and before `css/overrides.css` (or, on a site
with no `overrides.css`, after `theme.css` and before any page-local `<style>` block, as on `404.html`).
This is verified on Linux against a `node22-linux-x64` build (`docs/decisions/0012...`'s AC-19: the
shipped file byte-identical to the repo's `assets/site/scriptorium.css`), which proves the packaging
pipeline but nothing win-x64-specific. **Re-verify on Windows against the real `scriptorium-win-x64.exe`:**

1. Run `scriptorium-win-x64.exe build <campaign> --out <scratch-dir> --config <config>.toml` against a
   real or test vault.
2. Confirm `<scratch-dir>\css\scriptorium.css` exists and open it — it should read as the product
   stylesheet's five sections (Focus and motion, Layout and overflow, Relationship graph, Tap targets,
   Inline-style overrides), not campaign content.
3. Open a built page's HTML source (e.g. `index.html` and `404.html`) and confirm the
   `data-scriptorium-housestyle` link appears, in the position described above.
4. If the campaign in use has its own `css/overrides.css`, confirm in a real browser
   (`document.styleSheets`, or just visually) that a rule in `overrides.css` still wins over anything the
   product stylesheet sets for the same property — the whole point of the cascade order.

### C28: a nested excluded heading stays excluded, in the real win-x64 exe's output

**Rewritten at `publish-v1.11.40` (R1 repin, 2026-09-30): this is now upstream's own fix, not a
Scriptorium patch.** `docs/decisions/0013-nested-section-exclusion-patch.md`'s "Retired" addendum
has the full by-hand confirmation: at commit `78696167`, `lib/processor.js`'s own
`filterSections` now guards the exclude-level assignment with `if (!excluding && ...)`, so a
heading nested inside an already-excluded one no longer re-anchors `excludeLevel` to the inner
level. `src/generator/sectionfilter.js` (the `require.cache`-seeding patch this criterion used to
be about) is deleted — **Scriptorium patches nothing here now**; the packaged exe just needs to
run the pin's own unmodified `lib/processor.js`, the same as every other pinned module. This is
still worth confirming on Windows (a packaged snapshot is still a different artefact from source,
per this repo's first rule), but the failure mode it used to guard against (the `require.cache`
seed depending on `fs.readFileSync` of a `/snapshot/...` path) no longer exists.

1. In a scratch vault, give one page a section shaped like this, with `GM Notes` and `Needs` both in
   the campaign's `exclude_sections` (`GM Notes` is there by default anyway):

   ```markdown
   ## GM Notes
   Prep one.

   ### Needs
   A prep question.

   ### Rumours In Play
   NESTEDLEAKSENTINEL and a link to [[Some Other Page]].

   ## Public Bio
   Visible body.
   ```

2. `scriptorium-win-x64.exe build <campaign> --out <scratch-dir> --config <config>.toml --force`. `--force` is
   required: the fixture ships no `_meta/publish-manifest.md` and its `publish.mode` is `player`, so a plain
   `build` fails closed at exit 2 before ever reaching the patch under test (`test/section-filter-build.test.js`
   itself calls `runBuildCommand({ config, force: true })`, which is what this step now matches).
3. Confirm the built page's HTML carries `Public Bio` and its body (so the build really ran) and
   carries **neither** `Rumours In Play` nor `NESTEDLEAKSENTINEL`.
4. Search `<scratch-dir>\search-index.json` for `nestedleaksentinel` (it is lowercased there) and
   confirm no hit.
5. Open `Some Other Page`'s built HTML and confirm it has **no** "Mentioned In" entry pointing back at
   the page above — the wiki link lived only inside the excluded region.
6. If any of 3-5 fails, the patch is not taking effect inside the snapshot. Report it as a packaged-exe
   finding, not a source bug: the same fixture passes on Linux from source.

### C29: the Story split toggle (RETIRED at publish-v1.14.0)

`src/build/storynav.js` is deleted (`docs/decisions/0014-story-nav-split-toggle.md`'s addendum): upstream's
`publish-v1.12.4` renders the grouped Story toggle itself, as a `<button>` that only opens the menu, with
"Story so far" as the first entry. Nothing here for the Windows exe to prove beyond a smoke check: build a
vault with a Story section, open any page at desktop width, click the "Story" label, confirm the menu opens
and stays open and its first entry reads "Story so far". The Linux proof is `test/story-nav-pin.test.js`
(real build, real browser). **OPEN on Windows.**

### C30: the recap `<em>` transform (#38), in the real win-x64 exe's output

**Rewritten at `publish-v1.11.40` (R1 repin, 2026-09-30): upstream now renders the emphasis itself
(#269), and Scriptorium's own transform is deleted.** `src/build/recap-emphasis.js` (Engineering
Brief "Into the Haze home + recap emphasis", 2026-09-24) used to turn the landing recap's wrapping
`*...*` into `<em>...</em>` by hand; at `78696167` the pin's own `lib/templates/landing.js` calls
`extractRecapHtml` instead of the plain-text `extractRecap`, rendering the emphasis as real HTML at
the source. The module, its call site in `src/build/run.js`, and its unit test are all deleted.
Verified on Linux from source with a real build (`test/build-landing-recap.test.js`, a real build of
`test/fixtures/wrapup-vault`, mutation-proven: reverting the pin's own call to the plain-text
`extractRecap` makes the test fail), which per this repo's first rule still proves nothing about the
packaged artefact. **Mark this OPEN: Linux-verified from source only.**

1. `scriptorium-win-x64.exe build <campaign> --out <scratch-dir> --config <config>.toml`, against a
   vault whose latest session (or session Wrap-Up) has a recap paragraph with a `*...*`-wrapped word
   (a real campaign vault, or `test/fixtures/wrapup-vault` copied onto the Windows box —
   `test/fixtures/pin-vault` has no Sessions folder and never emits a recap at all).
2. Open the built `index.html` and confirm the recap's first element child is `<em>`, and its text
   content has no `*` anywhere.
3. Confirm the recap's `<br>` and the "Read full session" link still follow the `<em>` unchanged.

### Other Windows-only checks

- **Swap retry and rollback under a real lock.** Open a file inside the current build's output
  directory in an editor (or any process that holds a Windows file handle open), then run `build
  --force`. Confirm the retry/backoff (`src/build/swap.js`, 5 attempts, 100/200/400/800/1600ms) actually
  happens (observable as a multi-second pause before failure), and confirm the message on failure names
  both the locked path and that nothing was changed. Then close the editor and confirm a retry succeeds.
  Added 2026-09-18 in the same fix as the item below: the failure message now also names the *specific*
  locked file (`findLockedFile` in `src/build/swap.js`, a best-effort probe that walks the source tree
  and reports the first file it cannot open `r+`), not just which directory-level rename failed — proven
  on Linux with a simulated lock (`test/build-plan-swap.test.js`); **confirm on Windows that the named
  file matches the one actually held open in the editor.**
- **Track D2's refuse path: staging removal under a locked handle. RESOLVED 2026-09-18, re-verify on
  Windows.** The Windows verifier reproduced 5/5: `fs.rmSync(stagingRoot, ...)` threw `EBUSY` under a locked
  handle inside the staging tree, which crashed the refusal itself before the leak finding or the
  refusal message ever printed (exit 1 instead of 2 — recorded in the Windows verification
  channel). Fixed in `src/build/run.js`: the
  `fs.rmSync` call is now wrapped in try/catch, so reporting `refusedByScan: true` and the findings no
  longer depends on cleanup succeeding; a leftover staging tree from a failed cleanup is left in place
  (survivable — `sweepStaleSiblings` clears `.scriptorium-build-*` on the next build). Regression
  covered on Linux by simulating `fs.rmSync` throwing (`test/build-output-gate.test.js`), which is not
  a real file lock — **still needs a real repeat of the Windows verifier's repro on Windows** to confirm the fix
  holds against an actual locked handle, not just a simulated throw.
- **`gh` present but not on the running shell's PATH.** Install `gh` after opening a terminal (so the
  already-open shell's PATH does not include it), then run `scriptorium update --check` from that same
  shell. `src/update/gh.js`'s `discoverGh()` should still find it via the two hardcoded Windows install
  probes (`%ProgramFiles%\GitHub CLI\gh.exe`, `%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe`) rather than
  failing. Confirm which of the two paths (if either) matches the real install location on the owner's
  machine; if neither does, that is a real gap to report, not a test artefact.
- **Issue #21's three build-output-path defects. RESOLVED 2026-09-18, re-verify on Windows.** Found by
  the Windows verifier setting up a real-vault test.
  1. `build --out <path>` was already implemented (it is one of the global `--vault`/`--out`/
     `--site-config` diagnostic overrides in `src/cli/args.js`, plumbed through every command that
     resolves a campaign) but was never listed in `--help` or the README, which is what made it look
     missing. No code changed; `bin/scriptorium.js`'s `--help` text and `README.md` now list it.
     **Re-verify on Windows: `scriptorium-win-x64.exe build <campaign> --out <scratch-dir> --config
     <config>.toml` must redirect that one build without touching the registered campaign's own
     `output`** (`scriptorium config list` before and after should show the campaign's persisted `out=`
     unchanged).
  2. `build` now refuses (exit 2, writes nothing, overridable by `--force`) when the resolved output
     directory is the same one the campaign's site config names as its own `outputDir` — the case that
     made it possible to build straight into the real campaign vault's own frozen acceptance output
     directory, by registering the campaign with no override at all. **Re-verify on Windows against the
     real campaign vault: confirm a plain `build` refuses instead of writing there, and that
     `build --force` still proceeds and says so.**
  3. A campaign registered with no `site_config` now fails with one clean line
     (`campaign has no site_config configured`) and exit 3 (issue #108; was 1, now **OPEN** again), not a ten-frame stack trace. **Re-verify on
     Windows:** `scriptorium-win-x64.exe config add no-site-config-check --vault <any reachable
     dir>` (omit `--site-config`) then `check`/`build`/`status` against it should each print the one
     line and exit 3, no stack.

### C31: book leaves and page motion (Track B), in the real win-x64 exe's output

`docs/decisions/0016-book-leaves-and-page-motion.md`: `src/build/sessionbadges.js`,
`src/build/dates.js`, `src/build/accordions.js` and `src/build/pageturn.js` (Engineering Brief
"Book leaves + motion", 2026-09-24, plus AMENDMENT 1), wired into `src/build/run.js` between
`applyRecapEmphasis` and `scanStagingOutput`. The date transform's output depends on the build
machine's time zone (`dates.js` parses `Date.prototype.toString()`'s printed local time and offset,
which a Windows small-icu build may print differently or omit the trailing parenthetical for —
`DATE_TOSTRING_RE`'s own trailing group is optional for exactly this reason). Verified on Linux
from source only (`test/build-sessionbadges.test.js`, `test/build-dates.test.js`,
`test/build-accordions.test.js`, `test/build-pageturn.test.js`, `test/housestyle-bookleaves.test.js`,
`test/theme-haze.test.js`), which per this repo's first rule proves nothing about the
artefact. **Mark this OPEN: Linux-verified from source only.**

Build against a real campaign vault (or an equivalent scratch vault with a Sessions/Recaps
folder and at least one PC page with Background/Notes sections — `test/fixtures/pin-vault` has
neither).

1. `scriptorium-win-x64.exe build <campaign> --out <scratch-dir> --config <config>.toml`, in AEST
   (+1000 in September).
2. `findstr /s /m /r "GMT[+-][0-9][0-9][0-9][0-9]" *.html` in the out dir finds nothing.
3. The recap badges and `campaign/index.html`'s "Last Played" show the vault's authored dates in
   "D Month YYYY" form, never the day after or before. **Don't hardcode the expected dates here**:
   the live vault's date list grows over time (it grew by one entry between rc.2's two Windows
   verification passes on 2026-09-29 alone), so a
   literal date list in this document goes stale on its own schedule, not this repo's. Check
   instead against the vault's own `Sessions/`/`Recaps/` folder at run time: every date on every
   recap badge and on `campaign/index.html` must equal that source file's own authored date, and
   "Last Played" must equal the latest one among them.
4. Every `.html` has exactly one `data-scriptorium-pageturn`. Any published PC page with
   Background/Notes sections has two `class="accordion open"`. Any recap page has `data-field="status"`.
   Every leaf page has exactly one `<div class="vt-fx" aria-hidden="true"></div>` (AMENDMENT E-3),
   and `index.html`/`404.html` have none. **`events/index.html` is a deliberate exception, not a
   bug (rc.2 Windows follow-ups, 2026-09-29):** whenever a timeline exists, the pin's own
   `lib/build.js` writes it as a bare redirect stub straight to `campaign/timeline.html` (a
   `<meta http-equiv="refresh">`, no `<header class="top-nav">`, no `<main>`), because the
   timeline IS the events index once dated events exist. It correctly has zero `vt-fx`, the same
   bucket a 404 page is in — see the code comment above `transformPageTurn` in
   `src/build/pageturn.js` and its redirect-stub test in `test/build-pageturn.test.js`. The
   vault's four `Events/` leaf pages are unaffected and each still carry exactly one.
5. In Chromium, navigating between two leaf pages plays the fold (b2); a breadcrumb "up" click and
   browser Back both play it in reverse; going to/from the landing page plays A's ink-title morph
   instead, with no flap. Under emulated `prefers-reduced-motion: reduce`, every transition is a
   150ms crossfade with no transform/mask/filter and nothing moves.
6. Optional: repeat in a `cmd` with `set TZ=America/Los_Angeles`. If the exe ignores TZ, record
   that; it is not a failure.

### C32: story timeline and Connections lane, in the real win-x64 exe's output

`docs/decisions/0017-story-timeline-and-connections-lane.md`: `src/build/timeline.js`,
`src/build/connections.js`, `src/build/sitescript.js` (plus their shared helpers
`src/build/htmltext.js`/`src/build/recaps.js`), wired into `src/build/run.js` between
`applyAccordionOpen` and `applyPageTurn`. The one first-party asset both runtimes share,
`assets/site/scriptorium.js`, is a new entry in `scripts/pkg-assets.js`'s
`FIRST_PARTY_SITE_ASSETS` (33 → 34) — exactly the class of defect this repo's first rule exists
for: `npm run package`'s asset-embedding gate proves pkg's config-asset walker picked it up as a
*Linux* target build, and `npm test`/`npm run verify-generator` prove nothing about a packaged
Windows artefact at all. Verified on Linux from source only (`test/build-htmltext.test.js`,
`test/build-recaps.test.js`, `test/build-timeline.test.js`, `test/build-connections.test.js`,
`test/build-sitescript.test.js`, `test/site-runtime.test.js`, `test/housestyle-story.test.js`,
`test/theme-haze.test.js`, `test/build-story-e2e.test.js`). **Mark this OPEN: Linux-verified
from source only.**

Build against a real campaign vault (its `_Campaign/Timeline.md` must already carry the
Title/Kind/Weight/Place helper columns and a Learned anchors table — the vault curation this
brief's Lead doc calls for, a separate change to the vault itself, not to this repo).

1. `scriptorium-win-x64.exe build <campaign> --out <scratch-dir> --config <config>.toml`, with
   `SCRIPTORIUM_CONFIG` and `--config` isolated from the real `%APPDATA%\Scriptorium\config.toml`.
2. `<out>\js\scriptorium.js` exists, and `certutil -hashfile <out>\js\scriptorium.js SHA256` matches
   the repo asset's own SHA-256 (`certutil -hashfile assets\site\scriptorium.js SHA256`, compared
   by eye — no exe involved in computing the repo-side hash), **normalised** per "Checkout line
   endings (CRLF)" above: raw bytes will not match on a stock CRLF checkout, and that is not a defect.
3. `findstr /s /m "data-scriptorium-js" *.html` inside `<out>` lists only `campaign\timeline.html`
   plus every page that also carries `data-scriptorium-connections` — never every page in the site.
4. Serve `<out>` locally (e.g. `npx serve <out>` from a machine with Node, or any static file
   server) and open it in a browser:
   - `campaign/timeline.html` renders the ruler with 28 markers and no card open at rest (FR-T6's
     "no card open at rest" — the mock's own hard-coded at-rest selection is explicitly out).
   - any published NPC page renders a Connections lane in place of the old SVG.
   - DevTools' Network tab shows `scriptorium.js` returned 200, and the Console shows no errors.
   - any published PC page's `#journey` tab (the PC Journey tab, reached directly via the URL fragment)
     shows the Connections lane laid out correctly on first paint — not collapsed to zero width from
     rendering inside a tab that started hidden.

### C33: campaign pack resolution, in the real win-x64 exe

`docs/decisions/0018-campaign-pack.md`: `check`, `build` and `status` find a campaign's site inputs in this order:
the `site_config` key (or `--site-config`), then the `pack` key, then the convention directory
`<vault>\_meta\scriptorium\` holding `vault.config.json`. When `site_config` wins and a pack also exists, `check`
reports one `config/pack-shadowed` WARN and `build`/`status` print a `note:` line naming both paths. Pack files are
read through `src/vault/read.js`; `css/overrides.css` is still mirrored by `src/build/stage.js`. Verified on Linux
from source only (`test/pack-resolution.test.js`, `test/pack-shadowed.test.js`, the pack case in
`test/cli-site-output-collision.test.js`). **Mark this OPEN: Linux-verified from source only.**

Isolate config throughout: `SCRIPTORIUM_CONFIG` set to a scratch TOML, and the same path passed as `--config` on every
command. Record `certutil -hashfile %APPDATA%\Scriptorium\config.toml SHA256` before step 1 and after step 5; they must
match. Use a vault on a mapped drive letter that already carries `_meta\scriptorium\vault.config.json` and
`_meta\scriptorium\css\overrides.css`; nothing here writes into it. Output always goes to local scratch.

1. Convention: scratch TOML with the campaign's `vault` (drive-letter path) and a local scratch `output`, no
   `site_config`, no `pack`. `check <campaign> --json`: exit 0 or 2, never 1, and no `config/pack-shadowed` finding.
   `build <campaign> --no-check`: succeeds, and the SHA-256 of `<out>\css\overrides.css` equals that of
   `<vault>\_meta\scriptorium\css\overrides.css`.
2. Precedence: copy the legacy site dir's `vault.config.json` and `css\overrides.css` to local scratch, append a
   one-line CSS comment to the scratch `overrides.css` so its hash differs from the pack's, and add
   `site_config = '<scratch site>\vault.config.json'` to the TOML. `build --no-check`: `<out>\css\overrides.css` now
   hashes to the scratch legacy copy, not the pack's.
3. Shadow warning, same TOML: `check --json` has exactly one `config/pack-shadowed` WARN whose `data.siteConfigPath`
   and `data.packDir` are Windows paths (drive letter, backslashes) naming the scratch site config and
   `<vault>\_meta\scriptorium`; `status <campaign>` and the step 2 build output each print a `note:` line naming both.
4. Nothing found: point the TOML at a local scratch folder holding only `_meta\vault-config.md`, with no
   `site_config` and no `pack`. `check`: exit 3 (issue #108; was 1, **OPEN** again), exactly one stderr line naming `site_config`, `pack` and
   `<scratch vault>\_meta\scriptorium\vault.config.json`, no stack trace.
5. Re-hash `%APPDATA%\Scriptorium\config.toml`.

### C34: themes and image slots (pack.toml), in the real win-x64 exe

`docs/decisions/0019-themes-image-slots-and-asset-step.md`: `build` reads an optional `pack.toml` from the campaign's site
inputs, copies each `[images]` slot to `scriptorium\slots\<slot>.<ext>`, declares `--sc-img-<slot>` in
`css\scriptorium-theme.css`, and links that stylesheet on every page immediately after the `data-scriptorium-housestyle`
link, marked `data-scriptorium-theme`. `vault:` slot paths are checked by real path against the vault's real path, which on
Windows means a mapped drive letter or a UNC path, and excluded-folder names are matched case-insensitively on Windows.
Verified on Linux from source only (`test/theme-registry.test.js`, `test/theme-packtoml.test.js`,
`test/vault-exclusions.test.js`, `test/theme-assets.test.js`, `test/theme-style.test.js`, `test/theme-build.test.js`).
**Mark this OPEN: Linux-verified from source only.**

Isolate config throughout: `SCRIPTORIUM_CONFIG` set to a scratch TOML, and the same path passed as `--config` on every
command. Record `certutil -hashfile %APPDATA%\Scriptorium\config.toml SHA256` before step 1 and after step 6; they must
match. Use a vault on a mapped drive letter whose pack (`<vault>\_meta\scriptorium\`) carries `vault.config.json`,
`css\overrides.css` consuming `var(--sc-img-ground)`, and a `pack.toml` with `[images] ground = "vault:<path to an image
under the attachments folder>"`. Nothing here writes into that vault. Output always goes to local scratch.

1. Scratch TOML: the campaign's `vault` as a drive-letter path, a local scratch `output`, no `site_config`, no `pack`.
   `build <campaign> --no-check`: exit 0. A false containment refusal would instead exit 1 with one line naming
   `pack.toml` and "resolves outside the vault".
2. `<out>\scriptorium\slots\ground.<ext>` exists and its `certutil -hashfile ... SHA256` equals the vault source image's.
   `dir /s /b <out>\images` lists no file named `ground.*`.
3. `type <out>\css\scriptorium-theme.css` prints exactly three lines: `:root {`,
   `  --sc-img-ground: url("../scriptorium/slots/ground.<ext>");`, `}`. In `<out>`, `findstr /s /m
   "data-scriptorium-housestyle" *.html` and `findstr /s /m "data-scriptorium-theme" *.html` list the same files. In two
   of them (one nested, plus `404.html`) the theme link is the line immediately after the housestyle link.
4. `serve <campaign> --port <free port>` with the same TOML. In Edge or Chrome, `/scriptorium/slots/ground.<ext>` returns
   200 (DevTools Network). On a nested page and on `404.html`, in the Console,
   `getComputedStyle(document.documentElement).getPropertyValue('--sc-img-ground')` is
   `url("../scriptorium/slots/ground.<ext>")` on both (the declared value, not yet resolved to an absolute URL --
   custom properties are not URL-resolved by `getComputedStyle`). **Reworded 2026-09-29** (the Windows verifier found the
   original check assumed `overrides.css` consumes the variable on `html::before` specifically, but the setup only
   requires SOME selector to consume it; a fixture consuming it on `body` instead passed the mechanism but read
   `none` on `::before`). This step tests that the variable itself resolves correctly, not which selector reads it
   -- if the real campaign's own `overrides.css` uses `html::before`, additionally confirm
   `getComputedStyle(document.documentElement, '::before').backgroundImage` equals
   `url("http://127.0.0.1:<port>/scriptorium/slots/ground.<ext>")`, but a `none` there alone is not a failure.
   Firefox, if installed: the same Console check on one page.
5. UNC: point the scratch TOML's `vault` at the same folder by its UNC path (`\\<host>\<share>\...`) and build into a
   second scratch output: exit 0, and `fc /b` of the two `ground.<ext>` copies reports no differences.
6. Case-folded exclusion: in a local scratch folder (not the vault) create `vault\_meta\vault-config.md` (content
   `---`, `type: meta`, `---`), `vault\Secret\x.webp` (any bytes), and a pack `vault\_meta\scriptorium\` holding
   `vault.config.json` = `{"siteTitle":"Scratch","excludeDirs":["Secret"],"folderMap":{}}` and `pack.toml` =
   `[images]` / `ground = "vault:secret/x.webp"`. **`folderMap` must be present** (rc.2 Windows follow-ups,
   DEFECT 2, 2026-09-29): omitting it now refuses earlier, at config resolution, with `is missing required key
   folderMap` rather than reaching this step's own excluded-directory check at all. `build` against it: exit 3 (issue #108; was 1),
   exactly one line containing `excluded directory "Secret"`, no stack trace, and the scratch output folder was
   not created.
7. Re-hash `%APPDATA%\Scriptorium\config.toml`.

### C35: `init`, the first-run setup wizard, in the real win-x64 exe

`docs/decisions/0021-init-first-run-setup.md`: `init` asks for a campaign name, vault, output folder, site title and
theme, creates only the missing files of the campaign pack under `<vault>\_meta\scriptorium\` (never overwriting
one), and registers the campaign. Run with no arguments, no config file, and a console on stdin and stdout (a
double-click), the exe offers setup and waits for Enter before its window closes. The `vault.config.json` it writes
comes from the generator's scaffold template inside the exe. Verified on Linux from source only
(`test/init-e2e.test.js`, `test/init-flow.test.js`, `test/init-prompt.test.js`, `test/pack-write.test.js`,
`test/init-scaffold.test.js`, `test/init-args.test.js`). **Mark this OPEN: Linux-verified from source only.**

Never point any step at the real campaign vault or at anything under a mapped drive. Record `certutil -hashfile
%APPDATA%\Scriptorium\config.toml SHA256` before step 1 and after step 8; they must match. Work in a local scratch
folder whose path contains a space, below called S (for example `%TEMP%\gm scriptorium c35`; always type the expanded
path). Create a vault `S\My Vault\` holding `_meta\vault-config.md` (lines `---`, `type: meta`, `campaign: Scratch
Chronicle`, `---`), `_meta\publish-manifest.md` (lines `---`, `type: meta`, `---`, blank, `## Publishing`, blank,
`- [x] Characters/NPCs/Tess-Harrow.md`) and `Characters\NPCs\Tess-Harrow.md` (lines `---`, `type: npc`, `title: Tess
Harrow`, `---`, `A published page.`). Copy it to `S\Second Vault\`. Save `dir /s /b /a "S\My Vault"` to `S\before.txt`.

1. Interactive: in a console, `scriptorium-win-x64.exe init --config "S\config.toml"`. The first line names
   GM-Scriptorium. Answer `c35`; paste the vault path wrapped in double quotes (Explorer's "Copy as path"); Enter to
   accept the output default, which must read `S\c35-site`; Enter to accept the title default, which must read
   `Scratch Chronicle`; Enter for theme `gloam`; `y` to create; `y` to the first check. The check report prints and
   `echo %ERRORLEVEL%` is 0.
2. `S\My Vault\_meta\scriptorium\` holds exactly `css\` and `images\` (both empty), `pack.toml` and
   `vault.config.json`. `certutil -hashfile ... SHA256` gives `A9FD73776B017888C97A241A9F720B4C7FDF7D175EBA8CDAAD8FA8257DF1B9DA` and `ADDDCB5055B082A23E243E017E2D55114D11A8ADF612A9E1F2EC85A73E4A6BCA`, the bytes the Linux source writes for this title: the template came out of the exe
   snapshot unchanged, with no line-ending conversion. `dir /s /b /a "S\My Vault"` differs from `S\before.txt` only by
   lines under `_meta\scriptorium`.
3. `build c35 --config "S\config.toml"`: exit 0, and `S\c35-site\index.html` contains `Scratch Chronicle`.
4. Re-run: note `dir /T:W "S\My Vault\_meta\scriptorium"`, then
   `init --name c35 --vault "S\My Vault" --yes --config "S\config.toml"` (**`--vault` is required**:
   `--yes` needs both `--name` and `--vault`, or the exe exits 1 with
   `init --yes needs --name <name> and --vault <path>` — found missing here on rc.2, 2026-09-29;
   C36 step 6 already uses the full form): exit 0, a `left untouched:` line naming all four entries,
   and the same `dir /T:W` output and both hashes.
5. Abort: `init --config "S\config.toml"`, answer `c35b`, press Ctrl-C at the vault prompt: exactly one line
   `init aborted; nothing written`, exit 1, the console prompt returns at once, and `S\config.toml`'s hash is unchanged.
6. Exit codes: `init --name c35c --vault "S\Missing Vault" --yes --config "S\config.toml"` exits 3; `init --name c35c
   --vault "S\Second Vault" --out "S\Second Vault\site" --yes --config "S\config.toml"` exits 3 (issue #108; was 1) with one line
   `refusing to build inside the vault: ...`. Neither creates `S\Second Vault\_meta\scriptorium`.
7. Double-click: `setx SCRIPTORIUM_CONFIG "S\dblclick\config.toml"`, then double-click the exe in Explorer. The window
   offers setup; answer `n`: the help text prints and the window stays open on `Press Enter to close this window.`
   until Enter. Double-click again, answer `y`, and set up `S\Second Vault` as `c35d`: the window again stays open on
   that line. Then `reg delete HKCU\Environment /v SCRIPTORIUM_CONFIG /f`, and in a new console `echo
   %SCRIPTORIUM_CONFIG%` prints `%SCRIPTORIUM_CONFIG%` literally.
8. Re-hash `%APPDATA%\Scriptorium\config.toml`.

### C36: the built-in `haze` theme, in the real win-x64 exe

`docs/decisions/0023-haze-theme.md`:
- `theme = "haze"` makes `build` write `assets/themes/haze/theme.css` from the exe snapshot into
  `css\scriptorium-theme.css`.
- `init` offers `haze` next to `plain`.
- `check` reports `config/theme-scheme-mismatch` (INFO) when a dark theme meets a light palette.

Verified on Linux from source only (`test/theme-haze.test.js`, `test/theme-registry.test.js`,
`test/theme-scheme.test.js`, `test/package-config.test.js`), plus a Linux packaged build.
**Verified on Windows (2026-10-07, rc.4, Windows 11 test VM), except step 4's "dark hero" wording, which stays OPEN:** step 4's "dark hero" reads pale on the
mini-vault, whose palette is light (the same mismatch step 5 reports), so whether that wording suits a
dark-palette vault is a human judgement. Step 4 was run as a scripted fetch rather than DevTools.

Isolate config and scratch exactly as in C35. Never touch the real vault or a mapped drive. Hash
`%APPDATA%\Scriptorium\config.toml` before step 1 and after step 6.

1. Copy `test\fixtures\mini-vault` from a checkout of this release to `S\haze vault`.
2. `init --config "S\config.toml"`: name `c36`; vault `S\haze vault`; accept the output and title
   defaults. The theme prompt reads exactly `Theme (gloam, haze, plain) [gloam]: `; answer `haze`, `y` to
   create, `n` to the first check. `S\haze vault\_meta\scriptorium\pack.toml` is exactly
   `theme = "haze"`.
3. `build c36 --no-check --config "S\config.toml"`: exit `0`.
   `certutil -hashfile "S\c36-site\css\scriptorium-theme.css" SHA256` equals
   `7F8F53656AB5AE3E09CF1431793CE2949BB3E80C5A70C2EA6DD43DB298568FED` (re-measured on the Windows exe, 2026-10-07, rc.4, Windows 11 test VM). `findstr /s /m` for
   `data-scriptorium-housestyle` and for `data-scriptorium-theme` list the same files.
4. `serve c36 --port <free>` in Edge or Chrome: the landing page shows the full-bleed dark hero
   with the title set large, bottom-left. In DevTools, `scriptorium-theme.css` returns 200 and
   there are no `fonts.googleapis.com` or `fonts.gstatic.com` requests (haze self-hosts its fonts, issue #84; the five woff2 files load from `scriptorium/theme/fonts/`). After the font-sharing follow-up (fonts-share), haze no longer carries its own fonts/ or NOTICE.txt; its `theme.json` has `fontsFrom: "gloam"` and the five woff2 files load from the same `scriptorium/theme/fonts/` URLs, served from gloam's embedded copy in the exe. Step 4 must confirm the five woff2 files return 200 from a haze-only site (this is the case the share could break). Confirmed on the Windows exe (2026-10-07, rc.4, Windows 11 test VM): all five return 200 as `font/woff2` from a haze-only site.
5. `check c36 --json`: exactly one finding with id `config/theme-scheme-mismatch`, severity
   `info`, and `data` `{theme:"haze", scheme:"dark", paletteScheme:"light", background:"#e8f0f3"}`.
6. Plain is unaffected: in a second copy `S\plain vault`, `init --name c36p --vault "S\plain vault"
   --out "S\c36p-site" --theme plain --yes` (`--theme plain` is required now that `init`'s own
   default is `gloam`), then `build c36p --no-check`: exit `0`,
   `S\c36p-site\css\scriptorium-theme.css` doesn't exist, and `check --json` has no
   `config/theme-scheme-mismatch`.

Re-hash the config.

`<E1>` (exit `0`) and `<THEME_SHA256>` were derived from a Linux dry run of these exact steps at
this docs commit, using `test/fixtures/mini-vault` (it built to exit 0 under the scaffold config
without needing to fall back to `test/fixtures/pin-vault`) with `test/fixtures/mini-vault-site-
config.json`'s own JSON config: `theme = "haze"` in `pack.toml`, built via the packaged
`node22-linux-x64` binary (`scripts/package.js`), `--no-check`. The Windows exe is expected to
produce byte-identical `theme.css` content (same embedded snapshot bytes, `assets/themes/**/*` in
`pkg.assets` regardless of target platform); the Windows run on 2026-10-07, rc.4, Windows 11 test VM confirmed it.

### C37: labels and vocabulary (pack.toml [labels], [timeline], [recaps]), in the real win-x64 exe

`docs/decisions/0020-labels-and-vocabulary.md`: `pack.toml` may carry `[labels]`, `[timeline]` and `[recaps]`. They rename
labels the site emits, replace the timeline's kinds (each with a built-in glyph name or SVG path data), weight phrases and
column-header names, replace the session-token and segment-unit regular expressions, and change the recap heading the
learned items are read from. Everything is validated when `pack.toml` is read (regular expressions are compiled then), and a
label reaches a page's data island only when it differs from the default. Verified on Linux from source only
(`test/build-labels.test.js`, `test/build-vocab.test.js`, `test/site-runtime-vocab.test.js`, `test/build-vocab-e2e.test.js`).
**Mark this OPEN: Linux-verified from source only.**

Never point any step at a real campaign vault or at anything under a mapped drive. Isolate config throughout:
`SCRIPTORIUM_CONFIG` set to a scratch TOML and the same path passed as `--config` on every command. Record `certutil -hashfile
%APPDATA%\Scriptorium\config.toml SHA256` before step 1 and after step 7; they must match. Copy `test\fixtures\vocab-vault`
from a checkout of this repo to a local scratch folder S (for example `%TEMP%\gm-scriptorium-c37`).

1. Scratch TOML: campaign `vocab`, `vault = 'S\vocab-vault'`, `output = 'S\out'`, no `site_config`, no `pack`.
   `check vocab`: exit 0, and **no line with severity `ERROR`.** (Reworded 2026-09-29: six
   `census/unrecognised-type` WARNs are expected here, for `vocab-vault`'s own frontmatter types —
   `timeline`, `session`, `pc`, `npc`, `meta` — none of which is in the default recognised union.
   The same class of WARN appears against `nested-exclude-vault` (C28) and a fresh `init` scaffold
   (C35), so it is a property of the default recognised union, not specific to this fixture. Exit 0
   is still the assertion that matters; "no line containing `unrecognised`" was never accurate.)
2. `build vocab`: exit 0. The only `warning:` line names the unknown Kind `riddle`.
3. In PowerShell, `Select-String -SimpleMatch '"story_lens":"The tale"' S\out\chronicle\chronology.html` and
   `Select-String -SimpleMatch '"glyph":"M10 2 L18 18 L2 18 Z"' S\out\chronicle\chronology.html` each find one line, and
   `Select-String -SimpleMatch '"group_npc":"Folk"' S\out\people\*.html` finds at least one file.
4. `certutil -hashfile S\out\js\scriptorium.js SHA256` equals `certutil -hashfile assets\site\scriptorium.js SHA256` from
   the same checkout, **normalised** per "Checkout line endings (CRLF)" near the top of this document:
   raw bytes will not match on a stock CRLF checkout, and that is not a defect.
5. Serve `S\out` (`serve vocab --port <free port>` with the same TOML) and open it in Edge or Chrome:
   - `chronicle/chronology.html`: the legend reads Clash, Parley, Omen, Origin, Learned; the Omen marker is a triangle;
     the lens buttons read "The tale" and "What the crew found out"; a ruler segment reads "Night 3"; opening the
     "Dock Brawl" marker shows a card whose kind line is "A clash, a watershed" and whose meta line includes
     "Episode I, Episode 01". The Console shows no errors.
   - The NPC page under `people/` shows a Connections lane headed "Ties and threads".
6. Refusals, each a separate edit of `S\vocab-vault\_meta\scriptorium\pack.toml`, restoring it afterwards; `check vocab` each
   time: (a) `session_token = '\bEp(\d+'`: exit 3 (issue #108; was 1), exactly one stderr line containing
   `[timeline] session_token is not a valid regular expression`; (b) `session_token = '\bEp\d+\b'`: exit 3, one line
   containing `must have at least 1 capture group`; (c) in the `omen` kind, `glyph = '<path d="M0 0"/>'`: exit 3, one line
   containing `glyph must be one of`. No stack trace in any case.
7. Re-hash `%APPDATA%\Scriptorium\config.toml`.

### C38: v0.2.3 reads the new multi-entry `SHA256SUMS` with its OLD code; the new exe's `update --check` isn't refused

Phase 5a: `npm run package` now builds both
`scriptorium-win-x64.exe` and `scriptorium-linux-x64` and writes ONE `SHA256SUMS` covering both binaries plus
`THIRD-PARTY-NOTICES.txt` (three entries), where every release before this phase had exactly two (the exe and the
notices file). `src/update/verify.js`'s `parseSha256Sums()` itself was not changed by this phase -- P5a-FR10's
`test/update-verify.test.js` proves the existing, unmodified parser reads a synthetic three-entry file and finds the
Windows entry among the others. This criterion is the real-world half of that proof: the CURRENTLY INSTALLED v0.2.3
exe, built before this phase existed, must still find its own entry (by filename, ignoring the unfamiliar
`scriptorium-linux-x64` entry it has no case for) in a release built AFTER this phase, using v0.2.3's own unmodified
code -- and the resulting NEW exe (now running phase 5a's code, including the P5a-FR07 packaged-only guard) must not
have `update --check` refused on it. This can only be verified once a release actually built under phase 5a's
`npm run package` exists on GitHub. Verified on Linux from source only (the parser unit test above, plus
`test/update-packaged-guard.test.js` for the guard, both with injected dependencies rather than a real download or a
real pkg-built binary). **Steps 1 and 2 verified on Windows (2026-10-07, rc.4, Windows 11 test VM), against a real v0.2.3 exe and the
rc.4 release. Step 3 is verified in substance only: its expected exit code is stale, see below.**

Isolate config throughout: `SCRIPTORIUM_CONFIG` set to a scratch TOML, and the same path passed as `--config` on
every command. Never touch `%APPDATA%\Scriptorium\config.toml`. Use the v0.2.3 exe already installed from the last
release (do not rebuild it), and a real phase-5a-built release tag once one is published and promoted.

1. With the installed v0.2.3 exe, `update --check --pre --config <scratch>`: exit 0, reports an update is
   available. `--pre` is required: the phase-5a release under test is a prerelease, and plain `--check` looks up
   `/releases/latest`, which never returns a prerelease, so without `--pre` this step is a no-op that never reads
   the new `SHA256SUMS` at all -- it would report "already at the latest version" and never exercise
   `parseSha256Sums` on the new file shape, which is the entire point of this criterion. With `--pre`, v0.2.3's
   `parseSha256Sums` must not throw or exit non-zero while parsing the new `SHA256SUMS` -- it only ever looks up
   its own `scriptorium-win-x64.exe` entry by filename, so the unfamiliar third entry (`scriptorium-linux-x64`)
   must be silently ignored, not treated as a parse error.
2. With the installed v0.2.3 exe, a full `update --config <scratch>` (no `--pre` needed once promoted): downloads
   the win-x64 asset only (never the Linux one), verifies its checksum against the entry `parseSha256Sums` found,
   and replaces itself normally -- exactly as every prior release's update path did. `certutil -hashfile` the
   result against the win-x64 entry in the published `SHA256SUMS`.
3. With the newly updated exe (now running phase 5a's code), `update --check --config <scratch>`: it must not be
   refused with the "only runs inside a packaged executable" message. While the public repository has no
   releases, with `gh` authenticated it exits 4 with the 404 "no release has been published there yet" text, and
   without `gh` authentication it exits 4 with the gh-not-authenticated message. Once public releases exist
   it exits 0. Either way this confirms P5a-FR07's packaged-only guard (`isPkg`, default `typeof process.pkg !== 'undefined'`)
   recognises a real packaged Windows exe as packaged and does not refuse a legitimate `--check` -- the guard was
   built and unit-tested only with an injected `isPkg`, never against a real pkg-built binary.

### C39: `serve --admin` launch, bind and request gate, in the real win-x64 exe

`docs/decisions/0022-gm-admin-panel.md`: `serve --admin` starts an admin listener and a preview listener, both on 127.0.0.1 only. It prints the admin URL with a one-time launch token, and the preview URL without it. Every request must name the listener's own port as `127.0.0.1` or `localhost` in its Host. Opening the token link sets a session cookie and redirects. Every POST must carry an Origin exactly equal to the admin origin. No response carries a CORS header. Verified on Linux from source and from a Linux packaged build (`test/admin-cli.test.js`, `test/admin-gate.test.js`, `test/admin-http.test.js`, `test/admin-e2e.test.js`). **Mark this OPEN: Linux-verified from source only.**

Isolate config exactly as in C35. Set `SCRIPTORIUM_CONFIG` to a scratch TOML and pass the same path as `--config` on every command. Record `certutil -hashfile %APPDATA%\Scriptorium\config.toml SHA256` before step 1 and after step 6; they must match. Work in a local scratch folder S whose path contains a space. Never use the real vault or a mapped drive. Copy `test\fixtures\vocab-vault` from a checkout of this release to `S\panel vault`. Register it in the scratch TOML as campaign `c39`, with `vault = 'S\panel vault'`, `output = 'S\out'`, no `site_config` and no `pack`. Run the curl steps in PowerShell, so that `%` is never expanded.

1. Run `netstat -ano > S\before.txt`. Then run each of these; each must exit 1 with exactly one line on stderr and no stack trace:
   - `serve c39 --admin --host 0.0.0.0`
   - `serve c39 --admin --host 127.0.0.1`
   - `serve c39 --admin --host`
   - `serve c39 --admin --build`
   - `serve c39 --admin --out "S\x"`
   - `serve c39 --admin --site-config "S\x.json"`

   `netstat -ano` must then show no LISTENING entry that was not in `S\before.txt`.
2. `serve c39 --admin --port P`, where P is a free port, prints exactly three lines:
   - `admin panel: http://127.0.0.1:P/auth?token=<T>`
   - `preview: http://127.0.0.1:<Q>/`
   - `open the admin panel link in your browser. Press Ctrl-C to stop.`

   Record whether Windows Defender Firewall prompts; no prompt is expected. `netstat -ano` shows P and Q LISTENING on `127.0.0.1` only. From a second machine on the LAN, both ports refuse the connection or time out.
3. With curl.exe:
   - (a) `curl.exe -si "http://127.0.0.1:P/auth?token=<T>"` gives `303`, `Location: /`, and `Set-Cookie: scriptorium_admin_P=<T>; Path=/; HttpOnly; SameSite=Strict`.
   - (b) `curl.exe -s -o NUL -w "%{http_code}" -H "Cookie: scriptorium_admin_P=<T>" http://127.0.0.1:P/api/session` gives `200`. Adding `-H "Host: evil.example:P"` gives `403`.
   - (c) Without the Cookie header, the same request gives `403`. With the token's last character changed, it gives `403`. `/auth?token=` with the last character changed gives `403` and no `Set-Cookie` line.
   - (d) `curl.exe -s -o NUL -w "%{http_code}" -X POST -H "Cookie: scriptorium_admin_P=<T>" -H "Content-Type: text/plain" --data x -H "Origin: <O>" http://127.0.0.1:P/api/noop` gives `403` for O = `http://evil.example`, for `http://127.0.0.1:<Q>`, and for `null`. It gives `403` with the Origin header omitted, and `200` for O = `http://127.0.0.1:P`.
   - (e) `curl.exe -si -X OPTIONS -H "Origin: http://evil.example" -H "Access-Control-Request-Method: POST" http://127.0.0.1:P/api/noop`, and the same against Q: no line starts with `Access-Control-Allow-`.
4. `curl.exe -s -o NUL -w "%{http_code}" "http://127.0.0.1:P/%E0%A4%A"` gives `400`, and so does the same URL on Q. Step 3(b)'s positive control still gives `200` afterwards.
5. Ctrl-C prints `stopped.`, and `echo $LASTEXITCODE` gives 0. `netstat` shows neither port, and relaunching with the same `--port P` starts at once.
6. `findstr /s /m /c:"<T>" "S\*"` and the same over `%APPDATA%\Scriptorium` find nothing. Re-hash the config.

### C40: admin panel UI from the exe snapshot, browser and console

`docs/decisions/0022-gm-admin-panel.md`: the admin panel's HTML, CSS and JavaScript are embedded in the exe and served only on 127.0.0.1. Opening the printed link sets a session cookie and redirects, so the address bar drops the token. Everything the panel shows from the vault is plain text. Verified on Linux from source and from a Linux packaged build (`test/admin-views.test.js`, `test/admin-http.test.js`, `test/admin-assets.test.js`). **Mark this OPEN: Linux-verified from source only.**

Isolate config exactly as in C35. Record `certutil -hashfile %APPDATA%\Scriptorium\config.toml SHA256` before step 1 and after step 7; they must match. Use a local scratch folder S whose path contains a space. Never use the real vault or a mapped drive. Copy `test\fixtures\vocab-vault` to `S\panel vault` and register it as `c40`, with no `site_config` and no `pack`. For steps 1 to 4, launch `serve c40 --admin --port P` in a conhost window, not in Windows Terminal.

1. With the cookie from C39 step 3, fetch `/` into `S\got\index.html`, and every one of the 20 `ADMIN_ASSET_ROUTES` keys from `/assets/` into `S\got` (`admin.css`, `tokens.css`, `app.js`, `store.js`, `icons.js`, `nav.js`, `frame.js`, `views.js`, `pack.js`, `vocab.js`, `images.js`, `favicon.svg`, plus the 8 files under `fonts\`: `IMFeENrm28P.ttf`, `IMFeENsc28P.ttf`, `AlegreyaSans-Regular.ttf`, `AlegreyaSans-Medium.ttf`, `AlegreyaSans-Bold.ttf`, `AlegreyaSans-Italic.ttf`, `IBMPlexMono-Regular.woff2`, `IBMPlexMono-SemiBold.woff2`). `certutil -hashfile` of each equals the same file under `assets\admin\` (or `assets\admin\fonts\`) in a checkout of this release: for the 12 text assets (everything except the 8 font files), compare **normalised** per "Checkout line endings (CRLF)" near the top of this document, since raw bytes will not match on a stock CRLF checkout and that is not a defect; the 8 fonts are binary (git never CRLF-converts them), so those 8 compare on raw bytes directly. Each response's `Content-Type` matches the type listed for its key in `src/admin/assets.js` (`font/ttf` for the six TTFs, `font/woff2` for the two woff2s).
2. Open the printed admin link in Edge. The address bar shows `http://127.0.0.1:P/` with no token, and the panel names campaign `c40`. In DevTools, every request from the tab goes to `127.0.0.1:P`. The Console shows no errors and no Content-Security-Policy violations.
3. A second tab on `http://127.0.0.1:P/` shows the panel. An InPrivate window on the same URL shows only the "open the link printed in your terminal" page, with no campaign data.
4. In the conhost window, turn QuickEdit on, select part of the admin URL, and leave the selection active. In Edge, press Check, then Build preview. Both complete and show results, and the console window prints no new lines. Clear the selection.
5. Press Ctrl-C, then relaunch in Windows Terminal. Ctrl+click the admin URL. It opens with the token intact, and the panel loads.
6. The error, warning and info counts that the panel's Check shows equal the counts from `check c40 --json`.
7. Stop the panel. Register `c40p` with the same vault and `pack = 'S\panel vault\_meta\scriptorium'`. `serve c40p --admin` shows the panel with a read-only notice that names the pack key. Re-hash the config.

### C41: pack writes on NTFS, in the real win-x64 exe

`docs/decisions/0022-gm-admin-panel.md`: the admin panel edits only `pack.toml` and `vault.config.json` in `<vault>\_meta\scriptorium\`. It writes a temporary file beside the target and renames it over the target. It refuses if the file changed since the panel loaded it. It retries a locked file for about three seconds, then leaves it unchanged. Verified on Linux from source and from a Linux packaged build (`test/pack-replace.test.js`, `test/admin-pack.test.js`, `test/setup-validate.test.js`). **Mark this OPEN: Linux-verified from source only.**

Isolate config exactly as in C35. Record `certutil -hashfile %APPDATA%\Scriptorium\config.toml SHA256` before step 1 and after step 8; they must match. Use a local scratch folder S whose path contains a space. Never use the real vault or a mapped drive. Copy `test\fixtures\vocab-vault` to `S\panel vault`, register it as `c41` with no `site_config` and no `pack`, and save `dir /s /b /a "S\panel vault"` to `S\before.txt`. Call the pack folder `S\panel vault\_meta\scriptorium` P.

1. In the panel's Theme screen, choose `haze` and click Review change. The save review shows the new file, and clicking Save succeeds. `certutil -hashfile "P\pack.toml" SHA256` equals `617ead2a6a438b1113d7b52bf4ce4da13d0d372a2ad71bbc45e0452f91888155`, and `findstr /c:"[labels]" /c:"[timeline]" /c:"[recaps]" "P\pack.toml"` finds all three tables.
2. Stop the panel. Change the registered `vault` to the same path in different letter case, then relaunch. In the Title & tagline screen, set the site title to `Scratch Title` and save it through the save review. `P\vault.config.json` now contains `Scratch Title`, and `dir /s /b /a "S\panel vault"` shows no second pack folder.
3. Create `S\elsewhere`, run `mklink /H "S\elsewhere\linked.toml" "P\pack.toml"`, and note `linked.toml`'s hash. Save theme `plain`. `linked.toml`'s hash is unchanged, and `P\pack.toml`'s hash has changed.
4. P has no `images` folder yet. Run `mklink /J "P\images" "S\elsewhere"` (create `S\elsewhere` first), then upload any small png through the Images screen's upload form. The panel refuses, saying `images/` must be a real folder, not a link. `dir /a "S\elsewhere"` is unchanged, and nothing new appears under P. Remove the junction with `rmdir "P\images"`.
5. In PowerShell, run `$f = [IO.File]::Open("P\pack.toml",'Open','Read','None')`, then in the Theme screen click Review change and Save. The save review shows a clean error at once, the file's hash is unchanged, `dir /a P` shows no `.scriptorium-tmp-` file, and Check still works. Run `$f.Close()`. Repeat with `$f = [IO.File]::Open("P\pack.toml",'Open','Read','Read')` and save through the save review: after about three seconds it shows an error saying another program may have the file open, the hash is unchanged, and there is no temp file. Close the handle and save again; it succeeds.
6. Each of these uploads is refused, and `dir /a /r "P\images"` is unchanged after each:
   - `CON.png`, `nul.webp`, `com1.svg`
   - `crest.png:hidden`, `crest.png.`, and `crest.png ` with a trailing space
   - `crest.md`, `crest.exe`
   - a png made with `fsutil file createnew "S\big.png" 10485761`

   A png made with `fsutil file createnew "S\ok.png" 10485760` is accepted. After uploading `crest.png`, a second upload named `Crest.PNG` is refused as already existing. `dir /x "P\images"` shows `crest.png`'s 8.3 short name; an upload using that short name is refused, and `crest.png`'s hash is unchanged.
7. With the panel loaded, edit `P\pack.toml` in Notepad and save it. The next save review shows "pack.toml changed outside the panel. Reload before saving." with Reload and Keep editing, and the file keeps Notepad's bytes.
8. `dir /s /b /a "S\panel vault"` differs from `S\before.txt` only by lines under `_meta\scriptorium`. Re-hash the config.

Step 1's hash was computed on Linux at this docs commit (`src/admin/packedit.js`'s
`editPackTomlTheme`, applied to `test/fixtures/vocab-vault/_meta/scriptorium/pack.toml`'s own
`theme = "plain"` -> `"haze"`, following the C36 precedent for a stated expected value rather than
a placeholder the handover never supplies) — the panel's save endpoint calls this exact function,
so no packaged binary is needed to derive it. It matches what the Windows verifier independently observed
running the real panel on rc.2, 2026-09-29.

### C42: preview, GM link, published build

`docs/decisions/0022-gm-admin-panel.md`, "Preview builds" and "GM link and the unconditional output-gate marker": a preview build runs the same pipeline as `scriptorium build`, in-process against the panel's own launch-bound context, into a scratch directory under `%TEMP%` that is never beside the configured output and never inside the vault. After a successful preview build, every preview page that has `</body>` gets one discreet GM link back to the admin panel, added only after that build's own output gate has already run. The output gate refuses, unconditionally, any staged tree (preview or published) that contains the GM link's marker text, and no flag, `--force` included, can override that refusal. Verified on Linux from source and from a Linux packaged build (`test/admin-preview.test.js`, `test/gm-link.test.js`, `test/gm-link-gate.test.js`, `test/gm-link-structure.test.js`). **Mark this OPEN: Linux-verified from source only.**

Setup as in C40, with campaign `c42` and output `S\out`.

1. Build a preview from the panel. The preview link opens `http://127.0.0.1:<Q>/`, the site renders, and a search for a word that appears in the fixture returns results. The panel shows the preview folder. It is a `scriptorium-preview-` folder under `%TEMP%`: outside the vault, and not beside `S\out`. Every HTML page in the preview folder that contains `</body>` carries exactly one GM link at the bottom. `findstr /s /m /c:"data-scriptorium-gm-link" "<preview folder>\*.html"` lists every such page. Clicking a GM link opens the admin panel already signed in, with no token in the address bar.
2. With a preview tab open, change `theme` to `"haze"` in the pack's `pack.toml` using Notepad, then build the preview again. The build either succeeds, showing the haze look, or shows a message naming a locked file while the old preview is still served. The panel never crashes.
3. `build c42` into `S\out` exits 0. `findstr /s /m` over `S\out` for `data-scriptorium-gm-link`, for `127.0.0.1:P` and for the token each finds nothing.
4. `build c42` into `S\out` exits 0. In PowerShell, `Get-FileHash` every non-HTML file in the preview folder and in `S\out`, and compare by relative path: all are equal.
5. Press Ctrl-C. No `scriptorium-preview-` folder remains under `%TEMP%`; if one does, note it, since removal is best-effort. No `.scriptorium-build-*` folder remains beside `S\out`.
6. Append a line with the text `data-scriptorium-gm-link` to `S\panel vault\Episodes\Episode-01.md` (a note whose
   body prose actually publishes) and hash every file in `S\out`. **Do not use a note under `S\panel vault\People\`
   for this step**: `vocab-vault`'s `People\` notes are `type: pc`, whose template publishes only the first body
   line as a pull quote, so an appended line never reaches the staged tree and the gate has nothing to refuse --
   following the step against `People\` gives a FALSE PASS (`exit=0`, looks like the gate failed open, when it was
   never exercised at all; the Windows verifier nearly filed this as a defect on 2026-09-29 before finding the cause).
   `build c42 --force` exits 2, prints a line containing `build/gm-link-marker` for every affected page, and every
   file in `S\out` still has the same hash -- `--force` does not override this refusal. Remove the line; `build
   c42` exits 0. Automated coverage: `test/gm-link-gate.test.js` proves the gate fires against a marker planted in
   published prose from a real fixture, and separately proves a marker in a `type: pc` note's non-publishing body
   never reaches the staged tree -- pinning this exact fixture assumption so it cannot silently drift back.

### C43: `assertSafeOutputDir`'s containment (prefix) checks catch a case-different or symlinked output dir on real Windows, not just a `process.platform`-forced Linux test

Issue #23 closed the containment half of the fail-open gap `5d8dfb5` closed for equality: `finalOut` (or
an ancestor of it, since `finalOut` routinely does not exist yet) can be a case-different path or a real
symlink whose physical target is inside the vault, or vice versa, and a lexical `startsWith()` alone
cannot see either. `src/build/plan.js`'s `containmentPath()` now walks up to the longest existing
ancestor, `fs.realpathSync`s it, and rejoins the not-yet-created remainder before a case-folded prefix
comparison.

`test/build-plan-swap.test.js` proves this on Linux with real `fs.symlinkSync` (POSIX symlinks, which
this account can create without elevation) and forces the case-fold branch via a `process.platform`
`Object.defineProperty` proxy (`withPlatform('win32', ...)`) — it does not, and cannot, prove that a real
Windows NTFS volume behaves the way the proxy assumes. NTFS is case-insensitive-but-case-preserving by
default (not the same guarantee the fold treats it as), and a Windows directory symlink is `mklink /D` —
different creation semantics from POSIX, and on stock Windows 10/11 either Developer Mode or an elevated
prompt is required to create one at all, which this criterion cannot skip past. Mark this **OPEN** until
run against a real Windows filesystem.

Isolate config throughout: `SCRIPTORIUM_CONFIG` set to a scratch TOML with no `site_config`, and the same
path passed as `--config` on every command. Never touch `%APPDATA%\Scriptorium\config.toml`, never point
any of this at a real campaign vault.

1. Case: create `<scratch>\Vault\` (a real directory, real vault content not required — any file makes it
   a valid vault) and register a campaign whose `output` is `<scratch>\vault\site` (note the case
   difference in the `vault` segment, lowercase, and that `site` must not exist yet). `build` must refuse
   with the "refusing to build inside the vault" error, exit 3 (`VAULT_UNREACHABLE`, issue #108; was 1 —
   confirm it is 3 here, matching the Linux tests, not 1 and not a `check`-style exit 2).
2. Symlink, direct: `mklink /D <scratch>\out-alias <scratch>\Vault\secret` (an elevated prompt or
   Developer Mode, whichever this account has), `<scratch>\Vault\secret` pre-created. Register a campaign
   with `output` = `<scratch>\out-alias`. `build` must refuse the same way.
3. Symlink, ancestor-only (the case #23 calls "the common case, and the whole point"): `mklink /D
   <scratch>\ancestor-alias <scratch>\Vault\secret`, but do NOT create `<scratch>\ancestor-alias\site` —
   register `output` = `<scratch>\ancestor-alias\site` (a path that does not exist on disk at all).
   `build` must still refuse: this is the one Linux cannot fully stand in for, since it is exercising
   `containmentPath()`'s ancestor walk against Windows's own symlink/junction resolution rather than
   POSIX's.
4. Negative control, both 1-3's shapes but pointed at a genuinely unrelated directory (no vault
   relationship at all): `build` must proceed normally, no refusal. A guard that only ever refuses is not
   evidence it discriminates correctly.

### C44: the vocabulary editor in the admin panel, in the real win-x64 exe

`docs/decisions/0022-gm-admin-panel.md`, "Vocabulary edits": the panel edits `[labels]`, `[timeline]` and `[recaps]` in the pack's `pack.toml`, keeps every key it did not edit, and refuses any value `check` would refuse, with the same message. Verified on Linux from source and from a Linux packaged build (`test/admin-vocab.test.js`). **Mark this OPEN: Linux-verified from source only.**

Isolate config exactly as in C35, and hash `%APPDATA%\Scriptorium\config.toml` before step 1 and after step 5. Copy `test\fixtures\vocab-vault` to `S\panel vault` and register it as `c44`, with no `site_config` and no `pack`. Call the pack folder P.

1. In the panel's Vocabulary screen, Labels tab (the Connections group), set the connections heading to `Bonds`, click Review and save, check the diff in the save review, and click Save. `P\pack.toml` now contains `connections_heading = "Bonds"`, and `[timeline]` and `[recaps]` are still present.
2. `build c44` exits 0, and `Select-String -SimpleMatch 'Bonds' S\out\people\*.html` finds at least one file.
3. For each of C37 step 6's three values (session token `\bEp(\d+`, session token `\bEp\d+\b`, and the omen kind's glyph `<path d="M0 0"/>`), enter it in the Vocabulary screen's Weights and matching tab (the two session token values) or Timeline kinds tab (the glyph), and save through the save review:
   - Note the panel's message and `P\pack.toml`'s hash, which must be unchanged.
   - Put the same value into `P\pack.toml` with Notepad, and run `check c44`. It prints the same line.
   - Restore the file.
4. Clear the connections heading field and save. `connections_heading` is no longer in `P\pack.toml`.
5. In Notepad, add `future_label = "kept"` under `[labels]`, reload the panel, change the chapter label, and save. `future_label = "kept"` is still in the file. Re-hash the config.

### C45: the restyled admin panel in Edge, from the real win-x64 exe

`docs/decisions/0022-gm-admin-panel.md` §13 (V1c): Overview, Check, Preview and vault-config.md
are rebuilt on the shared store, with a `role="status"` line that shows while a check or preview
build runs and disables every run/save control across every screen and the slip for that
duration (FR-20). The brand now carries `siteTitle` (or the campaign name) plus a "campaign
`<name>`" sub-line, and the read-only vault-config.md nav item shows a visible "read-only"
marker. Below 700px the bottom bar and its sheet carry the full nav. Verified on Linux from
source and from a Linux packaged build (`test/admin-views-model.test.js`,
`test/admin-v1c-store.test.js`, the Playwright/axe QA pass at 1280 and 390 in Chromium and a
Firefox spot-check, zero serious/critical findings and zero `heading-order`). **Mark this OPEN:
Linux-verified from source only.**

Isolate config exactly as in C35. Copy `test\fixtures\vocab-vault` to `S\panel vault` and
register it as `c45`, with no `site_config` and no `pack`.

1. Open the printed admin link in Edge. In DevTools' Network tab, all 8 font requests
   (`IMFeENrm28P.ttf`, `IMFeENsc28P.ttf`, `AlegreyaSans-Regular.ttf`, `AlegreyaSans-Medium.ttf`,
   `AlegreyaSans-Bold.ttf`, `AlegreyaSans-Italic.ttf`, `IBMPlexMono-Regular.woff2`,
   `IBMPlexMono-SemiBold.woff2`) return 200 from `127.0.0.1:P`, with `Content-Type` `font/ttf` for
   the six TTFs and `font/woff2` for the two woff2s. The Console shows zero errors and zero
   Content-Security-Policy violations.
2. Keyboard only (no mouse): Tab to the Theme nav item, Enter. Tab to a theme card other than the
   one marked "in use", press Space to select `haze`, Tab to Review change, Enter. Focus lands
   inside the opened save review; Tab never reaches anything behind it (the sidebar, the nav).
   Press Escape: the save review closes, and focus returns to the Review change button. Reopen
   it, Tab to Save `pack.toml`, Enter: the save succeeds and the review closes.
3. Narrow the window below 700px. The sidebar is gone; a bottom bar reads Home, Vocab, Check,
   Preview, then More. Press More: a sheet opens listing every nav item, grouped as at ≥700px.
   Press Escape: the sheet closes and focus returns to More.
4. On Overview, press Run check. While it runs, the `role="status"` line above the screens reads
   "The panel pauses while a check runs.", and Run check, Build preview and every other run/save
   control on every screen (Theme's Review change, Title's Review and save, Vocabulary's Review
   and save, Images' Upload and Set/Clear, the slip's Save if one is open) are disabled. When it
   finishes, the line clears and the controls re-enable; Overview's bill shows the check's error
   and warning counts. Press Build preview: the same pause line and disabling happen for "The
   panel pauses while the preview build runs.", and afterwards Overview's bill reads "N files".
5. Open an InPrivate window on the same `http://127.0.0.1:P/` URL (no token). It shows the
   restyled locked page (no sidebar, no nav, no campaign data), styled consistently with the rest
   of the panel (the same fonts, the same dark surface).

### C46: `update` never downgrades from a prerelease

The Windows verifier found this on rc.2 (documented in the Windows verification channel): a prerelease
user running plain `update`/`update --check` was silently rolled back to the last stable release and
told they were "updated", because the decision path treated whatever `/releases/latest` returned as
newer than the running version with no ordering check. Fixed with real semver 2.0.0 precedence
(`src/update/semver.js`, including prerelease ordering): `update` and `update --check` must never offer
or install a version lower than or equal to the one already running, and `update --pre` now picks the
highest version across stable and prerelease releases by real semver, not by publish date or GitHub's
list order. There is no downgrade flag; rolling back stays manual via the `.old-<ver>` file `update`
already keeps beside the executable. Verified on Linux from source only, with injected release lists
(`test/update-downgrade.test.js`, `test/update-semver.test.js`) -- no real `gh` call or GitHub release
involved in any of it. **Steps 1, 2 and 4 verified on Windows (2026-10-07, rc.4, Windows 11 test VM), with real releases and `gh`. Step 3
was not run, because rc.4 exists and beats the rc.3 exe it would have used.**

Isolate config throughout: `SCRIPTORIUM_CONFIG` set to a scratch TOML, and the same path passed as
`--config` on every command. Never touch `%APPDATA%\Scriptorium\config.toml`.

1. With the currently installed prerelease exe, hash it (`certutil -hashfile <exe> SHA256`), then run
   `update --check --config <scratch>`. If the real `/releases/latest` is lower than or equal to the
   running version (the common case for a prerelease), exit 0 and the message must name both versions,
   point at `--pre`, and contain neither "update available" nor the word "updated".
2. Same exe, same comparison, now `update --config <scratch>` (no `--check`): same refusal wording,
   exit 0, and re-hash the exe afterward -- it must be byte-identical to step 1's hash (nothing written).
3. Same exe, `update --pre --config <scratch>`. If nothing published (stable or prerelease) beats the
   running version, the message must say so without suggesting `--pre` again (already used), exit 0,
   hash unchanged from step 1.
4. Negative control: once a genuinely newer prerelease or stable release is published, repeat step 1's
   `--check` (with `--pre` if the newer one is itself a prerelease) and confirm the ordinary
   "update available" message appears -- the fix must not have disabled real upgrades.

### C47: the vault-config.md tagline save and its backup, in the real win-x64 exe

`docs/decisions/0033-vaultconfig-write-exception.md`: the panel's tagline field now writes
`publish.theme.tagline` in `_meta\vault-config.md`, through a new chokepoint that backs up the
current bytes outside the vault before every write, in the per-machine folder beside
`config.toml`. `POST /api/pack/settings` with `landingTagline` gives 400 unknown field. Verified on
Linux from source and from a Linux packaged build (`test/vault-config-write.test.js`,
`test/machinedir-backups.test.js`, `test/admin-vault-config-edit.test.js`,
`test/admin-vault-config-http.test.js`, `test/admin-tagline-regression.test.js`). **Mark this
OPEN: Linux-verified from source only.**

Isolate config as in C35. Work in a local scratch folder `S` (a path containing a space, per C35).
Register a copy of `test\fixtures\vocab-vault` at `S\My Vault\` as campaign `c47`, with
`publish.theme.tagline: Old words` added under `publish:` in `_meta\vault-config.md`.

1. Hash both the isolated `S\config.toml` and the real `%APPDATA%\Scriptorium\config.toml`
   (`certutil -hashfile ... SHA256`) before step 2 and after step 4.
2. Open the Title screen and save the tagline `New words`. The review names the backup folder,
   which must sit beside the isolated `S\config.toml`, never under `%APPDATA%`. Afterwards,
   `fc /b` the saved `_meta\vault-config.md` against a pre-copy taken before the save: the only
   difference is the tagline line. A `vault-config-*.md.bak` exists in the named backup folder and
   is byte-equal to that pre-copy (`fc /b`).
3. `build c47 --config "S\config.toml"`: exit 0, and `S\c47-site\index.html` contains
   `New words` exactly once and `Old words` zero times.
4. CRLF: convert `_meta\vault-config.md` to CRLF line endings by hand, save a different tagline
   through the panel again, and `Format-Hex` on the result still shows `0D 0A` throughout the
   frontmatter, with the Markdown body byte-unchanged.
5. **Mapped-drive leg:** on a mapped network drive, create a fresh scratch vault in a uniquely
   named folder, confirmed (by full path string, not by drive letter alone) to be neither equal to
   nor inside the real campaign vault's own path. Save a tagline once; confirm both the write and
   the backup land correctly (the SMB atomic-rename residual ADR 0022 section 6 already names for
   `packreplace.js` applies identically here).
6. **Optional default-mode leg, needs the owner's own go first** (it relaxes CLAUDE.md's
   `SCRIPTORIUM_CONFIG` plus `--config` isolation rule): in one PowerShell session, set `APPDATA`
   to a scratch folder and unset `SCRIPTORIUM_CONFIG`. Backups must land under
   `<scratch>\Scriptorium\backups\`, and the real `%APPDATA%\Scriptorium\config.toml` hash from
   step 1 must be unchanged afterward.

### C48: scoped generator CSS and the color-mode toggle, in the real win-x64 exe (R1 repin, new)

Carried forward from the superseded ac2ebad repin briefs (never landed before this track). The
color-mode toggle (`gm-apprentice-publish/lib/color-mode.js`) rewrites the pin's own
`@media (prefers-color-scheme: light)` blocks in `css/style.css` at build time into
`:where(...[data-theme="light"])`-shaped selectors, driven by an inline `<head>` script that sets
`data-theme` from a saved choice or the OS default. Scriptorium's own `css/scriptorium.css` is
deliberately left unscoped by this transform (the documented residual: Scriptorium's product
stylesheet styles its own classes, not the pin's theme variables, so it has nothing for the
toggle's selector rewrite to touch). Verified on Linux from source and via a real build only.
**Mark this OPEN.**

1. Grapheme-vault built with the exe matches the C1 manifest (above) — confirms this transform ran
   identically to the node-side reference, not just that the build succeeded.
2. In Edge, at 768px and wider, confirm the header toggle appears, switches the palette, persists
   across a reload, follows the OS default when no choice has been saved, and that the mobile
   toggle (below 768px, a different control) also works.
3. A custom-palette scratch site (a campaign `theme.palette` override) has no toggle rendered, and
   its built `css/theme.css` contains a `color-scheme:` declaration.
4. In the built output, `css/style.css` contains `data-theme="light"` (the rewritten selectors);
   `css/scriptorium.css` does not (checked directly against a real Linux build: 10 occurrences vs.
   0 — confirm the same shape on Windows).

### C49: the bundled lunr asset in the exe's built site, and typo-tolerant search in Edge (R1 repin, new)

At `publish-v1.11.40`, `js/lunr.js` in the built output is the generator's own bundled lunr copy
(`node_modules/gm-apprentice-publish/node_modules/lunr/lunr.js`), not a top-level hoisted one —
confirmed byte-identical on Linux (`sha256sum` of the built `js/lunr.js` matches the bundled source
exactly). `pkg.assets` names the nested path directly (`docs/decisions/0005-generator-pin.md`'s
addendum), so the packaged exe's asset embedding is the thing to confirm on Windows. **Mark this
OPEN.**

1. Build a real vault with searchable content and `searchEnabled` on (the default).
2. In Edge, open the built site, use the search overlay, and confirm `js/lunr.js` loaded (Network
   tab, or that search returns results at all rather than silently no-op'ing).
3. Type a query that is a **prefix** of a real published page's title (not the whole word) and
   confirm it still finds the page — the client does prefix and fuzzy matching (Δ,
   `js/search.js`), independent of the leak check's own exact-token matching server-side.
4. Type a query that is a real proper name from the site with **one letter changed** (a typo) and
   confirm fuzzy matching still finds it.
5. If search returns nothing at all, check whether `js/lunr.js` failed to load in the exe
   specifically (a packaging/asset-embedding gap) before assuming a content problem.

### C50: the no-network guarantee, in the exe (R1 repin, new)

`src/generator/netguard.js`'s runtime guard is verified on Linux only
(`test/generator-no-network.test.js`'s FR-19 runtime test): a real build+check+preview of a
self-host-fonts fixture makes zero guarded `fetch`/`WebSocket` calls, the vault stays
byte-unchanged, and no `_meta/font-cache` is created. The guard itself (an
`Object.defineProperty` getter/setter on `globalThis.fetch`/`WebSocket`) is plain JS with nothing
platform-specific, but per this repo's first rule that is not evidence about the packaged exe.
**Steps 1 to 3 verified on Windows (2026-10-07, rc.4, Windows 11 test VM); step 4 stays OPEN. Step 2 was reworded to match what `build` prints.** The step 4 run added its block rule with `netsh advfirewall` to the local firewall store, which the test machine's policy ignores (local firewall rules are disallowed), so the rule was almost certainly not enforced. The byte-identical rebuild shows the build does not need the network, but not that the exe was blocked. A re-run must put the rule in the effective policy store.

1. Build a scratch site with `theme.fonts.source: self-host` and a non-generic heading font family
   (one the generator's own CSS stack doesn't already ship) via `scriptorium-win-x64.exe build`.
2. Confirm the build exits 0 and prints no network error, and that `theme.css` falls back to the CSS
   stack for the family (no `@font-face` and no Google import for it). The generator does emit a cache-miss
   warning, but `build` captures generator output and shows it only on a failed build, so on a successful
   build there is no warning line to look for (tracked in https://github.com/DrNoisys-Softworks/gm-scriptorium/issues/30).
3. Confirm no `_meta\font-cache` directory was created under the vault, and that the vault's
   per-file contents are unchanged (hash before/after, `Get-FileHash` recursively).
4. Optionally, stronger evidence: apply a Windows Firewall outbound-block rule scoped to the exe
   (or run it with network adapters disabled) and confirm the build produces byte-identical output
   to an unrestricted run — if the guard were somehow bypassed, only the firewall would still catch
   a real network attempt.

### C51: panel layout preferences survive a relaunch, in the real win-x64 exe

`docs/decisions/0033-vaultconfig-write-exception.md`, section 7: the panel now remembers a
handful of layout choices per computer (which version of a screen is shown, and whether the
preview pane is hidden), in `panel-prefs.json` beside `config.toml`. Never the vault, never
`config.toml` itself. Verified on Linux from source and from a Linux packaged build
(`test/admin-prefs.test.js`, `test/admin-v1e2-model.test.js`). **Mark this OPEN: Linux-verified
from source only.**

Isolate config as in C35. Work in a local scratch folder `S` (a path containing a space, per C35).
Register a copy of `test\fixtures\vocab-vault` at `S\My Vault\` as campaign `c51`.

1. Hash both the isolated `S\config.toml` and the real `%APPDATA%\Scriptorium\config.toml`
   (`certutil -hashfile ... SHA256`) before step 2 and after step 4.
2. On the Title screen, switch to "Where it shows". Confirm it stays pressed after a page reload.
3. Press Ctrl-C to stop the server, then relaunch it without `--port`. The printed admin port must
   differ from the first launch's. Open the new admin URL: the Title screen still shows "Where it
   shows" pressed.
4. `S\config.toml` exists at the same folder as `S\panel-prefs.json`. The real
   `%APPDATA%\Scriptorium\config.toml` hash from step 1 is unchanged.

### C52: the built-in `gloam` theme's self-hosted fonts and default, in the real win-x64 exe

`docs/decisions/0032-base-theme.md`: `init` now offers `gloam` as the default theme; `build`
copies its five self-hosted font files into `scriptorium\theme\fonts\` and writes
`css\scriptorium-theme.css`; the theme owns the vault's palette, so `check` never reports
`config/theme-scheme-mismatch` under it. Verified on Linux from source and from a Linux packaged
build only (`test/theme-gloam.test.js`, `test/theme-extends.test.js`, `test/theme-gloam-fonts.test.js`,
`test/init-e2e.test.js`, `test/theme-scheme.test.js`). **Partly verified on Windows (2026-10-07, rc.4, Windows 11 test VM). Two parts
stay OPEN: the save review slip and the lazy-loaded `IM Fell English SC` font.** Step 3's `IM Fell English SC` shows `unloaded` on the landing page, which uses no small caps
(the font loads lazily, and an explicit `document.fonts.load()` reports it `loaded`), and step 4's save
review slip was not exercised (OPEN). Linux-derived hashes below are stated literally; a Windows run confirms
them, it doesn't invent new ones.

Isolate config and scratch exactly as in C35, using a copy of `test\fixtures\mini-vault` at
`S\gloam vault`. Hash `%APPDATA%\Scriptorium\config.toml` before step 1 and after step 5.

1. `init --config "S\config.toml"`: name `c52`; vault `S\gloam vault`; accept the output and
   title defaults. The theme prompt reads exactly `Theme (gloam, haze, plain) [gloam]: `; press
   Enter; `y` to create. `S\gloam vault\_meta\scriptorium\pack.toml` is exactly `theme = "gloam"`.
2. `build c52 --no-check --config "S\config.toml"`: exit `0`.
   `dir /b "S\c52-site\scriptorium\theme\fonts"` lists exactly `CormorantGaramond-Italic-wght.woff2`,
   `CormorantGaramond-wght.woff2`, `IMFeENit28P.woff2`, `IMFeENrm28P.woff2`, `IMFeENsc28P.woff2`
   (owner decision, 2026-09-30: shipped as woff2, converted from the vendored TTFs with
   `woff2_compress`; the TTFs themselves are not shipped). Each file's
   `certutil -hashfile ... SHA256` equals the Linux-derived value: `115C1CCEC1E93F3FC3E8553A0FDA713C6C054FAD826A7D08DA7D7526A82FA72D`,
   `CF41B906EC483C10451416DB623A5D32F26DFD781A388241FB5CADC9A8E56419`,
   `25595DFB8A14B6486013C02157750C490C2B6E996C39E0B3144F00949889E7AB`,
   `BC324725E1DEAD508A492FFD50EF51D8B4A0D4D58016DA008BD9EC81EF8458D3`,
   `2E31919E93CB72DC957D9DA8A1E4788569490F3CFB7ABD52F53CA933792937A3` in that same order.
   `css\scriptorium-theme.css` hashes to `1D4A9DBDC60FA5CFF51C48A20BC212B95D4F58B8F5DE5A79894F87F9C1EBD27D`,
   and the site-root `NOTICE.txt` (the only one in a gloam build) hashes to
   `2B5A89F8DB0CAAF5223C1D41FF071B22D2275A03A14A9FEF15C16728C71FC6B7`.
3. `serve c52 --port <free>` in Edge: DevTools' Network tab shows no request outside 127.0.0.1
   on the landing page, and the Console's `[...document.fonts].map(f => f.family + " " + f.status)`
   lists `IM Fell English`, `IM Fell English SC` and `Cormorant Garamond`, each `loaded`.
4. `check c52 --json`: no finding with id `config/theme-scheme-mismatch`. Open the admin panel
   (`serve c52 --admin`) Theme screen: no mismatch note, and the save review slip shows none
   either.
5. Re-hash `%APPDATA%\Scriptorium\config.toml`.

### C53: one search control on phones, and a plain Sessions index, in the real win-x64 exe (R1b, new)

`docs/decisions/0012-product-stylesheet.md`'s "Addendum: one search button on phones, and a plain
Sessions index" addendum. The phone search un-hide now only fires when the header has no magnifier
icon button, and the Sessions index hides its breadcrumb, item count, sort menu, type buttons and
name filter. Verified on Linux from source and from a real Chromium check across multiple built
campaign sites, including a real campaign export. **Mark this OPEN: Linux-verified only.**

Isolate config as in C35. Register a copy of `test\fixtures\wrapup-vault` (has two session note
types, so its Sessions index also carries type buttons) at `S\My Vault\` as a scratch campaign.

1. Build with the exe (isolated as in C35).
2. The built `css\scriptorium.css` hash equals the Linux-recorded sha256:
   `533ab6fdafdc5aaa68d1419d5cdf328292e41a8ad0aaf255a3bcbf1db09be1bb`.
3. In Edge, open the built site's landing page:
   - at width 390: exactly one visible button named "Search" in the header. Tab from the site
     name reaches it, Enter opens the search overlay, and Escape returns focus to that same
     button.
   - at width 1440: exactly one visible button named "Search", and it is the text button, not the
     magnifier icon.
4. Open the built Sessions index. None of the five controls (breadcrumb, item count, sort menu,
   type buttons, name filter) are visible, and every session card is visible.
5. Open the Characters listing on the same site (or any other generic listing page other than
   Sessions). Its own breadcrumb, item count, sort menu and name filter are all still visible,
   unchanged.

### C54: the executable-frontmatter guard, in the real win-x64 exe

`docs/decisions/0034-executable-frontmatter-guard.md`: a note whose frontmatter opens with a
non-YAML language tag (`---js` and similar) is now refused by an ordinary check and by every
build, unconditionally; separately, the generator's own bundled copy of its frontmatter parser
has every non-YAML engine permanently removed for the life of the process, so even a note the
refusal never reaches cannot run as code. Verified on Linux, from source and from a Linux
packaged build, against a scratch vault planted at test time with the exact bytes needed for a
byte-order mark and each line-ending case (`test/fm-fence.test.js`, `test/fm-read.test.js`,
`test/fm-generator-guard.test.js`, `test/fm-check.test.js`, `test/fm-build-guard.test.js`,
`test/fm-sentinel-matrix.test.js`). **Mark this OPEN: Linux-verified from source and from a Linux
packaged build only.**

Isolate config as in C35. Work in a local scratch folder `S` (a path containing a space, per
C35). The payload every planted file below carries only ever writes a marker file inside `S`
itself; never plant one of these files in the real campaign vault.

1. Plant three files, written with `[IO.File]::WriteAllBytes` so the byte-order mark and line
   endings are exact (see "Checkout line endings" near the top of this document, for why a plain
   text editor cannot be trusted for this): `NPCs\Planted.md` opening `---js`, `_inbox\Note.md`
   opening `---JS` with an `aliases:` line further down, and a third file whose first line opens
   with a byte-order mark followed by `---js` and uses CRLF line endings throughout. Each payload
   writes a distinct, named marker file under `S`.
2. `check c54 --config "S\config.toml"` exits 2, names each of the three files by its own path,
   and none of the three marker files exist afterward.
3. `build c54 --force --no-check --config "S\config.toml"` exits 2, the human output contains the
   phrase "neither --force nor --no-check", nothing under the campaign's output folder changed,
   and none of the three marker files exist afterward.
4. In `serve --admin`: the Check panel shows the same three findings the console did in step 2;
   the Build preview button reports the same refusal rather than completing a build; and the
   vault-config field (when `_meta\vault-config.md` is itself one of the planted files) shows the
   refusal text, not the file's own body, anywhere in the panel or in the browser's network
   inspector.
5. A clean copy of the same fixture, with none of the three files planted, still checks and
   builds normally: the self-check that guards the generator's own parser passes silently on
   every ordinary run.
6. Optional, in the same scratch folder only: running the corresponding source-only executable
   from before this change against the same three planted files DOES create their marker files,
   confirming the scratch harness itself is live and the refusal above is real rather than
   coincidental.

### C55: Title views and the campaign-id warning, from the real win-x64 exe

`docs/decisions/0022-gm-admin-panel.md`, "Title and tagline, finished": the Title screen's
three views (a live hero with a plain summary, a "where it shows" gallery with pointers, and
read-only site-details cards with a Cards/JSON toggle), all over one set of fields, plus the
save-review warning that appears when a title change would also change the generator's own
campaign id. Verified on Linux from source and from a Linux packaged build
(`test/admin-v1e4-model.test.js`, `test/admin-title-campaign-id.test.js`). **Mark this OPEN:
Linux-verified from source only.**

1. Isolate config as in C35. In `S`, a copy of `test\fixtures\vocab-vault` whose
   `vault.config.json` gains `"backend": {"statusBar": true, "inbox": false}` by hand.
2. In Edge, Title in each of Title card, Where it shows and Site details. No JSON key names are on
   screen, except behind "Show the file" and in the JSON view.
3. Change the title from `Vocab Vault` to `New Campaign Name`. The review shows: "Saving this
   title changes that id from vocab-vault to new-campaign-name." (typed from the Linux run against
   this same fixture, `pinned.slugify`).
4. Save. `fc /b` against a pre-copy shows `vault.config.json` differing only on the `siteTitle`
   line.
5. The config hashes are unchanged.

### C56: Vocabulary help rail and friendly rows, from the real win-x64 exe

`docs/decisions/0022-gm-admin-panel.md`, section 13, "Vocabulary help and friendly rows":
a hideable "How to use" rail per tab, and friendly row names with a live sample beside each field.
Neither changes what gets saved. Verified on Linux from source and from a Linux packaged build
(`test/admin-v1e6-model.test.js`, and the browser matrix in the gate record). **Mark this OPEN:
Linux-verified only.**

1. Isolate config as in C35. In `S`, register a copy of `test\fixtures\vocab-vault`.
2. In Edge, choose the How-to rail: the rail text changes with each tab. Hide it, then press
   Ctrl-C and relaunch without `--port`: it is still hidden. The "How to use" button above the
   tabs brings it back.
3. Choose Friendly rows: typing in "Group: other people" updates its sample beside the field.
4. Save one label. Against a pre-copy, `pack.toml` gains only that `[labels]` line (the rewrite
   drops comments, as it always has).
5. The isolated `S\config.toml` and the real `%APPDATA%\Scriptorium\config.toml` hashes are
   unchanged throughout.

### C57: the live preview inside the panel, in Edge, from the real win-x64 exe

`docs/decisions/0035-preview-in-a-frame.md`: the Overview screen can now show a live, sandboxed
frame of the private preview build. Verified on Linux from source and from a Linux packaged build
(`test/admin-framing.test.js`, `test/admin-previewinfo.test.js`, `test/admin-pageroles.test.js`,
Playwright Chromium and Firefox). **Mark this OPEN: Linux-verified only, and frame-loading behaviour
is exactly the kind of thing that can differ on a real Windows browser.**

1. Isolate config as in C35. Register a copy of `test\fixtures\vocab-vault` in `S`. Hash both
   `config.toml` files before and after.
2. Launch without `--port`. With the Edge window at 1800 CSS px or wider (zoom out if needed),
   Build preview on Overview. The docked pane shows the landing page. The DevTools console shows no
   "Refused to frame" or Content Security Policy message.
3. Choose Split screen, open Title: the preview stays. Tick Follow and open Vocabulary: the preview
   collapses to an edge tab; clicking it shows the preview and hides the rail.
4. At 100% zoom (laptop width), Site preview opens a drawer. Choose "Show below the Overview": the
   preview sits below. Reload: still below.
5. In a new tab, open `http://localhost:<port>/auth?token=<token>`: the framed preview loads there
   too.
6. Ctrl-C and relaunch: the wide and laptop choices are both remembered, and the real
   `config.toml` hash is unchanged. C51 still holds within one window width.

### C58: session Wrap-Up recaps and withheld session bodies, in the real win-x64 exe

`docs/decisions/0036-session-wrap-up-support.md`: a session note paired with a published Wrap-Up
note now sources its timeline learned items, recap numeral and Connections links from the
Wrap-Up's own page, and `check` treats that session note's body as empty for the leak checks. A
published Wrap-Up linked to a session note that isn't itself published now gives a `check`
warning instead of silently disappearing. Verified on Linux from source and from a Linux packaged
build (`test/session-pairing.test.js`, `test/session-chain-leak.test.js`,
`test/session-chain-recaps.test.js`, `test/session-wrap-guard.test.js`). **Mark this OPEN:
Linux-verified from source and from a Linux packaged build only.**

1. Isolate config as in C35. Copy `test\fixtures\session-chain-vault` and its site config into a
   folder whose name contains a space, inside `S`.
2. `build` exits 0, with no `warning: sessions:` line in the output. Open the built site: the
   timeline's learned items and an NPC page's recap numeral both link to a page under
   `wrap-ups\`. Session 2's own page shows the generator's short recap paragraph and a "Read the
   full session" link, not the session note's own working notes. A count-only search for
   `R2SENTINEL` across the whole built output gives 0.
3. `check` gives none of the three new session-Wrap-Up warnings. Move `Sessions\Session 2.md`
   into a new folder, and add that folder's name to the site config's `excludeDirs`. `check` now
   gives exactly one warning naming Session 2's Wrap-Up and saying it is linked to a session note
   that isn't published.

### C59: readable relation words, a readable 404 button, and a readable story-begin button, in the real win-x64 exe

`docs/decisions/0012-product-stylesheet.md`, the addendum "Readable relation words and a readable
404 button": the Connections lane's relation words and tray text read the lane's own colours
instead of a bare theme colour, and the 404 page's "Return to Safety" button and the story
landing page's "Begin reading" button both read the page's own body-text colours, swapped.
Verified on Linux from source and from a Linux packaged build (`test/housestyle-contrast.test.js`
and the equivalent browser checks). **Mark this OPEN: Linux-verified from source only.**

1. Isolate config as in C35. Build a horror-preset scratch vault under the built-in `haze` theme,
   and the same vault again under the built-in `gloam` theme.
2. `certutil -hashfile css\scriptorium.css SHA256` on each build equals
   `8995a16d222b1e6101bdfaefb2cc0c14aafaf6f26b746a0fc2e32fe223e79b71` (same file, both builds).
   `certutil -hashfile css\scriptorium-theme.css SHA256` equals
   `8f117ab7a580a11e4973effecf3577e4608543503291c332823fb8b3c06cb906` for the `haze` build and
   `1d4a9dbdc60fa5cff51c48a20bc212b95d4f58b8f5de5a79894f87f9c1ebd27d` for the `gloam` build.
3. Open a character page with declared relationships in Edge, under `haze`. Switch the colour
   toggle both ways. The relation words, and the tray's quoted line, stay readable in both states,
   and DevTools' contrast check reports at least 4.5 for each. The tray's own heading only has to
   pass this way when the selected item has no page of its own to link to; when it does link to
   its own page, the heading reads the site's ordinary link colour instead, which this criterion
   does not cover (`docs/decisions/0012-product-stylesheet.md`'s addendum, "Will not catch").
4. On the 404 page, under `haze`, in both colour states, the button's computed background equals
   the page's own text colour and its own colour equals the page's own background colour, and
   DevTools reports at least 4.5. Under `gloam`, the button instead keeps its own purple
   background, with the page's own background colour as its text, and DevTools still reports at
   least 4.5.
5. On a story landing page with a campaign saga section, under both themes, the "Begin reading"
   button's computed background equals the page's own text colour and its own colour equals the
   page's own background colour, and DevTools reports at least 4.5.

### C60: Images layouts and art from the vault's attachments folder, from the real win-x64 exe

`docs/decisions/0038-vault-art-in-the-panel.md` and `docs/decisions/0022-gm-admin-panel.md`
section 13, "Images: friendly names, three layouts and your vault's art". Verified on Linux from
source and from a Linux packaged build (`test/admin-vault-art.test.js`, `test/admin-v1e5-model.test.js`,
and the browser matrix in the gate record). **Mark this OPEN: Linux-verified only, and junction and
network-drive behaviour can only be confirmed on Windows.**

1. Isolate config as in C35. In `S`, take a copy of `test\fixtures\vocab-vault` and add:
   - `_attachments\charts\harbour-chart.png` (any PNG) and `_attachments\.trash\old-map.png`;
   - a junction `mklink /J S\vault\_attachments\linked S\elsewhere`, with `S\elsewhere\stray.png`.
   - Hash both `config.toml` files before and after.
2. Launch without `--port`. In Edge, open Images in Slot gallery, On the page and Library first in
   turn. Each spot shows its panel name ("Landing banner", "Character portrait" and so on), with
   the code name only as small print.
3. "From your vault" lists `harbour-chart.png` with its picture, and never `old-map.png` or
   `stray.png`.
4. Use it for Page backdrop, then Review and save. The review row shows `Page backdrop`, with
   `vault:_attachments/charts/harbour-chart.png` after it. `fc /b` against a pre-copy shows
   `pack.toml` gaining only that `[images]` line (the rewrite drops comments, as it always has).
5. Build preview. `certutil -hashfile` of `scriptorium\slots\ground.png` in the preview tree equals
   the source PNG's hash.
6. In the same Edge profile, open `http://127.0.0.1:<port>/api/vault-art/file?name=_attachments/linked/stray.png`
   and `…?name=..%2F_meta%2Fvault-config.md`. Both answer `not found`.
7. **Mapped-drive leg:** a fresh scratch vault on a mapped network drive, in a uniquely named
   folder confirmed not equal to or inside the real vault's path. Steps 3 and 4 work. Note how long
   "From your vault" took to appear.
8. Replace `S\vault\_attachments` with a junction to `S`. The vault tab says the folder isn't
   inside the vault and lists nothing.
9. The config hashes are unchanged.

### C61: theme previews built from your own site, in Edge, from the real win-x64 exe

`docs/decisions/0039-preview-copies.md`: private copies of your site, one per registry theme,
built through the same pipeline a real build uses, from an in-memory change never written to your
vault. Shown on the Theme screen's cards as live frames, with page tabs, a status strip, a full-size
dialog and before/after frames in the review. Verified on Linux from source only
(`test/admin-variants.test.js`, `test/admin-variant-serving.test.js`, `test/admin-v1e7-model.test.js`).
**Mark this OPEN: Linux-verified from source only.**

1. Isolate config as in C35. Register a copy of `test\fixtures\vocab-vault` in `S`. Hash both
   `config.toml` files, and every file in the vault copy (`certutil -hashfile`), before you start.
2. Launch without `--port`. On Theme, choose "Build theme previews". The strip counts through each
   theme. Each card then shows a live frame of the copy's landing page in that theme. The DevTools
   console shows no "Refused to frame" or Content Security Policy message.
3. Under a card, the page buttons move its frame to a character page and to the timeline.
4. "Open full size" on gloam opens a dialog with the page at full width. Escape closes it and focus
   returns to the button.
5. Pick haze and choose "Review change". The review shows the "today" and "after saving" frames.
   Choose Keep editing.
6. Save a tagline on Title and return to Theme. The strip says the previews are out of date.
7. In Explorer, `%TEMP%\scriptorium-preview-*\variants\` holds one folder per theme. Ctrl-C removes
   the whole `scriptorium-preview-*` folder. Every vault-copy hash is unchanged, and no output
   folder was created. Record the deepest path length under `variants\` and note whether any build
   failed for path length.
8. The real `%APPDATA%\Scriptorium\config.toml` hash is unchanged.

### C62: the Vocabulary live example, from the real win-x64 exe

`docs/decisions/0039-preview-copies.md`'s addendum: a private copy of the site built from the
saved pack.toml plus the Vocabulary screen's own unsaved edits, through `POST /api/variants/vocab`
and the save path's own dry run. Shown on the Vocabulary screen's vo2 rail, with a Now / After
saving switch that follows the focused field's page, an Update example button, and a phone-only
collapsible block. Verified on Linux from source and from the packaged `gm-scriptorium-linux-x64`
binary only (`test/admin-variant-vocab.test.js`, `test/admin-v1e8-model.test.js`, plus a live
Chromium pass against the packaged Linux binary). **Mark this OPEN: not yet verified on Windows or
in Edge.**

1. Isolate config as in C35, with a `vocab-vault` copy. Hash `pack.toml` (`certutil -hashfile`).
   Build preview on Overview.
2. On Vocabulary, choose Live example. The rail shows "How it will look" with the Now frame of the
   timeline page.
3. Type a new word in "Group: other people" and choose "Update example". The panel pauses. "After
   saving" then shows a character page containing the new word. The `pack.toml` hash is unchanged.
4. Click into the Recaps tab's field. The frame moves to a session recap.
5. Review and save. In a pre-copy of the same vault, make the same edit in How-to rail view and
   save. `fc /b` of the two `pack.toml` files shows no difference.
6. Narrow Edge to phone width. The example becomes a "See how it will look" block.
7. Both config hashes are unchanged.

### C63: editing the whole vault-config.md settings block, the review and restore, in the real win-x64 exe

`docs/decisions/0041-check-an-edited-copy.md` and the tail addendum to
`docs/decisions/0033-vaultconfig-write-exception.md`: the vault-config.md screen now edits and
saves the whole settings block as text, runs the real check against the edited copy before saving,
and can restore any backup the backups list actually finds. Verified on Linux from source and from
a Linux packaged build (`test/admin-vault-config-editor-http.test.js`,
`test/admin-vault-config-effects.test.js`, `test/admin-candidate-check.test.js`,
`test/admin-v1e9-model.test.js`, `test/machinedir-backups.test.js`). **Mark this OPEN:
Linux-verified only.**

1. Isolate config as in C35. Register a scratch copy of `test\fixtures\vocab-vault` at
   `S\My Vault\` as a campaign, with `exclude_fields: ["secrets"]` added under `publish:` in
   `_meta\vault-config.md`, and two pages carrying a `secrets:` frontmatter field.
2. Hash both the isolated `S\config.toml` and the real `%APPDATA%\Scriptorium\config.toml` before
   step 3 and after step 9.
3. Open vault-config.md's editor, tick "Edit the file", and remove the `secrets` line from
   `exclude_fields`. The parse status reads clean.
4. Open the review. It lists the field as no longer hidden, names the 2 pages it affects, and shows
   the check line. The backup folder it names sits beside the isolated `S\config.toml`, never under
   `%APPDATA%`. Save stays disabled until "Save anyway" is ticked.
5. Tick "Save anyway" and save. Afterwards, `fc /b` against a pre-copy taken before the save shows
   the body unchanged; a `.bak` exists in the named backup folder and is byte-equal to that
   pre-copy (`fc /b`).
6. Restore that backup from the backups list on the same screen. The frontmatter is back to the
   pre-copy (`fc /b` equals it), and a fresh backup of the version just replaced now exists.
7. **CRLF leg:** convert `_meta\vault-config.md` to CRLF line endings by hand, make and save
   another edit through the panel. `Format-Hex` on the result shows `0D 0A` throughout the
   frontmatter, with the Markdown body byte-unchanged.
8. **Mapped-drive leg:** on a mapped network drive, create a fresh scratch vault in a uniquely
   named folder, confirmed by full path string (not drive letter alone) to be neither equal to nor
   inside the real campaign vault's own path. One text save and one restore both land correctly.
9. **Edge, keyboard only:** tab to the editor, open the review dialog, tab to the "Save anyway"
   tick and the save button, and tab through the "discard this edit" leave dialog when navigating
   away with unsaved changes; every control is reachable and operable without a mouse.

### C64: the vault-config.md watch and field layouts, in the real win-x64 exe

The tail addenda to `docs/decisions/0033-vaultconfig-write-exception.md` and
`docs/decisions/0022-gm-admin-panel.md`: the vault-config.md screen has two more layouts, "Unlock
and watch" (unlock by typing the campaign name, live "What this changes") and "Fields by risk"
(seven settings as fields, in three groups), and a field save edits only the lines of the settings
changed. Verified on Linux from source and from a Linux packaged build
(`test/admin-vault-config-fields.test.js`, `test/admin-vault-config-fields-http.test.js`,
`test/admin-v1e10-model.test.js`, `test/admin-v1e10-vc.dom.test.js`). **Mark this OPEN:
Linux-verified only.**

1. Isolate config as in C35. Register a scratch copy of `test\fixtures\vocab-vault` at
   `S\My Vault\` as a campaign, with a `landing:` block (`max_npcs: 6`) and
   `exclude_fields: ["secrets"]` under `publish:` in `_meta\vault-config.md`.
2. Hash both the isolated `S\config.toml` and the real `%APPDATA%\Scriptorium\config.toml`
   before step 3 and after step 8.
3. Pick "Unlock and watch". Typing part of the campaign's name leaves "Unlock editing" disabled;
   the whole name, in any case, enables it. Unlock, delete the `secrets` entry in the editor: the
   effects list (in the right-hand pane at a wide window, under the editor at a narrow one) names
   it as no longer hidden.
4. Pick "Fields by risk" without saving. A note says the edits are in the other layout; nothing is
   lost. Switch back and the edit is still there. Stop editing.
5. In "Fields by risk", unlock through the drawer, change "How many characters to show" to 9 and
   add one featured character. Review lists the two settings, with their before and after values.
   Save. `fc /b` against a pre-copy shows that only the `max_npcs` line and the
   `featured_npcs` line differ; a `.bak` byte-equal to the pre-copy exists in the named backup
   folder.
6. **CRLF leg:** convert `_meta\vault-config.md` to CRLF by hand and repeat step 5. `Format-Hex`
   shows `0D 0A` on every written line, and the body is byte-unchanged.
7. Remove the `secrets` chip. Review requires "Save anyway"; without the tick Save stays disabled.
8. **Edge, keyboard only:** unlock the fields drawer, remove a chip with Enter, open "+ add", type
   and press Enter, and reach Review, all without a mouse.

### C65: the public-repository rename, in the real exe (S3, new)

`docs/decisions/0030-public-repo-and-update-source.md`: GM-Scriptorium's `update` source is now
the public repository, the release assets are `gm-scriptorium-win-x64.exe` and
`gm-scriptorium-linux-x64`, the CLI's help and user-facing hints say "gm-scriptorium", and a built
site's `NOTICE.txt` credits GM-Scriptorium at the public repository's URL. Verified on Linux from
source and from a Linux packaged build (`test/public-rename.test.js`, and the existing
`update-linux`, `package-config`, `build-notice` and `serve-emission` suites). **Steps 1, 2 and 4 verified on
Windows (2026-10-07, rc.4, Windows 11 test VM). Step 3 is verified with `gh` authenticated and stays OPEN for the unauthenticated wording
below.**

Isolate config throughout: `SCRIPTORIUM_CONFIG` set to a scratch TOML, and the same path passed as
`--config` on every command. Never touch `%APPDATA%\Scriptorium\config.toml`.

1. `gm-scriptorium-win-x64.exe --help`. The first line reads exactly
   `gm-scriptorium <command> [campaign] [flags]`.
2. The rc.3-to-rc.4 bridge rehearsal (run and passed on 2026-10-07, rc.4, Windows 11 test VM).
   With an already-installed rc.3 exe (old asset names, old update source), run
   `update --check --pre --config <scratch>`. It must find the bridge release -- the same rc.4
   bytes, published under the OLD asset names at the private repository -- and report an update
   is available.
3. With the rc.4 exe produced by step 2 (now pointed at the public repository), run
   `update --check --pre --config <scratch>` once more, against a tag that does not exist there.
   `gh` reports the 404, and the printed message names the public repository's releases URL and
   contains no mention of a private repository. Exit code is 4. This text applies when `gh` is
   authenticated. Without `gh` authentication the command exits 4 with the gh-not-authenticated message
   (`gh is installed but not authenticated for github.com...`), which must also not mention a private
   repository.
   Then, while the public repository has **no releases at all** (nothing published yet), run
   `update --check --pre --config <scratch>`: the `releases` list comes back empty. Expect exit
   code **4** (not 1, which means a Scriptorium bug) and the same wording, "no release has been
   published there yet" (F1; Linux-verified from source in `test/update-empty-release-list.test.js`, and
   confirmed in the real exe with `gh` authenticated). Without `gh` authentication, expect the
   gh-not-authenticated message here too, never the "no release" text.
4. `gm-scriptorium-win-x64.exe build <campaign> --out <scratch-dir> --config <config>.toml`
   against any reachable vault. Open `<scratch-dir>\NOTICE.txt`. Its first line reads exactly
   `This site was built with GM-Scriptorium (https://github.com/DrNoisys-Softworks/gm-scriptorium),`.

### C67: the sample campaign builds and serves from a fresh clone, in the real win-x64 exe

`examples/the-long-lease/`: a GM-facing sample vault shipped in the repository, with a GM guide at
`examples/README.md`. Verified on Linux from source and from a Linux packaged build
(`test/example-build.test.js`). **Verified on Windows (2026-10-07, rc.4, Windows 11 test VM), from a clone made with Git for Windows
defaults (cloned from a git bundle of the release commit using MinGit, not from the GitHub repository). Steps 1 to 3 were run with a headless Edge probe in place of interactive DevTools.**

1. Isolate config as in C35. Clone the repository with Git for Windows' default line-ending
   setting into a folder inside `S` whose path contains a space.
2. Follow `examples\README.md`'s Windows steps verbatim, changing only the paths. Expect `check`
   to report 0 errors, and `build` to exit 0.
3. Run `serve` and open the site in Edge:
   - the landing banner shows;
   - Orpiment's page shows her portrait;
   - the Fair Terms and Orpiment's Scale item pages show their art, and the Tally Cliffs location
     page shows its tall banner image;
   - no broken-image icon appears on any of those pages;
   - DevTools Network shows no request to any host but `127.0.0.1`.

### C68: the admin panel under Windows high contrast (forced colours), in Edge, from the real win-x64 exe

Bug batch B1, issue 89. Under forced colours the panel was measured at about 120 contrast failures
per screen in Chromium's emulation: Chromium paints text with the forced system colour but reports
the author colour as the computed `-webkit-text-fill-color`, which axe-core reads. The fix names
system colours for that property inside `@media (forced-colors: active)` (links LinkText, buttons
ButtonText, fields FieldText, everything else CanvasText). Verified on Linux in Chromium's emulation
only (`test/admin-bugs-b1.dom.test.js`); Firefox's emulation does not substitute the palette.
**Mark this OPEN: not seen on a real Windows high-contrast theme.**

1. Turn on a Windows high-contrast theme (Settings, Accessibility, Contrast themes), start
   `gm-scriptorium-win-x64.exe serve --admin` against a scratch campaign, open the panel in Edge.
2. Visit Overview, Theme, Title, Images, Vocabulary, Check, Preview and vault-config.md. All text,
   including the sidebar group labels, pills, captions and code, is readable in the theme's own
   colours; links look like links and buttons like buttons.
3. Tab through each screen: the focus ring is visible on every stop. The current screen in the
   sidebar and the chosen view option are marked by an outline, not by colour alone.
4. On Theme, the chosen card has a heavy outline. Press an arrow key on a card's radio: the choice
   moves and the focus ring follows it.
5. Switch the theme off again and confirm the panel looks as before (the change is inside the
   forced-colors query only).

### C81: a stub page cannot publish a withheld sub-heading, in the real win-x64 exe

Bug batch B2, issue 100 (docs/decisions/0042-stub-section-guard.md). Scriptorium now replaces the
pinned generator's `keepOnlySections` export before `lib/build.js` loads, and refuses to build when
that replacement did not land. Verified on Linux from source, and **on Windows (2026-10-07, rc.4, Windows 11 test VM)**, using the repository's own stub-heading fixture
rather than a hand-built vault.

1. Make a scratch vault with a `publish: stub` NPC whose `publish_include_sections` is `[Appearance]`,
   and a body with `## Appearance`, then `## GM Notes` containing `### Appearance` with the word
   `withheldmarker` and a `[[wiki link]]` to a location.
2. Run `gm-scriptorium-win-x64.exe build`. It succeeds (a "stub-page section guard is not live" refusal
   instead is the failure this step exists to catch).
3. `findstr /s /m withheldmarker out\*` finds nothing, including `out\search-index.json`; the linked
   location's page has no "Mentioned In" entry for the NPC; the `## Appearance` text is published.

### C82: `serve --port 0` and the serve escape probes, in the real win-x64 exe

Bug batch B2, issues 78 and 79. Verified on Linux, and **on Windows (2026-10-07, rc.4, Windows 11 test VM)**.

1. `gm-scriptorium-win-x64.exe serve --port 0` against a built campaign prints a non-zero port, and
   opening that exact URL serves the site.
2. With the server running, `curl.exe "http://127.0.0.1:<port>/%E0%A4%A"` returns 400 and the server
   keeps answering. `/..%2fout-evil/x` (a sibling folder named like the output folder plus a suffix)
   and `/..%5cout-evil/x` return 400, never the file.

### C83: a pack folder that resolves to the vault root is refused, in the real win-x64 exe

Bug batch B2, issue 80. Verified on Linux, and **on Windows (2026-10-07, rc.4, Windows 11 test VM)** for both junction cases; the `mklink /D` repeat stays OPEN. A junction
made by a standard user is untrusted on Windows 11, so create the junctions from an administrator account and
run the exe as the standard user. The real `mklink /D` repeat was not run and stays OPEN.

1. Make `_meta` a junction to the vault root itself (`mklink /J <vault>\_meta <vault>`), then run the
   panel's pack write (or `init`) on that vault. It is refused with "resolves to the vault root" and no
   `pack.toml` appears at the vault root.
2. Repeat with `_meta\scriptorium` as a junction to the vault root. Repeat both with a real
   `mklink /D` if Developer Mode is on.
### C85: `update --version <tag>` reaches the update command, in the real win-x64 exe

Bug batch B3, issue 83. `--version` was a global boolean that printed the running version before
any subcommand ran, so `update --version <tag>` never reached `update`. Now `update --version <tag>`
takes the tag and runs the update; plain `--version` is unchanged. Linux-tested only from source,
where `update` stops at the packaged-only guard. **Steps 1 and 3 verified on Windows (2026-10-07, rc.4, Windows 11 test VM). Step 2 reaches the
update logic but cannot show the "newer" result until the public repository has the tag, so it stays OPEN.**

1. `gm-scriptorium-win-x64.exe --version` prints the version and exits 0, as before.
2. `gm-scriptorium-win-x64.exe update --version <tag>` does NOT print the version. It reaches the
   update logic and changes nothing. While the public repository has no release for `<tag>` (today it has
   none at all), it exits 4: with `gh` authenticated, the 404 text "no release has been published there
   yet, or the requested tag does not exist"; without it, the gh-not-authenticated message. Once the public
   repository has releases, pick a tag that exists and is older than the running version: it reports that
   the running version is newer, exit 0. Use a tag that does not exist for the 404 case.
3. `gm-scriptorium-win-x64.exe update --version` with no tag exits 1 with
   `--version needs a value: update --version <value>`.

### C86: a table cell wikilink with an escaped pipe, built by the real win-x64 exe

Bug batch B3, issue 48. `[[Target\|Label]]` inside a markdown table row is now read as a link with
the label, by `check` and by `build`. **Mark this OPEN: not run from the exe.** At `publish-v1.14.0` the build side is the pin's own reader alone (the build-side rewrite is retired, ADR 0043's addendum); the steps below are unchanged.

1. In a scratch copy of the sample campaign, add a table with a cell `[[Emlyn Crewe\|Label Zqx]]`
   to a published page. `check` reports no "does not resolve" for it.
2. `build`, then open that page in Edge: the cell shows "Label Zqx" as a working link to the
   Emlyn Crewe page, and no `[[` text appears. Searching for "Zqx" finds the page.

### C87: the Title tagline save with a blank line after the tagline, in the real win-x64 exe

Bug batch B3, issue 87. **Mark this OPEN: not run from the exe.**

1. In a scratch vault's `_meta/vault-config.md`, put a blank line directly after the
   `tagline:` line, then `serve --admin` and open Title.
2. Change only the tagline and save: it saves (no "couldn't change only the tagline safely"), the
   blank line is still there, and only the tagline line changed.

### C89: concurrent builds sharing an output parent, and a stale staging dir, in the real win-x64 exe

Issue 102. **Partly verified on Windows (2026-10-07, rc.4, Windows 11 test VM): step 1 (eight rounds, no ENOENT) and step 3 passed. Step 2, the
kill and sweep, was not run and stays OPEN.** The build sweep decides whether a
`.scriptorium-build-<pid>-<ms>-<hex>` sibling is another live build's work with
`process.kill(pid, 0)`; confirm its win32 behaviour is what the code assumes (live pid returns
without throwing, a dead pid throws ESRCH, a protected pid throws EPERM and counts as alive).

1. Make a folder `W` with two scratch campaigns whose outputs are `W\out-a` and `W\out-b` (same
   parent). Start `scriptorium build` for both at once (two consoles, or `start /b`), several
   times over. Both must exit 0, and neither may fail with an ENOENT naming a
   `.scriptorium-build-*` path.
2. Start a build of a large vault and kill it mid-run (`taskkill /f /pid <pid>`) so its
   `W\.scriptorium-build-<pid>-...` directory is left behind. Run a build into `W\out-a` again:
   the leftover directory is gone afterwards (swept, its pid no longer alive).
3. Confirm no `.scriptorium-build-*` directory is left in `W` after the runs above finish.

### C88: serve stops cleanly on Ctrl-C and Ctrl-Break, and `--json` lines parse, in the real win-x64 exe

Bug batch, issue 27. `serve` and `serve --admin` now stop on SIGINT, SIGTERM and (win32 only)
SIGBREAK through one handler. Windows has no real SIGTERM, so only Ctrl-C and Ctrl-Break are
expected to run the clean stop; a plain process kill (Task Manager, `taskkill /F`) is not catchable
and skips the cleanup by design. **Mark this OPEN: not run from the exe.**

1. `gm-scriptorium-win-x64.exe serve --json --port 8380` in a console: one JSON line with
   `"event":"ready"` and `"port":8380` appears. Press Ctrl-C: a final `"event":"stopped"` line
   prints, the exit code is 0 (`echo %ERRORLEVEL%`), and `http://127.0.0.1:8380` no longer answers.
2. Repeat with Ctrl-Break instead of Ctrl-C: same stopped line, exit 0, port closed.
3. `serve --admin --json`: a `"mode":"admin"` ready line with `adminUrl` and `previewUrl`. Run one
   preview build from the panel, then Ctrl-C: stopped line, exit 0, no `scriptorium-preview-*`
   folder left in `%TEMP%`.
4. `taskkill` (without /F) from another console: record what happens. Expected: the process ends
   (Windows delivers no catchable signal), which is not a defect.

### C90: init maps Sessions, and build warns about an unmapped folder, in the real win-x64 exe

Bug batch B4, issue 103. **Verified on Windows (2026-10-07, rc.4, Windows 11 test VM).**

1. Copy `examples\the-long-lease` to `W\vault` and delete `W\vault\_meta\scriptorium`.
2. `gm-scriptorium-win-x64.exe init --vault W\vault --name v2 --yes --out W\site`, then open
   `W\vault\_meta\scriptorium\vault.config.json`: `folderMap` has `"Sessions": "sessions"`.
3. `gm-scriptorium-win-x64.exe build v2`: exit 0, no "were not published" line, and
   `W\site\sessions` holds `index.html` plus 3 session pages.
4. Delete the `Sessions` line from that `folderMap`, run `build v2` again, then `build v2 --no-check`.
   Both print `warning: 3 page(s) in "Sessions" were not published` and still exit 0.

### C91: a campaign with no output folder gives a message, not a stack trace, in the real win-x64 exe

Bug batch B4, issue 104. **Verified on Windows (2026-10-07, rc.4, Windows 11 test VM).**

1. `gm-scriptorium-win-x64.exe config add nout --vault W\vault` (no `--out`): exit 1, the message says
   `config add needs --out <folder>`, and no config file is created.
2. Put a `[campaigns.nout]` table with only a `vault` line into the config by hand, then run
   `build nout` and `serve nout`: each exits 3 (issue #108; was 1) with `campaign "nout" has no output folder`, and no
   `TypeError` or stack trace appears.

### C92: a value flag with no value, and removing a malformed campaign, in the real win-x64 exe

Bug batch B4, issue 105. **Verified on Windows (2026-10-07, rc.4, Windows 11 test VM).**

1. `config add x --vault` (nothing after it): exit 1, `--vault needs a value`, config unchanged.
2. Edit the config so `[campaigns.x]` has `vault = true`. `config list` exits 3 (issue #108; was 1) and names `campaigns.x`
   and the `config remove x` fix. `config remove x` exits 0, and `config list` works again.

### C93: unknown flags are rejected, in the real win-x64 exe

Bug batch B4, issue 106. **Verified on Windows (2026-10-07, rc.4, Windows 11 test VM).**

1. `build lease --prot`: exit 1, `unknown flag --prot for "build"`, nothing written to the output folder.
2. `check lease --jsno`: exit 1, `Did you mean --json?`.
3. `serve lease --out=C:\x`: exit 1, the message says to write the value after a space.
4. `build lease --no-check --force --json` and `update --check` still run as before.

### C94: the first-run errors say what to do next, in the real win-x64 exe

Bug batch B4, issue 107. **Verified on Windows (2026-10-07, rc.4, Windows 11 test VM).**

1. `init --vault W\plain --name emp --yes` on an ordinary folder: exit 3, the message names
   `_meta/vault-config.md`, `examples/the-long-lease` and the gm-apprentice link.
2. Make a vault with `_meta/vault-config.md` (player mode) and no publish manifest, run `init ... --yes`
   then `check`: the missing-manifest error says to create `_meta/publish-manifest.md` with a
   `## Publishing` list.

### C95: user errors use the existing exit codes, in the real win-x64 exe

Issue #108 (owner decision 2026-10-07: no new exit codes). **Partly verified on Windows (2026-10-07, rc.4, Windows 11 test VM); stays OPEN for two findings.** Steps 1, 3 and the rest of 2 passed, and no exit 2 or 4 appeared. (a) `chek` exits 1 but prints the full usage with no leading one-line message. (b) `serve --port 80` as a standard user binds successfully on Windows, so the administrator-rights message in step 2 cannot occur there. The full case table is in `docs/DEVELOPING.md`, "Exit codes for user errors". Use a scratch TOML via `SCRIPTORIUM_CONFIG` and `--config`; never the real config or vault. Check `echo %ERRORLEVEL%` after each:

1. Exit 3, one plain line, no stack trace: `check` against a config with no campaigns; `check nope` (unknown campaign); `check --config S\missing.toml`; a config containing `config_version = [[[`; `build --no-check --out "<vault>\x"`; `serve` with no build at the output folder; `config remove nothere`.
2. Exit 1, one plain line, no stack trace and no raw Node text: `chek`; `serve --port abc`; `serve --port 99999`; a port already in use; `serve --port 80` as a standard user (the message says it needs administrator rights, no `EACCES`); `serve --admin --host 0.0.0.0`; `init --yes --name x --vault <vault> --theme nonesuch`.
3. Exit 0: `status` against a config with no campaigns prints `no campaigns registered`.
4. Exit 3 (issue #108, third decision): a campaign entry with no `vault` key then `check` (message says `config add <name> --vault ...`); a bare vault (`_meta\vault-config.md` only) registered by plain `config add`, then `check` (message says to run `init`). One plain line each, no stack.
5. Exit 3 (issue #108, second decision): `SCRIPTORIUM_PROFILE=nonesuch` then `check`; a `pack.toml` containing `theme = [[[` then `check`; a `pack.toml` with `theme = "nonesuch"` then `build --no-check`; a `pack` key pointing at a missing folder then `check`. Each prints one plain line, no stack.
6. Exit 2 and 4 appear in none of the above.
7. Expected code changed from 1 to 3 and is **OPEN** again until re-run from the exe: C35 step 6 (init with `--out` inside the vault), the C43 inside-the-vault build refusal (step 1), C91 step 2, C92 step 2, C33 step 4 and the C30-era "no site_config" item (line ~430), C34 (pack image refusal, was 1) and C37 step 6 (pack.toml refusals, was 1). Any other earlier criterion expecting exit 1 for a bad `pack.toml`, theme, pack folder or pack image now expects 3.
### C69: the hidden panel-password prompt, in conhost and Windows Terminal, in the real win-x64 exe

`docs/decisions/0029-remote-access.md`: `gm-scriptorium remote password` reads the panel password with nothing echoed on a terminal, and from standard input when there is no terminal, never from an argument or an environment variable. Verified on Linux from source and from a Linux packaged build (`test/remote-cli.test.js`, the fake-terminal raw-mode tests, and the piped runs through the real `bin`). **Mark this OPEN: Linux-verified from source and a Linux packaged build only.**

Isolate config exactly as in C35. Set `SCRIPTORIUM_CONFIG` to a scratch TOML and pass the same path as `--config` on every command. Record `certutil -hashfile %APPDATA%\Scriptorium\config.toml SHA256` before step 1 and after step 7; they must match. Work in a local scratch folder S. Let `<scratch>` be a folder inside S that holds the scratch TOML.

1. In conhost (`cmd.exe`), run `remote password --config <scratch>\config.toml`. At `New panel password: ` type 12 or more characters, then at `Type it again: ` the same. Nothing may echo, not even asterisks. The command prints `panel password set. Every remote device is signed out.` and exits 0 (`echo %ERRORLEVEL%`).
2. Repeat in Windows Terminal, including pasting the password with Ctrl+V at both prompts. Nothing echoes.
3. Run it again: `Current panel password: ` is asked first. Type a wrong one: exit 1 with `that is not the current panel password; nothing changed`.
4. At any prompt, type a few characters and press Backspace: the characters are removed, and the typed text is still not shown. Finish with the right password.
5. At any prompt, press Ctrl-C. It prints `cancelled; nothing changed`, exits 1, and the console echoes normally afterwards (type `echo hi` to prove it).
6. Piped from PowerShell, `"a new passphrase 123" | gm-scriptorium remote password --config <scratch>\config.toml` (with the current password as a first line when one is set) exits 0. With an argument, `remote password hunter2hunter2 --config <scratch>\config.toml` exits 1 with one line and no password in it. With `$env:SCRIPTORIUM_PANEL_PASSWORD` set to something else, the password that works is still the one typed or piped.
7. `findstr /s /m /c:"<the password you typed>" "<scratch>\*"` and the same over `%APPDATA%\Scriptorium` find nothing. Re-hash the config.

### C70: the access list on the panel folder and its files, in the real win-x64 exe

`docs/decisions/0029-remote-access.md`: the `panel` folder beside the resolved config, with `password.json`, `sessions.json` and `audit.log`, is created by the program. On POSIX it is `0700` and `0600` from creation; on Windows it inherits the folder's access list. Verified on Linux for the POSIX modes (`test/remote-paths.test.js`). **Mark this OPEN: the Windows access list is unverified.**

Isolate config as in C35. Use a scratch folder S inside the profile (under `%USERPROFILE%`) and a second, `T`, outside it (for example `C:\scriptorium-scratch`).

1. For each of S and T: set a password with `remote password`, start the panel in a remote mode (C71 shows how) or run `remote signout-all` after a sign-in so that `sessions.json` exists, and make one change through the panel so that `audit.log` exists.
2. Run `icacls <folder>\panel`, `icacls <folder>\panel\password.json`, `icacls <folder>\panel\sessions.json` and `icacls <folder>\panel\audit.log`. Record the exact output. Expect no user or group beyond the owner, SYSTEM and Administrators.
3. Record the result for S (inside the profile) and T (outside it). A broader access list outside the profile is recorded here, not fixed.
4. Confirm `panel` is a real folder (`dir /AL` shows nothing for it), and that placing a config folder inside a registered vault is refused with a message naming the campaign.

### C71: proxy mode on a LAN address, in the real win-x64 exe

`docs/decisions/0029-remote-access.md`: `proxy` mode listens on a chosen address plus 127.0.0.1, and drops every peer but the trusted proxy and this machine before any HTTP. Verified on Linux with real sockets (`test/remote-listener.test.js`, `test/remote-http.test.js`), which is Linux-only because Linux accepts every 127/8 address. **Mark this OPEN: Linux-verified only.**

Isolate config as in C35. You need the PC, a second machine that will act as the trusted proxy, and a third machine.

1. `remote set --mode proxy --bind <LAN IP of the PC> --trusted-proxy <second machine's IP> --admin-url https://scriptorium.home.arpa --preview-url https://preview.scriptorium.home.arpa --port 7400 --preview-port 7401 --config <scratch>\config.toml`, then `remote password`, then `serve <campaign> --admin --config <scratch>\config.toml`.
2. The first output line starts `WARNING: remote access is on (mode proxy).`, before anything else. Record the Windows Defender Firewall prompt; allow it on Private networks only.
3. `netstat -ano` shows ports 7400 and 7401 LISTENING on the LAN IP and on 127.0.0.1.
4. From the third machine, `curl.exe -v http://<LAN IP>:7400/`: the connection is closed with no HTTP response.
5. From the second machine, `curl.exe -si -H "Host: scriptorium.home.arpa" -H "X-Forwarded-Proto: https" http://<LAN IP>:7400/` returns 403 with the sign-in page, and the same with `-H "Host: <LAN IP>:7400"` returns 403 with the body `refused: host`.
6. On the PC itself, the `on this machine:` token URL opens the panel in Edge.
7. Ctrl-C prints `stopped.` and exits 0; `netstat` shows neither port.

### C72: `tailscale serve`, from another tailnet device

`docs/decisions/0029-remote-access.md`, `docs/remote-access.md` section 7: `tailscale` mode binds 127.0.0.1 and trusts `tailscale serve` as its proxy. The test proxy stands in for it in `test/remote-http.test.js`; whether the real `tailscale serve` passes the browser's Host through and sets `X-Forwarded-Proto: https` is **not confirmed anywhere**. **Mark this OPEN: owner-run.**

1. Run the `remote set --mode tailscale ...` and `tailscale serve --bg --https=443 7400` and `tailscale serve --bg --https=8443 7401` commands from `docs/remote-access.md` section 7, with the PC's own `.ts.net` name. Isolate config as in C35.
2. From another tailnet device, open `https://<name>.ts.net/`. The sign-in page appears; sign in. Open preview lands on the `:8443` address with no second password prompt, and the GM link in the preview returns to the panel.
3. If the page says `refused: host` or `refused: proto`, `tailscale serve` is rewriting Host or not saying HTTPS. Report it; do not work around it.
4. Run `tailscale serve reset` afterwards.

### C73: an OpenSSH Server tunnel, in the real win-x64 exe

`docs/decisions/0029-remote-access.md`: `ssh` mode fixes both ports and prints the exact `ssh -L` command. Verified on Linux from source for the printed line (`test/remote-serve-admin.test.js`). **Mark this OPEN.**

1. `remote set --mode ssh --port 7400 --preview-port 7401 --config <scratch>\config.toml`, then `serve <campaign> --admin --config <scratch>\config.toml` on the PC (with the Windows OpenSSH Server running).
2. From another machine, run the printed `ssh -L 7400:127.0.0.1:7400 -L 7401:127.0.0.1:7401 <user>@<host>` line, and open the printed token link through the tunnel. The panel loads.
3. Open preview works through the second forward.
4. A tunnel with different local ports (for example `-L 9000:127.0.0.1:7400`) fails the Host check: the panel answers `refused: host`. That is expected.

### C74: Edge on the owner's desktop through a proxy: sign-in, lockout, sign out everywhere

`docs/decisions/0029-remote-access.md`: the password sign-in, the lockout, "sign out every device" and the read-only Remote access screen. Verified in Chromium and Firefox through the repo's test proxy with a TLS front (Gate 5 of the V1.5a slice). **Mark this OPEN: Edge is unverified.**

1. Use the repo's test proxy with a TLS front (a throwaway certificate trusted only in a scratch Edge profile), or the owner's own proxy if the owner runs one. Isolate config as in C35.
2. Sign in. DevTools > Application > Cookies shows `__Host-scriptorium_session` with Secure, HttpOnly, SameSite Strict and an expiry about 24 hours out.
3. Save a theme through the slip.
4. Type five wrong passwords, then the sixth (the right one) is refused. Open the Remote access screen on the PC through the loopback link: it shows the pause.
5. Sign out every device: the Edge tab's next request lands on the sign-in page.
6. DevTools shows zero console errors and zero CSP violations, apart from the deliberate wrong-password 403s.

### C150: the README config-isolation blocks for PowerShell and cmd, on Windows

Issues #8 and #17 (slice 1). **Mark this OPEN: the two Windows blocks were written on Linux and never run on Windows.** Only the Linux block was run. From a clone of the repository, copy each block from the page `docs/trying-it-safely.md` ("Trying it beside a real campaign") exactly as written, in its own shell (PowerShell, then Command Prompt), with `gm-scriptorium` on the PATH:

1. The block runs to the end with no error: the scratch folder is made, the sample vault is copied to `vault`, `config add` registers `lease`, `check` passes, and `build` writes a site to `out`.
2. Run the same block a second time in a new window. It still works, because each run makes a new scratch folder, and the first run's folder is untouched.
3. `%APPDATA%\Scriptorium\config.toml` is unchanged (same hash and timestamp) before and after both runs, and the cloned `examples\the-long-lease` is unchanged.
4. In a new window, `echo %SCRIPTORIUM_CONFIG%` (or `$env:SCRIPTORIUM_CONFIG`) is empty again.

### C96: generator warnings show on a successful build, in the real win-x64 exe

Issue #30. This is the Windows leg of C50 step 2, which expects the generator's cache-miss line to print. **Mark this OPEN: Linux-verified from source only; not run from the exe.** Use the C50 fixture (a scratch site with `theme.fonts.source: self-host` and a non-generic heading font family, no `_meta\font-cache`), a scratch TOML via `SCRIPTORIUM_CONFIG` and `--config`, and never the real config or vault.

1. `scriptorium-win-x64.exe build --no-check` exits 0. After the `built N file(s)` line, the human output prints `N generator warning(s):` and then each warning with no leading spaces, including the font line `WARNING: font "<family>" is not in the vault's font cache ... using the fallback font stack`.
2. The same build with `--json`: `generatorWarnings` is an array holding the same lines in the same order, and no other field has changed. The font line carries no `.scriptorium-build-` staging path.
3. Run step 2 twice: the two `generatorWarnings` arrays are identical.
4. Search the built site (`Select-String -Recurse`) for the text `font cache`: no match. Warnings go to the console and the JSON only.
5. A folder with typed pages but no `folderMap` entry is named once, by Scriptorium's own `warning:` line; the generator's `scanner: skipping "<folder>"` line does not also print.
6. A site config as `init` scaffolds it prints none of the generator's `backend.statusBar` / `backend.inbox` "old name" lines or its "still holds campaign settings ... migrate.py" line, in human output or in `generatorWarnings`. Add a key `init` does not write (for example `excludeFields`) and the "still holds campaign settings" line returns.

### C98: a .cmd shim runs with no shell, and cmd metacharacters stay inert, in the real win-x64 exe

The process spawner (ADR 0046, `src/proc/run.js`). **Mark this OPEN: Linux tests prove the text of the command line the spawner builds, not how cmd.exe treats it. Runnable only from the first release candidate whose exe reaches the spawner; the trigger is the panel action that release provides for starting an outside program.** Never put a real vendor tool on the PATH of this run. Use a scratch folder, and a scratch `SCRIPTORIUM_CONFIG` with `--config`:

1. Start the exe so the spawner's PATH is the scratch folder alone (for example a `bin` folder under `%TEMP%`). Real tools must be unreachable.
2. Put a test `claude.cmd` there that writes `%*` to a file. Run the panel action with arguments containing `& | ^ ( ) < >`. Each arrives quoted and inert, and no stray file appears in the scratch folder or the working directory.
3. Run it with an argument containing `%`, then one containing `"`, then one containing a newline. Each is refused with a plain message and nothing starts (the test `claude.cmd` writes no file).
4. Replace the shim with a `claude.ps1` alone: not found. Then a `claude.bat` alone: not found. Then both a `claude.exe` (any harmless test program) and a `claude.cmd`: the `.exe` is the one that runs.
5. No console window flashes, for either the `.exe` or the `.cmd` run.

### C128: a cancel or timeout kills the whole tree, the environment strip holds, and the working folder is empty, in the real win-x64 exe

The process spawner (ADR 0046). **Mark this OPEN: the Linux tests cover the group kill and the shape of the `taskkill` call, not Windows process trees. Runnable only from the first release candidate whose exe reaches the spawner.** Same scratch PATH rule as C98:

1. Use a shim that starts `%SystemRoot%\System32\ping.exe -n 600 127.0.0.1`. Cancel the run from the panel, and check `tasklist` for the shim's `cmd.exe` and `ping.exe`: neither remains. Repeat with a run that hits its timeout. Neither remains.
2. Set `anthropic_api_key`, `Claude_Code_Use_Bedrock` and one unlisted variable before launching the exe, each with a generated value that is not key-shaped. Run a shim that dumps `set` to a file. None of the three is in the dump. `Path` and `SystemRoot` are.
3. Have the shim print `%CD%`. It is an empty `scriptorium-proc-*` folder under `%TEMP%`, and it is gone afterwards.
4. Press Ctrl-C in the console running the panel while a run is in progress. The panel stops, and `tasklist` shows no leftover `cmd.exe` or `ping.exe` from the run.

### C129: outgoing connections reach only listed destinations, with TLS verified, in the real win-x64 exe

This covers ADR 0024 and `src/net/egress.js`. **Mark this OPEN: the Linux tests prove the rules against loopback stubs from source, not from the exe. Runnable only from the first release candidate whose exe reaches the module; the trigger is the panel action that release provides for an AI connection.** Use a scratch `SCRIPTORIUM_CONFIG` with `--config`. Never use a real AI service or key.

1. Check `netstat -ano` for listeners on 11434 and 1234. If a real local model server is running, stop it, or skip steps 1 and 2 and leave them OPEN. Start a logging stub on 127.0.0.1:11434 (for example a short PowerShell `System.Net.HttpListener` script) and use the local-model connection. The stub logs the request. `netstat` shows no other connection from the exe.
2. Relaunch the exe with `HTTP_PROXY` and `HTTPS_PROXY` set to a second logging stub on another 127.0.0.1 port, and repeat step 1. The second stub logs nothing. If the release lets the GM type an address, enter 127.0.0.1 with an unlisted port that has a third stub on it. It is refused with a plain message, and the third stub logs nothing.
3. On a disposable test machine only: map one listed remote host name to 127.0.0.1 in the hosts file and serve a certificate from a throwaway test CA on 443. With the CA untrusted, the connection is refused with a plain certificate message and the stub logs no request. Relaunch with `NODE_EXTRA_CA_CERTS` naming the CA file. The request reaches the stub. If the exe ignores that variable, record it; the refusal half still counts. Remove the hosts entry afterwards.
4. No message in any step shows a URL path, query, header or response text. Nothing extra is written to the panel console.

### C97: L5 reads rendered heading forms and story headings, and L6 reads data islands, in the real win-x64 exe

ADR 0045. **Mark this OPEN: verified on Linux from source and from the Linux packaged binary only; not run from the exe.** The `\p{L}` pattern, `normalize('NFC')` and the markdown-it renderer inside the packaged snapshot are only proven by running the exe. Never use the real config or vault.

1. With config isolated via `SCRIPTORIUM_CONFIG` and `--config`, use a scratch copy of the sample campaign.
2. Put `## **GM Notes**` in an NPC body, and `GM Notes (spoilers)` over a `---` line in a PC's `_Story.md`.
3. Run `check`: it exits 2 with two `leak/l5-gm-heading-survives` errors, the second on the `_Story.md` path.
4. Fix the headings and run `build`.
5. Hand-add `%% test %%` to a string inside a built page's `sc-tl-data` or `sc-cx-data` island.
6. Run `check`: it exits 2 with `leak/l6-comment-in-output`.

### C130: a double-click with no config opens browser setup, in the real win-x64 exe

`docs/decisions/0028-installer-and-first-run.md`, sections 6 and 7. **Mark this OPEN: Linux-verified from source (and a Linux packaged build run under a pseudo terminal with a fake opener) only.** Run on a disposable test machine with no real campaign, where the default `%APPDATA%\Scriptorium\config.toml` may be used. Anywhere else, first run `setx SCRIPTORIUM_CONFIG <scratch>\config.toml`, and afterwards `reg delete HKCU\Environment /v SCRIPTORIUM_CONFIG /f`. Never `N:`.

1. Make sure no config exists. Double-click `gm-scriptorium-win-x64.exe` in Explorer on Windows 11 (Windows Terminal). The console shows exactly the version line, the two running lines, `Panel` with `http://127.0.0.1:<port>` and `this PC only`, the `Setup` line, and `Browser didn’t open? Press O to open it again.` Record whether the apostrophe renders.
2. The default browser opens, shows "Signing you in…" briefly, then the setup start screen. Watch the address bar throughout: it never shows `code`. `edge://history` holds no URL containing `code`.
3. Repeat on Windows 10, or with the default terminal set to Windows Console Host: same text and same result.

### C131: the launch code never appears in a command line or the history, and the opener copes with an unusual profile path, in the real win-x64 exe

`docs/decisions/0028-installer-and-first-run.md`, sections 7 and 8. **Mark this OPEN: Linux-verified from source (and a Linux packaged build run under a pseudo terminal with a fake opener) only.** Run on a disposable test machine with no real campaign, where the default `%APPDATA%\Scriptorium\config.toml` may be used. Anywhere else, first run `setx SCRIPTORIUM_CONFIG <scratch>\config.toml`, and afterwards `reg delete HKCU\Environment /v SCRIPTORIUM_CONFIG /f`. Never `N:`.

1. Before the double-click, start this in PowerShell: `1..60 | % { Get-CimInstance Win32_Process | Select ProcessId,Name,CommandLine; Start-Sleep -Milliseconds 200 } | Out-File S\procs.txt`.
2. Double-click. Afterwards:
   - `Select-String -Path S\procs.txt -Pattern 'code='` finds nothing;
   - the `rundll32.exe` line reads `url.dll,FileProtocolHandler` followed only by a path ending `\panel\launch-<pid>.html`;
   - no line holds a 43-character run of letters, digits, `-` and `_` other than inside a path.
3. Create a local user whose name has a space and a non-ASCII letter (for example `Zoë Test`). Sign in as that user and double-click. The browser opens and signs in. If it doesn't, record it. ADR 0028 names `explorer.exe` as the fallback; do not change anything during the run.

### C132: closing the window stops everything and tidies up, in the real win-x64 exe

`docs/decisions/0028-installer-and-first-run.md`, section 9. **Mark this OPEN: Linux-verified from source (and a Linux packaged build run under a pseudo terminal with a fake opener) only.** Run on a disposable test machine with no real campaign, where the default `%APPDATA%\Scriptorium\config.toml` may be used. Anywhere else, first run `setx SCRIPTORIUM_CONFIG <scratch>\config.toml`, and afterwards `reg delete HKCU\Environment /v SCRIPTORIUM_CONFIG /f`. Never `N:`.

1. Launch with a campaign, build a preview from the panel, and confirm a `scriptorium-preview-*` folder is in `%TEMP%`.
2. Settings > Default apps: set `.html` to Notepad. Press O: Notepad opens the launcher file. Within 60 seconds, close the console window with the X button. Then:
   - `%APPDATA%\Scriptorium\panel\launch-*.html` is gone;
   - no `scriptorium-preview-*` folder is left;
   - the open panel tab shows "GM-Scriptorium has stopped" within a few seconds.

   Restore the browser as the `.html` default.
3. Repeat with GM-Scriptorium in one tab of a multi-tab Windows Terminal, and close only that tab: same results.

### C133: O, Ctrl+C and QuickEdit, in the real win-x64 exe

`docs/decisions/0028-installer-and-first-run.md`, sections 6 and 9. **Mark this OPEN: Linux-verified from source (and a Linux packaged build run under a pseudo terminal with a fake opener) only.** Run on a disposable test machine with no real campaign, where the default `%APPDATA%\Scriptorium\config.toml` may be used. Anywhere else, first run `setx SCRIPTORIUM_CONFIG <scratch>\config.toml`, and afterwards `reg delete HKCU\Environment /v SCRIPTORIUM_CONFIG /f`. Never `N:`.

1. Press O: a new tab opens signed in. The earlier tab still works.
2. From an open `cmd` window, run the exe with no arguments: launch mode starts. Press Ctrl+C: it stops with no pause, and `echo %ERRORLEVEL%` prints 0.
3. In a double-clicked console, click inside the window so QuickEdit starts a selection. In the browser, run a preview build and switch screens. Record whether the panel stalls until Esc is pressed. A stall is a recorded residual, not a failure.

### C134: launch errors pause, with the right exit code, in the real win-x64 exe

`docs/decisions/0028-installer-and-first-run.md`, section 6. **Mark this OPEN: Linux-verified from source (and a Linux packaged build run under a pseudo terminal with a fake opener) only.** Run on a disposable test machine with no real campaign, where the default `%APPDATA%\Scriptorium\config.toml` may be used. Anywhere else, first run `setx SCRIPTORIUM_CONFIG <scratch>\config.toml`, and afterwards `reg delete HKCU\Environment /v SCRIPTORIUM_CONFIG /f`. Never `N:`.

1. Write `config_version = [[[` into the config and double-click. One plain message line shows, then `Press Enter to close this window.`, and the window stays until Enter.
2. From `cmd`, run with no arguments: same output. After Enter, `echo %ERRORLEVEL%` prints 3.
3. Register two campaigns with no default: same, exit 3, and the message names both campaigns.

### C136: a registered campaign opens its Overview, and a second start is harmless, in the real win-x64 exe

`docs/decisions/0028-installer-and-first-run.md`, sections 6 and 7. **Mark this OPEN: Linux-verified from source (and a Linux packaged build run under a pseudo terminal with a fake opener) only.** Run on a disposable test machine with no real campaign, where the default `%APPDATA%\Scriptorium\config.toml` may be used. Anywhere else, first run `setx SCRIPTORIUM_CONFIG <scratch>\config.toml`, and afterwards `reg delete HKCU\Environment /v SCRIPTORIUM_CONFIG /f`. Never `N:`.

1. With one campaign registered, double-click: the browser lands on that campaign's Overview, signed in.
2. While it runs, double-click again. A second console and a second panel on another port appear, each with its own tab, and both work.
3. Close both. `certutil -hashfile` of the config is the same before the second start and after both are closed. No `launch-*.html` is left in `panel`.

### C135: browser setup through `serve --admin`, in the real win-x64 exe

`docs/decisions/0028-installer-and-first-run.md`, sections 1 to 5. **Mark this OPEN: Linux-verified from source and a Linux packaged build only.** Isolate config as in C35: a scratch `SCRIPTORIUM_CONFIG` and the same path as `--config`. Never the real config, never `N:`. Record `certutil -hashfile %APPDATA%\Scriptorium\config.toml SHA256` before step 1 and after step 8; the two must match. Work in a local scratch folder S.

1. Copy `examples\the-long-lease` to `S\vault` and delete `S\vault\_meta\scriptorium`. Run `serve --admin --config S\config.toml` (the file doesn't exist yet). The usual three lines print, then `setup: no campaign yet, so the panel starts with setup`. Open the printed link in Edge: the setup start screen shows.
2. Local vault. Name `lease`, vault `S\vault`: the checks go green. The output defaults to `S\lease-site`, the title comes from the vault, and the theme shows its default. The review lists four entries under `_meta\scriptorium\` and the config path. Choose Build my first preview: four lines tick over, then the ready screen. Open my preview shows the site. Go to my panel shows the Overview with the welcome. `S\lease-site` doesn't exist.
3. Parity. In folder T, make the same copy and run `init --yes --name lease --vault T\vault --config T\config.toml`. `certutil -hashfile` of `pack.toml` and `vault.config.json` gives the same value in both folders. The two `config.toml` files differ only in the vault and output paths.
4. Network share. Share a folder holding a fresh copy, or use `\\localhost\C$\...`. Typing the path shows nothing until you leave the box. Then the network-share warning shows with the two git commands. Continue works, and the review shows the network share pill.
5. Map `Z:` to a share, disconnect it, and type `Z:\vault`: "Can't find that folder" shows, with the mapped-drive hint in the grey rule line. Type `\\no-such-host-scriptorium\share\vault` and leave the box. The panel keeps answering (switch screens), and the field reports that it can't reach the folder within a few seconds.
6. An output folder inside the vault (`S\vault\site`) is refused with `refusing to build inside the vault: ...`, and Continue stays off.
7. Ctrl-C: `stopped.`, exit 0, and no `scriptorium-preview-*` folder left in `%TEMP%`. Run the same command again: the campaign panel opens, not setup. `/setup` redirects to the Overview. The welcome shows until dismissed; dismiss it, restart, and it's gone.
8. Re-hash the real config.

### C138: the folder picker lists only folders, never stalls, and creates one folder at a time, in the real win-x64 exe

ADR 0049, `src/setup/folders.js` and `src/admin/foldercreate.js`. **Mark this OPEN: Linux-verified from source and a Linux packaged build only; Windows paths, drives, junctions and reparse points are only proven by running the exe.** Isolate config as in C35: a scratch `SCRIPTORIUM_CONFIG` and the same path as `--config`. Never the real config, never `N:`. Record `certutil -hashfile` of `%APPDATA%\Scriptorium\config.toml` before step 1 and after the last step; the two must match. Work in a local scratch folder S.

1. Start browser setup. Browse on the vault field: `C:` and a scratch mapped drive both list. No "insert a disk" dialog appears for an empty card reader or optical drive.
2. Disconnect the mapped drive and press Refresh. It shows "not responding" within a few seconds while the others list, and the panel keeps answering (switch screens).
3. Type `\\localhost\C$\` plus a scratch path in the location box. Nothing is requested until Enter or Go, then it lists.
4. A `mklink /J` junction in S is marked as a link and can't be entered or chosen.
5. A OneDrive folder lists and opens as an ordinary folder.
6. At `C:\`, `$Recycle.Bin` and `System Volume Information` are hidden until Show hidden folders is ticked.
7. A folder denied with `icacls <dir> /deny %USERNAME%:(RD)` shows the permission message and the picker stays put. Remove the deny afterwards.
8. Folder names with `&`, spaces and non-ASCII letters list and can be chosen.
9. `C:\Windows\WinSxS` shows the truncated note without a stall.
10. A path longer than 260 characters lists.
11. New folder on the output field:
    - `Session Art` is created at once and selected;
    - `CON`, `x.` and `a\b` are refused with the name message;
    - an existing name is refused, and its contents are unchanged;
    - a folder inside the scratch config folder is refused.
12. With remote access in proxy or tailscale mode on a disposable machine, list a folder from the second machine. The panel's `audit.log` gains one `folders` line. A listing from the same PC adds none. A New folder from either adds a request and response pair.
### C139: switching campaigns, set default and remove work in one panel, and config.toml is written safely, in the real win-x64 exe

`docs/decisions/0050-several-campaigns.md`. **Mark this OPEN: Linux-verified from source and a Linux packaged build only.** Isolate config as in C135: a scratch `SCRIPTORIUM_CONFIG` and the same path as `--config`. Never the real config, never `N:`. Record `certutil -hashfile %APPDATA%\Scriptorium\config.toml SHA256` before step 1 and after step 8; the two must match.

1. Register `a` (local, `S\a`) and `z` (on a scratch mapped `Z:`), then run `serve --admin`. Switch to `z`, build a preview, and switch back. `a`'s last preview shows, and neither preview ever shows the other's pages.
2. Run `net use Z: /delete`, then switch to `z`. A plain message appears within a few seconds, the panel stays on `a` and keeps answering, and the preview is still `a`'s.
3. Reconnect, then remove `z`. Hash every file under `z`'s vault, output and backups (`Get-ChildItem -Recurse -File | Get-FileHash`) before and after: identical. `config.toml` matches a copy put through `config remove z`.
4. Open Campaigns, run `config add c ...` in a terminal, then Set as default. It is refused with "Your settings changed outside the panel. Reload and try again." and `c` is still in the file.
5. Hold `config.toml` open without delete sharing (PowerShell `[IO.File]::Open(path,'Open','Read','Read')`), then Set as default. It is refused within about 4 seconds, the file is intact, and no `.config.toml.scriptorium-tmp-*` is left. Close the handle and retry: it works.
6. If remote access is configured, switch from the remote browser: `audit.log` shows request `a`, response `z`. Otherwise leave this step OPEN.
7. On the Title screen type a new title without saving, then pick another campaign in the switcher. A confirm says "You have unsaved changes on this page. Switch anyway?". Stay keeps the title and the campaign. Switch moves the panel and lands on the Overview. On the Campaigns screen the long vault and output paths wrap and the page does not scroll sideways at a narrow window.
8. Ctrl-C: no `scriptorium-preview-*` is left in `%TEMP%`. Re-hash the real config.

## Items OPEN after the 2026-09-29 rc.2 Windows run — need a person at a keyboard

None of these are product concerns; every one is a harness limit on the automated tester's side,
found running rc.2 against the real win-x64 exe on 2026-09-29. Each is **OPEN, needs a person at
the keyboard**; where the automated half of the same step already passed, that is stated so the
next run does not have to repeat it.

| Item | Automated half | What still needs a human |
|---|---|---|
| C43 steps 2-3, real `mklink /D` | **Passed** with junctions (`mklink /J`, `LinkType: Junction`) instead of a real symlink -- exercises the same `realpathSync` ancestor walk, but is not literally a symlink | Developer Mode on, or one elevated `mklink /D` run, to close the gap between a junction and a real symlink |
| C40 step 3, second tab + InPrivate window | Not run | An InPrivate window is not reachable through browser automation |
| C40 step 4, conhost QuickEdit | Not run | A conhost window with QuickEdit selection held active while the browser drives Check and Build preview |
| C40 step 5, Ctrl+click in Windows Terminal | Not run | Ctrl+click on the admin URL in Windows Terminal |
| C42 step 5, Ctrl-C to a running preview | **Passed for `serve` itself** (C39 step 5, via `AttachConsole`/`GenerateConsoleCtrlEvent`) | The same real `CTRL_C_EVENT` could not be delivered to the preview process across two launch shapes |
| C35 step 5, Ctrl-C at the vault prompt | **Passed via EOF**, an adjacent path: produced the specified `init aborted; nothing written` and exit 1, but EOF is not `SIGINT` | A real Ctrl-C at a console prompt |
| C31 step 5, page transition motion | Not run | Watching in Chromium: the fold, breadcrumb-up and Back playing it in reverse, the landing page's ink-title morph, and the reduced-motion 150ms crossfade all need a human watching the screen |
| C39 step 2, and C16 | **Passed** everything reachable from one machine | A second machine on the LAN; still with the owner as of this handover, unchanged from previous rounds |

## What was NOT built, so you are not looking for it

- No code-signing (SC-9). Windows SmartScreen will very likely warn on first run of an unsigned `.exe`
  downloaded via browser; that is expected, not a bug to chase.
- arm64 and macOS packaging (P5a explicitly left these out of scope; only win-x64 and linux-x64 exist).
- The NAS migration's status is retained in the private archive at `b5b48b4`; it is no longer
  tracked in this repository.

Signed off as the Linux build host.
