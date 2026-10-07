# 0004. `update` authenticates via the `gh` CLI subprocess only

Status: accepted (orchestrator ruling G1, implemented phase 2, 2026-09-10).

## Summary

`update` never makes a network request itself. It asks the GitHub command-line tool, `gh`, to look up and download releases, and the only other credential it accepts is a token that is passed straight through to `gh`. This was chosen because the repository was private at the time and the owner preferred reusing an already signed-in `gh` over storing a long-lived token. A user will hit one limit: `update` needs `gh` installed and signed in (or a token set), and its error messages say how to fix each case. The repository is public now; ADR 0030 covers that move, and the reasoning here still holds.

## Decision

`scriptorium update` never makes an HTTP request itself. Every network operation shells out to the
`gh` CLI (`src/update/gh.js`, `release.js`): metadata via `gh api repos/Noisyink/scriptorium/releases/...`,
asset download via `gh release download`. A fine-grained PAT via `SCRIPTORIUM_GITHUB_TOKEN` is the only
fallback, forwarded to the `gh` child process as `GH_TOKEN` and never read into a variable that could be
logged.

## Why this, given the repo was private

The repo (`Noisyink/scriptorium`) was private (orchestrator ruling G1), which changed the update
mechanism's constraints from what a public-repo tool would need. A private repo meant every metadata
and download request had to be authenticated, and GitHub returned 404 for a private repo to an
unauthorised caller, indistinguishable from "no such release" (`src/update/release.js`'s
`fetchLatestRelease` treated any 404 as `UpdatePrerequisiteError`, never as an unauthenticated retry,
so this ambiguity was never resolved by guessing).

The owner preferred reusing an already-authenticated `gh` over adding a long-lived token.




## What this buys, provably

- **Criterion 26 (no network call except to GitHub) becomes a code-inspection fact, not a testing
  claim.** There is no HTTP client anywhere in Scriptorium's own dependency tree or source. A grep for
  `require('http')`, `require('https')`, `fetch(` across `src/update/` returns nothing (asserted by
  `test/update-module-graph.test.js`'s second test).
- **Scriptorium itself never sees, stores, or transmits a token.** `gh` handles its own credential
  storage; `SCRIPTORIUM_GITHUB_TOKEN`, when set, is copied into the child process's environment
  (`src/update/gh.js`'s `runGh`) and nowhere else, discharging "never logged, never written to config,
  never in an error message" structurally rather than by code-review vigilance.
- **`src/update/` cannot reach campaign content even if a future change tried to.** Asserted by the
  same module-graph test: the require graph starting from every file under `src/update/` (plus its
  entrypoint, `src/cli/update.js`) never resolves into `src/vault/` or `src/build/`.

## Exit code 4

A dedicated exit code (`EXIT_CODES.UPDATE_PREREQUISITE`, distinct from the general-failure code 1)
covers: `gh` not found on `PATH` (with a Windows-specific probe of the two common install locations,
since a fresh `gh` install does not reach an already-open shell's `PATH`), `gh` present but
unauthenticated, and an unauthenticated-indistinguishable-from-missing 404. Every one of these messages
names the fix (`gh auth login`, or the `SCRIPTORIUM_GITHUB_TOKEN` alternative with the required
`Contents: Read` scope) rather than just reporting failure.

## What is not yet live-verified

This box has `gh` 2.23.0 authenticated as `Noisyink`, so the discovery and 404 paths were exercised
live against the real (not-yet-existing) `Noisyink/scriptorium` repo and correctly produced exit 4. The
download, checksum-verify, and self-replace path has no real release to test against yet; that
verification is deferred to `.agents/windows-verification.md` once a release exists to test with.

## Addendum: the repository this points at is now public (ADR 0030)

The repository `update` talks to is now public, not private, but nothing in this ADR's reasoning
changed as a result: `gh` is still the only thing that makes a network call, a fine-grained PAT is
still the only fallback credential, and authentication is still asserted up front every time,
because a public repository changes who is allowed to read it, not how this tool reaches GitHub.
The one thing that did change is the 404 message's wording: it no longer says "private repo",
since that would now be misleading, and it names the public repository's own releases page
instead. ADR 0030 covers the repository move itself, the renamed release assets, and the bridge
that carries an existing install across to the new repository without it ever needing to know
where the old one was.
