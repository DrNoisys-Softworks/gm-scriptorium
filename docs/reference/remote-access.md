# Remote access: accounts, sign-in and what is protected

This page is for someone who has set up remote access and wants to look up the rules for accounts,
how signing in works, what the audit log holds, what is and is not protected, and where the files
are kept. The steps for setting remote access up are in [Remote access](../remote-access.md).

## Accounts

An account is a name and a password. Every account has the same rights: there are no roles. A name
is 1 to 32 letters, digits, dots, hyphens or underscores, starting with a letter or digit, and it
does not care about capital letters (`Rook` and `rook` are one account). You can have up to eight.
They are managed only from the command line, so the panel itself can never set or change one; the
Setup > Remote access screen lists each name with when its password was set and its last sign-in,
and nothing more.

| Command | What it does |
|---|---|
| `remote account add <name>` | makes an account, asking for its password |
| `remote account change <name>` | asks for that account's current password, then a new one |
| `remote account reset <name>` | sets a new password with no current one needed, for a forgotten password; it is a command on this computer, so only someone who can run it here can use it |
| `remote account remove <name>` | deletes the account |
| `remote account rename <old> <new>` | gives the account a new name, keeping its password |
| `remote account list` | prints the names and the dates their passwords were set, never a secret |

`change`, `reset`, `remove` and `rename` each sign that account out on every device, and a running
panel notices straight away. Every account change is recorded in the audit log by name only.

**If you had a password before accounts existed,** it keeps working as an account called `gm`
(the list marks it "from your earlier password"). Nothing is rewritten when it is read. The first
`remote account` command that writes moves it into the accounts file. `remote password` still
works: it sets the password of the account `gm`, adding it if it is missing.

The account `gm` is a name anyone can guess, and someone who knows a name can keep it paused ([what is and is not protected](#what-is-and-is-not-protected)). `gm-scriptorium remote account rename gm <new name>` gives it one only you know.

## Other commands

| Command | What it does |
|---|---|
| `remote signout-all` | signs every remote device out at once (a lost laptop) |
| `remote signout-all --account <name>` | signs out only the devices signed in as that account |
| `remote off` | returns the setting to `local`, signs every device out and clears every account |

A running panel notices a sign-out or an account change straight away; the other settings need a
restart. If you forget every password: `remote account reset <name>` from this computer, or
`remote off`, then `remote account add <name>`, then set the mode again ([section 3](../remote-access.md#3-setting-it-up-from-the-command-line)).

## Signing in

A browser that reaches the panel by its external name and has no session sees a sign-in page, with a
username and a password field. The page says what the pause rule is. Behind it:

- **Sessions** last 24 hours from sign-in and are not extended while you use them. They survive a
  restart of the panel. Each browser holds its own, as a cookie that page scripts cannot read.
- **Wrong tries.** Five wrong tries for one username in ten minutes pause that username for fifteen
  minutes, whether or not such an account exists, and fifty wrong tries across all usernames in ten
  minutes pause every password sign-in for fifteen minutes. Every failure, paused or not, shows the
  same message, so the page never says whether a name exists. While a name or everything is paused
  the panel refuses attempts without even checking them. The Remote access screen shows what is
  paused. The one-time link on the machine itself is never paused. Restarting the panel also ends a
  pause.
- **Signing out.** "Sign out this device" and "Sign out every device" are on the Setup > Remote
  access screen, and `gm-scriptorium remote signout-all` does the second from the command line.
- **Open preview** from a signed-in panel goes to the preview address without asking for the
  password again.

## The audit log

Every sign-in attempt (the one-time link and the password), every lockout start and end, every
sign-out, every password or settings change, and every change made through the panel (a before line
and an after line with the result) is recorded in `panel/audit.log`, one line each, in a `panel`
folder next to your config file (`gm-scriptorium config path` shows where). It holds the method, the
result, the address the request came from as your proxy reported it, the browser family (not the
full browser string), the campaign and the time. It never holds a password, a one-time link, a
cookie, a key or a request body, and entries older than 90 days are dropped when the panel starts.

If the panel cannot write the log, changes from other devices are refused until it can, with a
message saying so. Changes made on the machine itself carry on, and the Remote access screen shows
the problem.

## What is and is not protected

Protected:

- Requests for any name other than the panel's own configured names, including the machine's bare
  address, a name with something added to it, a wrong port, and a request with no or two `Host`
  headers.
- Any machine other than your proxy (and this computer, over 127.0.0.1) in `proxy` mode.
- Forged `X-Forwarded-For` and `X-Forwarded-Proto` from anything but your proxy.
- Cross-site and cross-origin changes, including a sign-in attempt made by a page on the preview
  name.
- Guessing a password (the pause, per username), and a stolen sessions file (only digests are kept).
- Search engines indexing the sign-in page: every panel response says `X-Robots-Tag: noindex`.
- The panel and its sign-in page being framed by another site.

Not protected, deliberately:

- The plain hop between your proxy and the panel ([section 6](../remote-access.md#6-the-plain-hop)).
- A machine that can pretend to be your proxy's address.
- Devices your tailnet's rules let reach `tailscale serve` (they get the sign-in page).
- A stolen session cookie, which stays valid until it expires or you sign out.
- A change to what your published site hides, made by whoever holds a signed-in session: the
  guarded `vault-config.md` editor works remotely too, and the audit log records it.
- Anyone who can reach the sign-in page keeping everyone's sign-in paused by guessing wrong fifty
  times in ten minutes (use the one-time link on the machine, or restart the panel). This is the
  price of counting per username instead of per address.
- Hand-edited password records with other scrypt settings, and an older GM-Scriptorium run against
  a config folder that has been moved to accounts (it finds the old password file cleared and
  refuses remote sign-in).
- Anyone who knows an account name keeping that one account paused. Five wrong tries for the name
  every 15 minutes is enough. Other accounts and the one-time link on the machine are unaffected,
  and a restart ends the pause. Counting per username protects an account from strangers who do not
  know its name, not from someone who does.
- Password quality beyond 12 characters.

## Files, permissions and backups

Everything lives in the `panel` folder next to your config file: `accounts.json` (each account's
name and a salted scrypt hash, never a password; an older `password.json` is read as the account
`gm` until the first account command moves it), `sessions.json` (digests of session credentials), `audit.log`. On Linux
and macOS the folder is created readable only by you (`0700`) and each file `0600`, at creation; if
you loosen them the panel prints a warning at start and the Remote access screen shows it. On
Windows the program sets the folder's access list itself, on every start and before any `remote`
command writes there (your account, SYSTEM and Administrators, passed down to every file); if it
cannot, the panel warns, the Remote access screen shows it, and the remote modes refuse to start
([ADR 0056](../decisions/0056-windows-panel-access-list.md)). The folder must be a real folder
(not a link) and is never created inside a campaign vault.

A backup of that folder, or a roaming profile that copies it, carries the password hashes and the
session digests along with it. Keep the folder out of backups you share.
