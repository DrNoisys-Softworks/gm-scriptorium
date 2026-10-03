# Remote access to the admin panel

By default the GM admin panel (`gm-scriptorium serve --admin`) answers only on the computer it runs
on, and nothing here changes that. This page is for a GM who runs GM-Scriptorium on another machine
(a home server, a VM) and wants to use the panel from a laptop or phone. It is opt-in, it is set up
from the command line, and the reasoning behind it is in
[ADR 0029](decisions/0029-remote-access.md).

The names and addresses below are neutral examples: `scriptorium.home.arpa` for the panel,
`preview.scriptorium.home.arpa` for its preview, `192.0.2.42` for the machine running
GM-Scriptorium and `198.51.100.20` for a reverse proxy. Use your own.

## 1. What remote access is

Remote access is a saved setting, never a flag. There is no `--host` for `serve --admin`: the panel
reaches other devices only because you ran `gm-scriptorium remote set ...` and
`gm-scriptorium remote password`, and `serve --admin` then checks the whole setting before it opens
a single socket. If anything is missing it stops with one line saying what, and it never falls back
to a wider address.

Every way in over a network needs HTTPS, a password, and the panel's own checks on who is asking
(the Host and Origin of every request, and which machine the request came through). The panel can
change your campaign files, so none of these is optional.

## 2. The modes

| Mode | Where it listens | Who can connect | HTTPS comes from | Sign-in |
|---|---|---|---|---|
| `local` (the default) | `127.0.0.1`, any free port | this computer | not needed | the one-time link |
| `ssh` | `127.0.0.1`, two fixed ports | this computer, including an SSH tunnel to it | the tunnel | the one-time link |
| `tailscale` | `127.0.0.1`, two fixed ports | `tailscale serve` on this computer | `tailscale serve` | the panel password |
| `proxy` | an address you choose, plus `127.0.0.1`, two fixed ports | your reverse proxy and this computer; every other machine is dropped before any HTTP | your proxy | the panel password |

In `tailscale` and `proxy` mode the panel always also answers on `127.0.0.1`, so the one-time link
printed when it starts keeps working on the machine itself. That is your way back in if you lose
the password.

Remote settings are per machine, and so are the fixed ports: there is one set of them, and one
remote panel at a time.

## 3. Setting it up from the command line

Everything is `gm-scriptorium remote ...`, and it all works over SSH on a machine with no screen.
Add `--config <path>` to each command if you start GM-Scriptorium with a config of your own.

```
gm-scriptorium remote set --mode proxy --admin-url https://scriptorium.home.arpa --preview-url https://preview.scriptorium.home.arpa --bind 192.0.2.42 --trusted-proxy 198.51.100.20 --port 7400 --preview-port 7401
```

```
gm-scriptorium remote password
```

```
gm-scriptorium remote show
```

`set` checks every value as you give it (an address that is not `https://` is refused with "remote
access needs HTTPS", a port outside 1 to 65535 is refused, and so on) and writes nothing if any of
them is wrong. `show` lists what applies to the current mode and whether it is ready to start, and
never prints a secret. Changes take effect the next time `serve --admin` starts. Changing `--mode` drops the old admin and preview addresses (a proxy's names mean nothing to a tailnet) unless the same command gives new ones; the other settings are kept. Each subcommand has its own help: `gm-scriptorium remote set --help`.

`password` asks for the new password with nothing echoed (and, if one is already set, the current
one first). It is read only from the terminal or, when there is no terminal, from standard input,
one line each, for example `printf '%s\n' "your new passphrase" | gm-scriptorium remote password`.
It is never accepted as an argument or from an environment variable, because both are visible to
other programs. The password must be at least 12 characters; there are no other rules. Changing it
signs every remote device out.

Other commands:

| Command | What it does |
|---|---|
| `remote signout-all` | signs every remote device out at once (a lost laptop) |
| `remote off` | returns the setting to `local`, signs every device out and clears the password |

A running panel notices a sign-out or a password change straight away; the other settings need a
restart. If you forget the password: `remote off`, then `remote password`, then set the mode again.

Then start the panel as usual with `gm-scriptorium serve my-campaign --admin`. In a remote mode it
first prints a `WARNING:` line saying who can reach it, then the addresses, then the one-time link
for use on that machine.

## 4. Behind Caddy

Run Caddy anywhere that can reach the panel, with one site block per name. The panel's `proxy`
mode needs two names: one for the panel and one for the preview.

```
scriptorium.home.arpa {
	reverse_proxy 192.0.2.42:7400
}

preview.scriptorium.home.arpa {
	reverse_proxy 192.0.2.42:7401
}
```

Caddy keeps the browser's `Host` header as it is when it talks to a plain HTTP upstream, sets
`X-Forwarded-Proto` and `X-Forwarded-For`, and gets its own HTTPS certificates. **Do not add
`header_up Host ...`**: the panel checks the exact name the browser asked for and refuses anything
else. This block was checked with `caddy adapt` (Caddy v2.11.4) and not run against anyone's real
proxy; running it is on you.

Tell GM-Scriptorium which machine the proxy is, so that every other machine is dropped:

```
gm-scriptorium remote set --mode proxy --bind 192.0.2.42 --trusted-proxy 198.51.100.20 ...
```

`--bind` is the address the panel listens on for the proxy (`192.0.2.42`), and `--trusted-proxy` is
the address the proxy connects from. Use `0.0.0.0` for `--bind` only if you accept that the panel's
ports then exist on every address of that machine (they still drop everyone but the proxy and this
computer).

## 5. Behind nginx

```
server {
    listen 443 ssl;
    server_name scriptorium.home.arpa;
    # ssl_certificate and ssl_certificate_key as for any other site

    location / {
        proxy_pass http://192.0.2.42:7400;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

and the same for `preview.scriptorium.home.arpa` with port 7401. Keep `Host $http_host` (nginx's
default replaces it with the upstream address, which the panel will refuse). The panel never reads
`X-Forwarded-Host`, so setting it does nothing. It takes the client address from the **last**
`X-Forwarded-For` entry, the one your proxy appended, never the first.

## 6. The plain hop

In `proxy` mode the connection from the proxy to GM-Scriptorium is plain HTTP. Anyone who can see
that traffic on the network between the two can read the password at sign-in and every session
cookie after it. Keep the proxy and GM-Scriptorium on the same machine or on a network segment you
trust. It is also true that a machine that can pretend to be the proxy's address on that segment
can reach the sign-in page as if it were the proxy; it still needs the password.

## 7. With Tailscale

`tailscale serve` can put HTTPS in front of the panel without a proxy of your own. The command shape
below was checked against Tailscale's own documentation and `tailscale serve --help` (Tailscale
1.102.2) on 2026-10-03; run `tailscale serve --help` to see your version's.

1. Turn on HTTPS certificates for your tailnet in the Tailscale admin console.
2. Set the panel up for it, using your machine's own `.ts.net` name:

```
gm-scriptorium remote set --mode tailscale --admin-url https://panel-host.example-tailnet.ts.net --preview-url https://panel-host.example-tailnet.ts.net:8443 --port 7400 --preview-port 7401
gm-scriptorium remote password
```

3. Publish the two ports (the preview gets the second HTTPS port of the same name):

```
tailscale serve --bg --https=443 7400
tailscale serve --bg --https=8443 7401
```

`tailscale serve reset` undoes both. Your tailnet's access rules decide which devices can reach
that name, so check them: any device they allow can reach the panel's sign-in page, and the password
is what stops it going further. GM-Scriptorium never assumes that a tailnet is only your own
devices.

GM-Scriptorium needs `tailscale serve` to pass the browser's own `Host` through and to say it is
HTTPS (`X-Forwarded-Proto`). That is how it is expected to behave and it is **not yet confirmed**
against a real tailnet: if the sign-in page answers `refused: host` or `refused: proto`, report it
rather than working around it.

## 8. Over an SSH tunnel

`ssh` mode needs no password and no HTTPS of its own, because SSH has already authenticated and
encrypted the connection.

```
gm-scriptorium remote set --mode ssh --port 7400 --preview-port 7401
```

When `serve --admin` starts it prints the exact tunnel command with matching local ports, like

```
ssh -L 7400:127.0.0.1:7400 -L 7401:127.0.0.1:7401 you@192.0.2.42
```

Run that on the machine you are sitting at, then open the one-time link it printed. The two local
ports must equal the ports on the server, which the printed command guarantees; a tunnel with
different local ports is refused by the panel's Host check.

## 9. Signing in

A browser that reaches the panel by its external name and has no session sees a sign-in page. The
page says what the pause rule is. Behind it:

- **Sessions** last 24 hours from sign-in and are not extended while you use them. They survive a
  restart of the panel. Each browser holds its own, as a cookie that page scripts cannot read.
- **Wrong passwords.** Five in ten minutes pauses all remote password sign-in, from everywhere, for
  fifteen minutes, and the Remote access screen says so. While it is paused the panel refuses
  attempts without even checking them. The one-time link on the machine itself is never paused.
  Restarting the panel also ends a pause.
- **Signing out.** "Sign out this device" and "Sign out every device" are on the Setup > Remote
  access screen, and `gm-scriptorium remote signout-all` does the second from the command line.
- **Open preview** from a signed-in panel goes to the preview address without asking for the
  password again.

## 10. The audit log

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

## 11. What is and is not protected

Protected:

- Requests for any name other than the panel's own configured names, including the machine's bare
  address, a name with something added to it, a wrong port, and a request with no or two `Host`
  headers.
- Any machine other than your proxy (and this computer) in `proxy` mode.
- Forged `X-Forwarded-For` and `X-Forwarded-Proto` from anything but your proxy.
- Cross-site and cross-origin changes, including a sign-in attempt made by a page on the preview
  name.
- Guessing the password (the pause), and a stolen sessions file (only digests are kept).
- The panel and its sign-in page being framed by another site.

Not protected, deliberately:

- The plain hop between your proxy and the panel (section 6).
- A machine that can pretend to be your proxy's address.
- Devices your tailnet's rules let reach `tailscale serve` (they get the sign-in page).
- A stolen session cookie, which stays valid until it expires or you sign out.
- A change to what your published site hides, made by whoever holds a signed-in session: the
  guarded `vault-config.md` editor works remotely too, and the audit log records it.
- Anyone who can keep the sign-in paused by guessing wrong on purpose (use the one-time link on the
  machine, or restart the panel).
- Password quality beyond 12 characters.

## 12. Files, permissions, backups

Everything lives in the `panel` folder next to your config file: `password.json` (a salted scrypt
hash, never the password), `sessions.json` (digests of session credentials), `audit.log`. On Linux
and macOS the folder is created readable only by you (`0700`) and each file `0600`, at creation; if
you loosen them the panel prints a warning at start and the Remote access screen shows it. On
Windows they inherit the access list of the folder they are in (the profile folder, unless you put
your config elsewhere), which is worth checking with `icacls`. The folder must be a real folder
(not a link) and is never created inside a campaign vault.

A backup of that folder, or a roaming profile that copies it, carries the password hash and the
session digests along with it. Keep the folder out of backups you share.
