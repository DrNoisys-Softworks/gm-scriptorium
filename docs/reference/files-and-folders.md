# Files and folders

This page is for someone who wants to know what GM-Scriptorium writes to their computer, where it
goes, and which of those files are safe to open, copy or delete.

## Beside the settings file

Everything in this table sits in the same folder as your [settings file](config-toml.md). Paths are
relative to that folder. None of it is ever written inside a vault.

<!-- BEGIN GENERATED files: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Path | What it holds | Edit by hand? |
|---|---|---|
| `config.toml` | The settings file: your campaigns, profiles and the `[remote]`, `[update]` and `[desktop]` tables. | Yes, see [the settings file](config-toml.md) |
| `panel/` | The admin panel's per-computer files. It holds password hashes, so copy or share it with care. | No |
| `panel/password.json` | The earlier single-password file. It is still read, as the account `gm`, until the first `remote account` command moves it. | No |
| `panel/accounts.json` | *Since 0.5.0.* The remote-access accounts: each name and a salted hash of its password, never the password itself. | No |
| `panel/sessions.json` | Digests of the sign-ins of the devices that are signed in. | No |
| `panel/audit.log` | One line for each remote-access change, with the account name and the result. | No (read it if you like) |
| `tls/` | Reserved. Nothing writes it in this version. | No |
| `tls/generated.pem` | Reserved. Nothing writes it in this version. | No |
| `backups/` | Copies of each campaign's `_meta/vault-config.md`, made before the admin panel saves it, in a `campaign-<name>/` folder each. The newest 20 per campaign are kept. | No (delete old ones if you like) |
| `panel-prefs.json` | How you set the admin panel up on this computer, such as its views and pane placement. | No (delete it to reset) |
| `panel/welcome.json` | *Since 0.5.0.* The campaigns whose welcome message on the Overview has not been dismissed yet. | No |
| `panel/update-check.json` | *Since 0.5.0.* When the panel last asked GitHub about a newer version, and what it found. | No |
| `panel/logs/` | *Since 0.5.0.* The Windows desktop app's log folder. It is private to your account. | No |
| `panel/logs/desktop.log` | *Since 0.5.0.* What the Windows desktop app did: started, stopped, retried, and a plain one-line reason when something failed. It never holds a sign-in code, token, password or cookie, and it is never sent anywhere. At 256 KiB it moves to `desktop.log.1`. | No (read it if you like) |
| `panel/logs/desktop.log.1` | *Since 0.5.0.* The previous `desktop.log`, kept when it reached 256 KiB. The next one replaces it. | No (delete it if you like) |
| `panel/launch-<number>.html` | *Since 0.5.0.* The one-time sign-in page that opens your browser. It holds the sign-in code for under a minute and is deleted after use. The number is the program's process number. | No |
<!-- END GENERATED files -->

**Take care with `panel/`.** It holds the password hashes for remote access and the digests of
signed-in devices. Copy it, back it up or share it with care, and keep it out of any backup you
hand to someone else. [Remote access: accounts, sign-in and what is protected](remote-access.md) explains how its permissions are set.

## Beside the program

When `update` replaces the program, the old copy stays beside it as `<program>.old-<version>`, and
the next command you run sweeps it away. If an earlier version left a `THIRD-PARTY-NOTICES.txt`
beside the program, `update` removes it, because the program now carries its own copy (run
`gm-scriptorium --notices` to read it).

## In the system temp folder

The admin panel builds its preview in a folder called `scriptorium-preview-` followed by random
letters, in your system's temp folder. It is removed when the panel stops.

## In your vault

GM-Scriptorium writes to a vault only for the things you ask for in the admin panel, such as saving
`_meta/vault-config.md` or making a new campaign pack. [Trying it safely](../trying-it-safely.md)
shows how to try the tool without touching your real campaign.
