# 0046. One process spawner for outside programs

## Summary

Features that need an outside program (an AI command-line tool, git, rsync, ssh, a speech-to-text
engine) now share one module that is allowed to start programs: `src/proc/run.js`. It runs only
names from a fixed list, never through a shell, with an environment built from scratch and an empty
temporary folder as its working directory. A timeout, a cancel, too much output or a panel shutdown
kills the program and everything it started. A test pins that no other file under `src/` may start a
program, apart from the two that already did (the editor launcher and the `gh` lookup). Nothing in
the command-line tool calls the module yet, so no behaviour a GM sees has changed. The main
alternative, letting each feature spawn for itself with a scrubbed copy of the process environment,
is rejected below because a secret nobody thought to remove would leak by default.

Status: accepted.

## 1. The decision

- **One leaf module.** `src/proc/run.js` requires only `child_process` (the `spawn` function), `fs`,
  `os`, `path` and the shared error classes. It never requires the vault, build, admin or update
  code. It never reads the process environment, so "no ambient fallback" can be seen by reading it.
  It never writes to the console. Its errors are `ProcError`, which lives in the same file and
  extends the shared error class; `src/util/errors.js` is not edited.
- **A fixed list of names.** `claude`, `codex`, `gemini`, `git`, `rsync`, `ssh` and `whisper-cli`.
  The check is an exact match on the string before anything else touches it, so a path, an extension,
  a different case, a near-name or a non-string is refused. The list grows only by editing this file
  and its pinned test.
- **Resolution uses the given PATH and nothing else.** The module looks in the `PATH` of the
  environment it was handed, in order, and never falls back to the process PATH, a home folder or an
  install folder. On Linux and macOS an entry must be absolute and the file must be a regular file
  with the execute bit. On Windows the module tries `.exe`, then `.cmd`, in each PATH folder in
  order, and ignores `PATHEXT`. It never picks `.bat`, `.com`, `.ps1` or an extensionless file.
- **No shell, ever.** `spawn` always gets `shell: false` and an array of arguments. A prompt travels
  on stdin, written and closed, never in an argument or the environment. A NUL in an argument is
  refused on every platform, because Node's own error for it would echo the value.
- **Windows `.cmd` shims.** Node will not start a `.cmd` file directly, so the module runs
  `cmd.exe` from `<SystemRoot>\System32` with one verbatim command line in which the shim and every
  argument are double quoted. Inside double quotes `& | < > ( ) ^` are literal. Four things are not
  made inert by quoting, so an argument containing a double quote, a percent sign, an exclamation
  mark or a control character is refused before anything starts (`E_PROC_ARG`), as is a shim path
  containing one (`E_PROC_SHIM`). Real arguments (flags, temp file paths, an empty value) need none
  of them. `SystemRoot` must be present in the child environment and look like a plain drive path,
  or every Windows run is refused. `cmd.exe` and `taskkill.exe` are fixed paths under it and are
  never taken from `PATH`.
- **The environment is built from scratch.** A short fixed list of names is copied from the
  environment the caller passes in. On Windows the lookup is case-insensitive and two spellings with
  different values are refused. Then come explicit per-call additions, which can never set `PATH`.
  Then a strip that always runs last and ignores case on every platform: `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` and every name starting `CLAUDE_CODE_USE_` are removed even if a caller adds
  them. A NUL in a value, or an equals sign or NUL in a name, is refused naming only the variable.
  - Linux and macOS list: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`,
    `TMPDIR` and the five `XDG_*` folder variables.
  - Windows list: `PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `TEMP`, `TMP`,
    `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`,
    `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`, `USERNAME`, `NUMBER_OF_PROCESSORS`,
    `PROCESSOR_ARCHITECTURE` and `OS`. `PATHEXT` is passed so the child's own lookups work; this
    module never uses it.
  - Deliberately absent: `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS`, `CLAUDE_CONFIG_DIR`,
    `OPENAI_API_KEY` and `GEMINI_API_KEY`. A consumer adds the first three for one call when it
    needs them.
- **A fresh empty working folder.** Each run gets `scriptorium-proc-*` under the system temp folder,
  created only after every refusal check has passed, and removed afterwards. A failed removal is
  swallowed, as in the build code, and never changes what the caller sees. The caller cannot choose
  the working folder, so a program never starts inside a vault, a pack or an output folder.
- **Piped stdio, hidden window.** All three streams are pipes and `windowsHide` is set, so the child
  never inherits the panel's streams and never opens a console window. On Linux and macOS the child
  is started detached, which makes it the leader of its own process group. On Windows it is not,
  because that changes console allocation.
- **One kill routine for every path.** Timeout, cancel, an output cap, a failing callback, `killAll`
  and the exit drain all use it.
  - Linux and macOS: `SIGTERM` to the whole process group, `SIGKILL` after the grace period, and
    after one more grace period the pipes are destroyed and the run settles regardless.
  - Windows: `taskkill.exe /PID <pid> /T /F`, then `child.kill()` after the grace period, then the
    pipes are destroyed and the run settles. Windows has no polite step.
  - Exit drain: if the program exits but a leftover process still holds the pipes, the run does not
    wait for them. After the grace period it kills the group, destroys the pipes and settles.
  - Every timer is unreferenced, so none keeps the panel alive. A running child does, until
    `killAll()` or its own end.
- **Byte caps.** Each stream is counted. The chunk that crosses the cap is cut so the caller receives
  exactly the cap, the rest is discarded, the tree is killed, and the run rejects with
  `E_PROC_OUTPUT_CAP`.
- **Bounded.** At most 8 runs are live at once; a ninth is refused (`E_PROC_LIMIT`). `killAll()`
  cancels every live run, waits for all of them, never rejects, and is safe to call twice.
- **Errors say nothing secret.** A `ProcError` has a fixed message and only these extra fields: an
  allowed program name, an argument index, a short reason, a variable name, a stream name, a byte
  limit and a system error code. It never has a cause, a path, an environment value, an argument or
  stdin.

## 2. Narrowing ADR 0022, section 5 (Preview builds)

ADR 0022, section 5 rejected `child_process` for preview builds, and that stands: builds stay
in-process. What changes is the rule for the rest of the admin code. `child_process` is allowed on
the admin path only through this module. `test/admin-variants.test.js` still forbids
`child_process`, `worker_threads` and `cluster` under `src/admin` and is not edited. The new
`test/proc-structure.test.js` pins that the only files under `src/` naming `child_process` are
`src/proc/run.js`, `src/cli/config.js` and `src/update/gh.js` (see the addendum at the end: `gh.js` is gone).

## 3. Rejected alternatives

- **Copy the process environment and delete the known secrets.** Every new secret would leak until
  someone remembered to add it to the list. A short list of what a program needs is easier to audit.
- **Honour `PATHEXT` on Windows.** It is environment-controlled and can add script hosts. A fixed
  two-entry list cannot.
- **Fall back to home or install folders when a program is not on the PATH.** It makes the answer to
  "which program ran?" depend on the machine. A caller that wants a program passes the folder in
  `PATH`.
- **Escape every cmd metacharacter with carets.** It cannot make a percent sign or a newline
  reliably inert on a cmd command line, and its correctness depends on how many times a given shim
  re-parses the line. Refusing the four classes quoting cannot handle is smaller and checkable.
- **Refuse every cmd metacharacter.** It would break real Windows paths with `&` or brackets in a
  user name.
- **Spawn the `.cmd` file directly.** Node refuses, and it would leave the quoting to Node's generic
  rules.
- **A native module or Windows job objects for the tree kill.** It adds a dependency for a
  guarantee `taskkill /T` mostly gives.
- **Add `ProcError` to `src/util/errors.js`.** It widens a widely required shared file for no gain.
- **Let each feature spawn for itself.** It leaves nothing to pin, and the kill, environment and
  folder rules would drift between copies.

## Will catch / Will not catch, deliberately

Will catch:
- A name that is not on the list, however spelled: a path, an extension, a different case, a prefix.
- A program found only through the process PATH, a home folder or an install folder.
- A Windows argument that cmd.exe would reinterpret (a double quote, a percent sign, an exclamation
  mark, a control character), and a shim path containing one.
- An Anthropic credential or a `CLAUDE_CODE_USE_` switch reaching a child, by any route and in any
  letter case, including one added per call.
- A program that ignores `SIGTERM`, a program that starts a helper which ignores it, and a program
  that floods a stream.
- A second file under `src/`, in any folder, that starts to name `child_process`.
- Any test that could start a program from outside its scratch folder, by a structural pin on every
  test file that uses the module.

Will not catch, and these are residuals:
- A helper process that started its own session or detached itself. The group kill does not reach it.
- A helper that outlives a clean exit of the program after closing its pipes. Nothing is watching.
- A hard kill of the panel (`SIGKILL`, power loss). `killAll()` never runs, so children can outlive it.
- On Windows, a tree kill after the program has already gone. `taskkill /T` walks down from a live
  pid.
- What a vendor program does itself: the files it writes and the network it opens.
- Arguments such as `git -c core.sshCommand=...` or `ssh -o ProxyCommand=...`, which make the program
  run another command. A feature that takes arguments from config must constrain them before calling
  this module.
- A `.cmd` shim that re-parses its own arguments unquoted. Quoting reaches cmd.exe correctly; what a
  shim does with it afterwards is its own.
- The window in which a process-group id is reused after its owner exits.

## What a consumer must do

- Pass the caller's own environment as `env`. The module never reads the process environment.
- Put prompts on stdin, never in an argument.
- Call `killAll()` from the stop handler, next to `removePreviewRoot`, so an orderly panel stop leaves
  no child behind.
- Add `SSH_AUTH_SOCK`, `CLAUDE_CONFIG_DIR` or a similar variable through `extraEnv` for one call, and
  only when that call needs it.
- Constrain any arguments that come from config, as above.

## Windows verification

The Windows half (a `.cmd` shim under no shell, the metacharacter refusals, the extension list, no
console window, the tree kill, the case-insensitive environment strip and the empty working folder)
is verified only from the real exe. It is OPEN: `.agents/windows-verification.md` C98, C128 and C216. The
Linux tests prove the text of the Windows command line and the shape of the `taskkill` call, not
how Windows treats them.

## Addendum: a launch-only entry point

[ADR 0028](0028-installer-and-first-run.md) section 8 adds one function to `src/proc/run.js`, `openFile`, so that launch mode can hand a local file to the operating system's opener. It lives in this module so the structural rule that only this file (plus the two older spawners) may start a program stands unedited.

It is deliberately outside the rules above that suit a program the panel waits for. It is not on the allowlist, and `openFile` takes a file path, never a command name. It is never added to the live-run set, so `killAll` never reaches it, and nothing times it out: the browser it starts has to outlive the panel. It runs with ignored stdio, in a session of its own (so closing the terminal never reaches it), unref-ed, with the same scrubbed environment as any other call plus a short list of display variables on POSIX. It never uses a shell.

`bin` now reaches this module, through launch mode (`src/cli/launch.js`), where before nothing in `bin` did. The file and the one function are still the only places a program is started on the panel path.

## Addendum: the tray hand-off

[ADR 0057](0057-windows-desktop-app.md) section 10 adds one more function to `src/proc/run.js`, `runTrayHandoff`, so that typing `gm-scriptorium` in a terminal on an installed Windows copy can ask the tray helper beside the program to start the background app, or to reuse the running one. It lives in this module so the structural rule that only this file (plus the two older spawners) may start a program stands unedited. The pins in `test/proc-structure.test.js` are unchanged: the module still requires the same five modules, still reads no `process.env`, and its one new timer is unref-ed.

What it may do is narrower than `run` and wider than `openFile`:

- **It takes no program name and no path.** The helper's path is worked out inside the function, as the folder of the running program plus `gm-scriptorium-tray.exe`. The options are `env` and `timeoutMs` only, and any other key, including one that names a path, is refused before anything starts. `PATH` is never searched, and a helper in any other folder is never used. The program path is a test seam (`deps.execPath`, default `process.execPath`), not an option.
- **Windows only.** Anywhere else it is refused with the reason `windows-only`. The program path must be absolute (a drive or network share path) with no control characters.
- **One fixed command line.** `--handoff` and nothing else, no shell, ignored stdio, with the helper's own folder as the working folder. It is not detached: it is waited for. It is not on the allowlist and not in the live-run set.
- **Its environment is the usual scratch environment plus three names**, when they are set: `SCRIPTORIUM_CONFIG`, `SCRIPTORIUM_PROFILE` and `USERDOMAIN`. The first two let a terminal that has chosen a settings file or profile reach the same one in the app. `USERDOMAIN` is not in the base list, but [ADR 0056](0056-windows-panel-access-list.md) needs it to name the account in the panel folder's access list. Without it, a panel started from a terminal in a remote mode would refuse to start. Every other variable, including the stripped credentials, is left out as for any call.
- **It waits up to 15 seconds and never kills.** The timer is unref-ed, and the child handle keeps the command alive while it waits. On a timeout it lets go of the child and resolves `{ outcome: 'timeout' }`. What the helper started has to outlive the terminal, so nothing here ever stops it, by a timer or by `killAll`.
- **It reports what the helper did and decides nothing.** It resolves `{ outcome: 'exited', exitCode }` or `{ outcome: 'timeout' }`, and rejects `E_PROC_NOT_ALLOWED`, `E_PROC_BAD_OPTIONS`, `E_PROC_ENV` or `E_PROC_SPAWN`. The meaning of the exit code is in `src/desktop/handoff.js`: 0 and 3 give exit 0, 4 gives exit 1 and a line about the log, 1 falls back to console launch mode, a timeout prints a line and exits 1 with no fallback. The helper's code is never passed through, because 4 is the frozen update-prerequisite code.

Will not catch, deliberately: whether the helper started by `--handoff` survives the closing of the terminal. The helper starts a separate process for that reason, and only a real Windows machine can show it (criterion C197).

`bin` reaches this function through `src/desktop/handoff.js`, on a bare `gm-scriptorium` in a terminal.

## Addendum: the `gh` lookup is gone

`src/update/gh.js` was deleted when `update` moved onto the egress module (see
[ADR 0024](0024-ai-connections.md)). The only files under `src/` that name `child_process` are now
`src/proc/run.js` and `src/cli/config.js`, and `test/proc-structure.test.js` says so.

## Addendum: a Windows system tool

[ADR 0056](0056-windows-panel-access-list.md) adds a second, separate list to `src/proc/run.js`, `SYSTEM_COMMANDS`, which holds `icacls` only. A program on it is run only on Windows, only as `<SystemRoot>\System32\<name>.exe` (SystemRoot is validated like the `taskkill` and `cmd.exe` paths), and is never looked up through `PATH`, so a planted copy earlier on `PATH` is never chosen. Off Windows it is refused with the reason `windows-only`, and a near miss such as `icacls.exe`, `ICACLS` or a full path is refused as not on the list. Everything else about a run is unchanged: no shell, the scratch environment, the empty working folder, the caps and the timeout.

`ALLOWED_COMMANDS` and its pinned test are unchanged. `test/proc-system-commands.test.js` pins the new list. It grows only with a decision record, as the first list does.

`bin` now reaches `run()` through `serve --admin` and `remote` as well as launch mode, where the panel start and the writing `remote` commands set the access list of the `panel` folder.

## Addendum: the packager's PKG_EXECPATH (issue 212)

**What happened to a GM.** On an installed Windows copy, typing `gm-scriptorium` in a terminal left the tray saying "The panel stopped unexpectedly." and no panel. The terminal start hands off to the tray helper, which starts the host as the same program with the argument `desktop`. The host never ran its own code.

**The mechanism.** The packager wraps the packaged program's `spawn`. Before every spawn it adds a variable named PKG_EXECPATH, holding the program's own path, to the environment it is given. It writes into the object the caller passed and does nothing if the name already holds a value. The packaged program deletes the variable from its own environment at start, so the program never has it and every child gets it. A child that is the same program sees the variable, takes it as a request to run as plain Node, and treats `desktop` as a script name. Building the child's environment from scratch did not help, because the packager adds the variable afterwards, inside `spawn`.

**The decision.**

- `buildChildEnv` ends by putting a hidden entry of that name in every environment it builds: an own property holding an empty string that is not enumerable. The packager sees a defined value and leaves it alone. Node builds a child's environment from enumerable names only, so the child never gets it. A visible entry of that name, in any case, is removed first. The entry also covers `run`, `openFile` and `runTrayHandoff`.
- The `taskkill` spawn used to pass no environment, so it inherited the whole one: credentials, and the packager's variable under the packaged program. It now gets the built environment like every other spawn in the module.
- The tray removes the variable from its own environment as the first statement of `wWinMain`, so the four programs it starts never copy it, whatever started the tray.

**Rejected.** Deleting the name or passing a fresh object: the packager adds the variable inside `spawn`. Freezing the environment object: the packager's assignment would throw in strict mode and every spawn would fail. A harmless but visible value: it leaks a variable whose meaning belongs to the packager. A fix in `runTrayHandoff` alone: it leaves every other spawn open. A fix in the tray alone: it leaves git, ssh, the browser and `taskkill` open.

Will catch: the packager's variable reaching any child this module starts. The tests lay the packager's own spawn wrapper over a recording spawner and over a real stand-in program, so the variable is added by the real wrapper.

Will not catch, deliberately:

- The older spawner in `src/cli/config.js`, which gives the editor the whole environment by design.
- A variable a later packager adds under another name. The control test that expects the packager to add this one goes red at a version bump if it stops.
- What Windows hands each child. Only criterion C216 shows that on a real machine. It is OPEN.
