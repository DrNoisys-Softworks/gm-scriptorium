# 0001. Packager: @yao-pkg/pkg, target node22-win-x64

Status: accepted (phase 0 spike, 2026-09-10). The `spike/` harness and manifests cited below are retained in the private archive at `b5b48b4`.

## Summary

Scriptorium ships as one Windows executable that a GM can run with no Node.js installed. It is built with `@yao-pkg/pkg` and cross-compiled on a Linux machine, so no Windows build server is needed. Two alternatives were rejected: Node's own single-executable feature cannot cross-compile to Windows, and Bun's compile mode lacks the embedded file system the generator's asset copiers rely on. A spike proved the generator's asset copying works inside the packaged executable. Later records corrected this one's asset-inclusion note and its dependency clause, so read ADR 0005 and ADR 0010 alongside it.

The asset-inclusion note below (section "A pkg configuration gotcha found along the way", "this particular trap disappears by construction... when
the real pkg config for the shipped product lands in package.json at the repo root") is superseded
by 0005: it did not disappear by construction. `package.json`'s own `pkg` field is only read when
`package.json` is pkg's *input*; the real product shipped with `bin/scriptorium.js` as input (this
same invocation style), which silently ignores `pkg.assets` entirely. See 0005's "Packaging findings
resolved (DEP-a2)" section for the root cause and fix. Not rewritten below; this is a forward
pointer only.

Dependency clause (npm 1.2.1 pin, registry-hash integrity, asset list) superseded by 0005
(2026-09-11). Packager decision stands.

Note: this project was built under the working name Lorekeeper and renamed to Scriptorium before
phase 2 started, because the owner already has an unrelated Lorekeeper (a canon-consistency writing
agent, established across several campaigns). The evidence in this ADR was regenerated after the
rename, from the moved repository, rather than text-substituted: the byte-identical result and the
timings both reproduced unchanged.

## Decision

Ship Scriptorium as a single Windows executable built with `@yao-pkg/pkg` 6.22.0, target
`node22-win-x64`, cross-compiled from this Linux box. This is the primary path (F1) on the
fallback ladder in the Engineering Brief and Decisions Addendum. It is chosen alone, without
orchestrator approval, because the addendum reserves that requirement for F2/F3/F4 and F1 is the
one path the Engineer may take on their own judgement.

Node SEA was rejected before the spike: it cannot cross-compile Linux to Windows, which would
require a paid `windows-latest` Actions runner for every build, and the orchestrator's ruling (G2)
is to build on this box. Bun `--compile` was rejected because it has no directory-listing virtual
filesystem over an embedded root, and `gm-apprentice-publish`'s asset copiers do
`fs.readdirSync(path.join(__dirname, '../js'))`, which Bun cannot serve without a virtual-fs layer
Scriptorium would have to write itself.

## The risk this spike closes

The generator's asset copiers (`copyCSS`, `copyGenreCSS`, `copyJS` in `lib/build.js`, plus the
`require.resolve('lunr')` copy) all read `__dirname`-relative paths and call `fs.copyFileSync`.
Historically, `pkg`'s patched snapshot filesystem intercepted the `readFile`-family calls but not
`copyFile`, so a `copyFileSync` whose source resolves inside the snapshot could fail to find it.
That was the single most likely failure mode for this whole design, per the orchestrator's G2
ruling, and had to be proven or disproven before any other work started.

## Evidence: Half A (the real proof)

Built `scriptorium-spike-linux-x64` from `spike/bootstrap.js` with the assets in
`spike/pkg.config.json` (the CSS, JS and templates-scaffold trees of `gm-apprentice-publish`, plus
`lunr.js`), ran it against a real campaign vault
(a private QC folder, not in this repo, read-only, no modification), and ran the
identical build under plain `node` for comparison. Reproducible via:

```
spike/run-spike.sh --vault <path to vault> --site-config <path to a vault.config.json> --scratch <dir>
```

Neither the script nor `spike/bootstrap.js` hardcodes a vault location; both take it as a required
argument, per standing instruction (the vault is mid-migration).

**Result: the two output trees are byte-identical.** Sorted sha256 manifests of both trees,
byte-identical, `diff` clean. Manifests committed at:

- `spike/manifests/manifest-node.txt` (plain node)
- `spike/manifests/manifest-pkg-linux.txt` (pkg-built binary, shim installed)
- `spike/manifests/manifest-pkg-linux-noshim.txt` (pkg-built binary, shim **not** installed, see
  finding below)

All three are identical to each other. Both required asset sets are present in every tree:
`css/style.css`, `css/themes/horror.css`, `css/theme.css` (generated at build time via
`writeFileSync`, not a static asset, but confirms the output-writing path works identically under
both runtimes), all four `js/{filters,lightbox,nav,search}.js`, and `js/lunr.js`.

**Verdict: PASS.**

## Finding: the stated risk does not manifest in this pkg version

`@yao-pkg/pkg` 6.22.0's own prelude (`prelude/bootstrap.js:1044`) already patches
`fs.copyFileSync` (and the async `fs.copyFile`) to detect a snapshot-path source and route the copy
through `openSync`/`readSync`/`writeSync` on the *patched* `fs` object (`copyInChunks`, which is
therefore snapshot-aware), rather than calling the native `copyFile` syscall the VFS hooks cannot
intercept. This is exactly the technique the Engineering Brief prescribes for Scriptorium's own
shim, and the prelude's own code comments cite the identical rationale ("VFS module hooks
intercept readFile but may not intercept copyFile"). Confirmed by reading the source and by a
second, unrequested comparison run: rebuilding the Linux binary with
`spike/bootstrap.js build --no-shim` (Scriptorium's shim not installed at all) still produces
byte-identical output (`manifest-pkg-linux-noshim.txt`).

This means the specific historical failure the brief worried about, the reason the whole spike
was ordered before any other work, has already been fixed upstream in the exact pkg fork and
version this project depends on. It is good news, not a contradiction that changes the decision:
F1 is more robust than assumed, not less.

**Scriptorium's own shim (`spike/copyfile-shim.js`) is still built and will still ship**, per the
brief's explicit instruction to close the risk "in Scriptorium's own bootstrap, not by patching the
dependency." Depending on undocumented behaviour of a single-maintainer third-party fork for a
correctness-critical path is exactly the fragility the brief is guarding against; the shim is
cheap, self-contained, and makes Scriptorium correct even if a future pkg release regresses this.
It wraps the Node `fs` API only, never touches `gm-apprentice-publish`.

## Evidence: Half B (the target, build-time only)

Cross-built `scriptorium-spike-win-x64.exe` from the identical entrypoint and asset config.
Confirmed:

- `MZ` magic bytes at offset 0 (`od -An -tx1 -N2` gives `4d 5a`).
- All 15 configured assets (5 CSS incl. `themes/horror.css`, 4 JS, 5 templates-scaffold files,
  `lunr.js`) were added to the build at compile time, captured from `pkg --debug` output for this
  exact Windows build: `spike/manifests/win-x64-assets-debug.txt`.

`wine` is not installed in this environment (`which wine` reports not found), so the binary was not
executed. Per the brief, execution defers to the Windows verifier's pass; this ADR does not claim
`--version`/`--help` were run on Windows. `spike/run-spike.sh` runs the `walk` subcommand under
`wine` automatically if it becomes available.

**Verdict: assets confirmed present at build time. Execution unverified, deferred to the Windows
verifier per orchestrator ruling G3.**

## A pkg configuration gotcha found along the way

A standalone `-c <file>.config.json` config's `assets` glob is resolved **relative to the
directory containing that config file**, not the process cwd or the project root
(`buildMarker()` in `lib-es5/index.js` sets `marker.base = path.dirname(config)`). It must also be
nested under a `"pkg"` key exactly as in `package.json`, not left flat: `walker.js`'s
`appendFilesFromConfig` reads `marker.config?.pkg`, and a flat file silently produces zero matched
assets rather than an error. The first attempt at this spike hit exactly this: `css/style.css` and
`css/theme.css` got in anyway because pkg's own static analysis found their **literal**
`path.join(__dirname, '../css/style.css')` string in `lib/build.js`, but `copyGenreCSS`'s
`` `../css/themes/${genrePreset}.css` `` is built from a template literal pkg's static analysis
cannot resolve, so `css/themes/horror.css` was missing and the build failed with pkg's own "was
not included into executable" error until the config was fixed. `spike/pkg.config.json` now uses
`../node_modules/...` globs (it lives in `spike/`) and is nested under `"pkg"`. When the real
`pkg` config for the shipped product lands in `package.json` at the repo root in phase 2/3, this
particular trap disappears by construction (`base` becomes the repo root, where `node_modules`
already is), noted here so nobody has to rediscover it if a standalone config file is used again.

## Timings against the real vault (local disk, current location)

Measured on this box against a real campaign vault (a private QC folder, not in this repo),
which is on local disk at its current, pre-migration path, **not** yet on the CIFS NAS
share that the vault will move to as later phase work. This is a local-disk baseline only; it is
not the CIFS budget the addendum ultimately wants, and should be re-measured once the vault is at
a private QC folder (not in this repo).

`build` (full generator run, median of 3 runs each):

| Runtime | Elapsed |
|---|---|
| plain `node` | ~201 ms |
| `pkg`-built Linux binary | ~182 ms |

`check`-proxy (`check` does not exist yet, that is phase 2, so this walks the vault and parses every
`.md` file's frontmatter with the same `gray-matter` the generator uses, as a stand-in for the
future command's dominant cost; median of 3 runs, all files walked and parsed, 0 parse errors):

| Runtime | Elapsed |
|---|---|
| plain `node` | ~34 ms |
| `pkg`-built Linux binary | ~28 ms |

The pkg binary is not slower than plain node for either workload on this hardware; both are well
under a second on the current vault. No performance concern at this scale.

## Timings over CIFS, after the migration (docs/MIGRATION.md, retained in the private archive at `b5b48b4`, 2026-09-10)

The vault moved to a private QC folder (not in this repo) (phase 3, authorised by the owner).
This is the re-measurement the note above called for, using the real `check` and `build` commands
(both now exist; the local-disk numbers above used a `check`-proxy walk since `check` did not exist at
the time of the spike). Same real vault content, same machine, median of 3 runs each, `check` and
`build` measured against an empty output directory so the comparison is apples to apples:

| Command | Local disk | CIFS (NAS) | Ratio |
|---|---|---|---|
| `check` | ~85 ms | ~349 ms | ~4x |
| `build` (`--force`, incl. `NOTICE.txt`) | ~180 ms | ~2050 ms | ~11x |

Both stay well inside "seconds, not minutes" at this vault's current size.
`build`'s larger slowdown factor than `check`'s is consistent with CIFS write latency compounding over
many small per-file writes (vs. `check`'s read-mostly walk); this was not
independently isolated further. Whether this holds at "the first vault five times bigger" (the
yardstick Requirements section 9 sets) is not measured here and would need a synthetic larger vault to
test.

## Fallback ladder

- **F1 (chosen): pkg + the copyFileSync shim.** Proven above.
- **F2:** runtime extraction to `%LOCALAPPDATA%`. Requires orchestrator approval per the
  Decisions Addendum (this was previously an Engineer-alone decision in the Engineering Brief;
  the addendum narrowed that). Not needed, F1 passed.
- **F3:** Bun `--compile` + F2 extraction. Requires orchestrator approval. Not needed.
- **F4:** ship a Node runtime beside a launcher. Fails acceptance criterion 1. Requires
  orchestrator approval and Engineer must stop and escalate rather than choose it. Not needed.

Half A passed outright, so this build does not descend the ladder and nothing here requires
orchestrator sign-off.
