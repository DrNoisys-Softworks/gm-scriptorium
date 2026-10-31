# The command line

This page is for someone comfortable editing a text file who wants to run GM-Scriptorium from a
terminal or a script. It lists every command, the flags they accept and the subcommands of
`config`, `remote` and `desktop`, so you can look up what one does without trying it.

## How a command is written

A command looks like this:

```text
gm-scriptorium <command> [campaign] [flags]
```

Put a value after a space, never after an equals sign. `--port=8081` is refused with exit 1 and
the message "write the value after a space". A flag the command does not accept also exits 1, with
a suggestion when there is a close match, so a typo never quietly does something else.

For help, run `gm-scriptorium <command> --help`. For one `remote` subcommand, run
`gm-scriptorium remote <subcommand> --help`. Every help text ends with the exit codes that command
can return. The codes themselves are on [the exit codes page](exit-codes.md).

## With no command

*Since 0.5.0.*

Run `gm-scriptorium` on its own, with no command and no flag other than `--config <path>`, in a
terminal, and it opens the admin panel in your browser. If the output is piped or redirected, or
any other flag is given (apart from `--version` and `--notices`, which are handled first), it
prints the list of commands and exits 0 instead.

What happens in the terminal depends on the copy you run.

- **An installed copy on Windows** (the one Setup installs, with `gm-scriptorium-tray.exe` beside
  it), when you give no `--config`. The command asks the background app to start, or reuses the
  one already running. It prints a short status line, opens your browser, and returns with exit 0.
  If the app is running but its panel could not start, it points you at the log and exits 1.
  If it takes longer than 15 seconds to start, it says to look for the icon in the system tray
  and exits 1.
- **Any other copy**, such as a portable copy, Linux, or a Windows run with `--config`. The
  command runs the panel in the terminal, prints the panel's address and opens your browser. A
  sign-in link is printed only if the browser can't be opened. Stop it with Ctrl+C. If the background app could not be started at all, an installed copy falls back to
  this too.

Versions before 0.5.0 do not open the panel: with no settings file yet, the command offers to run `gm-scriptorium init` for you and waits for you to press Enter before the window closes, and otherwise it shows the list of commands.

## Commands

<!-- BEGIN GENERATED cli-commands: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Command | What it does | Exit codes |
|---|---|---|
| `init` | Registers a vault and sets up its publish settings. *Since 0.5.0.* It can also create a new vault first. It only adds files under `_meta/scriptorium/` and never touches the rest of the vault. *Since 0.6.0.* The one exception is a vault whose settings gm-apprentice has moved to `_meta/vault-config.yaml`: there init also sets the site title, the folder map and the hide lists in that file, asks first, keeps a copy of the file outside the vault, and changes nothing else: hide lists only gain entries, and a title or folder map the file already sets is kept. | `0`, `1`, `3` |
| `check` | Reads the vault and reports anything that would leak GM-only material or break the site. It changes nothing. | `0`, `1`, `2`, `3` |
| `carry` | *Since 0.6.0.* For a vault whose settings gm-apprentice has moved to `_meta/vault-config.yaml`: moves the settings your pack still holds into that file. It shows what it will move, asks first, and keeps a copy of both files outside the vault. The hide lists, the site title, the folder map and the site folder's settings (such as `host`) move. A title or folder map the vault already sets is kept as it is, and the output says so. Anything else, such as `footer`, `searchEnabled` or a changed `attachmentsDir`, stays in the pack and is named, for you to set in the vault's settings. `check` tells you when to run it. | `0`, `1`, `3` |
| `build` | Checks the vault, then writes the player-facing website to the output folder. If the check finds errors it refuses and writes nothing. | `0`, `1`, `2`, `3` |
| `serve` | Serves the built site on this computer so you can look at it, or with `--admin` opens the admin panel. | `0`, `1`, `3` |
| `status` | Shows where a campaign stands: whether the vault is reachable, when the site was last built, the last and next session, file counts and the latest check result. It changes nothing. | `0`, `1`, `3` |
| `config` | Manages the list of campaigns GM-Scriptorium knows about. It never needs the vault to be reachable. | `0`, `1`, `3` |
| `update` | Downloads the newest release from GitHub and replaces this program with it. *Since 0.5.0.* On an installed copy on Windows it replaces the tray helper beside it too, and nothing is replaced if either download fails. If the tray app is running, quit it and start it again afterwards. | `0`, `1`, `4` |
| `remote` | Changes how the admin panel can be reached from other devices. *Since 0.5.0.* It also manages the accounts that can sign in. See [Remote access](../remote-access.md). | `0`, `1`, `3` |
| `desktop` | *Since 0.5.0.* Saves the settings of the Windows desktop app: its two ports, and whether remote access may start at sign-in. The Windows tray app also runs `desktop run`, which is not meant to be typed. | `0`, `1`, `3` |
<!-- END GENERATED cli-commands -->

## Flags most commands accept

Most commands accept these flags. A command that has no use for one accepts it and ignores it,
with two exceptions. `init` refuses `--campaign`, `--site-config` and `--json`. And `serve --admin`,
and the subcommands of `remote` and `desktop`, accept only the flags listed for them in the
[subcommands table](#subcommands).

<!-- BEGIN GENERATED cli-global-flags: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Flag | Takes a value | What it does |
|---|---|---|
| `--help` | no | Prints the commands and the global flags. After a command, as in `serve --help`, it prints that command's own help and its exit codes. |
| `--version` | no | Prints the version of this program and the licence notices line, then stops. After `update` it takes a release tag instead (see the table below). |
| `--notices` | no | Prints the third-party licence notices, then stops. |
| `--config` | yes | Uses this settings file instead of the default one. See [the settings file](config-toml.md). |
| `--json` | no | Prints machine-readable JSON instead of text. Only `check`, `build`, `status` and `serve` read it; the other commands ignore it, and `init` refuses it. With `serve` it prints one JSON line for each event. |
| `--quiet` | no | Does nothing. Accepted only so that older scripts that pass it keep working. Leave it out of new scripts. |
| `--no-color` | no | Output is always plain text, so this changes nothing. |
| `--campaign` | yes | Picks a registered campaign. It is the same as naming the campaign after the command. `check`, `build`, `status` and `serve` read it; `init` refuses it. |
| `--vault` | yes | Uses this vault folder for this run only. Nothing is saved. `check`, `build`, `status` and `serve` read it. `init` and `config add` take it as the vault to register. |
| `--out` | yes | Uses this output folder for this run only. Nothing is saved. `check`, `build`, `status` and `serve` read it. `init` and `config add` take it as the output folder to register. |
| `--site-config` | yes | Uses this site config for this run only. Nothing is saved. `check`, `build` and `status` read it; `serve` never reads the site config. `config add` can register it with a campaign. `init` refuses it. |
<!-- END GENERATED cli-global-flags -->

`--vault`, `--out` and `--site-config` change a path for one run and never save it. To change a
path for good, use `config add` or `config edit`. The settings are on
[the settings file page](config-toml.md), and the variables the program reads are on
[the environment variables page](environment-variables.md).

## Flags for one command

<!-- BEGIN GENERATED cli-flags: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Flag | Takes a value | What it does |
|---|---|---|
| `init --name` | yes | The name to register the campaign under. |
| `init --title` | yes | The title of the site. |
| `init --theme` | yes | The theme for the site. An unknown theme exits 1 and lists the valid ones. |
| `init --yes` | no | Asks no questions and uses the flags you gave. |
| `init --new-vault` | yes | *Since 0.5.0.* Creates a new vault in this folder first, which must not exist yet or must be empty. Nothing is overwritten or removed. Use it with `--system`. It cannot be combined with `--vault`. |
| `init --system` | yes | *Since 0.5.0.* The game system for the new vault, or `none` for no particular system. It is never guessed, and it only works with `--new-vault`. |
| `carry --yes` | no | *Since 0.6.0.* Asks no question and carries what the plan shows. |
| `check --graph` | no | Also runs the optional relationship graph checks. |
| `build --force-out` | no | *Since 0.5.0.* Builds into the site config's own `outputDir`. |
| `build --force-check` | no | *Since 0.5.0.* Builds even though the check found errors. The output-leak scan still refuses a leak. *Since 0.6.0.* On a vault whose settings moved to `_meta/vault-config.yaml`, it does not build past a hide-list entry or a folder map that only the campaign pack holds: the build exits 3 until they are carried. |
| `build --no-check` | no | Skips the check step. *Since 0.6.0.* On a vault whose settings moved to `_meta/vault-config.yaml`, the build still refuses, with exit 3, while a hide-list entry or a folder map is only in the campaign pack. |
| `serve --build` | no | Builds the site first. |
| `serve --port` | yes | The port to listen on, 1 to 65535. Plain `serve` also accepts 0 for any free port, and uses the campaign's `serve_port` or 8080 when you give none. With `--admin`, leave it out and a free port is chosen for you. |
| `serve --host` | yes | Listens on another address. This exposes the site beyond this computer. `serve --admin` refuses it. |
| `serve --admin` | no | Opens the admin panel instead of serving the built site, and prints a one-time link. This mode accepts only the flags listed for `serve --admin` in the subcommands table. |
| `serve --preview-port` | yes | With `--admin`, the port for the preview, 1 to 65535. Remote access uses its saved ports. |
| `update --check` | no | Only says whether a newer release exists. |
| `update --pre` | no | Includes pre-releases. |
| `update --version` | yes | Installs that exact release, as in `update --version <tag>`. Everywhere else `--version` prints the version. |
| `remote --mode` | yes | For `remote set`: `local`, `ssh`, `tailscale` or `proxy`. Changing it drops the old addresses unless you give new ones. |
| `remote --admin-url` | yes | For `remote set`: the https address the admin panel is reached at. |
| `remote --preview-url` | yes | For `remote set`: the https address the preview is reached at. |
| `remote --bind` | yes | For `remote set`: the IP address the panel listens on, for the `proxy` mode. |
| `remote --trusted-proxy` | yes | For `remote set`: the address of your reverse proxy. Give several as a comma-separated list. |
| `remote --port` | yes | For `remote set`: the port for the admin panel. |
| `remote --preview-port` | yes | For `remote set`: the port for the preview. |
| `remote --account` | yes | *Since 0.5.0.* For `remote signout-all`: signs out only the devices signed in as this account. |
| `desktop --port` | yes | *Since 0.5.0.* For `desktop set`: the port the Windows desktop app gives its panel. See `[desktop]` in [the settings file](config-toml.md). |
| `desktop --preview-port` | yes | *Since 0.5.0.* For `desktop set`: the port the Windows desktop app gives its preview. See `[desktop]` in [the settings file](config-toml.md). |
| `desktop --remote-at-signin` | yes | *Since 0.5.0.* For `desktop set`: `on` or `off`, whether remote access may start when you sign in to Windows on this PC. `on` asks first at a terminal, and the default is No. Give it on its own, without `--port` or `--preview-port`. See `remote_at_signin` in [the settings file](config-toml.md). |
| `desktop --yes` | no | *Since 0.5.0.* For `desktop set --remote-at-signin on`: answers yes to the question, for a script. With no terminal and without it, `on` is refused and nothing changes. |
| `desktop --background` | no | *Since 0.5.0.* For `desktop run`: the quiet start at sign-in, with no browser tab. `desktop set` refuses it. |
<!-- END GENERATED cli-flags -->

*Since 0.5.0.* Under `build`: `--force` on its own was split in two and is refused with exit 1. Use
`--force-check` or `--force-out`. Neither one overrides the output-leak scan. The reasons are in
[ADR 0055](../decisions/0055-force-split.md), section 1, "The decision".

`remote` and `desktop` accept the flags above at the command line, but each subcommand then
accepts only the flags listed for it in the next table. For example `remote show --mode` exits 1.

## Subcommands

`config`, `remote` and `desktop` take a subcommand after the command name. `serve --admin` is not a
subcommand but a mode, and it is listed here because it also accepts only the flags in its row.

For the `config` rows, the flags column lists the flags that subcommand reads. `config` accepts
the other global flags too, and ignores them.

<!-- BEGIN GENERATED cli-subcommands: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Subcommand | Flags it accepts | What it does |
|---|---|---|
| `config list` | `--config` | Shows every registered campaign, with its vault and output folder and whether the vault is reachable. |
| `config add` | `--config`, `--vault`, `--out`, `--site-config` | Registers a campaign, or replaces one of the same name: `config add <name> --vault <path> --out <path>`. It needs `--vault`, and needs `--out` unless the campaign already has an output folder. |
| `config remove` | `--config` | Forgets a campaign: `config remove <name>`. Nothing on disk is deleted. |
| `config set-default` | `--config` | Sets the campaign used when you name none: `config set-default <name>`. |
| `config path` | `--config` | Prints where the settings file lives. |
| `config edit` | `--config` | Opens the settings file in the editor named by `EDITOR` or `VISUAL`. With neither set, it prints the path instead. |
| `remote show` | `--config` | Prints the remote-access settings for this computer: the mode, the addresses, where it listens and whether it is ready to start. *Since 0.5.0.* It also lists which accounts exist. It never prints a secret. |
| `remote set` | `--config`, `--mode`, `--admin-url`, `--preview-url`, `--bind`, `--trusted-proxy`, `--port`, `--preview-port` | Saves remote-access settings. Only https addresses are accepted, and every value is checked before anything is written. It takes effect the next time the admin panel starts. *Since 0.5.0.* On a Windows copy with the tray app, switching to a different remote mode turns remote access at sign-in off and says where to turn it back on. It never asks. |
| `remote account add` | `--config` | *Since 0.5.0.* Adds an account: `remote account add <name>`. Names are 1 to 32 letters, digits, dots, hyphens or underscores. The password is asked for with nothing shown on screen, and must be at least 12 characters. There can be at most 8 accounts. |
| `remote account change` | `--config` | *Since 0.5.0.* Changes an account's password: `remote account change <name>`. It asks for the current password first, and signs that account out on every device. |
| `remote account reset` | `--config` | *Since 0.5.0.* Sets a new password when the old one is forgotten: `remote account reset <name>`. It needs no current password, and signs that account out on every device. |
| `remote account remove` | `--config` | *Since 0.5.0.* Deletes an account: `remote account remove <name>`. It signs that account out on every device. |
| `remote account rename` | `--config` | *Since 0.5.0.* Gives an account a new name: `remote account rename <old> <new>`. It signs that account out on every device. |
| `remote account list` | `--config` | *Since 0.5.0.* Shows the account names and dates. It never shows a secret. |
| `remote password` | `--config` | The earlier command, kept so existing notes still work. *Since 0.5.0.* It sets or changes the password of the account named `gm`, adding the account if it is not there, and signs every remote device out. Use `remote account` for other accounts. In versions before 0.5.0, which have no accounts, it sets the one remote-access password. |
| `remote signout-all` | `--config`, `--account` | Signs every remote device out at once. *Since 0.5.0.* With `--account` it signs out only the devices signed in as that account. A running panel notices straight away. |
| `remote off` | `--config` | Returns the mode to `local`, signs every device out and clears every account. *Since 0.5.0.* It also clears the sign-in answer for the Windows desktop app. |
| `desktop run` | `--config`, `--background` | *Since 0.5.0.* The hidden background program the Windows tray app starts: `desktop run --background`. It runs the panel on the desktop ports and talks to the tray app over its standard input and output, so it is not meant to be typed and refuses to run in a terminal or off Windows. With `--background` (the start at sign-in) it is quiet, and it uses this computer only unless you agreed to remote access at sign-in. |
| `desktop set` | `--config`, `--port`, `--preview-port`, `--remote-at-signin`, `--yes` | *Since 0.5.0.* Saves the two ports for the Windows desktop app: `desktop set --port 7500 --preview-port 7501`. Give at least one, and a port you leave out keeps its current value. They must be different whole numbers from 1 to 65535, and nothing is written until both are checked. It changes only the `[desktop]` part of the settings file. With `--remote-at-signin on` or `off` instead, it saves whether remote access may start when you sign in to Windows on this PC; `on` asks first at a terminal unless you add `--yes`. |
| `serve --admin` | `--admin`, `--campaign`, `--config`, `--vault`, `--port`, `--preview-port`, `--json` | Opens the admin panel on this computer only. Every other flag, such as `--host`, `--build`, `--out` or `--site-config`, is refused with exit 1. This is a mode of `serve` and not a subcommand; it is listed here because it narrows the flags the same way. |
<!-- END GENERATED cli-subcommands -->

Remote access is explained, with the steps, in [Remote access](../remote-access.md).

## Examples

Each of these is a complete command.

- `gm-scriptorium check lease`
- `gm-scriptorium build lease --no-check`
- `gm-scriptorium serve lease --build --port 8081`
- `gm-scriptorium serve lease --admin`
- `gm-scriptorium config add lease --vault ~/campaigns/lease --out ~/sites/lease`
- `gm-scriptorium status lease --json`
- `gm-scriptorium update --check`
- *Since 0.5.0.* `gm-scriptorium remote signout-all --account gm`
- *Since 0.5.0.* `gm-scriptorium desktop set --port 7500 --preview-port 7501`
