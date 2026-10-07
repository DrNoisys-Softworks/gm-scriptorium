# Install, update and build from source

This page is for a GM who wants to get GM-Scriptorium running, keep it up to date, or build it
themselves.

## Install

1. Download the latest release from the
   [Releases page](https://github.com/DrNoisys-Softworks/gm-scriptorium/releases). There is no
   public release yet. Until the first one is out, build from source (see below).
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

**About the Windows warning:** the executable isn't code-signed yet, so Windows SmartScreen will
very likely say something like "Windows protected your PC" the first time you run it. Click **More
info**, then **Run anyway**. This is expected for an unsigned binary, not a sign anything's wrong.
Until releases are code-signed, this warning will keep appearing; it's planned, with no date set
yet. If Smart App Control is on, it may block an unsigned executable outright.

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
