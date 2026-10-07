# Backing up your vault

This page is for a GM who keeps a campaign in a vault and wants to know how to protect it. It
answers three questions: what GM-Scriptorium does with your notes, how to back them up, and what
not to do.

A **vault** is the folder of markdown pages you write your campaign in. A **backup** here means a
second copy you can get back if the first one is lost or damaged.

## What GM-Scriptorium does with your notes

It never moves vault content anywhere. `check` only reads. `build` reads the vault and writes a
site to a separate output folder. `serve` shows that site on your own computer. There is no
telemetry and no sync. The only network call the tool makes is `update`, and it fetches the tool's
own release files, never anything about your campaign.

The tool also does not back your vault up. It will write small files inside the vault, such as the
campaign pack in `_meta/scriptorium/` and, if you edit the tagline in the admin panel,
`_meta/vault-config.md`. It keeps a copy of `_meta/vault-config.md` outside the vault before each
panel save. That copy covers one file and is not a vault backup.

Your vault is the only copy of your notes that matters. Back it up yourself.

## Recommended: your vault's own git history

Git keeps every saved version of every file, so you can see what changed and go back to any point.

1. Make the vault a git repository (`git init` in the vault folder).
2. Commit when you finish writing, for example after each session.
3. Keep a second copy of the repository on another disk or another machine, so one failure cannot
   take both.

One rule matters if the vault is on a network share: **git on a network share is only safe with a
single writer.** Two computers committing to the same repository over a share can corrupt it. If
more than one machine edits the vault, keep the git history on one machine's own disk, or take
turns so that only one machine touches the repository at a time.

## Also recommended: storage snapshots

If your vault lives on a NAS or a file system that can take snapshots, turn them on. A snapshot is
a read-only picture of the folder at one moment, taken on a schedule, and it costs little space.
Snapshots protect against an accidental delete or a bad edit, and they work no matter what
software touched the files. Keep them on a different disk or machine from the vault itself if you
can, and check now and then that you can open an old one.

Snapshots and git do different jobs. Git gives you named, meaningful versions. Snapshots catch
what you forgot to commit. Using both is better than either alone.

## Do not publish the vault

A public repository publishes everything in it. Your vault holds GM notes: secrets, motives and
spoilers. If you put the vault in a public repository, or a private one you later make public,
players can read all of it, and so can anyone else. The player site GM-Scriptorium builds is the
only part meant to be shared. Keep the vault in private storage, and publish only the built output
after `check` and `build` have passed.
