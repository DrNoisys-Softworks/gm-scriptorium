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
Start a new campaign from nothing: this makes a vault in an empty or new folder and registers it, and `--system` is never guessed (use `--system none` for no particular system). See [Start a new campaign](how-to/start-a-new-campaign.md).

```
gm-scriptorium init
```
Interactive first-run setup: point it at your vault, name the campaign and pick a theme. It only adds files under `_meta/scriptorium/` and never overwrites one; see [Start a new campaign](how-to/start-a-new-campaign.md).

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
Opens the local GM admin panel instead: a small web page, on this computer only unless you turn on remote access (next command), with a live preview of the player site inside it. From it you can change the theme, images, vocabulary, title and tagline, run the checks, edit `_meta/vault-config.md` and switch campaigns; see [Change how your site looks and the words it uses](how-to/change-the-look-and-vocabulary.md).

If no campaign is registered yet, `gm-scriptorium serve --admin` starts browser setup instead of stopping with an error. It asks the same questions as `init`; the steps are in [Start a new campaign](how-to/start-a-new-campaign.md).

The vault and output questions have a Browse button, and the output question has New folder; see [Browse and New folder](how-to/start-a-new-campaign.md#browse-and-new-folder).

With more than one campaign registered, the campaign name at the top of the panel opens a list, and choosing another campaign switches the whole panel to it. The Campaigns screen (under Setup) sets the default and removes a campaign from the list; see [Add another campaign, and switch between them](how-to/add-another-campaign.md).

To add another campaign, press Add a campaign on the Campaigns screen, or in the list at the top of the panel. It asks the same questions as first-run setup; see [Add a campaign](how-to/add-another-campaign.md#add-a-campaign).

```
gm-scriptorium remote show
```
Opt-in access to the admin panel from another device, for a GM who runs GM-Scriptorium on a home
server or a VM: behind a reverse proxy, through `tailscale serve`, or through an SSH tunnel. Set it
up with `remote set`, `remote account`, `remote signout-all` and `remote off`. Behind a reverse
proxy or `tailscale serve`, the panel needs HTTPS (from the proxy or Tailscale) and a sign-in: a username and a
password, made with `remote account add <name>`.
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
Self-updates from the latest release. It needs an internet connection and nothing else; see [Updating](install.md#updating).

That's the full command surface: `init`, `check`, `build`, `serve` (with a `--admin` mode),
`status`, `config`, `remote`, `desktop`, `update`. Run `gm-scriptorium --help` for the full flag list on each.

## Keeping the admin panel running on Linux

This is for a GM who starts `gm-scriptorium serve --admin` over SSH or in a terminal and wants it to
keep running after the terminal closes. Closing the terminal sends the program a hangup, and the
panel stops. `nohup` alone does not prevent that: the program can't detect that it was started under
`nohup`, because Node resets the ignore that `nohup` sets before any of its code runs. Use one of
these instead:

```
setsid gm-scriptorium serve --admin > ~/gm-scriptorium.log 2>&1 &
```
`setsid` starts the panel in its own session, so a closed terminal has nothing to hang up.

```
tmux new -d -s gm-scriptorium 'gm-scriptorium serve --admin'
```
`tmux` keeps the panel running inside a session you can reattach to with `tmux attach -t gm-scriptorium`.

```
systemd-run --user --unit=gm-scriptorium gm-scriptorium serve --admin
```
A systemd user service runs apart from your terminal. Stop it with `systemctl --user stop gm-scriptorium`.
To keep it running when you are logged out, run `loginctl enable-linger` once.

## Leak checks

Everything a GM writes in a campaign vault, notes on what's really behind a mystery, secret NPC
motives, stat blocks that would spoil a fight, is not meant for players. The leak checks are how
GM-Scriptorium keeps those notes off the site.

- `check` runs read-only leak checks (L1 through L6, six layers that each look for GM-only names
  and notes in a different place, the sixth being Obsidian `%%` comments; see
  [ADR 0009](decisions/0009-output-leak-scan.md) and
  [ADR 0044](decisions/0044-obsidian-comments-withheld.md)) over the
  vault itself, including a scan of any already-built site for withheld names showing up in
  derived views: relationship-graph labels, aggregate index cards, recency excerpts, the search
  index.
- `build` runs those checks again against the freshly-built site before it swaps anything into
  place, and refuses to publish (exit code 2, nothing written) if it finds a leak. No flag overrides
  that. `--force-check` builds despite errors the check found, and `--force-out` builds into the
  site config's own output folder; neither one lets a leak through.
- Builds are atomic: a failed or interrupted build never damages the site you already had live.

For how a build decides what players see, and what these checks cannot see, read
[How GM-Scriptorium decides what players see](explanation/what-players-see.md).
