# How GM-Scriptorium decides what players see

This page is for a GM who wants to know how a build chooses which pages go on the player site, what it cuts from the pages that do, and what the leak checks can and cannot tell you. It explains the rules. For the commands, see [Using GM-Scriptorium](../using.md).

The pages are chosen and trimmed by the site generator's rules at the version GM-Scriptorium uses. This page describes them in words, so it stays true when a value in a list changes. The exact values are in the [upstream generator](https://github.com/AntTheLimey/gm-apprentice).

## Which pages publish

Each note in your vault gets one answer, publish or not, from the first rule below that applies.

1. **It sits in an always-excluded folder.** These are `_meta`, `_Templates`, `_templates` and `personal`. Nothing in them is ever published, whatever your settings say.
2. **Its folder is not in the folder map.** The generator is not told where such a page belongs, so it is left out and flagged for you to decide.
3. **It has no `type:` in its frontmatter.** It is left out and flagged for you to decide.
4. **It is a draft and drafts are switched off.** A note marked `canon_status: DRAFT` is left out when `exclude_drafts` is on.
5. **It is prep, or a scene that did not happen.** Notes marked as prep or not yet played, by their status, stage or source fields, and scenes that were cut or skipped, are left out. This rule is off in `full` mode, and a page listed under Publishing in the manifest overrides it.
6. **The manifest does not list it.** In player mode, `_meta/publish-manifest.md` is an allowlist. A page under Excluded or Needs Decision, or in no section at all, stays out. Only a page under Publishing goes on.
7. **It says not to publish.** `publish: false` and `publish: none` are honoured in every mode, and a manifest entry does not override them.
8. **Otherwise it publishes.**

Without `_meta/publish-manifest.md` there is no allowlist, so `check` reports an error (`leak/l1-no-manifest`) until you add one.

Separately, the folders named in `excludeDirs` in `vault.config.json` and in `publish.exclude_dirs` are never read. The two lists are joined. The settings are listed in [the vault's publish settings](../reference/vault-config.md).

## What is removed from a published page

A page that publishes is still trimmed before a player sees it. These are removed:

- Sections under the headings named in `exclude_sections`. The two config files' lists are joined. The generator's own default list applies only when neither file lists any.
- Blocks wrapped in `<!-- gm-only -->` or `<!-- spoiler -->` comments, and dataview blocks.
- Callouts of the kinds named in `exclude_callouts`.
- Frontmatter fields named in `exclude_fields`, and in the page's own `publish_exclude_fields`. A setting under `overrides.fields` can bring back a field named in `exclude_fields`, but never one hidden by `publish_exclude_fields`.
- Relationship edges marked `gm_only: true`.
- Obsidian `%%comments%%`. GM-Scriptorium removes these before the generator runs ([ADR 0044](../decisions/0044-obsidian-comments-withheld.md)).

A page marked `publish: stub` keeps only the sections you chose to include.

## Withheld names

What keeps a page off the site is the rules above, not the `withheld: true` marker. In the sample campaign, the manifest lists Ottoline Pardew under Excluded. The marker, in her own page's frontmatter, tells the leak checks that her name must not appear on any page a player can read.

The name check looks for the page's file name, its `title`, and each alias that is distinctive. A name is searched for only if it is at least 3 characters long. An alias is skipped if it starts with a lower-case letter, or with "the", "a" or "an", because words like that turn up in ordinary sentences.

## The checks and the build

- `check` reads your vault and exits with code 2 if it finds any error.
- `build` runs the same checks first and refuses to go on if they find an error, unless you pass `--force-check`. That flag does not override every finding; a few, such as notes with executable frontmatter ([ADR 0034](../decisions/0034-executable-frontmatter-guard.md)), always stop the build.
- It then builds the site in a staging folder and scans what the generator wrote. A leak there stops the build, and nothing overrides that scan ([ADR 0055](../decisions/0055-force-split.md)).
- Comment text in the output, and the GM link marker, are refused separately.
- The swap into place is atomic, so a refused build leaves your live site as it was.

## What the leak checks cannot see

The checks are proxies for a leak, not a judgement of one. A clean run is not clearance: "They cannot catch forward-looking prep prose that names nobody hidden, or GM-facing framing under a heading nobody listed. A clean result here is not clearance to share this site with players." Read the site yourself before you share it. The checks do not see:

- Hidden pages that are not marked `withheld: true`. They search for the names of withheld pages only.
- Prose that gives a secret away without naming anyone.
- GM framing under a heading nobody listed.
- Names shorter than 3 characters, and generic aliases.
- Names split by markup, and text inside images.
- A site edited after the build, or built by another tool.
- Output that does not exist yet. The built site is scanned only once you build it.

For the full list, see [ADR 0009](../decisions/0009-output-leak-scan.md), which describes what the output scan will and will not catch.

## Try it

- Browse the [hosted sample site](https://drnoisys-softworks.github.io/gm-scriptorium/) to see a built campaign.
- Open the [leak demo](https://drnoisys-softworks.github.io/gm-scriptorium/leak-demo.html) to see what a leak check protects.
- Plant a sentence naming the withheld NPC in the sample, and watch `check` refuse it. The steps are in [The Long Lease: a sample campaign](../../examples/README.md).
