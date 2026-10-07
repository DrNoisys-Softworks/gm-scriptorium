# 0018. The campaign pack: site inputs may live in the vault, output may not

Status: accepted (2026-09-25).

## Summary

A campaign's site settings, stylesheet and, later, images may now live inside the campaign's own vault, in a folder called a campaign pack, by convention `_meta/scriptorium/`. Scriptorium reads a pack and never writes to it, apart from the create-only `init` wizard in ADR 0021. The old rule becomes: inputs may live in the vault, but the built site may never be written inside it. Nothing under `_meta` is ever published. The rule that a vault has a single writer is kept, because a read-only folder adds no second writer.

## Decision

A campaign's site inputs (`vault.config.json`, `css/overrides.css`, and later `pack.toml` and
`images/`) may now live inside the campaign's own vault, in a **campaign pack**: a directory holding
`vault.config.json`. By convention that directory is `<vault>/_meta/scriptorium/`; the new `pack`
config key can point anywhere instead.

GM-Scriptorium reads a pack and never writes to it. ADR 0021's `init` is the single, narrow
exception, and it is create-only (never overwrites an existing pack file).

Output may still never be inside the vault. Nothing about this decision changes that.

## Amending requirement 8.1

The original rule, quoted in `src/cli/check.js:17-18`, was "site/ must be outside vault/". It existed
to keep output, and any second writer, out of what is meant to be a single-writer vault. A read-only
input directory raises neither concern: nothing else writes there, and it is never the destination of
a build.

The amended rule is that **inputs may live in the vault, output may not**. `assertSafeOutputDir`
(`src/build/plan.js:92-115`) is unchanged and keeps enforcing the output side; nothing about how it
refuses an unsafe output directory needed to move.

## Why `_meta` never publishes (G1, corrected citations)

A worry any "put more stuff in the vault" change raises: does putting a pack under `_meta/` risk it
leaking into the published site? No, for two independent reasons, both already true before this ADR:

- `scanVaultReport` (`src/vault/scanner.js:43-133`) reads only `.md` files (`:74`) and skips
  `excludeDirs` and any dot-directory (`:72`). It does not consult a separate always-excluded-dirs
  list; there isn't one at this layer.
- The real block is `decidePage`: the always-excluded segment list at
  `src/generator/publish-decision.js:45`, the segment match at `:76-80`, and the verdict at
  `:136-137`. The verdict is computed at `src/cli/build.js:240` and applied at `:289`. `_meta` (along
  with `_Templates`, `_templates` and `personal`) is on that list, so any markdown under it is dropped
  before it reaches the page walk, independent of the scanner's own dot-dir/exclude-dir skip above.
- `scanAttachments` walks only the configured `attachmentsDir`, never `_meta`.

Two opt-in exceptions already existed, and neither one is new here: `theme.campaign_image`
(`src/cli/build.js:515-531`) and section banners (`:806-843`) will copy any in-vault path the GM
explicitly names, `_meta` included, because the GM asked for that specific file. L2 does not
reconstruct `campaign_image` from a built site (`src/checks/leak/l2.js:93-97`), a pre-existing,
unrelated residual.

## Output refusal is compatible (G2)

- `assertSafeOutputDir` compares only the final output directory against the vault.
- The staging directory is a sibling of the final output directory (`src/build/plan.js:123-129`), not
  inside the vault.
- `mirrorSiteInputs` (`src/build/stage.js:41-52`) writes only into staging.
- The generator's own `configDir` is the staging directory (`src/build/run.js:64-68`).
- With no `outputDir` in the site config, the collision guard (`siteConfigOutputDirCollision`,
  `src/build/plan.js:187-191`) returns `null`: there is nothing to compare against.
- Residual: containment here is checked lexically only (`src/build/plan.js:100-108`'s own documented
  limit). This ADR does not change that.

## Reads (G3)

Pack reads go through `src/vault/read.js`'s new `readText()`, called through the module object
(`read.readText(...)`, never destructured), so a test can spy on the chokepoint. The structural test
at `test/vault-read.test.js:126-157` scans `read.js`'s own source for write-capable calls and keeps it
write-free; this ADR adds no exception to that.

Two named exceptions keep plain `fs`, unchanged by this ADR:

- `src/build/stage.js`'s `mirrorSiteInputs`, which copies pack files into staging byte for byte. It
  stays untouched so its own change-detector test (`test/build-site-mirror.test.js:135`) still holds.
- The legacy `site_config` read (`src/cli/check.js:33-56`, `loadSiteConfig`), which lives outside the
  vault and was never routed through the vault chokepoint in the first place.

## Resolution order

Resolution runs inside `resolveVaultContext`, right after `locateVault`, never in
`src/config/resolve.js`, which is documented not to stat anything (`resolve.js:10-11`).

The sequence is: `site_config` (including `--site-config`, which `src/cli/args.js` merges into the same
key) > the `pack` key (base campaign block, or a matched machine profile) > the convention directory
`<vault>/_meta/scriptorium/`. A pack exists if and only if its directory holds `vault.config.json`; a
bare directory with no such file is not a pack.

Failures and their messages (each a one-line `ConfigError`, absolute paths, no product name; the exit
mapping is unchanged: a `ConfigError` prints one line and exits 1):

| Case | Message |
|---|---|
| nothing configured at all | `campaign "<c>" has no site config: site_config is not set, pack is not set, and <vault>/_meta/scriptorium/vault.config.json does not exist` |
| explicit `pack` directory missing | `campaign "<c>": pack directory does not exist: <packDir>` |
| explicit `pack` directory has no `vault.config.json` | `campaign "<c>": pack directory <packDir> has no vault.config.json` |
| convention directory exists with no `vault.config.json` | `campaign "<c>": <vault>/_meta/scriptorium exists but has no vault.config.json` |
| pack JSON does not parse | `campaign "<c>": <jsonPath> is not valid JSON: <message>` |
| pack JSON parses to something other than an object | `campaign "<c>": <jsonPath> must contain a JSON object` |

An explicit `pack` key that fails never falls through to the convention: a config key that silently
doesn't apply is exactly the class of bug FR-17 already existed to kill for `site_config`.

Profiles merge per key, the same as every other campaign field, so a machine profile can switch off a
base `site_config` with `site_config = ""`; an empty string counts as unset, the same convention
`src/cli/check.js`'s pre-existing falsy check on `site_config` already used.

The `pack` key is a new optional string field. No `config_version` bump is needed: an older
GM-Scriptorium build treats an unrecognised campaign key as a warning and preserves it unmodified on
rewrite (`src/config/load.js:74-78`, `src/config/write.js:39-42`); it simply never looks for a pack.

**Rejected alternatives:**

- **Pack wins over `site_config`.** The moment a pack is committed to a shared vault repo, every
  machine still configured with `site_config` would silently switch which site inputs it builds from,
  while any machine still running an older, pack-unaware build keeps reading the old ones, with no
  message to either side. `site_config` winning keeps that switch a deliberate, per-machine edit.
- **Falling through from a broken explicit `pack` to the convention.** Already covered above; the
  precedent is FR-17's fix for exactly this shape of silent-fallback bug.
- **Resolving inside `src/config/resolve.js`.** That module is documented not to touch the filesystem
  at all; deciding whether a pack directory or its JSON file exists requires exactly that.

## `config/pack-shadowed`

A WARN, category `config`, that fires only when `site_config` wins and the pack that would otherwise
have been used (the `pack` key's directory if set, else the convention directory) exists. It names
both paths, in the message and in `data: {siteConfigPath, packDir, packSource}`. `build` and `status`
print a matching human-only `note:` line whenever it fires; neither adds a JSON envelope field for it.

It is never reported when a pack wins (there is nothing being shadowed), and never reported when no
pack exists at all (there is nothing to shadow with).

Rejected: probing every directory that could conceivably hold a pack. The shadow-probe only looks at
the one candidate that would actually have won if `site_config` were removed; probing more than that
could produce two warnings pointing at two different directories, one of which would never actually be
used even if `site_config` were removed.

## `vaultPath` and `outputDir` in a pack

No special handling. Both resolve relative to the pack directory, exactly the way they already resolve
relative to a legacy site config's own directory. The pre-existing FR-18 mismatch rule
(`config/site-vault-path-mismatch`) is unchanged and applies identically to a pack-sourced
`vaultPath`.

## D-06, decided by the owner 2026-09-25: keep `outputDir`

Two options were on the table for what a pack's `vault.config.json` should do with `outputDir`:

- **Option A**, drop it entirely. That keeps a pack free of any machine- or deployment-specific layout
  path, but it disarms `siteConfigOutputDirCollision` (`src/build/plan.js:187-191`), the guard that
  refuses (without `--force`) a build whose resolved output happens to equal the site config's own
  declared `outputDir`. For a deployment whose `outputDir` names a directory another process treats as
  a frozen baseline, that guard existing at all matters more than the pack staying free of layout
  paths.
- **Option B**, chosen: keep `outputDir`, resolved relative to the pack directory the same as
  `vaultPath` is. The guard keeps working, and a build that would land in that directory still needs
  `--force`.

**The value must be rewritten during migration, never copied verbatim.** A legacy site config's
`outputDir` is relative to that site config's own directory. For a layout of the shape
`<campaign root>/{vault, site, out}`, a legacy value of `"../out"` becomes `"../../../out"` once it
lives at `<campaign root>/vault/_meta/scriptorium/vault.config.json` instead of
`<campaign root>/site/vault.config.json`, one extra `_meta/scriptorium` level down from the vault
root, itself one level below the campaign root. Copied unchanged, `"../out"` would resolve to
`<vault>/_meta/out`, silently re-aiming the guard at a directory nobody protects, with no error raised
anywhere.

The cost of Option B is that a pack now carries one layout-shaped path. On a machine whose actual
layout differs, that path simply compares against a directory nobody ever builds into: harmless, not a
false refusal of a legitimate build.

## Generic migration procedure

(Placeholders throughout; no real campaign name, path or count appears here or in the private runbook
this ADR summarises.)

1. Make sure every machine that builds this campaign is already running a pack-aware GM-Scriptorium
   build, so nothing reads a half-migrated state incorrectly.
2. Create `<vault>/_meta/scriptorium/` and copy into it, byte for byte, the legacy `vault.config.json`
   and each site-relative input file that exists (the same file set `src/build/stage.js`'s
   `SITE_RELATIVE_INPUTS` already mirrors during a build). Copy no Markdown; a pack holds only the
   files a build actually reads.
3. In the pack's own `vault.config.json`, remove `vaultPath` and rewrite `outputDir` relative to the
   pack directory (D-06 above), or remove it entirely if that deployment has no baseline worth
   protecting.
4. Commit the pack to the vault's own repository, while no other automated process is writing to the
   vault at the same time.
5. Run a scratch build in pack mode and diff it against a scratch build in the still-active legacy
   mode: the two output trees must be byte-identical (0-diff). Only once this passes does step 6
   begin.
6. Remove `site_config` from each machine's own GM-Scriptorium config, one machine at a time. Until a
   given machine's `site_config` is removed, `config/pack-shadowed` keeps firing there as a reminder
   that the pack it now also has exists but is not yet in use.
7. Once no machine anywhere still reads the legacy site directory, rename its files to
   `*.moved-to-vault` rather than deleting them, so the old inputs remain recoverable.

Between steps 5 and 7, the pack's copy and the legacy directory's copy of any input file (most notably
`css/overrides.css`) must be kept in lockstep: an edit made to one during that window and not the other
is exactly the kind of silent drift this whole mechanism exists to avoid introducing.

## Will catch

- A committed pack silently changing a legacy-configured machine's inputs (it doesn't: `site_config`
  still wins, and `config/pack-shadowed` says so).
- A mistyped `pack` key (E-PACKDIR or E-PACKJSON, naming the path, no fallthrough).
- A half-scaffolded convention directory: present but missing its `vault.config.json` (E-CONV).
- No site inputs configured or discoverable at all (E-NONE, naming all three sources).
- Invalid or non-object pack JSON (E-PARSE, E-SHAPE).
- A build into the pack-relative `outputDir` target without `--force` (unchanged guard, D-06).

## Will not catch, deliberately

- Markdown placed in the pack. The census walk (`src/vault/index.js:23-36`) still walks `_meta`; a
  stray `README.md` with no frontmatter `type` becomes an ordinary `frontmatter/missing-type` ERROR
  like any other unmapped markdown file would. The migration procedure above copies no Markdown for
  exactly this reason, but nothing stops a GM from adding some by hand.
- The two pre-existing opt-in generator copies (`theme.campaign_image`, section banners) reaching into
  `_meta` when a GM explicitly names a path there.
- A convention directory that is itself a symlink pointing outside the vault. This ADR does no
  realpath containment on the pack directory itself; that is left for a later phase that also handles
  pack-relative image paths, where the same containment question comes up again.
- Symlinks and case-only differences in output containment; that residual already existed
  (`src/build/plan.js`'s own documented limits) and is unchanged here.
- A broken `pack` key while `site_config` is the one actually in use: it is not reported, because it
  is not in use, and reporting every syntactically-possible misconfiguration regardless of whether it
  affects anything would be noise.
- Older, pack-unaware GM-Scriptorium builds, which never look for a pack at all.
- The build note not appearing on the check-refusal path: `build`'s own refusal message construction
  (`src/cli/build.js:118-124`) builds its own lines directly; the embedded `check` envelope still
  carries the WARN either way.
- A relative `pack` key resolves against the current working directory, the same as every other
  path-shaped config key already does.
- An invalid legacy JSON still prints a stack trace (`src/cli/check.js:37-38`'s pre-existing,
  unchanged behaviour on the `site_config` path).

## Not decided here

`pack.toml`'s own contents (a later ADR), a `--pack` CLI flag, and `scriptorium init` (ADR 0021).

## Amended by ADR 0033

The admin panel may also replace one existing vault file, `_meta/vault-config.md`, through its own
chokepoint and only after a backup outside the vault. Nothing above is edited; see ADR 0033.
