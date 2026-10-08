# 0048. Starting a new campaign: creating a vault from the gm-apprentice scaffold

## Summary

A GM with no vault can now start a new campaign. Browser setup and `init --new-vault <folder>`
create a vault in a folder that does not exist yet or is empty, then carry on into the normal pack,
registration and first preview. The vault is the output of gm-apprentice's own vault scaffold,
captured once at a pinned upstream commit and shipped inside the executable, so the layout a GM gets
is the one gm-apprentice itself would have made. Creating it is a new kind of write, so it has its
own create-only writer that never overwrites and never deletes, and it stops and lists what it made
if anything goes wrong. The main alternative, inventing a layout of our own, is rejected below
because it would drift from the project whose layout everyone else's tools expect. One limit a GM
will hit: the starter ships for four game-system choices only (none, dnd-5e-2024, pf2e and fitd),
and a new vault's files are written by this program, so it carries a notice naming where they came
from.

Status: accepted.

## 1. What gets created and where it comes from

**The starter is upstream's output, not ours.** gm-apprentice has a script that builds a vault's
skeleton: the folders, the templates for a game system, four files under `_meta/`, a few world
pages and an empty timeline. We run that script once per game system, from a fresh clone at a pinned
commit, and keep what it wrote in `assets/vault-template/`. The executable carries that folder and
never runs Python. Files that are the same in every system are stored once under `common/`; the rest
are stored under `systems/<id>/`. A `manifest.json` records the upstream commit, the plugin version,
the licence and attribution text, the sha256 of every stored file, the places where the campaign
title and the creation date appear, and what the scaffold itself wrote for two sample runs.

**Two placeholders, nothing else.** Where the scaffold wrote the campaign name or the date, the
stored file holds `{{SCRIPTORIUM_CAMPAIGN}}` or `{{SCRIPTORIUM_CREATED}}`. They are found by
comparing runs with different names and dates, never by guessing, and the manifest declares how many
there are in each file. A leftover placeholder, or a count that disagrees with the file, is a
packaging defect and the starter refuses to load.

**One declared deviation and three additions.** The scaffold writes `site: false` in
`_meta/vault-config.md` because upstream's own publish step switches the site on afterwards. This
tool's pack step does not, so a fresh vault would refuse to build. The manifest therefore declares
one deviation, `  site: false` to `  site: true`, applied once when the starter is rendered. Three
files are written by this program and not by the scaffold: `_meta/publish-manifest.md`, which ticks
only the welcome page, `_Campaign/Welcome.md`, a player-safe page whose body says the story starts
soon and whose GM next steps sit under `## GM Notes`, and `_meta/NOTICE.txt`, which names upstream,
the commit, the author and the licence. The test for byte parity reverses the deviation before it
compares with the scaffold's own bytes. If upstream ever offers a switch that writes `site: true`,
the deviation goes away and only the manifest and the notice remain ours.

**Which systems ship.** None, dnd-5e-2024, pf2e and fitd. The Call of Cthulhu and GURPS templates
are held back: the first carry skill lists with base percentages that the rules-content gate refuses
to ship (see [ADR 0007](0007-rules-content-redaction.md)), and the second raises the same
"not for resale" question that decision already weighed. A system can be added later by capturing it
and reading its files.

**The title is never escaped.** The scaffold does not escape the name it writes, and parity with the
scaffold means we must not either. Instead the title is normalised exactly as the scaffold does
(every run of whitespace becomes one space), a few characters Python and JavaScript disagree about
are refused, and a title containing a word in braces such as `{TREE}` is refused because the scaffold
would expand it. Then the starter is rendered twice in memory, once with the real title and once with
a probe, every page's frontmatter is parsed, and the title must come back exactly as typed. A title
that breaks a page (a double quote or a backslash inside a quoted value) is refused with one line
before anything is written.

## 2. The writer

`src/vault/vaultcreate.js` is the one place a vault is created. It is in the family of the pack
writer ([ADR 0021](0021-init-first-run-setup.md)) and imports nothing from it, following the rule that one
chokepoint never imports another ([ADR 0033](0033-vaultconfig-write-exception.md)). It is create-only:

- every file is written with `wx`, so a file that appears between the check and the write is never
  replaced;
- every folder is made with a non-recursive `mkdirSync`, and a folder that already exists is a
  refusal, never tolerated;
- every path the starter lists is checked before anything exists: a plain relative path, no `..`,
  no absolute, drive or backslash form, no Windows reserved name, no trailing dot or space, none of
  `< > : " | ? *`, no control character, and no two names that differ only by case;
- every folder it makes is checked by realpath to be a new folder inside its parent, and every file
  is written only into a parent that resolves inside the new vault.

**Which folders it accepts.** The target must not exist or must be empty. Empty means nothing, or
only operating-system litter (`desktop.ini`, `Thumbs.db`, `.DS_Store`) and an `.obsidian` or `.git` folder, none
of which are ever read, changed or removed. It refuses a file, a symbolic link or junction, a
filesystem root, anything inside an existing vault (any ancestor holding `_meta/vault-config.md`),
anything inside GM-Scriptorium's own settings or panel folder, and anything that would hold them.

**Missing parent folders are created, at commit only.** A target whose parent folders do not exist is
allowed. They are created after the review, level by level: one non-recursive `mkdirSync` per level,
top first, an existing level at any point is a refusal, each level is checked by realpath, and no
level may be inside a vault. The review lists every folder that will be created, and so does the
list of what was created if the work stops. The recursive form of `mkdirSync` stays forbidden, and a
test pins that. This replaces the earlier rule that only the last folder is ever created.

**There is no rollback, deliberately.** On any failure the writer stops and its message lists exactly
what it created, in order, and says nothing was removed. A rollback would be the first deleting
vault write in the program, and the rules that fence the pack writer exist to forbid exactly that.
The folder was empty or new, so the list is all a GM needs to clean up. Upstream's own undo can also
leave files behind, so it is not a safer model. Staging the vault elsewhere and renaming it is
rejected too: renaming is forbidden here, and a rename across a network share or a synced folder is
unreliable.

A refusal or failure at any point is a `VaultUnreachableError`, so `init` exits 3 and the panel shows
the message word for word. A commit runs in this sequence: race check, validate every answer again on the
server, read the config again, render the starter in memory, create the vault, create the pack, write
the config once. If the vault cannot be created nothing else is written. If a later step fails the
vault stays and the message says so.

## 3. The pin

`scripts/vault-template.js` is a development tool with two subcommands. `capture` drives the scaffold
from a fresh clone, once per system and run, in a scratch folder outside the clone, with the scaffold
module's clock replaced by a fixed date; one control run per system uses the scaffold's own command
line to prove that replacement changes nothing else. `derive` compares the runs, refuses on any
surprise (a file set that differs, a scratch path in the output, a binary file, CRLF line ends, a
rules-content marker, a difference that is not at the name or date), and writes the template folder.
It also renders its own output back and checks the result against the scaffold's bytes. Neither runs
in `npm test`, which needs no Python.

Every upstream-origin file is therefore the scaffold's output and is never edited by hand. A change to
the starter is a new capture, a new derive and a read of every changed file, following the starter pin
bump procedure in [COLLABORATING.md](../COLLABORATING.md). The template is verified against its manifest
in `npm test`, in `npm run package` and again when the program loads it, and a starter that fails
refuses to create anything and exits 1. Every line the rules-content scan flags is recorded in the
manifest with a note a person wrote after reading it.

## 4. Licence and attribution

gm-apprentice's original content is CC-BY-SA-4.0 and its code is MIT, as
[the provenance record](../PROVENANCE.md) sets out. The starter's files are the scaffold's output, so
they carry attribution and share-alike. Each new vault contains `_meta/NOTICE.txt`, which names
upstream, the commit, the author, the licence and its URI, and the one deviation. Section 8 of
`THIRD-PARTY-NOTICES.txt` is built from the manifest, with the licence text copied from upstream at
the pinned commit. The starter holds no binary file, so the public-guard residual classes are
unchanged.

## 5. Setup and init

Browser setup and `init` share their validators, so they cannot drift. `validateSystem` and
`validateStarterTitle` live in `src/setup/validate.js` beside the others. `init` gains
`--new-vault <folder>` and `--system <id>`: the two flags exclude `--vault`, `--system` needs
`--new-vault`, and `--yes` with `--new-vault` needs `--name` and `--system` because the system is never
guessed. With neither flag, `init` asks "Do you already have a vault?" after the name. The questions
on the new path are the folder, the site title, the game system, the output folder and the theme, and
then one confirmation that says how many folders and files will be made and which parent folders do
not exist yet.

**No new route.** Adding a route would add a second write entry point and a second thing to fence.
Instead the existing routes carry the new fields: `GET /api/setup/check` accepts the fields
`newVault`, `system` and `starterTitle`, `POST /api/setup/commit` accepts the answers `newVault` (a
boolean) and `system`, and `GET /api/setup/state` reports whether this build can start a new campaign
and with which systems. `commitSetup` stays the one entry point and branches on `newVault`. The
setup-mode route list and the admin route table are unchanged, so every sweep that covers them
covers this too. The structure test that fences vault writes now names two writers, the pack writer
and this one, each reached only from `src/setup/register.js`.

## The pin

The starter is pinned at gm-apprentice commit `a0215b1f2e688c476e37d372fd647935360f00b8` (plugin version 1.10.37), fetched by clone and by tarball with identical shared trees. Per game system it holds 25 folders and 29 files (30 for fitd, which adds a crew template), 42 distinct stored files in 227,690 bytes with the manifest. Two sample runs per system are recorded, and a test renders both back to the scaffold's bytes. The scan for rules content over the starter has no hits.

**Known gap.** On this starter `check` reports no error and builds, but gives seven `census/unrecognised-type` warnings: the scaffold's entity-types page lists `meta`, `timeline` and `pc_roster` only under its required-fields section, which the recognised-type list does not read. The starter cannot be edited, so the fix belongs in the checker. A test pins the seven warnings exactly and must change when the checker does.

## The screens

Browser setup offers the same path. The start screen has a pair of choices, "I already have a vault"
(the default, so today's path stays one click) and "Start a new campaign". The pick changes the rail and
the number of questions: six on the new path (name, new vault folder, site title, game system, output
folder, theme), then the review. The vault question's two dead ends, a folder that is not a vault and a
folder that is not found, each gain a button, "Start a new campaign here instead", that carries the typed
folder across. The new vault folder question has the folder picker's Browse button (without New folder,
because the vault is made on the last screen) and draws one state for each answer the server gives:
a new folder, an empty one, one with only litter, a git repository with nothing else in it, a folder with
things in it, a file, a link, a folder inside a vault (with a button to use that vault instead), folders
above it that will be made, a OneDrive folder, and a network share. Every refusal shows the server's own
rule line, word for word. The game system question lists none and the shipped systems, with D&D 5e (2024) picked to begin with (the owner's ruling: the audience is D&D players), and a link to ask
for another. The command line never guesses a system. The review lists everything that will be created, with a disclosure for every folder and
file in the starter, and the ready screen says what to do next, including that setup does not run git.

**An empty folder may already be a git repository.** A folder that holds only a `.git` folder, with or
without `.obsidian` and operating-system litter, counts as empty, and `.git` is never read or changed.
This holds for the panel, for `init --new-vault` and for the writer itself.

## Rejected alternatives

- **Inventing our own layout.** It would drift from gm-apprentice, and every other tool that reads a
  vault would disagree with ours.
- **Copying the sample vault.** It is a campaign, with people and plots in it, not a starter, and it
  would have to be edited by hand.
- **Rolling back on failure.** It would be the first deleting vault write.
- **Running Python at run time.** The executable is Node only, and the capture is a pin-time step.
- **A full copy of the starter per system.** About seven times the files, and seven diffs to read
  for one upstream change. Shared files are stored once.
- **Generic `{{...}}` placeholders, or escaping the title.** Upstream templates can hold Obsidian's
  own `{{date}}`, and escaping breaks parity with the scaffold.
- **An `--inbox` choice.** It doubles the captures and adds a question, and this tool has no ingest
  feature.
- **A separate route to create the vault.** See section 5.

## Will catch / Will not catch, deliberately

Will catch:

- a target that is not empty, a file, a link, a filesystem root, inside a vault, or in the settings
  or panel folder, before anything is written;
- a starter file that was changed, removed or added, a placeholder count that disagrees with its
  file, and a deviation that does not apply exactly once;
- a title that cannot be written into the pages exactly as typed;
- a file or folder that appears between the check and the write, because every write is exclusive;
- a parent folder swapped for a link between the check and a write: the file's real location is checked after the write, and the failure is listed. The file is left where it landed, never removed.

Will not catch, deliberately:

- upstream output on Windows: the capture ran on Linux;
- a vault shared later without its `NOTICE.txt`;
- templates the GM later ticks to publish;
- OneDrive placeholder files that have not been downloaded;
- a race inside the folder between the check and the write, beyond what an exclusive create catches;
- a junction higher up the path than the target;
- a partial vault left after an I/O error. It is listed, never removed.

## Windows verification

`.agents/windows-verification.md` criterion C137 covers creating a vault on a local drive, in a
OneDrive folder and on a network share through the real win-x64 executable, then previewing it. It is
**OPEN**: the behaviour is verified on Linux, from source and from a Linux packaged build, and nothing
on Windows has run it.
