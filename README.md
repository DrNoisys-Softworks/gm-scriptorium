# GM-Scriptorium

A compiled command-line tool that turns your Obsidian-style tabletop campaign vault into a
player-safe website, on top of the [gm-apprentice](https://github.com/AntTheLimey/gm-apprentice)
generator.

## Why

Everything a GM writes in a campaign vault, notes on what's really behind a mystery, secret NPC
motives, stat blocks that would spoil a fight, is not meant for players. GM-Scriptorium's whole
job is turning that vault into a site players *can* see without your GM notes leaking into it.

- `check` runs read-only leak checks (L1 through L5, five layers that each look for GM-only names and notes in a different place; see [ADR 0009](docs/decisions/0009-output-leak-scan.md)) over the vault itself, including a scan of any
  already-built site for withheld names showing up in derived views: relationship-graph labels,
  aggregate index cards, recency excerpts, the search index.
- `build` runs those checks again against the freshly-built site before it swaps anything into
  place, and refuses to publish (exit code 2, nothing written) if it finds a leak, unless you pass
  `--force`.
- Builds are atomic: a failed or interrupted build never damages the site you already had live.

Your players never see your GM notes. That's the promise, and the leak checks are how it's kept
rather than just claimed.

## Install

1. Download the latest release from the
   [Releases page](https://github.com/DrNoisys-Softworks/gm-scriptorium/releases). The first
   public release is being prepared; until then, build from source (see below).
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

## What you need

This section is for a GM who has not used GM-Scriptorium before. It says what a vault is and the least a folder needs before the tool will build it.

A **vault** is the folder of markdown pages you keep for one campaign, laid out the way the
[gm-apprentice](https://github.com/AntTheLimey/gm-apprentice) project lays them out. It opens in
Obsidian like any other folder of notes. GM-Scriptorium does not create vaults. It reads one and
builds a player-safe site from it. To make your own, see the gm-apprentice project.

The least a folder needs:

1. `_meta/vault-config.md`, the vault's settings page. Without it, the tool says the folder is not
   a gm-apprentice vault.
2. `_meta/publish-manifest.md`, the list of pages players may see. In the default player mode, a
   page that is not ticked in this list stays off the site. Without the file, `check` stops with
   an error before anything is built.
3. Pages that start with a `type:` line in their frontmatter, kept in folders the site config
   knows about. `init` sets that up from the folders it finds, and `build` warns you about any
   folder it had to leave out.

To see a complete working vault, open `examples/the-long-lease` in this repository. It has all of
the above, and it is the quickest way to learn the layout.

## Quick start

To see the tool work before you point it at your own vault, build the sample campaign in
`examples/the-long-lease`. The [sample guide](examples/README.md) takes you through it step by step.

```
gm-scriptorium init
```
Interactive first-run setup: point it at your vault, give the campaign a name, pick a theme, and it
scaffolds `_meta/scriptorium/` inside your vault. It never touches anything else in the vault, and
never overwrites an existing file. The theme it suggests is `gloam`, a dark theme that ships its
own fonts.

```
gm-scriptorium check my-campaign
```
Read-only validation: frontmatter, links, required relationships, and the leak checks above. Never
writes anything. `check` also warns when a relationship uses a word that isn't in your vault's
relationship list (`_meta/relationship-types.md`), such as `allied` instead of `allied_with`. The
site still shows it, but features like a faction's member list only recognise the listed words, so
pick the closest listed word and store each relationship once, from one end. If a session note
links to a separate Wrap-Up note for players, the site publishes the Wrap-Up as that session's
recap and hides the session note's own text. `check` warns when a published Wrap-Up is linked to a
session note that won't publish.

```
gm-scriptorium build my-campaign
```
Runs `check` first (refuses on any error) and builds the player-facing site.

```
gm-scriptorium serve my-campaign
```
Serves the built site locally so you can preview it before it goes anywhere. It listens on
`127.0.0.1` by default, on purpose: a freshly built site is player-facing but not necessarily
player-safe until you've looked at it. `--host` widens it and prints a warning.

Stop it with Ctrl-C, or with SIGTERM from a service manager: it closes its ports and exits with
code 0 either way. Add `--json` (to `serve` or `serve --admin`) for scripts and supervisors: it
prints one JSON object per line, a `ready` line with the URL and port, a final `stopped` line
when it shuts down, and an `error` line if it cannot start. On Windows, Ctrl-C and Ctrl-Break
stop it cleanly, but ending the process from Task Manager cannot be caught.

```
gm-scriptorium serve my-campaign --admin
```
Opens the local GM admin panel instead: a small web page, on this computer only, for your campaign
pack (theme, image slots and vocabulary) and your campaign's tagline, with a live preview of the
player site inside the panel. The tagline is saved into your vault's `_meta/vault-config.md`, and
the panel keeps a copy of that file outside the vault before every save. Editing more of
`_meta/vault-config.md` from the panel is planned. The panel answers only on this computer unless
you turn remote access on (next command).

```
gm-scriptorium remote show
```
Opt-in access to the admin panel from another device, for a GM who runs GM-Scriptorium on a home
server or a VM: behind a reverse proxy, through `tailscale serve`, or through an SSH tunnel. It is
set up with `remote set`, `remote password`, `remote signout-all` and `remote off`, and the panel
then needs HTTPS and a password. See [Remote access](docs/remote-access.md).

```
gm-scriptorium status my-campaign
```
One-line health check: campaign, vault reachability, last/next session, file and link counts.

```
gm-scriptorium config list
```
Manage registered campaigns (`add`, `remove`, `set-default`, `path`, `edit`). `add` needs both
`--vault` and `--out`. Never touches vault content.

```
gm-scriptorium update
```
Self-updates from the latest release. See [Updating](#updating) below, it needs one extra tool.

That's the full command surface: `init`, `check`, `build`, `serve` (with a `--admin` mode),
`status`, `config`, `remote`, `update`. Run `gm-scriptorium --help` for the full flag list on each.

## How this relates to gm-apprentice

GM-Scriptorium is not a fork of, or a replacement for,
[gm-apprentice](https://github.com/AntTheLimey/gm-apprentice), it's a wrapper around it. All credit
for the actual vault-to-site generation logic goes to that project and its author. GM-Scriptorium
vendors one pinned copy of the generator (currently upstream tag `publish-v1.14.0`, package
version `1.14.0`), verified file-by-file against a committed manifest, and adds on top of it:

- a compiled, self-contained CLI so you don't need Node or npm installed to run it;
- the leak checks described above;
- themes and a per-campaign vocabulary pack;
- the local GM admin panel;
- self-updating.

Pinning a specific generator version means an upstream change doesn't reach your build until
someone here deliberately bumps the pin and re-verifies it, so your site's output doesn't shift
under you between two runs of the same GM-Scriptorium version.

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

## Privacy

- **The admin panel only listens on this computer, unless you turn on remote access.** `serve
  --admin` binds `127.0.0.1` and refuses `--host`; reaching it from another device is a separate,
  saved, opt-in setting (see [Remote access](docs/remote-access.md)). Each launch creates a new random token and prints it as a link; after that the token
  lives in a cookie that page scripts can't read. The panel checks every request's Host header, and
  the Origin of every change, before it checks the token.
- **Font requests depend on the theme and your vault config.** Campaigns set up with `init` use the
  built-in `gloam` theme, which ships its own font files inside the built site, so the theme itself
  asks no font service for anything. The `haze` theme does the same. The `plain` theme (used when a pack names no theme) ships no
  stylesheet and fetches nothing. Separately from the theme, the site generator adds its
  own Google Fonts request if your vault config names a specific font family under
  `publish.theme.fonts` (the default, `system-ui`, adds none), unless the vault config also sets
  the generator's font `source` to `local` (font files you supply from the vault) or `self-host`.
  GM-Scriptorium never downloads fonts while it builds, so `self-host` only uses fonts already
  cached in your vault, and any font that isn't cached falls back to a system font. To keep players
  from contacting any third party, use `gloam` or `plain`, and leave the vault's fonts at a generic
  family.
- **Live character sheets need a backend GM-Scriptorium does not have.** The generator can save player state (hit points, spell slots, rests) to a site backend when `publish.live_stats` is on and a KV store is wired. GM-Scriptorium builds and serves static pages only, so the switch stays off, builds emit no script that calls an API unless both are set, and if you do turn it on without a backend the generator withholds the live sheet and says so. The scripts it ships call only the site's own `/api/` paths.
- GM-Scriptorium itself has no telemetry and no analytics. The only network call anywhere in the
  tool is `update`, and it only ever fetches its own release assets, never anything about your
  campaign.

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

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), then read
[`docs/COLLABORATING.md`](docs/COLLABORATING.md), which is the detailed map of exactly where this
project depends on the upstream generator's behaviour and the ground rules for changes near that
boundary. [`docs/DEVELOPING.md`](docs/DEVELOPING.md) is the developer guide: what never to edit,
the checks a change must pass, and how releases are made. If you work with an AI coding assistant, point it at [`AGENTS.md`](AGENTS.md).

## Licence

MIT. See [`LICENSE`](LICENSE) for the full text.

## Docs

Full documentation lives in [`docs/README.md`](docs/README.md): using the tool, contributing,
design decisions, licensing, and where issues live.
