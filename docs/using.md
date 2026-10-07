# Using GM-Scriptorium

This page is for a GM who has not used GM-Scriptorium before. It says what a vault is, the least a
folder needs before the tool will build it, and what each command does.

## What you need

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
`examples/the-long-lease`. The [sample guide](../examples/README.md) takes you through it step by step.

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
Read-only validation: frontmatter, links, required relationships, and the leak checks (see
[Leak checks](#leak-checks)). Never writes anything. `check` also warns when a relationship uses a
word that isn't in your vault's relationship list (`_meta/relationship-types.md`), such as
`allied` instead of `allied_with`. The site still shows it, but features like a faction's member
list only recognise the listed words, so pick the closest listed word and store each relationship
once, from one end. If a session note links to a separate Wrap-Up note for players, the site
publishes the Wrap-Up as that session's recap and hides the session note's own text. `check` warns
when a published Wrap-Up is linked to a session note that won't publish.

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
you turn on remote access (next command).

If no campaign is registered yet, `gm-scriptorium serve --admin` starts browser setup instead of
stopping with an error. It asks the same five questions as `init` (name, vault, output folder, site
title and theme), checks each answer with the same rules, and shows the rule's own message when it
refuses one. Nothing is written until its review screen, which creates the same pack files and
registers the same campaign as `gm-scriptorium init --yes`. It then builds a first preview into the
panel's own preview folder and opens the panel on your campaign without restarting. Setup listens on
this computer only, whatever your remote access settings say. A vault on a network share is allowed,
with a warning to commit to git first. On Linux, a browser installed as a snap cannot always read the
hidden config folder, so use the link the command prints.

```
gm-scriptorium remote show
```
Opt-in access to the admin panel from another device, for a GM who runs GM-Scriptorium on a home
server or a VM: behind a reverse proxy, through `tailscale serve`, or through an SSH tunnel. Set it
up with `remote set`, `remote password`, `remote signout-all` and `remote off`. Behind a reverse
proxy or `tailscale serve`, the panel needs HTTPS (from the proxy or Tailscale) and a password.
Through an SSH tunnel it needs neither, because SSH has already authenticated and encrypted the
connection. See [Remote access](remote-access.md).

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
Self-updates from the latest release. See [Updating](install.md#updating), it needs one extra tool.

That's the full command surface: `init`, `check`, `build`, `serve` (with a `--admin` mode),
`status`, `config`, `remote`, `update`. Run `gm-scriptorium --help` for the full flag list on each.

## Leak checks

Everything a GM writes in a campaign vault, notes on what's really behind a mystery, secret NPC
motives, stat blocks that would spoil a fight, is not meant for players. The leak checks are how
GM-Scriptorium keeps those notes off the site.

- `check` runs read-only leak checks (L1 through L5, five layers that each look for GM-only names
  and notes in a different place; see [ADR 0009](decisions/0009-output-leak-scan.md)) over the
  vault itself, including a scan of any already-built site for withheld names showing up in
  derived views: relationship-graph labels, aggregate index cards, recency excerpts, the search
  index.
- `build` runs those checks again against the freshly-built site before it swaps anything into
  place, and refuses to publish (exit code 2, nothing written) if it finds a leak, unless you pass
  `--force`.
- Builds are atomic: a failed or interrupted build never damages the site you already had live.
