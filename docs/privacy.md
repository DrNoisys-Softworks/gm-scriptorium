# Privacy: what leaves your computer

This page is for a GM who wants to know what GM-Scriptorium sends over the network, and to whom.

- **The admin panel only listens on this computer, unless you turn on remote access.** By default
  `serve --admin` binds `127.0.0.1` and refuses `--host`. Reaching it from another device is a
  separate, saved, opt-in setting (see [Remote access](remote-access.md)). Behind a reverse proxy
  it listens on the address you chose plus this computer, and only your proxy and this computer can
  connect. With `tailscale serve` or an SSH tunnel it still listens on `127.0.0.1` only. Each launch
  creates a new random token and prints it as a link; after that the token lives in a cookie that
  page scripts can't read. *Since 0.5.0.* When you start GM-Scriptorium with no command, it does not print the link:
  it opens your browser with a one-time code that lives in a small file in a private folder next to
  your config, for at most a minute, and is deleted once it has been used. It prints the link only if
  the browser could not be opened. The panel checks every request's Host header, and the Origin of every
  change, before it checks the token.
- **Font requests depend on the theme and your vault config.** Campaigns set up with `init` use the
  built-in `gloam` theme, which ships its own font files inside the built site, so the theme itself
  asks no font service for anything. The `haze` theme does the same. The `plain` theme (used when a pack names no theme) ships no
  stylesheet and fetches nothing. Separately from the theme, the site generator adds its
  own Google Fonts request if your vault config names a specific font family under
  `publish.theme.fonts` (the default, `system-ui`, adds none), unless the vault config also sets
  the generator's font `source` to `local` (font files you supply from the vault) or `self-host`.
  GM-Scriptorium never downloads fonts while it builds, so `self-host` only uses fonts already
  cached in your vault, and any font that isn't cached falls back to a system font. To keep players
  from contacting any third party, use `gloam` or `plain`, and leave the vault's fonts at a generic
  family.
- **Live character sheets need a backend GM-Scriptorium does not have.** The generator can save player state (hit points, spell slots, rests) to a site backend when `publish.live_stats` is on and a KV store is wired. GM-Scriptorium builds and serves static pages only, so the switch stays off, builds emit no script that calls an API unless both are set, and if you do turn it on without a backend the generator withholds the live sheet and says so. The scripts it ships call only the site's own `/api/` paths.
- *Since 0.5.0.* **The panel checks GitHub for a newer version, and you can turn that off.** When GM-Scriptorium
  runs from its own program file (not from source, and not during first-time setup), the panel asks
  GitHub's releases API (`api.github.com`) whether a newer version is out. It asks once a day after
  a check that worked. After one that failed, it asks again the next time GM-Scriptorium starts, or a
  day later if it stays open. It also asks once when you change the update channel. GitHub sees your
  IP address, the time and the version in the User-Agent. Nothing about your campaigns, your files or
  your settings is sent, and nothing is ever installed by the notice. Turn it off with the switch in
  the Updates card at the bottom of the Overview, or by setting `check = false` under `[update]`
  in `config.toml`. With it off, no request is made. An `[update]` entry that can't be read keeps
  checks off too, and the panel says so. The Beta channel also shows releases that are still being
  checked before they become the latest.
- *Since 0.5.0.* **The Windows desktop app keeps a small log on this computer.** It is `desktop.log` in the `panel` folder
  next to your config, and it records what the app did (started, stopped, retried, a plain one-line reason
  when something failed). It is never sent anywhere, it never holds a launch code, token, password or cookie,
  and it is kept to 256 KiB plus one older copy.
- GM-Scriptorium itself has no telemetry and no analytics. `update` contacts only GitHub
  (`api.github.com`, `github.com` and its download host). GitHub sees your IP address, the time and
  the version in the User-Agent. *Since 0.5.0.* No account and no token are used, and proxy settings are not
  used. Earlier versions fetch updates through the GitHub CLI (`gh`) and need it signed in. Nothing about your campaign is sent.
