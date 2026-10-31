# Keep building after gm-apprentice moves your vault's settings

This guide is for a GM whose gm-apprentice plugin update moved the vault's settings from
`_meta/vault-config.md` to `_meta/vault-config.yaml`. It covers how to tell, what `check` says
afterwards, and how to move the settings your campaign pack still holds into the new file, from the
command line or the admin panel.

*Since 0.6.0.*

Version 0.5.0 stops on such a vault with a message that it `keeps its settings in
_meta/vault-config.yaml`. Later versions read it. The examples use a campaign called `lease`; use
your own campaign's name.

## Words used here

- The **vault's settings file** is `_meta/vault-config.yaml` in your vault. After the move,
  gm-apprentice and the site generator read the site's settings from it, such as the title and what
  is hidden.
- The **campaign pack** is the folder GM-Scriptorium keeps your site's look in, usually
  `_meta/scriptorium/` in the vault. Its `vault.config.json` used to hold the site title, the folder
  map (which vault folder becomes which part of the site) and lists of hidden folders, sections,
  fields and callouts.
- To **carry** a setting is to move it from the pack into the vault's settings file.

After the move, the generator no longer reads those settings from the pack. Until they are carried,
your site would lose its title, and anything only the pack hid would be published.

## 1. Check the vault

Run:

```
gm-scriptorium check lease
```

If the pack still holds settings the vault's settings file does not, `check` names each one:

- `config/pack-hiding-not-carried` is an error. Something the pack hides, such as a `GM Notes`
  section, is missing from the vault's own list, so it would be published.
- `config/folder-map-not-carried` is an error. The vault's settings set no folder map and the pack
  has one, so the build would publish almost nothing and replace your players' site with an empty
  one. The carry fixes it.
- `config/folder-map-missing` is an error too. The vault's settings set no folder map, or one that
  can't be read, and the carry can't help. Set or fix `player_site.folder_map` in
  `_meta/vault-config.yaml`. If a backup holds a folder map, the message names that
  file.
- `config/pack-setting-not-carried` is a warning. A setting such as the site title is only in the
  pack, so the site uses the built-in one.
- `config/pack-setting-differs` is a warning. Both files set the same thing differently. The vault's
  value is the one used.

While there is one of these errors, `build` stops and writes nothing. That holds even when you tell
it to skip the check or build past it: it exits 3 and names the settings and the command that moves
them. [Check messages](../reference/check-messages.md) explains each id.

If your campaign uses a site config that is not the pack in the vault, the carry can't rewrite it.
The messages say so. Copy the settings into `_meta/vault-config.yaml` yourself, then run `check`.

## 2. Carry the settings from the command line

Run:

```
gm-scriptorium carry lease
```

It lists what will move, then asks. Type `y` and press Enter. Before it writes anything, it keeps a
copy of both files outside the vault, in the `backups` folder beside your settings file, and it
prints where. If it also removes a leftover `_meta/vault-config.md`, it keeps a copy of that too. `gm-scriptorium config path` shows where your settings file is.

What it does:

- **Hide lists only grow.** Entries the vault's lists lack are added. Nothing is removed from them.
- **The vault's values win.** A title or folder map the vault's settings file already sets is kept,
  and the output says so. That includes one that can't be read: fix it in
  `_meta/vault-config.yaml`.
- **Some settings stay in the pack.** A few, such as `footer`, `searchEnabled` or a changed
  `attachmentsDir`, can't be carried yet. The output names each one. Set it in
  `_meta/vault-config.yaml` yourself, and `check` stops reporting it.
- The pack's `vault.config.json` is rewritten without the settings that moved.

Run `gm-scriptorium carry lease` again and it says there is nothing to carry. Then run `check` and
`build` as usual:

```
gm-scriptorium check lease
```

```
gm-scriptorium build lease
```

If the carry stops part way, its message says what was done and names both copies. Nothing is lost.
Run `gm-scriptorium carry lease` again once the files can be written, and it finishes the job.

## Or carry them from the admin panel

1. [Open the admin panel](../using.md#quick-start) and choose the campaign.
2. Open **Title & tagline**. If the pack still holds settings, the screen lists them under
   **Settings the pack still holds**.
3. Read the list, then press **Carry these settings**. The panel keeps a copy of both files outside
   the vault first, then shows what moved and where the copies are.

If the pack or the vault's settings file changed while the screen was open, nothing is written.
Open the screen again and look at the new list before you carry.

## Change the title or what is hidden

On a moved vault the panel shows the title and tagline from `_meta/vault-config.yaml` without letting
you change them, and its **vault-config.yaml** screen only says where the settings live. Editing
them in the panel arrives in a later release. For now, change them in `_meta/vault-config.yaml`: the title is `title:` and the hide lists
are under `hide:`, both under `player_site:`. Run `check` afterwards.

## A leftover vault-config.md

If `check` warns `config/leftover-settings-file`, gm-apprentice left the old `_meta/vault-config.md`
behind. Nothing reads it. Make sure nothing in it is missing from `_meta/vault-config.yaml`, then
delete it. If it holds nothing the yaml lacks, the carry removes it for you and keeps a copy.

## Setting up a campaign on a moved vault

`gm-scriptorium init` on a moved vault sets the site title, the folder map and the hide lists in
`_meta/vault-config.yaml`, after asking. It keeps a copy of that file outside the vault first. A title
or folder map the file already sets is kept. A new vault that `init` creates for you still starts
with `_meta/vault-config.md`.

## Related

- [Troubleshooting](troubleshooting.md): what the common messages mean.
- [The command line](../reference/command-line.md): the `carry` command and its flags.
- [Keep GM-only notes off the player site](hide-gm-content.md): the ways to hide something.
