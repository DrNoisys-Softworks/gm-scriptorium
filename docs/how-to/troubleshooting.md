# Troubleshooting

This guide is for a GM who ran a GM-Scriptorium command, got a message instead of what they
wanted, and needs to know what it means and what to do. It lists the messages you are most likely
to meet, then the problems that come with no message at all.

A message is one plain line, printed when a command stops. The part that stays the same is shown
below. The rest names your campaign, your folder or a port. The exit code, which a script can read,
is explained on [Exit codes](../reference/exit-codes.md).

## Messages

Find the words that match your message in the first column.

| What you see | What it means | What to do |
|---|---|---|
| `no campaigns registered; run` | No campaign is saved in the settings file this command read. | Add one with `gm-scriptorium config add lease --vault <folder> --out <folder>`. If you expected campaigns, run `gm-scriptorium config path` and check it is the file you meant. |
| `no campaign named` | The name you gave is not in the settings file. The message lists the names that are. | Check the spelling, or run `gm-scriptorium config list` to see what is registered. |
| `no campaign specified and no default_campaign set` | You have several campaigns and did not say which one. | Name the campaign, as in `gm-scriptorium check lease`, or choose one for good with `gm-scriptorium config set-default lease`. |
| `config file not found` | The file you gave with `--config` does not exist. | Fix the path. To start a new settings file there, run `gm-scriptorium config add` with the same `--config`. |
| `config is not valid TOML` | The settings file has a typing slip, often from a hand edit. The message shows the line. | Open it with `gm-scriptorium config edit` and fix that line. [The settings file](../reference/config-toml.md) shows what each part looks like. |
| `configured vault path does not exist` | The vault folder is not where the settings file says. It may have moved, or its drive may not be connected. | Fix the path with `gm-scriptorium config add`, or connect the drive. On a new computer, see [Move to another computer](move-to-another-computer.md). |
| `it is not a gm-apprentice vault` | The folder exists but has no `_meta/vault-config.md`, so it is not a vault GM-Scriptorium can read. | Check you chose the vault folder and not one inside it. *Since 0.5.0.* To make a new vault, run `gm-scriptorium init --new-vault <folder> --system none --name lease`. |
| `keeps its settings in _meta/vault-config.yaml` | *Since 0.5.0.* An update of the gm-apprentice plugin moved this vault's settings into a new file, which this version of GM-Scriptorium can't read. It stops before reading or changing anything. If the message also names a leftover `vault-config.md`, gm-apprentice ignores that file. | Don't create, copy or edit a `vault-config.md` to get round this. Support comes in a later GM-Scriptorium release. To follow it, see [issue 171](https://github.com/DrNoisys-Softworks/gm-scriptorium/issues/171). |
| `has no vault configured` | The campaign is in the settings file without a vault folder. | Add the vault with `gm-scriptorium config add lease --vault <folder> --out <folder>`. |
| `has no site config` | The vault is registered, but nothing says how its site should look. A plain `config add` leaves it this way. | Run `gm-scriptorium init` to create the settings, or set `site_config` or `pack` on the campaign. |
| `has no output folder` | The campaign has nowhere to put the built site. | Pass `--out <folder>` for one run, or save one with `gm-scriptorium config add lease --vault <folder> --out <folder>`. |
| `refusing to build inside the vault` | The output folder is inside the vault, or holds it. The site must never be built among your notes. | Choose an output folder outside the vault. |
| `no build exists at` | You ran `serve` before the site was built. | Run `gm-scriptorium build lease`, or add `--build` to `serve`. |
| `is already in use on` | Another program, perhaps another copy of GM-Scriptorium, is using that port. | Stop it, or pick another port with `--port`, as in `gm-scriptorium serve lease --port 8081`. |
| `needs administrator rights` | Ports below 1024 are kept for administrators on this computer. | Use a port above 1024, such as 8081. |
| `names a profile that does not exist` | The `SCRIPTORIUM_PROFILE` environment variable names a profile the campaign does not have. | Fix the name, or unset the variable. |
| `two profiles are equally specific for this machine` | Two profiles match this computer equally well, so GM-Scriptorium will not guess. | Make one profile more specific, or set `SCRIPTORIUM_PROFILE` to the one you want. [Move to another computer](move-to-another-computer.md) explains profiles. |
| `unknown flag` | The command does not accept that flag. This includes writing a value after an equals sign. | Check the spelling. Write a value after a space, as in `--port 8081`. `gm-scriptorium <command> --help` lists the flags. |
| `unknown command:` | GM-Scriptorium does not have a command of that name. | Check the spelling against the list printed below the message. |
| `--force has been split` | *Since 0.5.0.* A bare `--force` is no longer accepted. | Use `--force-check` to build even though the check found errors, or `--force-out` to build into the site config's own output folder. Neither one overrides the output-leak scan. |
| `does not accept --host` | A flag cannot widen who reaches the admin panel. Remote access comes only from settings you have saved. | To reach it from another device, set up [Remote access](../remote-access.md). |
| `must be at least 12 characters` | A remote access password is too short. | Choose a longer one. |
| `remote access keeps its files beside the config` | The settings folder is inside a vault, and remote access never keeps its files there. | Keep the settings file outside every vault, in the default place or at a path you give with `--config`. |
| `ERROR rendering` | The site generator could not build one page while building. It is not a check, so it has no id. | Read the page it names. [Check messages](../reference/check-messages.md#lines-that-are-not-checks) explains. |

## The checks found a problem (exit code 2)

`check` and `build` end with exit code 2 when the checks find errors. A `build` that ends this way
refuses and writes nothing.

1. Run `gm-scriptorium check lease`.
2. Read each line that starts with `ERROR`. It gives a message id, the file and the line.
3. Look the id up on [Check messages](../reference/check-messages.md). It says what the check means and what to do.
4. Fix the note, then run `check` again until it reports 0 errors.

Warnings do not stop a build. A clean `check` does not mean nothing can leak, so read [What the
leak checks cannot see](../explanation/what-players-see.md#what-the-leak-checks-cannot-see).

## Other things that go wrong

### The browser did not open

*Since 0.5.0.* When you run `gm-scriptorium` on its own and it runs the panel in the terminal
(a portable copy, Linux, or a run with `--config`), press O in that window to open the browser
again. An installed Windows copy hands the job to its background app instead; see the last item below. If it still cannot be opened, the window prints the panel link instead. On Linux, a browser
installed as a snap cannot always read the file the command leaves for it, and the command does not
notice. Run `gm-scriptorium serve --admin` and use the link it prints. To open the panel, see
[open the admin panel](../using.md#quick-start).

### The panel answers "refused: host" or "refused: proto"

Over remote access, the panel answers only to the exact names you saved with `remote set`. Run
`gm-scriptorium remote show` and type the address it shows. If a reverse proxy sits in front, it
must pass the browser's own `Host` through unchanged. [Remote access](../remote-access.md) has
the settings for Caddy and nginx (sections 4 and 5), Tailscale (section 7) and an SSH tunnel
(section 8, where the local ports must match).

### I forgot every remote password

*Since 0.5.0.* From the computer that runs GM-Scriptorium, run `gm-scriptorium remote account reset <name>`. It
needs no old password. Or run `gm-scriptorium remote off`, then add an account again and set the
mode again. The one-time link printed when the panel starts on that computer still works either
way. [Other commands](../reference/remote-access.md#other-commands) has the steps.

### update cannot reach GitHub

*Since 0.5.0.* `update` talks only to GitHub, and it ignores proxy settings. When it cannot connect it says so in
one line, exits with code 4 and points at the Releases page. Download the new release from there
and replace the program yourself, or, coming in 0.5.0, run the new installer. Versions before 0.5.0 fetch releases through the GitHub CLI (`gh`) and need it signed in. [Updating](../install.md#updating)
has the details.

### Windows warnings

- **SmartScreen.** Windows may warn that the program is unsigned or from an unknown publisher.
  [Install, update and build from source](../install.md) explains the warning and how to check
  your download.
- **OneDrive.** *Since 0.5.0.* Setup tells you when a vault folder syncs with OneDrive. That works,
  but let OneDrive finish syncing before you open the vault on another computer.
- **A network share or a mapped drive.** *Since 0.5.0.* Setup says it cannot reach the folder within a few seconds.
  Check that the share is online, then check again. A command may say a mapped drive "may not be
  mapped in this session". A mapped drive belongs to one sign-in session, so a window started as administrator
  may not have it. Run the command from a normal window.
- **The panel folder's access list.** *Since 0.5.0.* On Windows, remote access needs the `panel` folder
  limited to your account, SYSTEM and Administrators. When that cannot be done, the message says
  "limited to your account, SYSTEM and Administrators, and that could not be done", gives the
  reason in brackets, and the remote modes will not start. Read the reason, and check that the
  `panel` folder is a real folder in your own profile and not a link. Check that the `USERNAME`
  and `USERDOMAIN` variables are set too. If either is missing, the panel warns and remote access
  will not start. [Files, permissions and backups](../reference/remote-access.md#files-permissions-and-backups)
  explains the rule.

### The bare command took longer than 15 seconds

*Since 0.5.0.* On an installed Windows copy, running `gm-scriptorium` on its own asks the background
app to start. If that takes longer than 15 seconds, it says "GM-Scriptorium is still starting. Look
for its icon in the system tray." and exits with code 1. See the "With no command" section of
[The command line](../reference/command-line.md#with-no-command).
