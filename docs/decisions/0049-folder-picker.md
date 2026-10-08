# 0049. The folder picker

## Summary

The vault and output questions in browser setup now have a Browse button. It opens a folder list inside the panel, under the field, so a GM can click to a folder instead of typing a path. The list shows folders only, never a file name, and the New folder button on the output question makes one folder at a time, at once. It works from any signed-in browser, including one on another device, and listings from another device are written to the audit log. The main alternative, a native operating system dialog, is rejected below because the panel runs in a browser that may be on another machine. Limits a GM will meet: folders hidden only by a Windows attribute still show, a mapped drive looks like any other drive, network shares cannot be browsed by host name (type the path), and a link or junction can be seen but not opened.

Status: accepted.

## 1. What it does

- **Browse.** A Browse button sits beside each path field. It opens an inline list (not a modal) at the deepest folder that exists above what is already in the field, or at the account's home folder. The list shows child folders, the folder's parent, and a note when it was cut short.
- **Choose this folder.** It puts the open folder's full path in the field, closes the list, returns the keyboard to Browse and runs the same server check the field always ran. The picker never decides what is valid.
- **New folder.** On the output question only, because a vault already exists. It makes one folder directly inside the open folder, immediately, and shows it in the list as just created and selected.
- **Keyboard and screen readers.** The list is a single-select listbox. The arrow keys, Home and End move, Enter opens a folder, Backspace or Alt+Up goes up, Escape closes. A polite live region says the folder and how many folders it holds.
- **The contract for later screens.** `ScriptoriumAdmin.picker.attach(input, opts)` is the one entry point, so other screens can use the same component.

## 2. The listing route

`GET /api/folders` answers one of three views.

- **Roots.** On Linux and macOS: `/` and Home, with no probing. On Windows: the drives `A:` to `Z:`, asked one at a time, plus Home. A drive that does not answer is shown as not responding and every later letter is left unchecked, so one dead drive never holds up the list. A not-responding drive is not asked again until the GM presses Refresh.
- **Start.** The deepest existing folder above the field's value, found by walking up at most 32 levels. A network path (`\\host\share` or `//host/share`) is never asked: the answer is "deferred", and the client puts the value in the location box for an explicit Go.
- **Folder.** The child folders of one folder, each with its name, full path, and whether it is a link, hidden, or could not be examined. Nothing else about a file or folder is returned: no file name, count, size or date.

Rules for a folder listing:

- **Links are marked and never followed.** A symbolic link or junction is listed with `link: true`. Asking for a link's own listing answers `state: link`. Only a bounded `lstat` decides what a Windows reparse point is (a OneDrive folder is an ordinary folder), because the directory entry's own type cannot.
- **Hidden.** A name starting with a dot is hidden. On Windows these are also hidden, compared without regard to case: `$Recycle.Bin`, `System Volume Information`, `$WinREAgent`, `$WINDOWS.~BT`, `Config.Msi` and `Recovery`. Hidden folders show, flagged, when the client asks.
- **Caps.** At most 500 folders are returned, sorted without regard to case (no `Intl`, which the packaged executable cannot rely on). At most 20,000 directory entries are scanned, files included. At most 1,000 link or unknown-type entries are confirmed. The scan has a soft deadline of 2,000 milliseconds. Passing any cap sets `truncated`. A filter of up to 128 characters narrows the list on the server, within the same caps.
- **Path input.** A path is a string of at most 2,048 characters with no NUL. On Windows only a drive path (`C:\` or `C:/`) or a share path is accepted; a drive-relative form, a rooted form with no drive, the device namespace (`\\.\`, `\\?\`), a colon after the drive and a reserved device name as a component are refused. On Linux and macOS the path must start with `/`. There is no deny-list: on loopback this is the same user's own machine, and a remote session is signed in.
- **Answers, never errors.** An unreadable folder answers `permission`, a vanished one `missing`, a file `not-folder`, a hung one `not-responding`, and a full probe cap `busy`. A child that cannot be examined is listed with `unreadable`.

## 3. Making a folder

`POST /api/folders/create` takes `{ parent, name }` and makes exactly one folder.

- **The name** follows the upload-name rules of ADR 0022, section 7, rules 1 to 7: it is required, at most 128 characters, and free of separators, colons, Windows-illegal and control characters; it must not start with a dot, contain `..`, end in a dot or a space, or be a reserved Windows device name. The two file rules (`.md`, image extensions) do not apply to a folder.
- **Create-only, single level, non-recursive.** The module issues one create call with no options, directly inside the listed parent. It never creates ancestors, never tolerates an existing name, and never deletes, renames or overwrites anything. An existing name is refused as `exists`.
- **The parent** must exist, be a directory and not be a link. Its real path is taken, and the new folder is `realpath(parent)/name`, so it is a direct child by construction.
- **Where it may not go.** Never inside, or equal to, the config folder, the panel folder (checked separately, because `panel` could be a link) or any registered campaign's vault or profile vault. Each is checked both by real path and by the written path. A real path that cannot be had falls back to the written path.
- **Checked afterwards.** The created folder's real path must be where it was meant to be. If not, the answer is `moved`, names the path, and nothing is undone.
- **One at a time.** The create runs under the same exclusive lock as builds and checks (ADR 0022, FR31); another running job answers 409 `busy`.
- **A vault is not written to.** This is not a vault write: it can never land in a vault, and it is not one of the pack writes `src/vault/packwrite.js` guards. Its own fence is `test/folders-structure.test.js`.

## 4. Who can use it, and the audit

- Both routes need a signed-in session of any kind: the launch token's cookie on this computer, or an admin session from another device. They are served on the admin listener only, never the preview one. A create is a POST, so it carries the exact Origin check every admin POST has. No gate or content-security-policy change was needed.
- Both routes are allowed while setup is active, and keep working after setup hands over to the normal panel.
- **A create is audited for everyone.** The router writes the usual request and response lines, and the handler adds one `folder-create` line carrying the folder's full path before it makes anything. A request from another device whose log cannot be written is refused with 503 and nothing is made.
- **A listing is audited for another device only.** One `folders` line is written before anything is read, carrying the folder listed (nothing for the roots view). If it cannot be written the answer is 503 and nothing is listed. A listing from this computer writes nothing, so browsing does not flood the log.
- The audit log gains one key, `path`: a validated absolute folder path, capped like every other audit string, never a request body.

## 5. Never stalling

Every filesystem call in both modules is one operation under the shared bounded probe of ADR 0028, section 3, which allows two calls in flight. A call that runs out of time keeps its slot until it finishes, so a dead share costs one bounded wait and the next call answers `busy` at once. There is no new pool, no worker thread, and no synchronous filesystem call on a request path. Windows drives are asked strictly one at a time so enumeration never holds both slots. The listing module lives under `src/setup`, so the existing no-write fence over that folder holds it read-only without editing a constraint test.

## 6. What this changes in earlier decisions

- **ADR 0022, section 4.** Two routes now take a folder from a request, for names only, and there is one create-only folder write that is not a vault write.
- **ADR 0028, section 1.** Two more routes are admitted while setup is active, and setup's "writes only at its review screen" no longer covers a folder made with New folder. The review screen's wording changed to match.
- **FR35** is unchanged: the config writer is still reached only through the setup commit.
- Folders a later screen needs above a new vault are made by that screen's own writer, under its own decision.

## Rejected alternatives

- **A native operating system dialog.** The panel is a web page and may be open on another device; the dialog would appear on the wrong machine, or not at all.
- **Pending folders created at the end.** The owner chose to make the folder immediately.
- **A picker that is blind to other devices.** Another signed-in device gets the same picker, with its listings audited.
- **Asking a network path on every keystroke.** A dead host would stall the panel. The path is asked only on Enter or Go.
- **A separate probe pool for the picker.** Hung probes could take all four of libuv's threads. The shared cap of two covers it and the field checks together.
- **Auditing every listing.** It would flood the log with navigation. Only another device's listings are recorded.
- **Router-level audit of GET requests.** It would change the rule that audit is for POSTs and record every GET.
- **Putting the write in `packwrite.js` or under `src/setup`.** The first is the vault pack chokepoint; the second is fenced read-only.
- **Collation through `Intl`.** The packaged executable's history with `Intl` makes a plain lowercase compare the safer choice.

## Will catch / Will not catch, deliberately

Will catch: a file name in any listing; a link read through; a create that would nest, overwrite or recurse; a create inside the config folder, the panel folder or a vault, by real path or by written path; a hung drive or share; a network path asked before Go; a log that cannot record another device's use.

Will not catch:

- a folder hidden only by a Windows attribute (the attribute is not read);
- a mapped drive's network nature, which looks like any local drive;
- a create whose time ran out but which finished later (the folder may then exist although the answer said not-responding);
- an ancestor swapped to a link in the instant between the checks and the create (reported as `moved`, never undone);
- a hung probe holding a thread until the operating system gives up;
- a page showing fewer than 500 folders when links to files were omitted along the way;
- a reparse point that cannot be confirmed, which is listed as unreadable;
- a folder of exactly 20,000 entries, which is reported as cut short although nothing remained.

## Windows verification

`.agents/windows-verification.md` criterion C138 covers drives, junctions, OneDrive, hidden system folders, long paths, permissions and folder creation through the real win-x64 executable. It is **OPEN**: everything above is verified on Linux, from source and through a Linux packaged build, and nothing on Windows has run it.
