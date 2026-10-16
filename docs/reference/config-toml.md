# The settings file (config.toml)

This page is for someone comfortable editing a text file who wants to know every setting
GM-Scriptorium keeps in `config.toml`, what each one does, and which command or screen changes it.
The tables below are generated from the program itself, so they list exactly the keys this version
knows.

## Where the file lives

| Computer | Default place |
|---|---|
| Windows | `%APPDATA%\Scriptorium\config.toml` |
| Linux and macOS | `~/.config/scriptorium/config.toml`, or `scriptorium/config.toml` under the folder `XDG_CONFIG_HOME` names |

Two things override the default. The `--config` flag wins, then the `SCRIPTORIUM_CONFIG`
environment variable (see [environment variables](environment-variables.md)). To see which file a
command will use, run `gm-scriptorium config path`. The other files GM-Scriptorium keeps beside it
are listed in [files and folders](files-and-folders.md).

You can edit the file by hand, or run `gm-scriptorium config edit` to open it in your editor.
GM-Scriptorium also rewrites it when you use `config add`, `config remove`, `config set-default`,
`init`, `remote set` or `remote off`. *Since 0.5.0.* It also rewrites it for `desktop set`, and when
you change a campaign or the update setting in the admin panel. A rewrite puts the keys in a fixed order and puts a fresh header at the
top, so **comments you add are lost**. A key this version does not know is kept, and a warning says
it was "preserved, not applied". A file with a higher `config_version` than the program
understands is refused.

## An example

This is a complete file for one campaign, with a second set of folders for a Windows computer.

```toml
config_version = 1
default_campaign = "lease"

[campaigns.lease]
vault = '~/campaigns/lease/vault'
site_config = '~/campaigns/lease/site/vault.config.json'
output = '~/campaigns/lease/out'
serve_port = 8080

[campaigns.lease.paths.windows-desktop]
match = { platform = "win32" }
vault = 'D:\Campaigns\lease\vault'
output = 'D:\Campaigns\lease\out'
```

Use single quotes for Windows paths, so the backslashes are taken as they are.

## Top level

<!-- BEGIN GENERATED config-top: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `config_version` | whole number | Required | `1` | The version of the settings format. A file with a higher number than this program understands is refused, never half read. | GM-Scriptorium writes it |
| `default_campaign` | text | None | - | The campaign used when you name none on the command line. | `config set-default`, or by hand. *Since 0.5.0.* Also the admin panel |
| `campaigns` | table | None | - | One table per campaign, named by you: `[campaigns.lease]`. See the campaign table below. | `config add`, `config remove`, `init`, or by hand. *Since 0.5.0.* Also the admin panel |
| `remote` | table | Absent means local only | - | Remote access. See the `[remote]` section below. | `remote set`, `remote off`, or by hand |
| `update` | table | Absent means checks on | - | *Since 0.5.0.* The panel's update notice. See the `[update]` section below. | The Updates card in the admin panel, or by hand |
| `desktop` | table | Absent means the default ports | - | *Since 0.5.0.* The ports for the Windows desktop app. See the `[desktop]` section below. | `desktop set` |
<!-- END GENERATED config-top -->

## Campaigns: `[campaigns.<name>]`

Each campaign is a table named by you.

<!-- BEGIN GENERATED config-campaign: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `vault` | text | None | - | The folder holding the campaign's notes. A campaign without one cannot be checked or built. | `config add`, `init`, or by hand. *Since 0.5.0.* Also the admin panel |
| `site_config` | text | None | - | The campaign's `vault.config.json`, which holds the site settings. When it is set it is used, and any campaign pack is ignored. | `config add --site-config`, or by hand |
| `output` | text | None | - | The folder `build` writes the website to. It must be outside the vault. | `config add`, `init`, or by hand. *Since 0.5.0.* Also the admin panel |
| `pack` | text | None | - | The campaign pack folder (site settings, stylesheet and images). Without it, GM-Scriptorium looks for `_meta/scriptorium` inside the vault. | By hand |
| `serve_port` | whole number | 8080 | 1 to 65535 | The port `serve` listens on when you do not give `--port`. | By hand |
| `paths` | table of tables | None | - | Per-computer profiles: `[campaigns.lease.paths.<profile>]`. A profile needs a `match` and may set any of the campaign keys above except `paths`. See the profiles section below. | By hand |
<!-- END GENERATED config-campaign -->

## Per-computer profiles

One campaign can live in different places on different computers. Add a table
`[campaigns.<name>.paths.<profile>]` for each computer. The profile name is yours. It needs a
`match` line saying which computers it is for, and it may set any campaign key except `paths`. A
key you leave out falls back to the campaign table.

`match` takes these keys. An unknown key in `match` is an error, so a typing slip never matches the
wrong computer.

<!-- BEGIN GENERATED config-match: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `platform` | text | Matches any | `win32`, `linux`, `darwin` | The operating system, as Node.js names it. `win32` is Windows. | By hand |
| `hostname` | text | Matches any | Any computer name, such as my-laptop | The computer's name. Capital letters do not matter. | By hand |
<!-- END GENERATED config-match -->

If more than one profile matches, the most specific one wins: platform and hostname together, then
platform alone, then hostname alone. Two profiles that are equally specific stop the command with
exit code 3 and a message naming both. To pick a profile yourself, set the `SCRIPTORIUM_PROFILE`
environment variable to its name. A name that does not exist also exits 3.

## Remote access: `[remote]`

Remote access lets you use the admin panel from another device. [Remote access](../remote-access.md)
explains the modes and how to set them up, and [Remote access: accounts, sign-in and what is protected](remote-access.md)
says what each one protects. The table here lists the keys. Use `gm-scriptorium
remote set` to change them where you can, because it checks every value before it writes anything.
Changing `--mode` drops the old addresses unless you give new ones in the same command.

`direct` and the three `tls` keys are reserved. This version has no certificate support, so they are
accepted in the file but remote access will not start with them.

A mistake in this table stops only the `remote` command and the panel, however it is started. Other
commands such as `check` and `build` do not read it. An unknown key is an error, because a typing
slip in a security setting should never turn into a default.

<!-- BEGIN GENERATED config-remote: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `mode` | text | local | `local`, `ssh`, `tailscale`, `proxy`, `direct` (reserved) | How the panel is reached from other devices. `local` is this computer only. `direct` is reserved: it is refused with a message, and `remote set` will not set it. | `remote set --mode`, `remote off`, or by hand |
| `port` | whole number | None | 1 to 65535 | The fixed port for the panel. Every mode except `local` needs it, and it must differ from `preview_port`. | `remote set --port`, or by hand |
| `preview_port` | whole number | None | 1 to 65535 | The fixed port for the preview of the player site. Every mode except `local` needs it. | `remote set --preview-port`, or by hand |
| `admin_url` | web address | None | An https address with no user name or password | The address you type to reach the panel. Needed in the `tailscale`, `proxy` and reserved `direct` modes. Changing the mode drops it. | `remote set --admin-url`, or by hand |
| `preview_url` | web address | None | An https address with no user name or password | The address you type to reach the preview. It must differ from `admin_url`. Changing the mode drops it. | `remote set --preview-url`, or by hand |
| `bind` | IP address | None | One IP address | The address the panel listens on, for the `proxy` mode (and the reserved `direct` mode). | `remote set --bind`, or by hand |
| `trusted_proxies` | list of IP addresses | None | 1 to 16 addresses, never 0.0.0.0 or :: | The reverse proxies the panel believes, in the `proxy` mode. | `remote set --trusted-proxy`, or by hand |
| `tls` | text | off | `off`, `generated`, `byo` | Reserved. This version has no certificate support, so only `off` works, and a `proxy` mode with anything else is refused. | By hand |
| `tls_cert` | full path | None | An absolute path | Reserved. The certificate file for `tls = "byo"`. Nothing reads it in this version. | By hand |
| `tls_key` | full path | None | An absolute path | Reserved. The key file for `tls = "byo"`. Nothing reads it in this version. | By hand |
<!-- END GENERATED config-remote -->

## The update notice: `[update]`

*Since 0.5.0.*

The admin panel can tell you when a newer version is out. [Privacy](../privacy.md) says what that
request sends. If the table is missing, checks are on. If any value in it cannot be read, such as
`check = "yes"`, the whole table counts as off and no request is made. Other keys in the table are
ignored and kept.

<!-- BEGIN GENERATED config-update: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `check` | true or false | true | `true`, `false` | *Since 0.5.0.* Whether the admin panel asks GitHub once a day if a newer version is out. `false` turns the notice off and no request is made. | The Updates card in the admin panel, or by hand |
| `channel` | text | Left to the running build | `stable`, `beta` | *Since 0.5.0.* Which releases the notice offers. `beta` also offers releases that are still being checked. | The Updates card in the admin panel, or by hand |
<!-- END GENERATED config-update -->

## The Windows desktop app: `[desktop]`

*Since 0.5.0.*

This table holds the two ports for the Windows desktop app. Both keys are optional. An unknown key,
a port that is a string rather than a whole number, and two equal ports are all refused. Other
commands do not read this table, so a mistake in it does not stop them. `desktop set` refuses to
change a table it cannot read.

<!-- BEGIN GENERATED config-desktop: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `port` | whole number | 7400 | 1 to 65535 | *Since 0.5.0.* The panel's port for the Windows desktop app ([ADR 0057](../decisions/0057-windows-desktop-app.md), section 8). In this version only `desktop set` reads and writes it. It must differ from `preview_port`. | `desktop set --port` |
| `preview_port` | whole number | 7401 | 1 to 65535 | *Since 0.5.0.* The preview's port for the Windows desktop app ([ADR 0057](../decisions/0057-windows-desktop-app.md), section 8). In this version only `desktop set` reads and writes it. | `desktop set --preview-port` |
| `remote_at_signin` | true or false | false | `true`, `false` | *Since 0.5.0.* Records that you agreed remote access may start when you sign in to Windows. Without it, the desktop app starts the panel for this computer only at sign-in, whatever mode is saved; a start you make yourself uses the saved mode. `remote set` asks "Also start remote access when you sign in to Windows?" when you switch to a remote mode (the default is No, and no terminal counts as No), and it asks again when you switch to a different remote mode. `remote off` clears it. It counts only on the computer named in `remote_at_signin_pc`. | The answer to the `remote set` question, and `remote off` |
| `remote_at_signin_pc` | text | - | A computer name | *Since 0.5.0.* The name of the computer where you agreed that remote access may start at sign-in. The answer in `remote_at_signin` counts only on that computer, so copying your settings folder to another PC does not carry your yes with it: there the desktop app starts for this computer only, and `remote set` asks again. An answer saved without a name counts as no. `remote set` writes it together with the answer, and `remote off` clears both. It is never written to the desktop app's log. | The answer to the `remote set` question, and `remote off` |
<!-- END GENERATED config-desktop -->
