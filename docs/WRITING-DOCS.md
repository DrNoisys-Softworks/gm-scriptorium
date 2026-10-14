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
| [The settings file (config.toml)](reference/config-toml.md) | Reference | No steps |
| [Environment variables](reference/environment-variables.md) | Reference | No steps |
| [Exit codes](reference/exit-codes.md) | Reference | No steps |
| [Files and folders](reference/files-and-folders.md) | Reference | No steps |
| [The command line](reference/command-line.md) | Reference | No steps |
| [The campaign pack file (pack.toml)](reference/pack-toml.md) | Reference | No steps |
| [The vault's publish settings (vault-config.md and vault.config.json)](reference/vault-config.md) | Reference | No steps |
| [Check messages](reference/check-messages.md) | Reference | No steps |
| [Privacy](privacy.md) | Explanation | No steps |
| [How GM-Scriptorium decides what players see](explanation/what-players-see.md) | Explanation | No steps |
| [Why, and how this relates to gm-apprentice](about.md) | Explanation | No steps |

## Generated tables

Seven pages in `docs/reference/` (the settings file, exit codes, files and folders, the command line, the campaign pack file, the vault's publish settings, and the check messages) hold tables that
are generated from the code, so they cannot drift from it. A table sits between two comments that
start `<!-- BEGIN GENERATED` and `<!-- END GENERATED`. Never edit inside them. To change a table,
edit the hand-written columns in `scripts/docs-reference-text.js`, then run
`npm run docs-reference`. A column the code holds (the key lists, defaults, allowed values, exit-code
meanings, the commands that return each code, each command's exit codes, whether a flag takes a
value, the flags a subcommand accepts, whether a vault.config.json key is required, what a new
campaign gets, what the panel does with a vault-config.md key, and each check's severity and where it runs) comes from the code and cannot be overridden in
that file. `test/docs-reference.test.js`, `test/docs-reference-cli.test.js`,
`test/docs-reference-pack.test.js`, `test/docs-reference-vault.test.js` and
`test/docs-reference-checks.test.js` fail when the code
gains a key, exit code, file, command, flag, subcommand or check id the tables lack, or when a table lists
one the code lacks. The environment variables page is written
by hand, and the same test checks it against the variables the source reads.
