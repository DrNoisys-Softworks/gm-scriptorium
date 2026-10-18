# 0053. The Windows installer and uninstaller

## Summary

GM-Scriptorium now has a Windows installer and a matching uninstaller. Setup installs for the signed-in user only, so it never asks for administrator permission and never writes outside the user's own folders and registry. The uninstaller removes a short, named list of files and nothing else, and it never touches settings, campaigns or built sites. The installer is built on the Linux release machine with NSIS and is about the size of the executable it carries, because it stores its files uncompressed so the build can prove it packed exactly those bytes. The main alternative, a different installer maker that needs Wine on the build machine, is rejected below. The limits a GM will meet are a larger download, an optional PATH entry that is skipped when the PATH list is too long, and old portable copies that Setup does not remove.

Status: accepted.

## 1. What the GM gets

**Amended by [ADR 0058](0058-installer-options.md).** The options page is now Setup's own page: the Start menu shortcut is an ordinary option, ticked by default, Start with Windows is new, and PATH and the two ports sit under Advanced. The shortcuts and the finish box start the tray app, and the finish box reads "Start GM-Scriptorium now".

- A wizard with a welcome page, a folder page, an options page, a progress page and a finish page. The folder defaults to `%LOCALAPPDATA%\Programs\GM-Scriptorium`. The welcome page says it is for the signed-in user only.
- Options: a Start menu shortcut (always added), a desktop shortcut (off), the PATH entry (off), and "Open GM-Scriptorium now" on the finish page (on). The shortcut and the finish box start the executable with no arguments, so it opens as a double-click does.
- An entry in Installed apps. It carries the name, the publisher `DrNoisys Softworks`, the install folder, the icon and an estimated size. It has no version value, on purpose: the executable reports its own version, and a second copy of the number in the registry would be one more thing to go stale.
- An uninstaller, `Uninstall GM-Scriptorium.exe`, in the install folder. Its finish page lists what was kept, and has a box, off by default, that opens a short feedback form in the browser after Finish. The uninstaller itself sends nothing; the browser opens the page.

## 2. Per-user, no elevation

The installer asks for no elevation (`RequestExecutionLevel user`, which gives an `asInvoker` manifest) and uses the current user's folders and `HKCU` only. A structure test pins this: no `HKLM`, no `HKCR`, no Program Files folder, no `SetShellVarContext all`, no admin or highest level. The folder page checks that Setup can write to the chosen folder (it creates and deletes one file) and, if not, explains in plain words and stays on the page.

## 3. Two build stages and two signing passes

**Amended by [ADR 0058](0058-installer-options.md).** Stage B also packs the tray app, `gm-scriptorium-tray.exe`, and the build proves its bytes the same way.

The uninstaller has to be signed before it is packed into the installer, and NSIS builds an uninstaller only as a side effect of an installer. The build therefore runs in two stages, driven by `scripts/installer.js`:

- **Stage A** compiles the script with `EXTRACT_UNINSTALLER`. A `!uninstfinalize` line copies the uninstaller that makensis builds to the path asked for. The installer that stage also produces is thrown away. The uninstaller is then signed.
- **Stage B** compiles the real installer. It has no uninstall section at all. It packs the signed executable, the notices file and the signed uninstaller, and the installer is signed in turn.

So there are two signing passes in one sitting: the executable and the uninstaller first, the installer second. The release tooling runs them; this decision only sets the sequence the build needs.

Signing starts at 1.0 (ADR 0051, "Amended: releases are signed from 1.0"). Before 1.0 both signing passes are skipped: the executable, the uninstaller and the installer ship unsigned. The build order is unchanged, and stage B packs the unsigned executable and uninstaller.

Between the stages the build changes nothing in the uninstaller. Stage B packs whatever file it is given, byte for byte.

## 4. `SetCompress off`, and the cost

Every file is stored uncompressed, and the script never selects a compressor. The reason is the proof. After stage B the build searches the installer for the exact bytes of the executable and of the uninstaller it was given, and fails with no output if either is missing. With compression on, the machine would have no way to look inside the installer (there is no archive tool on the build machine) and the check would be a hope. A hand-written extractor was the other way to get the proof, and it is far more code to trust than one setting.

The cost is size: the installer is about as large as the executable plus the uninstaller. The download is bigger than it could be. The same build also checks that both outputs ask for `asInvoker` and fails closed if makensis is not on the machine.

## 5. Replacing the program safely

**Amended by [ADR 0058](0058-installer-options.md).** Setup replaces the tray app the same way, and the check covers both programs and runs just before the progress page. When the tray app is running, Setup first offers to close it on a page of its own.

Before anything is written, Setup checks whether the installed executable is running by trying to open it for writing, which Windows refuses for a running program. It shows a Retry or Cancel box until the check passes or the GM cancels. It then writes the new executable as `gm-scriptorium.exe-setup.tmp`, deletes the old one, and renames the temporary file into place, so the final name never holds a half-written file. If the old file cannot be deleted, Setup stops and removes its temporary file.

If a newer version is already installed in the folder, or Setup cannot tell which version it is, Setup warns before replacing it. The box defaults to Cancel. The check runs the installed executable with `--version` and compares the first line with the version in the installer. A silent install gets the same checks and answers Cancel.

## 6. The version compare

`packaging/windows/version.nsh` accepts exactly `X.Y.Z` or `X.Y.Z-rc.N`, with numbers only, one to nine digits each. A stable release is newer than a release candidate of the same `X.Y.Z`. Anything else does not parse, and an installed version that does not parse produces the warning. `scripts/installer.js` refuses to build with a version outside this grammar (and each of `X`, `Y` and `Z` must fit the 16-bit fields of the file's version resource), so Setup's own version always parses. The compare can only be tried on Windows.

## 7. The PATH option

The PATH entry is offered, unticked, and is compiled in only when the build passes `/DWITH_PATH_OPTION`, which `scripts/installer.js` does by default. Dropping it is a one-line change in that script, kept for the case that the Windows check of the option fails.

**Amended (issue #117).** The exact-length rule refused every PATH on Windows, because the size the registry reports for a text value is not its stored length: it counts two bytes more than the value holds. The second bullet below now says how the value is read. A tolerance of one extra character was considered and rejected: it leans on padding the registry does not promise, and from the size alone it cannot tell two closing NUL characters from data after an embedded NUL.

Setup reads the user's `Path` value whole, with its type, before it changes anything. NSIS strings top out at 1024 characters, so a long PATH cannot be edited the usual way without truncating it:

- No value: Setup creates one holding only the install folder.
- A value of the string or expandable-string type, with room to add the folder, that Setup reads whole: closing NUL characters end the value and are not part of it. A value with anything after an embedded NUL, a value bigger than the read buffer, or text that reads back shorter than the stored characters, is left alone. The room rule is unchanged: with D stored characters and K the length of the install folder, Setup acts only when D + 1 + K is at most 1022, so on the default folder (54 characters) a value of 967 characters is accepted and one of 968 is refused. Setup appends `;<folder>` unless the folder is already an exact component (compared without regard to case), and writes the value back with the type it had. Entries are never reordered.
- Anything else: Setup leaves PATH alone and tells the GM, in plain words, that the install worked and how to add the folder by hand.

Setup then tells running programs the environment changed, with a five second timeout. It writes only `HKCU`. It records `PathAdded` under its uninstall key only when it added the entry. The uninstaller removes only its own exact component, under the same guard, and when the guard trips it leaves PATH alone and says so.

The read asks the registry not to expand variables, so the type and size are those of the stored value. A value of the expandable type keeps that type.

## 8. The uninstaller: named files, settings never touched

**Amended by [ADR 0058](0058-installer-options.md).** The list grows by the tray app's four names, the `Run` and `StartupApproved\Run` values named `GM-Scriptorium`, and `HKCU\Software\GM-Scriptorium`. Each shortcut is removed only when Setup recorded making it.

The uninstaller deletes these and nothing else:

- `gm-scriptorium.exe`, `Uninstall GM-Scriptorium.exe`, `gm-scriptorium.exe.old-*` and `gm-scriptorium.exe-update-*.tmp` (what an update leaves), and `gm-scriptorium.exe-setup.tmp`.
- `THIRD-PARTY-NOTICES.txt`, only when its first 40 lines hold both the notices title and a line starting with the version stamp. This is the same recognition rule the updater uses. A file of that name that is not ours stays.
- The Start menu shortcut, the desktop shortcut, its own PATH component, and the Installed apps entry.

Then it removes the install folder with a plain `RMDir`, which fails if anything else is in it. The finish page says so when that happens. It never touches the settings and campaign list in `%APPDATA%\Scriptorium`, the folder named by `SCRIPTORIUM_CONFIG` if that is set, any campaign vault or any built site, and the finish page lists them as kept. The same running-copy check applies. Structure tests pin the delete list: any delete of a path outside it, any recursive remove, and any delete naming the settings folder fails the build.

## 9. The feedback box

The uninstaller's finish page has an unticked box, "Leave feedback for the developer. All feedback is read.", that opens one fixed address, `https://tally.so/r/eq19jQ`, in the browser after Finish. A test requires every web address in the script to be `https` on `tally.so`.

## 10. Notices

NSIS and its plug-ins are in both outputs, so the notices gain Section 9 with the NSIS licence file, reproduced unedited from the Debian package the release machine builds with. See [Licence provenance](../PROVENANCE.md).

## Rejected alternatives

- **Inno Setup.** It is a good installer maker, but it needs Wine on the Linux release machine, and every release would then depend on a Windows emulator.
- **An MSI built with `wixl`.** It builds on Linux, but its user interface is too thin for the wizard the GM was shown, and the plain-language messages would not fit.
- **An "Also remove my settings" box on the uninstaller.** A GM who ticks it by reflex loses the campaign list. Settings are never removed, so there is nothing to ask.
- **An unsigned uninstaller.** It would be the one program in the install that Windows trusts less than the rest, and a reputation system would count it against the signed files. This applies from 1.0; before 1.0 nothing in the install is signed.
- **An installer that carries an unsigned executable.** The signature check on the installed executable (criterion C141) would fail on every installed copy. This applies from 1.0; before 1.0 the executable is unsigned on purpose and C141 does not apply.
- **Running an inner installer to write the uninstaller.** It needs Windows or Wine at build time.
- **Compressing the files with LZMA.** The build could not then prove which bytes it packed.

## Limits

- The download is larger than the program: about the executable's size plus the uninstaller.
- The PATH entry is skipped when the PATH list is too long to change safely.
- Old portable copies are not removed. A GM who used the single file before has to delete that copy.
- Nothing the installer does when it runs can be tried on Linux. The pages, the running-copy check, the version compare, the PATH guard, the shortcuts and the launch from the finish page are checked on Windows (criteria C143 to C146, C151 and C212 in the Windows verification runbook).
