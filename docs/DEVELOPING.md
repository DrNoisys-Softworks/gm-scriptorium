# Developing GM-Scriptorium

This guide is for people who change the code: contributors, maintainers and anyone reviewing a
change. It answers three questions. What must you never edit? Which checks must pass before a
change is done? How is a release made? If you work with an AI coding assistant, it reads the same
rules; point it at `AGENTS.md`.

GM-Scriptorium is a compiled command-line tool, released as a Windows and a Linux executable. It checks a gm-apprentice campaign vault
(the folder of markdown pages a GM writes in), builds a player-facing website from it, and updates
itself from this repository's releases. Its commands are `init`, `check`, `build`, `serve`,
`status`, `config` and `update`.

Where this project depends on the upstream generator's behaviour, read
[Collaborating with the upstream generator](COLLABORATING.md) as well.

## The rule that matters more than any other

**Verify the artefact, not the source.** What ships is a single-file Windows executable,
cross-compiled from Linux by `@yao-pkg/pkg`. It is a different program from the source tree, and a
green test suite says nothing about it.

Two defects shipped on the same day, 2026-09-17, after four rounds of review and a green suite:

1. The executable crashed with `Intl.Segmenter is unavailable in this executable` on any vault
   containing withheld names, which is the tool's entire purpose. Every test ran the source under
   plain node, where the bug cannot occur, because it comes from how the executable is packaged.
2. No published Windows executable had ever started, across three releases. The packager had
   cross-compiled with V8 bytecode that Windows V8 rejects. The "packaging proof" built a Linux
   target on Linux, where the bytecode loads fine.

So when a fix depends on the packaged binary, or on Windows specifically, say so and mark it open.
Do not report a Windows-found defect as fixed on the strength of Linux tests. An issue found on
Windows stays open until it is confirmed on Windows, even when the fix is obviously right.

`scripts/package-selftest.js` states in its own header what it does and does not prove. It builds
a throwaway Linux target to prove the pipeline, and proves nothing about the Windows artefact.

## Never touch

**`assets/vault-template/`, by hand.** It is the output of gm-apprentice's vault scaffold, captured and derived by `scripts/vault-template.js`. Change it only by following the starter pin bump procedure in [COLLABORATING.md](COLLABORATING.md); a hand edit breaks byte parity with the scaffold and fails the manifest check.

**`node_modules/gm-apprentice-publish/`, directly.** It is a vendored, integrity-pinned copy of the
upstream generator's own release tarball. The current pin is `publish-v1.12.3` (commit
`3517ffd`). It is verified against the release's `SHA256SUMS` and, file by file, by sha256 against
`vendor/gm-apprentice-publish/PIN.json`.

Go through the facade at `src/generator/pinned.js`, which is the only sanctioned way in. Re-run
`npm run verify-generator` after anything near it. A generator-side fix goes upstream first and
comes in through a pin bump (see "Pin bump procedure" in
[COLLABORATING.md](COLLABORATING.md)).

## Gates that must stay green

| Command | What it checks |
|---|---|
| `npm test` | Runs the whole test suite with `node --test`. |
| `npm run verify-generator` | The installed generator tree still matches `PIN.json`. |
| `npm run package` | Builds both the win-x64 and linux-x64 targets into `dist/v<version>/`, with one combined `SHA256SUMS` covering both binaries and the notices file (see ADR 0001). |

`npm run package` runs six gates for each target before it writes anything:

1. Generator-pin verification. It re-verifies the pin itself, not just through the script above.
2. Notices freshness.
3. Asset embedding: every expected asset is confirmed inside the executable.
4. Rules-content markers.
5. A startup self-test of the packaged build.
6. Starter template verification: every file under `assets/vault-template/` must match its manifest's sha256 and token counts, with no unlisted file on disk. It fails closed, before the build starts.

If any target's gate fails, the run removes every binary it already produced and exits 1, so
`dist/v<version>/` never holds a binary that `SHA256SUMS` doesn't cover. `--target` and `--out`
still override to a single target.

A change that touches packaging, notices or embedded assets is not shown to work by `npm test`
alone. Run `npm run package`: five of its six gates exist nowhere else.

## Constraints that are tests, not preferences

Each of these exists because something went wrong once. **Editing one of them to make a fix pass
inverts the guarantee it gives.** If a fix needs one changed, raise it with the maintainers rather
than deciding alone.

- `test/update-module-graph.test.js`: nothing in `src/update/*` or `src/cli/update.js` may
  acquire a relative require that resolves into `src/vault/` or `src/build/`, and `src/update/*`
  may not gain a direct network call. The network assertion is a `/\bfetch\(/` regex over raw
  source, so an injected dependency named `fetch`, or one called as `.fetch(`, breaks the build
  with a confusing message.
- `test/generator-module-graph.test.js`: no network builtin may appear anywhere in the module
  graph from `bin/scriptorium.js`, except the allowlisted `src/serve/server.js`, and every
  specifier must resolve.
- `test/proc-structure.test.js`: only `src/proc/run.js` (plus the two older spawners, `src/cli/config.js`
  and `src/update/gh.js`) may start a program, and every test that uses the spawner must go through
  `test/helpers/proc-fakebin.js`, so no test can start a real program. See
  [ADR 0046](decisions/0046-one-process-spawner.md).
- `test/net-structure.test.js`: only `src/net/egress.js` (and the listener in `src/serve/server.js`) may load a network module, nothing under `src/net` names a fetch-style network token, and every test that uses egress goes through `test/helpers/net-stubs.js`, so no test can reach anything but this computer. See ADR 0024.
- `test/setup-structure.test.js`: the admin panel reaches the config writer only through `src/setup/register.js`, from the setup commit route and the campaign set-default and remove routes, and setup code writes to the vault only through `src/vault/packwrite.js`. See [ADR 0028](decisions/0028-installer-and-first-run.md) and [ADR 0050](decisions/0050-several-campaigns.md).
- `test/vault-create-structure.test.js`: `src/vault/vaultcreate.js` never deletes, renames, appends, truncates or uses a recursive `mkdirSync`, every `writeFileSync` in it is `flag: 'wx'`, it requires only `fs`, `path`, the error classes and the exclusions module, and `createVault` is named only in that file, `src/setup/register.js` and `src/cli/init.js`. See [ADR 0048](decisions/0048-new-campaign-vault.md).
- `test/admin-campaign-fields.test.js`: every field the panel context carries is classified as belonging to the process or to one campaign, so a switch can never carry one campaign's state into another. See [ADR 0050](decisions/0050-several-campaigns.md).
- `test/launch-structure.test.js`: the browser opener is named only in `src/proc/run.js` and `src/cli/launch.js`, launch code requires no other spawner, and every test that loads the launcher injects its opener, so no test opens a real browser. See [ADR 0028](decisions/0028-installer-and-first-run.md).
- `test/folders-structure.test.js`: the folder picker's listing lives in `src/setup` (so it is write-free), its one folder write is a single non-recursive create in `src/admin/foldercreate.js`, reached only from its own route, and every filesystem call goes through the shared bounded probe. See [ADR 0049](decisions/0049-folder-picker.md).
- `src/util/exitcodes.js`: the exit-code table is frozen. 0 is OK, 1 is a Scriptorium bug, 2 is
  a failed check, 3 is an unreachable vault and 4 is an update prerequisite. **No new exit
  codes.** User mistakes are mapped onto these (see "Exit codes for user errors" below). A cleanup or delete failure must never change the code a user sees. Copy the pattern in
  `src/build/run.js` (best-effort removal, swallowed, commented), tested in
  `test/build-output-gate.test.js`, which injects `EBUSY` through an `fs.rmSync` monkeypatch.
- **No new runtime dependency without saying so explicitly.** Anything new forces a regeneration
  of the notices and a licence re-audit (see [Licence provenance](PROVENANCE.md)).

## Exit codes for user errors

The table above is frozen and has no usage-error code (issue #108, owner decision 2026-10-07).
A user mistake therefore maps onto an existing code: a problem with the config, the campaign or
the vault exits **3** (a `VaultUnreachableError`; use it, do not invent a class), and any other
user mistake exits **1** with a plain one-line message and no stack trace. `status` with no
campaigns stays **0** because it is informational. Never use 2 (check failed) or 4 (update
prerequisite) for a user mistake. The table-driven test is `test/exit-codes-user-errors.test.js`.

| Case | Old code | New code | Message |
|---|---|---|---|
| no campaigns registered (check, build, serve) | 1 | 3 | `no campaigns registered; run "gm-scriptorium config add" first` |
| unknown campaign name | 1 | 3 | `no campaign named "x" in config (known: ...)` |
| several campaigns, none chosen, no default | 1 | 3 | `no campaign specified and no default_campaign set, with N campaigns registered (...)` |
| `--config` file does not exist | 1 | 3 | `config file not found: <path> (create it with ...)` |
| malformed config file (bad TOML, missing config_version, bad entry) | 1 | 3 | the loader message, e.g. `config is not valid TOML: ...` |
| config entry points at a missing vault | 3 | 3 | `campaign "x": configured vault path does not exist: <path>` (unchanged) |
| campaign has no output folder (build, serve) | 1 | 3 | `campaign "x" has no output folder, so "build" has nowhere to put the site. ...` |
| `--out` inside the vault, containing the vault, or a filesystem root | 1 | 3 | `refusing to build inside the vault: <path>` (and the two siblings) |
| `serve` before any build (output missing) | 1 | 3 | `no build exists at <path>; run "gm-scriptorium build" first or pass --build` |
| `config remove` or `config set-default` of an unknown name | 1 | 3 | `no campaign named "x" to remove` / `no campaign named "x"` |
| bad `SCRIPTORIUM_PROFILE`, or two equally specific profiles | 1 | 3 | `SCRIPTORIUM_PROFILE="x" names a profile that does not exist ...` / `two profiles are equally specific for this machine: a, b` |
| unusable campaign pack: pack folder missing, no `vault.config.json`, malformed `pack.toml`, unknown theme, missing or oversize image slot file | 1 | 3 | the pack message, e.g. `campaign "x": pack directory does not exist: <path>` |
| campaign entry with no `vault` key | 1 | 3 | `campaign "x" has no vault configured. Set one with: gm-scriptorium config add x --vault <vault folder> --out <output folder>` |
| vault with no `site_config`, no `pack` and no `_meta/scriptorium` (what a plain `config add` makes) | 1 | 3 | `campaign "x" has no site config: ... does not exist. Run "gm-scriptorium init" to create one, or set site_config or pack on the campaign.` |
| `status` with no campaigns | 0 | 0 | `no campaigns registered; run "gm-scriptorium config add" first` (informational) |
| unknown command | 1 | 1 | `unknown command: chek` plus the usage block |
| unknown flag, or a flag with no value | 1 | 1 | `unknown flag --prot for "build"` / `--vault needs a value` |
| `--port abc`, `99999`, `-5` (plain or `--admin`) | 1 | 1 | `--port must be a whole number from 0 to 65535 ...` |
| port in use | 1 | 1 | `failed to start server: port 8080 is already in use on 127.0.0.1` |
| privileged port without rights (EACCES) | 1 | 1 | `failed to start server: port 80 needs administrator rights ...` |
| `--host` with `--admin` | 1 | 1 | `serve --admin only ever listens on 127.0.0.1, so it does not accept --host` |
| `init --theme nonesuch` | 1 | 1 | `unknown theme "nonesuch"; valid themes: ...` |
| `init --new-vault` together with `--vault`, `--system` without `--new-vault`, or `--yes --new-vault` without `--name` or `--system` | 1 | 1 | `init takes --vault or --new-vault, not both` / `--system only applies with --new-vault` / `init --yes --new-vault needs --system <id> or --system none` |
| `init --system nonesuch`, or a site title the new pages cannot hold exactly as typed | 1 | 1 | `unknown game system "nonesuch"; valid systems: ..., none` / `site title can't be written into the new vault's pages exactly as typed; leave out double quotes and backslashes` |
| the starter in this build is missing, or fails its check against its manifest | 1 | 1 | `this build has no new-campaign starter` / `the new-campaign starter in this executable failed its integrity check: <file>; nothing was written` |
| `init --new-vault` into a folder that is not empty, is a file or a link, is a filesystem root, is inside a vault or inside the settings folder; or the creation stops part-way | 1 | 3 | `refusing to create a vault in <path>: it is not empty (it holds ...)` and its siblings / `stopped creating the vault in <path>: ...; created before stopping: ...` |
| `init` aborted by closed stdin | 1 | 1 | `init aborted; nothing written` |

Not remapped, still 1: a folderMap output collision, and any genuinely unexpected
exception (including one while loading a pack), which prints its stack. Only a `ConfigError`
raised while resolving a pack becomes exit 3 (`asPackProblem` in `src/cli/check.js`).

## Testing standards

- **Write the failing test first and watch it go red.** Then fix. A test written after a passing
  fix usually asserts the fix's shape rather than the behaviour.
- **Prove a test by mutation, not by reading the diff.** Break the fix and confirm the new test
  goes red. Record the mutation and what you saw. A mutation that leaves the suite green is a
  finding in its own right.
- **Never derive an assertion's expected value from the code under test.** This has happened
  here: an age-threshold test read the same constant its mutation changed, so the mutation passed
  and the test looked fine. It is invisible in a green suite. State expected values
  independently.
- **A hardcoded version literal is a release blocker.** A test that hardcoded `0.2.2` to avoid the
  tautology above then failed on the next bump. Assert against `package.json`, and state the
  residual in a comment.
- **Name the tests that pass today and so prove nothing**, so a reviewer can refuse them as
  evidence. This has caught real weak evidence.
- **Write residual gaps down** rather than leaving them for the next person to rediscover. The
  house style is the limits block at the top of `src/build/plan.js`, and the "Will catch / Will
  not catch, deliberately" section of [ADR 0009](decisions/0009-output-leak-scan.md).

## Release procedure

Maintainers make releases. These steps must run in this order, and two of them have already bitten
someone.

1. Bump `version` in `package.json`. Leave the stale root version in `package-lock.json` alone.
   Releases so far have, to avoid widening the notices diff mid-release.
2. Run `npm run notices`. The notices header carries the Scriptorium version, and
   `scripts/notices-freshness.js` strips only the `Generated:` line before comparing, so **a
   version bump fails `npm run package` until the notices are regenerated.** That is deliberate.
   Confirm the diff is only the version line and the timestamp.
3. Run `npm test`, `npm run verify-generator` and `npm run package`. All three must pass.
   `npm run package` builds both `gm-scriptorium-win-x64.exe` and `gm-scriptorium-linux-x64`.
4. Commit the bump with the regenerated notices.
5. In the public repository, run `node scripts/public-guard.js release <previous tag>` with the
   private lists configured (for the first public release, use the public root commit). It must
   exit 0. Then push, then tag, then push the tag.
6. Rebuild both executables after the release commit, from a cleared `dist/`, and check the build
   timestamp is later than the commit. A stale binary from an earlier commit has nearly shipped
   here.
7. Create the release as a prerelease, with both binaries, `THIRD-PARTY-NOTICES.txt` and the one
   combined `SHA256SUMS`.
8. Download the assets back off the release page and re-hash every one of them before announcing
   anything.
9. Have the Windows checks run on the release, using the Windows verification runbook at
   `.agents/windows-verification.md`. Promote the release to latest only when they pass.
10. Run the release-time `update` check, which is still **open**. Build a lower-version
    `scriptorium-linux-x64` in a scratch folder as a stand-in for an old install. Point it at the
    new release's tag and run `update --pre`. It should download, verify against `SHA256SUMS`, and
    end up replaced with mode 0755, with the old copy kept beside it as `.old-<version>`, and the
    new version named in the success message. Keep this marked open until it has been run once
    against a real published release. `test/update-linux.test.js` and
    `test/update-packaged-guard.test.js` cover the pieces (the ELF check, the packaged-only guard,
    the 0755 mode) with injected dependencies, not a real download and self-replace.

## Push policy

[COLLABORATING.md](COLLABORATING.md) holds this repository's push and branch rules.

**A multi-step shell block must never end in a push.** A broken chain here once pushed an
unreviewed commit, because an earlier step failed and the trailing `git push` ran anyway.

## Conventions

- **No real campaign, player, character or personal names, private paths, host names, IP
  addresses or email addresses** in repo text, fixtures, commit messages, issues or release
  notes.
- `scripts/public-guard.js` enforces that rule. It is a list-free CI check on every push and pull
  request. Maintainers also scan against private lists kept outside the repository, before every
  push and release. See [ADR 0031](decisions/0031-public-repo-privacy-guard.md).
- **Issues live on GitHub**, not in files. `docs/issues/` is only a pointer.
- **`docs/agent-runs/` is gitignored and must stay that way.** It can hold private campaign
  material, and this repository is public. Never commit it. The `.gitignore` entry is what makes
  that decision hold.
- **Decision records** are `docs/decisions/NNNN-*.md`. A decision with a rejected alternative
  worth remembering gets one, and the rejected alternative is written down with it.
- **Write for people.** Documents in this repository are for human readers: GMs, contributors and
  the upstream author. Open with who the page is for and what it answers. Use short sentences,
  and define a term when you first use it. Cite a decision record by number and section heading,
  never by line number. Keep internal work codes, slice names and role names out of prose. Leave
  out em dashes, emojis and promised dates, and use ">" rather than arrows. A decision record
  opens with a Summary of 3 to 6 plain sentences: what changed for a GM or contributor, the
  decision, the main rejected alternative, and any limit a user will hit.
- Material for AI assistants (working rules, onboarding, the Windows runbook) lives in `.agents/`,
  reached through `AGENTS.md`. Keep it out of the human documents.
- Windows-side behaviour is verified only through the runbook at
  `.agents/windows-verification.md`. A fix with a Windows leg that doesn't update its criterion
  there never gets verified where it was found.
