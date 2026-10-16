# The campaign pack file (pack.toml)

This page is for someone comfortable editing a text file who wants to know every setting in a
campaign's `pack.toml`, what each one does, and which screen changes it. The tables below are
generated from the program itself, so they list exactly the keys this version knows.

`pack.toml` holds the look and the wording of the site built for one campaign: its theme, its
image slots, the words it shows, and how the story timeline reads your notes. The settings that
belong to your computer, such as ports and remote access, are in
[the settings file](config-toml.md) instead.

## Where the file lives

`pack.toml` sits in the campaign's pack folder. GM-Scriptorium picks that folder in this order, and
uses the first that applies:

1. The folder that holds the campaign's `site_config` file, when the campaign sets one. This is
   the older way of setting up a campaign, and it still works.
2. The folder named by the campaign's `pack` key (see [the settings file](config-toml.md)).
3. The folder `_meta/scriptorium/` inside the vault.

The file is optional. If it is absent, every default on this page applies and the site is built
without any of your images or words.

`init` creates the file. *Since 0.5.0.* So does the admin panel's first-run setup. After that, three panel screens edit
it: Theme writes `theme`, Images writes `[images]`, and Vocabulary writes `[labels]`, `[timeline]`
and `[recaps]`. Nothing in the panel writes `[gm_link]`, so that table is by hand only.

A panel save reads the whole file and writes it back. The keys and tables it does not touch are
kept, and so are the ones it does not know. **Comments you added are lost**, and the layout may
change a little. The panel warns you about lost comments when it shows what it is about to save.
If you keep notes in the file, edit it by hand.

## Mistakes

- **An unknown key or image slot is a warning.** It is ignored, and `check`, `build` and `status`
  print a `warning:` line that names the file and the key. A misspelt key such as `theem` is
  therefore silently not applied, so read the warnings.
- **A bad value stops the command.** A theme the program does not know, a value of the wrong kind,
  a label that is too long, or an image path that breaks the rules stops `check`, `build` and
  `status` with exit 3, and the panel shows the same message. See [exit codes](exit-codes.md).

## An example

This is a complete file that sets every table once, with the image slots filled from the sample
campaign. A file that sets only a theme is just as valid.

```toml
theme = "gloam"

[images]
hero = "vault:_attachments/campaign/long-lease-banner.svg"
ground = "vault:_attachments/campaign/long-lease-banner.svg"
paper = "vault:_attachments/campaign/parchment.svg"

[labels]
learned_lens = "What the Wardens learned"
group_pc = "The Wardens"

[timeline]
weights = ["detail", "scene", "big moment"]
session_token = '\bEp(\d+)\b'

[[timeline.kinds]]
key = "clash"
label = "Clash"
glyph = "fight"
aliases = ["battle"]

[timeline.columns]
session = ["episode"]

[recaps]
learned_heading = "Lessons gathered"

[gm_link]
url = "https://scriptorium.home.arpa"
```

Use single quotes for a pattern, so the backslashes are taken as they are.

## Top level

The theme is the look of the site. `plain` is what a pack file with no `theme` gets, and `init`
offers `gloam` to a new campaign. The reasons are in [ADR 0019](../decisions/0019-themes-image-slots-and-asset-step.md),
section "Registry and `plain`", and [ADR 0032](../decisions/0032-base-theme.md), section "2. Decision".

<!-- BEGIN GENERATED pack-top: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `theme` | text | plain | `gloam`, `haze`, `plain` | The look of the built site. A theme the program does not know stops the build. New campaigns made by `init` get `gloam`; a pack file with no `theme` gets the default shown here. | The Theme screen in the admin panel, `init`, or by hand |
| `images` | table | No images | - | The art for the image slots. See the `[images]` section below. | The Images screen in the admin panel, or by hand |
| `labels` | table | The built-in words | - | The words the built site shows, such as the name of the party. See the `[labels]` section below. | The Vocabulary screen in the admin panel, or by hand |
| `timeline` | table | The built-in timeline words | - | How the story timeline reads your timeline page. See the `[timeline]` section below. | The Vocabulary screen in the admin panel, or by hand |
| `recaps` | table | The built-in heading | - | How recaps are read. See the `[recaps]` section below. | The Vocabulary screen in the admin panel, or by hand |
| `gm_link` | table | Absent means no link | - | *Since 0.5.0.* Adds one plain "Game master" link to the footer of every published page. See the `[gm_link]` section below. | By hand |
<!-- END GENERATED pack-top -->

## The [images] table

Each key is an image slot, a named place for your art. A slot shows only where a theme or your own
`overrides.css` draws it, and [image slots](../image-slots.md) says which do, and what size to
prepare each image at.

A value is a path inside the pack folder, or `vault:` followed by a path inside your vault. Write
it with forward slashes, even on Windows. It cannot be an absolute path, a web address, or contain
`..`, and a `vault:` path cannot point into `_meta`. The file must exist. The rules are in
[ADR 0019](../decisions/0019-themes-image-slots-and-asset-step.md), section "Slots and validation".

<!-- BEGIN GENERATED pack-images: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `404` | text | Empty | - | The picture on the page players land on when a link goes nowhere. Write the key in quotes, as `"404"`. | The Images screen in the admin panel, or by hand |
| `hero` | text | Empty | - | The landing banner: a wide picture for the top of the landing page. A slot is a place for your art, and it shows only where a theme or your `overrides.css` draws it. See [image slots](../image-slots.md). | The Images screen in the admin panel, or by hand |
| `ground` | text | Empty | - | The page backdrop: a picture fixed behind your pages. | The Images screen in the admin panel, or by hand |
| `paper` | text | Empty | - | The paper texture: a small image repeated behind text and cards. | The Images screen in the admin panel, or by hand |
| `crest-frame` | text | Empty | - | The emblem frame: a decorative border for faction crests. Use an image with a transparent background. | The Images screen in the admin panel, or by hand |
| `portrait` | text | Empty | - | The character portrait: an upright picture, cropped to fill a 3 to 4 frame. | The Images screen in the admin panel, or by hand |
<!-- END GENERATED pack-images -->

## The [labels] table

Each key renames one word or heading the built site shows. A value is plain text of 1 to 200
characters. A key you leave out keeps the default shown. Setting a label to its default changes
nothing in the built site. See [ADR 0020](../decisions/0020-labels-and-vocabulary.md), section
"3. The `pack.toml` tables".

<!-- BEGIN GENERATED pack-labels: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `learned_lens` | text | What the party learned | - | The name of the timeline view that shows what the party learned. | The Vocabulary screen in the admin panel, or by hand |
| `learned_legend` | text | Learned | - | The timeline legend entry for a point where the party learned something. | The Vocabulary screen in the admin panel, or by hand |
| `story_lens` | text | The story | - | The name of the timeline view that shows the story. | The Vocabulary screen in the admin panel, or by hand |
| `chapter` | text | Chapter | - | The word used for a chapter on the timeline. | The Vocabulary screen in the admin panel, or by hand |
| `recap` | text | Recap | - | The word for a session recap. | The Vocabulary screen in the admin panel, or by hand |
| `recap_learned_link` | text | What the Party Learned | - | The text of the link from a recap to what the party learned. | The Vocabulary screen in the admin panel, or by hand |
| `same_recap` | text | Same recap | - | The label for other events in the same recap. | The Vocabulary screen in the admin panel, or by hand |
| `connections_heading` | text | Connections | - | The heading above the connections section of a page. | The Vocabulary screen in the admin panel, or by hand |
| `group_tie` | text | Ties | - | The heading for the group of ties between two pages. | The Vocabulary screen in the admin panel, or by hand |
| `group_named` | text | Named by | - | The heading for the group of pages that name this one. | The Vocabulary screen in the admin panel, or by hand |
| `group_pc` | text | The party | - | The heading for the player characters, usually the party. | The Vocabulary screen in the admin panel, or by hand |
| `group_npc` | text | People | - | The heading for the non-player characters. | The Vocabulary screen in the admin panel, or by hand |
| `group_faction` | text | Factions | - | The heading for factions. | The Vocabulary screen in the admin panel, or by hand |
| `group_location` | text | Places | - | The heading for places. | The Vocabulary screen in the admin panel, or by hand |
| `group_thing` | text | Things | - | The heading for things, such as items. | The Vocabulary screen in the admin panel, or by hand |
| `group_event` | text | Events | - | The heading for events. | The Vocabulary screen in the admin panel, or by hand |
| `group_other` | text | Other | - | The heading for pages that fit none of the other groups. | The Vocabulary screen in the admin panel, or by hand |
<!-- END GENERATED pack-labels -->

## The [timeline] table

This table tells the story timeline how to read your timeline page. Every key is optional. See
[ADR 0020](../decisions/0020-labels-and-vocabulary.md), section "3. The `pack.toml` tables" and
section "6. Regular expressions". The two patterns are limited to 512 characters. A pattern is
read as a JavaScript regular expression, and the default shows its source.

<!-- BEGIN GENERATED pack-timeline: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `kinds` | list of tables | fight, meeting, discovery, journey, backstory | - | The kinds of story point, written as `[[timeline.kinds]]` entries. Your list replaces the built-in kinds as a whole, it is not added to them. See the `[[timeline.kinds]]` section below. | The Vocabulary screen in the admin panel, or by hand |
| `weights` | list of text | aside, scene, turning point | - | The three words for how much a story point matters, from lightest to heaviest. There must be exactly three. | The Vocabulary screen in the admin panel, or by hand |
| `session_token` | text | `\bS(\d+)\b` | - | A pattern that finds a session number in the text, such as the 3 in S3. It needs at least one capture group, and the first group must catch the number. The pattern is case-sensitive. | The Vocabulary screen in the admin panel, or by hand |
| `segment_units` | text | `\b(week\|day)\s+(\d+)\b` | - | A pattern that finds a stretch of time, such as week 2. It needs at least two capture groups: the unit word, then the number. The pattern ignores case. | The Vocabulary screen in the admin panel, or by hand |
| `columns` | table | The built-in column names | - | The column names the timeline page uses in your vault. See the `[timeline.columns]` section below. | The Vocabulary screen in the admin panel, or by hand |
<!-- END GENERATED pack-timeline -->

### The [[timeline.kinds]] entries

Each entry is a kind of story point. List one `[[timeline.kinds]]` table for each kind you want, 1 to
32 in all. The list replaces the built-in five (fight, meeting, discovery, journey and backstory), so
write every kind you still want. The panel does the same: change one kind and it writes the whole
set. See [ADR 0020](../decisions/0020-labels-and-vocabulary.md), section "4. Kinds" and section "5. Glyphs".

<!-- BEGIN GENERATED pack-timeline-kinds: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `key` | text | Required | - | The kind's name as it is written in your timeline table. A lower-case word of up to 32 characters: a letter, then letters, digits or hyphens. `learned` and `none` are reserved. No two kinds, or their aliases, may share a name. | The Vocabulary screen in the admin panel, or by hand |
| `label` | text | The key | - | The word shown for the kind on the site. | The Vocabulary screen in the admin panel, or by hand |
| `glyph` | text or drawing | The built-in glyph named like the key, if there is one; otherwise none | `backstory`, `discovery`, `fight`, `journey`, `learned`, `meeting` | The small picture for the kind. Use one of the built-in names, or SVG path data starting with `M` or `m`, at most 1024 characters. | The Vocabulary screen in the admin panel, or by hand |
| `aliases` | list of text | None | - | Other names a Kind cell may use for this kind. Up to 16. | The Vocabulary screen in the admin panel, or by hand |
| `before` | true or false | false | - | Marks the kind as something that happened before the story began. Such points sit at the start of the timeline. | The Vocabulary screen in the admin panel, or by hand |
<!-- END GENERATED pack-timeline-kinds -->

### The [timeline.columns] table

Each key is a column of the timeline table in your notes. Its value is a list of 1 to 16 header
names, each up to 64 characters, that the column may go by. Your list replaces the default for that
column, so include the default name if you still use it. No two columns may use the same name.

<!-- BEGIN GENERATED pack-timeline-columns: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `title` | list of text | title | - | The names the Title column of the timeline table may go by. | The Vocabulary screen in the admin panel, or by hand |
| `kind` | list of text | kind | - | The names the Kind column may go by. | The Vocabulary screen in the admin panel, or by hand |
| `weight` | list of text | weight | - | The names the Weight column may go by. | The Vocabulary screen in the admin panel, or by hand |
| `place` | list of text | place | - | The names the Place column may go by. | The Vocabulary screen in the admin panel, or by hand |
| `in_game` | list of text | in-game | - | The names the in-game date column may go by. | The Vocabulary screen in the admin panel, or by hand |
| `when` | list of text | when | - | The names the When column may go by. | The Vocabulary screen in the admin panel, or by hand |
| `real_world` | list of text | real-world | - | The names the real-world date column may go by. | The Vocabulary screen in the admin panel, or by hand |
| `what` | list of text | what | - | The names the What column may go by. Its text becomes the body of the timeline card. | The Vocabulary screen in the admin panel, or by hand |
| `session` | list of text | session | - | The names the Session column of the second table, the one that anchors what the party learned, may go by. | The Vocabulary screen in the admin panel, or by hand |
| `learned` | list of text | learned | - | The names the Learned column of that second table may go by. | The Vocabulary screen in the admin panel, or by hand |
| `after` | list of text | after | - | The names the After column of that second table may go by. | The Vocabulary screen in the admin panel, or by hand |
<!-- END GENERATED pack-timeline-columns -->

## The [recaps] table

<!-- BEGIN GENERATED pack-recaps: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `learned_heading` | text | what the party learned | - | The heading, inside a recap, above the list of what the party learned. The match ignores capital letters. | The Vocabulary screen in the admin panel, or by hand |
<!-- END GENERATED pack-recaps -->

See [ADR 0020](../decisions/0020-labels-and-vocabulary.md), section "3. The `pack.toml` tables".

## The [gm_link] table

Leave this table out and the published site has no link. Put it in and every published page gets
one plain "Game master" link in its footer. Anyone who can read the site can read the address, so
choose it with care. The reasons and the limits are in
[ADR 0054](../decisions/0054-gm-access-from-the-player-site.md), section "6. The GM link on the
published site". If the table is there but `url` is missing or wrong, the build stops with exit 3.

<!-- BEGIN GENERATED pack-gm-link: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
| Key | Type | Default | Allowed values | What it does | Changed by |
|---|---|---|---|---|---|
| `url` | text | Required when the table is present | - | *Since 0.5.0.* The address the "Game master" link opens. It must start with `https://` and be a bare address with no path, no user name and no loopback address. Anyone who can read the site can read this address. | By hand |
<!-- END GENERATED pack-gm-link -->
