# The Long Lease: a sample campaign

This guide is for a GM who wants to see GM-Scriptorium build and serve a real-looking site before
pointing it at their own vault. Everything in `the-long-lease/` is invented: the valley, the dragon,
the people and the art. Copy it, break it, and build your own campaign from it.

A few words this guide uses: a **vault** is the folder of markdown pages a GM writes in; a
**campaign pack** is the small bundle of settings and art inside a vault's `_meta/scriptorium/`
folder that tells Scriptorium how to build that vault's site; a **slot** is one of the handful of
background images (the banner, the ground texture, the paper texture) a theme can show; and
**withheld** marks one entity whose name must never appear on the published site at all.

## What's in it

| Path | What it is |
|---|---|
| `the-long-lease/` | The vault. Point `config add` at this folder. |
| `the-long-lease/_meta/` | The vault's schema notes, and the campaign pack under `_meta/scriptorium/`. |
| `the-long-lease/_attachments/` | The hand-drawn SVG art: portraits, faction sigils, the banner, the map and the paper texture. |
| `the-long-lease/Characters/`, `Locations/`, `Factions & Organizations/`, `Items & Artifacts/`, `Creatures/`, `Events/`, `Sessions/` | The campaign's own pages, one folder per entity type. |
| `the-long-lease/_Campaign/` | The campaign's front page and its timeline. |

## Build and look at it

1. Get the repository: clone it, or download the ZIP from its GitHub page.
2. Register the vault as a campaign called `lease`. Always pass `--out`.

   On Windows (PowerShell or Command Prompt):
   ```
   gm-scriptorium config add lease --vault "D:\gm-scriptorium\examples\the-long-lease" --out "D:\gm-scriptorium\out\lease"
   ```

   On Linux or macOS:
   ```
   gm-scriptorium config add lease --vault ~/gm-scriptorium/examples/the-long-lease --out ~/gm-scriptorium/out/lease
   ```
3. Check it for problems:
   ```
   gm-scriptorium check lease
   ```
4. Build the site:
   ```
   gm-scriptorium build lease
   ```
5. Serve it locally:
   ```
   gm-scriptorium serve lease
   ```
6. Open `http://127.0.0.1:8080` in a browser.
7. When you're done, deregister the campaign. This only removes the entry from your config; it
   never touches anything on disk.
   ```
   gm-scriptorium config remove lease
   ```

## What to look at

| Page | What it shows |
|---|---|
| The landing page (`index.html`) | The campaign banner, used as both the hero backdrop and the page's own ground texture. |
| Locations (`locations/index.html`) | An inline map banner with live links out to every location page. |
| Marigold Court (`factions/marigold-court.html`) | The heraldic crest layout the theme uses for a faction's hand-drawn sigil. |
| Fair Terms (`items/fair-terms.html`) | A wide vector item drawing, fitted into the same box a portrait would use. |
| Orpiment's Scale (`items/orpiments-scale.html`) | A small, square vector token. |
| The Tally Cliffs (`locations/the-tally-cliffs.html`) | A tall-aspect location image behind the theme's usual wide backdrop. |
| The 404 page (visit any address that doesn't exist) | The in-world "cut from the ledger" message. This vault has no dedicated `404` image, so the page falls back to the campaign banner. |

See `../docs/image-slots.md` for the full list of slots a theme can draw, and the sizes to prepare
art at.

**The withheld NPC.** One character in this vault, Ottoline Pardew, is marked `withheld: true` in
`_meta/publish-manifest.md`. Her page never builds, and her name is kept out of every page a player
can read. Try this: open `Characters/NPCs/Orpiment.md` and type a sentence naming her on the line
right under the `# Orpiment` heading, such as `Ottoline Pardew was seen here.` Then run `check`
again. It refuses to pass (exit code 2), because that is exactly what the leak checks exist to
catch. Put the same sentence at the very bottom of the file and `check` passes, because everything
under the `## GM Notes` heading is cut from the published page, so her name never reaches players
there.

## Start your own campaign from it

Copy the `the-long-lease/` folder somewhere else first, then register the copy as its own campaign.
`serve --admin` writes changes back into the vault it's pointed at, so only ever run it on your own
copy, never on this one.

## Where everything came from

Everything in this sample, its text and its hand-drawn SVG art, is original work made for this
repository, offered under the same licence as the rest of it: see `../LICENSE`.

This sample uses rules text from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the
Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative
Commons Attribution 4.0 International License, available at
https://creativecommons.org/licenses/by/4.0/legalcode.
