# Install, update and build from source

This page is for a GM who wants to get GM-Scriptorium running, keep it up to date, or build it
themselves.

## Install

1. Download the latest release from the
   [Releases page](https://github.com/DrNoisys-Softworks/gm-scriptorium/releases). The first
   public release is an unsigned prerelease. You can also build from source (see below).
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

**About the Windows warning:** signed releases carry a valid digital signature on the Windows
executable. The certificate is new, though, and Windows SmartScreen trusts a certificate more as
more people run programs signed with it. Until that reputation builds, SmartScreen may still say
something like "Windows protected your PC" the first time you run it. If it does, click **More
info**, then **Run anyway**. That is expected for a new certificate, not a sign anything's wrong.

To check a signature, right-click the executable, choose **Properties**, and open the **Digital
Signatures** tab. You can also run this in PowerShell and look for `Valid`:

```
Get-AuthenticodeSignature .\gm-scriptorium.exe | Select-Object Status
```

The `SHA256SUMS` check above still applies and is worth doing. A release whose notes say it is
unsigned will show the older warning instead, and you click through it the same way. If Smart App
Control is on, it may block an unsigned executable outright.

## Updating

```
gm-scriptorium update
```
Today, this requires the [GitHub CLI](https://cli.github.com) (`gh`) installed and signed in
(`gh auth login`), because `update` fetches the release through `gh` rather than talking to the
GitHub API directly. If `gh` isn't found, or is found but not authenticated, `update` fails with an
explanation rather than doing nothing silently. As an alternative to signing in with `gh`, you can
set `SCRIPTORIUM_GITHUB_TOKEN` to a fine-grained GitHub PAT with `Contents: Read` on this repo.

If you'd rather not install `gh` at all, download the new release manually from the Releases page
and replace the executable yourself, that always works regardless.

Removing the `gh` dependency is planned for later, but not built yet.

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
