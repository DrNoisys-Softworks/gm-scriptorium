# 0028. Installer and first run

## Summary

A GM who runs `serve --admin` with no campaign registered now gets browser setup instead of an error. It asks the same five questions as `init` (name, vault, output folder, site title, theme), checks each answer on the server with the same rules and the same messages `init` uses, and writes only at its review screen, producing the same pack files and the same config entry as `init --yes`. The panel's one write to `config.toml` is fenced: one module can reach the config writer, one route can call it, and structural and behavioural tests pin both. The main rejected alternative is making the GM restart after setup: the same process hands over to the normal panel on the same ports and with the same cookie. The limits a GM will meet are that setup listens on this computer only whatever remote access is saved, and that a network share is warned about but not checked for git.

Status: accepted for sections 1 to 5. The launch sections at the end are pending and will be written when launch mode lands.

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

## Rejected alternatives

- **The browser deciding validity.** Two copies of the rules would drift. Every check runs on the server, and the browser draws the answer.
- **Restarting after setup.** It would drop the GM's session and port and make the first minute worse for no gain. The handover is in process.
- **The panel requiring `init.js`.** `init.js` reaches the config writer and the prompt code. The shared pieces moved to `src/setup/scaffold.js` instead.
- **Injecting the config writer from `serve.js` to keep the old graph test green.** That would evade the fence instead of stating it. The fence is named and tested.
- **Probing network paths on every keystroke.** It would look up every partial host name as it is typed.
- **Worker threads for the probe.** `test/admin-variants.test.js` forbids them under `src/admin`, and they are a packaging risk.
- **A first-preview `--force`.** A forced first build over a check error would be a new exception to ADR 0022. The refused preview is shown honestly instead.
- **Putting the welcome in `config.toml`.** The config holds what the GM decided, not what the panel has shown.

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
- on Linux, a snap-packaged browser that cannot read hidden folders (relevant once the browser is opened by a launcher file; the workaround is the printed link).

## Pending: launch mode

Running the program with no command, and the console that goes with it.

## Pending: the launch code and how it reaches the browser

A one-time code instead of a token in the link.

## Pending: opening the browser

The one program the panel may start to open a page.

## Pending: stopping when the window closes

Closing the console window, and the "stopped" tab.

## Windows verification

`.agents/windows-verification.md` criterion C135 covers browser setup through the real win-x64 executable. It is **OPEN**: the behaviour is verified on Linux, from source and through a Linux packaged build, and nothing on Windows has run it.
