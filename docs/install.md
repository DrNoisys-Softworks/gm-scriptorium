# Install, update and build from source

This page is for a GM who wants to get GM-Scriptorium running, keep it up to date, or build it
themselves.

## Install

1. Download the latest release from the
   [Releases page](https://github.com/DrNoisys-Softworks/gm-scriptorium/releases). Releases
   before 1.0 are unsigned. You can also build from source (see below).
2. Grab the binary for your platform (`gm-scriptorium-win-x64.exe` or `gm-scriptorium-linux-x64`)
   plus `SHA256SUMS` from the same release.
3. Verify the download before running it.

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
4. Rename the downloaded binary to `gm-scriptorium.exe` (Windows) or `gm-scriptorium` (Linux).
5. There's no installer yet, it's a single portable executable. Put it wherever you keep tools and
   run it from there. (An installer is planned but not built.)

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

Older versions of GM-Scriptorium (before this change) fetched releases through the GitHub CLI
(`gh`) and needed it signed in. They still do, until they have updated once.

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
