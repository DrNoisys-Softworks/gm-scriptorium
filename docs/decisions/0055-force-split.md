# 0055. `--force` is split, and no flag overrides the output-leak scan

## Summary

`build --force` used to do three things at once: build despite check errors, build into the site config's own output folder, and build despite a hit from the output-leak scan. The third was the dangerous one, because a single flag a GM types out of habit could publish a withheld name. `--force` is now two flags that each do exactly one of the first two jobs. `--force-check` builds despite check errors, and `--force-out` builds into the site config's own `outputDir`. Nothing on the command line overrides the output-leak scan any more. A bare `--force` is refused with one line and exit 1, so a script that relied on the old meaning fails loudly instead of changing meaning. The main alternative, keeping `--force` as a deprecated alias, is rejected below. The limit a contributor will meet is that the maintainer scripts keep a programmatic override, and a structure test proves the command line cannot reach it.

Status: accepted. Amends [ADR 0009](0009-output-leak-scan.md).

## 1. The decision

`build` accepts `--force-check` and `--force-out`, independently, and no longer accepts `--force`.

- **`--force-check`** lets the build go ahead when the pre-build check found ERROR findings. Each finding it overrides is printed as an `OVERRIDDEN` line under `--force-check: overriding N error finding(s):`. Findings that no flag may override stay refused, such as `frontmatter/non-yaml-language` (ADR 0034). It still covers source-side `leak/*` check errors, because the output scan is the backstop that reads what was actually staged.
- **`--force-out`** lets the build write into the site config's own `outputDir` when the resolved output folder is that same folder (ADR 0018, the collision guard). The build says so with `--force-out: building into the site config's own outputDir (<path>) despite the collision guard.`
- **Neither flag, and no combination of them with `--no-check`, reaches the output-leak scan.** The scan runs on the staged tree before anything is swapped into place, and a hit refuses the build with exit 2 and writes nothing.

The product call site in `src/cli/build.js` passes the literal `force: false` to `runAtomicBuild`. `runAtomicBuild` keeps its `force` argument so the maintainer scripts that deliberately build leaky vaults (`scripts/equivalence-check.js`, `scripts/l4-render-audit.js`) and some tests can still render them. `test/force-split-structure.test.js` walks the module graph from `bin/scriptorium.js` and fails on any `runAtomicBuild` call that is not an object literal with `force: false`, and on either maintainer script entering the graph.

A bare `--force` is refused in two places with one message: in `validateFlags` (the command line) and at the top of `runBuildCommand` (direct callers, so a test or a script that passes `force` fails loudly instead of having it ignored). The message is `--force has been split: use --force-check to build despite check errors, or --force-out to build into the site config's own outputDir. Nothing overrides the output-leak scan.` Exit code 1, as for any other user mistake (the exit table is frozen, `src/util/exitcodes.js`).

## 2. What `--json` carries

Every build envelope, refusals included, now carries `forced` (either flag set), `forceOut`, `forceCheck` and `siteOutputDirCollision` (the path, or `null`). `overriddenFindings` holds check findings only, because a scan hit is never overridden. The change is additive, so `schemaVersion` is unchanged.

## 3. Rejected alternatives

- **Keep `--force` as a deprecated alias for both new flags.** A script that used `--force` to get past a scan hit would keep running with a different meaning, and the one who reads its log would not know. A refusal that says what to type is cheaper than a silent change.
- **A third flag, `--force-leaks`.** The point of the change is that the scan cannot be overridden from the command line. A flag for it would put the override back.
- **Rename the `force` parameter of `runAtomicBuild`.** It would edit a frozen signature test and about ten call sites for no gain, because the structure test already proves what the command line passes.
- **Keep source-side `leak/*` check errors unforceable.** Out of scope here. The staged-tree scan is the backstop, and making the check side unforceable is a separate decision.

## 4. Limits

- The maintainer scripts and some tests still pass `force: true` to `runAtomicBuild` directly. That is deliberate, loud and greppable, and the command line cannot reach it.
- Older messages that say `--force` cannot override a particular refusal (the executable-frontmatter guard, the GM link marker, the Obsidian comment gate, the theme asset step) are still true, so they were left as they are.
- Tooling outside this repository that runs `build --force` must change to the new flags.
