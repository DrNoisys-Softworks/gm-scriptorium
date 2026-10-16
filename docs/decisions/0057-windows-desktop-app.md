# 0057. The Windows desktop app

## Summary

Installed copies of GM-Scriptorium on Windows now run in the background with an icon in the system tray and no console window. A small native helper owns the icon, the single running copy, sign-out handling and Start with Windows. It runs the GM-Scriptorium program hidden and talks to it through pipes. The panel uses fixed addresses, 7400 and 7401 by default, which the GM can change. The main alternative, a Tauri or Electron shell, is rejected because it reverses [ADR 0028](0028-installer-and-first-run.md) and adds a second runtime. The limits a GM will meet are that the helper is a second file that antivirus software may judge, and that notifications have no buttons: clicking one does its main action and the other actions are in the tray menu.

Status: accepted. Amends [ADR 0028](0028-installer-and-first-run.md) and [ADR 0046](0046-one-process-spawner.md) for installed Windows copies only. [ADR 0053](0053-windows-installer.md) is superseded in part by the installer decision that follows this one.

## 1. What the GM gets

- Starting GM-Scriptorium from a shortcut, from Finish in Setup, or from a terminal shows no console window. An icon appears in the system tray (the notification area by the clock; Windows may keep it under the `^` overflow arrow). Closing the browser does not stop the program.
- The icon's menu has the version, the campaign and the address in a header. Under it are Open panel, Open preview, Stop panel and Start panel, Restart, Start with Windows, Check for updates, Open command line (Advanced), Open log folder and Quit.
- The preview opened from the tray is marked in the menu as not the live site, and its tab says so.
- Stop panel keeps the icon and pauses the panel. Start panel brings it back.
- The browser opens when the GM starts the program themselves, and stays quiet at sign-in.
- Start with Windows is offered and ticked. Remote access is never switched on by that start unless the GM has said so (section 7).
- A GM can pick the two ports, and the default is 7400 and 7401.
- Typing `gm-scriptorium` in a terminal on an installed copy starts the background app or reuses the running one, then opens a tab.
- Problems that stop the panel starting are shown as a change of the icon and a notification, with a plain one-line reason, and the same line goes in a log.
- A daily update notice reaches the tray as well as the panel.

## 2. Two programs

There are now two files in the install folder: `gm-scriptorium.exe`, the program, and `gm-scriptorium-tray.exe`, the helper. The release carries the helper as the asset `gm-scriptorium-tray-win-x64.exe`.

The helper is written in C17 against the Win32 interfaces only and built with the mingw-w64 cross compiler on the Debian release machine. It is a GUI-subsystem program, linked statically except for system libraries, stripped, with address-space randomisation, data execution prevention and high-entropy addresses on. It carries the same Lantern icon and version strings as the program.

Rejected:

- **Go.** A 2 to 3 MB runtime, and a long history of Defender machine-learning false positives on Go programs.
- **Rust for the windows-gnu target.** `rustup` is not packaged by the Debian project, so the toolchain is harder to vet.
- **A PowerShell script that draws the icon.** It runs into Constrained Language Mode and the antimalware scan interface, and it would need PowerShell added to `SYSTEM_COMMANDS` in [ADR 0046](0046-one-process-spawner.md).
- **Tauri or Electron.** This reverses the rejected alternative "Electron or Tauri" in [ADR 0028](0028-installer-and-first-run.md), and it is a second runtime to ship and patch.
- **A Node native addon.** It needs a `.node` file extracted at run time and an addon cross-built for Windows, the same kind of packaging risk the project avoids.
- **Flipping the packaged program to the GUI subsystem.** It breaks the command line's exit-code contract and still gives no tray.

## 3. How they talk

The helper starts the program as `gm-scriptorium.exe desktop run [--background]`, by full path from its own folder, never by searching `PATH`. It connects the child's standard input and output to pipes and talks to it with the line protocol at the end of this record. There is no network module, no named pipe and no change to the net-structure test, and the helper never calls the panel over HTTP.

- The host is started with `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT`, an inherited environment, and the user's profile folder as the working directory. It has no console at all.
- End of input on the host's standard input means quit. A broken output pipe means quit.
- The host's standard error is drained by the helper into a small ring and discarded. It is never shown, never written to disk and never put in the registry.
- Inside the host, `console.*` output and writes to `process.stdout` and `process.stderr` are redirected to the log when the host starts, by the command in `src/cli/desktop.js`. Protocol lines go only through the output stream captured before the redirect, so a stray print in the panel cannot corrupt the protocol.

Rejected:

- **A named pipe.** [ADR 0024](0024-ai-connections.md), "Network posture", and the net-structure test allow only two files to load a network module, and `net`, which provides named pipes, is one of those modules.
- **HTTP to the panel.** Egress is limited to GitHub.
- **`CREATE_NO_WINDOW`.** A hidden console still receives logoff and shutdown control events that the Node runtime does not map, so Windows could end the host before it had stopped cleanly.
- **A Job object with kill-on-close.** It would also kill the browser that `rundll32` starts for the host.

## 4. Single instance

The helper takes a named mutex, `Local\GM-Scriptorium-tray`, and creates one hidden top-level window of class `GMScriptoriumTray`. A second launch finds that window, sends it a `WM_COPYDATA` message and exits.

- `dwData` is `0x47534354`. The payload is UTF-16 text, either `open` or `handoff`.
- The reply is `1` for opened or started, `2` when the running copy is in an error state (it has shown the notification and opened the log folder), and `0` for refused.
- `WM_CLOSE` sent to that window means quit now, with no confirm. The installer and uninstaller use this.
- Double-clicking the icon sends `open`. If the panel is stopped, it is started first.

Rejected: a Node lock file plus a request file. It needs polling, and a crash leaves a stale lock.

## 5. Start, stop and restart

- **A start the GM makes** (shortcut, Start menu, Finish, tray, terminal) makes no retries. The browser opens and the first-run notification shows once.
- **A start at sign-in** (`--background`) is quiet. It retries only when the vault cannot be found (`VaultUnreachableError` with reason `not-found`), at 10, 20, 30, 60, 60 and 60 seconds, and then shows the error state and a notification. Any other failure is shown at once. Open panel, Start panel, Restart or Try again sent while the host is waiting to retry ends the wait and counts as a start the GM made.
- **A fresh token at every start.** Every start of the panel mints a new session token: Start panel, Restart, a retry and a ports change from the panel. Session cookies are sent to any program listening on `127.0.0.1` at that port, and the cookie name is scoped to the port (the session module's `cookieName(port)`). With fixed ports and a token that survived Stop and Start, another account on the same PC could take the port while the panel is stopped, collect the cookie when a tab reloads and replay it after Start. That is the threat model of [ADR 0056](0056-windows-panel-access-list.md). A new token ends it.
- **Tabs after Stop, Start or Restart.** Start panel and Restart open a fresh signed-in tab, because the GM asked for them. A background retry does not open a tab. An old tab left open from before does not get back in; it shows the stopped or sign-in page, and Open panel gets a signed-in one.
- **Stop panel** runs the launch stop path but keeps the host process and the icon. Restart is stop then start, and it re-reads the settings, so a change made in a terminal is picked up.
- **Quit** runs the launch stop path (see [ADR 0028](0028-installer-and-first-run.md), "Launch mode"): remove the launcher file, close the listeners and the preview folder, `killAll`, and clear the launch-code store. Then the host says `bye` and exits.
- **Confirm** before Quit or Stop panel only when remote access is on or the panel is busy (a preview build is running). Cancel is the default button. The host tells the helper which case applies with the `confirm` line.

## 6. End of session

The helper answers `WM_QUERYENDSESSION` with TRUE so it never holds up sign-out, restart or shutdown. On `WM_ENDSESSION` it sends `quit` to the host, waits up to 4000 ms for it to exit, then calls `TerminateProcess`.

The accepted leftovers are those in [ADR 0028](0028-installer-and-first-run.md), "Stopping when the window closes": a launcher file from a host that was ended early, and a preview folder. Both are tidied on the next start. Settings are never written during end of session.

## 7. Start with Windows

- The setting is the per-user `Run` value `GM-Scriptorium` under `HKCU`, set to `"<install>\gm-scriptorium-tray.exe" --background`. No machine-wide key is ever used.
- **The helper is the only writer that sets it.** Setup runs `gm-scriptorium-tray.exe --autostart on` or `off`, and the tray menu tick does the same. The uninstaller deletes the value and the matching `StartupApproved` value, which is the one removal exception.
- The state Task Manager shows (the `StartupApproved\Run` value, disabled when its first byte is `0x03`) is honoured. The menu tick reads it.
- Setup decides the tick's default (see the installer decision). Setup cannot read the remote mode, so on a PC that already has settings the default mirrors the current `Run` value, and an absent value means unticked.

**Remote access at sign-in asks again.** Starting the panel with remote access at sign-in is a different decision from starting it in a browser tab. When `gm-scriptorium remote set` changes the mode to a remote mode (`tailscale`, `proxy` or `ssh`) while the `Run` value is present, it asks "Also start remote access when you sign in to Windows?". The default is No. In a non-interactive run, or with `--json`, it is treated as No and says so.

- Until the GM confirms, a start at sign-in (`--background` from the `Run` value) runs the panel in local, this-PC-only mode. The tray header says "Remote access is off at sign-in. Start it from the tray to turn it on."
- A start the GM makes themselves (shortcut, Start menu, tray Start panel, terminal) uses the saved remote mode, as before.
- The confirmation is a per-machine flag kept with the desktop settings, written only through the one config writer. `remote off` clears it, and running `remote set` again with a different remote mode asks again, and withdraws the earlier yes on a No.
- **How the helper knows.** When a start at sign-in is held back like this (a remote mode is saved and the confirmation is not), the host adds the literal `signin-local` as the optional last field of its `state running` line, and the helper shows the header line above. The host also says, separately, whether remote access at sign-in is confirmed for this computer: every `state running` line ends with `signin=confirmed` or `signin=unconfirmed`, by the same-computer rule above. This is a different fact from `signin-local`. A remote start the GM made themselves, with the answer never given, carries `signin=unconfirmed` and no `signin-local`, so the helper can say "including at sign-in" only when the line says `signin=confirmed`. Both are trailing fields after the address, `signin-local` first when present and `signin=...` always last. A reader finds each by its exact text and ignores any trailing field it does not know, so an older helper that looks only for `signin-local` as the fifth field keeps working, and an older host that sends neither is read as unconfirmed.
- **The answer is tied to the computer.** A settings folder can be copied to another PC, and a yes given on one PC must not carry to the next. `remote set` therefore saves the answer together with the computer's name (`[desktop] remote_at_signin_pc`, from `os.hostname()`, compared without regard to case on Windows and exactly elsewhere). On any other computer the answer counts as no: a start at sign-in is this-PC-only, and `remote set` asks again, even when the mode has not changed. An answer saved with no name (written before the name was kept) counts as no. A No clears both keys, and so does `remote off`. The name is read when it is needed and is never written to the log or sent on the pipe. A computer renamed by its owner asks again, which is the safe direction.
- **How it is built.** The host reads `remote_at_signin` and `remote_at_signin_pc` at every start. A start at sign-in without it passes `localOnly` to the panel's start function, which then runs in local mode on the desktop ports whatever `[remote]` says. Every start the GM asks for, even in a host that was started with `--background`, leaves it off. The program cannot read the `Run` value (that needs a program on the spawner's list, which this decision does not add), so `remote set` asks whenever the helper sits beside the program on Windows, and a question that was not needed costs nothing, because the flag is read only at sign-in.

Rejected:

- **The Startup folder.** The shortcut goes stale when the install folder moves.
- **A Task Scheduler logon task.** It needs `schtasks` in `SYSTEM_COMMANDS`, looks more suspicious to antivirus software, and a GM cannot find it easily.
- **Honouring the saved remote mode at every sign-in.** A GM who turned remote access on in a browser session would have the panel reachable from the network after every restart without ever having agreed to that.

## 8. Fixed ports

A new `[desktop]` table in `config.toml` holds `port` (default 7400) and `preview_port` (default 7401), plus the sign-in confirmation in section 7, which is the key `remote_at_signin` (true or false, absent means false) together with `remote_at_signin_pc`, the name of the computer that gave the answer. Every key is optional, and any other key is refused, as with `[remote]`.

- **Only the desktop app reads it, and only when the panel is local or in setup mode.** Remote modes keep their `[remote]` ports, and the desktop ports are ignored there. `serve --admin`, launch mode, portable copies and Linux keep ports picked by the operating system, so tests, terminals and portable copies are unchanged.
- Each port is a TOML integer that passes the port check (1 to 65535), and the two must differ once the defaults are filled in, so `port = 7401` alone is refused. Strings such as `"7400"` are refused. The reader is `parseDesktopTable` in `src/config/desktopsettings.js`.
- `src/config/load.js` does not validate the table, so a bad entry never stops `check`, `build` and the rest. The desktop app reports it as a config error.
- **Writers.** The command line writer is `gm-scriptorium desktop set --port N --preview-port N` (either flag may be left out and then keeps its current value), which Setup and the tray's ports dialog both run. It changes only the `[desktop]` table, through `writeConfigFile`, and exits 1 for a bad value and 3 for a malformed settings file. The sign-in confirmation has its own builder, `setRemoteAtSignin` in `src/config/write.js`, which sets it or clears it (`remote off` clears it) and is written the same way. The panel's ports card writes through `register.setDesktopPortsFromPanel` on the one fenced chain. Setup never writes TOML.
- The ports dialog and Setup's port fields accept 1 to 5 digits only, checked before any command line is built.

Rejected:

- **Reusing `[remote].port`.** It would make the panel a writer of `[remote]`, against [ADR 0029](0029-remote-access.md), "The CLI, the read screen (owner decision), and the V7 seam".
- **OS-picked ports with a fallback.** The GM asked for fixed addresses.
- **An installer-only option.** The GM could not change it afterwards.

This amends [ADR 0028](0028-installer-and-first-run.md), "Launch mode": launch mode and `serve --admin` keep OS-picked ports.

## 9. Errors without a console

- **States.** The icon shows starting, running, stopped, update available, or an error. The error kinds are `vault`, `port`, `config` and `other`, each with a one-line message and, for `port`, the port number.
- **Notifications** are the balloon kind (`NIF_INFO`), which Windows 10 and 11 show as toasts. **They have no buttons.** A click does the main action: try again, change ports, or view the patch notes. The other actions are in the tray menu.
- **The log** is `<panel folder>\logs\desktop.log`, rotated to `desktop.log.1` when it reaches 256 KiB. It uses a closed list of events (`host-start`, `panel-starting`, `panel-running`, `panel-stopped`, `panel-error`, `panel-warning`, `retry`, `op`, `quit`, `exit`, `uncaught`), and every field is scrubbed before writing, and a value is cut at 500 characters. Lines are written through `appendPrivateLine`. Anything the panel prints (`console.*` and direct writes to standard output and error, which are redirected when the host starts) goes to the log as `panel-warning`, and so does each warning line the panel would have printed.
- **The panel knows it runs under the desktop app.** `/api/session` carries `desktop: true` only when the host started the panel (launch mode and `serve --admin` say false). Two lines of copy change, and nothing else about the wording of the panel does: the one-time welcome says that closing the tab does not stop GM-Scriptorium and that it keeps running in the system tray, and the stopped page says to start it again from the GM-Scriptorium icon in the system tray, or from the Start menu. The stopped page cannot ask the panel anything, so it caches the flag while the panel is up. Copy for every other run is unchanged.
- **It never holds a code, token, password or cookie.** This extends [ADR 0028](0028-installer-and-first-run.md), "The launch code and how it reaches the browser". The scrub replaces long token-like runs and anything after `token=`, `code=`, `password` or `cookie`. The folder's access list from [ADR 0056](0056-windows-panel-access-list.md) is the second layer: it is inheritable and applied at every panel start, so `logs` is covered, and in local mode only your account, SYSTEM and Administrators can list it.

## 10. Terminal and command line coexistence

- **Bare `gm-scriptorium` in a terminal** on an installed copy (the helper sits beside a packaged Windows program, and there is no `--config` flag) runs `gm-scriptorium-tray.exe --handoff` through the one spawner and prints a short status. Portable copies, Linux and `--config` keep console launch mode.
- **How the hand-off works.**
  - The Node side works out the helper's path itself, as the folder of its own executable plus `gm-scriptorium-tray.exe`. The caller cannot supply a path.
  - When no instance is running, `--handoff` starts a separate helper process with no arguments (a GM start) and exits with code 3. The `--handoff` process never becomes the instance itself, because Node places children that are not detached in a job that is closed with the terminal.
  - The helper's exit code is mapped, never passed through. 0 (delivered to a running instance) and 3 (started one) give the command exit 0. 4 (the running instance is in an error state) gives exit 1 with a line pointing at the notification and the log, because 4 is the frozen update-prerequisite code of the command line. 1 means nothing was started.
  - Any other code, or none, prints a plain line pointing at the icon and the log and exits 1 without a fallback, because the helper may already have started something. The command falls back to console launch mode only when the spawn fails or the helper exits 1. The wait is 15 seconds. On a timeout it prints "GM-Scriptorium is still starting. Look for its icon in the system tray." and exits 1 with no fallback, since a fallback after a helper has started an instance would give two panels.
  - The status lines name the default campaign, or the only one, in brackets, and leave the brackets out when there is neither or the config cannot be read.
  - The environment passed on carries the settings path and profile when set, and also `USERDOMAIN`. Without it, a remote-mode panel started from a terminal could not work out the account for the access list and would refuse to start ([ADR 0056](0056-windows-panel-access-list.md), "When it fails").
- **`serve --admin`** stays a separate foreground panel on OS-picked ports.
- **Settings.** Restart picks up edits made in a terminal. A different `SCRIPTORIUM_CONFIG` in a terminal does not affect the running app, whose settings win.
- **Open command line (Advanced)** in the tray menu starts `%SystemRoot%\System32\cmd.exe /d /s /k` with a short banner, in the user's profile folder, with the install folder first on `PATH` for that window only. Windows picks the terminal host, which is Windows Terminal when that is the default. `SYSTEM_COMMANDS` does not grow.

## 11. Updates

- The host polls the panel's update notice every 60 seconds while running and sends one `update` line per version. The tray shows the update state and one notification per version, and a click opens the patch notes. The helper opens that address only when it is a release page on the project's GitHub.
- "Check for updates" opens the panel with the Updates card in view, through the launch landing. The tray sends `open updates`, the host writes `to=updates` into that tab's launcher, and the exchange holds it for 15 seconds as a one-shot ([ADR 0028](0028-installer-and-first-run.md) section 7, addendum "the landing"). The page goes to the Overview, scrolls the Updates card into view and focuses its switch once it is mounted. "Open preview" works the same way with `open preview`: the page navigates to the preview port from `/api/session`, using the loopback scheme it reports. Any other word after `open` is ignored and the tab opens as usual. A URL fragment through `/auth` was rejected as unreliable.
- On a desktop install, the panel's update hint says to run `gm-scriptorium update` from the tray's Open command line (Advanced), because `PATH` is off by default.
- **`update` replaces both programs** when `gm-scriptorium-tray.exe` sits beside the program on Windows. It downloads and verifies both before replacing either, and any helper failure means nothing is replaced. It then replaces the program, then the helper, and each keeps an `.old-<version>` copy.
- **A failed step does not leave a half-updated install.** If replacing the helper fails after the program was replaced, the program is rolled back: the new program is moved aside and the `.old-<version>` file is renamed back into place, and the command reports that nothing changed. A hard stop between the two replacements, such as a crash or power loss, is not rolled back (see "Will not catch"). The new program is kept beside it as `.old-<new version>` until the next command sweeps it, since every step is a rename and Windows allows renaming a running program. Only if the rollback also fails does it say which file is at which version and tell the GM to run the installer. The helper's own `.old-` copies and abandoned staged files are swept at the start of every `update`, by the same rules as the program's.
- The success message on an installed copy adds "If GM-Scriptorium is running in the system tray, quit it and start it again to use the new version."
- **The two must match.** The helper compares the app version in `hello` exactly with its own version, not only the protocol number. A mismatch shows an error state reading "Quit GM-Scriptorium and start it again from the Start menu to finish updating."
- **Every later Windows release must ship `gm-scriptorium-tray-win-x64.exe` and list it in `SHA256SUMS`**, or installed copies cannot update.
- `update` on a copy from before the desktop app, or on a portable copy, replaces only the program and stays in console mode until the installer runs.

## 12. Antivirus, SmartScreen and Smart App Control

Before 1.0 nothing in the install is signed. Expected: a SmartScreen prompt on the downloaded installer, and no Defender detection of the program or the helper. Mitigations: the `Run` value is the only start-up mechanism (no scheduled task, no PowerShell), the helper uses ordinary imports from a short allowed list, nothing is packed, and the version information and manifest are real. Defender, SmartScreen and Smart App Control behaviour is recorded per binary in the Windows verification criteria.

A false positive is reported through Microsoft's submission portal; that is an action for the project owner. From 1.0 the helper is signed in the first signing pass, with the program and the uninstaller.

## 13. What this changes

- [ADR 0028](0028-installer-and-first-run.md): "Launch mode" and "Stopping when the window closes", and the rejected alternatives "Electron or Tauri" and "Detecting a double-click", for installed copies only.
- [ADR 0046](0046-one-process-spawner.md): a new addendum, "The tray hand-off".
- [ADR 0053](0053-windows-installer.md): superseded in part by the installer decision.
- [ADR 0035](0035-preview-in-a-frame.md): an addendum for the not-live strip.
- [ADR 0029](0029-remote-access.md), [ADR 0024](0024-ai-connections.md) and the net-structure test: unchanged.

## Rejected alternatives

Each section above lists the alternatives rejected for it. In short: Tauri, Electron, Go, Rust, a PowerShell tray, a Node native addon and a GUI-subsystem program for the helper (section 2); a named pipe, HTTP and a hidden console for the link (section 3); a lock file for single instance (section 4); a token that survives Stop and Start (section 5); the Startup folder, a scheduled task and honouring remote mode at every sign-in (section 7); `[remote].port` and fallback ports (section 8).

## Will catch / Will not catch, deliberately

Will catch:

- A line that carries a TAB or newline in a field, because the sender strips every control character and a receiver drops any line that still has one (unit tests on the protocol module).
- A line over 1024 bytes: the sender refuses and the receiver drops.
- An old helper with a new program, or the reverse, through the exact version in `hello`, and through `update` replacing both or neither (unit tests with injected downloads and a rename failure injected at each step).
- A terminal hand-off that would give a second panel: a timeout never falls back, and only "nothing was started" does.
- A stale session after Stop and Start, because the token changes.
- Remote access starting at sign-in without the GM's say-so, because the panel runs local-only until the confirmation flag is set.

Will not catch, deliberately:

- A crash or power loss between the program's replacement and the helper's. No rollback runs, the program is the new version, and `update` then reports it is already up to date. Running the installer repairs it.
- A second account on the same PC taking port 7400 or 7401 while the panel is not running. It can show a page there. It cannot sign in as the GM, and the fresh token means it cannot replay a cookie.
- Antivirus software judging the unsigned helper before 1.0. It is expected, recorded, and fixed by signing.
- A helper that was ended by Task Manager. The host then sees end of input and quits, but a host that was ended hard leaves the accepted leftovers in section 6.
- Anything about how Windows draws or schedules the icon and notifications. The Linux tests prove the protocol, the host and the build; the tray itself is checked only on Windows.
- Notifications with buttons. They need a Windows Runtime toast, which a plain C helper cannot raise without a shortcut and an application identifier.

## Windows verification

C190 to C205 in `.agents/windows-verification.md`, added by the slices that build each part, all OPEN until a person confirms them on a real Windows machine against the release candidate.

## Protocol v1

This is normative. The host (`src/desktop/protocol.js`) and the helper both implement it, and a parity test pins the verbs to the helper's source.

**Line format.**

- UTF-8. Fields are separated by one TAB. The line ends with one LF. It is at most 1024 bytes including the LF.
- The sender strips C0 controls (U+0000 to U+001F) and DEL (U+007F) from every field, so a field can never hold a TAB or LF.
- A sender whose line would be longer than 1024 bytes refuses to send it. A caller truncates any `message` field to 300 characters first.
- A receiver drops a malformed line (over the limit, or holding a control other than the separators) and ignores a line whose first field is not a known verb.

**Host to helper.**

- `hello  1  <version>  <logDir>`. Always the first line. `1` is the protocol number, and `<version>` is the app version, which the helper compares exactly with its own.
- `state  starting  <campaign or dash>  <detail>`. Where there is no campaign, `<campaign or dash>` is a lone `-`.
- `state  running  <campaign or setup>  <reach>  <address>  [signin-local]  signin=confirmed|signin=unconfirmed`. `reach` is one of `local`, `ssh`, `tailscale`, `proxy`, `direct`. `address` is `http://127.0.0.1:<port>` for `local` and `ssh`, and otherwise the configured `admin_url`.
- `state  stopped  <campaign or dash>`.
- `state  error  <kind>  <message>  [<port>]`. `kind` is one of `vault`, `port`, `config`, `other`.
- `confirm  none|remote|build`. Sent in reply to `stop?` and `quit?`.
- `update  <version>  <notesUrl>`.
- `bye  <reason>`.

**Helper to host.**

- `open`, optionally `open  updates` or `open  preview`.
- `stop?`, `stop`, `start`, `restart`, `retry`, `quit?`, `quit`.
- End of input means `quit`.
