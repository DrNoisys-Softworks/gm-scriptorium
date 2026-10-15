# Exit codes

This page is for someone writing a script, a scheduled job or a CI step around GM-Scriptorium who
needs to know what each exit code means. Every command ends with one of these five codes, and there
are no others, so a script can rely on them.

<!-- BEGIN GENERATED exit-codes: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Code | Meaning | Commands that can return it | What to do |
|---|---|---|---|
| `0` | success, or warnings only | `build`, `check`, `config`, `desktop`, `init`, `remote`, `serve`, `status`, `update` | Nothing. Warnings are shown but do not stop anything. |
| `1` | Scriptorium could not do what you asked (see the message); also used for unexpected failures | `build`, `check`, `config`, `desktop`, `init`, `remote`, `serve`, `status`, `update` | Read the message. It names what could not be done, such as an unknown command or flag, a port already in use, or an editor that could not start. A stack trace instead of a message is a bug, so report it. |
| `2` | the vault has errors (check found problems, or build refused and wrote nothing) | `build`, `check` | Run `gm-scriptorium check` and fix what it lists. A refused `build` writes nothing. |
| `3` | the campaign, its config or its vault cannot be used: no campaign registered, unknown campaign, missing or malformed config, vault missing or not a gm-apprentice vault, output folder missing or inside the vault | `build`, `check`, `config`, `desktop`, `init`, `remote`, `serve`, `status` | Read the message. It names the campaign, config file or folder that cannot be used. `gm-scriptorium config list` shows what is registered. |
| `4` | update cannot run (GitHub could not be reached, or there is no such release) | `update` | Check that this computer can reach GitHub, then run `gm-scriptorium update --check` again. |
<!-- END GENERATED exit-codes -->

The "Commands that can return it" column is read from each command's own `--help` text, so it is
the commands that document the code. The full list of user mistakes and the code each one gets is in
the [developer guide](../DEVELOPING.md#exit-codes-for-user-errors).
