# Trying it beside a real campaign

This page is for a GM who already has a campaign registered and wants to try a command, a
theme or the admin panel without disturbing it.

GM-Scriptorium keeps its list of campaigns in one config file. `SCRIPTORIUM_CONFIG` and the
`--config` flag both point the tool at a different file. Set both to the same scratch path and the
tool never reads or writes your real config.

**What this isolates.** Your registered campaigns, and the admin panel's backups and saved preferences.
The panel keeps its backups of `_meta/vault-config.md` outside the vault, in the same folder as
whichever config file you point at, and keeps its saved preferences there too. A scratch config
therefore gets its own scratch copies. (The panel's temporary preview folder goes to your system
temp folder either way.)

**What this does not isolate: your vault.** `init` and the admin panel write inside the vault.
They create and change files in `_meta/scriptorium/`, and the panel can also rewrite
`_meta/vault-config.md`, for example when you save the tagline. Pointing at a scratch config does not stop any of that. If you register
your real vault in a scratch config, those writes still land in your real vault. So give the scratch
config a copy of your vault, or the sample vault in `examples/the-long-lease`, and never the
original.

Each block below makes a scratch folder, copies the sample vault into it, and builds it. Run it
from the root of a clone of this repository. To try your own campaign instead, change the copy
line to copy a duplicate of your vault, never the original.

**Linux or macOS shell:**
```
TRIAL="$(mktemp -d)"
cp -r examples/the-long-lease "$TRIAL/vault"
mkdir "$TRIAL/config"
export SCRIPTORIUM_CONFIG="$TRIAL/config/config.toml"
gm-scriptorium --config "$SCRIPTORIUM_CONFIG" config add lease --vault "$TRIAL/vault" --out "$TRIAL/out"
gm-scriptorium --config "$SCRIPTORIUM_CONFIG" check lease
gm-scriptorium --config "$SCRIPTORIUM_CONFIG" build lease
```

**Windows PowerShell:**
```
$Trial = Join-Path $env:TEMP ("scriptorium-trial-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force "$Trial\config" | Out-Null
Copy-Item -Recurse examples\the-long-lease "$Trial\vault"
$env:SCRIPTORIUM_CONFIG = "$Trial\config\config.toml"
gm-scriptorium --config $env:SCRIPTORIUM_CONFIG config add lease --vault "$Trial\vault" --out "$Trial\out"
gm-scriptorium --config $env:SCRIPTORIUM_CONFIG check lease
gm-scriptorium --config $env:SCRIPTORIUM_CONFIG build lease
```

**Windows Command Prompt (cmd):**
```
set "TRIAL=%TEMP%\scriptorium-trial-%RANDOM%%RANDOM%"
mkdir "%TRIAL%\config"
xcopy /E /I examples\the-long-lease "%TRIAL%\vault"
set "SCRIPTORIUM_CONFIG=%TRIAL%\config\config.toml"
gm-scriptorium --config "%SCRIPTORIUM_CONFIG%" config add lease --vault "%TRIAL%\vault" --out "%TRIAL%\out"
gm-scriptorium --config "%SCRIPTORIUM_CONFIG%" check lease
gm-scriptorium --config "%SCRIPTORIUM_CONFIG%" build lease
```

The variable lasts only as long as that terminal window. Close the window, or unset it, to go back
to your real config. Each run makes a new scratch folder, so you can run a block again. Delete the
scratch folders when you are done. Only the Linux block has been run end to end. The two Windows
blocks have not been run on Windows yet, so tell us if anything in them does not work.
