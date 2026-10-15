# Add a Game master link to the player site

This guide is for a GM who has set up [remote access](../remote-access.md) to their own admin panel and wants a "Game master" link in the footer of the player site, so they can get back to the panel from a phone or another computer.

*Since 0.5.0.* The link is off until you add the table below. Nothing in the admin panel writes it, so you add it by hand.

**Read this first.** Anyone who can read the player site can read the address in the link. Choose it with care. The link also shows players that you have a panel there, and anyone can tell whether the panel is running by whether the address answers. Prefer your Tailscale address (the `.ts.net` name your computer gets on your tailnet, which only your own devices and the ones your tailnet allows can reach) to a public name on a reverse proxy. The reasons are in [ADR 0054](../decisions/0054-gm-access-from-the-player-site.md), section "6. The GM link on the published site".

## Before you start

You need a campaign you can build, and an address for your own panel that starts with `https://`. [Remote access](../remote-access.md) says how to get one, and section 7 there covers Tailscale.

## Steps

1. Find the campaign's pack folder. The [pack file reference](../reference/pack-toml.md#where-the-file-lives) says how GM-Scriptorium picks it. For a vault with no other setting, it is `_meta/scriptorium/` inside the vault.
2. Open `pack.toml` in that folder in a text editor. If the file does not exist yet, create it.
3. Add this table at the end, with your own address:

   ```toml
   [gm_link]
   url = "https://scriptorium.home.arpa"
   ```

4. Check the campaign. Use your campaign's name in place of `lease`:

   ```
   gm-scriptorium check lease
   ```

   If the address is not acceptable, `check` stops with exit code 3 and prints a line that names the `[gm_link]` table. Other exit codes are on the [exit codes page](../reference/exit-codes.md).
5. Build the site, then open any page and look at the footer:

   ```
   gm-scriptorium build lease
   ```

   <!-- screenshot: how-to/site-footer-gm-link.png -->

   The footer ends with "Game master". It opens `https://scriptorium.home.arpa/?campaign=lease`, which is the address you wrote, then `/?campaign=` and the campaign's name.

## What the address can be

GM-Scriptorium does not check that the address is your panel: it accepts any https address with no path, always labels the link "Game master" and adds `?campaign=<name>`.

An address with a path, a user name, a password, a query, or a loopback name such as `localhost` is refused, with exit code 3. The full rule is in the [pack file reference](../reference/pack-toml.md#the-gm_link-table).

## Turn it off

Delete the `[gm_link]` table from `pack.toml` and build again. With no table there is no link, and the site is built exactly as it was before you added it.

## If you are not sure

The link is public. If you do not want players to see the address, leave the table out and open the panel from your own bookmarks instead.
