# 0071. Reading a vault whose settings moved to vault-config.yaml, and carrying the pack's leftover settings

## Summary

An update of the gm-apprentice plugin moves a vault's settings from `_meta/vault-config.md` to `_meta/vault-config.yaml`, and GM-Scriptorium 0.5.0 refused such a vault with exit 3. Now `check`, `build`, `serve`, `init` and the admin panel read a moved vault through the pinned generator's own settings reader, and an old vault is read exactly as before. On a moved vault the generator no longer reads the campaign pack's site title, folder map or hide lists, so `check` names each one the vault's settings lack, and a hide entry or a folder map that would be lost fails `check`, and stops `build` even with `--no-check` or `--force-check`. The GM moves them with a new `carry` command, or the panel's **Carry these settings** button, which runs the generator's own merge and keeps a copy of both files outside the vault first; the vault's values win and hide lists only grow. The main rejected alternative was letting `build` carry the settings itself, which would break the promise of [ADR 0006](0006-post-build-page-writer.md) and [ADR 0018](0018-campaign-pack.md) that a build never writes to the vault. The limits a GM will meet: the GM must run the carry, the panel shows the moved settings read-only until a later release lets it edit them, and a new vault made by `init --new-vault` is still made on the old layout.

Status: accepted. Retires the refusal added for issue 171. Amends [ADR 0018](0018-campaign-pack.md), [ADR 0021](0021-init-first-run-setup.md) and [ADR 0033](0033-vaultconfig-write-exception.md). Builds on [ADR 0005](0005-generator-pin.md)'s publish-v1.26.0 addendum.

## 1. What a GM sees

Before this change, a vault with `_meta/vault-config.yaml` stopped every command with exit 3 and a message pointing at issue 171. Now:

- `check` and `build` work on a moved vault as they do on an old one.
- If the campaign pack's `vault.config.json` still holds settings the vault's own file does not, `check` names each one and the command that moves them, `gm-scriptorium carry <campaign>`.
- After the carry, those settings live in one place, `_meta/vault-config.yaml`, and the pack no longer holds them.

A vault with both files, a leftover `vault-config.md` beside the new one, is read the way the generator reads it: the yaml wins. `check` warns about the leftover (`config/leftover-settings-file`). The old refusal message, and its row in the exit-code table, are gone.

## 2. Decision: read through the pin

Which layout a vault is on, and what its settings say, come from the pinned generator's own code, reached through the facade (`src/generator/pinned.js`): `settingsLayoutOf`, `readPublishSettings`, `resolveSiteConfig`, `settingFaults` and `readSettingValues`. `check` still reads every vault file through `src/vault/read.js` and hands the pin the text, as the publish-v1.26.0 addendum to ADR 0005 describes; that now covers both settings files.

- On a moved vault, the site config `build` hands the generator is the pack resolved against the yaml, with every key the vault's settings now own taken out of the staged file (`stripMovedSettings`, used by `stageConfig` in `src/build/stage.js`). So the build never sees a pack value the generator would no longer read.
- The five site-folder keys are the exception: `siteUrl`, `host`, `cloudflarePagesProject` and `preserveDirs` stay in the staged file, as the pin's own `leaveFallback` leaves them. The generator still reads them from the site file while the yaml sets none, so a pack `siteUrl` keeps the address prefix on every page, the 404 page included. A key whose value is the built-in one is left out: the resolve fills it in when nobody set it, and staged it would only make the generator warn that it "moves to" the vault. None of these keys hides anything.
- The fifth, `outputDir`, stays out. The generator reads it there as a site-file setting it is about to move, and warned on every build that it "moves to `player_site.output`", about a key only Scriptorium's staged copy held. The build hands the output folder to the generator's own `outputDirOverride` build option instead. An old vault is staged exactly as before.
- The pack's required-key refusal (no `folderMap` or `excludeDirs` in `vault.config.json`, exit 3) applies only to an old vault. On a moved vault those keys belong in the yaml, and after a carry they are gone from the pack on purpose.
- A `_meta/vault-config.yaml` that is not valid YAML is a `config/settings-fault` ERROR in `check`, as a broken `vault-config.md` is. `build --force-check` and `build --no-check` on it exit 3 with one line, never a stack.
- The checks that compare a vault's own hide lists with the generator's defaults (`config/exclude-sections-divergence` and `config/exclude-fields-divergence`) run on both layouts and name the file that is really there. Only the comparisons between the pack and the vault's file are off on a moved vault, where the carry checks below replace them.

## 3. What `check` says before the carry

The findings come from the pin's own fault list for site-file keys it no longer reads, so the keys and setting names are the generator's, not a list kept here.

| Pack still holds | Check id | Severity | Why |
|---|---|---|---|
| A hide-folders, sections, fields or callouts entry the vault's list lacks | `config/pack-hiding-not-carried` | ERROR | The build would publish what the GM hid. |
| A folder map, and the vault's settings set none | `config/folder-map-not-carried` | ERROR | See below. The carry fixes it. |
| No folder map, and the vault's settings set none, or one the generator cannot read (for example after a carry); or a folder map the generator cannot read, whatever the pack holds | `config/folder-map-missing` | ERROR | The same empty site, which the carry cannot fix. The message says to set or fix it in the yaml, and names a backup that holds a folder map, when there is one: a copy of the yaml that holds one, or else the pack's copy, under `folderMap`. The carry copies the yaml before it writes the folder map, so its own yaml copy usually holds none. |
| Another setting the vault's settings do not set, such as `siteTitle` | `config/pack-setting-not-carried` | WARN | Visible, not a leak: the site loses its title. |
| A site-folder key (`siteUrl`, `host`, `cloudflarePagesProject`, `preserveDirs`) the vault's settings do not set, unequal to its built-in value | `config/pack-setting-not-carried` | WARN | The generator still reads it from the pack for now (section 2), so the site is right today; the carry moves it. |
| A setting both files set, to different values (the site-folder keys included, as the generator compares them), or one the vault's settings set to a value the generator cannot read | `config/pack-setting-differs` | WARN | The vault's value is the one used, or kept for the GM to fix. |

`config/folder-map-not-carried` is an ERROR, not the warning the design first gave it. Without a folder map the generator maps no folder, so a build publishes an almost empty site and exits 0. A deploy would then push that over the players' site. Making it an ERROR stops the build first, and section 12 stops it whatever the build's flags. A yaml folder map that is missing or that the generator cannot read maps no folder either, but the carry cannot fix that (it keeps a value the vault's settings hold, and an empty pack has nothing to bring), so it has its own id, `config/folder-map-missing`, an ERROR that the build refuses in the same way. A yaml folder map that leaves out folders the pack maps stays a WARN (`config/pack-setting-differs`): the vault's settings own the folder map, and dropping a folder is the GM's own choice, not a leak.

A pack value the vault's settings already hold, such as the same title or list entries the vault's list already has, is not reported. So the offer to carry disappears once there is nothing left to carry, even if the pack file still holds its old copies. When the campaign's site config is not the pack in the vault (a `site_config`, or a pack outside the vault), the carry cannot rewrite it, so every finding calls it the site config and says to move the setting into `_meta/vault-config.yaml` by hand. Section names are compared as the build reads them (`headingKey`), and folders as the scanner spells them. A pack key the generator no longer reads at all, such as `landingTagline`, is never reported.

## 4. Decision: the GM runs the carry, through the pin's own merge

`check` and `build` never write to the vault. The carry is an action the GM takes, offered in two places:

- **The command line:** `gm-scriptorium carry [campaign] [--yes]`. It prints what will move, asks, and then prints what moved and where the backups are. A second run says there is nothing to carry. Its exit codes are 0, 1 and 3 from the frozen table.
- **The panel:** on the Title & tagline screen of a moved campaign whose pack still holds settings, the panel lists them and offers **Carry these settings**. It plans the carry once per visit, applies it only if both files are still as they were when the lines were shown, then shows the result lines and the backups.

The carry uses the generator's own move code (`planSettingsCarry` and `applySettingsCarry`, the pin's `planMove` and `applyMove` with `foldSiteFile`). That code exists for a vault that has already moved: given a site file, it folds the file's settings into the yaml. It adds a hide list's entries to the vault's list and never drops one, keeps the stricter of two callout rules, keeps the vault's value where both files set one, and takes the carried keys out of the site file. It writes all or nothing, and refuses if either file changed after the plan was made. So there is one owner of the merge rules. If gm-apprentice changes how a list merges, Scriptorium follows with the next pin.

The pin's move wants a site file that names its vault in `vaultPath`, and the pack does not. So the move works on a copy of the pack in a fresh scratch folder in the system temp folder, and the copy then becomes the new pack through `src/vault/carrypack.js`, which refuses if the pack changed since it was read. Every message that would name the scratch copy names the pack. Only the pack in the vault (`_meta/scriptorium/vault.config.json`) is ever rewritten; a campaign whose pack lives elsewhere is told to move the settings by hand.

Before anything is written, both files are copied into the per-machine `backups` folder beside the settings file, in the campaign's folder, never into the vault, as ADR 0033's writer does. A failure before the yaml is written changes nothing.

The pin's apply can also remove a leftover `_meta/vault-config.md` that holds nothing the yaml lacks; its plan says so before the GM answers. When the plan removes it, that file is copied into the same folder first, as `vault-config-leftover-<stamp>-<hex6>.md.bak`, and the output names the copy. The label keeps it out of the panel's restore list and out of the newest-20 pruning of the panel's own `vault-config.md` copies, so it is never offered as a panel restore and never deleted. One with anything of its own, such as notes in its body, is kept by the pin and reported by `check`. The pin also removes hidden files left by an earlier move of its own; those are its scratch copies, and no copy is kept.

## 5. The title and folder map: Scriptorium writes them itself, for now

At publish-v1.26.0 (and still at 1.48.2) the pin's move on an already-moved vault takes `siteTitle` and `folderMap` out of the site file without writing them to the yaml (upstream AntTheLimey/gm-apprentice#539). Left alone, the carry would lose the site's title and its whole folder map.

So, after the pin's apply, Scriptorium sets `player_site.title` and `player_site.folder_map` itself, with the pin's own settings writer (`applySettingsChanges`, the pin's `lib/settings/write.js`), and only where the yaml does not already set them. It reads the result back before it takes them out of the pack. This step comes out once a pin carries the upstream fix.

This write comes after the pin's apply, because the pin refuses a yaml that changed after its plan was made. If it fails, the hide lists are already carried, the pack keeps `siteTitle` and `folderMap`, the command exits 3 and names both backups, and nothing is lost or written twice. Running the carry again finishes it.

## 6. What the carry moves, and what stays

- **The vault's values win.** Where both files set a title or folder map, the yaml's is kept and the output says so. That holds for a value the generator cannot read, too: the carry never writes over it, the pack keeps its own value, and the output names the yaml's value and says to fix it there.
- **Hide lists only grow.** The carry adds the pack's missing entries and never removes one.
- **Settings the pin cannot carry stay in the pack.** The pin's move also drops some other settings without carrying them (`footer`, `searchEnabled` or a changed `attachmentsDir`, for example). The carry puts each of those back in the pack, names it, and tells the GM to set it in `_meta/vault-config.yaml`; `check` keeps reporting it. A pack on a moved vault is therefore not always empty after a carry.
- **A failed pack rewrite is safe.** If the yaml was written but the pack could not be rewritten, the yaml already holds every carried value, `check` is satisfied, and the message says the pack can stay as it is.

## 7. `init` on a moved vault

`init` on an existing moved vault writes the pack without the keys the vault's settings now own, and carries its whole composed site config into the yaml through the same carry: the site title, the folder map, `excludeDirs` and any hide lists it composes. The yaml's values win as in section 6, and settings the pin cannot carry stay in the pack. It asks first, keeps a copy of the yaml outside the vault, and prints what it set. `--yes` accepts it like any other default. An `init --title` that differs from the title the yaml already sets exits 1 and says to change it there.

Carrying only the title, as the design first said, was not enough: a pack without a folder map and a yaml without one publish nothing, and `config/folder-map-not-carried` cannot fire when no folder map exists anywhere.

`init --new-vault` still makes a vault on the old layout, from the captured gm-apprentice scaffold, until the starter is recaptured.

## 8. The panel until it can edit the yaml

On a moved vault, the panel's title save, tagline save and vault settings editor are read-only. The Title & tagline screen shows the title and tagline as the yaml sets them, with a line saying the setting now lives in `_meta/vault-config.yaml` and that editing it there arrives in a later release. Otherwise a GM could type a title, the panel would save it to the pack, and the site would ignore it. The screen names the yaml wherever it used to name `vault-config.md` or `vault.config.json`. The carry section is described in section 4.

## 9. The pin's move loads a child-process module

`lib/settings/move.js` takes `spawnSync` from the child-process module when it loads, for a check that asks a site folder which publish tool it uses by running the pin's own command with `process.execPath`. In the packaged executable that would start GM-Scriptorium itself. The facade always hands the move its own answer (`pinCheck`, "no publish tool installed or pinned"), so nothing is ever started. Adding `lib/settings/move.js` to the expected set in `test/generator-module-graph.test.js` is a maintainer decision, flagged in the pull request that made it; ADR 0005's publish-v1.26.0 addendum records it, and `test/settings-carry-no-spawn.test.js` proves a real plan and apply start no program. Upstream AntTheLimey/gm-apprentice#535 asks for the module to be loaded lazily.

## 10. Rejected alternatives

- **The build carries the settings automatically**, with a backup, and reports what it did. Less for a GM to do, but a build would change the vault's settings file, breaking the guarantee of ADR 0006 and ADR 0018 that check and build never write to the vault.
- **Leave the title and folder map for the GM to copy by hand** until the upstream fix lands. Every GM who ran the carry would lose the site's title and folder map from the pack, and an empty site would follow unless they read the output closely.
- **A Scriptorium copy of the merge rules.** It would drift from gm-apprentice's, which is exactly the failure the design set out to avoid.
- **Ask gm-apprentice to change the move to accept a pack without `vaultPath`** before shipping. It would hold this release for an upstream one; the scratch copy works with the pin we have.

## 11. Will catch

- A hide entry or a folder map only the pack holds, or a moved vault with no folder map it can read: `check` fails, and `build` stops whatever its flags. Plain `build` stops at the check (exit 2). `build --no-check` and `build --force-check` stop before the generator runs, with exit 3 and one line naming the entries and `gm-scriptorium carry <campaign>`, or a hand edit for a site config outside the vault, and write nothing. On the old layout the generator's own settings stop cannot be forced either. The leak tests run both flags on both layouts.
- A carry that would lose a hide entry: the pin's merge only adds, and each carry rule (entries added, stricter callouts, the vault's value wins, a setting the vault lacks) has a test that builds the site and searches it for the hidden text before and after carrying.
- A leak case that passes on an old vault and fails on a moved one: every leak test runs on both layouts, with the moved copy made by the pin's own move, never written by hand.
- A plain `check` or `build` that changes a vault file on a moved vault: a test hashes every vault file before and after.
- A file changed between the plan and the apply, from the command line or the panel: nothing is written.
- A vault moved while the panel is running: every panel request that depends on the layout reads it from the disk again.

## 12. Will not catch, deliberately

- *Changed.* This section first said that `build --force-check` overrides `config/pack-hiding-not-carried` like any other check error and publishes what only the pack hid. That was reversed before release: on the old layout a generator settings stop is not forceable (ADR 0055 names the unforceable findings), and `--no-check` skipped the check without a word. The build now refuses on its own, as section 11 says. A GM must carry before building a moved vault whose pack still hides something.
- A pack value the vault already holds is not reported, by design. If the two are judged equal when the build would not treat them the same, a difference could go unreported. The comparison uses the build's own heading and folder readings to keep that gap closed.

## 13. Limits

- The GM must run the carry. Until they do, a moved vault with a pack folder map or hide entry fails `check` and cannot be built, with any flags.
- Editing a moved vault's settings from the panel arrives in a later release; until then, edit `_meta/vault-config.yaml` by hand.
- New vaults are made on the old layout until the starter is recaptured.
- `_meta/publish-list.yaml`, which arrives with a later pin, is not read yet.
