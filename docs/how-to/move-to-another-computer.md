# Move to another computer

This guide is for a GM who has GM-Scriptorium working on one computer and wants the same campaign
on another, or wants two computers to use one vault. It covers what to copy, how to fix the paths
afterwards, and the one rule for sharing a vault.

A **vault** is the folder of markdown pages you write your campaign in. The **settings file**
(`config.toml`) is the list of your campaigns and where each one lives. Moving to a new computer
means moving your notes, then telling GM-Scriptorium where they are now.

## Before you start

- Install GM-Scriptorium on the new computer. [Install, update and build from source](../install.md) has the steps.
- Get the vault onto the new computer first. GM-Scriptorium does not copy it for you. Use a copy,
  a sync tool or a shared drive, and keep the vault backed up: [Backing up your vault](../backing-up-your-vault.md).
- You do not need to move the built site. `build` makes it again on the new computer.

## 1. Find your settings folder

On the old computer, run this:

```
gm-scriptorium config path
```

It prints the settings file, for example `%APPDATA%\Scriptorium\config.toml` on Windows or
`~/.config/scriptorium/config.toml` on Linux. The settings folder is the folder that holds it.
[Files and folders](../reference/files-and-folders.md) lists everything that sits beside the
settings file.

## 2. Copy the settings

Copy `config.toml` into the same place on the new computer. Run `gm-scriptorium config path` there
to see where that is. Make the folder if it is not there yet.

You only need `config.toml`. Leave the rest of the folder behind unless you have a reason to take
it. If you copied the `panel` folder too, go to "If you copied the panel folder" below.

## 3. Fix the vault and output paths

The paths in `config.toml` are for the old computer. Fix them in one of two ways.

**Register the campaign again.** Use `config add` with the new paths. It replaces the campaign
of the same name:

```
gm-scriptorium config add lease --vault D:\Campaigns\lease\vault --out D:\Campaigns\lease\out
```

The output folder must be outside the vault. If the campaign has a profile that matches this
computer (see below), the profile's paths still win over the ones you just saved.

**Give each computer its own profile.** A profile is a small table in `config.toml` that holds the
paths for one computer. Edit the file by hand (`gm-scriptorium config edit` opens it). This
example keeps one set of paths for a Linux computer and one each for a Windows computer and a
laptop named `my-laptop`:

```toml
config_version = 1
default_campaign = "lease"

[campaigns.lease]
vault = '/srv/campaigns/lease/vault'
output = '/srv/campaigns/lease/out'

[campaigns.lease.paths.windows-desktop]
match = { platform = "win32" }
vault = 'D:\Campaigns\lease\vault'
output = 'D:\Campaigns\lease\out'

[campaigns.lease.paths.my-laptop]
match = { hostname = "my-laptop" }
vault = '/srv/laptop/lease/vault'
output = '/srv/laptop/lease/out'
```

Write the paths in full. A path that starts with `~` is not expanded in this file. Use single
quotes around Windows paths, so the backslashes are taken as they are.

Each profile needs a `match` line. When more than one profile matches a computer, the most
specific wins: platform and hostname together, then platform alone, then hostname alone. So if
`my-laptop` runs Windows, the `windows-desktop` profile wins over the `my-laptop` one. Put both
keys in the laptop's `match` to make it more specific. Two profiles that are equally specific stop
the command with exit code 3. [The settings file](../reference/config-toml.md#per-computer-profiles)
has every rule.

## 4. Check it

```
gm-scriptorium config list
```

Each campaign is listed with its vault, its output folder and whether the vault can be reached.
`[reachable]` is what you want. `[unreachable (not-found)]` means the path is wrong for this
computer.

Then run the checks and a build, to be sure the new computer sees what the old one did:

```
gm-scriptorium check lease
```

```
gm-scriptorium build lease
```

If a message stops you, [Troubleshooting](troubleshooting.md) explains it.

## If you copied the panel folder

The `panel` folder holds the password hashes for remote access and the digests of signed-in
devices. Treat it like a password file. Never edit anything in it by hand.

Remote access is set up for one computer. The addresses in the `[remote]` part of `config.toml`
belong to the old machine, so they are wrong on the new one. Look at what the new computer
believes:

```
gm-scriptorium remote show
```

Then choose:

- To turn remote access off on this computer, run `gm-scriptorium remote off`. It returns to
  local-only use, signs every device out and clears every account.
- To keep the setup but end every signed-in device, run `gm-scriptorium remote signout-all`.
- To set remote access up again with this computer's own addresses, follow [Remote access](../remote-access.md).

## Two computers, one vault

You can use one vault from two computers. Give each computer a profile (step 3) so each finds the
vault at its own path.

To force one profile by name, set the `SCRIPTORIUM_PROFILE` environment variable to the profile's
name before you run a command. A name that does not exist stops the command with exit code 3.
[Environment variables](../reference/environment-variables.md) has the details.

Use the vault from one computer at a time. Two computers writing to one vault can damage it, and
that includes the admin panel, which writes settings files into the vault. In particular, **git on
a network share is only safe with a single writer**. Keep the git history on one computer's own
disk, or take turns. [Backing up your vault](../backing-up-your-vault.md) explains why.

If the vault is in a folder that a sync tool such as OneDrive manages, let it finish syncing
before you open the vault on the other computer.

Remote access settings are per computer too, so each computer has its own `[remote]` setup and its own
`panel` folder.
