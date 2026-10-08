# Using GM-Scriptorium

This page is for a GM who has not used GM-Scriptorium before. It says what a vault is, the least a
folder needs before the tool will build it, and what each command does.

## What you need

A **vault** is the folder of markdown pages you keep for one campaign, laid out the way the
[gm-apprentice](https://github.com/AntTheLimey/gm-apprentice) project lays them out. It opens in
Obsidian like any other folder of notes. GM-Scriptorium reads a vault and builds a player-safe site
from it. You can follow the gm-apprentice project to make one by hand, or let GM-Scriptorium create
one for you: browser setup offers "Start a new campaign here", and `gm-scriptorium init --new-vault`
does the same from a terminal (see below). A vault made that way follows the gm-apprentice layout and
builds as soon as it exists.

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
gm-scriptorium
```
Run with no command in a terminal (or double-click the program on Windows) and it opens the admin
panel in your default browser, signed in. With no campaign registered yet, the panel starts with
setup (see below); otherwise it opens your campaign. The window it opens in says it is running, and
closing that window (or pressing Ctrl-C in it) stops the panel and tidies up after it. If the browser
did not open, press O in that window to open it again; if it still cannot be opened, the window prints
the panel link instead. If something goes wrong at the start, the window shows the message and waits
for Enter, so a double-clicked window does not close before you can read it. Opening the browser
leaves a small launcher file in a private folder next to your config for under a minute; it is
removed as soon as it has been used. On Linux, a browser installed as a snap cannot always read that
hidden folder, and the command does not notice; use `gm-scriptorium serve --admin` and its link there.
Running a command without a terminal (from a script, say) still prints the help.

```
gm-scriptorium init --new-vault ~/campaigns/lease --system none --name lease
```
Start a new campaign from nothing. It creates a vault in that folder, which must not exist yet or must
be empty (any parent folders that are missing are created too, and listed first), then sets up the
campaign pack and registers it. Pick your game system with `--system`, or `--system none`; it is never
guessed. It never overwrites or removes anything, and if it stops part-way it lists exactly what it
made. At a terminal, without `--vault` or `--new-vault`, `init` asks whether you already have a vault, and the questions follow from your answer. With piped input it does not ask, so scripts say `--new-vault`.

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
refuses one. Nothing is written until its review screen, apart from any folder you make with New folder, which creates the same pack files and
registers the same campaign as `gm-scriptorium init --yes`. It then builds a first preview into the
panel's own preview folder and opens the panel on your campaign without restarting. Setup listens on
this computer only, whatever your remote access settings say. A vault on a network share is allowed,
with a warning to commit to git first. On Linux, a browser installed as a snap cannot always read the
hidden config folder, so use the link the command prints.

The vault and output questions have a Browse button. It opens a list of folders under the field, starting at the deepest folder that already exists above what you typed. The list shows folders only, never files. A link or shortcut is marked and can't be opened there, so type its path instead. Choose this folder fills the field and runs the usual check. On the output question, New folder makes a folder inside the open one straight away, and it stays even if you cancel. This works from another device too, and the panel's audit log records it.

With more than one campaign registered, the campaign name at the top of the panel opens a list, and
choosing another campaign switches the whole panel to it, from this computer or from a remote
browser. If you have unsaved changes on the page, it asks before it switches. The Campaigns screen
(under Setup) lists each campaign with its vault and output folders, sets the one that opens by
default, and removes one from the list. Removing only takes it off GM-Scriptorium's list: the vault,
pack, output and backups stay where they are, and the campaign you are on cannot be removed. A
browser tab left open on the old campaign shows a banner and asks you to reload before it can change
anything. A panel started with `--vault` cannot switch.

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
