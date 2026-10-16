# 0061. Banners and the cover picture are judged by the file they were copied from

## Summary

The hidden-folder leak check, `leak/l2-excluded-dir-in-output`, used to read every file in the site's `images/` folder as if it came from the attachments folder, so a GM who hid the whole attachments folder had the build refused for every section banner and the cover picture, with no way past it. The check now works out where the generator copies the cover picture and section banners, recognises each copy by its place and its exact bytes, and judges it by the file it was really copied from. A cover picture or banner the GM named in a setting whose file is in a hidden folder is a WARN and the build goes ahead, because the GM asked for that file, while a `_banner` picture the build found by itself in a hidden folder is an ERROR and the build is refused. The main rejected alternative was refusing all of them, which would block a GM's own setting with no override. The limit a GM will meet is that the build's printed summary and the panel's preview do not show the WARN; `check` and `build --json` do.

Status: accepted. Amends [ADR 0060](0060-hidden-folders-warn.md) and [ADR 0018](0018-campaign-pack.md).

## 1. What the generator copies into `images/`

Three things write files into the built site's `images/` folder, and the check has to tell them apart.

- **Attachments.** Files from the attachments folder (`attachmentsDir`, `_attachments` by default) keep their path under it. When the whole attachments folder is hidden, none are copied.
- **The cover picture.** `publish.theme.campaign_image` in `_meta/vault-config.md` names a file inside the vault. The generator copies it to `images/` under its own file name. An `http` or `https` address is not copied.
- **Section banners.** For each of the generator's fixed sections (`locations`, `characters/npcs` and so on), a `banners` entry names a picture and, if you like, a file the picture links to. With no entry, the generator looks for a `_banner` picture (such as `_banner.png`) in the vault folder that `folder_map` maps to that section. Each copy goes to `images/banners/<section>/<file name>`, where every run of characters other than letters and digits in the section name becomes `-`, so `characters/npcs` becomes `characters-npcs`. An SVG banner with no link is written into the page itself and not copied.

The generator copies the cover picture and banners from any folder in the vault, hidden or not. That is the generator's behaviour, and this record does not change it.

## 2. How the check tells them apart

- It works out the same copies from the same settings the generator reads: `publish.theme.campaign_image`; `banners` from `_meta/vault-config.md`, plus any `vault.config.json` entry for a section it does not mention; and `folder_map` from `_meta/vault-config.md`, or `folderMap` from `vault.config.json` when the vault file has none.
- A file counts as a cover picture or banner only when its place is one of those copies and its bytes are identical to the file it would be copied from. A file in the right place with different bytes, such as a stale copy of a hidden attachment, is read as an attachment, as before.
- A recognised file is judged by the file it was really copied from: its path in the vault after `.` and `..` are worked out, against the same hidden folders and always-excluded folders as everything else in this check.
- If that file is not in a hidden folder, there is no finding.
- If it is, the finding names the setting, or says the banner was found automatically, and names the file. A file the GM named in `publish.theme.campaign_image` or `banners` is a WARN. A `_banner` picture found automatically is an ERROR.
- `check` and the build's own scan of the new site (ADR 0060) run the same code, so they agree.

The rules for choosing a banner (which entry wins, which folder, which file types, in which order) come from the generator itself. The place a copy lands and the merge of the two config files are copied into GM-Scriptorium, because the generator does not share them. A test builds a real site and checks the copies land where the check expects, so a generator update that moves them fails it. If GM-Scriptorium's copy of those rules ever drifts from the generator, a file stops matching and is read as an attachment again, so drift can cause a false ERROR but cannot hide a leak.

## 3. Why a named file is a warning

ADR 0018 already treats a cover picture or banner the GM names as deliberate, "because the GM asked for that specific file". Refusing the build for it, with nothing that overrides the refusal, would answer a GM's own setting by blocking every build until the file is moved. The WARN keeps the choice visible in `check` without stopping the build. A `_banner` picture found in a hidden folder is different: nobody named it, and a GM who hid a section's folder has no reason to expect its banner on the site.

## 4. Rejected alternatives

- **Every cover picture or banner from a hidden folder is an ERROR.** The common setups, a cover picture inside a hidden attachments folder or a cover kept in `_meta`, would stay refused with no override until the GM moved the file, and it reverses ADR 0018.
- **A named file is trusted and reported nowhere.** A GM who points a setting into a hidden folder by mistake would never be told.
- **Match on the place alone.** A stale copy of a hidden attachment that happens to sit where a banner goes would be waved through.
- **Wait for the generator to skip hidden folders when it copies these files.** That is the generator's change to make, and the check would stay wrong until it did.
- **Keep the limit in ADR 0060.** Hiding the whole attachments folder would keep refusing every build of a site with a banner or cover picture.

## 5. Limits

- The build's printed summary and the panel's preview do not list WARN findings from its scan of the new site. `check` and `build --json` show them.
- A standalone `check` against a site built before a banner or cover picture's file or setting changed reads that file as an attachment until the next build, because its place or bytes no longer match. `build` always scans a fresh site, so it never sees this.
- Not checked on Windows, where file names ignore case and `\` separates folders.
