# Environment variables

This page is for someone comfortable setting environment variables who wants to know exactly which
ones GM-Scriptorium reads, and what each one changes. It lists every name the program looks at, and
a test fails if the program reads a name that is not on this page.

## Variables you can set

| Variable | What it does | Where it applies |
|---|---|---|
| `SCRIPTORIUM_CONFIG` | The settings file to use, when you do not give `--config`. `--config` wins over it. See [the settings file](config-toml.md). | Every command |
| `SCRIPTORIUM_PROFILE` | Forces one per-computer profile by name, instead of matching on platform and host name. A name that does not exist stops the command with exit code 3. | Every command that reads a campaign |
| `XDG_CONFIG_HOME` | The folder that holds `scriptorium/config.toml`, in place of `~/.config`. | Linux and macOS |
| `EDITOR` | The program `config edit` opens the settings file in. It is looked at first. | `config edit` |
| `VISUAL` | The same, used only when `EDITOR` is not set. | `config edit` |

`EDITOR` and `VISUAL` must name a program and nothing else. A value such as `code --wait`, or a
Windows `.cmd` shim, cannot be started, and `config edit` stops with exit code 1 and tells you where
the settings file is, so you can open it yourself. If neither is set, `config edit` prints the path
and does nothing else.

## Variables it reads from your system

| Variable | What it does | Where it applies |
|---|---|---|
| `APPDATA` | Where the Windows settings folder is: `%APPDATA%\Scriptorium`. If it is missing, `AppData\Roaming` under your home folder is used. | Windows |
| `PATH` | Used to find the programs GM-Scriptorium starts, such as the one that opens your browser. A program it starts is refused if there is no `PATH`. | Every computer |
| `SystemRoot` | Passed on to the programs it starts. It must be a usable folder name, or they are not started. | Windows |
| `USERDOMAIN` | *Since 0.5.0.* With `USERNAME`, names your account when the panel folder is locked down to you, SYSTEM and Administrators. If either is missing, the panel warns and remote access will not start. | Windows |
| `USERNAME` | *Since 0.5.0.* See `USERDOMAIN`. | Windows |
| `OneDrive` | *Since 0.5.0.* When setting up a campaign, GM-Scriptorium warns if the folder you chose is inside a OneDrive folder. These three variables say where those folders are. | Windows |
| `OneDriveConsumer` | *Since 0.5.0.* See `OneDrive`. | Windows |
| `OneDriveCommercial` | *Since 0.5.0.* See `OneDrive`. | Windows |

## What it does not read

Programs that GM-Scriptorium starts get a short list of variables, not your whole environment, and
the variables that hold AI service keys are always removed
([the decision on what child programs receive](../decisions/0046-one-process-spawner.md)).

Passwords are never read from the environment. `remote account` and `remote password` ask for one
with nothing echoed, or read it from standard input when there is no terminal.
