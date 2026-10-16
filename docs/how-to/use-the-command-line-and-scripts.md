# Use the command line and scripts

This guide is for a GM who is comfortable in a terminal and wants to run GM-Scriptorium from a
script, a scheduled job or a service manager. It shows how to give a script its own settings, read
results as data, act on exit codes, keep the site running, and set a password without a prompt.

Every command is written `gm-scriptorium <command> [campaign] [flags]`. [The command line](../reference/command-line.md)
lists every command and flag. [Exit codes](../reference/exit-codes.md) says what each code means,
and [Environment variables](../reference/environment-variables.md) lists every variable the program reads.

## Point a script at its own settings

A script should not depend on whoever's settings file happens to be the default. Give it its own
file with the `--config` flag and the `SCRIPTORIUM_CONFIG` environment variable, set to the same
path:

```
export SCRIPTORIUM_CONFIG=~/ci/scriptorium/config.toml
gm-scriptorium check lease --config "$SCRIPTORIUM_CONFIG"
```

`--config` wins when both are set. Setting both means the script never touches your real settings.
[Trying it safely](../trying-it-safely.md) shows the same idea with a scratch copy of the sample
campaign, and says what the isolation does not cover: your vault is still written to by `init` and
the admin panel.

To see which file a command will use, run `gm-scriptorium config path`.

## Put flags after the command

Write the command first, then the campaign, then the flags:

```
gm-scriptorium check lease --config ~/ci/scriptorium/config.toml
```

Give a value after a space, never after an equals sign. `--port=8081` is refused with exit code 1.
A flag the command does not accept is also refused, so a typo in a script fails at once instead
of doing something else.

## Read results with --json

`check`, `build`, `status` and `serve` accept `--json`. Instead of text, they print data. Other
commands ignore it, except `init`, which refuses it.

```
gm-scriptorium check lease --json
```

`check` prints one JSON document. It has a `counts` object with the number of `error`, `warn` and
`info` findings, and a `findings` list. Each finding has an `id`, a `severity`, a `path`, a `line`
and a `message`. [Check messages](../reference/check-messages.md) explains each id.

With a tool such as `jq`, you can pull out what you need:

```
gm-scriptorium check lease --json | jq '.counts'
```

```
gm-scriptorium check lease --json | jq -r '.findings[] | select(.severity == "error") | .id'
```

`jq` is not part of GM-Scriptorium. Use whatever reads JSON in your script.

## Act on exit codes

Every command ends with one of five exit codes. 0 means success, or warnings only. 2 means the vault
has errors. 3 means the campaign, config or vault cannot be used. [Exit codes](../reference/exit-codes.md)
has all five and what to do about each. Read the code straight after the command.

In a bash script, use `$?`:

```
gm-scriptorium build lease
status=$?
if [ "$status" -eq 0 ]; then
  echo "built"
elif [ "$status" -eq 2 ]; then
  echo "the vault has errors; nothing was written"
else
  echo "failed with exit code $status"
fi
```

In PowerShell, use `$LASTEXITCODE`:

```
gm-scriptorium build lease
if ($LASTEXITCODE -eq 0) {
  "built"
} elseif ($LASTEXITCODE -eq 2) {
  "the vault has errors; nothing was written"
} else {
  "failed with exit code $LASTEXITCODE"
}
```

The PowerShell example has not been run on Windows yet, so tell us if it does not work.

A failed or interrupted build never damages the site you already had.

## Keep the site running under a supervisor

`serve` shows the built site on this computer. With `--json` it prints one JSON object per line, so
a supervisor or script can follow it:

```
gm-scriptorium serve lease --build --port 8081 --json
```

A `ready` line comes once the server is listening. With `--build`, a `message` line about the build comes before it.

```text
{"event":"ready","mode":"serve","url":"http://127.0.0.1:8081","host":"127.0.0.1","port":8081,"output":"/srv/lease/out"}
```

When the program is stopped with Ctrl-C or SIGTERM, it closes its ports, prints a `stopped` line and
exits 0:

```text
{"event":"stopped","signal":"SIGTERM","exitCode":0}
```

If it cannot start, it prints an `error` line and exits 1, or 3 when there is no build to serve:

```text
{"event":"error","message":"failed to start server: port 8081 is already in use on 127.0.0.1"}
```

`--build` builds the site first. Without it, `serve` stops with exit code 3 until a build exists.
The same lines come from `serve --admin --json`.

## Give remote account add a password from a script

`remote account add` asks for a password at a terminal. It never takes one as an argument or from an
environment variable, because other programs on the computer can read both. When there is no
terminal, it reads the password from standard input instead:

```
printf '%s\n' "$NEW_PASSWORD" | gm-scriptorium remote account add rook
```

*Since 0.5.0.* Take the password from your own secret store at the moment you run the command, and
never write it into the script. It must be at least 12 characters, or the command stops with exit
code 1 and says so.
[Remote access](../remote-access.md) has the setup, and [its reference page](../reference/remote-access.md) explains accounts and what remote access does and does not protect.
