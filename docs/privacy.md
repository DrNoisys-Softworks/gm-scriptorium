# Privacy: what leaves your computer

This page is for a GM who wants to know what GM-Scriptorium sends over the network, and to whom.

- **The admin panel only listens on this computer, unless you turn on remote access.** By default
  `serve --admin` binds `127.0.0.1` and refuses `--host`. Reaching it from another device is a
  separate, saved, opt-in setting (see [Remote access](remote-access.md)), and the panel then
  listens only on the address you chose, plus this computer. Each launch creates a new random token
  and prints it as a link; after that the token
  lives in a cookie that page scripts can't read. The panel checks every request's Host header, and
  the Origin of every change, before it checks the token.
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
- GM-Scriptorium itself has no telemetry and no analytics. The only network call anywhere in the
  tool is `update`, and it only ever fetches its own release assets, never anything about your
  campaign.
