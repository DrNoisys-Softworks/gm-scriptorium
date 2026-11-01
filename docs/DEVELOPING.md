# Developing GM-Scriptorium

This guide is for people who change the code: contributors, maintainers and anyone reviewing a
change. It answers three questions. What must you never edit? Which checks must pass before a
change is done? How is a release made? If you work with an AI coding assistant, it reads the same
rules; point it at `AGENTS.md`.

GM-Scriptorium is a compiled command-line tool, released as a Windows and a Linux executable. It checks a gm-apprentice campaign vault
(the folder of markdown pages a GM writes in), builds a player-facing website from it, and updates
itself from this repository's releases. Its commands are `init`, `check`, `build`, `serve`,
`status`, `config`, `remote`, `desktop` and `update`.

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
upstream generator's own release tarball. The current pin is `publish-v1.26.0` (commit
`228fa16`). It is verified against the release's `SHA256SUMS` and, file by file, by sha256 against
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
| `npm run package` | Builds both the win-x64 and linux-x64 targets and the Windows tray helper into `dist/v<version>/`, with one combined `SHA256SUMS` covering the three binaries and the notices file (see ADR 0001 and [ADR 0057](decisions/0057-windows-desktop-app.md)). It needs mingw-w64 on every machine that runs it (see gate 8). |

`npm run package` runs seven gates for each target before it writes anything (the seventh applies to the Windows target only), then an eighth once both targets have passed:

1. Generator-pin verification. It re-verifies the pin itself, not just through the script above.
2. Notices freshness.
3. Asset embedding: every expected asset is confirmed inside the executable.
4. Rules-content markers.
5. A startup self-test of the packaged build.
6. Starter template verification: every file under `assets/vault-template/` must match its manifest's sha256 and token counts, with no unlisted file on disk. It fails closed, before the build starts.
7. Windows branding (win-x64 only). Before the build, `scripts/winres.js` checks the pkg base binary against the hash pkg-fetch expects and writes a copy with the Lantern icon and the version strings; only the Windows build uses that copy. After the build, `node scripts/winres.js check` reads the exe back: one icon group with the eight sizes, exactly the eight version strings, and no Node.js value. This gate does not prove that Windows draws the icon or starts the exe; that is criterion C142. The startup self-test still proves nothing about win-x64.
8. Tray helper (win-x64). `scripts/tray.js` cross-compiles `gm-scriptorium-tray-win-x64.exe` from `packaging/windows/tray/` with mingw-w64 and checks the file it made: an x64 GUI program with address-space randomisation, data execution prevention and high-entropy addresses, no symbol table, imports only from seven Windows system libraries, a manifest with `asInvoker` and per-monitor DPI, and the branding (`node scripts/winres.js check-tray`). It needs the Debian packages `gcc-mingw-w64-x86-64-win32`, `binutils-mingw-w64-x86-64` and `mingw-w64-x86-64-dev` (the win32 thread model, so no winpthread library) on the release machine, on a contributor's machine and in CI. Without them it fails closed. It proves nothing about how Windows runs the helper; that is criteria C190, C192, C194 and C203.

If any target's gate fails, the run removes every binary it already produced and exits 1, so
`dist/v<version>/` never holds a binary that `SHA256SUMS` doesn't cover. `--target` and `--out`
still override to a single target.

A change that touches packaging, notices or embedded assets is not shown to work by `npm test`
alone. Run `npm run package`: six of its eight gates exist nowhere else.

## Constraints that are tests, not preferences

Each of these exists because something went wrong once. **Editing one of them to make a fix pass
inverts the guarantee it gives.** If a fix needs one changed, raise it with the maintainers rather
than deciding alone.

- `test/update-module-graph.test.js`: nothing in `src/update/*` or `src/cli/update.js` may
  acquire a relative require that resolves into `src/vault/` or `src/build/`. `src/update/*` loads
  no network or process module and has no `fetch(` call, and the update graph reaches a network
  module only in `src/net/egress.js`, which it must reach. The `fetch(` assertion is a regex over
  raw source, so an injected dependency named `fetch`, or one called as `.fetch(`, breaks the build
  with a confusing message.
- `test/generator-module-graph.test.js`: no network builtin may appear anywhere in the module
  graph from `bin/scriptorium.js`, except the allowlisted `src/serve/server.js` and
  `src/net/egress.js`, and every specifier must resolve.
- `test/proc-structure.test.js`: only `src/proc/run.js` (plus the one older spawner, `src/cli/config.js`) may start a program, and every test that uses the spawner must go through
  `test/helpers/proc-fakebin.js`, so no test can start a real program. See
  [ADR 0046](decisions/0046-one-process-spawner.md).
  `test/proc-system-commands.test.js` pins the Windows system-tool list (`SYSTEM_COMMANDS`, today `icacls` only), which is run only from `System32` and never found through PATH; it grows only with a decision record.
- `test/net-structure.test.js`: only `src/net/egress.js` (and the listener in `src/serve/server.js`) may load a network module, nothing under `src/net` names a fetch-style network token, `egress.js` reads the location header in exactly one place, and every test that uses egress goes through `test/helpers/net-stubs.js`, so no test can reach anything but this computer. See ADR 0024.
- `test/setup-structure.test.js`: the admin panel reaches the config writer only through `src/setup/register.js`, from the setup commit route, the campaign add, set-default and remove routes, the update setting route and the desktop ports route, and setup code writes to the vault only through `src/vault/packwrite.js` and, when it creates a new vault, `src/vault/vaultcreate.js`. See [ADR 0028](decisions/0028-installer-and-first-run.md) (including its addendum "The update notice"), [ADR 0050](decisions/0050-several-campaigns.md), [ADR 0052](decisions/0052-add-a-campaign.md) and [ADR 0057](decisions/0057-windows-desktop-app.md).
- `test/vault-create-structure.test.js`: `src/vault/vaultcreate.js` never deletes, renames, appends, truncates or uses a recursive `mkdirSync`, every `writeFileSync` in it is `flag: 'wx'`, it requires only `fs`, `path`, the error classes and the exclusions module, and `createVault` is named only in that file, `src/setup/register.js` and `src/cli/init.js`. See [ADR 0048](decisions/0048-new-campaign-vault.md).
- `test/admin-campaign-fields.test.js`: every field the panel context carries is classified as belonging to the process or to one campaign, so a switch can never carry one campaign's state into another. See [ADR 0050](decisions/0050-several-campaigns.md).
- `test/launch-structure.test.js`: the browser opener is named only in `src/proc/run.js`, `src/cli/launch.js` and `src/desktop/host.js`, launch code requires no other spawner, and every test that loads the launcher injects its opener, so no test opens a real browser. See [ADR 0028](decisions/0028-installer-and-first-run.md).
- `test/tray-structure.test.js`: the tray helper's C source starts programs in exactly four named places, each by full path, writes the registry only from its Start with Windows and notification-state functions and never machine-wide, opens folders and web pages only with the `open` verb, loads no network, download or injection interface, and its protocol verb tables equal `HOST_VERBS` and `HELPER_VERBS` in `src/desktop/protocol.js`. See [ADR 0057](decisions/0057-windows-desktop-app.md).
- `test/folders-structure.test.js`: the folder picker's listing lives in `src/setup` (so it is write-free), its one folder write is a single non-recursive create in `src/admin/foldercreate.js`, reached only from its own route, and every filesystem call goes through the shared bounded probe. See [ADR 0049](decisions/0049-folder-picker.md).
- `test/desktop-structure.test.js`: nothing under `src/desktop` loads a network module or `child_process` or calls a fetch-style function, nothing there names `process.stdout`, `process.stderr`, `startupText(`, `launchLines(` or `adminUrl(` (so the protocol stream and the log stay clean and no token-bearing address is built), and every test that loads `src/desktop/host` injects its opener, so no test opens a real browser. See [ADR 0057](decisions/0057-windows-desktop-app.md).
- `test/test-ports-structure.test.js`: no test binds a fixed port outside that helper, and no two test files share one.
- `src/util/exitcodes.js`: the exit-code table is frozen. 0 is OK, 1 is a Scriptorium bug, 2 is
  a failed check, 3 is an unreachable vault and 4 is an update prerequisite. **No new exit
  codes.** User mistakes are mapped onto these (see "Exit codes for user errors" below). A cleanup or delete failure must never change the code a user sees. Copy the pattern in
  `src/build/run.js` (best-effort removal, swallowed, commented), tested in
  `test/build-output-gate.test.js`, which injects `EBUSY` through an `fs.rmSync` monkeypatch.
- `test/docs-reference.test.js`, `test/docs-reference-cli.test.js`, `test/docs-reference-pack.test.js`, `test/docs-reference-vault.test.js` and `test/docs-reference-checks.test.js`: the reference pages in `docs/reference/` match the code. A new settings key, exit code, environment variable, file kept beside the config, command, flag, subcommand, pack.toml key, a vault-config.md key the panel knows, a vault.config.json key the program reads, writes or requires, or a check id fails them until it has its text in `scripts/docs-reference-text.js` (or a row on the environment variables page) and `npm run docs-reference` has been run.
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
| `vault.config.json` missing `excludeDirs` or `folderMap`, or either of the wrong kind | 1 | 3 | `campaign "x": <path> is missing required key folderMap` (and the wrong-kind messages) |
| `build --force-check` or `build --no-check` on a vault with a setting the generator cannot read (what it hides, where the site is built or what it keeps; for example `publish.mode: gm` or a `preserveDirs` entry with a slash); plain `build` already stops at the check step with 2 | 1 | 3 | `build stopped: the settings have a fault ...` and the generator's fault lines |
| `build --force-check` on a vault whose `_meta/vault-config.yaml` is not valid YAML; plain `build` already stops at the check step with 2 | 1 | 3 | `_meta/vault-config.yaml is not valid YAML: ...` (one line, the generator's words) |
| `build --no-check` on a vault whose `_meta/vault-config.yaml` is not valid YAML | 1 | 3 | `_meta/vault-config.yaml is not valid YAML: ...` (one line, the generator's words) |
| `build --force-check` or `build --no-check` on a vault whose settings moved to `_meta/vault-config.yaml`, when the campaign pack still holds a hide-list entry the yaml lacks, or a folder map and the yaml sets none; plain `build` already stops at the check step with 2 | new | 3 | `campaign "x": <pack> still holds settings that _meta/vault-config.yaml does not, and the build no longer reads them there: excludeSections ("..."). Run "gm-scriptorium carry x" to move them into _meta/vault-config.yaml. Nothing was written.` (for a site config outside the vault: move them by hand) |
| `build --force-check` or `build --no-check` on a vault whose settings moved to `_meta/vault-config.yaml`, when that file sets no `player_site.folder_map`, or one that cannot be read, and the pack holds none; plain `build` already stops at the check step with 2 | new | 3 | `campaign "x": _meta/vault-config.yaml sets no player_site.folder_map, so the build would publish none of the vault's folders. Set player_site.folder_map in _meta/vault-config.yaml. Nothing was written.` (names a backup that holds a folder map, when there is one) |
| campaign entry with no `vault` key | 1 | 3 | `campaign "x" has no vault configured. Set one with: gm-scriptorium config add x --vault <vault folder> --out <output folder>` |
| vault with no `site_config`, no `pack` and no `_meta/scriptorium` (what a plain `config add` makes) | 1 | 3 | `campaign "x" has no site config: ... does not exist. Run "gm-scriptorium init" to create one, or set site_config or pack on the campaign.` |
| `remote password`, `remote account add`, `change`, `reset`, `remove` or `rename`, `signout-all` or `off` with the config folder inside a vault (registered or not) | 1 | 3 | `remote access keeps its files beside the config, never inside a vault, but <path> is inside the vault at <vault>` |
| `serve --admin` in a remote mode on Windows when the panel folder's access list cannot be set | new | 1 | `remote access (mode x) needs <panel> limited to your account, SYSTEM and Administrators, and that could not be done (...); nothing was started` |
| `remote password` or `remote account add`, `change` or `reset` on Windows when the panel folder's access list cannot be set | new | 1 | `remote access needs <panel> limited to your account, SYSTEM and Administrators before a password is saved there, and that could not be done (...); no password was saved` |
| `remote account` with a name that breaks the rule, an account that does not exist or already exists, a ninth account, a wrong current password, a cancelled prompt, an extra argument, or a saved accounts file that cannot be read | 1 | 1 | `account names are 1 to 32 letters, digits, dots, hyphens or underscores, starting with a letter or digit` / `no account named "x"` / `an account named "x" already exists` / `there can be at most 8 accounts` / `that is not the current password for "x"; nothing changed` / `cancelled; nothing changed` |
| `carry` on a vault still on `_meta/vault-config.md`, on a pack that is not the one in the vault, on a pack or settings file that cannot be read, or when a file changed after the plan was made | new | 3 | `this vault keeps its settings in _meta/vault-config.md; there is nothing to carry` / `<pack> is not the pack in this vault (_meta/scriptorium/vault.config.json), ...` / `<file> changed since the carry was planned; nothing was written. Run "gm-scriptorium carry" again.` (reason `carry-blocked`) |
| `carry` with closed stdin, a backup that cannot be written, or a pack that cannot be rewritten after the vault's settings were written | new | 1 | `carry aborted; nothing written` / `could not back up <file> to <folder>: ...` / `The vault's settings already hold every value that was carried, but <pack> could not be rewritten ...` |
| `carry` when the site title and folder map cannot be written to the vault's settings file (also when the pack then cannot be rewritten) | new | 3 | `siteTitle and folderMap are still in <pack>: the vault's settings file could not be written (...)`, naming both backups (reason `carry-blocked`) |
| `init --title` that differs from the title a moved vault's `_meta/vault-config.yaml` already sets | new | 1 | `this vault's title is set in _meta/vault-config.yaml; change it there` |
| `init` on a vault whose `_meta/vault-config.yaml` cannot be read, or whose settings changed after the plan was made, or when the settings file cannot be written | new | 3 | `campaign "x": <file> could not be read: ...` / `<file> changed since the carry was planned; nothing was written. Run the command again.` (reason `carry-blocked`) |
| `init` on a moved vault when the per-machine folder for the backup is unavailable | new | 1 | the folder message, then `Nothing was written.` |
| `status` with no campaigns | 0 | 0 | `no campaigns registered; run "gm-scriptorium config add" first` (informational) |
| unknown command | 1 | 1 | `unknown command: chek` plus the usage block |
| unknown flag, or a flag with no value | 1 | 1 | `unknown flag --prot for "build"` / `--vault needs a value` |
| `build --force` (split into `--force-check` and `--force-out`) | accepted | 1 | `--force has been split: use --force-check ...` |
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
| `config edit` when the editor exits with a non-zero status, is stopped by a signal, or cannot be started | the editor's own status (0 when stopped or not started) | 1 | `the editor "x" exited with status N; the config file is at <path>` / `the editor "x" was stopped by SIGTERM; ...` / `could not start the editor "x" (ENOENT); ...` |

Not remapped, still 1: a folderMap output collision, and any genuinely unexpected
exception (including one while loading a pack), which prints its stack. Only a `ConfigError`
raised while resolving a pack, or by the required-key check on `vault.config.json`, becomes exit 3 (`asPackProblem` in `src/cli/check.js`).

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
- **A test that needs a fixed port takes it from `testPort(<default>)` in `test/helpers/ports.js`.** Set `SCRIPTORIUM_TEST_PORT_BASE` (a whole number from 1024 to 29768; default 7000) to move all of them by the same amount, so two copies of the suite can run at once.
- **Write residual gaps down** rather than leaving them for the next person to rediscover. The
  house style is the limits block at the top of `src/build/plan.js`, and the "Will catch / Will
  not catch, deliberately" section of [ADR 0009](decisions/0009-output-leak-scan.md).

## Running the browser tests

This section is for anyone changing the admin panel. The panel tests drive real Chromium and Firefox. Without the setup below they skip, and `npm test` still passes, so a skip is easy to miss.

Playwright (the browser driver) and axe-core (the accessibility checker) are not project dependencies. Install them into a folder outside the repository. Run each command on its own.

```
npm install --prefix "$HOME/scriptorium-browser-tools" playwright@1.55.1 axe-core@4.13.0
```

```
node "$HOME/scriptorium-browser-tools/node_modules/playwright/cli.js" install --with-deps chromium firefox
```

`--with-deps` installs system libraries on Debian or Ubuntu using `sudo apt`. Leave it out on other systems.

In a POSIX shell (bash, zsh), run the suite like this:

```
PLAYWRIGHT_MODULE="$HOME/scriptorium-browser-tools/node_modules/playwright" npm test
```

In PowerShell on Windows, set the variable, then run the suite:

```
$env:PLAYWRIGHT_MODULE = "$HOME\scriptorium-browser-tools\node_modules\playwright"
```

```
npm test
```

- `PLAYWRIGHT_MODULE` is the absolute path to the `playwright` package folder. A relative path fails, because the tests load it from inside `test/`.
- `AXE_CORE_PATH` is the full path to the `axe.min.js` file, not a folder. You only need it when axe-core is not at `node_modules/axe-core/axe.min.js` beside the playwright folder. The install above puts it there, so most people never set it.

To tell the browser tests ran, read the skip reasons in the output. None should mention Playwright or axe-core, for example "playwright not available" or "axe-core not available". Skips for missing build tools (mingw-w64, makensis, a C compiler, the packager's cached Windows base) or for another platform are expected.

To search a saved log for them:

```
grep -c "not available (set" npm-test.log
```

Run the browser tests before opening a pull request that changes the admin panel (`assets/admin/`) or the code it talks to (`src/admin/`, `src/setup/`, `src/serve/`, `src/desktop/`). Also run them for changes to `src/build/` and when you bump the generator pin. If in doubt, run them.

These steps were checked on Linux, on a machine that already had the system libraries the browsers need.

## Release procedure

Maintainers make releases. These steps must run in this order, and two of them have already bitten
someone.

**Version numbers.** Releases are numbered `X.Y.Z`. A release with new features raises the
middle number, and a release with fixes only raises the last. `-rc.N` is used only for the release
candidates of 1.0.0, made at the feature freeze, and it is the only suffix the release tooling
accepts. Releases before 1.0.0 are not signed (step 7).

1. Bump `version` in `package.json`. Leave the stale root version in `package-lock.json` alone.
   Releases so far have, to avoid widening the notices diff mid-release.
2. Run `npm run notices`. The notices header carries the Scriptorium version, and
   `scripts/notices-freshness.js` strips only the `Generated:` line before comparing, so **a
   version bump fails `npm run package` until the notices are regenerated.** That is deliberate.
   Confirm the diff is only the version line and the timestamp.
3. Run `npm test`, `npm run verify-generator` and `npm run package`. All three must pass.
   `npm run package` builds `gm-scriptorium-win-x64.exe`, the tray helper
   `gm-scriptorium-tray-win-x64.exe` (ADR 0057) and `gm-scriptorium-linux-x64`.
4. Commit the bump with the regenerated notices.
5. In the public repository, run `node scripts/public-guard.js release <previous tag>` with the
   private lists configured (for the first public release, use the public root commit). It must
   exit 0. Then push, then tag, then push the tag.
6. Rebuild both executables after the release commit, from a cleared `dist/`, and check the build
   timestamp is later than the commit. A stale binary from an earlier commit has nearly shipped
   here.
7. Sign the Windows executables. Maintainers sign `gm-scriptorium-win-x64.exe` and the tray helper
   `gm-scriptorium-tray-win-x64.exe` with the project's code-signing certificate, timestamped, on a
   Windows machine, because the signing key needs a person present. `SHA256SUMS` is regenerated after signing, so it covers the signed bytes.
   Check the signature on Windows before anything is published, using criterion C141 part A in the
   Windows verification runbook. Signing applies to every release from 1.0.0, including its release
   candidates. Releases before 1.0.0 skip this step and C141, ship unsigned, and their release
   notes say so. See [ADR 0051](decisions/0051-code-signing.md), "Amended: releases are signed from 1.0".
8. Create the release as a prerelease, with every binary (the Windows program, the tray helper
   `gm-scriptorium-tray-win-x64.exe` and the Linux program), `THIRD-PARTY-NOTICES.txt` and the one
   combined `SHA256SUMS`. **Every Windows release must carry the tray helper and list it in
   `SHA256SUMS`**: `update` on an installed copy downloads both programs and refuses to replace
   either if the helper is missing, so a release without it cannot be installed by `update` (ADR 0057,
   section 11). Every release goes up as a prerelease first, even one that will become
   latest, so nobody running a plain `update` gets it before the Windows checks pass.
9. Download the assets back off the release page and re-hash every one of them before announcing
   anything, the tray helper included.
10. Have the Windows checks run on the release, using the Windows verification runbook at
    `.agents/windows-verification.md`. Promote the release to latest only when they pass.
    An `X.Y.Z` release is promoted once they pass, signed or not, below 1.0.0. From 1.0.0 it is
    promoted only when signed. An `-rc.N` release is never promoted. A release whose checks fail
    stays an unpromoted prerelease, and the next patch release replaces it.
    On every push to main, CI packages both targets and runs the Linux binary through
    `scripts/packaged-smoke.js`. That proves nothing about Windows: the Windows executable stays a release
    gate on the test machine (C1 and C184, plus C141 part A step 4 from 1.0.0).
11. Run the release-time `update` check, which is still **open**. Build a lower-version
    `scriptorium-linux-x64` in a scratch folder as a stand-in for an old install. Point it at the
    new release's tag and run `update --pre`. It should download, verify against `SHA256SUMS`, and
    end up replaced with mode 0755, with the old copy kept beside it as `.old-<version>`, and the
    new version named in the success message. Keep this marked open until it has been run once
    against a real published release. `test/update-linux.test.js` and
    `test/update-packaged-guard.test.js` cover the pieces (the ELF check, the packaged-only guard,
    the 0755 mode) with injected dependencies, not a real download and self-replace.
    `update` on an installed Windows copy replaces the program and the tray helper together.
    `test/update-tray.test.js` covers that with injected downloads and real files in a scratch
    folder, and only the Windows runbook (C201) proves it on a real copy. Before promoting, confirm
    the release's `SHA256SUMS` has a line for `gm-scriptorium-tray-win-x64.exe`.
    After promoting, also run a plain `update --check` (no `--pre`) from the previous release's
    Linux binary, in a scratch folder with its own config. It must name the new tag. Plain `update`
    is what most people run, and it sees only the release marked latest. A previous release from
    before 0.5.0 still fetches through the GitHub CLI, so this check needs `gh` signed in on the
    build machine.

## The sample site

The sample campaign is published at <https://drnoisys-softworks.github.io/gm-scriptorium/> by `.github/workflows/pages.yml`, on a push to `main` or a manual run, in the public repository only. The workflow runs `npm ci`, `npm run verify-generator` and `node scripts/sample-site.js`, uploads the `_site` folder and deploys it. The decision and its limits are in [ADR 0059](decisions/0059-hosted-sample-site.md).

The script builds only `examples/the-long-lease`. Every path is a constant in the script, it takes no arguments, and it deletes nothing. It builds with a scratch copy of the pack that carries the site address, checks the output, copies it to `_site`, adds `leak-demo.html` (made by `scripts/leak-demo.js`) and sweeps the result for the withheld name and the GM note's text. Any failed step prints `SITE FAIL <step> <reason>` and exits 1, and nothing is uploaded.

To reproduce it, work in a scratch copy of the repository (for example `git archive HEAD | tar -x -C <folder>`, then `npm ci` there), because the script refuses to run if `.sample-site` or `_site` already exists, and you delete those two folders yourself. Do not run it in your working checkout unless you mean to.

The pinning tests are `test/pages-workflow.test.js` (the workflow file and the script's constants) and `test/sample-site.test.js` (the pipeline, each gate's control and the demo generator). The workflow is separate from `ci.yml`, which stays as it is.

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
  decision, the main rejected alternative, and any limit a user will hit. Pages for GMs also meet the criteria in
  [Writing the user documentation](WRITING-DOCS.md).
- Material for AI assistants (working rules, onboarding, the Windows runbook) lives in `.agents/`,
  reached through `AGENTS.md`. Keep it out of the human documents.
- Windows-side behaviour is verified only through the runbook at
  `.agents/windows-verification.md`. A fix with a Windows leg that doesn't update its criterion
  there never gets verified where it was found.
