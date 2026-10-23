# 0058. Installer options and the first campaign

## Summary

Setup now installs the tray app beside the program, and its shortcuts and finish box start the tray app, so an installed copy runs in the background from the first click. The options page is Setup's own page: a Start menu shortcut and Start with Windows are ticked, a desktop shortcut is off, and a closed Advanced section holds the PATH entry and the panel's two ports. On a PC with no settings, Setup also asks how to set up the first campaign: in the browser, chosen to start with, or by answering the questions in Setup, which it hands to the program's own `init --yes` once its files are copied. Setup closes a running copy itself, and the uninstaller removes the tray app, the Start with Windows entry and only the shortcuts Setup recorded making. Setup never opens or writes the settings file: the ports go through `desktop set`, the first campaign through `init --yes` and Start with Windows through the tray app's `--autostart`, and the main rejected alternative, Setup writing the settings itself, is below. The limits a GM will meet are that Setup cannot show the ports or campaigns already saved, that on a PC with settings Start with Windows starts unticked unless it is already on, and that a refused campaign answer shows only after the files are copied.

Status: accepted. Amends [ADR 0053](0053-windows-installer.md) sections 1, 3, 5, 8 and 9, and builds on [ADR 0057](0057-windows-desktop-app.md).

## 1. What the GM gets

The pages run in this order: welcome, folder, options, the running-app page when the tray app is running, then either the existing-settings page when a settings file is found or the first-campaign page when none is, the campaign details page when the GM chooses to answer there, progress, the refused-answers page when the program refused those answers, and finish.

The options page offers these, each with its starting value:

- **Start menu shortcut**, ticked. This is an ordinary option now, by owner decision. [ADR 0053](0053-windows-installer.md) section 1 said it was always added.
- **Desktop shortcut**, off.
- **Start GM-Scriptorium when I sign in to Windows**, ticked. It starts the tray app quietly, with no window.
- **Advanced**, closed. It holds **Add GM-Scriptorium to PATH** (off, and only in a build that has the PATH option, as in [ADR 0053](0053-windows-installer.md) section 7) and the panel's two ports, 7400 and 7401.

When all three boxes are off, the page says "You'll need to start GM-Scriptorium from its folder:" and names the folder. That line never blocks Next.

Setup records what it did. Each time it installs, it writes `StartMenuShortcut` and `DesktopShortcut` under its Installed apps key: 1 when it made that shortcut, 0 when the box was unticked. The next Setup starts each shortcut box the way the record says. With no record, the Start menu box is ticked, and the desktop box is ticked only when a shortcut of that name is already on the desktop. A box left unticked makes Setup delete that shortcut if it exists, so an old shortcut from an earlier install cannot keep starting the console program. A missing file is harmless.

The shortcuts and the finish box start `gm-scriptorium-tray.exe` with no arguments. The finish box reads "Start GM-Scriptorium now".

A silent install (`/S`) is not a supported way to install, but it gets the same defaults as the pages.

Rejected: the built-in components page. It cannot hold the port fields, and a page that shows only some of its choices cannot also say what Setup keeps.

## 2. The first campaign

On a PC with no settings, Setup asks how to set up the first campaign. The first-campaign page has two choices. Browser setup is selected and opens when GM-Scriptorium starts with no campaign ([ADR 0028](0028-installer-and-first-run.md)): straight after Finish if "Start GM-Scriptorium now" is ticked, otherwise at its first start. The page links the documentation index (section 7) and says nothing about using the panel from another device.

The other choice, "Answer the questions here now", leads to a details page with the campaign name, a vault the GM already has or a new vault with its game system, and the output folder, each folder with a Browse button. The game systems come from the starter through the build, which refuses to build if any is not a plain lowercase id. Setup checks only that each field is filled in and holds no double quote.

Setup never writes the settings or the vault itself. Once its files are copied, it runs the program's own `init --yes` with those answers, the same command a GM can run in a terminal, so the setup-structure fence and the one writer of the settings stay as they are. It runs after the ports are saved, so the campaign is added to the settings file that `desktop set` may just have made.

Setup passes no `--config`, so the program finds the settings the way section 3 describes. Values are quoted, with any trailing backslash doubled so a folder such as `E:\` reaches the program whole. A relative folder is read from the GM's user folder. A silent install never runs it.

The refused-answers page:

- If the program refuses the answers, a page after the progress page shows the headline "Setup couldn't set up" followed by the campaign name, and the program's last line. When the program's output is empty, or fills Setup's string limit, the page shows a general line instead.
- Try again runs the program again; "Set it up in my browser instead" goes on to Finish with no campaign. These are the only two ways on, by owner decision, because a third that also ends in browser setup would do the same thing. Back and Cancel are greyed there.
- The refusal comes after the copy, also by owner decision.

Rejected:

- Setup writing the settings or the pack.
- Running the checks before the copy from a temporary copy of the program. It doubles the disk writes and the time, and still needs the same reading of the output.
- An answers file for browser review, by owner decision.
- Stripping a trailing backslash. It turns `E:\` into `E:`, which Windows reads as the current folder on that drive.

## 3. Existing settings

Setup looks for the settings file in the same order the program does: the file named by `SCRIPTORIUM_CONFIG` if that is set, otherwise `%APPDATA%\Scriptorium\config.toml`. It checks only whether the file exists, with `IfFileExists`, and never opens it. A structure test fails the build if any other instruction names the path.

When the file exists, Setup shows a page of its own that names the file and says Setup will not change it, and points to Campaigns in the panel for adding another. The port fields on the options page are empty and locked, and a line takes the place of their help line: "Setup found your settings, so it keeps the ports saved there. Change them later on the panel's Overview." Setup cannot show the saved ports, because it cannot read them.

Rejected: reading the TOML in Setup, which would be a second parser that has to agree with the program's, and which the structure test forbids by forbidding any open of the settings. Also rejected: running `config list` to show the campaigns. It probes every vault, so it can hang on a disconnected drive, and on a first install the program is not on disk yet.

## 4. Ports and Start with Windows

**Ports.** On leaving the options page, each port must be 1 to 5 digits, the first not `0`, a whole number from 1 to 65535, and the two must differ. The first-digit rule is there because NSIS reads a leading `0` as octal, so the check runs on the text before any number is made of it. Anything else shows "Type a number from 1 to 65535 for each port, and make the two different." and stays on the page.

When there is no settings file and either port is not the default, Setup runs the program's own `desktop set --port <panel> --preview-port <preview>`, once, after the program is in place. With no settings file that command makes one. Run once with `--port 7410 --preview-port 7411` against an empty folder, it wrote a file that holds a header comment, `config_version = 1`, an empty `[campaigns]` table and a `[desktop]` table with `port = 7410` and `preview_port = 7411`. If the command fails, the detail line reads "The ports couldn't be saved, so the panel uses 7400 and 7401. Change them later on the panel's Overview." and the install carries on.

**Start with Windows.** After the tray app is in place, Setup runs it with `--autostart on` or `--autostart off`, and the tray app writes or removes its own `Run` value. If that fails, the detail line reads "Start with Windows couldn't be changed. Use Start with Windows in the tray icon's menu." and the install carries on.

**The default.** With no settings file, the box starts ticked. With a settings file, it starts as the tray menu's tick would show: ticked when the `Run` value named `GM-Scriptorium` exists and the matching `StartupApproved` value does not begin with `0x03` (the byte Windows writes when the GM switches an item off in Task Manager). Setup cannot read the settings, so it cannot tell whether remote access at sign-in is on for this PC; a settings folder kept from an earlier install may have it on.

Setup never reads or changes remote access at sign-in. A start at sign-in runs the panel for this PC only until the GM ticks "Remote access at sign-in" in the tray menu on that PC (ADR 0057, section 7), and Setup's Start with Windows option changes only whether the tray app starts at sign-in.

NSIS can read only text and number registry values, so reading the `StartupApproved` value uses one `RegGetValueW` call through the System plug-in, with the same type-checked read the PATH option already uses. The structure test that pins the PATH reads inside the PATH option now allows exactly this one other read, in one named function, and checks the call line against an exact pattern.

Rejected: Setup writing the `Run` value itself, which would make a second writer for the same value. Also rejected: a remote access page or option of any kind, by owner decision.

## 5. A running copy

Setup looks for the tray app's window with `FindWindow`, by the class name the tray app registers, `GMScriptoriumTray`. When the window is there, Setup shows a page that says GM-Scriptorium is running and will be closed, and that everything the GM saved is on disk. Its button reads "Close and continue". Pressing it sends the window the same close message the tray app's own Quit handles, and waits up to 15 seconds, longer than the tray app's own 10 seconds, then waits up to 5 more seconds for its process to exit. Cancel stops Setup with nothing changed.

The running-copy check now runs just before the progress page instead of on leaving the options page, so the page above comes first. It covers both programs, and a copy open in a terminal still gets the Retry box. A silent install still runs the check at the top of the first section.

The tray app is replaced the way the program is: written beside its final name as `gm-scriptorium-tray.exe-setup.tmp`, the old file deleted, the temporary file renamed into place. If either step fails, the message reads "Setup couldn't save GM-Scriptorium's tray app, so GM-Scriptorium may not start. Quit GM-Scriptorium if it is running, then run Setup again."

The uninstaller shows "GM-Scriptorium is running. Uninstall will close it first." on its confirm page when the window is there, and closes it the same way. A silent uninstall closes it too. A silent install with a copy running stops instead, as before, and never closes the app.

Rejected: relabelling the buttons of a message box. NSIS cannot, and a page of our own can say what it means.

## 6. What the uninstaller removes

It now also removes the four tray app names (`gm-scriptorium-tray.exe`, and its `.old-*`, `-update-*.tmp` and `-setup.tmp` leftovers), the `Run` and `StartupApproved\Run` values named `GM-Scriptorium`, the key `HKCU\Software\GM-Scriptorium` (the tray app's record of which notifications it has shown) and the Installed apps key. These are the only keys deleted whole. Setup itself never writes under `Run` or `StartupApproved\Run`; only the tray app does, when Setup runs its `--autostart`.

Each shortcut is deleted only when its record says Setup made it, read straight before the Installed apps key goes. A shortcut of the same name that the GM made by hand stays. The confirm page's Removed list now reads "The program, its tray helper, and any leftovers from updates", "The Start menu and desktop shortcuts, if Setup made them", "The start-with-Windows entry", "The PATH entry, if Setup added one" and "The Installed apps entry", and the finish page adds "It no longer starts when you sign in."

The structure tests pin all of it: the delete list, the two value deletes, the two keys, and the guard on each shortcut.

## 7. Links

Setup opens one web address: "Read the user guide" on the first-campaign page opens the documentation index, `https://github.com/DrNoisys-Softworks/gm-scriptorium/blob/main/docs/README.md`, in the browser. The uninstaller's feedback address is unchanged ([ADR 0053](0053-windows-installer.md), section 9). A structure test allows exactly these two addresses.

## 8. Limits

- Setup cannot show the saved ports or campaigns. It only says the settings exist.
- On a PC with settings, Start with Windows starts unticked unless it is already on.
- With no Start menu shortcut, the tray app's update-mismatch line and the panel's stopped page still say "from the Start menu". This decision does not change them.
- A hand-made desktop shortcut named GM-Scriptorium counts as Setup's on the first upgrade.
- A `Run` value of a non-text type reads as absent. Only the tray app writes it, always as text.
- Setup's window does not respond while it waits for the tray app to close.
- A refused answer shows only after the copy.
- Only the program's last line is shown, a reason past the string limit is replaced by a general line, and an unexpected error shows the last line of its report.
- The game systems are shown by id, such as `dnd-5e-2024`.
- Setup's window does not respond while the program checks the answers.
- The finish page does not name the new campaign.
- Whether the reason reads correctly for non-ASCII folder names is checked only on Windows. A line that does not survive the round trip described in the addendum "The running page's button and the program's line" is shown as Windows decoded it.
- Nothing here runs on Linux.

## Rejected alternatives

- **Setup writing the settings itself.** It would be the quickest way to set the ports and the first campaign, but it makes Setup a second writer of a file the program owns, and the setup-structure fence and [ADR 0057](0057-windows-desktop-app.md) section 8 rule it out. The program's own `desktop set` and the tray app's own `--autostart` do the writing instead.
- **Keeping the built-in components page.** It cannot hold text fields.
- **Reading or listing the campaigns in Setup.** See section 3.
- **A remote access page or option.** Remote access is the GM's choice in the tray menu, on the PC it applies to.
- **Setup writing the `Run` value.** See section 4.
- **Running the program's checks before the copy.** See section 2.
- **A second way off the refused-answers page.** See section 2.

## Will catch / Will not catch, deliberately

Will catch:

- A tray app missing from the installer, or different from the one the build was given (the build searches the installer for its exact bytes).
- A command line other than the two `init --yes` lines and the four earlier ones; any `--config`; an `init` reachable in a silent install or before the copy; a third way off the refused-answers page; a web address other than the two; a build whose game-system list holds anything but plain ids.
- A command line or plug-in call outside the short allowed list, any write under `Run` or `StartupApproved\Run`, any open of the settings path, any word naming remote access in the script, and any shortcut delete without its record guard.
- A different window class from the tray app's, a changed page order, and the running-copy check moving back to the options page.
- Any change to a user-facing string in the copy.

Will not catch, deliberately:

- How the pages look and whether anything clips at 100% or 150% scaling.
- Whether the `RegGetValueW` text, which the System plug-in reads only when it runs, does what it should.
- The port checks. They run only on Windows.
- Whether the program's reason reads correctly, and whether the new pages fit.
- What Defender, SmartScreen or Smart App Control decide about the tray app.

## Windows verification

C195, C198, C199, C200, C201, C202, C204 and C217 in `.agents/windows-verification.md`, all OPEN until confirmed on a real Windows machine.

## Addendum: the running page's button and the program's line (issues 213 and 214)

**The button (213).** The running page relabels the shared Next button "Close and continue" but did not resize it, so the label was clipped. Setup now measures the label with the button's own font, in real pixels. If the label does not fit, it widens the button leftward, keeping its right edge, and moves Back left by the same amount. The buttons belong to the window and outlive the page, so the original places are saved first, and they are put back when the page is left and when Back is pressed. Back moves before Next, and the "moved" flag is set before the first move, so a failure part-way leaves a gap, never an overlap, and the restore still works. If a call fails before anything has moved, the layout stays as it was. Rejected: a shorter label (the wording is the owner's), a wider Next on every page (the other pages would drift from the approved look), and asking the button for its ideal size (it needs a newer common-controls version than Setup relies on). Setup does not use dialog-unit conversion, so the fix holds at 100% and 150% display scaling.

**The line (214).** The program prints its refusal reason as UTF-8. Setup shows the last line it printed, and an accented letter appeared as two wrong ones, as if the bytes had been read in the Windows ANSI code page. Setup does not rely on how its process-reading step decodes. It converts the line to ANSI bytes, refusing any best-fit substitute, and reads those bytes as strict UTF-8. If any step fails, or the bytes are not valid UTF-8, the original line is kept. That is correct on a Western code page, a no-op if the line was already decoded correctly, and no worse than before on a double-byte code page, where the round trip can fail. The conversion runs once the whole output has been scanned, whether or not a newline follows the last line, because the program ends every line with one. (The first version sat on the no-newline path only, so on Windows it never ran; a structure test now runs the real scan text against each ending.) Rejected: a new `init` flag that writes the reason to a file (a new command-line surface, a docs-reference change and pinned command lines), and escaping the program's output to ASCII.

Both fixes are OPEN until a person confirms them on Windows: C217 for the button, and step 7 of C199 for the line.
