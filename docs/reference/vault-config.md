# The vault's publish settings (vault-config.md and vault.config.json)

This page is for someone comfortable editing a text file who wants to know which settings in
`_meta/vault-config.md` and in `vault.config.json` GM-Scriptorium reads, shows or changes. The tables
below are generated from the program itself, so they list exactly the keys this version knows.

Two files hold the settings that decide what the published site hides and how it is arranged. The
vault's own file, `_meta/vault-config.md`, keeps them under a `publish:` heading. The campaign's
`vault.config.json` keeps older, flat versions of some of them, and a few of its own. The site
generator reads more keys than these tables list. The ones it reads and GM-Scriptorium does not touch
are described in
[the generator's documentation](https://github.com/AntTheLimey/gm-apprentice/tree/publish-v1.26.0).
The settings that belong to your computer are in [the settings file](config-toml.md), and the look and
words of the site are in [the pack file](pack-toml.md).

*Since 0.6.0.* An update of the gm-apprentice plugin can move the vault's settings into
`_meta/vault-config.yaml`. GM-Scriptorium reads that file instead, and the settings this page lists
for `vault.config.json` then belong in it. [Keep building after gm-apprentice moves your vault's
settings](../how-to/vault-settings-moved.md) explains what changes and how to move them.

## Where each file lives

`_meta/vault-config.md` sits inside the vault, at `_meta/vault-config.md`. It is an ordinary note with
settings at the top, between two lines of `---`.

`vault.config.json` sits in the campaign's pack folder, next to `pack.toml`. GM-Scriptorium picks that
folder in this order, and uses the first that applies:

1. The folder that holds the campaign's `site_config` file, when the campaign sets one. This is the
   older way of setting up a campaign, and it still works.
2. The folder named by the campaign's `pack` key (see [the settings file](config-toml.md)).
3. The folder `_meta/scriptorium/` inside the vault.

## How the two files combine

Three settings can be given in both files: the hidden fields, the hidden headings and the hidden
folders. GM-Scriptorium does not choose one file over the other. It takes **both lists together**,
ignoring capital letters, so an entry in either file hides that field, heading or folder. A list in
`_meta/vault-config.md` replaces the built-in list. A list only in `vault.config.json` is added to the
built-in list. A fresh build honours both lists of hidden folders, as it does the other two.

`check` compares each pair of lists and reports it when they differ (`config/exclude-fields-divergence`,
`config/exclude-sections-divergence` and `config/exclude-dirs-divergence`).

The other settings are read like this:

- **`publish.mode`** is `player` when the key is absent or empty. Any value other than `player` or
  `full` stops the build.
- **`publish.exclude_callouts`** and `excludeCallouts` in `vault.config.json`: when both are set,
  the stricter one is used. `true` beats a list, a list beats `false`, and two lists are joined. When
  neither is set, the built-in value is used. `yes` and `on` mean `true`; `no` and `off` mean `false`.
- **A setting the generator cannot read stops the build**, and `check` reports it as
  `config/settings-fault`. That covers a setting that hides something or one that says where the
  site is built or what it keeps: a misspelt name such as `exclude_sectoins`, a list written as
  one word, a folder to keep written with a slash, and a switch set to a word other than the six above.
- **`publish.overrides.fields`** is read from the vault file only.
- **The campaign's title** is `siteTitle` in `vault.config.json`. When a new campaign is made, its
  title comes from the `campaign:` line at the top of `_meta/vault-config.md`, and from the campaign's
  name when that line is empty.

## What the admin panel does with them

The panel has one field for each of seven `publish:` settings, and shows six more without a field. The
"In the panel" column says which is which. The tagline is edited on the Title & tagline screen.

Every `publish:` key can also be changed through the panel's text editor for the vault file ("Edit as
text instead"), which is guarded. Before it saves, the panel keeps a backup of the file **outside the
vault**
([ADR 0033](../decisions/0033-vaultconfig-write-exception.md)), and it runs the check on an edited copy
of the file, so you see what the change would add before anything is written
([ADR 0041](../decisions/0041-check-an-edited-copy.md)). The backups are listed in
[files and folders](files-and-folders.md).

In `vault.config.json` the panel writes `siteTitle` and nothing else, and shows `landingTagline`.

## The publish settings in _meta/vault-config.md

Keys are written under `publish:`. A key with a dot, such as `landing.max_npcs`, is a key inside a
table: `max_npcs:` under `landing:`.

<!-- BEGIN GENERATED vault-publish: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | In the panel | What it does |
|---|---|---|---|---|
| `mode` | text | player | Publish mode (shown) | Which pages are published. `player` publishes only the pages ticked in `_meta/publish-manifest.md`. The panel shows this key but has no field to change it, because it decides what players can see. Change it in the panel's text editor, or by hand. |
| `exclude_fields` | list of text | secrets, current_plan, plan_progress, gm_notes, prep_notes, reliability | Hidden fields (edit) | Frontmatter fields that are never published, on any page. Joined with `excludeFields` in `vault.config.json`; see how the two files combine, above. |
| `exclude_sections` | list of text | GM Notes, DM Notes, Player Notes, Source References, Reconciliation Context, Handoff to Reconcile | Hidden headings (edit) | Headings whose section is removed from every page, at any heading level. Joined with `excludeSections` in `vault.config.json`. |
| `exclude_dirs` | list of text | _meta, _Templates | Hidden folders (edit) | Vault folders that are skipped completely. Joined with `excludeDirs` in `vault.config.json`. A trailing slash, a leading `./` and backslashes make no difference. `check` compares the two lists and says if they differ. |
| `exclude_drafts` | on or off | false | - | Whether pages with `canon_status: DRAFT` are left out of the site. `true`, `yes` and `on` mean on, and `false`, `no` and `off` mean off. Any other value stops the build (`config/settings-fault`). |
| `exclude_callouts` | on or off, or a list of text | false | - | Whether callout blocks are removed from pages. `true`, `yes` and `on` mean on, and `false`, `no` and `off` mean off. When `excludeCallouts` in `vault.config.json` is also set, the stricter of the two is used. |
| `overrides` | table | No overrides | - | Per-page exceptions to the hidden fields, under `overrides.fields`. An entry the generator cannot read is dropped. |
| `theme.palette` | table of colours | The built-in colours | Colours (shown) | The four site colours: `primary`, `accent`, `background` and `text`. The panel shows them but has no field to change them. |
| `theme.fonts` | table | The system font | Fonts (shown) | The heading and body fonts, and where font files come from. |
| `theme.genre` | text | None | Genre preset (shown) | A genre preset for the generator's look, such as `scifi`. |
| `theme.campaign_image` | text | None | Cover art (shown) | The path, inside the vault, of the campaign picture shown at the top of the landing page. The build copies it even from a hidden folder, because you named it, and `check` then gives a WARN (`leak/l2-excluded-dir-in-output`) so you know it is on the site. |
| `banners` | table | None | Section banners (shown) | A picture at the top of a section's index page, keyed by the section's output folder, such as `locations`. A bare path, or a table with `image`, `link` and `alt`. A section with no entry uses a `_banner` picture, such as `_banner.png`, from its own vault folder. A picture or link you name here is copied even from a hidden folder, and `check` gives a WARN; a `_banner` picture in a hidden folder is an ERROR, and `build` refuses it (`leak/l2-excluded-dir-in-output`). |
| `landing` | table | The built-in landing page | - | The landing page. The keys the panel knows are listed below as `landing.` keys; the generator reads more, which its README describes. |
| `landing.featured_npcs` | list of text | None | Featured characters (edit) | Characters to feature on the landing page, by name. |
| `landing.quick_links` | list of text | None | Quick links (edit) | Pages to link to from the landing page, by name. |
| `landing.max_npcs` | whole number | 6 | How many characters to show (edit) | How many characters the landing page shows. The panel accepts 0 to 100. |
| `four_oh_four` | table | The built-in not-found page | - | The page shown for an address that does not exist. |
| `four_oh_four.message` | text | This page is not available. | Not-found message (edit) | The line of text on the not-found page. The panel accepts 1 to 300 characters. |
| `theme.tagline` | text | None | Title & tagline (edit) | The one-line hook on the landing page. It is the only tagline the site shows; `landingTagline` in `vault.config.json` is no longer used. |
<!-- END GENERATED vault-publish -->

For the other keys of the file, see
[the generator's documentation](https://github.com/AntTheLimey/gm-apprentice/tree/publish-v1.26.0).

This is the `publish:` block of the sample campaign, with the long explore text left out. The hidden
lists are in full, so copying the block loses none of the built-in ones.

```yaml
publish:
  mode: player
  exclude_sections: ["GM Notes", "DM Notes", "Player Notes", "Source References", "Reconciliation Context", "Handoff to Reconcile"]
  exclude_fields: ["secrets", "current_plan", "plan_progress", "gm_notes", "prep_notes", "reliability"]
  exclude_dirs: ["_meta", "_Templates"]
  theme:
    tagline: "Three hundred years ago a queen rented this valley from a dragon."
    campaign_image: "_attachments/campaign/long-lease-banner.svg"
  banners:
    locations:
      image: "_attachments/charts/vale-of-quillet.svg"
      alt: "A painted chart of the Vale of Quillet"
  landing:
    max_npcs: 8
    quick_links: ["The Long Lease", "Timeline"]
  four_oh_four:
    message: "This page has been cut from the ledger."
```

## The settings in vault.config.json

"Required" means the key must be there: `check`, `build` and `status` stop without it. "New campaigns
get" is what `init` writes. *Since 0.5.0.* The panel's first-run setup writes the same.

<!-- BEGIN GENERATED vault-json: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Required | New campaigns get | What it does | Changed by |
|---|---|---|---|---|---|
| `siteTitle` | text | no | - | The site's name, shown in the navigation bar and as the page title. New campaigns get the title you gave `init`, or the one in `campaign:` in `_meta/vault-config.md`. | The Title & tagline screen in the admin panel, `init`, or by hand |
| `landingTagline` | text | no | - | An older home of the tagline. The site no longer reads it; use `publish.theme.tagline`. The panel shows a value left here but never writes one. | `init` writes it empty. By hand |
| `attachmentsDir` | text | no | _attachments | The folder inside the vault that holds images. | `init`, or by hand |
| `folderMap` | table | yes | - | Which vault folder becomes which folder on the site. A map with no entries is allowed; the key must be there. New campaigns get the standard folders, and the generator's README lists them. | `init`, or by hand |
| `excludeDirs` | list of text | yes | _meta, _Templates, _resources | Vault folders skipped completely. Joined with `publish.exclude_dirs`; when that is not set, added to the built-in folders. A trailing slash, a leading `./` and backslashes make no difference. | `init`, or by hand |
| `excludeSections` | list of text | no | GM Notes, DM Notes, Player Notes, Source References, Reconciliation Context, Handoff to Reconcile | Headings whose section is removed from every page. Joined with `publish.exclude_sections`; when that is not set, added to the built-in headings. | `init`, or by hand |
| `excludeCallouts` | on or off, or a list of text | no | true | Whether callout blocks are removed. `true`, `yes` and `on` mean on, and `false`, `no` and `off` mean off. When `publish.exclude_callouts` is also set, the stricter of the two is used. | `init`, or by hand |
| `backend` | table | no | - | Switches for the generator's optional site features: `statusBar` and `inbox`. New campaigns get both off. | `init`, or by hand |
| `banners` | table | no | - | An older home of the section banners. The generator still uses an entry here for a section that `publish.banners` in `_meta/vault-config.md` does not mention. GM-Scriptorium reads it to tell a copied banner from an attachment. | By hand |
| `excludeFields` | list of text | no | - | Frontmatter fields that are never published. Joined with `publish.exclude_fields`; when that is not set, added to the built-in fields. A new campaign has none here, and relies on the defaults. | By hand |
| `outputDir` | text | no | - | Where the generator would write if you ran it alone. GM-Scriptorium takes the output folder from the settings file instead, and `build` stops if this names the same folder. *Since 0.5.0.* `--force-out` builds into it anyway. Versions before 0.5.0 use `--force` for this. New campaigns do not get one. | By hand |
| `searchEnabled` | true or false | no | - | Set to `false` to build without the site search. Absent or anything else means search is on. | By hand |
| `vaultPath` | text | no | - | Where the generator would look for the vault if you ran it alone. GM-Scriptorium uses the vault from the settings file instead, and `check` says if this names a different folder. New campaigns do not get one. | By hand |
<!-- END GENERATED vault-json -->

The generator's own reference for this file is
[its README](https://github.com/AntTheLimey/gm-apprentice/blob/publish-v1.26.0/tools/publish/README.md).

This is the sample campaign's file, with the optional keys the sample does not need left out.
A real `folderMap` needs an entry for every folder you want published.

```json
{
  "siteTitle": "The Long Lease",
  "attachmentsDir": "_attachments",
  "folderMap": {
    "Sessions": "sessions",
    "Characters/PCs": "characters/pcs",
    "Characters/NPCs": "characters/npcs",
    "Locations": "locations",
    "Factions & Organizations": "factions",
    "Items & Artifacts": "items",
    "Creatures": "creatures",
    "Events": "events",
    "_Campaign": "campaign"
  },
  "excludeDirs": ["_meta", "_Templates"],
  "excludeSections": ["GM Notes", "DM Notes", "Player Notes", "Source References", "Reconciliation Context", "Handoff to Reconcile"],
  "excludeCallouts": false
}
```

## Mistakes

- **A `vault.config.json` that is not valid JSON stops the command with exit 3.** The message names the
  file and says `is not valid JSON`, then what the parser found, such as `Unexpected end of JSON input`.
- **A missing `excludeDirs` or `folderMap` stops the command with exit 3.** The message names the
  campaign and the file and says `is missing required key excludeDirs`, or `keys excludeDirs and
  folderMap` when both are gone. A key of the wrong kind stops it the same way. See
  [exit codes](exit-codes.md).
- **A misspelt key is not an error.** `exclude_feilds:` is a key nobody reads, so nothing is hidden by
  it. Compare what you wrote with the "Key" column above.
- **A change to `_meta/vault-config.md` by hand is not backed up.** Only the panel keeps a backup, so
  copy the file first. See [backing up your vault](../backing-up-your-vault.md).
