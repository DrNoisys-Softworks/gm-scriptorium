# 0005. Generator pin: vendored tarball, per-file manifest integrity

Status: accepted (dependency/packaging/staging clause). Packaging proof (Half A/B) was BLOCKED on two
findings as of the first 2026-09-11 run; both are RESOLVED as of DEP-a2 (same day), see "Packaging
findings resolved (DEP-a2)" below. A release-blocking coverage gap in that same fix was found by QA
and closed 2026-09-17, see "D2 coverage gap: the shim didn't cover the facade (2026-09-17)" below. The `spike/` harness and manifests cited below are retained in the private archive at `b5b48b4`.

## Summary

Scriptorium bundles one exact copy of the upstream generator, `gm-apprentice-publish`, and refuses to build if any file in it differs from a recorded list of checksums. The copy is a vendored release tarball installed as a local file dependency, so installing and building need no network beyond `npm install`. Depending on a directory of upstream's source was rejected, because npm would link to that directory instead of copying it, and the packager would not find the files. A GM sees none of this directly. A contributor must never edit the copy by hand, and moves it only through the pin bump procedure in the collaboration guide.

## Why and what

The Engineering Brief's original npm-registry pin (`gm-apprentice-publish` `1.2.1`, resolved and
integrity-checked by npm against the public registry) is replaced. `1.2.1` is stale, npm itself has
been abandoned by upstream for this package (`CHANGELOG.md:2933-2936`, `pub/README.md:55-62`), and
the registry-hash integrity check it relied on (Engineering Brief section 2;
`docs/ACCEPTANCE-RESULTS.md:14`, retained in the private archive at `b5b48b4`) is gone with it.

The pin of record is the 40-character SHA `5779522640ebc655f64aaeac4ea66b9e1214e2ba` (FR-DEP-01).
`v1.9.11` (the tag at that commit) and `1.11.30` (`tools/publish/package.json`'s own version) are
**labels only**: tags can move, and the plugin's own version doesn't track the tool's. The SHA is
recorded in three places: this ADR, the machine-readable `vendor/gm-apprentice-publish/PIN.json`
the integrity check reads, and the notices wording (`scripts/generate-notices.js`, reading
`PIN.json` directly rather than a second hardcoded copy).

## Mechanism

**Chosen: a committed `.tgz`, packed from `tools/publish` at the pin, installed as a `file:`
dependency on the tarball itself.**

```json
"gm-apprentice-publish": "file:vendor/gm-apprentice-publish/gm-apprentice-publish-1.11.30.tgz"
```

npm extracts a `file:` **tarball** dependency into a real directory (confirmed empirically below),
so `node_modules/gm-apprentice-publish/...` stays exactly where `package.json`'s `pkg.assets` and
this ADR's own packaging proof expect it, and `lunr` stays hoisted to the top level
`node_modules/lunr/lunr.js` pkg.assets already globs. The lockfile records the tarball's sha512 as
a secondary integrity anchor for free. No git or network step happens at install or build time
beyond today's `npm install`.

**Rejected:**
- **`file:` dependency on a directory** (upstream's own supported model): npm **symlinks** a
  directory `file:` dependency (`CHANGELOG.md:2903`), which would move `node_modules/
  gm-apprentice-publish`'s real location out from under `node_modules` (breaking the asset globs
  and resolving `lunr` to upstream's own nested vendored copy instead of the hoisted one), and
  pkg with a symlinked package is unproven. Also the largest per-pin-move diff.
- **Relative-path require, bypassing npm**: breaks FR-DEP-03 (`require('gm-apprentice-publish')`
  must still resolve) unless aliased, and the lockfile would no longer describe the generator at
  all, so the integrity check would have to be fully custom with no npm anchor.
- **A git dependency**: ruled out per the Lead (npm cannot install a git subdirectory).

### npm version and behaviour (from `spike/manifests/pin-5779522/npm-behaviour.txt`)

`npm --version`: `10.9.8`; `node --version`: `v22.22.3`. `package-lock.json`'s `lockfileVersion: 3`
is consistent with npm 7+; 10.9.8 is well past the "probably 9 or later" assumption this decision's
first step was written to check.

Confirmed on this npm:
- a `file:` tarball dependency is **extracted**, not linked: `node_modules/gm-apprentice-publish`
  is a real directory, not a symlink, and has no nested `node_modules`;
- the lockfile records `resolved: "file:vendor/gm-apprentice-publish/gm-apprentice-publish-1.11.30.tgz"`
  plus `integrity: sha512-u6Ij+lxkJeSA/...`;
- the installed `package.json` is **not rewritten**: byte-identical to the pin's own
  `tools/publish/package.json`;
- `require.resolve('lunr', {paths:[...]})` from inside the installed package resolves to
  `node_modules/lunr/lunr.js` (top-level, hoisted), not a nested copy;
- `rm -rf node_modules && npm ci` reproduces an identical tree (sha256 of the sorted per-file
  sha256 list, before and after, match).

**Tarball integrity enforcement (recorded only, per the brief, not a pass condition):** flipping one
byte of the vendored `.tgz` in a scratch copy and running `npm ci`:
- with a **warm** npm cache (content-addressable, keyed by the lockfile's recorded sha512): `npm ci`
  exits **0** and silently serves the cached, uncorrupted content. It does not re-read the on-disk
  tarball at all.
- with `npm cache clean --force` first (**cold** cache): `npm ci` fails loudly (`zlib: incorrect
  data check`, `Z_DATA_ERROR`, exit 253).

npm's own tarball integrity check is real but cache-dependent, hence not trustworthy alone. This is
exactly why `PIN.json`/`treeSha256` exists: it reads the **extracted** tree directly, independent of
npm's cache state, and runs in `npm test` and before `npm run package`.

No STOP condition fired (package is not a symlink, has no nested `node_modules`, `lunr` resolves
top-level, and the installed `package.json` matches the pin byte for byte).

### Tarball provenance (`spike/manifests/pin-5779522/tar-vs-tree.txt`)

Packed via `npm pack --pack-destination` at the pin, unmodified (no GNU tar fallback needed):
0 byte differences across all 142 tarball entries present in the tree; every one of the 628 tree
files absent from the tarball is explained (367 `node_modules/*`: no `bundleDependencies`; 259
`test/*`: `.npmignore`; `package-lock.json` and `.npmignore` itself: npm's own default ignore
list). `docs/`, `.github/` and `*.test.js` outside `test/` don't exist in this tree, so those
`.npmignore` lines are currently vestigial.

## Integrity

`vendor/gm-apprentice-publish/PIN.json` records:
- `repository`, `path`, `commit` (the 40-hex SHA), `labels.{tag,packageVersion}` (labels only),
  `tarball` (the vendored filename);
- `omitted`: every deliberately-dropped tree path by rule and file count (DEP-AC-02);
- `files`: every shipped file's sha256, keyed by package-relative POSIX path (142 entries, matching
  the tarball's own file count);
- `treeSha256`: sha256 of `<hex>  <path>\n` lines, sorted by path bytes (matches `LC_ALL=C sort`),
  independent of npm/gzip version so a fresh clone reproduces it exactly.

`scripts/generator-pin.js` implements `manifestOf`, `verifyInstalled`, `derivePin`, and a CLI
(`verify`/`derive`). `npm run verify-generator` runs `verify`. `npm test` includes
`test/generator-pin.test.js`, and `scripts/package.js` calls `verifyInstalled()` before invoking
pkg, printing every problem and exiting 1 (no exe produced) on any mismatch.

**Re-derivation, verified twice independently in this run:** a fresh clone (`git clone
https://github.com/AntTheLimey/gm-apprentice`, `checkout --detach 5779522...`) and a **second,
independent** fresh clone both reproduce the exact same `treeSha256`
(`bb1165a93e6ae93c50cf7d661dd9c7ee915de1db77582e5ee8085180d4377dcc`) via `node
scripts/generator-pin.js derive --source <clone>/tools/publish --commit 5779522640ebc655f64aaeac4ea66b9e1214e2ba
--tag v1.9.11 --package-version 1.11.30 --tarball gm-apprentice-publish-1.11.30.tgz`.

**Pin-move procedure** (re-run this whenever the pin changes):
1. Fresh clone the upstream repository; `checkout --detach <new SHA>`.
2. `cd <clone>/tools/publish && npm pack --pack-destination <scratch>` (fall back to the GNU tar
   recipe in the brief's first step only if `npm pack` introduces a byte difference or an
   unexplained omission versus the tree).
3. `node scripts/generator-pin.js derive --source <clone>/tools/publish --commit <SHA> --tag <tag>
   --package-version <version> --tarball <name> --out vendor/gm-apprentice-publish/PIN.json`, and
   copy the packed `.tgz` into `vendor/gm-apprentice-publish/`.
4. `npm install --save file:vendor/gm-apprentice-publish/<new tarball>.tgz`.
5. `npm run verify-generator`.
6. `git diff <old SHA> <new SHA> -- tools/publish` to bound which of this ADR's and FR-DEP-12's
   `mirrors lib/X.js:N`-style citations need re-checking.
7. Re-run the rules-content redaction tests (`test/redactions.test.js`,
   `test/redaction-gurps-build.test.js`, `test/redaction-coc-build.test.js`) and re-derive
   `PIN_SCAN_BASELINE` (`scripts/content-markers.js`'s `scanPinTree()`, over the newly installed
   tree). Read every new or changed baseline entry by hand: a new file reproducing rules content
   anywhere in the 142(+)-file pin tree must be redacted the same way
   (docs/decisions/0007-rules-content-redaction.md) before the pin ships, not filed as "benign"
   to make the test pass. Also re-verify `REDACTIONS`' two `expectedSha256` values against
   `PIN.json.files` (a pin move that touches either redacted file changes that hash) and
   `pkg.patches`' two keys still resolve under the new tree.
8. Re-run the nested section-exclusion tests (`test/section-filter-patch.test.js`,
   `test/section-filter-build.test.js`) and re-verify `SECTION_FILTER_PATCH.expectedSha256`
   (`src/generator/sectionfilter.js`) against `PIN.json.files["lib/processor.js"]`, a pin move that
   touches `lib/processor.js` at all changes that hash and fails that binding on purpose. Then
   **re-read `filterSections` by hand** at the new pin. If upstream has fixed the unconditional
   `excludeLevel = level` (`lib/processor.js:94-98` at the old pin), the patch module is finished:
   **delete `src/generator/sectionfilter.js`, its install call in `src/generator/pinned.js`, its
   install call in `src/generator/bootstrap.js`, and its two test files**, do not leave it in place
   reporting `upstream-fixed` forever. If upstream has moved the code without fixing it,
   `applySectionFilterPatch()` throws on the ambiguity rather than guessing, and the anchor needs
   re-deriving by hand. See docs/decisions/0013-nested-section-exclusion-patch.md.
9. Re-run DEP-AC-01 through DEP-AC-06 and the provenance re-audit (a separate, read-only pass).
10. Amend this ADR: the pin, the dependency-set deltas, and the packaging proof result.

## The dependency set (FR-DEP-05)

The resolved runtime set is **Scriptorium's own `package-lock.json`**, not upstream's committed
`node_modules` (which `npm pack` never ships regardless, per the tar-vs-tree result above). No
`overrides`. Deltas against what upstream itself vendors in `tools/publish/node_modules`:

| Package | Upstream vendors | Scriptorium resolves | Delta |
|---|---|---|---|
| `gray-matter` | `4.0.3` | `4.0.3` | none |
| `lunr` | `2.3.9` | `2.3.9` | none |
| `markdown-it` | `14.1.1` | `14.3.1` | **newer patch/minor**, within the pin's declared `^14.1.0` range |

`markdown-it` 14.3.1 is the one delta; it is a semver-compatible newer release within the range the
pin itself declares (`^14.1.0`). This is the set the provenance audit (DEP-c, out of scope here)
must cover, including nested deps like `markdown-it/node_modules/argparse`.

## Packaging (DEP-AC-03), Half A and Half B: BLOCKED, two findings

The proof harness is `spike/run-pin-proof.sh` (usage: `--vault <local export> --site-config <path>
--scratch <dir>`), built to use the **shipped entry point** (`bin/scriptorium.js` + package.json's
own `pkg` field) for Half A, per Structural decision 7. Run against a local `git archive` export of
a real campaign vault (the live NAS vault is being curated concurrently; nothing in this run wrote under
a private QC folder (not in this repo), and no build output ever targeted the NAS `out`).

**What passed:**
- **Plain node, twice** (`spike/manifests/pin-5779522/manifest-node.txt` and
  `manifest-node-repeat.txt`): byte-identical between the two runs (**NFR-03 PASS**).
  `css/style.css`, `css/themes/horror.css`, every `js/*.js` (12), `js/lunr.js` and
  `css/overrides.css` are all present and correct under plain node.
- **FR-DEP-08**: `spike/manifests/pin-5779522/nonliteral-requires.txt` confirms `lib/build.js:25`
  (`require(resolvedConfigPath)`) is the only non-literal `require()` reachable from
  `bin/scriptorium.js` inside the pin's `lib/` tree.
- **Asset count**: from `PIN.json.files`, 6 css (`style.css` + 5 themes) + 12 js + 12
  templates-scaffold + `lunr.js` = **31**, matching the expected count.
- **Timings** (median of 3, vault on the live NAS CIFS share read-only, output to local scratch,
  not comparable to 0001's local-disk-only numbers per that ADR's own note):

  | Command | Median |
  |---|---|
  | `check` | ~404 ms |
  | `build --force` | ~757 ms |

**What is BLOCKED, with evidence (both newly discovered by this run; the 1.2.1 pin never exercised
either code path):**

1. **Every pkg-linux (and, by the same base-binary family, almost certainly pkg-win) build of this
   pin crashes.** `@yao-pkg/pkg` 6.22.0's `node22-linux-x64`/`node22-win-x64` base binaries are
   built `--with-intl=small-icu` (no break-iterator data). `lib/unicode.js:75` constructs an
   `Intl.Segmenter` at module load (harmless: pkg's own prelude patches the constructor, not the
   throw), but `graphemes()`/`truncateGraphemes()` call `.segment()`, which pkg's prelude patches to
   throw:

   ```
   RangeError: pkg: Intl.Segmenter is unavailable in this executable. It embeds a small-icu
   Node.js build with no break-iterator data, where calling segment() would crash the process
   (nodejs/node#51752). Re-package with --sea, which uses full-icu official Node.js binaries, or
   set NODE_ICU_DATA to a directory containing icudt78l.dat.
   ```

   `graphemes`/`truncateGraphemes` are reached from `lib/relationship-graph.js` and
   `lib/templates/landing-data.js`, both on the normal build path for any vault with at least one
   relationship or landing entry. Confirmed reproducing identically on the 2-NPC mini-vault test
   fixture, not just the real campaign vault, this is universal, not content-dependent. Root cause confirmed
   by reading `node_modules/@yao-pkg/pkg/prelude/bootstrap-shared.js:380-429` (the source, not
   guessed). Evidence: `spike/manifests/pin-5779522/manifest-pkg-linux.txt`,
   `manifest-spike-pkg-linux.txt`, `manifest-spike-pkg-linux-noshim.txt`, `selftest-pkg-linux.json`
   (all record the crash directly; `selftest-pkg-linux.json` includes the raw stack).

   Two remedies exist per pkg's own error text: `--sea` (this fork's experimental,
   reportedly-multi-platform SEA compile, which would need its own cross-compile verification since
   vanilla Node SEA cannot cross-compile and that was ADR 0001's stated reason for rejecting SEA in
   the first place) or bundling a full-icu `icudt78l.dat` and setting `NODE_ICU_DATA`. Both are
   packaging-**mechanism** changes: ADR 0001's domain, not a DEP-a Structural decision, and not
   applied here.

2. **`package.json`'s own `pkg.assets` glob is not fully honoured for this exact build invocation
   (no `-c` config file), independent of the ICU issue and independent of the pin.** Using a
   throwaway `Intl.Segmenter`-stub diagnostic entry file (not committed) to get a pkg-linux build
   past finding 1, built two ways with identical asset globs and identical `node_modules`:

   | Build style | js/ files present |
   |---|---|
   | plain node | 13 / 13 |
   | `bin/scriptorium.js` via package.json's own `pkg` field (no `-c`) | **5 / 13** |
   | `spike/bootstrap.js` via `-c spike/pkg.config.json` (ADR 0001's proven style) | 13 / 13 |

   The 8 missing files (`change-request.js`, `coc-live.js`, `coc-sheet.js`, `filters.js`,
   `lightbox.js`, `live-state.js`, `nav.js`, `search.js`) are exactly the `js/` files not also
   reached via `require()`-based static analysis; only the require-graph-discovered files and the
   files pkg's analysis can resolve via a literal path (`css/style.css`, `js/{coc-party,gurps-live,
   gurps-party,party-core}.js`) make it in when using package.json's own field with no `-c` flag.
   The declared `pkg.assets` glob (`"node_modules/gm-apprentice-publish/js/**/*"` etc.) appears to
   be silently under-applied for this specific configuration style. Confirmed independently on both
   the `node22-linux-x64` diagnostic build and the `node22-win-x64 --debug` build (neither's debug
   output, nor the diagnostic linux build's actual output tree, contains any of `css/themes/**`,
   `templates-scaffold/**`, or the 8 missing `js/*.js` files). Full detail and the exact A/B:
   `spike/manifests/pin-5779522/win-x64-assets-debug.txt`.

   **This predates the pin move** (ADR 0001's own proof used `spike/pkg.config.json`'s standalone
   `-c` style, never package.json's own field end to end against a real vault) and is not something
   this track's Structural decisions license fixing unilaterally (it would mean changing how the
   real product is packaged, not the generator dependency). Flagged for the Architect.

**Verdict for DEP-AC-03: NOT PASSED.** Half A's node-vs-pkg-linux manifest comparison could not run
to completion; both findings above need an Architect decision before a packaged `.exe` of this pin
is safe to ship. Nothing else in this ADR (the pin, the integrity mechanism, the staging fix, the
classifier, or `npm test`) depends on resolving this: `npm test` never builds or runs a pkg binary.

## Packaging findings resolved (DEP-a2)

Both findings above are fixed. The published `v0.1.0`/`v0.1.1` exes remain broken (see the runtime
verification below); a fresh `npm run package` build off `main` is not.

### Runtime verification of the published exes (ordered before any DEP-a2 edit)

Per the DEP-a2 brief, the exes were verified broken *before* any fix landed, so the "fixed" claim
below has a negative control to compare against.
`spike/manifests/pin-5779522/release-v0.1.x-verification.txt` records four steps against the actual
`v0.1.0`/`v0.1.1` release commits and shipped bytes:
- **V0**: both release commits' `scripts/package.js` invoke pkg on `bin/scriptorium.js`, no
  `-c`/`--config`/`package.json` input, identical at both commits.
- **V1**: grepping the downloaded, checksum-verified release exes for distinctive markers from
  `css/style.css` (present, 1/1 both exes) vs. `css/themes/horror.css`, `js/search.js`, `js/nav.js`,
  `templates-scaffold/vault.config.json.tmpl` (absent, 0/0, both exes).
- **V2**: rebuilding the exact v0.1.1 invocation as a Linux binary and running `build` against a
  real campaign vault export: the node build succeeds; the pkg-linux build fails,
  `ok:false`, with pkg's own `"File '.../css/themes/horror.css' was not included into executable at
  compilation stage"` error, and writes zero output files.
- **V3**: the same invocation with `--debug` at `-t node22-win-x64`: **0** `"Adding asset"` lines
  (the phrase `walker.js:439` emits only for `pkg.assets`-driven config assets), against 260 lines
  from pkg's separate static-require walk (unrelated files like `LICENSE`/`README.md`/`*.d.ts`) and
  8 hits for `css/style.css` alone (a literal `require()`, not the glob).

**VERDICT: BROKEN.** `build`/`serve --build` fail on both published exes for any genre vault
(the real campaign vault sets `publish.theme.genre: horror`); a no-genre vault would build but without client JS.
`check`, `status`, `config` and `update` don't read generator assets and stay valid on those
releases. Per the brief's decision for the owner, these two releases are kept (needed for the C22-C25
update-flow test path) with their notes to say so, rather than deleted or hotfixed.

### §1 fix: a Scriptorium-owned `Intl.Segmenter` shim (`src/generator/intl-shim.js`)

**Decision.** `installSegmenterShim()` replaces only `Intl.Segmenter.prototype.segment`, and only
when `segmenterDataMissing()` is true (the gate copied from
`node_modules/@yao-pkg/pkg/prelude/bootstrap-shared.js:399-415`:
`process.config.variables.icu_small === true`, and neither `de` nor `ja` resolves in
`Intl.DateTimeFormat`). It never calls native `segment()` to probe, on small-icu that is an
uncatchable SIGSEGV (`bootstrap-shared.js:383-389`), not a catchable error. It patches the
*prototype method*, not the constructor: the pin constructs its one `Intl.Segmenter` at module load
(`lib/unicode.js:75`), and method lookup happens at call time, so an instance built before install
still picks up the shimmed method the first time it's called, pkg's own prelude relies on the same
property (`bootstrap-shared.js:419-423`). Scope is grapheme granularity only (`unicode.js:75` is the
pin's only construction, always `{granularity:'grapheme'}`, reached from
`templates/landing-data.js:69` and `relationship-graph.js:191`); any other requested granularity
throws pkg's own `RangeError` text, since this shim implements nothing else.
`src/generator/bootstrap.js`'s `runGeneratorBuild` installs it next to the pre-existing
`copyFileSync` shim and restores both in `finally`; `spike/bootstrap.js` always installs it too
(`--no-shim` there still only toggles the copyFileSync shim, unchanged from ADR 0001).

**Algorithm.** `graphemeSegments()` implements UAX #29 extended grapheme cluster boundary rules
GB3-GB13 via ECMAScript regex Unicode property escapes (`\p{Grapheme_Extend}`,
`\p{Extended_Pictographic}`, `\p{Regional_Indicator}`, `\p{Mc}`) plus Hangul syllable block
arithmetic and U+200D (ZWJ). It deliberately omits **GB9b (Prepend)**, rare, and not needed for
anything the pin's own corpus (NPC/location titles) is expected to contain, and **GB9c (Indic
conjunct clusters, Unicode 15.1)**, not expressible with the binary property escapes ECMAScript
regex ships without a bespoke Indic conjunct-break data table. `test/intl-shim.test.js`'s corpus
(ASCII, precomposed/decomposed Latin, stacked combining marks, CRLF, emoji ZWJ families, skin-tone
modifiers, regional-indicator flag pairs and an odd-count run, decomposed and precomposed Hangul)
matches native `Intl.Segmenter` exactly on plain node, where both are available to compare, the
open question the brief flagged ("the property escapes are backed by ICU property data compiled
into the library code... that's unproven") is now proven: `selftest-pkg-linux.json`'s
`regexPropertyEscapes` and `graphemeSegmentsCorpus` probes both pass inside the pkg-linux binary
(see below).

**Rejected** (unchanged from the brief's own analysis, recorded here for the ADR trail):
- **A full-ICU pkg base**: pkg-fetch hard-codes small-icu for node22, and win-x64 can't be
  cross-compiled from Linux, so it would need a Windows MSVC build machine.
- **`NODE_ICU_DATA`/`--icu-data-dir`**: needs a real directory at startup, a ~30 MB `.dat` beside
  the exe (breaking single-file) or extract-and-reexec (F2, needs orchestrator approval).
- **`--sea`**: downloads official full-icu binaries per target, changes the packager (ADR 0001's
  domain), and its VFS over assets is unproven. Fallback only, with orchestrator approval, if the
  shim had failed on Windows.
- **Substituting `unicode.js` in the require cache**: patching the dependency by the back door,
  the one option this track's red line rules out unconditionally.

### §2 fix: `package.json` as pkg's input (`scripts/package.js`, `scripts/pkg-assets.js`)

**Root cause, from pkg's source.** pkg reads a `pkg` field from `package.json` only when
`package.json` is the build input, or from an explicit/auto-discovered config file
(`node_modules/@yao-pkg/pkg/lib-es5/config.js`). With `bin/scriptorium.js` as input (both releases'
invocation): `inputJson` stays `undefined` (`config.js:525`, `isConfiguration` at `:58-61`);
auto-discovery only looks for `.pkgrc`/`.pkgrc.json`/`pkg.config.{js,cjs,mjs}` (none exist in this
repo); so `marker.config = inputJson || {}` (`index.js:50-57`), and `appendFilesFromConfig` finds no
`pkg.assets` at all (`walker.js:410-451`), **the glob list is ignored entirely**. Only files pkg's
own static require-graph walk finds (`css/style.css` via a literal `path.join(__dirname, ...)`,
`lunr` via `require.resolve`, plus unrelated node_modules metadata) get embedded.

**Fix.** `scripts/package.js`'s `buildInvocation()` makes pkg's input `package.json` itself, never
adding `-c` (pkg rejects package.json input plus `-c`, `config.js:560-562`). pkg then follows
`package.json`'s `bin.scriptorium` to `bin/scriptorium.js` (`config.js:532-546`), sets its asset-glob
base to the repo root, and, because the input IS `package.json`, actually reads `pkg.assets`. The
globs themselves were already correct; only the invocation was wrong.
`scripts/package.js` is now the single invocation path for both the release build (`npm run
package`, win-x64 default, `dist/v<version>/`) and the Linux proof
(`spike/run-pin-proof.sh`'s `--target`/`--out` overrides), with a `require.main` guard so requiring
it (from tests, or from the proof script's own node snippets) never triggers a real build.

**The regression gate.** `scripts/package.js` runs pkg with `--debug`, captures the output (a large
`maxBuffer`; pkg's win-x64 `--debug` output ran to 729KB in an earlier evidence file), and hands it
to `scripts/pkg-assets.js`'s `assertAssetsEmbedded()`. `parseEmbeddedAssets()` parses the exact
rendered form of `walker.js:439`'s debug line, confirmed from a real run: `log.debug()` prints `>
[debug] Adding asset : .... ` on one line and the asset's own absolute path as the *next* line
(`@yao-pkg/pkg-fetch/lib-es5/log.js`'s `Log#debug`/`Log#lines`); `expectedAssets()` expands
`pkg.assets` over disk via `vendor/gm-apprentice-publish/PIN.json`'s file list (31 entries: 6 css +
12 js + 12 templates-scaffold, plus `node_modules/lunr/lunr.js`). Any missing asset removes the
output and exits 1 before `SHA256SUMS` is written, DEP-AC-01's "never ship a corrupted/incomplete
exe" guarantee, extended from the generator pin to the packaged asset list. `test/package-config.test.js`
asserts, without running pkg: the invocation uses `package.json` with no `-c`/`--config`;
`expectedAssets()` equals the PIN.json-derived 31-entry set; and a change detector confirms every
`path.join(__dirname, '../<dir>...')` read on the pin's build path (`lib/build.js:86,94,117`,
`lib/init.js:4`, `lib/sync-functions.js:5`) sits under one of `pkg.assets`' three covered prefixes
(`css`, `js`, `templates-scaffold`), an early warning if a future pin adds a fourth `__dirname`-relative
directory the glob doesn't cover.

### Proof results (re-run in full for DEP-a2, `spike/run-pin-proof.sh`)

- **AC-a2-1 (Finding 2)**: `npm run package` exits 0; `spike/manifests/pin-5779522/win-x64-assets.txt`
  lists all 31 expected assets (parsed from the real `--debug` output of the actual
  `dist/v0.1.1/scriptorium-win-x64.exe` release build). **Negative control**: running
  `assertAssetsEmbedded()` against V3's old-invocation debug log
  (`bin/scriptorium.js` input, 0 "Adding asset" lines) reports `ok:false` with all 31 assets named
  missing.
- **AC-a2-2 (Finding 1)**: `test/intl-shim.test.js` (25 tests: the full corpus, pre-install-instance
  reuse, non-grapheme throw, `restore()`, the `segmenterDataMissing()` gate) and
  `test/generator-grapheme-parity.test.js` (2 tests: `test/fixtures/grapheme-vault` built via the real
  generator, byte-identical whether `installSegmenterShim({force:true})` is active or not; horror
  theme CSS and 4/4 truncated `…` graph labels present) both pass.
  `spike/manifests/pin-5779522/selftest-node.json` and `selftest-pkg-linux.json` agree on every probe
  (`nfdLength`, `intlSegmenter`, `regexPropertyEscapes`, `slugifyGonzalez`, `graphemesEAcute`,
  `graphemeSegmentsCorpus`, `truncateGraphemesLongTitle`), `ok:true` on both, including inside the
  actual pkg-linux binary, where `graphemesEAcute`/`truncateGraphemesLongTitle` (the pin's *own*
  `lib/unicode.js` functions) previously threw pkg's `RangeError` before `spike/bootstrap.js`'s
  `runSelftest` was updated to install the shim too, not only `runBuild`.
- **AC-a2-3 (DEP-AC-03, full re-run)**: on both a real campaign vault export and `grapheme-vault`,
  plain-node equals pkg-linux (`manifest-node.txt`/`manifest-pkg-linux.txt`: identical;
  `manifest-grapheme-node.txt`/`manifest-grapheme-pkg-linux.txt`: 39 files identical), and node
  equals node-repeated (NFR-03, identical). `css/themes/horror.css`, all 12 `js/*.js`,
  `js/lunr.js` and `css/overrides.css` are confirmed present in every manifest. The shim-on/shim-off
  spike manifests are identical. The win-x64 gate passes (`npm run package` exit 0, 31/31
  assets). Timings (single run, CIFS-backed, a real campaign vault export via the live NAS site config, local
  scratch output): node build 225.1ms / repeat 222.1ms / pkg-linux 195.3ms;
  grapheme-vault node build 51.0ms / pkg-linux 37.3ms (39 files).
- **AC-a2-4**: `npm test` is green (170 tests total, including every pre-existing D5 test
  unmodified). `package.json` stays `0.1.1`.
- **AC-a2-5**: one commit on `main`, no push.

No STOP condition fired: every selftest probe agreed in the pkg-linux binary (including after fixing
`spike/bootstrap.js`'s selftest to install the shim, which is itself evidence the STOP-condition check
was doing real work, not rubber-stamping); the shim corpus never diverged from native ICU outside the
documented GB9b/GB9c gap; and the embedded set reached the full 31 once the input changed.

## D2 coverage gap: the shim didn't cover the facade (2026-09-17)

**Bug.** QA found the packaged exe throws, deterministically, on `check` and `build --force` against
any vault with withheld names present in built output: `RangeError: pkg: Intl.Segmenter is
unavailable...`, from `lib/unicode.js:78`, via `src/checks/leak/outputscan.js`'s `needleFormsFor` ->
`pinned.truncateGraphemes` -> `scanStagingOutput`. Reproduced 2/2 with an identical stack. `status`,
`config list`, and `check` with no built output present were unaffected; plain `node` was unaffected,
which is why 358 tests and four Reviewer passes missed it, every test ran under node, never the
packaged artefact.

**Root cause.** DEP-a2's shim (`src/generator/intl-shim.js`) was real and correct, but
`installSegmenterShim()` was only called from `src/generator/bootstrap.js`'s `runGeneratorBuild`,
wrapped install/restore around its own direct `gm-apprentice-publish` `build()` call. Track D2's
output-leak scan (added after DEP-a2, `4b682db`) reaches the pin's `truncateGraphemes` a different
way, through `src/generator/pinned.js`, the facade, and never through `runGeneratorBuild`, so it
never triggered installation. On `check` (no build at all) and on `build --force` (whose scan runs
after `runGeneratorBuild`'s own `finally` has already restored native `Intl.Segmenter`), the packaged
exe's native small-icu `segment()` was reached unshimmed.

**Fix.** `installSegmenterShim()` is now also called, unconditionally and with no `force` override, at
the top of `src/generator/pinned.js`'s own module body, before any of its exports, including
`truncateGraphemes`, exist. `pinned.js` is documented as, and verified by inspection to be, the only
Scriptorium module that requires the pin's unicode functions. Six files in `src/` require the
facade itself (`l2.js`, `l3.js`, `l4.js`, `textmodel.js`, `outputscan.js`, `publishset.js`), but
that is callers of the facade, not callers of `truncateGraphemes` specifically: the function has
exactly one real call site in the whole tree, `src/checks/leak/outputscan.js:118`
(`pinned.truncateGraphemes(name, 15, 13)`); `publishset.js` requires the facade but never calls
`truncateGraphemes`. Nothing else in `src/` deep-requires `gm-apprentice-publish/lib/unicode.js` (`redactions.js`,
`scripts/equivalence-check.js`, and `spike/bootstrap.js`/`spike/pkg.config.json` deep-require other
pin files, never `unicode.js`; `spike/bootstrap.js` is Phase-0 spike harness code, not reachable from
`bin/scriptorium.js`'s module graph, and installs the shim itself regardless). Because `require()` runs
a module's whole body before returning its exports, and nothing can obtain `truncateGraphemes` except
by requiring `pinned.js`, this closes the gap by construction for every current and future caller, not
by each caller remembering to install the shim. `src/generator/bootstrap.js`'s own install/restore is
left in place (it still needs to cover the direct `build()` call, which does not go through the
facade at all) and is now cross-referenced to `pinned.js` in its own comment, so a future reader does
not assume it is the complete picture.

**Regression test (`test/generator-pinned-segmenter-shim.test.js`).** `process.config.variables` is
frozen on every dev/CI box here (`Object.getOwnPropertyDescriptor(...).writable === false`), so
`segmenterDataMissing()`'s real small-icu gate cannot be forced true in-process, and a plain-node test
that just calls `pinned.truncateGraphemes()` and checks the string cannot tell "the shim installed and
was a no-op because ICU is fine" apart from "nothing ever tried to install it", node was never the
broken case, so that kind of test would prove nothing. Instead the test intercepts `require.cache` for
`intl-shim.js` ahead of a fresh `require()` of `pinned.js`, with a wrapper that force-installs (the
same technique `test/intl-shim.test.js` already uses) and records the call. It asserts: requiring
`pinned.js` calls `installSegmenterShim()` exactly once, with no arguments (so the real gate still
governs it, nothing is silently forced in production); `Intl.Segmenter.prototype.segment` is patched
before `pinned.js` returns its exports; and `truncateGraphemes` then matches `intl-shim.js`'s own
`graphemeSegments` truncation end to end. Run against a copy of the pre-fix `pinned.js` (`git show
c803fcf:src/generator/pinned.js`, loaded the same way), the install-call assertion fails 0 !== 1,
this is a genuine discriminator, not a test that would have passed either way. What it does **not**
cover: it never runs inside a real packaged pkg exe, so on its own it cannot prove the RangeError is
actually gone in production, only that the wiring exists. That proof is the manual run below,
following this repo's existing precedent that `scripts/package.js`'s asset gate and rules-content gate
are unit-tested at the function level with the real-build proof done manually and recorded here rather
than run inside `npm test` (a full packaged-binary build needs pkg's fetched binary cache and takes
real wall-clock time, which does not belong in every `npm test` run).

**Manual packaged-binary proof (2026-09-17, `git archive` export of the live real campaign vault
into local scratch, never a private QC folder (not in this repo); build output only ever written to scratch).**

- **Negative control**, packaged from `c803fcf` (pre-fix) via `scripts/package.js --target
  node22-linux-x64`: `check` against an existing built tree and `build --force` against the same vault
  each threw the exact reported stack (`lib/unicode.js:78` -> `graphemes` -> `truncateGraphemes` ->
  `needleFormsFor` -> `scanOutputTree`/`scanStagingOutput` -> `runChecks`/`runAtomicBuild` ->
  `runCheckCommand`/`runBuildCommand`), 2/2, matching QA's report exactly.
- **Fixed binary**, same packaging invocation off the fixed tree: `check` exits 2 with
  `{"error":115,"warn":211,"info":2}` (no crash); `build --force` exits 0, `pagesWritten` matching,
  `outputScan.overridden: true`, `50` output-leak findings overridden, both counts identical to a
  plain-node run of the same commands against the same vault export.
- **Byte-identity**: a plain-node `build --force` and the fixed packaged-binary `build --force`,
  against the same real campaign vault export, produce sha256-identical output trees, so the
  fix is not merely "does not crash" but produces the same grapheme truncation the un-shimmed native
  path would have, matching DEP-a2's own `graphemeSegmentsCorpus` parity claim, now confirmed against
  this vault's real name corpus rather than only the synthetic `test/intl-shim.test.js` corpus.

## Network posture

- `child_process` is reached from exactly `lib/image-optimize.js` and `lib/run-command.js`
  (confirmed by `test/generator-module-graph.test.js`); neither makes a network call on the build
  path. `lib/run-command.js` is reached via `lib/build.js` → `lib/backend-flags.js` →
  `lib/inbox-wrangler.js` → `lib/run-command.js` (backend detection), and `lib/image-optimize.js`
  directly from `lib/build.js`.
- `http`/`https` are required only in `lib/deploy-cli.js:50`; that file is never reached from
  `bin/scriptorium.js`'s module graph (`test/generator-module-graph.test.js`).
- `images.optimize` (`lib/image-optimize.js`, shells out to an external image encoder) is off by
  default, the real campaign's site config does not set it, and it remains **unverified inside the
  packaged exe**, out of scope for this track, noted here per the brief.
- **Correction (DEP reviewer pass 2026-09-11):** the network-builtin and forbidden-file assertions
  in `test/generator-module-graph.test.js` originally filtered to the pinned generator's `lib/` dir
  only, so an `https` require added to Scriptorium's own `src/build/notice.js` (reached from the
  same graph walk) went undetected. Both assertions now cover the whole walked graph
  (`graph.files`), not just `node_modules/gm-apprentice-publish/lib/**`. One pre-existing,
  legitimate exception is allowlisted explicitly in the test (`NETWORK_BUILTIN_ALLOWLIST`), not
  filtered out by directory:
  - `src/serve/server.js` requires `http` because it IS the `serve` command's local HTTP server
    (binds `127.0.0.1` by default, see `docs/decisions/0002-serve-binds-localhost.md`). That is
    Scriptorium's own, deliberate, user-facing local server, unrelated to the generator/build
    network posture this test guards, and pre-dates DEP entirely.
  - No other file in the whole graph requires a network builtin, and no file in the whole graph is
    named `deploy-cli.js`, `inbox-cli.js` or `flush-cli.js` (verified directly, not just under
    `lib/`).

## Supersession

This ADR supersedes:
- ADR 0001's dependency-clause evidence and asset list (0001 now carries a status line pointing
  here; its **packager decision itself stands unchanged**, this ADR does not reopen `@yao-pkg/pkg`
  vs. the fallback ladder, only documents that the packaging *proof* for the shipped config, run
  for real for the first time in this track, is currently blocked);
- Engineering Brief §2/§14's npm-registry pin clause;
- the evidence behind `docs/ACCEPTANCE-RESULTS.md:14`'s acceptance criterion 4 (npm-registry
  integrity, retained in the private archive at `b5b48b4`), now replaced by `PIN.json`/`treeSha256`.

## Addendum: repin to publish-v1.11.40 (78696167), release-tarball pin source (R1, 2026-09-30)

### New pin source: the release tarball, not a source-tree `npm pack`

At `78696167`, `tools/publish` declares `bundleDependencies: gray-matter, lunr, markdown-it`, and
ships its own `node_modules` inside the package. `DEFAULT_OMIT`'s first rule ("npm pack: no
bundleDependencies") is now false, and a source-tree `npm pack` can no longer reproduce the
release artefact, the mechanism has to change from "derive a manifest from a checkout, vendor
what `npm pack` there would produce" to "vendor the release artefact itself, and prove it's the
thing upstream actually shipped."

- **Vendored:** the release's own `gm-apprentice-publish-1.11.40.tgz` and `SHA256SUMS`, byte-for-byte
  (`cmp` against the release, and against an independent re-download from the GitHub release URL,
  both legs pass).
- **`PIN.json`'s manifest** is `manifestOf(<extracted tarball>/package)`, **no omit rules at all**.
  `DEFAULT_OMIT` and the source-tree `derivePin` are deleted from `scripts/generator-pin.js`, not
  corrected, SD-1's rejected alternative, "a corrected `DEFAULT_OMIT`", would re-implement npm's
  own bundling semantics by hand and drift again the next time npm's packing behaviour does.
- **The authoritative cross-check is a reproducible build**, per the maintainers' ruling
  on the pin source (which won over the original plan where the two disagreed, and is kept in
  the private archive): a fresh checkout, `npm ci --ignore-scripts` in
  `tools/publish` (installs from upstream's own `package-lock.json`, integrity-checked registry
  packages), then `npm pack`. The extracted result must equal the extracted release in files and
  `treeSha256`. `derivePinFromTree` refuses to write on any mismatch.
- **A plain-checkout pack is explicitly rejected as authoritative**, with a real mechanism, not a
  guess: `npm-packlist` applies each bundled dependency's own `package.json` `files` allowlist only
  when Arborist reads that `package.json` from disk, which happens exactly when there is no hidden
  `node_modules/.package-lock.json` to build the installed tree from instead. A plain checkout has
  no such file (upstream gitignores it), so `npm pack` there applies each bundled package's `files`
  field and drops anything not listed, at this pin, 5 changelog paths across 4 packages
  (`argparse` in two places, `esprima`, `gray-matter`, `kind-of`). After `npm ci`, the hidden
  lockfile exists, Arborist reads bundled-dependency metadata from it instead (which carries no
  `files` key), and the whole directory packs, changelogs included, reproducing the release
  exactly. Proven three ways, not asserted: (a) `npm ci` then pack equals the release byte-for-byte;
  (b) deleting only the hidden lockfile from that same `npm ci` tree and re-packing reproduces the
  plain-checkout pack byte-for-byte (the toggle, isolated); (c) the 5-path release/plain-pack
  difference is exactly the paths outside their package's own `files` field, checked by hand against
  each package's real `package.json`.
- **Rejected:** npm-pack-only (cannot prove the released artefact, as the mismatch above
  demonstrates directly); a corrected `DEFAULT_OMIT` (re-implements npm's rules, see above); holding
  R1 as an upstream defect (rejected by the ruling, the artefact reproduces exactly under the
  reproducible-build procedure; there is nothing wrong with what was released, only with how a
  plain-checkout pack tries to verify it).
- **The commit stays the pin of record.** `publish-v*` tags are immutable per upstream's own README
  ("created once and never moved"), but remain labels only, per this ADR's original decision.

### `PIN.json` shape (amended)

- `source: { kind: "release-tarball", url }`, `tarball`, `tarballSha256`, `sums`.
- `crossCheck: { method: "npm-ci-pack", npmVersion, treeSha256 }`, `crossCheck.treeSha256` must
  equal the top-level `treeSha256` (both come from the same reproducible-build tree).
- `omitted` is gone entirely (no omit rules exist to record).
- `verifyInstalled` now checks the vendored tarball's sha256 against `PIN.json.tarballSha256` and
  the vendored `SHA256SUMS`, and fails closed if `crossCheck` is absent, its `method` isn't
  `"npm-ci-pack"`, or its `treeSha256` disagrees with the pin's own. It never repeats the
  cross-check itself, that needs the network and only happens when the pin moves.

### The dependency set (amended from the original table)

Bundled inside `node_modules/gm-apprentice-publish/node_modules/` (18 packages, from the extracted
release tree, read by hand): `argparse@1.0.10`, `entities@4.5.0`, `esprima@4.0.1`,
`extend-shallow@2.0.1`, `gray-matter@4.0.3`, `is-extendable@0.1.1`, `js-yaml@3.14.2`,
`kind-of@6.0.3`, `linkify-it@5.0.0`, `lunr@2.3.9`, `markdown-it@14.1.1`,
`markdown-it/node_modules/argparse@2.0.1`, `mdurl@2.0.0`, `punycode.js@2.3.1`,
`section-matter@1.0.0`, `sprintf-js@1.0.3`, `strip-bom-string@1.0.0`, `uc.micro@2.1.0`.

Top-level entries removed from `package-lock.json` because their only dependant traced to the
generator (proved with a lockfile-graph read against PARENT, mirroring `npm ls <name>`): `entities`,
`linkify-it`, `lunr`, `markdown-it`, `markdown-it`'s own nested `argparse`, `mdurl`, `punycode.js`,
`uc.micro`, lunr and markdown-it's own subtree, exactly as expected. `gray-matter` stays a
top-level Scriptorium dependency (`4.0.3`, unchanged) alongside the bundled copy at the same
version, two separate resolved copies from here on, since Scriptorium's own `src/vault/read.js`
and the generator now parse frontmatter with different `gray-matter`/`js-yaml` installations (a
residual, not a defect: nothing requires them to be the same copy).

**Bundled dependencies can't be patched through Scriptorium's own lockfile.** `package-lock.json`
records their versions as `inBundle: true` entries inside the tarball's own dependency tree; there
is no top-level resolution for `npm audit fix`, an override, or a manual bump to act on. A
vulnerability in a bundled package can only be fixed by a new upstream pin.

### `pkg.assets` and the bundled lunr identity (FR-17)

`package.json:24` and `scripts/pkg-assets.js` now name
`node_modules/gm-apprentice-publish/node_modules/lunr/lunr.js`, not a top-level
`node_modules/lunr/lunr.js` (which no longer exists, lunr is bundled, not hoisted).
`src/generator/pinned.js` requires `gm-apprentice-publish/node_modules/lunr` by the same literal
path, so the facade's `lunr` is provably the exact module the generator's own `lib/search-index.js`
resolves (AC-D2-09), never a second, independently-resolved copy. Packaged asset count stays **61**.

### Network posture (amended)

Two network capabilities enter the generator's module graph at this pin, both reached through
`opts.fetch || globalThis.fetch` / an injected `fetchFn` rather than a literal
`require('http')`-shaped call, which the pre-existing static scan (builtin requires only) cannot
see: `lib/fonts.js`'s self-host font prefetch (`prefetchForConfig`/`ensureFontCache`, #270) and
`lib/update-pin.js`'s release-pin updater (`runUpdatePin`/`runUpdatePinTag`), reached lazily via
`build.js` → `manifest-cli` → `site-pin` → `update-pin`. Scriptorium never calls either entry point
(OD-6/OD-8; `bin/scriptorium.js`'s module graph names neither identifier, a new static assertion
in `generator-module-graph.test.js` guards this). `lib/fonts.js:267`'s `require(resolved)` is a
second non-literal `require()` reachable from `bin/scriptorium.js`, alongside `lib/build.js:32`'s
pre-existing `require(resolvedConfigPath)` (FR-DEP-08).

Two guards now exist, layered:
1. **Static**, additive assertions in `generator-module-graph.test.js`: no reached file matches a
   network-capability token (`fetch`, `.fetch(`, `fetchFn`/`fetchImpl`, `WebSocket`,
   `EventSource`, `XMLHttpRequest`, `require('undici')`) outside an exact, justified allowlist
   (`lib/fonts.js`, `lib/update-pin.js`, `src/generator/netguard.js` itself, the pre-existing
   browser-only `js/party-core.js`, and Scriptorium's own pre-existing `src/cli/update.js`/
   `src/update/release.js`, governed separately by `test/update-module-graph.test.js`).
2. **Runtime**, `src/generator/netguard.js`'s `installNetworkGuard()`, installed at module load in
   both `src/generator/pinned.js` and `src/generator/bootstrap.js` (idempotent; whichever loads
   first performs the real install). Replaces `globalThis.fetch`/`WebSocket` with a guard function
   via `Object.defineProperty` getter/setter, so a later plain reassignment cannot remove it; throws
   a `ScriptoriumError` and counts attempts. Process-lifetime, not scoped to any one call (SD-19's
   own rejected alternative: scoping to `runGeneratorBuild` misses async continuations). No new
   exit code, a blocked call surfaces as an ordinary build failure.

A pre-existing bug was found, and is reported rather than fixed here, in
`generator-module-graph.test.js`'s shared `stripComments`/`walkModuleGraph`: a `//` line comment
containing a `/*`-shaped substring (`lib/build.js`'s own `// ... static css/themes/*.css file ...`)
is misread as an unterminated block-comment start and silently swallows real code, including
several real `require()` calls, up to the next unrelated `*/` anywhere later in the file. The new
static assertions above use their own, locally-scoped, correctly-ordered comment stripper instead
of fixing the shared one, because fixing it is a non-additive edit to a file this track's
constraints reserve as an escalation. Checked directly: the bug does not change any *existing*
assertion's truth value in that file today.

### Packaging proof (this repin)

`npm run package`: both targets built, one combined `SHA256SUMS` written, the Linux target's
packaged startup self-test passed (`--version` exited 0, reporting `0.3.0-rc.3`). All five
per-target gates passed for both targets (generator-pin verification against the live v1.11.40
pin, notices freshness, 61-asset embedding, rules-content markers, the packaged self-test).

### Step-8 deviation (pin-bump procedure "Verify")

`npm install --save file:vendor/.../gm-apprentice-publish-1.11.40.tgz` rewrote
`package-lock.json`'s root `"version"` from the stale `"0.1.1"` to the real `package.json` version
(`"0.3.0-rc.3"`) as a side effect of resolving the new dependency spec, restored to `"0.1.1"`
per the pin-bump procedure's own instruction ("Restore the root `"version"` to 0.1.1 if npm
rewrote it"), keeping the notices diff to the intended scope (CLAUDE.md's release procedure: the
stale root version is left alone deliberately, to avoid widening the notices diff mid-release).
`rm -rf node_modules && npm ci` afterward reproduces the installed tree exactly; `npm run
verify-generator` passes both before and after.

### Pointer: executable-frontmatter guard (ADR 0034)

`docs/decisions/0034-executable-frontmatter-guard.md` freezes the generator's own bundled copy of
its frontmatter parser to a YAML-only engine table for the life of the process, and binds that
freeze by hash to four of that parser's own files. A pin move must, in addition to this
document's existing "Pin-move procedure":

- re-verify `src/generator/fmguard.js`'s `BOUND_PIN_FILES` against the new `PIN.json` (all four
  hashes; a mismatch is the intended signal that the freeze needs a human re-read, not a bug to
  route around);
- re-grep the generator's own frontmatter-reading call sites, and the two scans it runs during a
  build, against ADR 0034's own walk-set table, in case the new version adds one;
- keep the single, literal reference to the generator's bundled parser, and its identity test,
  green.

## Addendum: repin to publish-v1.11.44 (cf721e0f), 2026-10-01

A routine pin bump along the release-tarball procedure, from `publish-v1.11.40` (`78696167`) to
`publish-v1.11.44` (`cf721e0f7ad8e59695d85dd9f0320da6de74e8ed`). It takes in four upstream
releases: 1.11.41 (handout Keeper sections withheld, upstream #280; piped CLI output drained,
#279), 1.11.42 (the D&D 5e PC sheet rendered from the template's own body sections, #271) and
1.11.43 (the same for Pathfinder 2e and Forged in the Dark, #272, with the D&D parsing moved into
two shared files) and 1.11.44 (a build warning when a PC publishes with no character sheet, #273,
and a fix to the PC pull quote that 1.11.43 had narrowed). The branch was first prepared at
`publish-v1.11.42` and moved on as 1.11.43 and 1.11.44 were released the same day; the procedure
was run in full at each pin, and the figures below are the 1.11.44 ones.

### What the procedure found

- **Release artefact.** Tarball sha256
  `cb3ff9b0a869465bdd7ad3b007cdddbd25e5345a64bdc6deb31f0af53a9b169a`, checked against upstream's
  `SHA256SUMS`; two independent downloads of both files are byte-identical. The tag is a
  lightweight tag on the pinned commit.
- **Reproducible-build cross-check.** A second fresh checkout, `npm ci --ignore-scripts`, `npm
  pack`: `diff -rq` clean against the extracted release, 519 files, `treeSha256`
  `22396cf7762a18636436c1bdb79d94ecc213c92b5a9a08f32fdd236cbaba5114`. Run with npm 11.8.0 on macOS
  (recorded in `PIN.json`'s `crossCheck.npmVersion`), not the 10.9.8 the previous repin used.
- **Dependency set: unchanged.** Fifteen files differ from `publish-v1.11.40` and three are new,
  all the generator's own: `bin/gm-publish.js`, `css/style.css`, `lib/build.js`, `lib/excerpt.js`,
  `lib/explain-cli.js`, `lib/processor.js`, `lib/sheet-cli.js`, `lib/site-doctor.js`,
  `package.json`, and under `lib/templates/`: `pc.js`, `pc-dnd.js`, `pc-fitd.js`, `pc-pf2e.js`,
  `pc-registry.js`, `coc/index.js`, plus the new `d20-sheet.js`, `sheet-parse.js` and
  `lib/sheet-source.js`. No file under the bundled `node_modules/` changed, so the bundled
  `name@version` set, the provenance audit and `fmguard.js`'s four bound hashes all carry over.
  The notices diff is the generator version line, the pinned commit and the lockfile hash.
- **Lockfile.** Allowed hunks only (the root dependency spec and the `gm-apprentice-publish`
  entry). `npm install` rewrote the root `name`/`version` and reformatted `package.json`'s
  `pkg.patches`; both restored. `rm -rf node_modules && npm ci` reproduces, and
  `verify-generator` passes before and after. No top-level `node_modules/lunr`; the bundled copy
  is at `node_modules/gm-apprentice-publish/node_modules/lunr/lunr.js`, as before.
- **Network and parser posture: unchanged.** The upstream diff adds no network call, no new
  frontmatter-parsing call site and no `eval`.
- **Rules-content scan.** `PIN_SCAN_BASELINE` has one new entry (a comment in
  `lib/templates/pc-registry.js` naming two systems) and five moved line numbers (one in
  `css/style.css`, four in `lib/templates/pc.js`), each re-read by hand and unchanged in content.
  The sheet files the scan pattern does not cover were read by hand: `pc-dnd.js`, `pc-pf2e.js`,
  `pc-fitd.js`, `d20-sheet.js` and `sheet-parse.js` parse tables the vault author wrote and hold no
  skill list, action list, spell list or other reproduced rules text. What they do hold is
  display vocabulary: the six ability abbreviations, the five Pathfinder proficiency rank names
  (`pc-pf2e.js:11`), and the labels "Stress" and "Trauma" (`pc-fitd.js:32`, `:37`). Whether those
  need a provenance note is the owner's call; none is a table of rules data. Both
  redacted files are byte-identical to the old pin.
- **`filterSections` changed, and was re-read by hand** (procedure step 9). The `!excluding &&`
  guard that retired ADR 0013's patch is intact. Two behaviours are new: an ATX closing sequence
  is no longer part of a heading's title (`## GM Notes ##` is now excluded as "GM Notes"), and
  the function takes the page's frontmatter as a third argument, withholding a handout's Keeper
  sections on a `type: document` page. The first needs nothing here, since the model calls the
  pin's own function. The second did: `src/checks/leak/textmodel.js` called it with two
  arguments, so `check` would have read sections a build withholds. It now passes the page's raw
  frontmatter for body text, which is what the build's `page.sourceFrontmatter` holds
  (`lib/build.js:484`). Story text gets none, because the build renders it from a page object
  whose frontmatter is `{}` (`lib/build.js:775-779`, `:1153`). `test/textmodel-pin.test.js` has
  the tests: three were written first and failed before the change, and each of three mutations
  (argument dropped, story text given the frontmatter, the published frontmatter passed in place
  of the raw one) turns at least one red.
- **Line citations re-derived** (procedure step 7). `lib/processor.js`, `lib/build.js` and
  `lib/templates/pc.js` all gained lines, and `test/pin-citations.test.js` only checks that a
  cited range exists. Every citation into those files, under `src/` and in
  `docs/COLLABORATING.md`, was moved to the same content at the new pin, each matched by line
  content against the old tree. Citations inside ADRs are left as written: they are dated
  records of the pin they were written against.
- **Two line-bound change detectors moved.** `lib/build.js` gained two requires at the top of the
  file at 1.11.44, which moved the lines `test/package-config.test.js` (the three
  `path.join(__dirname, …)` asset reads) and `test/generator-module-graph.test.js` (the non-literal
  `require(resolvedConfigPath)`) record by number. Both went red, as designed. The set of
  `__dirname` reads (11) and non-literal requires (4) across `lib/` and `bin/` is identical in
  content between 1.11.43 and 1.11.44, so the recorded lines were moved by two and nothing was
  added to either list. This edits a test in a file CLAUDE.md lists under constraints; it follows
  that test's own comment about the same move at an earlier pin, and wants the owner's eye.
- **Equivalence check** (step 10): clean on `mini-vault`, `story-vault` and `wrapup-vault`.
- **Session pairing** (step 10b): no change detector moved.

### What this does not prove

- **The packaged executables.** `npm run package` was run on a macOS host and exited 0: both
  targets built, with the pin, notices-freshness, asset-embedding and rules-content gates passing.
  The fifth gate, the packaged startup self-test, was skipped, because that host is not linux-x64
  and cannot run either binary. So no packaged executable has been started at this pin, and
  nothing here is evidence about the win-x64 artefact. Re-run `npm run package` on the Linux build
  host before a release.
- **The test suite on Linux.** `npm test` on that macOS host: 2909 tests, 2897 or 2898 pass, and the
  11 that always fail also fail there on the commit before this repin (they assert a Linux host:
  case-sensitive paths, `process.arch`, stdin EOF behaviour). A twelfth, the 413 upload-size test,
  fails intermittently on that host on both commits. Not run on Linux.
- **The Windows C1 manifest.** `docs/HANDOVER-WINDOWS.md`'s `c1-manifest-node.txt` was generated at
  `publish-v1.11.40`. The pin's `css/style.css` changed (at 1.11.42 and again at 1.11.43), so it no
  longer matches a build at this pin. It is marked stale there and has not been regenerated.
- **The handout rule end to end.** The new tests exercise the text model directly. No fixture
  vault has a `type: document` page with a Keeper section, so no real build-plus-check run covers
  it yet.
- **How the new sheets look under Scriptorium's stylesheets and themes.** The D&D, Pathfinder and
  FitD sheet markup is new (`.dnd-ability-card`, `.fitd-tracker` and friends, styled by the pin's
  own `css/style.css`). No transform
  here matches it and none broke, but nobody has looked at it under `scriptorium.css`, gloam or a
  campaign theme.

### Residual gaps

- **No near-miss warning for a handout's Keeper headings.** `filterSections` matches these
  titles exactly, as it does `exclude_sections`. `check`'s L5 near-miss rule only looks at the
  `exclude_sections` list, so on a document page `## Prop Notes (physical)` or `## Context and
  Background` publishes and L5 says nothing. A withheld name inside one is still caught by the
  other leak checks; Keeper text with no withheld name in it is not.
- **The admin panel's exclude_sections effect text** (`src/admin/vaultconfigeffects.js`) says a
  heading removed from the list "would be published". For Context, Clues, Prop Notes and Delivery
  on a document page that is no longer true: the pin withholds them regardless.
- **The pin's new no-sheet warning is not surfaced.** From 1.11.44 a build prints one `WARNING:`
  line naming PCs that published with no character sheet (and no `sheet_source` in their
  frontmatter saying the sheet is kept elsewhere). `src/generator/bootstrap.js`'s
  `classifyGeneratorLog` files every captured line that is not a render error under detail, so
  the warning is only visible with `--verbose`. A campaign whose PC notes hold no stat tables will
  get this line on every build.
- **Excerpts no longer stop at a title.** From 1.11.44 the first-sentence cut in the pin's
  `lib/excerpt.js` does not end at Mr., Mrs., Dr., St., Col. and similar, for every excerpt on the
  site (pull quotes and listing cards). PC pull quotes are otherwise as at 1.11.40: `key_traits` if
  set, else a body excerpt, which on PC pages now skips bold label lines, tick-box lines and
  unfilled placeholders. No Scriptorium code calls the excerpt function.

## Addendum: repin to publish-v1.12.0 (89d65420), 2026-10-02

A pin bump along the release-tarball procedure, from `publish-v1.11.44` (`cf721e0f`) to
`publish-v1.12.0` (`89d654201a96570acf2cdfa49c2a8c87151ce45e`). It takes in two upstream releases:
1.11.45 (a note whose frontmatter is not valid YAML is reported by the build, upstream #287) and
1.12.0 (upstream #285), which is not routine. 1.12.0 makes `publish:` in `_meta/vault-config.md`
the one home for campaign settings, adds three switches there (`character_sheets`, `live_stats`,
`inbox`), and stops reading character-sheet stats from PC frontmatter.

This repin does the minimum to keep Scriptorium correct at the new pin. It does not move
Scriptorium onto the new config model. That is an owner decision, set out under "Left for the
owner" below.

### What upstream changed

- **One config source.** `vault.config.json` is meant to hold only `vaultPath`, `outputDir`,
  `host`, `siteUrl`, `cloudflarePagesProject` and `preserveDirs`. `siteTitle`, `footer`,
  `searchEnabled`, `folderMap`, `attachmentsDir`, `system`, the four exclude keys and `backend.*`
  move to `publish:` under snake_case names (`lib/config-keys.js`, `MOVED_KEYS`). A moved key
  still in the site file is read as a fallback, with one build warning naming the keys, and
  upstream plans to stop reading them at plugin 1.11.0. With both files set, the vault file wins a
  scalar; the three exclude lists are the vault list followed by the site-file entries it lacks;
  `exclude_callouts` is the stricter of the two (`lib/config.js:165-175`, `:192-246`).
- **Three switches**, all under `publish:`. `character_sheets` defaults on; `live_stats` and
  `inbox` default off. `character_sheets: false` publishes a PC page with only its keep-listed
  prose sections and forces live stats off.
- **Live features are no longer switched on by detection.** Up to 1.11.44 a deployed backend
  (`wrangler.toml` with a real KV id plus the function file) turned the live bar or the inbox on.
  `resolveBackendFlags` is deleted. A switch must now be set, in the vault file or as the old
  `backend.statusBar` / `backend.inbox` in the site file; unset means off, and the build warns
  when a backend is deployed and its switch is unset (`lib/build.js:1339-1340`). **A campaign that
  relied on detection loses its live bar or inbox at this pin until a switch is set.**
- **Sheets come from the note body only.** PC frontmatter stat fields are no longer read
  (`lib/pc-prose.js`, `RETIRED_BY_SYSTEM`); a PC that still carries one gets a build warning.
- **The site config is read from disk.** `lib/build.js:67` and `lib/fonts.js:267` call
  `loadVaultConfig()` (`fs` plus `JSON.parse`) where they used a non-literal `require()`. No file
  under the pin's `lib/` now requires a bare identifier.
- **A broken `_meta/vault-config.md` fails with a clearer message.** It stopped the build before
  (gray-matter's own exception); `loadPublishConfig` now throws one line naming the file
  (`lib/config.js:368`). `src/vault/publishset.js` reads such a file as empty, as it did.
- **`filterSections` and `strippedSectionTitles` gained an optional fourth argument**, `rules`,
  and `isExcludedSection` an optional trailing one. They carry the sheets-off keep list. No facade
  signature broke.

### What the procedure found

- **Release artefact.** Tarball sha256
  `3ac6152d01472a06858f41702c516dbbca316316d70285f2924e48811c15e835`, checked against upstream's
  `SHA256SUMS`; two independent downloads of both files are byte-identical. The tag is a
  lightweight tag on the pinned commit.
- **Reproducible-build cross-check.** A second fresh checkout, `npm ci --ignore-scripts`, `npm
  pack`: `diff -rq` clean against the extracted release, 526 files, `treeSha256`
  `88bb9865f5ed37c069a63caf27b97fb5b13bbced9f2dc4323149e4abb5e3287a`. npm 11.8.0 on macOS.
- **Dependency set: unchanged.** 31 files differ from `publish-v1.11.44` and seven are new
  (`lib/config-keys.js`, `lib/frontmatter.js`, `lib/migrate-config.js`, `lib/pc-prose.js`,
  `lib/switches.js`, `lib/vault-config-edit.js`, `lib/templates/pc-identity.js`), all the
  generator's own. No file under the bundled `node_modules/` changed. `js-yaml` is now a declared
  dependency of the generator and is named in `bundleDependencies`; it was already in the bundle
  as gray-matter's own dependency, at the same version. `fmguard.js`'s four bound hashes carry
  over. The notices diff is the generator version line, the pinned commit and the lockfile hash.
  `npm audit --omit=dev` reports the same three advisories (`js-yaml`, `linkify-it`,
  `markdown-it`) as the commit before this repin.
- **Lockfile.** Allowed hunks only: the root dependency spec and the `gm-apprentice-publish` entry,
  which gains `js-yaml` in `bundleDependencies` and `dependencies`. `npm install` rewrote the root
  `name`/`version` and reformatted `package.json`'s `pkg.patches`; both restored. `rm -rf
  node_modules && npm ci` reproduces, and `verify-generator` passes before and after. No top-level
  `node_modules/lunr`; the bundled copy is where it was.
- **Network posture: unchanged.** No file under `lib/` or `bin/` gained a `fetch(`, an `eval(`, a
  `new Function` or a `child_process` use.
- **Parser posture: same call sites, one new reading point.** A build still parses frontmatter at
  the same five places (three in `lib/scanner.js`, `lib/config.js:364`, `lib/manifest.js:34`). All
  now go through `parseNote()` in the new `lib/frontmatter.js`, which calls `matter(text, {})`.
  The empty options object turns gray-matter's content cache off. Scriptorium's own reader already
  passes options, so the two agree. ADR 0034's table of reading points names the call sites
  directly and wants `lib/frontmatter.js:13` added by the owner.
- **Rules-content scan.** `PIN_SCAN_BASELINE` has one new entry (a comment in `lib/pc-prose.js`
  naming two systems while explaining the retired-field report) and fifteen moved line numbers
  (three in `css/style.css`, two in `lib/flush-cli.js`, six in `lib/templates/gurps/parse.js`, four
  in `lib/templates/pc.js`), each matched by line content against the old tree. Both redacted files
  are byte-identical to the old pin.
- **The GURPS redaction fixture moved its stats into the body.**
  `test/fixtures/redaction-gurps-vault/Characters/PCs/Hero.md` kept `melee`, `ranged` and
  `defenses` in frontmatter. The pin no longer reads them, so no combat tab rendered and both the
  protected-build test and its control went red. The same rows are now `## Melee Weapons`,
  `## Ranged Weapons` and `## Active Defenses` tables, the headings upstream's own PC template
  uses. The tests are unchanged and pass.
- **`init` keeps scaffolding the old site-file keys (a stopgap).** The pin's
  `vault.config.json` template shrank to deploy keys. `composeVaultConfigJson` built a new pack's
  file from that template, so a new pack came out with `host` and `siteTitle` only and failed
  `assertScanKeysPresent`. It now adds the settings the 1.11.44 template carried
  (`LEGACY_SCAFFOLD_SETTINGS` in `src/cli/init.js`), in the same key order, so a pack scaffolded
  at this pin is byte-identical to one scaffolded before it. `test/init-scaffold.test.js`'s
  hand-typed literal is unchanged and passes. The cost: those keys are the fallback upstream plans
  to drop, and every build of such a pack carries the pin's "still holds campaign settings"
  warning, which Scriptorium files under detail.
- **Four change detectors moved or changed meaning.**
  - `test/package-config.test.js`: the `path.join(__dirname, …)` asset reads moved
    (`lib/build.js` 97, 114, 146 to 145, 162, 194; `lib/init.js` 4 to 7; `lib/sync-functions.js`
    5 to 4). The set of reads is the same.
  - `test/generator-module-graph.test.js`: the two recorded non-literal requires no longer exist.
    The test now asserts that both sites read the config through `loadVaultConfig()` and that no
    file under the pin's `lib/` requires a bare identifier. **This rewrites a test in a file
    CLAUDE.md lists under constraints and wants the owner's eye.**
  - `test/session-pairing.test.js`: the note-walk gate literal reads `parseNote(text).data` where
    it read `matter(text).data`. `src/vault/sessionpairs.js` needed no change.
  - `test/build-site-mirror.test.js`: the parity test calls `hasRealKvId`, `detectInbox` and
    `detectStatusBar` in place of the deleted `resolveBackendFlags`; `configDir` appears eight
    times in `lib/build.js`, was six. `SITE_RELATIVE_INPUTS` is unchanged.
- **One fixture name collided with the pin's stylesheet.** `css/style.css` has a new
  `.sheet-withheld` class. `test/build-vocab-e2e.test.js` wrote a withheld note to
  `People/Withheld.md`, and the output scan read the class name as that note's file name
  appearing in built output. The fixture file is renamed. The scan did what it is meant to do; a
  real vault with a withheld note whose file name is a word in the pin's stylesheet would be
  refused the same way, as it would have been before for any other such word.
- **Line citations re-derived** (step 7), for every file that differs between the two pins, under
  `src/` and in `docs/COLLABORATING.md`: 107 moved by line content, about thirty re-read by hand
  because the cited lines changed. Citations to the deleted `unionExcludeList` now name `pick()`.
  Citations inside ADRs are left as written.
- **Equivalence check** (step 10): clean on `mini-vault`, `story-vault` and `wrapup-vault`.

### What this does not prove

- **The packaged executables.** `npm run package` on a macOS host exited 0 with the pin,
  notices-freshness, asset-embedding and rules-content gates passing. The startup self-test was
  skipped, as before. No packaged executable has been started at this pin.
- **The test suite on Linux.** `npm test` on that macOS host: 2984 tests, 2973 pass, and the 11
  that fail are the same 11 that fail there on `main` at `1194ff9`. Not run on Linux.
- **The Windows C1 manifest.** Still stale; `css/style.css` changed again.
- **Any of the three switches end to end.** No fixture vault sets `character_sheets`,
  `live_stats` or `inbox`, so no build-plus-check run here covers a sheets-off site or a live
  feature.
- **A real campaign.** The fallback path was exercised by the fixtures, whose site files carry
  the old keys. No real pack was built at this pin.

### Left for the owner

- **Where a pack's campaign settings live.** The stopgap above keeps them in the pack's
  `vault.config.json`. The upstream model wants them in `publish:` in the vault file, which means
  `init` (and the admin panel's editor) writing outside `<vault>/_meta/scriptorium/`, against
  `init`'s own banner. Upstream ships `gm-apprentice-publish migrate-config` and, for a caller
  that writes YAML itself, `lib/vault-config-edit.js` (`setPublishKeys`, `editPublishBlock`).
  `assertScanKeysPresent` requiring `excludeDirs` and `folderMap` in the site file is part of the
  same decision. It needs settling before upstream drops the fallback.
- **`src/vault/publishset.js` still ports the merge.** Upstream now exports
  `resolveConfig(rawConfig, vaultPath, warn)` and `resolveSwitches(publish, json)` so a caller need
  not. Calling them means calling one of the pin's file-reading entry points, which
  `src/generator/pinned.js` avoids on purpose (ADR 0034), so it was not done here. The port agrees
  with the pin on every fixture. Known differences. In the first, second and fourth the port
  reads as published something the build withholds, never the reverse; the third changes no
  published text that `check` models:
  - `exclude_callouts` is vault-then-site here and the stricter of the two in the pin;
  - a vault exclude key that is set but is not a list gives the pin defaults plus the site-file
    entries in the pin, and the site-file list alone here;
  - `system` falls back to the site file's `system` in the pin and not here;
  - with `character_sheets: false`, the pin withholds every PC section off the keep list and the
    text model does not pass the fourth `rules` argument, so `check` reads those sections as
    published.
- **`src/admin/handlers/pack.js`'s backend check** reads `backend.statusBar` / `backend.inbox`
  from the site file only. A campaign that sets `publish.live_stats` or `publish.inbox` in the
  vault file is not seen by it.
- **The three switches in the admin panel.** Not added. They are plain booleans under `publish:`.
- **The no-sheet and legacy-settings warnings** are both filed under detail and seen only with
  `--verbose`, as the 1.11.44 addendum already says of the first.

## Addendum: repin to publish-v1.12.3 (3517ffd8), 2026-10-03

A pin bump along the release-tarball procedure, from `publish-v1.12.0` (`89d65420`) to
`publish-v1.12.3` (`3517ffd86196c1b6334ef3eb3f208cf7df34435e`). It takes in three upstream
releases: 1.12.1 (the section filter reads headings as the renderer does, upstream #295), 1.12.2
(the plugin's migration engine; one line of the publish tool changed) and 1.12.3 (renames and
moves without broken links, upstream #298). The branch was first brought up to `main` at
`f0ac2ce`.

As at 1.12.0, this does the minimum to keep Scriptorium correct at the new pin. Everything under
"Left for the owner" in the 1.12.0 addendum still stands.

### What upstream changed

- **The section filter withholds on every reading of a heading** (1.12.1). `filterSections` asks
  the renderer's own parser where the headings are (`findHeadings`, `lib/processor.js:180-209`)
  and keeps the old margin pattern beside it (`marginHeading`, `:220-226`, and `looseHeading`,
  `:234-240`). A withheld section starts at a line any reading calls a heading with a withheld
  title: indented, underlined (setext), inside a blockquote or list, written with a non-breaking
  space, or under an unclosed code block. It ends only where both readings agree. A note the
  parser cannot read has its whole body withheld (`lib/processor.js:264-325`). The function still
  only deletes whole lines, and its signature is unchanged. New exports `sectionVerdicts` and
  `keptSectionFlags` are not used here.
- **The verdict loop moved.** `lib/build.js` no longer calls `decidePage` itself. The new
  `lib/published-pages.js` pairs story files, takes one verdict per page and filters, in the same
  order and still with no `pageIndex` (`:10-17`, called from `lib/build.js:417-419`).
- **A story companion is decided in one place.** `pairStoryFiles` and the story-companion verdict
  both ask `isStoryCompanion` (`lib/scanner.js:339-341`): a typed note at `<PC>_Story.md` beside a
  `pc`.
- **One wikilink reader** (1.12.3), `lib/wikilink.js`. A table-cell link written `[[Target\|Label]]`
  now resolves in the pin itself, for the page, backlinks, recency, the story spine and the search
  index. A link with a heading, a block or `.md` resolves to its page, and a link to a page's own
  heading no longer counts as a mention of itself.
- **A new switch, `publish.site`.** With `site: false` in `_meta/vault-config.md` the pin's
  `build()` throws before it writes anything (`lib/build.js:73-74`). Unset is on.
- **A PC's live key can be pinned.** `live_key` in a PC's frontmatter, else the slug of its file
  name as before (`pcLiveKey`, `lib/scanner.js:28-31`).
- **New commands** in the upstream CLI only: `lines`, `rename` and a vault-setting reader
  (`lib/lines-cli.js`, `lib/rename-refs.js`, `lib/vault-setting-cli.js`). Nothing here calls them.

### What the procedure found

- **Release artefact.** Tarball sha256
  `586f87a2fa909855555a44e4f920fe076b2b07f547255bfc65ba841a1dbaa3ac`, checked against upstream's
  `SHA256SUMS`; two independent downloads of both files are byte-identical. The tag is a
  lightweight tag on the pinned commit.
- **Reproducible-build cross-check.** A second fresh checkout, `npm ci --ignore-scripts`, `npm
  pack`: `diff -rq` clean against the extracted release, 531 files, `treeSha256`
  `0be5cbe29083c387b21eae2058e64c6d9a2348246963a0d621638c595f121444`. npm 11.8.0 on macOS.
- **Dependency set: unchanged.** 39 files differ from `publish-v1.12.0` and five are new
  (`lib/lines-cli.js`, `lib/published-pages.js`, `lib/rename-refs.js`, `lib/vault-setting-cli.js`,
  `lib/wikilink.js`), all the generator's own. No file under the bundled `node_modules/` changed,
  and the generator's `package.json` differs only in its version. `fmguard.js`'s four bound hashes
  carry over, and both redacted files are byte-identical to the old pin. The notices diff is the
  generator version line, the pinned commit and the lockfile hash. `npm audit --omit=dev` reports
  the same three advisories (`js-yaml`, `linkify-it`, `markdown-it`).
- **Lockfile.** Allowed hunks only: the root dependency spec and the `gm-apprentice-publish`
  entry's version, path and integrity. `npm install` rewrote the root `name`/`version` and
  reformatted `package.json`'s `pkg.patches`; both restored. `rm -rf node_modules && npm ci`
  reproduces, and `verify-generator` passes before and after. No top-level `node_modules/lunr`.
- **Network posture: unchanged.** No changed or new file under `lib/` or `bin/` gained a
  `fetch(`, an `eval(`, a `new Function`, a `child_process` use or a network builtin.
- **Parser posture: unchanged on the build path.** A build parses frontmatter at the same five
  places. The new `parseNote()` callers are in the three new command modules, which a build does
  not reach.
- **Rules-content scan.** `PIN_SCAN_BASELINE` has no new entry. Four line numbers in
  `lib/templates/pc.js` moved by one, each matched by line content against the old tree.
- **The published-set port still agrees with the pin** (step 9's by-hand read, widened).
  `src/vault/publishset.js` mirrors the pairing, the verdict call and the filter that now sit in
  `lib/published-pages.js`; the sequence and the arguments are the same. Its `pairStoryFiles` has no
  `isStoryCompanion` gate and needs none: `pages` holds typed notes only, in the pin and in the
  port, so the gate is always true where it is asked. `src/checks/leak/textmodel.js` calls the
  pin's own `filterSections`, so `check` picked up the wider withholding with no change, and its
  line-alignment argument (every strip step deletes whole lines or shortens one in place) still
  holds for the rewritten walk.
- **Two change detectors moved.**
  - `test/package-config.test.js`: the asset reads moved (`lib/build.js` 145, 162, 194 to 149,
    166, 198; `lib/init.js` 7 to 8). The set of `path.join(__dirname, …)` reads on the build path
    is the same.
  - `test/generator-module-graph.test.js`: the `loadVaultConfig(resolvedConfigPath)` read moved
    from `lib/build.js:67` to `:69`. **This is a second edit to a test in a file listed under
    constraints, and wants the owner's eye with the first.**
- **A merge fault in `init`, fixed.** `main`'s folder-map additions (#103) were set on the
  template object, and the 1.12.0 stopgap in `composeVaultConfigJson` let a template key win over
  its defaults. The pin's template has no `folderMap`, so a new pack was written with `Sessions`
  and the vault's own folders and none of the thirteen standard ones.
  `test/bugs-b4-init-foldermap.test.js` and `test/init-e2e.test.js` went red on the merge commit
  (four tests) and pass with the additions applied after the defaults.
- **Line citations re-derived** (step 7), for every file that differs between the two pins, under
  `src/` and in `docs/COLLABORATING.md`: 142 moved by line content, about fifteen re-read by hand
  because the cited lines changed. Citations to the old verdict loop now name
  `lib/published-pages.js`.
- **Equivalence check** (step 10): clean on `mini-vault`, `story-vault` and `wrapup-vault`.

### What this does not prove

- **The packaged executables.** `npm run package` on a macOS host built both targets with the
  pin, notices-freshness, asset-embedding and rules-content gates passing. The startup self-test
  was skipped, as before. No packaged executable has been started at this pin.
- **The test suite on Linux.** `npm test` on that macOS host, Node 22: 3276 tests, 3267 pass, 3
  skipped (the real-browser tests), 6 fail. The six are host assumptions (a symlinked temp
  directory, a case-folding disk, a linux-x64 build host), the six that pull request #94 fixes. Not
  run on Linux, and not run with the real-browser tests.
- **The Windows C1 manifest.** Still stale.
- **The wider section filter on a real vault.** No fixture has a withheld heading that is
  indented, underlined, nested or under an unclosed code block, so no build-plus-check run here
  covers the new readings.
- **A rename.** Nothing here exercises `live_key` or the upstream rename command.

### Residual gaps

- **`publish.site: false` ends a build with exit 1.** The pin throws a plain `Error`, so
  `build --no-check` prints `build failed: the site is off for this vault …`, keeps the staging
  tree "for inspection" and exits with the code that means a Scriptorium fault. Nothing is
  published, which is the right outcome. The exit code and the kept staging tree are not. `check`
  says nothing about the switch. Seen on a copy of `mini-vault`; no test covers it.
- **The escaped-pipe read shim (ADR 0043) now overlaps the pin.** The pin reads `[[T\|L]]` itself
  at this version. The shim still runs and its tests pass, so a table-cell link is rewritten
  before the pin sees it. Whether to retire the build half of the shim is the owner's call; the
  `check` half is Scriptorium's own reader and is unaffected.
- **`leak/l5-gm-heading-survives` reads rendered headings**, so a heading the pin now withholds is
  no longer there for it to report, and its "starts with" arm still covers what the pin's exact
  match misses. No change was needed. Whether its description should say what the pin now
  withholds was not examined.
- **Citations in `test/` comments are not re-derived.** They were written against several
  earlier pins and were not brought to `publish-v1.12.0` either, so mapping them from that pin
  would be wrong. Two that could be checked by hand were fixed
  (`test/stub-heading-collision.test.js`, `.agents/windows-verification.md`).
  `test/pin-citations.test.js` checks only that a cited line exists.

## Addendum: repin to publish-v1.14.0 (ea94de7f), 2026-10-06

Repin from `publish-v1.12.3` (3517ffd8). Follows `docs/COLLABORATING.md`'s pin bump procedure. Upstream
went through 1.12.4, 1.12.5, 1.13.0 and 1.14.0 in between. The release-tarball pin source is unchanged.

### What upstream changed (the part that reaches us)

- **The grouped Story toggle is a `<button>`** (1.12.4). `lib/templates/nav.js` no longer emits
  `<a class="nav-group-toggle" href=...>Story</a>`; the landing is the dropdown's first entry, labelled
  "Story so far". The chapter index entry reads "Chapters" (1.12.5). Retires Scriptorium's own
  `src/build/storynav.js` (ADR 0014 addendum, next commit).
- **An empty authored Timeline no longer replaces Events** (`lib/build.js:706-711`), and `player-characters`
  is accepted as a roster type (`isRoster`, `lib/templates/nav.js:28-29`).
- **The full D&D 5e sheet** (1.13.0). `lib/templates/pc-dnd.js` is gone, replaced by
  `lib/templates/dnd/**` (renderer, parser, vitals/spells blocks, party board). `css/style.css` grew.
- **The playable D&D sheet** (1.14.0): `js/dnd-live.js`, `js/dnd-party.js`, `lib/flush/dnd-writeback.js`.
  Live only with `publish.live_stats` on (`lib/build.js:879`, `live: publishConfig.live.stats === true`).
- `lib/processor.js` gains two exports, `renderInline` and `findHeadings`. `filterSections`,
  `keepOnlySections`, `keptSectionFlags` and `sectionVerdicts` are unchanged in signature and body.
- `lib/build.js` gains two options, `outputDirOverride` and `assumeKv`, for upstream's own local live preview.
  Scriptorium passes neither.

### What the procedure found

- **Release artefact.** Tarball sha256
  `ff3776d439936c5680894b1b0ad23d2cc7bec96d9478603baa1c3730ff80aadf`, checked against upstream's
  `SHA256SUMS`; two independent downloads of both files are byte-identical. The tag is a lightweight tag
  on the pinned commit.
- **Reproducible-build cross-check.** A fresh checkout at the pinned commit, `npm ci --ignore-scripts`,
  `npm pack`: `diff -rq` clean against the extracted release, 560 files, `treeSha256`
  `fda6f79d7f2b9d198c9bcc1c7b59f121445f5b397c1bdf0148dd82f74c8ef644`. npm 10.9.8 on Linux (the earlier
  addenda recorded 11.8.0 on macOS; the tree hash is what is compared).
- **Dependency set: unchanged.** `diff -rq` of the bundled `node_modules/` between the 1.12.3 and 1.14.0
  tarballs is empty. The generator-owned delta is 17 paths: `css/style.css`, `js/dnd-live.js` and
  `js/dnd-party.js` (new), `lib/build.js`, `lib/flush-cli.js`, `lib/flush/dnd-writeback.js` (new),
  `lib/party-board-registry.js`, `lib/processor.js`, `lib/templates/{d20-sheet,live-mount,nav,pc-registry,pc,sheet-parse}.js`,
  `lib/templates/dnd/**` (new), `lib/templates/pc-dnd.js` (removed), `package.json`. `fmguard.js`'s four
  bound hashes and both redaction targets are byte-identical, so the redactions and `fmguard` carry over
  with no hash edit. `npm audit --omit=dev` reports the same bundled-package advisories as before.
- **Lockfile.** Allowed hunks only: the root dependency spec and the `gm-apprentice-publish` entry
  (version, path, integrity). `npm install` rewrote the root `name`/`version` and reformatted
  `package.json`'s `pkg.patches`; both restored. `rm -rf node_modules && npm ci` reproduces and
  `verify-generator` passes before and after. No top-level `node_modules/lunr`; the bundled copy is
  under `node_modules/gm-apprentice-publish/node_modules/lunr`.
- **Network posture.** No changed or new file under `lib/` or `bin/` gained a `fetch(`, an `eval(`, a
  `new Function` or a network builtin (`child_process` is in `lib/image-optimize.js` and
  `lib/run-command.js`, as before). The two new browser scripts are covered in the `live_stats` note below.
- **Rules-content scan.** `PIN_SCAN_BASELINE` re-derived: 42 hits both before and after. Five moved by
  line content (`css/style.css` 3925 to 4096, `lib/flush-cli.js` 117 to 64, `lib/party-board-registry.js`
  10 to 11 and 23 to 30), one comment is gone (`lib/flush-cli.js:43`), and one is new
  (`lib/build.js:879`, a comment naming three systems, no rules data). Every other hit was compared by line
  content against the old tree and is unchanged. The new `lib/templates/dnd/**` has no hit and no
  page-citation or rules table.
- **Citations re-derived** (step 7) in `src/` and `docs/COLLABORATING.md`, by line content against the
  old tree: 39 moved. `test/` comments are not re-derived, as at the last two pins.
- **Change detectors moved.** `test/generator-pin.test.js` (the SHA), `test/generator-module-graph.test.js`
  (`loadVaultConfig(resolvedConfigPath)` now `lib/build.js:70`), `test/package-config.test.js` (asset reads
  `lib/build.js` 149, 166, 198 to 152, 169, 201; 74 packaged assets, up from 72, for the two new scripts).
- **Equivalence check** (step 10): clean on `mini-vault`, `story-vault`, `wrapup-vault` and `pin-vault`.
  `session-chain-vault` reports `timeline.html` predicted and not built; that is the same result at
  `publish-v1.12.3`, so it is not a drift from this repin (not investigated further).

### What this does not prove here

The Windows C1 manifest is still stale (OPEN, `.agents/windows-verification.md`). The Windows build of this
pin has not been run. The packaging proof is recorded below once run.

### Packaging proof (publish-v1.14.0, Linux host)

`npm run package` built both targets (win-x64 and linux-x64) with the notices-freshness, asset-embedding
(74 assets) and rules-content gates passing; the startup self-test passed for linux-x64 (run directly) and
for win-x64 (a throwaway linux-x64 build from the identical invocation, as before). The packaged linux-x64
executable builds a clone of a real campaign vault byte-for-byte identically to a source build (`diff -r`
clean, 178 files). `npm test` fully unskipped (Playwright and axe-core): 3332 tests, 0 skipped, 0 failed.
A real campaign vault clone and `examples/the-long-lease`, built at `7eba2d8` and here: the page set is the same; the only
file changes are `css/style.css` (upstream's D&D rules), `css/scriptorium.css` (our retired Story-nav block),
two new unreferenced scripts `js/dnd-live.js` and `js/dnd-party.js`, and the Story menu markup in the nav of
116 and 60 pages. `check` is finding-for-finding identical on both. No Windows run.
