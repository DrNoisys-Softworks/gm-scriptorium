# Install, update and build from source

This page is for a GM who wants to get GM-Scriptorium running, keep it up to date, or build it
themselves.

## Install

### Windows: the installer

1. Download `gm-scriptorium-setup-win-x64.exe` and `SHA256SUMS` from the latest release on the
   [Releases page](https://github.com/DrNoisys-Softworks/gm-scriptorium/releases). You can also
   build from source (see below).
2. Verify the download before running it. In PowerShell or cmd:
   ```
   certutil -hashfile gm-scriptorium-setup-win-x64.exe SHA256
   ```
   Compare the output against the matching line in `SHA256SUMS`.
3. Double-click the installer. Setup installs GM-Scriptorium for you only. It needs no
   administrator permission and no password prompt, and it writes only inside your own user folder.
   It walks you through five pages:
   - **Welcome.**
   - **Where.** The folder defaults to `%LOCALAPPDATA%\Programs\GM-Scriptorium`. You can browse for
     another folder inside your own user folder.
   - **Options.** A Start menu shortcut is always added. A desktop shortcut and "Add
     GM-Scriptorium to PATH" are off until you tick them. Adding to PATH lets you type
     `gm-scriptorium` in any terminal; if your PATH list is too long to change safely, Setup
     leaves it alone and tells you.
   - **Progress.**
   - **Finish.** "Open GM-Scriptorium now" is ticked, and opens it the same way a double-click does.
4. Start GM-Scriptorium from the Start menu, or type its name in Start.

If a copy of GM-Scriptorium is open, Setup asks you to close it, then click Retry. If a newer
version is already installed in the folder, Setup warns you before replacing it; Cancel is the
default.

The installer lists GM-Scriptorium under **Installed apps**, with `DrNoisys Softworks` as the
publisher. It is larger than the program itself, because the files inside it are stored as they
are, so the build can prove they are exactly the files it was given. Releases before 1.0 are unsigned, so Windows may
warn the first time Setup runs (**More info**, then **Run anyway**).

**If you used the single file before:** Setup does not touch the old copy. Your settings and campaign
list live in `%APPDATA%\Scriptorium`, so they carry over to the installed program unchanged. Every
earlier version, back to 0.2.3, keeps them in the same place. When you are happy with the
installed program, delete the old portable copy yourself, so there is only one `gm-scriptorium.exe`
on your machine and the Start menu shortcut is the one you run.

### The single file (Windows or Linux)

1. Grab the binary for your platform (`gm-scriptorium-win-x64.exe` or `gm-scriptorium-linux-x64`)
   plus `SHA256SUMS` from the same release.
2. Verify the download before running it.

   **Windows (PowerShell or cmd):**
   ```
   certutil -hashfile gm-scriptorium-win-x64.exe SHA256
   ```
   Compare the output against the matching line in `SHA256SUMS`.

   **Linux:**
   ```
   sha256sum -c SHA256SUMS
   ```
   (or `sha256sum gm-scriptorium-linux-x64` and compare by eye against `SHA256SUMS`.)
3. Rename the downloaded binary to `gm-scriptorium.exe` (Windows) or `gm-scriptorium` (Linux).
4. It is a single portable executable. Put it wherever you keep tools and run it from there. On
   Linux this is the only way to install it.

**About the Windows warning:** releases before 1.0 are unsigned, so the first time you run one
Windows SmartScreen will probably say "Windows protected your PC". Click **More info**, then **Run
anyway**. If Smart App Control is on, it may block an unsigned executable outright. The `SHA256SUMS`
check above is how you verify the download.

**From 1.0, releases are signed.** A signed release carries a valid digital signature on the Windows
executable. The certificate is new, though, and Windows SmartScreen trusts a certificate more as
more people run programs signed with it. Until that reputation builds, SmartScreen may still say
something like "Windows protected your PC" the first time you run it. If it does, click **More
info**, then **Run anyway**. That is expected for a new certificate, not a sign anything's wrong.

To check a signature, right-click the executable, choose **Properties**, and open the **Digital
Signatures** tab. You can also run this in PowerShell and look for `Valid`:

```
Get-AuthenticodeSignature .\gm-scriptorium.exe | Select-Object Status
```

The `SHA256SUMS` check above still applies and is worth doing.

## Uninstall

Open **Settings > Apps > Installed apps**, find GM-Scriptorium and choose Uninstall, or run
`Uninstall GM-Scriptorium.exe` from the install folder.

The uninstaller removes only what Setup put there: the program, the leftovers an update can
leave beside it, its own notices file, the Start menu and desktop shortcuts, the PATH entry if Setup
added one, and the Installed apps entry. It never touches:

- your settings and campaign list in `%APPDATA%\Scriptorium` (or the folder named by
  `SCRIPTORIUM_CONFIG`, if you set that),
- your campaign vaults, or
- your built sites and anything you have published.

The install folder is removed only if it is empty afterwards. If you saved something else in it,
the folder stays and the last page says so. If GM-Scriptorium is open, the uninstaller asks you to
close it and click Retry. The last page also has a box, off by default, that opens a short feedback
form in your browser after Finish. The uninstaller itself sends nothing.

If you used the single file, delete that file yourself; there is nothing to uninstall.

## Updating

```
gm-scriptorium update
```
This checks GitHub for the newest release, downloads it, checks it against the published
checksums, and replaces the program. It needs an internet connection and nothing else: no GitHub
account, no token and no other tool. Add `--check` to only ask whether a newer release exists,
`--pre` to include prereleases, or `--version TAG` to install one exact release.

`update` talks only to GitHub (`api.github.com`, `github.com` and the host GitHub downloads release
files from). It ignores proxy settings, so on a computer that can only reach the internet through
a proxy it cannot work. If you can't use `update`, or it can't reach GitHub, it says so in one
line and points at the Releases page. You can always download the new release from there and replace
the program yourself, or run the new installer.

On an installed copy, `update` also replaces the tray helper (`gm-scriptorium-tray.exe`) that sits
beside the program. It downloads and checks both files first, and if anything goes wrong it puts
everything back and says nothing changed. When it finishes, quit GM-Scriptorium from its icon in the
system tray and start it again, so the new version is the one running.

The panel also tells you when a newer version is out. When GM-Scriptorium runs from its program
file, the Overview shows a notice with the new version, your version and a link to what changed,
and a Not now button that hides it until a newer version comes out. The notice never installs
anything: to update, run the new installer or `gm-scriptorium update`. The check runs once a day
after a check that worked; after one that failed it runs again at the next start or a day later,
and once when you change the channel. The Updates card at the bottom of the Overview has the off
switch and the choice between Stable and Beta. Both are saved under `[update]` in `config.toml`
(`check` and `channel`). The command `update` is separate: it still takes `--pre` and does not
follow the channel.

Versions of GM-Scriptorium before 0.5.0 fetch releases through the GitHub CLI (`gh`) and need it
signed in. They still do, until they have updated once.

## Building from source

Requires Node.js 22 or later.

```
npm install
npm run package
```

Builds **both** targets, `gm-scriptorium-win-x64.exe` and `gm-scriptorium-linux-x64`, into
`dist/v<version>/`, cross-compiled from Linux via
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg), along with one combined `SHA256SUMS` and the
bundled `THIRD-PARTY-NOTICES.txt`. Building needs network access beyond the initial `npm install`
too: the first time you package for a target it doesn't already have a cached runtime for,
`@yao-pkg/pkg` downloads a prebuilt Node runtime for that target.

To run straight from source without building an executable:

```
node bin/scriptorium.js <command>
```

Run this way the program is called `scriptorium` in a few places, and the downloaded binary is
called `gm-scriptorium`. They are the same program; every example in these docs uses the binary's
name.
