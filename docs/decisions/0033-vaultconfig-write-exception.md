# 0033. `_meta/vault-config.md` gets its own write exception, backed up outside the vault

## Summary

The admin panel can now edit one line in a vault file it never touched before: the tagline shown
under the campaign title on the built site. Before this change, the panel saved that tagline into
a different file the site never reads, so nothing a GM typed there ever appeared on the live site.
The fix adds a narrow, backed up write path for exactly one key in the vault's own configuration
note, leaving the previous, unused value in place and no longer writing to it. Every edit is
checked two different ways before it is saved, and a copy of the file is kept outside the vault
first, so a mistake or a conflicting edit from another tool can always be recovered.

Status: proposed. Section 7 (per-machine panel preferences) was added after this decision was
first written. Later addenda at the tail of this document extend it.

## 1. Decision

The admin panel may replace `<vault>/_meta/vault-config.md`, and only that file, only through
`src/vault/vaultconfigwrite.js`, and only after the file's current bytes are backed up outside the
vault. In V1e-1 the only operation this chokepoint drives is one targeted edit: set or clear
`publish.theme.tagline`, the panel's own tagline field. `landingTagline` (`vault.config.json`) is
never written by the panel again, and `POST /api/pack/settings` refuses it outright.

## 2. Why

The panel shipped a defect: the Title screen's tagline field wrote `vault.config.json`'s
`landingTagline` key (`src/admin/handlers/pack.js`'s old `saveSettings`, `src/admin/packedit.js`'s
old `editVaultConfigJson`, `assets/admin/pack.js`'s old `buildTitleScreen`). The site's landing
hero never reads that key. It reads `publish.theme.tagline` out of `_meta/vault-config.md`'s
frontmatter (`gm-apprentice-publish/lib/templates/landing.js:45,63`), merged from the vault's own
`publish` block with no `vault.config.json` fallback for `theme` at all
(`gm-apprentice-publish/lib/config.js:206-267`). A GM who typed a tagline into the panel saw it in
the panel's own preview of itself and nowhere on the built site. This is unchanged by the pending
generator repin to 1.11.40: a grep of `upstream-publish-5779522-to-v1.11.40.diff` for "tagline"
finds nothing.

`vault.config.json`'s `landingTagline` is dead config, not a Scriptorium bug in the generator: the
upstream README documents it (`node_modules/gm-apprentice-publish/README.md:147`) and the scaffold
template still writes an empty one (`templates-scaffold/vault.config.json.tmpl:3`), but `lib/`
never reads it anywhere. That is worth an upstream issue; it is not filed without the owner's go,
and `init`'s own scaffold keeps writing the empty key regardless (generator-owned, out of scope
here).

## 3. What this amends

- `docs/decisions/0018-campaign-pack.md`, line 3: a pointer paragraph. The body ("GM-Scriptorium
  reads a pack and never writes to it. ADR 0021's `init` is the single, narrow exception") is not
  edited; this decision is a second, separate exception, for a file outside the campaign pack
  entirely.
- `docs/decisions/0006-post-build-page-writer.md`, line 3: a pointer paragraph naming this as a
  second narrow exception to reason 2 ("no vault write").
- `docs/decisions/0022-gm-admin-panel.md`: in-place pointer paragraphs after the FR32 raw-read
  paragraph (section 4), after the "two files" bullet list (section 6), after D03 (section 6), and
  after the include paragraph (section 6); a new `### V1e-1` subsection under section 13.

**The curation co-writer.** `_meta/vault-config.md` sits outside `_meta/scriptorium/`, the one
directory section 6's original write exception told a curation agent not to edit. A curation agent
(or any other tool) may still edit this file, same as before this decision. Four things bound the
risk of the panel and a co-writer colliding:

- the sha256 precondition (identical to `packreplace.js`'s own) turns a concurrent edit into a 409
  `changed`, never a silent clobber;
- a backup precedes every panel write, unconditionally, so the pre-edit state is always
  recoverable even if the precondition somehow passed on stale information;
- the edit itself touches only one key's own lines, so every other line, including anything a
  curation agent wrote, survives byte-identical, and a `git diff` of the result is trivial to
  read;
- the GM is expected to commit the vault to git before using the panel (section 6's own existing
  argument), which this decision does not change.

The residual: a curation write that lands *after* the panel's own save can still overwrite it. The
sha precondition only ever protects the panel's own save operation, not everything that happens to
the file afterwards. See section 10.

## 4. The chokepoint

`src/vault/vaultconfigwrite.js` exports `checkTarget` (read-only) and `replaceVaultConfigMd`.
`checkTarget` is reused by the handler before any read at all, including a dry run and the
`?include=vaultconfig` read, so nothing in this feature ever reads through a target that fails its
own containment check:

1. `realVault = realpath(vaultPath)`.
2. `_meta` must resolve to **exactly** `<realVault>/_meta`, folded per `platformFoldsCase()`. This
   is stricter than `packwrite.js`'s own `isInsideOrEqual`: a symlinked `_meta` is refused even
   when it happens to point somewhere inside the vault, because that still is not the file's real
   home, and accepting it would leave the "ancestor" case (`_meta` pointed at the vault root)
   unrefused. The single exact-equality rule catches outside, ancestor, prefix-sibling
   (`<vault>/_meta-evil`) and descendant targets at once, the same idiom section 6 of ADR 0022
   uses at the pack-dir level (`packreplace.js`'s own step 5).
3. `lstat(target)`: `ENOENT` means the file has never existed here and is never created by this
   module (`VaultConfigChangedError`); not a regular file, including a symlink, is refused
   (`ConfigError`).
4. The target's own real directory must equal `_meta`'s real path exactly, folded, independent of
   step 2, the way `packreplace.js` step 5 is independent of its own step 3.

`replaceVaultConfigMd(vaultPath, candidateBytes, { expectedSha256, backup, campaign, sleep })`:

1. `candidateBytes` must be a `Buffer` and `backup` must be a function, or this is a programming
   error (`ScriptoriumError`), never a user-facing refusal.
2. `checkTarget`.
3. A precondition read and sha comparison. A mismatch throws `VaultConfigChangedError` **before**
   any backup or temp file exists.
4. `backup(precheckBuf)` runs unconditionally, with the file's current bytes, before the temp file
   is even opened. Any throw from `backup` propagates untouched: the vault stays exactly as it was
   and no temp file is ever created.
5. A temp file at `<vault>/_meta/<TMP_PREFIX><pid>-<hex12>`, never ending in `.md` (so neither
   `readFrontmatter` nor `check`'s markdown walk can ever mistake it for real frontmatter):
   `open('wx')`, `write`, `fsync`, `close`.
6. A bounded rename retry loop, structurally copied from `packreplace.js`'s own (same
   `RETRYABLE_CODES`, `EPERM`, `EBUSY`, `EACCES`, same delays, same per-attempt re-hash before
   every rename attempt including the first, same "remove only its own temp" cleanup).
7. Returns `{ path, sha256, backup: <backup's own return value> }`.

The retry loop is a deliberate, verbatim copy rather than a shared helper: the two chokepoints
must never import from one another, so a change to one can never silently reach the other.

The candidate bytes are the whole file, preserved exactly, a BOM and CR survive a round trip,
because this is not `packreplace.js`'s LF-only, no-BOM `data` contract (that module writes
generated TOML/JSON; this one edits a human-authored Markdown file whose byte-for-byte shape
matters).

## 5. Backups outside the vault

`src/config/machinedir.js` resolves the per-machine folder from `ctx.ctxInfo.configPath` alone,
exactly as `loadConfig` resolved it at launch (`%APPDATA%\Scriptorium`, `${XDG_CONFIG_HOME:-
~/.config}/scriptorium`, or beside `--config`/`SCRIPTORIUM_CONFIG`), **never** a fallback to
`defaultConfigPath()`: a `configPath` that is not a non-empty absolute string makes editing
unavailable, full stop, rather than silently writing into the real per-machine folder from a
context that never resolved one (a unit-built `ctx`, for instance). The folder must already exist;
the panel never creates it. A machine dir that resolves inside the vault refuses editing outright
(the panel would otherwise be keeping backups inside the very thing it is backing up out of). The
reverse is fine: a vault living inside the machine dir's own tree is an ordinary, supported layout.

The campaign folder segment (`campaignSegment`) is always one safe path segment:
`campaign-<name>` when the name matches `NAME_RE` (`src/setup/validate.js`), else
`campaign_<first 16 hex of sha256(utf8 name)>`. The `campaign-`/`campaign_` prefix makes every
result non-reserved on Windows (`con` becomes `campaign-con`, not the device name `CON`); `_` is
outside `NAME_RE`'s alphabet, so the plain and hashed forms can never collide with each other.

`src/config/backups.js` writes `<machineDir>/backups/<segment>/vault-config-<stamp>-<hex6>.md.bak`
(`BACKUP_NAME_RE`), directories at `0700` and the file at `0600` on POSIX, tmp-then-rename the same
way the chokepoint itself does. Pruning keeps the newest 20 by name (the ISO-derived stamp sorts
lexically the same as chronologically), runs only **after** a successful backup, and is entirely
swallowed on failure (`src/build/run.js`'s established best-effort pattern), a prune failure must
never turn a successful save into a reported failure. Pruning only ever considers direct children
matching `BACKUP_NAME_RE` and only removes ones that `lstat` as a regular file: a foreign file or a
symlink in that folder is left alone, never counted and never deleted.

## 6. Operation (a): set or clear `publish.theme.tagline`

`src/admin/vaultconfigedit.js` is pure (no `fs` at all). `splitFile(buf)` decodes and validates the
whole file: invalid UTF-8; a first line that is not exactly an optional BOM plus `---`; no later
line matching gray-matter's own `---` close rule; mixed line endings inside the frontmatter block;
frontmatter text over the existing 64 KiB `JSON_BODY_CAP`. The `---` check runs before any parser
does, so a `---js` file (gray-matter's `javascript` engine, which `eval`s the block,
`node_modules/gray-matter/lib/engines.js:36-54`, a pre-existing property of the *other*,
unrelated read paths this slice does not touch) is refused here without ever reaching a parser.

`locateTagline` is a line-level block-mapping scanner for `publish.theme.tagline`, cross-checked
at every step against the same text's own parsed data (`Object.prototype.hasOwnProperty`): if the
scanner and the parser ever disagree about whether a key exists, that is refused, not resolved in
either direction. It refuses a flow mapping or sequence, a block scalar, an anchor/alias/tag, a
merge key, a tab in the indentation, `publish`/`theme` present but not a plain mapping, and a
current tagline value that parses as anything but a string.

`applyTagline` sets the value as a JSON-escaped double-quoted scalar (never a bare/plain scalar:
YAML's own type coercion on `yes`, a bare date, or a leading `#` is exactly the class of bug a
quoted string sides around) or, to clear, removes the tagline's own lines and prunes a `theme:`
or `publish:` header left with no remaining content. Every other line, comments, dates, sibling
keys, is carried through completely untouched: only the frontmatter's line array is ever
spliced, never re-serialised. **Never re-serialising the whole frontmatter is deliberate**: a
`js-yaml`-style dump would drop comments outright and would turn an unquoted date into a full ISO
timestamp, both real, observed failure modes of a "just re-emit the parsed object" design.

Correctness is carried by two guards, **never** the locator itself, which is why anything the
locator cannot confidently classify is refused rather than best-effort applied:

- **`semanticGuard(cur, cand, value)`**, run once per parser: `strip`s `publish.theme.tagline`
  (and prunes `theme`/`publish` if they become empty) from both the current and candidate parsed
  data, and requires the rest to be exactly, deeply equal; plus the candidate's own
  `publish.theme.tagline` must equal the requested value (or, on clear, must not be an own
  property at all).
- **`textualGuard(model, candModel)`**, independent of the locator (it is never given the plan,
  the Reviewer verifies this by reading the function signature): the head and tail must be
  byte-equal; taking the longest common line prefix and suffix, the one differing hunk's removed
  lines must contain no blank line and no comment-only line, its added lines must match only a
  `publish:`/`theme:` header or a `tagline: "…"` value line in the file's own line ending, and
  every removed line that is not a `publish:`/`theme:` header must be the tagline's own line or a
  more-deeply-indented continuation of it.

Both parsers run through `parseWithBoth`, via `pinned.generatorGrayMatter` and
`read.parseFrontmatterText`, both called through their module objects so a test can inject a throw
into either one independently. At this pin the two are the **same resolved module**
(`require('gray-matter')`), confirmed by an identity test that goes red the moment a future pin
bundles a second copy, until then, the "two parsers disagree" branch is provable only by
injection, and the tests say so.

No `check`-on-candidate runs for operation (a). That is FR-03(b)/(d) and vc1's territory (V1e-9).

## 7. Per-machine panel preferences

The panel remembers a handful of layout choices per computer: which version of each screen a GM
picked, and whether the preview pane is hidden. These live in one small file, `panel-prefs.json`,
saved beside `config.toml` in the same per-machine folder section 5 already sets up for backups.
They are never saved to the vault and never touch `config.toml` itself.

The file holds nine settings: which layout is chosen for Overview, Title, Images, Vocabulary and
the vault-config screen, whether the preview pane and the "how to use" rail are hidden, whether the
split preview follows the screen a GM is editing, and whether the preview shows a desktop or phone
view. Every setting has an allowed list of values and a default; anything else, including an
unrecognised setting name, is dropped rather than saved. A corrupt, oversized or unreadable file is
treated the same as no file at all: the panel falls back to its defaults and keeps working. The
file is capped at 4 kilobytes and written in one atomic step, so a save can never leave it half
written.

Saving a preference is available even on a read-only campaign, because it changes nothing inside
the vault.

Two other places were considered and rejected. The browser's own local storage does not work here,
because the panel's own address changes every time it starts (it always binds to a fresh port
unless one is given explicitly), so anything saved that way would be lost on the next launch.
`config.toml` was rejected because it already has its own writer with its own rules, and folding an
unrelated "what does this screen look like" setting into it would blur that boundary for no
benefit. Including preferences on the ordinary page-load response was rejected too: a browser can
have an old page-load response still in flight when a preference changes, and letting that stale
response land afterwards would silently overwrite the GM's own fresh choice.

## 8. Rejected alternatives

- **A separate, tagline-only writer.** Rejected (D-14): it would mean two writers for one file,
  duplicate containment and sha logic, and the "backup before every save" rule enforced in two
  places instead of one. Any future operation on this file (the frontmatter-text replace, the
  structured field edits, restore) goes through the same chokepoint.
- **Widening `packreplace.js`'s `REPLACEABLE_FILES`.** Rejected: it would break that module's own
  exact-pack-dir step 5 assumption (that every replaceable name lives in one directory), and would
  give one directory's writer a second, unrelated directory to know about.
- **Re-serialising the whole frontmatter** (a `js-yaml`-style parse-then-dump). Rejected: drops
  comments; turns an unquoted date into a full ISO timestamp.
- **A YAML CST/concrete-syntax-tree dependency**, to edit losslessly without a line-level scanner.
  Rejected: no new runtime dependency without saying so explicitly (CLAUDE.md), and the two-guard
  design gets the same safety property (refuse rather than silently misedit) without one.
- **Plain, unquoted scalars for the tagline value.** Rejected: YAML's implicit typing turns `yes`,
  `no`, a bare date, or a leading `#` into something other than the literal string the GM typed.
- **Backups inside `_meta/scriptorium/backups/`.** Rejected: `check` walks every Markdown file
  under `_meta`, it would add git noise to the very vault the owner is versioning, and it directly
  contradicts the owner's own instruction ("outside the vault, in Scriptorium's own per-machine
  folder").
- **Backups in `os.tmpdir()`.** Rejected: not retained across reboots on every platform, not a
  stable, discoverable location for a GM to find a backup later.
- **Reusing `src/admin/uploadname.js`'s reserved-device-name regex** for the campaign segment.
  Rejected: it is not exported, it is a denylist (not a full safe-segment guarantee), and ADR 0022
  section 7 already lists superscript and other Unicode residuals it does not cover.
- **`require.resolve('gray-matter', { paths })` in the facade**, to always resolve the pin's own
  copy dynamically rather than a literal `require`. Rejected: unproven inside a packaged `pkg`
  snapshot (the SD-17 lunr precedent this facade follows uses a literal require for the same
  reason).
- **A combined server route for the two-file (D-19) save.** Rejected: the two files already have
  two independent sha preconditions and two independent write chokepoints; a combined route would
  have to invent a new, weaker consistency story instead of reusing `runExclusive`'s existing
  one-write-at-a-time guarantee twice, sequentially, from the client.
- **Teaching the generator about `landingTagline`.** Rejected outright: the generator is pinned,
  vendored and untouched by this repo; the fix is to stop writing the dead key, not to make the
  site read it.

## 9. Will catch

- A symlinked target, a symlinked or ancestor-pointed `_meta`, the target replaced by a directory,
  and a target whose own real directory resolves somewhere other than `_meta`.
- A stale sha precondition and a concurrent edit mid-retry; a missing file (never created here).
- A backup failure: no write happens.
- Temp file names that can never end in `.md` (never mistaken for real frontmatter by another
  reader).
- The file's BOM, line-ending style and body bytes, preserved exactly across every edit.
- Comment and date loss from a tagline edit.
- A candidate that changes the file's meaning anywhere outside the one targeted key.
- The two parsers disagreeing about the same text (by injection, at this pin).
- Unsupported YAML shapes on the edit path, and a `---js` file, refused before any parser runs.
- An oversize frontmatter (the existing 64 KiB cap).
- A read-only campaign (`site_config`/pack-key): no vault-config.md write, same as every other
  vault write.
- A machine dir that resolves inside the vault.
- Hostile campaign names (`con`, `nul`, `a/b`, `..`) as backup-folder segments.
- Foreign files and symlinks surviving backup pruning untouched.
- `landingTagline` writes, refused with the ordinary unknown-field 400.
- A tampered preferences file: an unrecognised setting name, a value outside that setting's
  allowed list, an oversized file, bad JSON, or a symlink in its place. Every one of these falls
  back to the defaults rather than being saved or trusted.

## 10. Will not catch, deliberately

- **TOCTOU** between any read and the eventual write; **atomic rename over SMB is unproven** (the
  HANDOVER mapped-drive leg is the only place this gets tested against a real network share, same
  residual ADR 0022 section 6 already accepts for `packreplace.js`).
- A curation agent or any other tool overwriting a panel edit to `vault-config.md` **after** the
  save completes, the sha precondition only ever protects the save itself, not what happens next
  (section 3).
- Edits to vault pages made outside the panel are not part of any freshness signal this slice
  builds (there is none in V1e-1; V1e-3 adds one, for build staleness only).
- A comment sitting on the tagline's own line is replaced along with the value, because it is part
  of that line.
- Pre-existing directory permissions on an already-existing backups folder are never changed.
- `landingTagline` stays on disk if it was already there; this decision never removes an existing
  value, and `init`'s own scaffold (generator-owned, out of scope) keeps writing an empty one.
- At this pin (1.11.30) the two parsers are literally one module, so "the parsers disagree" is
  provable only by injection until a pin move bundles a second copy.
- Case-insensitive filesystem mounts beyond what `platformFoldsCase()` already folds for
  (win32/darwin).
- Backups roaming with a Windows roaming profile, if the per-machine folder happens to live inside
  one.
- Two panel processes saving a preference at the same moment: whichever write lands last wins,
  with no merge between them.
- A preference change that fails to save is only kept for the rest of that browser session. The
  panel announces this to screen readers next to the layout switcher; it does not retry on its
  own.

## Addendum: layout choices per screen size

Section 7's nine settings are now twenty-one. Every screen's layout choice, and where the site
preview pane sits, is remembered separately for a wide screen, a laptop-sized one and a phone,
not one shared choice for all three. A GM who picks a small live preview on a wide monitor and
then opens the panel on a laptop is no longer switched to that same choice on a screen it was
never meant for; the laptop keeps its own, independent pick. The preview pane's own placement,
alongside the page, or stacked underneath it, has the same per-size memory, and on a laptop or a
phone it defaults to sitting underneath the page rather than needing an extra click to reveal it.

The file still holds only the choices a GM actually made, never a full snapshot of every setting's
current default. A value that happens to equal its own default cannot be told apart from "never
chosen", earlier versions of the panel wrote every setting on every save, so a value on disk that
matches today's default is not proof a GM picked it on purpose. Reading an old file written that
way, one setting migrates once: a screen's single remembered choice, if it differs from what that
choice defaulted to at the time, is copied into that screen's three new per-size settings, but only
into whichever of the three a GM has not already set some other way. The very next save drops the
old, single setting from the file entirely; there is no going back to it.

**Rejected:** keeping the old, single setting alive alongside the new per-size ones, checked only
when a per-size one is absent. A live fallback chain cannot coexist with the sparse-file rule
above: every save would have to decide whether to also write out the old setting so a future reader
still sees it, which reopens the exact "a written default looks like a real choice" problem the
sparse-file rule exists to avoid. Writing every setting's current value on every save, the way the
very first version of this file did, was rejected for the same reason it was rejected in section 7:
it freezes today's defaults in place for anyone who already has a saved file, so a later change to
a default would never reach them.

**Will not catch:** two panel processes changing a layout choice for the same screen and size at
the same moment. Whichever save lands last on disk wins, exactly as section 10 already says for
every other preference.

## Addendum: editing the whole settings block, and restoring a backup

The chokepoint this document describes now drives two more operations, alongside the narrow
tagline edit section 6 already covers: replacing the whole settings block a GM typed, and
restoring an earlier version from one of the backups section 5 already keeps. Both go through the
same backup-first write, unchanged; neither can touch anything outside the file's own frontmatter.

The file's body, everything after the closing `---` line, a GM's own prose, is never read into
the browser and never rewritten. What is kept is proved at the byte level, independent of whichever
builder assembled the candidate: the candidate's own opening bytes and closing bytes are compared
directly against the current file's, at the exact byte offsets the current file's own fence lines
occupy. A builder that quietly lost or reordered a byte of the body fails that proof and nothing is
written, regardless of what the builder itself believed it produced.

Two things about the file as it is today can't be carried into an edit. A stray carriage return
inside the frontmatter, one that isn't simply part of how the file ends its lines, but sits in
the middle of a line a browser's own text editing would quietly change, refuses editing outright,
the same way an unreadable or oversized frontmatter already does. And a save always follows the
file's own line-ending style, not whatever the browser happened to send: a restore rewrites a
backup's own lines to match the current file's endings rather than bringing the backup's own
endings back.

Before anything is written, every candidate goes through the review this write exception's own
companion decision (0041) describes: the same check that `scriptorium check` runs, against the
edited copy, without writing it anywhere first; and a plain-language list of what the edit changes,
worked out by comparing the old and new settings directly. A change that could publish something a
GM meant to keep private needs an explicit tick before it can be saved; a few refusals the check
reports can never be overridden by that tick at all. A save is bound to exactly the candidate that
was reviewed, if the file on disk, or the chosen backup, changes in the meantime, the save is
refused and the GM reviews again rather than saving something nobody actually looked at.

The backups list only ever shows, and only ever restores, a backup that a fresh listing of the
folder actually finds at the moment it's asked for, never a name a request merely claims. That
folder must be a plain folder, outside the vault, and each entry in it a plain file; anything else
found there (a symlink standing in for the folder itself, or for one entry in it) is refused rather
than trusted. Each backup is labelled with which save it preceded, worked out by comparing it
against the next backup in the list (or, for the newest one, against the file as it is now),
no separate record of that is ever written, so the label is always a comparison of two real
settings blocks, not a note that could drift from what actually happened.

The vault-config.md item moves out of the panel's old read-only group entirely, into a new
Advanced group of its own: guarded, not read-only, with its own marker that changes while a GM is
actively editing it.

**Rejected:** letting a GM edit the file's body as well as its settings block. The owner's own
decision was that this file's prose is theirs to keep however they like; the settings block is the
only part another tool, or the site itself, ever reads. A separate file recording which save each
backup preceded, kept alongside the backups themselves: it would need writing and pruning in step
with the backups it describes, for a label that a plain comparison between two files already
produces without one. A YAML parser running in the browser, so the live "what this changes" panel
could work without asking the server: no such parser exists here already, and a second one,
alongside the two the server itself already runs the candidate through, is one more place the two
could quietly disagree. Re-running the check on every confirm, even when nothing about the
candidate has changed since the last review: it doubles the wait at the exact moment a GM is
waiting to save, for a result that review already produced; the save is instead bound to the exact
candidate that review covered.

**Will catch:** a candidate that doesn't keep the body byte for byte; a save or restore that races
an edit the check never saw; any candidate the check itself refuses outright, regardless of the
tick.

**Will not catch, deliberately:** a backup's label can misattribute what changed if the file was
edited by some other tool between two panel saves, the label only ever compares what's actually
on disk at each point, and has no way to know who or what made an in-between edit. On a filesystem
without `O_NOFOLLOW`, a backup file swapped for a symlink in the narrow window between a fresh
listing and the read that follows it is a residual this write exception shares with every other
TOCTOU gap already noted above.

## Second addendum: editing individual settings

The vault-config.md screen has two more layouts, "Unlock and watch" and "Fields by risk". The
second shows seven of the file's settings as ordinary fields, in three groups by how much a
mistake costs: what is hidden from players (hidden fields, headings and folders), words and picks
on the landing and not-found pages (featured characters, quick links, how many characters to show,
the not-found message), and the look (colours, fonts, cover art, genre, banners), which stays
read-only. The publish mode is also read-only there. Changing it, or anything else the fields
don't cover, stays behind "Edit as text instead".

A field save does not re-write the frontmatter. It changes only the lines of the settings that
were edited, one setting at a time, and inserts a missing setting (and a missing `landing:`,
`four_oh_four:` or `publish:` header above it) at the end of its parent, at the file's own
indentation, in the file's own line endings. Each step is checked twice before the next one runs:
a text check that nothing but that setting's own lines (or the headers just created) changed, and
no comment line or blank line was removed; and after the last step a check, once per reader the
site uses (Scriptorium's and the generator's), that every other value in the file is exactly what
it was and the edited ones are exactly what was asked for. A setting written in a form the line
editor can't safely change (an anchor, a merge key, a list spread over several lines, a block
scalar, a value continued on the next line) is refused with its name and "Edit as text instead".
What is lost is always named in the review: a comment on an edited line, and a list written in
single quotes coming back in double quotes. The request goes through the same review, check, tick,
binding, backup and write path as every other save in this file; the response never carries the
body.

The seven paths are an exact allowlist. A longer path that merely starts with an allowed one (a
sibling key, a deeper key) is refused with a 400 before any lock is taken. "How many characters"
takes a whole number from 0 to 100; the message takes 1 to 300 characters; each list takes up to
100 distinct, trimmed entries of 1 to 200 characters; none may hold a control character.

The screen also lets a GM unlock by typing the campaign's name (exact, case-insensitive, after
trimming, never a partial match) instead of ticking a box, and shows the same "what this changes"
list the review shows, read from the text as it is typed. The unlock is shared by all three
layouts, and there is one edit session at a time, either of text or of fields. Switching layout
never throws edits away: a layout that edits the other kind shows a note, "Your unsaved edits are
in the ... layout", until the edits are saved or discarded. Hidden-field chips check themselves
against the vault: a name no page carries is flagged (with a "did you mean" when a default that is
missing differs only by a trailing s), and a default the list no longer includes is called out
with a "Put it back".

**Rejected:** making the publish mode a field (it is the single most privacy-critical value in the
file, so it stays where it needs the full text and its review); re-writing the frontmatter from the
parsed data (it would lose every comment and quoting choice in the file, silently); building the
candidate text in the browser for fields (it would duplicate the locator and drop the guards).

**Will catch:** an edit that changes any line outside the edited setting; a deleted comment or
blank line; an edit that changes any other value in the file under either reader; a path outside
the seven; a prefix-sibling path; an inherited property name counted as a page's own field.

**Will not catch, deliberately:** a list written across several lines is refused rather than
edited. The hidden-field usage counts come from a fresh walk of the vault on every load of the
fields (about 40 ms for 500 pages and 170 ms for 5000 on the build host); a vault far larger than
that will feel it. A hidden-field entry typed this session is shown as new, not as unused: only
the entries the server counted can be flagged unused, and the review is the place that names the
published pages an entry would affect.
