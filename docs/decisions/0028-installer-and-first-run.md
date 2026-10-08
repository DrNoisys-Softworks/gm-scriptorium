# 0028. Installer and first run

## Summary

Running GM-Scriptorium with no command in a terminal, or by double-clicking it, now opens the panel in the default browser, and a GM with no campaign yet gets browser setup instead of an error. Setup asks the same five questions as `init`, checks each answer on the server with the same rules and messages, and writes only at its review screen, producing the same pack files and config entry as `init --yes`; the panel's one write to `config.toml` is fenced. The browser is signed in with a one-time code that travels in an owner-only launcher file, never in a command line or an address, which needs one narrow, named exception to the exact-Origin rule. The main rejected alternatives are making the GM restart after setup, and starting the browser through a shell command. The limits a GM will meet are that setup listens on this computer only, that a network share is warned about but not checked for git, and that a snap-packaged Linux browser may not be able to read the launcher file.

Status: accepted.

## 1. Setup mode

`serve --admin` enters setup mode when three things are true: no campaign is named on the command line (neither as an argument nor with `--campaign`), the config has no campaign registered, and `--vault` was not given. A missing config file counts as no campaigns, including a missing file named with `--config`. Every other case reaches the campaign resolver exactly as before, so `serve --admin ghost`, `serve --admin --campaign ghost`, plain `serve`, `check` and `build` keep their exit codes and messages. `--vault` with no campaign is refused with one plain line, because it would name a vault for a campaign that does not exist yet.

The console prints the usual lines, then one more: `setup: no campaign yet, so the panel starts with setup`. It comes after the usual lines on purpose, so the line that carries the one-time link is still the first line printed. With `--json`, the readiness line gains `"setup": true`, and only in setup mode.

Setup is loopback only, whatever `[remote]` says. It uses the local listener for both ports (the operating system picks them), runs no readiness check and never opens a remote listener. When the saved mode is not local, one line before any listener opens says remote access starts the next time GM-Scriptorium starts. A `[remote]` table that does not parse never stops setup.

While setup is active the router answers only a fixed list: `GET /auth`, `GET /api/session`, `GET /setup`, `GET /api/setup/state`, `GET /api/setup/check`, `POST /api/setup/commit`, and the static assets. `GET /` serves the setup page. Every other route answers 409 with a fixed JSON body, never a 500. The setup routes need the same session and the same exact Origin as every other route, the commit is audited like every other write, and each setup handler also refuses a remote-kind request, as defence in depth. After the handover `GET /setup` redirects to the Overview, and the check and commit routes answer 409.

## 2. The panel's one write to config.toml

ADR 0022 forbade the panel's module graph from reaching the config writer. Browser setup needs exactly one write, the registration of the first campaign, so the rule is amended, not dropped:

- `writeConfigFile` moves from `src/cli/config.js`, which also starts the editor, into `src/config/write.js` beside `addCampaign`. `src/cli/config.js` re-exports the same function.
- `src/setup/register.js` is the only panel-side module that requires `src/config/write.js`, and `src/admin/handlers/setup.js` is the only module that requires `register.js`. The commit route is the only caller of `commitSetup`.
- The panel graph still never reaches `src/cli/config.js` or `src/cli/init.js`. The shared pieces `init` and setup both need (the scaffold entries, the default output and title, the non-empty output texts) live in `src/setup/scaffold.js`, and `init.js` re-exports the identical objects.
- Tests pin it from both sides. The graph tests show `write.js` has one importer chain. A source scan shows no other module under `src/admin` or `src/setup` names the writer. A behavioural sweep spies on the writer, hits every route of the table in normal mode and in setup mode with empty bodies, and expects no call except one valid setup commit, which expects one. Setup code stays write-free apart from the create-only pack writer in `src/vault/packwrite.js`.

The commit re-reads the config before anything is written. If it now holds any campaign (another instance, or a terminal `init`, got there first) the commit is refused with nothing written. The config is read again after the last slow folder check, and everything from there to the write is synchronous; only a truly simultaneous write by another process can slip through (see the last section). The commit also refuses a config file path or a panel folder inside a vault, and a non-empty output folder that is not an earlier build unless the review sent an explicit confirmation. Pack entries go through `createPackEntries`, which is create-only, so a pack file that already exists is left alone and listed. Nothing is ever rolled back.

## 3. Checking answers without stalling the panel

The shared validators for a vault and an output folder are synchronous, and a synchronous existence check against an unreachable network host can block the whole process for a long time. So each path is first probed asynchronously on the thread pool, with a bound of three seconds and at most two probes in flight at once (a third answers "busy"). The synchronous validator runs only after the probe answers that the path exists or does not. A probe that times out keeps counting until the operating system finally gives up, because the call is still holding a thread.

A path that looks like a network share (`\\host\share` or `//host/share`) is not touched at all until the GM commits the field: leaving the box, pressing Continue, or pressing Check again. Typing never probes, so a half-typed host name is never looked up. A local path is checked while typing, after a short pause. The browser never decides validity. Every refusal carries the shared validator's own message, shown word for word under the friendly text.

Setup refuses relative paths, because a browser has no meaningful working directory. A drive letter cannot be told from a mapped network drive without detection, so a drive letter is probed live and bounded, and only a UNC path waits. A network share vault is allowed. The review shows a "network share" pill, and the screen shows the two git commands to run first. There is no git status line and no mapped-drive detection.

## 4. The handover

After a successful commit the same process serves the campaign. `applyHandover` resolves the campaign from the config that was just written, resolves its vault and site, and copies the result onto the one context object every handler already closed over. The ports, the one-time token and the cookie do not change, and nothing restarts. This amends ADR 0022 section 5: the campaign context is still resolved once and then fixed, but in setup mode "once" means at the handover, not at launch. A second handover is refused. If the handover fails, the response says so, the registration stands, and the page tells the GM to restart.

## 5. The first preview and the welcome

After the commit the page asks for a check, then a preview, through the existing routes, and draws four lines. The preview is built into the panel's own preview folder; the output folder is never created or touched. A check error does not stop the preview step from running, but the build pipeline refuses to build over an error (the panel never forces a build, ADR 0022), so the screen shows the check as a failure and the preview as refused, and never shows "ready". Registration is kept, and the page offers "Go to my panel" instead.

The Overview welcome is shown once, only for a campaign that browser setup created. The names waiting for it are kept in `welcome.json` beside the config, in the folder the panel already uses for its other per-machine files, written privately. It is not browser storage and not `config.toml`. Dismissing it removes the name for good, and a reload does not bring it back.

## 6. Launch mode

Running the program with no command, in a terminal or by double-clicking the executable, starts `serve --admin` underneath in launch mode. It starts when there is no command, no flag other than `--config <path>`, and both standard input and standard output are terminals. A double-clicked console program and a typed command look the same (both have a terminal on each end), and telling them apart would need native code, so every operating system behaves the same. With no command and no terminal, the program prints help and exits 0, as before. `--help`, `--version` and `--notices` are unchanged, and `--help` now ends with a line saying that running with no command opens the panel.

The target is the one `serve --admin` would pick: browser setup when there is no config or no campaign, otherwise the default campaign. If that cannot be resolved (several campaigns and no default, a config that does not parse, an unreachable vault), the console prints the one-line message and waits on "Press Enter to close this window." before exiting with the code the frozen table gives, which is 3 for those cases. Any exit that is not a deliberate stop pauses the same way, so a double-clicked window does not vanish with the message in it. A deliberate stop does not pause.

The console prints the version, "GM-Scriptorium is running. Your panel is open in your browser.", "Close this window to stop.", the panel address with "this PC only", a "Setup" line (or a "Campaign" line, which the mock does not show), and "Browser didn’t open? Press O to open it again." The apostrophe is U+2019, as in the mock; whether a Windows console renders it is a recorded check, not something to change quietly. The long-lived token is never printed in launch mode, except in the fallback described in section 8. After startup nothing is written except in answer to O, which keeps the window quiet.

Keys are read raw: O (either case) mints a new code and opens the browser again, byte 0x03 (Ctrl+C, which raw mode delivers as data instead of a signal) stops, and every other key, including any escape sequence, is ignored.

With a saved remote mode, the pre-listen warning is printed before any listener opens, as ADR 0002 requires. The "Panel" line then says "on this machine", followed by the same address lines the plain `serve --admin` prints (never the token). Auto-open always targets the loopback address.

This supersedes ADR 0021's no-argument offer. `shouldOfferInit` and `runInitOffer`, and the five tests that exercised them, are removed. `init` and its flags and prompts are unchanged.

## 7. The launch code and how it reaches the browser

A code is minted at start and again on each O. It is 256 random bits from the system's random source, base64url, and only its SHA-256 is held, in memory. It is single use (any lookup spends the entry it finds), usable at +59999 milliseconds and dead at +60000, with at most four outstanding and the oldest evicted first. It is accepted only from a loopback request; the gate refuses `/auth/launch` for a remote-kind request, exactly as it refuses `/auth`. `/auth?token=` keeps working unchanged.

The code reaches the browser through a launcher file, `launch-<pid>.html`, in the per-user panel folder beside the config. The file is written atomically at mode 0600 into a 0700 folder, after checking the folder is not inside any registered vault, and it is never put in the system temp folder (snap-packaged browsers cannot read it). The opener is given only that file's path. The file is removed when the code it holds is spent, on a timer when that code would expire, and at stop. The code appears in no command line, no address, no console line, no audit entry, no response body, no header other than the session cookie, no file name, and no file except the launcher.

The launcher is a small HTML file that auto-submits one form, a POST of the code to `/auth/launch` on the loopback port. Three traps shaped it:

- **The cookie is SameSite=Strict.** A browser stores a Strict cookie set on a top-level navigation response, but will not send it on a redirect that began on another site. A `file:` page has no origin, so a 303 to the panel would land on the locked page. The exchange therefore answers **200**, with the cookie and a small page whose script navigates to `/` from a same-origin document, and that navigation carries the cookie. `location.replace` also drops the POST from the history. A no-script link is on the page too.
- **Every admin POST needs an exact Origin.** A form posted from a `file:` page sends `Origin: null`. The gate accepts that for exactly one case: the path `/auth/launch`, a loopback-kind request, and a process that has a code store (only launch mode makes one, so `serve --admin` has no exception). It is one expression in the gate, in the same place as the exact-Origin check, and the gate order is unchanged. Even then the request does nothing without a valid unspent code. Every attempt that reaches the handler is audited as a code sign-in, whether it succeeded or not, the way token sign-ins are; a remote-kind attempt is refused at the gate and, like `/auth`, is not audited.
- **The panel's CSP says `form-action 'none'`.** The launcher is not a panel response, so the panel's policy never applies to it. It carries its own policy instead: only the one fixed inline script (by hash) may run, and the form may post to this one loopback port and nowhere else. The panel's own CSP is unchanged.

## 8. Opening the browser

`openFile` in `src/proc/run.js` is the opener. It stays inside the one process spawner so the structural rule that only that file may start a program holds without being edited, and it is exempt from the spawner's allowlist, the kill rules and the live-run set, which ADR 0046 now says in an addendum. It uses no shell. On Windows it runs `rundll32.exe url.dll,FileProtocolHandler <file>`, with `rundll32.exe` resolved absolutely from `SystemRoot`, never from the PATH. On macOS (from source only, since no macOS executable ships) it runs `/usr/bin/open`. On Linux it needs `DISPLAY` or `WAYLAND_DISPLAY`, and finds `xdg-open` on the absolute entries of the scrubbed PATH, as an executable regular file. The display variables and the few desktop variables an opener needs are passed through on POSIX only; the rest of the environment is built from scratch as for any other program.

The open is fire and forget: ignored stdio, a session of its own (so closing the terminal never reaches the browser), unref-ed, never registered in the live-run set, never killed by a timer or by `killAll`. That matters because the "stopped" tab needs the browser to outlive the panel. The call resolves "exited" with the code if the opener finishes within ten seconds, otherwise "running", and rejects only if the program could not be started.

If the opener is missing, there is no display, it fails to start or it exits non-zero, the console says "The browser couldn't be opened. Open this link instead:" and prints today's `admin panel:` line with the token link. That is ADR 0022 section 11's existing accepted residual, and it keeps the GM from being locked out. O tries again.

## 9. Stopping when the window closes

Closing the console window, or the terminal tab it lives in, runs the same stop path as Ctrl+C: remove the launcher file, close both listeners and the preview folder, cancel any program the panel started, and give the terminal back. On Windows a closed console window reaches Node as SIGHUP (SIGBREAK is Ctrl+Break, which the old comment mislabelled), so SIGHUP is registered on Windows for every `serve` mode. On POSIX it is registered only in launch mode, which leaves `serve --admin` exactly as it was there: a hangup still ends it at once, as it does for any Node program, because Node resets a program's signal dispositions when it starts. That also means `nohup` does not protect `serve --admin` (the ignore it sets is reset before any code runs); run it under `setsid` or a service manager instead. Launch mode registers SIGHUP because a closed terminal should clean up after itself.

An open panel tab notices within a few seconds that the panel has gone. Every three seconds the page asks for a public asset (`HEAD /assets/favicon.svg`), and after two failures in a row it replaces itself with the "GM-Scriptorium has stopped" page, built in the browser. A public asset touches no session, so asking never refreshes or extends anything, and no session lifetime changes. The page says "You closed its window" in launch mode and uses neutral wording otherwise.

## 10. What this changes in earlier decisions

- **ADR 0021** is superseded in part: with no command in a terminal, the panel opens instead of the offer to run `init`.
- **ADR 0022 section 3** is amended: in launch mode the long-lived token is printed only as the fallback in section 8. `serve --admin` is unchanged and still prints it.
- **ADR 0046** gets an addendum: a launch-only entry point, `openFile`, and the fact that `bin` now reaches the spawner through launch mode.
- **The remote-structure test** that lists who may write private files now names the launcher file writer, because the launcher is a new private file in the panel folder.

## Rejected alternatives

- **The browser deciding validity.** Two copies of the rules would drift. Every check runs on the server, and the browser draws the answer.
- **Restarting after setup.** It would drop the GM's session and port and make the first minute worse for no gain. The handover is in process.
- **The panel requiring `init.js`.** `init.js` reaches the config writer and the prompt code. The shared pieces moved to `src/setup/scaffold.js` instead.
- **Injecting the config writer from `serve.js` to keep the old graph test green.** That would evade the fence instead of stating it. The fence is named and tested.
- **Probing network paths on every keystroke.** It would look up every partial host name as it is typed.
- **Worker threads for the probe.** `test/admin-variants.test.js` forbids them under `src/admin`, and they are a packaging risk.
- **A first-preview `--force`.** A forced first build over a check error would be a new exception to ADR 0022. The refused preview is shown honestly instead.
- **Putting the welcome in `config.toml`.** The config holds what the GM decided, not what the panel has shown.
- **`cmd /c start`.** It parses the line as a shell command, which is the one thing the opener must not do.
- **The code in the opener's command line.** Any process on the machine can read a command line.
- **The code in the query string, a fragment or `window.name`.** The first two end up in the history, and browsers clear the third on a cross-site navigation.
- **A SameSite=Lax cookie.** It would make the exchange work with a redirect, and widen the cross-site exposure of every panel request.
- **A 303 after the exchange.** The Strict cookie is not sent on the redirected request (the first trap).
- **Electron or Tauri.** The direction is a browser-based panel with no native shell.
- **Detecting a double-click.** It needs native code, and a console program started either way has a terminal on both ends.
- **The system temp folder for the launcher.** Snap-packaged browsers cannot read it, and it is shared between users.
- **Adding `xdg-open` to the spawner's allowlist.** That would change a pinned list for a program that must never be killed like the others.
- **`explorer.exe` as the Windows opener.** Kept as the recorded fallback if a user profile path with a non-ASCII letter defeats `rundll32.exe`.

## Will catch / Will not catch, deliberately

Will catch:

- a second campaign registered between page load and commit, by a terminal `init` or another window (the commit is refused, nothing is written);
- a vault, output folder or panel folder in a forbidden place, with the shared message;
- an unreachable network path, as "can't reach that folder", without stalling any other request;
- any route outside the setup list while setup is active, as a clean 409.

Will not catch, deliberately:

- a share that drops between the probe and the write;
- two first-run instances writing in the same instant: the config is read again after the last slow folder check and everything from there to the write is synchronous, so only a truly simultaneous write can get through;
- a mapped network drive, which is treated as a local disk;
- a hanging probe holding one of the thread pool's four threads until the operating system gives up;
- on Linux, a snap-packaged browser that cannot read hidden folders. The launcher file lives in the per-user folder beside the config, which is a hidden folder there, and `xdg-open` reports success either way, so no fallback line appears. The workaround is `serve --admin`, which prints the link;
- a hangup (a closed terminal) stopping `serve --admin` on Linux and macOS without cleanup, with or without `nohup`. This is unchanged by this decision: only launch mode handles SIGHUP on POSIX, so the preview folder of a hung-up `serve --admin` is left for the next run to ignore;
- an opener failure that exits 0. `rundll32.exe` does not reliably report a failure through its exit code on Windows, so a browser that did not open may not print the fallback line. Pressing O tries again;
- the console window pausing while text is selected in it (QuickEdit). A selection can stall the process writing to that console until Esc is pressed. The panel is quiet after startup, which keeps the window small, but this is recorded rather than fixed;
- a hard kill (power loss, `kill -9`, Task Manager) leaving a launcher file behind. It holds a code that is dead after 60 seconds, so it is only clutter, and the next start of the same process id replaces it;
- other software running as the same user reading the launcher file during its 60 seconds. The folder is owner-only, so this is the same exposure as the user's own browser profile;
- a default `.html` handler that is not a browser (an editor, say). The launcher then opens as text and nothing signs in, and the console's "Press O" line is the way out;
- `Origin: null` sent to `/auth/launch` by other local or sandboxed pages. The request is useless without a valid code, and every attempt is audited like a bad `/auth` guess.

## Windows verification

`.agents/windows-verification.md` criterion C135 covers browser setup through the real win-x64 executable, and C130, C131, C132, C133, C134 and C136 cover launch mode: the console and the browser landing, the code never reaching a command line or the history, closing the window, O and Ctrl+C, the pause on errors, and a second start. All of them are **OPEN**: the behaviour is verified on Linux, from source and through a Linux packaged build under a pseudo terminal with a fake opener, and nothing on Windows has run it.
