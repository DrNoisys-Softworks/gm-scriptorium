# 0021. First-run setup: init creates a campaign pack and registers it, and writes nothing else in the vault

Status: accepted (2026-09-25).

## Summary

`init` is a terminal wizard that turns a freshly cloned vault into a registered campaign in seven steps, from the campaign name to an offer to run a first check. It writes only the files a campaign pack needs, only under `_meta/scriptorium/`, and never overwrites a file that is already there. On Windows, double-clicking the executable with no settings yet offers the same wizard in a console window that waits for Enter. Reusing the generator's own `init` was rejected, because it writes extra files into the vault. A flags mode lets the wizard run without prompts.

## Decision

`scriptorium init` is a terminal wizard, with a flags mode, that turns a GM's freshly-cloned vault
into a registered GM-Scriptorium campaign in seven steps: name, vault, output, title, theme,
scaffold, register-then-offer-a-check. It creates only the files a campaign pack needs, only under
`<vault>/_meta/scriptorium/`, and never overwrites one that is already there. A Windows GM who
double-clicks the exe with no arguments and no config file yet gets the same wizard offered to them,
through a console window that stays open until they press Enter, so the window never flashes and
disappears before they can read it.

### The command and its seven steps

1. **Name**, matching `^[a-z0-9][a-z0-9-]{0,62}$`. A known campaign name prefills the remaining
   steps from its existing registration.
2. **Vault**, resolved and checked with the same `locateVault` every other command uses. Its pack
   directory, `<vault>/_meta/scriptorium/`, is inspected here too: a wrong-kind entry (a file where
   a folder belongs) is refused before anything else runs.
3. **Output**, defaulting to `<vault's parent>/<name>-site`, deliberately never `out`, and never
   inside the vault (`assertSafeOutputDir`, unchanged). A folder that already exists, is non-empty,
   and does not look like a previous Scriptorium build (`index.html` plus `css/scriptorium.css`)
   is a separate gate, below.
4. **Title.** If `vault.config.json` already exists in the pack, its `siteTitle` is shown read-only
   and a conflicting `--title` is refused. Otherwise the default is the vault's own
   `_meta/vault-config.md` frontmatter `campaign:`, when it is a non-empty string; otherwise the
   campaign name.
5. **Theme**, from the 3a registry (`plain`, today). Same read-only-on-a-re-run treatment as the
   title, keyed off whether `pack.toml` already exists.
6. **Scaffold** whatever of `css/`, `images/`, `pack.toml`, `vault.config.json` is missing, in that
   order, after an explicit confirmation (interactive) or unconditionally under `--yes`.
7. **Register**, through the existing config writer, then offer a first `check` (interactively
   only; its outcome never changes `init`'s own exit code).

### Flags and `--yes`

`--name`, `--vault`, `--out`, `--title`, `--theme` each answer their step without a prompt.
`--yes` accepts every default and never touches stdin: it needs `--name` and `--vault` up front,
because there is nothing left to fall back to once prompting is off the table. `yes` joins
`args.js`'s `GLOBAL_BOOLEAN_FLAGS`, so `--yes alpha` cannot swallow a positional argument the way an
unregistered boolean flag would.

`init` refuses a positional argument and the flags `--campaign`, `--site-config` and `--json`: none
of the three means anything to a wizard that is still deciding which campaign to create. All of
these checks, plus "does a flag that needs a value have one" and the *format* of a flag-supplied
name, theme or title, run before the banner and before any prompt, a malformed `--theme haze`
fails fast, the same in flags mode or interactive mode, without ever touching stdin.

### The TTY-only no-argument offer, and the pause

`bin/scriptorium.js` already prints HELP and exits 0 on no arguments, with no TTY check anywhere
(G7): a script that runs `scriptorium` with nothing piped in has always gotten HELP, and that must
keep working. The offer sits in front of that behaviour, not instead of it: it appears only when
there is no positional argument, no `--help`/`--version`/`--notices`, no config file yet at the
resolved path, and *both* stdin and stdout are TTYs. Every one of those conditions has to hold, so
a CI job, a redirected script, or a double-click into a pipe still gets plain HELP and exit 0.

The double-click case is the reason for the fifth condition. A GM who downloads the exe and
double-clicks it in Explorer gets a console window whose process exits the instant `main()`
returns, with no arguments and no config file, that would otherwise be "print HELP, close the
window" faster than a human can read it. The offer's console window instead waits for Enter before
closing, on every exit path: after declining and after an inner `init`, whether that `init`
succeeds or throws. An **explicit** `init` (typed as a command, not reached through the offer)
never pauses, a script driving `init` headlessly should never block on a keypress nobody is going
to send.

No new exit codes: an invalid vault is exit 3, output-in-vault, a bad name/theme, or an abort are
exit 1, exactly the frozen taxonomy every other command already uses.

## The narrow exception

This is a deliberate, narrow exception to three existing rules:

- **"GM-Scriptorium never edits the vault."** `init` is the first and only command that writes
  inside one.
- **ADR 0018's "reads a pack and never writes to it."** `init` is the one writer that ADR 0018
  itself named ahead of time as the coming exception.
- **ADR 0006 reason 2, "No vault write"** (the vault is single-writer; a curation agent works it
  directly, and a second writer risks a collision with that agent's own edits). The exception holds
  here for the same reason it does not generalise: `init` runs once, by the GM themselves, before
  there is anything for a curation agent to collide with, and it creates files a curation agent has
  no reason to ever touch (`_meta/scriptorium/pack.toml`, `vault.config.json`, empty `css/` and
  `images/` folders), never a `.md` file the census or a curation pass would ever see.

The exception is scoped as narrowly as the write itself:

- **Create-only.** Nothing `init` writes is ever overwritten, edited, or deleted by `init` itself.
- **`_meta/scriptorium/` only.** Nothing outside that one directory is ever touched.
- **Written by one module.** `src/vault/packwrite.js` is the sole writer; phase 8 (editing an
  existing pack file) extends it under the same scope rather than adding a second write path.
- **`src/vault/read.js` stays write-free.** It is still, structurally, the read-only chokepoint
  every other command relies on; a one-line comment in its header now names `packwrite.js` as the
  documented exception, so nobody reading it wonders why a "never writes" module doesn't cover this
  case.

## What `packwrite` enforces, and why

`src/vault/packwrite.js` is plain `fs`, not `read.js`, it says so in its own header, because it
*is* the write chokepoint, not a consumer of the read-only one.

- **`O_CREAT|O_EXCL`** (`{ flag: 'wx' }`, `CREATE_NEW` on Windows) for every file it writes. The
  existence check and the write are the same atomic filesystem operation, so a race between an
  interactive confirmation and something else creating the same file in between, the exact shape
  of the pin's own rejected `init()`, below, can never overwrite anything. It fails instead, with
  the created-so-far list in the error, and does not clean up: no rollback (see below).
- **Non-recursive `mkdirSync`**, tolerating `EEXIST` only when the pre-existing entry is genuinely a
  directory.
- **`realpath` containment**, folded per-platform the same way `src/build/plan.js` and
  `src/vault/exclusions.js` already do: `_meta` must resolve inside the vault, the pack directory
  (if it already exists) must resolve inside the vault, and each entry's parent must resolve to the
  pack directory or inside it, checked immediately before that entry is written, a defence against
  a symlink swapped in after an earlier check in the same run, not only a hostile initial state.
- **No Markdown, structurally.** Any file entry whose name ends in `.md` (case-insensitive) is
  refused before any write happens, because the census walks every Markdown file under `_meta`
  (`src/vault/index.js`), a stray `.md` here would become a `frontmatter/missing-type` ERROR the
  next time anyone runs `check`.
- **JSON last.** Write order is `css/`, `images/`, `pack.toml`, then `vault.config.json`.
  `vault.config.json` is the pack's own existence marker (ADR 0018: `resolveSiteSource` looks for
  it, not for the directory). After a scaffold interrupted partway through, `check` reports E-CONV
 , a pack directory with no `vault.config.json`, instead of silently treating a half-written pack
  as a complete one, and a re-run of `init` fills in exactly what is still missing.
- **No rollback.** On `EEXIST` or any other I/O error, `packwrite` stops and reports what it had
  already created; it never deletes anything. A rollback here would itself be a vault delete, which
  is precisely the risk this whole exception exists to avoid taking on.

## Scaffold contents

- **`pack.toml`** is exactly `theme = "<chosen>"\n`, the identical bytes 3a's own gate proved inert
  (ADR 0019's "variant B"), so a campaign that never touches theming still builds a byte-identical
  site.
- **`vault.config.json`** comes from the pin's own scaffold template
  (`templates-scaffold/vault.config.json.tmpl`), read through a new `src/generator/pinned.js`
  export, `readVaultConfigTemplate()`. It locates the file relative to
  `require.resolve('gm-apprentice-publish/lib/processor.js')`, the same anchor
  `src/generator/sectionfilter.js` already resolves inside every packaged exe, the pin's own
  `lib/init.js:4` locates the identical file relative to its own `__dirname`, which is not a
  citation `init` can safely reuse, because `lib/init.js` itself is never required anywhere in
  Scriptorium's graph and so has no guarantee of surviving inside a pkg snapshot.
  - It is built by **JSON serialisation**, never by the pin's own `{{PLACEHOLDER}}` string
    substitution: parse the template, delete `vaultPath`, `outputDir` and `siteUrl`, set
    `siteTitle`, then `JSON.stringify(obj, null, 2) + '\n'`.
  - `siteUrl` is removed, not defaulted, because the pin's own default
    (`https://example.github.io/my-campaign`) would give the 404 page a `/my-campaign/` basePath
    (`lib/templates/four-oh-four.js:7-10`) that has nothing to do with the campaign being created.
  - `vaultPath` and `outputDir` are removed because a pack resolves both relative to itself
    (ADR 0018, D-06), not relative to wherever the pin's own template happened to point.
  - A guard refuses any `{{NAME}}`-shaped placeholder surviving anywhere in the output other than
    `siteTitle`, the one field allowed to contain literal `{{` characters, because it is the GM's
    own text, not the pin's.
  - `css/` and `images/` are created empty. Git does not track an empty directory, which is a
    residual, not a defect: the folders exist on disk for the GM to drop files into, and nothing
    about `check` or `build` requires them to be non-empty.
  - Residual, inherited from the pin's template and not addressed here: its `folderMap` publishes
    `Clues`, `Chapters` and `_World`.

## Registration

Registration goes through the same `addCampaign` and a newly-exported `writeConfigFile`
(`src/cli/config.js`) every `config add` call already uses, not a second, `init`-only
registration function, which the brief's hand-back rejected on the grounds that the two would
eventually drift apart.

**The `addCampaign` fix ("undefined means keep").** `addCampaign` used to assign `site_config` and
`output` onto the campaign block even when the caller passed `undefined` for them, and the config
emitter's `orderCampaign` then dropped any key whose value was `undefined`, so `init`, which only
ever supplies `vault` and `output`, would have silently erased an existing `site_config` on every
re-run, and `config add` on an already-registered campaign had exactly the same bug already, before
`init` existed. The fix assigns each of `vault`, `output` and `site_config` only when the caller
actually passed a value; an omitted one leaves whatever was already registered alone. This is one
fix with two call sites, not an `init`-specific patch: `test/config-write.test.js`'s R4 is the
regression test for `config add`'s own share of it.

- Every existing campaign key `init` did not itself set, `site_config`, `pack`, `serve_port`,
  `paths`, and any unrecognised key, survives a re-run untouched.
- `default_campaign` is set only when it was not already set.
- A `site_config` shadowing the new pack is never removed; `init` prints the same
  `config/pack-shadowed` message `check` already uses (`packShadowedMessage`), plus a note that the
  file was left in place. When only a `pack` key (no `site_config`) is in the way, a parallel note
  names that instead.
- **Validate, then scaffold, then register**, in that order: `addCampaign`'s pre-validated result
  and `assertConfigPathNotInVault` both run before any vault write, so a config path that resolves
  inside the very vault being registered is refused before `_meta/scriptorium/` gains a single file.

## The output-folder hazard (in scope, orchestrator addendum A1)

`build` replaces its output folder wholesale (`src/build/swap.js`), and until this addendum `init`
only checked that the output was *outside* the vault, not that it was safe to overwrite. A GM who
typed an existing, unrelated folder as the output would lose its contents on the very first build,
with no warning from `init` at all, the same hazard `config add --out` has always had, and still
has; this addendum is `init`-only.

`init` now refuses to register an output folder that (1) exists, (2) is non-empty, and (3) does not
look like a previous Scriptorium build (both `index.html` and `css/scriptorium.css` present).
Interactively, it warns that the first build will replace the folder's contents and asks
`[y/N]`, the default is **No**, and declining aborts with nothing written, the same as any other
step. Under `--yes` or a flag-driven run, there is no one to ask, so it refuses outright with a
`ConfigError` naming the folder and pointing at an empty or new one instead.

## Prompting

`src/cli/prompt.js` is a line prompter built on readline's `'line'`/`'close'` events, deliberately
never `rl.question`:

- **`rl.question` drops lines when stdin is piped.** Readline emits every line of a chunk at once,
  and only the first reaches a pending `rl.question` call; a scripted 7-line answer would silently
  lose the last six. A queue of `'line'` events, drained by `ask()` in order, cannot drop one, and
  a line that arrives before it is asked for is still delivered once it is, even after the
  underlying stream has already closed (a piped source routinely finishes reading well before
  `init` has asked every question it is going to ask).
- **Readline with no `'SIGINT'` listener pauses instead of exiting.** In terminal mode the listener
  goes on `rl` itself; off a terminal, an injected `signals.once('SIGINT')` (default `process`)
  does the same job, and is explicitly removed on `close()` so a long-lived process (this matters
  for `runInitOffer`'s own prompter more than for a one-shot `init`) does not accumulate listeners
  on `process`.
- **`ask()` never rejects.** EOF and an interrupt both resolve `null`, so a caller treats "the user
  is done answering" as one case, not two.
- **`--yes` never creates the prompter, and never touches stdin.** The prompter is created lazily,
  on the first `ask()` call that actually needs one, and only `init` itself ever closes the one it
  created, the offer's own prompter is passed in and left for the offer to close, so there is
  never more than one readline interface open on the same stdin at a time.

An `ask()` that resolves `null` at steps 1 through 6 throws `init aborted; nothing written` and
exits 1, true at every one of those points, because nothing has been written yet. Step 7's check
offer is the one exception: by then the pack and the registration both already exist, so EOF or a
decline there just skips the check silently and returns exit 0.

## Re-running

Re-run behaviour is driven entirely by **which files already exist**, never by anything read back
out of the config: an existing `pack.toml` or `vault.config.json` makes its own step read-only
(displayed, never asked), a known campaign name prefills vault and output from the registered base
block, and a conflicting explicit `--theme` or `--title` is refused rather than silently ignored,
because `init` never edits a pack file it did not just create. `left untouched: …` is printed
whenever any scaffold entry already exists, in the same four-entry order everything else uses.

## Rejected alternatives

- **The pin's own `init()`** (`lib/init.js`). Its plan writes `README.md`, `package.json`,
  `wrangler.toml` and `.gitignore` alongside `vault.config.json`, a `README.md` under `_meta`
  would become a `frontmatter/missing-type` ERROR the moment `check` ran, because the census walks
  every Markdown file there. Its own no-overwrite guard is check-then-write (`fs.access`, then
  `fs.writeFile`), which can lose exactly the race `packwrite`'s `O_EXCL` closes. Only its template
  file is reused; its writer is not.
- **Rolling back a partial scaffold on failure.** Rejected for the same reason `packwrite` has no
  delete capability at all: a rollback is a vault delete, and the JSON-last write order already
  makes a partial scaffold self-describing (`check` reports E-CONV) and self-healing (a re-run
  fills the gap) without one.
- **Editing an existing pack file.** Explicitly out of scope; phase 8's job.
- **A second, `init`-only registration function**, instead of fixing `addCampaign`. Rejected
  because the two would drift apart over time; one function, fixed once, is FR07 for both callers.
- **Scaffolding a legacy site directory outside the vault.** `init` only ever writes the in-vault
  convention pack (ADR 0018); a legacy `site_config` layout is not something `init` creates.
- **Offering `init` without a TTY.** Would break any script or CI job that currently relies on "no
  arguments, no TTY" meaning HELP and exit 0, G7's existing, load-bearing behaviour.

## Will catch

Overwrites, including the check-then-write race the pin's own `init()` was vulnerable to; a write
attempted outside the pack; a symlinked `_meta` or pack directory that resolves outside the vault;
Markdown anywhere in the pack; an invalid name, vault, output, theme or title; an output inside the
vault; a config path that resolves inside the vault being registered; a silently-ignored flag; a
leftover template placeholder; and every hang this phase specifically designed around, piped
stdin, Ctrl-C, and stdin left open.

## Will not catch, deliberately

- A process killed mid-scaffold, including a real `SIGINT` arriving during the synchronous writes
  themselves (outside `packwrite`'s own containment checks, which run first): `check` reports
  E-CONV, and a re-run completes the pack.
- A symlink swapped in between a containment check and the file open immediately after it, `wx`
  still guarantees the open itself never overwrites, but the containment check one line earlier is
  not re-verified atomically with the open.
- Empty `css/` and `images/` folders, which git will not track.
- An output folder that already holds unrelated files and *does* look like a previous Scriptorium
  build, `build` replaces it wholesale, same as it always has, and same as `config add --out`
  still does.
- A literal `~` in a typed path.
- Per-machine profile overrides shadowing the base block `init` writes.
- The shadow and pack-key notes reading anything other than the base campaign block.
- `assertSafeOutputDir`'s existing, documented lexical-only containment residual.
- The scaffold template's own `folderMap`, which publishes `Clues`, `Chapters` and `_World`.
- A theme or title changing on a re-run, by design; edit the file instead.
- Windows console behaviour, until C35 confirms it there.

## Not decided here

Browser setup (phase 8b); editing an existing pack file (phase 8); a `siteUrl` prompt; a `haze`
theme; per-machine profiles; what a double-click does when a config file already exists (still
plain HELP).
