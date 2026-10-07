# 0010. Windows startup defect: drop V8 bytecode, add a pipeline startup self-test

Status: accepted (2026-09-17). The `spike/` harness and manifests cited below are retained in the private archive at `b5b48b4`.

## Summary

No published Windows executable had ever started, because the packager compiled V8 bytecode on Linux that Windows rejects when it loads. The packager now builds without bytecode, so the packaged JavaScript stays readable inside the executable. A new startup self-test runs the packaged program before a release is written, so a build that cannot start is never shipped. The limit to know about is that the self-test runs a Linux build, so it proves the pipeline and not Windows itself, and Windows verification stays a separate step.

## The defect

The Windows verifier ran the just-published v0.2.0 exe on the owner's Windows PC (full evidence:
a private QC folder, not in this repo). It exited 1 inside pkg's
own bootstrap, before any Scriptorium code ran:

```
Error: [pkg] V8 rejected the bytecode cache for C:\snapshot\scriptorium\bin\scriptorium.js. This
usually means the binary was built with mismatched host/target V8 (cross-platform bytecode). Rebuild
pkg with --public-packages "*" --public or --sea to avoid bytecode.
```

v0.1.0 and v0.1.1 fail identically. As far as anyone can tell, **no published Windows exe has ever
started.** `scripts/package.js`'s `buildInvocation()` built plain `pkg --debug -t <target> -o <out>
package.json`, with no `--no-bytecode`, `--public`, `--public-packages` or `--sea`. pkg compiled V8
bytecode for the win-x64 target *on this Linux build host*; V8's serialised code cache only loads back
on a matching V8 build, so the embedded Windows Node (v22.23.2) rejected it at load.

**Why nothing in the pipeline caught this:** `npm test` runs source under plain `node`, never through a
packaged binary. `spike/run-pin-proof.sh` and every packaging proof to date built a *Linux* target on
Linux, where the bytecode is self-consistent and loads fine. `scripts/pkg-assets.js`'s asset gate and
`scripts/content-markers.js`'s rules-content gate both *inspect* the produced binary (its `--debug`
log, its bytes), neither had ever *run* it. Every layer of verification was blind to this defect in
the same way: nobody had ever executed a win-x64 artefact, on any host, at any point in the pipeline.

## Decision: stop emitting bytecode

`buildInvocation()` (`scripts/package.js`) now passes `--no-bytecode --public --public-packages "*"`,
verbatim the fix pkg's own error message names. This makes the packed snapshot carry plain JS instead
of a V8 code cache, which is portable across V8 builds because it was never V8-build-specific to begin
with, so cross-compiling win-x64 from this Linux box keeps working exactly as before.

The alternative route, build win-x64 *on* Windows, sidestepping cross-V8-bytecode entirely, was
considered and rejected for now: Scriptorium has no Windows build host, and 0001's fallback ladder
already ruled out paid Windows CI on cost (G2: build on this box). Nothing about that ruling changed
here; if a Windows host becomes available later, bytecode could be re-enabled for a same-host build,
but that is a future decision, not this one.

`--sea` (pkg's Node-SEA wrapper) was not chosen. 0001 already rejected Node's own SEA feature before
the packaging spike specifically because it cannot cross-compile Linux to Windows; `@yao-pkg/pkg`'s
`--sea` flag is a different code path (it *can* target win-x64 from here, per pkg's own `--sea` help
text), but it is marked Experimental in this pkg version and changes more of the packaging pipeline
than the problem requires (SEA mode forces `STORE_CONTENT` for everything via a different code path,
`walker.js:382`, and skips the ESM transform pkg otherwise runs). `--no-bytecode` alone is the smaller,
better-understood change: same walker code paths as every prior release, same `pkg.patches` mechanism,
same `--debug` log shape the existing asset gate already parses. Not re-litigated further; revisit only
if `--no-bytecode` itself turns out to be insufficient.

### Why `--no-bytecode` alone is not enough

`--no-bytecode` alone throws `"--no-bytecode and no source breaks final executable"` (`packer.js:66`)
for any file pkg would otherwise store bytecode-only. Whether a file gets a source fallback depends on
`marker.public` / `params.publicPackages` (`walker.js:555-562,779-785`): without `--public` and
`--public-packages "*"`, most of the dependency tree is not "public" and pkg has nothing to fall back
to when bytecode is turned off. `--public` marks the top-level project public; `--public-packages "*"`
marks every dependency public too. Confirmed by reading `walker.js` and `packer.js` directly (no
version needs re-deriving here; this is the exact mechanism, not a guess).

## The cost: the packaged JS is now readable, not bytecode

This is the trade-off the brief asked to be written down plainly rather than discovered later.

**Before (bytecode):** a prior QA pass (recorded in `docs/decisions/0007-rules-content-redaction.md`,
"The ship gate is an artefact scan, not a flag") found that `strings -e l` and `-e b` against a
bytecode-built binary found nothing, the two redacted files' marker strings sat inside V8's serialised
code cache as latin1-encoded bytes, invisible to a naive text scan. That is why
`scripts/content-markers.js`'s `scanBuffer()` was written to check both latin1 and utf16le byte
encodings directly against the raw buffer, rather than relying on `strings`.

**After (`--no-bytecode`):** plain JS source is embedded verbatim. Confirmed directly against the real
v0.2.0 release build (`dist/v0.2.0/scriptorium-win-x64.exe`, built under this ADR's flags):

```
$ strings -a dist/v0.2.0/scriptorium-win-x64.exe | grep -m5 "runGeneratorBuild\|ScriptoriumError\|Global flags"
const { VaultUnreachableError, ConfigError, UpdatePrerequisiteError, ScriptoriumError } = require('../src/util/errors');
Global flags: --campaign <name>, --config <path>, --json, --quiet, --no-color, --version, --help
    if (err instanceof ConfigError || err instanceof ScriptoriumError) {
class ScriptoriumError extends Error {
class VaultReadError extends ScriptoriumError {
```

Full, readable Scriptorium source (comments, variable names, control flow) is extractable from the
shipped binary with a plain `strings` pass, no bytecode disassembly, no latin1/utf16le byte-scan
needed. This did not previously offer any licence-compliance protection (the bytecode was never
presented as encryption or DRM), but it is a real change in what a person examining the binary can
read, and is recorded here so nobody discovers it by surprise. `README.md`'s Third-party notices
section and `docs/PROVENANCE.md` (section 16, added by this change) both now say so.

**Binary size, both under the shipped invocation (`scripts/package.js`, win-x64, package.json as pkg's
input):**

| Build | Size |
|---|---|
| v0.2.0 as published (bytecode, broken) | 63,839,897 bytes |
| This fix (`--no-bytecode --public --public-packages "*"`) | 61,930,554 bytes |

The new build is *smaller* (~1.9 MB / ~3%), not larger, a V8 code cache is not free, and dropping it
outweighs shipping plain text for this project's size of dependency tree. Not something this decision
relied on, but recorded since a size regression would have been a reasonable thing to worry about and
didn't happen.

## Re-verifying the rules-content redaction gate under the new route

`docs/decisions/0007-rules-content-redaction.md`'s AC-R6/AC-R7/AC-R8 positive/negative controls were
run against a *bytecode* binary. The brief for this fix required re-running them against the new route
before trusting that the gate still means anything, because the encoding situation changes completely
once bytecode is off.

**Positive control, re-run under `--no-bytecode --public --public-packages "*"`, real win-x64 release
target.** `package.json`'s `pkg.patches` key removed (scratch copy, `git diff` clean afterward), same
invocation (`scripts/package.js --target node22-win-x64 --out <scratch>`):

```
package: refusing to ship, the packaged binary contains rules-content marker(s):
  - <scratch>/positive-control-win-x64.exe: "Source: GURPS Basic Set 4e, p. B552"
  - <scratch>/positive-control-win-x64.exe: "Source: GURPS Basic Set 4e, p. B550"
  - <scratch>/positive-control-win-x64.exe: "Humanoid Hit Location"
  - <scratch>/positive-control-win-x64.exe: "Cthulhu Mythos"
  - <scratch>/positive-control-win-x64.exe: "Spot Hidden"
```

All five marker strings found, by the gate's own `assertNoRulesContent()`/`scanBuffer()`, the same
function that ships in `scripts/package.js`, not a bespoke re-implementation, and the gate refused to
ship exactly as designed (non-zero exit, output removed). Had this come back clean, the correct
response would have been to stop and report a broken proof strategy (per 0007's own rule); it did not.
Mechanically this still works under `--no-bytecode` for the same reason it worked before: `scanBuffer()`
checks latin1 bytes, and latin1 and UTF-8 encode plain ASCII identically, so the now-plain-text marker
strings are found exactly the same way the old latin1-cache bytes were.

**Negative control**, same build, `pkg.patches` restored (this is simply the real release build): zero
marker hits, build succeeded, `dist/v0.2.0/SHA256SUMS` written. Equivalent to AC-R7 under the new route.

**`pkg.patches` still applies under the new flags.** Both controls above depend on it: the positive
control needed the *unpatched* file's content to still be readable in the walker's records for
`hasPatch`/`stepPatch` reasoning to matter at all, and the negative control needed the patch to actually
erase it. `walker.js`'s `stepPatch` fires off `hasPatch(record)` (`:791`), not off the `bytecode`
variable, reading the source directly confirms patching and bytecode compilation are two independent
steps in the pipeline, so turning bytecode off was never going to disable patches. Both controls behaving
as expected is the proof; no separate mechanism check was needed.

**Conclusion: the gate is not decorative under the new route.** `test/redactions.test.js`'s unit-level
coverage of `scanBuffer()`/`assertNoRulesContent()` is unchanged and still exercises the same functions
`scripts/package.js` calls at build time.

## The other hole: nothing had ever executed the artefact

Every existing gate inspects the artefact (its `--debug` log, its bytes). None had ever run it, the
root cause this whole defect exists to fix. `scripts/package-selftest.js` adds a startup self-test to
`scripts/package.js`, after the asset and rules-content gates and before `SHA256SUMS` is written, mirror-
ing their exact fail shape (print detail, remove the output, exit 1, write no `SHA256SUMS`).

**What is actually achievable from this Linux build host, stated plainly:** a win-x64 binary cannot be
executed here at all (no `wine`; confirmed, `which wine` reports not found, same as 0001's own Half B
finding). So the self-test cannot prove the win-x64 artefact starts. What it *can* prove: the exact same
invocation (`buildInvocation()`, same flags, same `pkg.patches`) produces something that starts on this
host, by running (for a Linux target) or building-and-running (for win-x64, a throwaway
`node22-linux-x64` exe from the identical invocation). That is a genuine pipeline-level proof, the
flags are accepted, `pkg.patches` still applies, the packed snapshot is well-formed enough for pkg's own
bootstrap to hand off into `bin/scriptorium.js`'s CLI dispatch, but it is **not** a Windows proof. A
Windows-only failure (wrong base binary, a Windows-only code path, anything platform-specific) would
sail straight through this guard undetected. That gap stays open until an actual Windows build/test
host exists; this self-test closes the pipeline-level blind spot cheaply, not the platform one, and its
own module header says so.

Exercised end-to-end against the real release build (`npm run package`, win-x64 default target):

```
package: startup self-test: node22-win-x64 cannot be executed on this Linux host; building a throwaway
node22-linux-x64 exe from the identical invocation to prove the pipeline (flags, pkg.patches) produces
a runnable artefact, this does NOT prove node22-win-x64 itself starts
package: startup self-test passed: --version exited 0: 0.2.0
packaged dist/v0.2.0/scriptorium-win-x64.exe
wrote dist/v0.2.0/SHA256SUMS
```

Total extra cost: one more `pkg` build (linux-x64, already cached base binaries) plus one `--version`
exec. The whole `npm run package` run, including the new self-test, took under 3 seconds on this box.

`spike/run-pin-proof.sh`'s own `node scripts/package.js --target node22-linux-x64 --out ...` call
exercises the *other* branch of `planSelfTest()` (`mode: 'direct'`): since the requested target already
matches this host, the self-test runs the real produced artefact directly rather than building a proxy.

`scripts/package-selftest.js`'s `planSelfTest()` is pure (no filesystem/process calls) and unit tested
directly (`test/package-selftest.test.js`) against every branch (host-match, no-host-match, non-linux-x64
host); `execVersionProbe()` is unit tested against small throwaway scripts, not a real pkg build, same
convention 0007 used for `scanBuffer()`/`assertNoRulesContent()`, so `npm test` stays in the
milliseconds-not-seconds range and the real pkg-build proof lives in this ADR and in
`spike/run-pin-proof.sh`, not in the fast unit-test loop.

## What still cannot be verified from Linux

Stated plainly, not softened: **whether the win-x64 exe actually starts on Windows is not verified by
anything in this repository or this ADR.** The positive/negative controls above prove the rules-content
gate still has teeth; the self-test proves the build pipeline (flags, patches, snapshot integrity)
produces a runnable artefact on the one platform this box can execute. Neither one runs win-x64 code.
The only real verification of that claim is the Windows verifier re-running the same startup check
(a private QC folder, not in this repo, using the same method) against a
build produced under this ADR's flags, once the owner decides to cut a new release. That is explicitly out
of scope here: no release, no tag, no push (orchestrator instruction).

## Consequence

- `scripts/package.js`'s `buildInvocation()` gained three flags; its file-header comment and the
  `pkg.patches` gate's own comment were updated to match (mechanism, not behaviour, changed under the
  gate).
- `scripts/package-selftest.js` (new) holds the self-test decision logic and exec probe, both unit
  tested in `test/package-selftest.test.js` (new).
- `docs/PROVENANCE.md` gained a short addendum (section 16) recording the readable-JS trade-off.
- Version stays `0.2.0` as of this ADR. Since 0.2.0 was already published (and broken, per the
  defect above) it could not be re-cut, so the fix ships as `0.2.1` in a follow-up commit. The
  release decision (whether/when to cut a new tag) is still the owner's.
