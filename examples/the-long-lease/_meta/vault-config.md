---
type: meta
purpose: vault-config
source_confidence: AUTHORITATIVE
gm_apprentice_version: "1.7.1"
campaign: "The Long Lease"
game_system: "dnd-5e-2024"
setting_year: "Lease Year 300"
created: 2026-07-04
publish:
  system: dnd-5e-2024
  mode: player
  exclude_sections: ["GM Notes", "DM Notes", "Player Notes", "Source References", "Reconciliation Context", "Handoff to Reconcile"]
  exclude_fields: ["secrets", "current_plan", "plan_progress", "gm_notes", "prep_notes", "reliability"]
  exclude_dirs: ["_meta", "_Templates"]
  theme:
    tagline: "Three hundred years ago a queen rented this valley from a dragon. At midsummer the dragon came back for the rent."
    palette:
      primary: "#1f3a6b"
      accent: "#a3321f"
      background: "#fbf6ea"
      text: "#2a2019"
    fonts:
      heading: "serif"
      body: "serif"
    campaign_image: "_attachments/campaign/long-lease-banner.svg"
  banners:
    locations:
      image: "_attachments/charts/vale-of-quillet.svg"
      alt: "A painted chart of the Vale of Quillet, from the Tally Cliffs down to Sealwright Hall"
  landing:
    max_npcs: 8
    featured_npcs: ["Orpiment", "Queen Hesper"]
    quick_links: ["The Long Lease", "Timeline", "The Lease of Quillet"]
    explore_descriptions:
      characters: "Four hired Wardens, one young queen, and the dragon everyone is being very polite to."
      locations: "A riverside town, a hall full of wax, a cliff full of tally marks, and a barrow that sings."
      story: "The rent falls due at the Lammas moon. Here is how the Wardens are spending the weeks."
      factions: "The crown that owes, the guild that lost the paperwork, and the bank that holds the notes."
      items: "Two copies of one lease, a scale off the lessor, and a sword with a lawyer's name."
      creatures: "Things that fall off dragons, crawl out of inkwells, or guard the dead in tune."
      events: "The signing, the landing, the cut page, the verse."
  four_oh_four:
    style: in-world
    message: "This page has been cut from the ledger. Someone owes us an explanation."
---

# Vault configuration

This is the sample campaign that ships with GM-Scriptorium. Everything in it is invented for the purpose: the vale, the dragon, the people and the art.

## Folder structure

| Folder | Holds |
|---|---|
| `_meta/` | Schema, this file, the publish manifest, and the campaign pack under `_meta/scriptorium/` |
| `_Campaign/` | The campaign's front page and the Timeline |
| `_attachments/` | Hand-drawn SVG art: portraits, faction sigils, the banner (also the ground texture), the map and the paper texture |
| `Sessions/` | One `type: session` page per played session. Each holds the player-facing recap |
| `Characters/PCs/`, `Characters/NPCs/` | People. Each PC has a `{Name}_Story.md` companion |
| `Locations/` | Places, nested by `parent_location` |
| `Factions & Organizations/` | The three powers in the vale |
| `Items & Artifacts/` | Things worth carrying, or worth stealing |
| `Creatures/` | Original monsters, with brief table stats |
| `Events/` | Moments that changed where the story is going |

## Naming

Entity files use the canonical name as the filename, so `[[Orpiment]]` is `Characters/NPCs/Orpiment.md`. Sessions are `Sessions/Session NN - Title.md`.

## Campaign settings

- System: fifth-edition rules (the 2024 revision), using SRD 5.2 material under CC-BY-4.0; the attribution is on the campaign front page. The party is level 3.
- Table: fortnightly Saturdays, four players.
- Calendar: the vale counts years from the signing of the lease, so this summer is Lease Year 300. Inside the campaign, days are counted from Midsummer: day 1 is the fair.

## Player-facing publish

The site builds in `player` mode against `_meta/publish-manifest.md`, which is a fail-closed allowlist: a page publishes only if its path is ticked under Publishing. `## GM Notes` sections, `<!-- gm-only -->` blocks, the `secrets` field and any relationship edge marked `gm_only: true` are stripped from everything that does publish.

One entity is `withheld: true`. It sits under Excluded in the manifest, and its name may appear only inside GM Notes, never in anything a player can read. Scriptorium's leak checks exist to prove that holds.
