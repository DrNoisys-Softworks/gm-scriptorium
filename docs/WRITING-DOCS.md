# Writing the user documentation

This page is for anyone who writes or changes a page meant for GMs. It answers three questions:
what must every such page do, where does a new page go, and which pages count? The tests read the
table at the end of this page, so a page that is not in it is not checked.

## The criteria

Every page for GMs meets these.

- **Open with who the page is for.** The first paragraph says "This page is for" or "This guide
  is for", then names the reader. A test checks this.
- **Belong to one section.** The index in [README.md](README.md) groups pages as Tutorial,
  How-to guides, Reference or Explanation. A tutorial teaches by doing. A how-to guide gives the
  steps for one job. A reference page is for looking facts up. An explanation says why. A page
  that tries to be two of these is usually two pages.
- **Links resolve.** Every relative link points at a file that exists. A test checks this.
- **Command examples use real flags.** A flag in a command example is one the command accepts. A
  test checks this for every example written in backticks.
- **Say where the steps were run.** If a page has steps to follow, the table below records the
  platform they were run on. Write "Not recorded" if nobody can show where they were run. Never
  guess a platform.
- **Mark what is new.** Anything newer than the latest published release carries the marker
  `*Since X.Y.Z.*`, with the version that first ships it. Add it in the same change as the
  feature, and leave it in place afterwards.
- **Pictures.** Put every picture under `docs/images/`, the only documentation folder the public
  guard accepts pictures in. Take it from the sample campaign, on a scratch config, never from
  your own campaign. Add its row to the guard's list of named images (`NAMED_IMAGE_RESIDUAL` in
  `scripts/public-guard.js`) only after a person has looked at the picture for names, paths and
  host names. Give each picture alt text.
- **Keep paths stable.** Once a page is linked from the admin panel or from a release note, its
  path does not change. The panel's publish link already points at `docs/README.md`. If a page
  has to move, leave a stub at the old path with a link to the new one.
- **House style.** Australian English, short sentences, a term explained when it first appears,
  and no em dashes, emojis, arrows or promised dates. The rest is in the "Write for people" rule
  in the [developer guide](DEVELOPING.md).

## Where a new page goes

The pages that exist today stay where they are. A new page goes in a folder named for its
section: `docs/tutorial/`, `docs/how-to/`, `docs/reference/` or `docs/explanation/`. Then link it
from the index under that section and add a row to the table below.

## The user pages

Each page appears here once, under the same section as in the index. A test fails if the two
disagree.

| Page | Section | Steps run on |
|---|---|---|
| [The Long Lease: a sample campaign](../examples/README.md) | Tutorial | Not recorded |
| [Install, update and build from source](install.md) | How-to guides | Not recorded |
| [Using GM-Scriptorium](using.md) | How-to guides | Not recorded |
| [Trying it safely](trying-it-safely.md) | How-to guides | Linux (the Windows blocks have not been run) |
| [Remote access](remote-access.md) | How-to guides | Not recorded |
| [Backing up your vault](backing-up-your-vault.md) | How-to guides | Not recorded |
| [Image slots](image-slots.md) | Reference | No steps |
| [Privacy](privacy.md) | Explanation | No steps |
| [Why, and how this relates to gm-apprentice](about.md) | Explanation | No steps |
